import * as THREE from "three";

const EYE_HEIGHT = 1.7;
const PITCH_LIMIT = THREE.MathUtils.degToRad(85);

/**
 * First-person camera. Position lives on the ground at eye height; yaw/pitch
 * are tracked explicitly so look input and movement stay decoupled.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0; // radians, 0 = looking toward -Z; increases turning left
  pitch = 0;
  position = new THREE.Vector3(0, EYE_HEIGHT, 8);
  moveSpeed = 4.5; // m/s

  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();

  constructor() {
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.05,
      1000,
    );
    this.applyToCamera();
  }

  addLook(dxRad: number, dyRad: number): void {
    this.yaw -= dxRad;
    this.pitch -= dyRad;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** move.x = strafe (+right), move.y = forward (+forward), each in [-1, 1]. */
  move(moveX: number, moveY: number, dt: number): void {
    if (moveX === 0 && moveY === 0) return;
    // Heading on the XZ plane from yaw (ignores pitch so you don't fly).
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(-1);
    this.right.set(-this.forward.z, 0, this.forward.x); // right = forward × up (e.g. facing -Z north → +X east)
    const step = this.moveSpeed * dt;
    this.position.addScaledVector(this.forward, moveY * step);
    this.position.addScaledVector(this.right, moveX * step);
    this.position.y = EYE_HEIGHT;
  }

  /**
   * World-space forward direction including pitch (for crosshair raycasts).
   * Derived from the live camera so the ray always matches what is rendered
   * (applyToCamera() runs each frame before this is read).
   */
  getViewDirection(target: THREE.Vector3): THREE.Vector3 {
    return this.camera.getWorldDirection(target);
  }

  /** Camera heading in degrees, 0 = -Z (north), 90 = +X (east); matches spawn `facing`. */
  headingDegrees(): number {
    // forward XZ = (-sin yaw, -cos yaw). North is -Z, so measure from -Z, CW toward +X (east).
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    let deg = (Math.atan2(fx, -fz) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
  }

  applyToCamera(): void {
    this.camera.position.copy(this.position);
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(euler);
  }
}
