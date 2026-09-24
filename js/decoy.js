// =====================================================================
// Echoes of Hong Kong — Ghost Decoy Director ("The False Ear")
//
//   While the ghost STALKS at medium range it sometimes SINGS LIKE A
//   BEACON — from a position offset ±30° from its true bearing, so
//   Player A guides B toward nothing. The counter-play is perceptual:
//     * the REAL beacon's pitch rises as B approaches; the mimic holds
//       ONE random frequency and never moves,
//     * the mimic carries a faint trace of sawtooth harmonics — the
//       ghost's own voice bleeding through (rendered by audio.js).
//
//   This module is PURE LOGIC (no audio, no DOM): it decides WHEN and
//   WHERE the mimic sings. Rendering belongs to SpatialAudio.
//
//   UNITY MIGRATION: DecoyDirector.cs (MonoBehaviour)
//     - Update() reads the ghost state + listener transform from
//       injected references (same signature as update() below)
//     - placement math ports 1:1 (Mathf.Atan2 / Cos / Sin)
//     - the snapshot becomes a plain struct handed to an AudioSource
// =====================================================================

import { GHOST_STATE } from './ghost.js';

// ---- Tunables (expose in a ScriptableObject on the Unity side) --------
export const DECOY = Object.freeze({
  MIN_DIST:     8,              // ghost must be at least this far from B
  MAX_DIST:     28,             // ... and at most (inaudible beyond anyway)
  ANGLE_OFFSET: Math.PI / 6,    // ±30° from the ghost's true bearing
  DURATION:     4.5,            // seconds the mimic sings
  COOLDOWN_MIN: 14,             // seconds of silence between mimicries
  COOLDOWN_MAX: 22,
  FIRST_DELAY:  6,              // grace period after game start / restart
  RETRY_DELAY:  2.5,            // blocked placement -> try again soon
  FREQ_MIN:     330,            // mimic pitch band (plausible beacon
  FREQ_MAX:     560,            // frequencies — but FLAT: the audio tell)
});

export class GhostDecoyDirector {
  /**
   * @param {{isWall(x:number,y:number):boolean}} map  collision query only
   * @param {() => number} [rng]                         injectable RNG (tests)
   */
  constructor(map, rng = Math.random) {
    this.map = map;
    this.rng = rng;

    this._active   = false;
    this._timer    = 0;             // remaining song time
    this._cooldown = DECOY.FIRST_DELAY;
    this._pos      = null;          // {x, y} world position of the mimic
    this._freq     = 0;             // the ONE frequency it holds
    this._snapshot = { active: false };
  }

  // What the audio engine should render this frame.
  get snapshot() { return this._snapshot; }

  // ------------------------------------------------------------------------
  // Advance the director one frame.
  //   @param dt               frame delta (seconds)
  //   @param s.ghostState     Ghost GHOST_STATE string ('stalk', ...)
  //   @param s.ghostX/Y       ghost world position
  //   @param s.listenerX/Y    listener (Player B) world position
  //   @returns {{active:boolean,x?:number,y?:number,freq?:number}|{active:false}}
  // ------------------------------------------------------------------------
  update(dt, s) {
    // ---- Song in progress: keep singing until the timer runs out ----
    if (this._active) {
      this._timer -= dt;
      if (this._timer <= 0) {
        this._active = false;
        this._cooldown = DECOY.COOLDOWN_MIN +
          this.rng() * (DECOY.COOLDOWN_MAX - DECOY.COOLDOWN_MIN);
        this._snapshot = { active: false };
      }
      return this._snapshot;
    }

    // ---- Silent: tick the cooldown, then consider a new mimicry ----
    this._cooldown -= dt;
    if (this._cooldown > 0) return this._snapshot;

    const dist = Math.hypot(s.ghostX - s.listenerX, s.ghostY - s.listenerY);
    const eligible =
      s.ghostState === GHOST_STATE.STALK &&
      dist >= DECOY.MIN_DIST && dist <= DECOY.MAX_DIST;
    if (!eligible) return this._snapshot;

    const pos = this._place(s.listenerX, s.listenerY, s.ghostX, s.ghostY);
    if (!pos) {                       // both offset spots are inside walls
      this._cooldown = DECOY.RETRY_DELAY;
      return this._snapshot;
    }

    this._active = true;
    this._timer  = DECOY.DURATION;
    this._pos    = pos;
    // One random plausible frequency, held flat for the whole song.
    this._freq   = DECOY.FREQ_MIN +
      this.rng() * (DECOY.FREQ_MAX - DECOY.FREQ_MIN);
    this._snapshot = { active: true, x: pos.x, y: pos.y, freq: this._freq };
    return this._snapshot;
  }

  // ------------------------------------------------------------------------
  // Place the mimic: same distance as the ghost, bearing rotated by
  // ±ANGLE_OFFSET around the listener. If the first side lands inside a
  // wall, mirror to the other side; if both are blocked, give up (null).
  // ------------------------------------------------------------------------
  _place(listenerX, listenerY, ghostX, ghostY) {
    const dx = ghostX - listenerX;
    const dy = ghostY - listenerY;
    const r  = Math.hypot(dx, dy);
    const bearing = Math.atan2(dy, dx);
    const sides = this.rng() < 0.5 ? [1, -1] : [-1, 1];

    for (const side of sides) {
      const a = bearing + side * DECOY.ANGLE_OFFSET;
      const x = listenerX + Math.cos(a) * r;
      const y = listenerY + Math.sin(a) * r;
      if (!this.map.isWall(x, y)) return { x, y };
    }
    return null;
  }

  // Back to the post-restart grace period.
  reset() {
    this._active   = false;
    this._timer    = 0;
    this._cooldown = DECOY.FIRST_DELAY;
    this._pos      = null;
    this._freq     = 0;
    this._snapshot = { active: false };
  }
}