import * as THREE from "three";
import type { CameraController } from "./CameraController";

/**
 * Casts a ray from the camera through the screen-center crosshair onto the
 * ground plane and shows a ghost reticle at the resulting world point.
 */
export class GroundCursor {
  readonly group: THREE.Group;
  private ray = new THREE.Ray();
  private dir = new THREE.Vector3();
  private hit = new THREE.Vector3();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private valid = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.renderOrder = 10;

    const ringGeo = new THREE.RingGeometry(0.18, 0.26, 36);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x7fd6ff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    this.group.add(ring);

    const dotGeo = new THREE.CircleGeometry(0.05, 16);
    const dot = new THREE.Mesh(dotGeo, ringMat);
    dot.rotation.x = -Math.PI / 2;
    this.group.add(dot);
  }

  /** Returns the world ground point under the crosshair, or null if aiming up. */
  update(cam: CameraController): { x: number; z: number } | null {
    this.ray.origin.copy(cam.position);
    cam.getViewDirection(this.dir);
    this.ray.direction.copy(this.dir);

    const result = this.ray.intersectPlane(this.plane, this.hit);
    if (!result) {
      this.valid = false;
      this.group.visible = false;
      return null;
    }
    this.valid = true;
    this.group.visible = true;
    this.group.position.set(this.hit.x, 0.02, this.hit.z);
    return { x: this.hit.x, z: this.hit.z };
  }

  setColor(hex: number): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.material) {
        (mesh.material as THREE.MeshBasicMaterial).color.setHex(hex);
      }
    });
  }

  isValid(): boolean {
    return this.valid;
  }
}
