// =====================================================================
// Echoes of Hong Kong — Dual Player Perspectives (SYMBIOTIC)
//
//   PlayerB : first-person drifter. Eyes only — their tab is DEAF.
//   PlayerA : sensor terminal. No map. Pure atmosphere: directional
//             light/shadow gradients + live spectrum of what A hears.
//             A literally listens through B's ears (see audio.js).
// =====================================================================

// -------------------------------------------------------------------------
// PLAYER B — FIRST-PERSON DRIFTER (the eyes)
// -------------------------------------------------------------------------
export class PlayerB {
  /**
   * @param {GameMap} map
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {HTMLElement} [opts.captureOverlay]   Click-to-capture prompt
   * @param {HTMLElement} [opts.syncStatus]       Link-status line in overlay
   */
  constructor(map, opts) {
    // Back-compat: allow PlayerB(map, canvas)
    if (opts instanceof HTMLCanvasElement) {
      opts = { canvas: opts };
    }
    this.map     = map;
    this.canvas  = opts.canvas;
    this.ctx     = this.canvas.getContext('2d');
    this.captureOverlay = opts.captureOverlay || null;
    this.syncStatus     = opts.syncStatus     || null;

    this.x     = map.playerSpawn.x + 0.5;
    this.y     = map.playerSpawn.y + 0.5;
    this.yaw   = 0;     // 0 = facing +X (east); grows counter-clockwise
    this.pitch = 0;
    this.fov   = Math.PI / 3;   // 60°

    this.speedWalk   = 3.8;
    this.speedSprint = 6.2;
    this.turnSpeed   = 1.8;

    // ---- Collision ----
    // Half-extent of the player's collision circle (in map units).
    this.radius = 0.28;

    this.keys          = {};
    this.pointerLocked = false;
    this.isMoving      = false;

    this._bind();
    this._renderCaptureOverlay();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup',   (e) => { this.keys[e.code] = false; });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = (document.pointerLockElement === this.canvas);
      this._renderCaptureOverlay();
    });

    document.addEventListener('pointerlockerror', () => {
      if (this.syncStatus) {
        this.syncStatus.textContent = 'pointer-lock denied — click again to retry';
        this.syncStatus.className   = 'cap-sync error';
      }
      if (this.captureOverlay) this.captureOverlay.classList.remove('hidden');
    });

    const requestLock = () => {
      if (!this.pointerLocked) {
        this.canvas.requestPointerLock?.();
      }
    };
    this.canvas.addEventListener('click', requestLock);
    if (this.captureOverlay) {
      this.captureOverlay.addEventListener('click', requestLock);
    }

    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.yaw   += e.movementX * 0.0025;
      this.pitch += e.movementY * 0.0022;
      this.pitch = Math.max(-0.9, Math.min(0.9, this.pitch));
    });
  }

  _renderCaptureOverlay() {
    if (!this.captureOverlay) return;
    this.captureOverlay.classList.toggle('hidden', this.pointerLocked);
  }

  // -----------------------------------------------------------------------
  // Collision: circle-vs-grid. 8 sample points around (cx,cy) at the
  // collision radius. X and Y tested independently -> wall sliding.
  // -----------------------------------------------------------------------
  _collidesAt(cx, cy, r = this.radius) {
    const samples = [
      [cx + r, cy    ], [cx - r, cy    ],
      [cx    , cy + r], [cx    , cy - r],
      [cx + r, cy + r], [cx + r, cy - r],
      [cx - r, cy + r], [cx - r, cy - r],
    ];
    for (let i = 0; i < samples.length; i++) {
      if (this.map.isWall(samples[i][0], samples[i][1])) return true;
    }
    return false;
  }

  _unstick() {
    if (!this._collidesAt(this.x, this.y, this.radius * 0.5)) return;
    const tries = [
      [ this.radius, 0], [-this.radius, 0],
      [0,  this.radius], [0, -this.radius],
      [ this.radius,  this.radius], [-this.radius,  this.radius],
      [ this.radius, -this.radius], [-this.radius, -this.radius],
    ];
    for (const [dx, dy] of tries) {
      if (!this._collidesAt(this.x + dx, this.y + dy, this.radius)) {
        this.x += dx;
        this.y += dy;
        return;
      }
    }
    this.x = this.map.playerSpawn.x + 0.5;
    this.y = this.map.playerSpawn.y + 0.5;
    this.yaw = 0;
  }

  update(dt) {
    this._unstick();

    let mx = 0, my = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp'])    my += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  my -= 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  mx -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) mx += 1;

    const sprint = !!this.keys['ShiftLeft'] || !!this.keys['ShiftRight'];
    const speed  = sprint ? this.speedSprint : this.speedWalk;

    this.isMoving = (mx !== 0 || my !== 0);

    if (this.isMoving) {
      const len = Math.hypot(mx, my);
      mx /= len; my /= len;

      const fx = Math.cos(this.yaw);
      const fy = Math.sin(this.yaw);
      const rx = -Math.sin(this.yaw);
      const ry =  Math.cos(this.yaw);

      // world velocity = forward * (W/S input) + right * (A/D input)
      const wx = (my * fx + mx * rx);
      const wy = (my * fy + mx * ry);

      const dxStep = wx * speed * dt;
      const dyStep = wy * speed * dt;

      // Axis-separated collision — slide along walls
      const tryX = this.x + dxStep;
      if (!this._collidesAt(tryX, this.y)) this.x = tryX;
      const tryY = this.y + dyStep;
      if (!this._collidesAt(this.x, tryY)) this.y = tryY;
    }
  }

  // -------------------------------------------------------------------
  // First-person raycasting renderer
  // -------------------------------------------------------------------
  render() {
    const canvas = this.canvas;
    const ctx    = this.ctx;
    const w = canvas.width  = canvas.clientWidth;
    const h = canvas.height = canvas.clientHeight;

    // ---- Sky / Ceiling ----
    const sky = ctx.createLinearGradient(0, 0, 0, h / 2);
    sky.addColorStop(0, '#02050a');
    sky.addColorStop(1, '#0c1418');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h / 2);

    // ---- Floor ----
    const floor = ctx.createLinearGradient(0, h / 2, 0, h);
    floor.addColorStop(0, '#0a0606');
    floor.addColorStop(1, '#1c0d04');
    ctx.fillStyle = floor;
    ctx.fillRect(0, h / 2, w, h / 2);

    // ---- Walls via raycasting ----
    const numRays = Math.min(w, 280);
    const colW    = w / numRays;
    const halfFov = this.fov / 2;

    for (let i = 0; i < numRays; i++) {
      const cameraX = 2 * (i / numRays) - 1;
      const rayAngle = this.yaw + Math.atan(cameraX * Math.tan(halfFov));
      const hit = this.map.castRay(this.x, this.y, Math.cos(rayAngle), Math.sin(rayAngle));
      if (!isFinite(hit.distance)) continue;

      const perpDist = hit.distance * Math.cos(rayAngle - this.yaw);
      const lineH    = Math.min(h, h / Math.max(0.05, perpDist));
      const top      = (h - lineH) / 2 - this.pitch * lineH * 0.25;

      const t = Math.min(1, perpDist / 14);
      const r = Math.floor(10 + (1 - t) * 50);
      const g = Math.floor(70 + (1 - t) * 150);
      const b = Math.floor(40 + (1 - t) * 70);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(i * colW, top, Math.ceil(colW) + 1, lineH);

      ctx.strokeStyle = `rgba(154,240,160,${0.30 + (1 - t) * 0.45})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(i * colW, top);
      ctx.lineTo(i * colW, top + lineH);
      ctx.stroke();
    }

    // ---- Floor wireframe scanlines for atmosphere ----
    ctx.strokeStyle = 'rgba(154,240,160,0.05)';
    ctx.lineWidth = 1;
    for (let y = h / 2; y < h; y += 6) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }
}

// -------------------------------------------------------------------------
// PLAYER A — SENSOR TERMINAL (the ears)
//   No map. An atmospheric directional readout:
//     * Compass ring locked to Player B's facing (F/R/B/L)
//     * Beacon arcs (amber) + ghost shadow (red) around the ring
//     * Light/shadow gradients that breathe with the heartbeat
//     * Live audio spectrum of exactly what Player A is hearing
// -------------------------------------------------------------------------
export class PlayerA {
  constructor(map, canvas) {
    this.map     = map;
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');

    // Beacon bookkeeping (shared API with main.js)
    this.beacons          = map.beacons.map(b => ({ ...b, collected: false }));
    this.activeBeaconIdx  = 0;

    this._beaconFlash = 0;   // brief flash when a beacon is collected
  }

  // External mutator so main.js can hook broadcast logic via a wrapper.
  setActiveBeaconIdx(idx) {
    if (idx >= 0 && idx < this.beacons.length) this.activeBeaconIdx = idx;
  }

  // -------------------------------------------------------------------
  // render(state)
  //   state.beacons      : [{ angle, dist, active, collected }]  relative to B
  //   state.ghostAngle   : radians relative to B's facing (-PI..PI)
  //   state.ghostDist    : map units
  //   state.tension      : 0..1
  //   state.heartPulse   : 0..1 heartbeat pulse
  //   state.spectrum     : Uint8Array or null
  // -------------------------------------------------------------------
  render(state) {
    const ctx = this.ctx;
    const w = this.canvas.width  = this.canvas.clientWidth;
    const h = this.canvas.height = this.canvas.clientHeight;
    const cx = w / 2;
    const cy = h * 0.42;
    const R  = Math.min(w, h) * 0.30;

    const tension    = state.tension    ?? 0;
    const heartPulse = state.heartPulse ?? 0;
    const ghostDist  = state.ghostDist  ?? Infinity;
    const ghostNear  = isFinite(ghostDist) ? Math.max(0, 1 - ghostDist / 22) : 0;

    if (this._beaconFlash > 0) this._beaconFlash = Math.max(0, this._beaconFlash - 0.02);

    // ---- Deep void: a red tide rises with danger ----
    const dread = Math.max(ghostNear, tension * 0.35);
    const bg = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, Math.max(w, h) * 0.75);
    bg.addColorStop(0, `rgba(${Math.floor(14 + dread * 60)}, 6, 8, 1)`);
    bg.addColorStop(1, '#010203');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // ---- Heartbeat: the terminal's edges bleed red with each pulse ----
    const edge = heartPulse * (0.10 + ghostNear * 0.55);
    if (edge > 0.01) {
      const vg = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.30, cx, cy, Math.max(w, h) * 0.72);
      vg.addColorStop(0, 'rgba(255,59,107,0)');
      vg.addColorStop(1, `rgba(255,59,107,${Math.min(0.8, edge).toFixed(3)})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    }

    // ---- Ghost shadow: red wedge seeping in from the ghost's direction ----
    if (isFinite(state.ghostAngle) && ghostNear > 0.02) {
      const wedge = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, Math.max(w, h));
      wedge.addColorStop(0, 'rgba(255,59,107,0)');
      wedge.addColorStop(1, `rgba(255,59,107,${0.12 + ghostNear * 0.35})`);
      // rel angle 0 = B's forward -> screen up. Canvas arc angles start at +X.
      const toCanvas = (rel) => rel - Math.PI / 2;
      const spread = 0.5 + ghostNear * 0.8;   // widens as it closes in
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, Math.max(w, h), toCanvas(state.ghostAngle - spread), toCanvas(state.ghostAngle + spread));
      ctx.closePath();
      ctx.fillStyle = wedge;
      ctx.fill();
      ctx.restore();
    }

    // ---- Compass ring (locked to B's facing: 0 = B's forward = up) ----
    const ringAlpha = 0.35 + heartPulse * 0.4;
    ctx.strokeStyle = `rgba(154,240,160,${ringAlpha})`;
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = '#9af0a0';
    ctx.shadowBlur  = 6 + heartPulse * 14;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Ticks every 15°, majors every 90°
    for (let deg = 0; deg < 360; deg += 15) {
      const rel = (deg * Math.PI) / 180;
      const major = (deg % 90 === 0);
      const inner = R - (major ? 12 : 5);
      const px1 = cx + Math.sin(rel) * inner;
      const py1 = cy - Math.cos(rel) * inner;
      const px2 = cx + Math.sin(rel) * (R - 2);
      const py2 = cy - Math.cos(rel) * (R - 2);
      ctx.strokeStyle = `rgba(154,240,160,${major ? 0.7 : 0.25})`;
      ctx.lineWidth   = major ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(px1, py1);
      ctx.lineTo(px2, py2);
      ctx.stroke();
    }

    // Body-relative labels: F(ront), R(ight), B(ack), L(eft)
    ctx.font = '11px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(154,240,160,0.55)';
    ctx.fillText('F', cx, cy - R - 10);
    ctx.fillText('R', cx + R + 12, cy + 4);
    ctx.fillText('B', cx, cy + R + 16);
    ctx.fillText('L', cx - R - 12, cy + 4);

    // ---- Echo channels on the dial: numbered dots, the tuned one glows ----
    const now = performance.now() * 0.002;
    (state.beacons || []).forEach((b, i) => {
      if (!isFinite(b.angle)) return;
      const bx = cx + Math.sin(b.angle) * R;
      const by = cy - Math.cos(b.angle) * R;
      const pulse = 0.5 + 0.5 * Math.sin(now * 1.6 + i * 1.3);

      if (b.collected) {
        ctx.fillStyle = 'rgba(255,184,75,0.15)';
        ctx.beginPath();
        ctx.arc(bx, by, 1.6, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      const alpha = b.active ? 0.95 : 0.38;
      const size  = b.active ? 4.5 : 2.5;

      ctx.shadowColor = '#ffb84b';
      ctx.shadowBlur  = b.active ? 10 + pulse * 8 : 3;
      ctx.fillStyle   = `rgba(255,184,75,${alpha})`;
      ctx.beginPath();
      ctx.arc(bx, by, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // channel numeral — the only number on the dial
      ctx.fillStyle = b.active ? 'rgba(255,184,75,0.95)' : 'rgba(255,184,75,0.30)';
      ctx.font = b.active ? 'bold 12px "Courier New", monospace' : '10px "Courier New", monospace';
      ctx.fillText(String(i + 1), bx, by - 11);

      if (b.active) {
        ctx.strokeStyle = `rgba(255,184,75,${0.35 + pulse * 0.35})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(bx, by, 9 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // ---- Ghost marker on the ring ----
    if (isFinite(state.ghostAngle)) {
      const gx = cx + Math.sin(state.ghostAngle) * R;
      const gy = cy - Math.cos(state.ghostAngle) * R;
      const wob = 1 + 0.25 * Math.sin(now * 4);

      ctx.shadowColor = '#ff3b6b';
      ctx.shadowBlur  = 8 + ghostNear * 18;
      ctx.fillStyle   = `rgba(255,59,107,${0.5 + ghostNear * 0.5})`;
      ctx.beginPath();
      ctx.arc(gx, gy, 5 * wob, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (ghostNear > 0.3) {
        ctx.strokeStyle = `rgba(255,59,107,${(ghostNear - 0.3) * 1.4})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(gx, gy, 10 + ghostNear * 10 + Math.sin(now * 5) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ---- Center: which echo the dial is tuned to (no bearings, no units) ----
    const activeB = (state.beacons || []).find(b => b.active && !b.collected);
    ctx.textAlign = 'center';
    if (activeB) {
      const i = state.beacons.indexOf(activeB);
      ctx.fillStyle = 'rgba(255,184,75,0.9)';
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillText(`ECHO ${i + 1}`, cx, cy - 4);
    } else {
      ctx.fillStyle = 'rgba(154,240,160,0.55)';
      ctx.font = 'bold 14px "Courier New", monospace';
      ctx.fillText('SIGNAL CLEAR', cx, cy - 4);
    }

    // ---- Live spectrum: what Player A is hearing right now ----
    if (state.spectrum && state.spectrum.length) {
      const barCount = 48;
      const spectrumW = Math.min(w * 0.8, 480);
      const barW = spectrumW / barCount;
      const sx = cx - spectrumW / 2;
      const sy = h - 46;
      const maxBarH = 34;
      const step = Math.max(1, Math.floor(state.spectrum.length / barCount));

      for (let i = 0; i < barCount; i++) {
        const v = state.spectrum[i * step] / 255;
        const bh = Math.max(1, v * maxBarH);
        const cr = Math.floor(90 + v * 165);
        const cg = Math.floor(200 - v * 100);
        ctx.fillStyle = `rgba(${cr},${cg},60,${0.35 + v * 0.6})`;
        ctx.fillRect(sx + i * barW, sy - bh, barW - 1, bh);
      }

      ctx.fillStyle = 'rgba(154,240,160,0.35)';
      ctx.font = '9px "Courier New", monospace';
      ctx.fillText('· SIGNAL ·', cx, sy + 12);
    }
  }

  // -------------------------------------------------------------------
  // Beacon state API (kept compatible with main.js)
  // -------------------------------------------------------------------
  collectBeacon(idx, audio) {
    const i = (idx !== undefined) ? idx : this.activeBeaconIdx;
    if (i < 0 || i >= this.beacons.length || this.beacons[i].collected) return false;
    this.beacons[i].collected = true;
    this._beaconFlash = 1;
    audio?.playCollectChime?.();
    const next = this.beacons.findIndex(b => !b.collected);
    if (next >= 0) this.activeBeaconIdx = next;
    return true;
  }

  beaconCount() { return this.beacons.length; }
  collectedCount() { return this.beacons.filter(b => b.collected).length; }
  getActiveBeacon() { return this.beacons[this.activeBeaconIdx]; }
}