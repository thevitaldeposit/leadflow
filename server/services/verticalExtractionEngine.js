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

const HOME_SERVICES_SUB_VERTICAL_CONFIGS = {
  dumpster_rental: {
    promptAddition: `This is a call to a dumpster rental business. Extract: customer name, phone, email, delivery address, dumpster size requested, delivery date, pickup date, rental duration, type of debris or material (construction, household, yard waste, etc.), any access instructions, whether a permit was mentioned, any price discussed, payment method or payment status mentioned, and urgency. Urgency: ASAP if they say today/now/emergency, This Week if this week, Next Week if next week, otherwise Flexible.

${HOME_SERVICES_NAME_RULE}`,
    outputSchema: `{
  "customerName": string | null,
  "customerPhone": string | null,
  "customerEmail": string | null,
  "deliveryAddress": string | null,
  "dumpsterSize": string | null,
  "deliveryDate": string | null,
  "pickupDate": string | null,
  "rentalDuration": string | null,
  "debrisType": string | null,
  "accessNotes": string | null,
  "permitNeeded": boolean | null,
  "quotedPrice": string | null,
  "paymentStatus": string | null,
  "urgency": "ASAP" | "This Week" | "Next Week" | "Flexible" | null,
  "notes": string | null,
  "confidence": number (0-100),
  "callSummary": string
}`,
  },
  hvac: {
    promptAddition: `This is a call to an HVAC business. Extract: customer name, phone, email, property address, type of service needed (repair/maintenance/install/replacement/estimate), type of equipment (furnace/ac/heat pump/boiler/ductwork/other), description of the issue, age of the system if mentioned, brand or model if mentioned, whether it is an emergency, whether they requested an appointment, and any price discussed. Urgency: ASAP if emergency or no heat/no ac, This Week if soon, Next Week if next week, otherwise Flexible.

${HOME_SERVICES_NAME_RULE}`,
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

  let phone = extracted.customerPhone;
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) phone = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    else if (digits.length === 11 && digits[0] === '1') phone = `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
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
      call_summary: callSummary || null,
    },
    verticalData: verticalSpecific,
    confidence: confidence || 0,
    subVertical: resolvedSubVertical,
  };
}

module.exports = {
  extractFromTranscriptVertical,
  VERTICAL_CONFIGS,
  HOME_SERVICES_SUB_VERTICAL_CONFIGS,
};
