export interface InputCallbacks {
  onLook: (dxRad: number, dyRad: number) => void;
  onDrop: () => void;
}

type Role = "move" | "look";
interface PointerState {
  role: Role;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
}

/**
 * Touch + desktop input. Left half of the screen = virtual joystick (move),
 * right half = drag to look. WASD also moves; Space drops. Pointer ownership is
 * tracked by id so a move-touch and a look-touch never interfere.
 */
export class InputController {
  private layer: HTMLDivElement;
  private joyBase: HTMLDivElement;
  private joyStick: HTMLDivElement;
  private pointers = new Map<number, PointerState>();
  private keys = new Set<string>();
  private move = { x: 0, y: 0 };

  private lookSens = 0.0032; // radians per pixel
  private joyRadius = 56; // px

  constructor(
    private host: HTMLElement,
    private cb: InputCallbacks,
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "input-layer";

    this.joyBase = document.createElement("div");
    this.joyBase.className = "joystick-base";
    this.joyStick = document.createElement("div");
    this.joyStick.className = "joystick-stick";
    this.joyBase.appendChild(this.joyStick);
    this.joyBase.style.display = "none";

    this.layer.appendChild(this.joyBase);
    host.appendChild(this.layer);

    this.layer.addEventListener("pointerdown", this.onPointerDown);
    this.layer.addEventListener("pointermove", this.onPointerMove);
    this.layer.addEventListener("pointerup", this.onPointerUp);
    this.layer.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.target !== this.layer) return; // let HUD controls handle their own
    const role: Role = e.clientX < window.innerWidth / 2 ? "move" : "look";
    this.layer.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, {
      role,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
    });
    if (role === "move") {
      this.joyBase.style.left = `${e.clientX}px`;
      this.joyBase.style.top = `${e.clientY}px`;
      this.joyBase.style.display = "block";
      this.joyStick.style.transform = "translate(-50%, -50%)";
    }
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    const st = this.pointers.get(e.pointerId);
    if (!st) return;
    if (st.role === "move") {
      let dx = e.clientX - st.startX;
      let dy = e.clientY - st.startY;
      const len = Math.hypot(dx, dy);
      if (len > this.joyRadius) {
        dx = (dx / len) * this.joyRadius;
        dy = (dy / len) * this.joyRadius;
      }
      this.joyStick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      this.move.x = dx / this.joyRadius;
      this.move.y = -dy / this.joyRadius; // screen-up = forward
    } else {
      const dx = e.clientX - st.lastX;
      const dy = e.clientY - st.lastY;
      st.lastX = e.clientX;
      st.lastY = e.clientY;
      this.cb.onLook(dx * this.lookSens, dy * this.lookSens);
    }
    e.preventDefault();
  };

  private onPointerUp = (e: PointerEvent) => {
    const st = this.pointers.get(e.pointerId);
    if (!st) return;
    this.pointers.delete(e.pointerId);
    if (st.role === "move") {
      this.move.x = 0;
      this.move.y = 0;
      this.joyBase.style.display = "none";
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      return;
    }
    const k = e.key.toLowerCase();
    if (k === " ") {
      e.preventDefault();
      this.cb.onDrop();
      return;
    }
    this.keys.add(k);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  /** Combined movement vector from joystick + WASD, clamped to the unit disc. */
  getMove(): { x: number; y: number } {
    let x = this.move.x;
    let y = this.move.y;
    if (this.keys.has("w") || this.keys.has("arrowup")) y += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) y -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) x += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  dispose(): void {
    this.layer.removeEventListener("pointerdown", this.onPointerDown);
    this.layer.removeEventListener("pointermove", this.onPointerMove);
    this.layer.removeEventListener("pointerup", this.onPointerUp);
    this.layer.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.layer.remove();
  }
}
