# Echoes of Hong Kong

A 2-player **cooperative asymmetric** prototype. Two roles, two devices, one voice channel.

## Roles

| Role | Senses | Job |
|---|---|---|
| **Player A — THE EARS** (Sensor Terminal) | Hears everything | Guide Player B by voice. Spatial audio is bound to Player B's position and camera rotation — when B turns their head, the sound pans in A's headphones. |
| **Player B — THE EYES** (First-Person Drifter) | Completely deaf | Navigate the dark alleys by sight alone. Survive. |

Player A hears the objective beacons and the stalking ghost's hum through Player B's ears — a symbiotic blind-and-deaf cooperative loop.

## Play

### Cross-device multiplayer (real networking)

1. Start the relay server (see below).
2. Both players open the game — enter the server URL on the title screen.
3. One clicks **CREATE ROOM** and shares the 4-character code; the other enters it and clicks **JOIN ROOM**.
4. Each picks a role (the server refuses a role already taken).
5. Talk to each other (Discord / phone call / same room).

If no server is reachable, the game silently falls back to **local mode**:
two tabs in the same browser sync via `BroadcastChannel` — zero setup.

### Controls

**Player A (Ears)**
- `1`–`5` — select which beacon to direct Player B toward
- Listen — beacon panning (L/R) tells you which way B should turn; the ghost hum tells you when to run

**Player B (Eyes)**
- `W A S D` — move, `SHIFT` — sprint
- Mouse (pointer lock) — look around
- `E` — absorb the active beacon (when close)
- `ESC` — release mouse, `TAB` — toggle view layout

## Relay server

```
cd server
npm install
npm start            # http://localhost:8080 + ws://localhost:8080/ws
```

The server is a deliberately dumb relay: 4-char room matchmaking (2 players
per room), role A/B arbitration, and verbatim message forwarding — all game
simulation stays in Player B's browser. It also serves the game itself, so a
single deployment (VPS / Render / Fly.io — any Node 18+ host) is enough:
`PORT=8080 npm start`, put HTTPS/WSS in front (e.g. Caddy or a platform
terminating TLS), and the title screen auto-detects the correct
`wss://…/ws` URL.

## Tech

- Vanilla JS + Canvas 2D (raycasting renderer)
- Web Audio API (HRTF spatial panners, AnalyserNode spectrum)
- CC0 sampled audio (`assets/audio/` — ambient BGM, sprint breathing, footsteps; see `assets/audio/CREDITS.md`) layered on top of the procedural synth engine
- WebSocket relay server (Node 18+, `ws`) with room codes — `js/net.js` + `server/server.js`
- BroadcastChannel fallback for same-browser play
- No build step (client); one dependency (server: `ws`)

## Project structure

```
index.html               entry point, room-code link panel, role select, dual viewports
css/style.css            CRT retro theme (scanlines, phosphor green, warning red)
js/main.js               game loop, state machine, map data, message routing
js/net.js                NetLink — WebSocket relay + BroadcastChannel fallback transport
js/player.js             Player B (Rain) first-person view + Player A sensor terminal
js/ghost.js              stalking AI ghost (wander / stalk / hunt / investigate)
js/audio.js              spatial audio engine (the symbiotic listener link)
js/audioAssets.js         AudioAssetBank — loads/decodes the CC0 samples, event mapping
js/music.js              AmbientMusic — shared BGM bed (A reuses ctx, B gets a private one)
js/decoy.js              false-ear mimic director (Scheme: The False Ear)
js/memoryEchoes.js       residue whispers (Scheme: Reverberant Remains)
js/calibration.js        spatial calibration math + session
assets/audio/            CC0 audio assets + CREDITS.md provenance
server/server.js         Node relay: rooms, role arbitration, message relay, static hosting
UNITY_MIGRATION_BLUEPRINT.md   JS → Unity C# system mapping
```

### Maps

Three distinct Hong Kong-inspired locations with unique grid structures and
first-person palettes. The Drifter (Player B) selects the location on the title
screen; the Sensor (Player A) automatically mirrors it over the network:

| Location | Identity | Palette |
|---|---|---|
| **Sham Shui Po Alleys** | tight, irregular neon maze | phosphor green |
| **Temple Street Market** | long lantern-lit lanes with staggered stall gaps | amber / red |
| **Kwai Chung Freight Yard** | regular 2×2 container grid, long sightlines | cyan / steel |

### Audio event mapping

| Asset | Event | Heard by |
|---|---|---|
| `bgm_dark_drone.mp3` | looping ambient bed, starts at role select | both players (B via private context) |
| `breath_sprint_loop.mp3` | Rain (Player B) holds SHIFT while moving | Player A only (symbiotic link) |
| `footstep_single.mp3` | every step cycle while B moves (rate-varied) | Player A only |
| beacon synth (redesigned) | sub-octave + breathing tremolo, softer loudness | Player A only |
