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

// -------------------------------------------------------------------------
// GAME MAP — 24x24 grid, 1 = wall, 0 = open
// Loose homage to Hong Kong alleys: tight corridors, plazas, dead ends.
// -------------------------------------------------------------------------
class GameMap {
  constructor() {
    this.width  = 24;
    this.height = 24;

    const raw = [
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
    ];

    this.grid = raw.map(row => row.split('').map(Number));

    this.playerSpawn = { x: 1.5, y: 1.5 };
    this.ghostSpawn  = { x: 22.5, y: 22.5 };

    // Beacons Player B must absorb (mirrored into the map + audio)
    this.beacons = [
      { x:  6, y:  6 },   // B1
      { x: 17, y:  3 },   // B2
      { x:  3, y: 14 },   // B3
      { x: 18, y: 13 },   // B4
      { x: 11, y: 21 },   // B5
    ];

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
const syncStatus     = document.getElementById('sync-status');

const proxBar      = document.getElementById('proximity-bar');
const proxVal      = document.getElementById('proximity-val');
const aggrBar      = document.getElementById('aggression-bar');
const aggrVal      = document.getElementById('aggression-val');
const beaconBar    = document.getElementById('beacon-bar');
const beaconVal    = document.getElementById('beacon-val');

const map         = new GameMap();
const playerB     = new PlayerB(map, {
  canvas:         document.getElementById('fp-canvas'),
  captureOverlay: captureOverlay,
  syncStatus:     syncStatus,
});
const playerA     = new PlayerA(map, document.getElementById('map-canvas'));
const ghost       = new Ghost(map, map.ghostSpawn);
const audio       = new SpatialAudio();

document.getElementById('role-a-btn').addEventListener('click', () => selectRole('A'));
document.getElementById('role-b-btn').addEventListener('click', () => selectRole('B'));

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
  tension:        0,
  ghostProximity: 0,
  ghostX:         ghost.x,
  ghostY:         ghost.y,
  playerX:        playerB.x,
  playerY:        playerB.y,
  playerYaw:      playerB.yaw,
  aState:         null,   // render payload for A's sensor terminal
};

// -------------------------------------------------------------------------
// CROSS-TAB SYNC (BroadcastChannel — same-origin tabs only)
//   Player B tab is the primary simulation source.
//   Player A tab receives state and renders.
//   When only one tab is open, that tab runs standalone.
// -------------------------------------------------------------------------
let channel       = null;
let remotePresent = false;
let remotePlayerB = false;     // has another tab taken role B?
let remoteRole    = null;

try {
  channel = new BroadcastChannel('echoes852-sync');
  channel.onmessage = (e) => onChannelMessage(e.data);
  // Announce our presence
  setTimeout(() => channel?.postMessage({ type: 'hello', role: game.role }), 50);
} catch (err) {
  console.warn('[sync] BroadcastChannel unavailable — running standalone', err);
}

function onChannelMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'hello': {
      // Another tab is asking who's around; reply if we already picked a role
      if (game.role) {
        channel?.postMessage({ type: 'present', role: game.role });
      }
      break;
    }
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
    case 'b-state': {
      if (game.role === 'A') {
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
  }
}

function updateSyncStatus() {
  if (!syncStatus) return;
  if (!remotePresent) {
    syncStatus.textContent = 'standalone session';
    syncStatus.className   = 'cap-sync';
  } else {
    syncStatus.textContent = `linked to role ${remoteRole}`;
    syncStatus.className   = 'cap-sync linked';
  }
}

// -------------------------------------------------------------------------
// ROLE SELECTION
// -------------------------------------------------------------------------
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
  //   Player B is the eyes  -> B's tab NEVER initialises audio.
  //                            B is completely deaf in-game.
  if (r === 'A') {
    audio.init();
    audio.resume();
  }

  // Tell the channel we joined and who we are.
  channel?.postMessage({ type: 'present', role: r });
  setTimeout(() => channel?.postMessage({ type: 'present', role: r }), 100);
  updateSyncStatus();

  game.phase = STATE.PLAY;
}

window.addEventListener('keydown', (e) => {
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
        if (ok) channel?.postMessage({ type: 'b-beacon-collected', idx });
      }
    }
  }
  // 1-5 — Player A selects which beacon to direct B toward
  if (game.phase === STATE.PLAY && game.role === 'A' && /^Digit[1-5]$/.test(e.code)) {
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
  channel?.postMessage({ type: 'a-lure', x: bx, y: by, idx });
}

const origSetActive = playerA.setActiveBeaconIdx?.bind(playerA);
playerA.setActiveBeaconIdx = function (idx) {
  if (origSetActive) origSetActive(idx);
  else this.activeBeaconIdx = idx;
  if (game.role === 'A') {
    channel?.postMessage({ type: 'a-target', idx });
    if (game.phase === STATE.PLAY) triggerLure(idx);
  }
};

window.addEventListener('resize', () => {
  // canvas sizes auto-update on next frame via clientWidth/Height
});

window.addEventListener('beforeunload', () => {
  channel?.postMessage({ type: 'goodbye' });
});

// -------------------------------------------------------------------------
// UPDATE
// -------------------------------------------------------------------------
function update(dt) {
  // ----- Player B is the primary simulation source (and is DEAF) -----
  if (game.role === 'B') {
    playerB.update(dt);
    ghost.update(dt, playerB.x, playerB.y);

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
    if (channel) {
      const collected = playerA.beacons.map(b => b.collected);
      channel.postMessage({
        type: 'b-state',
        x: playerB.x, y: playerB.y, yaw: playerB.yaw,
        gx: ghost.x, gy: ghost.y, ga: ghost.aggression,
        gs: ghost.state, gsl: ghost.staticLevel,
        gr: ghost.rageTimer > 0,
        isMoving: playerB.isMoving,
        collected,
      });
    }

    updateHUD_B(beaconDist);
  }
  // ----- Player A: the ears. Listens THROUGH Player B via the link. -----
  else if (game.role === 'A') {
    // State values arrive via channel messages ('b-state').
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
      aggression: ghost.aggression,
      tension:    game.tension,
      isMoving:   playerB.isMoving,
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
  game.phase = STATE.PLAY;
  hideEndBanner();
}

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