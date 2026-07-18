import * as THREE from "three";
import type { KauaiTileStreamer } from "./KauaiTileStreamer";

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
const RAIN = 0.03; // m/s added everywhere — the headwater feed (pilot: fast fill)
const SEA = -0.4; // bed below this = ocean → drains to sea level
const EDGE_DRAIN = 0.5; // domain-edge ring keeps this fraction each step (outflow BC)
const MIN_DEPTH = 0.04; // below this a cell renders dry (transparent)
const FULL_DEPTH = 0.6; // at/above this the surface is fully opaque

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
  private mesh?: THREE.Mesh;
  private geo?: THREE.BufferGeometry;
  private posArr?: Float32Array;
  private colArr?: Float32Array;
  private readonly mat: THREE.MeshStandardMaterial;

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
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x1d6f8c,
      roughness: 0.18,
      metalness: 0.05,
      transparent: true,
      opacity: 0.86,
      vertexColors: true, // alpha carries per-cell wetness
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.group.name = "kauai-watersim";
    scene.add(this.group);
    this.buildMesh();
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
    this.terrainReady = true;
    return true;
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
    // Feed + drains.
    if (this.rainOn) {
      const add = RAIN * DT;
      for (let i = 0; i < N * N; i++) water[i] += add;
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

  /** Advance the sim by `steps` substeps and refresh the surface mesh. */
  update(steps: number): void {
    if (!this.terrainReady || this.disposed) return;
    for (let s = 0; s < steps; s++) this.substep();
    this.refreshMesh();
  }

  private buildMesh(): void {
    const N = this.N;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * N * 3);
    const col = new Float32Array(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const o = this.wi(x, y) * 3;
        pos[o] = this.worldX(x);
        pos[o + 1] = 0;
        pos[o + 2] = this.worldZ(y);
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
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
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
    for (let i = 0; i < N * N; i++) {
      const d = water[i];
      pos[i * 3 + 1] = bed[i] + d;
      // alpha ramps in over [MIN_DEPTH, FULL_DEPTH] so dry cells vanish.
      const a =
        d <= MIN_DEPTH
          ? 0
          : d >= FULL_DEPTH
            ? 1
            : (d - MIN_DEPTH) / (FULL_DEPTH - MIN_DEPTH);
      const c = i * 4;
      col[c] = 1;
      col[c + 1] = 1;
      col[c + 2] = 1;
      col[c + 3] = a;
    }
    this.geo!.attributes.position.needsUpdate = true;
    this.geo!.attributes.color.needsUpdate = true;
    this.geo!.computeVertexNormals();
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
    if (this.mesh) this.group.remove(this.mesh);
    this.group.parent?.remove(this.group);
  }
}
