import * as THREE from "three";
import { beachHeight, METERS_PER_UNIT } from "./beachTerrain";
import { loadTexture } from "./assets";
import type { LodManager } from "./LodManager";

/**
 * BerryBushes — textured billboard forage bushes for the island survival loop.
 *
 * Each bush is three crossed camera-independent quads (a "star" impostor, so it
 * reads as a 3-D mound from any angle without billboarding) cut from a painted
 * blueberry-bush texture. A RIPE bush shows the berry texture; foraging swaps it
 * to the berry-less "bare" texture and starts a regrow cooldown. Bushes never
 * collide, so they can sit near story lanes without trapping anyone, and they
 * register with the LodManager so they cull with the global draw distance.
 */

interface Bush {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  x: number;
  z: number;
  ripe: boolean;
  /** Seconds until the berries regrow; 0 = ripe now. */
  cooldown: number;
  unregister?: () => void;
}

const REGROW_SECS = 90;
/** Berries handed out per forage. */
export const BERRIES_PER_FORAGE = 3;

export class BerryBushes {
  /** All bushes live under this group (added to the scene by the caller). */
  readonly group = new THREE.Group();

  private readonly bushes: Bush[] = [];
  private readonly quad: THREE.PlaneGeometry;
  private readonly ripeMat: THREE.MeshBasicMaterial;
  private readonly bareMat: THREE.MeshBasicMaterial;

  constructor(private readonly lod?: LodManager) {
    this.group.name = "berry-bushes";
    // Bottom-pivoted unit quad so instance placement plants the base on terrain.
    this.quad = new THREE.PlaneGeometry(1, 1);
    this.quad.translate(0, 0.5, 0);
    const mk = (): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        transparent: false,
        fog: true,
      });
    this.ripeMat = mk();
    this.bareMat = mk();
    // Painted textures (bled to kill black-edge halos, like the trees). Loaded
    // async; the quads exist immediately and get their map when it decodes.
    void this.loadTex("assets/foliage/bush-ripe.png", this.ripeMat);
    void this.loadTex("assets/foliage/bush-bare.png", this.bareMat);
  }

  private async loadTex(rel: string, mat: THREE.MeshBasicMaterial): Promise<void> {
    const tex = await loadTexture(rel);
    if (!tex) return;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    mat.map = tex;
    mat.needsUpdate = true;
  }

  /** Plant a bush at world XZ (terrain height sampled here). */
  add(x: number, z: number, seed = 0): void {
    const g = new THREE.Group();
    const rand = mulberry(seed * 7919 + this.bushes.length * 104729 + 13);

    // Three crossed quads at 60° give volume from any viewing angle.
    const size = (1.25 + rand() * 0.5) / METERS_PER_UNIT; // ~1.25–1.75 m
    const meshes: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(this.quad, this.ripeMat);
      m.scale.set(size, size, 1);
      m.rotation.y = (i / 3) * Math.PI + rand() * 0.3;
      m.castShadow = false; // flat cards cast unconvincing shadows
      meshes.push(m);
      g.add(m);
    }

    g.position.set(x, beachHeight(x, z) - 0.15 / METERS_PER_UNIT, z);
    this.group.add(g);
    const bush: Bush = { group: g, meshes, x, z, ripe: true, cooldown: 0 };
    // Ground detail: cull a touch earlier than the full world range (0.7×).
    bush.unregister = this.lod?.register(g, {
      x,
      z,
      radius: size,
      rangeScale: 0.7,
    });
    this.bushes.push(bush);
  }

  /** Tick regrow cooldowns (cheap — a few numbers). */
  update(dt: number): void {
    for (const bush of this.bushes) {
      if (bush.cooldown <= 0) continue;
      bush.cooldown -= dt;
      if (bush.cooldown <= 0) {
        bush.cooldown = 0;
        this.setRipe(bush, true);
      }
    }
  }

  private setRipe(bush: Bush, ripe: boolean): void {
    if (bush.ripe === ripe) return;
    bush.ripe = ripe;
    const mat = ripe ? this.ripeMat : this.bareMat;
    for (const m of bush.meshes) m.material = mat;
  }

  /** Index of the nearest RIPE bush within `rangeU` world units, or -1. */
  nearestRipe(x: number, z: number, rangeU: number): number {
    let best = -1;
    let bestD = rangeU * rangeU;
    for (let i = 0; i < this.bushes.length; i++) {
      const b = this.bushes[i];
      if (b.cooldown > 0) continue;
      const dx = x - b.x;
      const dz = z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD) {
        bestD = d2;
        best = i;
      }
    }
    return best;
  }

  /** World XZ of bush `index` (objective markers), or null. */
  bushAt(index: number): { x: number; z: number } | null {
    const b = this.bushes[index];
    return b ? { x: b.x, z: b.z } : null;
  }

  /** Strip a ripe bush (swaps to the bare texture, starts regrow). False if not ripe. */
  forage(index: number): boolean {
    const bush = this.bushes[index];
    if (!bush || bush.cooldown > 0) return false;
    bush.cooldown = REGROW_SECS;
    this.setRipe(bush, false);
    return true;
  }

  dispose(): void {
    for (const b of this.bushes) b.unregister?.();
    this.group.removeFromParent();
    this.quad.dispose();
    this.ripeMat.map?.dispose();
    this.bareMat.map?.dispose();
    this.ripeMat.dispose();
    this.bareMat.dispose();
    this.bushes.length = 0;
  }
}

/** Tiny deterministic PRNG so bush shapes are stable across reloads. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
