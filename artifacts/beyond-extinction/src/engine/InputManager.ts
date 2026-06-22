import * as THREE from "three";

type ClickHandler = (pointer: THREE.Vector2, event: PointerEvent) => void;

/**
 * Tracks keyboard (WASD / arrows), pointer, and on-screen touch input, and
 * exposes raycasting helpers for click-to-interact behaviour. On touch / small
 * screens it mounts a virtual joystick and an action button that feed the same
 * movement and interaction queries the keyboard does.
 */
export class InputManager {
  private readonly dom: HTMLElement;
  private readonly keys = new Set<string>();
  readonly pointer = new THREE.Vector2();
  readonly raycaster = new THREE.Raycaster();
  private clickHandlers = new Set<ClickHandler>();
  private enabled = true;

  // On-screen touch controls.
  private readonly touch = new THREE.Vector2();
  private actionLatched = false;
  private touchRoot: HTMLElement | null = null;
  private resetStick: (() => void) | null = null;

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
    if (!enabled) {
      this.keys.clear();
      this.actionLatched = false;
      this.touch.set(0, 0);
      this.resetStick?.();
    }
    this.touchRoot?.classList.toggle("be-touch--off", !enabled);
  }

  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /**
   * Returns true once per press of the on-screen action button, then clears the
   * latch. This guarantees a quick tap is never lost between animation frames,
   * unlike polling current key state.
   */
  consumeActionPress(): boolean {
    if (!this.actionLatched) return false;
    this.actionLatched = false;
    return true;
  }

  /** Normalised movement vector on the XZ plane from keys and/or joystick. */
  getMoveVector(): THREE.Vector2 {
    const x =
      (this.isDown("KeyD", "ArrowRight") ? 1 : 0) -
      (this.isDown("KeyA", "ArrowLeft") ? 1 : 0);
    const y =
      (this.isDown("KeyS", "ArrowDown") ? 1 : 0) -
      (this.isDown("KeyW", "ArrowUp") ? 1 : 0);
    const v = new THREE.Vector2(x, y);
    if (this.touch.lengthSq() > 0.0004) v.add(this.touch);
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

  /**
   * Builds the on-screen joystick + action button into the given UI layer when
   * the device is touch-capable or the viewport is narrow. Safe to call once.
   */
  mountTouchControls(layer: HTMLElement): void {
    if (this.touchRoot) return;
    const wantsTouch =
      window.matchMedia("(pointer: coarse)").matches ||
      navigator.maxTouchPoints > 0 ||
      window.matchMedia("(max-width: 820px)").matches;
    if (!wantsTouch) return;

    const root = document.createElement("div");
    root.className = "be-touch";

    // ---- Virtual joystick (left) ----
    const stick = document.createElement("div");
    stick.className = "be-touch-stick";
    const knob = document.createElement("div");
    knob.className = "be-touch-stick__knob";
    stick.appendChild(knob);
    root.appendChild(stick);

    const radius = 52;
    let stickId = -1;
    const resetStick = () => {
      stickId = -1;
      this.touch.set(0, 0);
      knob.style.transform = "translate(-50%, -50%)";
    };
    this.resetStick = resetStick;

    const moveStick = (e: PointerEvent) => {
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > radius) {
        dx = (dx / len) * radius;
        dy = (dy / len) * radius;
      }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      this.touch.set(dx / radius, dy / radius);
    };

    stick.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      stickId = e.pointerId;
      stick.setPointerCapture(stickId);
      moveStick(e);
    });
    stick.addEventListener("pointermove", (e) => {
      if (e.pointerId !== stickId) return;
      moveStick(e);
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return;
      resetStick();
    };
    stick.addEventListener("pointerup", endStick);
    stick.addEventListener("pointercancel", endStick);

    // ---- Action button (right) → behaves like the E key ----
    const action = document.createElement("button");
    action.className = "be-touch-action";
    action.type = "button";
    action.textContent = "E";
    action.setAttribute("aria-label", "Interact");
    const pressAction = (e: PointerEvent) => {
      e.preventDefault();
      if (!this.enabled) return;
      this.actionLatched = true;
      action.classList.add("is-down");
    };
    const releaseAction = () => {
      action.classList.remove("is-down");
    };
    action.addEventListener("pointerdown", pressAction);
    action.addEventListener("pointerup", releaseAction);
    action.addEventListener("pointercancel", releaseAction);
    action.addEventListener("pointerleave", releaseAction);
    root.appendChild(action);

    layer.appendChild(root);
    this.touchRoot = root;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    this.clickHandlers.clear();
    this.touchRoot?.remove();
    this.touchRoot = null;
  }
}
