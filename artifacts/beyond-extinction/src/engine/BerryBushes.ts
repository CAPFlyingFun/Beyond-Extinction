import * as THREE from "three";
import { beachHeight, METERS_PER_UNIT } from "./beachTerrain";

/**
 * BerryBushes — cheap procedural forage bushes for the island survival loop.
 *
 * Each bush is a cluster of dark-green flat-shaded blobs with a handful of
 * berry spheres dotted over the foliage. Walking up to a RIPE bush shows the
 * contextual "Forage" button (wired by the scene, mirroring the Feed button);
 * foraging hides the berries and starts a regrow cooldown, after which the
 * berries pop back. Purely set-dressing physics-wise — bushes never collide,
 * so they can sit near story lanes without trapping anyone.
 */

interface Bush {
  group: THREE.Group;
  berries: THREE.Group;
  x: number;
  z: number;
  /** Seconds until the berries regrow; 0 = ripe now. */
  cooldown: number;
}

const REGROW_SECS = 90;
/** Berries handed out per forage. */
export const BERRIES_PER_FORAGE = 3;

export class BerryBushes {
  /** All bushes live under this group (added to the scene by the caller). */
  readonly group = new THREE.Group();

  private readonly bushes: Bush[] = [];
  private readonly leafGeo: THREE.IcosahedronGeometry;
  private readonly leafMat: THREE.MeshStandardMaterial;
  private readonly berryGeo: THREE.SphereGeometry;
  private readonly berryMat: THREE.MeshStandardMaterial;

  constructor() {
    this.group.name = "berry-bushes";
    this.leafGeo = new THREE.IcosahedronGeometry(1, 1);
    this.leafMat = new THREE.MeshStandardMaterial({
      color: 0x2c5b2a,
      roughness: 0.95,
      flatShading: true,
    });
    this.berryGeo = new THREE.SphereGeometry(0.3, 8, 8);
    this.berryMat = new THREE.MeshStandardMaterial({
      color: 0x5a4fcf,
      roughness: 0.35,
      emissive: 0x1a1060,
      emissiveIntensity: 0.35,
    });
  }

  /** Plant a bush at world XZ (terrain height sampled here). */
  add(x: number, z: number, seed = 0): void {
    const g = new THREE.Group();
    const rand = mulberry(seed * 7919 + this.bushes.length * 104729 + 13);

    // Foliage: 4–5 overlapping blobs, ~1.2 m tall in world units.
    const blobCount = 4 + Math.floor(rand() * 2);
    const H = 1.2 / METERS_PER_UNIT; // bush height in units
    for (let i = 0; i < blobCount; i++) {
      const r = H * (0.34 + rand() * 0.22);
      const blob = new THREE.Mesh(this.leafGeo, this.leafMat);
      blob.scale.setScalar(r);
      blob.position.set(
        (rand() - 0.5) * H * 0.9,
        r * 0.8 + rand() * H * 0.35,
        (rand() - 0.5) * H * 0.9,
      );
      blob.castShadow = true;
      g.add(blob);
    }

    // Berries: a dozen small spheres dotted over the canopy, toggled as one.
    const berries = new THREE.Group();
    for (let i = 0; i < 12; i++) {
      const b = new THREE.Mesh(this.berryGeo, this.berryMat);
      const a = rand() * Math.PI * 2;
      const rr = H * (0.35 + rand() * 0.35);
      b.scale.setScalar(0.14 / METERS_PER_UNIT / 0.3); // ~14 cm berries
      b.position.set(
        Math.cos(a) * rr,
        H * (0.45 + rand() * 0.55),
        Math.sin(a) * rr,
      );
      berries.add(b);
    }
    g.add(berries);

    g.position.set(x, beachHeight(x, z), z);
    g.rotation.y = rand() * Math.PI * 2;
    this.group.add(g);
    this.bushes.push({ group: g, berries, x, z, cooldown: 0 });
  }

  /** Tick regrow cooldowns (cheap — a few numbers). */
  update(dt: number): void {
    for (const bush of this.bushes) {
      if (bush.cooldown <= 0) continue;
      bush.cooldown -= dt;
      if (bush.cooldown <= 0) {
        bush.cooldown = 0;
        bush.berries.visible = true;
      }
    }
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

  /** Strip a ripe bush (hides berries, starts regrow). False if not ripe. */
  forage(index: number): boolean {
    const bush = this.bushes[index];
    if (!bush || bush.cooldown > 0) return false;
    bush.cooldown = REGROW_SECS;
    bush.berries.visible = false;
    return true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.leafGeo.dispose();
    this.leafMat.dispose();
    this.berryGeo.dispose();
    this.berryMat.dispose();
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
