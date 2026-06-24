import * as THREE from "three";

type ClickHandler = (pointer: THREE.Vector2, event: PointerEvent) => void;

/**
 * Tracks keyboard (WASD / arrows) and pointer input, and exposes raycasting
 * helpers for click/tap-to-interact behaviour. Movement and interaction are
 * unified across desktop and touch: WASD/arrows walk on desktop, and tapping
 * the floor (to walk) or a tagged object (to interact) drives everything else
 * on every platform.
 */
export class InputManager {
  private readonly dom: HTMLElement;
  private readonly keys = new Set<string>();
  readonly pointer = new THREE.Vector2();
  readonly raycaster = new THREE.Raycaster();
  private clickHandlers = new Set<ClickHandler>();
  private enabled = true;

  readonly isTouch: boolean =
    window.matchMedia("(pointer: coarse)").matches ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia("(max-width: 820px)").matches;

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.updatePointer(e);
    this.clickHandlers.forEach((h) => h(this.pointer, e));
  };
  private onPointerMove = (e: PointerEvent) => {
    this.updatePointer(e);
  };

  constructor(dom: HTMLElement) {
    this.dom = dom;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointermove", this.onPointerMove);
  }

  private updatePointer(e: PointerEvent): void {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.keys.clear();
  }

  /** Whether input is currently accepted (false while menus/cutscenes gate it). */
  get inputEnabled(): boolean {
    return this.enabled;
  }

  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Normalised movement vector on the XZ plane from the keyboard. */
  getMoveVector(): THREE.Vector2 {
    const x =
      (this.isDown("KeyD", "ArrowRight") ? 1 : 0) -
      (this.isDown("KeyA", "ArrowLeft") ? 1 : 0);
    const y =
      (this.isDown("KeyS", "ArrowDown") ? 1 : 0) -
      (this.isDown("KeyW", "ArrowUp") ? 1 : 0);
    const v = new THREE.Vector2(x, y);
    if (v.lengthSq() > 1) v.normalize();
    return v;
  }

  onClick(handler: ClickHandler): () => void {
    this.clickHandlers.add(handler);
    return () => this.clickHandlers.delete(handler);
  }

  /** Raycast from the current pointer against the given objects. */
  intersect(
    camera: THREE.Camera,
    objects: THREE.Object3D[],
    pointer = this.pointer,
  ): THREE.Intersection[] {
    this.raycaster.setFromCamera(pointer, camera);
    return this.raycaster.intersectObjects(objects, true);
  }

  clearClickHandlers(): void {
    this.clickHandlers.clear();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    this.clickHandlers.clear();
  }
}
