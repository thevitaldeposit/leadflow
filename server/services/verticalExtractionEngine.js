const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Top-level vertical configs: auto_dealer and insurance_agent are single-schema.
// home_services delegates to a sub-vertical (dumpster_rental, hvac, …) via
// HOME_SERVICES_SUB_VERTICAL_CONFIGS below.
const VERTICAL_CONFIGS = {
  auto_dealer: {
    promptAddition: `This is a call at a car dealership. Extract the vehicle the customer is interested in purchasing, any trade-in vehicle they mentioned, their budget, whether they expressed interest in financing, and how soon they want to buy. Speaker 0 is the salesperson — do not extract their personal contact information.`,
    outputSchema: `{
  "customerName": string | null,
  "customerPhone": string | null,
  "customerEmail": string | null,
  "vehicleInterest": string | null,
  "tradeIn": string | null,
  "budget": string | null,
  "financingInterested": boolean | null,
  "timeframe": string | null,
  "notes": string | null,
  "confidence": number (0-100),
  "callSummary": string
}`,
  },
  insurance_agent: {
    promptAddition: `This is a call at an insurance agency. Extract the type of coverage the customer is inquiring about, their current insurance provider if mentioned, what they currently pay if mentioned, when their policy expires, whether they requested a quote, and whether they expressed interest in bundling policies. Speaker 0 is the insurance agent — do not extract their personal contact information.`,
    outputSchema: `{
  "customerName": string | null,
  "customerPhone": string | null,
  "customerEmail": string | null,
  "coverageType": string | null,
  "currentProvider": string | null,
  "currentPremium": string | null,
  "policyExpiration": string | null,
  "quoteRequested": boolean | null,
  "bundleInterest": boolean | null,
  "driversInHousehold": string | null,
  "propertyAddress": string | null,
  "notes": string | null,
  "confidence": number (0-100),
  "callSummary": string
}`,
  },
};

const HOME_SERVICES_NAME_RULE = `IMPORTANT NAME RULE: customerName must be extracted regardless of which speaker said it. The business owner (Speaker 0) often greets the customer by name ("Hi John, this is Mike at ABC Dumpsters") — capture that name. Only phone, email, and address are restricted to the customer's own speech. Speaker 0 is the business owner — do not extract Speaker 0's personal phone, email, or address.`;

const HOME_SERVICES_ACTION_RULE = `ACTION INTELLIGENCE: You must also produce signals that help the owner know what to do next.

- intentLevel: "high" if the customer requested pricing, a delivery date, an appointment, or availability; "warm" if the customer expressed interest but made no specific request; "cold" if the customer said they were comparing prices, just gathering info, or non-committal.
- followUpSignal: one of "callback_today" (customer said ASAP/today/emergency), "callback_tomorrow" (customer said tomorrow), "callback_next_week" (customer said next week or call me back [day]), "comparing_prices" (customer is shopping around or needs to think about it), "before_delivery" (customer gave a specific future delivery/service date — set followUpAnchorDate to that date in ISO YYYY-MM-DD), "next_business_day" (high intent but no explicit callback request), "unknown" (no clear signal).
- followUpAnchorDate: the specific date the customer mentioned, in YYYY-MM-DD, if relevant. Otherwise null. Resolve relative dates ("Monday", "next Friday", "June 3") to absolute ISO dates using the current date context.
- rawDeliveryDate: the exact phrase the customer used to describe when they want delivery (e.g. "Monday", "next week", "June 3rd"). Null if not mentioned.
- deliveryDateISO: the resolved ISO date (YYYY-MM-DD) for delivery, calculated from rawDeliveryDate. Null if not mentioned.
- followUpReason: one short sentence explaining why this follow-up timing was chosen (e.g. "Customer requested callback tomorrow morning").
- aiRecommendation: one concise action sentence the owner can read at a glance (e.g. "Call back today — customer agreed to $545 for Monday delivery").
- outcome: REQUIRED, never null. Use: "quote_requested" if customer asked for a price, "quote_sent" if a price was given on the call, "booked" if customer agreed to price AND date, "not_serviceable" if outside service area or wrong service. Default: "quote_requested".
- estimatedRevenue: numeric dollars (no currency symbol) parsed from quotedPrice if a clear price was discussed, otherwise null. If quotedPrice is a range ("$300-$400"), use the midpoint.`;

const HOME_SERVICES_SUB_VERTICAL_CONFIGS = {
  dumpster_rental: {
    promptAddition: `This is a call to a dumpster rental business. Extract: customer name, phone, email, delivery address, dumpster size requested, delivery date, pickup date, rental duration, type of debris or material (construction, household, yard waste, etc.), any access instructions, whether a permit was mentioned, any price discussed, payment method or payment status mentioned, and urgency. Urgency: ASAP if they say today/now/emergency, This Week if this week, Next Week if next week, otherwise Flexible.

${HOME_SERVICES_NAME_RULE}

${HOME_SERVICES_ACTION_RULE}`,
    outputSchema: `{
  "customerName": string | null,
  "customerPhone": string | null,
  "customerEmail": string | null,
  "deliveryAddress": string | null,
  "dumpsterSize": string | null,
  "deliveryDate": string | null,
  "rawDeliveryDate": string | null,
  "deliveryDateISO": string | null,
  "pickupDate": string | null,
  "rentalDuration": string | null,
  "debrisType": string | null,
  "accessNotes": string | null,
  "permitNeeded": boolean | null,
  "quotedPrice": string | null,
  "paymentStatus": string | null,
  "urgency": "ASAP" | "This Week" | "Next Week" | "Flexible" | null,
  "intentLevel": "high" | "warm" | "cold" | null,
  "followUpSignal": "callback_today" | "callback_tomorrow" | "callback_next_week" | "comparing_prices" | "before_delivery" | "next_business_day" | "unknown" | null,
  "followUpAnchorDate": string | null,
  "followUpReason": string | null,
  "aiRecommendation": string | null,
  "outcome": "quote_requested" | "quote_sent" | "booked" | "not_serviceable",
  "estimatedRevenue": number | null,
  "notes": string | null,
  "confidence": number (0-100),
  "callSummary": string
}`,
  },
  hvac: {
    promptAddition: `This is a call to an HVAC business. Extract: customer name, phone, email, property address, type of service needed (repair/maintenance/install/replacement/estimate), type of equipment (furnace/ac/heat pump/boiler/ductwork/other), description of the issue, age of the system if mentioned, brand or model if mentioned, whether it is an emergency, whether they requested an appointment, and any price discussed. Urgency: ASAP if emergency or no heat/no ac, This Week if soon, Next Week if next week, otherwise Flexible.

${HOME_SERVICES_NAME_RULE}

${HOME_SERVICES_ACTION_RULE}`,
    outputSchema: `{
  "customerName": string | null,
  "customerPhone": string | null,
  "customerEmail": string | null,
  "propertyAddress": string | null,
  "serviceType": "repair" | "maintenance" | "install" | "replacement" | "estimate" | "unknown" | null,
  "equipmentType": "furnace" | "ac" | "heat_pump" | "boiler" | "ductwork" | "other" | "unknown" | null,
  "issueDescription": string | null,
  "systemAge": string | null,
  "brandOrModel": string | null,
  "emergencyStatus": boolean | null,
  "appointmentRequested": boolean | null,
  "quotedPrice": string | null,
  "followUpNeeded": boolean | null,
  "urgency": "ASAP" | "This Week" | "Next Week" | "Flexible" | null,
  "intentLevel": "high" | "warm" | "cold" | null,
  "followUpSignal": "callback_today" | "callback_tomorrow" | "callback_next_week" | "comparing_prices" | "before_delivery" | "next_business_day" | "unknown" | null,
  "followUpAnchorDate": string | null,
  "followUpReason": string | null,
  "aiRecommendation": string | null,
  "estimatedRevenue": number | null,
  "notes": string | null,
  "confidence": number (0-100),
  "callSummary": string
}`,
  },
};

function resolveConfig(vertical, subVertical) {
  if (vertical === 'home_services') {
    const sub = subVertical || 'dumpster_rental';
    const cfg = HOME_SERVICES_SUB_VERTICAL_CONFIGS[sub]
      || HOME_SERVICES_SUB_VERTICAL_CONFIGS.dumpster_rental;
    return { config: cfg, resolvedSubVertical: HOME_SERVICES_SUB_VERTICAL_CONFIGS[sub] ? sub : 'dumpster_rental' };
  }
  return { config: VERTICAL_CONFIGS[vertical] || VERTICAL_CONFIGS.auto_dealer, resolvedSubVertical: null };
}

function buildSystemPrompt(vertical, subVertical) {
  const { config } = resolveConfig(vertical, subVertical);
  return `You are an AI-powered lead extraction engine. Your job is to analyze sales call transcripts and extract customer lead information. You operate as the core intelligence behind a fully autonomous CRM population tool. The goal is zero manual data entry.

## SPEAKER IDENTIFICATION
In the transcript, Speaker 0 is always the business owner/employee. Speaker 1 and higher are customers. Extract lead information ONLY from customer speakers. You may extract the salesperson/employee name from Speaker 0 if mentioned, but never their personal phone, email, or address.

## VERTICAL CONTEXT
${config.promptAddition}

## CONFIDENCE SCORING
Provide an overall confidence score (0-100) reflecting how complete and reliable the extraction is:
- 90-100: Customer name + phone + primary interest all clearly stated
- 70-89: Most fields captured, minor ambiguity
- 50-69: Partial extraction, several fields inferred
- 30-49: Only a few fields captured reliably
- 0-29: Very little useful information extracted

## EXTRACTION RULES
1. NEVER fabricate data. If a field is not present, use null.
2. Normalize names (proper capitalization), phone numbers (xxx-xxx-xxxx format), emails (lowercase).
3. For boolean fields: true if clearly expressed, false if explicitly denied, null if not mentioned.
4. callSummary: 2-3 sentence summary written for a business owner. Focus on what the customer wants and what the next step should be.
5. If the call is clearly personal (chatting with friends/family, no business context), set confidence to 0 and callSummary to "Personal call — no business lead captured."

## OUTPUT FORMAT
Return ONLY valid JSON matching this schema. No markdown, no backticks, no explanation.

${config.outputSchema}`;
}

function parseResponse(rawText) {
  let text = rawText.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  return JSON.parse(text);
}

function splitCustomerName(fullName) {
  if (!fullName) return { first: null, last: null };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Translate the AI-emitted followUpSignal into an absolute follow-up timestamp,
// applying the rules from the product spec. `now` is injectable for tests.
// Returns { followUpDate, followUpReason } — followUpDate is an ISO string.
function computeFollowUpDate(signal, anchorDate, providedReason, intentLevel, now = new Date()) {
  function atHour(d, hour, minute = 0) {
    const copy = new Date(d);
    copy.setHours(hour, minute, 0, 0);
    return copy;
  }
  function addDays(d, n) {
    const copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
  }
  function nextBusinessDayAt9(from) {
    let next = addDays(from, 1);
    // 0 = Sun, 6 = Sat
    while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
    return atHour(next, 9, 0);
  }
  function nextMondayAt9(from) {
    const day = from.getDay();
    // Days until next Monday (1). If today is Monday, jump 7.
    const delta = ((1 - day + 7) % 7) || 7;
    return atHour(addDays(from, delta), 9, 0);
  }
  function parseAnchor(str) {
    if (!str) return null;
    // Accept YYYY-MM-DD or full ISO.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  let date;
  let reason = providedReason || null;

  switch (signal) {
    case 'callback_today':
      // ASAP / today / emergency → 2 hours from call
      date = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      reason = reason || 'Customer requested a callback today — follow up within 2 hours';
      break;
    case 'callback_tomorrow':
      date = atHour(addDays(now, 1), 9, 0);
      reason = reason || 'Customer requested a callback tomorrow at 9am';
      break;
    case 'callback_next_week':
      date = nextMondayAt9(now);
      reason = reason || 'Customer requested a callback next week';
      break;
    case 'comparing_prices':
      // Comparing prices → 3 days (not 2 days per spec)
      date = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      reason = reason || 'Customer is comparing prices — follow up in 3 days';
      break;
    case 'before_delivery': {
      const anchor = parseAnchor(anchorDate);
      if (anchor) {
        // Days until delivery determines lead time
        const daysUntil = Math.round((anchor - now) / (24 * 60 * 60 * 1000));
        if (daysUntil <= 14) {
          // 1-2 weeks away → follow up 5 days before project date
          date = atHour(addDays(anchor, -5), 9, 0);
          reason = reason || `Project is ${daysUntil} days away — follow up 5 days before (${anchorDate})`;
        } else {
          // 3+ weeks away → follow up 7 days before project date
          date = atHour(addDays(anchor, -7), 9, 0);
          reason = reason || `Project is ${daysUntil} days away — follow up 7 days before (${anchorDate})`;
        }
        // Don't schedule follow-up in the past
        if (date < now) {
          date = nextBusinessDayAt9(now);
          reason = reason || `Delivery soon — follow up the next business day`;
        }
      } else {
        date = nextBusinessDayAt9(now);
        reason = reason || 'Follow up to confirm service date';
      }
      break;
    }
    case 'next_business_day':
      date = nextBusinessDayAt9(now);
      reason = reason || 'High intent — follow up the next business day at 9am';
      break;
    case 'unknown':
    case null:
    case undefined:
    default:
      if (intentLevel === 'high') {
        date = nextBusinessDayAt9(now);
        reason = reason || 'High intent lead — follow up the next business day at 9am';
      } else {
        // No signal → 2 business days at 9am
        date = nextBusinessDayAt9(nextBusinessDayAt9(now));
        reason = reason || 'No explicit follow-up signal — follow up in 2 business days';
      }
      break;
  }

  return { followUpDate: date.toISOString(), followUpReason: reason };
}

async function extractFromTranscriptVertical(transcript, vertical = 'auto_dealer', subVertical = null) {
  const { resolvedSubVertical } = resolveConfig(vertical, subVertical);
  const systemPrompt = buildSystemPrompt(vertical, subVertical);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Extract all lead information from this call transcript:\n\n${transcript}`,
      },
    ],
  });

  const rawText = response.content[0].text;
  const extracted = parseResponse(rawText);

  const { first, last } = splitCustomerName(extracted.customerName);

  // Separate common fields (stored flat) from vertical-specific fields (stored as JSON).
  // customerName is preserved in verticalData so vertical UIs can show the full name
  // as one field even when extraction returns only first or only last via the split.
  const { customerName, customerPhone, customerEmail, callSummary, confidence, ...verticalSpecific } = extracted;
  verticalSpecific.customerName = customerName || null;

  // Home Services: compute the absolute follow-up date from the AI signal so
  // the dashboard's prioritization logic can sort on a single timestamp.
  // Also ensure outcome is always set and job_status defaults to 'inquiry'.
  if (vertical === 'home_services') {
    const { followUpDate, followUpReason } = computeFollowUpDate(
      verticalSpecific.followUpSignal,
      verticalSpecific.followUpAnchorDate,
      verticalSpecific.followUpReason,
      verticalSpecific.intentLevel
    );
    verticalSpecific.followUpDate = followUpDate;
    verticalSpecific.followUpReason = followUpReason;

    // outcome must never be blank — default to quote_requested
    if (!verticalSpecific.outcome) {
      verticalSpecific.outcome = 'quote_requested';
    }

    // job_status always starts as inquiry for new leads
    verticalSpecific.job_status = 'inquiry';
  }

  let phone = extracted.customerPhone;
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) phone = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    else if (digits.length === 11 && digits[0] === '1') phone = `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  // Home Services swaps the confidence-score concept for action-oriented flags
  // appended to the AI summary so the owner sees concrete follow-ups.
  let augmentedSummary = callSummary || null;
  if (vertical === 'home_services' && augmentedSummary) {
    const flags = [];
    if (!customerName) flags.push('Customer name was not collected — follow up to confirm.');
    if (!extracted.customerEmail) flags.push('Email was not collected.');
    if (flags.length) augmentedSummary = `${augmentedSummary} ${flags.join(' ')}`;
  }

  // Promote key fields to flat DB columns so queries/filters work without JSON parsing
  const flatExtra = {};
  if (vertical === 'home_services') {
    if (verticalSpecific.outcome) flatExtra.outcome = verticalSpecific.outcome;
    if (verticalSpecific.job_status) flatExtra.job_status = verticalSpecific.job_status;
    if (verticalSpecific.rawDeliveryDate) flatExtra.raw_delivery_date = verticalSpecific.rawDeliveryDate;
    if (verticalSpecific.deliveryDateISO) flatExtra.delivery_date = verticalSpecific.deliveryDateISO;
    if (typeof verticalSpecific.estimatedRevenue === 'number') flatExtra.estimated_revenue = verticalSpecific.estimatedRevenue;
  }

  return {
    commonFields: {
      customer_first_name: first,
      customer_first_name_confidence: first ? (confidence / 100) : 0,
      customer_last_name: last,
      customer_last_name_confidence: last ? (confidence / 100) : 0,
      phone,
      phone_confidence: phone ? (confidence / 100) : 0,
      email: extracted.customerEmail,
      email_confidence: extracted.customerEmail ? (confidence / 100) : 0,
      call_summary: augmentedSummary,
      ...flatExtra,
    },
    verticalData: verticalSpecific,
    confidence: confidence || 0,
    subVertical: resolvedSubVertical,
  };
}

module.exports = {
  extractFromTranscriptVertical,
  computeFollowUpDate,
  VERTICAL_CONFIGS,
  HOME_SERVICES_SUB_VERTICAL_CONFIGS,
};
