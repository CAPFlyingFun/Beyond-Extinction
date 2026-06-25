import { assetUrl } from "./assets";
import { VOICE_CLIPS } from "../data/voiceClips";

/**
 * Name → file lookups. Entries without a mapped file are silently skipped
 * (same optional-asset convention as loadModel/loadTexture) so scenes can
 * call playMusic/playSfx with any cue name before the matching asset exists.
 */
const MUSIC_TRACKS: Record<string, string> = {
  "main-theme": "assets/audio/main-theme.mp3",
};

const SFX_TRACKS: Record<string, string> = {};

const MUSIC_VOLUME = 0.45;
const SFX_VOLUME = 0.7;
const VOICE_VOLUME = 1;
const FADE_MS = 800;
const FADE_STEPS = 16;
// While a voice line is playing, music ducks to a fraction of MUSIC_VOLUME so
// dialogue stays intelligible over the score, then restores once it's done.
const MUSIC_DUCK_MULT = 0.25;
const DUCK_FADE_MS = 250;
const DUCK_FADE_STEPS = 8;

/**
 * Plays music/sfx via HTMLAudioElement. Music cross-fades between tracks and
 * loops; sfx are fire-and-forget one-shots. Cue names with no mapped file are
 * a silent no-op so unfinished sound design never breaks a scene.
 */
const UNLOCK_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

/** Rough spoken-duration estimate (ms), used as a fallback when a voice clip
 *  is missing or playback is blocked, so cutscenes keep pacing with subtitles. */
function estimateSpeechMs(text: string): number {
  return Math.max(1500, Math.round(text.length * 65) + 600);
}

export class AudioManager {
  private muted = false;
  private current: string | null = null;
  private currentEl: HTMLAudioElement | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private unlockBound = false;
  private currentVoiceEl: HTMLAudioElement | null = null;
  private voiceDone: (() => void) | null = null;
  private ducked = false;

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

  // Shared by music and voice: a single user gesture unblocks autoplay for
  // both, so one retry path covers whichever element(s) are still pending.
  private armUnlock(): void {
    if (this.unlockBound) return;
    this.unlockBound = true;
    const retry = () => {
      this.unlockBound = false;
      for (const evt of UNLOCK_EVENTS) window.removeEventListener(evt, retry);
      this.currentEl?.play().catch(() => {});
      this.currentVoiceEl?.play().catch(() => {});
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

  /**
   * Play a pre-baked voice-over clip by manifest id. Resolves when the clip
   * finishes. If the file is missing or playback is blocked, resolves after an
   * estimated reading time so a cutscene keeps advancing (with subtitles) even
   * before the audio has been generated. Only one voice plays at a time.
   */
  playVoice(id: string): Promise<void> {
    this.stopVoice();
    this.duckMusic();
    const entry = VOICE_CLIPS[id];
    const fallbackMs = entry
      ? entry.durationMs ?? estimateSpeechMs(entry.text)
      : 1500;
    if (!entry) {
      console.info(`[Audio] voice → ${id} (no clip in manifest)`);
      return this.voiceWait(fallbackMs);
    }
    if (this.muted) return this.voiceWait(fallbackMs);
    const el = new Audio(assetUrl(entry.src));
    el.volume = VOICE_VOLUME;
    this.currentVoiceEl = el;
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (this.voiceDone !== finish) return;
        this.voiceDone = null;
        if (timer) clearTimeout(timer);
        el.removeEventListener("ended", finish);
        el.removeEventListener("error", onError);
        el.pause();
        if (this.currentVoiceEl === el) this.currentVoiceEl = null;
        this.unduckMusic();
        resolve();
      };
      const onError = () => {
        console.warn(`[Audio] voice ${id} unavailable — using estimated timing`);
        if (timer) clearTimeout(timer);
        timer = setTimeout(finish, fallbackMs);
      };
      this.voiceDone = finish;
      el.addEventListener("ended", finish);
      el.addEventListener("error", onError);
      el.play().catch(() => {
        // Blocked by autoplay policy (no user gesture yet) rather than a
        // missing/corrupt file — retry on the next gesture instead of
        // leaving this line permanently silent, same as music's unlock path.
        this.armUnlock();
        if (timer) clearTimeout(timer);
        timer = setTimeout(finish, fallbackMs);
      });
    });
  }

  /** Stop any currently playing voice clip and settle its pending promise. */
  stopVoice(): void {
    this.currentVoiceEl?.pause();
    this.currentVoiceEl = null;
    this.voiceDone?.();
    this.unduckMusic();
  }

  private duckMusic(): void {
    if (this.ducked || !this.currentEl) return;
    this.ducked = true;
    this.fadeTo(this.currentEl, MUSIC_VOLUME * MUSIC_DUCK_MULT, undefined, DUCK_FADE_MS, DUCK_FADE_STEPS);
  }

  private unduckMusic(): void {
    if (!this.ducked) return;
    this.ducked = false;
    if (this.currentEl) this.fadeTo(this.currentEl, MUSIC_VOLUME, undefined, DUCK_FADE_MS, DUCK_FADE_STEPS);
  }

  /**
   * Best-effort spoken duration (ms) for a clip: its baked durationMs if known,
   * otherwise a reading-time estimate. Used to pace typewriter text against the
   * voice (see JournalIntroScene) even before the audio has been generated.
   */
  getVoiceDuration(id: string): number {
    const entry = VOICE_CLIPS[id];
    if (!entry) return 1500;
    return entry.durationMs ?? estimateSpeechMs(entry.text);
  }

  private voiceWait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.voiceDone = null;
        this.unduckMusic();
        resolve();
      }, ms);
      this.voiceDone = () => {
        clearTimeout(t);
        this.voiceDone = null;
        this.unduckMusic();
        resolve();
      };
    });
  }

  stopMusic(): void {
    this.current = null;
    this.fadeOutCurrent();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.currentEl) this.currentEl.muted = muted;
    if (this.currentVoiceEl) this.currentVoiceEl.muted = muted;
  }

  dispose(): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    this.stopVoice();
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

  private fadeTo(
    el: HTMLAudioElement,
    target: number,
    onDone?: () => void,
    durationMs = FADE_MS,
    steps = FADE_STEPS,
  ): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    const start = el.volume;
    let step = 0;
    this.fadeTimer = setInterval(() => {
      step++;
      el.volume = start + (target - start) * (step / steps);
      if (step >= steps) {
        if (this.fadeTimer) clearInterval(this.fadeTimer);
        this.fadeTimer = null;
        onDone?.();
      }
    }, durationMs / steps);
  }
}
