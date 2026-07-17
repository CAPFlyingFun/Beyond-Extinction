import * as THREE from "three";
import { loadTexture } from "./assets";
import type { KauaiTileStreamer } from "./KauaiTileStreamer";
import { KauaiCarve, type HydroRiver, type HydroLake } from "./KauaiCarve";
import { riverCarveRadius } from "./kauaiCarveCore";

/**
 * Real Kauaʻi hydrography (USGS NHDPlus HR), baked offline by
 * tools/bake_hydro.py into assets/terrain/kauai/hydro.json:
 *
 *  - rivers: polyline runs (world XZ + Y draped on the RENDERED terrain mesh,
 *    monotonic downstream) with a per-point width from drainage area. Runs are
 *    pre-split per terrain tile so they stream with {@link KauaiTileStreamer}.
 *  - lakes/reservoirs: flat rings (+holes) at a baked waterline Y, triangulated
 *    here at load time with THREE.ShapeUtils.
 *
 * Rendering matches the ocean look (translucent blue + animated ripple normals
 * + fresnel sheen) so all water reads as one family. River UVs run along the
 * channel (u = metres/8) and the normal map scrolls downstream; lake UVs are
 * world-locked like the ocean's.
 *
 * Each tile's rivers merge into ONE mesh and its lakes into another (2 draw
 * calls per resident tile, worst case). Chunks show/hide with tile residency —
 * geometry is built lazily on first residency and cached for the scene's life.
 */

// Water surfaces are FLAT canals (RCT / Planet-Coaster autofill), levelled
// against the LIVE streamed terrain (streamer.surfaceHeightAt — triangle-exact
// against the rendered mesh). Rivers fill a widened, deepened trench (see
// riverCarveRadius/Depth) to a dead-flat pool level that steps down at weirs;
// lakes sit flat at their baked waterline. Water is never coupled to the ocean
// tide (that only moves the separate ocean plane).
const LIFT_M = 0.18; // min water depth above the channel centreline (m)
const FILL_DEPTH = 2.4; // target water depth above the carved bed (m) — swimmable
const BANK_FREEBOARD = 0.05; // keep the surface this far below the trench rim (m)
const EDGE_SMOOTH = 4; // ± samples averaged to smooth the canal width (curved banks)
const LEVEL_SMOOTH = 3; // ± samples averaged to smooth the surface along the run
const UV_M = 8; // metres per ripple-normal repeat (same wavelength as the ocean)
const RIVER_SCROLL = 0.05; // u/s ≈ 0.4 m/s downstream drift
const LAKE_DRIFT = { x: 0.014, y: 0.01 }; // ocean's ripple drift (u/s)

/**
 * Ocean-family water material (see KauaiStreamScene.makeOceanMaterial).
 *
 * `sink` picks the polygon-offset direction, and this is the whole reason
 * rivers used to break into shards:
 *
 *  • LAKES sit in a real 2 m-carved basin, so — like the ocean — they want the
 *    terrain to WIN near-coplanar ties at their feathered rim (positive offset,
 *    fragments pushed DEEPER). The water then hides cleanly inside the bank.
 *  • RIVERS have no real trench at mesh resolution: the channel carve (≤ a few
 *    metres, ≤ 1 mesh facet wide) is muted to almost nothing by the 36 m-facet
 *    render grid, so a river ribbon lies essentially ON its bed. The ocean's
 *    positive offset then pushed those fragments BEHIND the bed — and because
 *    one depth step is metres at distance, the whole ribbon lost the depth test
 *    from a few dozen metres out and surfaced only in the odd dip: the
 *    "disconnected blue shards". Rivers therefore need the OPPOSITE bias
 *    (negative offset) so the thin sheet of water reliably beats the bed it
 *    rests on, at every distance.
 */
function makeWaterMaterial(color: number, sink = true): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.13,
    metalness: 0.22,
    transparent: true,
    opacity: 0.82,
    envMapIntensity: 1.1,
    normalScale: new THREE.Vector2(0.55, 0.55),
    side: THREE.DoubleSide, // ribbons stay visible from below-bank angles
    // Polygon-offset z-fight guard. Positive (sink) pushes fragments DEEPER so
    // near-coplanar terrain wins — right for pools/ocean whose edge should hide
    // in the bank. Negative LIFTS river fragments toward the camera so the
    // draped-flat sheet wins over the bed it sits on (see the doc comment).
    // Units are deliberately generous: at multi-km distance one 24-bit depth
    // step is metres, so a small factor still ties on flat far terrain.
    polygonOffset: true,
    polygonOffsetFactor: sink ? 2 : -2,
    polygonOffsetUnits: sink ? 4 : -4,
  });
  const sky = new THREE.Color(0x9fc6df).convertSRGBToLinear();
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSky = { value: sky };
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSky;")
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
        {
          float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += uSky * fres * 0.35;
        }`,
      );
  };
  return mat;
}

type Pt4 = [number, number, number, number];

/**
 * Centripetal Catmull-Rom resample of a run's [x, y, z, width] points.
 *
 * The baked NHDPlus vertices sit ~34 m apart, so straight segments meeting at
 * sharp vertices read as a blocky, faceted ribbon. We pass a smooth spline
 * through the original knots and re-sample it every ~STEP metres so bends round
 * out. Centripetal parameterisation (alpha = 0.5) is used specifically because
 * it never self-intersects or overshoots into cusps — the curve stays inside
 * the channel it was digitised from, so the draped Y won't dive under terrain.
 * All four channels (position + width) are interpolated together so the ribbon
 * stays in sync.
 */
function smoothRun(pts: Pt4[]): Pt4[] {
  const n = pts.length;
  if (n < 3) return pts; // 2 points is already a straight segment
  const STEP = 6; // target metres between re-sampled points
  const alpha = 0.5;
  const planar = (a: Pt4, b: Pt4): number => Math.hypot(b[0] - a[0], b[2] - a[2]);
  const knot = (a: Pt4, b: Pt4): number => Math.pow(Math.max(planar(a, b), 1e-4), alpha);
  // Barry-Goldman pyramidal Catmull-Rom, evaluated per channel.
  const lerp = (p: Pt4, q: Pt4, s: number): Pt4 => [
    p[0] + (q[0] - p[0]) * s,
    p[1] + (q[1] - p[1]) * s,
    p[2] + (q[2] - p[2]) * s,
    p[3] + (q[3] - p[3]) * s,
  ];
  const out: Pt4[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const steps = Math.max(1, Math.round(planar(p1, p2) / STEP));
    for (let s = 0; s < steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const a1 = lerp(p0, p1, (t - t0) / (t1 - t0));
      const a2 = lerp(p1, p2, (t - t1) / (t2 - t1));
      const a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      const b1 = lerp(a1, a2, (t - t0) / (t2 - t0));
      const b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
      out.push(lerp(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  out.push(pts[n - 1]);
  return out;
}

/** Terrain-grounded surface height (m) for a water vertex at world (x, z). */
type GroundY = (x: number, z: number) => number;

/**
 * River ribbon that fills a real carved trench.
 *
 * Earlier passes fought mesh resolution and lost: a thin channel carve is muted
 * to nothing by the 36 m render facets, so the water had no rendered banks and
 * sat ON the ground as "floating plates". The fix is upstream — {@link
 * riverCarveRadius}/{@link riverCarveDepth} now press a genuinely WIDE, DEEP,
 * flat-bottomed trench (≥96 m, ≥3 m) the mesh actually shows. Here the water
 * just fills that trench: the surface sits FILL_DEPTH above the carved bed
 * (swimmable — see KauaiStreamScene's river physics) and flows downhill inside
 * it, and each bank's water edge is found by marching out to where the RENDERED
 * ground rises to the surface level, so the water tucks into the true banks
 * instead of floating over or flooding past them.
 */
function buildRibbon(
  run: HydroRiver,
  positions: number[],
  uvs: number[],
  indices: number[],
  groundY: GroundY,
  samples: RiverSample[],
): void {
  const pts = smoothRun(run.pts);
  const n = pts.length;
  if (n < 2) return;
  // Valid cross-sections: world frame (centre + XZ-perpendicular), u coord
  // and width.
  interface CS {
    x: number;
    z: number;
    px: number;
    pz: number;
    u: number;
    w: number;
  }
  const cs: CS[] = [];
  let cum = 0;
  let prevX = pts[0][0];
  let prevZ = pts[0][2];
  for (let i = 0; i < n; i++) {
    const [x, , z, w] = pts[i];
    // central-difference direction (falls back to fwd/back at the ends)
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue; // degenerate — skip, quad bridges the gap
    cum += Math.hypot(x - prevX, z - prevZ);
    prevX = x;
    prevZ = z;
    cs.push({ x, z, px: -dz / len, pz: dx / len, u: cum / UV_M, w });
  }
  const m = cs.length;
  if (m < 2) return;
  // The carve now presses a REAL trench (see riverCarveRadius/Depth), so the
  // water simply FILLS it to a swimmable depth above the carved bed and flows
  // downhill inside it — no faked flat pools, no floating. gC is the rendered
  // channel-floor (the trench's low point); the surface sits FILL_DEPTH above
  // it, but never above the trench rim (sampled at ±R) so it can't sheet out.
  const gC = new Float64Array(m);
  const rimCap = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const c = cs[i];
    const R = riverCarveRadius(c.w);
    gC[i] = groundY(c.x, c.z);
    const rimL = groundY(c.x + c.px * R, c.z + c.pz * R);
    const rimR = groundY(c.x - c.px * R, c.z - c.pz * R);
    rimCap[i] = Math.min(rimL, rimR) - BANK_FREEBOARD;
  }
  // Surface level: bed + FILL_DEPTH, capped under the rim, then smoothed along
  // the run so it reads as a continuous sheet (and re-clamped so smoothing can
  // never push it below the bed or above the rim).
  const rawLevel = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    rawLevel[i] = Math.min(Math.max(gC[i] + FILL_DEPTH, gC[i] + LIFT_M), rimCap[i]);
  }
  const level = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const k0 = Math.max(0, i - LEVEL_SMOOTH);
    const k1 = Math.min(m - 1, i + LEVEL_SMOOTH);
    let s = 0;
    for (let k = k0; k <= k1; k++) s += rawLevel[k];
    const avg = s / (k1 - k0 + 1);
    level[i] = Math.min(Math.max(avg, gC[i] + LIFT_M), Math.max(rimCap[i], gC[i] + LIFT_M));
  }
  // Water edge per side: march outward from the centreline until the RENDERED
  // bank rises to the water level — that's the true waterline, so the edge
  // tucks into the actual bank (never floats over it, never floods past it).
  const edgeToWaterline = (
    cx: number,
    cz: number,
    ex: number,
    ez: number,
    lvl: number,
    R: number,
  ): number => {
    let d = R;
    for (let t = 4; t <= R; t += 3) {
      if (groundY(cx + ex * t, cz + ez * t) >= lvl) {
        d = t;
        break;
      }
    }
    return Math.max(6, d); // always show a little water even in a shallow spot
  };
  const halfL = new Float64Array(m);
  const halfR = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const c = cs[i];
    const R = riverCarveRadius(c.w);
    halfL[i] = edgeToWaterline(c.x, c.z, c.px, c.pz, level[i], R);
    halfR[i] = edgeToWaterline(c.x, c.z, -c.px, -c.pz, level[i], R);
  }
  // Smooth each bank's width along the run so the shoreline reads as a flowing
  // curve rather than a per-sample zig-zag.
  const smoothWidth = (src: Float64Array): Float64Array => {
    const out = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const k0 = Math.max(0, i - EDGE_SMOOTH);
      const k1 = Math.min(m - 1, i + EDGE_SMOOTH);
      let s = 0;
      for (let k = k0; k <= k1; k++) s += src[k];
      out[i] = s / (k1 - k0 + 1);
    }
    return out;
  };
  const hL = smoothWidth(halfL);
  const hR = smoothWidth(halfR);
  const base = positions.length / 3;
  for (let i = 0; i < m; i++) {
    const c = cs[i];
    positions.push(c.x + c.px * hL[i], level[i], c.z + c.pz * hL[i]);
    positions.push(c.x - c.px * hR[i], level[i], c.z - c.pz * hR[i]);
    uvs.push(c.u, 0, c.u, (hL[i] + hR[i]) / UV_M);
    // Water-level query sample (for swim physics), decimated every 3rd
    // cross-section (~18 m apart) — the generous half reach overlaps the gaps,
    // and the caller's depth = level − ground test discards any dry-bank
    // overshoot. Keeps the per-frame waterLevelAt scan cheap on mobile.
    if (i % 3 === 0) {
      samples.push({ x: c.x, z: c.z, level: level[i], half: Math.max(hL[i], hR[i]) + 3 });
    }
  }
  for (let i = 0; i < m - 1; i++) {
    const a = base + i * 2;
    // two triangles per quad, wound for +Y normals
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

/** Lake mesh from ring + holes: one FLAT plane at the baked waterline. */
function buildLake(
  lake: HydroLake,
  positions: number[],
  uvs: number[],
  indices: number[],
): void {
  const contour = lake.ring.map(([x, z]) => new THREE.Vector2(x, z));
  const holes = lake.holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  let tris: number[][];
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return; // malformed ring — skip rather than crash the scene
  }
  const all = contour.concat(...holes);
  const base = positions.length / 3;
  for (const v of all) {
    // v.x = world X, v.y = world Z. Flat at the baked waterline: the carve
    // floors the bed 2 m below it, so the surface reads as a filled pool and
    // its edge hides inside the feathered banks (RCT-style), instead of the
    // old grounded rim that draped the "water" over the terrain.
    positions.push(v.x, lake.y, v.y);
    uvs.push(v.x / UV_M, v.y / UV_M);
  }
  for (const [a, b, c] of tris) {
    // ShapeUtils winds for +Z-up shapes; our Y-up flat mesh needs the flip
    indices.push(base + a, base + c, base + b);
  }
}

/** Even-odd point-in-polygon in world XZ. */
function insideRing(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** True if (x, z) is inside a lake's shoreline ring and not in one of its holes. */
function pointInLake(x: number, z: number, lake: HydroLake): boolean {
  if (!insideRing(x, z, lake.ring)) return false;
  for (const h of lake.holes) if (insideRing(x, z, h)) return false;
  return true;
}

/** One centreline cross-section's water surface, for waterLevelAt() queries. */
interface RiverSample {
  x: number;
  z: number;
  level: number;
  half: number; // generous lateral reach (the depth check filters dry banks)
}
/** A river run's samples plus a bbox for cheap rejection. */
interface RiverRun {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  samples: RiverSample[];
}

interface Chunk {
  tile: string;
  cx: number;
  cz: number;
  rivers: HydroRiver[];
  lakes: HydroLake[];
  built: boolean;
  meshes: THREE.Mesh[];
  /** Built lazily with the geometry — used by waterLevelAt() for swim physics. */
  riverRuns: RiverRun[];
}

export class KauaiHydro {
  readonly group = new THREE.Group();

  private readonly scene: THREE.Scene;
  private readonly chunks = new Map<string, Chunk>();
  private riverMat: THREE.MeshStandardMaterial;
  private lakeMat: THREE.MeshStandardMaterial;
  private riverNormal?: THREE.Texture;
  private lakeNormal?: THREE.Texture;
  private t = 0;
  private disposed = false;
  private loaded = false;

  /** True once hydro.json is parsed, so waterNear() can answer authoritatively. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = "kauai-hydro";
    scene.add(this.group);
    // Slightly deeper blue-green than the open ocean so channels read as
    // river water, while staying in the same material family. Rivers lift
    // toward the camera (sink = false) so the thin channel sheet beats its
    // bed; lakes sink like the ocean so their rim hides in the bank.
    this.riverMat = makeWaterMaterial(0x175b66, false);
    this.lakeMat = makeWaterMaterial(0x14526e, true);
    void this.loadNormals();
    void this.load();
  }

  private async loadNormals(): Promise<void> {
    const tex = await loadTexture("assets/textures/water_normal.png");
    if (!tex || this.disposed) return;
    const prep = (t: THREE.Texture): THREE.Texture => {
      t.colorSpace = THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      return t;
    };
    // independent clones: rivers scroll downstream, lakes drift like the ocean
    this.riverNormal = prep(tex.clone());
    this.lakeNormal = prep(tex.clone());
    this.riverMat.normalMap = this.riverNormal;
    this.riverMat.needsUpdate = true;
    this.lakeMat.normalMap = this.lakeNormal;
    this.lakeMat.needsUpdate = true;
  }

  private async load(): Promise<void> {
    // Single shared fetch: KauaiCarve owns hydro.json (it also presses the
    // channels into the terrain heights at tile-decode time).
    const doc = await KauaiCarve.prefetch();
    if (!doc) return; // KauaiCarve already logged the failure
    if (this.disposed) return;
    const chunkOf = (tile: string): Chunk => {
      let c = this.chunks.get(tile);
      if (!c) {
        const col = tile.charCodeAt(0) - 65;
        const row = parseInt(tile.slice(1), 10) - 1;
        c = {
          tile,
          cx: (col - 3.5) * 7000,
          cz: (row - 3.5) * 7000,
          rivers: [],
          lakes: [],
          built: false,
          meshes: [],
          riverRuns: [],
        };
        this.chunks.set(tile, c);
      }
      return c;
    };
    for (const r of doc.rivers) chunkOf(r.tile).rivers.push(r);
    for (const l of doc.lakes) chunkOf(l.tile).lakes.push(l);
    this.loaded = true;
  }

  /**
   * River segments + lake rings overlapping an XZ box, for planting exclusion.
   * River widths (baked per point) are halved and grown by `margin` so callers
   * can test "does this point touch water" with a point-to-segment distance;
   * lakes are returned whole for a point-in-polygon test. Cheap: a forest cell
   * is ~300 m and only the one or two tiles it spans are scanned.
   */
  waterNear(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    margin = 0,
  ): { segs: { ax: number; az: number; bx: number; bz: number; half: number }[]; lakes: HydroLake[] } {
    const segs: { ax: number; az: number; bx: number; bz: number; half: number }[] = [];
    const lakes: HydroLake[] = [];
    for (const c of this.chunks.values()) {
      // Skip tiles whose 7 km bounds don't overlap the query box.
      if (
        c.cx + 3500 < minX ||
        c.cx - 3500 > maxX ||
        c.cz + 3500 < minZ ||
        c.cz - 3500 > maxZ
      ) {
        continue;
      }
      for (const r of c.rivers) {
        const pts = r.pts;
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = pts[i][0];
          const az = pts[i][2];
          const bx = pts[i + 1][0];
          const bz = pts[i + 1][2];
          const half = Math.max(pts[i][3], pts[i + 1][3]) * 0.5 + margin;
          if (
            Math.max(ax, bx) + half < minX ||
            Math.min(ax, bx) - half > maxX ||
            Math.max(az, bz) + half < minZ ||
            Math.min(az, bz) - half > maxZ
          ) {
            continue;
          }
          segs.push({ ax, az, bx, bz, half });
        }
      }
      for (const l of c.lakes) {
        let lminX = Infinity;
        let lmaxX = -Infinity;
        let lminZ = Infinity;
        let lmaxZ = -Infinity;
        for (const [x, z] of l.ring) {
          if (x < lminX) lminX = x;
          if (x > lmaxX) lmaxX = x;
          if (z < lminZ) lminZ = z;
          if (z > lmaxZ) lmaxZ = z;
        }
        if (
          lmaxX + margin < minX ||
          lminX - margin > maxX ||
          lmaxZ + margin < minZ ||
          lminZ - margin > maxZ
        ) {
          continue;
        }
        lakes.push(l);
      }
    }
    return { segs, lakes };
  }

  /**
   * Water surface Y at world (x, z) if it lies over a BUILT river or lake, else
   * null. Used by the swim/wade physics so the inland waterways are real water,
   * not just a visual. Lateral river reach is generous — the caller's
   * depth = level − ground test discards any dry-bank overshoot. Cheap: a
   * tile-bounds reject then per-run bbox rejects leave only the run(s) the point
   * actually sits in.
   */
  waterLevelAt(x: number, z: number): number | null {
    let best: number | null = null;
    for (const c of this.chunks.values()) {
      if (!c.built) continue;
      if (x < c.cx - 3600 || x > c.cx + 3600 || z < c.cz - 3600 || z > c.cz + 3600) {
        continue;
      }
      for (const run of c.riverRuns) {
        if (x < run.minX || x > run.maxX || z < run.minZ || z > run.maxZ) continue;
        for (const s of run.samples) {
          const dx = x - s.x;
          const dz = z - s.z;
          if (dx * dx + dz * dz <= s.half * s.half && (best === null || s.level > best)) {
            best = s.level;
          }
        }
      }
      for (const l of c.lakes) {
        if (pointInLake(x, z, l) && (best === null || l.y > best)) best = l.y;
      }
    }
    return best;
  }

  private buildChunk(c: Chunk, streamer: KauaiTileStreamer): void {
    c.built = true;
    // Raw rendered-surface height; pool levels add their own depth/lift.
    const groundY: GroundY = (x, z) => streamer.surfaceHeightAt(x, z);
    const make = (
      build: (pos: number[], uv: number[], idx: number[]) => void,
      mat: THREE.Material,
      name: string,
    ): void => {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      build(pos, uv, idx);
      if (idx.length === 0) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.visible = false;
      c.meshes.push(mesh);
      this.group.add(mesh);
    };
    make(
      (p, u, i) => {
        for (const r of c.rivers) {
          const samples: RiverSample[] = [];
          buildRibbon(r, p, u, i, groundY, samples);
          if (samples.length < 2) continue;
          let minX = Infinity;
          let maxX = -Infinity;
          let minZ = Infinity;
          let maxZ = -Infinity;
          for (const s of samples) {
            if (s.x - s.half < minX) minX = s.x - s.half;
            if (s.x + s.half > maxX) maxX = s.x + s.half;
            if (s.z - s.half < minZ) minZ = s.z - s.half;
            if (s.z + s.half > maxZ) maxZ = s.z + s.half;
          }
          c.riverRuns.push({ minX, maxX, minZ, maxZ, samples });
        }
      },
      this.riverMat,
      `hydro-${c.tile}-rivers`,
    );
    make(
      (p, u, i) => {
        for (const l of c.lakes) buildLake(l, p, u, i);
      },
      this.lakeMat,
      `hydro-${c.tile}-lakes`,
    );
  }

  /** Call every frame after the streamer's update. */
  update(dt: number, streamer: KauaiTileStreamer): void {
    this.t += dt;
    if (this.riverNormal) this.riverNormal.offset.set(-this.t * RIVER_SCROLL, 0);
    if (this.lakeNormal) {
      this.lakeNormal.offset.set(this.t * LAKE_DRIFT.x, this.t * LAKE_DRIFT.y);
    }
    for (const c of this.chunks.values()) {
      const ready = streamer.tileReadyAt(c.cx, c.cz);
      if (ready && !c.built) this.buildChunk(c, streamer);
      for (const m of c.meshes) m.visible = ready;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.chunks.values()) {
      for (const m of c.meshes) {
        this.group.remove(m);
        m.geometry.dispose();
      }
      c.meshes.length = 0;
    }
    this.chunks.clear();
    this.riverMat.dispose();
    this.lakeMat.dispose();
    this.riverNormal?.dispose();
    this.lakeNormal?.dispose();
    this.scene.remove(this.group);
  }
}
