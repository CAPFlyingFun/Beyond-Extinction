import * as THREE from "three";
import { loadTexture } from "./assets";
import type { KauaiTileStreamer } from "./KauaiTileStreamer";
import { KauaiCarve, type HydroRiver, type HydroLake } from "./KauaiCarve";
import { riverCarveDepth } from "./kauaiCarveCore";

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

// Water surfaces are FLAT pools (RCT-style "fill the depression"), levelled
// against the LIVE streamed terrain (streamer.surfaceHeightAt — triangle-exact
// against the rendered mesh). Rivers pick a pool level per cross-section from
// the carved channel and clamp it monotonic downstream; lakes sit flat at
// their baked waterline. Water is never coupled to the ocean tide (that only
// moves the separate ocean plane).
const LIFT_M = 0.12; // min water depth above the channel centreline (m)
const BANK_FREEBOARD = 0.05; // keep the pool this far below the lower bank (m)
const POOL_WINDOW = 3; // cross-sections (±) bridged by one pool (~±18 m)
const UV_M = 8; // metres per ripple-normal repeat (same wavelength as the ocean)
const RIVER_SCROLL = 0.05; // u/s ≈ 0.4 m/s downstream drift
const LAKE_DRIFT = { x: 0.014, y: 0.01 }; // ocean's ripple drift (u/s)

/** Ocean-family water material (see KauaiStreamScene.makeOceanMaterial). */
function makeWaterMaterial(color: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.13,
    metalness: 0.22,
    transparent: true,
    opacity: 0.82,
    envMapIntensity: 1.1,
    normalScale: new THREE.Vector2(0.55, 0.55),
    side: THREE.DoubleSide, // ribbons stay visible from below-bank angles
    // Same z-fight guard as the ocean: pool surfaces cross near-coplanar
    // terrain right at their banks — push water fragments slightly deeper so
    // the shoreline pixels resolve to ground, not shimmer.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
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
 * Pooled river ribbon: FLAT cross-sections at a water LEVEL, RCT-style.
 *
 * The old ribbon grounded every vertex on the terrain, so the water wrapped
 * the channel (and any dune it crossed) like a blue carpet. Instead each
 * cross-section now picks a pool level inside the carved channel — above the
 * centreline ground, below the lower bank — bridges facet dips with a small
 * windowed max, and clamps the level monotonic DOWNSTREAM (water never flows
 * uphill; behind a terrain bump it simply disappears under the ground until
 * the valley floor drops back below the pool). The cross-section is emitted
 * flat at that level, so the water edge hides inside the banks exactly like a
 * filled depression.
 */
function buildRibbon(
  run: HydroRiver,
  positions: number[],
  uvs: number[],
  indices: number[],
  groundY: GroundY,
): void {
  const pts = smoothRun(run.pts);
  const n = pts.length;
  if (n < 2) return;
  // Valid cross-sections: world frame (centre + XZ-perpendicular), u coord,
  // baked Y (for downstream orientation) and width.
  interface CS {
    x: number;
    z: number;
    px: number;
    pz: number;
    half: number;
    u: number;
    y: number;
    w: number;
  }
  const cs: CS[] = [];
  let cum = 0;
  let prevX = pts[0][0];
  let prevZ = pts[0][2];
  for (let i = 0; i < n; i++) {
    const [x, y, z, w] = pts[i];
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
    cs.push({ x, z, px: -dz / len, pz: dx / len, half: w / 2, u: cum / UV_M, y, w });
  }
  const m = cs.length;
  if (m < 2) return;
  // Pool level candidate per cross-section: deep enough over the channel
  // centreline to read as water, but below the lower bank so the edge stays
  // tucked inside the carved channel. (The rendered carve is shallower than
  // the data carve on narrow rivers — 36 m mesh facets mute it — so the
  // centreline floor, not the nominal carve depth, is the anchor.)
  const cand = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const c = cs[i];
    const gC = groundY(c.x, c.z);
    const bankL = groundY(c.x + c.px * c.half, c.z + c.pz * c.half);
    const bankR = groundY(c.x - c.px * c.half, c.z - c.pz * c.half);
    const lvl = Math.min(
      gC + 0.35 * riverCarveDepth(c.w),
      Math.min(bankL, bankR) - BANK_FREEBOARD,
    );
    cand[i] = Math.max(lvl, gC + LIFT_M); // never below the centreline ground
  }
  // One pool spans ~±18 m: windowed max bridges single-facet dips so a lone
  // low sample doesn't drag a long downstream reach under the terrain.
  const level = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let v = -Infinity;
    const k0 = Math.max(0, i - POOL_WINDOW);
    const k1 = Math.min(m - 1, i + POOL_WINDOW);
    for (let k = k0; k <= k1; k++) v = Math.max(v, cand[k]);
    level[i] = v;
  }
  // Monotonic downstream: the baked Y is draped monotonic downstream, so the
  // lower-Y end of the run is the ocean end. Water level may only fall that way.
  if (cs[0].y >= cs[m - 1].y) {
    for (let i = 1; i < m; i++) level[i] = Math.min(level[i], level[i - 1]);
  } else {
    for (let i = m - 2; i >= 0; i--) level[i] = Math.min(level[i], level[i + 1]);
  }
  const base = positions.length / 3;
  for (let i = 0; i < m; i++) {
    const c = cs[i];
    positions.push(c.x + c.px * c.half, level[i], c.z + c.pz * c.half);
    positions.push(c.x - c.px * c.half, level[i], c.z - c.pz * c.half);
    uvs.push(c.u, 0, c.u, c.w / UV_M);
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

interface Chunk {
  tile: string;
  cx: number;
  cz: number;
  rivers: HydroRiver[];
  lakes: HydroLake[];
  built: boolean;
  meshes: THREE.Mesh[];
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
    // river water, while staying in the same material family.
    this.riverMat = makeWaterMaterial(0x175b66);
    this.lakeMat = makeWaterMaterial(0x14526e);
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
        for (const r of c.rivers) buildRibbon(r, p, u, i, groundY);
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
