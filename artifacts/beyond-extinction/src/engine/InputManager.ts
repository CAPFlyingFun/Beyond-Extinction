import * as THREE from "three";

type ClickHandler = (pointer: THREE.Vector2, event: PointerEvent) => void;

type LongPressHandler = (pointer: THREE.Vector2) => void;

type FpPointerRole = "move" | "look";
interface FpPointerState {
  role: FpPointerRole;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Long-press timer id; cleared once the pointer moves or lifts. */
  holdTimer: number | null;
  /** True once the pointer moved past the long-press cancel threshold. */
  moved: boolean;
}

/**
 * Tracks keyboard (WASD / arrows) and pointer input, and exposes raycasting
 * helpers for click/tap-to-interact behaviour. Movement and interaction are
 * unified across desktop and touch: WASD/arrows walk on desktop, and tapping
 * the floor (to walk) or a tagged object (to interact) drives everything else
 * on every platform.
 *
 * It also owns the first-person control surface (a virtual joystick on the left
 * half, drag-to-look on the right half, plus a crosshair / interact button /
 * prompt). That HUD is mounted on the shared UI layer and only shown while
 * {@link enableFpControls}(true). Keeping it here means there is a single owner
 * of the pointer/keyboard: first-person mode suppresses cinematic tap input
 * instead of running a parallel input stack alongside it.
 */
export class InputManager {
  private readonly dom: HTMLElement;
  private readonly uiHost: HTMLElement;
  private readonly keys = new Set<string>();
  readonly pointer = new THREE.Vector2();
  readonly raycaster = new THREE.Raycaster();
  private clickHandlers = new Set<ClickHandler>();
  private enabled = true;

  readonly isTouch: boolean =
    window.matchMedia("(pointer: coarse)").matches ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia("(max-width: 820px)").matches;

  // --- First-person control surface (built lazily on first FP activation) ----
  private fpMode = false;
  private fpLayer: HTMLDivElement | null = null;
  private fpJoyBase: HTMLDivElement | null = null;
  private fpJoyStick: HTMLDivElement | null = null;
  private fpPromptEl: HTMLDivElement | null = null;
  private fpInteractBtn: HTMLButtonElement | null = null;
  private readonly fpPointers = new Map<number, FpPointerState>();
  private readonly fpJoy = { x: 0, y: 0 }; // joystick vector, forward = +y
  private readonly fpLook = { x: 0, y: 0 }; // accumulated raw drag delta (px)
  private readonly fpJoyRadius = 56;
  private readonly interactHandlers = new Set<() => void>();
  // Long-press-to-interact: a stationary hold fires these with the touch point
  // (NDC) so the scene can raycast the item under the finger. Movement past
  // LONG_PRESS_MOVE_PX cancels it (that gesture is a look-drag / joystick).
  private readonly longPressHandlers = new Set<LongPressHandler>();
  private readonly LONG_PRESS_MS = 420;
  private readonly LONG_PRESS_MOVE_PX = 14;

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (this.fpMode && (e.code === "KeyE" || e.code === "Space")) {
      e.preventDefault();
      this.fireInteract();
      return;
    }
    this.keys.add(e.code);
  };
  // Always clear on key-up (even while disabled) so a key released during a
  // gated stretch can never linger in the set when input is re-enabled.
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled || this.fpMode) return;
    this.updatePointer(e);
    this.clickHandlers.forEach((h) => h(this.pointer, e));
  };
  private onPointerMove = (e: PointerEvent) => {
    this.updatePointer(e);
  };

  constructor(dom: HTMLElement, uiHost?: HTMLElement) {
    this.dom = dom;
    this.uiHost = uiHost ?? dom.parentElement ?? document.body;
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
      this.resetFpInput();
    }
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

  // ---------- First-person controls ----------

  /**
   * Show/hide the first-person HUD and start/stop owning the pointer for FP
   * walk + look. While active, cinematic tap input is suppressed but keyboard
   * tracking stays live, so WASD keeps driving {@link fpMovement}.
   */
  enableFpControls(active: boolean): void {
    this.fpMode = active;
    if (active) this.ensureFpLayer();
    if (this.fpLayer) this.fpLayer.style.display = active ? "block" : "none";
    if (!active) this.resetFpInput();
  }

  get fpControlsActive(): boolean {
    return this.fpMode;
  }

  /**
   * Combined first-person movement from the joystick + WASD/arrows, clamped to
   * the unit disc. Forward (screen-up / W) is +y, strafe-right is +x.
   */
  fpMovement(): { x: number; y: number } {
    let x = this.fpJoy.x;
    let y = this.fpJoy.y;
    if (this.isDown("KeyW", "ArrowUp")) y += 1;
    if (this.isDown("KeyS", "ArrowDown")) y -= 1;
    if (this.isDown("KeyD", "ArrowRight")) x += 1;
    if (this.isDown("KeyA", "ArrowLeft")) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  /** Drag-look delta (raw px) accumulated since the last call; resets on read. */
  consumeLook(): { x: number; y: number } {
    const out = { x: this.fpLook.x, y: this.fpLook.y };
    this.fpLook.x = 0;
    this.fpLook.y = 0;
    return out;
  }

  /** Register a handler fired by the interact button / E / Space. */
  onInteract(cb: () => void): () => void {
    this.interactHandlers.add(cb);
    return () => this.interactHandlers.delete(cb);
  }

  /**
   * Show or hide the contextual interact hint. Interaction is now driven by a
   * long-press directly on the item (see {@link onLongPress}), so the on-screen
   * "Interact" BUTTON is never shown — the hint just tells the player what a
   * long-press on the highlighted item will do. Pass null to hide it.
   */
  setInteractPrompt(text: string | null): void {
    if (!this.fpLayer || !this.fpPromptEl || !this.fpInteractBtn) return;
    this.fpInteractBtn.style.display = "none"; // long-press replaces the button
    if (text) {
      this.fpPromptEl.textContent = text;
      this.fpPromptEl.style.display = "block";
    } else {
      this.fpPromptEl.style.display = "none";
    }
  }

  private fireInteract(): void {
    this.interactHandlers.forEach((h) => h());
  }

  private resetFpInput(): void {
    for (const st of this.fpPointers.values()) {
      if (st.holdTimer !== null) clearTimeout(st.holdTimer);
    }
    this.fpPointers.clear();
    this.fpJoy.x = 0;
    this.fpJoy.y = 0;
    this.fpLook.x = 0;
    this.fpLook.y = 0;
    if (this.fpJoyBase) this.fpJoyBase.style.display = "none";
    if (this.fpJoyStick) {
      this.fpJoyStick.style.transform = "translate(-50%, -50%)";
    }
  }

  private ensureFpLayer(): void {
    if (this.fpLayer) return;

    const layer = document.createElement("div");
    layer.className = "be-fp-layer";
    layer.style.display = "none";

    const crosshair = document.createElement("div");
    crosshair.className = "be-fp-crosshair";
    layer.appendChild(crosshair);

    const joyBase = document.createElement("div");
    joyBase.className = "be-fp-joybase";
    joyBase.style.display = "none";
    const joyStick = document.createElement("div");
    joyStick.className = "be-fp-joystick";
    joyBase.appendChild(joyStick);
    layer.appendChild(joyBase);

    const prompt = document.createElement("div");
    prompt.className = "be-fp-prompt";
    prompt.style.display = "none";
    layer.appendChild(prompt);

    const interactBtn = document.createElement("button");
    interactBtn.className = "be-fp-interact";
    interactBtn.type = "button";
    interactBtn.textContent = "Interact";
    interactBtn.style.display = "none";
    interactBtn.addEventListener("click", (e) => {
      e.preventDefault();
      this.fireInteract();
    });
    layer.appendChild(interactBtn);

    layer.addEventListener("pointerdown", this.onFpPointerDown);
    layer.addEventListener("pointermove", this.onFpPointerMove);
    layer.addEventListener("pointerup", this.onFpPointerUp);
    layer.addEventListener("pointercancel", this.onFpPointerUp);

    this.uiHost.appendChild(layer);
    this.fpLayer = layer;
    this.fpJoyBase = joyBase;
    this.fpJoyStick = joyStick;
    this.fpPromptEl = prompt;
    this.fpInteractBtn = interactBtn;
  }

  // Left half drives the virtual joystick (move); right half drags to look.
  // Pointer ownership is tracked by id so a move-touch and a look-touch never
  // interfere. Only pointerdowns that land on the bare layer start move/look,
  // so the interact button keeps its own clicks.
  private onFpPointerDown = (e: PointerEvent) => {
    if (!this.enabled || !this.fpLayer) return;
    if (e.target !== this.fpLayer) return;
    const role: FpPointerRole =
      e.clientX < window.innerWidth / 2 ? "move" : "look";
    this.fpLayer.setPointerCapture(e.pointerId);
    // Arm a long-press: if this pointer stays put for LONG_PRESS_MS it becomes a
    // "use the item under my finger" gesture (works on either half — a held
    // joystick or a held look-touch both contribute no motion). Movement cancels.
    const px = e.clientX;
    const py = e.clientY;
    const holdTimer = window.setTimeout(() => {
      const st = this.fpPointers.get(e.pointerId);
      if (!st || st.moved) return;
      st.holdTimer = null;
      st.moved = true; // consume: pointerup won't treat this as anything else
      const p = this.clientToNdc(px, py);
      this.longPressHandlers.forEach((h) => h(p));
    }, this.LONG_PRESS_MS);
    this.fpPointers.set(e.pointerId, {
      role,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      holdTimer,
      moved: false,
    });
    if (role === "move" && this.fpJoyBase && this.fpJoyStick) {
      this.fpJoyBase.style.left = `${e.clientX}px`;
      this.fpJoyBase.style.top = `${e.clientY}px`;
      this.fpJoyBase.style.display = "block";
      this.fpJoyStick.style.transform = "translate(-50%, -50%)";
    }
    e.preventDefault();
  };

  private onFpPointerMove = (e: PointerEvent) => {
    const st = this.fpPointers.get(e.pointerId);
    if (!st) return;
    // Past the threshold this is a drag (look / joystick), not a long-press.
    if (!st.moved && Math.hypot(e.clientX - st.startX, e.clientY - st.startY) > this.LONG_PRESS_MOVE_PX) {
      st.moved = true;
      if (st.holdTimer !== null) {
        clearTimeout(st.holdTimer);
        st.holdTimer = null;
      }
    }
    if (st.role === "move") {
      let dx = e.clientX - st.startX;
      let dy = e.clientY - st.startY;
      const len = Math.hypot(dx, dy);
      if (len > this.fpJoyRadius) {
        dx = (dx / len) * this.fpJoyRadius;
        dy = (dy / len) * this.fpJoyRadius;
      }
      if (this.fpJoyStick) {
        this.fpJoyStick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      }
      this.fpJoy.x = dx / this.fpJoyRadius;
      this.fpJoy.y = -dy / this.fpJoyRadius; // screen-up = forward
    } else {
      this.fpLook.x += e.clientX - st.lastX;
      this.fpLook.y += e.clientY - st.lastY;
      st.lastX = e.clientX;
      st.lastY = e.clientY;
    }
    e.preventDefault();
  };

  private onFpPointerUp = (e: PointerEvent) => {
    const st = this.fpPointers.get(e.pointerId);
    if (!st) return;
    if (st.holdTimer !== null) clearTimeout(st.holdTimer);
    this.fpPointers.delete(e.pointerId);
    if (st.role === "move") {
      this.fpJoy.x = 0;
      this.fpJoy.y = 0;
      if (this.fpJoyBase) this.fpJoyBase.style.display = "none";
    }
  };

  /** Convert client (screen) px to normalized device coords over the canvas. */
  private clientToNdc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.dom.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Register a handler fired on a stationary long-press, with the touch NDC. */
  onLongPress(cb: LongPressHandler): () => void {
    this.longPressHandlers.add(cb);
    return () => this.longPressHandlers.delete(cb);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    if (this.fpLayer) {
      this.fpLayer.removeEventListener("pointerdown", this.onFpPointerDown);
      this.fpLayer.removeEventListener("pointermove", this.onFpPointerMove);
      this.fpLayer.removeEventListener("pointerup", this.onFpPointerUp);
      this.fpLayer.removeEventListener("pointercancel", this.onFpPointerUp);
      this.fpLayer.remove();
      this.fpLayer = null;
    }
    for (const st of this.fpPointers.values()) {
      if (st.holdTimer !== null) clearTimeout(st.holdTimer);
    }
    this.fpPointers.clear();
    this.interactHandlers.clear();
    this.longPressHandlers.clear();
    this.clickHandlers.clear();
  }
}
