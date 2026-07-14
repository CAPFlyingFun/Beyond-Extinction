/**
 * PerfHud — a tiny always-on framerate readout in the corner of the screen.
 *
 * It also owns the *smoothed* framerate the rest of the game reads: the number
 * shown here is the exact same `fps` the billboard forest uses to pick its draw
 * distance (see islandBillboardTrees), so what you see is what's driving the LOD.
 *
 * The smoothing is an exponential moving average with a ~0.5 s time constant,
 * and single-frame hitches are clamped (a 2 s asset stall reads as one 10 fps
 * frame, not a spike to 0) so the average — and therefore the LOD — stays calm.
 */
export class PerfHud {
  readonly el: HTMLDivElement;
  private fpsEma = 60;
  private acc = 0; // seconds since the last DOM text write (throttled)
  private visible = true;

  constructor(parent: HTMLElement = document.body) {
    const el = document.createElement("div");
    el.className = "be-fps";
    el.textContent = "-- fps";
    parent.appendChild(el);
    this.el = el;
  }

  /** Feed the frame delta (seconds). Cheap; call once per frame. */
  tick(dt: number): void {
    if (dt <= 0) return;
    const inst = 1 / Math.min(dt, 0.1); // clamp hitches to a 10 fps floor
    const k = 1 - Math.exp(-dt / 0.5); // ~0.5 s EMA
    this.fpsEma += (inst - this.fpsEma) * k;
    this.acc += dt;
    if (this.acc >= 0.25) {
      this.acc = 0;
      if (this.visible) this.el.textContent = `${Math.round(this.fpsEma)} fps`;
    }
  }

  /** Smoothed frames-per-second — the value the tree LOD keys off. */
  get fps(): number {
    return this.fpsEma;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? "" : "none";
  }

  dispose(): void {
    this.el.remove();
  }
}
