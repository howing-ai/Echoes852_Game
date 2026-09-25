// =====================================================================
// Echoes of Hong Kong — js/net.js
//   NetLink: the client networking layer.
//
//   One API, two transports (chosen automatically):
//     SERVER — WebSocket connection to the relay server (server/server.js).
//              True cross-device multiplayer. Room-code matchmaking,
//              server-arbitrated role claims, `msg` envelopes relayed
//              verbatim to the partner.
//     LOCAL  — BroadcastChannel fallback (same-browser tabs). Zero setup.
//              Presence is negotiated with hello/present/goodbye pings.
//
//   The rest of the game never touches a socket: it calls net.send(msg)
//   and receives messages through the single onMessage callback. This
//   mirrors the Unity Mirror migration target, where NetLink becomes a
//   NetworkClient + Transport pair and the game messages become
//   serialized Command/RpcMessage structs.
//
//   Game-message schema (identical on both transports — the relay server
//   is a dumb pipe and never inspects `data`):
//     { type:'b-state', ... }            Player B -> A sensory stream
//     { type:'a-target'|'a-lure', ... }  Player A -> B intent
//     { type:'b-echo'|'b-beacon-collected', ... }
//     { type:'present'|'goodbye', role } presence, synthesized by NetLink
// =====================================================================

export const NET_MODE = Object.freeze({
  OFFLINE: 'offline',   // not started yet
  LOCAL:   'local',     // BroadcastChannel (same-browser tabs)
  SERVER:  'server',    // WebSocket relay (true networking)
});

// Unambiguous alphabet: no 0/O, no 1/I.
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(len = 4) {
  let code = '';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) {
    code += ROOM_ALPHABET[buf[i] % ROOM_ALPHABET.length];
  }
  return code;
}

// Smart default: if the page itself was served by our relay server,
// point the WebSocket at the same host — zero configuration on deploy.
export function defaultServerUrl() {
  if (location.protocol === 'file:') return 'ws://localhost:8080/ws';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export class NetLink {
  constructor({ connectTimeoutMs = 6000 } = {}) {
    this._connectTimeoutMs = connectTimeoutMs;

    this.mode      = NET_MODE.OFFLINE;   // NET_MODE
    this.room      = null;               // room code when in SERVER mode
    this.role      = null;               // my role ('A' | 'B') once claimed
    this.connected = false;              // server link is live

    this._onMessage = null;              // (gameMsg) => void
    this._onStatus  = null;              // (status)   => void

    this._ws           = null;
    this._bc           = null;
    this._localPeerRole  = null;         // presence seen over BroadcastChannel
    this._serverPeers    = new Set();    // roles held by remote clients
    this._roleClaim      = null;         // { resolve, reject } while claiming
  }

  // ------------------------------------------------------------------
  // Subscriptions
  // ------------------------------------------------------------------
  onMessage(fn) { this._onMessage = fn; }
  onStatus(fn)  { this._onStatus  = fn; }

  _emit(msg)   { this._onMessage?.(msg); }
  _emitStatus() {
    this._onStatus?.({
      mode:      this.mode,
      room:      this.room,
      role:      this.role,
      connected: this.connected,
    });
  }

  // ------------------------------------------------------------------
  // LOCAL transport (BroadcastChannel) — the always-warm fallback
  // ------------------------------------------------------------------
  startLocal() {
    if (this._bc) return;
    try {
      this._bc = new BroadcastChannel('echoes852-sync');
    } catch (err) {
      console.warn('[net] BroadcastChannel unavailable', err);
      return;
    }
    this._bc.onmessage = (e) => this._onLocalMessage(e.data);
    if (this.mode === NET_MODE.OFFLINE) this.mode = NET_MODE.LOCAL;
    // Ask who is already here; an existing tab replies with 'present'.
    setTimeout(() => this._bc?.postMessage({ type: 'hello' }), 50);
    this._emitStatus();
  }

  _onLocalMessage(msg) {
    // Once the server link is live it owns messaging; ignore local chatter
    // so two tabs on one machine never receive duplicated game traffic.
    if (this.mode === NET_MODE.SERVER || !msg || !msg.type) return;

    switch (msg.type) {
      case 'hello':
        if (this.role) this._bc?.postMessage({ type: 'present', role: this.role });
        break;
      case 'present':
        if (msg.role && msg.role !== this.role && msg.role !== this._localPeerRole) {
          this._localPeerRole = msg.role;
          this._emit({ type: 'present', role: msg.role });
          this._emitStatus();
        }
        break;
      case 'goodbye':
        if (this._localPeerRole) {
          this._localPeerRole = null;
          this._emit({ type: 'goodbye' });
          this._emitStatus();
        }
        break;
      default:
        this._emit(msg);   // game traffic
    }
  }

  /** Claim a role in LOCAL mode (no arbitration needed). */
  setLocalRole(role) {
    this.role = role;
    if (this.mode === NET_MODE.LOCAL && this._bc) {
      this._bc.postMessage({ type: 'present', role });
      // Re-announce shortly after in case a peer just opened
      setTimeout(() => this._bc?.postMessage({ type: 'present', role }), 100);
    }
    this._emitStatus();
  }

  // ------------------------------------------------------------------
  // SERVER transport (WebSocket relay)
  // ------------------------------------------------------------------

  /**
   * Connect to the relay server and join (or create) a room.
   * Resolves with the room code; rejects if unreachable / invalid.
   */
  connectServer(url, roomCode) {
    return new Promise((resolve, reject) => {
      if (this._ws) {
        try { this._ws.onclose = null; this._ws.close(); } catch { /* ignore */ }
        this._ws = null;
      }

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(new Error(`invalid server url: ${url}`));
        return;
      }
      this._ws = ws;

      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        finish(reject, new Error('connection timed out'));
      }, this._connectTimeoutMs);

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', room: String(roomCode).toUpperCase().trim() }));
      };
      ws.onerror = () => finish(reject, new Error('could not reach server'));
      ws.onclose = () => {
        if (!settled) {
          finish(reject, new Error('connection refused'));
        } else {
          this._onServerDown();
        }
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        this._onServerMessage(m, () => finish(resolve, this.room));
      };
    });
  }

  _onServerMessage(m, onJoined) {
    switch (m.t) {
      case 'joined':
        this.mode      = NET_MODE.SERVER;
        this.room      = m.room;
        this.connected = true;
        this._applyServerRoles(m.roles);
        onJoined?.();
        this._emitStatus();
        break;

      case 'room-state':
        this._applyServerRoles(m.roles);
        break;

      case 'role-ok': {
        this.role = m.role;
        const claim = this._roleClaim;
        this._roleClaim = null;
        claim?.resolve(m.role);
        this._emitStatus();
        break;
      }

      case 'role-taken': {
        const claim = this._roleClaim;
        this._roleClaim = null;
        claim?.reject(new Error(`role ${m.role} is already taken`));
        break;
      }

      case 'msg':
        this._emit(m.data);   // unwrap the envelope — game sees raw messages
        break;

      case 'error':
        console.warn('[net] server error:', m.reason);
        break;
    }
  }

  /** Translate server role occupancy into present/goodbye events. */
  _applyServerRoles(roles) {
    if (!roles) return;
    const now = new Set(
      Object.keys(roles).filter((r) => roles[r] && r !== this.role)
    );
    let changed = now.size !== this._serverPeers.size;
    for (const r of now) {
      if (!this._serverPeers.has(r)) {
        changed = true;
        this._emit({ type: 'present', role: r });
      }
    }
    for (const r of this._serverPeers) {
      if (!now.has(r)) {
        changed = true;
        this._emit({ type: 'goodbye' });
      }
    }
    this._serverPeers = now;
    if (changed) this._emitStatus();
  }

  _onServerDown() {
    if (this.mode !== NET_MODE.SERVER) return;
    this.connected = false;
    this._applyServerRoles({ A: false, B: false });
    this._emitStatus();
  }

  /** True if the partner is connected (either transport). */
  hasPeer() {
    if (this.mode === NET_MODE.SERVER) return this._serverPeers.size > 0;
    return this._localPeerRole !== null;
  }

  /**
   * Claim a role. SERVER mode asks the server to arbitrate (rejects if
   * the partner already holds it); LOCAL mode just announces it.
   */
  claimRole(role) {
    if (this.mode !== NET_MODE.SERVER) {
      this.setLocalRole(role);
      return Promise.resolve(role);
    }
    return new Promise((resolve, reject) => {
      this._roleClaim = { resolve, reject };
      this._ws?.send(JSON.stringify({ t: 'set-role', role }));
      setTimeout(() => {
        if (this._roleClaim) {
          this._roleClaim = null;
          reject(new Error('role claim timed out'));
        }
      }, 4000);
    });
  }

  // ------------------------------------------------------------------
  // Unified send — the only call the rest of the game ever needs
  // ------------------------------------------------------------------
  send(msg) {
    if (this.mode === NET_MODE.SERVER) {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ t: 'msg', data: msg }));
      }
    } else if (this._bc) {
      this._bc.postMessage(msg);
    }
  }

  disconnect() {
    if (this._bc) {
      this._bc.postMessage({ type: 'goodbye' });
      this._bc.close();
      this._bc = null;
    }
    if (this._ws) {
      try { this._ws.onclose = null; this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    this.mode      = NET_MODE.OFFLINE;
    this.connected = false;
    this.room      = null;
    this._serverPeers.clear();
    this._localPeerRole = null;
    this._emitStatus();
  }
}
