const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

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
  home_services: {
    promptAddition: `This is a call to a home services business. The business owner may provide dumpster rentals, HVAC, plumbing, roofing, landscaping, junk removal, or other home services. Extract the customer's name, phone number, email, and the address where service is needed. Extract the type of service or project they need, what materials or work is involved, the size or scope if mentioned, how long they need it, their requested delivery and pickup dates, any access instructions for the property, whether they asked for a quote, any price discussed, and any payment information mentioned. Determine urgency based on their language: if they say today, now, emergency, or ASAP mark as ASAP. If they say this week mark as This Week. If they say next week mark as Next Week. Otherwise mark as Flexible.

IMPORTANT NAME RULE: customerName must be extracted regardless of which speaker said it. The business owner (Speaker 0) often greets the customer by name ("Hi John, this is Mike at ABC Dumpsters") — capture that name. Only phone, email, and address are restricted to the customer's own speech. Speaker 0 is the business owner — do not extract Speaker 0's personal phone, email, or address.`,
    outputSchema: `{
  "customerName": string | null,
  "customerPhone": string | null,
  "customerEmail": string | null,
  "serviceAddress": string | null,
  "serviceType": string | null,
  "projectDescription": string | null,
  "serviceSize": string | null,
  "rentalDuration": string | null,
  "deliveryDate": string | null,
  "pickupDate": string | null,
  "accessNotes": string | null,
  "quoteRequested": boolean | null,
  "priceDiscussed": string | null,
  "paymentDiscussed": string | null,
  "urgency": "ASAP" | "This Week" | "Next Week" | "Flexible" | null,
  "notes": string | null,
  "confidence": number (0-100),
  "callSummary": string
}`,
  },
};

function buildSystemPrompt(vertical) {
  const config = VERTICAL_CONFIGS[vertical] || VERTICAL_CONFIGS.auto_dealer;
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

async function extractFromTranscriptVertical(transcript, vertical = 'auto_dealer') {
  const systemPrompt = buildSystemPrompt(vertical);

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
  };
}

module.exports = { extractFromTranscriptVertical, VERTICAL_CONFIGS };
