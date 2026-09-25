// =====================================================================
// Echoes of Hong Kong — server/server.js
//   A minimal relay server for true cross-device multiplayer.
//
//   Responsibilities (deliberately dumb — all game simulation stays
//   client-side, exactly like the Unity Mirror "relay/host" model this
//   project will migrate to):
//     1. Room matchmaking  — 4-char room codes, max 2 players per room
//     2. Role arbitration  — role A / B can each be claimed once
//     3. Message relay     — forwards `msg` envelopes verbatim to the peer
//     4. Static hosting    — serves the game itself (single-port deploy)
//
//   PROTOCOL (JSON over WebSocket)
//   -----------------------------------------------------------------
//   Client -> Server
//     { t: 'join',      room: 'AB3K' }        join (or create) a room
//     { t: 'set-role',  role: 'A' | 'B' }      claim a role
//     { t: 'msg',       data: <game message> } relayed to the other peer
//
//   Server -> Client
//     { t: 'joined',     room, roles }         confirm join + occupancy
//     { t: 'room-state', room, roles }         occupancy changed (broadcast)
//     { t: 'role-ok',    role }                role claim accepted
//     { t: 'role-taken', role }                role claim rejected
//     { t: 'msg',        data }                relayed game message
//     { t: 'error',      reason }
//
//   `roles` is always `{ A: boolean, B: boolean }` (true = occupied).
//
//   Run:  npm install && npm start     (default port 8080, $PORT override)
// =====================================================================

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT      = Number(process.env.PORT) || 8080;
const ROOT      = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // game root
const MAX_ROOM_SIZE  = 2;
const MAX_ROOMS      = 500;
const PING_INTERVAL  = 30_000;

// ---------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

class Room {
  constructor(code) {
    this.code    = code;
    this.clients = new Map();   // WebSocket -> { role: 'A'|'B'|null }
  }

  get size() { return this.clients.size; }

  roles() {
    const r = { A: false, B: false };
    for (const c of this.clients.values()) if (c.role) r[c.role] = true;
    return r;
  }

  send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcast(obj, except = null) {
    const s = JSON.stringify(obj);
    for (const ws of this.clients.keys()) {
      if (ws !== except && ws.readyState === ws.OPEN) ws.send(s);
    }
  }

  broadcastState() {
    this.broadcast({ t: 'room-state', room: this.code, roles: this.roles() });
  }
}

const rooms = new Map();   // code -> Room

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = new Room(code);
    rooms.set(code, room);
  }
  return room;
}

// ---------------------------------------------------------------------
// Static file hosting (so a single VPS/Render deploy serves everything)
// ---------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';

  // Prevent path traversal: resolve inside ROOT and re-check prefix.
  const filePath = normalize(join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }

  readFile(filePath)
    .then((buf) => {
      const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(buf);
    })
    .catch(() => res.writeHead(404).end('not found'));
}

// ---------------------------------------------------------------------
// HTTP + WebSocket wiring
// ---------------------------------------------------------------------
const httpServer = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200).end('ok'); return; }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive  = true;
  ws.room     = null;          // Room
  ws.meta     = { role: null };
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      // -- join / create a room --------------------------------------
      case 'join': {
        const code = String(m.room || '').toUpperCase().trim();
        if (!ROOM_CODE_RE.test(code)) {
          ws.send(JSON.stringify({ t: 'error', reason: 'invalid room code' }));
          return;
        }
        if (ws.room) { // re-join: leave current room first
          leaveRoom(ws);
        }
        const room = getOrCreateRoom(code);
        if (!room || room.size >= MAX_ROOM_SIZE) {
          ws.send(JSON.stringify({ t: 'error', reason: room ? 'room is full' : 'server busy' }));
          return;
        }
        room.clients.set(ws, ws.meta);
        ws.room = room;
        ws.send(JSON.stringify({ t: 'joined', room: room.code, roles: room.roles() }));
        room.broadcastState();
        break;
      }

      // -- claim a role -----------------------------------------------
      case 'set-role': {
        const role = m.role === 'A' || m.role === 'B' ? m.role : null;
        if (!role || !ws.room) {
          ws.send(JSON.stringify({ t: 'error', reason: 'bad role claim' }));
          return;
        }
        // Conflict if any OTHER client already holds this role
        for (const [peer, meta] of ws.room.clients) {
          if (peer !== ws && meta.role === role) {
            ws.send(JSON.stringify({ t: 'role-taken', role }));
            return;
          }
        }
        ws.meta.role = role;
        ws.send(JSON.stringify({ t: 'role-ok', role }));
        ws.room.broadcastState();
        break;
      }

      // -- dumb relay: forward the envelope to the peer(s) ------------
      case 'msg': {
        if (!ws.room) return;
        ws.room.broadcast({ t: 'msg', data: m.data }, ws);
        break;
      }

      default:
        ws.send(JSON.stringify({ t: 'error', reason: 'unknown message' }));
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  ws.room = null;
  ws.meta.role = null;
  room.broadcastState();
  if (room.size === 0) rooms.delete(room.code);
}

// Heartbeat: drop dead sockets so rooms free up promptly.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL);

httpServer.listen(PORT, () => {
  console.log(`[echoes852] relay + static server listening on :${PORT}`);
  console.log(`[echoes852] game:   http://localhost:${PORT}`);
  console.log(`[echoes852] socket: ws://localhost:${PORT}/ws`);
});
