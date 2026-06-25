import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { CALENDLY_URL } from '../utils/calendly';

// Calendly's inline widget needs a real, explicit height: a min-height alone lets
// the injected iframe's `height:100%` collapse to nothing (renders blank). We
// reserve this much vertical space so the box can never collapse while loading.
const CALENDLY_HEIGHT = 680;
// If the widget script is blocked (ad/privacy blockers very commonly block
// *.calendly.com) or never loads, surface a plain booking link by this deadline so
// the user is never stranded on an empty box.
const CALENDLY_FALLBACK_MS = 6000;
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

// Stripe Elements appearance — dark theme matched to the app's design tokens.
const STRIPE_APPEARANCE = {
  theme: 'night',
  variables: {
    colorPrimary: '#2575ed',      // --color-brand
    colorBackground: '#1b2937',   // --color-surface-2
    borderRadius: '8px',
    fontSizeBase: '14px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
};

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2 text-content">
      <AudioLines className="text-brand" size={24} strokeWidth={2.5} />
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
            i < step ? 'bg-brand' : 'bg-surface-2'
          }`}
        />
      ))}
    </div>
  );
}

function Field({ label, error, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-content">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

// Loads Calendly's stylesheet + widget script exactly once for the whole app and
// resolves when `window.Calendly` is ready (rejects if the script errors or is
// blocked). Reusing the same tags across mounts keeps the inline widget from
// fighting React's mount/unmount cycle as the user moves between signup steps —
// the previous hand-rolled per-mount injection had no error/timeout handling, so
// a blocked or slow script left the box permanently blank with no way to recover.
let calendlyPromise = null;
function loadCalendlyWidget() {
  if (typeof window !== 'undefined' && window.Calendly) return Promise.resolve();
  if (calendlyPromise) return calendlyPromise;

  calendlyPromise = new Promise((resolve, reject) => {
    const CSS_ID = 'calendly-widget-css';
    if (!document.getElementById(CSS_ID)) {
      const link = document.createElement('link');
      link.id = CSS_ID;
      link.rel = 'stylesheet';
      link.href = 'https://assets.calendly.com/assets/external/widget.css';
      document.head.appendChild(link);
    }

    const SCRIPT_ID = 'calendly-widget-js';
    let script = document.getElementById(SCRIPT_ID);
    if (!script) {
      script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = 'https://assets.calendly.com/assets/external/widget.js';
      script.async = true;
      document.body.appendChild(script);
    }

    script.addEventListener('load', () => {
      if (window.Calendly) resolve();
      else reject(new Error('Calendly loaded but did not initialize'));
    }, { once: true });
    script.addEventListener('error', () => {
      // Drop the cached promise so a later mount can retry from a clean slate.
      calendlyPromise = null;
      reject(new Error('Calendly widget script blocked or failed to load'));
    }, { once: true });
  });
  return calendlyPromise;
}

// Calendly inline embed. Renders the scheduling calendar into our container with
// the prospect's name + email pre-filled. Shows a loading state until the iframe
// actually appears and, if the widget can't load (blocked script, slow network,
// etc.), degrades to a plain booking link so the user is never stranded on a
// blank box. The container carries an explicit height/min-height so it can never
// collapse to zero.
function CalendlyEmbed({ name, email, onScheduled }) {
  const ref = useRef(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'failed'

  // Auto-advance once the user completes a booking. Calendly's inline widget
  // posts a `calendly.event_scheduled` message to the parent window on success;
  // we verify the origin is Calendly's before reacting, then wait ~1.5s so the
  // widget's own confirmation registers before redirecting (same destination as
  // "Skip for now"). The listener is torn down on unmount so it can't fire on a
  // later step or page.
  useEffect(() => {
    if (!onScheduled) return undefined;
    let redirectTimer;
    const handleMessage = (event) => {
      if (typeof event.origin !== 'string' || !event.origin.includes('calendly.com')) return;
      if (!event.data || event.data.event !== 'calendly.event_scheduled') return;
      redirectTimer = setTimeout(() => onScheduled(), 1500);
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [onScheduled]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    let cancelled = false;
    let observer;

    // Safety net: if the iframe never shows up, fall back to the plain link.
    const fallbackTimer = setTimeout(() => {
      if (!cancelled && !node.querySelector('iframe')) setStatus('failed');
    }, CALENDLY_FALLBACK_MS);

    loadCalendlyWidget()
      .then(() => {
        if (cancelled || !window.Calendly) return;
        node.innerHTML = '';
        window.Calendly.initInlineWidget({
          url: `${CALENDLY_URL}?hide_gdpr_banner=1`,
          parentElement: node,
          prefill: { name: name || '', email: email || '' },
        });

        // Calendly appends the iframe asynchronously; clear the loading overlay as
        // soon as it shows up (re-checks via a short-lived observer if not yet).
        const markReady = () => { if (!cancelled) setStatus('ready'); };
        if (node.querySelector('iframe')) {
          markReady();
        } else {
          observer = new MutationObserver(() => {
            if (node.querySelector('iframe')) {
              markReady();
              observer.disconnect();
            }
          });
          observer.observe(node, { childList: true, subtree: true });
        }
      })
      .catch(() => { if (!cancelled) setStatus('failed'); });

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      if (observer) observer.disconnect();
      node.innerHTML = '';
    };
  }, [name, email]);

  return (
    <div className="relative w-full" style={{ minHeight: `${CALENDLY_HEIGHT}px` }}>
      {/* Deliberately NOT given Calendly's `calendly-inline-widget` class:
          widget.js runs a one-time auto-init on load that scans for that class
          and initializes each match from its `data-url`. With no data-url it
          injects a blank, urlless iframe that races/overrides our own
          initInlineWidget call below — an iframe appears (so we'd mark "ready")
          but renders blank. A plain container guarantees only our init, with the
          correct URL, ever populates it. */}
      <div
        ref={ref}
        className="w-full overflow-hidden rounded-xl"
        style={{ minWidth: '320px', height: `${CALENDLY_HEIGHT}px`, minHeight: `${CALENDLY_HEIGHT}px` }}
      />

      {status === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-surface">
          <Loader2 size={22} className="animate-spin text-brand" />
          <p className="text-sm text-muted">Loading scheduler…</p>
        </div>
      )}

      {status === 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl border border-divider bg-surface-2 px-6 text-center">
          <p className="max-w-xs text-sm text-muted">
            We couldn't load the scheduler here — it may be blocked by your browser.
          </p>
          <a
            href={CALENDLY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-content transition-colors hover:bg-brand"
          >
            Open the booking page <ArrowRight size={15} />
          </a>
        </div>
      )}
    </div>
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
        <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
      )}

      <button
        type="submit"
        disabled={!stripe || processing}
        className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-content transition-colors hover:bg-brand disabled:opacity-50"
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
        className="inline-flex w-full items-center justify-center gap-1.5 text-sm font-medium text-muted hover:text-content disabled:opacity-50"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
        <Lock size={12} /> Secured by Stripe · cancel anytime
      </p>

      <p className="text-center text-xs leading-relaxed text-muted">
        By subscribing you agree to our{' '}
        <Link to="/terms" target="_blank" className="font-medium text-muted hover:text-content">
          Terms of Service
        </Link>{' '}
        and{' '}
        <Link to="/privacy" target="_blank" className="font-medium text-muted hover:text-content">
          Privacy Policy
        </Link>
        .
      </p>
    </form>
  );
}

// ── Step 3, no-payment variant ────────────────────────────────────────────────
// A 100%-off promo zeroes the first invoice, so Stripe has nothing to charge and
// there's no PaymentIntent to confirm. We swap the card form for this simple
// confirm button, which registers the account directly via onComplete().
function FreeCheckout({ onComplete, onBack }) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

  const handleConfirm = async () => {
    if (processing) return;
    setProcessing(true);
    setError(null);
    try {
      await onComplete();
      // onComplete advances to Step 4, unmounting this component.
    } catch (err) {
      setError(err.message || 'We hit a snag creating your account. Please contact support.');
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg bg-success/10 px-3 py-2.5 text-sm text-success">
        No payment due today — your promo code covers your subscription.
      </div>

      {error && (
        <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
      )}

      <button
        type="button"
        onClick={handleConfirm}
        disabled={processing}
        className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-content transition-colors hover:bg-brand disabled:opacity-50"
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
        className="inline-flex w-full items-center justify-center gap-1.5 text-sm font-medium text-muted hover:text-content disabled:opacity-50"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
        <Lock size={12} /> Secured by Stripe · cancel anytime
      </p>
    </div>
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
// a duplicate (incomplete) subscription. An applied promo code is part of the
// identity so editing earlier steps re-creates the subscription with it intact.
function paymentSignature(form, promotionCode = '') {
  return [
    form.email.trim().toLowerCase(),
    form.firstName.trim(),
    form.lastName.trim(),
    form.businessName.trim(),
    promotionCode || '',
  ].join('|');
}

export default function SignupPage() {
  const navigate = useNavigate();
  const { register } = useAuth();
  const stripePromise = useMemo(() => getStripe(), []);

  // Destination after the setup-call step — used by both "Skip for now" and the
  // auto-advance that fires when a booking completes. Memoized so passing it to
  // CalendlyEmbed doesn't re-subscribe its message listener on every render.
  const goToDashboard = useCallback(() => navigate('/dashboard'), [navigate]);

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
  const [payment, setPayment] = useState(null); // { clientSecret | noPaymentRequired, customerId, subscriptionId, sig }
  const [preparing, setPreparing] = useState(false); // creating the Stripe subscription
  const [prepError, setPrepError] = useState(null);

  // Promo code (Step 3, optional)
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState(null); // { promotionCode, discount } once applied
  const [promoApplying, setPromoApplying] = useState(false);
  const [promoError, setPromoError] = useState(null);

  useEffect(() => {
    document.title = 'Get Started — Stream';
  }, []);

  const setField = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  const inputClass = (name) =>
    `w-full rounded-lg border px-4 py-2.5 text-sm text-content transition-colors focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand ${
      errors[name] ? 'border-danger' : 'border-divider'
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

    const sig = paymentSignature(form, promo?.promotionCode);
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
        promotionCode: promo?.promotionCode,
      });
      setPayment({ ...data, sig });
      setStep(3);
    } catch (err) {
      setPrepError(err.message || 'Could not start checkout. Please try again.');
    } finally {
      setPreparing(false);
    }
  };

  // Step 3: validate a promo code, then re-create the subscription with it so the
  // amount due (and the PaymentElement, or the no-payment path) reflects the
  // discount. The promotion code id from validation is what Stripe needs.
  const applyPromo = async () => {
    const code = promoInput.trim();
    if (!code || promoApplying) return;

    setPromoApplying(true);
    setPromoError(null);
    try {
      const result = await api.validatePromo(code);
      if (!result || !result.valid) {
        setPromoError('Invalid promo code');
        return;
      }

      const data = await api.createSignupSubscription({
        email: form.email.trim(),
        name: `${form.firstName.trim()} ${form.lastName.trim()}`.trim(),
        businessName: form.businessName.trim(),
        promotionCode: result.promotionCode,
      });
      setPayment({ ...data, sig: paymentSignature(form, result.promotionCode) });
      setPromo({ promotionCode: result.promotionCode, discount: result.discount });
    } catch (err) {
      setPromoError(err.message || 'Could not apply promo code. Please try again.');
    } finally {
      setPromoApplying(false);
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
    <div className="min-h-screen w-full overflow-y-auto bg-surface-2">
      <style>{`
        @keyframes signup-step-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .signup-step { animation: signup-step-in 0.28s ease-out; }
      `}</style>

      <header className="border-b border-divider bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Wordmark />
          <span className="text-sm text-muted">Step {step} of {TOTAL_STEPS}</span>
        </div>
      </header>

      <main className="mx-auto flex w-full flex-col px-4 py-10 sm:py-14">
        <div className={`mx-auto w-full ${containerWidth}`}>
          <StepBar step={step} />

          <div key={step} className="signup-step mt-6">
            {/* ── Step 1 — Account Info ─────────────────────────────────── */}
            {step === 1 && (
              <div className="rounded-2xl border border-divider bg-surface p-7 shadow-sm">
                <h1 className="text-2xl font-bold tracking-tight text-content">Create your account</h1>
                <p className="mt-1.5 text-sm text-muted">Let's get you set up with Stream.</p>

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
                    className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-content transition-colors hover:bg-brand"
                  >
                    Next
                    <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
                  </button>
                </form>

                <p className="mt-5 text-center text-sm text-muted">
                  Already have an account?{' '}
                  <Link to="/login" className="font-medium text-brand hover:text-brand">
                    Sign in
                  </Link>
                </p>
              </div>
            )}

            {/* ── Step 2 — Your Business ────────────────────────────────── */}
            {step === 2 && (
              <div className="rounded-2xl border border-divider bg-surface p-7 shadow-sm">
                <h1 className="text-2xl font-bold tracking-tight text-content">Tell us about your business</h1>
                <p className="mt-1.5 text-sm text-muted">This tailors Stream to how you work.</p>

                <form onSubmit={submitBusiness} className="mt-6 space-y-5">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-content">Industry type</label>
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
                                ? 'border-brand bg-brand/10 ring-2 ring-brand/30'
                                : 'border-divider bg-surface hover:border-divider hover:bg-surface-2'
                            }`}
                          >
                            <Icon size={22} className={selected ? 'text-brand' : 'text-muted'} />
                            <span className={`text-xs font-medium ${selected ? 'text-brand' : 'text-muted'}`}>
                              {id}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {errors.industryType && <p className="mt-1.5 text-xs text-danger">{errors.industryType}</p>}
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
                    <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{prepError}</div>
                  )}

                  <button
                    type="submit"
                    disabled={preparing}
                    className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-content transition-colors hover:bg-brand disabled:opacity-50"
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
                    className="inline-flex w-full items-center justify-center gap-1.5 text-sm font-medium text-muted hover:text-content disabled:opacity-50"
                  >
                    <ArrowLeft size={15} /> Back
                  </button>
                </form>
              </div>
            )}

            {/* ── Step 3 — Payment ──────────────────────────────────────── */}
            {step === 3 && (
              <div className="rounded-2xl border border-divider bg-surface p-7 shadow-sm">
                <h1 className="text-2xl font-bold tracking-tight text-content">Payment</h1>
                <p className="mt-1.5 text-sm text-muted">Start your subscription to activate Stream.</p>

                {/* Order summary */}
                <div className="mt-6 flex items-start justify-between gap-4 rounded-xl border border-divider bg-surface-2 px-4 py-3.5">
                  <div>
                    <p className="text-sm font-semibold text-content">Stream — {PRICE_LABEL}</p>
                    <p className="mt-0.5 text-xs text-muted">Full access to your operations dashboard.</p>
                  </div>
                  <p className="whitespace-nowrap text-base font-bold text-content">$149</p>
                </div>

                {/* Promo code — optional. Validating re-creates the subscription
                    with the discount applied. */}
                <div className="mt-4">
                  <label htmlFor="promoCode" className="mb-1.5 block text-sm font-medium text-content">
                    Promo Code
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="promoCode"
                      type="text"
                      value={promoInput}
                      onChange={(e) => {
                        setPromoInput(e.target.value);
                        if (promoError) setPromoError(null);
                      }}
                      disabled={!!promo || promoApplying}
                      placeholder="Enter promo code"
                      className={`w-full rounded-lg border px-4 py-2.5 text-sm text-content transition-colors focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand disabled:bg-surface-2 disabled:text-muted ${
                        promoError ? 'border-danger' : 'border-divider'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={applyPromo}
                      disabled={!!promo || promoApplying || !promoInput.trim()}
                      className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-divider bg-surface px-5 py-2.5 text-sm font-semibold text-content transition-colors hover:bg-surface-2 disabled:opacity-50"
                    >
                      {promoApplying ? <Loader2 size={15} className="animate-spin" /> : 'Apply'}
                    </button>
                  </div>
                  {promo && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-success">
                      <Check size={13} /> {promo.discount} applied
                    </p>
                  )}
                  {promoError && <p className="mt-1.5 text-xs text-danger">{promoError}</p>}
                </div>

                <div className="mt-6">
                  {payment?.noPaymentRequired ? (
                    <FreeCheckout onComplete={finishSignup} onBack={() => setStep(2)} />
                  ) : payment?.clientSecret ? (
                    <Elements
                      key={payment.clientSecret}
                      stripe={stripePromise}
                      options={{ clientSecret: payment.clientSecret, appearance: STRIPE_APPEARANCE }}
                    >
                      <PaymentForm onComplete={finishSignup} onBack={() => setStep(2)} />
                    </Elements>
                  ) : (
                    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
                      <Loader2 size={16} className="animate-spin" /> Loading secure checkout…
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Step 4 — Schedule Setup Call ──────────────────────────── */}
            {step === 4 && (
              <div className="rounded-2xl border border-divider bg-surface p-7 shadow-sm">
                <div className="text-center">
                  <h1 className="text-2xl font-bold tracking-tight text-content">You're in! 🎉</h1>
                  <p className="mx-auto mt-2 max-w-md text-sm text-muted">
                    Schedule your setup call to activate your advanced booking and extraction features.
                  </p>
                </div>

                <div className="mt-6 overflow-hidden rounded-xl border border-divider">
                  <CalendlyEmbed
                    name={`${form.firstName} ${form.lastName}`.trim()}
                    email={form.email.trim()}
                    onScheduled={goToDashboard}
                  />
                </div>

                <div className="mt-5 text-center">
                  <button
                    onClick={goToDashboard}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-content"
                  >
                    Skip for now <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {step === 4 && (
            <div className="mt-5 flex items-center justify-center gap-2 text-center text-sm text-muted">
              <Check size={15} className="flex-shrink-0 text-brand" />
              We'll walk you through everything on a quick 30-minute call.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
