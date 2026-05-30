const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const EXTRACTION_SYSTEM_PROMPT = require('../prompts/extractionPrompt');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-4-6";

function parseExtractionResponse(rawText) {
  let text = rawText.trim();

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  // Attempt 1: direct parse
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Attempt 2: extract the outermost { ... } block in case there's surrounding prose
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch (_) {}
  }

  // All attempts failed — log the raw response so we can debug
  console.error('[extraction] Model returned non-JSON. Raw response:\n', rawText.slice(0, 800));
  throw new SyntaxError(`Extraction model returned non-JSON. First 200 chars: ${rawText.slice(0, 200)}`);
}

function flattenExtraction(extracted) {
  const c = extracted.customer || {};
  const voi = extracted.vehicle_of_interest || {};
  const trade = extracted.trade_in || {};
  const deal = extracted.deal_details || {};
  const appt = extracted.appointment || {};
  const intent = extracted.intent || {};
  const sales = extracted.salesperson || {};
  const flags = extracted.flags || {};

  const v = (field) => (field && field.value !== undefined ? field.value : null);
  const conf = (field) => (field && field.confidence !== undefined ? field.confidence : 0);

  return {
    extraction_type: extracted.extraction_type || 'transcript',

    customer_first_name: v(c.first_name),
    customer_first_name_confidence: conf(c.first_name),
    customer_last_name: v(c.last_name),
    customer_last_name_confidence: conf(c.last_name),
    phone: v(c.phone),
    phone_confidence: conf(c.phone),
    email: v(c.email),
    email_confidence: conf(c.email),
    address: v(c.address),
    address_confidence: conf(c.address),

    voi_year: v(voi.year),
    voi_year_confidence: conf(voi.year),
    voi_make: v(voi.make),
    voi_make_confidence: conf(voi.make),
    voi_model: v(voi.model),
    voi_model_confidence: conf(voi.model),
    voi_trim: v(voi.trim),
    voi_trim_confidence: conf(voi.trim),
    voi_color: v(voi.color),
    voi_color_confidence: conf(voi.color),
    voi_stock_number: v(voi.stock_number),
    voi_stock_number_confidence: conf(voi.stock_number),
    voi_vin: v(voi.vin),
    voi_vin_confidence: conf(voi.vin),
    voi_new_or_used: v(voi.new_or_used),
    voi_new_or_used_confidence: conf(voi.new_or_used),

    trade_year: v(trade.year),
    trade_year_confidence: conf(trade.year),
    trade_make: v(trade.make),
    trade_make_confidence: conf(trade.make),
    trade_model: v(trade.model),
    trade_model_confidence: conf(trade.model),
    trade_trim: v(trade.trim),
    trade_trim_confidence: conf(trade.trim),
    trade_color: v(trade.color),
    trade_color_confidence: conf(trade.color),
    trade_mileage: v(trade.mileage),
    trade_mileage_confidence: conf(trade.mileage),
    trade_condition: v(trade.condition),
    trade_condition_confidence: conf(trade.condition),
    trade_payoff: v(trade.payoff),
    trade_payoff_confidence: conf(trade.payoff),
    trade_owned_or_leased: v(trade.owned_or_leased),
    trade_owned_or_leased_confidence: conf(trade.owned_or_leased),

    budget_monthly: v(deal.monthly_budget),
    budget_monthly_confidence: conf(deal.monthly_budget),
    budget_total: v(deal.total_budget),
    budget_total_confidence: conf(deal.total_budget),
    down_payment: v(deal.down_payment),
    down_payment_confidence: conf(deal.down_payment),
    financing_interest: v(deal.financing_interest),
    financing_interest_confidence: conf(deal.financing_interest),
    credit_concerns: v(deal.credit_concerns),
    credit_concerns_confidence: conf(deal.credit_concerns),
    co_buyer: v(deal.co_buyer),
    co_buyer_confidence: conf(deal.co_buyer),

    appointment_set: v(appt.set) ? 1 : 0,
    appointment_set_confidence: conf(appt.set),
    appointment_date: v(appt.date),
    appointment_date_confidence: conf(appt.date),
    appointment_time: v(appt.time),
    appointment_time_confidence: conf(appt.time),

    customer_intent: v(intent.customer_intent),
    customer_intent_confidence: conf(intent.customer_intent),
    visit_type: v(intent.visit_type),
    visit_type_confidence: conf(intent.visit_type),

    salesperson_name: v(sales.name),
    salesperson_name_confidence: conf(sales.name),
    lead_source: v(sales.lead_source),
    lead_source_confidence: conf(sales.lead_source),

    call_summary: extracted.call_summary || null,
    additional_notes: JSON.stringify(extracted.additional_notes || []),
    objections: JSON.stringify(
      (extracted.objections || []).map(o => (typeof o === 'string' ? o : o.objection))
    ),

    flag_urgent: flags.urgent ? 1 : 0,
    flag_needs_manager: flags.needs_manager_attention ? 1 : 0,
    flag_duplicate_suspect: flags.duplicate_suspect ? 1 : 0,
    flag_reason: flags.reason || null,
  };
}

async function extractFromTranscript(transcript) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Extract all lead information from this sales call transcript and respond with JSON only:\n\n${transcript}`,
      },
      { role: 'assistant', content: '{' },
    ],
  });

  const rawText = '{' + response.content[0].text;
  const extracted = parseExtractionResponse(rawText);
  return flattenExtraction(extracted);
}

async function extractFromImage(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const ext = path.extname(imagePath).toLowerCase();
  const mediaTypeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/jpeg',
    '.heif': 'image/jpeg',
  };
  const mediaType = mediaTypeMap[ext] || 'image/jpeg';

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: 'Extract all lead information from this handwritten up sheet image and respond with JSON only.',
          },
        ],
      },
      { role: 'assistant', content: '{' },
    ],
  });

  const rawText = '{' + response.content[0].text;
  const extracted = parseExtractionResponse(rawText);
  return flattenExtraction(extracted);
}

module.exports = { extractFromTranscript, extractFromImage };
