import { assetUrl } from "./assets";

/**
 * Name → file lookups. Entries without a mapped file are silently skipped
 * (same optional-asset convention as loadModel/loadTexture) so scenes can
 * call playMusic/playSfx with any cue name before the matching asset exists.
 */
const MUSIC_TRACKS: Record<string, string> = {
  "main-theme": "assets/audio/main-theme.mp3",
};

const SFX_TRACKS: Record<string, string> = {};

const MUSIC_VOLUME = 0.55;
const SFX_VOLUME = 0.7;
const FADE_MS = 800;
const FADE_STEPS = 16;

/**
 * Plays music/sfx via HTMLAudioElement. Music cross-fades between tracks and
 * loops; sfx are fire-and-forget one-shots. Cue names with no mapped file are
 * a silent no-op so unfinished sound design never breaks a scene.
 */
const UNLOCK_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

export class AudioManager {
  private muted = false;
  private current: string | null = null;
  private currentEl: HTMLAudioElement | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private unlockBound = false;

  playMusic(track: string): void {
    if (this.current === track) return;
    this.current = track;
    this.fadeOutCurrent();

    const src = MUSIC_TRACKS[track];
    if (!src) {
      console.info(`[Audio] music → ${track} (no track file mapped yet)`);
      return;
    }
    const el = new Audio(assetUrl(src));
    el.loop = true;
    el.volume = 0;
    el.muted = this.muted;
    // Scenes call playMusic immediately on enter, often before any user
    // gesture — browsers block that play() call, so fall back to retrying
    // on the first interaction instead of staying silent forever.
    el.play().catch(() => this.armUnlock());
    this.currentEl = el;
    this.fadeTo(el, MUSIC_VOLUME);
  }

  private armUnlock(): void {
    if (this.unlockBound) return;
    this.unlockBound = true;
    const retry = () => {
      this.unlockBound = false;
      for (const evt of UNLOCK_EVENTS) window.removeEventListener(evt, retry);
      this.currentEl?.play().catch(() => {});
    };
    for (const evt of UNLOCK_EVENTS) {
      window.addEventListener(evt, retry, { once: true });
    }
  }

  playSfx(name: string): void {
    if (this.muted) return;
    const src = SFX_TRACKS[name];
    if (!src) {
      console.info(`[Audio] sfx → ${name} (no sfx file mapped yet)`);
      return;
    }
    const el = new Audio(assetUrl(src));
    el.volume = SFX_VOLUME;
    el.play().catch(() => {});
  }

  stopMusic(): void {
    this.current = null;
    this.fadeOutCurrent();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.currentEl) this.currentEl.muted = muted;
  }

  dispose(): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    this.currentEl?.pause();
    this.currentEl = null;
    this.current = null;
  }

  private fadeOutCurrent(): void {
    const el = this.currentEl;
    if (!el) return;
    this.currentEl = null;
    this.fadeTo(el, 0, () => el.pause());
  }

  private fadeTo(el: HTMLAudioElement, target: number, onDone?: () => void): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    const start = el.volume;
    let step = 0;
    this.fadeTimer = setInterval(() => {
      step++;
      el.volume = start + (target - start) * (step / FADE_STEPS);
      if (step >= FADE_STEPS) {
        if (this.fadeTimer) clearInterval(this.fadeTimer);
        this.fadeTimer = null;
        onDone?.();
      }
    }, FADE_MS / FADE_STEPS);
  }
}
