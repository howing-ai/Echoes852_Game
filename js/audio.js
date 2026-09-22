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
// =====================================================================

export class SpatialAudio {
  constructor() {
    this.ctx            = null;
    this.master         = null;
    this.analyser       = null;
    this._spectrum      = null;

    this.listener       = null;

    // Beacon (objective target)
    this.beaconOsc      = null;
    this.beaconGain     = null;
    this.beaconPanner   = null;
    this.beaconFreqMin  = 300;
    this.beaconFreqMax  = 720;

    // Ghost proximity hum
    this.ghostOsc       = null;
    this.ghostFilter    = null;
    this.ghostGain      = null;
    this.ghostPanner    = null;

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
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);

    // ---- Spectrum tap for the sensor terminal ----
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.82;
    this.master.connect(this.analyser);
    this._spectrum = new Uint8Array(this.analyser.frequencyBinCount);

    this.listener = this.ctx.listener;

    // ===== Beacon panner (objective sound source in the world) =====
    this.beaconOsc = this.ctx.createOscillator();
    this.beaconOsc.type = 'sine';
    this.beaconOsc.frequency.value = this.beaconFreqMin;

    this.beaconGain = this.ctx.createGain();
    this.beaconGain.gain.value = 0;

    this.beaconPanner = this.ctx.createPanner();
    this.beaconPanner.panningModel = 'HRTF';
    this.beaconPanner.distanceModel = 'exponential';
    this.beaconPanner.refDistance = 1.0;
    this.beaconPanner.maxDistance = 40;
    this.beaconPanner.rolloffFactor = 0.8;   // audible across most of the map

    this.beaconOsc.connect(this.beaconGain);
    this.beaconGain.connect(this.beaconPanner);
    this.beaconPanner.connect(this.master);
    this.beaconOsc.start();

    // ===== Ghost hum — NOW SPATIAL (A hears WHERE the ghost is) =====
    this.ghostOsc = this.ctx.createOscillator();
    this.ghostOsc.type = 'sawtooth';
    this.ghostOsc.frequency.value = 70;

    this.ghostFilter = this.ctx.createBiquadFilter();
    this.ghostFilter.type = 'lowpass';
    this.ghostFilter.frequency.value = 320;
    this.ghostFilter.Q.value = 6;

    this.ghostGain = this.ctx.createGain();
    this.ghostGain.gain.value = 0;

    this.ghostPanner = this.ctx.createPanner();
    this.ghostPanner.panningModel = 'HRTF';
    this.ghostPanner.distanceModel = 'exponential';
    this.ghostPanner.refDistance = 1.0;
    this.ghostPanner.maxDistance = 45;
    this.ghostPanner.rolloffFactor = 0.8;

    // LFO gives the filter a breathing, living quality
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.4;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 80;
    lfo.connect(lfoGain).connect(this.ghostFilter.frequency);
    lfo.start();

    this.ghostOsc.connect(this.ghostFilter);
    this.ghostFilter.connect(this.ghostGain);
    this.ghostGain.connect(this.ghostPanner);
    this.ghostPanner.connect(this.master);
    this.ghostOsc.start();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() { return !!this.ctx; }

  // ------------------------------------------------------------------------
  // Listener = Player B's head. Sound sources live in the world.
  // _setListener(x, y, z, yaw)  — yaw 0 = facing +X, matches game convention
  // ------------------------------------------------------------------------
  _setListener(x, y, z, yaw) {
    if (!this.listener) return;
    const fx = Math.cos(yaw);
    const fz = Math.sin(yaw);
    if (this.listener.positionX) {
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
      this.listener.setPosition(x, y, z);
      this.listener.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  _setSource(panner, x, y) {
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
  // Public: per-frame update.
  //   All positions come from Player B's simulation (broadcast to A's tab).
  //   Player A's tab calls this with B's x/y/yaw so the panning follows
  //   B's camera — A literally hears through B's ears.
  // ------------------------------------------------------------------------
  update({
    playerX, playerY, playerYaw,        // listener = Player B's head
    ghostX, ghostY, ghostDist,          // ghost source position
    beaconX, beaconY, beaconDist,       // active beacon source position
    aggression,                         // 0..1 ghost aggression
    tension,                            // 0..1 overall tension
    isMoving,                           // Player B moving?
    dt,
  }) {
    if (!this.ctx) return;

    // ---- Listener rigidly attached to Player B's camera ----
    this._setListener(playerX, 0, playerY, playerYaw);

    // ---- Beacon: distance handled by panner, gain stays constant ----
    const t = this.ctx.currentTime;
    this._setSource(this.beaconPanner, beaconX, beaconY);
    const beaconActive = beaconDist < 90;
    this.beaconGain.gain.linearRampToValueAtTime(beaconActive ? 0.5 : 0, t + 0.1);
    if (beaconActive) {
      // Closer -> higher pitch (urgency)
      const beaconNorm = Math.max(0, Math.min(1, 1 - beaconDist / 32));
      const freq = this.beaconFreqMin + beaconNorm * (this.beaconFreqMax - this.beaconFreqMin);
      this.beaconOsc.frequency.linearRampToValueAtTime(freq, t + 0.18);
    }

    // ---- Ghost: spatial hum; distance via panner, aggression via gain ----
    this._setSource(this.ghostPanner, ghostX, ghostY);
    this.ghostGain.gain.linearRampToValueAtTime(0.16 + aggression * 0.42, t + 0.1);
    this.ghostOsc.frequency.linearRampToValueAtTime(55 + aggression * 130, t + 0.1);
    this.ghostFilter.frequency.linearRampToValueAtTime(220 + aggression * 520, t + 0.1);

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

    // ---- Footstep (A hears B walking) ----
    if (isMoving) {
      this.stepTimer -= dt;
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
    o.connect(g); g.connect(this.master);
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
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 1.5);
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
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.25);
  }

  _playFootstep(intensity) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90 + Math.random() * 20, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 + intensity * 0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.15);
  }
}