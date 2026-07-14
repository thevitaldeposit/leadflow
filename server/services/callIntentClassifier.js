// ── Call-intent classifier ─────────────────────────────────────────────────────
// When a call comes from a customer who ALREADY has an open job, this figures out
// what the call is asking for (reschedule, cancel, swap, extension, …) so the
// pipeline can act on it instead of treating it as a generic new inquiry.
//
// This module deliberately builds its OWN Anthropic client and prompt. It CONSUMES
// the extraction engine's output — it must never import, reach into, or mutate the
// extraction engine (verticalExtractionEngine.js), whose client/model are
// module-private on purpose. Any failure here returns null so the caller falls
// straight back to today's behavior (see the webhook's call-intent block).

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Own timeout + retry budget so a slow/hung model call can never stall the pipeline.
const CLASSIFIER_TIMEOUT_MS = Number(process.env.STREAM_CALL_INTENT_TIMEOUT_MS) || 15000;

// The single intent this call is asking for, relative to the caller's open job.
const VALID_INTENTS = new Set([
  'pickup_change',       // move WHEN pickup happens (earlier, or a logistics change) — not extra days
  'delivery_reschedule', // change the drop-off date/time
  'extension',           // KEEP the dumpster additional days (incurs extra-day charges)
  'swap',                // haul the full dumpster away and drop an empty replacement
  'cancellation',        // cancel the job entirely
  'additional_dumpster', // a SEPARATE second unit / second site, on top of the existing one
  'none',                // none of the above (general question, confirmation, unrelated, new inquiry)
]);

function buildSystemPrompt(job, today) {
  const j = job || {};
  const dateLine = today && today.label ? `Today is ${today.label} (${today.iso}).` : '';
  return `You classify a phone call from an EXISTING dumpster-rental customer who already has an open job.
${dateLine}

The customer's current job:
- Dumpster size: ${j.dumpster_size || 'unknown'}
- Delivery date: ${j.delivery_date || 'unknown'}
- Pickup date: ${j.pickup_date || 'unknown'}
- Delivery time: ${j.scheduled_time || 'unspecified'}
- Service address: ${j.address || 'unknown'}
- Rental duration: ${j.rental_duration || 'unknown'}

Decide the ONE thing this call is primarily asking for. Definitions:
- "delivery_reschedule": change the DELIVERY (drop-off) day or time to a different one.
- "pickup_change": pick the dumpster up on a different day than currently scheduled WITHOUT asking to keep it longer for more days — e.g. "we finished early, grab it tomorrow" or "come Friday instead of Thursday".
- "extension": the customer wants to KEEP the dumpster ADDITIONAL days beyond the current pickup — i.e. MORE rental days, which incurs extra-day charges. E.g. "can I keep it a few more days", "extend it a week".
- "swap": the customer is DONE with the CURRENT dumpster and needs it REPLACED within the same job — haul the current (usually full) unit away and drop an empty one in its place. The number of dumpsters on site stays the SAME (one leaves, one arrives), usually the same size; the customer is continuing the same job with a fresh unit, not adding capacity.
- "cancellation": cancel the job entirely.
- "additional_dumpster": the customer wants ANOTHER dumpster IN ADDITION to the current one — the current unit STAYS and a new, separate unit is added (more total capacity, a second unit, or one at another site). The number of dumpsters on site INCREASES.
- "none": none of the above — a general question, a confirmation, an unrelated call, or a brand-new inquiry.

CRITICAL distinction — extension vs pickup_change: both can move the pickup date later, but choose "extension" whenever the customer wants to keep the dumpster LONGER (more days); choose "pickup_change" only when they are just rescheduling when pickup happens without asking for extra days. When in doubt and they clearly want it longer, pick "extension".

CRITICAL distinction — swap vs additional_dumpster: both involve a fresh dumpster arriving, so do NOT decide by literal words like "full" or "swap it out" — decide by whether the CURRENT dumpster STAYS or GOES. Current one hauled away and replaced (net units on site unchanged) → "swap". Current one stays and another is added (net units increase) → "additional_dumpster". Weigh the OWNER's side of the call, not just the customer's: the owner often restates the plan ("so we'll grab the full one and drop a fresh 20, that it?" → swap; "so you want a second one out there on top of the first" → additional_dumpster) — trust that confirmation over the customer's loose phrasing.

Output a SINGLE JSON object, no other text, with EXACTLY these keys:
{
  "intent": one of ${[...VALID_INTENTS].map((i) => `"${i}"`).join(', ')},
  "newDeliveryDate": "YYYY-MM-DD or null",   // resolved new delivery date if a delivery_reschedule
  "deliveryPhrase": "the exact words the customer used for the new delivery timing, or null",
  "newPickupDate": "YYYY-MM-DD or null",     // resolved new pickup date if the pickup moves
  "pickupPhrase": "the exact words the customer used for the new pickup timing, or null",
  "newTime": "new delivery time like \\"8:00 AM\\", or null",
  "extraDays": integer or null,              // for an extension, how many EXTRA days if stated
  "swapSize": "requested replacement size if it differs from the current size, e.g. \\"30 yard\\", or null",
  "reason": "a short reason phrase the customer gave (especially for a cancellation), or null",
  "confidence": a number 0.0-1.0 for how sure you are of the intent
}

Only fill schedule fields the customer actually specified; leave anything unstated null. Always include the raw customer phrase (deliveryPhrase / pickupPhrase) when they mention timing, so dates can be recomputed reliably downstream.`;
}

// Strip code fences / surrounding prose and parse the model's JSON. Mirrors the
// extraction engine's tolerant parse. Returns null (never throws) on failure.
function parseJson(rawText) {
  if (!rawText) return null;
  let text = String(rawText).trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (_) {}
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch (_) {}
  }
  return null;
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

function cleanIso(v) {
  const s = cleanStr(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function cleanInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Normalize the raw model object into a safe, typed result. Never throws.
function normalizeResult(parsed) {
  if (!parsed || !VALID_INTENTS.has(parsed.intent)) return null;
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = null;
  else confidence = Math.max(0, Math.min(1, confidence));
  return {
    intent: parsed.intent,
    newDeliveryDate: cleanIso(parsed.newDeliveryDate),
    deliveryPhrase: cleanStr(parsed.deliveryPhrase),
    newPickupDate: cleanIso(parsed.newPickupDate),
    pickupPhrase: cleanStr(parsed.pickupPhrase),
    newTime: cleanStr(parsed.newTime),
    extraDays: cleanInt(parsed.extraDays),
    swapSize: cleanStr(parsed.swapSize),
    reason: cleanStr(parsed.reason),
    confidence,
  };
}

// Classify a call against the caller's existing open job.
//   input: { transcript, job, today? }
//     - transcript: the call transcript (string)
//     - job: the open engagement's state ({ status, dumpster_size, delivery_date,
//            pickup_date, scheduled_time, address, rental_duration })
//     - today: optional { iso, label } for relative-date context
// Returns a normalized result object, or null on ANY failure / missing input /
// invalid intent — the caller treats null as "do nothing, behave as today".
async function classifyCallIntent({ transcript, job, today } = {}) {
  try {
    if (!transcript || !job) return null;
    if (!process.env.ANTHROPIC_API_KEY) return null;

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 512,
        system: buildSystemPrompt(job, today),
        messages: [
          {
            role: 'user',
            content: `Call transcript:\n\n${transcript}\n\nOutput a single JSON object — no other text.`,
          },
        ],
      },
      { timeout: CLASSIFIER_TIMEOUT_MS, maxRetries: 1 }
    );

    const raw = response && response.content && response.content[0] ? response.content[0].text : null;
    return normalizeResult(parseJson(raw));
  } catch (err) {
    console.error('[callIntentClassifier] classify error:', err.message);
    return null;
  }
}

module.exports = {
  classifyCallIntent,
  // Exported for unit tests — pure, no network.
  buildSystemPrompt,
  parseJson,
  normalizeResult,
  VALID_INTENTS,
  MODEL,
};
