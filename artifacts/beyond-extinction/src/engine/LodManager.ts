import * as THREE from "three";
import { METERS_PER_UNIT } from "./beachTerrain";
import { TREE_RANGE_M, type GraphicsQuality } from "./Settings";

/**
 * LodManager — the single source of truth for the world's draw distance.
 *
 * One manager owns the current fade-out distance (metres), derived from the
 * graphics-quality preset (a fixed tier distance, or fps-scaled for "auto").
 * Everything that wants distance culling flows through it:
 *   - the billboard forest READS `fadeEndM` each frame for its shader fade;
 *   - simpler objects (berry bushes, future props/rocks) REGISTER and get their
 *     `.visible` toggled by distance automatically.
 *
 * This keeps one consistent draw range for the whole scene: change the quality
 * setting and trees, bushes and props all pull in or push out together.
 */

const M = 1 / METERS_PER_UNIT; // metres -> world units

/** "auto" framerate → draw distance (metres), anchored to the fixed tiers:
 *  ≤20 fps → 50 (minimal) … 60 → 225 (high) … ≥72 → 300 (ultra). Lerped. */
const AUTO_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [20, TREE_RANGE_M.minimal],
  [30, TREE_RANGE_M.low],
  [40, TREE_RANGE_M.medium],
  [50, TREE_RANGE_M["medium-high"]],
  [60, TREE_RANGE_M.high],
  [72, TREE_RANGE_M.ultra],
];

function autoRange(fps: number): number {
  if (fps <= AUTO_ANCHORS[0][0]) return AUTO_ANCHORS[0][1];
  for (let i = 1; i < AUTO_ANCHORS.length; i++) {
    const [f1, d1] = AUTO_ANCHORS[i];
    if (fps <= f1) {
      const [f0, d0] = AUTO_ANCHORS[i - 1];
      return d0 + (d1 - d0) * ((fps - f0) / (f1 - f0));
    }
  }
  return AUTO_ANCHORS[AUTO_ANCHORS.length - 1][1];
}

/** Target draw distance (metres) for a quality preset at the current fps. */
export function rangeForQuality(q: GraphicsQuality, fps: number): number {
  return q === "auto" ? autoRange(fps) : TREE_RANGE_M[q];
}

export interface LodOptions {
  /** World XZ (units). Defaults to the object's current position. */
  x?: number;
  z?: number;
  /** Bounding radius (units) so large objects cull a little later. */
  radius?: number;
  /** Fraction of the global range this object uses (small ground detail can
   *  cull earlier). Default 1 = the full range. */
  rangeScale?: number;
  /** Optional hook: called each frame with (visible, distance/limit 0..1) for
   *  objects that want to fade or swap detail themselves. */
  onLod?: (visible: boolean, nearness: number) => void;
}

interface LodItem {
  obj: THREE.Object3D;
  x: number;
  z: number;
  radius: number;
  rangeScale: number;
  onLod?: (visible: boolean, nearness: number) => void;
}

export class LodManager {
  private quality: GraphicsQuality = "high";
  private fadeEnd = TREE_RANGE_M.high; // metres, eased toward the target
  private readonly items: LodItem[] = [];

  setQuality(q: GraphicsQuality): void {
    this.quality = q;
  }

  /** Current eased draw distance in metres (the trees read this). */
  get fadeEndM(): number {
    return this.fadeEnd;
  }

  /** Register an object for automatic distance culling. Returns an unregister
   *  function; the object's `.visible` is managed from here on. */
  register(obj: THREE.Object3D, opts: LodOptions = {}): () => void {
    const item: LodItem = {
      obj,
      x: opts.x ?? obj.position.x,
      z: opts.z ?? obj.position.z,
      radius: opts.radius ?? 0,
      rangeScale: opts.rangeScale ?? 1,
      onLod: opts.onLod,
    };
    this.items.push(item);
    return () => {
      const i = this.items.indexOf(item);
      if (i >= 0) this.items.splice(i, 1);
    };
  }

  /** Ease the draw distance toward the quality/fps target and cull registered
   *  objects. Returns the current fade-end (metres) so callers can pass it on
   *  to the forest shader. `fps` only matters for "auto". */
  update(dt: number, camPos: THREE.Vector3, fps = 60): number {
    const target = rangeForQuality(this.quality, fps);
    const k = dt > 0 ? 1 - Math.exp(-dt / 1.0) : 1; // ~1 s ease, no pop
    this.fadeEnd += (target - this.fadeEnd) * k;

    const rangeU = this.fadeEnd * M;
    for (const it of this.items) {
      const dx = it.x - camPos.x;
      const dz = it.z - camPos.z;
      const lim = rangeU * it.rangeScale + it.radius;
      const d2 = dx * dx + dz * dz;
      const vis = d2 < lim * lim;
      if (it.obj.visible !== vis) it.obj.visible = vis;
      if (it.onLod) it.onLod(vis, Math.sqrt(d2) / Math.max(lim, 1));
    }
    return this.fadeEnd;
  }

  /** Drop all registrations (scene teardown). */
  clear(): void {
    this.items.length = 0;
  }
}
