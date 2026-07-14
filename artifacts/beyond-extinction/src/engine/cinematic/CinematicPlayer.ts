import type {
  Beat,
  CameraStep,
  ControlStep,
  DespawnStep,
  FadeStep,
  FaceStep,
  GateStep,
  MoveStep,
  ObjectiveStep,
  SayStep,
  SfxStep,
  SpawnStep,
  Step,
  VfxStep,
} from "./CinematicTypes";
import type { CinematicScript } from "./CinematicTypes";

/**
 * CinematicBindings — how a scene renders each step kind. The player is engine-
 * agnostic: it walks the beats and calls these. A binding may return a Promise;
 * the player awaits it only where the beat opts in (`await`/`gate`/`fade`/etc.).
 *
 * Per the script's §7 rule, an unimplemented sfx/vfx/anim id should DOWNGRADE
 * (log + best effort), never throw — so the beat always advances.
 */
export interface CinematicBindings {
  fade(step: FadeStep): Promise<void> | void;
  control(step: ControlStep): void;
  camera(step: CameraStep): void;
  /** Show the line (subtitle + optional VO); resolve when it's had its beat. */
  say(step: SayStep): Promise<void> | void;
  objective(step: ObjectiveStep): void;
  face(step: FaceStep): void;
  /** Play a one-shot/loop on an actor; resolve when done (for `await`). */
  anim(step: import("./CinematicTypes").AnimStep): Promise<void> | void;
  move(step: MoveStep): Promise<void> | void;
  spawn(step: SpawnStep): void;
  despawn(step: DespawnStep): void;
  /** Block until the player satisfies the gate (or it auto-passes / fails). */
  gate(step: GateStep): Promise<void>;
  sfx(step: SfxStep): void;
  vfx(step: VfxStep): void;
  wait(seconds: number): Promise<void>;
  /** True once the scene is torn down — the player bails cleanly. */
  isDisposed(): boolean;
  /** Fired at the start of every beat (checkpoint keys, debug, autosave). */
  onBeat?(beat: Beat): void;
}

/**
 * CinematicPlayer — executes a scene's beats/steps in order against a set of
 * bindings. Sequential and cancellable: it checks `isDisposed()` between steps
 * so a scene teardown mid-cutscene unwinds without dangling timers.
 */
export class CinematicPlayer {
  constructor(
    private readonly script: CinematicScript,
    private readonly bindings: CinematicBindings,
  ) {}

  /** Play one scene by id. Resolves when the last beat finishes (or on dispose). */
  async playScene(sceneId: string): Promise<void> {
    const scene = this.script.scenes.find((s) => s.id === sceneId);
    if (!scene) {
      console.warn(`[cinematic] unknown scene "${sceneId}"`);
      return;
    }
    for (const beat of scene.beats) {
      if (this.bindings.isDisposed()) return;
      this.bindings.onBeat?.(beat);
      for (const step of beat.steps) {
        if (this.bindings.isDisposed()) return;
        try {
          await this.runStep(step);
        } catch (err) {
          // A single misbehaving binding must not abort the whole cutscene.
          console.warn(`[cinematic] step ${step.kind} failed:`, err);
        }
      }
    }
  }

  private async runStep(step: Step): Promise<void> {
    const b = this.bindings;
    switch (step.kind) {
      case "fade":
        await b.fade(step);
        break;
      case "wait":
        await b.wait(step.duration ?? 0);
        break;
      case "say":
        await b.say(step);
        break;
      case "control":
        b.control(step);
        break;
      case "camera":
        b.camera(step);
        break;
      case "objective":
        b.objective(step);
        break;
      case "face":
        b.face(step);
        break;
      case "spawn":
        b.spawn(step);
        break;
      case "despawn":
        b.despawn(step);
        break;
      case "sfx":
        b.sfx(step);
        break;
      case "vfx":
        b.vfx(step);
        break;
      case "gate":
        await b.gate(step);
        break;
      case "anim": {
        const p = b.anim(step);
        if (step.await && p) await p;
        break;
      }
      case "move": {
        const p = b.move(step);
        if (step.await && p) await p;
        break;
      }
      default: {
        // Exhaustiveness guard — a new step kind should surface loudly in dev.
        const _never: never = step;
        console.warn("[cinematic] unhandled step", _never);
      }
    }
  }
}
