import * as THREE from "three";

/**
 * ProximityDoor — the web mirror of the Godot project's `ProximityDoor`, a
 * system that is DELIBERATELY separate from {@link Interactable}. A proximity
 * door opens purely on presence (no USE press) and closes again when the subject
 * leaves. The cafeteria and server-room doors use it in auto mode.
 *
 * The same sliding + collision mechanics also back the Lab Seven glass door, but
 * that door runs in MANUAL mode: it never auto-triggers on proximity — the
 * badge {@link Interactable} decides when it opens (permanently). Keeping one
 * door-mechanics class while the badge LOGIC lives in the interactable respects
 * the "do not merge them" rule: the interactable fires, and only then calls
 * {@link openPermanently}.
 */
export interface DoorPanel {
  mesh: THREE.Object3D;
  /** Local offset (world units) applied to the panel when fully open. */
  openOffset: THREE.Vector3;
}

export interface ProximityDoorOptions {
  panels: DoorPanel[];
  /** Auto-open when the subject comes within `triggerRange` of `triggerPos`. */
  auto: boolean;
  /** Door-centre world point for the proximity test (auto mode only). */
  triggerPos?: THREE.Vector3;
  /** Trigger radius in world units (auto mode only). */
  triggerRange?: number;
  /** Slide speed as a fraction/sec of the full travel (1 = ~1s open/close). */
  speed?: number;
  /** Axis-aligned gap footprint (world units) the closed door blocks. */
  gap: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Fired the frame the door starts opening (once per closed→opening edge). */
  onOpenStart?: () => void;
}

export class ProximityDoor {
  /** 0 = fully closed, 1 = fully open. */
  private openness = 0;
  private target = 0;
  private locked = false; // manual doors stay 0 until openPermanently()
  private permanent = false; // once true, never closes again
  private readonly rest: THREE.Vector3[];
  private readonly subjectXZ = new THREE.Vector3();

  constructor(private readonly opts: ProximityDoorOptions) {
    this.rest = opts.panels.map((p) => p.mesh.position.clone());
    if (!opts.auto) this.locked = true;
  }

  /** True while the closed door should still block movement through its gap. */
  get solid(): boolean {
    return this.openness < 0.7;
  }

  get isOpen(): boolean {
    return this.openness > 0.95;
  }

  /** Does the (player-grown) closed footprint contain this XZ point? */
  blocks(x: number, z: number, grow: number): boolean {
    if (!this.solid) return false;
    const g = this.opts.gap;
    return (
      x > g.minX - grow &&
      x < g.maxX + grow &&
      z > g.minZ - grow &&
      z < g.maxZ + grow
    );
  }

  /** Badge-gated open: latch the door open for the rest of the scene. */
  openPermanently(): void {
    this.locked = false;
    this.permanent = true;
    this.target = 1;
  }

  /**
   * Per-frame step. In auto mode the target follows proximity; in manual mode it
   * only moves once {@link openPermanently} has fired. Returns true on the frame
   * the door begins opening from fully closed (so the host can play a hiss).
   */
  update(dt: number, subjectPos: THREE.Vector3): boolean {
    let startedOpening = false;
    if (this.opts.auto && !this.permanent && this.opts.triggerPos) {
      this.subjectXZ.set(subjectPos.x, this.opts.triggerPos.y, subjectPos.z);
      const near =
        this.subjectXZ.distanceTo(this.opts.triggerPos) <=
        (this.opts.triggerRange ?? 8);
      const nextTarget = near ? 1 : 0;
      if (nextTarget === 1 && this.target === 0 && this.openness < 0.05) {
        startedOpening = true;
      }
      this.target = nextTarget;
    } else if (this.permanent) {
      if (this.target === 1 && this.openness < 0.05) startedOpening = true;
      this.target = 1;
    } else if (this.locked) {
      this.target = 0;
    }

    const speed = this.opts.speed ?? 2.2;
    if (this.openness !== this.target) {
      const dir = Math.sign(this.target - this.openness);
      this.openness = THREE.MathUtils.clamp(
        this.openness + dir * speed * dt,
        0,
        1,
      );
      // Ease the panels to their open offset by the current openness.
      this.opts.panels.forEach((p, i) => {
        p.mesh.position.copy(this.rest[i]).addScaledVector(p.openOffset, this.openness);
      });
    }
    if (startedOpening) this.opts.onOpenStart?.();
    return startedOpening;
  }
}
