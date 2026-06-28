import * as THREE from "three";
import { makeLabel } from "../markers/labels";

/** The static world: sky, lights, ground plane, grid, and axis hints. */
export class EditorScene {
  readonly scene: THREE.Scene;
  readonly ground: THREE.Mesh;
  readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f17);
    scene.fog = new THREE.Fog(0x0b0f17, 60, 220);

    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x202734, 1.0);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(40, 70, 20);
    scene.add(dir);

    // Ground plane (subtle, so the grid reads on top).
    const groundGeo = new THREE.PlaneGeometry(400, 400);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x141a26,
      roughness: 1,
      metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.name = "ground";
    scene.add(ground);

    // Metric grid: 1m minor, 10m major.
    const grid = new THREE.GridHelper(400, 400, 0x3a4a66, 0x222c3d);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.y = 0.002;
    scene.add(grid);

    const majorGrid = new THREE.GridHelper(400, 40, 0x4f6486, 0x33415a);
    majorGrid.position.y = 0.004;
    scene.add(majorGrid);

    // Axis hints at the origin (matches the game): +X (east) red, -Z (north) blue.
    scene.add(makeAxis(new THREE.Vector3(1, 0, 0), 0xff5a5a));
    scene.add(makeAxis(new THREE.Vector3(0, 0, -1), 0x5a9bff));

    // Compass labels so N/S/E/W are never ambiguous. North is -Z to match the game.
    const compass: Array<[string, number, number]> = [
      ["N", 0, -9],
      ["S", 0, 9],
      ["E", 9, 0],
      ["W", -9, 0],
    ];
    for (const [text, x, z] of compass) {
      const label = makeLabel(text, "#9fc0ff");
      label.position.set(x, 0.9, z);
      scene.add(label);
    }

    this.scene = scene;
    this.ground = ground;
  }

  add(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  remove(obj: THREE.Object3D): void {
    this.scene.remove(obj);
  }
}

function makeAxis(dir: THREE.Vector3, color: number): THREE.Line {
  const pts = [new THREE.Vector3(0, 0.02, 0), dir.clone().multiplyScalar(8).setY(0.02)];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color });
  return new THREE.Line(geo, mat);
}
