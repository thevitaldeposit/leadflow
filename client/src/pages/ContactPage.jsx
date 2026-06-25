import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AudioLines, ArrowRight, Check, Loader2 } from 'lucide-react';
import { api } from '../utils/api';

const SUBJECTS = ['General Inquiry', 'Sales', 'Support', 'Partnership', 'Other'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_MESSAGE = 20;

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2 text-content">
      <AudioLines className="text-brand" size={24} strokeWidth={2.5} />
      <span className="text-lg font-bold tracking-tight">Stream</span>
    </Link>
  );
}

function Field({ label, optional, error, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-content">
        {label}
        {optional && <span className="ml-1 font-normal text-muted">(optional)</span>}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export default function ContactPage() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [errors, setErrors] = useState({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    document.title = 'Contact — Stream';
  }, []);

  const setField = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  const inputClass = (name) =>
    `w-full rounded-lg border px-4 py-2.5 text-sm text-content transition-colors focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand ${
      errors[name] ? 'border-danger' : 'border-divider'
    }`;

  const validate = () => {
    const v = {};
    if (!form.name.trim()) v.name = 'Required';
    if (!form.email.trim()) v.email = 'Required';
    else if (!EMAIL_RE.test(form.email.trim())) v.email = 'Enter a valid email address';
    if (!form.message.trim()) v.message = 'Required';
    else if (form.message.trim().length < MIN_MESSAGE)
      v.message = `Please write at least ${MIN_MESSAGE} characters`;
    return v;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (sending) return;

    const v = validate();
    if (Object.keys(v).length) {
      setErrors(v);
      return;
    }

    setSending(true);
    setSubmitError(null);
    try {
      await api.sendContactMessage({
        name: form.name.trim(),
        email: form.email.trim(),
        subject: form.subject || 'General Inquiry',
        message: form.message.trim(),
      });
      setSent(true);
      setForm({ name: '', email: '', subject: '', message: '' });
    } catch {
      setSubmitError(
        'Something went wrong. Please try again or email us directly at info@joinstream.app'
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen w-full overflow-y-auto bg-surface text-content">
      <header className="border-b border-divider bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Wordmark />
          <Link to="/" className="text-sm font-medium text-muted transition-colors hover:text-content">
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-6 py-12 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight text-content sm:text-4xl">Get in Touch</h1>
        <p className="mt-3 text-lg leading-relaxed text-muted">
          Have a question or want to learn more about Stream? We'd love to hear from you.
        </p>

        {sent ? (
          <div className="mt-8 flex items-start gap-3 rounded-2xl border border-brand/30 bg-brand/10 p-6">
            <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand text-content">
              <Check size={14} strokeWidth={3} />
            </span>
            <div>
              <p className="text-sm font-semibold text-content">Thanks for reaching out!</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                We'll get back to you within 1 business day.
              </p>
              <button
                onClick={() => setSent(false)}
                className="mt-3 text-sm font-medium text-brand hover:text-brand"
              >
                Send another message
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <Field label="Full name" error={errors.name}>
              <input
                type="text"
                autoComplete="name"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="Jane Doe"
                className={inputClass('name')}
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

            <Field label="Subject" optional>
              <select
                value={form.subject}
                onChange={(e) => setField('subject', e.target.value)}
                className={`${inputClass('subject')} bg-surface`}
              >
                <option value="">General Inquiry</option>
                {SUBJECTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Message" error={errors.message}>
              <textarea
                rows={6}
                value={form.message}
                onChange={(e) => setField('message', e.target.value)}
                placeholder="How can we help?"
                className={`${inputClass('message')} resize-y`}
              />
            </Field>

            {submitError && (
              <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{submitError}</div>
            )}

            <button
              type="submit"
              disabled={sending}
              className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-content transition-colors hover:bg-brand disabled:opacity-50"
            >
              {sending ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Sending…
                </>
              ) : (
                <>
                  Send Message
                  <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
                </>
              )}
            </button>
          </form>
        )}

        <p className="mt-8 text-sm text-muted">
          Prefer email? Reach us at{' '}
          <a href="mailto:info@joinstream.app" className="font-medium text-brand hover:text-brand">
            info@joinstream.app
          </a>
        </p>
      </main>
    </div>
  );
}
