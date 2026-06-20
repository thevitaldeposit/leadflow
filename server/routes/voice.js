const express = require('express');
const router = express.Router();
const { attachBusiness } = require('../middleware/auth');

// The Twilio Node SDK is required lazily and defensively. If it is somehow not
// installed (e.g. `npm install` hasn't run on a box), the rest of the app must
// still boot — the token endpoint just degrades to a 503 instead of throwing.
let AccessToken = null;
try {
  AccessToken = require('twilio').jwt.AccessToken;
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

// Soft auth: scopes to the caller's business when a JWT is present, else falls
// back to the default business (Valley Binz) exactly like device registration,
// so the iOS app can mint a token today before per-user login ships.
router.use(attachBusiness);

// POST /api/voice/token — mint a Twilio Voice access token for the logged-in
// user's client identity. Returns { token, identity, ttl }. Never throws on
// missing config: returns 503 "Voice not yet configured" so the rest of the
// backend and the existing call pipeline keep working without these vars set.
router.post('/token', (req, res) => {
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

    res.json({ token: token.toJwt(), identity, ttl: TOKEN_TTL_SECONDS });
  } catch (err) {
    console.error('[voice] POST /token error:', err);
    res.status(500).json({ error: 'Failed to mint voice token' });
  }
});

module.exports = { router, voiceIdentityFor };
