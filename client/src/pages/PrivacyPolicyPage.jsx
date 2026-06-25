import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AudioLines } from 'lucide-react';

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2 text-content">
      <AudioLines className="text-brand" size={24} strokeWidth={2.5} />
      <span className="text-lg font-bold tracking-tight">Stream</span>
    </Link>
  );
}

function Section({ title, children }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold tracking-tight text-content">{title}</h2>
      <div className="mt-2 space-y-3 leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  useEffect(() => {
    document.title = 'Privacy Policy — Stream';
  }, []);

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

      <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight text-content sm:text-4xl">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted">Last updated: June 2026</p>

        <Section title="1. Introduction">
          <p>
            Stream is a product of Three T's Capital LLC ("we," "us," or "our"). This Privacy Policy
            explains how we collect, use, and protect information when you use Stream ("the Service").
          </p>
        </Section>

        <Section title="2. Information We Collect">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              Account information: name, email address, business name, and industry type provided during
              signup
            </li>
            <li>
              Payment information: processed securely through Stripe — we do not store credit card numbers
            </li>
            <li>
              Business operational data: phone call recordings, transcriptions, and lead information
              captured through your connected phone number
            </li>
            <li>Usage data: how you interact with the Service</li>
          </ul>
        </Section>

        <Section title="3. How We Use Your Information">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>To provide and operate the Service</li>
            <li>To process payments and manage your subscription</li>
            <li>To send transactional emails (account setup, password resets, billing notifications)</li>
            <li>To improve the Service</li>
          </ul>
        </Section>

        <Section title="4. Phone Call Recording">
          <p>
            Stream records inbound business calls for the purpose of lead capture and transcription. By
            using the Service, you agree to notify callers that their call may be recorded, as required by
            applicable law. A recording disclosure is played automatically to callers.
          </p>
        </Section>

        <Section title="5. Data Storage and Security">
          <p>
            Your data is stored securely on Railway infrastructure. Call recordings are automatically
            deleted after 30 days. We use industry-standard security practices to protect your information.
          </p>
        </Section>

        <Section title="6. Third-Party Services">
          <p>
            We use the following third-party services: Twilio (call handling and SMS), Anthropic (AI
            processing), Deepgram (transcription), Stripe (payments), and Resend (email). Each has their own
            privacy policy governing their use of data.
          </p>
        </Section>

        <Section title="7. SMS Communications">
          <p>
            If you use Stream's SMS features, message and data rates may apply. Reply STOP to opt out of SMS
            messages. Reply HELP for help.
          </p>
        </Section>

        <Section title="8. Data Retention">
          <p>
            We retain your account data for as long as your subscription is active. Upon cancellation you may
            request deletion of your data by contacting us at{' '}
            <a href="mailto:info@joinstream.app" className="font-medium text-brand hover:text-brand">
              info@joinstream.app
            </a>
            .
          </p>
        </Section>

        <Section title="9. Your Rights">
          <p>
            You may request access to, correction of, or deletion of your personal data by contacting us at{' '}
            <a href="mailto:info@joinstream.app" className="font-medium text-brand hover:text-brand">
              info@joinstream.app
            </a>
            .
          </p>
        </Section>

        <Section title="10. Contact">
          <p>
            Three T's Capital LLC
            <br />
            Email:{' '}
            <a href="mailto:info@joinstream.app" className="font-medium text-brand hover:text-brand">
              info@joinstream.app
            </a>
          </p>
        </Section>

        <div className="mt-12 border-t border-divider pt-6 text-sm text-muted">
          <Link to="/terms" className="font-medium text-brand hover:text-brand">
            Terms of Service
          </Link>
        </div>
      </main>
    </div>
  );
}
