import * as THREE from "three";
import { loadTexture } from "./assets";
import type { KauaiTileStreamer } from "./KauaiTileStreamer";
import { KauaiCarve, type HydroRiver, type HydroLake } from "./KauaiCarve";

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

// River/lake surfaces are re-grounded onto the LIVE streamed terrain at build
// time (streamer.surfaceHeightAt — triangle-exact against the rendered mesh)
// and lifted this small amount, so they always sit just above the actual
// rendered ground — no clipping in/out, no z-fighting, and no coupling to the
// ocean tide (which only ever moves the separate ocean plane).
const LIFT_M = 0.12;
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
 * Grid-conforming ribbon along a run's centerline, XZ-perpendicular offsets.
 *
 * Cross-sections are sampled every ~6 m along the run AND subdivided across
 * the width, with EVERY vertex re-grounded on the rendered terrain surface.
 * A 2-vertex cross-section spans up to 36 m of terrain as one straight line —
 * on rough 36 m mesh cells the ground bulges metres above that chord, which is
 * exactly how the old ribbons kept vanishing into hillsides. With ≤ ~7 m
 * between grounded vertices the water hugs the drawn triangles everywhere and
 * the LIFT margin keeps it just above them.
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
  // Lanes must be CONSTANT per run (width varies along it — use the max) so
  // the index buffer stays a regular grid.
  let maxW = 0;
  for (const p of pts) maxW = Math.max(maxW, p[3]);
  const lanes = Math.min(7, Math.max(2, Math.ceil(maxW / 7) + 1));
  let cum = 0;
  let prevX = pts[0][0];
  let prevZ = pts[0][2];
  const base = positions.length / 3;
  let emitted = 0;
  for (let i = 0; i < n; i++) {
    const [x, , z, w] = pts[i]; // baked Y ignored — we re-ground onto terrain
    // central-difference direction (falls back to fwd/back at the ends)
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue; // degenerate — skip, quad bridges the gap
    dx /= len;
    dz /= len;
    const px = -dz; // left-perpendicular in XZ
    const pz = dx;
    const half = w / 2;
    cum += Math.hypot(x - prevX, z - prevZ);
    prevX = x;
    prevZ = z;
    const u = cum / UV_M;
    for (let k = 0; k < lanes; k++) {
      const t = k / (lanes - 1);
      const off = half * (1 - 2 * t); // +half (left bank) → −half (right bank)
      const vx = x + px * off;
      const vz = z + pz * off;
      positions.push(vx, groundY(vx, vz), vz);
      uvs.push(u, (t * w) / UV_M);
    }
    emitted++;
  }
  for (let i = 0; i < emitted - 1; i++) {
    for (let k = 0; k < lanes - 1; k++) {
      const a = base + i * lanes + k;
      const b = a + lanes; // same lane, next cross-section
      // two triangles per cell, wound for +Y normals
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/** Lake mesh from ring + holes, re-grounded onto the live terrain surface. */
function buildLake(
  lake: HydroLake,
  positions: number[],
  uvs: number[],
  indices: number[],
  groundY: GroundY,
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
    // v.x = world X, v.y = world Z. Sit the rim on the live ground so the pool
    // meets its banks cleanly instead of clipping a flat baked plane.
    positions.push(v.x, groundY(v.x, v.y), v.y);
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
    // Sample the live rendered terrain and lift a hair so water sits just above
    // the ground surface (never coupled to the ocean tide, never clipping).
    const groundY: GroundY = (x, z) => streamer.surfaceHeightAt(x, z) + LIFT_M;
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
        for (const l of c.lakes) buildLake(l, p, u, i, groundY);
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
