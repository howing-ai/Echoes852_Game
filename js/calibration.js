// =====================================================================
// Echoes of Hong Kong — Spatial Calibration & Remapping System
//
// MATHEMATICAL FRAMEWORK — 2D polar perception mapping
// ---------------------------------------------------------------------
// The listener L sits at the origin, facing pad-up ("front").
// A sound source S has TRUE polar coordinates relative to L:
//     r_a = ‖S − L‖                     (radial distance, map units)
//     θ_a = atan2(S_right, S_front)     (azimuth; 0 = dead ahead,
//                                        + = clockwise toward RIGHT,
//                                        wrapped to (−π, π])
//
// The listener PERCEIVES the source at (r_p, θ_p) — measured by where
// they click on the polar pad. Perception is modelled as an affine map
// of the true coordinates:
//     θ_p = k_θ · θ_a + b_θ             (pan gain + pan bias)
//     r_p = k_r · r_a + b_r             (distance gain + distance bias)
// k = 1, b = 0  →  veridical perception.
//
// ERROR METRICS (per trial i):
//     Δθ_i = wrap(θ_p − θ_a)            signed azimuth error [rad]
//     Δr_i = r_p − r_a                  signed radial error [units]
//     E_i  = ‖p_p − p_a‖ / D_max       normalized positional deviation
//                                       (0 = perfect; 1 = off by a full
//                                       pad radius; dimensionless)
//
// AGGREGATES over N trials:
//     meanΔθ = Σ Δθ_i / N               systematic left/right bias
//     E_rms  = √( Σ E_i² / N )          overall deviation (RMS)
//     σ_θp   = stdev(θ_p)               ≈ 0 → mono output suspected
//     σ_θa   = stdev(θ_a)               sanity: trials were spread out
//
// DIAGNOSIS RULES (thresholds):
//     E_rms ≤ 0.20  and  |meanΔθ| ≤ 22°       → CALIBRATED (pass)
//     > 60% of front-hemisphere sources land on the WRONG side of the
//     midline, or mean|Δθ| > 120°             → channels REVERSED
//       (no auto-flip is applied — a negative pan gain is destructive if
//        the true cause is HRTF front/back confusion. The user is told
//        to check their headphones; safe gain/bias fits still apply.)
//     σ_θp < 8°  with σ_θa > 30°              → MONO output
//     otherwise                               → CHECK HEADPHONES
// REVERSED detection uses a SIGN-FLIP rule (perceived and actual on
// opposite sides of the midline) rather than Δθ magnitude: at θ = ±90°
// a mirrored perception yields Δθ = ±180°, which the wrap seam would
// swallow. The azimuth fit uses front-hemisphere trials (|θ_a| ≤ 110°)
// with the perceived angle expressed as θ_a + Δθ (seam-free for the
// non-mirrored cases the fit is meant to correct).
//
// CORRECTION — the inverse map, applied at RENDER time:
//     θ_render = wrap( (θ_true − b_θ) / k_θ )
//     r_render = max(0.3, (r_true − b_r) / k_r )
// Feeding the renderer the pre-compensated position makes the perceived
// position coincide with the true position. Gains are least-squares
// fitted from the trials and clamped to [0.5, 2] (or [−2, −0.5], which
// un-mirrors reversed stereo channels) for numerical stability.
//
// MIN/MAX SOUND VALUE REMAP (user-adjustable loudness envelope):
//     gain(d) = v_max · (v_min / v_max) ^ clamp((d − d_near)/(d_far − d_near))
// v_min = loudness floor at far range, v_max = ceiling at near range.
// Defaults 1.0 / 1.0 are neutral. Persisted alongside the polar fit.
// =====================================================================

export const CAL = Object.freeze({
  D_MAX:      16,     // pad radius in map units
  R_MIN:       4,     // trial distance range ...
  R_MAX:      13,     // ... (keeps sources clearly inside the pad)
  TRIALS:      6,
  ANG_WARN: 22 * Math.PI / 180,   // |meanΔθ| threshold (rad)
  RMS_WARN: 0.20,                 // normalized E_rms threshold
  REV_WARN: 120 * Math.PI / 180,  // mean|Δθ| → reversed channels
  MONO_SD:   8 * Math.PI / 180,   // σ_θp below → mono suspected
  SPREAD_SD: 30 * Math.PI / 180,  // σ_θa above → trials were spread
  K_CLAMP: [0.5, 2.0],            // |k| clamp for the affine gains
  R_FLOOR:  0.3,                  // rendered radius floor [units]
  D_NEAR:   2,                    // loudness envelope anchors ...
  D_FAR:   32,                    // ... (map units)
  STORE_KEY: 'echoes852_calibration',
});

export const DEFAULT_CAL = Object.freeze({
  kT: 1, bT: 0,   // azimuth:  perceived = kT·true + bT
  kR: 1, bR: 0,   // radius:   perceived = kR·true + bR
  vMin: 1, vMax: 1,   // loudness floor / ceiling multipliers
});

// -------------------------------------------------------------------------
// Pure math — exported for unit testing
// -------------------------------------------------------------------------

/** Wrap an angle to (−π, π]. */
export function wrap(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Per-trial error between the true source position and the perceived one.
 * Both positions are pad-relative cartesians: x = right, y = front.
 * @returns {{dTheta:number, dR:number, E:number}} E is normalized 0..~1.4
 */
export function trialError(actual, perceived) {
  const dTheta = wrap(perceived.theta - actual.theta);
  const dR     = perceived.r - actual.r;
  const ax = actual.r * Math.sin(actual.theta),     ay = actual.r * Math.cos(actual.theta);
  const px = perceived.r * Math.sin(perceived.theta), py = perceived.r * Math.cos(perceived.theta);
  const E = Math.hypot(px - ax, py - ay) / CAL.D_MAX;
  return { dTheta, dR, E };
}

/**
 * Least-squares affine fit  y = k·x + b  over sample pairs.
 * Degenerate (zero variance) input returns the identity k=1, b=0.
 */
export function fitAffine(xs, ys) {
  const n = xs.length;
  if (n < 2) return { k: 1, b: 0 };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i++) {
    cov  += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) * (xs[i] - mx);
  }
  if (varx < 1e-9) return { k: 1, b: 0 };
  const k = cov / varx;
  return { k, b: my - k * mx };
}

const stdev = (arr, mean) =>
  Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);

/**
 * Aggregate the trial results into a diagnosis + fitted correction.
 * @param {Array<{actual:{theta,r}, perceived:{theta,r}}>} trials
 */
export function aggregate(trials) {
  const errs = trials.map(t => trialError(t.actual, t.perceived));
  const thA = trials.map(t => t.actual.theta);
  const thP = trials.map(t => t.perceived.theta);
  const rA  = trials.map(t => t.actual.r);
  const rP  = trials.map(t => t.perceived.r);

  const meanDTheta = errs.reduce((s, e) => s + e.dTheta, 0) / errs.length;
  const meanAbsDTh = errs.reduce((s, e) => s + Math.abs(e.dTheta), 0) / errs.length;
  const rmsE       = Math.sqrt(errs.reduce((s, e) => s + e.E * e.E, 0) / errs.length);
  const sdThetaP   = stdev(thP, thP.reduce((s, v) => s + v, 0) / thP.length);
  const sdThetaA   = stdev(thA, thA.reduce((s, v) => s + v, 0) / thA.length);

  // ---- Azimuth fit: front-hemisphere trials only, seam-free unwrap ----
  // Rear angles are wrap-ambiguous (a click 150° "left" is indistinguishable
  // from 210° "right" mirrored), so the regression restricts to |θ_a| ≤ 110°.
  // 110° covers the ±12° jitter of the ±90° sectors (up to ±102°) while
  // staying clear of the rear sectors (|θ| ≥ 123° after jitter). The
  // shuffled 8-sector design guarantees ≥ 3 front trials.
  const FRONT = 110 * Math.PI / 180;
  let fitTrials = trials.filter(t => Math.abs(t.actual.theta) <= FRONT);
  if (fitTrials.length < 3) fitTrials = trials;
  const xsT = fitTrials.map(t => t.actual.theta);
  // θ_pU = θ_a + Δθ  — continuous in θ_a, no ±180° discontinuities
  const ysT = fitTrials.map(t => t.actual.theta + wrap(t.perceived.theta - t.actual.theta));
  const fT  = fitAffine(xsT, ysT);   // θ_pU = kT·θ_a + bT

  // ---- Mirror (reversed channels) detection: sign-flip rule ----
  // A mirrored listener places sources on the WRONG side of the midline.
  // Sign comparison is robust at ±90°, where Δθ = ±180° would be
  // swallowed by the wrap seam. A 60% majority suppresses one-off slips.
  const SIDE = 15 * Math.PI / 180;
  const front = trials.filter(t => Math.abs(t.actual.theta) <= FRONT);
  const crossers = front.filter(t =>
    Math.sign(t.perceived.theta) !== Math.sign(t.actual.theta) &&
    Math.abs(t.actual.theta) > SIDE &&
    Math.abs(t.perceived.theta) > SIDE).length;
  const mirrored =
    (front.length >= 3 && crossers / front.length > 0.6) ||
    meanAbsDTh > CAL.REV_WARN;

  // ---- Radial fit (no wrap involved — all trials used) ----
  const fR = fitAffine(rA, rP);     // r_p = kR·r_a + bR

  const clampK = k => {
    const a = Math.abs(k);
    if (a < CAL.K_CLAMP[0]) return 1;        // too weak to be meaningful
    const clamped = Math.min(a, CAL.K_CLAMP[1]);
    return Math.sign(k) * clamped;
  };

  // ---- Diagnosis ----
  let verdict = 'PASS';
  let correction = { kT: clampK(fT.k), bT: wrap(fT.b), kR: clampK(fR.k), bR: fR.b };
  if (mirrored) {
    verdict = 'REVERSED';
    // NO auto-flip: a negative pan gain is destructive if the real cause
    // is HRTF front/back confusion rather than swapped channels. Warn the
    // user to fix the hardware; keep the (safe) radial correction.
    correction = { kT: 1, bT: 0, kR: correction.kR, bR: correction.bR };
  }
  else if (sdThetaP < CAL.MONO_SD && sdThetaA > CAL.SPREAD_SD) verdict = 'MONO';
  else if (rmsE > CAL.RMS_WARN || Math.abs(meanDTheta) > CAL.ANG_WARN) verdict = 'CHECK';

  return {
    n: trials.length,
    meanDTheta, meanAbsDTh, rmsE, sdThetaP, sdThetaA,
    meanDThetaDeg: meanDTheta * 180 / Math.PI,
    verdict,
    correction,
  };
}

/**
 * Apply the inverse (correction) map to a true polar position.
 * The corrected azimuth SATURATES at ±180° rather than wrapping: a
 * strongly compressed perception (k < 1) may demand a rendered angle
 * beyond the expressible range, and wrapping would land the source on
 * the WRONG side — saturation keeps it on the correct side.
 */
export function remapPolar(theta, r, cal) {
  const c = { ...DEFAULT_CAL, ...cal };
  const th = (theta - c.bT) / c.kT;
  return {
    theta: Math.max(-Math.PI, Math.min(Math.PI, th)),
    r: Math.max(CAL.R_FLOOR, (r - c.bR) / c.kR),
  };
}

/**
 * Loudness envelope from the user's min/max remap.
 * gain(d): v_max at d ≤ D_NEAR, geometric decay to v_min at d ≥ D_FAR.
 */
export function loudnessAt(dist, cal) {
  const c = { ...DEFAULT_CAL, ...cal };
  const t = Math.max(0, Math.min(1, (dist - CAL.D_NEAR) / (CAL.D_FAR - CAL.D_NEAR)));
  if (c.vMin <= 0.0001) return 0;
  return c.vMax * Math.pow(c.vMin / c.vMax, t);
}

// -------------------------------------------------------------------------
// Persistence
// -------------------------------------------------------------------------

export function saveCal(cal) {
  try {
    localStorage.setItem(CAL.STORE_KEY, JSON.stringify({ ...cal, t: Date.now() }));
  } catch { /* storage unavailable — calibration is per-session only */ }
}

export function loadCal() {
  try {
    const raw = localStorage.getItem(CAL.STORE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    const num = v => (Number.isFinite(v) ? v : null);
    const out = {
      kT: num(c.kT) ?? 1,  bT: num(c.bT) ?? 0,
      kR: num(c.kR) ?? 1,  bR: num(c.bR) ?? 0,
      vMin: num(c.vMin) ?? 1, vMax: num(c.vMax) ?? 1,
    };
    return out;
  } catch { return null; }
}

export function clearCal() {
  try { localStorage.removeItem(CAL.STORE_KEY); } catch { /* noop */ }
}

// -------------------------------------------------------------------------
// CalibrationSession — drives the interactive polar pad
// -------------------------------------------------------------------------

export class CalibrationSession {
  /**
   * @param {{canvas:HTMLCanvasElement, audio:object,
   *          onTrial:Function, onFinish:Function, onTrialStart:Function}} opts
   * onTrial(trial, errs)        — after each click (for pad redraw)
   * onTrialStart(trial, idx)    — a new ping was fired
   * onFinish(result)            — aggregate() result after the last trial
   */
  constructor({ canvas, audio, onTrial, onFinish, onTrialStart }) {
    this.canvas  = canvas;
    this.audio   = audio;
    this.onTrial = onTrial;
    this.onFinish = onFinish;
    this.onTrialStart = onTrialStart;

    this.trials  = [];
    this.current = null;
    this.idx     = -1;
    this.done    = false;
    this._clickHandler = (e) => this._click(e);

    canvas.addEventListener('click', this._clickHandler);
  }

  get active() { return !!this.current && !this.done; }

  /** Begin (or restart) the trial sequence. */
  start() {
    this.trials = [];
    this.done   = false;
    this.idx    = -1;

    // 8 sectors, shuffled, ±12° jitter — guarantees angular coverage.
    this._sectors = [0, 1, 2, 3, 4, 5, 6, 7]
      .sort(() => Math.random() - 0.5)
      .slice(0, CAL.TRIALS);

    // Calibration runs in a private acoustic space: listener at the
    // pad centre, facing pad-up. Game mix is muted by the caller.
    this.audio.setCalListener?.(0, 0, Math.PI / 2);

    this._next();
  }

  _next() {
    this.idx++;
    if (this.idx >= CAL.TRIALS) { this._finish(); return; }

    const theta = this._sectors[this.idx] * Math.PI / 4
                + (Math.random() - 0.5) * (24 * Math.PI / 180);
    const r = CAL.R_MIN + Math.random() * (CAL.R_MAX - CAL.R_MIN);

    this.current = {
      idx: this.idx,
      actual:   { theta: wrap(theta), r },
      perceived: null, errs: null,
    };

    // Two pings, 700ms apart — one may be missed in a noisy room.
    this._ping();
    setTimeout(() => { if (this.active) this._ping(); }, 700);
    this.onTrialStart?.(this.current, this.idx);
  }

  _ping() {
    // Pad frame: x = right, y = front. Audio frame (listener yaw = π/2,
    // forward = +z, right = −x): source offset = (−x, 0, +y).
    const a = this.current.actual;
    const dx = a.r * Math.sin(a.theta);   // right
    const dy = a.r * Math.cos(a.theta);   // front
    this.audio.playCalibrationPing?.(-dx, dy);
  }

  /** SPACE replays the current ping without scoring. */
  replay() {
    if (this.active) { this._ping(); setTimeout(() => { if (this.active) this._ping(); }, 700); }
  }

  _click(e) {
    if (!this.active) return;
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(this.canvas.width, this.canvas.height);
    const R = scale / 2 - 34;   // pad radius in canvas px

    const cxp = e.clientX - rect.left - rect.width  / 2;
    const cyp = e.clientY - rect.top  - rect.height / 2;
    const dx = (cxp / R) * CAL.D_MAX;               // right  [+]
    const dy = (-(cyp / R)) * CAL.D_MAX;            // front  [+]

    this.current.perceived = {
      theta: wrap(Math.atan2(dx, dy)),
      r: Math.min(CAL.D_MAX, Math.hypot(dx, dy)),
    };
    this.current.errs = trialError(this.current.actual, this.current.perceived);
    this.trials.push(this.current);

    this.onTrial?.(this.current, this.current.errs);

    if (this.idx + 1 >= CAL.TRIALS) this._finish();
    else setTimeout(() => { if (!this.done) this._next(); }, 1400);
  }

  _finish() {
    this.done = true;
    this.current = null;
    const result = aggregate(this.trials);
    this.onFinish?.(result);
  }

  destroy() {
    this.canvas.removeEventListener('click', this._clickHandler);
  }
}
