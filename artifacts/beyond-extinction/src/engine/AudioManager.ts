import { assetUrl } from "./assets";
import { VOICE_CLIPS } from "../data/voiceClips";

/**
 * Name → file lookups. Entries without a mapped file are silently skipped
 * (same optional-asset convention as loadModel/loadTexture) so scenes can
 * call playMusic/playSfx with any cue name before the matching asset exists.
 */
const MUSIC_TRACKS: Record<string, string> = {
  "main-theme": "assets/audio/main-theme.mp3",
  "lab-calm": "assets/audio/lab-calm.mp3",
  "lab-suspense": "assets/audio/lab-suspense.mp3",
};

const SFX_TRACKS: Record<string, string> = {
  "coffee-pour": "assets/audio/coffee-pour.mp3",
  alarm: "assets/audio/alarm.mp3",
  "vortex-open": "assets/audio/vortex-open.mp3",
  "vortex-pull": "assets/audio/vortex-pull.mp3",
  // Prologue interaction cues (scene cue name → uploaded file). The scene names
  // predate the files, so the mapping bridges them: badge scan accept/deny, the
  // knock on the lab door, and the badge/item pickup.
  "badge-accept": "assets/audio/badge-ok.mp3",
  "buzz-deny": "assets/audio/badge-deny.mp3",
  "door-knock": "assets/audio/door-knock.mp3",
  "badge-pickup": "assets/audio/item-pickup.mp3",
};

// Base music level. Kept deliberately low so the score is atmosphere, not a
// foreground element — it should never fight the SFX or (especially) dialogue.
const MUSIC_VOLUME = 0.35;
// While a voice clip is speaking, music ducks FAR under the voice — down to a
// barely-there presence so the dialogue is always clearly intelligible and the
// bed never competes with what Jack says.
const MUSIC_DUCK = 0.07;
const SFX_VOLUME = 0.7;
// Voice plays at full level so it sits clearly above the ducked music bed.
const VOICE_VOLUME = 1.0;
// Default fade (stopping music, generic): quick.
const FADE_MS = 800;
// Ducking under a voice line: a fairly quick dip so the bed gets out of the way
// as Jack starts, then a slow, gentle swell back once he's done — so the music
// returns smoothly instead of snapping up between/after lines.
const DUCK_FADE_MS = 900;
const UNDUCK_FADE_MS = 1800;
// When a line begins MID-crossfade, the outgoing track's tail is faded out this
// fast so leftover music doesn't pile on top of the ducked bed under the voice.
const DUCK_KILL_MS = 400;
// Music track changes crossfade slowly for a smooth, cinematic blend.
const MUSIC_FADE_MS = 4000;
// Volume is stepped on this interval; fine-grained so even a 4s fade is smooth.
const FADE_TICK_MS = 40;

// How many sfx can overlap before the oldest is reused (round-robin pool).
const SFX_POOL_SIZE = 4;

// ─── Procedural SFX (Web Audio) ──────────────────────────────────────────────
// Godot's AudioManager SYNTHESIZES its sfx in code (see AudioManager.gd
// _build_sfx) and treats audio files as optional overrides. The web build was
// file-only, so any cue with no mapped file (door slides, power fail/restore,
// the flashlight click, UI select) was a silent no-op — which is why "sound
// effects weren't coming through". This mirrors the Godot synths so those cues
// make sound with no asset, and (like Godot) a mapped file still takes priority.
const SFX_RATE = 44100;

/** Sine tone with a 5 ms attack (anti-click) and exponential decay. */
function tone(freq: number, dur: number, peak: number, decay: number): Float32Array {
  const n = Math.floor(SFX_RATE * dur);
  const atk = Math.floor(SFX_RATE * 0.005);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SFX_RATE;
    let env = Math.exp(-decay * t);
    if (i < atk) env *= i / atk;
    out[i] = Math.sin(2 * Math.PI * freq * t) * peak * env;
  }
  return out;
}

/** Harsh square wave with tremolo — the "access denied" texture. */
function buzz(freq: number, dur: number, peak: number): Float32Array {
  const n = Math.floor(SFX_RATE * dur);
  const atk = Math.floor(SFX_RATE * 0.004);
  const tail = Math.floor(SFX_RATE * 0.02);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SFX_RATE;
    const sq = (freq * t) % 1.0 < 0.5 ? 1.0 : -1.0;
    const trem = 0.6 + 0.4 * Math.sin(2 * Math.PI * 32.0 * t);
    let env = 1.0;
    if (i < atk) env = i / atk;
    else if (i > n - tail) env = (n - i) / tail;
    out[i] = sq * peak * trem * env;
  }
  return out;
}

/** One-pole-lowpassed white noise under a sine swell — pneumatic door hiss.
 *  Uses an index-seeded LCG (no Math.random) so the buffer is deterministic. */
function whoosh(dur: number, peak: number): Float32Array {
  const n = Math.floor(SFX_RATE * dur);
  const out = new Float32Array(n);
  let prev = 0;
  let seed = 0x9e3779b1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const raw = (seed / 0xffffffff) * 2.0 - 1.0;
    prev = prev * 0.9 + raw * 0.1; // soft low-pass
    const env = Math.sin((Math.PI * i) / n); // 0 → 1 → 0 swell
    out[i] = prev * peak * env;
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function silence(dur: number): Float32Array {
  return new Float32Array(Math.floor(SFX_RATE * dur));
}

/** Sample builders, keyed by synth id (ported 1:1 from Godot _build_sfx). */
const SFX_BUILDERS: Record<string, () => Float32Array> = {
  // pickup — single soft sine blip (cup / badge pickup).
  pickup: () => tone(720, 0.09, 0.45, 42),
  // beep_ok — two ascending sine tones G5 → D6 (badge accepted / UI select).
  beep: () => concat(tone(784, 0.08, 0.42, 24), tone(1175, 0.13, 0.42, 18)),
  // buzz_deny — two harsh low square-wave pulses.
  buzz: () => concat(buzz(130, 0.14, 0.36), silence(0.05), buzz(130, 0.17, 0.36)),
  // door — airy filtered-noise whoosh (sliding door open / close).
  door: () => whoosh(0.45, 0.42),
  // door-knock — two low damped thumps.
  knock: () => concat(tone(85, 0.09, 0.85, 55), silence(0.14), tone(78, 0.1, 0.85, 50)),
  // power_on — rising three-note boot chime (power restore).
  power_on: () =>
    concat(tone(392, 0.1, 0.4, 20), tone(523.3, 0.1, 0.4, 20), tone(784, 0.22, 0.42, 12)),
  // power_fail — falling three-note (the inverse) as the mains cut out.
  power_fail: () =>
    concat(tone(784, 0.1, 0.4, 20), tone(523.3, 0.1, 0.42, 22), tone(311.1, 0.32, 0.42, 9)),
  // click — a single sharp high tick for the flashlight toggle.
  click: () => tone(2600, 0.02, 0.5, 240),
};

/** Cue name → synth id. Only cues WITHOUT a mapped file rely on these, but
 *  including the file-backed cues too is harmless (files win in playSfx). */
const PROCEDURAL_SFX: Record<string, string> = {
  "door-open": "door",
  "door-glass": "door",
  "power-restore": "power_on",
  "power-fail": "power_fail",
  "flashlight-click": "click",
  "ui-select": "beep",
  // File-backed cues, kept as an ultimate fallback if the mp3 is ever absent.
  "door-knock": "knock",
  "badge-accept": "beep",
  "buzz-deny": "buzz",
  "badge-pickup": "pickup",
};

// A zero-length silent WAV. Mobile browsers (notably iOS Safari) only let an
// <audio> element play() programmatically — with no user gesture active, e.g.
// mid-cutscene — AFTER it has been play()'d once inside a real gesture. We
// "bless" every reusable element by playing this silent clip on the first tap.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

const UNLOCK_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

/** Rough spoken-duration estimate (ms), used as a fallback when a voice clip
 *  is missing or playback is blocked, so cutscenes keep pacing with subtitles. */
function estimateSpeechMs(text: string): number {
  return Math.max(1500, Math.round(text.length * 65) + 600);
}

/**
 * Plays music/sfx/voice via a FIXED POOL of HTMLAudioElements that are reused
 * (their `src` is swapped) rather than created on demand. This is what makes
 * audio reliable on mobile: scenes start music and narration on enter — often
 * during an automatic scene transition with no user gesture in the moment — and
 * a brand-new `new Audio().play()` would be autoplay-blocked there. Instead we
 * unlock the whole pool on the first interaction, after which every element can
 * play freely. Music cross-fades between two elements; voice is single; sfx use
 * a small round-robin pool. Cue names with no mapped file are a silent no-op.
 */
export class AudioManager {
  private muted = false;
  private current: string | null = null;
  private fadeTimers = new Map<HTMLAudioElement, ReturnType<typeof setInterval>>();
  private ducked = false;
  private unlocked = false;
  private unlockHandler: (() => void) | null = null;

  // Two music elements so an outgoing and incoming track can truly crossfade.
  private readonly musicEls: [HTMLAudioElement, HTMLAudioElement] = [
    new Audio(),
    new Audio(),
  ];
  private currentEl: HTMLAudioElement | null = null;

  // One voice element (only one line speaks at a time).
  private readonly voiceEl = new Audio();
  private voiceDone: (() => void) | null = null;
  private voiceActive = false;

  // Small pool of sfx elements for overlapping one-shots.
  private readonly sfxEls: HTMLAudioElement[] = Array.from(
    { length: SFX_POOL_SIZE },
    () => new Audio(),
  );
  private sfxIdx = 0;

  // Web Audio context + cached synthesized buffers for procedural sfx fallback.
  private sfxCtx: AudioContext | null = null;
  private readonly sfxBuffers = new Map<string, AudioBuffer>();

  constructor() {
    for (const el of this.musicEls) el.loop = true;
    this.bindUnlock();
  }

  /** Every reusable element, so the unlock pass can bless them in one gesture. */
  private reusableEls(): HTMLAudioElement[] {
    return [...this.musicEls, this.voiceEl, ...this.sfxEls];
  }

  /**
   * Arm a one-time first-interaction handler that "blesses" the whole element
   * pool (a silent play()/pause() inside the gesture) so later, gesture-less
   * playback is allowed on mobile. Also resumes whatever music should already
   * be sounding (e.g. the menu theme requested before this first tap).
   */
  private bindUnlock(): void {
    const unlock = () => {
      this.unlocked = true;
      for (const el of this.reusableEls()) {
        if (el === this.currentEl) continue; // resumed below with its real src
        if (!el.src) el.src = SILENT_WAV;
        const blessSrc = el.src;
        el.play()
          .then(() => {
            // Only pause if a real cue didn't claim this element in the same
            // gesture (e.g. a menu sfx) — otherwise we'd cut its audio off.
            if (el.src === blessSrc) el.pause();
          })
          .catch(() => {});
      }
      // Start the current music for real (it was likely autoplay-blocked when
      // the scene requested it before any interaction).
      if (this.currentEl) this.currentEl.play().catch(() => {});
      // Web Audio also needs a gesture: create/resume the context now so the
      // first procedural sfx doesn't start in a suspended (silent) state.
      const ctx = this.ensureSfxCtx();
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
      this.removeUnlock();
    };
    this.unlockHandler = unlock;
    for (const evt of UNLOCK_EVENTS) {
      window.addEventListener(evt, unlock);
    }
  }

  private removeUnlock(): void {
    if (!this.unlockHandler) return;
    for (const evt of UNLOCK_EVENTS) {
      window.removeEventListener(evt, this.unlockHandler);
    }
    this.unlockHandler = null;
  }

  /**
   * Re-arm the first-gesture unlock after a post-unlock play() rejection — a
   * recovery path in case the initial blessing didn't take (some mobile
   * browsers are stricter than others). Re-blessing on the next tap is harmless
   * if the pool was already unlocked.
   */
  private armRetry(): void {
    if (this.unlockHandler) return; // already armed
    this.bindUnlock();
  }

  playMusic(track: string): void {
    if (this.current === track) return;
    this.current = track;

    // Remember which element is fading out so the incoming track uses the OTHER
    // one — a real crossfade rather than one fade clobbering the other.
    const outgoing = this.currentEl;
    this.fadeOutCurrent(MUSIC_FADE_MS);

    const src = MUSIC_TRACKS[track];
    if (!src) {
      console.info(`[Audio] music → ${track} (no track file mapped yet)`);
      return;
    }

    const el = outgoing === this.musicEls[0] ? this.musicEls[1] : this.musicEls[0];
    const existing = this.fadeTimers.get(el);
    if (existing) {
      clearInterval(existing);
      this.fadeTimers.delete(el);
    }
    el.src = assetUrl(src);
    el.loop = true;
    el.currentTime = 0;
    el.volume = 0;
    el.muted = this.muted;
    el.play()
      .then(() => console.info(`[Audio] music \u25b6 ${track}`))
      .catch((err) => {
        // Before the first interaction this is expected; the unlock handler
        // will resume `currentEl` on the first tap.
        console.warn(
          `[Audio] music blocked: ${track} (${(err as DOMException)?.name ?? err}) \u2014 will start on first interaction`,
        );
        this.armRetry();
      });
    this.currentEl = el;
    this.fadeTo(el, this.ducked ? MUSIC_DUCK : MUSIC_VOLUME, MUSIC_FADE_MS);
  }

  playSfx(name: string): void {
    if (this.muted) return;
    const src = SFX_TRACKS[name];
    if (!src) {
      // No mapped file — fall back to a synthesized cue (Godot parity) so door
      // slides, power fail/restore, the flashlight click and UI select still
      // sound. Only a truly unknown cue is a silent no-op.
      if (!this.playProceduralSfx(name)) {
        console.info(`[Audio] sfx → ${name} (no file and no procedural synth)`);
      }
      return;
    }
    const el = this.sfxEls[this.sfxIdx];
    this.sfxIdx = (this.sfxIdx + 1) % this.sfxEls.length;
    el.src = assetUrl(src);
    el.currentTime = 0;
    el.volume = SFX_VOLUME;
    el.play().catch(() => {});
  }

  /** Lazily create the Web Audio context used for synthesized sfx. */
  private ensureSfxCtx(): AudioContext | null {
    if (this.sfxCtx) return this.sfxCtx;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.sfxCtx = new Ctor();
    } catch {
      this.sfxCtx = null;
    }
    return this.sfxCtx;
  }

  /**
   * Synthesize and play a procedural sfx cue. Returns false when the cue has no
   * synth (so the caller can log a real no-op) or Web Audio is unavailable.
   * Buffers are built once and cached, mirroring Godot's _build_sfx.
   */
  private playProceduralSfx(name: string): boolean {
    const synthId = PROCEDURAL_SFX[name];
    if (!synthId) return false;
    const ctx = this.ensureSfxCtx();
    if (!ctx) return false;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    let buf = this.sfxBuffers.get(synthId);
    if (!buf) {
      const samples = SFX_BUILDERS[synthId]();
      buf = ctx.createBuffer(1, samples.length, SFX_RATE);
      buf.getChannelData(0).set(samples);
      this.sfxBuffers.set(synthId, buf);
    }
    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = SFX_VOLUME;
    source.connect(gain).connect(ctx.destination);
    source.start();
    return true;
  }

  /**
   * Play a pre-baked voice-over clip by manifest id. Resolves when the clip
   * finishes. If the file is missing or playback is blocked, resolves after an
   * estimated reading time so a cutscene keeps advancing (with subtitles) even
   * before the audio has been generated. Only one voice plays at a time.
   */
  playVoice(id: string): Promise<void> {
    this.stopVoice();
    const entry = VOICE_CLIPS[id];
    const fallbackMs = entry
      ? entry.durationMs ?? estimateSpeechMs(entry.text)
      : 1500;
    if (!entry) {
      console.info(`[Audio] voice → ${id} (no clip in manifest)`);
      return this.voiceWait(fallbackMs);
    }
    if (this.muted) return this.voiceWait(fallbackMs);

    const el = this.voiceEl;
    el.src = assetUrl(entry.src);
    el.currentTime = 0;
    el.volume = VOICE_VOLUME;
    el.muted = this.muted;
    this.voiceActive = true;

    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (this.voiceDone !== finish) return;
        this.voiceDone = null;
        this.voiceActive = false;
        if (timer) clearTimeout(timer);
        el.removeEventListener("ended", finish);
        el.removeEventListener("error", onError);
        el.pause();
        this.duckMusic(false);
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
      el.play()
        .then(() => {
          console.info(`[Audio] voice \u25b6 ${id}`);
          // Guard against a stop/dispose that landed before play() resolved:
          // a stale resolve would otherwise duck the music with no voice
          // playing and leave `ducked` stuck on until the next line finishes.
          if (this.voiceDone === finish && this.voiceActive) {
            this.duckMusic(true);
          }
        })
        .catch((err) => {
          console.warn(
            `[Audio] voice blocked: ${id} (${(err as DOMException)?.name ?? err}) \u2014 subtitle-only timing`,
          );
          this.armRetry();
          if (timer) clearTimeout(timer);
          timer = setTimeout(finish, fallbackMs);
        });
    });
  }

  /** Stop any currently playing voice clip and settle its pending promise. */
  stopVoice(): void {
    this.voiceActive = false;
    this.voiceEl.pause();
    this.voiceDone?.();
  }

  /**
   * Duck the music bed far down while a voice line is speaking, then gently
   * swell it back once the line finishes — so narration always sits clearly on
   * top of the score. No-op when no music is playing.
   */
  private duckMusic(on: boolean): void {
    this.ducked = on;
    if (on) {
      // If a line starts mid-crossfade, the OUTGOING track is still audible and
      // isn't the element we duck (currentEl). Fade its tail out fast so the
      // leftover music doesn't pile on top of the ducked bed — and so the bed
      // level stays constant for the whole line instead of dropping mid-sentence
      // as the crossfade finishes (which read as an abrupt shift).
      for (const el of this.musicEls) {
        if (el !== this.currentEl && this.fadeTimers.has(el)) {
          this.fadeTo(el, 0, DUCK_KILL_MS, () => el.pause());
        }
      }
    }
    if (!this.currentEl) return;
    this.fadeTo(
      this.currentEl,
      on ? MUSIC_DUCK : MUSIC_VOLUME,
      on ? DUCK_FADE_MS : UNDUCK_FADE_MS,
    );
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

  /**
   * Live playback position of the currently speaking voice clip, for syncing
   * on-screen text (the journal typewriter) to the actual audio rather than a
   * precomputed estimate. `active` is false when no real audio is playing (clip
   * missing/blocked, or muted) so callers can fall back to timed pacing.
   */
  getVoicePlayback(): { currentTime: number; duration: number; active: boolean } {
    const el = this.voiceEl;
    const duration = Number.isFinite(el.duration) ? el.duration : 0;
    return {
      currentTime: el.currentTime,
      duration,
      active: this.voiceActive && !el.paused && duration > 0,
    };
  }

  private voiceWait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.voiceDone = null;
        resolve();
      }, ms);
      this.voiceDone = () => {
        clearTimeout(t);
        this.voiceDone = null;
        resolve();
      };
    });
  }

  stopMusic(): void {
    this.current = null;
    // Slow tail rather than a quick cut — an abrupt stop reads as a glitch, a
    // long fade reads as a scene ending.
    this.fadeOutCurrent(MUSIC_FADE_MS);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const el of this.musicEls) el.muted = muted;
    this.voiceEl.muted = muted;
    for (const el of this.sfxEls) el.muted = muted;
  }

  dispose(): void {
    // Pause every element that is mid-fade (an in-progress crossfade has BOTH
    // the outgoing and incoming track here) — clearing the timers alone would
    // skip their onDone pause and leave an outgoing track audible after dispose.
    for (const [el, timer] of this.fadeTimers) {
      clearInterval(timer);
      el.pause();
    }
    this.fadeTimers.clear();
    this.removeUnlock();
    this.stopVoice();
    for (const el of this.musicEls) el.pause();
    for (const el of this.sfxEls) el.pause();
    this.currentEl = null;
    this.current = null;
    if (this.sfxCtx) {
      this.sfxCtx.close().catch(() => {});
      this.sfxCtx = null;
      this.sfxBuffers.clear();
    }
  }

  private fadeOutCurrent(durationMs: number = FADE_MS): void {
    const el = this.currentEl;
    if (!el) return;
    this.currentEl = null;
    this.fadeTo(el, 0, durationMs, () => el.pause());
  }

  /**
   * Fade one element's volume to `target` over `durationMs`. Each element gets
   * its own interval (keyed in `fadeTimers`) so an outgoing track and an
   * incoming track can fade *simultaneously* — a real crossfade — instead of
   * one fade cancelling the other. Volume is stepped every FADE_TICK_MS so even
   * a multi-second music crossfade stays smooth.
   */
  private fadeTo(
    el: HTMLAudioElement,
    target: number,
    durationMs: number = FADE_MS,
    onDone?: () => void,
  ): void {
    const existing = this.fadeTimers.get(el);
    if (existing) clearInterval(existing);
    const start = el.volume;
    const steps = Math.max(1, Math.round(durationMs / FADE_TICK_MS));
    let step = 0;
    const timer = setInterval(() => {
      step++;
      const v = start + (target - start) * (step / steps);
      el.volume = Math.min(1, Math.max(0, v));
      if (step >= steps) {
        clearInterval(timer);
        this.fadeTimers.delete(el);
        onDone?.();
      }
    }, FADE_TICK_MS);
    this.fadeTimers.set(el, timer);
  }
}
