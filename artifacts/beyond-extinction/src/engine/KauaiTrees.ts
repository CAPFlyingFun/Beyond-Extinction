import * as THREE from "three";
import { assetUrl, loadTexture } from "./assets";
import type { KauaiTileStreamer } from "./KauaiTileStreamer";
import type { KauaiHydro } from "./KauaiHydro";

/**
 * Streaming billboard forest for the real-scale Kauaʻi map — the metre-scale
 * counterpart to islandBillboardTrees (the "other map" forest). Each tree is a
 * single camera-facing photo quad; a whole neighbourhood of trees is one
 * InstancedMesh, billboarded + wind-swayed in the vertex shader, and faded out
 * by distance with the SAME dithered alpha ramp the beach map uses.
 *
 * Placement is driven by the baked USGS/ESA vegetation rasters
 * (assets/terrain/kauai/veg): landcover picks tree vs shrub vs open ground,
 * canopy cover sets local density, and the water + river masks keep trees out
 * of the sea, lakes and channels. Species are chosen by real elevation band
 * (palms fringe the coast, ferns/cycads carpet the low jungle, broadleaf on the
 * mid slopes, conifers near the summit).
 *
 * Streaming: the world is diced into fixed CHUNK-metre cells. Only cells within
 * BUILD_M of the player (whose terrain tile has decoded, so trees can be grounded
 * on the real surface) are built; cells drifting past KEEP_M are disposed, so
 * memory stays bounded no matter how far you range across the 56 km map. At most
 * a couple of cells are built per frame to avoid hitches when crossing tiles.
 */

const CHUNK = 300; // metres per streamed forest cell
const STEP = 10.2; // metres between candidate planting sites (denser = fuller)
const BUILD_M = 1050; // build cells within this radius of the player
const KEEP_M = 2600; // dispose cells past this radius
const DRAW_M = 900; // trees solid to 75% of this, dither out to it
const BUILD_PER_FRAME = 2; // cap cell builds per frame (anti-hitch)
const WATER_MARGIN = 2.5; // keep plant bases this far back from any water edge

// Vegetation raster geometry (see assets/terrain/kauai/veg/veg.json).
const VEG_GRID = 384;
const MAP_M = 56000; // world square the rasters cover (±28 km)

interface Species {
  file: string; // asset path under assets/ (incl. subdir + extension)
  height: number; // metres
  minH: number; // elevation band (m)
  maxH: number;
  sway: number; // crown sway amplitude (m)
  weight: number; // relative pick weight inside its band
}

// Coast → summit succession, keyed to real Kauaʻi elevation (m). The low, wide
// bush carpets the understory across nearly the whole vegetated range so the
// ground layer reads as thick brush between the taller canopy species.
const SPECIES: Species[] = [
  { file: "billboards/billboard_bush_01.png", height: 2.6, minH: 0.5, maxH: 620, sway: 0.4, weight: 1.1 },
  { file: "trees/palm.png", height: 13, minH: 0.5, maxH: 24, sway: 1.2, weight: 0.5 },
  { file: "trees/cycad.png", height: 6, minH: 0.5, maxH: 30, sway: 0.5, weight: 0.7 },
  { file: "trees/sago.png", height: 6.5, minH: 1, maxH: 45, sway: 0.5, weight: 0.7 },
  { file: "trees/fern.png", height: 4.5, minH: 1, maxH: 260, sway: 0.8, weight: 1.0 },
  { file: "trees/aspen.png", height: 12, minH: 60, maxH: 680, sway: 1.0, weight: 0.9 },
  { file: "trees/conifer.png", height: 14, minH: 460, maxH: 1600, sway: 1.2, weight: 0.85 },
];

/** Stable hash → [0,1), same family as the beach forest so stands are stable. */
function hash(i: number, j: number, salt: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Cylindrical-billboard + wind-sway + distance-fade material. World units are
 * metres here, so the fade ramp reads camera distance directly (no unit
 * conversion). Unlit basic material — the tree photos are already lit.
 */
function billboardMaterial(
  tex: THREE.Texture,
  sway: number,
  uTime: { value: number },
  uFadeStart: { value: number },
  uFadeEnd: { value: number },
): THREE.Material {
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    transparent: false,
    fog: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uSway = { value: sway };
    shader.uniforms.uFadeStart = uFadeStart;
    shader.uniforms.uFadeEnd = uFadeEnd;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime, uSway, uFadeStart, uFadeEnd;
        varying float vOpacity;
        // metres → opacity: full to uFadeStart, linear ramp to 0 at uFadeEnd.
        float treeFade(float m) {
          return clamp((uFadeEnd - m) / max(uFadeEnd - uFadeStart, 1.0), 0.0, 1.0);
        }`,
      )
      .replace(
        "#include <project_vertex>",
        `
        vec3 bbBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float bbW = length(instanceMatrix[0].xyz);
        float bbH = length(instanceMatrix[1].xyz);
        vec3 bbToCam = cameraPosition - bbBase; bbToCam.y = 0.0;
        float bbLen = length(bbToCam);
        vec3 bbLook = bbLen > 1e-4 ? bbToCam / bbLen : vec3(0.0, 0.0, 1.0);
        vec3 bbRight = normalize(cross(vec3(0.0, 1.0, 0.0), bbLook));
        float bbPh = dot(bbBase.xz, vec2(0.031, 0.017));
        float bbBend = position.y * position.y;
        float bbSway = (sin(uTime * 1.1 + bbPh) + 0.5 * sin(uTime * 2.3 + bbPh * 1.7)) * uSway * bbBend;
        vec3 bbWorld = bbBase
          + bbRight * (position.x * bbW + bbSway)
          + vec3(0.0, position.y * bbH, 0.0);
        vec4 mvPosition = viewMatrix * vec4(bbWorld, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vOpacity = treeFade(bbLen); // world = metres
        `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vOpacity;
        float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
        float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }`,
      )
      .replace(
        "#include <alphatest_fragment>",
        `#include <alphatest_fragment>
        if (vOpacity < bayer4(gl_FragCoord.xy)) discard;`,
      );
  };
  mat.customProgramCacheKey = () => "kauai-billboard-tree";
  return mat;
}

/** A decoded vegetation raster as a flat R-channel array + bilinear sampler. */
interface Raster {
  data: Uint8ClampedArray; // one byte per pixel (R channel)
  w: number;
  h: number;
}

/** zlib-inflate a byte range using the platform DecompressionStream. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/**
 * Decode an 8-bit greyscale, non-interlaced PNG (all four veg rasters are this
 * form) to a flat one-byte-per-pixel array — entirely on the CPU. This avoids
 * createImageBitmap + canvas readback, which under a continuously-rendering
 * WebGL context (heavy scene load on low-end GPUs / headless swiftshader) can
 * silently return zero-dimension / blank pixels and disable all planting.
 */
async function loadRaster(name: string): Promise<Raster | null> {
  try {
    const res = await fetch(assetUrl(`assets/terrain/kauai/veg/${name}`));
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(buf.buffer);
    // PNG signature check.
    if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    let w = 0;
    let h = 0;
    const idat: Uint8Array[] = [];
    let i = 8; // past the 8-byte signature
    while (i < buf.length) {
      const len = dv.getUint32(i);
      const type =
        String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
      const start = i + 8;
      if (type === "IHDR") {
        w = dv.getUint32(start);
        h = dv.getUint32(start + 4);
        const bitDepth = buf[start + 8];
        const colorType = buf[start + 9];
        const interlace = buf[start + 12];
        if (bitDepth !== 8 || colorType !== 0 || interlace !== 0) return null;
      } else if (type === "IDAT") {
        idat.push(buf.subarray(start, start + len));
      } else if (type === "IEND") {
        break;
      }
      i = start + len + 4; // skip data + CRC
    }
    if (!w || !h || !idat.length) return null;

    // Concatenate IDAT chunks and inflate.
    let total = 0;
    for (const c of idat) total += c.length;
    const comp = new Uint8Array(total);
    let off = 0;
    for (const c of idat) {
      comp.set(c, off);
      off += c.length;
    }
    const raw = await inflate(comp);

    // Un-filter scanlines (greyscale → 1 byte per pixel, so bpp = 1).
    const out = new Uint8ClampedArray(w * h);
    const stride = w;
    let pos = 0;
    for (let y = 0; y < h; y++) {
      const filter = raw[pos++];
      for (let x = 0; x < stride; x++) {
        const rawv = raw[pos + x];
        const a = x >= 1 ? out[y * stride + x - 1] : 0; // left
        const b = y >= 1 ? out[(y - 1) * stride + x] : 0; // up
        const c = x >= 1 && y >= 1 ? out[(y - 1) * stride + x - 1] : 0; // up-left
        let v = rawv;
        if (filter === 1) v = rawv + a;
        else if (filter === 2) v = rawv + b;
        else if (filter === 3) v = rawv + ((a + b) >> 1);
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = rawv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        out[y * stride + x] = v & 255;
      }
      pos += stride;
    }
    return { data: out, w, h };
  } catch {
    return null;
  }
}

/** World XZ → raster pixel (nearest), value 0 if the raster is missing. */
function sampleNearest(r: Raster | null, x: number, z: number): number {
  if (!r) return 0;
  const px = Math.round(((x / MAP_M + 0.5) * (VEG_GRID - 1)) | 0);
  const py = Math.round(((z / MAP_M + 0.5) * (VEG_GRID - 1)) | 0);
  if (px < 0 || py < 0 || px >= r.w || py >= r.h) return 0;
  return r.data[py * r.w + px];
}

/** Bilinear sample (for the smooth canopy-density field). */
function sampleBilinear(r: Raster | null, x: number, z: number): number {
  if (!r) return 0;
  const fx = Math.min(r.w - 1, Math.max(0, (x / MAP_M + 0.5) * (VEG_GRID - 1)));
  const fy = Math.min(r.h - 1, Math.max(0, (z / MAP_M + 0.5) * (VEG_GRID - 1)));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(r.w - 1, x0 + 1);
  const y1 = Math.min(r.h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = r.data;
  return (
    d[y0 * r.w + x0] * (1 - tx) * (1 - ty) +
    d[y0 * r.w + x1] * tx * (1 - ty) +
    d[y1 * r.w + x0] * (1 - tx) * ty +
    d[y1 * r.w + x1] * tx * ty
  );
}

interface Cell {
  ci: number;
  cj: number;
  cx: number; // centre X (m)
  cz: number; // centre Z (m)
  meshes: THREE.InstancedMesh[];
}

/** River segments + lake rings overlapping a forest cell (from KauaiHydro). */
type WaterSet = ReturnType<KauaiHydro["waterNear"]>;

/** Squared distance from point (px,pz) to segment (ax,az)-(bx,bz), in XZ. */
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
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
}

/** Even-odd point-in-polygon test for a closed ring of [x, z] points. */
function pointInRing(px: number, pz: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** True if (px,pz) touches any river ribbon or lake in the set (widths already
 *  include WATER_MARGIN via KauaiHydro.waterNear). */
function touchesWater(px: number, pz: number, water: WaterSet): boolean {
  for (const s of water.segs) {
    if (distSqToSeg(px, pz, s.ax, s.az, s.bx, s.bz) <= s.half * s.half) return true;
  }
  for (const l of water.lakes) {
    if (pointInRing(px, pz, l.ring) && !l.holes.some((h) => pointInRing(px, pz, h))) {
      return true;
    }
  }
  return false;
}

export class KauaiTrees {
  readonly group = new THREE.Group();

  private readonly scene: THREE.Scene;
  private readonly uTime = { value: 0 };
  private readonly uFadeEnd = { value: DRAW_M };
  private readonly uFadeStart = { value: DRAW_M * 0.75 };
  private readonly quad: THREE.PlaneGeometry;
  private mats: (THREE.Material | null)[] = [];
  private widths: number[] = [];
  private canopy: Raster | null = null;
  private landcover: Raster | null = null;
  private water: Raster | null = null;
  private river: Raster | null = null;
  private ready = false;
  private disposed = false;
  private readonly cells = new Map<string, Cell>();
  private readonly buildQueue: { ci: number; cj: number }[] = [];

  /** True once the vegetation rasters + species billboards have decoded and the
   *  forest can start planting cells (gates the arrival reveal on "trees ready"). */
  get isReady(): boolean {
    return this.ready;
  }
  /** How many forest cells have actually been scattered/planted so far. */
  get cellCount(): number {
    return this.cells.size;
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = "kauai-trees";
    scene.add(this.group);
    this.quad = new THREE.PlaneGeometry(1, 1);
    this.quad.translate(0, 0.5, 0); // pivot at the base so instances plant feet
    void this.init();
  }

  private async init(): Promise<void> {
    // Decode the vegetation rasters ONE AT A TIME. Decoding them concurrently
    // (and alongside the tree-texture GPU uploads) intermittently yields a
    // 0-dimension bitmap for the indexed-colour landcover PNG, which would
    // silently disable all planting. Sequential decode is reliable.
    this.canopy = await loadRaster("canopy.png");
    if (this.disposed) return;
    this.landcover = await loadRaster("landcover.png");
    if (this.disposed) return;
    this.water = await loadRaster("water.png");
    if (this.disposed) return;
    this.river = await loadRaster("river.png");
    if (this.disposed) return;

    const texs = await Promise.all(
      SPECIES.map((sp) => loadTexture(`assets/${sp.file}`)),
    );
    if (this.disposed) return;
    this.mats = SPECIES.map((sp, s) => {
      const tex = texs[s];
      if (!tex) return null;
      tex.anisotropy = 4;
      const img = tex.image as { width: number; height: number } | undefined;
      const aspect = img && img.height ? img.width / img.height : 0.6;
      this.widths[s] = sp.height * aspect;
      return billboardMaterial(tex, sp.sway, this.uTime, this.uFadeStart, this.uFadeEnd);
    });
    this.ready = true;
  }

  /** Build one forest cell: scatter, gate on veg rasters, ground on terrain. */
  private buildCell(
    ci: number,
    cj: number,
    streamer: KauaiTileStreamer,
    water: WaterSet | null,
  ): void {
    const key = `${ci},${cj}`;
    if (this.cells.has(key)) return;
    const x0 = ci * CHUNK;
    const z0 = cj * CHUNK;
    const buckets: THREE.Matrix4[][] = SPECIES.map(() => []);
    const dummy = new THREE.Object3D();

    for (let gx = x0; gx < x0 + CHUNK; gx += STEP) {
      for (let gz = z0; gz < z0 + CHUNK; gz += STEP) {
        const i = Math.round(gx / STEP);
        const j = Math.round(gz / STEP);
        const px = gx + (hash(i, j, 21) - 0.5) * STEP * 0.9;
        const pz = gz + (hash(i, j, 22) - 0.5) * STEP * 0.9;

        // Vegetation gates: land only, no water/rivers, real tree/shrub cover.
        if (sampleNearest(this.water, px, pz) > 0) continue;
        if (sampleNearest(this.river, px, pz) > 90) continue;
        const lc = sampleNearest(this.landcover, px, pz);
        const isTree = lc === 10;
        const isShrub = lc === 20;
        if (!isTree && !isShrub) continue;
        const canopy = sampleBilinear(this.canopy, px, pz) / 255; // 0..1 cover
        // Probability of a tree at this site: canopy cover, thinned for shrub.
        const prob = canopy * (isTree ? 1 : 0.45);
        if (prob < 0.04 || hash(i, j, 23) > prob) continue;

        // Ground on the RENDERED mesh surface (not the finer heightmap) so the
        // base sits exactly on the terrain you see, even on curved slopes.
        const h = streamer.surfaceHeightAt(px, pz);
        if (h < 1) continue; // never plant below/at the waterline

        // Precise water collision: skip anything landing on/near a real river
        // ribbon or lake (the veg raster is too coarse to catch narrow channels).
        if (water && touchesWater(px, pz, water)) continue;

        // Species by elevation band, weighted pick among those in-band.
        let total = 0;
        for (let s = 0; s < SPECIES.length; s++) {
          const sp = SPECIES[s];
          if (h >= sp.minH && h <= sp.maxH && this.mats[s]) total += sp.weight;
        }
        if (total <= 0) continue;
        let r = hash(i, j, 24) * total;
        let pick = -1;
        for (let s = 0; s < SPECIES.length; s++) {
          const sp = SPECIES[s];
          if (h < sp.minH || h > sp.maxH || !this.mats[s]) continue;
          r -= sp.weight;
          if (r <= 0) {
            pick = s;
            break;
          }
        }
        if (pick < 0) continue;

        const scale = 0.82 + hash(i, j, 28) * 0.42;
        dummy.position.set(px, h - 0.4, pz); // feet a hair under ground
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(this.widths[pick] * scale, SPECIES[pick].height * scale, 1);
        dummy.updateMatrix();
        buckets[pick].push(dummy.matrix.clone());
      }
    }

    const meshes: THREE.InstancedMesh[] = [];
    SPECIES.forEach((sp, s) => {
      const mats = buckets[s];
      const mat = this.mats[s];
      if (!mats.length || !mat) return;
      const im = new THREE.InstancedMesh(this.quad, mat, mats.length);
      mats.forEach((m, k) => im.setMatrixAt(k, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      if (im.boundingSphere) im.boundingSphere.radius += sp.height + sp.sway * 2;
      im.frustumCulled = true;
      im.castShadow = false;
      im.receiveShadow = false;
      const spId = sp.file.replace(/^.*\//, "").replace(/\.[a-z]+$/i, "");
      im.name = `kauai-trees-${spId}-${key}`;
      this.group.add(im);
      meshes.push(im);
    });

    this.cells.set(key, {
      ci,
      cj,
      cx: x0 + CHUNK / 2,
      cz: z0 + CHUNK / 2,
      meshes,
    });
  }

  private disposeCell(cell: Cell): void {
    for (const m of cell.meshes) {
      this.group.remove(m);
      m.geometry.dispose(); // the shared quad is cheap to recreate; frees GPU buffers
    }
    this.cells.delete(`${cell.ci},${cell.cj}`);
  }

  /** Call every frame after the streamer's update. Pass the hydro layer so new
   *  cells can exclude anything landing on a real river or lake. */
  update(
    dt: number,
    camPos: THREE.Vector3,
    streamer: KauaiTileStreamer,
    hydro?: KauaiHydro,
  ): void {
    this.uTime.value += dt;
    if (!this.ready) return;

    // Retire cells that drifted out of the keep radius (bounded memory).
    for (const cell of [...this.cells.values()]) {
      const dx = cell.cx - camPos.x;
      const dz = cell.cz - camPos.z;
      if (dx * dx + dz * dz > KEEP_M * KEEP_M) this.disposeCell(cell);
    }

    // Queue nearby, terrain-ready cells that aren't built yet.
    const c0 = Math.floor((camPos.x - BUILD_M) / CHUNK);
    const c1 = Math.floor((camPos.x + BUILD_M) / CHUNK);
    const r0 = Math.floor((camPos.z - BUILD_M) / CHUNK);
    const r1 = Math.floor((camPos.z + BUILD_M) / CHUNK);
    for (let ci = c0; ci <= c1; ci++) {
      for (let cj = r0; cj <= r1; cj++) {
        const key = `${ci},${cj}`;
        if (this.cells.has(key)) continue;
        const cx = ci * CHUNK + CHUNK / 2;
        const cz = cj * CHUNK + CHUNK / 2;
        const dx = cx - camPos.x;
        const dz = cz - camPos.z;
        if (dx * dx + dz * dz > BUILD_M * BUILD_M) continue;
        if (!streamer.tileReadyAt(cx, cz)) continue; // grounding needs the tile
        if (!this.buildQueue.some((q) => q.ci === ci && q.cj === cj)) {
          this.buildQueue.push({ ci, cj });
        }
      }
    }
    // Build a couple per frame (nearest first) to avoid tile-crossing hitches.
    this.buildQueue.sort((a, b) => {
      const da = (a.ci * CHUNK - camPos.x) ** 2 + (a.cj * CHUNK - camPos.z) ** 2;
      const db = (b.ci * CHUNK - camPos.x) ** 2 + (b.cj * CHUNK - camPos.z) ** 2;
      return da - db;
    });
    // Defer building until the hydrography is parsed, so the water-collision
    // test is authoritative — otherwise trees could be planted in a channel
    // before we can see it (the coarse veg raster misses narrow rivers).
    const waterReady = !hydro || hydro.isLoaded;
    for (let n = 0; waterReady && n < BUILD_PER_FRAME && this.buildQueue.length; n++) {
      const { ci, cj } = this.buildQueue.shift()!;
      const x0 = ci * CHUNK;
      const z0 = cj * CHUNK;
      const water = hydro
        ? hydro.waterNear(
            x0 - WATER_MARGIN,
            z0 - WATER_MARGIN,
            x0 + CHUNK + WATER_MARGIN,
            z0 + CHUNK + WATER_MARGIN,
            WATER_MARGIN,
          )
        : null;
      this.buildCell(ci, cj, streamer, water);
    }

    // Per-tree distance fade + per-cell cull (same ramp as the beach forest).
    this.uFadeEnd.value = DRAW_M;
    this.uFadeStart.value = DRAW_M * 0.75;
    for (const cell of this.cells.values()) {
      const dx = cell.cx - camPos.x;
      const dz = cell.cz - camPos.z;
      const lim = DRAW_M + CHUNK; // whole-cell cull once fully past the fade end
      const vis = dx * dx + dz * dz < lim * lim;
      for (const m of cell.meshes) m.visible = vis;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const cell of [...this.cells.values()]) this.disposeCell(cell);
    this.cells.clear();
    this.buildQueue.length = 0;
    for (const m of this.mats) m?.dispose();
    this.quad.dispose();
    this.scene.remove(this.group);
  }
}
