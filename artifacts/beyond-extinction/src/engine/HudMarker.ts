import * as THREE from "three";
import { METERS_PER_UNIT } from "./beachTerrain";

/**
 * A screen-space objective marker: a small chip that projects a world point to
 * the HUD, shows an icon + label + live distance, and — when the target is
 * off-screen or behind you — pins to the screen edge as a direction arrow. This
 * is the "where do I go" guide that replaces the hard story-boundary box: the
 * player is free to roam, the marker keeps the objective findable.
 */
export class HudMarker {
  private readonly el: HTMLDivElement;
  private readonly iconEl: HTMLSpanElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly distEl: HTMLSpanElement;
  private target: THREE.Vector3 | null = null;
  private yOffset = 0;
  private readonly p = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "be-objmarker";
    this.el.innerHTML =
      '<span class="be-objmarker__icon"></span>' +
      '<span class="be-objmarker__label"></span>' +
      '<span class="be-objmarker__dist"></span>';
    this.iconEl = this.el.querySelector(".be-objmarker__icon")!;
    this.labelEl = this.el.querySelector(".be-objmarker__label")!;
    this.distEl = this.el.querySelector(".be-objmarker__dist")!;
    this.el.style.display = "none";
    parent.appendChild(this.el);
  }

  /** Aim at a live world position (pass null to hide). `yOffset` lifts the anchor
   *  off the ground (world units) so the chip floats over a character's head. */
  set(target: THREE.Vector3 | null, label = "", icon = "🧭", yOffset = 0): void {
    this.target = target;
    this.yOffset = yOffset;
    this.labelEl.textContent = label;
    this.iconEl.textContent = icon;
    if (!target) this.el.style.display = "none";
  }

  update(camera: THREE.Camera): void {
    if (!this.target) {
      this.el.style.display = "none";
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const margin = 46;

    this.p.copy(this.target);
    this.p.y += this.yOffset;
    this.p.project(camera);
    const behind = this.p.z > 1;

    let sx = (this.p.x * 0.5 + 0.5) * W;
    let sy = (-this.p.y * 0.5 + 0.5) * H;
    if (behind) {
      // Behind the camera the projection inverts; mirror through centre so the
      // edge arrow still points the right way round.
      sx = W - sx;
      sy = H - sy;
    }
    const offscreen =
      behind || sx < margin || sx > W - margin || sy < margin || sy > H - margin;

    const cx = THREE.MathUtils.clamp(sx, margin, W - margin);
    const cy = THREE.MathUtils.clamp(sy, margin, H - margin);

    const distM = Math.max(
      0,
      Math.round(camera.position.distanceTo(this.target) * METERS_PER_UNIT),
    );
    this.distEl.textContent = `${distM} m`;

    this.el.style.display = "flex";
    this.el.style.left = `${cx}px`;
    this.el.style.top = `${cy}px`;
    this.el.classList.toggle("be-objmarker--edge", offscreen);
    if (offscreen) {
      const ang = (Math.atan2(cy - H / 2, cx - W / 2) * 180) / Math.PI;
      this.el.style.setProperty("--arrow", `${ang}deg`);
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
