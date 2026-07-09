import * as THREE from "three";
import type { MarkerDef } from "./MarkerStore";

/**
 * The palette of things the Marker Editor can place, plus a self-contained
 * procedural mesh for each (no assets needed). A marker is a lightweight world
 * object — a spawn point, a prop, a light — that the editor lays down and the
 * game recalls. Types are intentionally generic so the same set works on the
 * lab and the island; add entries here to grow the palette.
 */

export interface MarkerType {
  key: string;
  label: string;
  icon: string;
  /** Category, used only to group the palette buttons. */
  group: "spawn" | "prop" | "nature" | "light";
}

export const MARKER_TYPES: MarkerType[] = [
  { key: "spawn", label: "Spawn Point", icon: "◈", group: "spawn" },
  { key: "waypoint", label: "Waypoint", icon: "⚑", group: "spawn" },
  { key: "crate", label: "Crate", icon: "▦", group: "prop" },
  { key: "barrel", label: "Barrel", icon: "◍", group: "prop" },
  { key: "sign", label: "Sign", icon: "▲", group: "prop" },
  { key: "rock", label: "Rock", icon: "⬢", group: "nature" },
  { key: "tree", label: "Tree", icon: "🌳", group: "nature" },
  { key: "palm", label: "Palm", icon: "🌴", group: "nature" },
  { key: "bush", label: "Bush", icon: "❦", group: "nature" },
  { key: "torch", label: "Torch Light", icon: "✷", group: "light" },
];

export function markerLabel(type: string): string {
  return MARKER_TYPES.find((t) => t.key === type)?.label ?? type;
}

// ── Procedural builders (one small mesh per type) ────────────────────────────
function mat(color: number, opts: { rough?: number; metal?: number; emissive?: number } = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.rough ?? 0.85,
    metalness: opts.metal ?? 0,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissive ? 1 : 0,
  });
}

function buildSpawn(color: number): THREE.Object3D {
  // A flat glowing ring + up-arrow so a spawn/waypoint reads on the ground.
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.2, 0.14, 10, 32),
    mat(color, { emissive: color, rough: 0.4 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  const post = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 12), mat(color, { emissive: color }));
  post.position.y = 1.4;
  g.add(ring, post);
  return g;
}

function buildCrate(): THREE.Object3D {
  const c = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat(0x9a6b3a, { rough: 0.9 }));
  c.position.y = 1;
  c.castShadow = true;
  return c;
}

function buildBarrel(): THREE.Object3D {
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.4, 16), mat(0x4a6a54, { metal: 0.3, rough: 0.6 }));
  b.position.y = 1.2;
  b.castShadow = true;
  return b;
}

function buildSign(): THREE.Object3D {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3, 8), mat(0x5b4326));
  post.position.y = 1.5;
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 0.16), mat(0xc7a86a));
  board.position.y = 2.6;
  g.add(post, board);
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

function buildRock(): THREE.Object3D {
  const r = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4, 0), mat(0x6f7278, { rough: 1 }));
  r.position.y = 0.9;
  r.scale.set(1, 0.75, 1.1);
  r.castShadow = true;
  return r;
}

function buildPalm(): THREE.Object3D {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 7, 8), mat(0x7a5a34, { rough: 1 }));
  trunk.position.y = 3.5;
  trunk.rotation.z = 0.08;
  g.add(trunk);
  const frondMat = mat(0x2f7d3a, { rough: 0.9 });
  for (let i = 0; i < 6; i++) {
    const frond = new THREE.Mesh(new THREE.ConeGeometry(0.7, 4.5, 4), frondMat);
    frond.position.set(0, 7, 0);
    frond.rotation.z = Math.PI / 2.4;
    frond.rotation.y = (i / 6) * Math.PI * 2;
    frond.translateY(2);
    g.add(frond);
  }
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

function buildTree(): THREE.Object3D {
  // Matches the coded island foliage: trunk + two stacked canopy blobs.
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.5, 7, 6),
    mat(0x6b4a2a, { rough: 1 }),
  );
  trunk.position.y = 3.5;
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2f7d3a, roughness: 1, flatShading: true });
  const low = new THREE.Mesh(new THREE.IcosahedronGeometry(3.2, 0), canopyMat);
  low.scale.set(1, 0.8, 1);
  low.position.y = 8;
  const high = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2, 0), canopyMat);
  high.position.y = 11;
  g.add(trunk, low, high);
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

function buildBush(): THREE.Object3D {
  const g = new THREE.Group();
  const m = mat(0x3a6d2e, { rough: 1 });
  for (const [x, y, z, s] of [
    [0, 0.7, 0, 1],
    [0.7, 0.5, 0.3, 0.7],
    [-0.6, 0.55, -0.2, 0.8],
  ] as const) {
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 * s, 1), m);
    blob.position.set(x, y, z);
    blob.castShadow = true;
    g.add(blob);
  }
  return g;
}

function buildTorch(): THREE.Object3D {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 2.2, 8), mat(0x3a3a3a, { metal: 0.6, rough: 0.5 }));
  post.position.y = 1.1;
  const flame = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 12, 12),
    mat(0xffa032, { emissive: 0xff7a1a, rough: 0.3 }),
  );
  flame.position.y = 2.35;
  const light = new THREE.PointLight(0xffb257, 8, 26, 2);
  light.position.y = 2.4;
  g.add(post, flame, light);
  return g;
}

/** Build the world object for a marker def, positioned/rotated/scaled + tagged. */
export function buildMarkerObject(def: MarkerDef): THREE.Object3D {
  let obj: THREE.Object3D;
  switch (def.type) {
    case "spawn":
      obj = buildSpawn(0x37e0a0);
      break;
    case "waypoint":
      obj = buildSpawn(0x4ea3ff);
      break;
    case "crate":
      obj = buildCrate();
      break;
    case "barrel":
      obj = buildBarrel();
      break;
    case "sign":
      obj = buildSign();
      break;
    case "rock":
      obj = buildRock();
      break;
    case "tree":
      obj = buildTree();
      break;
    case "palm":
      obj = buildPalm();
      break;
    case "bush":
      obj = buildBush();
      break;
    case "torch":
      obj = buildTorch();
      break;
    default:
      obj = buildCrate();
      break;
  }
  obj.position.set(def.x, def.y, def.z);
  obj.rotation.y = def.rotY ?? 0;
  const s = def.scale ?? 1;
  obj.scale.multiplyScalar(s);
  obj.userData.marker = true;
  obj.userData.markerId = def.id;
  obj.userData.markerType = def.type;
  return obj;
}
