import * as THREE from "three";
import { loadTexture } from "./assets";
import type { KauaiTileStreamer } from "./KauaiTileStreamer";
import type { HydroRiver } from "./KauaiCarve";
import { riverCarveRadius, FLAT_FRAC } from "./kauaiCarveCore";

/**
 * Virtual-pipes shallow-water simulation over a real terrain window — the
 * "water finds the valleys" pilot (lisyarus, "Simulating water over terrain").
 *
 * State on a staggered grid:
 *   bed[N·N]        fixed terrain height, sampled once from the streamed mesh
 *   water[N·N]      water column depth per cell (the thing we simulate)
 *   flowX[(N+1)·N]  flux across vertical edges (between horizontal neighbours)
 *   flowY[N·(N+1)]  flux across horizontal edges
 *
 * Each step: accelerate the edge flows by the SURFACE-height (bed+water)
 * difference (× g·dt/cell, with friction), scale outflows so no cell goes
 * negative, then move the water. Water surface settles flat and spills at the
 * lowest rim — the automatic pool/river/waterfall behaviour, straight from the
 * terrain. Rain feeds it; ocean cells + the domain edge drain it.
 *
 * Bounded + CPU: this is the WaterLab pilot. The island-scale version bakes an
 * offline steady state; a movable 256² patch runs live near the player.
 */
export interface WaterSimOpts {
  centerX: number;
  centerZ: number;
  N?: number; // grid cells per side (default 256)
  cell?: number; // metres per cell (default 10)
}

const G = 9.8; // gravity (only ever used as g·dt/cell in the accel step)
const DT = 0.003; // sim timestep (s) — small for CFL stability
const FRICTION = 0.3; // 0 = max friction (kills flow), 1 = none
// Feed only the UPPER CATCHMENT (highland runoff), NOT every cell — global rain
// on beaches, valleys and ridges alike floods the whole window into a bathtub.
const RAIN = 0.08; // m/s injected at the headwaters — safe to feed hard once confined to the corridor
const FEED_PCTL = 0.4; // feed land cells above this elevation percentile
const SEA = -0.4; // bed below this = ocean → drains to sea level
const EDGE_DRAIN = 0.97; // domain-edge ring keeps this per substep — a gentle outflow, not an instant empty
const MIN_DEPTH = 0.05; // below this a cell renders dry (hides thin sheet-flow films)
const FULL_DEPTH = 0.35; // reach full opacity at a shallow depth so the channel reads as solid blue water, not a pale film over sand
const CORRIDOR_R = 12; // half-width (m) of the river-corridor confinement band (~24 m wide)
const SOURCE_PCTL = 0.8; // feed only the top 20% (by elevation) of corridor cells — the headwaters
const TARGET_DEPTH = 2.6; // aim the channel at ~this deepest depth, then throttle inflow (bankfull-ish)
const MIN_FILL = 0.5; // RENDER floor: draw corridor channels at least this deep so a shallow, fast reach still reads as a filled river (visual only — sim state stays honest)
const FILL_LEVEL = -0.5; // below-sea channels fill to this flat surface (≈ reef-texture top, just under the ocean's -0.4) so no exposed reef wall pokes above the water. Sits 0.1 m below the ocean so the ocean wins the depth test where they overlap (no z-fight).
const BED_UV_M = 22; // metres per water-normal ripple tile — large & gentle so the
// surface reads as smooth flowing water, not a fine gravel/pebble texture (the
// ocean uses no tiled normal map at all; a 6 m tile made the river look pebbly)
const FLOW_SCROLL = 0.05; // normal-map scroll speed (downstream drift look)

export class KauaiWaterSim {
  readonly group = new THREE.Group();
  private readonly N: number;
  private readonly cell: number;
  private readonly ox: number; // world X of the grid's min corner
  private readonly oz: number;
  private readonly bed: Float32Array;
  private readonly water: Float32Array;
  private readonly flowX: Float32Array;
  private readonly flowY: Float32Array;
  private readonly frictionFactor = Math.pow(1 - FRICTION, DT);
  private terrainReady = false;
  private disposed = false;
  private rainOn = true;
  private feedThresh = 0; // elevation above which highland cells receive runoff
  private mask?: Uint8Array; // 1 = inside a river corridor; water is confined here
  private edgeSoft?: Float32Array; // 0..1 bank feather: 1 in the channel core, 0 at the rim
  private source?: Uint8Array; // 1 = headwater cell where runoff enters the corridor
  private mesh?: THREE.Mesh;
  private geo?: THREE.BufferGeometry;
  private posArr?: Float32Array;
  private colArr?: Float32Array;
  private readonly mat: THREE.MeshStandardMaterial;
  private normalTex?: THREE.Texture;
  private clock = 0;
  private maxD = 0; // running deepest cell (previous substep) — drives the inflow throttle

  constructor(scene: THREE.Scene, opts: WaterSimOpts) {
    this.N = opts.N ?? 256;
    this.cell = opts.cell ?? 10;
    const half = (this.N * this.cell) / 2;
    this.ox = opts.centerX - half;
    this.oz = opts.centerZ - half;
    const N = this.N;
    this.bed = new Float32Array(N * N);
    this.water = new Float32Array(N * N);
    this.flowX = new Float32Array((N + 1) * N);
    this.flowY = new Float32Array(N * (N + 1));
    // River-water material: low roughness + envMap (three auto-applies
    // scene.environment) gives real sky reflection; a scrolling normal map makes
    // it move; a fresnel term adds the bright grazing sheen. Per-vertex colour
    // carries depth tint (RGB) + wetness (alpha), so shallow edges read clear and
    // the bed shows through while deep water goes blue.
    // Match the ocean water look (KauaiStreamScene.makeOceanMaterial) so all the
    // water reads as one family — same blue, roughness, envMap reflection and
    // fresnel sheen — but keep per-vertex alpha so dry cells vanish (the ocean
    // uses a coast mask instead; we use the sim's wetness).
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x1a6389,
      roughness: 0.18,
      metalness: 0.1,
      envMapIntensity: 0.9,
      normalScale: new THREE.Vector2(0.32, 0.32),
      transparent: true,
      opacity: 0.9,
      alphaTest: 0.02,
      vertexColors: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const sky = new THREE.Color(0x9fc6df).convertSRGBToLinear();
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSky = { value: sky };
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform vec3 uSky;")
        .replace(
          "#include <lights_fragment_end>",
          `#include <lights_fragment_end>
          {
            // Match the ocean's fresnel sky sheen exactly (makeOceanMaterial):
            float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
            totalEmissiveRadiance += uSky * min(fres, 0.85) * 0.5;
          }`,
        );
    };
    this.group.name = "kauai-watersim";
    scene.add(this.group);
    this.buildMesh();
    void this.loadNormal();
  }

  private wi(x: number, y: number): number {
    return y * this.N + x;
  }
  private fxi(x: number, y: number): number {
    return y * (this.N + 1) + x;
  } // flowX (N+1)·N
  private fyi(x: number, y: number): number {
    return y * this.N + x;
  } // flowY N·(N+1)
  private worldX(x: number): number {
    return this.ox + (x + 0.5) * this.cell;
  }
  private worldZ(y: number): number {
    return this.oz + (y + 0.5) * this.cell;
  }

  /** Sample the streamed terrain into the bed once its tiles are resident. */
  sampleTerrain(streamer: KauaiTileStreamer): boolean {
    const N = this.N;
    // Bail unless the whole window is resident, so we don't bake sea-level holes.
    for (let y = 0; y < N; y += 16) {
      for (let x = 0; x < N; x += 16) {
        if (!streamer.tileReadyAt(this.worldX(x), this.worldZ(y))) return false;
      }
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        this.bed[this.wi(x, y)] = streamer.surfaceHeightAt(this.worldX(x), this.worldZ(y));
      }
    }
    // Highland feed threshold = the FEED_PCTL percentile of LAND elevations, so
    // runoff enters only in the upper catchment (hills/mountains), not on beaches.
    const land: number[] = [];
    for (let i = 0; i < N * N; i++) if (this.bed[i] > 1) land.push(this.bed[i]);
    land.sort((a, b) => a - b);
    this.feedThresh = land.length ? land[Math.floor(land.length * FEED_PCTL)] : 0;
    this.terrainReady = true;
    this.computeSource(); // if the corridor mask already arrived, seed headwaters now
    return true;
  }

  /** Confine the sim to the REAL waterways: mark every cell within CORRIDOR_R of
   *  an NHD river line, and thereafter water only exists inside that band. This
   *  is what stops the sim flooding the whole island — water physically cannot
   *  leave the channels, so it can only pool/flow along the actual 2–5 rivers. */
  setCorridor(rivers: HydroRiver[]): void {
    const N = this.N;
    const cell = this.cell;
    const mask = new Uint8Array(N * N);
    // Per-cell nearest distance to the centerline + the local channel half-width,
    // so banks can be FEATHERED at render time (soft alpha, no hard staircase)
    // and each reach fills to ITS OWN width instead of a single fixed corridor.
    const dist = new Float32Array(N * N).fill(1e9);
    const cellR = new Float32Array(N * N); // local half-width at the nearest reach
    const minX = this.ox;
    const maxX = this.ox + N * cell;
    const minZ = this.oz;
    const maxZ = this.oz + N * cell;
    for (const r of rivers) {
      const pts = r.pts;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][0];
        const az = pts[i - 1][2];
        const bx = pts[i][0];
        const bz = pts[i][2];
        // Fill to the FLAT channel bed the carve actually cut (riverCarveRadius ×
        // FLAT_FRAC) using this reach's real width, so the water is as wide as the
        // reef-textured channel instead of a thin 24 m ribbon down a wide canal.
        // Fixed floor CORRIDOR_R keeps a hairline reach visible.
        const w = (pts[i - 1][3] + pts[i][3]) * 0.5;
        const R = Math.max(CORRIDOR_R, riverCarveRadius(w) * FLAT_FRAC);
        const rSq = R * R;
        if (
          Math.max(ax, bx) + R < minX ||
          Math.min(ax, bx) - R > maxX ||
          Math.max(az, bz) + R < minZ ||
          Math.min(az, bz) - R > maxZ
        ) {
          continue; // segment doesn't touch the window
        }
        const cx0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - this.ox) / cell));
        const cx1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + R - this.ox) / cell));
        const cz0 = Math.max(0, Math.floor((Math.min(az, bz) - R - this.oz) / cell));
        const cz1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + R - this.oz) / cell));
        const dx = bx - ax;
        const dz = bz - az;
        const ll = dx * dx + dz * dz || 1;
        for (let y = cz0; y <= cz1; y++) {
          for (let x = cx0; x <= cx1; x++) {
            const wx = this.worldX(x);
            const wz = this.worldZ(y);
            let t = ((wx - ax) * dx + (wz - az) * dz) / ll;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = wx - (ax + dx * t);
            const ez = wz - (az + dz * t);
            const d2 = ex * ex + ez * ez;
            if (d2 < rSq) {
              const idx = y * N + x;
              mask[idx] = 1;
              const d = Math.sqrt(d2);
              if (d < dist[idx]) {
                dist[idx] = d;
                cellR[idx] = R;
              }
            }
          }
        }
      }
    }
    this.mask = mask;
    // Feather factor: 1.0 across the channel core, easing to 0 at the outer rim
    // (per-cell width) so bank pixels go translucent and blend into the sand.
    const soft = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      if (!mask[i]) continue;
      const R = cellR[i] || CORRIDOR_R;
      const rin = R * 0.8; // inner 80% fully opaque, outer 20% feathers to the bank
      const e = Math.min(1, Math.max(0, (R - dist[i]) / (R - rin)));
      soft[i] = e * e * (3 - 2 * e); // smoothstep
    }
    this.edgeSoft = soft;
    this.computeSource();
  }

  /** Headwater cells = the highest corridor cells; runoff enters only there so
   *  water flows DOWN the channel instead of filling it uniformly. Needs both the
   *  corridor mask and the sampled bed, so it runs when the second of the two lands. */
  private computeSource(): void {
    if (!this.mask || !this.terrainReady) return;
    const N = this.N;
    const elevs: number[] = [];
    for (let i = 0; i < N * N; i++) if (this.mask[i] && this.bed[i] > SEA) elevs.push(this.bed[i]);
    const src = new Uint8Array(N * N);
    if (elevs.length) {
      elevs.sort((a, b) => a - b);
      const thresh = elevs[Math.floor(elevs.length * SOURCE_PCTL)];
      for (let i = 0; i < N * N; i++) if (this.mask[i] && this.bed[i] >= thresh) src[i] = 1;
    }
    this.source = src;
  }

  get ready(): boolean {
    return this.terrainReady;
  }
  setRain(on: boolean): void {
    this.rainOn = on;
  }
  reset(): void {
    this.water.fill(0);
    this.flowX.fill(0);
    this.flowY.fill(0);
  }

  /** One simulation substep (fixed DT). */
  private substep(): void {
    const N = this.N;
    const bed = this.bed;
    const water = this.water;
    const fx = this.flowX;
    const fy = this.flowY;
    const cell = this.cell;
    // Feed + drains. With a corridor mask, runoff enters ONLY along the real
    // waterways; otherwise it falls on the upper catchment (highland cells).
    const mask = this.mask;
    const src = this.source;
    if (this.rainOn) {
      // Throttle inflow as the deepest cell approaches TARGET_DEPTH (bankfull-ish):
      // full feed below 70%, ramping to zero at target. Excess is NOT erased — we
      // just stop adding, so volume is conserved and the level settles naturally.
      const lo = TARGET_DEPTH * 0.7;
      const throttle =
        this.maxD >= TARGET_DEPTH ? 0 : this.maxD <= lo ? 1 : (TARGET_DEPTH - this.maxD) / (TARGET_DEPTH - lo);
      const add = RAIN * DT * throttle;
      if (src) {
        for (let i = 0; i < N * N; i++) if (src[i]) water[i] += add; // headwaters only
      } else if (mask) {
        for (let i = 0; i < N * N; i++) if (mask[i] && bed[i] > SEA) water[i] += add;
      } else {
        const thresh = this.feedThresh;
        for (let i = 0; i < N * N; i++) if (bed[i] > thresh) water[i] += add;
      }
    }
    for (let i = 0; i < N * N; i++) if (bed[i] < SEA) water[i] = 0; // ocean sink
    // Accelerate X flows on interior edges (surface = bed + water).
    const k = (G * DT) / cell;
    for (let y = 0; y < N; y++) {
      for (let x = 1; x < N; x++) {
        const l = this.wi(x - 1, y);
        const r = this.wi(x, y);
        const dH = bed[l] + water[l] - bed[r] - water[r];
        const i = this.fxi(x, y);
        fx[i] = fx[i] * this.frictionFactor + dH * k;
      }
    }
    for (let y = 1; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const b = this.wi(x, y - 1);
        const t = this.wi(x, y);
        const dH = bed[b] + water[b] - bed[t] - water[t];
        const i = this.fyi(x, y);
        fy[i] = fy[i] * this.frictionFactor + dH * k;
      }
    }
    // Wall the domain boundary edges (outflow is handled by the edge-drain ring).
    for (let y = 0; y < N; y++) {
      fx[this.fxi(0, y)] = 0;
      fx[this.fxi(N, y)] = 0;
    }
    for (let x = 0; x < N; x++) {
      fy[this.fyi(x, 0)] = 0;
      fy[this.fyi(x, N)] = 0;
    }
    // Outflow scaling — never remove more water than a cell holds.
    const cap = (cell * cell) / DT;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fxl = fx[this.fxi(x, y)];
        const fyb = fy[this.fyi(x, y)];
        const fxr = fx[this.fxi(x + 1, y)];
        const fyt = fy[this.fyi(x, y + 1)];
        let out = 0;
        if (fxl < 0) out += -fxl;
        if (fyb < 0) out += -fyb;
        if (fxr > 0) out += fxr;
        if (fyt > 0) out += fyt;
        if (out > 0) {
          const s = Math.min(1, (water[this.wi(x, y)] * cap) / out);
          if (s < 1) {
            if (fxl < 0) fx[this.fxi(x, y)] = fxl * s;
            if (fyb < 0) fy[this.fyi(x, y)] = fyb * s;
            if (fxr > 0) fx[this.fxi(x + 1, y)] = fxr * s;
            if (fyt > 0) fy[this.fyi(x, y + 1)] = fyt * s;
          }
        }
      }
    }
    // Move the water.
    const kd = DT / (cell * cell);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = this.wi(x, y);
        const dv =
          fx[this.fxi(x, y)] + fy[this.fyi(x, y)] - fx[this.fxi(x + 1, y)] - fy[this.fyi(x, y + 1)];
        water[i] += dv * kd;
        if (water[i] < 0) water[i] = 0;
      }
    }
    // Deepest cell → next substep's inflow throttle (cheap: reuse this pass).
    let mx = 0;
    for (let i = 0; i < N * N; i++) if (water[i] > mx) mx = water[i];
    this.maxD = mx;
    // Corridor confinement: water cannot exist off the real waterways, so any
    // that spread onto a non-corridor cell is removed. This is the hard cap that
    // makes island-flooding impossible — only the channels ever hold water.
    if (mask) {
      for (let i = 0; i < N * N; i++) if (!mask[i]) water[i] = 0;
    }
    // Edge-drain ring = outflow boundary (water leaving the window heads to sea).
    for (let x = 0; x < N; x++) {
      water[this.wi(x, 0)] *= EDGE_DRAIN;
      water[this.wi(x, N - 1)] *= EDGE_DRAIN;
    }
    for (let y = 0; y < N; y++) {
      water[this.wi(0, y)] *= EDGE_DRAIN;
      water[this.wi(N - 1, y)] *= EDGE_DRAIN;
    }
  }

  /** Advance the sim by `steps` substeps, scroll the ripples, refresh the mesh. */
  update(steps: number, dt = 0.016): void {
    if (!this.terrainReady || this.disposed) return;
    for (let s = 0; s < steps; s++) this.substep();
    this.clock += dt;
    if (this.normalTex) this.normalTex.offset.set(-this.clock * FLOW_SCROLL, this.clock * FLOW_SCROLL * 0.6);
    this.refreshMesh();
  }

  /** Load the scrolling ripple normal for the water surface. */
  private async loadNormal(): Promise<void> {
    const tex = await loadTexture("assets/textures/water_normal.png");
    if (!tex || this.disposed) return;
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    this.normalTex = tex;
    this.mat.normalMap = tex;
    this.mat.needsUpdate = true;
  }

  private buildMesh(): void {
    const N = this.N;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * N * 3);
    const col = new Float32Array(N * N * 4);
    const uv = new Float32Array(N * N * 2);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const o = this.wi(x, y) * 3;
        pos[o] = this.worldX(x);
        pos[o + 1] = 0;
        pos[o + 2] = this.worldZ(y);
        const u = this.wi(x, y) * 2;
        uv[u] = this.worldX(x) / BED_UV_M;
        uv[u + 1] = this.worldZ(y) / BED_UV_M;
      }
    }
    const idx: number[] = [];
    for (let y = 0; y < N - 1; y++) {
      for (let x = 0; x < N - 1; x++) {
        const a = this.wi(x, y);
        const b = this.wi(x + 1, y);
        const c = this.wi(x, y + 1);
        const d = this.wi(x + 1, y + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
    // Straight-up normals: water is a near-flat plane, so let the tangent-space
    // ripple normal map do the surface detail instead of per-cell face normals
    // (computeVertexNormals on the bumpy heightfield gives faceted, blocky
    // shading that reads as jagged rather than smooth water).
    const nrm = new Float32Array(N * N * 3);
    for (let i = 0; i < N * N; i++) nrm[i * 3 + 1] = 1;
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.posArr = pos;
    this.colArr = col;
    this.geo = geo;
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.name = "kauai-watersim-surface";
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.group.add(mesh);
  }

  private refreshMesh(): void {
    const N = this.N;
    const pos = this.posArr!;
    const col = this.colArr!;
    const bed = this.bed;
    const water = this.water;
    const mask = this.mask;
    for (let i = 0; i < N * N; i++) {
      // Render depth: draw the whole river corridor as filled water at MIN_FILL,
      // with the sim's own depth added on top where it has pooled. The corridor
      // mask IS the real NHD waterway, so filling it is correct — including the
      // below-sea-level inland canals/trenches. (An earlier version gated this to
      // bed > SEA, assuming the ocean floods everything below sea level. It does
      // NOT: inland depressions not connected to the open sea are baked to the
      // coast-mask "land" sentinel and get no ocean, so gating them out left the
      // main canal bone-dry — bare reef, no water. Fill the full corridor.)
      const raw = water[i];
      const fill = mask ? mask[i] === 1 : false;
      // A deep channel bed (say -3 m) filled only to bed+MIN_FILL leaves the reef
      // wall exposed from there up to the waterline. Instead raise the surface to
      // a flat FILL_LEVEL for any bed below it (like a pool), so the water covers
      // the whole submerged reef band with no dry fringe. Shallow/above-sea beds
      // still use bed+MIN_FILL; the sim's own depth (raw) wins when it pooled more.
      const level = fill ? Math.max(bed[i] + MIN_FILL, bed[i] + raw, FILL_LEVEL) : bed[i] + raw;
      const d = level - bed[i];
      pos[i * 3 + 1] = level + 0.03; // tiny visual offset above the bed
      const a =
        d <= MIN_DEPTH
          ? 0
          : d >= FULL_DEPTH
            ? 1
            : (d - MIN_DEPTH) / (FULL_DEPTH - MIN_DEPTH);
      // Depth tint (RGB multiplies the material colour): shallow ~neutral, deep
      // darker — never brighter, so shallow water isn't a glowing cyan stripe.
      const k = d >= FULL_DEPTH ? 1 : d <= MIN_DEPTH ? 0 : (d - MIN_DEPTH) / (FULL_DEPTH - MIN_DEPTH);
      const shade = 1.0 - 0.42 * k;
      const soft = this.edgeSoft ? this.edgeSoft[i] : 1;
      const c = i * 4;
      col[c] = shade;
      col[c + 1] = shade;
      col[c + 2] = shade * 1.04;
      col[c + 3] = a * soft; // feather bank pixels translucent → no hard staircase
    }
    this.geo!.attributes.position.needsUpdate = true;
    this.geo!.attributes.color.needsUpdate = true;
    // Normals stay straight-up (set in buildMesh); the ripple normal map supplies
    // the surface detail, keeping the water smooth instead of faceted.
  }

  /** Diagnostics: total water volume + wet-cell count (for headless checks). */
  stats(): { wetCells: number; totalVolume: number; maxDepth: number } {
    let wet = 0;
    let vol = 0;
    let mx = 0;
    const a = this.cell * this.cell;
    for (let i = 0; i < this.N * this.N; i++) {
      const d = this.water[i];
      if (d > MIN_DEPTH) wet++;
      vol += d * a;
      if (d > mx) mx = d;
    }
    return { wetCells: wet, totalVolume: vol, maxDepth: mx };
  }

  dispose(): void {
    this.disposed = true;
    this.geo?.dispose();
    this.mat.dispose();
    this.normalTex?.dispose();
    if (this.mesh) this.group.remove(this.mesh);
    this.group.parent?.remove(this.group);
  }
}
