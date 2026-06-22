import { Renderer } from "./Renderer";
import { InputManager } from "./InputManager";
import { DialogueManager } from "./DialogueManager";
import { QuestManager } from "./QuestManager";
import { AudioManager } from "./AudioManager";
import { Overlays } from "./Overlays";
import { SceneManager } from "./SceneManager";
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

  private readonly uiLayer: HTMLElement;
  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private elapsed = 0;

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);

    this.uiLayer = document.createElement("div");
    this.uiLayer.id = "be-ui-layer";
    container.appendChild(this.uiLayer);

    this.input = new InputManager(this.renderer.domElement);
    this.input.mountTouchControls(this.uiLayer);
    this.dialogue = new DialogueManager(this.uiLayer);
    this.quest = new QuestManager(this.uiLayer);
    this.audio = new AudioManager();
    this.overlays = new Overlays(this.uiLayer);
    this.scenes = new SceneManager();

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

    window.addEventListener("resize", this.onResize);
  }

  private onResize = () => {
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
    window.removeEventListener("resize", this.onResize);
    this.input.dispose();
    this.dialogue.dispose();
    this.quest.dispose();
    this.audio.dispose();
    this.overlays.dispose();
    this.renderer.dispose();
  }
}
