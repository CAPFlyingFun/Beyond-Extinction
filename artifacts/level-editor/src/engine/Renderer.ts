import * as THREE from "three";

/** Owns the WebGL renderer, the canvas, and resize handling. */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private resizeTarget: { camera: THREE.PerspectiveCamera } | null = null;
  private onResize = () => this.handleResize();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.classList.add("editor-canvas");
    container.appendChild(this.canvas);
    window.addEventListener("resize", this.onResize);
  }

  bindCamera(camera: THREE.PerspectiveCamera): void {
    this.resizeTarget = { camera };
    this.handleResize();
  }

  private handleResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    if (this.resizeTarget) {
      this.resizeTarget.camera.aspect = w / h;
      this.resizeTarget.camera.updateProjectionMatrix();
    }
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.renderer.render(scene, camera);
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    this.canvas.remove();
  }
}
