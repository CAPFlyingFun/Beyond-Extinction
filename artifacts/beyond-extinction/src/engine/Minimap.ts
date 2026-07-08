/**
 * Blueprint-style vector minimap — a web port of the Godot project's minimap.gd.
 * Top-right HUD panel that draws the floor plan (room outlines, door gaps, ring
 * features), the active player's facing arrow, and a pulsing objective dot. Press
 * M (or tap the panel) to expand to a big centred view.
 *
 * Fully data-driven so it doubles as the template for the island chapter: the
 * scene feeds world-space XZ geometry (bounds/rooms/doors/circles) once, then
 * calls {@link setPlayer}/{@link setMarker} each frame and {@link render} draws.
 * World X → canvas X (east right), world Z → canvas Y (north up), matching the
 * top-down blueprint.
 */
export interface MinimapRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export interface MinimapConfig {
  bounds: MinimapRect;
  rooms: MinimapRect[];
  doors: Array<{ x0: number; z0: number; x1: number; z1: number }>;
  circles?: Array<{ x: number; z: number; r: number }>;
}

const COL_BG = "rgba(5,13,20,0.72)";
const COL_FRAME = "rgba(89,191,242,0.9)";
const COL_WALL = "rgba(204,224,242,0.95)";
const COL_DOOR = "rgba(255,214,26,1)";
const COL_RING = "rgba(102,204,255,0.9)";
const COL_PLAYER = "rgba(77,255,115,1)";
const COL_MARKER = "rgba(255,214,26,1)";
const INSET = 10;

export class Minimap {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly c: CanvasRenderingContext2D;
  private big = false;
  private px = 0;
  private pz = 0;
  private fx = 0; // player forward (world XZ), normalized
  private fz = 1;
  private hasPlayer = false;
  private marker: { x: number; z: number } | null = null;
  private t = 0;
  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onResize: () => void;

  constructor(
    parent: HTMLElement,
    private readonly cfg: MinimapConfig,
  ) {
    this.root = document.createElement("div");
    this.root.className = "be-minimap";
    this.canvas = document.createElement("canvas");
    this.root.appendChild(this.canvas);
    const hint = document.createElement("div");
    hint.className = "be-minimap__hint";
    hint.textContent = "M — map";
    this.root.appendChild(hint);
    parent.appendChild(this.root);
    this.c = this.canvas.getContext("2d")!;

    // Tap/click toggles the big view (mobile has no M key).
    this.root.addEventListener("click", () => this.toggleBig());
    this.onKey = (e) => {
      if (e.key === "m" || e.key === "M") this.toggleBig();
    };
    window.addEventListener("keydown", this.onKey);
    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
    // Measure after the element has been laid out by CSS.
    requestAnimationFrame(() => this.resize());
  }

  /** Active player world position + normalized world-forward (XZ). */
  setPlayer(x: number, z: number, fx: number, fz: number): void {
    this.px = x;
    this.pz = z;
    const len = Math.hypot(fx, fz) || 1;
    this.fx = fx / len;
    this.fz = fz / len;
    this.hasPlayer = true;
  }

  /** Objective world position (null hides the dot). */
  setMarker(pos: { x: number; z: number } | null): void {
    this.marker = pos;
  }

  toggleBig(): void {
    this.big = !this.big;
    this.root.classList.toggle("big", this.big);
    const hint = this.root.querySelector(".be-minimap__hint");
    if (hint) hint.textContent = this.big ? "M — close" : "M — map";
    requestAnimationFrame(() => this.resize());
  }

  /** Match the canvas backing store to its CSS box (crisp on hi-dpi). */
  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.c.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(dt: number): void {
    this.t += dt;
    const c = this.c;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (w === 0 || h === 0) return;
    // Self-heal the backing store if it hasn't matched the CSS box yet (first
    // frame before layout, or right after a big-view toggle changed the size).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.resize();
    }
    c.clearRect(0, 0, w, h);
    c.fillStyle = COL_BG;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = COL_FRAME;
    c.lineWidth = 2;
    c.strokeRect(1, 1, w - 2, h - 2);

    // Letterbox-fit the world bounds into the inset box.
    const b = this.cfg.bounds;
    const bw = b.maxX - b.minX;
    const bh = b.maxZ - b.minZ;
    const availW = w - INSET * 2;
    const availH = h - INSET * 2;
    const sc = Math.min(availW / bw, availH / bh);
    const offX = INSET + (availW - bw * sc) / 2 - b.minX * sc;
    const offZ = INSET + (availH - bh * sc) / 2 - b.minZ * sc;
    const sx = (x: number) => offX + x * sc;
    const sz = (z: number) => offZ + z * sc;

    // Rooms.
    c.strokeStyle = COL_WALL;
    c.lineWidth = 2;
    for (const r of this.cfg.rooms) {
      c.strokeRect(sx(r.minX), sz(r.minZ), (r.maxX - r.minX) * sc, (r.maxZ - r.minZ) * sc);
    }
    // Door gaps.
    c.strokeStyle = COL_DOOR;
    c.lineWidth = 3;
    for (const d of this.cfg.doors) {
      c.beginPath();
      c.moveTo(sx(d.x0), sz(d.z0));
      c.lineTo(sx(d.x1), sz(d.z1));
      c.stroke();
    }
    // Ring features.
    c.strokeStyle = COL_RING;
    c.lineWidth = 2;
    for (const ci of this.cfg.circles ?? []) {
      c.beginPath();
      c.arc(sx(ci.x), sz(ci.z), ci.r * sc, 0, Math.PI * 2);
      c.stroke();
    }

    // Pulsing objective dot.
    if (this.marker) {
      const pr = 4 + 1.6 * Math.sin(this.t * 5);
      c.fillStyle = COL_MARKER;
      c.beginPath();
      c.arc(sx(this.marker.x), sz(this.marker.z), pr, 0, Math.PI * 2);
      c.fill();
    }

    // Active player arrow (position + facing).
    if (this.hasPlayer) {
      const mx = sx(this.px);
      const mz = sz(this.pz);
      // World forward (fx,fz) → canvas (X right, Z down). Perp for the base.
      const fX = this.fx;
      const fZ = this.fz;
      const pX = -fZ;
      const pZ = fX;
      const tip = [mx + fX * 9, mz + fZ * 9];
      const left = [mx - fX * 5 + pX * 5, mz - fZ * 5 + pZ * 5];
      const right = [mx - fX * 5 - pX * 5, mz - fZ * 5 - pZ * 5];
      c.fillStyle = COL_PLAYER;
      c.beginPath();
      c.moveTo(tip[0], tip[1]);
      c.lineTo(left[0], left[1]);
      c.lineTo(right[0], right[1]);
      c.closePath();
      c.fill();
    }
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
  }
}
