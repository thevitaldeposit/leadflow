import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  AudioLines,
  PhoneCall,
  Sparkles,
  CircleDollarSign,
  ArrowRight,
  Check,
  Truck,
  Wind,
  Wrench,
  Trees,
  Hammer,
  Building2,
} from 'lucide-react';

const STEPS = [
  {
    icon: PhoneCall,
    title: 'A customer calls',
    body: 'Stream answers your business number and records every conversation — no missed calls, no lost details.',
  },
  {
    icon: Sparkles,
    title: 'AI extracts the lead',
    body: 'The name, number, and job details are pulled out instantly and land in your dashboard the moment the call ends.',
  },
  {
    icon: CircleDollarSign,
    title: 'Follow up & get paid',
    body: 'Follow up, book the job, and collect payment — every lead tracked from first ring to final invoice, all in one place.',
  },
];

const INDUSTRIES = [
  { icon: Truck, label: 'Dumpster Rental' },
  { icon: Wind, label: 'HVAC' },
  { icon: Wrench, label: 'Plumbing' },
  { icon: Trees, label: 'Landscaping' },
  { icon: Hammer, label: 'Roofing' },
  { icon: Building2, label: 'Any service business' },
];

function Wordmark({ className = '' }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <AudioLines className="text-blue-500" size={26} strokeWidth={2.5} />
      <span className="font-bold text-xl tracking-tight">Stream</span>
    </div>
  );
}

export default function LandingPage() {
  useEffect(() => {
    document.title = 'Stream — Never Miss a Customer Again';
  }, []);

  return (
    <div className="h-screen w-full overflow-y-auto bg-white text-slate-900 scroll-smooth">
      {/* ── Hero (dark) ─────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-slate-950 text-white">
        {/* ambient blue glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-blue-600/25 blur-[120px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />

        <div className="relative">
          {/* nav */}
          <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
            <Wordmark />
            <div className="flex items-center gap-3 sm:gap-5">
              <Link
                to="/login"
                className="text-sm font-medium text-slate-300 transition-colors hover:text-white"
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-200"
              >
                Get Started
              </Link>
            </div>
          </nav>

          {/* hero content */}
          <div className="mx-auto max-w-4xl px-6 pb-28 pt-16 text-center sm:pt-24">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-medium text-slate-300 backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
              AI call capture for service businesses
            </div>
            <h1 className="text-balance text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl md:text-7xl">
              Never miss a
              <br className="hidden sm:block" /> customer again
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-slate-300 sm:text-xl">
              Stream captures every call, extracts lead data automatically, and manages your
              follow-ups — so you can focus on the job.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                to="/signup"
                className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-7 py-3.5 text-base font-semibold text-white shadow-lg shadow-blue-600/30 transition-all hover:bg-blue-500 hover:shadow-blue-500/40 sm:w-auto"
              >
                Get Started
                <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" />
              </Link>
              <a
                href="#how-it-works"
                className="inline-flex w-full items-center justify-center rounded-xl border border-white/15 px-7 py-3.5 text-base font-semibold text-white transition-colors hover:bg-white/5 sm:w-auto"
              >
                See how it works
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────── */}
      <section id="how-it-works" className="border-b border-slate-100 bg-white py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-blue-600">
              How it works
            </p>
            <h2 className="mt-3 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
              From ring to revenue, automatically
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              Three steps. Zero spreadsheets. Every lead accounted for.
            </p>
          </div>

          <div className="mt-16 grid gap-8 md:grid-cols-3">
            {STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <div
                  key={step.title}
                  className="relative rounded-2xl border border-slate-200 bg-white p-8 transition-shadow hover:shadow-lg hover:shadow-slate-200/60"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                    <Icon size={24} />
                  </div>
                  <div className="mt-5 flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-blue-600">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <h3 className="text-xl font-semibold tracking-tight text-slate-900">
                      {step.title}
                    </h3>
                  </div>
                  <p className="mt-3 leading-relaxed text-slate-600">{step.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Who it's for ────────────────────────────────────────────── */}
      <section className="bg-slate-50 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-widest text-blue-600">
                Built for the trades
              </p>
              <h2 className="mt-3 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
                If your business runs on phone calls, Stream is for you
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-slate-600">
                Stream is purpose-built for service businesses where every missed call is a missed
                job. The moment the phone rings, you're covered.
              </p>
              <ul className="mt-6 space-y-3">
                {['Capture every inbound call', 'Never lose a lead to a voicemail', 'One place for follow-ups, bookings, and payments'].map(
                  (item) => (
                    <li key={item} className="flex items-center gap-3 text-slate-700">
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
                        <Check size={13} strokeWidth={3} />
                      </span>
                      {item}
                    </li>
                  )
                )}
              </ul>
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {INDUSTRIES.map((ind) => {
                const Icon = ind.icon;
                return (
                  <div
                    key={ind.label}
                    className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-7 text-center transition-colors hover:border-blue-200"
                  >
                    <Icon size={26} className="text-blue-600" />
                    <span className="text-sm font-medium text-slate-700">{ind.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ──────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-slate-950 text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-[28rem] w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600/25 blur-[120px]"
        />
        <div className="relative mx-auto max-w-3xl px-6 py-24 text-center">
          <h2 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Ready to stop missing leads?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-300">
            Get set up in minutes. We'll walk you through everything on a quick call.
          </p>
          <Link
            to="/signup"
            className="group mt-9 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-8 py-4 text-base font-semibold text-white shadow-lg shadow-blue-600/30 transition-all hover:bg-blue-500"
          >
            Get Started
            <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="border-t border-slate-100 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 sm:flex-row">
          <Wordmark className="text-slate-900" />
          <p className="text-sm text-slate-500">
            © {new Date().getFullYear()} Stream. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
