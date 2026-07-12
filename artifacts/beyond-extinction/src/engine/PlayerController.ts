import * as THREE from "three";
import type { InputManager } from "./InputManager";

const DEFAULT_EYE_HEIGHT = 1.65;
const PITCH_LIMIT = THREE.MathUtils.degToRad(80);

export interface PlayerControllerOptions {
  /** Camera height above the ground, in meters. */
  eyeHeight?: number;
  /** Walk speed in meters/second. */
  moveSpeed?: number;
  /** Speed multiplier applied while running (InputManager.isRunning(): hold-Shift
   *  on desktop / the mobile Run toggle). 1 = no run boost. */
  runMultiplier?: number;
  /** Speed multiplier while crouching (InputManager.isCrouching(): "C" / a tap of
   *  the mobile Crouch toggle) — a slow crouch-walk. 1 = no crouch. */
  crouchMultiplier?: number;
  /** Speed multiplier while crawling (InputManager.isCrawling(): "X" / holding the
   *  mobile Crouch button) — prone + slowest. Beats crouch/run. 1 = no crawl. */
  crawlMultiplier?: number;
  /** Drag-look sensitivity, radians per pixel. */
  lookSensitivity?: number;
  /**
   * Optional run gate consulted every frame: return false to force walking
   * even while run input is held/latched (e.g. the island passes
   * `() => stats.stamina > 0`). Omitted = always allowed (prologue behavior).
   * Gates desktop hold-Shift too, which clearing the mobile latch alone
   * would miss.
   */
  canRun?: () => boolean;
}

/**
 * Maps an attempted destination to an allowed one so the controller stays
 * scene-agnostic: each scene passes its own collision logic (e.g. the prologue's
 * `resolveMove`). Receives and returns world positions on the XZ plane.
 */
export type CollisionResolver = (
  from: THREE.Vector3,
  to: THREE.Vector3,
) => THREE.Vector3Like;

/**
 * First-person player controller. Owns yaw/pitch and a ground position at eye
 * height, drives a provided perspective camera, and exposes a center-screen
 * interact ray. Movement is delegated to a {@link CollisionResolver} so the
 * controller knows nothing about a particular scene's geometry.
 *
 * Input is read from the shared {@link InputManager} (joystick + drag-look +
 * keyboard + interact), which the controller flips into first-person mode while
 * {@link setActive}(true). There is no parallel input stack: when inactive, the
 * game's cinematic tap-to-interact input owns the pointer as usual.
 */
export class PlayerController {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0; // radians; 0 = looking toward -Z (north), increases turning left
  pitch = 0;
  readonly position = new THREE.Vector3(0, DEFAULT_EYE_HEIGHT, 0);

  private readonly input: InputManager;
  private readonly eyeHeight: number;
  private readonly moveSpeed: number;
  private readonly runMultiplier: number;
  private readonly crouchMultiplier: number;
  private readonly crawlMultiplier: number;
  private lookSensitivity: number;
  private readonly canRun?: () => boolean;
  private active = false;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly attempt = new THREE.Vector3();
  private readonly interactHandlers = new Set<() => void>();
  private interactUnsub: (() => void) | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    input: InputManager,
    opts: PlayerControllerOptions = {},
  ) {
    this.camera = camera;
    this.input = input;
    this.eyeHeight = opts.eyeHeight ?? DEFAULT_EYE_HEIGHT;
    this.moveSpeed = opts.moveSpeed ?? 3.2;
    this.runMultiplier = opts.runMultiplier ?? 1;
    this.crouchMultiplier = opts.crouchMultiplier ?? 1;
    this.crawlMultiplier = opts.crawlMultiplier ?? 1;
    this.lookSensitivity = opts.lookSensitivity ?? 0.0032;
    this.canRun = opts.canRun;
    this.position.y = this.eyeHeight;
  }

  /**
   * Position the player and set facing in game heading degrees
   * (0 = -Z north, 90 = +X east), matching spawn `facing` from the level editor.
   */
  placeAt(x: number, z: number, facingDeg = 0): void {
    this.position.set(x, this.eyeHeight, z);
    this.yaw = THREE.MathUtils.degToRad(-facingDeg); // heading H -> yaw -H
    this.pitch = 0;
    this.applyToCamera();
  }

  /** Live-update the drag-look sensitivity (radians per pixel). */
  setLookSensitivity(v: number): void {
    if (Number.isFinite(v) && v > 0) this.lookSensitivity = v;
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.input.enableFpControls(active);
    if (active) {
      this.interactUnsub ??= this.input.onInteract(() =>
        this.interactHandlers.forEach((h) => h()),
      );
    } else if (this.interactUnsub) {
      this.interactUnsub();
      this.interactUnsub = null;
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  addLook(dxRad: number, dyRad: number): void {
    this.yaw -= dxRad;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - dyRad,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
  }

  /** Register a handler fired by the interact button / E / Space. */
  onInteract(cb: () => void): () => void {
    this.interactHandlers.add(cb);
    return () => this.interactHandlers.delete(cb);
  }

  /**
   * Show or hide the contextual interact prompt + button. Pass null to hide it
   * (e.g. when nothing interactable is under the crosshair / in range).
   */
  setInteractPrompt(text: string | null): void {
    this.input.setInteractPrompt(text);
  }

  /**
   * Advance one frame while active. Applies look + movement (through the
   * collision resolver) and writes the camera. Returns whether the player moved
   * this frame (for locomotion) and the current heading in degrees.
   */
  update(
    dt: number,
    resolveMove?: CollisionResolver,
  ): { moving: boolean; headingDeg: number } {
    const look = this.input.consumeLook();
    if (look.x !== 0 || look.y !== 0) {
      this.addLook(look.x * this.lookSensitivity, look.y * this.lookSensitivity);
    }

    const mv = this.input.fpMovement();
    let moving = false;
    if (mv.x !== 0 || mv.y !== 0) {
      this.forward
        .set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
        .multiplyScalar(-1);
      this.right.set(-this.forward.z, 0, this.forward.x);
      // Priority: crawl > crouch > run > walk.
      const runAllowed = this.canRun ? this.canRun() : true;
      const mult = this.input.isCrawling()
        ? this.crawlMultiplier
        : this.input.isCrouching()
          ? this.crouchMultiplier
          : this.input.isRunning() && runAllowed
            ? this.runMultiplier
            : 1;
      const step = this.moveSpeed * mult * dt;
      this.attempt
        .copy(this.position)
        .addScaledVector(this.forward, mv.y * step)
        .addScaledVector(this.right, mv.x * step);
      this.attempt.y = this.eyeHeight;
      if (resolveMove) {
        const allowed = resolveMove(this.position, this.attempt);
        this.position.set(allowed.x, this.eyeHeight, allowed.z);
      } else {
        this.position.copy(this.attempt);
      }
      moving = true;
    }
    this.applyToCamera();
    return { moving, headingDeg: this.headingDegrees() };
  }

  /** Interact ray from screen center along the camera's view direction. */
  getInteractRay(out = new THREE.Ray()): THREE.Ray {
    out.origin.copy(this.camera.position);
    this.camera.getWorldDirection(out.direction);
    return out;
  }

  /** Heading in degrees: 0 = -Z (north), 90 = +X (east); matches spawn `facing`. */
  headingDegrees(): number {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    let deg = (Math.atan2(fx, -fz) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
  }

  private applyToCamera(): void {
    this.camera.position.copy(this.position);
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(euler);
  }

  dispose(): void {
    this.interactHandlers.clear();
    if (this.interactUnsub) {
      this.interactUnsub();
      this.interactUnsub = null;
    }
    if (this.active) {
      this.input.enableFpControls(false);
      this.active = false;
    }
  }
}
