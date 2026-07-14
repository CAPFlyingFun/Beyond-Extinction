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

    // ── Boulder pile framing a real cave MOUTH against a cliff backdrop.
    {
      const { x, z, fx, fz } = anchors.cave;
      const y = beachHeight(x, z);
      const gx = -fz; // sideways axis across the mouth
      const gz = fx;
      const yaw = Math.atan2(fx, fz); // faces the runners (+fx)

      // Shared dark interior materials. `darkMat` is BackSide so it is only
      // ever seen looking *into* the throat/room (front faces culled); `floorMat`
      // is a flat dark ground so bright sand never shows through the opening.
      const darkMat = new THREE.MeshStandardMaterial({
        color: 0x080605,
        roughness: 1,
        metalness: 0,
        side: THREE.BackSide,
      });
      const floorMat = new THREE.MeshStandardMaterial({ color: 0x1c160f, roughness: 1 });
      this.mats.push(darkMat, floorMat);

      // Structural block: a rock primitive with *controlled* orientation. The
      // `rock` pile helper randomises rotation, which is wrong for the pillars
      // and lintel that must read as an upright doorway. Local +Z is aimed
      // along fx (out toward the runners) so `sz` is depth and `sx` is width.
      const block = (
        bx: number,
        bz: number,
        sx: number,
        sy: number,
        sz: number,
        yLift: number,
        mat: THREE.Material,
      ): THREE.Mesh => {
        const m = new THREE.Mesh(rockGeo, mat);
        m.scale.set(sx, sy, sz);
        m.position.set(bx, beachHeight(bx, bz) + yLift, bz);
        m.rotation.set((rand() - 0.5) * 0.25, yaw + (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.25);
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        return m;
      };

      // Cliff backdrop: a huge flattened wall behind the pile so the mouth
      // always reads against solid rock, never open sky.
      block(x - fx * M(11), z - fz * M(11), M(11), M(11), M(3.5), M(5), rockMat);

      // The dark THROAT — an open-ended cylinder (near-black, BackSide) whose
      // front rim sits in the gap facing the runners and bores back into the
      // cliff. From the approach you look straight down it into darkness, and
      // *that* is what reads as "an opening" in daylight. (The old design buried
      // a back-faced dome in the pile — invisible from outside, so there was
      // no visible mouth at all. This is the fix for "the cave has no opening".)
      const R = M(2.7);
      const throatLen = M(10);
      const throatGeo = new THREE.CylinderGeometry(R, R * 1.08, throatLen, 22, 1, true);
      this.geos.push(throatGeo);
      const axis = new THREE.Vector3(fx, 0, fz).normalize();
      const throatQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      const throat = new THREE.Mesh(throatGeo, darkMat);
      throat.quaternion.copy(throatQ);
      const tcx = x + fx * (M(1.4) - throatLen / 2); // front rim ~1.4 m out
      const tcz = z + fz * (M(1.4) - throatLen / 2);
      throat.position.set(tcx, y + M(1.6), tcz);
      this.group.add(throat);

      // Dark floor strip down the throat (horizontal, its length along fx).
      const tFloorGeo = new THREE.PlaneGeometry(R * 1.7, throatLen);
      this.geos.push(tFloorGeo);
      const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const tFloor = new THREE.Mesh(tFloorGeo, floorMat);
      tFloor.quaternion.copy(spin.multiply(flat));
      tFloor.position.set(tcx, y + M(0.06), tcz);
      this.group.add(tFloor);

      // Interior room: a dark dome + floor at the back of the throat, so the
      // inside cinematic shots (camera at caveInterior) have walls and ground.
      const domeCx = x - fx * M(7);
      const domeCz = z - fz * M(7);
      const domeGeo = new THREE.SphereGeometry(M(4.6), 16, 12);
      this.geos.push(domeGeo);
      const dome = new THREE.Mesh(domeGeo, darkMat);
      dome.position.set(domeCx, y + M(1.0), domeCz);
      this.group.add(dome);
      const floorGeo = new THREE.CircleGeometry(M(4.4), 20);
      this.geos.push(floorGeo);
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(domeCx, y + M(0.05), domeCz);
      this.group.add(floor);

      // Ember-warm interior light (off until the runners are inside).
      const glow = new THREE.PointLight(0xffd9a0, 0.0, M(11));
      glow.name = "cave-glow";
      glow.position.set(domeCx + fx * M(1.5), y + M(1.6), domeCz + fz * M(1.5));
      this.group.add(glow);

      // Doorway framing: two tall pillars flanking the mouth + a lintel across
      // their tops, so the silhouette reads as an entrance carved in the rock.
      for (const s of [-1, 1]) {
        block(
          x + gx * M(3.3) * s + fx * M(0.6),
          z + gz * M(3.3) * s + fz * M(0.6),
          M(1.7),
          M(3.4),
          M(1.7),
          M(0.6),
          s < 0 ? mossMat : rockMat,
        );
      }
      block(x + fx * M(0.3), z + fz * M(0.3), M(4.6), M(1.5), M(2.4), M(4.4), rockMat);

      // Outer weathered boulders for bulk (kept clear of the mouth centre).
      for (const s of [-1, 1]) {
        rock(x + gx * M(6.6) * s + fx * M(0.5), z + gz * M(6.6) * s + fz * M(0.5), M(4.2), M(0.8), mossMat);
        rock(x + gx * M(5.0) * s - fx * M(3.5), z + gz * M(5.0) * s - fz * M(3.5), M(3.6), M(1.2), rockMat);
      }

      this.caveInterior.set(domeCx, y, domeCz);
      this.caveMouth.set(
        x + fx * M(4.5),
        beachHeight(x + fx * M(4.5), z + fz * M(4.5)),
        z + fz * M(4.5),
      );
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
