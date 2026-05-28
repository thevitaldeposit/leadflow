const http2 = require('http2');
const crypto = require('crypto');
const fs = require('fs');

const APNS_HOST = process.env.APNS_PRODUCTION === 'true'
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com';

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.leadflow.ios';

let _cachedToken = null;
let _tokenExpiry = 0;

function getPrivateKey() {
  const content = process.env.APNS_KEY_CONTENT;
  if (content) return content.replace(/\\n/g, '\n');
  const keyPath = process.env.APNS_KEY_PATH;
  if (keyPath) return fs.readFileSync(keyPath, 'utf-8');
  throw new Error('APNs key not configured. Set APNS_KEY_CONTENT or APNS_KEY_PATH.');
}

function generateToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && _tokenExpiry > now + 60) return _cachedToken;

  const kid = process.env.APNS_KEY_ID;
  const iss = process.env.APNS_TEAM_ID;
  if (!kid || !iss) throw new Error('APNS_KEY_ID and APNS_TEAM_ID must be set.');

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss, iat: now })).toString('base64url');
  const signingInput = `${header}.${payload}`;

  const privateKey = getPrivateKey();
  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

  _cachedToken = `${signingInput}.${signature}`;
  _tokenExpiry = now + 3500;
  return _cachedToken;
}

function sendPush(deviceToken, title, body, data = {}) {
  return new Promise((resolve, reject) => {
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    if (!keyId || !teamId) {
      console.warn('[apns] Not configured — skipping push (set APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_CONTENT)');
      return resolve({ skipped: true });
    }

    let jwt;
    try {
      jwt = generateToken();
    } catch (err) {
      console.warn('[apns] JWT generation failed:', err.message);
      return resolve({ skipped: true });
    }

    const apnsPayload = JSON.stringify({
      aps: { alert: { title, body }, sound: 'default', badge: 1 },
      ...data,
    });

    const client = http2.connect(`https://${APNS_HOST}`);
    client.on('error', (err) => { reject(err); });

    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(apnsPayload),
    };

    const req = client.request(headers);
    let status = 0;
    let responseBody = '';

    req.on(':status', (s) => { status = s; });
    req.on('data', (chunk) => { responseBody += chunk; });
    req.on('end', () => {
      client.close();
      if (status === 200) {
        resolve({ success: true });
      } else {
        console.error(`[apns] HTTP ${status}:`, responseBody);
        reject(new Error(`APNs returned HTTP ${status}: ${responseBody}`));
      }
    });
    req.on('error', reject);

    req.write(apnsPayload);
    req.end();
  });
}

async function sendToAll(deviceTokens, title, body, data = {}) {
  if (!deviceTokens || deviceTokens.length === 0) return;
  const results = await Promise.allSettled(
    deviceTokens.map(token => sendPush(token, title, body, data))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[apns] Failed for token ${deviceTokens[i].slice(0, 8)}...:`, r.reason?.message);
    }
  });
}

module.exports = { sendPush, sendToAll };
