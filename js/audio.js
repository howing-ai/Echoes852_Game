// =====================================================================
// Echoes of Hong Kong — SpatialAudio (SYMBIOTIC SETUP)
//
//   LISTENER = Player B's ears... worn by Player A.
//   The audio listener is bound 1:1 to Player B's first-person position
//   and camera yaw. When B turns their head in the 3D world, the sound
//   panning shifts left/right for whoever is listening — Player A.
//
//   * Player B's tab never initialises this class  ->  B is deaf.
//   * Player A's tab plays:
//       - Beacon (objective)  : HRTF-panned sine, pitch rises when close
//       - Ghost hum           : HRTF-panned filtered sawtooth (direction!)
//       - Heartbeat           : tension pulse + phase exposed for visuals
//       - Footstep pulse      : so A knows B is moving
//   * AnalyserNode taps the master bus so A's terminal can draw the
//     live spectrum of what A is actually hearing.
//   * Spatial calibration hook: _setSource() warps every source through
//     the inverse perception map fitted by js/calibration.js, so what A
//     hears matches where things truly are.
// =====================================================================

import { DEFAULT_CAL, remapPolar, loudnessAt, wrap } from './calibration.js';

export class SpatialAudio {
  constructor() {
    this.ctx            = null;
    this.master         = null;
    this.analyser       = null;
    this._spectrum      = null;

    this.listener       = null;

    // Listener pose cache (world x, world y→z, yaw) — needed by the
    // spatial remap in _setSource().
    this._lx = 0; this._lz = 0; this._lyaw = 0;

    // Spatial calibration (affine polar remap + loudness envelope)
    this.cal            = { ...DEFAULT_CAL };
    this.calMode        = false;   // true while the calibration pad runs

    // Beacon (objective target)
    // REDESIGNED for a less intrusive character: pure sine carrier (the
    // distance->pitch mechanic and the decoy's "pure sine" tell are core
    // gameplay), plus a soft sub-octave pad and a slow breathing tremolo,
    // at noticeably lower loudness. It now reads as a distant wind-chime
    // hum instead of a constant test tone.
    this.beaconOsc      = null;
    this.beaconSub      = null;   // sine one octave down — warmth
    this.beaconSubGain  = null;
    this.beaconTrem     = null;   // slow LFO depth node — breathing motion
    this.beaconGain     = null;
    this.beaconPanner   = null;
    this.beaconFreqMin  = 300;
    this.beaconFreqMax  = 720;
    this.beaconLoudMax  = 0.34;   // was 0.5 — the old constant hum was fatiguing

    // Ghost proximity hum
    this.ghostOsc       = null;
    this.ghostFilter    = null;
    this.ghostGain      = null;
    this.ghostPanner    = null;

    // Ghost decoy ("the false ear") — mimics a beacon from a false bearing
    this.decoyOsc       = null;   // pure sine carrier (mimics the beacon)
    this.decoySub       = null;   // sub-octave — mimics the beacon's new warmth
    this.decoySubGain   = null;
    this.decoyTrem      = null;   // same tremolo — the mimic must sound identical
    this.decoyDirt      = null;   // faint detuned sawtooth — THE TELL
    this.decoyDirtGain  = null;
    this.decoyGain      = null;
    this.decoyAtmos     = null;
    this.decoyPanner    = null;

    // Sampled assets (js/audioAssets.js) + Rain's sprint breathing
    this.bank           = null;
    this.breathSrc      = null;   // looping CC0 fast-breath sample
    this.breathFilter   = null;
    this.breathGain     = null;

    // Heartbeat
    this.heartbeatTimer  = 0;
    this.heartbeatPeriod = 1.5;
    this.heartbeatPhase  = 0;   // 0..1, exposed for visual pulse

    // Footstep
    this.stepTimer = 0;
  }

  // ------------------------------------------------------------------------
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { console.warn('[audio] Web Audio API not supported'); return; }

    this.ctx  = new AC();
    this.master = this.ctx.createGain();
    // Master gain compensated upward to offset the perceived loudness loss
    // introduced by the 500Hz atmosphere LPF (see _atmosFilter).
    this.master.gain.value = 0.75;
    this.master.connect(this.ctx.destination);

    // ---- Spectrum tap for the sensor terminal ----
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.82;
    this.master.connect(this.analyser);
    this._spectrum = new Uint8Array(this.analyser.frequencyBinCount);

    this.listener = this.ctx.listener;

    // ===== Beacon panner (objective sound source in the world) =====
    // Chain: carrier(s) -> tremolo -> gain -> atmos -> panner -> master.
    // The sub-octave and 0.55Hz tremolo replace the old fatiguing constant
    // tone with a gentle breathing hum; pitch-vs-distance is unchanged.
    this.beaconOsc = this.ctx.createOscillator();
    this.beaconOsc.type = 'sine';
    this.beaconOsc.frequency.value = this.beaconFreqMin;

    this.beaconSub = this.ctx.createOscillator();
    this.beaconSub.type = 'sine';
    this.beaconSub.frequency.value = this.beaconFreqMin / 2;

    this.beaconSubGain = this.ctx.createGain();
    this.beaconSubGain.gain.value = 0.22;

    // Tremolo: gain rides 0.75 ± 0.25 (a breath, not a beep)
    this.beaconTrem = this.ctx.createGain();
    this.beaconTrem.gain.value = 0.75;
    const beaconLfo = this.ctx.createOscillator();
    beaconLfo.frequency.value = 0.55;
    const beaconLfoDepth = this.ctx.createGain();
    beaconLfoDepth.gain.value = 0.25;
    beaconLfo.connect(beaconLfoDepth).connect(this.beaconTrem.gain);
    beaconLfo.start();

    this.beaconGain = this.ctx.createGain();
    this.beaconGain.gain.value = 0;

    this.beaconAtmos = this._atmosFilter();            // 500Hz shared atmosphere LPF

    this.beaconPanner = this.ctx.createPanner();
    this.beaconPanner.panningModel = 'HRTF';
    // Gentle exponential attenuation: A needs enough falloff room to track
    // a source before it goes silent. refDistance 1.5 (no proximity boost),
    // rolloff 0.25 (very gradual), maxDistance 80 (silence beyond).
    this.beaconPanner.distanceModel = 'exponential';
    this.beaconPanner.refDistance = 1.5;
    this.beaconPanner.maxDistance = 80;
    this.beaconPanner.rolloffFactor = 0.25;

    this.beaconOsc.connect(this.beaconTrem);
    this.beaconSub.connect(this.beaconSubGain);
    this.beaconSubGain.connect(this.beaconTrem);
    this.beaconTrem.connect(this.beaconGain);
    this.beaconGain.connect(this.beaconAtmos);         // atmosphere tints BEFORE panner
    this.beaconAtmos.connect(this.beaconPanner);
    this.beaconPanner.connect(this.master);
    this.beaconOsc.start();
    this.beaconSub.start();

    // ===== Ghost hum — NOW SPATIAL (A hears WHERE the ghost is) =====
    this.ghostOsc = this.ctx.createOscillator();
    this.ghostOsc.type = 'sawtooth';
    this.ghostOsc.frequency.value = 70;

    // The ghost already has its OWN mood filter (220-740Hz LFO-modulated).
    // The shared atmosphere LPF on top gives the SAME tonal character as
    // every other source while keeping the ghost's breathing modulation.
    this.ghostFilter = this.ctx.createBiquadFilter();
    this.ghostFilter.type = 'lowpass';
    this.ghostFilter.frequency.value = 320;
    this.ghostFilter.Q.value = 6;

    this.ghostGain = this.ctx.createGain();
    this.ghostGain.gain.value = 0;

    this.ghostAtmos = this._atmosFilter();             // shared atmosphere LPF

    this.ghostPanner = this.ctx.createPanner();
    this.ghostPanner.panningModel = 'HRTF';
    this.ghostPanner.distanceModel = 'exponential';
    this.ghostPanner.refDistance = 1.5;
    this.ghostPanner.maxDistance = 80;
    this.ghostPanner.rolloffFactor = 0.25;

    // LFO gives the filter a breathing, living quality
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.4;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 80;
    lfo.connect(lfoGain).connect(this.ghostFilter.frequency);
    lfo.start();

    this.ghostOsc.connect(this.ghostFilter);
    this.ghostFilter.connect(this.ghostGain);
    this.ghostGain.connect(this.ghostAtmos);           // atmosphere tints before panner
    this.ghostAtmos.connect(this.ghostPanner);
    this.ghostPanner.connect(this.master);
    this.ghostOsc.start();

    // ===== Ghost decoy — the false ear =====
    // Mimics the beacon's NEW timbre exactly (sine carrier + sub-octave +
    // same 0.55Hz tremolo) so the disguise holds. A faint detuned sawtooth
    // rides underneath: real beacons are pure sines, so the trace of
    // harmonics is the spectral tell for a sharp listener.
    this.decoyOsc = this.ctx.createOscillator();
    this.decoyOsc.type = 'sine';
    this.decoyOsc.frequency.value = 440;

    this.decoySub = this.ctx.createOscillator();
    this.decoySub.type = 'sine';
    this.decoySub.frequency.value = 220;
    this.decoySubGain = this.ctx.createGain();
    this.decoySubGain.gain.value = 0.22;

    this.decoyTrem = this.ctx.createGain();
    this.decoyTrem.gain.value = 0.75;
    const decoyLfo = this.ctx.createOscillator();
    decoyLfo.frequency.value = 0.55;
    const decoyLfoDepth = this.ctx.createGain();
    decoyLfoDepth.gain.value = 0.25;
    decoyLfo.connect(decoyLfoDepth).connect(this.decoyTrem.gain);
    decoyLfo.start();

    this.decoyDirt = this.ctx.createOscillator();
    this.decoyDirt.type = 'sawtooth';
    this.decoyDirt.frequency.value = 443;
    this.decoyDirtGain = this.ctx.createGain();
    this.decoyDirtGain.gain.value = 0.05;

    this.decoyGain = this.ctx.createGain();
    this.decoyGain.gain.value = 0;

    this.decoyAtmos  = this._atmosFilter();            // same tint as everything
    this.decoyPanner = this.ctx.createPanner();
    this.decoyPanner.panningModel = 'HRTF';
    this.decoyPanner.distanceModel = 'exponential';
    this.decoyPanner.refDistance = 1.5;
    this.decoyPanner.maxDistance = 80;
    this.decoyPanner.rolloffFactor = 0.25;

    this.decoyOsc.connect(this.decoyTrem);
    this.decoySub.connect(this.decoySubGain);
    this.decoySubGain.connect(this.decoyTrem);
    this.decoyDirt.connect(this.decoyDirtGain);
    this.decoyDirtGain.connect(this.decoyTrem);
    this.decoyTrem.connect(this.decoyGain);
    this.decoyGain.connect(this.decoyAtmos);
    this.decoyAtmos.connect(this.decoyPanner);
    this.decoyPanner.connect(this.master);
    this.decoyOsc.start();
    this.decoySub.start();
    this.decoyDirt.start();
  }

  // ---- Shared low-pass atmosphere filter (500Hz, Q=0.7) -----------------
  // Inserted on every source chain — uniform tonal character.
  // 500Hz cutoff (gentle resonance at Q=0.7) strips the harshness that
  // raw oscillators generate in the 1–4kHz band, leaving a deeper, more
  // atmospheric mix while preserving enough mid-band for HRTF panning
  // cues (ITD still works well below 1.5kHz).
  _atmosFilter() {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500;
    f.Q.value = 0.7;
    return f;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // ------------------------------------------------------------------------
  // attachBank(bank): plug in the decoded CC0 samples (js/audioAssets.js).
  //   'breath' becomes Rain's (Player B's) sprint breathing — a looping
  //   fast-breath sample. Non-spatial and routed around the 500Hz
  //   atmosphere LPF (breaths need the 1-2kHz band to read as breathing);
  //   its own gentle 2.4kHz LPF keeps it soft. It lives in B's body, so it
  //   arrives like the whisper: from inside, at no position.
  //   The footstep sample replaces the old synth pluck in _playFootstep.
  // ------------------------------------------------------------------------
  attachBank(bank) {
    this.bank = bank;
    if (!this.ctx || !bank?.has('breath')) return;

    this.breathSrc = this.ctx.createBufferSource();
    this.breathSrc.buffer = bank.get('breath');
    this.breathSrc.loop = true;

    this.breathFilter = this.ctx.createBiquadFilter();
    this.breathFilter.type = 'lowpass';
    this.breathFilter.frequency.value = 2400;
    this.breathFilter.Q.value = 0.7;

    this.breathGain = this.ctx.createGain();
    this.breathGain.gain.value = 0;

    this.breathSrc.connect(this.breathFilter);
    this.breathFilter.connect(this.breathGain);
    this.breathGain.connect(this.master);
    this.breathSrc.start();
  }

  get ready() { return !!this.ctx; }

  // ------------------------------------------------------------------------
  // Listener = Player B's head. Sound sources live in the world.
  // _setListener(x, y, z, yaw)  — yaw 0 = facing +X, matches game convention
  // ------------------------------------------------------------------------
  _setListener(x, y, z, yaw) {
    if (!this.listener) return;
    // Normalise yaw to (-π, π] BEFORE trig. Player B's camera accumulates
    // yaw unboundedly over a session; cos/sin of large arguments lose
    // precision in the low-order bits (e.g. sin(100π) ≈ 0 but rounds to
    // ±10⁻¹⁵). The normalised angle produces the SAME unit forward
    // vector as the raw one, but without the floating-point drift.
    const yN = wrap(yaw);
    // cache pose for the spatial remap in _setSource()
    this._lx = x; this._lz = z; this._lyaw = yN;
    const fx = Math.cos(yN);
    const fz = Math.sin(yN);
    if (this.listener.positionX) {
      // Direct .value writes (no ramp) → HRTF panning responds IMMEDIATELY
      // to camera rotation, frame-perfect. AudioParam.linearRampToValue
      // would cause audible lag and lateral misalignment.
      this.listener.positionX.value = x;
      this.listener.positionY.value = y;
      this.listener.positionZ.value = z;
      this.listener.forwardX.value = fx;
      this.listener.forwardY.value = 0;
      this.listener.forwardZ.value = fz;
      this.listener.upX.value = 0;
      this.listener.upY.value = 1;
      this.listener.upZ.value = 0;
    } else {
      // Legacy AudioListener path (older browsers) — setPosition is
      // instantaneous; setOrientation is too (no ramp overload).
      this.listener.setPosition(x, y, z);
      this.listener.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  // Public: calibration system owns the listener while it runs.
  setCalListener(x, y, yaw) {
    this._setListener(x, 0, y, yaw);
  }

  // Public: install a calibration (affine polar remap + loudness envelope).
  setCalibration(cal) {
    this.cal = { ...DEFAULT_CAL, ...(cal || {}) };
  }

  _setSourceRaw(panner, x, y) {
    if (!panner) return;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = 0;
      panner.positionZ.value = y;
    } else {
      panner.setPosition(x, 0, y);
    }
  }

  // ------------------------------------------------------------------------
  // _setSource: place a WORLD source, but first warp it through the
  // inverse perception map:
  //     θ_render = (θ_true − bT) / kT      (relative to listener facing)
  //     r_render = (r_true  − bR) / kR
  // so the position the listener PERCEIVES equals the true world position.
  // ------------------------------------------------------------------------
  _setSource(panner, x, y) {
    if (!panner) return;
    const dx = x - this._lx;
    const dz = y - this._lz;
    const rTrue = Math.hypot(dx, dz);
    const thTrue = Math.atan2(dz, dx) - this._lyaw;   // 0 = ahead, + = right

    const m  = remapPolar(thTrue, rTrue, this.cal);
    const ang = m.theta + this._lyaw;
    this._setSourceRaw(panner, this._lx + Math.cos(ang) * m.r,
                              this._lz + Math.sin(ang) * m.r);
  }

  // ------------------------------------------------------------------------
  // Public: per-frame update.
  //   All positions come from Player B's simulation (broadcast to A's tab).
  //   Player A's tab calls this with B's x/y/yaw so the panning follows
  //   B's camera — A literally hears through B's ears.
  // ------------------------------------------------------------------------
  update({
    playerX, playerY, playerYaw,        // listener = Player B's head
    ghostX, ghostY, ghostDist,          // ghost source position
    beaconX, beaconY, beaconDist,       // active beacon source position
    decoy,                              // { active, x, y, freq } | undefined — ghost mimic
    aggression,                         // 0..1 ghost aggression
    tension,                            // 0..1 overall tension
    isMoving,                           // Player B moving?
    isSprinting,                        // Rain (Player B) sprinting?
    dt,
  }) {
    if (!this.ctx) return;

    // Calibration pad owns the acoustic space: duck the game mix out.
    if (this.calMode) {
      const t = this.ctx.currentTime;
      this.beaconGain.gain.linearRampToValueAtTime(0, t + 0.1);
      this.ghostGain.gain.linearRampToValueAtTime(0, t + 0.1);
      this.decoyGain.gain.linearRampToValueAtTime(0, t + 0.1);
      return;
    }

    // ---- Listener rigidly attached to Player B's camera ----
    this._setListener(playerX, 0, playerY, playerYaw);

    // ---- Beacon: distance handled by panner, gain stays constant ----
    const t = this.ctx.currentTime;
    this._setSource(this.beaconPanner, beaconX, beaconY);
    const beaconActive = beaconDist < 90;
    const beaconLoud = this.beaconLoudMax * loudnessAt(beaconDist, this.cal);
    this.beaconGain.gain.linearRampToValueAtTime(beaconActive ? beaconLoud : 0, t + 0.1);
    if (beaconActive) {
      // Closer -> higher pitch (urgency)
      const beaconNorm = Math.max(0, Math.min(1, 1 - beaconDist / 32));
      const freq = this.beaconFreqMin + beaconNorm * (this.beaconFreqMax - this.beaconFreqMin);
      this.beaconOsc.frequency.linearRampToValueAtTime(freq, t + 0.18);
      this.beaconSub.frequency.linearRampToValueAtTime(freq / 2, t + 0.18);
    }

    // ---- Ghost: spatial hum; distance via panner, aggression via gain ----
    this._setSource(this.ghostPanner, ghostX, ghostY);
    const ghostLoud = (0.16 + aggression * 0.42) * loudnessAt(ghostDist, this.cal);
    this.ghostGain.gain.linearRampToValueAtTime(ghostLoud, t + 0.1);
    this.ghostOsc.frequency.linearRampToValueAtTime(55 + aggression * 130, t + 0.1);
    this.ghostFilter.frequency.linearRampToValueAtTime(220 + aggression * 520, t + 0.1);

    // ---- Ghost decoy: the false ear ----
    this._updateDecoy(decoy, t);

    // ---- Heartbeat (A feels B's pulse) ----
    this.heartbeatPeriod = Math.max(0.32, 1.6 - tension * 1.2);
    this.heartbeatPhase = (this.heartbeatPhase + dt / this.heartbeatPeriod) % 1;
    this.heartbeatTimer -= dt;
    if (this.heartbeatTimer <= 0 && tension > 0.05) {
      this._playHeartbeat(tension);
      this.heartbeatTimer = this.heartbeatPeriod;
    } else if (tension <= 0.05) {
      this.heartbeatTimer = this.heartbeatPeriod;
    }

    // ---- Rain's sprint breathing (A hears B's lungs work) ----
    // Cross-fades the CC0 fast-breath loop in while the sprint key is held
    // with movement. Long ramps (0.4s) so breaths swell rather than click.
    if (this.breathGain) {
      const breathTarget = (isSprinting && isMoving) ? 0.55 : 0;
      this.breathGain.gain.linearRampToValueAtTime(breathTarget, t + 0.4);
    }

    // ---- Footstep (A hears B walking) ----
    if (isMoving) {      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this._playFootstep(tension);
        this.stepTimer = 0.45;
      }
    } else {
      this.stepTimer = 0;
    }
  }

  // Spectrum of everything Player A is hearing right now.
  getSpectrum() {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this._spectrum);
    return this._spectrum;
  }

  getHeartbeatPulse() {
    // 1 right after the beat, decaying to 0
    return Math.max(0, 1 - this.heartbeatPhase * 2.2);
  }

  // ------------------------------------------------------------------------
  // Ghost decoy renderer. The director (js/decoy.js) owns the decisions;
  // this only paints sound. Key detail: the frequency is set with a flat
  // setValueAtTime every frame — the REAL beacon ramps its pitch upward
  // as B closes in, the mimic NEVER MOVES. That is the audible tell.
  // ------------------------------------------------------------------------
  _updateDecoy(d, t) {
    if (!this.decoyGain) return;
    if (d && d.active) {
      this._setSource(this.decoyPanner, d.x, d.y);
      this.decoyOsc.frequency.setValueAtTime(d.freq, t);
      this.decoySub.frequency.setValueAtTime(d.freq / 2, t);
      this.decoyDirt.frequency.setValueAtTime(d.freq * 1.008, t);
      const dist = Math.hypot(d.x - this._lx, d.y - this._lz);
      this.decoyGain.gain.linearRampToValueAtTime(0.40 * loudnessAt(dist, this.cal), t + 0.12);
    } else {
      this.decoyGain.gain.linearRampToValueAtTime(0, t + 0.25);
    }
  }

  // ------------------------------------------------------------------------
  // MEMORY ECHO WHISPER — the residue's voice.
  // Deliberately NOT spatialised: no PannerNode, no atmosphere filter.
  // Bandpassed noise gated in speech-like syllable bursts, routed straight
  // to both ears — it comes from inside the listener's own head. Every
  // other sound in the game has a position; this one doesn't.
  // ------------------------------------------------------------------------
  playWhisper() {
    if (!this.ctx) return;
    const t   = this.ctx.currentTime;
    const dur = 3.4;

    // 1. Second-and-a-half of white noise shaped into "breath"
    const len  = Math.ceil(this.ctx.sampleRate * dur);
    const buf  = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    // 2. Formant band: speech-intelligible frequencies, but no words
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1350;
    bp.Q.value = 1.4;

    // 3. Syllable cadence: bursts of 120-240ms with short gaps
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    let tt = t + 0.15;
    while (tt < t + dur - 0.35) {
      const on  = 0.12 + Math.random() * 0.12;
      const amp = 0.16 + Math.random() * 0.14;
      g.gain.linearRampToValueAtTime(amp, tt + 0.03);
      g.gain.setValueAtTime(amp, tt + on);
      g.gain.linearRampToValueAtTime(0.015, tt + on + 0.05);
      tt += on + 0.06 + Math.random() * 0.10;
    }
    g.gain.linearRampToValueAtTime(0, t + dur);

    // No panner, no atmosphere — straight into the skull.
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.1);
  }

  // ------------------------------------------------------------------------
  // One-shot stingers
  // ------------------------------------------------------------------------
  playCollectChime() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(1320, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    const atmos = this._atmosFilter();           // uniform atmosphere tint
    o.connect(g); g.connect(atmos); atmos.connect(this.master);
    o.start(t); o.stop(t + 0.6);
  }

  playDeathRoar() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 1.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.6, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    const atmos = this._atmosFilter();
    o.connect(g); g.connect(atmos); atmos.connect(this.master);
    o.start(t); o.stop(t + 1.5);
  }

  // ------------------------------------------------------------------------
  // The auditory LURE: a loud ping at a beacon's true world position.
  // Player A hears it panned/attenuated through Player B's ears — and the
  // ghost (simulated in Player B's tab) is drawn to the sound.
  // ------------------------------------------------------------------------
  playLurePing(x, y) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    // Match the gentle attenuation profile of the world sources so a lure
    // ping is audible at all game-relevant distances; rolloff=0.45 (still
    // louder than continuous sources, but no abrupt cliff at maxDistance).
    panner.distanceModel = 'exponential';
    panner.refDistance = 1.5;
    panner.maxDistance = 80;
    panner.rolloffFactor = 0.45;

    this._setSource(panner, x, y);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(980, t);
    o.frequency.exponentialRampToValueAtTime(560, t + 0.35);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.7 * loudnessAt(Math.hypot(x - this._lx, y - this._lz), this.cal), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);

    const atmos = this._atmosFilter();             // uniform atmosphere tint
    o.connect(g);
    g.connect(atmos);
    atmos.connect(panner);
    panner.connect(this.master);
    o.start(t);
    o.stop(t + 1.2);
  }

  // ------------------------------------------------------------------------
  // CALIBRATION MODE: while the calibration pad runs, it owns the listener
  // pose and fires raw (un-remapped) pings so we measure the listener's
  // TRUE perception, not the corrected one.
  // ------------------------------------------------------------------------
  enterCalibration() { this.calMode = true; }
  exitCalibration()  { this.calMode = false; }

  playCalibrationPing(x, y) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'exponential';
    panner.refDistance = 1.5;
    panner.maxDistance = 80;
    panner.rolloffFactor = 0.35;            // keep every trial clearly audible

    this._setSourceRaw(panner, x, y);       // RAW: no remap during measurement

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(720, t);
    o.frequency.exponentialRampToValueAtTime(430, t + 0.3);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.8, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);

    const atmos = this._atmosFilter();
    o.connect(g);
    g.connect(atmos);
    atmos.connect(panner);
    panner.connect(this.master);
    o.start(t);
    o.stop(t + 1.0);
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------
  _playHeartbeat(intensity) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 48 + intensity * 32;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32 * intensity, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    const atmos = this._atmosFilter();
    o.connect(g); g.connect(atmos); atmos.connect(this.master);
    o.start(t); o.stop(t + 0.25);
  }

  _playFootstep(intensity) {
    const t = this.ctx.currentTime;

    // Preferred path: CC0 concrete-step sample (js/audioAssets.js),
    // playbackRate-varied ±8% so consecutive steps don't repeat verbatim.
    const buf = this.bank?.get('footstep');
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 0.92 + Math.random() * 0.16;
      const g = this.ctx.createGain();
      g.gain.value = 0.45 + intensity * 0.2;
      const atmos = this._atmosFilter();
      src.connect(g); g.connect(atmos); atmos.connect(this.master);
      src.start(t);
      return;
    }

    // Fallback: original synth pluck (asset failed to load)
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90 + Math.random() * 20, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 + intensity * 0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    const atmos = this._atmosFilter();
    o.connect(g); g.connect(atmos); atmos.connect(this.master);
    o.start(t); o.stop(t + 0.15);
  }
}