// =====================================================================
// Echoes of Hong Kong — Memory Echoes ("Reverberant Remains")
//
//   Scattered through the alleys are the residues of previous victims.
//   Player B walks past them unaware; when B comes within the trigger
//   radius, the residue stirs and whispers — but ONLY Player A hears it,
//   and the whisper has NO position (no HRTF panner): it plays straight
//   into both ears, as if it came from inside A's own head.
//
//   The whisper itself is unintelligible (synthesised breath); the intel
//   arrives as a text fragment on A's sensor terminal. Every fragment is
//   TRUTHFUL — each one describes a real mechanic in ghost.js / decoy.js.
//
//   Placement is fully DETERMINISTIC (no RNG): both tabs compute the
//   identical residue list from the map alone, so no placement sync is
//   ever needed over the channel.
//
//   UNITY MIGRATION: MemoryEchoSystem.cs
//     - residues become GameObjects with SphereCollider triggers
//     - placeResidues() becomes an editor-time placement pass
//     - FRAGMENTS become ScriptableObjects (Localization-ready)
//     - the cross-run archive maps to PlayerPrefs / cloud save
// =====================================================================

// ---- Tunables ---------------------------------------------------------
export const ECHO = Object.freeze({
  COUNT:          4,      // residues per run
  TRIGGER_RADIUS: 2.6,    // how close B must walk
  MIN_SPACING:    6,      // minimum distance between residues
  SPAWN_CLEAR:    7,      // keep residues away from both spawn points
  BEACON_CLEAR:   3.5,    // ... and away from beacon tiles
  ARCHIVE_KEY:    'echoes852-echoes',   // localStorage: cross-run discoveries
});

// ---- The intel. Each fragment is a real, verifiable game mechanic ------
// (id 3 doubles as the built-in counter-play tutorial for the decoy.)
export const FRAGMENTS = Object.freeze([
  { id: 0, kind: 'hunt',
    text: 'seven steps\u2026 it changes at seven steps\u2026 never let it closer than seven\u2026' },
  { id: 1, kind: 'lure',
    text: 'let it chase the noise\u2026 noise is a leash\u2026 it forgets you for fourteen breaths\u2026' },
  { id: 2, kind: 'rage',
    text: 'empty hands make it FURIOUS\u2026 eight\u2026 count eight\u2026 then run\u2026' },
  { id: 3, kind: 'decoy',
    text: 'it learns our song\u2026 the true tone RISES as you near\u2026 the false one never moves\u2026' },
]);

// ------------------------------------------------------------------------
// Deterministic placement: scan the grid in fixed order, prefer
// dead-end cells (most wall neighbours), enforce spacing. Pure function
// of the map — identical on every tab, every run.
// ------------------------------------------------------------------------
export function placeResidues(map) {
  const candidates = [];
  for (let y = 1; y < map.height - 1; y++) {
    for (let x = 1; x < map.width - 1; x++) {
      if (map.grid[y][x] !== 0) continue;
      const cx = x + 0.5, cy = y + 0.5;

      // Keep clear of spawns and beacons
      if (Math.hypot(cx - map.playerSpawn.x, cy - map.playerSpawn.y) < ECHO.SPAWN_CLEAR) continue;
      if (Math.hypot(cx - map.ghostSpawn.x,  cy - map.ghostSpawn.y)  < ECHO.SPAWN_CLEAR) continue;
      if (map.beacons.some(b =>
        Math.hypot(cx - (b.x + 0.5), cy - (b.y + 0.5)) < ECHO.BEACON_CLEAR)) continue;

      // Dead-endish = most of the 4 neighbours are walls
      const walls = map.grid[y - 1][x] + map.grid[y + 1][x] +
                    map.grid[y][x - 1] + map.grid[y][x + 1];
      candidates.push({ x: cx, y: cy, walls });
    }
  }

  // Fixed preference: dead ends first, then row-major for determinism
  candidates.sort((a, b) => (b.walls - a.walls) || (a.y - b.y) || (a.x - b.x));

  const picked = [];
  for (const c of candidates) {
    if (picked.length >= ECHO.COUNT) break;
    if (picked.every(p => Math.hypot(p.x - c.x, p.y - c.y) >= ECHO.MIN_SPACING)) {
      picked.push({ x: c.x, y: c.y });
    }
  }
  // Fallback: if the map is too open for the spacing rule, fill the rest
  for (const c of candidates) {
    if (picked.length >= ECHO.COUNT) break;
    if (!picked.some(p => p.x === c.x && p.y === c.y)) picked.push({ x: c.x, y: c.y });
  }
  return picked;
}

// ---- Cross-run archive (which fragments this browser has EVER heard) ---
export function loadArchive() {
  try {
    const raw = JSON.parse(localStorage.getItem(ECHO.ARCHIVE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
export function saveArchive(set) {
  try { localStorage.setItem(ECHO.ARCHIVE_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

export class MemoryEchoSystem {
  /**
   * @param {{grid:number[][], width:number, height:number,
   *          playerSpawn:{x,y}, ghostSpawn:{x,y}, beacons:{x,y}[]}} map
   */
  constructor(map) {
    this.map      = map;
    this.residues = placeResidues(map);
    this.heard    = new Set();        // per-run (cleared on restart)
    this.archive  = loadArchive();    // cross-run (localStorage)
  }

  get total()      { return this.residues.length; }
  get discovered() { return this.heard.size; }

  getFragment(idx) {
    return FRAGMENTS[((idx % FRAGMENTS.length) + FRAGMENTS.length) % FRAGMENTS.length];
  }

  // ------------------------------------------------------------------------
  // Advance one frame. Runs on Player B's tab (position authority).
  //   @returns {{idx:number, fragment:object}|null}  non-null ONCE per residue
  // ------------------------------------------------------------------------
  update(_dt, playerX, playerY) {
    for (let i = 0; i < this.residues.length; i++) {
      if (this.heard.has(i)) continue;
      const r = this.residues[i];
      if (Math.hypot(r.x - playerX, r.y - playerY) <= ECHO.TRIGGER_RADIUS) {
        this.heard.add(i);
        this.archive.add(i);
        saveArchive(this.archive);
        return { idx: i, fragment: this.getFragment(i) };
      }
    }
    return null;
  }

  // New run: residues whisper again (the cross-run archive is untouched).
  reset() { this.heard.clear(); }
}
