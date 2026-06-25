import { Zap } from 'lucide-react';

// Shared, display-only booking-signals panel. Renders either the green
// "Auto-Booked" badge (all 5 signals detected on the call) or the amber
// "booking signals detected" panel showing which of the 5 signals fired — or
// nothing when there are no signals. Reused by the lead detail and the customer
// profile so both render identical chrome.
//
// PURELY VISUAL: this reflects what the extraction already stored on the lead.
// It never writes, and it never re-evaluates booking — rendering it cannot
// trigger or change auto-booking.
const SIGNAL_LABELS = {
  price_agreed: 'Price agreed',
  size_confirmed: 'Size confirmed',
  delivery_date_set: 'Delivery date set',
  location_given: 'Location given',
  payment_intent: 'Payment intent',
};

const ALL_SIGNALS = ['price_agreed', 'size_confirmed', 'delivery_date_set', 'location_given', 'payment_intent'];

export default function BookingSignalsPanel({ autoBooked, bookingSignals, bookingConfidence }) {
  const signals = Array.isArray(bookingSignals) ? bookingSignals : [];

  if (autoBooked) {
    return (
      <div className="flex items-center gap-3 bg-success/10 border border-success/30 rounded-xl px-4 py-3">
        <Zap size={16} className="text-success flex-shrink-0" />
        <div>
          <p className="text-sm font-bold text-success">Auto-Booked</p>
          <p className="text-xs text-success">All 5 booking signals detected — job was automatically confirmed from the call.</p>
        </div>
        {signals.length > 0 && (
          <div className="ml-auto flex flex-wrap gap-1 justify-end">
            {signals.map(s => (
              <span key={s} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/30">
                {SIGNAL_LABELS[s] || s}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (bookingConfidence && bookingConfidence !== 'none' && signals.length > 0) {
    return (
      <div className="flex items-start gap-3 bg-warning/10 border border-warning/30 rounded-xl px-4 py-3">
        <Zap size={16} className="text-warning flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-warning">
            Booking signals detected
            <span className="ml-2 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-warning/10 border border-warning/30">
              {bookingConfidence}
            </span>
          </p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {ALL_SIGNALS.map(s => (
              <span key={s} className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                signals.includes(s)
                  ? 'bg-warning/10 text-warning border-warning/30'
                  : 'bg-surface-2 text-muted border-divider line-through'
              }`}>
                {SIGNAL_LABELS[s]}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
