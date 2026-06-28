import * as THREE from "three";

/**
 * Optional top-down reference image laid flat on the ground so the user can
 * trace it while walking. Purely client-side; never serialized into the level.
 */
export class FloorPlanOverlay {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshBasicMaterial;
  private texture: THREE.Texture | null = null;
  private imageAspect = 1;

  // Controls (meters / degrees / 0..1).
  widthMeters = 20;
  offsetX = 0;
  offsetZ = 0;
  rotationDeg = 0;
  opacity = 0.6;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: this.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      color: 0xffffff,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.01;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
  }

  async setImage(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      if (this.texture) this.texture.dispose();
      this.texture = tex;
      this.imageAspect =
        tex.image && tex.image.width
          ? tex.image.width / tex.image.height
          : 1;
      this.material.map = tex;
      this.material.needsUpdate = true;
      this.mesh.visible = true;
      this.applyTransform();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v && this.texture !== null;
  }

  hasImage(): boolean {
    return this.texture !== null;
  }

  applyTransform(): void {
    const w = this.widthMeters;
    const h = w / (this.imageAspect || 1);
    // Plane lies in XZ after rotation.x = -90°; the image's top (local +Y) maps
    // to world -Z = north, so a north-up floor plan traces in the right orientation.
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.set(this.offsetX, 0.01, this.offsetZ);
    this.mesh.rotation.set(-Math.PI / 2, 0, THREE.MathUtils.degToRad(this.rotationDeg));
    this.material.opacity = this.opacity;
  }

  dispose(): void {
    if (this.texture) this.texture.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
