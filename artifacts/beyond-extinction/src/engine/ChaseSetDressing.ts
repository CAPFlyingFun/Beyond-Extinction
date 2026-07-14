import * as THREE from "three";
import { beachHeight, METERS_PER_UNIT } from "./beachTerrain";

/**
 * ChaseSetDressing — the procedural set pieces the Chapter Three chase runs
 * through: a ravine (two rocky lips with a dark trench between), a fast river
 * strip, and the boulder pile + cave mouth at the cliff that ends the chase.
 *
 * Everything is cheap primitives (flat-shaded icosahedron rock blobs, planes)
 * because the cinematic frames them tightly under hard cuts and the free-roam
 * player only ever sees them from ground level. None of it collides — the
 * cinematic owns actor movement, and in free roam they are landmarks, not
 * fences (spawn-trap lesson: keep required paths clear by layout).
 */

export interface ChaseAnchors {
  /** Ravine centre + its long axis (unit XZ, runs across the chase lane). */
  ravine: { x: number; z: number; ax: number; az: number };
  /** River centre + its flow axis (unit XZ). */
  river: { x: number; z: number; ax: number; az: number };
  /** Cave mouth + outward facing direction (unit XZ, points at the runners). */
  cave: { x: number; z: number; fx: number; fz: number };
}

const M = (metres: number) => metres / METERS_PER_UNIT;

export class ChaseSetDressing {
  readonly group = new THREE.Group();
  /** World-space point just inside the cave (interior shots + FP handback). */
  readonly caveInterior = new THREE.Vector3();
  /** World-space point just outside the boulder gap (dive target). */
  readonly caveMouth = new THREE.Vector3();

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private riverMat?: THREE.MeshStandardMaterial;
  private riverTime = 0;

  constructor(anchors: ChaseAnchors) {
    this.group.name = "chase-set-dressing";

    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    this.geos.push(rockGeo);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x6e6257,
      roughness: 1,
      flatShading: true,
    });
    const mossMat = new THREE.MeshStandardMaterial({
      color: 0x51584a,
      roughness: 1,
      flatShading: true,
    });
    this.mats.push(rockMat, mossMat);
    const rand = mulberry(20260714);

    const rock = (
      x: number,
      z: number,
      r: number,
      yLift: number,
      mat: THREE.Material,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(rockGeo, mat);
      m.scale.set(r * (0.8 + rand() * 0.5), r * (0.55 + rand() * 0.5), r * (0.8 + rand() * 0.5));
      m.position.set(x, beachHeight(x, z) + yLift, z);
      m.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      return m;
    };

    // ── Ravine: two parallel lips of rock with a sunken dark trench between.
    {
      const { x, z, ax, az } = anchors.ravine;
      const half = M(4.5); // half the gap — ~9 m across, a two-storey leap
      const px = -az; // perpendicular (chase direction)
      const pz = ax;
      for (let i = -6; i <= 6; i++) {
        const along = i * M(6) * (0.85 + rand() * 0.3);
        for (const s of [-1, 1]) {
          const off = half + M(1.5) + rand() * M(2);
          rock(
            x + ax * along + px * off * s,
            z + az * along + pz * off * s,
            M(2.2 + rand() * 1.6),
            -M(0.6),
            rand() < 0.35 ? mossMat : rockMat,
          );
        }
      }
      // The trench: a long dark box sunk between the lips so looking across
      // reads as depth-in-shadow (the terrain itself can't be carved).
      const trenchGeo = new THREE.BoxGeometry(M(80), M(7), half * 2);
      this.geos.push(trenchGeo);
      const trenchMat = new THREE.MeshStandardMaterial({ color: 0x0b0f0a, roughness: 1 });
      this.mats.push(trenchMat);
      const trench = new THREE.Mesh(trenchGeo, trenchMat);
      trench.position.set(x, beachHeight(x, z) - M(4.2), z);
      trench.rotation.y = Math.atan2(ax, az) + Math.PI / 2;
      this.group.add(trench);
    }

    // ── River: a fast blue strip with pale foam lines that scroll in update().
    {
      const { x, z, ax, az } = anchors.river;
      const y = beachHeight(x, z) + M(0.15);
      const riverGeo = new THREE.PlaneGeometry(M(9), M(170));
      this.geos.push(riverGeo);
      this.riverMat = new THREE.MeshStandardMaterial({
        color: 0x2f76c9,
        roughness: 0.25,
        metalness: 0.1,
        transparent: true,
        opacity: 0.82,
      });
      this.mats.push(this.riverMat);
      const river = new THREE.Mesh(riverGeo, this.riverMat);
      river.rotation.x = -Math.PI / 2;
      river.rotation.z = Math.atan2(ax, az);
      river.position.set(x, y, z);
      this.group.add(river);
      // Wet stones along both banks.
      for (let i = -10; i <= 10; i++) {
        const along = i * M(8) * (0.8 + rand() * 0.4);
        for (const s of [-1, 1]) {
          if (rand() < 0.4) continue;
          const off = M(5.5) + rand() * M(2.5);
          rock(
            x + ax * along + -az * off * s,
            z + az * along + ax * off * s,
            M(0.5 + rand() * 0.7),
            -M(0.2),
            mossMat,
          );
        }
      }
    }

    // ── Boulder pile + cave mouth against a cliff backdrop.
    {
      const { x, z, fx, fz } = anchors.cave;
      const y = beachHeight(x, z);
      // Cliff backdrop: one huge flattened rock wall behind the pile.
      const wall = rock(x - fx * M(10), z - fz * M(10), M(14), M(6), rockMat);
      wall.scale.y *= 1.8;
      // The pile: big weathered boulders left and right of a narrow gap that
      // faces the runners (fx,fz). The gap is the dive lane — kept clear.
      const gx = -fz; // sideways axis
      const gz = fx;
      for (const s of [-1, 1]) {
        rock(x + gx * M(3.4) * s + fx * M(2), z + gz * M(3.4) * s + fz * M(2), M(3.2), M(0.5), rockMat);
        rock(x + gx * M(6.5) * s + fx * M(0.5), z + gz * M(6.5) * s + fz * M(0.5), M(4.2), M(0.8), mossMat);
        rock(x + gx * M(4.6) * s - fx * M(3), z + gz * M(4.6) * s - fz * M(3), M(3.6), M(1.2), rockMat);
      }
      // A capstone over the gap so the mouth reads as an opening, not a slot.
      rock(x - fx * M(2), z - fz * M(2), M(3.4), M(4.6), rockMat);

      // Interior: a dark dome (backside) buried in the pile — interior shots
      // put the camera inside it so "the cave" has walls without real geometry.
      const domeGeo = new THREE.SphereGeometry(M(5.2), 16, 12);
      this.geos.push(domeGeo);
      const domeMat = new THREE.MeshStandardMaterial({
        color: 0x17130f,
        roughness: 1,
        side: THREE.BackSide,
      });
      this.mats.push(domeMat);
      const dome = new THREE.Mesh(domeGeo, domeMat);
      dome.position.set(x - fx * M(4), y + M(1.2), z - fz * M(4));
      this.group.add(dome);
      // Interior floor so the dome's inside has a ground plane to stand on.
      const floorGeo = new THREE.CircleGeometry(M(5), 16);
      this.geos.push(floorGeo);
      const floorMat = new THREE.MeshStandardMaterial({ color: 0x241d16, roughness: 1 });
      this.mats.push(floorMat);
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(dome.position.x, y + M(0.05), dome.position.z);
      this.group.add(floor);
      // A dim ember-warm point light so the interior isn't pure black.
      const glow = new THREE.PointLight(0xffd9a0, 0.0, M(9));
      glow.name = "cave-glow";
      glow.position.set(dome.position.x, y + M(1.6), dome.position.z);
      this.group.add(glow);

      this.caveInterior.set(dome.position.x, y, dome.position.z);
      this.caveMouth.set(x + fx * M(4.5), beachHeight(x + fx * M(4.5), z + fz * M(4.5)), z + fz * M(4.5));
    }
  }

  /** Turn the faint interior glow on/off (cave shots / after the handback). */
  setCaveGlow(on: boolean): void {
    const glow = this.group.getObjectByName("cave-glow") as THREE.PointLight | null;
    if (glow) glow.intensity = on ? 1.4 : 0;
  }

  update(dt: number): void {
    // River shimmer: a cheap emissive pulse reads as moving water at distance.
    if (this.riverMat) {
      this.riverTime += dt;
      const s = 0.5 + 0.5 * Math.sin(this.riverTime * 2.3);
      this.riverMat.color.setHSL(0.58, 0.62, 0.38 + s * 0.08);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
