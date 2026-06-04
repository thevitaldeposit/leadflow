import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AudioLines, ArrowRight, CalendarCheck, Check } from 'lucide-react';
import { api } from '../utils/api';

const BUSINESS_TYPES = ['Dumpster Rental', 'HVAC', 'Plumbing', 'Landscaping', 'Roofing', 'Other'];
const CALENDLY_URL = 'https://calendly.com/threetscapital/30min';

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2 text-slate-900">
      <AudioLines className="text-blue-600" size={24} strokeWidth={2.5} />
      <span className="text-lg font-bold tracking-tight">Stream</span>
    </Link>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(form) {
  const errors = {};
  if (!form.firstName.trim()) errors.firstName = 'Required';
  if (!form.businessName.trim()) errors.businessName = 'Required';
  if (!form.businessType) errors.businessType = 'Please choose your business type';
  if (!form.phone.trim()) errors.phone = 'Required';
  else if (form.phone.replace(/\D/g, '').length < 7) errors.phone = 'Enter a valid phone number';
  if (!form.email.trim()) errors.email = 'Required';
  else if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Enter a valid email address';
  return errors;
}

// Calendly inline embed. Loads the widget assets once, then renders the
// scheduling calendar into our container with the prospect's name + email
// pre-filled. Clears the container on re-render so React StrictMode's double
// effect invocation in dev can't stack two widgets.
function CalendlyEmbed({ name, email }) {
  const ref = useRef(null);

  useEffect(() => {
    // Capture the node up front so the cleanup closure isn't reading a ref that
    // may have changed (and to keep render/cleanup pointed at the same element).
    const node = ref.current;
    if (!node) return undefined;

    const CSS_ID = 'calendly-widget-css';
    if (!document.getElementById(CSS_ID)) {
      const link = document.createElement('link');
      link.id = CSS_ID;
      link.rel = 'stylesheet';
      link.href = 'https://assets.calendly.com/assets/external/widget.css';
      document.head.appendChild(link);
    }

    let cancelled = false;
    const render = () => {
      if (cancelled || !window.Calendly) return;
      node.innerHTML = '';
      window.Calendly.initInlineWidget({
        url: `${CALENDLY_URL}?hide_gdpr_banner=1`,
        parentElement: node,
        prefill: { name: name || '', email: email || '' },
      });
    };

    const SCRIPT_ID = 'calendly-widget-js';
    const existing = document.getElementById(SCRIPT_ID);
    if (window.Calendly) {
      render();
    } else if (existing) {
      existing.addEventListener('load', render, { once: true });
    } else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = 'https://assets.calendly.com/assets/external/widget.js';
      script.async = true;
      script.addEventListener('load', render, { once: true });
      document.body.appendChild(script);
    }

    return () => {
      cancelled = true;
      node.innerHTML = '';
    };
  }, [name, email]);

  return (
    <div
      ref={ref}
      className="calendly-inline-widget w-full overflow-hidden rounded-xl"
      style={{ minWidth: '320px', height: '700px' }}
    />
  );
}

function Field({ label, error, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export default function SignupPage() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    firstName: '',
    businessName: '',
    businessType: '',
    phone: '',
    email: '',
  });
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = 'Get Started — Stream';
  }, []);

  const setField = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  const inputClass = (name) =>
    `w-full rounded-lg border px-4 py-2.5 text-sm text-slate-900 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
      errors[name] ? 'border-red-400' : 'border-slate-300'
    }`;

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitError(null);

    const validationErrors = validate(form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    const payload = {
      firstName: form.firstName.trim(),
      businessName: form.businessName.trim(),
      businessType: form.businessType,
      phone: form.phone.trim(),
      email: form.email.trim(),
    };

    setSubmitting(true);
    try {
      await api.createSignup(payload);
      setStep(2);
    } catch (err) {
      // A server error response (has a status) is something the user can act on
      // — surface it and let them retry. A bare network error (no status, server
      // unreachable) must never block the booking: stash the lead locally and
      // move on to Screen 2 anyway.
      if (err.status) {
        setSubmitError(err.message || 'Something went wrong. Please try again.');
      } else {
        try {
          const pending = JSON.parse(localStorage.getItem('stream_pending_signups') || '[]');
          pending.push({ ...payload, savedAt: new Date().toISOString() });
          localStorage.setItem('stream_pending_signups', JSON.stringify(pending));
        } catch {
          /* localStorage unavailable — nothing more we can do, still proceed */
        }
        setStep(2);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-screen w-full overflow-y-auto bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Wordmark />
          <span className="text-sm text-slate-500">Step {step} of 2</span>
        </div>
      </header>

      {step === 1 ? (
        <div className="mx-auto flex max-w-md flex-col px-6 py-12 sm:py-16">
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Get started</h1>
            <p className="mt-2 text-slate-600">
              Tell us a bit about your business and we'll get you set up.
            </p>
          </div>

          <form onSubmit={onSubmit} className="mt-8 space-y-5 rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
            <Field label="First name" error={errors.firstName}>
              <input
                type="text"
                autoComplete="given-name"
                autoFocus
                value={form.firstName}
                onChange={(e) => setField('firstName', e.target.value)}
                placeholder="Jane"
                className={inputClass('firstName')}
              />
            </Field>

            <Field label="Business name" error={errors.businessName}>
              <input
                type="text"
                autoComplete="organization"
                value={form.businessName}
                onChange={(e) => setField('businessName', e.target.value)}
                placeholder="Acme Dumpster Rental"
                className={inputClass('businessName')}
              />
            </Field>

            <Field label="Type of business" error={errors.businessType}>
              <select
                value={form.businessType}
                onChange={(e) => setField('businessType', e.target.value)}
                className={`${inputClass('businessType')} ${form.businessType ? '' : 'text-slate-400'}`}
              >
                <option value="" disabled>
                  Select…
                </option>
                {BUSINESS_TYPES.map((t) => (
                  <option key={t} value={t} className="text-slate-900">
                    {t}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Phone number" error={errors.phone}>
              <input
                type="tel"
                autoComplete="tel"
                value={form.phone}
                onChange={(e) => setField('phone', e.target.value)}
                placeholder="(555) 123-4567"
                className={inputClass('phone')}
              />
            </Field>

            <Field label="Email address" error={errors.email}>
              <input
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(e) => setField('email', e.target.value)}
                placeholder="jane@acme.com"
                className={inputClass('email')}
              />
            </Field>

            {submitError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{submitError}</div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Next'}
              {!submitting && (
                <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
              )}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-slate-500">
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-blue-600 hover:text-blue-500">
              Sign in
            </Link>
          </p>
        </div>
      ) : (
        <div className="mx-auto max-w-3xl px-6 py-12 sm:py-14">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-600">
              <CalendarCheck size={24} />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              One last step — pick a time that works for you
            </h1>
            <p className="mx-auto mt-3 max-w-xl text-slate-600">
              We'll walk you through everything on a quick 30-minute call.
            </p>
          </div>

          <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            <CalendlyEmbed name={form.firstName} email={form.email} />
          </div>

          <div className="mt-5 flex items-center justify-center gap-2 text-center text-sm text-slate-500">
            <Check size={15} className="flex-shrink-0 text-blue-600" />
            Not ready to book yet? No problem — we'll reach out to you soon.
          </div>
        </div>
      )}
    </div>
  );
}
