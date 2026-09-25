// =====================================================================
// Echoes of Hong Kong — js/audioAssets.js
//   AudioAssetBank: loads, decodes and serves the game's sampled audio
//   assets (CC0 files under assets/audio/ — see CREDITS.md).
//
//   Design (Unity-shaped): the manifest maps an event name to a file and
//   playback intent — in Unity this becomes a serialized struct of
//   `AudioClip` references on an `AudioDirector` component; `bank.get()`
//   becomes a direct clip field access.
//
//   Event mapping:
//     'bgm'        ambient bed loop          — both players, low volume
//     'breath'     Rain's (Player B) sprint  — loop, Player A only
//     'footstep'   single concrete step      — Player A only, rate-varied
//     'footsteps'  old-concrete step bed     — reserve material
// =====================================================================

export const AUDIO_MANIFEST = Object.freeze({
  bgm:        { file: 'assets/audio/bgm_dark_drone.mp3',        loop: true },
  breath:     { file: 'assets/audio/breath_sprint_loop.mp3',    loop: true },
  footstep:   { file: 'assets/audio/footstep_single.mp3',       loop: false },
  footsteps:  { file: 'assets/audio/footsteps_old_concrete.mp3', loop: false },
});

export class AudioAssetBank {
  constructor() {
    this._ctx     = null;              // AudioContext the buffers decode into
    this._buffers = new Map();         // event name -> AudioBuffer
  }

  get ready() { return this._buffers.size > 0; }

  /**
   * Fetch + decode every manifest entry. Failures are logged and skipped
   * (callers fall back to procedural synthesis), never thrown — audio
   * assets must never take the game down.
   * @param {AudioContext} ctx  context buffers are decoded against
   * @param {string} baseUrl   prefix for relative paths (default: page root)
   */
  async load(ctx, baseUrl = '') {
    this._ctx = ctx;
    const jobs = Object.entries(AUDIO_MANIFEST).map(async ([name, entry]) => {
      try {
        const res = await fetch(baseUrl + entry.file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.arrayBuffer();
        this._buffers.set(name, await ctx.decodeAudioData(raw));
      } catch (err) {
        console.warn(`[assets] failed to load "${name}" (${entry.file}) — falling back to synth`, err);
      }
    });
    await Promise.all(jobs);
    return this;
  }

  has(name) { return this._buffers.has(name); }

  get(name) { return this._buffers.get(name) || null; }

  /** Playback intent from the manifest ('loop' flag). */
  loops(name) { return AUDIO_MANIFEST[name]?.loop ?? false; }
}
