const express = require('express');
const router = express.Router();
const { attachBusiness } = require('../middleware/auth');
const { getDefaultBusinessId } = require('../services/businesses');

// The Twilio Node SDK is required lazily and defensively. If it is somehow not
// installed (e.g. `npm install` hasn't run on a box), the rest of the app must
// still boot — the token endpoint just degrades to a 503 instead of throwing.
// `twilioLib` (the module itself) is also kept so a REST client can be built for
// the Network Traversal Service (NTS) ICE-server lookup below.
let twilioLib = null;
let AccessToken = null;
try {
  twilioLib = require('twilio');
  AccessToken = twilioLib.jwt.AccessToken;
} catch (err) {
  console.warn('[voice] twilio SDK not available — /api/voice/token will 503:', err.message);
}

// Access tokens are intentionally short-lived; the iOS app re-fetches as needed
// (on launch / foreground / before (re)registering for VoIP push). The Twilio
// push *registration* it creates lives much longer server-side at Twilio, so
// incoming calls keep ringing even after the access token expires.
const TOKEN_TTL_SECONDS = 3600; // 1 hour

// Voice access tokens need these four Voice-specific SIDs in addition to the
// account SID the rest of the app already uses. They DO NOT EXIST YET — they can
// only be created once the Apple Developer account is active and a VoIP Services
// certificate → Twilio Voice Push Credential + TwiML App have been set up in the
// Twilio console (see .env.example for the manual steps). Until then this list is
// non-empty and the endpoint returns a controlled 503 rather than crashing.
const REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_VOICE_PUSH_CREDENTIAL_SID',
];

function missingVoiceConfig() {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

// Stable, unique Twilio Voice client identity for the caller. Derived from the
// tenant (and the specific user when authenticated) so a business's inbound
// TwiML can later dial <Client>identity</Client> to ring that business's app(s).
// Sanitized to the characters Twilio treats as safe in a client identity.
function voiceIdentityFor(business, user) {
  const base = user && user.id
    ? `business_${business.id}_user_${user.id}`
    : `business_${business.id}`;
  return base.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// ─── Outbound (app-initiated) calling ───────────────────────────────────────
//
// When the iOS app places a call, the Twilio Voice SDK reaches the TwiML App's
// "Voice Request URL", which MUST point at POST /api/voice/outbound (below). That
// endpoint returns <Dial> TwiML that bridges the call to the dialed number and
// presents the business's VERIFIED caller ID. It is deliberately separate from the
// inbound webhook (server/routes/webhook.js): it shares none of inbound's routing,
// recording, or caller-ID passthrough — outbound calls are NOT recorded.

// The verified caller ID outbound calls present. This must be a real number the
// business owns and has registered as a Verified Caller ID in the Twilio Console
// (NOT the Twilio number used for inbound caller-ID passthrough). Valley Binz →
// +18155030701. Kept as a per-business resolver, not a bare constant, so other
// tenants can map their own verified number later; an env override wins, else the
// Valley Binz default.
const DEFAULT_OUTBOUND_CALLER_ID = process.env.TWILIO_OUTBOUND_CALLER_ID || '+18155030701';

function outboundCallerIdForBusiness(_businessId) {
  // Multi-tenant seam: today only the anchor tenant (Valley Binz) dials out, so
  // every id resolves to the single configured verified number. Map per-business
  // verified caller IDs here when more tenants begin placing calls.
  return DEFAULT_OUTBOUND_CALLER_ID;
}

// Twilio sets `From` to "client:<identity>" for SDK-originated calls. Our voice
// identities are "business_<id>" / "business_<id>_user_<id>" (see voiceIdentityFor),
// so the dialing tenant can be recovered from it to scope the caller ID — no token
// is available on a Twilio-originated request.
function businessIdFromClientFrom(from) {
  if (!from) return null;
  const m = String(from).match(/business_(\d+)/);
  return m ? Number(m[1]) : null;
}

// Normalize a user-dialed number to E.164. Handles the shapes the client may send
// (10-digit US, 1+10-digit US, already-E.164, loosely formatted). Returns null when
// it can't produce a confident E.164 number, so the endpoint refuses to dial rather
// than placing a garbage call.
function normalizeDialedNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase().startsWith('client:')) return null; // never PSTN-dial a client id
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (hasPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;                          // US 10-digit
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`; // US 1+10-digit
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;      // best-effort intl
  return null;
}

// Escape the characters that must not appear raw inside XML. Our values are already
// restricted to '+' and digits, but this keeps the TwiML well-formed regardless of
// what reaches it.
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Soft auth: scopes to the caller's business when a JWT is present, else falls
// back to the default business (Valley Binz) exactly like device registration,
// so the iOS app can mint a token today before per-user login ships.
router.use(attachBusiness);

// A Twilio REST client for the Network Traversal Service (NTS) ICE-server lookup.
// Built lazily from the account SID + auth token the rest of the app already uses,
// and cached. Returns null (never throws) when the SDK or those creds are absent so
// the token handler can simply skip the relay fetch and still return a token.
let ntsClient = null;
function getNtsClient() {
  if (ntsClient) return ntsClient;
  if (!twilioLib) return null;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  try {
    ntsClient = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    return ntsClient;
  } catch (err) {
    console.warn('[voice] could not build Twilio REST client for NTS:', err.message);
    return null;
  }
}

// Fetch TURN/STUN relay credentials from Twilio NTS so the iOS client has a relay
// ready at call time instead of discovering one mid-call — that discovery is the
// cause of the several-second dead-audio window on cellular. Deliberately
// best-effort: any missing config, failure, or slowness resolves to null and the
// caller returns the access token exactly as before (just without `iceServers`).
// Calls must never break because this relay-credential fetch hiccupped. The NTS
// token TTL matches the 1h access-token lifetime — comfortably longer than a call.
async function fetchIceServers() {
  const client = getNtsClient();
  if (!client) return null;
  try {
    const nts = await client.tokens.create({ ttl: TOKEN_TTL_SECONDS });
    return Array.isArray(nts.iceServers) && nts.iceServers.length > 0 ? nts.iceServers : null;
  } catch (err) {
    console.warn('[voice] NTS ice-server fetch failed — returning token without relay:', err.message);
    return null;
  }
}

// POST /api/voice/token — mint a Twilio Voice access token for the logged-in
// user's client identity. Returns { token, identity, ttl } (plus `iceServers`
// when NTS relay credentials could be fetched). Never throws on missing config:
// returns 503 "Voice not yet configured" so the rest of the backend and the
// existing call pipeline keep working without these vars set.
router.post('/token', async (req, res) => {
  try {
    if (!AccessToken) {
      console.warn('[voice] token requested but twilio SDK is not installed');
      return res.status(503).json({ error: 'Voice not yet configured' });
    }

    const missing = missingVoiceConfig();
    if (missing.length > 0) {
      // Names only — never log secret values.
      console.warn(`[voice] token requested but Voice is not configured (missing: ${missing.join(', ')})`);
      return res.status(503).json({ error: 'Voice not yet configured' });
    }

    if (!req.business || !req.business.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const identity = voiceIdentityFor(req.business, req.user);

    const voiceGrant = new AccessToken.VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      pushCredentialSid: process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID,
      incomingAllow: true, // allow this client to receive incoming calls
    });

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity, ttl: TOKEN_TTL_SECONDS }
    );
    token.addGrant(voiceGrant);

    const body = { token: token.toJwt(), identity, ttl: TOKEN_TTL_SECONDS };

    // Best-effort: hand the client TURN/STUN relay servers up front so cellular
    // calls have an instant fallback path. Never fatal — on any failure the token
    // is returned without `iceServers` and the call proceeds as it does today.
    const iceServers = await fetchIceServers();
    if (iceServers) body.iceServers = iceServers;

    res.json(body);
  } catch (err) {
    console.error('[voice] POST /token error:', err);
    res.status(500).json({ error: 'Failed to mint voice token' });
  }
});

// POST /api/voice/outbound — TwiML for app-initiated OUTBOUND calls. Point the
// Twilio TwiML App (TWILIO_TWIML_APP_SID) "Voice Request URL" at this endpoint:
//   https://leadflow-production-9c02.up.railway.app/api/voice/outbound   (HTTP POST)
// The iOS client calls TwilioVoiceSDK.connect(params: { To: "<number>" }); Twilio
// invokes this endpoint with that `To` (plus From="client:<identity>"), and we
// answer with <Dial callerId="<verified>"><Number>To</Number></Dial>. GET is also
// accepted so a console mistakenly set to GET still works. The soft-auth
// (attachBusiness) on this router runs but is not relied on — the tenant is taken
// from the client identity in `From`. Always returns valid TwiML (never 4xx/5xx),
// so a transient issue degrades to a spoken error instead of a dropped call.
function handleOutbound(req, res) {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const to = params.To || params.to || '';
    const from = params.From || params.from || '';

    const businessId =
      businessIdFromClientFrom(from) || (req.business && req.business.id) || getDefaultBusinessId();
    const callerId = outboundCallerIdForBusiness(businessId);
    const dest = normalizeDialedNumber(to);

    let twiml;
    if (!dest) {
      console.warn(`[voice] /outbound refused — invalid destination "${to}" (business ${businessId})`);
      twiml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Response><Say>Sorry, we could not place this call because the number was invalid.</Say><Hangup/></Response>';
    } else {
      console.log(`[voice] /outbound dial → ${dest} (callerId ${callerId}, business ${businessId})`);
      // answerOnBridge keeps the app on ringback until the callee actually answers.
      twiml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        `<Response><Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true"><Number>${xmlEscape(dest)}</Number></Dial></Response>`;
    }
    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('[voice] /outbound error:', err);
    res
      .type('text/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>Sorry, the call could not be completed.</Say><Hangup/></Response>');
  }
}

router.post('/outbound', handleOutbound);
router.get('/outbound', handleOutbound);

module.exports = { router, voiceIdentityFor };
