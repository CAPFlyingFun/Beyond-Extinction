/**
 * Typed model for the engine-neutral cinematic script (BE Ch02–03 and beyond).
 *
 * The JSON is generated from the Markdown by `src/story/parse-script.js` and is
 * marked "do not hand-edit" — so this file only *describes* its shape; it never
 * duplicates content. The CinematicPlayer executes these steps against the game
 * through a CinematicBindings implementation the scene provides.
 *
 * Step vocabulary mirrors §3 of the script. Unknown ids inside sfx/vfx/anim are
 * tolerated at runtime (best-effort / downgrade, never crash) per §7's rule:
 * "downgrade the method, never the beat."
 */

export type FadeTarget = "black" | "white" | "scene";
export type ControlMode = "fp" | "cinematic";
export type BeatMode = "playable" | "cinematic";

export interface CameraTargets {
  primary?: string;
  secondary?: string;
  weight?: number;
}

export interface FadeStep {
  kind: "fade";
  to: FadeTarget;
  duration: number; // seconds
}
export interface ControlStep {
  kind: "control";
  mode?: ControlMode;
  allow?: string[];
  speed_mult?: number;
}
export interface VfxStep {
  kind: "vfx";
  id: string;
  params?: Record<string, unknown>;
}
export interface SfxStep {
  kind: "sfx";
  id: string;
  loop?: boolean;
  params?: Record<string, unknown>;
}
export interface GateStep {
  kind: "gate";
  id: string;
  type: string; // player_look_behind | proximity | timed_jump | timed_duck | timed_action
  target?: string;
  radius?: number;
  window?: number;
  fail?: string;
  optional?: boolean;
}
export interface AnimStep {
  kind: "anim";
  actor: string;
  id: string;
  await?: boolean;
  loop?: boolean;
}
export interface CameraStep {
  kind: "camera";
  moment: string; // establishing | follow | midpoint | orbit | climax
  cut?: boolean;
  targets?: CameraTargets;
}
export interface SayStep {
  kind: "say";
  actor: string; // narrator | jack | sarah
  clip: string;
  text?: string;
  direction?: string; // performance direction (stripped from screen)
}
export interface ObjectiveStep {
  kind: "objective";
  id: string;
  text?: string;
  state: string; // hidden | active | complete
}
export interface FaceStep {
  kind: "face";
  actor: string;
  at: string;
  amount?: number;
}
export interface WaitStep {
  kind: "wait";
  duration: number; // seconds
}
export interface SpawnStep {
  kind: "spawn";
  actor: string;
  at: string; // marker id
}
export interface DespawnStep {
  kind: "despawn";
  actor: string;
  after?: number; // seconds
}
export interface MoveStep {
  kind: "move";
  actor: string;
  to: string; // marker id
  duration?: number;
  await?: boolean;
  mode?: string; // escort | towed | ...
}

export type Step =
  | FadeStep
  | ControlStep
  | VfxStep
  | SfxStep
  | GateStep
  | AnimStep
  | CameraStep
  | SayStep
  | ObjectiveStep
  | FaceStep
  | WaitStep
  | SpawnStep
  | DespawnStep
  | MoveStep;

export interface Beat {
  id: string; // chapter.scene.beat, e.g. "2.3.B" — use as checkpoint key
  mode: BeatMode;
  rig?: string;
  steps: Step[];
  slug?: string;
}

export interface CinematicScene {
  id: string; // ch02_arrival | ch03_chase
  number: number;
  title: string;
  slug?: string;
  beats: Beat[];
}

export interface CinematicScript {
  version: number;
  source: string;
  generated?: string;
  note?: string;
  scenes: CinematicScene[];
}
