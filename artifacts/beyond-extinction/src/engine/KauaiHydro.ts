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
const FILL_DEPTH = 2.4; // target water depth above the carved bed (m) — swimmable
const BANK_FREEBOARD = 0.05; // keep the surface this far below the trench rim (m)
const EDGE_SMOOTH = 4; // ± samples averaged to smooth the canal width (curved banks)
const UV_M = 8; // metres per ripple-normal repeat (same wavelength as the ocean)
const BED_UV_M = 3.5; // metres per riverbed-texture tile (pebble scale under the water)
const BED_LIFT = 0.1; // streambed sits this far above the carved terrain (kills z-fight)
const BED_SINK = 0.06; // …but always at least this far below the water surface

// Riverbed variants drawn UNDER the translucent water, chosen per reach by
// elevation + slope so the streambed matches its setting (with a little
// per-reach variety). Index order is referenced by bedIndexFor().
const BED_TEXTURES = [
  "assets/textures/riverbed_sand.jpg", // 0: lowland / coastal sand + fine pebbles
  "assets/textures/riverbed_cobble.jpg", // 1: steep mountain / rapids — mossy cobbles
  "assets/textures/riverbed_silt.jpg", // 2: slow muddy lowland / floodplain silt
  "assets/textures/riverbed_algae.jpg", // 3: jungle / shaded slow water — algae bed
];

/** Deterministic 0..1 hash of a world point (no Math.random — a reach must keep
 *  the SAME bed every time its tile reloads, or the streambed would flicker). */
function bedHash01(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Pick a riverbed variant for a reach from its mean elevation, slope, and a
 *  stable hash: mountains/rapids → cobble; jungle band → algae/silt; the
 *  lowlands and coast → mostly sand with occasional silt/algae. */
function bedIndexFor(avgE: number, slopeDeg: number, h: number): number {
  if (slopeDeg > 6 || avgE > 680) return 1; // mountain streams & rapids
  if (avgE > 120) return h < 0.5 ? 3 : 2; // jungle lowlands
  return h < 0.45 ? 0 : h < 0.8 ? 2 : 3; // coastal / valley floor
}
const RIVER_SCROLL = 0.05; // u/s ≈ 0.4 m/s downstream drift
const LAKE_DRIFT = { x: 0.014, y: 0.01 }; // ocean's ripple drift (u/s)

// Grid-joint cascades: a fast whitewater streak laid along the flow wherever a
// waterway crosses a tile boundary, so the seam between two per-tile ribbons
// reads as continuous tumbling rapids rather than a visible join. The streak is
// centred on the crossing and runs CASCADE_LEN along the flow direction (well
// past the seam on both sides), so it stays put and looks the same no matter
// which side's tile faded in first.
const GRID_LINES = [-21000, -14000, -7000, 0, 7000, 14000, 21000]; // tile seams (m)
const CASCADE_LEN = 64; // m — whitewater streak length along flow, spanning the seam
const CASCADE_STATIONS = 12; // vertices along the streak (smooth follow of the bed)
const CASCADE_SCROLL = 0.55; // v/s — fast tumble so it reads as rapids, not still water
const CASCADE_LIFT = 0.06; // m above the ribbon surface so the foam sits on top

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
  leadIn: Pt4[],
  leadOut: Pt4[],
  bed: { pos: number[]; uv: number[]; idx: number[] },
): void {
  // GHOST CONTEXT: the bake splits each river into per-tile runs that share
  // exact endpoints, but if every piece is smoothed/filled from ITS points
  // alone the shared boundary cross-section lands differently on each side and
  // the ribbons don't meet (the visible seam). Prepend/append a few of the
  // NEIGHBOUR run's points (from load()) so the polyline is continuous across
  // the tile edge; both tiles then see the SAME points around the shared
  // endpoint and — because the terrain heights are seam-deterministic — compute
  // an identical boundary cross-section. We build over the extended polyline for
  // context but only EMIT the geometry for this run's real span.
  const fullPts = leadIn.length || leadOut.length ? [...leadIn, ...run.pts, ...leadOut] : run.pts;
  const pts = smoothRun(fullPts);
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
    gy: number; // BAKED centreline ground elevation (monotonic downstream)
  }
  const cs: CS[] = [];
  let cum = 0;
  let prevX = pts[0][0];
  let prevZ = pts[0][2];
  for (let i = 0; i < n; i++) {
    const [x, gy, z, w] = pts[i];
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
    cs.push({ x, z, px: -dz / len, pz: dx / len, u: cum / UV_M, w, gy });
  }
  const m = cs.length;
  if (m < 2) return;
  // rimCap is the lower LIVE bank at ±R — the surface must stay under it so the
  // water can't sheet out over open ground.
  const rimCap = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const c = cs[i];
    const R = riverCarveRadius(c.w);
    const rimL = groundY(c.x + c.px * R, c.z + c.pz * R);
    const rimR = groundY(c.x - c.px * R, c.z - c.pz * R);
    rimCap[i] = Math.min(rimL, rimR) - BANK_FREEBOARD;
  }
  // Surface level from the BAKED monotonic centreline (cs[].gy): the bake draped
  // a strictly-downhill profile along every river, so levelling from IT — not the
  // wandering 36 m live mesh — is what stops the water climbing uphill. Steps:
  //  1. start at the baked ground, sunk a hair (BANK_FREEBOARD) so the edge tucks
  //     into the channel; clamp under the live banks so it can't flood out;
  //  2. a strict downstream pass (level[i] = min(level[i], level[i-1])) GUARANTEES
  //     a non-increasing surface — pools sit flat, drops become steps/waterfalls,
  //     and nowhere does the water rise as it flows on.
  // Seam-safe: the baked gy at a shared tile-boundary point is byte-identical in
  // both runs, and the ghost lead-in feeds the same upstream context, so both
  // sides settle on the same monotone level.
  const level = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    level[i] = Math.min(cs[i].gy - BANK_FREEBOARD, rimCap[i]);
  }
  for (let i = 1; i < m; i++) {
    if (level[i] > level[i - 1]) level[i] = level[i - 1]; // never rise downstream
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
  // Emit only this run's REAL span (the ghost lead-in/out was context only):
  // the cross-sections nearest the run's own first & last points.
  const first = run.pts[0];
  const last = run.pts[run.pts.length - 1];
  let i0 = 0;
  let i1 = m - 1;
  let b0 = Infinity;
  let b1 = Infinity;
  for (let i = 0; i < m; i++) {
    const d0 = (cs[i].x - first[0]) ** 2 + (cs[i].z - first[2]) ** 2;
    if (d0 < b0) {
      b0 = d0;
      i0 = i;
    }
    const d1 = (cs[i].x - last[0]) ** 2 + (cs[i].z - last[2]) ** 2;
    if (d1 < b1) {
      b1 = d1;
      i1 = i;
    }
  }
  if (i0 > i1) [i0, i1] = [i1, i0];
  const base = positions.length / 3;
  const bedBase = bed.pos.length / 3;
  let emitted = 0;
  for (let i = i0; i <= i1; i++) {
    const c = cs[i];
    const lx = c.x + c.px * hL[i];
    const lz = c.z + c.pz * hL[i];
    const rx = c.x - c.px * hR[i];
    const rz = c.z - c.pz * hR[i];
    positions.push(lx, level[i], lz);
    positions.push(rx, level[i], rz);
    uvs.push(c.u, 0, c.u, (hL[i] + hR[i]) / UV_M);
    // Streambed: a textured sheet on the CARVED bed under the (translucent)
    // water — left edge, centre, right edge, each dropped to the real ground but
    // always kept just under the surface so it never pokes through. World-planar
    // UVs so the pebble scale is constant and doesn't stretch on wide reaches.
    const cap = level[i] - BED_SINK;
    const by = (x: number, z: number): number => Math.min(groundY(x, z) + BED_LIFT, cap);
    bed.pos.push(lx, by(lx, lz), lz);
    bed.pos.push(c.x, by(c.x, c.z), c.z);
    bed.pos.push(rx, by(rx, rz), rz);
    bed.uv.push(lx / BED_UV_M, lz / BED_UV_M, c.x / BED_UV_M, c.z / BED_UV_M, rx / BED_UV_M, rz / BED_UV_M);
    // Water-level query sample (for swim physics), decimated every 3rd
    // cross-section (~18 m apart) — the generous half reach overlaps the gaps,
    // and the caller's depth = level − ground test discards any dry-bank
    // overshoot. Keeps the per-frame waterLevelAt scan cheap on mobile.
    if (emitted % 3 === 0) {
      samples.push({ x: c.x, z: c.z, level: level[i], half: Math.max(hL[i], hR[i]) + 3 });
    }
    emitted++;
  }
  for (let k = 0; k < emitted - 1; k++) {
    const a = base + k * 2;
    // two triangles per quad, wound for +Y normals
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    // Streambed: two quad strips (left→centre, centre→right) per span.
    const b = bedBase + k * 3;
    bed.idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 4); // left strip
    bed.idx.push(b + 1, b + 4, b + 2, b + 2, b + 4, b + 5); // right strip
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

/** Bright foam material for the grid-joint cascades — translucent whitewater
 *  that scrolls fast along the flow. depthWrite off + a negative polygon offset
 *  so it blends cleanly on TOP of the river ribbon it overlays. */
function makeCascadeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xdff2f5,
    roughness: 0.55,
    metalness: 0.0,
    transparent: true,
    opacity: 0.72,
    emissive: new THREE.Color(0xbfe4ea),
    emissiveIntensity: 0.28,
    side: THREE.DoubleSide,
    normalScale: new THREE.Vector2(0.9, 0.9),
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
  });
}

/** One point where a river polyline crosses a tile-boundary grid line. */
interface Crossing {
  x: number;
  z: number;
  dx: number; // unit flow direction (downstream)
  dz: number;
  w: number; // river width here (m)
}

/** Every tile-boundary crossing along one run, with the local flow direction. */
function runCrossings(run: HydroRiver): Crossing[] {
  const out: Crossing[] = [];
  const pts = run.pts;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const w = (a[3] + b[3]) / 2;
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    for (const B of GRID_LINES) {
      if ((a[0] - B) * (b[0] - B) < 0) {
        const t = (B - a[0]) / (b[0] - a[0]);
        out.push({ x: B, z: a[2] + t * (b[2] - a[2]), dx, dz, w });
      }
      if ((a[2] - B) * (b[2] - B) < 0) {
        const t = (B - a[2]) / (b[2] - a[2]);
        out.push({ x: a[0] + t * (b[0] - a[0]), z: B, dx, dz, w });
      }
    }
  }
  return out;
}

/** Build a whitewater streak at every grid-joint crossing of these runs. The
 *  streak is a thin strip centred on the crossing, running CASCADE_LEN along the
 *  flow, draped a hair above the water surface so it masks the per-tile seam. */
function buildCascades(
  rivers: HydroRiver[],
  positions: number[],
  uvs: number[],
  indices: number[],
  surfaceY: (x: number, z: number) => number,
): void {
  for (const run of rivers) {
    for (const c of runCrossings(run)) {
      const px = -c.dz; // perpendicular to flow (XZ)
      const pz = c.dx;
      const halfW = Math.min(Math.max(c.w * 0.6, 3), 14);
      // Anchor the whole streak to the water surface AT the crossing — that
      // point always sits over this chunk's own just-built ribbon, so it reads
      // the true (smoothed, near-flat) pool level. Sampling per-station instead
      // would fall back to bed+fill on the neighbour side (ribbon not built yet)
      // and push the foam metres under/over the water on steep ground.
      const y = surfaceY(c.x, c.z) + CASCADE_LIFT;
      const base = positions.length / 3;
      for (let s = 0; s < CASCADE_STATIONS; s++) {
        const f = s / (CASCADE_STATIONS - 1) - 0.5; // -0.5 … 0.5 along flow
        const cx = c.x + c.dx * (CASCADE_LEN * f);
        const cz = c.z + c.dz * (CASCADE_LEN * f);
        const v = (f + 0.5) * (CASCADE_LEN / UV_M);
        positions.push(cx + px * halfW, y, cz + pz * halfW);
        positions.push(cx - px * halfW, y, cz - pz * halfW);
        uvs.push(0, v, 1, v);
      }
      for (let s = 0; s < CASCADE_STATIONS - 1; s++) {
        const a = base + s * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
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
  /** Ghost lead-in/out points per run (neighbour context for seamless joins). */
  private readonly riverLeads = new Map<HydroRiver, { in: Pt4[]; out: Pt4[] }>();
  private riverMat: THREE.MeshStandardMaterial;
  private lakeMat: THREE.MeshStandardMaterial;
  private cascadeMat: THREE.MeshStandardMaterial;
  private bedMats: THREE.MeshStandardMaterial[] = [];
  private riverNormal?: THREE.Texture;
  private lakeNormal?: THREE.Texture;
  private cascadeNormal?: THREE.Texture;
  private bedTexs: THREE.Texture[] = [];
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
    this.riverMat = makeWaterMaterial(0x1a6389, false); // match the open-ocean blue so all water reads as one family
    this.riverMat.opacity = 0.8; // was 0.68: too see-through, so thin/coastal/mountain reaches read as a pale film over the bed instead of water. 0.8 keeps a hint of streambed on the deep reaches while the shallows now read as actual water.
    this.lakeMat = makeWaterMaterial(0x14526e, true);
    this.cascadeMat = makeCascadeMaterial();
    // Wet river-stone bed, drawn on the carved floor UNDER the translucent water
    // so the shallows read as streambed, not beach. Opaque, sunk a touch so the
    // water always wins the depth test above it.
    // One streambed material per riverbed variant; each gets its texture in
    // loadBedTextures(). Same params as before — only the albedo differs.
    this.bedMats = BED_TEXTURES.map(
      () =>
        new THREE.MeshStandardMaterial({
          color: 0x9a9086,
          roughness: 0.72,
          metalness: 0.0,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 3,
        }),
    );
    void this.loadNormals();
    void this.loadBedTextures();
    void this.load();
  }

  /** Load the streambed albedo variants (sand / cobble / silt / algae). */
  private async loadBedTextures(): Promise<void> {
    await Promise.all(
      BED_TEXTURES.map(async (url, i) => {
        const tex = await loadTexture(url);
        if (!tex || this.disposed) return;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        this.bedTexs[i] = tex;
        this.bedMats[i].map = tex;
        this.bedMats[i].color.setHex(0xffffff); // let the texture carry the colour
        this.bedMats[i].needsUpdate = true;
      }),
    );
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
    // independent clones: rivers scroll downstream, lakes drift like the ocean,
    // cascades tumble fast along the flow
    this.riverNormal = prep(tex.clone());
    this.lakeNormal = prep(tex.clone());
    this.cascadeNormal = prep(tex.clone());
    this.cascadeNormal.repeat.set(1, 3); // more foam detail packed along the flow
    this.riverMat.normalMap = this.riverNormal;
    this.riverMat.needsUpdate = true;
    this.lakeMat.normalMap = this.lakeNormal;
    this.lakeMat.needsUpdate = true;
    this.cascadeMat.normalMap = this.cascadeNormal;
    this.cascadeMat.needsUpdate = true;
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
    this.computeRiverLeads(doc.rivers);
    this.loaded = true;
  }

  /**
   * For each per-tile run, find the neighbour run it joins at each end (they
   * share an exact endpoint) and record a few of that neighbour's points just
   * across the seam. buildRibbon feeds these as ghost context so both sides of
   * a tile boundary compute the SAME join cross-section — no more disconnect.
   */
  private computeRiverLeads(rivers: HydroRiver[]): void {
    const K = 4; // ghost points each side (covers the smoothing windows)
    const key = (p: Pt4): string => `${Math.round(p[0] * 2)},${Math.round(p[2] * 2)}`;
    // endpoint → list of (run, atStart) touching it
    const ends = new Map<string, { r: HydroRiver; atStart: boolean }[]>();
    const add = (k: string, r: HydroRiver, atStart: boolean): void => {
      const a = ends.get(k);
      if (a) a.push({ r, atStart });
      else ends.set(k, [{ r, atStart }]);
    };
    for (const r of rivers) {
      if (r.pts.length < 2) continue;
      add(key(r.pts[0]), r, true);
      add(key(r.pts[r.pts.length - 1]), r, false);
    }
    // The K neighbour points adjacent to the shared endpoint, taken from either
    // the neighbour's start (nearest = its 2nd point) or its end (nearest = its
    // 2nd-last). fromStart keeps nearest FIRST; fromEnd keeps nearest LAST.
    const fromStart = (s: HydroRiver): Pt4[] => s.pts.slice(1, 1 + K);
    const fromEnd = (s: HydroRiver): Pt4[] =>
      s.pts.slice(Math.max(0, s.pts.length - 1 - K), s.pts.length - 1);
    const leadAt = (r: HydroRiver, atStart: boolean): Pt4[] => {
      const p = r.pts;
      const k = key(atStart ? p[0] : p[p.length - 1]);
      const nb = (ends.get(k) ?? []).find((t) => t.r !== r);
      if (!nb) return [];
      const s = nb.r;
      if (atStart) {
        // LEAD-IN (prepend): nearest point must come LAST.
        return nb.atStart ? fromStart(s).reverse() : fromEnd(s);
      }
      // LEAD-OUT (append): nearest point must come FIRST.
      return nb.atStart ? fromStart(s) : fromEnd(s).reverse();
    };
    for (const r of rivers) {
      if (r.pts.length < 2) continue;
      this.riverLeads.set(r, { in: leadAt(r, true), out: leadAt(r, false) });
    }
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
    // Streambed sheets (drawn under the water). Bucketed by riverbed variant —
    // each reach picks a variant from its elevation/slope, so a tile emits one
    // bed mesh per variant its rivers actually use (usually 1–2).
    const beds = BED_TEXTURES.map(() => ({
      pos: [] as number[],
      uv: [] as number[],
      idx: [] as number[],
    }));
    make(
      (p, u, i) => {
        for (const r of c.rivers) {
          const samples: RiverSample[] = [];
          const lead = this.riverLeads.get(r);
          // Choose this reach's streambed variant from its mean elevation + slope.
          const pts = r.pts;
          const a = pts[0];
          const b = pts[pts.length - 1];
          const m = pts[pts.length >> 1];
          const avgE = groundY(m[0], m[2]);
          const run = Math.hypot(b[0] - a[0], b[2] - a[2]);
          const slopeDeg =
            run > 20
              ? (Math.atan2(Math.abs(groundY(a[0], a[2]) - groundY(b[0], b[2])), run) * 180) /
                Math.PI
              : 0;
          const ti = bedIndexFor(avgE, slopeDeg, bedHash01(m[0], m[2]));
          buildRibbon(r, p, u, i, groundY, samples, lead?.in ?? [], lead?.out ?? [], beds[ti]);
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
    // One streambed mesh per used variant (opaque, drawn BEFORE the water).
    for (let ti = 0; ti < beds.length; ti++) {
      const bed = beds[ti];
      if (bed.idx.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(bed.pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(bed.uv, 2));
      geo.setIndex(bed.idx);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.bedMats[ti]);
      mesh.name = `hydro-${c.tile}-bed${ti}`;
      mesh.visible = false;
      mesh.renderOrder = -1;
      c.meshes.push(mesh);
      this.group.add(mesh);
    }
    // Grid-joint cascades — built AFTER the ribbons so surfaceY can read this
    // chunk's just-built water samples; falls back to the carved bed + fill
    // depth where a neighbour ribbon across the seam hasn't built yet.
    const surfaceY = (x: number, z: number): number =>
      this.waterLevelAt(x, z) ?? groundY(x, z) + FILL_DEPTH;
    make(
      (p, u, i) => buildCascades(c.rivers, p, u, i, surfaceY),
      this.cascadeMat,
      `hydro-${c.tile}-cascades`,
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
    // Cascades tumble downstream (v runs 0→len along the flow) — fast scroll so
    // the seam reads as churning rapids.
    if (this.cascadeNormal) this.cascadeNormal.offset.set(0, -this.t * CASCADE_SCROLL);
    for (const c of this.chunks.values()) {
      const ready = streamer.tileReadyAt(c.cx, c.cz);
      // Build only once the 4 orthogonal neighbour tiles are also resident, so
      // the ghost-context samples across every seam read real (seam-deterministic)
      // terrain — the boundary cross-sections then match and STAY matched (built
      // once, never rebuilt). Off-grid edges count as ready (no seam there).
      if (ready && !c.built && this.neighboursReady(c, streamer)) {
        this.buildChunk(c, streamer);
      }
      for (const m of c.meshes) m.visible = ready;
    }
  }

  /** True if every in-grid orthogonal neighbour tile of `c` has heights loaded. */
  private neighboursReady(c: Chunk, streamer: KauaiTileStreamer): boolean {
    const col = c.tile.charCodeAt(0) - 65;
    const row = parseInt(c.tile.slice(1), 10) - 1;
    const S = 7000;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nc > 7 || nr < 0 || nr > 7) continue; // off-grid: no seam
      if (!streamer.tileReadyAt(c.cx + dc * S, c.cz + dr * S)) return false;
    }
    return true;
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
    this.cascadeMat.dispose();
    for (const m of this.bedMats) m.dispose();
    this.riverNormal?.dispose();
    this.lakeNormal?.dispose();
    this.cascadeNormal?.dispose();
    for (const t of this.bedTexs) t.dispose();
    this.scene.remove(this.group);
  }
}
