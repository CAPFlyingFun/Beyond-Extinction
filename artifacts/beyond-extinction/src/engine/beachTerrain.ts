import * as THREE from "three";
import { assetUrl } from "./assets";
import { TerrainEdit } from "./TerrainEdit";

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

/**
 * World scale. The MeshyAI island is authored tiny (~76 m across, ~15 m tall).
 * The Godot build ships Hanifat at 8192 m across (2048 px heightmap at 4 m/px —
 * "comparable to ARK: The Island", per its generator) with a 350 m volcano.
 * Jack is a fixed size (~1.8 m ≈ 0.28125 m per world unit), so we blow the
 * terrain up in world units. Horizontal and vertical scales differ so we hit
 * BOTH the width (8192 m) and the height (350 m) targets; the same 350 m spread
 * over the wider island also makes every slope ~2.6× gentler than the old
 * ~3.1 km version — the "huge map with gentle slopes" feel of the Godot build.
 */
export const MAP_SCALE = 8192 / 84.375; // horizontal — island = 8192 m across (84.375 = 300 map-units × 0.28125 m/u)
export const HEIGHT_SCALE = 24; // vertical — volcano ≈ 350 m tall (Godot parity)

const HM_SPAN = 300 * MAP_SCALE; // world units the heightmap spans
const HM_CZ = 122 * MAP_SCALE; // world z at the heightmap's vertical centre
const HM_SEA = 0.1; // grey fraction that maps to sea level (y=0)
const HM_SCALE = 58 * HEIGHT_SCALE; // world height per grey fraction above sea level
const HM_DEEP = -6 * HEIGHT_SCALE; // height returned off the map (open ocean)
// Coastal-apron shaping: a power curve on the height-above-sea. >1 flattens the
// low band into a wide, gentle beach → jungle slope (no steep wall behind the
// spawn) while keeping the summit, matching the topographic profile. 1.0 = raw.
const HM_APRON = 1.8;
const HM_MAXH = (1 - HM_SEA) * HM_SCALE; // world height at full-white grey (summit)

/** World Z near the southern waterline (spawn beach); kept for compatibility. */
export const SHORE_Z = -2 * MAP_SCALE;
/** Approx world centre of the island (terrain + water are built around this). */
export const ISLAND_CENTER = { x: 0, z: HM_CZ };
/** Height (world units) above which the terrain is bare volcanic rock.
 *  Godot parity: crags/volcano rock begins at ~250 m (island_biomes.gd). */
export const VOLCANO_ROCK_H = 37 * HEIGHT_SCALE; // 888 u ≈ 250 m

/** Real-world metres per world unit (Jack is 6.4 u ≈ 1.8 m tall). */
export const METERS_PER_UNIT = 1.8 / 6.4;

/**
 * Landing-zone flatten (Godot parity: island_terrain.gd LANDING_*): the
 * arrival beach is perfectly flat within 55 m of the default spawn at 4 m
 * above sea level, feathered back into the natural terrain by 200 m — so
 * Jack & Sarah always wash up on a gentle pad no matter how the heightmap
 * slopes there. Keep the centre in sync with JACK_SPAWN (ChapterOne scene).
 */
const LANDING_X = -106 * MAP_SCALE;
const LANDING_Z = 182 * MAP_SCALE;
const LANDING_FLAT_R = 55 / METERS_PER_UNIT;
const LANDING_FEATHER_R = 200 / METERS_PER_UNIT;
const LANDING_H = 4 / METERS_PER_UNIT;
/** World units the satellite/heightmap image spans edge-to-edge. */
export const ISLAND_SPAN = HM_SPAN;
/**
 * Map a world XZ to normalized coordinates on the island satellite/heightmap
 * image (u,v ∈ 0..1; u = left→right = west→east, v = top→bottom = north→south),
 * using the exact same projection the terrain drape uses.
 *
 * TRUE AERIAL VIEW: image-top = world −Z (north — the engine-wide heading-0
 * direction) and image-right = world +X (east). The previous convention (+Z at
 * the top) displayed a MIRRORED aerial view, which made the heading-up minimap
 * impossible to orient with any rotation (one of N/S or E/W always flipped).
 */
export function worldToIslandUV(x: number, z: number): { u: number; v: number } {
  return { u: 0.5 + x / HM_SPAN, v: 0.5 + (z - HM_CZ) / HM_SPAN };
}

/** Inverse of {@link worldToIslandUV}: image (u,v) → world (x,z). */
export function islandUVToWorld(u: number, v: number): { x: number; z: number } {
  return { x: (u - 0.5) * HM_SPAN, z: HM_CZ + (v - 0.5) * HM_SPAN };
}

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
  let h: number;
  if (hmData) {
    const u = 0.5 + x / HM_SPAN;
    const v = 0.5 + (z - HM_CZ) / HM_SPAN; // image rows — same as worldToIslandUV
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
    const above = (n - HM_SEA) / (1 - HM_SEA); // 0..1 above sea level
    h =
      above <= 0
        ? (n - HM_SEA) * HM_SCALE // underwater — keep linear
        : Math.pow(above, HM_APRON) * HM_MAXH; // gradual apron, summit preserved
  } else {
    h = proceduralHeight(x, z);
  }
  // Landing-zone flatten: blend to the 4 m pad near the arrival spawn.
  const dLand = Math.hypot(x - LANDING_X, z - LANDING_Z);
  if (dLand < LANDING_FEATHER_R) {
    const t =
      dLand <= LANDING_FLAT_R
        ? 0
        : (dLand - LANDING_FLAT_R) / (LANDING_FEATHER_R - LANDING_FLAT_R);
    const e = t * t * (3 - 2 * t); // smoothstep out to natural terrain
    h = LANDING_H * (1 - e) + h * e;
  }
  // Dev-sculpted edits (1 m layer): empty by default, so this is a no-op until
  // the Terrain Editor lays down deltas. Reaches everything that reads height.
  h += TerrainEdit.deltaAt(x, z);
  return h;
}

/**
 * Terrain steepness at a world XZ, in degrees (0 = flat). Central finite
 * difference of {@link beachHeight} over ~1.7 m, so it reflects the apron +
 * landing-flatten shaping the player actually walks. Used to gate movement by
 * posture: crawl needs ≤5°, crouch ≤15°, walk/run ≤45°.
 */
export function beachSlopeDeg(x: number, z: number): number {
  const e = 6; // ~1.7 m sampling span (below the ~8 m heightmap texel)
  const gx = (beachHeight(x + e, z) - beachHeight(x - e, z)) / (2 * e);
  const gz = (beachHeight(x, z + e) - beachHeight(x, z - e)) / (2 * e);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
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
  let c = mix3(wetsand, sand, smoothstep(-5, 10, h));
  c = mix3(c, coast, smoothstep(18, 34, h));
  c = mix3(c, jungle, smoothstep(148, 195, h));
  c = mix3(c, rock, smoothstep(VOLCANO_ROCK_H, VOLCANO_ROCK_H + 43, h));
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
         // Elevation bands, low -> high — Godot parity (island_biomes.gd):
         // beach <=6 m, coastal grass <=45 m, jungle <=160 m, highland <=250 m,
         // volcanic rock above (uRockH ~= 250 m). Edges are world units
         // (1 m = 3.556 u), with a little overlap so bands blend naturally.
         vec3 col = reef;
         col = mix(col, sand,   smoothstep(-14.0, 10.0, h));   // waterline -> beach
         col = mix(col, grass,  smoothstep(18.0, 34.0, h));    // beach ends ~6 m
         col = mix(col, jungle, smoothstep(148.0, 195.0, h));  // coast -> jungle ~45 m
         col = mix(col, mtn,    smoothstep(555.0, 620.0, h));  // jungle -> highland ~160 m
         col = mix(col, volc,   smoothstep(uRockH, uRockH + 90.0, h)); // crags/volcano ~250 m
         // Patchy swamp mud — Godot keeps swamp to the low, flat NW basin
         // (island_biomes.gd SWAMP box, <30 m). Gate it to the NW quadrant
         // (west: −x, north: z < uCz) so mud never blankets the SW spawn beach,
         // and only on low ground.
         float nS = vnoise(vWXZ.xz * 0.0018);
         float swampRegion =
           smoothstep(0.0, uSpan * 0.12, -vWXZ.x) *
           smoothstep(0.0, uSpan * 0.12, uCz - vWXZ.z);
         float swampM = smoothstep(20.0, 45.0, h) * (1.0 - smoothstep(85.0, 110.0, h)) *
                        smoothstep(0.5, 0.72, nS) * swampRegion;
         col = mix(col, swamp, swampM * 0.7);
         // Patchy dirt trails through the jungle band.
         float nD = vnoise(vWXZ.xz * 0.05 + 13.0);
         float dirtM = smoothstep(170.0, 230.0, h) * (1.0 - smoothstep(480.0, 540.0, h)) * smoothstep(0.55, 0.8, nD);
         col = mix(col, dirt, dirtM * 0.65);
         // Only genuinely steep faces -> coastal cliff rock; gentle hillsides
         // stay jungle so the island reads green like the reference.
         float slope = 1.0 - clamp(vWN.y, 0.0, 1.0);
         col = mix(col, cliff, smoothstep(0.52, 0.78, slope));
         // Faint aerial macro tint so the island's big-picture colour still reads.
         // flipY texture space: v_tex = 1 - image_v, so the sign is opposite
         // to worldToIslandUV's image-row v.
         vec2 auv = vec2(0.5 + vWXZ.x / uSpan, 0.5 - (vWXZ.z - uCz) / uSpan);
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
  // Mesh covers the heightmap plus a ~30-map-unit ocean-floor skirt each side.
  // At 8192 m across, 512 segments give ~19 m cells — right beside the Godot
  // build's 16 m (its 8192 m / GRID 512). The old 440-unit span wasted ~2/5 of
  // the vertex budget on flat deep-ocean floor.
  const SIZE = 360 * MAP_SCALE;
  const SEG = 512;
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
    // flipY texture space, so the v sign is opposite to worldToIslandUV's rows.
    uv.setXY(i, 0.5 + x / HM_SPAN, 0.5 - (z - HM_CZ) / HM_SPAN);
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
  uniform float uWaveAmp;
  uniform float uWaveFreq;
  varying vec3 vWorld;
  varying float vCrest;
  varying vec3 vNormal;
  float waves(vec2 pin) {
    vec2 p = pin * uWaveFreq;
    float h = 0.0;
    h += sin(dot(p, vec2( 0.8, 0.6)) * 0.10 + uTime * 1.1) * 0.24;
    h += sin(dot(p, vec2(-0.4, 0.9)) * 0.16 + uTime * 0.9) * 0.16;
    h += sin(dot(p, vec2( 0.3,-0.7)) * 0.24 + uTime * 1.5) * 0.10;
    h += sin(dot(p, vec2(-0.7, 0.3)) * 0.33 + uTime * 1.8) * 0.06;
    // Fine ripples — mostly for the surface NORMAL (small amplitude) so the
    // water catches sun glints and sky reflection instead of reading flat.
    h += sin(dot(p, vec2( 0.9,-0.2)) * 0.70 + uTime * 2.6) * 0.030;
    h += sin(dot(p, vec2(-0.2, 0.95)) * 0.95 + uTime * 3.1) * 0.020;
    return h * uWaveAmp;
  }
  void main() {
    vec3 p = position;
    float h = waves(p.xz);
    p.y += h;
    // Surface normal from finite differences of the height field.
    float e = 6.0;
    float hx = waves(p.xz + vec2(e, 0.0));
    float hz = waves(p.xz + vec2(0.0, e));
    vNormal = normalize(vec3(h - hx, e, h - hz));
    vCrest = clamp((h / max(uWaveAmp, 0.001)) * 1.4 + 0.5, 0.0, 1.0);
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WATER_FRAG = /* glsl */ `
  uniform vec3 uCamPos;
  uniform float uShallow;
  uniform float uDeepDist;
  varying vec3 vWorld;
  varying float vCrest;
  varying vec3 vNormal;
  void main() {
    vec3 nrm = normalize(vNormal);
    vec3 viewDir = normalize(uCamPos - vWorld);
    vec3 sunDir = normalize(vec3(0.35, 0.72, 0.28));

    // Base water colour by distance (reads as depth).
    vec3 deep    = vec3(0.02, 0.10, 0.24);
    vec3 shallow = vec3(0.08, 0.42, 0.50);
    float dist = length(vWorld.xz - uCamPos.xz);
    float depthT = smoothstep(uShallow, uDeepDist, dist);
    vec3 water = mix(shallow, deep, depthT);

    // Fresnel: at grazing angles the surface mirrors the sky, head-on it shows
    // the water colour — the single biggest cue that sells a real surface.
    float fres = pow(clamp(1.0 - max(dot(nrm, viewDir), 0.0), 0.0, 1.0), 4.0);
    vec3 sky = vec3(0.45, 0.66, 0.92);
    vec3 col = mix(water, sky, fres * 0.65);

    // Wave shading + a tight sun specular glint riding the ripple normals.
    float diff = 0.72 + 0.28 * max(dot(nrm, sunDir), 0.0);
    col *= diff;
    vec3 halfv = normalize(sunDir + viewDir);
    float spec = pow(max(dot(nrm, halfv), 0.0), 220.0);
    col += vec3(1.0, 0.97, 0.88) * spec * 0.9;

    // Softer crest foam (less streaky than the old hard band).
    float foam = smoothstep(0.85, 0.99, vCrest);
    col = mix(col, vec3(0.86, 0.94, 0.96), foam * 0.7);

    float alpha = mix(0.82, 0.98, depthT);
    alpha = max(alpha, max(foam * 0.9, fres * 0.5));
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
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
    // Longer, taller swell + shore/deep fade distances scaled to the big world.
    uWaveAmp: { value: 9 * (HEIGHT_SCALE / 24) },
    uWaveFreq: { value: 0.18 },
    uShallow: { value: 50 * MAP_SCALE },
    uDeepDist: { value: 800 * MAP_SCALE },
  };
  // Big enough to reach the horizon well past the ~3 km island; the vertex-
  // displaced swell only needs to read near shore, so tessellation stays moderate.
  const SPAN = 60000;
  const geo = new THREE.PlaneGeometry(SPAN, SPAN, 384, 384);
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
