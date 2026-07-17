/**
 * Pure carve math for the Kauaʻi waterways — no three.js, no DOM, no fetch —
 * so it can be unit-tested (seam determinism matters: tiles share their border
 * heights byte-identically and the carve must preserve that).
 *
 * Rivers press a smooth cos²-profile channel into the 513² tile height data at
 * decode time; lakes floor their interior below the baked waterline with a
 * feathered rim. Because the DATA is carved before the mesh is built, every
 * consumer — the rendered mesh, player physics, NPC grounding, tree planting,
 * the hydro water surfaces — agrees automatically.
 *
 * Determinism at tile seams: sample world coords are computed from the GLOBAL
 * pixel index (col·(P−1)+i), never from tileCentre + localOffset, so the
 * floating-point result for a shared border sample is bit-identical in both
 * tiles. Carves accumulate with max()/min() (order-independent), and the fixed
 * rivers-then-lakes ordering is the same everywhere.
 */

export interface CarveSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Carve half-radius from the centerline (m). */
  r: number;
  /** Full carve depth at the centerline (m). */
  depth: number;
}

export interface CarveLakeSpec {
  /** Baked waterline elevation (m). */
  y: number;
  ring: [number, number][];
  holes: [number, number][][];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Half the world extent (8 tiles × 7 km): world x/z ∈ [−28 000, 28 000]. */
export const HALF_WORLD = 28000;

// Channel shaping — sized to press a REAL, swimmable trench the 36 m mesh can
// render. The mesh samples heights every 36.5 m (SEG 192 over 7 km), so a carve
// narrower than that falls between vertices and mutes to nothing (the v80
// radius-24 channels did this → the flat water sat ON the ground as "floating
// plates"). R now floors at 48 m (≈ a 96 m channel, ~1.3 facets each side) with
// a FLAT bottom across the inner half (see FLAT_FRAC in carveTileHeights), so a
// vertex always lands in the flat bed at full depth. Depth floors at 3 m — below
// SWIM_DEPTH (1.3 m) plus margin — so the filled channel is deep enough to swim.
// Bigger baked widths widen and deepen proportionally.
export function riverCarveRadius(w: number): number {
  return Math.max(w * 1.3, 48);
}
export function riverCarveDepth(w: number): number {
  return Math.min(Math.max(w * 0.6, 3.0), 6.0);
}
/** Fraction of the carve radius that is a FLAT bed (rest is the cos² wall). */
export const FLAT_FRAC = 0.5;
/** Lakes floor to (waterline − LAKE_DEPTH), feathered over LAKE_FEATHER m. */
export const LAKE_DEPTH = 2;
export const LAKE_FEATHER = 15;

/** Squared distance from point (px,pz) to segment (ax,az)-(bx,bz). */
function distSqToSeg(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const ll = dx * dx + dz * dz;
  let t = ll > 0 ? ((px - ax) * dx + (pz - az) * dz) / ll : 0;
  t = Math.min(1, Math.max(0, t));
  const ex = px - (ax + dx * t);
  const ez = pz - (az + dz * t);
  return ex * ex + ez * ez;
}

/** Even-odd point-in-polygon in world XZ. */
function insidePoly(px: number, pz: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance from a point to the nearest edge of ring/holes (m). */
function distToEdges(
  px: number,
  pz: number,
  ring: [number, number][],
  holes: [number, number][][],
): number {
  let best = Infinity;
  const scan = (r: [number, number][]): void => {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const d = distSqToSeg(px, pz, r[j][0], r[j][1], r[i][0], r[i][1]);
      if (d < best) best = d;
    }
  };
  scan(ring);
  for (const h of holes) scan(h);
  return Math.sqrt(best);
}

/**
 * Carve river channels + lake beds into one tile's height data, in place.
 * `segs`/`lakes` may be the global lists pre-filtered to this tile's bounds
 * (callers should expand the tile bbox by each feature's reach when filtering).
 */
export function carveTileHeights(
  h: Float32Array,
  P: number,
  S: number,
  col: number,
  row: number,
  segs: readonly CarveSeg[],
  lakes: readonly CarveLakeSpec[],
): void {
  const step = S / (P - 1);
  const g0x = col * (P - 1); // global pixel index of this tile's first column
  const g0z = row * (P - 1);
  // Rivers: rasterize each segment's reach, accumulating the DEEPEST carve per
  // sample (max — confluences don't stack, the bigger channel wins).
  const carve = new Float32Array(P * P);
  for (const s of segs) {
    const r = s.r;
    const gxMin = Math.max(g0x, Math.floor((Math.min(s.ax, s.bx) - r + HALF_WORLD) / step));
    const gxMax = Math.min(g0x + P - 1, Math.ceil((Math.max(s.ax, s.bx) + r + HALF_WORLD) / step));
    const gzMin = Math.max(g0z, Math.floor((Math.min(s.az, s.bz) - r + HALF_WORLD) / step));
    const gzMax = Math.min(g0z + P - 1, Math.ceil((Math.max(s.az, s.bz) + r + HALF_WORLD) / step));
    const rSq = r * r;
    for (let gz = gzMin; gz <= gzMax; gz++) {
      const z = gz * step - HALF_WORLD; // global-index coords: seam-identical
      const jBase = (gz - g0z) * P - g0x;
      for (let gx = gxMin; gx <= gxMax; gx++) {
        const x = gx * step - HALF_WORLD;
        const dSq = distSqToSeg(x, z, s.ax, s.az, s.bx, s.bz);
        if (dSq >= rSq) continue;
        // Flat-bottomed U-channel: full depth across the inner FLAT_FRAC of the
        // radius (a real flat bed the 36 m mesh can land a vertex in → a trench
        // that actually renders and holds swimmable water), then a cos² wall out
        // to r. A pure cos² "V" put full depth only at the exact centreline, so
        // between mesh vertices it muted to nothing and the water floated.
        const dist = Math.sqrt(dSq);
        const rFlat = r * FLAT_FRAC;
        let prof: number;
        if (dist <= rFlat) {
          prof = 1;
        } else {
          const c = Math.cos((Math.PI / 2) * ((dist - rFlat) / (r - rFlat)));
          prof = c * c;
        }
        const depth = s.depth * prof;
        const idx = jBase + gx;
        if (depth > carve[idx]) carve[idx] = depth;
      }
    }
  }
  for (let i = 0; i < carve.length; i++) h[i] -= carve[i];
  // Lakes (after rivers, fixed order everywhere): floor the interior toward
  // (waterline − LAKE_DEPTH), feathered from the shoreline inward. min() only —
  // a DEM bed already deeper than the target is never raised.
  for (const l of lakes) {
    const target = l.y - LAKE_DEPTH;
    const gxMin = Math.max(g0x, Math.floor((l.minX + HALF_WORLD) / step));
    const gxMax = Math.min(g0x + P - 1, Math.ceil((l.maxX + HALF_WORLD) / step));
    const gzMin = Math.max(g0z, Math.floor((l.minZ + HALF_WORLD) / step));
    const gzMax = Math.min(g0z + P - 1, Math.ceil((l.maxZ + HALF_WORLD) / step));
    for (let gz = gzMin; gz <= gzMax; gz++) {
      const z = gz * step - HALF_WORLD;
      const jBase = (gz - g0z) * P - g0x;
      for (let gx = gxMin; gx <= gxMax; gx++) {
        const x = gx * step - HALF_WORLD;
        if (!insidePoly(x, z, l.ring)) continue;
        let inHole = false;
        for (const hole of l.holes) {
          if (insidePoly(x, z, hole)) {
            inHole = true;
            break;
          }
        }
        if (inHole) continue;
        const f0 = Math.min(1, distToEdges(x, z, l.ring, l.holes) / LAKE_FEATHER);
        const f = f0 * f0 * (3 - 2 * f0); // smoothstep rim
        const idx = jBase + gx;
        const cur = h[idx];
        const lowered = cur + (target - cur) * f;
        if (lowered < cur) h[idx] = lowered;
      }
    }
  }
}
