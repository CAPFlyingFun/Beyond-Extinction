import * as THREE from "three";
import { loadModel } from "./assets";
import {
  beachHeight,
  ISLAND_CENTER,
  VOLCANO_ROCK_H,
  MAP_SCALE,
  HEIGHT_SCALE,
} from "./beachTerrain";

/**
 * Real tree models scattered over the island by elevation band — the five
 * Meshy species replacing the low-poly placeholder trees:
 *
 *   beach fringe   → coconut palm
 *   low jungle     → giant tree fern
 *   mid jungle     → banyan / strangler fig
 *   dense jungle   → monkey puzzle
 *   highland       → wind-swept conifer
 *
 * Rendering: the GLBs arrive as ~2-7k-tri skinned meshes (rigged but with no
 * baked clips). Skinning hundreds of trees is a mobile non-starter, so each
 * species is baked to a static geometry and drawn with InstancedMesh — but
 * split into a grid of CHUNKS so THREE's frustum culling can drop the forest
 * behind the camera (a single InstancedMesh always draws every instance).
 * Wind sway is a cheap vertex-shader bend with a per-instance phase, which
 * reads just like the rigged sway would at a fraction of the cost.
 *
 * Placement uses the same deterministic hash grid as islandFoliage, so the
 * forest is randomised but stable across reloads.
 */

interface Species {
  file: string;
  /** Target tree height in world units (1 m = 6.4/1.8 u). */
  height: number;
  /** Elevation band (world y, fractions of HEIGHT_SCALE applied below). */
  minH: number;
  maxH: number;
  /** Fraction of eligible cells that grow this species inside its band. */
  density: number;
  /** Sway amplitude in world units at the crown. */
  sway: number;
}

const M = 6.4 / 1.8; // world units per metre
const S = HEIGHT_SCALE;

const SPECIES: Species[] = [
  { file: "palm", height: 12 * M, minH: 0.4 * S, maxH: 3 * S, density: 0.32, sway: 1.6 },
  { file: "fern", height: 7 * M, minH: 2.5 * S, maxH: 7 * S, density: 0.4, sway: 0.9 },
  { file: "banyan", height: 15 * M, minH: 6 * S, maxH: 14 * S, density: 0.3, sway: 0.7 },
  { file: "monkeypuzzle", height: 14 * M, minH: 12 * S, maxH: 30 * S, density: 0.38, sway: 1.0 },
  { file: "conifer", height: 8 * M, minH: 26 * S, maxH: VOLCANO_ROCK_H, density: 0.35, sway: 1.3 },
];

// Same stable hash as islandFoliage so densities stay reload-invariant.
function hash(i: number, j: number, salt: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Bake a loaded GLB into a ground-origin static geometry + swaying material. */
function bakeSpecies(
  root: THREE.Object3D,
  sp: Species,
  uTime: { value: number },
): { geo: THREE.BufferGeometry; mat: THREE.Material } | null {
  let src: THREE.Mesh | null = null;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!src && (o as THREE.Mesh).isMesh) src = o as THREE.Mesh;
  });
  if (!src) return null;
  const mesh = src as THREE.Mesh;
  const geo = mesh.geometry.clone();
  // Static instancing: the rig is unused (no clips shipped), drop its weight.
  geo.deleteAttribute("skinIndex");
  geo.deleteAttribute("skinWeight");
  geo.applyMatrix4(mesh.matrixWorld);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const size = new THREE.Vector3();
  bb.getSize(size);
  const c = new THREE.Vector3();
  bb.getCenter(c);
  // Feet on the ground at the local origin, sized to the species height.
  geo.translate(-c.x, -bb.min.y, -c.z);
  const k = sp.height / Math.max(size.y, 1e-6);
  geo.scale(k, k, k);
  geo.computeBoundingSphere();

  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).clone();
  // Wind sway: bend grows quadratically up the trunk, phased per instance from
  // its world position so the forest doesn't wave in lockstep.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uHeight = { value: sp.height };
    shader.uniforms.uSway = { value: sp.sway };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uTime, uHeight, uSway;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          float ph = dot(instanceMatrix[3].xz, vec2(0.031, 0.017));
          float bendN = clamp(transformed.y / uHeight, 0.0, 1.0);
          float w = sin(uTime * 1.1 + ph) + 0.5 * sin(uTime * 2.3 + ph * 1.7);
          float sway = w * uSway * bendN * bendN;
          transformed.x += sway;
          transformed.z += sway * 0.6;
        }`,
      );
  };
  mat.customProgramCacheKey = () => `island-tree-${sp.file}`;
  return { geo, mat };
}

export interface IslandTrees {
  group: THREE.Group;
  /** Advance the wind + distance-cull chunks. Call once per frame. */
  update(dt: number, camPos: THREE.Vector3): void;
  /** Total placed trees (for dev logging). */
  count: number;
}

/** Tree chunks beyond this range don't draw at all — the terrain's draped
 *  aerial photo reads as jungle at distance, so the canopy only needs real
 *  geometry near the player. Facing inland the frustum otherwise contains
 *  most of the island (~13M tris); this cap keeps it ~1-2M. */
const TREE_DRAW_DIST = 62 * MAP_SCALE; // ≈ 700 m

export async function loadIslandTrees(): Promise<IslandTrees> {
  const group = new THREE.Group();
  group.name = "island-trees";
  const uTime = { value: 0 };

  const loaded = await Promise.all(
    SPECIES.map((sp) =>
      loadModel(`assets/models/trees/${sp.file}.glb`, () => new THREE.Group()).then(
        (root) => bakeSpecies(root, sp, uTime),
      ),
    ),
  );

  // ── placement: one deterministic grid, species picked by elevation band ────
  const PLANT = MAP_SCALE / 5.2; // same world-size scaling as islandFoliage
  const STEP = 13 * PLANT;
  const AX = 150 * MAP_SCALE;
  const CX = ISLAND_CENTER.x;
  const CZ = ISLAND_CENTER.z;
  // Chunked instancing: per-chunk bounding spheres let frustum culling drop
  // whole stands of forest behind the camera.
  const CHUNK = 40 * MAP_SCALE;
  type Bucket = Map<string, THREE.Matrix4[]>;
  const buckets: Bucket[] = SPECIES.map(() => new Map());

  const dummy = new THREE.Object3D();
  let count = 0;
  for (let x = CX - AX; x <= CX + AX; x += STEP) {
    for (let z = CZ - AX; z <= CZ + AX; z += STEP) {
      const i = Math.round(x / STEP);
      const j = Math.round(z / STEP);
      const px = x + (hash(i, j, 21) - 0.5) * STEP * 0.9;
      const pz = z + (hash(i, j, 22) - 0.5) * STEP * 0.9;
      const h = beachHeight(px, pz);
      // Species whose band contains this elevation; hash picks among overlaps.
      const eligible = SPECIES.map((sp, s) => ({ sp, s })).filter(
        ({ sp }) => h >= sp.minH && h <= sp.maxH,
      );
      if (!eligible.length) continue;
      const pick = eligible[Math.floor(hash(i, j, 23) * eligible.length) % eligible.length];
      if (hash(i, j, 24) > pick.sp.density || !loaded[pick.s]) continue;
      dummy.position.set(px, h - 0.4, pz); // sink a hair so roots never float
      dummy.rotation.set(
        (hash(i, j, 26) - 0.5) * 0.1,
        hash(i, j, 25) * Math.PI * 2,
        (hash(i, j, 27) - 0.5) * 0.1,
      );
      dummy.scale.setScalar(0.8 + hash(i, j, 28) * 0.5);
      dummy.updateMatrix();
      const key = `${Math.floor(px / CHUNK)}:${Math.floor(pz / CHUNK)}`;
      const bucket = buckets[pick.s];
      (bucket.get(key) ?? bucket.set(key, []).get(key)!).push(dummy.matrix.clone());
      count++;
    }
  }

  const chunks: { im: THREE.InstancedMesh; center: THREE.Vector3 }[] = [];
  SPECIES.forEach((sp, s) => {
    const baked = loaded[s];
    if (!baked) return;
    for (const [key, mats] of buckets[s]) {
      const im = new THREE.InstancedMesh(baked.geo, baked.mat, mats.length);
      mats.forEach((m, k) => im.setMatrixAt(k, m));
      im.instanceMatrix.needsUpdate = true;
      // Exact per-chunk bounds from the instance matrices — the shared
      // geometry's bounds alone would cull the whole stand wrongly. Grow it a
      // touch so wind sway never pops a chunk at the frustum edge.
      im.computeBoundingSphere();
      if (im.boundingSphere) im.boundingSphere.radius += sp.sway * 2;
      im.frustumCulled = true;
      im.castShadow = true;
      im.receiveShadow = false;
      im.name = `trees-${sp.file}-${key}`;
      group.add(im);
      chunks.push({ im, center: im.boundingSphere!.center.clone() });
    }
  });

  return {
    group,
    count,
    update(dt: number, camPos: THREE.Vector3) {
      uTime.value += dt;
      for (const c of chunks) {
        const dx = c.center.x - camPos.x;
        const dz = c.center.z - camPos.z;
        c.im.visible = dx * dx + dz * dz < TREE_DRAW_DIST * TREE_DRAW_DIST;
      }
    },
  };
}
