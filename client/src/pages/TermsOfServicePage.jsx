import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AudioLines } from 'lucide-react';

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2 text-slate-900">
      <AudioLines className="text-blue-600" size={24} strokeWidth={2.5} />
      <span className="text-lg font-bold tracking-tight">Stream</span>
    </Link>
  );
}

function Section({ title, children }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
      <div className="mt-2 space-y-3 leading-relaxed text-slate-600">{children}</div>
    </section>
  );
}

export default function TermsOfServicePage() {
  useEffect(() => {
    document.title = 'Terms of Service — Stream';
  }, []);

  return (
    <div className="min-h-screen w-full overflow-y-auto bg-white text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Wordmark />
          <Link to="/" className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-700">
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Terms of Service</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: June 2026</p>

        <Section title="1. Acceptance">
          <p>
            By using Stream, you agree to these Terms of Service. If you do not agree, do not use the
            Service.
          </p>
        </Section>

        <Section title="2. The Service">
          <p>
            Stream is a business operations and lead management platform provided by Three T's Capital LLC.
            We reserve the right to modify or discontinue the Service at any time.
          </p>
        </Section>

        <Section title="3. Subscription and Billing">
          <p>
            Stream is offered as a monthly subscription at $149/month. Your subscription renews
            automatically each month. You may cancel at any time through your account billing settings.
            Cancellations take effect at the end of the current billing period — you retain access until
            then.
          </p>
        </Section>

        <Section title="4. Payment">
          <p>
            Payments are processed by Stripe. By providing payment information you authorize us to charge
            your payment method on a recurring monthly basis.
          </p>
        </Section>

        <Section title="5. Acceptable Use">
          <p>
            You agree to use Stream only for lawful business purposes. You agree not to use Stream to send
            spam, harass individuals, or violate any applicable laws. You are responsible for complying with
            all applicable call recording laws in your jurisdiction.
          </p>
        </Section>

        <Section title="6. Call Recording Compliance">
          <p>
            Stream automatically plays a recording disclosure to inbound callers. You are responsible for
            ensuring your use of call recording features complies with applicable federal and state laws.
          </p>
        </Section>

        <Section title="7. Data">
          <p>
            You retain ownership of your business data. We process it solely to provide the Service. See our{' '}
            <Link to="/privacy" className="font-medium text-blue-600 hover:text-blue-500">
              Privacy Policy
            </Link>{' '}
            for details.
          </p>
        </Section>

        <Section title="8. Limitation of Liability">
          <p>
            Three T's Capital LLC is not liable for any indirect, incidental, or consequential damages
            arising from your use of Stream. Our total liability is limited to the amount you paid in the 30
            days preceding the claim.
          </p>
        </Section>

        <Section title="9. Termination">
          <p>We reserve the right to suspend or terminate your account for violation of these Terms.</p>
        </Section>

        <Section title="10. Governing Law">
          <p>These Terms are governed by the laws of the State of Illinois.</p>
        </Section>

        <Section title="11. Contact">
          <p>
            Three T's Capital LLC
            <br />
            Email:{' '}
            <a href="mailto:info@joinstream.app" className="font-medium text-blue-600 hover:text-blue-500">
              info@joinstream.app
            </a>
          </p>
        </Section>

        <div className="mt-12 border-t border-slate-100 pt-6 text-sm text-slate-500">
          <Link to="/privacy" className="font-medium text-blue-600 hover:text-blue-500">
            Privacy Policy
          </Link>
        </div>
      </main>
    </div>
  );
}
