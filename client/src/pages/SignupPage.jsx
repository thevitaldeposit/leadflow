import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AudioLines, ArrowRight, ArrowLeft, Check, Lock, Loader2,
  Trash2, Wind, Droplets, Trees, HardHat, Building2,
} from 'lucide-react';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { api } from '../utils/api';
import { getStripe } from '../utils/stripe';
import { useAuth } from '../context/AuthContext';
import { setActiveVertical } from '../utils/verticalConfig';

const CALENDLY_URL = 'https://calendly.com/threetscapital/30min';
const PRICE_LABEL = '$149/month';
const TOTAL_STEPS = 4;

// Industry options shown as a visual card selector on Step 2. The id doubles as
// the value persisted to businesses.industry_type.
const INDUSTRIES = [
  { id: 'Dumpster Rental', Icon: Trash2 },
  { id: 'HVAC', Icon: Wind },
  { id: 'Plumbing', Icon: Droplets },
  { id: 'Landscaping', Icon: Trees },
  { id: 'Roofing', Icon: HardHat },
  { id: 'Other', Icon: Building2 },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Stripe Elements appearance — tuned to the blue accent used across the app.
const STRIPE_APPEARANCE = {
  theme: 'stripe',
  variables: {
    colorPrimary: '#2563eb',
    borderRadius: '8px',
    fontSizeBase: '14px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
};

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2 text-slate-900">
      <AudioLines className="text-blue-600" size={24} strokeWidth={2.5} />
      <span className="text-lg font-bold tracking-tight">Stream</span>
    </Link>
  );
}

// Subtle 4-segment progress bar at the top of the card.
function StepBar({ step }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
            i < step ? 'bg-blue-600' : 'bg-slate-200'
          }`}
        />
      ))}
    </div>
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

// Calendly inline embed. Loads the widget assets once, then renders the
// scheduling calendar into our container with the prospect's name + email
// pre-filled. Clears the container on re-render so React StrictMode's double
// effect invocation in dev can't stack two widgets.
function CalendlyEmbed({ name, email }) {
  const ref = useRef(null);

  useEffect(() => {
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
      style={{ minWidth: '320px', height: '660px' }}
    />
  );
}

// ── Step 3 payment form ──────────────────────────────────────────────────────
// Lives inside <Elements> so the Stripe hooks resolve. Confirms the PaymentIntent
// created server-side, then calls onComplete() (which registers the account and
// advances). A failed payment surfaces an error and lets the user retry without
// losing any of their info.
function PaymentForm({ onComplete, onBack }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements || processing) return;

    setProcessing(true);
    setError(null);

    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      // return_url is required by the API, but card payments resolve inline with
      // redirect:'if_required' and never actually navigate there.
      confirmParams: { return_url: `${window.location.origin}/signup` },
      redirect: 'if_required',
    });

    if (confirmError) {
      setError(confirmError.message || 'Payment failed. Please check your details and try again.');
      setProcessing(false);
      return;
    }

    if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
      try {
        await onComplete();
        // onComplete advances to Step 4, unmounting this form — nothing more to do.
      } catch (err) {
        setError(
          err.message ||
            'Your payment went through, but we hit a snag creating your account. Please contact support.'
        );
        setProcessing(false);
      }
      return;
    }

    setError('Payment could not be completed. Please try again.');
    setProcessing(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <PaymentElement options={{ layout: 'tabs' }} />

      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <button
        type="submit"
        disabled={!stripe || processing}
        className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
      >
        {processing ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Processing…
          </>
        ) : (
          <>
            Start My Subscription
            <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
          </>
        )}
      </button>

      <button
        type="button"
        onClick={onBack}
        disabled={processing}
        className="inline-flex w-full items-center justify-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <p className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
        <Lock size={12} /> Secured by Stripe · cancel anytime
      </p>

      <p className="text-center text-xs leading-relaxed text-slate-400">
        By subscribing you agree to our{' '}
        <Link to="/terms" target="_blank" className="font-medium text-slate-500 hover:text-slate-700">
          Terms of Service
        </Link>{' '}
        and{' '}
        <Link to="/privacy" target="_blank" className="font-medium text-slate-500 hover:text-slate-700">
          Privacy Policy
        </Link>
        .
      </p>
    </form>
  );
}

// ── Step 1/2 validation ───────────────────────────────────────────────────────
function validateAccount(form) {
  const errors = {};
  if (!form.firstName.trim()) errors.firstName = 'Required';
  if (!form.lastName.trim()) errors.lastName = 'Required';
  if (!form.email.trim()) errors.email = 'Required';
  else if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Enter a valid email address';
  if (!form.password) errors.password = 'Required';
  else if (form.password.length < 8) errors.password = 'Must be at least 8 characters';
  if (!form.confirmPassword) errors.confirmPassword = 'Required';
  else if (form.password !== form.confirmPassword) errors.confirmPassword = 'Passwords do not match';
  return errors;
}

function validateBusiness(form) {
  const errors = {};
  if (!form.industryType) errors.industryType = 'Please choose your industry';
  if (!form.businessName.trim()) errors.businessName = 'Required';
  return errors;
}

// Identity of the inputs a Stripe subscription is created from. When unchanged
// between Step 2 visits we reuse the existing PaymentIntent instead of creating
// a duplicate (incomplete) subscription.
function paymentSignature(form) {
  return [form.email.trim().toLowerCase(), form.firstName.trim(), form.lastName.trim(), form.businessName.trim()].join('|');
}

export default function SignupPage() {
  const navigate = useNavigate();
  const { register } = useAuth();
  const stripePromise = useMemo(() => getStripe(), []);

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    industryType: '',
    businessName: '',
  });
  const [errors, setErrors] = useState({});
  const [payment, setPayment] = useState(null); // { clientSecret, customerId, subscriptionId, sig }
  const [preparing, setPreparing] = useState(false); // creating the Stripe subscription
  const [prepError, setPrepError] = useState(null);

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

  // Step 1 → 2
  const submitAccount = (e) => {
    e.preventDefault();
    const v = validateAccount(form);
    if (Object.keys(v).length) {
      setErrors(v);
      return;
    }
    setStep(2);
  };

  // Step 2 → 3: validate, then create (or reuse) the Stripe subscription so the
  // PaymentElement on Step 3 has a client secret to confirm.
  const submitBusiness = async (e) => {
    e.preventDefault();
    const v = validateBusiness(form);
    if (Object.keys(v).length) {
      setErrors(v);
      return;
    }

    const sig = paymentSignature(form);
    if (payment && payment.sig === sig) {
      setStep(3);
      return;
    }

    setPreparing(true);
    setPrepError(null);
    try {
      const data = await api.createSignupSubscription({
        email: form.email.trim(),
        name: `${form.firstName.trim()} ${form.lastName.trim()}`.trim(),
        businessName: form.businessName.trim(),
      });
      setPayment({ ...data, sig });
      setStep(3);
    } catch (err) {
      setPrepError(err.message || 'Could not start checkout. Please try again.');
    } finally {
      setPreparing(false);
    }
  };

  // Called after the PaymentElement confirms. Creates the account (attaching the
  // Stripe ids), logs in, points the new tenant at the Home Services dashboard,
  // and advances to the scheduling step. Throws so PaymentForm can surface errors.
  const finishSignup = async () => {
    await register({
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      password: form.password,
      businessName: form.businessName.trim(),
      industryType: form.industryType,
      stripeCustomerId: payment?.customerId,
      stripeSubscriptionId: payment?.subscriptionId,
    });
    setActiveVertical('home_services');
    setStep(4);
  };

  const containerWidth = step === 4 ? 'max-w-2xl' : 'max-w-lg';

  return (
    <div className="min-h-screen w-full overflow-y-auto bg-slate-50">
      <style>{`
        @keyframes signup-step-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .signup-step { animation: signup-step-in 0.28s ease-out; }
      `}</style>

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Wordmark />
          <span className="text-sm text-slate-500">Step {step} of {TOTAL_STEPS}</span>
        </div>
      </header>

      <main className="mx-auto flex w-full flex-col px-4 py-10 sm:py-14">
        <div className={`mx-auto w-full ${containerWidth}`}>
          <StepBar step={step} />

          <div key={step} className="signup-step mt-6">
            {/* ── Step 1 — Account Info ─────────────────────────────────── */}
            {step === 1 && (
              <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Create your account</h1>
                <p className="mt-1.5 text-sm text-slate-600">Let's get you set up with Stream.</p>

                <form onSubmit={submitAccount} className="mt-6 space-y-5">
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
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
                    <Field label="Last name" error={errors.lastName}>
                      <input
                        type="text"
                        autoComplete="family-name"
                        value={form.lastName}
                        onChange={(e) => setField('lastName', e.target.value)}
                        placeholder="Doe"
                        className={inputClass('lastName')}
                      />
                    </Field>
                  </div>

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

                  <Field label="Password" error={errors.password}>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(e) => setField('password', e.target.value)}
                      placeholder="At least 8 characters"
                      className={inputClass('password')}
                    />
                  </Field>

                  <Field label="Confirm password" error={errors.confirmPassword}>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={form.confirmPassword}
                      onChange={(e) => setField('confirmPassword', e.target.value)}
                      placeholder="Re-enter your password"
                      className={inputClass('confirmPassword')}
                    />
                  </Field>

                  <button
                    type="submit"
                    className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
                  >
                    Next
                    <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
                  </button>
                </form>

                <p className="mt-5 text-center text-sm text-slate-500">
                  Already have an account?{' '}
                  <Link to="/login" className="font-medium text-blue-600 hover:text-blue-500">
                    Sign in
                  </Link>
                </p>
              </div>
            )}

            {/* ── Step 2 — Your Business ────────────────────────────────── */}
            {step === 2 && (
              <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Tell us about your business</h1>
                <p className="mt-1.5 text-sm text-slate-600">This tailors Stream to how you work.</p>

                <form onSubmit={submitBusiness} className="mt-6 space-y-5">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">Industry type</label>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {INDUSTRIES.map(({ id, Icon }) => {
                        const selected = form.industryType === id;
                        return (
                          <button
                            type="button"
                            key={id}
                            onClick={() => setField('industryType', id)}
                            className={`flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-center transition-all ${
                              selected
                                ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500/30'
                                : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            <Icon size={22} className={selected ? 'text-blue-600' : 'text-slate-400'} />
                            <span className={`text-xs font-medium ${selected ? 'text-blue-700' : 'text-slate-600'}`}>
                              {id}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {errors.industryType && <p className="mt-1.5 text-xs text-red-600">{errors.industryType}</p>}
                  </div>

                  {/* Business name appears once an industry is chosen. */}
                  {form.industryType && (
                    <div className="signup-step">
                      <Field label="Business name" error={errors.businessName}>
                        <input
                          type="text"
                          autoComplete="organization"
                          autoFocus
                          value={form.businessName}
                          onChange={(e) => setField('businessName', e.target.value)}
                          placeholder="Acme Dumpster Rental"
                          className={inputClass('businessName')}
                        />
                      </Field>
                    </div>
                  )}

                  {prepError && (
                    <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{prepError}</div>
                  )}

                  <button
                    type="submit"
                    disabled={preparing}
                    className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                  >
                    {preparing ? (
                      <>
                        <Loader2 size={16} className="animate-spin" /> Preparing checkout…
                      </>
                    ) : (
                      <>
                        Next
                        <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    disabled={preparing}
                    className="inline-flex w-full items-center justify-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
                  >
                    <ArrowLeft size={15} /> Back
                  </button>
                </form>
              </div>
            )}

            {/* ── Step 3 — Payment ──────────────────────────────────────── */}
            {step === 3 && (
              <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Payment</h1>
                <p className="mt-1.5 text-sm text-slate-600">Start your subscription to activate Stream.</p>

                {/* Order summary */}
                <div className="mt-6 flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Stream — {PRICE_LABEL}</p>
                    <p className="mt-0.5 text-xs text-slate-500">Full access to your operations dashboard.</p>
                  </div>
                  <p className="whitespace-nowrap text-base font-bold text-slate-900">$149</p>
                </div>

                <div className="mt-6">
                  {payment?.clientSecret ? (
                    <Elements
                      stripe={stripePromise}
                      options={{ clientSecret: payment.clientSecret, appearance: STRIPE_APPEARANCE }}
                    >
                      <PaymentForm onComplete={finishSignup} onBack={() => setStep(2)} />
                    </Elements>
                  ) : (
                    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
                      <Loader2 size={16} className="animate-spin" /> Loading secure checkout…
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Step 4 — Schedule Setup Call ──────────────────────────── */}
            {step === 4 && (
              <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
                <div className="text-center">
                  <h1 className="text-2xl font-bold tracking-tight text-slate-900">You're in! 🎉</h1>
                  <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
                    Schedule your setup call to activate your advanced booking and extraction features.
                  </p>
                </div>

                <div className="mt-6 overflow-hidden rounded-xl border border-slate-200">
                  <CalendlyEmbed name={`${form.firstName} ${form.lastName}`.trim()} email={form.email.trim()} />
                </div>

                <div className="mt-5 text-center">
                  <button
                    onClick={() => navigate('/dashboard')}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-700"
                  >
                    Skip for now <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {step === 4 && (
            <div className="mt-5 flex items-center justify-center gap-2 text-center text-sm text-slate-500">
              <Check size={15} className="flex-shrink-0 text-blue-600" />
              We'll walk you through everything on a quick 30-minute call.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
