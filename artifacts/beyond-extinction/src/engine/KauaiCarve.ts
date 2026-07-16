import { assetUrl } from "./assets";
import {
  carveTileHeights,
  riverCarveRadius,
  riverCarveDepth,
  type CarveSeg,
  type CarveLakeSpec,
} from "./kauaiCarveCore";

/**
 * Baked hydrography document (tools/bake_hydro.py → hydro.json). Shared by
 * KauaiCarve (channel carving) and KauaiHydro (water surfaces) — fetched ONCE
 * here; KauaiHydro awaits {@link KauaiCarve.prefetch} instead of re-fetching.
 */
export interface HydroRiver {
  name: string | null;
  toOcean: boolean;
  order: number;
  /** Terrain tile id ("A1".."H8") the run was split into. */
  tile: string;
  /** Polyline: [x, y, z, width] per point; y draped at bake time (unused). */
  pts: [number, number, number, number][];
}
export interface HydroLake {
  name: string | null;
  tile: string;
  /** Waterline elevation (m) baked from the DEM. */
  y: number;
  /** Outer shoreline ring: [x, z] pairs. */
  ring: [number, number][];
  /** Island cutouts inside the lake, same format. */
  holes: [number, number][][];
}
export interface HydroDoc {
  version: number;
  rivers: HydroRiver[];
  lakes: HydroLake[];
}

/**
 * Singleton that fetches hydro.json and presses the waterways into each
 * terrain tile's height data at decode time (KauaiTileStreamer calls
 * {@link applyToTile} after decoding, before the heights are published).
 * Carving the DATA — not the mesh — means physics, tree planting, NPC
 * grounding and the water surfaces all see the same carved ground for free.
 */
class KauaiCarveSingleton {
  private segs: CarveSeg[] = [];
  private lakes: CarveLakeSpec[] = [];
  private loaded = false;
  private docPromise?: Promise<HydroDoc | null>;

  /**
   * Kick (or join) the single hydro.json fetch. Call as early as possible —
   * the scene fires it in parallel with the terrain manifest so tile decodes
   * never wait on the network serially. Resolves null on failure (tiles then
   * build uncarved rather than not at all).
   */
  prefetch(): Promise<HydroDoc | null> {
    this.docPromise ??= (async () => {
      try {
        const res = await fetch(assetUrl("assets/terrain/kauai/hydro.json"));
        if (!res.ok) throw new Error(`hydro.json ${res.status}`);
        const doc = (await res.json()) as HydroDoc;
        this.build(doc);
        return doc;
      } catch (e) {
        console.error("[kauai] hydro.json load failed — terrain stays uncarved", e);
        return null;
      }
    })();
    return this.docPromise;
  }

  /** Resolves when carve data is ready (or has definitively failed). */
  async ready(): Promise<void> {
    await this.prefetch();
  }

  private build(doc: HydroDoc): void {
    for (const r of doc.rivers) {
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1];
        const b = r.pts[i];
        const w = (a[3] + b[3]) / 2;
        this.segs.push({
          ax: a[0],
          az: a[2],
          bx: b[0],
          bz: b[2],
          r: riverCarveRadius(w),
          depth: riverCarveDepth(w),
        });
      }
    }
    for (const l of doc.lakes) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [x, z] of l.ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      this.lakes.push({ y: l.y, ring: l.ring, holes: l.holes, minX, maxX, minZ, maxZ });
    }
    this.loaded = true;
  }

  /**
   * Carve one tile's freshly-decoded heights in place. No-op until the hydro
   * doc is loaded — callers must await {@link ready} first. Features are
   * pre-filtered to the tile's bounds (expanded by each feature's reach), and
   * the core rasterizer computes sample coords from global pixel indices, so
   * shared border samples stay bit-identical across neighbouring tiles.
   */
  applyToTile(h: Float32Array, P: number, S: number, col: number, row: number): void {
    if (!this.loaded) return;
    const x0 = (col - 4) * S;
    const x1 = x0 + S;
    const z0 = (row - 4) * S;
    const z1 = z0 + S;
    const segs = this.segs.filter(
      (s) =>
        Math.min(s.ax, s.bx) - s.r < x1 &&
        Math.max(s.ax, s.bx) + s.r > x0 &&
        Math.min(s.az, s.bz) - s.r < z1 &&
        Math.max(s.az, s.bz) + s.r > z0,
    );
    const lakes = this.lakes.filter(
      (l) => l.minX < x1 && l.maxX > x0 && l.minZ < z1 && l.maxZ > z0,
    );
    if (segs.length === 0 && lakes.length === 0) return;
    carveTileHeights(h, P, S, col, row, segs, lakes);
  }
}

export const KauaiCarve = new KauaiCarveSingleton();
