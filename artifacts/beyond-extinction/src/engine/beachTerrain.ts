import * as THREE from "three";

/**
 * Procedural beach terrain + real animated water for the island (Chapter 2) —
 * the web equivalent of the Godot island's terrain/ocean (island_terrain.gd +
 * ocean_water.gdshader). Instead of a baked heightmap PNG, the height comes from
 * value-noise fbm in code, so it needs no asset.
 *
 * Layout matches the beach scene: −Z is the sea, +Z is inland. The terrain
 * slopes BELOW sea level offshore and rises into dunes inland, so the water
 * plane at y=0 only shows on the sea side — no more flat ocean plane overlapping
 * the flat sand (which was the "water flying across the ground" flicker).
 */

/** World Z of the waterline (terrain crosses y=0 here). */
export const SHORE_Z = -15;

// ── Deterministic value-noise fbm ────────────────────────────────────────────
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
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; // 0..1
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
  return f; // ~ −1..1
}

/**
 * Terrain height at a world XZ. Below 0 = underwater. Gentle dry beach across
 * the play area, dunes/jungle rise past the treeline, sea floor slopes off −Z.
 */
export function beachHeight(x: number, z: number): number {
  const inland = z - SHORE_Z; // <0 offshore, >0 inland
  let h: number;
  if (inland < 0) {
    h = inland * 0.11; // sea floor slopes down offshore
  } else {
    const beach = Math.min(inland, 49) * 0.03; // gentle dry beach over the play area
    const dune = Math.max(0, inland - 49) * 0.16; // dunes/jungle rise past the treeline
    h = beach + dune;
  }
  // Undulation: ~none underwater, gentle on the flat beach, stronger in the dunes.
  const dry = Math.max(0, Math.min(1, inland / 16));
  const duneAmp = 0.35 + Math.max(0, inland - 49) * 0.05;
  h += fbm(x * 0.018, z * 0.018) * duneAmp * dry;
  return h;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function mix3(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Biome colour by elevation (mirrors island_terrain.gdshader's beach bands). */
function beachColor(h: number): number[] {
  const wetsand = [0.45, 0.41, 0.3];
  const sand = [0.72, 0.64, 0.44];
  const coast = [0.34, 0.52, 0.22];
  const jungle = [0.13, 0.34, 0.12];
  let c = sand;
  c = mix3(wetsand, c, smoothstep(-1.5, 0.8, h)); // underwater → wet sand
  c = mix3(c, coast, smoothstep(2.5, 7.0, h)); // grassy dunes
  c = mix3(c, jungle, smoothstep(11.0, 24.0, h)); // treeline green
  return c;
}

/**
 * Build the vertex-coloured terrain mesh over the beach. Centred on the origin,
 * spanning far enough offshore/inland to read as a coastline.
 */
export function buildBeachTerrain(): THREE.Mesh {
  const SIZE = 800;
  const SEG = 180;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2); // into the XZ plane (y up)
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = beachHeight(x, z);
    pos.setY(i, h);
    const [r, g, b] = beachColor(h);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "beach-terrain";
  return mesh;
}

const WATER_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uShoreZ;
  varying vec3 vWorld;
  varying float vCrest;
  float waves(vec2 p) {
    float h = 0.0;
    h += sin(dot(p, vec2( 0.8, 0.6)) * 0.10 + uTime * 1.1) * 0.30;
    h += sin(dot(p, vec2(-0.4, 0.9)) * 0.16 + uTime * 0.9) * 0.20;
    h += sin(dot(p, vec2( 0.3,-0.7)) * 0.24 + uTime * 1.5) * 0.12;
    h += sin(dot(p, vec2(-0.7, 0.3)) * 0.33 + uTime * 1.8) * 0.08;
    return h;
  }
  void main() {
    vec3 p = position;
    // Flatten the swell right at the waterline so it meets the wet sand cleanly,
    // building up offshore — no waves poking through the beach.
    float shoreFade = smoothstep(uShoreZ, uShoreZ - 100.0, p.z);
    float h = waves(p.xz) * shoreFade;
    p.y += h;
    vCrest = clamp(h * 1.2 + 0.5, 0.0, 1.0);
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
    float depthT = smoothstep(60.0, 900.0, dist); // near shore = shallow, far = deep
    vec3 col = mix(shallow, deep, depthT);
    float foam = smoothstep(0.74, 0.92, vCrest); // crest foam
    col = mix(col, surf, foam);
    float alpha = mix(0.80, 0.97, depthT);
    alpha = max(alpha, foam);
    gl_FragColor = vec4(col, alpha);
  }
`;

export interface OceanWater {
  mesh: THREE.Mesh;
  uniforms: {
    uTime: { value: number };
    uCamPos: { value: THREE.Vector3 };
    uShoreZ: { value: number };
  };
}

/** Build the animated water plane at sea level (y=0), reaching to the horizon. */
export function buildOceanWater(): OceanWater {
  const uniforms = {
    uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3() },
    uShoreZ: { value: SHORE_Z },
  };
  const geo = new THREE.PlaneGeometry(2400, 2000, 160, 140);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0, -700); // extend far offshore to the horizon
  mesh.renderOrder = 1; // drawn after the opaque terrain
  mesh.name = "ocean-water";
  return { mesh, uniforms };
}
