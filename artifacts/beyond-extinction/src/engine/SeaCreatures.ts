import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { beachHeight, METERS_PER_UNIT } from "./beachTerrain";
import { loadModel } from "./assets";

/**
 * Island fauna for the Chapter 2 ocean & shoreline — a port of the Godot
 * creature AI (Dinos/sea_ai.gd + Dinos/dino_ai.gd) to Three.js.
 *
 * Two brains dispatched by habitat:
 *   • "sea"        — Megalodon / Mosasaurus / Ichthyosaurus glide FREELY through
 *                    the water volume (cruise → investigate → lunge), holding a
 *                    depth band between the surface and the seabed, banking into
 *                    turns, and circling / biting a swimming player.
 *   • "amphibious" — Sarcosuchus / Deinosuchus walk the terrain (idle → wander →
 *                    chase → attack → flee), crossing the waterline freely as
 *                    shallow ambush lurkers: they follow beachHeight on land and
 *                    the seabed alike and never enter the free-swim state.
 *
 * A small population is streamed around a focus point (the player in gameplay,
 * the flyover camera during the arrival cinematic): anything that drifts past
 * the cull distance recycles to a fresh spawn ahead, so the world stays
 * inhabited near you without simulating a fixed global herd.
 *
 * Real GLBs are preloaded once and cloned per creature via SkeletonUtils; a
 * procedural body stands in if a model fails to load. Models carry no baked
 * locomotion clip yet, so motion is procedural (body translation + tail sway);
 * the jaws are modelled open on purpose so a future jaw clip can drive them.
 *
 * Config numbers are ported straight from SeaConfig / DinoConfig. Depths use the
 * live terrain (beachHeight) as the floor instead of Godot's fixed −60 m plane,
 * so creatures adapt to however deep this ocean actually is.
 */

/** World units per metre (all config authored in metres). */
const U = 1 / METERS_PER_UNIT;
const MODELS_DIR = "assets/models/sea";

export type SeaSpeciesId =
  | "megalodon"
  | "mosasaurus"
  | "ichthyosaurus"
  | "sarcosuchus"
  | "deinosuchus";

type Habitat = "sea" | "amphibious";
type SeaAggression = "ambient" | "curious" | "aggressive";
type LandTemperament = "neutral" | "aggressive" | "skittish" | "passive";

/** Free-swimming water brain tuning (SeaConfig). Distances/speeds in metres. */
interface SeaBrainCfg {
  cruiseSpeed: number;
  chaseSpeed: number;
  turn: number; // rad/s heading agility
  bankMax: number; // roll into hard turns, rad
  bandTop: number; // shallowest comfortable depth (Y, negative m)
  bandBottom: number; // deepest comfortable depth
  surfaceMargin: number; // never rise closer than this to the surface
  floorMargin: number; // never sink closer than this to the seabed
  idleWobble: number;
  aggression: SeaAggression;
  sight: number; // notices a swimming player within this (3D m)
  orbitRadius: number; // stand-off distance while investigating
  attackRange: number;
  biteDamage: number;
  biteCooldown: number;
  circleBeforeLunge: number;
  homeRadius: number; // patrol radius around spawn
  wanderReach: number;
}

/** Amphibious land brain tuning (DinoConfig, habitat "amphibious"). */
interface LandBrainCfg {
  temperament: LandTemperament;
  maxHealth: number;
  sight: number; // once locked, keeps tracking a target out to this (metres)
  attackRange: number;
  fovDeg: number;
  damage: number;
  cooldown: number;
  strikeAt: number; // seconds into the bite the hit lands
  wanderSpeed: number;
  chaseSpeed: number;
  turnSpeed: number; // rad/s yaw slew
  leash: number; // roam radius around home
  giveUp: number; // lose the target past sight/leash + this
  fleeHealth: number; // flee below this fraction of maxHealth (0 = never)
  standM: number; // body height (metres) — water-probe reference
  maxWadeM: number; // wander no deeper than this (metres); chase ignores it
}

interface Species {
  id: SeaSpeciesId;
  habitat: Habitat;
  lengthM: number; // nose-to-tail (model scaled to this)
  modelYaw: number; // radians added so the nose points +Z (swim/walk forward)
  color: number; // procedural-fallback body colour
  belly: number;
  girthM: number; // fallback radius + seafloor clearance
  spawnWeight: number;
  sea?: SeaBrainCfg;
  land?: LandBrainCfg;
}

// ── species table (ported SeaConfig + DinoConfig) ────────────────────────────

const SPECIES: Species[] = [
  {
    id: "megalodon",
    habitat: "sea",
    lengthM: 16,
    modelYaw: 0,
    color: 0x4a5a63,
    belly: 0xd7dde0,
    girthM: 2.2,
    spawnWeight: 2,
    sea: {
      cruiseSpeed: 4.0, chaseSpeed: 9.5, turn: 1.1, bankMax: 0.7,
      bandTop: -8, bandBottom: -46, surfaceMargin: 2, floorMargin: 4,
      idleWobble: 0.6, aggression: "aggressive", sight: 60, orbitRadius: 18,
      attackRange: 6.5, biteDamage: 34, biteCooldown: 6, circleBeforeLunge: 3.5,
      homeRadius: 120, wanderReach: 7,
    },
  },
  {
    id: "mosasaurus",
    habitat: "sea",
    lengthM: 15,
    modelYaw: 0,
    color: 0x3f5647,
    belly: 0xcdd6c8,
    girthM: 1.9,
    spawnWeight: 2,
    sea: {
      cruiseSpeed: 4.5, chaseSpeed: 10, turn: 1.35, bankMax: 0.7,
      bandTop: -6, bandBottom: -48, surfaceMargin: 2, floorMargin: 4,
      idleWobble: 0.7, aggression: "aggressive", sight: 60, orbitRadius: 16,
      attackRange: 6, biteDamage: 30, biteCooldown: 5.5, circleBeforeLunge: 3,
      homeRadius: 120, wanderReach: 7,
    },
  },
  {
    id: "ichthyosaurus",
    habitat: "sea",
    lengthM: 4,
    modelYaw: 0,
    color: 0x2f4a58,
    belly: 0xbfe0e6,
    girthM: 0.6,
    spawnWeight: 3,
    sea: {
      cruiseSpeed: 5.5, chaseSpeed: 8, turn: 2.4, bankMax: 0.8,
      bandTop: -2.5, bandBottom: -18, surfaceMargin: 1.5, floorMargin: 4,
      idleWobble: 0.8, aggression: "curious", sight: 40, orbitRadius: 9,
      attackRange: 4, biteDamage: 8, biteCooldown: 6, circleBeforeLunge: 3,
      homeRadius: 120, wanderReach: 7,
    },
  },
  {
    id: "sarcosuchus",
    habitat: "amphibious",
    lengthM: 11,
    modelYaw: 0,
    color: 0x5a5140,
    belly: 0xcfc4a6,
    girthM: 1.3,
    spawnWeight: 2,
    land: {
      // Notice range is now stance-driven (FaunaPlayer.noticeRange); sight is the
      // lock-tracking range once it's chasing you.
      temperament: "neutral", maxHealth: 300, sight: 60,
      attackRange: 4.5, fovDeg: 210, damage: 28, cooldown: 2.2, strikeAt: 0.4,
      wanderSpeed: 1.2, chaseSpeed: 6.0, turnSpeed: 4.0, leash: 70, giveUp: 40,
      fleeHealth: 0, standM: 1.3, maxWadeM: 3,
    },
  },
  {
    id: "deinosuchus",
    habitat: "amphibious",
    lengthM: 12,
    modelYaw: 0,
    color: 0x4c4a3a,
    belly: 0xc7c2a0,
    girthM: 1.5,
    spawnWeight: 2,
    land: {
      // Notice range is stance-driven (FaunaPlayer.noticeRange); sight is the
      // lock-tracking range once it's charging you.
      temperament: "aggressive", maxHealth: 420, sight: 60,
      attackRange: 5.0, fovDeg: 210, damage: 38, cooldown: 2.4, strikeAt: 0.4,
      wanderSpeed: 1.1, chaseSpeed: 5.6, turnSpeed: 3.6, leash: 70, giveUp: 40,
      fleeHealth: 0, standM: 1.6, maxWadeM: 3,
    },
  },
];

// ── sea-brain states ─────────────────────────────────────────────────────────
const SEA_CRUISE = 0;
const SEA_INVESTIGATE = 1;
const SEA_LUNGE = 2;
// ── land-brain states ────────────────────────────────────────────────────────
const LAND_IDLE = 0;
const LAND_WANDER = 1;
const LAND_CHASE = 2;
const LAND_ATTACK = 3;
const LAND_FLEE = 4;
const LAND_BASK = 5; // mouth-open rest — the passive-tame feed window

const SEA_THINK_DT = 0.2;
const LAND_THINK_DT = 0.15;
const WANDER_TIMEOUT = 8.0;
const REPROVOKE = 6.0;

// Passive taming (ARK-Additions Deinosuchus style: bask → feed → snap hostile).
const BASK_DUR = 13; // seconds a croc lies basking (feedable)
const BASK_CD = 9; // cooldown after a bask before it can bask again
const FEED_WINDOW = 4; // seconds of eating after a feed, then it turns hostile
const AGITATED_DUR = 6; // seconds it's aggressive right after finishing a feed
const FEED_STEP = 20; // tame % gained per feed (5 feeds = tamed)

/** Display name for a species id. */
function speciesName(id: SeaSpeciesId): string {
  switch (id) {
    case "megalodon": return "Megalodon";
    case "mosasaurus": return "Mosasaurus";
    case "ichthyosaurus": return "Ichthyosaurus";
    case "sarcosuchus": return "Sarcosuchus";
    case "deinosuchus": return "Deinosuchus";
  }
}

interface Creature {
  species: Species;
  group: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
  phase: number;
  home: THREE.Vector3;
  wanderPt: THREE.Vector3;
  // shared FSM
  state: number;
  stateT: number;
  thinkAcc: number;
  hasTarget: boolean;
  parked: boolean; // placement found no valid ground/water — retry next frame
  // sea brain
  heading: THREE.Vector3; // 3D unit swim direction
  prevHeading: THREE.Vector3;
  bank: number;
  circleDir: number;
  biteCd: number;
  peelT: number;
  // land brain
  yaw: number;
  health: number;
  attackCd: number;
  biting: boolean;
  biteT: number;
  biteHit: boolean;
  threatened: boolean;
  provokedT: number;
  idleHold: number;
  chaseBestD: number;
  chaseStall: number;
  // passive taming
  tamePct: number;
  tamed: boolean;
  basking: boolean;
  baskTimer: number;
  baskCd: number;
  feedWindow: number;
  agitated: number;
  // tracking / persistence
  id: number;
  tracked: boolean;
  // debug
  label?: THREE.Sprite;
  labelText?: string;
}

/** The player as a target for the fauna (undefined = nobody to chase/bite). */
export interface FaunaPlayer {
  /** Player world position (units). */
  pos: THREE.Vector3;
  /** Is the player currently in the water? (sea creatures only chase in water) */
  inWater: boolean;
  /** May creatures target and bite the player right now? (false in cinematics) */
  vulnerable: boolean;
  /**
   * Metres at which creatures first notice the player — driven by stance so
   * stealth matters: running ~100, walking ~50, crouching ~30, crawling ~10.
   * Land crocs use it directly as their aggro range; sea creatures scale their
   * sight by noticeRange/50.
   */
  noticeRange: number;
}

export interface SeaCreaturesOptions {
  count?: number; // animals kept alive around the focus
  rangeM?: number; // ring the population is kept within
  cullM?: number; // recycle past this distance
  minDepthM?: number; // sea creatures only spawn where water is at least this deep
  /** Called when a creature's bite connects with the player. */
  onBitePlayer?: (damage: number, species: SeaSpeciesId) => void;
  /** Called when a croc's passive tame completes. */
  onTamed?: (name: string) => void;
  /** Float a state label over each creature (testing aid until animations land). */
  debug?: boolean;
  /** Camera, so debug/tracked labels can hold a fixed on-screen size. */
  camera?: THREE.Camera;
}

/** Persisted state for a tracked/tamed creature (save & resume). */
export interface FaunaSaveEntry {
  species: SeaSpeciesId;
  x: number;
  z: number;
  yaw: number;
  tamePct: number;
  tamed: boolean;
  tracked: boolean;
}

export class SeaCreatures {
  private readonly root = new THREE.Group();
  private readonly creatures: Creature[] = [];
  private readonly templates = new Map<SeaSpeciesId, THREE.Object3D>();
  /** Half the fitted body height per species — lifts land walkers onto the ground. */
  private readonly halfH = new Map<SeaSpeciesId, number>();
  private readonly rng = mulberry32(0x5ea1e);
  private readonly count: number;
  private readonly rangeU: number;
  private readonly cullU: number;
  private readonly minDepthU: number;
  private readonly onBitePlayer?: (d: number, s: SeaSpeciesId) => void;
  private readonly onTamed?: (name: string) => void;
  private readonly debug: boolean;
  private readonly camera?: THREE.Camera;
  private nextId = 1;
  private pendingRestore: FaunaSaveEntry[] | null = null;
  private ready = false;
  private elapsed = 0;

  constructor(scene: THREE.Scene, opts: SeaCreaturesOptions = {}) {
    this.count = opts.count ?? 6;
    this.rangeU = (opts.rangeM ?? 140) * U;
    this.cullU = (opts.cullM ?? 240) * U;
    this.minDepthU = (opts.minDepthM ?? 4) * U;
    this.onBitePlayer = opts.onBitePlayer;
    this.onTamed = opts.onTamed;
    this.debug = opts.debug ?? false;
    this.camera = opts.camera;
    this.root.name = "SeaCreatures";
    scene.add(this.root);
  }

  /** Preload + scale the five models once (procedural fallback per species). */
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

  /** Seed the population around the focus point (once preload has resolved). */
  private populate(focus: THREE.Vector3): void {
    if (!this.ready || this.creatures.length > 0) return;
    for (let i = 0; i < this.count; i++) {
      const c = this.build(this.pickSpecies());
      this.place(c, focus, true);
      this.creatures.push(c);
      this.root.add(c.group);
    }
  }

  /**
   * Advance the population one frame.
   * @param dt     delta seconds
   * @param focus  streaming centre (player in play, flyover camera in cinematic)
   * @param player optional bite target (omit during cinematics)
   */
  update(dt: number, focus: THREE.Vector3, player?: FaunaPlayer): void {
    if (dt <= 0 || !this.ready) return;
    this.elapsed += dt;
    if (this.pendingRestore) {
      this.applyRestore(this.pendingRestore);
      this.pendingRestore = null;
    }
    if (this.creatures.length === 0) this.populate(focus);

    for (const c of this.creatures) {
      // Stream: anything past the cull radius recycles to a fresh spawn ahead.
      // Tamed and tracked creatures are pinned — they persist where they are.
      if (
        !c.parked &&
        !c.tamed &&
        !c.tracked &&
        dist2(c.group.position, focus) > this.cullU * this.cullU
      ) {
        this.recycle(c, focus);
        continue;
      }
      // Parked (no valid ground/water near the last focus, e.g. a shore creature
      // during the offshore flyover): keep retrying placement as the focus moves,
      // and stay hidden until it lands somewhere valid.
      if (c.parked) {
        this.place(c, focus, false);
        if (c.parked) continue;
      }
      if (c.species.habitat === "sea") this.updateSea(c, dt, player);
      else this.updateLand(c, dt, player);
      if (this.debug || c.tracked) this.updateLabel(c);
      else if (c.label) c.label.visible = false;
    }
  }

  // ── debug state labels ─────────────────────────────────────────────────────

  private updateLabel(c: Creature): void {
    // Created lazily (never in build(), which would leak a stray label on
    // recycle) so it persists on the reused creature object.
    if (!c.label) {
      c.label = this.makeLabel();
      this.root.add(c.label);
    }
    const s = c.label;
    if (c.parked) {
      s.visible = false;
      return;
    }
    s.visible = true;
    const top = (this.halfH.get(c.species.id) ?? 1) * 2 + 3 * U;
    s.position.set(c.group.position.x, c.group.position.y + top, c.group.position.z);
    // Fixed on-screen size: scale the sprite proportional to camera distance so
    // it doesn't shrink/grow as you move (canvas is 320×72 → keep that aspect).
    const dist = this.camera ? this.camera.position.distanceTo(s.position) : 40;
    const w = 0.34 * Math.max(dist, 6);
    s.scale.set(w, w * (72 / 320), 1);
    // A tracked label wears a 🎯 marker so you can pick it out of the pack.
    const { text, color } = this.labelFor(c);
    this.setLabel(c, c.tracked ? `🎯 ${text}` : text, color);
  }

  private labelFor(c: Creature): { text: string; color: string } {
    if (c.species.habitat === "sea") {
      const name = ["CRUISE", "INVESTIGATE", "LUNGE"][c.state] ?? "?";
      const color =
        c.state === SEA_LUNGE ? "#ff8b6b" : c.state === SEA_INVESTIGATE ? "#ffd98f" : "#9fe0ff";
      return { text: `${c.species.id} · ${name}`, color };
    }
    if (c.tamed) return { text: `${c.species.id} · TAMED`, color: "#7dffb0" };
    if (c.feedWindow > 0)
      return { text: `${c.species.id} · EATING ${Math.round(c.tamePct)}%`, color: "#ffd98f" };
    if (c.agitated > 0)
      return { text: `${c.species.id} · AGITATED ${Math.round(c.tamePct)}%`, color: "#ff6b6b" };
    const name = ["IDLE", "WANDER", "CHASE", "ATTACK", "FLEE", "BASK"][c.state] ?? "?";
    const color =
      c.state === LAND_ATTACK || c.state === LAND_CHASE
        ? "#ff8b6b"
        : c.state === LAND_BASK
          ? "#7dffb0"
          : "#cfe8ff";
    return { text: `${c.species.id} · ${name} ${Math.round(c.tamePct)}%`, color };
  }

  private makeLabel(): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 72;
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const s = new THREE.Sprite(mat);
    s.scale.set(11, 2.5, 1);
    s.renderOrder = 999;
    s.userData.canvas = canvas;
    return s;
  }

  private setLabel(c: Creature, text: string, color: string): void {
    if (c.labelText === text) return;
    c.labelText = text;
    const s = c.label!;
    const canvas = s.userData.canvas as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(8,14,22,0.72)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 34px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    (s.material.map as THREE.CanvasTexture).needsUpdate = true;
  }

  dispose(): void {
    for (const c of this.creatures) {
      c.mixer?.stopAllAction();
      c.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry?.dispose();
      });
      c.label?.material.map?.dispose();
      c.label?.material.dispose();
    }
    this.root.removeFromParent();
    this.creatures.length = 0;
    this.templates.clear();
  }

  // ── passive taming (public API for the scene's Feed action) ────────────────

  private nearestFeedable(pos: THREE.Vector3, rangeM: number): Creature | null {
    const r = rangeM * U;
    let best: Creature | null = null;
    let bestD = Infinity;
    for (const c of this.creatures) {
      if (c.species.habitat !== "amphibious") continue;
      if (c.tamed || c.parked || !c.basking || c.feedWindow > 0 || c.agitated > 0) continue;
      const d = c.group.position.distanceTo(pos);
      if (d <= r && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /** Nearest croc that's basking and feedable within `rangeM` of `pos`, or null.
   *  Drives the on-screen Feed prompt. */
  feedTarget(pos: THREE.Vector3, rangeM: number): { name: string; tamePct: number } | null {
    const c = this.nearestFeedable(pos, rangeM);
    return c ? { name: speciesName(c.species.id), tamePct: Math.round(c.tamePct) } : null;
  }

  /** Feed the nearest feedable croc: bumps its tame meter and opens the ~4 s
   *  window before it snaps hostile (or friendly, if this completes the tame).
   *  Returns the fed creature's new state, or null if nothing was feedable. */
  feed(pos: THREE.Vector3, rangeM: number): { name: string; tamePct: number } | null {
    const c = this.nearestFeedable(pos, rangeM);
    if (!c) return null;
    c.tamePct = Math.min(100, c.tamePct + FEED_STEP);
    c.feedWindow = FEED_WINDOW;
    return { name: speciesName(c.species.id), tamePct: Math.round(c.tamePct) };
  }

  // ── tracking + persistence ─────────────────────────────────────────────────

  /** Toggle tracking on the creature under the crosshair ray (origin+dir), or
   *  null if the ray misses. Tracked creatures show a label + are never culled. */
  trackUnderRay(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxM = 140,
  ): { name: string; tracked: boolean } | null {
    const d = dir.clone().normalize();
    const oc = new THREE.Vector3();
    let best: Creature | null = null;
    let bestT = Infinity;
    for (const c of this.creatures) {
      if (c.parked) continue;
      const radius = c.species.lengthM * U * 0.55; // generous body sphere
      oc.copy(c.group.position).sub(origin);
      const t = oc.dot(d); // distance along the ray to the closest point
      if (t < 0 || t > maxM * U) continue;
      const perp2 = oc.lengthSq() - t * t; // squared miss distance
      if (perp2 <= radius * radius && t < bestT) {
        bestT = t;
        best = c;
      }
    }
    if (!best) return null;
    best.tracked = !best.tracked;
    return { name: speciesName(best.species.id), tracked: best.tracked };
  }

  /** Snapshot every tracked or tamed creature for the save file. */
  serialize(): FaunaSaveEntry[] {
    const out: FaunaSaveEntry[] = [];
    for (const c of this.creatures) {
      if (!c.tracked && !c.tamed) continue;
      out.push({
        species: c.species.id,
        x: c.group.position.x,
        z: c.group.position.z,
        yaw: c.species.habitat === "sea" ? Math.atan2(c.heading.x, c.heading.z) : c.yaw,
        tamePct: c.tamePct,
        tamed: c.tamed,
        tracked: c.tracked,
      });
    }
    return out;
  }

  /** Queue saved tracked/tamed creatures to respawn once models are loaded. */
  restore(list: FaunaSaveEntry[]): void {
    if (list && list.length) this.pendingRestore = list;
  }

  private applyRestore(list: FaunaSaveEntry[]): void {
    for (const e of list) {
      const sp = SPECIES.find((s) => s.id === e.species);
      if (!sp) continue;
      const c = this.build(sp);
      c.group.position.set(e.x, 0, e.z);
      c.home.set(e.x, 0, e.z);
      c.tamePct = e.tamePct;
      c.tamed = e.tamed;
      c.tracked = e.tracked;
      if (sp.habitat === "sea") {
        c.heading.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
        c.prevHeading.copy(c.heading);
        c.group.position.y = sp.sea!.bandTop * U;
        this.pickWanderSea(c);
      } else {
        c.yaw = e.yaw;
        this.pickWanderLand(c);
      }
      this.creatures.push(c);
      this.root.add(c.group);
    }
  }

  // ── SEA brain (free-swimming) ──────────────────────────────────────────────

  private updateSea(c: Creature, dt: number, player?: FaunaPlayer): void {
    c.stateT += dt;
    c.biteCd = Math.max(0, c.biteCd - dt);
    if (c.peelT > 0) c.peelT -= dt;

    c.thinkAcc += dt;
    if (c.thinkAcc >= SEA_THINK_DT) {
      c.thinkAcc = 0;
      this.thinkSea(c, player);
    }
    this.swimSea(c, dt, player);
  }

  private thinkSea(c: Creature, player?: FaunaPlayer): void {
    const cfg = c.species.sea!;
    const canSee =
      !!player &&
      player.vulnerable &&
      player.inWater &&
      cfg.aggression !== "ambient" &&
      c.group.position.distanceTo(player.pos) <= cfg.sight * (player.noticeRange / 50);
    switch (c.state) {
      case SEA_CRUISE:
        if (canSee) {
          c.hasTarget = true;
          c.circleDir = this.rng() < 0.5 ? 1 : -1;
          this.enter(c, SEA_INVESTIGATE);
        }
        break;
      case SEA_INVESTIGATE:
        if (!this.stillInterested(c, player)) {
          c.hasTarget = false;
          this.enter(c, SEA_CRUISE);
        } else if (
          cfg.aggression === "aggressive" &&
          c.biteCd <= 0 &&
          c.stateT > cfg.circleBeforeLunge
        ) {
          this.enter(c, SEA_LUNGE);
        }
        break;
      case SEA_LUNGE:
        if (!this.stillInterested(c, player)) {
          c.hasTarget = false;
          this.enter(c, SEA_CRUISE);
        }
        break;
    }
  }

  private stillInterested(c: Creature, player?: FaunaPlayer): boolean {
    if (!player || !player.vulnerable || !player.inWater) return false;
    const sight = c.species.sea!.sight * (player.noticeRange / 50);
    return c.group.position.distanceTo(player.pos) <= sight * 1.3;
  }

  private swimSea(c: Creature, dt: number, player?: FaunaPlayer): void {
    const cfg = c.species.sea!;
    const p = c.group.position;
    let speed = cfg.cruiseSpeed * U;
    let desired: THREE.Vector3;

    switch (c.state) {
      case SEA_INVESTIGATE:
        desired = this.steerInvestigate(c, player);
        break;
      case SEA_LUNGE:
        desired = this.steerLunge(c, player);
        speed = cfg.chaseSpeed * U;
        break;
      default:
        desired = this.steerCruise(c);
        break;
    }

    desired
      .add(this.verticalCorrection(c))
      .add(this.edgeCorrection(c));
    desired.y += Math.sin(this.elapsed * 1.3 + c.phase) * 0.05 * cfg.idleWobble;
    if (desired.lengthSq() < 1e-6) desired.copy(c.heading);
    desired.normalize();

    rotateTowards(c.heading, desired, cfg.turn * dt);

    // Cap the pitch: a deep-band creature stuck in shallow shore water would
    // otherwise keep steering straight down (heading.y → -1) and stand on its
    // nose (the "megalodon facing up"). Real fish never swim near-vertical — hold
    // the body within ~28° of level and let the y-clamp handle the rest.
    const maxPitchSin = 0.47; // sin(~28°)
    if (Math.abs(c.heading.y) > maxPitchSin) {
      c.heading.y = Math.sign(c.heading.y) * maxPitchSin;
      c.heading.normalize();
    }

    // Advance — but never step the body into water too shallow to swim in. The
    // player wades at the shoreline, so a chasing shark would otherwise beach
    // itself: block the horizontal step over shallows and sheer away, keeping
    // the vertical component so it can still rise/dive.
    const step = speed * dt;
    const nx = p.x + c.heading.x * step;
    const nz = p.z + c.heading.z * step;
    if (-beachHeight(nx, nz) < this.minDepthU) {
      c.heading.x = -c.heading.x;
      c.heading.z = -c.heading.z;
    } else {
      p.x = nx;
      p.z = nz;
    }
    p.y += c.heading.y * step;

    // Hard-clamp inside the water column: just under the surface, clear of the
    // live seabed (beachHeight), so it never breaches or clips the floor.
    const surfaceY = -cfg.surfaceMargin * U;
    const floorY = beachHeight(p.x, p.z) + (cfg.floorMargin + c.species.girthM) * U;
    p.y = clamp(p.y, Math.min(floorY, surfaceY), surfaceY);

    this.orientSea(c, dt);
    this.animateBody(c, dt);
  }

  private steerCruise(c: Creature): THREE.Vector3 {
    const cfg = c.species.sea!;
    const to = c.wanderPt.clone().sub(c.group.position);
    if (to.length() < cfg.wanderReach * U) {
      this.pickWanderSea(c);
      to.copy(c.wanderPt).sub(c.group.position);
    }
    return to.lengthSq() > 1e-6 ? to.normalize() : c.heading.clone();
  }

  private steerInvestigate(c: Creature, player?: FaunaPlayer): THREE.Vector3 {
    const cfg = c.species.sea!;
    if (!player) return c.heading.clone();
    const toP = player.pos.clone().sub(c.group.position);
    const flat = new THREE.Vector3(toP.x, 0, toP.z);
    const dist = flat.length();
    if (c.peelT > 0 || dist < 0.01) {
      return toP.lengthSq() > 1e-6 ? toP.normalize().multiplyScalar(-1) : c.heading.clone();
    }
    const orbit = cfg.orbitRadius * U;
    const dirFlat = flat.clone().divideScalar(dist);
    const tangent = new THREE.Vector3(-dirFlat.z, 0, dirFlat.x).multiplyScalar(c.circleDir);
    let radial = 0;
    if (dist > orbit * 1.25) radial = 1;
    else if (dist < orbit * 0.75) radial = -1;
    const horiz = tangent.add(dirFlat.multiplyScalar(radial)).normalize();
    const dy = clamp(player.pos.y - c.group.position.y, -0.6 * U, 0.6 * U);
    return horiz.add(new THREE.Vector3(0, dy, 0)).normalize();
  }

  private steerLunge(c: Creature, player?: FaunaPlayer): THREE.Vector3 {
    const cfg = c.species.sea!;
    if (!player) return c.heading.clone();
    const toP = player.pos.clone().sub(c.group.position);
    if (toP.length() <= cfg.attackRange * U) {
      this.onBitePlayer?.(cfg.biteDamage, c.species.id);
      c.biteCd = cfg.biteCooldown;
      c.peelT = 1.2;
      this.enter(c, SEA_INVESTIGATE);
      return toP.lengthSq() > 1e-6 ? toP.normalize().multiplyScalar(-1) : c.heading.clone();
    }
    return toP.normalize();
  }

  /** Pull back toward the comfortable depth band (0 while inside it). */
  private verticalCorrection(c: Creature): THREE.Vector3 {
    const cfg = c.species.sea!;
    const y = c.group.position.y;
    const top = cfg.bandTop * U; // shallowest (less negative)
    // Never aim deeper than the live seabed clearance.
    const floor = beachHeight(c.group.position.x, c.group.position.z) +
      (cfg.floorMargin + c.species.girthM) * U;
    const bottom = Math.max(cfg.bandBottom * U, floor);
    if (y > top) return new THREE.Vector3(0, -1, 0).multiplyScalar(clamp((y - top) / (6 * U), 0.2, 1.5));
    if (y < bottom) return new THREE.Vector3(0, 1, 0).multiplyScalar(clamp((bottom - y) / (6 * U), 0.2, 1.5));
    return new THREE.Vector3();
  }

  /** Steer back toward home past the patrol radius (horizontal only). */
  private edgeCorrection(c: Creature): THREE.Vector3 {
    const cfg = c.species.sea!;
    const flat = new THREE.Vector3(
      c.group.position.x - c.home.x, 0, c.group.position.z - c.home.z,
    );
    const r = cfg.homeRadius * U;
    if (flat.length() <= r) return new THREE.Vector3();
    return flat.normalize().multiplyScalar(-clamp((flat.length() - r) / (20 * U), 0.3, 2.0));
  }

  private orientSea(c: Creature, dt: number): void {
    if (c.heading.lengthSq() < 1e-6) return;
    // Signed horizontal turn since last frame → roll into it.
    const a = new THREE.Vector2(c.prevHeading.x, c.prevHeading.z);
    const b = new THREE.Vector2(c.heading.x, c.heading.z);
    let targetBank = 0;
    if (a.lengthSq() > 1e-6 && b.lengthSq() > 1e-6) {
      a.normalize();
      b.normalize();
      const cross = a.x * b.y - a.y * b.x;
      targetBank = clamp(-cross * 14, -1, 1) * c.species.sea!.bankMax;
    }
    c.prevHeading.copy(c.heading);
    c.bank += (targetBank - c.bank) * clamp(dt * 4, 0, 1);

    const h = c.heading;
    const yaw = Math.atan2(h.x, h.z); // +Z forward
    const pitch = Math.asin(clamp(h.y, -1, 1));
    c.group.rotation.set(pitch, yaw, -c.bank);
  }

  // ── LAND brain (amphibious walker) ─────────────────────────────────────────

  private updateLand(c: Creature, dt: number, player?: FaunaPlayer): void {
    c.stateT += dt;
    c.attackCd = Math.max(0, c.attackCd - dt);
    if (c.provokedT > 0) c.provokedT -= dt;
    if (c.baskCd > 0) c.baskCd -= dt;
    if (c.agitated > 0) c.agitated -= dt;

    // Feeding window: while eating after a passive feed the croc is occupied and
    // harmless; when it finishes it either finalises the tame (turns friendly)
    // or snaps its jaws shut and turns hostile — the cue to have backed away.
    if (c.feedWindow > 0) {
      c.feedWindow -= dt;
      if (c.feedWindow <= 0) {
        c.basking = false;
        if (c.tamePct >= 100) {
          c.tamed = true;
          this.onTamed?.(speciesName(c.species.id));
          this.enter(c, LAND_IDLE);
        } else {
          c.agitated = AGITATED_DUR; // now hostile — run!
          this.enter(c, LAND_WANDER);
        }
      }
      this.groundLand(c); // jaws working, body still
      this.animateBody(c, dt);
      return;
    }

    c.thinkAcc += dt;
    if (c.thinkAcc >= LAND_THINK_DT) {
      c.thinkAcc = 0;
      if (c.state !== LAND_ATTACK || !c.biting) this.thinkLand(c, player);
    }
    this.moveLand(c, dt, player);
    this.updateBite(c, dt, player);
    this.groundLand(c);
    this.animateBody(c, dt);
  }

  /** Snap the body belly-down onto the terrain and face the current yaw.
   *  Amphibious: no gravity/jump — the half-height lifts the recentred body
   *  onto the ground so it follows slopes and the seabed alike. */
  private groundLand(c: Creature): void {
    const g = beachHeight(c.group.position.x, c.group.position.z);
    c.group.position.y = g + (this.halfH.get(c.species.id) ?? 0);
    c.group.rotation.set(0, c.yaw, 0);
  }

  private thinkLand(c: Creature, player?: FaunaPlayer): void {
    const cfg = c.species.land!;
    // Tamed: peaceful — never targets the player, just roams.
    if (c.tamed) {
      this.loseAndRoam(c);
      return;
    }
    // Agitated right after a feed: aggressive regardless of temperament.
    if (c.agitated > 0) {
      if (player && player.vulnerable) this.engageLand(c, player);
      else this.loseAndRoam(c);
      return;
    }
    // Basking (mouth-open rest = the feed window): ignore the player, hold still.
    if (c.basking) return;
    // Low-health flee (crocs have fleeHealth 0 → never).
    if (cfg.fleeHealth > 0 && c.health < cfg.fleeHealth * cfg.maxHealth) {
      if (player && player.vulnerable) {
        c.hasTarget = true;
        this.enter(c, LAND_FLEE);
        return;
      }
    }
    const seen = this.acquirePlayer(c, player);
    const provoked = c.provokedT > 0 && player && player.vulnerable;
    if (cfg.temperament === "aggressive") {
      if (seen) {
        this.engageLand(c, player!);
        return;
      }
    } else if (cfg.temperament === "neutral") {
      if (seen || provoked) {
        if (player) this.engageLand(c, player);
        return;
      }
    }
    // passive/skittish crocs don't apply here; fall through to roam.
    this.loseAndRoam(c);
  }

  /** Notice the player within the stance-based range + FOV; a locked target is
   *  tracked out to max(sight, noticeRange) so a spotted player isn't lost the
   *  instant they crouch. */
  private acquirePlayer(c: Creature, player?: FaunaPlayer): boolean {
    const cfg = c.species.land!;
    if (!player || !player.vulnerable) return false;
    const d = c.group.position.distanceTo(player.pos);
    const notice = player.noticeRange * U;
    const track = Math.max(cfg.sight * U, notice);
    const locked = c.hasTarget;
    if (d > track) return false;
    if (!locked) {
      if (d > notice) return false;
      if (!this.inFov(c, player.pos)) return false;
    }
    return true;
  }

  private inFov(c: Creature, target: THREE.Vector3): boolean {
    const cfg = c.species.land!;
    if (cfg.fovDeg >= 359) return true;
    const to = new THREE.Vector3(target.x - c.group.position.x, 0, target.z - c.group.position.z);
    if (to.lengthSq() < 1e-6) return true;
    to.normalize();
    // Forward = +Z rotated by yaw.
    const fwd = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
    const cosHalf = Math.cos((cfg.fovDeg * 0.5 * Math.PI) / 180);
    return fwd.dot(to) >= cosHalf;
  }

  private engageLand(c: Creature, player: FaunaPlayer): void {
    const cfg = c.species.land!;
    c.hasTarget = true;
    // Leash break: too far from home → give up and walk back.
    if (c.group.position.distanceTo(c.home) > (cfg.leash + cfg.giveUp) * U) {
      this.disengage(c);
      return;
    }
    const d = c.group.position.distanceTo(player.pos);
    if (d <= cfg.attackRange * U) this.enter(c, LAND_ATTACK);
    else this.enter(c, LAND_CHASE);
  }

  private loseAndRoam(c: Creature): void {
    c.hasTarget = false;
    c.threatened = false;
    if (c.state !== LAND_IDLE && c.state !== LAND_WANDER) this.enter(c, LAND_WANDER);
  }

  private disengage(c: Creature): void {
    c.hasTarget = false;
    c.threatened = false;
    c.provokedT = 0;
    c.wanderPt.copy(c.home);
    this.enter(c, LAND_WANDER);
  }

  private moveLand(c: Creature, dt: number, player?: FaunaPlayer): void {
    const cfg = c.species.land!;
    switch (c.state) {
      case LAND_IDLE:
        c.idleHold -= dt;
        if (c.idleHold <= 0) {
          // Sometimes drop into a mouth-open bask (the passive-tame window)
          // instead of wandering — untamed, calm, and off cooldown only.
          if (!c.tamed && c.baskCd <= 0 && c.agitated <= 0 && this.rng() < 0.5) {
            c.basking = true;
            c.baskTimer = BASK_DUR;
            this.enter(c, LAND_BASK);
          } else {
            this.pickWanderLand(c);
            this.enter(c, LAND_WANDER);
          }
        }
        break;
      case LAND_BASK:
        c.baskTimer -= dt;
        if (c.baskTimer <= 0) {
          c.basking = false;
          c.baskCd = BASK_CD;
          c.idleHold = 1 + this.rng() * 2;
          this.enter(c, LAND_IDLE);
        }
        break;
      case LAND_WANDER: {
        const arrived = this.moveToward(c, c.wanderPt, cfg.wanderSpeed * U, dt, false);
        if (arrived || c.stateT > WANDER_TIMEOUT) {
          c.idleHold = 1.2 + this.rng() * 2.3;
          this.enter(c, LAND_IDLE);
        }
        break;
      }
      case LAND_CHASE: {
        if (!player || !player.vulnerable) {
          this.disengage(c);
          break;
        }
        const d = c.group.position.distanceTo(player.pos);
        if (d <= cfg.attackRange * U) {
          this.enter(c, LAND_ATTACK);
          break;
        }
        if (d > (cfg.sight + cfg.giveUp) * U) {
          this.disengage(c);
          break;
        }
        // Stall watch: no progress for 5 s → give up.
        if (d < c.chaseBestD - 0.5 * U) {
          c.chaseBestD = d;
          c.chaseStall = 0;
        } else {
          c.chaseStall += dt;
          if (c.chaseStall > 5) {
            this.disengage(c);
            break;
          }
        }
        this.moveToward(c, player.pos, cfg.chaseSpeed * U, dt, false);
        break;
      }
      case LAND_ATTACK: {
        if (!player || !player.vulnerable) {
          if (!c.biting) this.disengage(c);
          break;
        }
        this.face(c, player.pos, dt);
        const d = c.group.position.distanceTo(player.pos);
        if (c.biting) {
          // lunge into the strike
          this.driveAt(c, player.pos, cfg.chaseSpeed * U, dt);
        } else if (d > cfg.attackRange * 1.4 * U) {
          this.enter(c, LAND_CHASE);
        } else if (d > cfg.attackRange * 0.7 * U) {
          this.driveAt(c, player.pos, cfg.chaseSpeed * U, dt);
        }
        break;
      }
      case LAND_FLEE: {
        if (!player || c.group.position.distanceTo(player.pos) > cfg.sight * 1.1 * U) {
          this.disengage(c);
          break;
        }
        const away = c.group.position.clone().multiplyScalar(2).sub(player.pos);
        this.moveToward(c, away, cfg.chaseSpeed * U, dt, true);
        break;
      }
    }
  }

  /** Bite timeline (only in ATTACK). Lands damage at strikeAt, then cools down. */
  private updateBite(c: Creature, dt: number, player?: FaunaPlayer): void {
    const cfg = c.species.land!;
    if (c.state !== LAND_ATTACK) {
      c.biting = false;
      return;
    }
    if (c.biting) {
      c.biteT += dt;
      if (!c.biteHit && c.biteT >= cfg.strikeAt) {
        c.biteHit = true;
        if (player && c.group.position.distanceTo(player.pos) <= cfg.attackRange * 1.5 * U) {
          this.onBitePlayer?.(cfg.damage, c.species.id);
        }
      }
      if (c.biteT >= cfg.strikeAt + 0.35) {
        c.biting = false;
        c.attackCd = cfg.cooldown;
      }
      return;
    }
    if (!player) return;
    // Telegraph the first strike at the player (a beat before the bite).
    if (!c.threatened) {
      c.threatened = true;
      c.attackCd = Math.max(c.attackCd, 0.6);
      return;
    }
    const d = c.group.position.distanceTo(player.pos);
    if (c.attackCd <= 0 && d <= cfg.attackRange * U) {
      c.biting = true;
      c.biteT = 0;
      c.biteHit = false;
    }
  }

  /** Walk toward dest; returns true on arrival. Amphibious → never water-blocked. */
  private moveToward(
    c: Creature, dest: THREE.Vector3, speed: number, dt: number, isFlee: boolean,
  ): boolean {
    const p = c.group.position;
    const to = new THREE.Vector3(dest.x - p.x, 0, dest.z - p.z);
    const dist = to.length();
    if (!isFlee && dist <= 1.5 * U) return true;
    if (dist < 1e-4) return true;
    to.divideScalar(dist);
    p.x += to.x * speed * dt;
    p.z += to.z * speed * dt;
    this.face(c, dest, dt);
    return false;
  }

  /** Drive straight at dest with no arrival check (the attack lunge). */
  private driveAt(c: Creature, dest: THREE.Vector3, speed: number, dt: number): void {
    const p = c.group.position;
    const to = new THREE.Vector3(dest.x - p.x, 0, dest.z - p.z);
    if (to.lengthSq() < 1e-4) return;
    to.normalize();
    p.x += to.x * speed * dt;
    p.z += to.z * speed * dt;
  }

  private face(c: Creature, target: THREE.Vector3, dt: number): void {
    const to = new THREE.Vector3(target.x - c.group.position.x, 0, target.z - c.group.position.z);
    if (to.lengthSq() < 1e-5) return;
    const targetYaw = Math.atan2(to.x, to.z); // +Z forward
    c.yaw = lerpAngle(c.yaw, targetYaw, clamp(c.species.land!.turnSpeed * dt, 0, 1));
  }

  private pickWanderLand(c: Creature): void {
    const cfg = c.species.land!;
    // Shoreline decisiveness: a croc sitting at the water's edge should COMMIT
    // to a real trek rather than dither in place — pick a target that's clearly
    // inland OR clearly into the shallows (50/50 when it's on the waterline;
    // otherwise continue whichever side it's already on), a good stride away.
    const here = beachHeight(c.group.position.x, c.group.position.z);
    const onShore = Math.abs(here) < 2.5 * U;
    const goLand = onShore ? this.rng() < 0.5 : here > 0;
    for (let tries = 0; tries < 12; tries++) {
      const ang = this.rng() * Math.PI * 2;
      const r = (8 + this.rng() * (cfg.leash - 8)) * U; // commit to a distance
      const x = c.home.x + Math.sin(ang) * r;
      const z = c.home.z + Math.cos(ang) * r;
      const h = beachHeight(x, z);
      const onLand = h > 0.3 * U;
      const inWade = h < 0 && -h <= cfg.maxWadeM * U;
      if (goLand ? onLand : inWade) {
        c.wanderPt.set(x, 0, z);
        return;
      }
    }
    // Fallback: any land-or-wadeable point nearby (don't get stuck).
    for (let tries = 0; tries < 12; tries++) {
      const ang = this.rng() * Math.PI * 2;
      const r = (4 + this.rng() * (cfg.leash - 4)) * U;
      const x = c.home.x + Math.sin(ang) * r;
      const z = c.home.z + Math.cos(ang) * r;
      if (-beachHeight(x, z) <= cfg.maxWadeM * U) {
        c.wanderPt.set(x, 0, z);
        return;
      }
    }
    c.wanderPt.copy(c.home);
  }

  // ── shared ─────────────────────────────────────────────────────────────────

  private animateBody(c: Creature, dt: number): void {
    if (c.mixer) c.mixer.update(dt);
    const sway =
      Math.sin(this.elapsed * (c.species.sea?.turn ? 3.2 : 2.4) + c.phase) *
      (c.species.habitat === "sea" ? 0.16 : 0.06);
    c.model.rotation.y = c.species.modelYaw + sway;
  }

  private enter(c: Creature, s: number): void {
    // Re-entering ATTACK is allowed (so bites re-trigger); others no-op.
    if (s === c.state && !(c.species.habitat === "amphibious" && s === LAND_ATTACK)) return;
    c.state = s;
    c.stateT = 0;
    if (c.species.habitat === "amphibious") {
      if (s === LAND_CHASE) {
        c.chaseBestD = Infinity;
        c.chaseStall = 0;
      }
      if (s !== LAND_ATTACK) c.threatened = false;
    }
  }

  // ── spawning / streaming ───────────────────────────────────────────────────

  private recycle(c: Creature, focus: THREE.Vector3): void {
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
    this.resetState(c);
    this.place(c, focus, false);
  }

  private place(c: Creature, focus: THREE.Vector3, initial: boolean): void {
    c.parked = false; // placeInOcean/placeAtShore set it true if they can't land
    if (c.species.habitat === "sea") this.placeInOcean(c, focus, initial);
    else this.placeAtShore(c, focus, initial);
    if (c.parked) return; // nowhere valid yet — try again next frame
    c.home.copy(c.group.position);
    c.home.y = 0;
    if (c.species.habitat === "sea") this.pickWanderSea(c);
    else this.pickWanderLand(c);
  }

  private placeInOcean(c: Creature, focus: THREE.Vector3, initial: boolean): void {
    for (let tries = 0; tries < 40; tries++) {
      const ang = this.rng() * Math.PI * 2;
      const rMin = initial ? 0.12 : 0.4;
      const r = Math.sqrt(rMin * rMin + this.rng() * (1 - rMin * rMin)) * this.rangeU;
      const x = focus.x + Math.sin(ang) * r;
      const z = focus.z + Math.cos(ang) * r;
      if (-beachHeight(x, z) < this.minDepthU) continue;
      const cruise = c.species.sea!.bandTop * U;
      c.group.position.set(x, cruise, z);
      const a = this.rng() * Math.PI * 2;
      c.heading.set(Math.sin(a), 0, Math.cos(a));
      c.prevHeading.copy(c.heading);
      return;
    }
    c.group.position.set(focus.x, -400, focus.z); // no deep water near focus
    c.parked = true;
  }

  private placeAtShore(c: Creature, focus: THREE.Vector3, initial: boolean): void {
    const wade = c.species.land!.maxWadeM * U;
    for (let tries = 0; tries < 48; tries++) {
      const ang = this.rng() * Math.PI * 2;
      const rMin = initial ? 0.12 : 0.4;
      const r = Math.sqrt(rMin * rMin + this.rng() * (1 - rMin * rMin)) * this.rangeU;
      const x = focus.x + Math.sin(ang) * r;
      const z = focus.z + Math.cos(ang) * r;
      const h = beachHeight(x, z);
      // Lurk at the shoreline: shallow water (down to maxWade) up to just onto
      // the beach — never the deep, never far inland.
      if (h >= -wade && h <= 1.0 * U) {
        c.group.position.set(x, h, z);
        c.yaw = this.rng() * Math.PI * 2;
        return;
      }
    }
    c.group.position.set(focus.x, -400, focus.z); // no shoreline near focus
    c.parked = true;
  }

  private pickWanderSea(c: Creature): void {
    const cfg = c.species.sea!;
    const hr = cfg.homeRadius * U;
    const ang = this.rng() * Math.PI * 2;
    const r = hr * (0.2 + this.rng() * 0.8);
    const y = (cfg.bandBottom + this.rng() * (cfg.bandTop - cfg.bandBottom)) * U;
    c.wanderPt.set(c.home.x + Math.sin(ang) * r, y, c.home.z + Math.cos(ang) * r);
  }

  private pickSpecies(): Species {
    const total = SPECIES.reduce((s, sp) => s + sp.spawnWeight, 0);
    let r = this.rng() * total;
    for (const sp of SPECIES) {
      r -= sp.spawnWeight;
      if (r <= 0) return sp;
    }
    return SPECIES[0];
  }

  private resetState(c: Creature): void {
    c.state = c.species.habitat === "sea" ? SEA_CRUISE : LAND_IDLE;
    c.stateT = 0;
    c.thinkAcc = 0;
    c.hasTarget = false;
    c.parked = false;
    c.bank = 0;
    c.circleDir = this.rng() < 0.5 ? 1 : -1;
    c.biteCd = 0;
    c.peelT = 0;
    c.attackCd = 0;
    c.biting = false;
    c.biteT = 0;
    c.biteHit = false;
    c.threatened = false;
    c.provokedT = 0;
    c.idleHold = 0.5 + this.rng() * 2.5;
    c.chaseBestD = Infinity;
    c.chaseStall = 0;
    c.tamePct = 0;
    c.tamed = false;
    c.basking = false;
    c.baskTimer = 0;
    c.baskCd = 2 + this.rng() * 6;
    c.feedWindow = 0;
    c.agitated = 0;
    c.tracked = false; // a recycled creature is a fresh, untracked one
    if (c.species.land) c.health = c.species.land.maxHealth;
  }

  // ── model instancing ───────────────────────────────────────────────────────

  private fitModel(model: THREE.Object3D, sp: Species): void {
    model.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const longest = Math.max(size.x, size.y, size.z);
    if (longest > 1e-4) model.scale.setScalar((sp.lengthM * U) / longest);
    model.updateWorldMatrix(true, true);
    const fitted = new THREE.Box3().setFromObject(model);
    const c2 = fitted.getCenter(new THREE.Vector3());
    model.position.sub(c2);
    // Body half-height (after centring) so land walkers rest belly-on-ground.
    this.halfH.set(sp.id, (fitted.max.y - fitted.min.y) * 0.5);
  }

  private build(sp: Species): Creature {
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

    const c: Creature = {
      species: sp,
      group,
      model,
      mixer,
      phase: this.rng() * Math.PI * 2,
      home: new THREE.Vector3(),
      wanderPt: new THREE.Vector3(),
      state: sp.habitat === "sea" ? SEA_CRUISE : LAND_IDLE,
      stateT: 0,
      thinkAcc: 0,
      hasTarget: false,
      parked: false,
      heading: new THREE.Vector3(0, 0, 1),
      prevHeading: new THREE.Vector3(0, 0, 1),
      bank: 0,
      circleDir: this.rng() < 0.5 ? 1 : -1,
      biteCd: 0,
      peelT: 0,
      yaw: 0,
      health: sp.land?.maxHealth ?? 1,
      attackCd: 0,
      biting: false,
      biteT: 0,
      biteHit: false,
      threatened: false,
      provokedT: 0,
      idleHold: 0.5 + this.rng() * 2.5,
      chaseBestD: Infinity,
      chaseStall: 0,
      tamePct: 0,
      tamed: false,
      basking: false,
      baskTimer: 0,
      baskCd: 2 + this.rng() * 6,
      feedWindow: 0,
      agitated: 0,
      id: this.nextId++,
      tracked: false,
    };
    return c;
  }
}

// ── procedural fallback body (used only if a GLB fails to load) ───────────────

function buildProceduralBody(sp: Species): THREE.Object3D {
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

// ── helpers ───────────────────────────────────────────────────────────────────

function dist2(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Shortest-arc angle lerp. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return a + d * t;
}

/** Rotate unit vector `from` toward unit `to`, by at most `maxRad`. In place. */
const _qFull = new THREE.Quaternion();
const _qStep = new THREE.Quaternion();
const _qId = new THREE.Quaternion();
function rotateTowards(from: THREE.Vector3, to: THREE.Vector3, maxRad: number): void {
  const f = from.clone().normalize();
  const t = to.clone().normalize();
  const dot = clamp(f.dot(t), -1, 1);
  const angle = Math.acos(dot);
  if (angle < 1e-4) {
    from.copy(t);
    return;
  }
  const frac = Math.min(1, maxRad / angle);
  _qFull.setFromUnitVectors(f, t);
  _qId.identity();
  _qStep.copy(_qId).slerp(_qFull, frac);
  from.copy(f).applyQuaternion(_qStep).normalize();
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
