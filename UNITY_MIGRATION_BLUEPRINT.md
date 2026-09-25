# Unity Migration Blueprint

**Echoes of Hong Kong — JS POC → Unity "Hong Kong Digital Twin"**

This document maps every system in the current vanilla-JS prototype to its
Unity C# counterpart. The POC was deliberately structured for this port:
pure-logic modules (no DOM / no Web Audio) translate 1:1; engine-touching
modules translate to well-known Unity subsystems.

---

## 1. System Map (file → components)

| JS Module | Responsibility | Unity Counterpart | Effort |
|---|---|---|---|
| `js/main.js` | Bootstrap, game state machine, main loop, cross-tab sync | `GameManager` (singleton) + `GameStateMachine` + scenes | Medium |
| `js/main.js` → `MAP_DEFS` + `GameMap` | 24×24 grid, walls, raycast, three location palettes | `LocationDefinition` ScriptableObjects + `Tilemap` / 3D mesh prefabs + `NavMesh` | Medium |
| `js/player.js` → `PlayerB` | First-person movement + raycasting renderer | `CharacterController` + Cinemachine FP camera (3D replaces the raycaster entirely) | Low |
| `js/player.js` → `PlayerA` | Sensor terminal canvas UI | UGUI / UI Toolkit `SensorTerminalUI` + `AudioSourceSpectrum` | Low |
| `js/audio.js` → `SpatialAudio` | HRTF panners, distance curves, filters, one-shots | `AudioListener` (on B's camera) + `AudioSource` pool + `AudioMixer` | Medium |
| `js/audioAssets.js` → `AudioAssetBank` | CC0 sample loading + event→asset mapping | serialized `AudioClip` fields on an `AudioDirector` component | Trivial |
| `js/music.js` → `AmbientMusic` | shared BGM bed (A reuses ctx, B gets private one) | one 2D looping `AudioSource` per client, `AudioClip` = bgm asset | Trivial |
| `js/audio.js` → `_atmosFilter` | 500 Hz/Q0.7 atmosphere LPF on every source | One `AudioMixerGroup` ("Atmosphere") with a Lowpass filter — set once, route everything through it | Trivial |
| `js/audio.js` → calibration hooks | Polar remap pre-warp, loudness envelope, cal mode | `SpatialCalibrationService` (static C# port) + per-source pre-warp before `transform.position` assignment | Medium |
| `js/ghost.js` | 4-state FSM + aggression/static dynamics | `GhostAI : MonoBehaviour` (same FSM, `NavMeshAgent` for movement) | Low |
| `js/calibration.js` | Polar math, affine fit, session, persistence | `CalibrationMath` (pure C#, unit-testable) + `CalibrationSession` + `PlayerPrefs`/cloud | Low |
| `js/decoy.js` | False-ear director (pure logic) | `DecoyDirector : MonoBehaviour` — ports line-by-line | Trivial |
| `js/memoryEchoes.js` | Residue placement + whisper triggers + archive | `MemoryEchoSystem` + `SphereCollider` triggers + `EchoFragment` ScriptableObjects | Low |
| `css/style.css`, CRT overlay | Terminal aesthetics | UI Toolkit + custom shaders (scanlines, bloom, chromatic aberration) | Medium |
| `js/net.js` → `NetLink` | Transport abstraction: WebSocket relay (server mode) + BroadcastChannel (local fallback), room codes, role arbitration | **Netcode for GameObjects** `NetworkManager` + `INetworkTransport` — see §4 | Low |
| `server/server.js` | Dumb relay: room matchmaking, role arbitration, message forwarding, static hosting | Unity Relay (rooms/allocations) + Lobby service — the relay itself disappears | — |

\* In the Digital Twin 3D target, the grid becomes real geometry; keep a
logical `IGridMap` interface (`bool IsWall(float x, float y)`) so ghost AI,
decoy placement and residue placement keep working unchanged.

---

## 2. The Symbiotic Audio Link in Unity

The prototype's core trick — *A listens through B's ears* — maps to a
standard Unity pattern:

```
JS POC                                   Unity
──────────────────────────────────       ──────────────────────────────────
audio listener bound to B's pos+yaw  →   AudioListener component parented
                                         under B's camera rig (automatic)
HRTF PannerNode per source           →   AudioSource.spatialBlend = 1
                                         + spatializer plugin (Steam Audio
                                         recommended: occlusion + HRTF)
_setSource() per-frame position      →   AudioSource.transform.position =
                                         pre-warped world position (§3)
exponential model ref=1.5 max=80     →   AudioSource rolloff: custom curve,
rolloff=0.25                            clone the curve, one asset shared
500Hz atmosphere LPF per source      →   AudioMixerGroup "Atmosphere"
                                         with Lowpass @500Hz, Q 0.7
beacon/ghost/decoy persistent chains →   3 persistent AudioSources + a pool
                                         for one-shots (chime/roar/whisper)
playWhisper(): no panner, no atmos   →   AudioSource.spatialBlend = 0,
                                         routed OUTSIDE the Atmosphere group
                                         ("inside your head" by design)
```

**Sampled CC0 assets** (`assets/audio/` — provenance in `CREDITS.md`): the four
files port directly as `AudioClip`s. Event mapping: `bgm_dark_drone` → 2D loop
on both clients (`AmbientMusic` → one `AudioSource` each); `breath_sprint_loop`
→ 2D loop on A's client, gain cross-faded by B's sprint `NetworkVariable`;
`footstep_single` → one-shot pool with ±8% random pitch. The beacon synth keeps
its sub-octave + 0.55 Hz tremolo character (two extra oscillators per source) —
port as a second `AudioSource` at half frequency on the same mixer group.

**Location / map visual identity**: `MAP_DEFS` become `LocationDefinition`
ScriptableObjects; the palette struct (wallNear/Far, edge, sky, floor) maps to a
`LocationPalette` asset. Player B's camera background + global fog + wall
materials read the selected palette. In the Digital Twin, swap the `Tilemap`
sprite/mesh palette and the post-process colour grading per location so players
instantly know which part of Hong Kong they are in.

**Listener orientation**: the POC writes `forward = (cos yaw, 0, sin yaw)`,
`up = (0,1,0)` every frame with a normalized yaw (`wrap()`). In Unity the
camera transform does this for free — the yaw-normalisation fix becomes a
no-op, but keep `wrap()` in `CalibrationMath` because the decoy placement
and polar remap still consume raw accumulated yaw from input.

---

## 3. Spatial Calibration — the pure-math port

`calibration.js` contains zero engine dependencies. Port as:

```
Assets/Scripts/Calibration/
  CalibrationMath.cs      // wrap(), remapPolar(), loudnessAt(),
                          // trialError(), fitAffine(), aggregate()
                          // — direct translation, keep unit tests
  CalibrationSession.cs   // trial sequence state machine
  CalibrationUI.cs        // replaces the canvas polar pad; UI Toolkit
                          // radial layout, click → perceived polar coords
  CalProfile.cs           // ScriptableObject: { kT, bT, kR, bR, vMin, vMax }
```

Application point: every world-position → AudioSource assignment passes
through `CalibrationMath.RemapPolar(listenerPose, sourcePos, profile)`
**before** setting `transform.position`. This is exactly what
`SpatialAudio._setSource()` does today — the Unity version simply moves
that warp into a shared helper called by the audio source updater.

Persistence: `localStorage` → `PlayerPrefs.SetString("cal.profile", json)`
(or cloud save for the Digital Twin).

---

## 4. Networking — NetLink + relay server

The POC now has **real cross-device networking** (`js/net.js` +
`server/server.js`), structured exactly like the Unity target:

```
JS POC (today)                                Unity (target)
──────────────────────────────────────       ──────────────────────────────────────
js/net.js NetLink                          → NetworkClient (NGO NetworkManager)
  ├─ SERVER mode: WebSocket relay          →   Relay transport (WebSocket → UDP)
  └─ LOCAL mode: BroadcastChannel          →   (editor/offline mode; dropped)
server/server.js (dumb relay)              →   Unity Relay + Lobby service
  ├─ room codes (4-char, max 2 players)    →   Lobby join codes
  ├─ role arbitration (A/B once each)      →   connection approval / lobby slots
  └─ {t:'msg'} envelopes relayed verbatim  →   NGO messaging handles framing
net.send(msg) — single game-facing API     →   NetworkClient.Send(msg)
present/goodbye synthesized per transport  →   lobby player add/remove events
b-state throttled to 30 Hz                 →   NetworkTransform sendRate 30
```

The relay is deliberately dumb (never inspects game payloads) — in Unity it
is replaced wholesale by Relay/Lobby, and only `NetLink`'s public surface
(`send`, `onMessage`, `claimRole`, room join flow) needs a new backend.

The POC message protocol is already a clean wire format. Map it directly
to Netcode for GameObjects custom messages (or Fusion RPCs):

| POC message | Fields | Direction | Unity equivalent |
|---|---|---|---|
| `present` / `goodbye` | role | both (synthesized by NetLink) | Lobby presence + connection approval |
| `b-state` | x, y, yaw, gx, gy, ga, gs, gsl, gr, isMoving, collected[] | B → A, 30 Hz | `NetworkTransform` on B's rig + ghost (server-authoritative) + `NetworkVariable`s for aggression/state |
| `b-beacon-collected` | idx | B → A | Server RPC → client RPC (event) |
| `a-target` | idx | A → B | client RPC |
| `a-lure` | x, y, idx | A → B | client RPC → server `ghost.Investigate(x, y)` |
| `b-echo` | idx | B → A | trigger event RPC (see §6) |

**Authority model** (unchanged from POC): Player B's client simulates the
ghost and B's movement; A is a pure listener. For the Digital Twin, promote
the ghost to server-authoritative (NavMeshAgent on the host / dedicated
server) — the JS architecture already funnels every ghost mutation through
`ghost.update(dt, playerX, playerY)` and `ghost.investigate()`, so the
promotion is localized to one class.

Voice: the POC assumes external Discord. In Unity, add Vivox (free tier)
or Unity's built-in voice — Player A hears B through the same headset path
as the game audio, keeping the symbiotic loop intact.

---

## 5. Ghost AI

`ghost.js` is a clean FSM — port as `GhostAI : MonoBehaviour`:

```csharp
enum GhostState { Wander, Stalk, Hunt, Investigate }   // 1:1 with GHOST_STATE
// update()            -> Update() (state machine switch)
// wall-slide movement -> NavMeshAgent.SetDestination()
// investigate(x,y)    -> public method, called by the lure RPC
// rageTimer window    -> same field, same 8s / 1.35x / 3x-aggression rules
// getStatic()         -> NetworkVariable<float> driving B's screen static
```

Tuning values (speeds 1.6/3.4, thresholds 18/7/14, rage 8s) move into a
`GhostSettings` ScriptableObject.

---

## 6. The Two New Features (already Unity-shaped)

### Decoy Director (`decoy.js` → `DecoyDirector.cs`)
- Pure logic, no engine calls: ports line-for-line.
- Runs **only on Player A's client** (the lie is told to the listener) —
  reads the synced ghost state, drives one pooled AudioSource.
- Unity nicety: replace `map.isWall()` wall-flip with a
  `NavMesh.SamplePosition()` check for the ±30° candidates.
- The two tells survive the port unchanged: flat pitch (real beacon ramps
  300→720 Hz with proximity) and the 5%-gain sawtooth "dirt" layer
  (second AudioSource, same mixer group).

### Memory Echoes (`memoryEchoes.js` → `MemoryEchoSystem.cs`)
- `placeResidues()` becomes an editor-time placement pass (keep the
  deterministic scan as a unit test for map generation).
- Each residue: GameObject + `SphereCollider` (is trigger) + `EchoFragment`
  ScriptableObject reference (localization-ready text).
- Trigger fires on B's client → `b-echo` RPC → A plays the whisper
  (spatialBlend 0, bypasses Atmosphere mixer) and shows the fragment text
  (UI Toolkit label, same 7 s fade).
- Archive: `localStorage` → `PlayerPrefs` / cloud save.

---

## 7. Data Flow (unchanged shape)

```
        ┌────────── Player B client (the eyes, deaf) ──────────┐
        │  PlayerB input → movement                            │
        │  GhostAI.update(dt, B.pos)     [simulation authority]│
        │  MemoryEcho triggers           → b-echo RPC          │
        │  b-state broadcast (30 Hz)     ────────────────┐     │
        └────────────────────────────────────────────────┼─────┘
                                                          ▼
        ┌────────── Player A client (the ears, blind) ─────────┐
        │  synced B pose + ghost state                         │
        │  DecoyDirector.update()        (false ear)           │
        │  CalibrationMath.RemapPolar()  (pre-warp)            │
        │  AudioSources at warped positions → A's headphones   │
        │  EchoFragment subtitle          (b-echo)             │
        └──────────────────────────────────────────────────────┘
```

---

## 8. Migration Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Vertical slice** | Grid map as Tilemap/3D blocks, PlayerB controller, one AudioSource beacon, ghost FSM | A can walk and hear one spatial beacon through B's ears |
| **1. Audio parity** | Atmosphere mixer, distance curves, heartbeat/footsteps, one-shot pool, spectrum UI | Blind playtest matches POC feel |
| **2. Networking** | NGO + Relay + Lobby, message table from §4, role selection lobby | Two machines, full co-op loop |
| **3. Calibration** | `CalibrationMath` port + radial-pad UI + profile persistence | Deviation detection & remap parity with POC |
| **4. Features** | GhostAI NavMesh, DecoyDirector, MemoryEchoSystem + fragments | All POC mechanics present |
| **5. Digital Twin** | Replace grid with real HK geometry, occlusion audio (Steam Audio), lighting, ambisonic beds | The "massive immersive map" vision |

---

## 9. POC Conventions That Made This Port Cheap

Keep these conventions in the Unity codebase:

1. **Directors are pure logic** — `decoy.js` / `memoryEchoes.js` never touch
   audio or DOM; they return decisions. Same in C#: no `AudioSource` calls
   inside director classes.
2. **Config in frozen constants at the top of each module** — becomes
   ScriptableObjects, never magic numbers in `Update()`.
3. **One update signature per system** — `update(dt, inputState) → output`;
   identical to Unity's `Update()` shape, just with explicit data flow.
4. **All tuning values documented in place** — every threshold in the POC
   (7/14/18 steps, 8s rage, ±30° decoy, 2.6m echo radius) has a comment
   explaining *why*, which is the real migration asset.
