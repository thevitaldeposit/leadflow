import { io } from 'socket.io-client';

// withCredentials sends the httpOnly auth cookie on the socket handshake, the
// same way utils/api.js uses credentials:'include' for REST calls. The server
// reads that cookie's JWT to join this client to its per-business room, so the
// dashboard only receives real-time events for its own business.
const socket = io('/', {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  autoConnect: true,
  withCredentials: true,
});

export default socket;
