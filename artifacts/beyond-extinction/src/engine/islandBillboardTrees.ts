import * as THREE from "three";
import { loadTexture } from "./assets";
import {
  beachHeight,
  ISLAND_CENTER,
  VOLCANO_ROCK_H,
  MAP_SCALE,
  HEIGHT_SCALE,
  METERS_PER_UNIT,
} from "./beachTerrain";

/**
 * Billboard (impostor) forest — the mobile-friendly counterpart to islandTrees.
 * Instead of skinned GLB canopies, each tree is a single camera-facing textured
 * quad cut from a photo of the species. A whole stand is one InstancedMesh, and
 * the quads are billboarded + wind-swayed entirely in the vertex shader, so the
 * CPU does nothing per frame but advance a clock and toggle chunk visibility.
 *
 * Why this over real geometry on phones: a quad is 2 triangles vs thousands, and
 * a photo canopy reads better at distance than a low-poly mesh. The trade-off is
 * a cylindrical (Y-only) billboard goes thin when viewed from straight above —
 * fine for a first-person ground camera.
 *
 * Placement reuses islandTrees' deterministic hash grid + elevation bands +
 * per-chunk InstancedMesh (so frustum culling drops forest behind you), so the
 * two systems can be swapped without the forest jumping around.
 */

interface Species {
  file: string;
  /** Target tree height in world units (1 m = 6.4/1.8 u). */
  height: number;
  /** Elevation band (world y). */
  minH: number;
  maxH: number;
  /** Fraction of eligible cells that grow this species inside its band. */
  density: number;
  /** Horizontal crown sway amplitude (world units). */
  sway: number;
}

const M = 6.4 / 1.8; // world units per metre
const S = HEIGHT_SCALE;

// Prehistoric mix keyed to elevation: palms + cycads fringe the beach, ferns
// carpet the low jungle, a few gold deciduous punctuate the mid slopes, conifers
// crown the highland.
const SPECIES: Species[] = [
  // Beach: palms are the sparse landmark (~20%); the smaller plants carpet it
  // (~40-50%). A shore->treeline ramp (below) thins ALL of them right at the
  // water and thickens them toward the tree line.
  { file: "palm", height: 13 * M, minH: 0.25 * S, maxH: 3.5 * S, density: 0.24, sway: 1.4 },
  { file: "cycad", height: 6 * M, minH: 0.3 * S, maxH: 6 * S, density: 0.48, sway: 0.5 },
  { file: "sago", height: 6.5 * M, minH: 0.4 * S, maxH: 6 * S, density: 0.44, sway: 0.5 },
  { file: "fern", height: 4.5 * M, minH: 1 * S, maxH: 9 * S, density: 0.6, sway: 0.8 },
  // Inland / highland: the dense forest proper (unaffected by the shore ramp).
  { file: "aspen", height: 12 * M, minH: 5 * S, maxH: 17 * S, density: 0.44, sway: 1.2 },
  { file: "conifer", height: 14 * M, minH: 12 * S, maxH: VOLCANO_ROCK_H, density: 0.7, sway: 1.3 },
];

/** Smoothstep — smooth 0->1 ramp between edges e0 and e1. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Density multiplier by elevation: ~0 right at the waterline, full by the tree
 *  line (~3× HEIGHT_SCALE up). Keeps the open sand at the shore and thickens the
 *  planting inland, per the "greater chance at the tree line, not the shore" note.
 *  Above the tree line it's 1, so it never thins the inland/highland forest. */
function shoreRamp(h: number): number {
  return smoothstep(0.3 * S, 3 * S, h);
}

// Same stable hash as islandTrees/islandFoliage so stands stay reload-invariant.
function hash(i: number, j: number, salt: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Cylindrical-billboard + wind-sway vertex shader, injected into a basic
 *  (unlit — the photos are already lit) alpha-cutout material. */
function billboardMaterial(
  tex: THREE.Texture,
  sway: number,
  uTime: { value: number },
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
    // ── VERTEX: billboard, wind sway, and per-tree LOD opacity by distance ──
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime, uSway;
        varying float vOpacity;
        // Distance fade (metres → opacity): a smooth linear ramp, full at 0 m
        // to gone at 200 m (i.e. −25% every 50 m). Continuous rather than
        // stepped so it doesn't band as you move. Applied by an ordered dither
        // in the fragment shader, so far trees cost fewer pixels while their
        // silhouette stays readable.
        float treeFade(float m) {
          return clamp(1.0 - m / 200.0, 0.0, 1.0);
        }`,
      )
      .replace(
        "#include <project_vertex>",
        `
        // Instance world base (feet), and the width/height baked into its scale.
        vec3 bbBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float bbW = length(instanceMatrix[0].xyz);
        float bbH = length(instanceMatrix[1].xyz);
        // Horizontal look-at (upright cylindrical billboard).
        vec3 bbToCam = cameraPosition - bbBase; bbToCam.y = 0.0;
        float bbLen = length(bbToCam);
        vec3 bbLook = bbLen > 1e-4 ? bbToCam / bbLen : vec3(0.0, 0.0, 1.0);
        vec3 bbRight = normalize(cross(vec3(0.0, 1.0, 0.0), bbLook));
        // Wind: crown sways more than the base, phased per instance.
        float bbPh = dot(bbBase.xz, vec2(0.031, 0.017));
        float bbBend = position.y * position.y; // position.y in [0,1]
        float bbSway = (sin(uTime * 1.1 + bbPh) + 0.5 * sin(uTime * 2.3 + bbPh * 1.7)) * uSway * bbBend;
        vec3 bbWorld = bbBase
          + bbRight * (position.x * bbW + bbSway)
          + vec3(0.0, position.y * bbH, 0.0);
        vec4 mvPosition = viewMatrix * vec4(bbWorld, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        // LOD opacity from the ground distance to the camera (the player), in m.
        vOpacity = treeFade(bbLen * float(${METERS_PER_UNIT}));
        `,
      );
    // ── FRAGMENT: ordered-dither the LOD opacity (screen-door transparency) ──
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vOpacity;
        // 4×4 ordered Bayer dither in [0,1) — no array indexing (WebGL1/2 safe).
        float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
        float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }`,
      )
      .replace(
        "#include <alphatest_fragment>",
        `#include <alphatest_fragment>
        if (vOpacity < bayer4(gl_FragCoord.xy)) discard;`,
      );
  };
  // All species share one program (identical code; only uniforms differ).
  mat.customProgramCacheKey = () => "island-billboard-tree";
  return mat;
}

export interface IslandTrees {
  group: THREE.Group;
  update(dt: number, camPos: THREE.Vector3): void;
  count: number;
}

/** Chunks past this range don't draw — the draped aerial terrain reads as jungle
 *  at distance, so real billboards only need to fill the near field. */
const TREE_DRAW_DIST = 62 * MAP_SCALE; // ≈ 700 m

export async function loadIslandBillboardTrees(): Promise<IslandTrees> {
  const group = new THREE.Group();
  group.name = "island-billboard-trees";
  const uTime = { value: 0 };

  // Unit quad, pivot at bottom-centre so instance placement plants the base.
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0);

  const loaded = await Promise.all(
    SPECIES.map(async (sp) => {
      const tex = await loadTexture(`assets/trees/${sp.file}.png`);
      if (!tex) return null;
      tex.anisotropy = 4;
      const img = tex.image as { width: number; height: number } | undefined;
      const aspect = img && img.height ? img.width / img.height : 0.6;
      return { mat: billboardMaterial(tex, sp.sway, uTime), width: sp.height * aspect };
    }),
  );

  // ── placement: deterministic grid, species picked by elevation band ─────────
  // Tighter STEP + higher densities => a much fuller forest. Perf holds because
  // each tree is a 2-tri billboard, a whole stand is one InstancedMesh (draw
  // calls scale with CHUNK count, not tree count), and the 200 m LOD dither caps
  // how many pixels the far field can cost.
  const PLANT = MAP_SCALE / 5.2;
  const STEP = 4.5 * PLANT; // ~13 -> 4.5: ~8x denser than the first pass
  const AX = 150 * MAP_SCALE;
  const CX = ISLAND_CENTER.x;
  const CZ = ISLAND_CENTER.z;
  const CHUNK = 18 * MAP_SCALE;
  const buckets: Map<string, THREE.Matrix4[]>[] = SPECIES.map(() => new Map());

  const dummy = new THREE.Object3D();
  let count = 0;
  for (let x = CX - AX; x <= CX + AX; x += STEP) {
    for (let z = CZ - AX; z <= CZ + AX; z += STEP) {
      const i = Math.round(x / STEP);
      const j = Math.round(z / STEP);
      const px = x + (hash(i, j, 21) - 0.5) * STEP * 0.9;
      const pz = z + (hash(i, j, 22) - 0.5) * STEP * 0.9;
      const h = beachHeight(px, pz);
      if (h <= 0) continue; // never plant below the waterline
      const eligible = SPECIES.map((sp, s) => ({ sp, s })).filter(
        ({ sp }) => h >= sp.minH && h <= sp.maxH,
      );
      if (!eligible.length) continue;
      const pick = eligible[Math.floor(hash(i, j, 23) * eligible.length) % eligible.length];
      const baked = loaded[pick.s];
      // Thin the planting toward the shoreline (open sand), thicken it inland.
      if (hash(i, j, 24) > pick.sp.density * shoreRamp(h) || !baked) continue;
      // Feet a hair below ground so trunks never float; slight scale variety.
      const scale = 0.82 + hash(i, j, 28) * 0.42;
      dummy.position.set(px, h - 0.4, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(baked.width * scale, pick.sp.height * scale, 1);
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
      const im = new THREE.InstancedMesh(quad, baked.mat, mats.length);
      mats.forEach((m, k) => im.setMatrixAt(k, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      // The shared unit-quad bounds are tiny; the real extent is the instance
      // spread + the tallest tree. Grow the sphere so culling uses true bounds.
      if (im.boundingSphere) im.boundingSphere.radius += sp.height + sp.sway * 2;
      im.frustumCulled = true;
      im.castShadow = false; // flat billboards cast unconvincing shadows
      im.receiveShadow = false;
      im.name = `bbtrees-${sp.file}-${key}`;
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
