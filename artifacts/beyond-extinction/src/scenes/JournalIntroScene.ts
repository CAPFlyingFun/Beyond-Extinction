import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { VOICE_CLIPS } from "../data/voiceClips";
import { createPrologueScene } from "./PrologueCafeteriaScene";

/**
 * "Entry zero": a black page where Jack's journal narration types itself out in
 * sync with his voice-over, before the Lab Prologue opens. Deliberately tiny —
 * no 3D, just a black scene behind a full-screen text overlay — so it reads as
 * the cold open of an interactive audiobook. New Game routes here first (see
 * MainMenuScene), then this scene hands off to the prologue.
 */
const JOURNAL_CLIPS = ["intro_01", "intro_02"] as const;

class JournalIntroScene implements IScene {
  readonly name = "journal-intro";
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

  private disposed = false;
  private root?: HTMLDivElement;
  private textEl?: HTMLDivElement;
  private typeRaf: number | null = null;

  constructor(private ctx: SceneContext) {}

  enter(): void {
    this.scene.background = new THREE.Color(0x05070c);

    const root = document.createElement("div");
    root.className = "be-journal";
    const text = document.createElement("div");
    text.className = "be-journal__text";
    root.appendChild(text);
    this.ctx.uiLayer.appendChild(root);
    this.root = root;
    this.textEl = text;
    requestAnimationFrame(() => root.classList.add("show"));

    this.ctx.input.setEnabled(false);
    // Not awaited: SceneManager must finish enter() and lift the black fade
    // before the narration plays — awaiting here would run it behind the fade.
    void this.playJournal();
  }

  private async playJournal(): Promise<void> {
    // Let the scene's fade-from-black settle before the first line lands.
    await this.wait(1100);
    for (const id of JOURNAL_CLIPS) {
      if (this.disposed) return;
      const clipText = VOICE_CLIPS[id]?.text ?? "";
      // Start revealing, then play the clip: the typewriter tracks the VO's
      // actual playback position (see typewrite), so the words land with the
      // voice. playVoice resolves when the audio ends (or an estimate if it's
      // missing/blocked), which is also when the line has fully typed out.
      this.typewrite(clipText, id);
      await this.ctx.audio.playVoice(id);
      if (this.disposed) return;
      await this.wait(900);
    }
    if (this.disposed) return;
    // Fade the page out ourselves, then hand off to the prologue. (Doing the
    // fade here keeps it above the SceneManager fade layer.)
    this.root?.classList.remove("show");
    await this.wait(900);
    if (this.disposed) return;
    this.ctx.scenes.goTo(createPrologueScene);
  }

  /**
   * Reveal `text` in sync with the voice clip `id`. Each frame the revealed
   * character count tracks the audio's real playback fraction (currentTime /
   * duration), so the words match what's being said. The reveal is scaled to
   * finish at ~92% of the clip so the last word lands a hair before the voice
   * trails off. If the audio isn't actually playing yet (or is missing/blocked),
   * it falls back to the clip's estimated duration for pacing.
   */
  private typewrite(text: string, id: string): void {
    if (this.typeRaf !== null) cancelAnimationFrame(this.typeRaf);
    const el = this.textEl;
    if (!el) return;
    el.textContent = "";
    const len = Math.max(text.length, 1);
    const LEAD = 0.92; // finish typing at 92% of the clip
    const fallbackMs = Math.max(this.ctx.audio.getVoiceDuration(id), 1);
    const startPerf = performance.now();
    // Monotonic: the reveal only ever grows, so the brief handoff from the
    // fallback timer to real audio playback can never un-type a character.
    let revealed = 0;
    const tick = () => {
      if (this.disposed) return;
      const pb = this.ctx.audio.getVoicePlayback();
      const frac =
        pb.active && pb.duration > 0
          ? pb.currentTime / (pb.duration * LEAD)
          : (performance.now() - startPerf) / (fallbackMs * LEAD);
      const shown = Math.max(revealed, Math.min(1, frac));
      revealed = shown;
      el.textContent = text.slice(0, Math.round(shown * len));
      if (shown < 1) {
        this.typeRaf = requestAnimationFrame(tick);
      } else {
        el.textContent = text;
        this.typeRaf = null;
      }
    };
    tick();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  update(): void {}

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    if (this.typeRaf !== null) cancelAnimationFrame(this.typeRaf);
    this.typeRaf = null;
    this.ctx.audio.stopVoice();
    this.root?.remove();
    this.scene.clear();
  }
}

export const createJournalIntroScene: SceneFactory = (ctx) =>
  new JournalIntroScene(ctx);
