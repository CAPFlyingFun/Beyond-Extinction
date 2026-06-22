import * as THREE from "three";
import type { Renderer } from "./Renderer";
import type { InputManager } from "./InputManager";
import type { DialogueManager } from "./DialogueManager";
import type { QuestManager } from "./QuestManager";
import type { AudioManager } from "./AudioManager";
import type { Overlays } from "./Overlays";
import type { SceneManager } from "./SceneManager";

/**
 * Shared services handed to every scene. Scene-based (not chapter-based) so the
 * game can scale to hundreds of distinct scenes that each own their own world.
 */
export interface SceneContext {
  renderer: Renderer;
  input: InputManager;
  dialogue: DialogueManager;
  quest: QuestManager;
  audio: AudioManager;
  overlays: Overlays;
  scenes: SceneManager;
  uiLayer: HTMLElement;
}

export type SceneFactory = (ctx: SceneContext) => IScene;

export interface IScene {
  readonly name: string;
  /** The Three.js scene graph this scene renders. */
  readonly scene: THREE.Scene;
  /** The active camera for this scene. */
  readonly camera: THREE.Camera;

  /** Called once when the scene becomes active. May be async to load assets. */
  enter(): Promise<void> | void;
  /** Per-frame update. dt = seconds since last frame, elapsed = total seconds. */
  update(dt: number, elapsed: number): void;
  /** Called on window resize. */
  resize(width: number, height: number): void;
  /** Tear down listeners, geometry, DOM, etc. */
  dispose(): void;
}
