// =====================================================================
// Echoes of Hong Kong — Ghost AI
//   * Three states: WANDER (idle drift), STALK (heads toward player),
//                  HUNT  (accelerates when close)
//   * Aggression accumulates when near, decays when far
//   * Wall-aware via injected `map.isWall(x, y)`
//   * Exposes `getProximity()` and `getDistanceTo()` for visuals & audio
// =====================================================================

export const GHOST_STATE = Object.freeze({
  WANDER: 'wander',
  STALK:  'stalk',
  HUNT:   'hunt',
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

    // Distance cache
    this._lastDistance = Infinity;
  }

  // ------------------------------------------------------------------------
  update(dt, playerX, playerY) {
    const dx = playerX - this.x;
    const dy = playerY - this.y;
    const dist = Math.hypot(dx, dy);
    this._lastDistance = dist;

    // ---- State transitions ----
    if (this.state === GHOST_STATE.WANDER && dist < 18) {
      this.state = GHOST_STATE.STALK;
    }
    if (this.state === GHOST_STATE.STALK && dist < 7) {
      this.state = GHOST_STATE.HUNT;
    }
    if (this.state === GHOST_STATE.HUNT && dist > 14) {
      this.state = GHOST_STATE.STALK;
    }

    // ---- Aggression dynamics ----
    if (dist < 12) {
      this.aggression = Math.min(1, this.aggression + dt * 0.10);
    } else {
      this.aggression = Math.max(0, this.aggression - dt * 0.04);
    }

    // ---- Movement ----
    let vx = 0, vy = 0;
    if (this.state === GHOST_STATE.WANDER) {
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

    const speed = (this.state === GHOST_STATE.HUNT) ? this.speedHunt : this.speedBase + this.aggression * 0.8;
    const nx = this.x + vx * speed * dt;
    const ny = this.y + vy * speed * dt;

    // Wall-aware movement (axis-separated to slide along walls)
    if (!this.map.isWall(nx, this.y)) this.x = nx;
    if (!this.map.isWall(this.x, ny)) this.y = ny;

    // ---- Static level ----
    // Closer = stronger static; aggression amplifies it
    const proxNorm = Math.max(0, 1 - dist / 22);
    this.staticLevel = Math.min(1, proxNorm * 0.8 + this.aggression * 0.4);
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
}