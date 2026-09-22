# Echoes of Hong Kong

A local 2-player **cooperative asymmetric** prototype. Two roles, two browser tabs, one voice channel.

## Roles

| Role | Senses | Job |
|---|---|---|
| **Player A — THE EARS** (Sensor Terminal) | Hears everything | Guide Player B by voice. Spatial audio is bound to Player B's position and camera rotation — when B turns their head, the sound pans in A's headphones. |
| **Player B — THE EYES** (First-Person Drifter) | Completely deaf | Navigate the dark alleys by sight alone. Survive. |

Player A hears the objective beacons and the stalking ghost's hum through Player B's ears — a symbiotic blind-and-deaf cooperative loop.

## Play

1. Open the game in two browser tabs (or two devices on the same origin).
2. Tab 1: pick **SENSOR · THE EARS** — put headphones on.
3. Tab 2: pick **DRIFTER · THE EYES** — click to capture the mouse.
4. Talk to each other (Discord / phone call / same room).

### Controls

**Player A (Ears)**
- `1`–`5` — select which beacon to direct Player B toward
- Listen — beacon panning (L/R) tells you which way B should turn; the ghost hum tells you when to run

**Player B (Eyes)**
- `W A S D` — move, `SHIFT` — sprint
- Mouse (pointer lock) — look around
- `E` — absorb the active beacon (when close)
- `ESC` — release mouse, `TAB` — toggle view layout

## Tech

- Vanilla JS + Canvas 2D (raycasting renderer)
- Web Audio API (HRTF spatial panners, AnalyserNode spectrum)
- BroadcastChannel for same-origin cross-tab sync
- No dependencies, no build step

## Project structure

```
index.html      entry point, role select, dual viewports
css/style.css   CRT retro theme (scanlines, phosphor green, warning red)
js/main.js      game loop, state machine, map data, cross-tab sync
js/player.js    Player B first-person view + Player A sensor terminal
js/ghost.js     stalking AI ghost (wander / stalk / hunt)
js/audio.js     spatial audio engine (the symbiotic listener link)
```
