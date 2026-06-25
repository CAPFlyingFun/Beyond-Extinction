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
  private typeTimer: ReturnType<typeof setInterval> | null = null;

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
      this.typewrite(clipText, this.ctx.audio.getVoiceDuration(id));
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
   * Reveal `text` one character at a time across ~70% of the spoken duration so
   * the line finishes a beat before the voice does. Interval is clamped so very
   * short or long lines stay readable.
   */
  private typewrite(text: string, durationMs: number): void {
    if (this.typeTimer) clearInterval(this.typeTimer);
    const el = this.textEl;
    if (!el) return;
    el.textContent = "";
    const interval = THREE.MathUtils.clamp(
      (durationMs * 0.7) / Math.max(text.length, 1),
      16,
      80,
    );
    let i = 0;
    this.typeTimer = setInterval(() => {
      i++;
      el.textContent = text.slice(0, i);
      if (i >= text.length && this.typeTimer) {
        clearInterval(this.typeTimer);
        this.typeTimer = null;
      }
    }, interval);
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
    if (this.typeTimer) clearInterval(this.typeTimer);
    this.typeTimer = null;
    this.ctx.audio.stopVoice();
    this.root?.remove();
    this.scene.clear();
  }
}

export const createJournalIntroScene: SceneFactory = (ctx) =>
  new JournalIntroScene(ctx);
