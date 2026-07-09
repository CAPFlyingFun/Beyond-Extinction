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

/** The nine real photographic ground textures (from the "8 ground textures"
 *  release + the volcano lava rock), keyed by biome. */
export interface IslandGround {
  reef: THREE.Texture; // shallow submerged floor
  sand: THREE.Texture; // tropical beach
  grass: THREE.Texture; // open plains
  jungle: THREE.Texture; // dense jungle floor
  dirt: THREE.Texture; // forest dirt path (patchy in jungle)
  swamp: THREE.Texture; // swamp mud (patchy in low wetlands)
  mountain: THREE.Texture; // rocky mountain ground
  cliff: THREE.Texture; // coastal cliff rock (steep faces)
  volcano: THREE.Texture; // volcanic lava rock (caldera)
}

let groundCache: IslandGround | null = null;

/** Load the nine tiling ground textures once and cache them. */
export async function loadIslandGround(): Promise<IslandGround> {
  if (groundCache) return groundCache;
  const loader = new THREE.TextureLoader();
  const load = (name: string) =>
    new Promise<THREE.Texture>((resolve) => {
      loader.load(
        assetUrl(`assets/textures/${name}.jpg`),
        (t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          resolve(t);
        },
        undefined,
        () => resolve(new THREE.Texture()),
      );
    });
  const names = ["reef", "sand", "grass", "jungle", "dirt", "swamp", "mountain", "cliff", "volcano"];
  const [reef, sand, grass, jungle, dirt, swamp, mountain, cliff, volcano] = await Promise.all(
    names.map(load),
  );
  groundCache = { reef, sand, grass, jungle, dirt, swamp, mountain, cliff, volcano };
  return groundCache;
}

/**
 * Terrain material that paints the nine real photographic ground textures,
 * blended into biome bands by elevation (reef → sand → grass → jungle →
 * mountain → volcanic caldera) with patchy swamp/dirt in the low/mid bands and
 * triplanar coastal-cliff rock on steep faces so slopes don't smear. The aerial
 * photo is a faint low-freq macro tint so the big picture still matches the
 * render. Built on MeshStandardMaterial (via onBeforeCompile) so it keeps real
 * lighting + shadows.
 */
function makeTerrainMaterial(aerial: THREE.Texture, g: IslandGround): THREE.MeshStandardMaterial {
  aerial.wrapS = aerial.wrapT = THREE.ClampToEdgeWrapping;
  aerial.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uReef = { value: g.reef };
    shader.uniforms.uSand = { value: g.sand };
    shader.uniforms.uGrass = { value: g.grass };
    shader.uniforms.uJungle = { value: g.jungle };
    shader.uniforms.uDirt = { value: g.dirt };
    shader.uniforms.uSwamp = { value: g.swamp };
    shader.uniforms.uMountain = { value: g.mountain };
    shader.uniforms.uCliff = { value: g.cliff };
    shader.uniforms.uVolcano = { value: g.volcano };
    shader.uniforms.uAerial = { value: aerial };
    shader.uniforms.uDetail = { value: 0.09 }; // world→uv freq (~11u per tile)
    shader.uniforms.uSpan = { value: HM_SPAN };
    shader.uniforms.uCz = { value: HM_CZ };
    shader.uniforms.uRockH = { value: VOLCANO_ROCK_H };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWXZ;\nvarying vec3 vWN;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n  vWXZ = (modelMatrix * vec4(transformed,1.0)).xyz;\n  vWN = normalize(mat3(modelMatrix) * normal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vWXZ; varying vec3 vWN;
         uniform sampler2D uReef, uSand, uGrass, uJungle, uDirt, uSwamp, uMountain, uCliff, uVolcano, uAerial;
         uniform float uDetail, uSpan, uCz, uRockH;
         float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
         float vnoise(vec2 p){
           vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
           float a=hash21(i), b=hash21(i+vec2(1.0,0.0)), c=hash21(i+vec2(0.0,1.0)), d=hash21(i+vec2(1.0,1.0));
           return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
         }`,
      )
      .replace(
        "#include <map_fragment>",
        `float h = vWXZ.y;
         vec2 uvp = vWXZ.xz * uDetail;                 // planar (XZ) tiling coords
         vec3 reef   = texture2D(uReef, uvp).rgb;
         vec3 sand   = texture2D(uSand, uvp).rgb;
         vec3 grass  = texture2D(uGrass, uvp).rgb;
         vec3 jungle = texture2D(uJungle, uvp).rgb;
         vec3 dirt   = texture2D(uDirt, uvp).rgb;
         vec3 swamp  = texture2D(uSwamp, uvp).rgb;
         vec3 mtn    = texture2D(uMountain, uvp).rgb;
         vec3 volc   = texture2D(uVolcano, uvp).rgb;
         // Coastal cliff triplanar so steep faces don't smear.
         vec3 bw = abs(vWN); bw = pow(bw, vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
         vec3 pw = vWXZ * uDetail;
         vec3 cliff = texture2D(uCliff, pw.zy).rgb * bw.x + texture2D(uCliff, pw.xz).rgb * bw.y + texture2D(uCliff, pw.xy).rgb * bw.z;
         // Elevation bands, low -> high.
         vec3 col = reef;
         col = mix(col, sand,   smoothstep(-1.6, 0.2, h));
         col = mix(col, grass,  smoothstep(1.6, 4.6, h));
         col = mix(col, jungle, smoothstep(8.0, 16.0, h));
         col = mix(col, mtn,    smoothstep(22.0, 34.0, h));
         col = mix(col, volc,   smoothstep(uRockH + 1.0, uRockH + 12.0, h));
         // Patchy swamp mud in the low, flat wetlands near the water.
         float nS = vnoise(vWXZ.xz * 0.035);
         float swampM = smoothstep(-0.5, 1.5, h) * (1.0 - smoothstep(3.5, 6.5, h)) * smoothstep(0.45, 0.75, nS);
         col = mix(col, swamp, swampM * 0.75);
         // Patchy dirt trails through the jungle band.
         float nD = vnoise(vWXZ.xz * 0.05 + 13.0);
         float dirtM = smoothstep(6.5, 10.0, h) * (1.0 - smoothstep(17.0, 21.0, h)) * smoothstep(0.55, 0.8, nD);
         col = mix(col, dirt, dirtM * 0.65);
         // Steep slopes -> coastal cliff rock (overlays every band).
         float slope = 1.0 - clamp(vWN.y, 0.0, 1.0);
         col = mix(col, cliff, smoothstep(0.34, 0.6, slope));
         // Faint aerial macro tint so the island's big-picture colour still reads.
         vec2 auv = vec2(0.5 + vWXZ.x / uSpan, 0.5 + (vWXZ.z - uCz) / uSpan);
         vec3 macro = texture2D(uAerial, auv).rgb;
         diffuseColor.rgb *= col * (0.82 + 0.36 * macro);`,
      );
  };
  mat.customProgramCacheKey = () => "island-terrain";
  return mat;
}

/**
 * Build the island terrain mesh over the heightmap, centred on the island. When
 * both `colorMap` (the aerial photo) and `ground` (the nine tiling textures) are
 * given, the ground is painted with real photographic biome textures blended by
 * elevation + slope and faintly tinted by the aerial; otherwise vertices are
 * coloured by elevation band.
 */
export function buildBeachTerrain(
  colorMap?: THREE.Texture | null,
  ground?: IslandGround | null,
): THREE.Mesh {
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
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat =
    colorMap && ground
      ? makeTerrainMaterial(colorMap, ground)
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
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
