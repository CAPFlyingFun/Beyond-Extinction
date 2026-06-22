import * as THREE from "three";

/**
 * Owns a perspective camera and provides cinematic helpers (smooth lerping to
 * targets and idle drift) that scenes can use for a filmic feel.
 */
export class CameraManager {
  readonly camera: THREE.PerspectiveCamera;

  private basePosition = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private desiredPosition = new THREE.Vector3();
  private desiredLook = new THREE.Vector3();
  private lerpSpeed = 1.5;
  private driftAmplitude = 0;
  private driftSpeed = 0.25;

  constructor(fov = 55, near = 0.1, far = 2000) {
    this.camera = new THREE.PerspectiveCamera(
      fov,
      window.innerWidth / window.innerHeight,
      near,
      far,
    );
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Snap immediately to a position/target with no interpolation. */
  place(position: THREE.Vector3Like, target: THREE.Vector3Like): void {
    this.basePosition.set(position.x, position.y, position.z);
    this.desiredPosition.copy(this.basePosition);
    this.camera.position.copy(this.basePosition);
    this.lookTarget.set(target.x, target.y, target.z);
    this.desiredLook.copy(this.lookTarget);
    this.camera.lookAt(this.lookTarget);
  }

  /** Smoothly move toward a new position/target over subsequent updates. */
  moveTo(
    position: THREE.Vector3Like,
    target: THREE.Vector3Like,
    lerpSpeed = 1.5,
  ): void {
    this.basePosition.set(position.x, position.y, position.z);
    this.desiredPosition.copy(this.basePosition);
    this.lookTarget.set(target.x, target.y, target.z);
    this.desiredLook.copy(this.lookTarget);
    this.lerpSpeed = lerpSpeed;
  }

  setDrift(amplitude: number, speed = 0.25): void {
    this.driftAmplitude = amplitude;
    this.driftSpeed = speed;
  }

  update(dt: number, elapsed: number): void {
    const t = 1 - Math.exp(-this.lerpSpeed * dt);
    this.camera.position.lerp(this.desiredPosition, t);
    this.lookTarget.lerp(this.desiredLook, t);

    if (this.driftAmplitude > 0) {
      const dx = Math.sin(elapsed * this.driftSpeed) * this.driftAmplitude;
      const dy =
        Math.cos(elapsed * this.driftSpeed * 0.8) * this.driftAmplitude * 0.5;
      this.camera.position.x += dx;
      this.camera.position.y += dy;
    }

    this.camera.lookAt(this.lookTarget);
  }
}
