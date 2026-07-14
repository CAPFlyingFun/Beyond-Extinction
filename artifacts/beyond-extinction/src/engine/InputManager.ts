import * as THREE from "three";
import { registerHudElement } from "./HudEditor";
import { getSettings } from "./Settings";

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
  private fpJoyRest: HTMLDivElement | null = null;
  private fpPromptEl: HTMLDivElement | null = null;
  private fpInteractBtn: HTMLButtonElement | null = null;
  private fpJumpBtn: HTMLButtonElement | null = null;
  private fpRunBtn: HTMLButtonElement | null = null;
  private fpCrouchBtn: HTMLButtonElement | null = null;
  private nativeButtonsVisible = true;
  // HUD-layout registry unhooks for the FP buttons (see HudEditor).
  private hudUnregs: Array<() => void> = [];
  private runToggled = false; // mobile Run toggle (desktop uses hold-Shift)
  private crouchToggled = false; // mobile Crouch toggle (desktop uses the "C" key)
  private crawlHeld = false; // mobile Crawl: the Crouch button held (desktop: "X")
  private static readonly CROUCH_HOLD_MS = 300; // hold this long → Crawl
  private readonly fpPointers = new Map<number, FpPointerState>();
  private readonly fpJoy = { x: 0, y: 0 }; // joystick vector, forward = +y
  private readonly fpLook = { x: 0, y: 0 }; // accumulated raw drag delta (px)
  // Joystick throw radius in px. The HUD editor's "joystick" scale multiplies
  // the BASE at gesture start: CSS transform scale only shrinks the visuals,
  // so the input math must scale too or a small joystick would need the same
  // finger travel as a big one.
  private static readonly FP_JOY_BASE_RADIUS = 56;
  private fpJoyRadius = InputManager.FP_JOY_BASE_RADIUS;
  private fpJoyScale = 1;
  private readonly interactHandlers = new Set<() => void>();
  private jumpRequested = false;
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
    if (this.fpMode && e.code === "KeyE") {
      e.preventDefault();
      this.fireInteract();
      return;
    }
    if (this.fpMode && e.code === "Space") {
      e.preventDefault();
      this.jumpRequested = true;
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

  /**
   * True while the player should RUN rather than walk: hold-Shift on desktop,
   * or the latched mobile Run toggle. The controller multiplies its walk speed
   * by the run factor while this holds (see PlayerController.update).
   */
  isRunning(): boolean {
    return this.runToggled || this.isDown("ShiftLeft", "ShiftRight");
  }

  /**
   * True while the player should CROUCH (a slow crouch-walk): the "C" key on
   * desktop, or a tap of the mobile Crouch toggle. Slower than walk; crawl and
   * (see PlayerController.update) run take precedence over it.
   */
  isCrouching(): boolean {
    return this.crouchToggled || this.isDown("KeyC");
  }

  /**
   * True while the player should CRAWL — prone, slowest, silent (a stealth
   * hook for when noise/detection lands): the "X" key on desktop, or holding
   * the mobile Crouch button. Takes precedence over crouch/run/walk.
   */
  isCrawling(): boolean {
    return this.crawlHeld || this.isDown("KeyX");
  }

  /** Drag-look delta (raw px) accumulated since the last call; resets on read. */
  consumeLook(): { x: number; y: number } {
    const out = { x: this.fpLook.x, y: this.fpLook.y };
    this.fpLook.x = 0;
    this.fpLook.y = 0;
    return out;
  }

  /** True once if a jump was requested (Space / jump button) since last call. */
  consumeJump(): boolean {
    const j = this.jumpRequested;
    this.jumpRequested = false;
    return j;
  }

  /** Register a handler fired by the interact button / E. */
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
    this.runToggled = false; // don't leave run/crouch/crawl latched across sessions
    this.crouchToggled = false;
    this.crawlHeld = false;
    this.fpRunBtn?.classList.remove("is-active");
    this.fpCrouchBtn?.classList.remove("is-active", "is-crawl");
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

    // Resting joystick base: a faint, always-visible anchor at the bottom-left
    // showing where movement lives. Touches pass through it (pointer-events:
    // none) — the ACTIVE joystick still spawns wherever the thumb lands on the
    // left half. It doubles as the HUD editor's "joystick" node: moving it
    // relocates the visual anchor, scaling it resizes the live joystick too.
    const joyRest = document.createElement("div");
    joyRest.className = "be-fp-joyrest";
    // Hidden: the live joystick floats to wherever the thumb lands on the left
    // half, so a second always-on resting base just read as a dead control.
    joyRest.style.display = "none";
    layer.appendChild(joyRest);

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

    // Jump button (mobile) — pointerdown so it fires instantly and never starts
    // a move/look drag.
    const jumpBtn = document.createElement("button");
    jumpBtn.className = "be-fp-jump";
    jumpBtn.type = "button";
    jumpBtn.setAttribute("aria-label", "Jump");
    jumpBtn.textContent = "⤒";
    jumpBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.jumpRequested = true;
    });
    layer.appendChild(jumpBtn);

    // Run button (mobile) — a TOGGLE (holding a button while thumbing the
    // joystick + look is awkward on touch), so tap to latch run on/off. PC uses
    // hold-Shift instead (see isRunning). Button shows its state via .is-active.
    const runBtn = document.createElement("button");
    runBtn.className = "be-fp-run";
    runBtn.type = "button";
    runBtn.setAttribute("aria-label", "Run");
    runBtn.textContent = "RUN";
    runBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.runToggled = !this.runToggled;
      if (this.runToggled) {
        this.crouchToggled = false;
        this.fpCrouchBtn?.classList.remove("is-active");
      }
      runBtn.classList.toggle("is-active", this.runToggled);
    });
    layer.appendChild(runBtn);
    this.fpRunBtn = runBtn;

    // Crouch / Crawl button (mobile). A short TAP toggles Crouch (mutually
    // exclusive with Run); a press-and-HOLD drops to Crawl — prone, slowest,
    // silent — for as long as it's held, then releases back to the prior
    // crouch state. PC uses the "C" (crouch) and "X" (crawl) keys instead.
    const crouchBtn = document.createElement("button");
    crouchBtn.className = "be-fp-crouch";
    crouchBtn.type = "button";
    crouchBtn.setAttribute("aria-label", "Crouch — hold to Crawl");
    crouchBtn.textContent = "CRCH";
    let holdTimer: number | null = null;
    let crawlingFromHold = false;
    crouchBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Capture so the release still fires if the finger slides off; ignore if
      // the browser refuses (never let it abort the press logic below).
      try {
        crouchBtn.setPointerCapture(e.pointerId);
      } catch {
        /* capture unavailable — the hold/tap still works via up/cancel */
      }
      crawlingFromHold = false;
      holdTimer = window.setTimeout(() => {
        crawlingFromHold = true;
        this.crawlHeld = true;
        crouchBtn.classList.add("is-crawl");
      }, InputManager.CROUCH_HOLD_MS);
    });
    const endCrouchPress = () => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (crawlingFromHold) {
        this.crawlHeld = false; // release crawl; keep the crouch toggle as it was
        crouchBtn.classList.remove("is-crawl");
      } else {
        this.crouchToggled = !this.crouchToggled; // short tap toggles crouch
        if (this.crouchToggled) {
          this.runToggled = false;
          this.fpRunBtn?.classList.remove("is-active");
        }
        crouchBtn.classList.toggle("is-active", this.crouchToggled);
      }
      crawlingFromHold = false;
    };
    crouchBtn.addEventListener("pointerup", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endCrouchPress();
    });
    crouchBtn.addEventListener("pointercancel", () => endCrouchPress());
    layer.appendChild(crouchBtn);
    this.fpCrouchBtn = crouchBtn;

    layer.addEventListener("pointerdown", this.onFpPointerDown);
    layer.addEventListener("pointermove", this.onFpPointerMove);
    layer.addEventListener("pointerup", this.onFpPointerUp);
    layer.addEventListener("pointercancel", this.onFpPointerUp);

    this.uiHost.appendChild(layer);
    this.fpLayer = layer;
    this.fpJoyBase = joyBase;
    this.fpJoyStick = joyStick;
    this.fpJoyRest = joyRest;
    this.fpPromptEl = prompt;
    this.fpInteractBtn = interactBtn;
    this.fpJumpBtn = jumpBtn;

    this.applyNativeButtonVisibility();

    // Join the HUD-layout registry so custom placements from the HUD editor
    // (settings.hudLayout) apply to the touch buttons. NOTE: the "joystick"
    // node is the static RESTING base, never the dynamic touch-anchored base —
    // onFpPointerDown writes px positions to the dynamic one per gesture, which
    // would fight the registry's % placement.
    this.hudUnregs.push(
      registerHudElement("interact", interactBtn),
      registerHudElement("jump", jumpBtn),
      registerHudElement("run", runBtn),
      registerHudElement("crouch", crouchBtn),
      registerHudElement("joystick", joyRest),
    );
  }

  // ---------- Island HUD hooks (SurvivalHud action ring) ----------

  /**
   * Hide/show the built-in jump/run/crouch touch buttons. The island hides
   * them — its action ring drives the same latches through the public methods
   * below — while the prologue lab keeps them untouched. The interact prompt
   * and joystick are unaffected.
   */
  setNativeButtonsVisible(visible: boolean): void {
    this.nativeButtonsVisible = visible;
    this.applyNativeButtonVisibility();
  }

  private applyNativeButtonVisibility(): void {
    const d = this.nativeButtonsVisible ? "" : "none";
    if (this.fpJumpBtn) this.fpJumpBtn.style.display = d;
    if (this.fpRunBtn) this.fpRunBtn.style.display = d;
    if (this.fpCrouchBtn) this.fpCrouchBtn.style.display = d;
  }

  /** Queue a jump (same path as Space / the native jump button). */
  requestJump(): void {
    if (!this.fpMode || !this.enabled) return;
    this.jumpRequested = true;
  }

  /** Flip the run latch (mutually exclusive with crouch); returns new state. */
  toggleRun(): boolean {
    this.setRunToggled(!this.runToggled);
    return this.runToggled;
  }

  /** Set the run latch directly — e.g. auto-cancel when stamina empties. */
  setRunToggled(on: boolean): void {
    this.runToggled = on;
    if (on) {
      this.crouchToggled = false;
      this.fpCrouchBtn?.classList.remove("is-active");
    }
    this.fpRunBtn?.classList.toggle("is-active", this.runToggled);
  }

  /** Flip the crouch latch (mutually exclusive with run); returns new state. */
  toggleCrouch(): boolean {
    this.crouchToggled = !this.crouchToggled;
    if (this.crouchToggled) {
      this.runToggled = false;
      this.fpRunBtn?.classList.remove("is-active");
    }
    this.fpCrouchBtn?.classList.toggle("is-active", this.crouchToggled);
    return this.crouchToggled;
  }

  /** Current mobile run latch (excludes hold-Shift). */
  get runLatched(): boolean {
    return this.runToggled;
  }

  /** Current mobile crouch latch (excludes the "C" key). */
  get crouchLatched(): boolean {
    return this.crouchToggled;
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
      // The HUD editor's joystick scale resizes the live joystick: visuals via
      // a CSS scale on the base, input math via the effective throw radius.
      const s = getSettings().hudLayout.joystick?.scale ?? 1;
      this.fpJoyScale = s;
      this.fpJoyRadius = InputManager.FP_JOY_BASE_RADIUS * s;
      this.fpJoyBase.style.left = `${e.clientX}px`;
      this.fpJoyBase.style.top = `${e.clientY}px`;
      this.fpJoyBase.style.transform = s === 1 ? "" : `scale(${s})`;
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
        // The base is CSS-scaled by fpJoyScale, so child px offsets get scaled
        // too — divide so the knob tracks the finger 1:1 on screen.
        const kx = dx / this.fpJoyScale;
        const ky = dy / this.fpJoyScale;
        this.fpJoyStick.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
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
    for (const unreg of this.hudUnregs) unreg();
    this.hudUnregs = [];
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
