import * as THREE from "three";

/**
 * A named camera "moment": active under some condition over the scene's own
 * state (proximity to a prop, current phase, whatever TState carries), with
 * a position/lookAt to ease toward while it's the winner and a priority to
 * break ties when more than one zone's condition is true at once.
 */
export interface CameraZone<TState> {
  id: string;
  priority: number;
  /** Fraction of the remaining distance closed per ~frame at 60fps; higher = snappier. */
  easeSpeed: number;
  isActive(state: TState): boolean;
  position(state: TState): THREE.Vector3;
  lookAt(state: TState): THREE.Vector3;
}

/**
 * Picks the highest-priority active zone each frame and eases the camera's
 * position and look target toward it, so a scene can declare several
 * cinematic framings (an establishing shot, a close-up near an interactable,
 * a wide shot for a chase) without each owning its own ad-hoc lerp and without
 * the camera snapping the instant the winning zone changes. Call cut() right
 * before a deliberate hard cut (entering dialogue or a cutscene) — every
 * other transition eases.
 */
export class CameraDirector<TState> {
  private zones: CameraZone<TState>[] = [];
  private activeId: string | null = null;
  private snapNext = false;
  private currentLook: THREE.Vector3 | null = null;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  addZone(zone: CameraZone<TState>): void {
    this.zones.push(zone);
  }

  /** Forces the next update() to jump straight to the resolved zone instead of easing. */
  cut(): void {
    this.snapNext = true;
  }

  /** id of the zone that won the most recent update(), if any. */
  get activeZoneId(): string | null {
    return this.activeId;
  }

  /** Resolves the active zone for this frame and moves the camera toward it. Returns its id, or null if no zone matched. */
  update(state: TState, dt: number): string | null {
    let chosen: CameraZone<TState> | null = null;
    for (const zone of this.zones) {
      if (zone.isActive(state) && (!chosen || zone.priority > chosen.priority)) {
        chosen = zone;
      }
    }
    if (!chosen) return null;
    this.activeId = chosen.id;

    const targetPos = chosen.position(state);
    const targetLook = chosen.lookAt(state);
    const snap = this.snapNext || !this.currentLook;
    this.snapNext = false;

    if (snap || !this.currentLook) {
      this.camera.position.copy(targetPos);
      this.currentLook = targetLook.clone();
    } else {
      const k = 1 - Math.pow(1 - chosen.easeSpeed, dt * 60);
      this.camera.position.lerp(targetPos, k);
      this.currentLook.lerp(targetLook, k);
    }
    this.camera.lookAt(this.currentLook);
    return chosen.id;
  }
}
