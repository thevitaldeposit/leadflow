import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { api } from '../utils/api';
import { getConnectedStripe } from '../utils/stripe';

// ── PUBLIC, tokenized invoice page ─────────────────────────────────────────────
// Opened by the customer from an email/SMS link with NO login. Renders the line
// items, balance, and terms, captures an e-signature (drawn or typed) + full name,
// then unlocks pay-by-card (Stripe Connect direct charge). Payment is GATED behind
// signing: the Pay area stays disabled until the contract is signed, and the
// server rejects a charge on an unsigned invoice. Self-contained: its own chrome,
// no dashboard layout.

function money(n, currency = 'USD') {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Canvas-based drawing pad with mouse + touch support and a high-DPI backing
// store. Calls onChange(dataUrl|null) as strokes are added/cleared.
function DrawPad({ onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const dirty = useRef(false);

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
  }, []);

  useEffect(() => {
    setup();
    const onResize = () => { setup(); dirty.current = false; onChange(null); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setup, onChange]);

  const pos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  };
  const start = (e) => { e.preventDefault(); drawing.current = true; last.current = pos(e); };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!dirty.current) { dirty.current = true; }
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange(canvasRef.current.toDataURL('image/png'));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = false;
    onChange(null);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="w-full h-40 border border-gray-300 rounded-lg bg-white touch-none cursor-crosshair"
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      <div className="flex justify-between items-center mt-1.5">
        <p className="text-xs text-gray-400">Sign with your mouse or finger</p>
        <button type="button" onClick={clear} className="text-xs text-gray-500 hover:text-gray-700 underline">Clear</button>
      </div>
    </div>
  );
}

function SignSection({ token, invoice, onSigned }) {
  const [mode, setMode] = useState('draw'); // 'draw' | 'type'
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState(null);
  const [agree, setAgree] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const typedSig = name.trim();
  const canSign = agree && name.trim() && (mode === 'draw' ? !!drawn : !!typedSig) && !submitting;

  const submit = async () => {
    setError(null);
    const signatureData = mode === 'draw' ? drawn : typedSig;
    const signatureType = mode === 'draw' ? 'drawn' : 'typed';
    if (!name.trim()) return setError('Please enter your full name.');
    if (!signatureData) return setError(mode === 'draw' ? 'Please draw your signature.' : 'Please type your name as your signature.');
    setSubmitting(true);
    try {
      const signed = await api.signPublicInvoice(token, { signerName: name.trim(), signatureData, signatureType });
      onSigned(signed);
    } catch (e) {
      setError(e.message || 'Could not record your signature. Please try again.');
      setSubmitting(false);
    }
  };

  const tabCls = (active) =>
    `flex-1 text-sm font-medium py-2 rounded-lg transition-colors ${active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`;

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
      <h2 className="text-base font-bold text-gray-900">Accept &amp; Sign</h2>
      <p className="text-sm text-gray-500 mt-1 mb-4">
        By signing, you confirm the details above are correct and agree to the terms.
      </p>

      <div className="flex gap-2 mb-4">
        <button type="button" className={tabCls(mode === 'draw')} onClick={() => setMode('draw')}>Draw signature</button>
        <button type="button" className={tabCls(mode === 'type')} onClick={() => setMode('type')}>Type signature</button>
      </div>

      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Full name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your full legal name"
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2.5 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />

      {mode === 'draw' ? (
        <DrawPad onChange={setDrawn} />
      ) : (
        <div>
          <div className="h-40 border border-gray-300 rounded-lg bg-white flex items-center justify-center px-4 overflow-hidden">
            <span className="text-3xl text-gray-900" style={{ fontFamily: '"Brush Script MT","Segoe Script",cursive' }}>
              {typedSig || 'Your signature'}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-1.5">Your typed name will be used as your signature.</p>
        </div>
      )}

      <label className="flex items-start gap-2.5 mt-4 cursor-pointer">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 w-4 h-4 accent-indigo-600" />
        <span className="text-sm text-gray-600">
          I have read and agree to the terms, and I authorize the work and total of{' '}
          <strong>{money(invoice.total, invoice.currency)}</strong>.
        </span>
      </label>

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={!canSign}
        className="w-full mt-4 py-3.5 rounded-xl text-base font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? 'Recording…' : 'Accept & Sign'}
      </button>
    </div>
  );
}

// Stripe Elements appearance — tuned to this page's accent.
const PAY_APPEARANCE = { theme: 'stripe', variables: { colorPrimary: '#4f46e5', borderRadius: '10px' } };

// Centered "Payment Complete" success screen. Rendered BOTH immediately after a
// successful client-side confirm (inside CardForm, before any server round-trip)
// AND for an already-paid invoice (PaymentSection) — same component both ways, so
// the instant success and the later webhook-reconciled receipt never disagree and
// there's no jarring swap. The card line shows only when brand + last4 are known
// (they aren't surfaced to this public page today, so it's gracefully omitted
// rather than invented).
function PaymentComplete({ amountLabel, cardBrand, cardLast4, paidAt }) {
  const card =
    cardBrand && cardLast4
      ? `${cardBrand.charAt(0).toUpperCase()}${cardBrand.slice(1)} ${cardLast4}`
      : null;
  return (
    <div className="bg-white rounded-2xl shadow-sm p-6 sm:p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-4xl mx-auto">
        ✓
      </div>
      <h2 className="text-xl font-bold text-gray-900 mt-4">Payment Complete</h2>
      <p className="text-3xl font-extrabold text-gray-900 mt-2">{amountLabel}</p>
      {card && <p className="text-sm text-gray-500 mt-1.5">{card}</p>}
      {paidAt && <p className="text-xs text-gray-400 mt-3">Paid {fmtDateTime(paidAt)}</p>}
    </div>
  );
}

// The card form, mounted inside <Elements> (bound to the business's CONNECTED
// account). On a successful confirm it flips the invoice to paid via the confirm
// endpoint (the Connect webhook is the async backstop) and hands the updated
// invoice back up. Card data is collected by Stripe and never touches our server.
function CardForm({ token, amountLabel, onPaid, onCancel }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [paid, setPaid] = useState(null); // truthy once the card confirm succeeds

  const submit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements || processing) return;
    setProcessing(true);
    setError(null);
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      // Card payments resolve inline with redirect:'if_required'; the return_url is
      // only used by redirect-based methods and never actually navigates for cards.
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });

    if (confirmError) {
      setError(confirmError.message || 'Payment failed. Please check your details and try again.');
      setProcessing(false);
      return;
    }

    if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
      // Show the success screen immediately from the client's OWN confirmation —
      // don't gate it on our confirm endpoint or the async Connect webhook. That
      // race is exactly what used to surface a misleading red "it went through…"
      // message styled like a failure, with the Pay button still showing.
      setPaid({});
      // Best-effort: flip the invoice to paid server-side now so a reload, the
      // receipt, and the header "Paid" badge reflect it. The webhook is the
      // backstop, so a failure here is intentionally silent — the customer has
      // already seen success.
      api.confirmInvoicePayment(token, paymentIntent.id)
        .then((updated) => { if (updated) onPaid(updated); })
        .catch(() => {});
      return;
    }

    setError('Payment could not be completed. Please try again.');
    setProcessing(false);
  };

  // Replace the whole form with the success screen once paid — no Pay button, no
  // form, no red text for a success.
  if (paid) {
    return <PaymentComplete amountLabel={amountLabel} cardBrand={paid.cardBrand} cardLast4={paid.cardLast4} />;
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={!stripe || processing}
        className="w-full py-3.5 rounded-xl text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        {processing ? 'Processing…' : `Pay ${amountLabel}`}
      </button>
      <button type="button" onClick={onCancel} disabled={processing} className="w-full text-sm text-gray-500 hover:text-gray-700">
        Cancel
      </button>
    </form>
  );
}

// Payment section. Three states: already paid (receipt), payments not enabled by
// the business (informational, no Pay button — preserves the original behavior),
// or pay-by-card (start → mount Elements on the connected account → confirm).
function PaymentSection({ token, invoice, onPaid }) {
  const [pi, setPi] = useState(null); // { clientSecret, connectedAccountId, publishableKey, paymentIntentId }
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await api.createInvoicePayment(token);
      if (res && res.alreadyPaid) { onPaid(); return; }
      if (res && res.clientSecret && res.connectedAccountId) setPi(res);
      else setError('Could not start payment. Please try again.');
    } catch (e) {
      setError(e.message || 'Could not start payment. Please try again.');
    } finally {
      setStarting(false);
    }
  };

  // Stripe.js bound to the connected account (memoized so re-renders don't reload).
  const stripePromise = useMemo(
    () => (pi ? getConnectedStripe(pi.connectedAccountId, pi.publishableKey) : null),
    [pi]
  );

  if (invoice.paid_at) {
    const refunded = Number(invoice.amount_refunded) > 0;
    // Straight payment → the clean centered success screen (same one CardForm
    // shows the instant the card confirms). Refunds keep the informational amber
    // row — a refund isn't a "success" to celebrate with a green check.
    if (!refunded) {
      return (
        <PaymentComplete
          amountLabel={money(invoice.amount_paid || invoice.total, invoice.currency)}
          paidAt={invoice.paid_at}
        />
      );
    }
    return (
      <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg flex-shrink-0 bg-amber-100 text-amber-700">↩</div>
          <div>
            <p className="font-semibold text-amber-900">Refunded</p>
            <p className="text-sm text-gray-500">
              {money(invoice.amount_paid || invoice.total, invoice.currency)} paid · {fmtDateTime(invoice.paid_at)} · {money(invoice.amount_refunded, invoice.currency)} refunded
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!invoice.payment_enabled) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
        <h2 className="text-base font-bold text-gray-900">Payment</h2>
        <p className="text-sm text-gray-500 mt-1">
          {invoice.business?.phone ? 'Contact the business to arrange payment.' : 'The business will share payment options with you.'}
        </p>
      </div>
    );
  }

  // Gate: payment unlocks only after the contract is signed. Until then the Pay
  // area is rendered disabled (button not clickable) with a hint pointing back to
  // the signature card above. The server enforces the same rule, so this is UX,
  // not the security boundary. Once `signed_at` lands (the sign call updates the
  // invoice in state) this branch falls through to the live Pay flow below.
  if (invoice.signature_required && !invoice.signed_at) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
        <h2 className="text-base font-bold text-gray-900">Pay this invoice</h2>
        <p className="text-sm text-gray-500 mt-1 mb-4">Pay securely by card. Powered by Stripe.</p>
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="w-full py-3.5 rounded-xl text-base font-bold text-white bg-gray-300 cursor-not-allowed flex items-center justify-center gap-2"
        >
          <span aria-hidden="true">🔒</span> Pay {money(invoice.total, invoice.currency)} by card
        </button>
        <p className="text-sm text-gray-500 mt-2 text-center">Sign above to enable payment</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
      <h2 className="text-base font-bold text-gray-900">Pay this invoice</h2>
      <p className="text-sm text-gray-500 mt-1 mb-4">Pay securely by card. Powered by Stripe.</p>
      {pi && stripePromise ? (
        <Elements stripe={stripePromise} options={{ clientSecret: pi.clientSecret, appearance: PAY_APPEARANCE }}>
          <CardForm token={token} amountLabel={money(invoice.total, invoice.currency)} onPaid={onPaid} onCancel={() => setPi(null)} />
        </Elements>
      ) : (
        <>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="w-full py-3.5 rounded-xl text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {starting ? 'Starting…' : `Pay ${money(invoice.total, invoice.currency)} by card`}
          </button>
        </>
      )}
    </div>
  );
}

export default function PublicInvoicePage() {
  const { token } = useParams();
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    api.getPublicInvoice(token)
      .then((inv) => { if (active) setInvoice(inv); })
      .catch((e) => { if (active) setError(e.status === 404 ? 'This invoice link is invalid or has expired.' : (e.message || 'Could not load this invoice.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  if (loading) {
    return (
      <div className="h-screen w-full overflow-y-auto flex items-center justify-center bg-slate-100">
        <div className="animate-spin w-7 h-7 border-2 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="h-screen w-full overflow-y-auto flex items-center justify-center bg-slate-100 px-4">
        <div className="bg-white rounded-2xl shadow-sm p-8 max-w-sm text-center">
          <div className="w-12 h-12 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center text-2xl mx-auto mb-4">✕</div>
          <h1 className="text-lg font-bold text-gray-900">Invoice unavailable</h1>
          <p className="text-sm text-gray-500 mt-2">{error}</p>
        </div>
      </div>
    );
  }

  const inv = invoice;
  const isSigned = !!inv.signed_at;
  const isPaid = !!inv.paid_at;
  const isRefunded = Number(inv.amount_refunded) > 0;
  const biz = inv.business || {};

  // After a successful payment: use the updated invoice the confirm endpoint
  // returns, or re-fetch if we only learned it was already paid.
  const handlePaid = async (updated) => {
    if (updated) { setInvoice(updated); return; }
    try { setInvoice(await api.getPublicInvoice(token)); } catch { /* keep current */ }
  };

  return (
    // The global CSS locks html/body scroll (so the authed dashboard's <main> is
    // the only scroller). This page renders with no dashboard chrome, so it must
    // be its own scroll container — otherwise everything past the first viewport
    // (sign + pay) is clipped and unreachable, especially on mobile. Mirrors the
    // h-screen/overflow-y-auto pattern the other public pages (e.g. LandingPage) use.
    <div className="h-screen w-full overflow-y-auto bg-slate-100 pb-12">
      {/* Branded header */}
      <div className="bg-slate-900 text-white">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 flex items-center justify-between">
          <div>
            <p className="text-xl font-bold tracking-tight">{biz.name}</p>
            <p className="text-sm text-white/60 mt-0.5">Invoice {inv.invoice_number}</p>
          </div>
          <div className="text-right">
            {isRefunded ? (
              <span className="inline-block text-xs font-bold uppercase tracking-wide px-3 py-1 rounded-full bg-amber-500/20 text-amber-200">Refunded</span>
            ) : isPaid ? (
              <span className="inline-block text-xs font-bold uppercase tracking-wide px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300">Paid</span>
            ) : isSigned ? (
              <span className="inline-block text-xs font-bold uppercase tracking-wide px-3 py-1 rounded-full bg-violet-500/20 text-violet-200">Signed</span>
            ) : (
              <span className="inline-block text-xs font-bold uppercase tracking-wide px-3 py-1 rounded-full bg-white/10 text-white/70">Awaiting signature</span>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {/* Signed confirmation banner */}
        {isSigned && (
          <div className="bg-violet-50 border border-violet-200 rounded-2xl p-5 flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center flex-shrink-0 text-lg">✓</div>
            <div>
              <p className="font-semibold text-violet-900">Signed by {inv.signer_name}</p>
              <p className="text-sm text-violet-700/80">{fmtDateTime(inv.signed_at)}</p>
            </div>
          </div>
        )}

        {/* Meta + bill-to */}
        <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Billed to</p>
              <p className="font-medium text-gray-900">{inv.bill_to_name || '—'}</p>
              {inv.bill_to_address && <p className="text-gray-500">{inv.bill_to_address}</p>}
              {inv.bill_to_email && <p className="text-gray-500">{inv.bill_to_email}</p>}
              {inv.bill_to_phone && <p className="text-gray-500">{inv.bill_to_phone}</p>}
            </div>
            <div className="text-right">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Details</p>
              <p className="text-gray-500">Issued <span className="text-gray-800">{fmtDate(inv.issue_date)}</span></p>
              {inv.due_date && <p className="text-gray-500">Due <span className="text-gray-800">{fmtDate(inv.due_date)}</span></p>}
            </div>
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                <th className="text-right px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Qty</th>
                <th className="text-right px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Rate</th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {inv.line_items.length === 0 ? (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-gray-400">No line items.</td></tr>
              ) : inv.line_items.map((it, i) => (
                <tr key={i}>
                  <td className="px-5 py-3 text-gray-800">
                    {it.description}
                    {it.unit ? <span className="text-gray-400 text-xs"> / {it.unit}</span> : null}
                  </td>
                  <td className="px-3 py-3 text-right text-gray-600 whitespace-nowrap">{it.quantity}</td>
                  <td className="px-3 py-3 text-right text-gray-600 whitespace-nowrap">{money(it.unit_rate, inv.currency)}</td>
                  <td className="px-5 py-3 text-right text-gray-900 font-medium whitespace-nowrap">{money(it.amount, inv.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Totals */}
          <div className="border-t border-gray-100 px-5 py-4 space-y-1.5">
            <div className="flex justify-between text-sm text-gray-500">
              <span>Subtotal</span><span>{money(inv.subtotal, inv.currency)}</span>
            </div>
            {inv.tax_amount > 0 && (
              <div className="flex justify-between text-sm text-gray-500">
                <span>Tax{inv.tax_rate ? ` (${inv.tax_rate}%)` : ''}</span><span>{money(inv.tax_amount, inv.currency)}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline pt-2 mt-1 border-t border-gray-100">
              <span className="text-sm font-semibold text-gray-700">Balance Due</span>
              <span className="text-2xl font-extrabold text-gray-900">{money(inv.total, inv.currency)}</span>
            </div>
          </div>
        </div>

        {inv.notes && (
          <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Note</p>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{inv.notes}</p>
          </div>
        )}

        {/* Terms / contract — the full agreement flows naturally in the page so it
            reads top-to-bottom and the Sign card below stays reachable by scrolling
            the page (this page is its own scroll container). No inner scroll box:
            on mobile a nested scroller is cramped for a multi-section contract. */}
        <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Terms &amp; Conditions</p>
          <div className="text-[13px] text-gray-700 whitespace-pre-wrap leading-relaxed">
            {inv.terms || 'No additional terms.'}
          </div>
        </div>

        {/* Sign or signed-signature display */}
        {isSigned ? (
          <div className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Signature</p>
            {inv.signature_type === 'drawn' && inv.signature_data?.startsWith('data:image') ? (
              <img src={inv.signature_data} alt="Signature" className="h-20 border border-gray-200 rounded-lg bg-white" />
            ) : (
              <span className="text-3xl text-gray-900" style={{ fontFamily: '"Brush Script MT","Segoe Script",cursive' }}>{inv.signature_data}</span>
            )}
            <p className="text-sm text-gray-500 mt-3">{inv.signer_name} · {fmtDateTime(inv.signed_at)}</p>
          </div>
        ) : (
          <SignSection token={token} invoice={inv} onSigned={setInvoice} />
        )}

        {/* Payment — pay-by-card when the business has Connect enabled */}
        <PaymentSection token={token} invoice={inv} onPaid={handlePaid} />

        <div className="text-center pt-2">
          {biz.phone && <p className="text-sm text-gray-500">Questions? Call <a href={`tel:${biz.phone}`} className="text-indigo-600">{biz.phone}</a></p>}
          <p className="text-xs text-gray-400 mt-2">Powered by Stream</p>
        </div>
      </div>
    </div>
  );
}
