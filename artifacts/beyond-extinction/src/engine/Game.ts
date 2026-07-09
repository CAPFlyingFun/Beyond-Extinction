import { Renderer } from "./Renderer";
import { InputManager } from "./InputManager";
import { DialogueManager } from "./DialogueManager";
import { QuestManager } from "./QuestManager";
import { AudioManager } from "./AudioManager";
import { Overlays } from "./Overlays";
import { SceneManager } from "./SceneManager";
import { DevPortal } from "./DevPortal";
import { MarkerEditor } from "./MarkerEditor";
import { MarkerStore } from "./MarkerStore";
import { AnimationEditor } from "./AnimationEditor";
import { AnimStore } from "./AnimStore";
import { DevAccess } from "./DevAccess";
import { createChapterOneScene } from "../scenes/ChapterOnePlaceholderScene";
import type { SceneContext, SceneFactory } from "./IScene";

/**
 * Top-level game bootstrap. Wires the renderer, shared managers, and DOM UI
 * layer, then runs a single requestAnimationFrame loop driving the active scene.
 */
export class Game {
  readonly renderer: Renderer;
  readonly input: InputManager;
  readonly dialogue: DialogueManager;
  readonly quest: QuestManager;
  readonly audio: AudioManager;
  readonly overlays: Overlays;
  readonly scenes: SceneManager;
  private readonly devPortal: DevPortal;
  private readonly markerEditor: MarkerEditor;
  private readonly animEditor: AnimationEditor;

  private readonly uiLayer: HTMLElement;
  private rafId = 0;
  private resizeRaf = 0;
  private resizeSettleTimer = 0;
  private running = false;
  private lastTime = 0;
  private elapsed = 0;

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);

    this.uiLayer = document.createElement("div");
    this.uiLayer.id = "be-ui-layer";
    container.appendChild(this.uiLayer);

    this.input = new InputManager(this.renderer.domElement, this.uiLayer);
    this.dialogue = new DialogueManager(this.uiLayer);
    this.quest = new QuestManager(this.uiLayer);
    this.audio = new AudioManager();
    this.overlays = new Overlays(this.uiLayer);
    this.scenes = new SceneManager();

    // In-app Marker Editor (ARK-style), driven by its own fly camera while open.
    this.markerEditor = new MarkerEditor({
      getActive: () => {
        const a = this.scenes.active;
        return a ? { scene: a.scene, camera: a.camera, name: a.name } : null;
      },
      domElement: this.renderer.domElement,
      uiLayer: this.uiLayer,
      input: this.input,
      onOpenChange: (open) => this.devPortal.setSuspended(open),
      playSfx: (n) => this.audio.playSfx(n),
      showToast: (m) => this.overlays.showToast(m),
    });
    // In-app Animation Editor (bones + keyframes) — its own turntable scene.
    this.animEditor = new AnimationEditor({
      uiLayer: this.uiLayer,
      domElement: this.renderer.domElement,
      input: this.input,
      onOpenChange: (open) => this.devPortal.setSuspended(open),
      playSfx: (n) => this.audio.playSfx(n),
      showToast: (m) => this.overlays.showToast(m),
    });
    // Preload the baked marker + animation layouts so scenes recall them on enter.
    void MarkerStore.load();
    void AnimStore.load();

    // Hidden dev gate: press-and-hold 10s anywhere → PIN → Dev menu.
    this.devPortal = new DevPortal({
      onMarkerEditor: () => this.markerEditor.toggle(),
      onAnimationEditor: () => this.animEditor.toggle(),
      onSkipToIsland: () => this.skipToIsland(),
      showToast: (m) => this.overlays.showToast(m),
    });
    // The inventory's DEV tab opens the same PIN gate directly (no 10s hold).
    DevAccess.open = () => this.devPortal.requestUnlock();

    const ctx: SceneContext = {
      renderer: this.renderer,
      input: this.input,
      dialogue: this.dialogue,
      quest: this.quest,
      audio: this.audio,
      overlays: this.overlays,
      scenes: this.scenes,
      uiLayer: this.uiLayer,
    };
    this.scenes.bind(ctx, this.overlays);

    // Mobile browsers report the final viewport size a beat *after* the
    // resize/orientationchange event fires, so reading dimensions synchronously
    // in the handler can pick up stale (pre-rotation) values. We coalesce every
    // resize signal into a single rAF-aligned sync and re-sync once more after
    // the layout settles, so the drawing buffer always ends up matching the
    // real viewport. visualViewport (when present) is the most reliable
    // orientation-change signal on iOS.
    window.addEventListener("resize", this.scheduleResize);
    window.addEventListener("orientationchange", this.scheduleResize);
    window.visualViewport?.addEventListener("resize", this.scheduleResize);
  }

  private scheduleResize = () => {
    cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = requestAnimationFrame(this.applyResize);
    window.clearTimeout(this.resizeSettleTimer);
    this.resizeSettleTimer = window.setTimeout(this.applyResize, 300);
  };

  private applyResize = () => {
    this.renderer.resize();
    this.scenes.resize(this.renderer.width, this.renderer.height);
    this.markerEditor.resize(this.renderer.width, this.renderer.height);
    this.animEditor.resize(this.renderer.width, this.renderer.height);
  };

  async start(initial: SceneFactory): Promise<void> {
    // Dev shortcut: `?skip=island` boots straight to the beach, past the menu +
    // lab prologue (handy for testing the island). Same jump the Dev menu's
    // "Skip to Island" performs.
    const skip = new URLSearchParams(location.search).get("skip") === "island";
    await this.scenes.goTo(skip ? createChapterOneScene : initial, false);
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
  }

  /** Jump to the island, closing any open editor first (Dev menu shortcut). */
  private skipToIsland(): void {
    this.markerEditor.close();
    this.animEditor.close();
    void this.scenes.goTo(createChapterOneScene);
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;
    this.elapsed += dt;
    const elapsed = this.elapsed;
    this.scenes.update(dt, elapsed);
    this.markerEditor.update(dt);
    this.animEditor.update(dt);
    // The Animation Editor renders its OWN scene+camera (a turntable); the
    // Marker Editor drives a fly camera over the live scene; otherwise the
    // active scene renders with its own camera.
    const animView = this.animEditor.overrideView();
    if (animView) {
      this.renderer.render(animView.scene, animView.camera);
      return;
    }
    const active = this.scenes.active;
    if (active) {
      const cam = this.markerEditor.overrideCamera() ?? active.camera;
      this.renderer.render(active.scene, cam);
    }
  };

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.scheduleResize);
    window.removeEventListener("orientationchange", this.scheduleResize);
    window.visualViewport?.removeEventListener("resize", this.scheduleResize);
    cancelAnimationFrame(this.resizeRaf);
    window.clearTimeout(this.resizeSettleTimer);
    this.input.dispose();
    this.dialogue.dispose();
    this.quest.dispose();
    this.audio.dispose();
    this.overlays.dispose();
    this.markerEditor.close();
    this.animEditor.close();
    this.devPortal.dispose();
    this.renderer.dispose();
  }
}
