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
      <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
        <Zap size={16} className="text-emerald-600 flex-shrink-0" />
        <div>
          <p className="text-sm font-bold text-emerald-800">Auto-Booked</p>
          <p className="text-xs text-emerald-600">All 5 booking signals detected — job was automatically confirmed from the call.</p>
        </div>
        {signals.length > 0 && (
          <div className="ml-auto flex flex-wrap gap-1 justify-end">
            {signals.map(s => (
              <span key={s} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
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
      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
        <Zap size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-amber-800">
            Booking signals detected
            <span className="ml-2 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-100 border border-amber-300">
              {bookingConfidence}
            </span>
          </p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {ALL_SIGNALS.map(s => (
              <span key={s} className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                signals.includes(s)
                  ? 'bg-amber-100 text-amber-700 border-amber-300'
                  : 'bg-gray-100 text-gray-400 border-gray-200 line-through'
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
