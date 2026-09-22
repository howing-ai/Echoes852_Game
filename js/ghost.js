// =====================================================================
// Echoes of Hong Kong — Ghost AI
//   * Four states: WANDER (idle drift), STALK (heads toward player),
//                  HUNT  (accelerates when close),
//                  INVESTIGATE (rushes toward a loud beacon ping — the lure)
//   * Aggression accumulates when near, decays when far;
//     a fruitless investigation leaves it ENRAGED (rage window):
//     tripled aggression build-up + 35% speed for a short duration.
//   * Wall-aware via injected `map.isWall(x, y)`
//   * Exposes `getProximity()` and `getDistanceTo()` for visuals & audio
// =====================================================================

export const GHOST_STATE = Object.freeze({
  WANDER:      'wander',
  STALK:       'stalk',
  HUNT:        'hunt',
  INVESTIGATE: 'investigate',
});

export class Ghost {
  constructor(map, spawn) {
    this.map  = map;
    this.x    = spawn.x;
    this.y    = spawn.y;
    this.state = GHOST_STATE.WANDER;

    // Movement
    this.speedBase  = 1.6;
    this.speedHunt  = 3.4;
    this.dirX       = (Math.random() - 0.5) * 2;
    this.dirY       = (Math.random() - 0.5) * 2;
    this.dirTimer   = Math.random() * 4;

    // Tension / aggression builds when near
    this.aggression = 0;

    // Visual static intensity (0..1) — already normalized
    this.staticLevel = 0;

    // Auditory lure: the entity investigates loud beacon pings
    this.target           = null;   // {x, y} — where it heard the sound
    this.investigateTimer = 0;      // gives up when this reaches zero
    this.rageTimer        = 0;      // enrage window after a fruitless search

    // Distance cache
    this._lastDistance = Infinity;
  }

  // ------------------------------------------------------------------------
  update(dt, playerX, playerY) {
    const dx = playerX - this.x;
    const dy = playerY - this.y;
    const dist = Math.hypot(dx, dy);
    this._lastDistance = dist;

    // ---- Rage window: a fruitless investigation leaves it furious ----
    if (this.rageTimer > 0) this.rageTimer = Math.max(0, this.rageTimer - dt);
    const enraged = this.rageTimer > 0;

    // ---- State transitions ----
    if (this.state === GHOST_STATE.INVESTIGATE) {
      this.investigateTimer -= dt;
      const td = this.target
        ? Math.hypot(this.target.x - this.x, this.target.y - this.y)
        : Infinity;

      if (td < 1.5 || this.investigateTimer <= 0) {
        // It reached the sound (or gave up). Was anyone there?
        if (dist < 7) {
          // Fresh trail — straight to the hunt
          this.state = GHOST_STATE.HUNT;
        } else {
          // Empty alley. The frustration lingers as rage:
          // faster and angrier for a short while.
          this.rageTimer = 8;
          this.aggression = Math.min(1, this.aggression + 0.45);
          this.state = (dist < 18) ? GHOST_STATE.STALK : GHOST_STATE.WANDER;
        }
        this.target = null;
      }
    } else {
      if (this.state === GHOST_STATE.WANDER && dist < 18) {
        this.state = GHOST_STATE.STALK;
      }
      if (this.state === GHOST_STATE.STALK && dist < 7) {
        this.state = GHOST_STATE.HUNT;
      }
      if (this.state === GHOST_STATE.HUNT && dist > 14) {
        this.state = GHOST_STATE.STALK;
      }
    }

    // ---- Aggression dynamics (rage triples the build-up) ----
    if (dist < 12) {
      this.aggression = Math.min(1, this.aggression + dt * 0.10 * (enraged ? 3 : 1));
    } else {
      this.aggression = Math.max(0, this.aggression - dt * 0.04);
    }

    // ---- Movement ----
    let vx = 0, vy = 0;
    if (this.state === GHOST_STATE.INVESTIGATE && this.target) {
      const tdx = this.target.x - this.x;
      const tdy = this.target.y - this.y;
      const tl  = Math.max(0.001, Math.hypot(tdx, tdy));
      vx = tdx / tl;
      vy = tdy / tl;
    } else if (this.state === GHOST_STATE.WANDER) {
      this.dirTimer -= dt;
      if (this.dirTimer <= 0) {
        this.dirX = (Math.random() - 0.5) * 2;
        this.dirY = (Math.random() - 0.5) * 2;
        this.dirTimer = 2.5 + Math.random() * 3.5;
      }
      vx = this.dirX;
      vy = this.dirY;
    } else if (this.state === GHOST_STATE.STALK) {
      const len = Math.max(0.001, dist);
      vx = dx / len;
      vy = dy / len;
      // small drift noise so it doesn't glue perfectly
      const t = performance.now() * 0.001;
      vx += Math.sin(t * 1.7) * 0.08;
      vy += Math.cos(t * 1.9) * 0.08;
    } else if (this.state === GHOST_STATE.HUNT) {
      const len = Math.max(0.001, dist);
      vx = dx / len;
      vy = dy / len;
    }

    const base = (this.state === GHOST_STATE.HUNT || this.state === GHOST_STATE.INVESTIGATE)
      ? this.speedHunt
      : this.speedBase + this.aggression * 0.8;
    const speed = base * (enraged ? 1.35 : 1);
    const nx = this.x + vx * speed * dt;
    const ny = this.y + vy * speed * dt;

    // Wall-aware movement (axis-separated to slide along walls)
    if (!this.map.isWall(nx, this.y)) this.x = nx;
    if (!this.map.isWall(this.x, ny)) this.y = ny;

    // ---- Static level ----
    // Closer = stronger static; aggression and rage amplify it
    const proxNorm = Math.max(0, 1 - dist / 22);
    this.staticLevel = Math.min(1, proxNorm * 0.8 + this.aggression * 0.4 + (enraged ? 0.15 : 0));
  }

  // ------------------------------------------------------------------------
  // AUDITORY LURE: a loud ping tears the entity away from whatever it was
  // doing and sends it rushing toward the sound's world coordinates.
  // Nothing distracts it once it is locked in a HUNT.
  // ------------------------------------------------------------------------
  investigate(x, y) {
    if (this.state === GHOST_STATE.HUNT) return false;
    this.state = GHOST_STATE.INVESTIGATE;
    this.target = { x, y };
    this.investigateTimer = 14;   // seconds before it gives up
    return true;
  }

  // ------------------------------------------------------------------------
  // Accessors
  distanceTo(x, y) {
    return Math.hypot(this.x - x, this.y - y);
  }

  getProximity() { return this._lastDistance; }
  getStatic()    { return this.staticLevel; }
  getAggression(){ return this.aggression; }
  getState()     { return this.state; }
  getRage()      { return this.rageTimer > 0; }
}