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
import { TerrainEditor } from "./TerrainEditor";
import { TerrainEdit } from "./TerrainEdit";
import { DevAccess } from "./DevAccess";
import {
  createAntScaleScene,
  createKauaiStreamScene,
  createKauaiArrivalScene,
} from "../scenes/KauaiStreamScene";
import { createWaterLabScene } from "../scenes/WaterLabScene";
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
  private readonly terrainEditor: TerrainEditor;

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
    // In-app Terrain Editor (island sculpt brushes) — shares the fly-cam deps.
    this.terrainEditor = new TerrainEditor({
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
    // Preload the baked marker + animation layouts + terrain edits.
    void MarkerStore.load();
    void AnimStore.load();
    TerrainEdit.load();

    // Hidden dev gate: press-and-hold 10s anywhere → PIN → Dev menu.
    this.devPortal = new DevPortal({
      onMarkerEditor: () => this.markerEditor.toggle(),
      onAnimationEditor: () => this.animEditor.toggle(),
      onTerrainEditor: () => this.terrainEditor.toggle(),
      onSkipToIsland: () => this.skipToIsland(),
      onKauaiStream: () => this.skipToKauai(),
      onWaterLab: () => this.skipToWaterLab(),
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
    this.terrainEditor.resize(this.renderer.width, this.renderer.height);
  };

  async start(initial: SceneFactory): Promise<void> {
    // Dev shortcut: `?skip=island` boots straight to the beach, past the menu +
    // lab prologue (handy for testing the island). Gated to non-production so a
    // player on the live site can't URL-skip the intro; on the deployed build
    // the same jump is still reachable through the PIN-gated Dev menu's
    // "Skip to Island".
    const params = import.meta.env.DEV ? new URLSearchParams(location.search) : null;
    const skipTo = params?.get("skip") ?? null;
    const sceneTo = params?.get("scene") ?? null;
    // `?scene=antscale` IS NOT DEV-GATED, deliberately and temporarily. It is a
    // diagnostic that has to be looked at on a phone, on the deployed build,
    // and the whole point of it is a judgement made by eye on a real device.
    // The cost is that it is also an intro skip, which is exactly what the gate
    // above exists to prevent — so this must be re-gated or removed before this
    // branch goes anywhere near a release.
    const antScale =
      new URLSearchParams(location.search).get("scene") === "antscale";
    const first = antScale
      ? createAntScaleScene // ?scene=antscale → the island from 10 mm up
      : sceneTo === "waterlab"
        ? createWaterLabScene // ?scene=waterlab → isolated 3×3 water R&D testbed
        : skipTo === "island"
          ? createKauaiArrivalScene // ?skip=island → the Chapter-Two arrival cinematic
          : skipTo === "kauai"
            ? createKauaiStreamScene // ?skip=kauai → straight into first person
            : initial;

    await this.scenes.goTo(first, false);
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
  }

  /** Jump to the island arrival (Kauaʻi Day-One cinematic), closing any open
   *  editor first (Dev menu shortcut). */
  private skipToIsland(): void {
    this.markerEditor.close();
    this.animEditor.close();
    this.terrainEditor.close();
    void this.scenes.goTo(createKauaiArrivalScene);
  }

  /** Jump to the Kauaʻi streaming-terrain test scene (Dev menu shortcut). */
  private skipToKauai(): void {
    this.markerEditor.close();
    this.animEditor.close();
    this.terrainEditor.close();
    void this.scenes.goTo(createKauaiStreamScene);
  }

  /** Jump to the WaterLab 3×3 water R&D testbed (Dev menu shortcut). */
  private skipToWaterLab(): void {
    this.markerEditor.close();
    this.animEditor.close();
    this.terrainEditor.close();
    void this.scenes.goTo(createWaterLabScene);
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
    this.terrainEditor.update(dt);
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
      const cam =
        this.terrainEditor.overrideCamera() ?? this.markerEditor.overrideCamera() ?? active.camera;
      this.renderer.render(active.scene, cam);
      active.renderOverlays?.(this.renderer.renderer);
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
    this.terrainEditor.close();
    this.devPortal.dispose();
    this.renderer.dispose();
  }
}
