const { Server } = require('socket.io');
const { verifyToken } = require('./services/authService');

// Valley Binz — the default business unauthenticated clients (the iOS app before
// it sends a token) are placed in, preserving the original single-tenant behavior.
const DEFAULT_BUSINESS_ID = 1;

let io = null;

// Pull a single cookie value out of a raw Cookie header. Mirrors the helper in
// middleware/auth.js so the socket handshake can read the same httpOnly `token`
// cookie the web dashboard already sends on same-origin requests.
function readCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// Resolve the connecting client's business_id from its JWT. Prefers an explicit
// handshake token (sent by API clients / the iOS app via `auth.token`), then
// falls back to the httpOnly `token` cookie the browser sends automatically.
// Returns null when no valid token is present.
function resolveBusinessId(socket) {
  const handshake = socket.handshake || {};
  const token =
    (handshake.auth && handshake.auth.token) ||
    readCookie(handshake.headers && handshake.headers.cookie, 'token');
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    return payload.businessId || null;
  } catch {
    return null;
  }
}

function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    // Join a room scoped to the client's business so lead/update events are only
    // delivered to that tenant. Unauthenticated clients fall back to Valley Binz.
    const businessId = resolveBusinessId(socket) || DEFAULT_BUSINESS_ID;
    socket.join(`business:${businessId}`);
    console.log(`[socket] client connected: ${socket.id} (business:${businessId})`);
    socket.on('disconnect', () => {
      console.log('[socket] client disconnected:', socket.id);
    });
  });

  return io;
}

function getIO() {
  return io;
}

// Emit an event to a single business's room. No-ops if the socket server is not
// yet initialized or no business_id is available. Coerces a falsy business_id to
// the default so a lead missing its business_id still reaches Valley Binz clients.
function emitToBusiness(businessId, event, payload) {
  if (!io) return;
  const room = `business:${businessId || DEFAULT_BUSINESS_ID}`;
  io.to(room).emit(event, payload);
}

module.exports = { init, getIO, emitToBusiness, DEFAULT_BUSINESS_ID };
