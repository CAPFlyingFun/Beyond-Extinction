import * as THREE from "three";
import { assetUrl } from "./assets";

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

/** Terrarium RGB → metres. Ocean/nodata reads huge-negative → clamp to sea. */
function decodeElev(r: number, g: number, b: number): number {
  const e = r * 256 + g + b / 256 - 32768;
  return e < -20 ? 0 : Math.max(0, e);
}

const SEG = 96; // grid resolution per tile (97² verts ≈ 9.4k)
const FADE_PER_SEC = 1 / 0.6; // ~0.6 s cross-fade
const SUN = new THREE.Vector3(-0.55, 0.72, 0.42).normalize();

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

  /** True once the tile the player is standing in has its heights decoded. */
  get currentReady(): boolean {
    const t = this.tiles.get(`${this.colOf(0) + 0},${this.rowOf(0)}`);
    return !!t?.heights;
  }
  tileReadyAt(x: number, z: number): boolean {
    return !!this.tiles.get(`${this.colOf(x)},${this.rowOf(z)}`)?.heights;
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
    // player may have moved away while decoding
    if (this.tiles.get(key) !== tile) return;
    tile.heights = heights;
    this.buildMesh(tile);
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

  private buildMesh(tile: Tile): void {
    const P = this.P;
    const h = tile.heights!;
    const geo = new THREE.PlaneGeometry(this.S, this.S, SEG, SEG);
    geo.rotateX(-Math.PI / 2); // lie flat: +Z south, +X east
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    const sampleH = (u: number, v: number): number => {
      const fx = Math.min(P - 1, Math.max(0, u * (P - 1)));
      const fy = Math.min(P - 1, Math.max(0, v * (P - 1)));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(P - 1, x0 + 1);
      const y1 = Math.min(P - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      return (
        h[y0 * P + x0] * (1 - tx) * (1 - ty) +
        h[y0 * P + x1] * tx * (1 - ty) +
        h[y1 * P + x0] * (1 - tx) * ty +
        h[y1 * P + x1] * tx * ty
      );
    };
    for (let i = 0; i < pos.count; i++) {
      // local plane coords: x in [-S/2, S/2] (east), z in [-S/2, S/2] (south)
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const u = lx / this.S + 0.5;
      const v = lz / this.S + 0.5;
      const y = sampleH(u, v);
      pos.setY(i, y);
      // biome ramp by elevation (sand→grass→forest→rock→snow)
      const t = Math.min(1, y / 1575);
      if (y <= 0.5) col.setRGB(0.82, 0.76, 0.55);
      else if (t < 0.14) col.setRGB(0.55, 0.62, 0.34);
      else if (t < 0.4) col.setRGB(0.24, 0.44, 0.24);
      else if (t < 0.7) col.setRGB(0.42, 0.38, 0.3);
      else col.setRGB(0.92, 0.94, 0.96);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(tile.cx, 0, tile.cz);
    mesh.name = `kauai-${tile.id}`;
    mesh.renderOrder = 0;
    tile.mesh = mesh;
    tile.mat = mat;
    this.group.add(mesh);
  }

  private disposeTile(t: Tile): void {
    if (t.mesh) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
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
