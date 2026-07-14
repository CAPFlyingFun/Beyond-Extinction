/**
 * PerfHud — the smoothed framerate tracker that drives the adaptive tree LOD
 * (see islandBillboardTrees), with an OPTIONAL tiny on-screen readout.
 *
 * The readout is off by default (the counter distracts more than it helps in
 * normal play); pass `show: true` — the scene wires this to a `?fps=1` URL flag
 * — to bring it back for performance tuning. Either way the fps is still tracked
 * so the LOD keeps adapting.
 *
 * The smoothing is an exponential moving average with a ~0.5 s time constant,
 * and single-frame hitches are clamped (a 2 s asset stall reads as one 10 fps
 * frame, not a spike to 0) so the average — and therefore the LOD — stays calm.
 */
export class PerfHud {
  private readonly el: HTMLDivElement | null = null;
  private fpsEma = 60;
  private acc = 0; // seconds since the last DOM text write (throttled)

  constructor(show = false, parent: HTMLElement = document.body) {
    if (show) {
      const el = document.createElement("div");
      el.className = "be-fps";
      el.textContent = "-- fps";
      parent.appendChild(el);
      this.el = el;
    }
  }

  /** Feed the frame delta (seconds). Cheap; call once per frame. */
  tick(dt: number): void {
    if (dt <= 0) return;
    const inst = 1 / Math.min(dt, 0.1); // clamp hitches to a 10 fps floor
    const k = 1 - Math.exp(-dt / 0.5); // ~0.5 s EMA
    this.fpsEma += (inst - this.fpsEma) * k;
    if (!this.el) return;
    this.acc += dt;
    if (this.acc >= 0.25) {
      this.acc = 0;
      this.el.textContent = `${Math.round(this.fpsEma)} fps`;
    }
  }

  /** Smoothed frames-per-second — the value the tree LOD keys off. */
  get fps(): number {
    return this.fpsEma;
  }

  dispose(): void {
    this.el?.remove();
  }
}
