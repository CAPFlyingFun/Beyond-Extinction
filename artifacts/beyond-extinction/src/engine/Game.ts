import { Renderer } from "./Renderer";
import { InputManager } from "./InputManager";
import { DialogueManager } from "./DialogueManager";
import { QuestManager } from "./QuestManager";
import { AudioManager } from "./AudioManager";
import { Overlays } from "./Overlays";
import { SceneManager } from "./SceneManager";
import { DevPortal } from "./DevPortal";
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

    // Hidden dev gate: press-and-hold 10s anywhere → PIN → Level Editor.
    this.devPortal = new DevPortal();

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
  };

  async start(initial: SceneFactory): Promise<void> {
    await this.scenes.goTo(initial, false);
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
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
    const active = this.scenes.active;
    if (active) {
      this.renderer.render(active.scene, active.camera);
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
    this.devPortal.dispose();
    this.renderer.dispose();
  }
}
