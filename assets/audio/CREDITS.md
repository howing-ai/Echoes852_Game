# Audio Assets — Attribution & Provenance

All assets are **CC0 (Creative Commons Zero / public domain)**, sourced from
Freesound. CC0 requires no attribution, but provenance is recorded here for
traceability. Files are the Freesound HQ preview MP3s (128 kbps).

| File | Source | Author | License | Notes |
|---|---|---|---|---|
| `bgm_dark_drone.mp3` | [Dark Atmospheric Drone (Time-Stretched, Seamless Loop)](https://freesound.org/people/kkenny101/sounds/865550/) | kkenny101 | CC0 | 2:38 seamless loop — shared ambient bed (both players) |
| `breath_sprint_loop.mp3` | [Male_Breath_Fast_Loop_Stereo.wav](https://freesound.org/people/Nox_Sound/sounds/554907/) | Nox_Sound | CC0 | 5.2s fast-breath loop — Rain (Player B) sprinting, heard by Player A |
| `footsteps_old_concrete.mp3` | [Footsteps on Old Concrete Slabs](https://freesound.org/people/SiriusS19YT/sounds/868548/) | SiriusS19YT | CC0 | 6s worn-concrete steps — reserve material |
| `footstep_single.mp3` | [concrete footstep 2](https://freesound.org/people/Yoyodaman234/sounds/166508/) | Yoyodaman234 | CC0 | 0.49s single step — per-step trigger, playbackRate-varied |

Unity migration note: these four files port directly as `AudioClip`s; the
manifest in `js/audioAssets.js` maps 1:1 to serialized `AudioClip` fields.
