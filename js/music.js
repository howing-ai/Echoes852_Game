// =====================================================================
// Echoes of Hong Kong — js/music.js
//   AmbientMusic: the shared background-music bed (CC0 "Dark Atmospheric
//   Drone", assets/audio/bgm_dark_drone.mp3).
//
//   Listener design (per the relaxed symbiotic contract):
//     * Player A hears it through the shared AudioContext — routed
//       DIRECTLY to ctx.destination, bypassing SpatialAudio's master gain,
//       500Hz atmosphere LPF and analyser tap, so the sensor terminal's
//       spectrum still shows only the gameplay-relevant sources.
//     * Player B (the "deaf" eyes) hears it through a private, minimal
//       AudioContext — B's tab stays deaf to every GAME sound; the music
//       is the only thing it ever plays.
//
//   Unity mapping: an `AudioDirector` MonoBehaviour with one AudioSource
//   (loop, 2D spatialBlend, low priority) instantiated by the scene
//   loader on both clients.
// =====================================================================

import { AudioAssetBank } from './audioAssets.js';

const MUSIC_VOLUME = 0.22;   // a bed, not a performer — must never mask the
                             // beacon hum or Rain's breathing cues

export class AmbientMusic {
  constructor() {
    this.ctx       = null;   // AudioContext (shared with A, private for B)
    this.ownsCtx   = false;  // true => B's tab: we created (and must close) it
    this.gain      = null;
    this.src       = null;
    this.started   = false;
  }

  // ---- Player A's tab: reuse the SpatialAudio context -----------------
  // `bank` may be the AudioAssetBank or a promise resolving to it.
  async startShared(ctx, bank) {
    await this._start(ctx, await bank);
  }

  // ---- Player B's tab: private context, own asset load ----------------
  // MUST be called from a user gesture (role-select click) so the context
  // starts un-suspended.
  async startStandalone() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ownsCtx = true;
    const bank = await new AudioAssetBank().load(ctx);
    await this._start(ctx, bank);
  }

  async _start(ctx, bank) {
    if (this.started || !ctx) return;
    const buf = bank?.get('bgm');
    if (!buf) {
      console.warn('[music] bgm asset unavailable — continuing silent');
      return;
    }
    this.ctx     = ctx;
    this.gain    = ctx.createGain();
    this.gain.gain.value = 0;                    // fade in below
    this.src     = ctx.createBufferSource();
    this.src.buffer = buf;
    this.src.loop = true;                        // asset is a seamless loop
    this.src.connect(this.gain);
    this.gain.connect(ctx.destination);          // bypass everything game-y
    this.src.start();
    this.gain.gain.linearRampToValueAtTime(MUSIC_VOLUME, ctx.currentTime + 3);
    this.started = true;
  }

  stop() {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.gain.gain.linearRampToValueAtTime(0, t + 1);
    const src = this.src;
    setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, 1100);
    if (this.ownsCtx) setTimeout(() => { try { this.ctx.close(); } catch { /* ignore */ } }, 1200);
    this.started = false;
  }
}
