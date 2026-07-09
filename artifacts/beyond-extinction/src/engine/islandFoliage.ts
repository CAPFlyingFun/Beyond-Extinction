import * as THREE from "three";
import { beachHeight, ISLAND_CENTER, VOLCANO_ROCK_H, MAP_SCALE, HEIGHT_SCALE } from "./beachTerrain";

// Foliage scales with the world so the forest looks the same at any MAP_SCALE:
// PLANT is the tree/bush size multiplier (a ~2 m sapling becomes a believable
// jungle tree on the big island); spacing and the beach-clearance band scale to
// match, keeping the tree COUNT and density roughly constant.
const PLANT = MAP_SCALE / 5.2; // ≈ 8 at the shipping scale → ~15 m trees

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
  /** Lowest terrain height (world units) a big tree may grow at — keeps the
   *  immediate beach open. Above VOLCANO_ROCK_H stays bare (the caldera). */
  treeMinHeight?: number;
  /** How much of the eligible land grows a tree (0..1). */
  treeDensity?: number;
  /** Half-extent the foliage covers around the island centre. */
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

/**
 * Build the island's trees + bushes as instanced meshes on the terrain. Returns
 * a group the scene adds; dispose by traversing (geometries/materials) as usual.
 * Placement is elevation-based (works with the real heightmap): trees fill the
 * land between the beach and the bare volcanic rock; bushes reach nearer the shore.
 */
export function buildIslandFoliage(opts: FoliageOptions = {}): THREE.Group {
  const treeMin = opts.treeMinHeight ?? 2.5 * HEIGHT_SCALE;
  const density = opts.treeDensity ?? 0.5;
  const AX = opts.areaX ?? 145 * MAP_SCALE; // cover the whole island by default
  const AZ = opts.areaZ ?? 145 * MAP_SCALE;
  const CX = ISLAND_CENTER.x;
  const CZ = ISLAND_CENTER.z;

  const group = new THREE.Group();
  group.name = "island-foliage";

  const trees: { m: THREE.Matrix4; tint: THREE.Color; palm: boolean }[] = [];
  const bushes: { m: THREE.Matrix4; tint: THREE.Color }[] = [];

  const TREE_STEP = 11 * PLANT; // spacing scales with tree size → constant density
  const dummy = new THREE.Object3D();
  for (let x = CX - AX; x <= CX + AX; x += TREE_STEP) {
    for (let z = CZ - AZ; z <= CZ + AZ; z += TREE_STEP) {
      const i = Math.round(x / TREE_STEP);
      const j = Math.round(z / TREE_STEP);
      if (hash(i, j, 1) > density) continue; // thin out by density
      const px = x + (hash(i, j, 2) - 0.5) * TREE_STEP * 0.9;
      const pz = z + (hash(i, j, 3) - 0.5) * TREE_STEP * 0.9;
      const h = beachHeight(px, pz);
      if (h < treeMin || h > VOLCANO_ROCK_H) continue; // off beach, off bare rock
      const scale = (0.8 + hash(i, j, 4) * 0.9) * PLANT;
      const palm = hash(i, j, 5) > 0.5;
      dummy.position.set(px, h, pz);
      dummy.rotation.set(0, hash(i, j, 6) * Math.PI * 2, (hash(i, j, 7) - 0.5) * 0.14);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      const tint = new THREE.Color().setHSL(0.28 + hash(i, j, 8) * 0.08, 0.5, 0.28 + hash(i, j, 9) * 0.12);
      trees.push({ m: dummy.matrix.clone(), tint, palm });
    }
  }

  const BUSH_STEP = 7 * PLANT;
  for (let x = CX - AX; x <= CX + AX; x += BUSH_STEP) {
    for (let z = CZ - AZ; z <= CZ + AZ; z += BUSH_STEP) {
      const i = Math.round(x / BUSH_STEP);
      const j = Math.round(z / BUSH_STEP);
      if (hash(i, j, 11) > 0.32) continue;
      const px = x + (hash(i, j, 12) - 0.5) * BUSH_STEP;
      const pz = z + (hash(i, j, 13) - 0.5) * BUSH_STEP;
      const h = beachHeight(px, pz);
      if (h < 0.5 * HEIGHT_SCALE || h > VOLCANO_ROCK_H + 8 * HEIGHT_SCALE) continue;
      const scale = (0.7 + hash(i, j, 14) * 1.1) * PLANT;
      dummy.position.set(px, h, pz);
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
