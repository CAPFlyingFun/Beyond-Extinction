import * as THREE from "three";

/**
 * Interactable — the web mirror of the Godot project's reusable
 * `InteractableArea3D` base. ONE class drives every "press USE" object in the
 * prologue: the coffee cart, the badge pickup, and the Lab Seven glass door.
 * Each instance wraps a world object, an exported prompt string and interact
 * range, and a single `interacted` callback; the object's own logic lives in
 * that callback, so the base stays generic.
 *
 * This is deliberately SEPARATE from {@link ProximityDoor}: proximity doors open
 * on presence with no input, interactables require a USE press. The two systems
 * are never merged — same as the Godot design.
 *
 * The host scene owns the crosshair/prompt UI and the per-frame "who is the
 * player looking at, in range?" test; it drives one Interactable at a time via
 * {@link inRange}, {@link promptText} and {@link interact}.
 */
export interface InteractableOptions {
  /** The world object whose position gates range (its world XZ is measured). */
  object: THREE.Object3D;
  /** Prompt shown when the player is in the zone. String or lazy getter. */
  promptText: string | (() => string);
  /** How close (world units, horizontal) the player must be to interact. */
  interactRange: number;
  /** Fired when the player presses USE while in range and enabled. */
  interacted: () => void;
  /** Optional gate — when it returns false the interactable is inert (no prompt). */
  isEnabled?: () => boolean;
}

export class Interactable {
  private readonly _worldPos = new THREE.Vector3();

  constructor(private readonly opts: InteractableOptions) {}

  /** The wrapped world object. */
  get object(): THREE.Object3D {
    return this.opts.object;
  }

  /** Whether this interactable is currently live (default: always). */
  get enabled(): boolean {
    return this.opts.isEnabled ? this.opts.isEnabled() : true;
  }

  /** The current USE prompt label. */
  get promptText(): string {
    const p = this.opts.promptText;
    return typeof p === "function" ? p() : p;
  }

  /** This object's current world position (kept fresh each call). */
  worldPosition(out?: THREE.Vector3): THREE.Vector3 {
    const v = out ?? this._worldPos;
    return this.opts.object.getWorldPosition(v);
  }

  /** True if `from` is within interactRange on the horizontal (XZ) plane. */
  inRange(from: THREE.Vector3): boolean {
    if (!this.enabled) return false;
    this.opts.object.getWorldPosition(this._worldPos);
    const dx = this._worldPos.x - from.x;
    const dz = this._worldPos.z - from.z;
    return Math.hypot(dx, dz) <= this.opts.interactRange;
  }

  /** Fire the `interacted` callback (the object's own logic). */
  interact(): void {
    if (this.enabled) this.opts.interacted();
  }
}
