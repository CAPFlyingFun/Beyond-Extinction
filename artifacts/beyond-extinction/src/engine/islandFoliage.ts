import * as THREE from "three";
import { beachHeight, SHORE_Z } from "./beachTerrain";

/**
 * Procedural island vegetation — coded trees + bushes scattered over the beach
 * terrain, a placeholder for real tree models later. Everything is InstancedMesh
 * so hundreds of plants cost a handful of draw calls (mobile-friendly).
 *
 * Placement rules (per the design):
 *  - LARGE trees only beyond a shore-clearance band (the first ~30 m of beach by
 *    the water stays open), and never over water.
 *  - Bushes/small plants anywhere on land that isn't right at the waterline.
 *  - Density comes from a deterministic jittered grid (hash-based), so the forest
 *    is randomised but STABLE across reloads rather than reshuffling each time.
 */

export interface FoliageOptions {
  /** Inland distance (world units past the shoreline) kept clear of big trees. */
  treeClearance?: number;
  /** How much of the land area grows a tree (0..1). */
  treeDensity?: number;
  /** Half-extent (x) and inland reach (z) the foliage covers. */
  areaX?: number;
  areaZ?: number;
  /** Optional bark/wood texture for the trunks (placeholder until real models). */
  trunkMap?: THREE.Texture | null;
}

// ── deterministic hash (stable per grid cell) ────────────────────────────────
function hash(i: number, j: number, salt: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s); // 0..1
}

/** True where a plant may grow: on land, above the water line. */
function onLand(x: number, z: number): boolean {
  return beachHeight(x, z) > 0.15;
}

/**
 * Build the island's trees + bushes as instanced meshes on the terrain. Returns
 * a group the scene adds; dispose by traversing (geometries/materials) as usual.
 */
export function buildIslandFoliage(opts: FoliageOptions = {}): THREE.Group {
  const clearance = opts.treeClearance ?? 30;
  const density = opts.treeDensity ?? 0.55;
  const AX = opts.areaX ?? 190;
  const AZ = opts.areaZ ?? 230;

  const group = new THREE.Group();
  group.name = "island-foliage";

  // Gather tree + bush transforms first so the InstancedMeshes are sized exactly.
  const trees: { m: THREE.Matrix4; tint: THREE.Color; palm: boolean }[] = [];
  const bushes: { m: THREE.Matrix4; tint: THREE.Color }[] = [];

  const TREE_STEP = 11;
  const dummy = new THREE.Object3D();
  for (let x = -AX; x <= AX; x += TREE_STEP) {
    for (let z = -10; z <= AZ; z += TREE_STEP) {
      const i = Math.round(x / TREE_STEP);
      const j = Math.round(z / TREE_STEP);
      if (hash(i, j, 1) > density) continue; // thin out by density
      const px = x + (hash(i, j, 2) - 0.5) * TREE_STEP * 0.9;
      const pz = z + (hash(i, j, 3) - 0.5) * TREE_STEP * 0.9;
      const inland = pz - SHORE_Z;
      if (inland < clearance) continue; // keep the shore open of big trees
      if (!onLand(px, pz)) continue; // never in the water
      const py = beachHeight(px, pz);
      const scale = 0.8 + hash(i, j, 4) * 0.9;
      const palm = hash(i, j, 5) > 0.5;
      dummy.position.set(px, py, pz);
      dummy.rotation.set(0, hash(i, j, 6) * Math.PI * 2, (hash(i, j, 7) - 0.5) * 0.14);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      const tint = new THREE.Color().setHSL(0.28 + hash(i, j, 8) * 0.08, 0.5, 0.28 + hash(i, j, 9) * 0.12);
      trees.push({ m: dummy.matrix.clone(), tint, palm });
    }
  }

  const BUSH_STEP = 7;
  for (let x = -AX; x <= AX; x += BUSH_STEP) {
    for (let z = -8; z <= AZ; z += BUSH_STEP) {
      const i = Math.round(x / BUSH_STEP);
      const j = Math.round(z / BUSH_STEP);
      if (hash(i, j, 11) > 0.35) continue;
      const px = x + (hash(i, j, 12) - 0.5) * BUSH_STEP;
      const pz = z + (hash(i, j, 13) - 0.5) * BUSH_STEP;
      if (!onLand(px, pz)) continue;
      const py = beachHeight(px, pz);
      const scale = 0.7 + hash(i, j, 14) * 1.1;
      dummy.position.set(px, py, pz);
      dummy.rotation.set(0, hash(i, j, 15) * Math.PI * 2, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      const tint = new THREE.Color().setHSL(0.27 + hash(i, j, 16) * 0.1, 0.55, 0.26 + hash(i, j, 17) * 0.12);
      bushes.push({ m: dummy.matrix.clone(), tint });
    }
  }

  // ── Trees: instanced trunk + two instanced canopy layers ───────────────────
  if (trees.length) {
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.5, 7, 8);
    trunkGeo.translate(0, 3.5, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 1 });
    if (opts.trunkMap) {
      const map = opts.trunkMap;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      // The walnut grain runs horizontally in the image; rotate it 90° so it
      // runs UP the trunk, and tile a couple times along the height.
      map.center.set(0.5, 0.5);
      map.rotation = Math.PI / 2;
      map.repeat.set(1, 2);
      trunkMat.map = map;
      trunkMat.color.set(0xffffff);
    }
    const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);

    const lowGeo = new THREE.IcosahedronGeometry(3.2, 0);
    lowGeo.scale(1, 0.8, 1);
    lowGeo.translate(0, 8, 0);
    const highGeo = new THREE.IcosahedronGeometry(2.2, 0);
    highGeo.translate(0, 11, 0);
    const canopyMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
    const canopyLow = new THREE.InstancedMesh(lowGeo, canopyMat, trees.length);
    const canopyHigh = new THREE.InstancedMesh(highGeo, canopyMat, trees.length);

    trees.forEach((t, k) => {
      trunk.setMatrixAt(k, t.m);
      canopyLow.setMatrixAt(k, t.m);
      canopyHigh.setMatrixAt(k, t.m);
      canopyLow.setColorAt(k, t.tint);
      canopyHigh.setColorAt(k, t.tint.clone().offsetHSL(0, 0, 0.05));
    });
    trunk.castShadow = true;
    canopyLow.castShadow = true;
    group.add(trunk, canopyLow, canopyHigh);
  }

  // ── Bushes: one instanced blob ─────────────────────────────────────────────
  if (bushes.length) {
    const bushGeo = new THREE.IcosahedronGeometry(1.1, 1);
    bushGeo.scale(1, 0.75, 1);
    bushGeo.translate(0, 0.7, 0);
    const bushMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
    const bush = new THREE.InstancedMesh(bushGeo, bushMat, bushes.length);
    bushes.forEach((b, k) => {
      bush.setMatrixAt(k, b.m);
      bush.setColorAt(k, b.tint);
    });
    bush.castShadow = true;
    group.add(bush);
  }

  return group;
}
