// Burger Run 3D: serves the game page and relays multiplayer progress. No dependencies: `node server.js`.
// Each client simulates its own race; the server only relays validated progress between players of a room.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = Number(process.env.PORT) || 8080, MAX_PLAYERS = 8, MAX_CLIENTS = 200, MAX_ROOMS = 50, IDLE_MS = 60000, MAX_MSGS_PER_SEC = 40;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map();
let nextId = 1, clientCount = 0;
const page = fs.readFileSync(path.join(__dirname, 'index.html'));
// The page is one file with inline script and style; sockets may target the page's own host or a typed server address.
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
};

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, HEADERS); return res.end(page); }
  res.writeHead(404); res.end('not found');
});

const num = (v, lo, hi) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : lo;
const int = (v, lo, hi) => Math.round(num(v, lo, hi));

function send(client, obj) {
  if (client.sock.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  client.sock.write(Buffer.concat([head, payload]));
}
const broadcast = (client, obj) => rooms.get(client.room)?.forEach(c => { if (c !== client) send(c, obj); });

function leave(client) {
  if (client.left) return;
  client.left = true;
  clientCount--;
  const room = rooms.get(client.room);
  if (!room) return;
  room.delete(client);
  broadcast(client, { t: 'leave', id: client.id });
  if (!room.size) rooms.delete(client.room);
}

function handle(client, msg) {
  if (msg.t === 'join' && !client.room) {
    const room = String(msg.room || 'main').replace(/[^\w-]/g, '').slice(0, 20) || 'main';
    const members = rooms.get(room) || new Set();
    if (members.size >= MAX_PLAYERS || (!rooms.has(room) && rooms.size >= MAX_ROOMS)) { send(client, { t: 'full' }); return client.sock.end(); }
    const a = Array.isArray(msg.a) ? msg.a : [];
    client.name = String(msg.name || '').replace(/[^\w -]/g, '').trim().slice(0, 16) || 'Player' + client.id;
    client.a = [int(a[0], 0, 5), int(a[1], 0, 2), int(a[2], 0, 1), int(a[3], 0, 2)];
    send(client, { t: 'hello', id: client.id, peers: [...members].map(c => ({ id: c.id, name: c.name, a: c.a })) });
    client.room = room;
    members.add(client);
    rooms.set(room, members);
    broadcast(client, { t: 'peer', id: client.id, name: client.name, a: client.a });
  } else if (!client.room) {
    return;
  } else if (msg.t === 's') {
    const now = Date.now();
    if (now - client.last < 40) return;
    client.last = now;
    broadcast(client, { t: 's', id: client.id, li: int(msg.li, 0, 2), d: num(msg.d, 0, 1e5), x: num(msg.x, -10, 10), sp: num(msg.sp, 0, 300), hp: int(msg.hp, 0, 3), on: int(msg.on, 0, 1) });
  } else if (msg.t === 'fin') {
    broadcast(client, { t: 'fin', id: client.id, li: int(msg.li, 0, 2), score: int(msg.score, 0, 1e7) });
  }
}

// Minimal RFC 6455 reader: single-frame masked client messages up to 64 KiB.
function readFrame(client) {
  const b = client.buf;
  if (b.length < 2) return null;
  const op = b[0] & 15;
  let len = b[1] & 127, offset = 2;
  if (!(b[1] & 128) || len === 127) return { op: 8 };
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); offset = 4; }
  if (b.length < offset + 4 + len) return null;
  const mask = b.subarray(offset, offset + 4), data = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
  for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
  client.buf = b.subarray(offset + 4 + len);
  return { op, data };
}

server.on('upgrade', (req, sock) => {
  // First, before any destroy(): an unhandled 'error' on a raw socket (e.g. a client RST) would crash the process.
  sock.on('error', () => sock.destroy());
  const key = req.headers['sec-websocket-key'], origin = req.headers.origin;
  // file:// pages send Origin "null"; any other site must be the host serving this page.
  let originOk = !origin || origin === 'null';
  if (!originOk) {
    try { originOk = new URL(origin).host === req.headers.host; } catch { originOk = false; } // malformed Origin: reject
  }
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !originOk || clientCount >= MAX_CLIENTS) return sock.destroy();
  clientCount++;
  sock.setTimeout(IDLE_MS, () => sock.destroy()); // a live client sends state ~10 times a second
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { id: nextId++, sock, room: null, name: '', a: null, buf: Buffer.alloc(0), last: 0, left: false, winStart: 0, winCount: 0 };
  sock.on('data', chunk => {
    client.buf = Buffer.concat([client.buf, chunk]);
    if (client.buf.length > 70000) return sock.destroy();
    let frame;
    while ((frame = readFrame(client))) {
      if (frame.op === 8) return sock.end();
      // Any frame type counts toward the budget: a legitimate client sends ~10 messages a second.
      const now = Date.now();
      if (now - client.winStart > 1000) { client.winStart = now; client.winCount = 0; }
      if (++client.winCount > MAX_MSGS_PER_SEC) return sock.destroy();
      if (frame.op === 9) { if (frame.data.length <= 125) sock.write(Buffer.concat([Buffer.from([0x8a, frame.data.length]), frame.data])); continue; }
      if (frame.op !== 1 || frame.data.length > 2048) continue;
      try { handle(client, JSON.parse(frame.data.toString())); }
      catch (err) { console.warn(`client ${client.id}: bad message (${err.message})`); }
    }
  });
  sock.on('close', () => leave(client));
  sock.on('error', () => leave(client));
});

server.maxConnections = 500;
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.listen(PORT, () => console.log(`Burger Run 3D server on http://localhost:${PORT} (share your LAN IP with friends)`));
