import * as THREE from "three";
import { assetUrl } from "./assets";

/**
 * Island terrain + water for Chapter 2 (Hanifat). The shape comes from a real
 * MeshyAI heightmap (public/assets/textures/island_height.png) sampled per
 * vertex, with the matching aerial photo draped over it as the ground texture
 * (island_color.jpg). If the heightmap hasn't loaded, everything falls back to
 * the old value-noise beach so the scene never blocks on the asset.
 *
 * World mapping (locked numerically so Jack spawns on the south beach and the
 * volcano rises to the north):
 *   u =  0.5 + x / SPAN
 *   v =  0.5 − (z − CZ) / SPAN     (image top = the volcano summit / north)
 *   height = (grey/255 − SEA) · SCALE
 * −Z is open sea, +Z is inland toward the volcano.
 */

const HM_SPAN = 300; // world units the heightmap spans
const HM_CZ = 122; // world z at the heightmap's vertical centre
const HM_SEA = 0.10; // grey fraction that maps to sea level (y=0)
const HM_SCALE = 58; // world height per grey fraction above sea level
const HM_DEEP = -6; // height returned off the map (open ocean)

/** World Z near the southern waterline (spawn beach); kept for compatibility. */
export const SHORE_Z = -2;
/** Approx world centre of the island (terrain + water are built around this). */
export const ISLAND_CENTER = { x: 0, z: HM_CZ };
/** Height (world units) above which the terrain is bare volcanic rock. */
export const VOLCANO_ROCK_H = 40;

let hmData: Float32Array | null = null;
let hmSize = 0;

/** Load the island heightmap into a grey field sampled by {@link beachHeight}. */
export async function loadIslandHeightmap(url: string): Promise<void> {
  if (hmData) return;
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = img.width;
        const cv = document.createElement("canvas");
        cv.width = size;
        cv.height = size;
        const ctx = cv.getContext("2d");
        if (!ctx) return resolve();
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, size, size).data;
        const g = new Float32Array(size * size);
        for (let i = 0; i < size * size; i++) g[i] = d[i * 4] / 255; // R channel
        hmData = g;
        hmSize = size;
      } catch {
        /* CORS / decode failure — stay on the procedural fallback */
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = assetUrl(url);
  });
}

// ── Deterministic value-noise fbm (procedural fallback only) ──────────────────
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, z: number): number {
  let f = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    f += amp * (vnoise(x * freq, z * freq) * 2 - 1);
    freq *= 2;
    amp *= 0.5;
  }
  return f;
}
function proceduralHeight(x: number, z: number): number {
  const inland = z - -15;
  let h: number;
  if (inland < 0) h = inland * 0.11;
  else h = Math.min(inland, 49) * 0.03 + Math.max(0, inland - 49) * 0.16;
  const dry = Math.max(0, Math.min(1, inland / 16));
  h += fbm(x * 0.018, z * 0.018) * (0.35 + Math.max(0, inland - 49) * 0.05) * dry;
  return h;
}

/** Terrain height at a world XZ (heightmap when loaded, else procedural). */
export function beachHeight(x: number, z: number): number {
  if (hmData) {
    const u = 0.5 + x / HM_SPAN;
    const v = 0.5 - (z - HM_CZ) / HM_SPAN;
    if (u <= 0 || u >= 1 || v <= 0 || v >= 1) return HM_DEEP;
    const fx = u * (hmSize - 1);
    const fy = v * (hmSize - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, hmSize - 1);
    const y1 = Math.min(y0 + 1, hmSize - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const s = (xx: number, yy: number) => hmData![yy * hmSize + xx];
    const n =
      s(x0, y0) * (1 - tx) * (1 - ty) +
      s(x1, y0) * tx * (1 - ty) +
      s(x0, y1) * (1 - tx) * ty +
      s(x1, y1) * tx * ty;
    return (n - HM_SEA) * HM_SCALE;
  }
  return proceduralHeight(x, z);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function mix3(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
/** Biome colour by elevation — the fallback when the aerial texture is absent. */
function beachColor(h: number): number[] {
  const wetsand = [0.45, 0.41, 0.3];
  const sand = [0.72, 0.64, 0.44];
  const coast = [0.34, 0.52, 0.22];
  const jungle = [0.13, 0.34, 0.12];
  const rock = [0.3, 0.29, 0.28];
  let c = mix3(wetsand, sand, smoothstep(-1.5, 1.2, h));
  c = mix3(c, coast, smoothstep(2.5, 8, h));
  c = mix3(c, jungle, smoothstep(11, 26, h));
  c = mix3(c, rock, smoothstep(VOLCANO_ROCK_H, VOLCANO_ROCK_H + 12, h));
  return c;
}

/**
 * Build the island terrain mesh over the heightmap, centred on the island. When
 * `colorMap` is given (the aerial photo) it is draped over the surface; otherwise
 * vertices are coloured by elevation band.
 */
export function buildBeachTerrain(colorMap?: THREE.Texture | null): THREE.Mesh {
  const SIZE = 440;
  const SEG = 288;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2); // into XZ (y up)
  geo.translate(0, 0, HM_CZ); // vertices now hold real world coords
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, beachHeight(x, z));
    // Drape UVs: align the aerial image to the same mapping as the heightmap.
    uv.setXY(i, 0.5 + x / HM_SPAN, 0.5 + (z - HM_CZ) / HM_SPAN);
    const [r, g, b] = beachColor(pos.getY(i));
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geo.computeVertexNormals();
  let mat: THREE.MeshStandardMaterial;
  if (colorMap) {
    colorMap.wrapS = colorMap.wrapT = THREE.ClampToEdgeWrapping;
    mat = new THREE.MeshStandardMaterial({ map: colorMap, roughness: 1, metalness: 0 });
  } else {
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "beach-terrain";
  return mesh;
}

const WATER_VERT = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  varying float vCrest;
  float waves(vec2 p) {
    float h = 0.0;
    h += sin(dot(p, vec2( 0.8, 0.6)) * 0.10 + uTime * 1.1) * 0.24;
    h += sin(dot(p, vec2(-0.4, 0.9)) * 0.16 + uTime * 0.9) * 0.16;
    h += sin(dot(p, vec2( 0.3,-0.7)) * 0.24 + uTime * 1.5) * 0.10;
    h += sin(dot(p, vec2(-0.7, 0.3)) * 0.33 + uTime * 1.8) * 0.06;
    return h;
  }
  void main() {
    vec3 p = position;
    float h = waves(p.xz);
    p.y += h;
    vCrest = clamp(h * 1.4 + 0.5, 0.0, 1.0);
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WATER_FRAG = /* glsl */ `
  uniform vec3 uCamPos;
  varying vec3 vWorld;
  varying float vCrest;
  void main() {
    vec3 deep    = vec3(0.03, 0.12, 0.28);
    vec3 shallow = vec3(0.10, 0.50, 0.52);
    vec3 surf    = vec3(0.62, 0.88, 0.90);
    float dist = length(vWorld.xz - uCamPos.xz);
    float depthT = smoothstep(50.0, 800.0, dist);
    vec3 col = mix(shallow, deep, depthT);
    float foam = smoothstep(0.74, 0.92, vCrest);
    col = mix(col, surf, foam);
    float alpha = mix(0.78, 0.97, depthT);
    alpha = max(alpha, foam);
    gl_FragColor = vec4(col, alpha);
  }
`;

export interface OceanWater {
  mesh: THREE.Mesh;
  uniforms: {
    uTime: { value: number };
    uCamPos: { value: THREE.Vector3 };
  };
}

/** Animated water plane at sea level (y=0), surrounding the island. */
export function buildOceanWater(): OceanWater {
  const uniforms = {
    uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3() },
  };
  const geo = new THREE.PlaneGeometry(2600, 2600, 180, 180);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0, HM_CZ); // centred on the island
  mesh.renderOrder = 1;
  mesh.name = "ocean-water";
  return { mesh, uniforms };
}
