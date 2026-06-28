import * as THREE from "three";

export interface NavigatorOptions {
  /** World units per second. */
  speed: number;
  /** Distance at which the actor is considered to have arrived. */
  arriveDistance?: number;
  /**
   * Optional per-step collision resolver (e.g. slide-along-walls against
   * scene colliders). Given the current XZ and a desired next XZ, returns
   * the XZ actually reached this step.
   */
  resolveMove?: (
    curX: number,
    curZ: number,
    nextX: number,
    nextZ: number,
  ) => { x: number; z: number };
}

/**
 * Minimal reusable ground-plane auto-walker: steers an Object3D toward a
 * target XZ point at a constant speed, optionally sliding around colliders
 * via resolveMove, and fires a callback on arrival. Jack's tap-to-walk and
 * Sarah's scripted moves both reduce to "an actor walking to a point," so
 * they share this one stepping implementation instead of each scene
 * hand-rolling its own — and the same Navigator drops in for any future
 * companion/NPC that needs to walk somewhere.
 */
export class Navigator {
  private target: THREE.Vector3 | null = null;
  private onArrive: (() => void) | null = null;

  constructor(
    private readonly actor: THREE.Object3D,
    private readonly opts: NavigatorOptions,
  ) {}

  /** Starts walking toward `target`; `onArrive` fires once, on arrival. */
  goTo(target: THREE.Vector3, onArrive?: () => void): void {
    this.target = target.clone();
    this.onArrive = onArrive ?? null;
  }

  /** Cancels any in-progress walk without firing `onArrive`. */
  stop(): void {
    this.target = null;
    this.onArrive = null;
  }

  /** Live-adjust the walk speed (e.g. a slow scripted stroll vs. normal pace). */
  setSpeed(speed: number): void {
    this.opts.speed = speed;
  }

  get isMoving(): boolean {
    return this.target !== null;
  }

  /** Steps the actor one frame. Returns true if it actually moved. */
  update(dt: number): boolean {
    if (!this.target) return false;
    const to = new THREE.Vector3().subVectors(this.target, this.actor.position);
    to.y = 0;
    const arriveDistance = this.opts.arriveDistance ?? 0.6;
    if (to.length() <= arriveDistance) {
      this.arrive();
      return false;
    }

    to.normalize();
    const step = this.opts.speed * dt;
    const nextX = this.actor.position.x + to.x * step;
    const nextZ = this.actor.position.z + to.z * step;
    const resolved = this.opts.resolveMove
      ? this.opts.resolveMove(this.actor.position.x, this.actor.position.z, nextX, nextZ)
      : { x: nextX, z: nextZ };

    const moved = Math.hypot(
      resolved.x - this.actor.position.x,
      resolved.z - this.actor.position.z,
    );
    this.actor.position.x = resolved.x;
    this.actor.position.z = resolved.z;
    this.actor.rotation.y = Math.atan2(to.x, to.z);

    // A prop fully blocks the straight path — abandon rather than grinding
    // against it forever (no onArrive; the player can tap again).
    if (moved < step * 0.05) {
      this.stop();
      return false;
    }
    return true;
  }

  private arrive(): void {
    this.target = null;
    const cb = this.onArrive;
    this.onArrive = null;
    cb?.();
  }
}
