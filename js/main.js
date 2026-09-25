// =====================================================================
// Echoes of Hong Kong — main.js
//   * Bootstraps the game
//   * Owns the GameMap (simple grid map)
//   * Drives the main loop
//   * Wires HUD + audio + ghost + players
// =====================================================================

import { PlayerB, PlayerA } from './player.js';
import { Ghost, GHOST_STATE } from './ghost.js';
import { SpatialAudio }       from './audio.js';
import { CalibrationSession, loadCal, saveCal, clearCal, CAL } from './calibration.js';
import { GhostDecoyDirector } from './decoy.js';
import { MemoryEchoSystem }   from './memoryEchoes.js';
import { NetLink, NET_MODE, generateRoomCode, defaultServerUrl } from './net.js';
import { AudioAssetBank } from './audioAssets.js';
import { AmbientMusic }    from './music.js';

// -------------------------------------------------------------------------
// MAP ARCHETYPES — each location is structurally AND chromatically unique.
//   1. SHAM SHUI PO   : tight irregular neon alleys (the original maze)
//   2. TEMPLE STREET  : lantern-lit market lanes — long horizontal streets
//                       cut by stall walls with staggered gaps
//   3. KWAI CHUNG     : container freight yard — a regular 2x2 block grid
//                       with long, exposed sightlines
// The palette drives Player B's first-person renderer (js/player.js), the
// title-screen preview cards and the HUD location chips, so a location is
// recognisable at a glance from any of them.
// Unity mapping: MAP_DEFS[] -> LocationDefinition ScriptableObjects.
// -------------------------------------------------------------------------
function genTempleGrid() {
  const W = 24, H = 24;
  const g = Array.from({ length: H }, () => Array(W).fill(0));
  for (let i = 0; i < W; i++) { g[0][i] = 1; g[H - 1][i] = 1; }
  for (let y = 0; y < H; y++) { g[y][0] = 1; g[y][W - 1] = 1; }
  // Full-width stall rows with staggered 2-wide gaps = market streets
  const lanes = { 5: [3, 4, 14, 15, 20], 10: [1, 2, 8, 9, 17, 18], 15: [5, 6, 12, 13, 21], 19: [3, 4, 16, 17] };
  for (const [y, gaps] of Object.entries(lanes)) {
    for (let x = 1; x < W - 1; x++) if (!gaps.includes(x)) g[y][x] = 1;
  }
  // Vertical stubs break the sightlines down each street
  const stubs = [[6, 1], [12, 2], [17, 6], [6, 7], [7, 11], [16, 11], [9, 16], [14, 16], [6, 21], [18, 21]];
  for (const [x, y] of stubs) g[y][x] = 1;
  return g.map(r => r.join(''));
}

function genKwaiGrid() {
  const W = 24, H = 24;
  const g = Array.from({ length: H }, () => Array(W).fill(0));
  for (let i = 0; i < W; i++) { g[0][i] = 1; g[H - 1][i] = 1; }
  for (let y = 0; y < H; y++) { g[y][0] = 1; g[y][W - 1] = 1; }
  // Container stacks: 2x2 blocks on a 5-cell pitch -> 3-wide lanes, all connected
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if ((y % 5 === 1 || y % 5 === 2) && (x % 5 === 1 || x % 5 === 2)) g[y][x] = 1;
    }
  }
  return g.map(r => r.join(''));
}

const MAP_DEFS = [
  {
    id: 'shamshuipo',
    name: 'SHAM SHUI PO ALLEYS',
    blurb: 'tight neon alleys · dead ends',
    grid: [
      "111111111111111111111111",
      "100000000000000000000001",
      "101111101111101111110001",
      "100000101000100000010001",
      "111100101011101111010001",
      "100000100000000000010001",
      "101111111011111101111101",
      "101000000010000100000001",
      "101011101110101101111111",
      "101000001000101100000001",
      "101111111100101111110101",
      "100000000000100000010101",
      "111111011111100111110101",
      "100001000000100100000101",
      "101101111010101101111101",
      "101100000010101000000001",
      "101111111110101111111101",
      "100000000010100000000001",
      "101111101110101111111111",
      "101000101000100000000001",
      "101011101011111011111101",
      "100010001000000000000001",
      "100000000000000000000001",
      "111111111111111111111111",
    ],
    playerSpawn: { x: 1.5, y: 1.5 },
    ghostSpawn:  { x: 22.5, y: 22.5 },
    beacons: [ { x: 6, y: 6 }, { x: 17, y: 3 }, { x: 3, y: 14 }, { x: 18, y: 13 }, { x: 11, y: 21 } ],
    palette: {
      wallNear: [60, 220, 120], wallFar: [10, 70, 40],
      edge: '154,240,160', accent: '#9af0a0',
      skyTop: '#02050a', skyBot: '#0c1418',
      floorTop: '#0a0606', floorBot: '#1c0d04',
    },
  },
  {
    id: 'temple',
    name: 'TEMPLE STREET MARKET',
    blurb: 'lantern lanes · long streets',
    grid: genTempleGrid(),
    playerSpawn: { x: 1.5, y: 1.5 },
    ghostSpawn:  { x: 22.5, y: 22.5 },
    beacons: [ { x: 3, y: 3 }, { x: 20, y: 3 }, { x: 11, y: 12 }, { x: 3, y: 17 }, { x: 20, y: 17 } ],
    palette: {
      wallNear: [190, 120, 50], wallFar: [34, 16, 8],
      edge: '255,184,75', accent: '#ffb84b',
      skyTop: '#080405', skyBot: '#200f08',
      floorTop: '#140804', floorBot: '#2c1206',
    },
  },
  {
    id: 'kwai',
    name: 'KWAI CHUNG FREIGHT YARD',
    blurb: 'container grid · open sightlines',
    grid: genKwaiGrid(),
    playerSpawn: { x: 3.5, y: 3.5 },
    ghostSpawn:  { x: 20.5, y: 20.5 },
    beacons: [ { x: 4, y: 4 }, { x: 9, y: 13 }, { x: 13, y: 4 }, { x: 19, y: 9 }, { x: 4, y: 19 } ],
    palette: {
      wallNear: [70, 180, 200], wallFar: [8, 22, 30],
      edge: '120,220,240', accent: '#7adcf0',
      skyTop: '#020608', skyBot: '#0a1620',
      floorTop: '#050a0d', floorBot: '#101c24',
    },
  },
];

// -------------------------------------------------------------------------
// GAME MAP — grid + walls + raycast, driven by a MAP_DEFS entry
// -------------------------------------------------------------------------
class GameMap {
  constructor(def) {
    const d = def || MAP_DEFS[0];
    this.def     = d;
    this.name    = d.name;
    this.palette = d.palette;
    this.width   = 24;
    this.height  = 24;

    this.grid = d.grid.map(row => row.split('').map(Number));

    this.playerSpawn = { ...d.playerSpawn };
    this.ghostSpawn  = { ...d.ghostSpawn };
    this.beacons     = d.beacons.map(b => ({ ...b }));

    this._buildWalls();
  }

  _buildWalls() {
    const walls = [];
    const g = this.grid;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (g[y][x] !== 1) continue;
        // wall tile centers span (x..x+1, y..y+1). Emit one outline loop.
        walls.push({ x1: x,   y1: y,   x2: x+1, y2: y   });
        walls.push({ x1: x+1, y1: y,   x2: x+1, y2: y+1 });
        walls.push({ x1: x+1, y1: y+1, x2: x,   y2: y+1 });
        walls.push({ x1: x,   y1: y+1, x2: x,   y2: y   });
      }
    }
    this.walls = walls;
  }

  isWall(x, y) {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return true;
    return this.grid[cy][cx] === 1;
  }

  // Simple brute-force DDA-style raymarcher; cheap enough for prototype.
  castRay(ox, oy, dx, dy) {
    const step = 0.05;
    let x = ox, y = oy;
    for (let i = 0; i < 400; i++) {
      x += dx * step;
      y += dy * step;
      if (this.isWall(x, y)) {
        return { distance: Math.hypot(x - ox, y - oy), x, y };
      }
    }
    return { distance: Infinity, x: ox + dx * 20, y: oy + dy * 20 };
  }
}

// -------------------------------------------------------------------------
// BOOT
// -------------------------------------------------------------------------
const titleScreen    = document.getElementById('title-screen');
const gameContainer  = document.getElementById('game-container');
const staticOverlay  = document.getElementById('static-overlay');
const compass        = document.getElementById('compass');
const beaconCounter  = document.getElementById('beacon-collected');
const statusA        = document.getElementById('status-a');
const statusB        = document.getElementById('status-b');
const targetText     = document.getElementById('target-text');
const targetIndicator = document.getElementById('target-indicator');
const captureOverlay = document.getElementById('capture-overlay');

// --- Spatial calibration UI (Player A) ---
const calBtn        = document.getElementById('cal-btn');
const calOverlay    = document.getElementById('cal-overlay');
const calClose      = document.getElementById('cal-close');
const calPad        = document.getElementById('cal-pad');
const calInstr      = document.getElementById('cal-instruction');
const calProgress   = document.getElementById('cal-progress');
const calResult     = document.getElementById('cal-result');
const calWarning    = document.getElementById('cal-warning');
const calWarnReason = document.getElementById('cal-warning-reason');
const calVMin       = document.getElementById('cal-vmin');
const calVMinVal    = document.getElementById('cal-vmin-val');
const calVMax       = document.getElementById('cal-vmax');
const calVMaxVal    = document.getElementById('cal-vmax-val');
const calTest       = document.getElementById('cal-test');
const calApply      = document.getElementById('cal-apply');
const calReset      = document.getElementById('cal-reset');
const syncStatus     = document.getElementById('sync-status');

const proxBar      = document.getElementById('proximity-bar');
const proxVal      = document.getElementById('proximity-val');
const aggrBar      = document.getElementById('aggression-bar');
const aggrVal      = document.getElementById('aggression-val');
const beaconBar    = document.getElementById('beacon-bar');
const beaconVal    = document.getElementById('beacon-val');

let map      = new GameMap(MAP_DEFS[0]);
const playerB = new PlayerB(map, {
  canvas:         document.getElementById('fp-canvas'),
  captureOverlay: captureOverlay,
  syncStatus:     syncStatus,
});
let playerA = new PlayerA(map, document.getElementById('map-canvas'));
let ghost   = new Ghost(map, map.ghostSpawn);
const audio       = new SpatialAudio();
let decoy   = new GhostDecoyDirector(map);   // decides when/where the mimic sings
let echoes  = new MemoryEchoSystem(map);     // deterministic residue whispers

// -------------------------------------------------------------------------
// MAP SWITCHING — Player B (the world authority) owns the ground; Player A
// mirrors it via the 'b-map' message. applyMap() rebuilds every map-bound
// system; playerB is re-pointed instead of rebuilt (it owns input bindings).
// -------------------------------------------------------------------------
function applyMap(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAP_DEFS.length) return;

  const chipA = document.getElementById('loc-name-a');
  const chipB = document.getElementById('loc-name-b');
  if (chipA) chipA.textContent = MAP_DEFS[idx].name;
  if (chipB) chipB.textContent = MAP_DEFS[idx].name;

  if (map && map.def === MAP_DEFS[idx]) {   // already on this map: chips only
    game.mapIdx = idx;
    return;
  }

  map      = new GameMap(MAP_DEFS[idx]);
  game.mapIdx = idx;

  playerB.map = map;
  playerB.x = map.playerSpawn.x; playerB.y = map.playerSpawn.y;
  playerB.yaw = 0; playerB.velX = 0; playerB.velY = 0;

  ghost   = new Ghost(map, map.ghostSpawn);
  playerA = new PlayerA(map, document.getElementById('map-canvas'));
  decoy   = new GhostDecoyDirector(map);
  echoes  = new MemoryEchoSystem(map);
  hookPlayerA();

  window.__echoes = { game, map, playerA, playerB, ghost, audio, decoy, echoes, net, music: () => music };
}

function hookPlayerA() {
  const orig = playerA.setActiveBeaconIdx?.bind(playerA);
  playerA.setActiveBeaconIdx = function (idx) {
    if (orig) orig(idx);
    else this.activeBeaconIdx = idx;
    if (game.role === 'A') {
      net.send({ type: 'a-target', idx });
      if (game.phase === STATE.PLAY) triggerLure(idx);
    }
  };
}
hookPlayerA();

// -------------------------------------------------------------------------
// TITLE SCREEN — location cards with live top-down previews.
// Each card is painted in its map's palette so the three locations are
// distinguishable before a single step is taken.
// -------------------------------------------------------------------------
const mapCardsWrap = document.getElementById('map-cards');
let selectedMapIdx = 0;

function renderMapCards() {
  if (!mapCardsWrap) return;
  mapCardsWrap.innerHTML = '';
  MAP_DEFS.forEach((def, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'map-card' + (i === selectedMapIdx ? ' selected' : '');
    card.innerHTML =
      `<canvas width="96" height="96"></canvas>` +
      `<span class="mc-check">&#10003;</span>` +
      `<span class="mc-name">${def.name}</span>` +
      `<span class="mc-blurb">${def.blurb}</span>`;
    card.addEventListener('click', () => {
      selectedMapIdx = i;
      renderMapCards();
      applyMap(i);   // instant local preview (B's choice is broadcast on start)
    });
    mapCardsWrap.appendChild(card);

    // top-down preview: walls in the palette accent on that map's night sky
    const cv = card.querySelector('canvas');
    const c2 = cv.getContext('2d');
    c2.fillStyle = def.palette.skyBot;
    c2.fillRect(0, 0, 96, 96);
    c2.fillStyle = def.palette.accent;
    for (let y = 0; y < def.grid.length; y++) {
      for (let x = 0; x < def.grid[y].length; x++) {
        if (def.grid[y][x] === '1') c2.fillRect(x * 4, y * 4, 4, 4);
      }
    }
    // beacons as warning-red pixels
    c2.fillStyle = '#ff3b6b';
    for (const b of def.beacons) c2.fillRect(b.x * 4 + 1, b.y * 4 + 1, 2, 2);
  });
}

let music = null;   // AmbientMusic — shared bgm bed (module-level for __echoes)

// -------------------------------------------------------------------------
// ROLE SELECTION
//   Server mode: the server arbitrates (rejects a role already held by the
//   partner). Local mode: NetLink just announces our role to sibling tabs.
// -------------------------------------------------------------------------
document.getElementById('role-a-btn').addEventListener('click', () => pickRole('A'));
document.getElementById('role-b-btn').addEventListener('click', () => pickRole('B'));

async function pickRole(r) {
  if (game.role) return;
  try {
    await net.claimRole(r);
  } catch (err) {
    setNetStatus(`${err.message} — pick the other role`, 'bad');
    return;
  }
  selectRole(r);
}

function selectRole(r) {
  game.role = r;
  titleScreen.classList.add('hidden');
  gameContainer.classList.remove('hidden');

  // Single-role layout: hide the other panel entirely
  gameContainer.classList.add('role-only');
  gameContainer.classList.toggle('is-role-a', r === 'A');
  gameContainer.classList.toggle('is-role-b', r === 'B');

  // SYMBIOTIC AUDIO:
  //   Player A is the ears  -> A's tab owns the AudioContext.
  //   Player B is the eyes  -> B's tab NEVER initialises game audio.
  //                            B is completely deaf in-game.
  //   Shared exception: the ambient music bed plays on BOTH tabs
  //   (B through a private context) — everything gameplay-relevant
  //   (beacons, ghost, breathing, footsteps) still only exists for A.
  music = new AmbientMusic();
  if (r === 'A') {
    audio.init();
    audio.resume();
    // Restore persisted spatial calibration (polar remap + loudness env)
    const saved = loadCal();
    if (saved) audio.setCalibration(saved);
    calBtn.classList.remove('hidden');

    // Load CC0 samples (breathing + footsteps) and the shared music bed.
    // One bank, one fetch pass; loading is non-blocking — synth fallbacks
    // cover the gap meanwhile.
    const bank = new AudioAssetBank();
    const bankReady = bank.load(audio.ctx);
    bankReady
      .then(() => audio.attachBank(bank))
      .catch((err) => console.warn('[audio] asset bank failed', err));
    music.startShared(audio.ctx, bankReady.then(() => bank));
  } else if (r === 'B') {
    // B's tab: music only, through its own minimal context.
    music.startStandalone();
    // B owns the ground: announce the chosen location to A (and keep the
    // snapshot stream carrying it as a late-join safety net).
    net.send({ type: 'b-map', idx: game.mapIdx });
  }

  updateSyncStatus();
  game.phase = STATE.PLAY;
}

// Normalize an angle into [-PI, PI]
function normAngle(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Bearing of (bx,by) relative to Player B's position AND facing.
// 0 = dead ahead of B; +PI/2 = B's right; -PI/2 = B's left.
function relAngle(bx, by, px, py, yaw) {
  return normAngle(Math.atan2(by - py, bx - px) - yaw);
}

// -------------------------------------------------------------------------
// STATE
// -------------------------------------------------------------------------
const STATE = Object.freeze({
  TITLE:  'title',
  PLAY:   'play',
  WIN:    'win',
  LOSE:   'lose',
});

const game = {
  phase:  STATE.TITLE,
  role:   null,        // 'A' | 'B' | null
  mapIdx: 0,           // active MAP_DEFS index (B is the authority)
  tension:        0,
  ghostProximity: 0,
  ghostX:         ghost.x,
  ghostY:         ghost.y,
  playerX:        playerB.x,
  playerY:        playerB.y,
  playerYaw:      playerB.yaw,
  aState:         null,   // render payload for A's sensor terminal
};

renderMapCards();   // title-screen location previews
applyMap(0);        // set the HUD location chips for the default map

// -------------------------------------------------------------------------
// NETWORK LAYER (js/net.js — NetLink)
//   SERVER mode: WebSocket relay (server/server.js) — true cross-device
//               multiplayer, room-code matchmaking, server-side role
//               arbitration. Player B's tab stays the simulation authority;
//               the server is a dumb relay (the Mirror-style transport).
//   LOCAL mode: BroadcastChannel fallback — same-browser tabs, zero setup.
//   The game code below only ever calls net.send(); presence events
//   ('present' / 'goodbye') are synthesized identically by both transports.
// -------------------------------------------------------------------------
const net = new NetLink();
let remotePresent = false;
let remotePlayerB = false;     // has the partner taken role B?
let remoteRole    = null;

net.onMessage(onGameMessage);
net.onStatus(updateSyncStatus);
net.startLocal();   // warm the BroadcastChannel fallback immediately

// --- Title-screen network UI ---
const netUrl     = document.getElementById('net-url');
const netCode    = document.getElementById('net-code');
const netStatus  = document.getElementById('net-status');
const netCreate  = document.getElementById('net-create');
const netJoin    = document.getElementById('net-join');

netUrl.value = defaultServerUrl();

function setNetStatus(text, cls = '') {
  netStatus.textContent = text;
  netStatus.className   = `net-status ${cls}`.trim();
}

async function connectToServer(code) {
  netCreate.disabled = true;
  netJoin.disabled   = true;
  setNetStatus(`connecting to ${netUrl.value} …`, 'wait');
  try {
    const room = await net.connectServer(netUrl.value.trim(), code);
    setNetStatus(`room ${room} — share the code with your partner`, 'ok');
  } catch (err) {
    setNetStatus(`server unreachable (${err.message}) — falling back to local mode`, 'bad');
    throw err;
  } finally {
    netCreate.disabled = false;
    netJoin.disabled   = false;
  }
}

netCreate.addEventListener('click', async () => {
  const code = generateRoomCode();
  netCode.value = code;
  try {
    await connectToServer(code);
  } catch { /* status already shown; local fallback is live */ }
});

netJoin.addEventListener('click', async () => {
  const code = netCode.value.trim().toUpperCase();
  if (code.length < 4) {
    setNetStatus('enter the 4-character room code first', 'bad');
    return;
  }
  try {
    await connectToServer(code);
  } catch { /* status already shown; local fallback is live */ }
});

netCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') netJoin.click();
});

function onGameMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'present': {
      if (msg.role && msg.role !== game.role) {
        remotePresent = true;
        remoteRole    = msg.role;
        remotePlayerB = (msg.role === 'B');
        updateSyncStatus();
      }
      break;
    }
    case 'goodbye': {
      remotePresent = false;
      remotePlayerB = false;
      remoteRole    = null;
      updateSyncStatus();
      break;
    }
    // ---- Player B -> Player A stream ----
    case 'b-map': {
      // B (world authority) announces the ground. A mirrors it.
      if (game.role === 'A' && Number.isInteger(msg.idx)) {
        applyMap(msg.idx);
        selectedMapIdx = msg.idx;
        renderMapCards();
      }
      break;
    }
    case 'b-state': {
      if (game.role === 'A') {
        // Late-joining safety: the map index rides every snapshot
        if (Number.isInteger(msg.mi) && msg.mi !== game.mapIdx) applyMap(msg.mi);
        playerB.x    = msg.x;
        playerB.y    = msg.y;
        playerB.yaw  = msg.yaw;
        ghost.x      = msg.gx;
        ghost.y      = msg.gy;
        ghost.aggression = msg.ga;
        ghost.state  = msg.gs;
        ghost.staticLevel = msg.gsl;
        ghost.rageTimer = msg.gr ? 5 : 0;
        if (typeof msg.isMoving === 'boolean') playerB.isMoving = msg.isMoving;
        if (typeof msg.isSprinting === 'boolean') playerB.isSprinting = msg.isSprinting;
        // beacon progress
        if (Array.isArray(msg.collected)) {
          msg.collected.forEach((c, i) => {
            if (c && playerA.beacons[i]) playerA.beacons[i].collected = true;
          });
        }
      }
      break;
    }
    case 'b-beacon-collected': {
      if (game.role === 'A' && playerA.beacons[msg.idx]) {
        if (!playerA.beacons[msg.idx].collected) {
          playerA.beacons[msg.idx].collected = true;
          audio.playCollectChime?.();   // Player A hears the success sting
        }
      }
      break;
    }
    // ---- Player A -> Player B stream ----
    case 'a-target': {
      if (game.role === 'B' && Number.isInteger(msg.idx)) {
        playerA.activeBeaconIdx = msg.idx;
      }
      break;
    }
    case 'a-lure': {
      // A pinged a beacon: the ghost (simulated in B's tab) rushes to the sound
      if (game.role === 'B' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
        ghost.investigate(msg.x, msg.y);
      }
      break;
    }
    case 'b-echo': {
      // A residue stirred near B. Only Player A hears the whisper —
      // it arrives from inside A's own head (no position, no panner).
      if (game.role === 'A' && Number.isInteger(msg.idx)) {
        audio.playWhisper?.();
        showEchoSubtitle(msg.idx);
      }
      break;
    }
  }
}

function updateSyncStatus() {
  if (!syncStatus) return;
  if (net.mode === NET_MODE.SERVER && net.connected) {
    syncStatus.textContent = net.hasPeer()
      ? `linked: room ${net.room} (server)`
      : `room ${net.room} — waiting for partner…`;
    syncStatus.className = net.hasPeer() ? 'cap-sync linked' : 'cap-sync';
  } else if (remotePresent) {
    syncStatus.textContent = `linked to role ${remoteRole} (local)`;
    syncStatus.className   = 'cap-sync linked';
  } else if (net.mode === NET_MODE.SERVER && !net.connected) {
    syncStatus.textContent = 'server link lost';
    syncStatus.className   = 'cap-sync';
  } else {
    syncStatus.textContent = 'standalone session';
    syncStatus.className   = 'cap-sync';
  }
}

window.addEventListener('keydown', (e) => {
  // Calibration overlay open: SPACE replays the ping, game keys are inert
  if (!calOverlay.classList.contains('hidden')) {
    if (e.code === 'Space') { e.preventDefault(); calSession?.replay(); }
    return;
  }
  // Layout toggle (Player A only sees one panel anyway, but harmless)
  if (e.code === 'Tab') {
    e.preventDefault();
    gameContainer.classList.toggle('toggled');
  }
  // E — absorb active beacon (Player B only — Player A can't move)
  if (e.code === 'KeyE' && game.phase === STATE.PLAY && game.role === 'B') {
    const active = playerA.getActiveBeacon();
    if (active && !active.collected) {
      const d = Math.hypot(active.x + 0.5 - playerB.x, active.y + 0.5 - playerB.y);
      if (d < 2.0) {
        const idx = playerA.activeBeaconIdx;
        const ok = playerA.collectBeacon(idx, null);   // B is deaf: no chime here
        if (ok) net.send({ type: 'b-beacon-collected', idx });
      }
    }
  }
  // 1-5 — Player A selects which beacon to direct B toward
  // (gated while the spatial calibration overlay is open)
  if (game.phase === STATE.PLAY && game.role === 'A' && /^Digit[1-5]$/.test(e.code)
      && calOverlay.classList.contains('hidden')) {
    const idx = Number(e.code.slice(5)) - 1;
    if (idx >= 0 && idx < playerA.beacons.length && !playerA.beacons[idx].collected) {
      playerA.setActiveBeaconIdx(idx);
    }
  }
});

// Player A selects/pings a beacon (click or 1-5) -> lure the ghost + notify B
function triggerLure(idx) {
  const b = playerA.beacons[idx];
  if (!b || b.collected) return;
  const bx = b.x + 0.5, by = b.y + 0.5;
  // Loud spatial ping in A's own headphones, at the beacon's true position
  audio.playLurePing?.(bx, by);
  // The ghost hears it too (it is simulated in Player B's tab)
  net.send({ type: 'a-lure', x: bx, y: by, idx });
}

// (Player A's setActiveBeaconIdx hook lives in hookPlayerA() above — it is
//  re-attached every time applyMap() rebuilds the playerA instance.)

// =========================================================================
// MEMORY ECHO SUBTITLE (Player A)
//   The whisper is unintelligible by design; the intel arrives as text on
//   A's sensor terminal. The fragment plays ONCE per run — A must relay it
//   to B by voice, which is the whole point of the information asymmetry.
// =========================================================================
const echoSubtitle  = document.getElementById('echo-subtitle');
let echoSubTimer    = null;

function showEchoSubtitle(idx) {
  if (!echoSubtitle) return;
  const frag = echoes.getFragment(idx);
  echoSubtitle.innerHTML =
    `<span class="es-tag">&#9670; SIGNAL FRAGMENT ${idx + 1}/${echoes.total} &mdash; plays once</span>` +
    frag.text;
  echoSubtitle.classList.remove('hidden');
  requestAnimationFrame(() => echoSubtitle.classList.add('visible'));
  clearTimeout(echoSubTimer);
  echoSubTimer = setTimeout(hideEchoSubtitle, 7000);
}

function hideEchoSubtitle() {
  if (!echoSubtitle) return;
  clearTimeout(echoSubTimer);
  echoSubtitle.classList.remove('visible');
  setTimeout(() => echoSubtitle.classList.add('hidden'), 600);
}

// =========================================================================
// SPATIAL CALIBRATION & REMAPPING (Player A)
//   Interactive polar pad: pings sound at hidden positions; A clicks where
//   they perceive them. Deviation metrics diagnose the audio setup
//   (reversed channels / mono / general inaccuracy), and an affine inverse
//   map is fitted to pre-compensate the spatial panning. VOL MIN/MAX
//   sliders remap the loudness envelope. Persisted in localStorage.
// =========================================================================
let calSession = null;
let calLastResult = null;

const calPadCtx = calPad.getContext('2d');

function calPadGeometry() {
  const s = Math.min(calPad.width, calPad.height);
  return { c: s / 2, R: s / 2 - 34 };
}

function renderCalPad(trial) {
  const { c, R } = calPadGeometry();
  const ctx = calPadCtx;
  ctx.clearRect(0, 0, calPad.width, calPad.height);
  ctx.fillStyle = '#020604';
  ctx.fillRect(0, 0, calPad.width, calPad.height);

  // rings at 4 / 8 / 12 / 16 units
  ctx.strokeStyle = 'rgba(154,240,160,0.14)';
  ctx.lineWidth = 1;
  for (let u = 4; u <= CAL.D_MAX; u += 4) {
    ctx.beginPath();
    ctx.arc(c, c, (u / CAL.D_MAX) * R, 0, Math.PI * 2);
    ctx.stroke();
  }
  // crosshair
  ctx.beginPath();
  ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
  ctx.moveTo(c, c - R); ctx.lineTo(c, c + R);
  ctx.stroke();

  // frame letters: F(ront) R(ight) B(ack) L(eft)
  ctx.fillStyle = 'rgba(154,240,160,0.45)';
  ctx.font = '11px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('F', c, c - R - 10);
  ctx.fillText('B', c, c + R + 18);
  ctx.textAlign = 'left';  ctx.fillText('R', c + R + 8,  c + 4);
  ctx.textAlign = 'right'; ctx.fillText('L', c - R - 8,  c + 4);
  ctx.textAlign = 'center';

  const padXY = p => [c + (p.r * Math.sin(p.theta) / CAL.D_MAX) * R,
                      c - (p.r * Math.cos(p.theta) / CAL.D_MAX) * R];

  if (trial && trial.perceived) {
    // feedback: perceived (green) vs actual (amber) + error line
    const [ax, ay] = padXY(trial.actual);
    const [px, py] = padXY(trial.perceived);
    ctx.strokeStyle = 'rgba(255,59,107,0.7)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ax, ay); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffb84b';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(ax, ay, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#9af0a0';
    ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
  } else if (trial) {
    // awaiting click: breathing centre dot
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
    ctx.fillStyle = `rgba(154,240,160,${0.25 + pulse * 0.4})`;
    ctx.beginPath(); ctx.arc(c, c, 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

function calWarnText(verdict) {
  if (verdict === 'REVERSED') return 'stereo channels appear mirrored (left/right swapped)';
  if (verdict === 'MONO')     return 'no directional separation detected (mono output?)';
  return 'perceived positions deviate too far from the true sources';
}

function openCalibration() {
  if (game.role !== 'A' || !audio.ready) return;
  calOverlay.classList.remove('hidden');
  calResult.classList.add('hidden');
  calWarning.classList.add('hidden');
  calProgress.textContent = '';
  calLastResult = null;
  audio.enterCalibration();

  const saved = loadCal();
  calVMin.value = saved?.vMin ?? 1;
  calVMax.value = saved?.vMax ?? 1;
  calVMinVal.textContent = Number(calVMin.value).toFixed(2);
  calVMaxVal.textContent = Number(calVMax.value).toFixed(2);

  calSession = new CalibrationSession({
    canvas: calPad,
    audio,
    onTrialStart: (trial, i) => {
      calProgress.textContent = `PING ${i + 1} / ${CAL.TRIALS} — CLICK WHERE YOU HEAR IT`;
      renderCalPad(null);
    },
    onTrial: (trial) => {
      renderCalPad(trial);
      calProgress.textContent = `Δ ${(trial.errs.dTheta * 180 / Math.PI).toFixed(0)}°  ·  ${trial.errs.E.toFixed(2)} dev`;
    },
    onFinish: (result) => {
      calLastResult = result;
      calProgress.textContent = '';
      const ok = result.verdict === 'PASS';
      calResult.classList.remove('hidden');
      calResult.innerHTML =
        `<span class="${ok ? 'ok' : 'bad'}">${ok ? 'CALIBRATED' : 'DEVIATION DETECTED'}</span><br>` +
        `mean azimuth error: <span class="${Math.abs(result.meanDThetaDeg) > 22 ? 'bad' : 'ok'}">${result.meanDThetaDeg.toFixed(1)}°</span> · ` +
        `rms deviation: <span class="${result.rmsE > CAL.RMS_WARN ? 'bad' : 'ok'}">${result.rmsE.toFixed(3)}</span><br>` +
        `fitted remap — pan gain ×${result.correction.kT.toFixed(2)}, distance gain ×${result.correction.kR.toFixed(2)}`;
      if (!ok) {
        calWarnReason.textContent = calWarnText(result.verdict);
        calWarning.classList.remove('hidden');
      } else {
        calWarning.classList.add('hidden');
      }
      calInstr.innerHTML = 'correction fitted &mdash; <kbd>APPLY REMAP</kbd> to save it &middot; close and reopen <kbd>CAL</kbd> to recalibrate';
    },
  });
  calSession.start();
}

function closeCalibration() {
  calOverlay.classList.add('hidden');
  audio.exitCalibration();
  calSession?.destroy();
  calSession = null;
}

calBtn.addEventListener('click', openCalibration);
calClose.addEventListener('click', closeCalibration);

const calSliderSync = () => {
  calVMinVal.textContent = Number(calVMin.value).toFixed(2);
  calVMaxVal.textContent = Number(calVMax.value).toFixed(2);
};
calVMin.addEventListener('input', calSliderSync);
calVMax.addEventListener('input', calSliderSync);

calApply.addEventListener('click', () => {
  const base = calLastResult?.correction ?? { kT: 1, bT: 0, kR: 1, bR: 0 };
  const cal = { ...base, vMin: Number(calVMin.value), vMax: Number(calVMax.value) };
  audio.setCalibration(cal);
  saveCal(cal);
  calApply.textContent = 'APPLIED';
  setTimeout(() => { calApply.textContent = 'APPLY REMAP'; }, 1200);
});

calReset.addEventListener('click', () => {
  clearCal();
  audio.setCalibration(null);
  calVMin.value = 1; calVMax.value = 1;
  calSliderSync();
  calResult.classList.add('hidden');
  calWarning.classList.add('hidden');
  calLastResult = null;
});

calTest.addEventListener('click', () => {
  // Subjective check: ping at 45° right, 10 units, WITH current remap
  const dx = 10 * Math.sin(Math.PI / 4), dy = 10 * Math.cos(Math.PI / 4);
  audio.setCalListener(0, 0, Math.PI / 2);
  audio.playLurePing(dx, dy);   // remapped path — verifies the correction live
});

window.addEventListener('resize', () => {
  // canvas sizes auto-update on next frame via clientWidth/Height
});

window.addEventListener('beforeunload', () => {
  net.disconnect();   // local goodbye ping + clean socket close
});

// -------------------------------------------------------------------------
// UPDATE
// -------------------------------------------------------------------------
let bStateTimer = 0;   // 30Hz throttle for the b-state snapshot stream

function update(dt) {
  // ----- Player B is the primary simulation source (and is DEAF) -----
  if (game.role === 'B') {
    playerB.update(dt);
    ghost.update(dt, playerB.x, playerB.y);

    // Memory echoes: B walks past residues unaware; each triggers ONCE
    // and is broadcast to A (who hears the whisper + reads the fragment).
    const echoEvt = echoes.update(dt, playerB.x, playerB.y);
    if (echoEvt) net.send({ type: 'b-echo', idx: echoEvt.idx });

    // Mirror to render state
    game.playerX   = playerB.x;
    game.playerY   = playerB.y;
    game.playerYaw = playerB.yaw;
    game.ghostX    = ghost.x;
    game.ghostY    = ghost.y;

    // Proximity / tension (visual tension only — B hears nothing)
    const proxDist = Math.hypot(ghost.x - playerB.x, ghost.y - playerB.y);
    game.ghostProximity = Math.max(0, 1 - proxDist / 30);
    game.tension = Math.max(game.tension * 0.97, ghost.aggression);

    // Active beacon distance (for the HUD bar)
    const active = playerA.getActiveBeacon();
    let beaconDist = 999;
    if (active && !active.collected) {
      beaconDist = Math.hypot(active.x + 0.5 - playerB.x, active.y + 0.5 - playerB.y);
    }

    // Win/lose (no audio stingers here — B's tab is silent)
    if (playerA.collectedCount() >= playerA.beaconCount()) {
      game.phase = STATE.WIN;
    } else if (proxDist < 1.4) {
      game.phase = STATE.LOSE;
    }

    // ---- Broadcast the full sensory world to Player A ----
    // Throttled to 30Hz: over a real network the full-state snapshot does
    // not need to ride every frame (Unity equivalent: NetworkTransform
    // sendRate). Local mode inherits the same cadence harmlessly.
    bStateTimer += dt;
    if (bStateTimer >= 1 / 30) {
      bStateTimer = 0;
      net.send({
        type: 'b-state',
        mi: game.mapIdx,
        x: playerB.x, y: playerB.y, yaw: playerB.yaw,
        gx: ghost.x, gy: ghost.y, ga: ghost.aggression,
        gs: ghost.state, gsl: ghost.staticLevel,
        gr: ghost.rageTimer > 0,
        isMoving: playerB.isMoving,
        isSprinting: playerB.isSprinting,
        collected: playerA.beacons.map(b => b.collected),
      });
    }

    updateHUD_B(beaconDist);
  }
  // ----- Player A: the ears. Listens THROUGH Player B via the link. -----
  else if (game.role === 'A') {
    // State values arrive via net messages ('b-state').
    game.playerX   = playerB.x;
    game.playerY   = playerB.y;
    game.playerYaw = playerB.yaw;
    game.ghostX    = ghost.x;
    game.ghostY    = ghost.y;

    const proxDist = Math.hypot(ghost.x - playerB.x, ghost.y - playerB.y);
    game.ghostProximity = Math.max(0, 1 - proxDist / 30);
    game.tension = Math.max(game.tension * 0.97, ghost.aggression);

    // Active beacon source position
    const active = playerA.getActiveBeacon();
    let beaconDist = 999, beaconX = 0, beaconY = 0;
    if (active && !active.collected) {
      beaconX = active.x + 0.5;
      beaconY = active.y + 0.5;
      beaconDist = Math.hypot(beaconX - playerB.x, beaconY - playerB.y);
    }

    // ======== THE SYMBIOTIC LINK ========
    // Audio listener rides Player B's head: position + camera yaw.
    // When B turns in the 3D world, panning shifts in A's headphones.
    // Sound sources (beacon + ghost) live at their true world positions.
    //
    // The decoy director (false ear) watches the synced ghost state and
    // decides whether the mimic sings this frame. It runs HERE, on A's
    // tab, because only A has ears — the mimic is a lie told to A alone.
    decoy.update(dt, {
      ghostState: ghost.state,
      ghostX:     ghost.x,
      ghostY:     ghost.y,
      listenerX:  playerB.x,
      listenerY:  playerB.y,
    });

    audio.update({
      playerX:    playerB.x,
      playerY:    playerB.y,
      playerYaw:  playerB.yaw,     // <- B's camera rotation drives the panning
      ghostX:     ghost.x,
      ghostY:     ghost.y,
      ghostDist:  proxDist,
      beaconX,
      beaconY,
      beaconDist,
      decoy:      decoy.snapshot,
      aggression: ghost.aggression,
      tension:    game.tension,
      isMoving:   playerB.isMoving,
      isSprinting: playerB.isSprinting,
      dt,
    });

    // Assemble the sensor-terminal render payload
    game.aState = {
      beacons: playerA.beacons.map((b, i) => ({
        angle: relAngle(b.x + 0.5, b.y + 0.5, playerB.x, playerB.y, playerB.yaw),
        dist:  Math.hypot(b.x + 0.5 - playerB.x, b.y + 0.5 - playerB.y),
        active:    i === playerA.activeBeaconIdx,
        collected: b.collected,
      })),
      ghostAngle: relAngle(ghost.x, ghost.y, playerB.x, playerB.y, playerB.yaw),
      ghostDist:  proxDist,
      tension:    game.tension,
      heartPulse: audio.getHeartbeatPulse(),
      spectrum:   audio.getSpectrum(),
    };

    // Win/lose (A's tab plays the stingers)
    if (playerA.collectedCount() >= playerA.beaconCount()) {
      if (game.phase !== STATE.WIN) {
        game.phase = STATE.WIN;
        audio.playCollectChime?.();
      }
    } else if (proxDist < 1.4) {
      if (game.phase !== STATE.LOSE) {
        game.phase = STATE.LOSE;
        audio.playDeathRoar?.();
      }
    }

    updateHUD_A(beaconDist);
  }
}

function updateHUD_B(beaconDist) {
  // Sensor footer bars were removed from Player A's panel — guard nulls
  if (proxBar) {
    proxBar.style.width = (game.ghostProximity * 100).toFixed(1) + '%';
    proxVal.textContent = game.ghostProximity.toFixed(2);
    aggrBar.style.width = (ghost.aggression * 100).toFixed(1) + '%';
    aggrVal.textContent = ghost.aggression.toFixed(2);
  }

  if (beaconBar) {
    if (beaconDist < 99) {
      const norm = Math.max(0, 1 - beaconDist / 32);
      beaconBar.style.width = (norm * 100).toFixed(1) + '%';
      beaconVal.textContent = beaconDist.toFixed(1);
    } else {
      beaconBar.style.width = '0%';
      beaconVal.textContent = '--';
    }
  }

  // Static overlay
  staticOverlay.style.opacity = (ghost.getStatic() * 0.85).toFixed(2);

  // Status text
  const danger = game.tension > 0.65 || ghost.getStatic() > 0.7;
  const warn   = game.tension > 0.30 || ghost.getStatic() > 0.4;

  if (danger) {
    statusB.textContent = '!! ENTITY PROXIMITY !!';
    statusB.className   = 'status danger';
  } else if (warn) {
    statusB.textContent = 'TENSION RISING';
    statusB.className   = 'status';
  } else {
    statusB.textContent = 'DRIFTING';
    statusB.className   = 'status';
  }

  // Compass active marker
  const yawDeg = ((playerB.yaw * 180 / Math.PI) % 360 + 360) % 360;
  let facing = 'N';
  if      (yawDeg >  45 && yawDeg <= 135) facing = 'E';
  else if (yawDeg > 135 && yawDeg <= 225) facing = 'S';
  else if (yawDeg > 225 && yawDeg <= 315) facing = 'W';
  compass.querySelectorAll('span[data-dir]').forEach(s => {
    s.classList.toggle('active', s.dataset.dir === facing);
  });

  // Beacon counter (Player B)
  beaconCounter.textContent =
    `${playerA.collectedCount()} / ${playerA.beaconCount()} echoes absorbed`;

  // Target indicator — what Player A is highlighting for Player B
  const active = playerA.getActiveBeacon();
  if (targetText && targetIndicator) {
    if (!active) {
      targetText.textContent = '--';
      targetIndicator.classList.add('collected');
    } else if (active.collected) {
      targetText.textContent = 'all absorbed';
      targetIndicator.classList.add('collected');
    } else {
      const idx = playerA.beacons.indexOf(active);
      targetText.textContent = `B${idx + 1}`;
      targetIndicator.classList.remove('collected');
    }
  }

  // End-of-game overlay
  if (game.phase === STATE.WIN || game.phase === STATE.LOSE) {
    showEndBanner();
  } else {
    hideEndBanner();
  }
}

function updateHUD_A() {
  // The terminal is deliberately number-free: danger is conveyed by the
  // red tide, the heartbeat edge pulse, the static, and the audio itself.

  // Status text (audio-centric phrasing for the listener)
  const danger = game.tension > 0.65;
  const warn   = game.tension > 0.30;

  if (ghost.getRage?.()) {
    statusA.textContent = 'IT IS FURIOUS';
    statusA.className   = 'status danger';
  } else if (danger) {
    statusA.textContent = 'HUM OVERWHELMING';
    statusA.className   = 'status danger';
  } else if (warn) {
    statusA.textContent = 'HUM CLOSING';
    statusA.className   = 'status';
  } else {
    statusA.textContent = 'SENSORS NOMINAL';
    statusA.className   = 'status';
  }

  // End-of-game overlay
  if (game.phase === STATE.WIN || game.phase === STATE.LOSE) {
    showEndBanner();
  } else {
    hideEndBanner();
  }
}

let bannerEl = null;
function showEndBanner() {
  if (bannerEl) return;

  // Release pointer lock so the user can click RE-INITIATE.
  // Otherwise mouse capture would swallow all clicks on the banner.
  if (document.pointerLockElement) {
    document.exitPointerLock?.();
  }

  bannerEl = document.createElement('div');
  bannerEl.className = 'end-banner';
  bannerEl.style.cssText = `
    position: fixed; inset: 0; z-index: 8000;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(2px);
    font-family: "Courier New", monospace; text-align: center;
  `;
  const won = game.phase === STATE.WIN;
  bannerEl.innerHTML = `
    <div style="border:1px solid ${won ? '#9af0a0' : '#ff3b6b'};
                padding:1.6rem 2.4rem; background:#040608;
                box-shadow: 0 0 20px ${won ? '#9af0a0' : '#ff3b6b'};">
      <div style="color:${won ? '#9af0a0' : '#ff3b6b'}; font-size:1.6rem;
                  letter-spacing:0.4rem; text-shadow:0 0 8px currentColor;">
        ${won ? 'ALL ECHOES ABSORBED' : 'CONNECTION LOST'}
      </div>
      <div style="color:#ffb84b; font-size:0.8rem; letter-spacing:0.2rem; margin-top:0.6rem;">
        ${won ? 'your voices carried them home.' : 'the ghost found them. the hum goes quiet.'}
      </div>
      <button id="restart-btn" style="
        margin-top:1rem; background:transparent;
        border:1px solid #9af0a0; color:#9af0a0;
        padding:0.5rem 1.4rem; font-family:inherit;
        letter-spacing:0.3rem; cursor:pointer;">RE-INITIATE</button>
    </div>
  `;
  document.body.appendChild(bannerEl);
  document.getElementById('restart-btn').addEventListener('click', restart);
}

function hideEndBanner() {
  if (!bannerEl) return;
  bannerEl.remove();
  bannerEl = null;
}

function restart() {
  playerB.x = map.playerSpawn.x;
  playerB.y = map.playerSpawn.y;
  playerB.yaw = 0;
  ghost.x = map.ghostSpawn.x;
  ghost.y = map.ghostSpawn.y;
  ghost.aggression = 0;
  ghost.state = 'wander';
  playerA.beacons.forEach(b => b.collected = false);
  playerA.activeBeaconIdx = 0;
  decoy.reset();        // false ear: back to the grace period
  echoes.reset();       // residues may whisper again this run
  hideEchoSubtitle();
  game.phase = STATE.PLAY;
  hideEndBanner();
}

// Testing / demo handle — also the seam the Unity migration demos drive.
window.__echoes = { game, map, playerA, playerB, ghost, audio, decoy, echoes, net, music: () => music };

// -------------------------------------------------------------------------
// RENDER
// -------------------------------------------------------------------------
function render() {
  if (game.role === 'A') {
    // Sensor terminal: atmospheric readout only, no map.
    playerA.render(game.aState || {});
  } else if (game.role === 'B') {
    // First-person eyes only. B's tab plays no sound at all.
    playerB.render();
  } else {
    playerA.render(game.aState || {});
  }
}

// -------------------------------------------------------------------------
// MAIN LOOP
// -------------------------------------------------------------------------
let lastTime = performance.now();

function loop(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  if (game.phase === STATE.PLAY) {
    update(dt);
    render();
  } else if (game.phase === STATE.TITLE) {
    // Idle ambient render behind the title screen
    playerA.render({
      beacons: [], ghostAngle: NaN, ghostDist: Infinity,
      tension: 0.2, heartPulse: 0.3 + 0.3 * Math.sin(now * 0.003),
      spectrum: null,
    });
  } else {
    // WIN / LOSE — keep last frame visible but no further updates
    render();
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame((t) => { lastTime = t; loop(t); });