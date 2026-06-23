import * as THREE from "three";

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Mobile GPUs can drop the WebGL context (memory pressure, tab backgrounding,
    // orientation changes). preventDefault() lets the browser restore it instead
    // of permanently killing the canvas; Three.js re-initialises its state on the
    // restored event. We log explicitly rather than failing silently.
    const canvas = this.renderer.domElement;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.error(
        "[beyond-extinction] WebGL context lost — rendering paused until it is restored.",
      );
    });
    canvas.addEventListener("webglcontextrestored", () => {
      console.info("[beyond-extinction] WebGL context restored.");
    });
  }

  /**
   * Pre-compile every material currently in the scene while the GL context is
   * healthy, so a later first-time draw (e.g. a climax effect) never has to
   * compile a shader mid-gameplay — the moment that crashes on flaky mobile
   * contexts.
   */
  precompile(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.compile(scene, camera);
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get width(): number {
    return this.container.clientWidth || window.innerWidth;
  }

  get height(): number {
    return this.container.clientHeight || window.innerHeight;
  }

  resize(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.width, this.height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  dispose(): void {
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
