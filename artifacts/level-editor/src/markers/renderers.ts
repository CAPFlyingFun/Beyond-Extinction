import * as THREE from "three";
import type {
  ObjectMarker,
  SpawnMarker,
  Vec2,
  WallChain,
} from "../state/types";
import { makeLabel } from "./labels";

const WALL_COLOR = 0xffc24d;
const WALL_ACTIVE_COLOR = 0x7fffa8;
const OBJECT_COLOR = 0x9b8cff;
const SPAWN_COLOR = 0x4dd6a0;
const NODE_COLOR = 0xffffff;

/** Dispose all geometries/materials/textures under a group, then clear it. */
export function disposeGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    const anyObj = obj as THREE.Mesh & THREE.Line & THREE.Sprite;
    if (anyObj.geometry) anyObj.geometry.dispose();
    const mat = (anyObj as { material?: THREE.Material | THREE.Material[] })
      .material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        const tex = (m as THREE.SpriteMaterial).map;
        if (tex) tex.dispose();
        m.dispose();
      }
    }
  });
  group.clear();
}

function nodeMarker(p: Vec2, color = NODE_COLOR): THREE.Mesh {
  const geo = new THREE.SphereGeometry(0.09, 10, 8);
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(p.x, 0.05, p.z);
  mesh.renderOrder = 5;
  return mesh;
}

/** A single wireframe wall segment (box) between two ground points. */
function wallSegment(
  a: Vec2,
  b: Vec2,
  height: number,
  thickness: number,
  color: number,
): THREE.LineSegments {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 0.001;
  const box = new THREE.BoxGeometry(len, height, Math.max(thickness, 0.02));
  const edges = new THREE.EdgesGeometry(box);
  box.dispose();
  const mat = new THREE.LineBasicMaterial({ color });
  const seg = new THREE.LineSegments(edges, mat);
  seg.position.set((a.x + b.x) / 2, height / 2, (a.z + b.z) / 2);
  // Box local +X runs along the segment; rotate about Y to align.
  seg.rotation.y = Math.atan2(dx, dz) - Math.PI / 2;
  return seg;
}

export function buildWall(wall: WallChain, active = false): THREE.Group {
  const group = new THREE.Group();
  const color = active ? WALL_ACTIVE_COLOR : WALL_COLOR;
  const pts = wall.points;

  for (let i = 0; i < pts.length - 1; i += 1) {
    group.add(wallSegment(pts[i], pts[i + 1], wall.height, wall.thickness, color));
  }
  if (wall.closed && pts.length >= 3) {
    group.add(
      wallSegment(pts[pts.length - 1], pts[0], wall.height, wall.thickness, color),
    );
  }
  for (const p of pts) group.add(nodeMarker(p, active ? WALL_ACTIVE_COLOR : NODE_COLOR));

  if (!active && pts.length > 0 && wall.tag) {
    const label = makeLabel(wall.tag, "#ffe2a8");
    label.position.set(pts[0].x, wall.height + 0.4, pts[0].z);
    group.add(label);
  }
  return group;
}

export function buildObject(obj: ObjectMarker): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: OBJECT_COLOR });
  let outline: THREE.Line;

  if (obj.shape === "circle") {
    const r = obj.size / 2;
    const curve = new THREE.EllipseCurve(0, 0, r, r, 0, Math.PI * 2, false, 0);
    const pts2d = curve.getPoints(48);
    const pts = pts2d.map((p) => new THREE.Vector3(p.x, 0, p.y));
    outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat);
  } else {
    const h = obj.size / 2;
    const corners = [
      new THREE.Vector3(-h, 0, -h),
      new THREE.Vector3(h, 0, -h),
      new THREE.Vector3(h, 0, h),
      new THREE.Vector3(-h, 0, h),
    ];
    outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(corners),
      mat,
    );
  }
  outline.position.y = 0.03;
  group.add(outline);

  // Center post for visibility from a distance.
  const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.6, 6);
  const post = new THREE.Mesh(
    postGeo,
    new THREE.MeshBasicMaterial({ color: OBJECT_COLOR }),
  );
  post.position.y = 0.3;
  group.add(post);

  group.position.set(obj.x, 0, obj.z);
  group.rotation.y = THREE.MathUtils.degToRad(obj.rot);

  if (obj.tag) {
    const label = makeLabel(obj.tag, "#ccc2ff");
    label.position.set(0, 0.95, 0);
    group.add(label);
  }
  return group;
}

export function buildSpawn(spawn: SpawnMarker): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: SPAWN_COLOR });
  const r = 0.4;

  const curve = new THREE.EllipseCurve(0, 0, r, r, 0, Math.PI * 2, false, 0);
  const ringPts = curve.getPoints(40).map((p) => new THREE.Vector3(p.x, 0, p.y));
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(ringPts),
    mat,
  );
  ring.position.y = 0.03;
  group.add(ring);

  // Facing arrow: 0° points -Z (north); facing increases clockwise toward +X (east).
  const arrowPts = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -(r + 0.5)),
    new THREE.Vector3(-0.15, 0, -(r + 0.25)),
    new THREE.Vector3(0, 0, -(r + 0.5)),
    new THREE.Vector3(0.15, 0, -(r + 0.25)),
  ];
  const arrow = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(arrowPts),
    mat,
  );
  arrow.position.y = 0.03;
  group.add(arrow);

  group.position.set(spawn.x, 0, spawn.z);
  // Negate: compass facing is CW from north (-Z), but +Y rotation is CCW.
  group.rotation.y = THREE.MathUtils.degToRad(-spawn.facing);

  if (spawn.tag) {
    const label = makeLabel(spawn.tag, "#b6f0d6");
    label.position.set(0, 0.9, 0);
    group.add(label);
  }
  return group;
}

/** Preview of the in-progress wall, including a ghost segment to the cursor. */
export function buildActiveWallPreview(
  wall: WallChain,
  cursor: Vec2 | null,
): THREE.Group {
  const group = buildWall(wall, true);
  if (cursor && wall.points.length > 0) {
    const last = wall.points[wall.points.length - 1];
    const ghostMat = new THREE.LineDashedMaterial({
      color: WALL_ACTIVE_COLOR,
      dashSize: 0.3,
      gapSize: 0.2,
    });
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(last.x, 0.05, last.z),
        new THREE.Vector3(cursor.x, 0.05, cursor.z),
      ]),
      ghostMat,
    );
    line.computeLineDistances();
    group.add(line);
  }
  return group;
}
