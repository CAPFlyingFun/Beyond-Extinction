import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { beachHeight, METERS_PER_UNIT } from "./beachTerrain";
import { loadModel } from "./assets";

/**
 * ARK-style sea life for the Chapter 2 ocean.
 *
 * A small roaming population of the five imported marine models — megalodon,
 * mosasaurus, ichthyosaurus, sarcosuchus, deinosuchus — that swim the open
 * water around the player. Each wanders to random deep-water targets, banks
 * into its turns with a gentle body sway, and holds a cruise depth below the
 * surface without clipping the seafloor. Any creature that drifts too far from
 * the player is recycled to a fresh spawn point ahead (population streaming),
 * so the sea always feels inhabited near you — the ARK "spawn around the
 * player" model — instead of simulating a fixed world-wide herd.
 *
 * Real GLBs (Draco-compressed, ~1.5-2.5 MB each) are preloaded once, then
 * cloned per creature via SkeletonUtils so instances share the loaded data.
 * The models carry no baked swim clip, so the swim is faked by translating the
 * whole body with a subtle tail sway / bank (bone undulation can come later).
 * If a model fails to load, loadModel() falls back to a procedural stand-in so
 * the ocean still populates.
 *
 * Self-contained: `const sea = new SeaCreatures(scene); await sea.preload();`
 * then `sea.update(dt, playerPos)` each frame and `sea.dispose()` on teardown.
 */

/** World units per metre (sizes/speeds authored in metres). */
const U = 1 / METERS_PER_UNIT;
const MODELS_DIR = "assets/models/sea";

export type SeaSpeciesId =
  | "megalodon"
  | "mosasaurus"
  | "ichthyosaurus"
  | "sarcosuchus"
  | "deinosuchus";

interface SeaSpecies {
  id: SeaSpeciesId;
  lengthM: number; // nose-to-tail, metres (model is scaled to this)
  /** Radians added to the model so its nose points +Z (swim-forward). TUNE visually. */
  modelYaw: number;
  color: number; // procedural-fallback body colour
  belly: number;
  speedM: number; // cruise speed, metres/sec
  turn: number; // max yaw rate, rad/sec
  cruiseDepthM: number; // preferred depth below the surface, metres
  swayAmp: number; // tail-sway yaw amplitude, radians
  swayHz: number; // tail-sway frequency
  bankAmp: number; // roll into turns, radians
  spawnWeight: number;
  girthM: number; // fallback body radius + seafloor clearance
}

const SPECIES: SeaSpecies[] = [
  { id: "megalodon", lengthM: 16, modelYaw: 0, color: 0x4a5a63, belly: 0xd7dde0, speedM: 5.5, turn: 0.5, cruiseDepthM: 7, swayAmp: 0.14, swayHz: 2.6, bankAmp: 0.5, spawnWeight: 2, girthM: 2.2 },
  { id: "mosasaurus", lengthM: 15, modelYaw: 0, color: 0x3f5647, belly: 0xcdd6c8, speedM: 4.8, turn: 0.55, cruiseDepthM: 5, swayAmp: 0.16, swayHz: 2.2, bankAmp: 0.55, spawnWeight: 2, girthM: 1.9 },
  { id: "ichthyosaurus", lengthM: 4, modelYaw: 0, color: 0x2f4a58, belly: 0xbfe0e6, speedM: 7.5, turn: 1.1, cruiseDepthM: 3, swayAmp: 0.2, swayHz: 4.5, bankAmp: 0.7, spawnWeight: 3, girthM: 0.6 },
  { id: "sarcosuchus", lengthM: 11, modelYaw: 0, color: 0x5a5140, belly: 0xcfc4a6, speedM: 3.6, turn: 0.7, cruiseDepthM: 2.5, swayAmp: 0.18, swayHz: 2.0, bankAmp: 0.35, spawnWeight: 2, girthM: 1.3 },
  { id: "deinosuchus", lengthM: 12, modelYaw: 0, color: 0x4c4a3a, belly: 0xc7c2a0, speedM: 3.8, turn: 0.65, cruiseDepthM: 2.5, swayAmp: 0.17, swayHz: 2.0, bankAmp: 0.35, spawnWeight: 2, girthM: 1.5 },
];

interface Creature {
  species: SeaSpecies;
  group: THREE.Group; // outer transform (world position + heading + bank + pitch)
  model: THREE.Object3D; // inner model, swayed relative to the group
  mixer: THREE.AnimationMixer | null; // drives a baked clip if the GLB has one
  heading: number; // yaw, radians
  speedU: number; // current speed, units/sec
  phase: number; // per-creature sway offset so they desync
  target: THREE.Vector3; // current wander goal (world)
  retargetIn: number; // seconds until a new goal is forced
  turnRoll: number; // smoothed bank amount, −1..1
}

export interface SeaCreaturesOptions {
  count?: number; // animals kept alive around the player
  rangeM?: number; // ring the population is kept within (metres)
  cullM?: number; // recycle a creature past this distance (metres)
  minDepthM?: number; // only spawn where water is at least this deep (metres)
}

export class SeaCreatures {
  private readonly root = new THREE.Group();
  private readonly creatures: Creature[] = [];
  private readonly templates = new Map<SeaSpeciesId, THREE.Object3D>();
  private readonly rng = mulberry32(0x5ea1e);
  private readonly count: number;
  private readonly rangeU: number;
  private readonly cullU: number;
  private readonly minDepthU: number;
  private ready = false;
  private elapsed = 0;

  constructor(scene: THREE.Scene, opts: SeaCreaturesOptions = {}) {
    this.count = opts.count ?? 6;
    this.rangeU = (opts.rangeM ?? 140) * U;
    this.cullU = (opts.cullM ?? 240) * U;
    this.minDepthU = (opts.minDepthM ?? 4) * U;
    this.root.name = "SeaCreatures";
    scene.add(this.root);
  }

  /** Preload + scale the five models once. Falls back to a procedural body per
   *  species if its GLB is missing. Safe to await before the ocean is entered. */
  async preload(): Promise<void> {
    await Promise.all(
      SPECIES.map(async (sp) => {
        const model = await loadModel(`${MODELS_DIR}/${sp.id}.glb`, () =>
          buildProceduralBody(sp),
        );
        this.fitModel(model, sp);
        this.templates.set(sp.id, model);
      }),
    );
    this.ready = true;
  }

  /** Seed the population around the player (call once preload() has resolved). */
  populate(playerPos: THREE.Vector3): void {
    if (!this.ready || this.creatures.length > 0) return;
    for (let i = 0; i < this.count; i++) {
      const c = this.build(this.pickSpecies());
      this.placeInOcean(c, playerPos, true);
      this.creatures.push(c);
      this.root.add(c.group);
    }
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    if (dt <= 0 || !this.ready) return;
    this.elapsed += dt;
    if (this.creatures.length === 0) this.populate(playerPos);

    for (const c of this.creatures) {
      if (dist2(c.group.position, playerPos) > this.cullU * this.cullU) {
        this.recycle(c, playerPos);
        continue;
      }
      // Rescue: anything that has ended up on/over the waterline (beached) jumps
      // straight back to deep water instead of sitting on the sand.
      if (-beachHeight(c.group.position.x, c.group.position.z) < 1.0 * U) {
        this.placeInOcean(c, playerPos, false);
        continue;
      }
      this.steer(c, dt);
      this.swim(c, dt);
      this.animate(c, dt);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry?.dispose();
    });
    this.creatures.length = 0;
    this.templates.clear();
  }

  // ── AI ──────────────────────────────────────────────────────────────────

  private steer(c: Creature, dt: number): void {
    c.retargetIn -= dt;
    const toX = c.target.x - c.group.position.x;
    const toZ = c.target.z - c.group.position.z;
    const flat = Math.hypot(toX, toZ);
    if (flat < c.species.lengthM * U || c.retargetIn <= 0) {
      this.retarget(c);
      return;
    }
    const want = Math.atan2(toX, toZ); // +Z forward
    let d = normAngle(want - c.heading);
    const max = c.species.turn * dt;
    const clamped = Math.max(-max, Math.min(max, d));
    c.heading += clamped;
    // Bank target: how hard we're turning, signed, normalised.
    const turnFrac = Math.max(-1, Math.min(1, clamped / Math.max(max, 1e-4)));
    c.turnRoll += (turnFrac - c.turnRoll) * Math.min(1, dt * 3);
    const straight = 1 - Math.min(1, Math.abs(turnFrac)) * 0.35;
    c.speedU = c.species.speedM * U * straight;
  }

  private swim(c: Creature, dt: number): void {
    const p = c.group.position;
    const nx = p.x + Math.sin(c.heading) * c.speedU * dt;
    const nz = p.z + Math.cos(c.heading) * c.speedU * dt;

    // Never swim into water too shallow to dive in (or onto the beach): if the
    // step ahead is shallower than our minimum depth, hold position, sheer away
    // from the shallows, and pick a fresh deep-water goal. Keeps them off land.
    if (-beachHeight(nx, nz) < this.minDepthU) {
      c.heading += Math.PI * 0.6;
      c.turnRoll = 0;
      this.retarget(c);
    } else {
      p.x = nx;
      p.z = nz;
    }

    const floor = beachHeight(p.x, p.z);
    const cruise = -c.species.cruiseDepthM * U;
    const clearance = c.species.girthM * U * 1.2;
    const surface = -0.6 * U; // hard cap: the body always stays under the waterline
    const prevY = p.y;
    const targetY = Math.min(surface, Math.max(cruise, floor + clearance));
    p.y += (targetY - p.y) * Math.min(1, dt * 2.5);

    c.group.rotation.y = c.heading;
    // Pitch toward the depth we're easing to; roll (bank) into turns.
    const climb = (p.y - prevY) / Math.max(dt, 1e-4);
    c.group.rotation.x = THREE.MathUtils.clamp(-climb * 0.03, -0.35, 0.35);
    c.group.rotation.z = -c.turnRoll * c.species.bankAmp;
  }

  /** Tail-sway on the inner model + advance any baked clip. */
  private animate(c: Creature, dt: number): void {
    if (c.mixer) c.mixer.update(dt);
    const sway = Math.sin(this.elapsed * c.species.swayHz + c.phase) * c.species.swayAmp;
    c.model.rotation.y = c.species.modelYaw + sway;
  }

  private retarget(c: Creature): void {
    const base = c.group.position;
    for (let tries = 0; tries < 10; tries++) {
      const ang = c.heading + (this.rng() - 0.5) * Math.PI * 1.2;
      const reach = (40 + this.rng() * 90) * U;
      const x = base.x + Math.sin(ang) * reach;
      const z = base.z + Math.cos(ang) * reach;
      if (-beachHeight(x, z) >= this.minDepthU) {
        c.target.set(x, 0, z);
        c.retargetIn = 4 + this.rng() * 6;
        return;
      }
    }
    // Boxed in by shallows — head back toward open sea (−Z is open ocean).
    c.target.set(base.x, 0, base.z - 120 * U);
    c.retargetIn = 3;
  }

  // ── spawning ────────────────────────────────────────────────────────────

  private recycle(c: Creature, playerPos: THREE.Vector3): void {
    const next = this.pickSpecies();
    if (next.id !== c.species.id) {
      this.root.remove(c.group);
      const fresh = this.build(next);
      c.species = fresh.species;
      c.group = fresh.group;
      c.model = fresh.model;
      c.mixer = fresh.mixer;
      this.root.add(c.group);
    }
    this.placeInOcean(c, playerPos, false);
  }

  private placeInOcean(c: Creature, playerPos: THREE.Vector3, initial: boolean): void {
    for (let tries = 0; tries < 40; tries++) {
      const ang = this.rng() * Math.PI * 2;
      // Area-uniform random point in the water disc around the focus (r ∝ √u so
      // they scatter evenly across the whole area, not bunched in a ring),
      // keeping a small inner gap so nothing pops in right on the camera/player.
      const rMin = initial ? 0.12 : 0.4;
      const r =
        Math.sqrt(rMin * rMin + this.rng() * (1 - rMin * rMin)) * this.rangeU;
      const x = playerPos.x + Math.sin(ang) * r;
      const z = playerPos.z + Math.cos(ang) * r;
      // Water only — never on/over land: reject anything shallower than the
      // minimum spawn depth and keep sampling.
      if (-beachHeight(x, z) < this.minDepthU) continue;
      c.group.position.set(x, -c.species.cruiseDepthM * U, z);
      c.heading = this.rng() * Math.PI * 2;
      c.group.rotation.set(0, c.heading, 0);
      c.speedU = c.species.speedM * U;
      c.turnRoll = 0;
      this.retarget(c);
      return;
    }
    // No deep water near the player — park it far below until they near water.
    c.group.position.set(playerPos.x, -400, playerPos.z);
  }

  private pickSpecies(): SeaSpecies {
    const total = SPECIES.reduce((s, sp) => s + sp.spawnWeight, 0);
    let r = this.rng() * total;
    for (const sp of SPECIES) {
      r -= sp.spawnWeight;
      if (r <= 0) return sp;
    }
    return SPECIES[0];
  }

  // ── model instancing ──────────────────────────────────────────────────────

  /** Scale a freshly loaded template to its species length and centre it. */
  private fitModel(model: THREE.Object3D, sp: SeaSpecies): void {
    model.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const longest = Math.max(size.x, size.y, size.z);
    if (longest > 1e-4) model.scale.setScalar((sp.lengthM * U) / longest);
    // Re-centre on the body so the group origin sits at the creature's middle.
    model.updateWorldMatrix(true, true);
    const c2 = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
    model.position.sub(c2);
  }

  private build(sp: SeaSpecies): Creature {
    const template = this.templates.get(sp.id);
    const model = template ? cloneSkinned(template) : buildProceduralBody(sp);
    model.rotation.y = sp.modelYaw;

    const group = new THREE.Group();
    group.name = sp.id;
    group.rotation.order = "YXZ";
    group.add(model);

    let mixer: THREE.AnimationMixer | null = null;
    const clips = (template?.animations ?? []) as THREE.AnimationClip[];
    if (clips.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(clips[0]).play();
    }

    return {
      species: sp,
      group,
      model,
      mixer,
      heading: 0,
      speedU: sp.speedM * U,
      phase: this.rng() * Math.PI * 2,
      target: new THREE.Vector3(),
      retargetIn: 0,
      turnRoll: 0,
    };
  }
}

// ── procedural fallback body (used only if a GLB fails to load) ───────────────

function buildProceduralBody(sp: SeaSpecies): THREE.Object3D {
  const group = new THREE.Group();
  const len = sp.lengthM * U;
  const girth = sp.girthM * U;
  const body = new THREE.MeshStandardMaterial({ color: sp.color, roughness: 0.72 });
  const belly = new THREE.MeshStandardMaterial({ color: sp.belly, roughness: 0.72 });

  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(girth, len * 0.7, 6, 12), body);
  hull.rotation.x = Math.PI / 2;
  group.add(hull);
  const under = new THREE.Mesh(new THREE.CapsuleGeometry(girth * 0.92, len * 0.66, 4, 10), belly);
  under.rotation.x = Math.PI / 2;
  under.position.y = -girth * 0.18;
  group.add(under);
  const fluke = new THREE.Mesh(new THREE.ConeGeometry(girth * 1.6, len * 0.22, 4), body);
  fluke.scale.set(0.12, 1, 1);
  fluke.rotation.x = Math.PI / 2;
  fluke.position.z = -len * 0.5;
  group.add(fluke);
  return group;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function dist2(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Small deterministic PRNG so spawns are stable across reloads. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
