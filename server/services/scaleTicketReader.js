const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Scale-ticket photo reader ─────────────────────────────────────────────────
//
// Reads the WEIGHT off a photographed scale ticket so the owner doesn't have to
// type it. This is a SHORTCUT, never an authority: the value it returns pre-fills
// the same pounds box the owner would have typed into, and nothing is submitted
// until they confirm it. Manual typing always works whether or not this ever runs.
//
// This file deliberately COPIES the vision call pattern from
// services/extractionEngine.js (base64 image → Claude) rather than importing it.
// extractionEngine.js is the load-bearing auto-dealer extraction path and is
// fenced off — it must not grow a second, unrelated job.
//
// A scale ticket usually prints several weights (GROSS / TARE / NET, sometimes in
// tons rather than pounds), so the reader returns BOTH the number and which line
// it read it from, and the UI shows the owner that label next to the pre-filled
// box. Net is what a haul actually bills on, so that's what we ask for.

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/jpeg',
  '.heif': 'image/jpeg',
};

const SYSTEM_PROMPT = `You read weights off photographs of landfill / transfer-station scale tickets.

A scale ticket normally prints more than one weight:
  GROSS  — the loaded truck
  TARE   — the empty truck
  NET    — the load itself (gross − tare)
Weights may be printed in POUNDS (lbs, LB, #) or in TONS (T, TN, tons).

Return the weight of the LOAD — the NET weight — because that is what the haul is
billed on. If the ticket prints no net weight but does print both gross and tare,
subtract them. If only one weight is legible, return that one and say which it is.

Output a single JSON object and NOTHING else, in exactly this shape:
{
  "weightLbs": <number in POUNDS, or null if you cannot read a weight>,
  "label": "<short description of the line you read, e.g. \\"NET 7,240 lb\\" or \\"gross 18,900 lb − tare 11,660 lb\\", or null>",
  "confidence": <0-100 integer: how sure you are of the number>
}

Rules:
- ALWAYS convert to pounds. A ticket printing "3.62 T" means weightLbs = 7240.
- Never guess a number that is not legible in the image — return null with
  confidence 0 instead. A wrong weight becomes a wrong invoice.
- If the image is not a scale ticket at all, return null with confidence 0.`;

function parseReading(rawText) {
  let text = String(rawText || '').trim();
  // Strip markdown fences if the model wrapped the JSON.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { parsed = JSON.parse(text.slice(first, last + 1)); } catch { /* fall through */ }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    console.error('[scaleTicketReader] Unparseable response:', text.slice(0, 400));
    return { weightLbs: null, label: null, confidence: 0 };
  }

  // Normalize hard: a value that isn't a finite, non-negative number is "couldn't
  // read it", not a weight to pre-fill. The explicit null/'' guard matters —
  // Number(null) is 0, which is finite, so "unreadable" would otherwise pre-fill
  // the owner's box with a confident-looking 0 lbs.
  const raw = parsed.weightLbs;
  const n = Number(raw);
  const weightLbs = raw != null && raw !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  const c = Number(parsed.confidence);
  return {
    weightLbs,
    label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : null,
    confidence: weightLbs == null ? 0 : Math.max(0, Math.min(100, Number.isFinite(c) ? Math.round(c) : 0)),
  };
}

// Read a scale-ticket photo off disk. Resolves to { weightLbs, label, confidence };
// weightLbs is null whenever nothing legible was found — the caller then leaves the
// owner's box empty rather than pre-filling a guess.
async function readScaleTicket(imagePath) {
  const base64Image = fs.readFileSync(imagePath).toString('base64');
  const mediaType = MEDIA_TYPES[path.extname(imagePath).toLowerCase()] || 'image/jpeg';

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image },
          },
          {
            type: 'text',
            text: 'Output a single JSON object — no other text — with the load weight from this scale ticket.',
          },
        ],
      },
    ],
  });

  return parseReading(response.content[0].text);
}

module.exports = { readScaleTicket, parseReading };
