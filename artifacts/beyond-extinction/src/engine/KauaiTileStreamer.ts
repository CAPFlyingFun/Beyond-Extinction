import * as THREE from "three";
import { assetUrl, loadTexture } from "./assets";
import { SEG, renderedSurfaceHeight } from "./terrainSampling";
import { KauaiCarve } from "./KauaiCarve";

/**
 * Streaming terrain for the full-scale Kauaʻi map (Chapter 2+ "Hanifat").
 *
 * The island ships as a 8×8 chessboard of 7 km heightmap tiles (A1…H8, folders
 * A–H) baked from real USGS/Terrarium elevation — 56 km across at true scale,
 * far too large to hold in memory at once on a phone. This streamer keeps only
 * the ring of tiles around the player resident: as they walk toward a new tile
 * it loads and FADES IN, and tiles that fall out of range FADE OUT and dispose.
 *
 * Everything here is in REAL METRES (matching the manifest + PlayerController's
 * metre-based movement): grid centre is world (0,0); a tile at column `col`
 * (A=0…H=7) and row `row` (0…7) is centred at ((col−3.5)·S, (row−3.5)·S) with
 * S = tileSizeM. Column → +X (east), row → +Z (south). Height is elevation in
 * metres, sea level = 0.
 */

export interface KauaiManifestTile {
  id: string;
  col: number;
  row: number;
  file: string;
}
export interface KauaiManifest {
  tileSizeM: number;
  tilePixels: number;
  tiles: KauaiManifestTile[];
  spawn?: { tile?: string; x?: number; z?: number; facing?: string };
}

/**
 * Terrarium RGB → metres. Keeps the REAL bathymetry (negative = below sea
 * level) so the seafloor drops beneath the water plane instead of z-fighting a
 * flat sand shelf against it. Only genuine nodata sentinels (absurd depths)
 * are floored.
 */
function decodeElev(r: number, g: number, b: number): number {
  const e = r * 256 + g + b / 256 - 32768;
  return e < -6000 ? -6000 : e;
}

// Grid resolution per tile (SEG) + surface sampling now live in
// terrainSampling.ts so the pure math is unit-testable and shared.
// Tiles are baked 513² with a 1-px overlap: a tile's last height column/row is
// byte-identical to its neighbour's first, and the mesh maps u·(P−1) so that
// shared sample lands exactly on the tile border. Neighbouring edge vertices
// therefore get the SAME world position and height — the grid welds watertight
// and the skirt is only a safety net for the cross-fade window (a fading-in
// tile is briefly transparent) and float rounding, so it can stay shallow.
const SKIRT_M = 6; // metres each tile's edge apron drops behind the seam
const FADE_PER_SEC = 1 / 0.6; // ~0.6 s cross-fade

/** Biome ground textures blended across the terrain by elevation + slope. */
interface BiomeTextures {
  sand: THREE.Texture;
  grass: THREE.Texture;
  jungle: THREE.Texture;
  rock: THREE.Texture; // cliff.jpg — steep faces + mid rock
  mountain: THREE.Texture;
  snow: THREE.Texture;
  reef: THREE.Texture; // shallow seafloor / lagoon
}

type TileState = "loading" | "in" | "active" | "out";

interface Tile {
  id: string;
  col: number;
  row: number;
  cx: number; // centre X (m)
  cz: number; // centre Z (m)
  heights?: Float32Array; // P×P elevation (m), row-major, north→south
  mesh?: THREE.Mesh;
  mat?: THREE.MeshStandardMaterial;
  state: TileState;
  opacity: number;
}

export interface KauaiStreamerOptions {
  /** Chebyshev tile radius kept resident around the player (1 = 3×3). */
  radius?: number;
  /** Root under public/ for the tiles, no trailing slash. */
  base?: string;
}

export class KauaiTileStreamer {
  readonly group = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly S: number;
  private readonly P: number;
  private readonly radius: number;
  private readonly base: string;
  private readonly byId = new Map<string, KauaiManifestTile>();
  private readonly tiles = new Map<string, Tile>();
  private curCol = -99;
  private curRow = -99;
  /** Number of tiles fully or partially resident (for a debug HUD). */
  resident = 0;
  /** Shared biome textures, loaded once and reused by every tile mesh. */
  private texReady: Promise<BiomeTextures>;

  constructor(
    scene: THREE.Scene,
    manifest: KauaiManifest,
    opts: KauaiStreamerOptions = {},
  ) {
    this.scene = scene;
    this.S = manifest.tileSizeM;
    this.P = manifest.tilePixels;
    this.radius = opts.radius ?? 1;
    this.base = opts.base ?? "assets/terrain/kauai";
    for (const t of manifest.tiles) this.byId.set(t.id, t);
    this.group.name = "kauai-terrain";
    scene.add(this.group);
    this.texReady = this.loadBiomeTextures();
  }

  /** Load the shared biome ground textures once (repeat-wrapped for tiling). */
  private async loadBiomeTextures(): Promise<BiomeTextures> {
    const names: (keyof BiomeTextures)[] = [
      "sand",
      "grass",
      "jungle",
      "rock",
      "mountain",
      "snow",
      "reef",
    ];
    const files: Record<keyof BiomeTextures, string> = {
      sand: "sand",
      grass: "grass",
      jungle: "jungle",
      rock: "cliff",
      mountain: "mountain",
      snow: "snow",
      reef: "reef",
    };
    const white = (): THREE.Texture => {
      const t = new THREE.DataTexture(
        new Uint8Array([200, 200, 200, 255]),
        1,
        1,
      );
      t.needsUpdate = true;
      return t;
    };
    const out = {} as BiomeTextures;
    await Promise.all(
      names.map(async (n) => {
        const tex = (await loadTexture(`assets/textures/${files[n]}.jpg`)) ?? white();
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        // High anisotropy keeps the ground crisp at grazing angles instead of
        // dissolving into moiré bands (three clamps to the device max).
        tex.anisotropy = 16;
        out[n] = tex;
      }),
    );
    return out;
  }

  /** Tile column/row for a world XZ (unclamped). */
  private colOf(x: number): number {
    return Math.round(x / this.S + 3.5);
  }
  private rowOf(z: number): number {
    return Math.round(z / this.S + 3.5);
  }
  centreOf(col: number, row: number): { x: number; z: number } {
    return { x: (col - 3.5) * this.S, z: (row - 3.5) * this.S };
  }

  /** Ground elevation (m) at a world XZ, bilinear from the resident tile. 0 if none loaded. */
  heightAt(x: number, z: number): number {
    const col = this.colOf(x);
    const row = this.rowOf(z);
    const t = this.tiles.get(`${col},${row}`);
    if (!t || !t.heights) return 0;
    const P = this.P;
    // local 0..1 across the tile (west→east, north→south)
    const u = (x - t.cx) / this.S + 0.5;
    const v = (z - t.cz) / this.S + 0.5;
    const fx = Math.min(P - 1, Math.max(0, u * (P - 1)));
    const fy = Math.min(P - 1, Math.max(0, v * (P - 1)));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(P - 1, x0 + 1);
    const y1 = Math.min(P - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const h = t.heights;
    const h00 = h[y0 * P + x0];
    const h10 = h[y0 * P + x1];
    const h01 = h[y1 * P + x0];
    const h11 = h[y1 * P + x1];
    return (
      h00 * (1 - tx) * (1 - ty) +
      h10 * tx * (1 - ty) +
      h01 * (1 - tx) * ty +
      h11 * tx * ty
    );
  }

  /**
   * Height of the RENDERED terrain surface at world (x, z). Unlike heightAt
   * (which bilinear-samples the full-resolution heightmap), this reproduces the
   * mesh's SEG-resolution grid TRIANGLE-exactly — the same diagonal split
   * PlaneGeometry draws — so anything grounded here sits ON the visible
   * surface. (A bilinear blend of the four cell corners differs from the two
   * drawn triangles by the cell's twist term — metres on rough 36 m cells —
   * which was how water ribbons kept clipping through hillsides.)
   */
  surfaceHeightAt(x: number, z: number): number {
    const col = this.colOf(x);
    const row = this.rowOf(z);
    const t = this.tiles.get(`${col},${row}`);
    if (!t || !t.heights) return 0;
    return renderedSurfaceHeight(t.heights, this.P, this.S, x - t.cx, z - t.cz);
  }

  /** True once the tile the player is standing in has its heights decoded. */
  get currentReady(): boolean {
    const t = this.tiles.get(`${this.colOf(0) + 0},${this.rowOf(0)}`);
    return !!t?.heights;
  }
  tileReadyAt(x: number, z: number): boolean {
    return !!this.tiles.get(`${this.colOf(x)},${this.rowOf(z)}`)?.heights;
  }

  /**
   * Force the single tile containing world (x, z) to load NOW and resolve once
   * its heights are decoded (mesh built) — used to bring the arrival/spawn tile
   * in FIRST, ahead of the surrounding ring, so the player has ground + a
   * grounded body before the establishing flyover begins. Resolves false for an
   * ocean-only cell with no baked tile. Polls with a generous cap so a slow
   * connection still settles rather than hanging forever.
   */
  async ensureTileAt(x: number, z: number): Promise<boolean> {
    const col = Math.min(7, Math.max(0, this.colOf(x)));
    const row = Math.min(7, Math.max(0, this.rowOf(z)));
    const id = String.fromCharCode(65 + col) + (row + 1);
    if (!this.byId.has(id)) return false;
    const key = `${col},${row}`;
    if (!this.tiles.has(key)) void this.loadTile(col, row, key);
    for (let i = 0; i < 600; i++) {
      if (this.tiles.get(key)?.heights) return true;
      await new Promise((r) => setTimeout(r, 30));
    }
    return !!this.tiles.get(key)?.heights;
  }

  /**
   * Progress of the resident ring around (camX, camZ): how many of the wanted
   * land tiles have decoded vs how many exist. Drives the dynamic loading bar —
   * because tiles stream at the connection's pace, the bar reflects real network
   * speed rather than a canned timer. Ocean-only cells (absent from the manifest)
   * are not counted, so the bar can actually reach 100 %.
   */
  loadState(camX: number, camZ: number): { ready: number; total: number } {
    const col = Math.min(7, Math.max(0, this.colOf(camX)));
    const row = Math.min(7, Math.max(0, this.rowOf(camZ)));
    let ready = 0;
    let total = 0;
    for (let dc = -this.radius; dc <= this.radius; dc++) {
      for (let dr = -this.radius; dr <= this.radius; dr++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c > 7 || r < 0 || r > 7) continue;
        const id = String.fromCharCode(65 + c) + (r + 1);
        if (!this.byId.has(id)) continue;
        total++;
        if (this.tiles.get(`${c},${r}`)?.heights) ready++;
      }
    }
    return { ready, total };
  }

  /** Stream + advance cross-fades. Call every frame with the camera XZ. */
  update(dt: number, camX: number, camZ: number): void {
    const col = Math.min(7, Math.max(0, this.colOf(camX)));
    const row = Math.min(7, Math.max(0, this.rowOf(camZ)));
    if (col !== this.curCol || row !== this.curRow) {
      this.curCol = col;
      this.curRow = row;
      this.reconcile(col, row);
    }
    // advance fades
    let resident = 0;
    for (const [key, t] of this.tiles) {
      if (t.state === "in") {
        t.opacity = Math.min(1, t.opacity + dt * FADE_PER_SEC);
        if (t.mat) t.mat.opacity = t.opacity;
        if (t.opacity >= 1) {
          t.state = "active";
          if (t.mat) {
            t.mat.transparent = false;
            t.mat.depthWrite = true;
          }
        }
      } else if (t.state === "out") {
        t.opacity = Math.max(0, t.opacity - dt * FADE_PER_SEC);
        if (t.mat) {
          t.mat.transparent = true;
          t.mat.opacity = t.opacity;
        }
        if (t.opacity <= 0) {
          this.disposeTile(t);
          this.tiles.delete(key);
          continue;
        }
      }
      resident++;
    }
    this.resident = resident;
  }

  /** Decide the desired resident set for the current tile and kick loads/unloads. */
  private reconcile(col: number, row: number): void {
    const want = new Set<string>();
    for (let dc = -this.radius; dc <= this.radius; dc++) {
      for (let dr = -this.radius; dr <= this.radius; dr++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c > 7 || r < 0 || r > 7) continue;
        const id = String.fromCharCode(65 + c) + (r + 1);
        if (!this.byId.has(id)) continue;
        want.add(`${c},${r}`);
      }
    }
    // start loads for newly-wanted tiles
    for (const key of want) {
      const existing = this.tiles.get(key);
      if (existing) {
        if (existing.state === "out") {
          // coming back before it finished fading — revive
          existing.state = existing.opacity >= 1 ? "active" : "in";
        }
        continue;
      }
      const [c, r] = key.split(",").map(Number);
      void this.loadTile(c, r, key);
    }
    // fade out tiles no longer wanted
    for (const [key, t] of this.tiles) {
      if (!want.has(key) && t.state !== "out") {
        t.state = "out";
        if (t.mat) {
          t.mat.transparent = true;
          t.mat.depthWrite = false;
        }
      }
    }
  }

  private async loadTile(col: number, row: number, key: string): Promise<void> {
    const id = String.fromCharCode(65 + col) + (row + 1);
    const man = this.byId.get(id);
    if (!man) return;
    const { x: cx, z: cz } = this.centreOf(col, row);
    const tile: Tile = { id, col, row, cx, cz, state: "loading", opacity: 0 };
    this.tiles.set(key, tile);
    let heights: Float32Array;
    try {
      heights = await this.decodeHeights(man.file);
    } catch {
      // failed load: drop the slot so a later pass can retry
      if (this.tiles.get(key) === tile) this.tiles.delete(key);
      return;
    }
    // Press the river channels + lake beds into the height DATA before anyone
    // sees it (mesh build, physics, planting, hydro all read tile.heights) so
    // every consumer agrees on the carved ground. ready() resolves even if
    // hydro.json failed — the tile then builds uncarved rather than never.
    await KauaiCarve.ready();
    KauaiCarve.applyToTile(heights, this.P, this.S, col, row);
    const tex = await this.texReady;
    // player may have moved away while decoding
    if (this.tiles.get(key) !== tile) return;
    tile.heights = heights;
    this.buildMesh(tile, tex);
    // if it was marked out during the await, honor that; else fade in
    if (tile.state !== "out") tile.state = "in";
  }

  private async decodeHeights(file: string): Promise<Float32Array> {
    const P = this.P;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`tile ${file}`));
      im.src = assetUrl(`${this.base}/${file}`);
    });
    const cv = document.createElement("canvas");
    cv.width = P;
    cv.height = P;
    const g = cv.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("no 2d ctx");
    g.drawImage(img, 0, 0, P, P);
    const data = g.getImageData(0, 0, P, P).data;
    const out = new Float32Array(P * P);
    for (let i = 0; i < P * P; i++) {
      const j = i * 4;
      out[i] = decodeElev(data[j], data[j + 1], data[j + 2]);
    }
    return out;
  }

  private buildMesh(tile: Tile, tex: BiomeTextures): void {
    const P = this.P;
    const h = tile.heights!;
    // Exact-size grid so neighbouring tiles BUTT together with no overlap.
    const geo = new THREE.PlaneGeometry(this.S, this.S, SEG, SEG);
    geo.rotateX(-Math.PI / 2); // lie flat: +Z south, +X east
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      // local plane coords: x in [-S/2, S/2] (east), z in [-S/2, S/2] (south)
      const u = pos.getX(i) / this.S + 0.5;
      const v = pos.getZ(i) / this.S + 0.5;
      const fx = Math.min(P - 1, Math.max(0, u * (P - 1)));
      const fy = Math.min(P - 1, Math.max(0, v * (P - 1)));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(P - 1, x0 + 1);
      const y1 = Math.min(P - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      pos.setY(
        i,
        h[y0 * P + x0] * (1 - tx) * (1 - ty) +
          h[y0 * P + x1] * tx * (1 - ty) +
          h[y1 * P + x0] * (1 - tx) * ty +
          h[y1 * P + x1] * tx * ty,
      );
    }
    geo.computeVertexNormals();
    // Per-vertex "colour elevation" = the surface height. The skirt reuses its
    // top-edge height here, so its dropped wall colours like the terrain edge
    // (dry sand on a beach) instead of reading as dark underwater.
    const elev = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) elev[i] = pos.getY(i);
    geo.setAttribute("aElev", new THREE.BufferAttribute(elev, 1));
    const mat = makeBiomeMaterial(tex);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(tile.cx, 0, tile.cz);
    mesh.name = `kauai-${tile.id}`;
    mesh.renderOrder = 0;
    // Downward skirt: a vertical apron hanging SKIRT_M below the tile's edge,
    // sharing the biome material so it fades with the tile and reads as
    // terrain. It plugs any hairline seam where two neighbours' independently
    // sampled edges differ, without ever sticking out horizontally.
    const skirt = new THREE.Mesh(buildSkirtGeometry(geo, SEG, SKIRT_M), mat);
    skirt.name = `kauai-${tile.id}-skirt`;
    mesh.add(skirt);
    tile.mesh = mesh;
    tile.mat = mat;
    this.group.add(mesh);
  }

  private disposeTile(t: Tile): void {
    if (t.mesh) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      for (const c of t.mesh.children) {
        if (c instanceof THREE.Mesh) c.geometry.dispose(); // skirt
      }
    }
    t.mat?.dispose();
    t.mesh = undefined;
    t.mat = undefined;
    t.heights = undefined;
  }

  dispose(): void {
    for (const [, t] of this.tiles) this.disposeTile(t);
    this.tiles.clear();
    this.scene.remove(this.group);
  }
}

/**
 * Build a vertical "skirt" apron around a displaced tile grid: for every edge
 * segment, a quad hanging `drop` metres straight down from the tile's border.
 * Neighbouring tiles butt together at their exact extent; this apron sits just
 * behind the seam and fills any hairline gap where two independently-sampled
 * edges don't line up — without ever protruding horizontally. Positions are in
 * the tile's local space (same as the grid), so it rides as a child mesh.
 */
function buildSkirtGeometry(
  grid: THREE.PlaneGeometry,
  seg: number,
  drop: number,
): THREE.BufferGeometry {
  const p = grid.attributes.position as THREE.BufferAttribute;
  const nrm = grid.attributes.normal as THREE.BufferAttribute;
  const n = seg + 1;
  const vidx = (ix: number, iz: number): number => iz * n + ix;
  const out: number[] = [];
  const nout: number[] = [];
  const eout: number[] = []; // aElev: the top-edge height, so the wall colours
  //                            like the terrain edge, not its dropped position.
  const quad = (ax: number, az: number, bx: number, bz: number): void => {
    const a = vidx(ax, az);
    const b = vidx(bx, bz);
    const axv = p.getX(a), ayv = p.getY(a), azv = p.getZ(a);
    const bxv = p.getX(b), byv = p.getY(b), bzv = p.getZ(b);
    // Shade the skirt with the TERRAIN's edge normals (not the wall's own
    // outward normal) so the apron reads as a continuation of the surface and
    // the seam line disappears instead of catching light as a vertical facet.
    const an = [nrm.getX(a), nrm.getY(a), nrm.getZ(a)];
    const bn = [nrm.getX(b), nrm.getY(b), nrm.getZ(b)];
    out.push(axv, ayv, azv, bxv, byv, bzv, bxv, byv - drop, bzv);
    nout.push(...an, ...bn, ...bn);
    eout.push(ayv, byv, byv); // all three sample their column's edge height
    out.push(axv, ayv, azv, bxv, byv - drop, bzv, axv, ayv - drop, azv);
    nout.push(...an, ...bn, ...an);
    eout.push(ayv, byv, ayv);
  };
  for (let ix = 0; ix < seg; ix++) quad(ix, 0, ix + 1, 0); // north
  for (let ix = 0; ix < seg; ix++) quad(ix, seg, ix + 1, seg); // south
  for (let iz = 0; iz < seg; iz++) quad(0, iz, 0, iz + 1); // west
  for (let iz = 0; iz < seg; iz++) quad(seg, iz, seg, iz + 1); // east
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nout, 3));
  g.setAttribute("aElev", new THREE.Float32BufferAttribute(eout, 1));
  return g;
}

/**
 * Terrain material that auto-paints the real biome ground textures by elevation
 * and slope: sand at the waterline → grass → jungle → rock → mountain → snow on
 * the peaks, with steep faces reading as cliff/rock at any height. Built on
 * MeshStandardMaterial (keeps scene lighting + fog + the cross-fade opacity);
 * the blend is injected via onBeforeCompile. All tiles share one compiled
 * program (customProgramCacheKey) and the same texture set.
 */
function makeBiomeMaterial(tex: BiomeTextures): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide, // skirt walls stay visible regardless of winding
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tSand = { value: tex.sand };
    shader.uniforms.tGrass = { value: tex.grass };
    shader.uniforms.tJungle = { value: tex.jungle };
    shader.uniforms.tRock = { value: tex.rock };
    shader.uniforms.tMtn = { value: tex.mountain };
    shader.uniforms.tSnow = { value: tex.snow };
    shader.uniforms.tReef = { value: tex.reef };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float aElev;\nvarying float vElev;\nvarying vec3 vBiomeW;\nvarying vec3 vBiomeN;",
      )
      .replace(
        "#include <beginnormal_vertex>",
        "#include <beginnormal_vertex>\n  vBiomeN = normalize(mat3(modelMatrix) * objectNormal);",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n  vBiomeW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vElev = aElev;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying float vElev;
varying vec3 vBiomeW;
varying vec3 vBiomeN;
uniform sampler2D tSand, tGrass, tJungle, tRock, tMtn, tSnow, tReef;
float gWet = 0.0; // shoreline wetness (set in map_fragment, used for roughness)
// three uploads sRGB textures with an sRGB internal format on WebGL2, so
// texture2D already returns LINEAR — no manual decode needed.
vec3 s2l(vec3 c) { return c; }
// Cheap world-space value noise (no texture fetch) — used to jitter biome
// band thresholds and to modulate brightness so repeats/contours break up.
// Sinless hash (Dave Hoskins): stays artifact-free at this map's large world
// coordinates, where sin()-based hashes lose precision on mobile GPUs.
float bhash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float bnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bhash(i), bhash(i + vec2(1.0, 0.0)), f.x),
             mix(bhash(i + vec2(0.0, 1.0)), bhash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Anti-repetition tiling: the same texture at two offset scales, blended.
// The second (4.3× larger, irrational-ish ratio) de-phases the repeat grid so
// the pattern stops reading as a checkerboard at distance.
vec3 tile2(sampler2D tex, vec2 uv, float scale) {
  vec3 a = texture2D(tex, uv / scale).rgb;
  vec3 b = texture2D(tex, uv / (scale * 4.3) + vec2(0.37, 0.71)).rgb;
  return mix(a, b, 0.45);
}
// Triplanar sample: blend the three world-axis projections by the surface
// normal so vertical faces tile from the side instead of smearing the
// top-down projection down a cliff.
vec3 triplanar(sampler2D tex, vec3 wp, vec3 n, float scale) {
  vec3 bw = abs(n); bw = pow(bw, vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
  vec3 cx = texture2D(tex, wp.zy / scale).rgb;
  vec3 cy = texture2D(tex, wp.xz / scale).rgb;
  vec3 cz = texture2D(tex, wp.xy / scale).rgb;
  return cx * bw.x + cy * bw.y + cz * bw.z;
}`,
      )
      .replace(
        "#include <map_fragment>",
        `{
  float e = vElev;                              // elevation (m) — skirt uses its edge height
  vec3 nrm = normalize(vBiomeN);                 // varying denormalizes across a triangle
  float slope = 1.0 - clamp(nrm.y, 0.0, 1.0);
  vec2 uv = vBiomeW.xz;                          // world-space tiling (flat areas)
  // Jittered band elevation: two octaves of world noise wobble the biome
  // thresholds ±~45 m so transitions are patchy and organic instead of
  // following exact height contours. Ramped in above the beach so the
  // waterline bands (wet sand / reef, which use the raw e) stay put.
  float jit = bnoise(uv * 0.011) * 0.65 + bnoise(uv * 0.047) * 0.35 - 0.5;
  float ej = e + jit * 90.0 * min(1.0, max(e, 0.0) / 60.0);
  vec3 sand = s2l(tile2(tSand,   uv, 9.0 ));
  vec3 grass= s2l(tile2(tGrass,  uv, 11.0));
  vec3 jung = s2l(tile2(tJungle, uv, 13.0));
  // rock + mountain are what shows on steep faces → triplanar so they tile
  vec3 rock = s2l(triplanar(tRock, vBiomeW, nrm, 18.0));
  vec3 mtn  = s2l(triplanar(tMtn,  vBiomeW, nrm, 22.0));
  vec3 snow = s2l(tile2(tSnow,   uv, 6.0));
  // Lush Kauaʻi bands: dry grass is only a coastal fringe, jungle green owns
  // the lowlands, and bare rock/summit bands sit higher up the mountain.
  vec3 c = sand;
  c = mix(c, grass, smoothstep(2.5, 12.0, ej));
  c = mix(c, jung,  smoothstep(18.0, 90.0, ej));
  c = mix(c, rock,  smoothstep(680.0, 980.0, ej));
  c = mix(c, mtn,   smoothstep(1020.0, 1220.0, ej));
  c = mix(c, snow,  smoothstep(1300.0, 1540.0, ej));
  // Steep faces → cliff rock at ANY elevation (triplanar, so it tiles instead
  // of smearing). No height gate: coastal bluffs and sea cliffs need it most —
  // the old gate left them as vertically-stretched sand stripes.
  float rockAmt = smoothstep(0.30, 0.55, slope);
  c = mix(c, rock, rockAmt);
  // Large-scale brightness variation (two noise octaves, no fetch) breaks the
  // "wallpaper" uniformity of tiled ground seen from altitude.
  c *= 0.90 + 0.20 * (bnoise(uv * 0.0016) * 0.6 + bnoise(uv * 0.0085) * 0.4);
  // Soft shoreline (no hard cut at e=0): the beach dampens to wet sand as it
  // nears the waterline, then the reef/seafloor fades in over a few metres and
  // deepens with depth — the same kind of smoothstep blend as the biome bands.
  // Wet sheen is a BAND at the water's edge, not the whole seabed: it ramps up
  // as the beach nears the waterline, then fades back to matte a few metres
  // under, so the submerged floor doesn't carry a glossy glare.
  gWet = smoothstep(1.4, -0.8, e) * smoothstep(-4.0, -0.8, e);
  c = mix(c, c * 0.66, smoothstep(1.3, 0.0, e)); // wet-sand band
  {
    float d = clamp(-e / 55.0, 0.0, 1.0);
    vec3 reef = s2l(texture2D(tReef, uv / 10.0).rgb);
    vec3 underwater = mix(reef, vec3(0.015, 0.06, 0.10), d * d);
    c = mix(c, underwater, smoothstep(0.3, -3.5, e)); // fade in over ~3.5 m
  }
  diffuseColor.rgb *= c;
}`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.25, gWet); // wet sheen at the shore",
      );
  };
  mat.customProgramCacheKey = () => "kauai-biome";
  return mat;
}
