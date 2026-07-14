import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { loadModel, loadTexture } from "../engine/assets";
import { updateBillboardsYAxis } from "../engine/Billboard";
import { loadIslandBillboardTrees } from "../engine/islandBillboardTrees";
import { HudMarker } from "../engine/HudMarker";
import { Navigator } from "../engine/Navigator";
import { PlayerController } from "../engine/PlayerController";
import { InventoryOverlay } from "../engine/InventoryOverlay";
import { CameraDirector, type CameraZone } from "../engine/CameraDirector";
import { ClipLibrary } from "../engine/ClipLibrary";
import {
  ObjectiveHighlight,
  type FocusColor,
} from "../engine/ObjectiveHighlight";
import { SequenceDirector } from "../engine/SequenceDirector";
import { autoFramingScale, portraitFovBoost } from "../engine/cameraFraming";
import {
  getSettings,
  subscribeSettings,
  type GameplaySettings,
} from "../engine/Settings";
import { openSettingsPanel, closeSettingsPanel } from "../engine/SettingsPanel";
import { closeHudEditor, setHudEditorContext } from "../engine/HudEditor";
import { ISLAND_LOCATIONS, MAP_METRES, locationWorld } from "../engine/islandLocations";
import { SeaCreatures, type FaunaSaveEntry } from "../engine/SeaCreatures";
import { Progression } from "../engine/Progression";
import { beachStory } from "../data/beachSequences";
import { VOICE_CLIPS } from "../data/voiceClips";
import {
  buildBeachTerrain,
  buildOceanWater,
  loadIslandHeightmap,
  loadIslandGround,
  beachHeight,
  beachSlopeDeg,
  MAP_SCALE,
  HEIGHT_SCALE,
  METERS_PER_UNIT,
  ISLAND_CENTER,
  ISLAND_SPAN,
  type OceanWater,
} from "../engine/beachTerrain";
import { SaveManager } from "../engine/SaveManager";
import { SpawnStore } from "../engine/SpawnStore";
import { SpawnTools } from "../engine/SpawnTools";
import { IslandMap } from "../engine/IslandMap";
import { SurvivalStats } from "../engine/SurvivalStats";
import { SurvivalHud } from "../engine/SurvivalHud";
import { PlayerInventory } from "../engine/PlayerInventory";
import { MarkerStore } from "../engine/MarkerStore";
import { spawnSceneMarkers } from "../engine/MarkerEditor";
import { AnimStore } from "../engine/AnimStore";
import { RIGS, bakeHumanoidClips, STD_CLIPS } from "../engine/proceduralAnimator";
import { StoryDilo } from "../engine/StoryDilo";

/** The animation actions a rigged character drives (idle/walk crossfade). */
interface CharacterActions {
  idle: THREE.AnimationAction;
  walk?: THREE.AnimationAction;
}

/** What the camera zones read each frame to decide framing. */
interface CameraZoneState {
  jack: THREE.Vector3;
  sarah: THREE.Vector3;
  framingScale: number;
  moment: string | null;
}

/**
 * A routine ACTION gate: a tappable world object the player walks Jack up to.
 * The director awaits it via waitForInteraction(id); under Auto Play it
 * auto-executes after a short beat. Genuine CHOICEs are never modelled here —
 * those always pause for the player (see chooseOption).
 */
interface BeachInteraction {
  target: THREE.Object3D;
  /** Point Jack walks to (defaults to the target's position). */
  walkTo?: THREE.Vector3;
  /** How close counts as "arrived". */
  radius: number;
  highlight: ObjectiveHighlight;
  /** Side effect run on arrival (e.g. Sarah stands, driftwood is gathered). */
  onPerform: () => Promise<void> | void;
}

/**
 * Chapter One opening — the first scene built on the reusable directed-gameplay
 * engine. Jack wakes on a too-bright beach; the player taps glowing objectives
 * to walk him to Sarah and to gather driftwood, characters auto-pathfind and
 * animate, dialogue auto-advances, and a single genuine choice (treeline vs
 * shoreline) always pauses for the player. A hiss from the treeline ends the
 * vertical slice and hands back to the menu.
 *
 * The story is data: beachSequences.beachStory is a flat timeline the
 * SequenceDirector plays, delegating every effect to the closures wired up in
 * enter(). Auto Play (a Settings toggle) auto-executes the ACTION gates while
 * leaving the choice to the player.
 */
class ChapterOnePlaceholderScene implements IScene {
  readonly name = "chapter-one";
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private viewportHeight = window.innerHeight;
  private oceanUniforms!: OceanWater["uniforms"];
  private dodo!: THREE.Group;
  private billboards: THREE.Mesh[] = [];
  // Wind + draw-distance tick for the instanced tree species (see islandTrees).
  private treesUpdate?: (dt: number, camPos: THREE.Vector3) => void;
  // Sun with a player-following shadow frustum (see updateSun). The shadow box
  // is tight (~140 m) because a directional shadow can't span the 8 km island.
  private sun?: THREE.DirectionalLight;

  private jack!: THREE.Group;
  private sarah!: THREE.Group;
  private jackNav!: Navigator;
  private mixers: THREE.AnimationMixer[] = [];
  private readonly clipLibrary = new ClipLibrary();

  // First-person Jack (hybrid FPS controls). The cinematic camera director is
  // built but left dormant while firstPerson is true — easy to switch back.
  private firstPerson = true;
  private player?: PlayerController;
  private inventory?: InventoryOverlay;
  private islandMap?: IslandMap;
  private seaCreatures?: SeaCreatures;
  // Creature-combat: a full-screen red damage vignette, and a latch that makes
  // the player non-targetable while a death/respawn is playing out.
  private hurtEl?: HTMLDivElement;
  private hurtT = 0;
  private respawning = false;
  // Passive taming: a contextual Feed button near a basking croc + a "back off"
  // countdown bar during the post-feed window.
  private feedBtnEl?: HTMLButtonElement;
  private feedBarEl?: HTMLDivElement;
  private feedBarFillEl?: HTMLDivElement;
  private feedWindowT = 0;
  private unsubFeed?: () => void;
  private static readonly FEED_RANGE_M = 5;
  // Track button: mark the creature under the crosshair to follow it (label +
  // no-cull) and persist it through save/resume.
  private trackBtnEl?: HTMLButtonElement;
  private resumeFauna?: FaunaSaveEntry[];
  // Tamed-creature interaction menu (⚙ Command → Follow / Stay / Wander).
  private petBtnEl?: HTMLButtonElement;
  private tameMenuEl?: HTMLDivElement;
  private tameMenuTargetId?: number;
  // Survival model + hybrid ARK×PoT HUD (first-person island only). Stats tick
  // only while player input is enabled, so cinematics/menus freeze the clock.
  private stats?: SurvivalStats;
  private survivalHud?: SurvivalHud;
  private locNameAcc = 0; // throttle for the minimap location label
  // Named-zone lookup table (world coords + squared radii), built lazily on
  // first poll — locationWorld() needs the heightmap, which loads with init().
  private locZones?: Array<{ name: string; x: number; z: number; r2: number }>;
  // Eye heights in world units, keyed off Godot's real-metre stances so the two
  // builds match exactly (model is 1.8 m tall = 6.4 u; METERS_PER_UNIT converts).
  // Godot base_character.gd: stand 1.62 m, crouch 1.05 m, crawl 0.52 m.
  private static readonly EYE = 1.62 / METERS_PER_UNIT; // ≈ 5.76 u (1.62 m)
  private static readonly CROUCH_EYE = 1.05 / METERS_PER_UNIT; // ≈ 3.73 u (1.05 m)
  private static readonly CRAWL_EYE = 0.52 / METERS_PER_UNIT; // ≈ 1.85 u (0.52 m)
  // Camera forward nudge (Godot cam_fwd_offset 0.32 m): pushes the eye ahead of
  // the head bone so the body renders behind it — no head clipping in view.
  private static readonly CAM_FWD = 0.32 / METERS_PER_UNIT; // ≈ 1.14 u (0.32 m)
  private eyeOffset = ChapterOnePlaceholderScene.EYE; // lerps toward the posture target
  // Dev-only on-screen readout of movement state (WALK/RUN/CROUCH/CRAWL + eye
  // height + flags). Off in shipped builds; flip to true to diagnose input.
  private static readonly DEBUG_MOVE = false;
  private dbgEl?: HTMLDivElement;
  // Default island start points (SSW arrival beach), in the scaled world. Jack.rot
  // = facing degrees; Sarah.rot = mesh rotation.y (radians). Overridable + savable
  // via the Dev menu. (Base coords were tuned on the small island, so ×MAP_SCALE.)
  // z values are mirrored about the island centre (z' = 244·MS − z) from the
  // pre-"true aerial view" coords — see worldToIslandUV — with headings
  // mirrored to match (H' = 180 − H; mesh yaw θ' = π − θ).
  private static readonly JACK_SPAWN = { x: -106 * MAP_SCALE, z: 182 * MAP_SCALE, rot: 240 };
  private static readonly SARAH_SPAWN = { x: -108 * MAP_SCALE, z: 176 * MAP_SCALE, rot: Math.PI / 2 };
  private jackFacingDeg = ChapterOnePlaceholderScene.JACK_SPAWN.rot;
  // Vertical physics for first person: the eye rests on the ground but isn't
  // locked to it — gravity pulls it down, jump pushes it up, you fall off ledges.
  // Sun / shadow rig (see enter()). SUN_DIR is the fixed light direction (a
  // low morning sun); the light sits SUN_DIST up-sun from the player and its
  // shadow frustum is ±SHADOW_HALF (~140 m) so nearby character/prop shadows
  // stay crisp on the huge island.
  private static readonly SUN_DIR = new THREE.Vector3(0.6, 0.66, -0.33).normalize();
  private static readonly SUN_DIST = 900;
  private static readonly SHADOW_HALF = 500;
  private static readonly GRAVITY = 34.84; // 9.8 m/s² (0.28125 m/u)
  private static readonly JUMP_SPEED = 17.07; // 4.8 m/s (Godot jump velocity)
  private static readonly STEP = 3; // step-down snap tolerance (u) so gentle slopes stay grounded
  private vy = 0; // vertical velocity (world u/s)
  private camY = 0; // integrated eye height (the controller resets camera.y each frame)
  private onGround = true;

  // --- Chapter Two "Day One — Arrival" cinematic (Godot island_story parity):
  // journal page typed over black → nightmare SFX → skippable establishing
  // flyover → "SARAH!" → Find Sarah. Runs once per fresh arrival; resumes skip.
  private arrivalJournal?: HTMLDivElement;
  private journalTextEl?: HTMLDivElement;
  private typeRaf: number | null = null;
  private uwTint?: HTMLDivElement; // underwater blue wash during the dive
  private flyoverState: {
    wps: { p: THREE.Vector3; l: THREE.Vector3; d: number }[];
    total: number;
    elapsed: number;
    resolve: () => void;
  } | null = null;
  private flyoverSkip = false;
  private skipUnsub?: () => void;
  private findSarahArmed = false;
  private static readonly FLYOVER_FOV = 65; // Godot FlyoverCam fov
  private static readonly SARAH_TRIGGER = 3.0 / METERS_PER_UNIT; // 3 m (Godot TRIGGER_RADIUS)

  // The scripted first-encounter Dilophosaurus (a story entity, hand-placed at
  // the treeline; NOT part of the fauna streamer). Armed once Sarah is found;
  // walking up to the treeline fires the reveal cutscene once.
  private dilo?: StoryDilo;
  /** On-screen quest pointer (replaces the hard boundary — guides, not walls). */
  private objMarker?: HudMarker;
  /** Whether the gated story-grid wall is active (off = open island). */
  private storyBoundaryOn = false;
  private diloArmed = false;
  private diloRevealStarted = false;
  private readonly diloTreeline = new THREE.Vector3();
  /** While set, update() locks the camera onto this world point (the reveal). */
  private revealLook: THREE.Vector3 | null = null;
  private static readonly DILO_HEIGHT = 9; // units (~2.5 m tall at the crest)
  private static readonly DODO_HEIGHT = 3.6; // units (~1 m tall)
  private static readonly TREELINE_TRIGGER = 14 / METERS_PER_UNIT; // 14 m
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  private cameraDirector!: CameraDirector<CameraZoneState>;
  private highlights: ObjectiveHighlight[] = [];
  private interactions = new Map<string, BeachInteraction>();
  // The interaction the director is currently waiting on, with the resolver
  // that unblocks its timeline step.
  private pending: { id: string; resolve: () => void } | null = null;
  private autoPlayTimer: ReturnType<typeof setTimeout> | null = null;
  // True while a choice panel is up, so taps don't drive Jack underneath it.
  private choiceOpen = false;

  private director!: SequenceDirector;
  private scriptedCameraMoment: string | null = null;
  private hissDone = false;
  private elapsed = 0;
  private disposed = false;
  private unsubClick?: () => void;
  private unsubSettings?: () => void;
  private gearEl?: HTMLButtonElement;
  private endCardEl?: HTMLDivElement;
  private settings: GameplaySettings = getSettings();

  // Fixed three-quarter diorama: a constant world offset tracking Jack.
  private camOffset = new THREE.Vector3(0, 14, 23);
  private static readonly JACK_HEIGHT = 6.4;
  // Auto Play delay before an ACTION gate executes itself.
  private static readonly AUTOPLAY_DELAY_MS = 900;
  // The beach play area Jack/Sarah are clamped to (off the water, short of the
  // treeline).
  // A much larger roam area: a wide beach that runs from out in the shallow
  // water (negative Z — you can wade in) up to the dunes/treeline inland.
  // Roam the WHOLE island: the heightmap spans x ±150·MS, z −28..272·MS —
  // these bounds cover all of it plus a swimmable shallows margin, so nothing
  // stops you mid-island (the volcano included).
  // Full-island bounds — used only once Unlimited Mode unlocks (the open sandbox
  // after the campaign). Covers the whole heightmap plus a swimmable margin.
  private static readonly ISLAND = {
    minX: -170 * MAP_SCALE,
    maxX: 170 * MAP_SCALE,
    minZ: -48 * MAP_SCALE,
    maxZ: 292 * MAP_SCALE,
  };
  // Fixed story grid for this chapter (metres) — the player is clamped to this
  // box until Unlimited Mode unlocks. Larger chapters bump this up.
  private static readonly CHAPTER_GRID_M = 1000;
  // Computed in enter() from the arrival spawn + CHAPTER_GRID_M.
  private gridBounds = ChapterOnePlaceholderScene.ISLAND;
  private boundaryBox?: THREE.Group;
  private boundaryToastAt = 0;

  constructor(private ctx: SceneContext) {
    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      // Near 0.03 m (Godot base_character parity): the camera rides at the head
      // and sits just ahead of the face, so a tiny near plane keeps the beach
      // from slicing away underfoot even when crawling. Far stays huge for the
      // 8 km horizon; distant terrain is fogged well before precision matters.
      0.107,
      60000,
    );
  }

  async enter(): Promise<void> {
    // Reaching the island is the game's main progression checkpoint: from here
    // "Continue" brings the player straight back to the beach. Restore inventory
    // if this was a resume, then (re)write the island autosave. (See SaveManager.)
    const resume = SaveManager.consumeResume();
    // Day One — Arrival cinematic (journal + flyover) plays only the first time
    // in: a resume drops straight into free roam.
    const freshArrival = !(resume && resume.scene === "island");
    if (resume && resume.scene === "island") {
      // Loading an island save — keep exactly what was saved.
      PlayerInventory.hasBadge = resume.inventory.hasBadge;
      PlayerInventory.heldItems = [...resume.inventory.heldItems];
      // Tracked / part-tamed creatures ride along in the save's flags.
      const fauna = resume.flags?.fauna;
      if (Array.isArray(fauna)) this.resumeFauna = fauna as FaunaSaveEntry[];
    } else {
      // Fresh arrival through the portal: set Jack's carry-over loadout
      // explicitly (the prologue's end-state inventory is unreliable). Jack keeps
      // a badge and one coffee.
      PlayerInventory.hasBadge = true;
      // Coffee + a few raw meat to test passive taming the basking crocs.
      PlayerInventory.heldItems = ["coffee", "meat", "meat", "meat", "meat", "meat"];
    }
    // Sarah travels with the party on the island carrying her own badge +
    // flashlight (tracked separately from Jack's pack for future crafting).
    PlayerInventory.companionHasBadge = true;
    PlayerInventory.companionItems = ["flashlight"];
    SaveManager.autosave({
      label: "Chapter One — The Island",
      scene: "island",
      inventory: {
        hasBadge: PlayerInventory.hasBadge,
        heldItems: [...PlayerInventory.heldItems],
      },
    });

    const scene = this.scene;
    // Unnaturally vivid, high-oxygen sky.
    scene.background = new THREE.Color(0x2f8ff5);
    scene.fog = new THREE.Fog(0x9fd2ff, 140 * MAP_SCALE, 900 * MAP_SCALE);

    // On a fresh arrival the beach ambience waits for the flyover (the arrival
    // cinematic opens on black and silence); resumes start it immediately.
    if (!(this.firstPerson && freshArrival)) this.ctx.audio.playMusic("beach-dawn");

    const hemi = new THREE.HemisphereLight(0xbfe4ff, 0xc8b78a, 1.0);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d6, 2.3);
    sun.castShadow = true;
    // A directional shadow can't cover an 8 km island at usable resolution, so
    // the shadow frustum is a tight box that FOLLOWS the player (updateSun()).
    // Without this the default ±5-unit shadow camera sits at the origin, ~20 000
    // units from the player, and projects garbage onto the terrain (a hard dark
    // quad + acne). SUN_DIR is the fixed light direction; the light rides a
    // fixed offset up-sun from the player each frame and targets them.
    sun.shadow.mapSize.set(2048, 2048);
    const shCam = sun.shadow.camera;
    const SH = ChapterOnePlaceholderScene.SHADOW_HALF;
    shCam.left = -SH;
    shCam.right = SH;
    shCam.top = SH;
    shCam.bottom = -SH;
    shCam.near = 1;
    shCam.far = ChapterOnePlaceholderScene.SUN_DIST * 2;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 2;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;
    this.updateSun(); // frame the spawn before the first render

    // Real island terrain from the MeshyAI heightmap, with the aerial photo
    // draped over it. Load both first (the heightmap must be sampled per vertex);
    // if either fails, buildBeachTerrain falls back to the procedural beach.
    await loadIslandHeightmap("assets/textures/island_height.png");
    if (this.disposed) return;
    const islandColor = await loadTexture("assets/textures/island_color.jpg");
    if (this.disposed) return;
    const islandGround = await loadIslandGround();
    if (this.disposed) return;
    scene.add(buildBeachTerrain(islandColor, islandGround));

    // Animated water at sea level (y=0), surrounding the island.
    const ocean = buildOceanWater();
    this.oceanUniforms = ocean.uniforms;
    scene.add(ocean.mesh);

    // Ambient sea life — created here (not in buildFpHud) so the GLBs stream in
    // during the arrival journal and the creatures are already roaming the ocean
    // by the time the flyover skims and dives over the water. update() seeds them
    // around a focus point (the flyover camera during the cinematic, then Jack).
    this.seaCreatures = new SeaCreatures(this.scene, {
      count: 6,
      camera: this.camera,
      // Chapter 1–3 is the protected arrival beach: only marine species stream
      // in, and only offshore in deep water. Crocs (Sarco/Deino) are amphibious
      // and would otherwise camp the shoreline where the player spawns — they
      // belong to the rivers/swamps of later chapters, so they're gated out here.
      // The first hour should read as "where are we?", not an ambush.
      allowedSpecies: ["megalodon", "mosasaurus", "ichthyosaurus"],
      onBitePlayer: (dmg, species) => this.onCreatureBite(dmg, species),
      onTamed: (name) => this.onCreatureTamed(name),
      // State labels off for now — they cluttered the horizon. Tracked creatures
      // (🎯 Track button) still show their label. Re-enable for AI debugging.
      debug: false,
    });
    // Restore tracked / part-tamed creatures from the loaded save (if any).
    if (this.resumeFauna) this.seaCreatures.restore(this.resumeFauna);
    void this.seaCreatures.preload();

    await this.buildJungle();
    if (this.disposed) return;

    // Recall any dev-placed markers (spawn points / objects) for this scene.
    await MarkerStore.load();
    if (this.disposed) return;
    spawnSceneMarkers(this.name, scene);

    // Start positions: the SSW arrival beach defaults (per the HANIFAT map plan:
    // arrival in the SSW, trail runs "south to summit" — both wash up at the
    // waterline, ocean at their back, the island rising to the NE toward the
    // volcano). A dev can override these live via the Dev menu (Set … Spawn), and
    // the saved point wins here on future loads.
    const savedSpawns = SpawnStore.get();
    const jackSpawn = savedSpawns.jack ?? ChapterOnePlaceholderScene.JACK_SPAWN;
    const sarahSpawn = savedSpawns.sarah ?? ChapterOnePlaceholderScene.SARAH_SPAWN;
    this.jackFacingDeg = jackSpawn.rot;

    // Chapters 1–3 play OPEN — no hard story-grid wall. Objectives can sit
    // anywhere (e.g. Sarah at the waterline), and the on-screen HUD marker guides
    // the player instead of a cage. clampToPlay still fences the island edge so
    // you can't wander off into open ocean. STORY_BOUNDARY re-enables the gated
    // grid later; Dev override ?unlimited=1/=0 still applies.
    const STORY_BOUNDARY = false;
    this.storyBoundaryOn = STORY_BOUNDARY;
    if (import.meta.env.DEV) {
      const u = new URLSearchParams(location.search).get("unlimited");
      if (u === "1") Progression.setUnlimited(true);
      else if (u === "0") Progression.setUnlimited(false);
    }
    if (STORY_BOUNDARY) {
      const spanU = ChapterOnePlaceholderScene.CHAPTER_GRID_M / METERS_PER_UNIT;
      const waterU = 50 / METERS_PER_UNIT; // seaward margin
      const inlandX = ISLAND_CENTER.x - jackSpawn.x;
      const inlandZ = ISLAND_CENTER.z - jackSpawn.z;
      this.gridBounds = {
        minX: inlandX >= 0 ? jackSpawn.x - waterU : jackSpawn.x - (spanU - waterU),
        maxX: inlandX >= 0 ? jackSpawn.x + (spanU - waterU) : jackSpawn.x + waterU,
        minZ: inlandZ >= 0 ? jackSpawn.z - waterU : jackSpawn.z - (spanU - waterU),
        maxZ: inlandZ >= 0 ? jackSpawn.z + (spanU - waterU) : jackSpawn.z + waterU,
      };
      this.buildBoundary(scene);
    } else {
      this.gridBounds = ChapterOnePlaceholderScene.ISLAND; // open to the island
    }

    // Jack, just come to on the sand — standing dazed (no lying clip; tipping
    // him would snap upright when he first walks).
    this.jack = await this.buildCharacter("Jack", 0x3a78d0);
    if (this.disposed) return;
    this.jack.position.set(jackSpawn.x, beachHeight(jackSpawn.x, jackSpawn.z), jackSpawn.z);
    scene.add(this.jack);
    this.jackNav = new Navigator(this.jack, {
      speed: 16,
      arriveDistance: 0.6,
      resolveMove: (_cx, _cz, nx, nz) => this.clampToPlay(nx, nz),
    });

    // Sarah, washed up a few metres further along the same SSW beach — prone
    // until Jack reaches her.
    this.sarah = await this.buildCharacter("Sarah", 0x36b27a);
    if (this.disposed) return;
    this.sarah.position.set(sarahSpawn.x, beachHeight(sarahSpawn.x, sarahSpawn.z), sarahSpawn.z);
    this.sarah.rotation.y = sarahSpawn.rot;
    scene.add(this.sarah);
    this.setProne(this.sarah, true);

    // A curious dodo nearby (set-dressing positions scale with the world).
    this.dodo = await this.buildDodo();
    if (this.disposed) return;
    this.dodo.position.set(
      14 * MAP_SCALE,
      beachHeight(14 * MAP_SCALE, 244 * MAP_SCALE),
      244 * MAP_SCALE, // mirrored with the true-aerial-view flip (was z=0)
    );
    this.dodo.rotation.y = 0.6; // angled toward the beach, unbothered — for now
    scene.add(this.dodo);

    // Driftwood scattered up the sand (the "gather" objective anchor).
    const driftwood = this.buildDriftwood();
    driftwood.position.set(
      22 * MAP_SCALE,
      beachHeight(22 * MAP_SCALE, 230 * MAP_SCALE),
      230 * MAP_SCALE, // mirrored with the true-aerial-view flip (was z=14)
    );
    scene.add(driftwood);

    this.registerInteractions(driftwood);

    // The scripted first predator — hand-placed just inside the treeline (inland,
    // +Z of the arrival spawn), hidden until the reveal. Only for a fresh
    // first-person arrival (a resume drops the player back into free roam).
    if (this.firstPerson && freshArrival) {
      const inlandU = 40 / METERS_PER_UNIT; // 40 m up the beach, at the trees
      this.diloTreeline.set(
        jackSpawn.x + 8 / METERS_PER_UNIT,
        0,
        jackSpawn.z + inlandU,
      );
      this.diloTreeline.y = beachHeight(this.diloTreeline.x, this.diloTreeline.z);
      this.dilo = new StoryDilo();
      await this.dilo.load(ChapterOnePlaceholderScene.DILO_HEIGHT);
      if (this.disposed) return;
      this.dilo.placeAt(this.diloTreeline.x, this.diloTreeline.z);
      scene.add(this.dilo.group);
    }

    this.cameraDirector = new CameraDirector(this.camera);
    this.buildCameraZones();
    this.applyFov();
    // Snap the camera to its opening framing so the first rendered frame is right.
    this.cameraDirector.cut();
    this.cameraDirector.update(this.cameraState(), 0);

    this.director = new SequenceDirector({
      playVoice: () => Promise.resolve(),
      showSubtitle: (o) => this.ctx.dialogue.showSubtitle(o),
      hideSubtitle: () => this.ctx.dialogue.hideSubtitle(),
      setCameraMoment: (m, o) => this.setCameraMoment(m, o),
      clearCameraMoment: () => this.clearCameraMoment(),
      playGesture: () => Promise.resolve(),
      setObjective: (t) =>
        t ? this.ctx.quest.setObjective(t) : this.ctx.quest.clear(),
      waitForInteraction: (id) => this.waitForInteraction(id),
      chooseOption: (prompt, options) => this.chooseOption(prompt, options),
    });

    this.unsubSettings = subscribeSettings((s) => {
      this.settings = s;
      this.applyFov();
      this.maybeAutoAdvance();
    });
    this.buildSettingsButton();

    this.ctx.input.setEnabled(true);

    if (this.firstPerson) {
      // Hand the beach to the player in first person (same hybrid controls as the
      // prologue: drag-look + WASD / on-screen joystick). The cinematic director
      // stays dormant. Jack's mesh is hidden — the camera sits in his head — and
      // the camera rides the terrain surface each frame (see update()).
      this.player = new PlayerController(this.camera, this.ctx.input, {
        eyeHeight: ChapterOnePlaceholderScene.EYE,
        // Movement stats (m/s → u/s at 0.28125 m/u): walk 3.2, run (Shift / Run
        // toggle) 6.2 = ×1.9375, crouch (C / Crouch tap) 2.2 = ×0.6875, crawl
        // (X / Crouch-hold) 1.4 = ×0.4375 — prone, slowest, silent.
        moveSpeed: 11.38, // 3.2 m/s
        runMultiplier: 1.9375, // 6.2 m/s
        crouchMultiplier: 0.6875, // 2.2 m/s
        crawlMultiplier: 0.4375, // 1.4 m/s
        lookSensitivity: this.settings.lookSensitivity,
        // Stamina gate: at zero, sprint drops to a walk until it recovers.
        // Drives both the Shift key (desktop) and the Run ring button.
        canRun: () => (this.stats?.stamina ?? 100) > 0,
      });
      this.player.placeAt(this.jack.position.x, this.jack.position.z, this.jackFacingDeg);
      this.camY = beachHeight(this.jack.position.x, this.jack.position.z) + ChapterOnePlaceholderScene.EYE;
      this.player.setActive(true);
      // First-person BODY (Godot parity): Jack stays visible so looking down you
      // see his torso and legs, but his HEAD is shrunk away — the camera sits at
      // head height, so an intact head would fill the view with skull interior
      // (Godot's _apply_head_visibility does the same on the active character).
      this.jack.visible = true;
      this.hideHeadBones(this.jack);
      this.applyFov();
      if (ChapterOnePlaceholderScene.DEBUG_MOVE) {
        const dbg = document.createElement("div");
        dbg.style.cssText =
          "position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:80;" +
          "padding:6px 12px;border-radius:8px;background:rgba(6,12,20,0.78);" +
          "color:#8fffb0;font:600 13px/1.35 ui-monospace,monospace;white-space:pre;" +
          "text-align:center;pointer-events:none;letter-spacing:0.3px;";
        this.ctx.uiLayer.appendChild(dbg);
        this.dbgEl = dbg;
      }
      // Expose spawn-editing to the Dev menu: walk to a spot, open Dev tools, and
      // save it as Jack's or Sarah's island start point (persists to localStorage).
      this.registerSpawnTools();
      // HUD chrome (inventory + minimap): immediately on a resume; a fresh
      // arrival builds it after the cinematic so nothing floats over the journal.
      if (!freshArrival) this.buildFpHud();
    } else {
      // Legacy directed-gameplay path (click-to-move + cinematic story).
      this.unsubClick = this.ctx.input.onClick(() => this.handleClick());
    }

    if (this.firstPerson && freshArrival) {
      // Day One — Arrival: the journal page (opaque, layered above the fade
      // veil) owns the black screen; the flyover fades the world in itself.
      // Not awaited — enter() must resolve so the render loop can drive the
      // cinematic camera from update().
      void this.runArrival();
      return;
    }
    // The prologue hands off with the screen blacked out (its closing cut); lift
    // it so the beach is actually visible.
    await this.ctx.overlays.fadeFromBlack(900);
    if (this.disposed) return;
    if (!this.firstPerson) void this.runStory();
  }

  /**
   * Name of the HANIFAT story zone the player is standing in, or null in
   * unnamed wilderness (hides the minimap pill). Zones are authored on the
   * 2500 m map grid; radii scale through the same grid→world conversion as
   * the positions so a "20 m" circle drawn on the map brief stays the same
   * *fraction of the island* in-game.
   */
  private nearestLocationName(cx: number, cz: number): string | null {
    if (!this.locZones) {
      const worldPerGridMetre = ISLAND_SPAN / MAP_METRES;
      this.locZones = ISLAND_LOCATIONS.map((loc) => {
        const w = locationWorld(loc);
        const r = loc.radius * worldPerGridMetre;
        return { name: loc.name, x: w.x, z: w.z, r2: r * r };
      });
    }
    let best: string | null = null;
    let bestD = Infinity;
    for (const zone of this.locZones) {
      const dx = cx - zone.x;
      const dz = cz - zone.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= zone.r2 && d2 < bestD) {
        bestD = d2;
        best = zone.name;
      }
    }
    return best;
  }

  /** First-person HUD chrome: inventory overlay + satellite minimap + survival
   *  HUD. Built immediately on a resume, or after the arrival cinematic on day
   *  one. Guard against double-build with the inventory presence check. */
  private buildFpHud(): void {
    if (this.disposed || this.inventory) return;

    // HUD layout editor shows the island element set while this scene is live
    // (survival clusters instead of the lab objective card). Reset in dispose().
    setHudEditorContext("island");

    // ARK-style survival model — feeds the HUD with live stamina/food/water/
    // temperature/day values. One instance per scene entry; stats reset fresh.
    this.stats = new SurvivalStats();
    this.stats.onDeath = () => void this.onPlayerDeath();

    // On-screen objective pointer (guides the player now that the play area is
    // open — no hard boundary). Aimed at the active objective below.
    this.objMarker = new HudMarker(this.ctx.uiLayer);

    // Jack's inventory (badge + coffee) + the DEV tab, same ARK overlay as the
    // prologue. Opening it freezes movement; closing restores it.
    this.inventory = new InventoryOverlay(this.ctx.uiLayer, {
      getObjective: () => "",
      setFrozen: (frozen) => this.ctx.input.setEnabled(!frozen),
      canOpen: () => this.firstPerson && !this.disposed,
      getRole: () => "JACK · Survivor",
      playSfx: (n) => this.ctx.audio.playSfx(n),
      onSave: () => this.manualSaveIsland(),
    });

    // Satellite minimap (tap to open the full map with pinch-zoom/pan).
    // Passing the world scene switches the minimap to a LIVE top-down render
    // (what's really there — no baked image, immune to world rescales).
    this.islandMap = new IslandMap(this.ctx.uiLayer, this.scene);

    // Hybrid ARK × Path of Titans survival HUD. Two exclusive modes:
    //   On-foot  → menu / status / tracker / hotbar / stamina-water bars
    //   Mounted  → menu / status / tracker / ring / abilities / creature vitals
    // Toggle via survivalHud.setMounted(creatureStats | null).
    this.survivalHud = new SurvivalHud({
      parent: this.ctx.uiLayer,
      input: this.ctx.input,
      stats: this.stats,
      quest: this.ctx.quest,
      audio: this.ctx.audio,
      onOpenMenu: () => {
        this.ctx.audio.playSfx("ui-select");
        const wasEnabled = this.ctx.input.inputEnabled;
        this.ctx.input.setEnabled(false);
        openSettingsPanel({
          parent: this.ctx.uiLayer,
          audio: this.ctx.audio,
          onClose: () => {
            if (!this.disposed) this.ctx.input.setEnabled(wasEnabled);
          },
          // Show/hide the story-grid boundary live as Unlimited Mode toggles.
          onUnlimitedChange: (on) => {
            if (this.boundaryBox) this.boundaryBox.visible = !on;
          },
        });
      },
      onOpenMap: () => this.islandMap?.openFull(),
      onOpenCodex: () => this.inventory?.toggle(),
    });

    this.buildFeedUI();
    // The E key / long-press interact also feeds when a croc is basking nearby.
    this.unsubFeed = this.ctx.input.onInteract(() => this.tryFeed());
  }

  // ---------- Passive taming ----------

  /** Contextual Feed button + the post-feed "back off" countdown bar. */
  private buildFeedUI(): void {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "be-feed-btn";
    btn.style.display = "none";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      this.tryFeed();
    });
    this.ctx.uiLayer.appendChild(btn);
    this.feedBtnEl = btn;

    const bar = document.createElement("div");
    bar.className = "be-feed-bar";
    bar.style.display = "none";
    bar.innerHTML = `<span class="be-feed-bar__label">Back off!</span><div class="be-feed-bar__track"><i></i></div>`;
    this.feedBarFillEl = bar.querySelector(".be-feed-bar__track i")!;
    this.ctx.uiLayer.appendChild(bar);
    this.feedBarEl = bar;

    // Track button: whatever creature is under the crosshair gets tracked
    // (persistent label + no-cull + saved). Always available in free roam.
    const track = document.createElement("button");
    track.type = "button";
    track.className = "be-track-btn";
    track.textContent = "🎯 Track";
    track.style.display = "none";
    track.addEventListener("click", (e) => {
      e.preventDefault();
      this.tryTrack();
    });
    this.ctx.uiLayer.appendChild(track);
    this.trackBtnEl = track;

    // Tamed-creature command button (⚙) — shown when the crosshair is on a
    // tamed croc; opens the interaction menu.
    const pet = document.createElement("button");
    pet.type = "button";
    pet.className = "be-pet-btn";
    pet.textContent = "⚙ Command";
    pet.style.display = "none";
    pet.addEventListener("click", (e) => {
      e.preventDefault();
      this.openTameMenu();
    });
    this.ctx.uiLayer.appendChild(pet);
    this.petBtnEl = pet;

    // The interaction menu overlay (ARK Mobile-style order list).
    const menu = document.createElement("div");
    menu.className = "be-tame-menu";
    menu.style.display = "none";
    menu.innerHTML = `
      <div class="be-tame-menu__panel">
        <div class="be-tame-menu__title"></div>
        <div class="be-tame-menu__orders">
          <button type="button" data-order="follow">Follow</button>
          <button type="button" data-order="stay">Stay</button>
          <button type="button" data-order="wander">Wander</button>
        </div>
        <button type="button" class="be-tame-menu__agg" data-agg></button>
        <button type="button" class="be-tame-menu__close" data-close>Close</button>
      </div>`;
    this.ctx.uiLayer.appendChild(menu);
    this.tameMenuEl = menu;
    menu.querySelector("[data-close]")?.addEventListener("click", () => this.closeTameMenu());
    menu.querySelectorAll<HTMLButtonElement>("[data-order]").forEach((b) => {
      b.addEventListener("click", () =>
        this.setTameOrder(b.dataset.order as "follow" | "stay" | "wander"),
      );
    });
    menu.querySelector("[data-agg]")?.addEventListener("click", () => this.toggleTameAgg());
  }

  private openTameMenu(): void {
    if (this.disposed || !this.seaCreatures || !this.tameMenuEl) return;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const t = this.seaCreatures.tamedUnderRay(this.camera.position, dir);
    if (!t) return;
    this.tameMenuTargetId = t.id;
    const menu = this.tameMenuEl;
    menu.querySelector(".be-tame-menu__title")!.textContent = `${t.name}`;
    menu.querySelectorAll<HTMLButtonElement>("[data-order]").forEach((b) => {
      b.classList.toggle("active", b.dataset.order === t.behavior);
    });
    // Passive/Aggressive is disabled until creature-vs-creature combat exists —
    // the flag is stored but nothing reads it yet, so don't imply behaviour.
    const agg = menu.querySelector<HTMLButtonElement>("[data-agg]")!;
    agg.textContent = "Defend — coming soon";
    agg.disabled = true;
    agg.classList.remove("active");
    menu.style.display = "flex";
    this.ctx.input.setEnabled(false); // freeze look/move while the menu is open
    if (this.petBtnEl) this.petBtnEl.style.display = "none";
  }

  private closeTameMenu(): void {
    if (this.tameMenuEl) this.tameMenuEl.style.display = "none";
    this.tameMenuTargetId = undefined;
    if (!this.disposed) this.ctx.input.setEnabled(true);
  }

  private setTameOrder(order: "follow" | "stay" | "wander"): void {
    if (this.tameMenuTargetId == null || !this.seaCreatures) return;
    this.seaCreatures.setBehavior(this.tameMenuTargetId, order);
    this.ctx.audio.playSfx("ui-select");
    this.ctx.overlays.showToast(`Order: ${order}`);
    this.persistIsland();
    this.closeTameMenu();
  }

  private toggleTameAgg(): void {
    if (this.tameMenuTargetId == null || !this.seaCreatures || !this.tameMenuEl) return;
    const agg = this.tameMenuEl.querySelector<HTMLButtonElement>("[data-agg]")!;
    const on = !agg.classList.contains("active");
    this.seaCreatures.setAggressive(this.tameMenuTargetId, on);
    agg.textContent = on ? "Aggressive" : "Passive";
    agg.classList.toggle("active", on);
    this.persistIsland();
  }

  /** Toggle tracking on whatever creature is under the crosshair. */
  private tryTrack(): void {
    if (this.disposed || !this.seaCreatures) return;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const res = this.seaCreatures.trackUnderRay(this.camera.position, dir);
    if (!res) {
      this.ctx.overlays.showToast("Nothing under the crosshair");
      return;
    }
    this.ctx.audio.playSfx("ui-select");
    this.ctx.overlays.showToast(res.tracked ? `Tracking ${res.name}` : `Untracked ${res.name}`);
    this.persistIsland(); // so the track list survives save & leave
  }

  /** Re-autosave the island with the current inventory + live fauna state. */
  private persistIsland(): void {
    if (this.disposed) return;
    SaveManager.autosave({
      label: "Chapter One — The Island",
      scene: "island",
      inventory: {
        hasBadge: PlayerInventory.hasBadge,
        heldItems: [...PlayerInventory.heldItems],
      },
      flags: { fauna: this.seaCreatures?.serialize() ?? [] },
    });
  }

  /** Feed the nearest basking croc (Feed button / E key). */
  private tryFeed(): void {
    if (this.disposed || this.feedWindowT > 0 || this.respawning) return;
    if (!this.seaCreatures || !this.stats) return;
    if (PlayerInventory.count("meat") <= 0) return;
    const res = this.seaCreatures.feed(
      this.camera.position,
      ChapterOnePlaceholderScene.FEED_RANGE_M,
    );
    if (!res) return;
    PlayerInventory.drop("meat");
    this.ctx.audio.playSfx("badge-pickup"); // a soft "gulp" cue for now
    // Open the back-off window: the croc eats, then turns hostile.
    this.feedWindowT = 4;
    if (this.feedBtnEl) this.feedBtnEl.style.display = "none";
    if (this.feedBarEl) this.feedBarEl.style.display = "flex";
  }

  private onCreatureTamed(name: string): void {
    if (this.disposed) return;
    this.ctx.dialogue.showSubtitle({ speaker: "", text: `${name} tamed!` });
    this.ctx.audio.playSfx("ui-select");
    this.persistIsland(); // keep the tame through save & resume
    window.setTimeout(() => {
      if (!this.disposed) this.ctx.dialogue.hideSubtitle();
    }, 2600);
  }

  /** Per-frame: drive the Feed prompt + the back-off countdown bar. */
  private updateFeedUI(dt: number, active: boolean): void {
    // Track button rides along with free-roam play.
    if (this.trackBtnEl) {
      this.trackBtnEl.style.display = active ? "block" : "none";
    }
    // While the interaction menu is open, hide the contextual buttons.
    const menuOpen = this.tameMenuEl?.style.display === "flex";
    // Post-feed window: count the "back off" bar down.
    if (this.feedWindowT > 0) {
      this.feedWindowT -= dt;
      if (this.feedBarFillEl) {
        this.feedBarFillEl.style.width = `${Math.max(0, (this.feedWindowT / 4) * 100)}%`;
      }
      if (this.feedWindowT <= 0 && this.feedBarEl) this.feedBarEl.style.display = "none";
      if (this.feedBtnEl) this.feedBtnEl.style.display = "none";
      if (this.petBtnEl) this.petBtnEl.style.display = "none";
      return;
    }
    const btn = this.feedBtnEl;
    const canSee = active && this.seaCreatures && !menuOpen;
    const dir = new THREE.Vector3();
    if (canSee) this.camera.getWorldDirection(dir);
    const R = ChapterOnePlaceholderScene.FEED_RANGE_M;

    // Feed button: a basking croc in reach + meat → Feed; else a cooling croc
    // nearby → a disabled "ready in Ns" meter; else hidden.
    if (btn) {
      const target =
        canSee && PlayerInventory.count("meat") > 0
          ? this.seaCreatures!.feedTarget(this.camera.position, R)
          : null;
      if (target) {
        btn.textContent = `🥩 Feed ${target.name} · ${target.tamePct}%`;
        btn.classList.remove("be-feed-btn--wait");
        btn.style.display = "block";
      } else {
        const cd = canSee ? this.seaCreatures!.feedCooldown(this.camera.position, R) : null;
        if (cd) {
          btn.textContent = `🥩 ${cd.name} ready in ${cd.secs}s`;
          btn.classList.add("be-feed-btn--wait");
          btn.style.display = "block";
        } else if (btn.style.display !== "none") {
          btn.style.display = "none";
        }
      }
    }

    // ⚙ Command button: shown when the crosshair is on a tamed creature.
    if (this.petBtnEl) {
      const tamed = canSee
        ? this.seaCreatures!.tamedUnderRay(this.camera.position, dir)
        : null;
      this.petBtnEl.style.display = tamed ? "block" : "none";
    }
  }

  // ---------- Chapter Two: "Day One — Arrival" cinematic ----------

  /** Godot island_story.gd parity: the journal entry typed over black in sync
   *  with the VO → nightmare SFX (still black) → a skippable establishing
   *  flyover that fades the island in and settles behind Jack → "SARAH!" →
   *  the Find Sarah objective. */
  private async runArrival(): Promise<void> {
    const audio = this.ctx.audio;
    this.ctx.input.setEnabled(false);
    this.player?.setActive(false);

    // ── 1. Journal page over black (opaque; sits above the scene fade veil,
    // so it owns the black screen no matter when SceneManager lifts the fade).
    const root = document.createElement("div");
    root.className = "be-journal";
    root.style.transition = "none"; // opaque from the first frame
    root.classList.add("show");
    const text = document.createElement("div");
    text.className = "be-journal__text";
    root.appendChild(text);
    this.ctx.uiLayer.appendChild(root);
    this.arrivalJournal = root;
    this.journalTextEl = text;

    // The prologue handed off on a closing cut to black (the SceneManager veil)
    // and we swapped scenes with fade=false, so nothing ever lifted that veil.
    // The opaque journal now covers the screen, so clear the leftover veil
    // underneath — otherwise it stays black through the entire flyover and the
    // camera is never seen (only the HUD + underwater tint show above it), which
    // is why lab→island was all black while a menu Skip (no closing cut) worked.
    this.ctx.overlays.setBlackInstant(false);

    await this.waitMs(700);
    if (this.disposed) return;
    this.typewrite(VOICE_CLIPS["ch2_jack_journal"]?.text ?? "", "ch2_jack_journal");
    await audio.playVoice("ch2_jack_journal");
    if (this.disposed) return;
    await this.waitMs(300);
    if (this.disposed) return;

    // ── 2. Straight into the establishing flyover — the camera does the rest.
    // The journal clip (~5.7s) is the ONLY hold on black; from here the flyover
    // fades the world in and flies to Jack. The nightmare stingers (crash →
    // roar → gasp) fire NON-blocking so they ride over the opening reveal/dive
    // instead of holding the screen black for another ~5s.
    text.style.transition = "opacity 0.6s ease";
    text.style.opacity = "0";
    audio.playMusic("beach-dawn");
    audio.playSfx("jungle-crash");
    void (async () => {
      await this.waitMs(1400);
      if (this.disposed || !this.flyoverState) return;
      audio.playSfx("roar-distant");
      await this.waitMs(1600);
      if (this.disposed || !this.flyoverState) return;
      audio.playSfx("gasp");
    })();
    await this.runFlyover(root);
    if (this.disposed) return;
    this.arrivalJournal = undefined;
    this.journalTextEl = undefined;

    // Hand the beach to the player, then Jack calls for her.
    this.buildFpHud();
    this.ctx.input.setEnabled(true);
    this.player?.setActive(true);
    await this.waitMs(400);
    if (this.disposed) return;
    this.ctx.dialogue.showSubtitle({ speaker: "Jack", text: "SARAH!" });
    await audio.playVoice("ch2_jack_sarah_shout");
    this.ctx.dialogue.hideSubtitle();
    if (this.disposed) return;

    // ── 4. Objective: find her (the proximity trigger lives in update()).
    this.ctx.quest.setObjective("Find Sarah");
    this.interactions.get("find-sarah")?.highlight.setVisible(true);
    this.objMarker?.set(this.sarah.position, "Sarah", "🧭", 8);
    this.findSarahArmed = true;
  }

  /** Reveal `text` in sync with voice clip `id` — JournalIntroScene's playback
   *  tracker: type against the real audio clock, fall back to the manifest
   *  duration when playback isn't available (muted/blocked autoplay). */
  private typewrite(text: string, id: string): void {
    if (this.typeRaf !== null) cancelAnimationFrame(this.typeRaf);
    const el = this.journalTextEl;
    if (!el) return;
    el.textContent = "";
    const len = Math.max(text.length, 1);
    const LEAD = 0.92; // finish typing slightly before the VO ends
    const fallbackMs = Math.max(this.ctx.audio.getVoiceDuration(id), 1);
    const startPerf = performance.now();
    let revealed = 0;
    const tick = () => {
      if (this.disposed) return;
      const pb = this.ctx.audio.getVoicePlayback();
      const frac =
        pb.active && pb.duration > 0
          ? pb.currentTime / (pb.duration * LEAD)
          : (performance.now() - startPerf) / (fallbackMs * LEAD);
      const shown = Math.max(revealed, Math.min(1, frac));
      revealed = shown;
      el.textContent = text.slice(0, Math.round(shown * len));
      if (shown < 1) this.typeRaf = requestAnimationFrame(tick);
      else {
        el.textContent = text;
        this.typeRaf = null;
      }
    };
    tick();
  }

  private waitMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Drone flight: high offshore reveal → descend → skim the water → dive
   *  under → surface → race in → settle just off Jack at eye height. The
   *  waypoints are the Godot script's, metres relative to Jack along the true
   *  seaward axis (island centre → Jack, pointing offshore). Any key or tap
   *  skips to the end. Resolves when the flight (or skip) completes. */
  private runFlyover(page: HTMLDivElement): Promise<void> {
    const j = this.jack.position.clone();
    const s2 = new THREE.Vector2(j.x - ISLAND_CENTER.x, j.z - ISLAND_CENTER.z);
    if (s2.lengthSq() < 1e-6) s2.set(0, 1);
    s2.normalize();
    const S = new THREE.Vector3(s2.x, 0, s2.y);
    const m = (metres: number) => metres / METERS_PER_UNIT;
    // Waypoint builder: `sea` metres seaward of Jack, `up` metres above him.
    // The underwater leg clamps to the seabed so the dive never clips terrain.
    const P = (sea: number, up: number) => {
      const v = j.clone().addScaledVector(S, m(sea));
      v.y += m(up);
      if (up < 0) v.y = Math.max(v.y, beachHeight(v.x, v.z) + m(2));
      return v;
    };
    // {p: camera, l: look target, d: seconds from the previous waypoint}.
    const wps = [
      { p: P(640, 190), l: P(120, 4), d: 0 },
      { p: P(560, 80), l: P(100, 3), d: 4.5 },
      { p: P(510, 10), l: P(430, 1), d: 4.0 },
      { p: P(495, -9), l: P(440, -6), d: 2.5 }, // DIVE
      { p: P(470, -11), l: P(410, -8), d: 3.0 },
      { p: P(435, -9), l: P(360, -5), d: 3.0 }, // surfacing
      { p: P(380, 12), l: P(120, 3), d: 3.5 },
      { p: P(150, 40), l: P(0, 3), d: 5.0 }, // race in toward the beach
      { p: P(8, 2.4), l: P(0, 1.6), d: 4.5 }, // settle just off Jack, cut to FP
    ];
    const total = wps.reduce((sum, w) => sum + w.d, 0);

    // The flyover's own wider lens; finishFlyover() restores the player FOV.
    this.camera.fov =
      ChapterOnePlaceholderScene.FLYOVER_FOV + portraitFovBoost(this.camera.aspect);
    this.camera.updateProjectionMatrix();

    // Jack's head is shrunk for first person — restore it: the flight looks AT him.
    this.setHeadBonesHidden(this.jack, false);

    // Underwater blue wash while the camera is below the surface.
    const tint = document.createElement("div");
    tint.style.cssText =
      "position:fixed;inset:0;z-index:54;pointer-events:none;" +
      "background:rgb(13,56,97);opacity:0;";
    this.ctx.uiLayer.appendChild(tint);
    this.uwTint = tint;

    // Fade out of black across the first seconds of the flight.
    page.style.transition = "opacity 2.2s ease";
    page.classList.remove("show");

    // Any key or tap skips.
    this.flyoverSkip = false;
    const skip = () => {
      this.flyoverSkip = true;
    };
    window.addEventListener("keydown", skip);
    window.addEventListener("pointerdown", skip);
    this.skipUnsub = () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
    };

    return new Promise<void>((resolve) => {
      this.flyoverState = { wps, total, elapsed: 0, resolve };
    });
  }

  /** Per-frame flyover camera: Catmull-Rom through the waypoints (C1-smooth,
   *  no per-segment stop-start — Godot's _fly_sample), plus the underwater
   *  wash cross-fade. Called from update() while flyoverState is set. */
  private updateFlyover(dt: number): void {
    const f = this.flyoverState;
    if (!f) return;
    f.elapsed = this.flyoverSkip ? f.total : f.elapsed + dt;
    const t = Math.min(f.elapsed, f.total);
    const s = this.flySample(f.wps, t);
    this.camera.position.copy(s.p);
    this.camera.lookAt(s.l);
    if (this.uwTint) {
      const target = this.camera.position.y < 0 ? 0.65 : 0;
      const a = parseFloat(this.uwTint.style.opacity || "0");
      const step = Math.min(Math.abs(target - a), dt * 2.5);
      this.uwTint.style.opacity = (a + Math.sign(target - a) * step).toFixed(3);
    }
    if (f.elapsed >= f.total) this.finishFlyover();
  }

  private finishFlyover(): void {
    const f = this.flyoverState;
    if (!f) return;
    this.flyoverState = null;
    this.skipUnsub?.();
    this.skipUnsub = undefined;
    // Snap to the settle pose so the FP handoff starts from the final shot.
    const last = f.wps[f.wps.length - 1];
    this.camera.position.copy(last.p);
    this.camera.lookAt(last.l);
    // Clear the underwater wash and the journal page.
    const tint = this.uwTint;
    if (tint) {
      tint.style.transition = "opacity 0.3s ease";
      tint.style.opacity = "0";
      setTimeout(() => tint.remove(), 400);
      this.uwTint = undefined;
    }
    this.arrivalJournal?.remove();
    // Back to first person: hide the head again (the camera moves back inside
    // it), restore the gameplay FOV, and re-seat the eye on the terrain.
    this.setHeadBonesHidden(this.jack, true);
    this.applyFov();
    if (this.player) {
      this.player.placeAt(this.jack.position.x, this.jack.position.z, this.jackFacingDeg);
      this.camY =
        beachHeight(this.jack.position.x, this.jack.position.z) + this.eyeOffset;
      this.vy = 0;
      this.onGround = true;
    }
    f.resolve();
  }

  /** Sample the flight path at time `t`: find the active segment, then run a
   *  uniform Catmull-Rom through the surrounding four waypoints (both the
   *  camera position and the look target get the same treatment). */
  private flySample(
    wps: { p: THREE.Vector3; l: THREE.Vector3; d: number }[],
    t: number,
  ): { p: THREE.Vector3; l: THREE.Vector3 } {
    let acc = 0;
    let i = 1;
    while (i < wps.length - 1 && t > acc + wps[i].d) {
      acc += wps[i].d;
      i++;
    }
    const seg = Math.max(wps[i].d, 0.0001);
    const u = THREE.MathUtils.clamp((t - acc) / seg, 0, 1);
    const i0 = Math.max(i - 2, 0);
    const i3 = Math.min(i + 1, wps.length - 1);
    return {
      p: catmull(wps[i0].p, wps[i - 1].p, wps[i].p, wps[i3].p, u),
      l: catmull(wps[i0].l, wps[i - 1].l, wps[i].l, wps[i3].l, u),
    };
  }

  /** Jack reaches Sarah: she wakes and stands. (The full shot/reverse-shot
   *  reunion dialogue is the next port milestone; free roam continues.) */
  private async sarahFound(): Promise<void> {
    this.interactions.get("find-sarah")?.highlight.setVisible(false);
    this.objMarker?.set(null); // reached her — clear until the next objective
    this.faceTowards(this.sarah, this.jack.position);
    await this.wake(this.sarah, 1100);
    if (this.disposed) return;
    // With the Dilo staged, point the player toward the treeline — walking up to
    // it springs the first-encounter reveal. Otherwise, plain free roam.
    if (this.dilo) {
      this.ctx.dialogue.showSubtitle({
        speaker: "Sarah",
        text: "We can't stay in the open. The trees — there'll be cover.",
      });
      await this.waitMs(2600);
      if (this.disposed) return;
      this.ctx.dialogue.hideSubtitle();
      this.ctx.quest.setObjective("Head inland — reach the treeline");
      this.objMarker?.set(this.diloTreeline, "Treeline", "🌴", 10);
      this.diloArmed = true;
    } else {
      this.ctx.quest.setObjective("Assess the situation");
      this.objMarker?.set(null);
    }
  }

  /**
   * The scripted first-encounter reveal — the memorable beat, not a random AI
   * spawn. Freeze the player and take the camera, the Dilophosaurus stalks out of
   * the treeline, rears up with a snarl (the crest-flare display), lunges at the
   * camera, then a hard cut to black and the far, giant roar closes the slice.
   */
  private async runDiloReveal(): Promise<void> {
    if (this.diloRevealStarted || !this.dilo || this.disposed) return;
    this.diloRevealStarted = true;
    const audio = this.ctx.audio;

    // Freeze the player; the camera holds at their eye and locks onto the animal.
    this.ctx.input.setEnabled(false);
    this.player?.setActive(false);
    this.ctx.quest.clear();
    this.objMarker?.set(null);
    this.ctx.overlays.hideHint();

    const eye = this.camera.position.clone();
    this.dilo.faceToward(eye);
    this.revealLook = this.dilo.headWorld(new THREE.Vector3());
    this.dilo.setVisible(true);
    this.hissDone = true;
    if (this.dodo) this.dodo.rotation.y = this.dilo.group.rotation.y + Math.PI; // bolts away from the trees
    audio.playSfx("large-creature-hiss");
    audio.playSfx("dilo-call");

    // 1) It stalks a couple of steps clear of the trees.
    this.dilo.play("Walk", 0.2);
    for (let i = 0; i < 10 && !this.disposed; i++) {
      this.dilo.moveForward(0.9);
      await this.waitMs(90);
    }
    if (this.disposed) return;

    // 2) Rear-up threat display + snarl — the crest-flare beat, chase sting hits.
    this.dilo.play("Idle", 0.15);
    this.dilo.playOnce("Menace");
    audio.playSfx("dilo-snarl");
    audio.playMusic("dilo-chase");
    this.ctx.dialogue.showSubtitle({ speaker: "Sarah", text: "Jack — RUN!" });
    await this.waitMs(1500);
    if (this.disposed) return;
    this.ctx.dialogue.hideSubtitle();

    // 3) It lunges at the camera.
    this.dilo.faceToward(this.camera.position);
    this.dilo.playOnce("Lunge");
    audio.playSfx("dilo-spit");
    for (let i = 0; i < 6 && !this.disposed; i++) {
      this.dilo.moveForward(1.6);
      await this.waitMs(45);
    }
    if (this.disposed) return;

    // 4) Hard cut to black + the far, giant roar — "what was THAT?"
    this.ctx.overlays.setBlackInstant(true);
    audio.playSfx("roar-distant");
    await this.waitMs(1700);
    if (this.disposed) return;
    this.revealLook = null;
    this.showEndCard();
  }

  // ---------- Story ----------

  private async runStory(): Promise<void> {
    await this.director.play(beachStory);
    if (this.disposed) return;
    this.ctx.quest.clear();
    this.ctx.overlays.hideHint();
    this.showEndCard();
  }

  /** "Tap" on touch, "Click" with a mouse — for phrasing hints. */
  private get walkHint(): string {
    return this.ctx.input.isTouch
      ? "Tap the glowing objective"
      : "Click the glowing objective";
  }

  // ---------- Interaction gates ----------

  private registerInteractions(driftwood: THREE.Object3D): void {
    // Find Sarah: walk up to her side; she wakes and stands.
    const sarahHl = new ObjectiveHighlight(this.scene, this.sarah, {
      color: "friendly",
      icon: "\u{1F4AC}",
      radius: 1.8,
      markerHeight: 7.6,
    });
    sarahHl.setVisible(false);
    this.highlights.push(sarahHl);
    this.interactions.set("find-sarah", {
      target: this.sarah,
      walkTo: this.standOffsetTo(this.sarah, 4.5),
      radius: 7,
      highlight: sarahHl,
      onPerform: async () => {
        this.faceTowards(this.jack, this.sarah.position);
        await this.wake(this.sarah, 1100);
        if (this.disposed) return;
        this.faceTowards(this.sarah, this.jack.position);
      },
    });

    // Gather driftwood: walk to the pile; it sinks away as Jack collects it.
    const woodHl = new ObjectiveHighlight(this.scene, driftwood, {
      color: "info",
      icon: "\u{1FAB5}",
      radius: 1.6,
      markerHeight: 3.4,
    });
    woodHl.setVisible(false);
    this.highlights.push(woodHl);
    this.interactions.set("gather-driftwood", {
      target: driftwood,
      walkTo: this.standOffsetTo(driftwood, 3.5),
      radius: 5.5,
      highlight: woodHl,
      onPerform: async () => {
        this.faceTowards(this.jack, driftwood.position);
        await this.sink(driftwood, 700);
      },
    });
  }

  /** A point `dist` units from `obj` toward Jack — so he stops short, not on top. */
  private standOffsetTo(obj: THREE.Object3D, dist: number): THREE.Vector3 {
    const stand = obj.position.clone();
    const toJack = this.jack.position.clone().sub(obj.position);
    toJack.y = 0;
    stand.add(
      toJack.lengthSq() > 1e-4
        ? toJack.normalize().multiplyScalar(dist)
        : new THREE.Vector3(dist, 0, 0),
    );
    stand.y = 0;
    return stand;
  }

  /**
   * The director's ACTION gate. Reveals the objective's highlight + hint, then
   * resolves when the player taps it (Interactive) or, under Auto Play, after a
   * short beat the scene drives Jack to it itself.
   */
  private waitForInteraction(id: string): Promise<void> {
    const interaction = this.interactions.get(id);
    if (!interaction) return Promise.resolve();
    interaction.highlight.setVisible(true);
    this.ctx.overlays.showHint(this.walkHint);
    return new Promise<void>((resolve) => {
      this.pending = { id, resolve };
      if (this.settings.autoPlay) {
        this.autoPlayTimer = setTimeout(() => {
          this.autoPlayTimer = null;
          if (!this.disposed && this.pending?.id === id) this.driveTo(interaction);
        }, ChapterOnePlaceholderScene.AUTOPLAY_DELAY_MS);
      }
    });
  }

  /**
   * React to Auto Play being switched ON while a trigger is already waiting for
   * the player: drive the pending objective straight away instead of leaving
   * Jack stuck waiting for a tap. (Auto Play that was already on when the gate
   * opened is handled by waitForInteraction's scheduled beat.) Genuine choices
   * never go through `pending`, so they still always pause for the player.
   */
  private maybeAutoAdvance(): void {
    if (this.disposed || !this.settings.autoPlay) return;
    if (!this.pending || this.choiceOpen) return;
    // Already mid-drive (timer pending or Jack walking) — nothing to kick off.
    if (this.autoPlayTimer || this.jackNav.isMoving) return;
    const interaction = this.interactions.get(this.pending.id);
    if (interaction) this.driveTo(interaction);
  }

  /** Genuine choice — always pauses for the player, even under Auto Play. */
  private async chooseOption(
    prompt: string,
    options: { id: string; label: string }[],
  ): Promise<string> {
    this.ctx.overlays.hideHint();
    this.choiceOpen = true;
    const chosen = await this.ctx.overlays.showChoice(prompt, options);
    this.choiceOpen = false;
    return chosen;
  }

  /**
   * Guided, not free-roam: the only meaningful tap is on the current objective.
   * A tap while a gate is open drives Jack to it (a miss still resolves to it —
   * there's only ever one active objective on screen).
   */
  private handleClick(): void {
    if (this.choiceOpen || this.ctx.dialogue.isActive || !this.pending) return;
    const interaction = this.interactions.get(this.pending.id);
    if (!interaction || this.jackNav.isMoving) return;
    this.driveTo(interaction);
  }

  /** Hide the marker, walk Jack over, then run the gate's side effect. */
  private driveTo(interaction: BeachInteraction): void {
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    interaction.highlight.setVisible(false);
    this.ctx.overlays.hideHint();
    const dest = interaction.walkTo ?? interaction.target.position.clone();
    if (this.jack.position.distanceTo(dest) <= interaction.radius) {
      void this.completeInteraction(interaction);
      return;
    }
    this.jackNav.goTo(dest, () => void this.completeInteraction(interaction));
  }

  private async completeInteraction(interaction: BeachInteraction): Promise<void> {
    const settle = this.pending;
    this.pending = null;
    await interaction.onPerform();
    if (this.disposed) return;
    settle?.resolve();
  }

  // ---------- Camera ----------

  private cameraState(): CameraZoneState {
    return {
      jack: this.jack.position,
      sarah: this.sarah.position,
      framingScale: this.framingScale(),
      moment: this.scriptedCameraMoment,
    };
  }

  private framingScale(): number {
    return autoFramingScale(this.camera.aspect, this.viewportHeight) / this.settings.zoom;
  }

  private applyFov(): void {
    this.camera.fov = this.settings.fov + portraitFovBoost(this.camera.aspect);
    this.camera.updateProjectionMatrix();
  }

  private setCameraMoment(moment: string, opts?: { cut?: boolean }): void {
    this.scriptedCameraMoment = moment;
    if (opts?.cut) this.cameraDirector.cut();
    // The chase teaser is also when the treeline threat announces itself.
    if (moment === "chase" && !this.hissDone) {
      this.hissDone = true;
      this.ctx.audio.playSfx("large-creature-hiss");
    }
  }

  private clearCameraMoment(): void {
    this.scriptedCameraMoment = null;
  }

  /** Resolve a scripted framing to a concrete position/lookAt, or null. */
  private cameraMoment(
    id: string,
    s: CameraZoneState,
  ): { position: THREE.Vector3; lookAt: THREE.Vector3 } | null {
    if (id === "wake") {
      const focus = s.jack.clone();
      focus.y += 3;
      return {
        position: s.jack
          .clone()
          .add(new THREE.Vector3(-5, 7, 15).multiplyScalar(s.framingScale)),
        lookAt: focus,
      };
    }
    if (id === "two-shot") {
      const mid = s.jack.clone().lerp(s.sarah, 0.5);
      const look = mid.clone();
      look.y += 3.5;
      return {
        position: mid
          .clone()
          .add(new THREE.Vector3(2, 6, 17).multiplyScalar(s.framingScale)),
        lookAt: look,
      };
    }
    if (id === "dodo") {
      const focus = this.dodo.position.clone();
      focus.y += 2.5;
      return {
        position: focus
          .clone()
          .add(new THREE.Vector3(-3, 6, 14).multiplyScalar(s.framingScale)),
        lookAt: focus,
      };
    }
    if (id === "treeline") {
      const focus = s.jack.clone();
      focus.y += 3;
      focus.z += 18;
      return {
        position: s.jack
          .clone()
          .add(new THREE.Vector3(0, 9, -16).multiplyScalar(s.framingScale)),
        lookAt: focus,
      };
    }
    if (id === "shoreline") {
      const focus = s.jack.clone();
      focus.y += 3;
      focus.z -= 18;
      return {
        position: s.jack
          .clone()
          .add(new THREE.Vector3(0, 9, 18).multiplyScalar(s.framingScale)),
        lookAt: focus,
      };
    }
    if (id === "chase") {
      const mid = s.jack.clone().lerp(s.sarah, 0.5);
      const look = mid.clone();
      look.y += 4;
      look.z += 24;
      return {
        position: mid
          .clone()
          .add(new THREE.Vector3(0, 12, 26).multiplyScalar(s.framingScale)),
        lookAt: look,
      };
    }
    return null;
  }

  private buildCameraZones(): void {
    // Scripted cinematic moments win while a moment is set.
    const scripted: CameraZone<CameraZoneState> = {
      id: "scripted",
      priority: 100,
      easeSpeed: 0.08,
      isActive: (s) => s.moment !== null && this.cameraMoment(s.moment, s) !== null,
      position: (s) => this.cameraMoment(s.moment!, s)!.position,
      lookAt: (s) => this.cameraMoment(s.moment!, s)!.lookAt,
    };
    // Fallback: a plain three-quarter follow on Jack.
    const follow: CameraZone<CameraZoneState> = {
      id: "follow",
      priority: 0,
      easeSpeed: 0.08,
      isActive: () => true,
      position: (s) => s.jack.clone().add(this.camOffset.clone().multiplyScalar(s.framingScale)),
      lookAt: (s) => {
        const l = s.jack.clone();
        l.y += 3;
        return l;
      },
    };
    this.cameraDirector.addZone(scripted);
    this.cameraDirector.addZone(follow);
  }

  // ---------- World building ----------

  private async buildJungle(): Promise<void> {
    if (this.disposed) return;
    // Billboard (impostor) forest — camera-facing photo quads, cheap on mobile.
    // Ground foliage stays off for now; trees are the priority pass.
    const trees = await loadIslandBillboardTrees();
    if (this.disposed) return;
    this.scene.add(trees.group);
    this.treesUpdate = trees.update;
    console.info(`[Beyond Extinction] island billboard trees placed: ${trees.count}`);
  }

  /**
   * Load a character GLB (falling back to a colored capsule), normalize it to a
   * consistent height with feet on the sand, and wire an idle/walk crossfade
   * driven by applyLocomotion. Every rig shares one bone layout, so all clips
   * land in the shared ClipLibrary.
   */
  private async buildCharacter(name: string, color: number): Promise<THREE.Group> {
    const group = new THREE.Group();
    const model = await loadModel(`assets/models/${name}.glb`, () => {
      const ph = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(1.1, 3.2, 6, 14),
        new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 }),
      );
      body.position.y = 3;
      body.castShadow = true;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 16, 16),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5 }),
      );
      head.position.y = 5.6;
      head.castShadow = true;
      ph.add(body, head);
      return ph;
    });
    group.add(model);
    group.userData.model = model;
    this.groundAndScale(model, ChapterOnePlaceholderScene.JACK_HEIGHT);
    group.userData.standY = model.position.y;

    // The Meshy auto-rigs ship no clips, so synthesize idle/walk/run from the
    // ported rig (same as the prologue) — otherwise the island characters stand
    // frozen. Then overlay any dev-authored clips from the Animation Editor.
    if (
      (!model.animations || model.animations.length === 0) &&
      !model.userData.isPlaceholder &&
      RIGS[name]
    ) {
      model.animations = bakeHumanoidClips(model, RIGS[name], {
        Idle: STD_CLIPS.Idle,
        Walking: STD_CLIPS.Walking,
        Running: STD_CLIPS.Running,
      });
    }
    if (model.animations) model.animations = AnimStore.applyTo(model.animations);

    if (model.animations && model.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(model);
      const clips = model.animations;
      const byRe = (re: RegExp) => clips.find((c) => re.test(c.name));
      const idleClip =
        THREE.AnimationClip.findByName(clips, "Idle") ?? byRe(/idle/i) ?? clips[0];
      const walkClip =
        byRe(/^walking$/i) ??
        byRe(/walk/i) ??
        byRe(/^running$/i) ??
        byRe(/run/i) ??
        null;

      const idleAction = mixer.clipAction(idleClip);
      idleAction.play();
      const actions: CharacterActions = { idle: idleAction };
      if (walkClip && walkClip !== idleClip) {
        const walkAction = mixer.clipAction(walkClip);
        walkAction.play();
        walkAction.setEffectiveWeight(0);
        actions.walk = walkAction;
      }
      mixer.update(0);

      this.mixers.push(mixer);
      group.userData.mixer = mixer;
      group.userData.actions = actions;
      group.userData.walkBlend = 0;
      this.clipLibrary.add(clips);
    }

    // Skinned meshes keep their bind-pose bounds; the two hero characters are
    // always near camera, so skip frustum culling to avoid limbs popping out.
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) mesh.frustumCulled = false;
    });
    return group;
  }

  /**
   * Shrink the head chain (camera bone + skull/jaw/hair skinned to it) to nearly
   * nothing on the first-person body, so the head-height camera doesn't render
   * the inside of the skull. The baked clips only write rotation tracks, so the
   * scale sticks across animation (Godot's first-person head trick).
   */
  private hideHeadBones(group: THREE.Group): void {
    this.setHeadBonesHidden(group, true);
  }

  /** Shrink (or restore) the head bones. Hidden in first person so the camera
   *  can sit inside the skull; restored during the arrival flyover, which looks
   *  AT Jack from outside. */
  private setHeadBonesHidden(group: THREE.Group, hidden: boolean): void {
    const model = (group.userData.model as THREE.Object3D) ?? group;
    const headBones = RIGS.Jack?.bones.head ?? ["Bone_017", "Bone_016"];
    const names = Array.isArray(headBones) ? headBones : [headBones];
    let head: THREE.Object3D | undefined;
    for (const n of names) {
      head = model.getObjectByName(n);
      if (head) break;
    }
    if (!head) return;
    const s = hidden ? 0.001 : 1;
    head.traverse((o) => {
      if ((o as THREE.Bone).isBone) o.scale.setScalar(s);
    });
  }

  /** Scale a model to `targetHeight` world units and sit its feet at y=0. */
  private groundAndScale(model: THREE.Object3D, targetHeight: number): void {
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(model).getSize(size);
    if (size.y > 1e-3) model.scale.multiplyScalar(targetHeight / size.y);
    const grounded = new THREE.Box3().setFromObject(model);
    model.position.y -= grounded.min.y;
  }

  /** Tip a character onto their BACK (supine) and re-ground, or restore upright.
   *  Tipping backward is a rotation about the model's local X axis; rolling about
   *  Z (the old behaviour) laid them on their side instead. */
  private setProne(group: THREE.Group, prone: boolean): void {
    const model = group.userData.model as THREE.Object3D | undefined;
    if (!model) return;
    model.rotation.x = prone ? -Math.PI / 2 : 0;
    const grounded = new THREE.Box3().setFromObject(model);
    model.position.y -= grounded.min.y;
    if (prone) group.userData.proneY = model.position.y;
  }

  /** Ease a prone character up to standing (rotation + grounded height). */
  private wake(group: THREE.Group, ms: number): Promise<void> {
    const model = group.userData.model as THREE.Object3D | undefined;
    if (!model) return Promise.resolve();
    const fromRot = model.rotation.x;
    const fromY = model.position.y;
    const toY = (group.userData.standY as number) ?? 0;
    return new Promise<void>((resolve) => {
      const start = performance.now();
      const tick = () => {
        if (this.disposed) return resolve();
        const k = Math.min((performance.now() - start) / ms, 1);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        model.rotation.x = fromRot * (1 - e);
        model.position.y = THREE.MathUtils.lerp(fromY, toY, e);
        if (k < 1) requestAnimationFrame(tick);
        else resolve();
      };
      tick();
    });
  }

  /** Sink a prop into the sand (gathered) over `ms`, then hide it. */
  private sink(obj: THREE.Object3D, ms: number): Promise<void> {
    const fromY = obj.position.y;
    return new Promise<void>((resolve) => {
      const start = performance.now();
      const tick = () => {
        if (this.disposed) return resolve();
        const k = Math.min((performance.now() - start) / ms, 1);
        obj.position.y = fromY - k * 3;
        if (k < 1) {
          requestAnimationFrame(tick);
        } else {
          obj.visible = false;
          resolve();
        }
      };
      tick();
    });
  }

  private buildDriftwood(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a6b46, roughness: 0.95 });
    for (let i = 0; i < 5; i++) {
      const plank = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.3, 3 + Math.random() * 1.5, 6),
        mat,
      );
      plank.castShadow = true;
      plank.rotation.z = Math.PI / 2;
      plank.rotation.y = Math.random() * Math.PI;
      plank.position.set(
        (Math.random() - 0.5) * 2.2,
        0.3 + i * 0.18,
        (Math.random() - 0.5) * 2.2,
      );
      g.add(plank);
    }
    return g;
  }

  /** The curious dodo — the real Meshy model with its baked Walking cycle
   *  (ambling in place). Scaled to a real dodo's ~1 m height; the coarse
   *  procedural bird stays only as a fallback if the GLB fails to load. A
   *  rigged replacement with custom weighted anims can drop in later. */
  private async buildDodo(): Promise<THREE.Group> {
    const g = new THREE.Group();
    const model = await loadModel("assets/models/dodo.glb", () => this.buildDodoFallback());

    // Scale to ~1 m tall, feet on the group origin.
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(model).getSize(size);
    if (size.y > 1e-3) model.scale.multiplyScalar(ChapterOnePlaceholderScene.DODO_HEIGHT / size.y);
    model.position.y -= new THREE.Box3().setFromObject(model).min.y;

    // Meshy GLBs import fully-metallic/emissive — tame that (as the rigs do).
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        if (sm && "metalness" in sm) {
          sm.metalness = Math.min(sm.metalness ?? 0, 0.1);
          if (sm.emissive) sm.emissiveIntensity = 0;
        }
      }
    });
    g.add(model);

    // Play the baked Walking cycle as a calm in-place amble (no root motion, so
    // it pecks about without drifting). Its mixer rides this.mixers.
    if (model.animations && model.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(model);
      const walk =
        THREE.AnimationClip.findByName(model.animations, "Walking") ?? model.animations[0];
      const action = mixer.clipAction(walk);
      action.timeScale = 0.6;
      action.play();
      mixer.update(0);
      this.mixers.push(mixer);
    }
    return g;
  }

  /** Coarse procedural dodo — fallback only, if dodo.glb fails to load. */
  private buildDodoFallback(): THREE.Group {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x9a8f7d, roughness: 0.9, flatShading: true });
    const beakMat = new THREE.MeshStandardMaterial({ color: 0xe2c044, roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(2, 14, 12), bodyMat);
    body.scale.set(1, 1.1, 1.3);
    body.position.y = 2.4;
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12), bodyMat);
    head.position.set(0, 4.4, 1);
    head.castShadow = true;
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.4, 8), beakMat);
    beak.rotation.x = Math.PI / 2.2;
    beak.position.set(0, 4.2, 2);
    const legMat = new THREE.MeshStandardMaterial({ color: 0xc7a13e });
    for (const sx of [-0.6, 0.6]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2, 6), legMat);
      leg.position.set(sx, 1, 0);
      g.add(leg);
    }
    g.add(body, head, beak);
    g.userData.isPlaceholder = true;
    return g;
  }

  /** Mount the in-game gear button that opens the Settings panel. */
  private buildSettingsButton(): void {
    const btn = document.createElement("button");
    btn.className = "be-gear";
    btn.type = "button";
    btn.setAttribute("aria-label", "Settings");
    btn.textContent = "\u2699";
    btn.addEventListener("click", () => {
      this.ctx.audio.playSfx("ui-select");
      const wasEnabled = this.ctx.input.inputEnabled;
      this.ctx.input.setEnabled(false);
      openSettingsPanel({
        parent: this.ctx.uiLayer,
        audio: this.ctx.audio,
        onClose: () => {
          if (!this.disposed) this.ctx.input.setEnabled(wasEnabled);
        },
      });
    });
    this.ctx.uiLayer.appendChild(btn);
    this.gearEl = btn;
  }

  // ---------- Helpers ----------

  private clampToPlay(nx: number, nz: number): { x: number; z: number } {
    // Locked to the chapter's story grid until Unlimited Mode opens the island.
    const p = Progression.unlimitedMode
      ? ChapterOnePlaceholderScene.ISLAND
      : this.gridBounds;
    const x = THREE.MathUtils.clamp(nx, p.minX, p.maxX);
    const z = THREE.MathUtils.clamp(nz, p.minZ, p.maxZ);
    if ((x !== nx || z !== nz) && this.storyBoundaryOn && !Progression.unlimitedMode) {
      this.boundaryHit();
    }
    return { x, z };
  }

  /** Throttled nudge when the player pushes against the story-grid boundary. */
  private boundaryHit(): void {
    const now = this.elapsed;
    if (now - this.boundaryToastAt < 6) return;
    this.boundaryToastAt = now;
    this.ctx.overlays.showToast("Story boundary — the island opens up in Unlimited Mode");
  }

  /** A glowing wireframe cage + faint shell at the story-grid edge (hidden in
   *  Unlimited Mode). Purely a visual marker; the clamp does the real work. */
  private buildBoundary(scene: THREE.Scene): void {
    const g = this.gridBounds;
    const yLo = -6 / METERS_PER_UNIT;
    const yHi = 34 / METERS_PER_UNIT;
    const w = g.maxX - g.minX;
    const h = yHi - yLo;
    const d = g.maxZ - g.minZ;
    const group = new THREE.Group();
    group.position.set((g.minX + g.maxX) / 2, (yLo + yHi) / 2, (g.minZ + g.maxZ) / 2);

    const boxGeo = new THREE.BoxGeometry(w, h, d);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeo),
      new THREE.LineBasicMaterial({ color: 0x69d2e7, transparent: true, opacity: 0.5 }),
    );
    const shell = new THREE.Mesh(
      boxGeo,
      new THREE.MeshBasicMaterial({
        color: 0x69d2e7,
        transparent: true,
        opacity: 0.035,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    group.add(shell, edges);
    group.visible = !Progression.unlimitedMode;
    scene.add(group);
    this.boundaryBox = group;
  }

  /** Manual save from the island inventory screen. */
  private manualSaveIsland(): void {
    const snap = {
      label: "Chapter One — The Island",
      scene: "island",
      inventory: {
        hasBadge: PlayerInventory.hasBadge,
        heldItems: [...PlayerInventory.heldItems],
      },
      flags: { fauna: this.seaCreatures?.serialize() ?? [] },
    };
    SaveManager.save("manual-1", snap);
    SaveManager.autosave(snap); // resume picks the autosave — keep it in sync
    this.ctx.overlays.showToast("Game saved");
  }

  /**
   * Wire the Dev menu's "Set … Spawn (here)" buttons to this live scene. "Here"
   * is the player's current camera position; Jack's facing is read from the
   * controller. Setting Sarah's spawn also drops her mesh at the spot so the
   * placement is visible immediately. Points persist via SpawnStore.
   */
  private registerSpawnTools(): void {
    SpawnTools.current = {
      setJackHere: () => {
        const x = +this.camera.position.x.toFixed(1);
        const z = +this.camera.position.z.toFixed(1);
        // placeAt uses yaw = degToRad(-facing), so facing = -deg(yaw).
        const facing = +(-THREE.MathUtils.radToDeg(this.player?.yaw ?? 0)).toFixed(1);
        SpawnStore.setJack({ x, z, rot: facing });
        this.jackFacingDeg = facing;
        return `Jack start saved (${x}, ${z})`;
      },
      setSarahHere: () => {
        const x = +this.camera.position.x.toFixed(1);
        const z = +this.camera.position.z.toFixed(1);
        const rot = this.sarah?.rotation.y ?? Math.PI / 2;
        SpawnStore.setSarah({ x, z, rot });
        if (this.sarah) {
          this.sarah.position.set(x, beachHeight(x, z), z);
          this.setProne(this.sarah, true);
        }
        return `Sarah start saved (${x}, ${z})`;
      },
      reset: () => {
        SpawnStore.clear();
        return "Island start points reset to defaults";
      },
    };
  }

  private faceTowards(obj: THREE.Object3D, target: THREE.Vector3): void {
    const dir = new THREE.Vector3().subVectors(target, obj.position);
    dir.y = 0;
    if (dir.lengthSq() > 0.0001) obj.rotation.y = Math.atan2(dir.x, dir.z);
  }

  private applyLocomotion(group: THREE.Group, moving: boolean, dt: number): void {
    const actions = group.userData.actions as CharacterActions | undefined;
    if (!actions || !actions.walk) return;
    const target = moving ? 1 : 0;
    const k = 1 - Math.pow(0.0015, dt);
    const blend = THREE.MathUtils.lerp(
      (group.userData.walkBlend as number) ?? 0,
      target,
      k,
    );
    group.userData.walkBlend = blend;
    actions.idle.setEffectiveWeight(1 - blend);
    actions.walk.setEffectiveWeight(blend);
  }

  // ---------- End card ----------

  private showEndCard(): void {
    if (this.disposed || this.endCardEl) return;
    const el = document.createElement("div");
    el.className = "be-endcard";
    el.innerHTML = `
      <div class="be-endcard__panel">
        <div class="be-endcard__eyebrow">Chapter Two</div>
        <h2 class="be-endcard__title">Coming Soon</h2>
        <p class="be-endcard__body">
          Jack and Sarah's story continues in the next chapter.
          Thank you for playing the vertical slice.
        </p>
        <button class="be-btn be-btn--primary" data-action="menu">Return to Main Menu</button>
      </div>`;
    this.ctx.uiLayer.appendChild(el);
    this.endCardEl = el;
    requestAnimationFrame(() => el.classList.add("show"));
    el.querySelector('[data-action="menu"]')?.addEventListener("click", () => {
      this.ctx.audio.playSfx("ui-confirm");
      void this.returnToMenu();
    });
  }

  private async returnToMenu(): Promise<void> {
    const { createMainMenuScene } = await import("./MainMenuScene");
    this.ctx.scenes.goTo(createMainMenuScene);
  }

  // ---------- Creature combat ----------

  /** A creature bite connected: damage the survival model, cue pain, flash red. */
  private onCreatureBite(dmg: number, _species: string): void {
    if (!this.stats || this.respawning || this.disposed) return;
    this.stats.takeDamage(dmg); // fires stats.onDeath → onPlayerDeath() at 0
    this.ctx.audio.playSfx("gasp");
    this.hurtFlash();
  }

  /** Flash a red damage vignette (fades out over the next ~0.35 s in update). */
  private hurtFlash(): void {
    if (!this.hurtEl) {
      const el = document.createElement("div");
      el.className = "be-hurt";
      el.style.cssText =
        "position:fixed;inset:0;z-index:40;pointer-events:none;opacity:0;" +
        "transition:opacity 0.1s ease;background:radial-gradient(ellipse at" +
        " center, transparent 42%, rgba(150,0,8,0.62) 100%);";
      this.ctx.uiLayer.appendChild(el);
      this.hurtEl = el;
    }
    this.hurtEl.style.opacity = "1";
    this.hurtT = 0.35;
  }

  /** Health hit 0: fade out, respawn Jack at the arrival beach, restore stats. */
  private async onPlayerDeath(): Promise<void> {
    if (this.respawning || this.disposed) return;
    this.respawning = true;
    this.player?.setActive(false);
    this.ctx.input.setEnabled(false);
    if (this.hurtEl) this.hurtEl.style.opacity = "0";
    this.ctx.dialogue.showSubtitle({ speaker: "", text: "You were killed." });
    await this.ctx.overlays.fadeToBlack(700);
    if (this.disposed) return;
    const sp = SpawnStore.get().jack ?? ChapterOnePlaceholderScene.JACK_SPAWN;
    const groundY = beachHeight(sp.x, sp.z);
    this.stats?.revive();
    this.jack.position.set(sp.x, groundY, sp.z);
    this.jackFacingDeg = sp.rot;
    if (this.player) {
      this.player.placeAt(sp.x, sp.z, sp.rot);
      this.camY = groundY + this.eyeOffset;
    }
    await this.ctx.overlays.fadeFromBlack(700);
    if (this.disposed) return;
    this.ctx.dialogue.hideSubtitle();
    this.player?.setActive(true);
    this.ctx.input.setEnabled(true);
    this.respawning = false;
  }

  // ---------- Loop ----------

  update(dt: number, elapsed: number): void {
    // Ambient sea life — roams whether or not gameplay control is active. During
    // the arrival flyover, seed/stream them around the CAMERA (which skims and
    // dives over the water) so they're visible in the dip; otherwise around Jack.
    // In live first-person play the player is a bite target: sea creatures chase
    // a swimmer, the amphibious crocs ambush on land/shallows.
    const seaFocus = this.flyoverState ? this.camera.position : this.jack?.position;
    if (seaFocus) {
      const cp = this.camera.position;
      const player =
        !this.flyoverState && this.firstPerson && this.player && !this.respawning
          ? {
              pos: cp,
              inWater: beachHeight(cp.x, cp.z) < 0,
              vulnerable: this.ctx.input.inputEnabled,
              // Stealth: how far creatures notice you, by stance (metres).
              noticeRange: this.ctx.input.isCrawling()
                ? 10
                : this.ctx.input.isCrouching()
                  ? 30
                  : this.ctx.input.isRunning()
                    ? 100
                    : 50,
            }
          : undefined;
      this.seaCreatures?.update(dt, seaFocus, player);
    }
    // Damage vignette fade.
    if (this.hurtEl && this.hurtT > 0) {
      this.hurtT -= dt;
      if (this.hurtT <= 0) this.hurtEl.style.opacity = "0";
    }
    // Passive-taming Feed prompt + post-feed back-off bar.
    const feedActive =
      !this.flyoverState &&
      this.firstPerson &&
      !!this.player &&
      !this.respawning &&
      this.ctx.input.inputEnabled;
    this.updateFeedUI(dt, feedActive);
    this.elapsed = elapsed;
    this.oceanUniforms.uTime.value = elapsed;

    if (this.flyoverState) {
      // Arrival flyover: the cinematic owns the camera, but the world still
      // breathes — ocean, sun shadow box, character anims, trees, billboards.
      this.updateFlyover(dt);
      this.oceanUniforms.uCamPos.value.copy(this.camera.position);
      this.updateSun();
      this.applyLocomotion(this.jack, false, dt);
      this.applyLocomotion(this.sarah, false, dt);
      for (const m of this.mixers) m.update(dt);
      this.dilo?.update(dt);
      this.treesUpdate?.(dt, this.camera.position);
      updateBillboardsYAxis(this.billboards, this.camera.position);
      return;
    }

    if (this.revealLook) {
      // Dilophosaurus reveal cutscene: the player is frozen, the camera holds at
      // their eye and swings to lock onto the animal (its head, tracked live).
      this.dilo?.headWorld(this.revealLook);
      const m = new THREE.Matrix4().lookAt(
        this.camera.position,
        this.revealLook,
        ChapterOnePlaceholderScene.UP,
      );
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      this.camera.quaternion.slerp(q, 1 - Math.pow(0.0016, dt));
      this.oceanUniforms.uCamPos.value.copy(this.camera.position);
      this.updateSun();
      this.applyLocomotion(this.sarah, false, dt);
      for (const mx of this.mixers) mx.update(dt);
      this.dilo?.update(dt);
      this.treesUpdate?.(dt, this.camera.position);
      updateBillboardsYAxis(this.billboards, this.camera.position);
      return;
    }

    if (this.firstPerson && this.player) {
      // Drive first-person movement, clamped to the play area, then ride the
      // beach surface so the camera walks the terrain instead of a flat plane.
      // Effective stance, clamped by the slope under the player: you can't crawl
      // a grade > 5° or crouch one > 15°, so holding that key on steeper ground
      // falls back to the next stance that fits — never a frozen posture you
      // can't move in. Drives BOTH the move gate and the eye height below.
      const posture = this.effectivePosture(this.camera.position.x, this.camera.position.z);
      const res = this.player.update(dt, (from, to) => {
        // Move gate: reject a step onto ground steeper than the stance allows;
        // try sliding along one axis (walk the contour) before blocking.
        const ok = (x: number, z: number) => beachSlopeDeg(x, z) <= posture.limit;
        const c = this.clampToPlay(to.x, to.z);
        if (ok(c.x, c.z)) return { x: c.x, y: to.y, z: c.z };
        const cx = this.clampToPlay(to.x, from.z); // slide in X only
        if (ok(cx.x, cx.z)) return { x: cx.x, y: to.y, z: from.z };
        const cz = this.clampToPlay(from.x, to.z); // slide in Z only
        if (ok(cz.x, cz.z)) return { x: from.x, y: to.y, z: cz.z };
        return { x: from.x, y: to.y, z: from.z }; // too steep for this stance
      });
      // Vertical physics: the eye rests EYE above the ground under it, but is not
      // locked there. Gravity pulls it down; a jump launches it up; walking off a
      // ledge lets it fall. Gentle slopes (drop < STEP per frame) stay grounded so
      // you don't float downhill.
      // Posture: ease the eye height toward the EFFECTIVE stance (slope-clamped),
      // so on ground too steep to crawl you crouch/stand instead of dropping to
      // a stuck prone camera.
      this.eyeOffset += (posture.eye - this.eyeOffset) * Math.min(1, dt * 9);
      const cx = this.camera.position.x;
      const cz = this.camera.position.z;
      const yaw = this.player.yaw;
      const groundEye = beachHeight(cx, cz) + this.eyeOffset;
      if (this.dbgEl) {
        const inp = this.ctx.input;
        const crawl = inp.isCrawling();
        const crouch = inp.isCrouching();
        const run = inp.isRunning();
        const posture = crawl ? "CRAWL" : crouch ? "CROUCH" : run ? "RUN" : "WALK";
        const M = 0.28125; // metres per unit
        this.dbgEl.textContent =
          `▶ ${posture}   eye ${(this.eyeOffset * M).toFixed(2)}m (${this.eyeOffset.toFixed(1)}u)\n` +
          `run=${run ? 1 : 0}  crouch=${crouch ? 1 : 0}  crawl=${crawl ? 1 : 0}  ` +
          `ground=${this.onGround ? 1 : 0}`;
      }
      const jumped = this.ctx.input.consumeJump() && this.onGround;
      if (jumped) {
        this.vy = ChapterOnePlaceholderScene.JUMP_SPEED;
        this.onGround = false;
      }
      // Tick the survival model while input is enabled (pauses during
      // cinematics / menus because setEnabled(false) is called there).
      if (this.ctx.input.inputEnabled && this.stats) {
        this.stats.update(dt, {
          moving: res.moving,
          running: this.ctx.input.isRunning() && res.moving,
          crouching: this.ctx.input.isCrouching(),
          crawling: this.ctx.input.isCrawling(),
          jumped,
        });
      }
      // Throttled nearest-location poll (~0.5 s) → minimap location pill.
      this.locNameAcc += dt;
      if (this.locNameAcc >= 0.5) {
        this.locNameAcc = 0;
        this.islandMap?.setLocationName(this.nearestLocationName(cx, cz));
      }
      this.vy -= ChapterOnePlaceholderScene.GRAVITY * dt;
      // Integrate our OWN eye height — PlayerController.applyToCamera() overwrites
      // camera.position.y with the flat eye height every frame, so we can't read it.
      this.camY += this.vy * dt;
      if (this.vy <= 0 && this.camY <= groundEye + ChapterOnePlaceholderScene.STEP) {
        this.camY = groundEye; // land / stick to the surface
        this.vy = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }
      this.camera.position.y = this.camY;
      this.oceanUniforms.uCamPos.value.copy(this.camera.position);
      this.updateSun();
      this.islandMap?.setPlayer(cx, cz, yaw);
      this.islandMap?.update(dt);
      // Day One: reaching Sarah wakes her (Godot's reunion trigger; the full
      // shot/reverse-shot reunion dialogue is a later port milestone).
      if (this.findSarahArmed) {
        const ddx = cx - this.sarah.position.x;
        const ddz = cz - this.sarah.position.z;
        const r = ChapterOnePlaceholderScene.SARAH_TRIGGER;
        if (ddx * ddx + ddz * ddz <= r * r) {
          this.findSarahArmed = false;
          void this.sarahFound();
        }
      }
      // Walking up to the treeline springs the Dilophosaurus reveal (once).
      if (this.diloArmed && this.dilo) {
        const tdx = cx - this.diloTreeline.x;
        const tdz = cz - this.diloTreeline.z;
        const tr = ChapterOnePlaceholderScene.TREELINE_TRIGGER;
        if (tdx * tdx + tdz * tdz <= tr * tr) {
          this.diloArmed = false;
          void this.runDiloReveal();
        }
      }
      // First-person body: Jack stands at the player's feet (NOT under the
      // nudged camera — that would drift him forward each frame), faces the look
      // yaw, and walks. He crouches/lies with the eye via a body drop so the
      // visible body matches the camera height.
      if (this.jack) {
        const bodyDrop = ChapterOnePlaceholderScene.EYE - this.eyeOffset; // 0 stand, + when low
        this.jack.position.set(cx, beachHeight(cx, cz) - bodyDrop, cz);
        this.jack.rotation.y = this.player.yaw + Math.PI; // model forward is +Z, look yaw is -Z
        this.applyLocomotion(this.jack, res.moving, dt);
      }
      // Godot cam_fwd_offset: nudge the eye forward of the head bone along the
      // look direction. The head bones are shrunk to nothing (hideHeadBones), so
      // there's no skull to clip; the nudge keeps the torso/shoulders out of the
      // forward view while looking down still reveals your own body.
      this.camera.position.x -= Math.sin(yaw) * ChapterOnePlaceholderScene.CAM_FWD;
      this.camera.position.z -= Math.cos(yaw) * ChapterOnePlaceholderScene.CAM_FWD;
      this.applyLocomotion(this.sarah, false, dt);
      for (const m of this.mixers) m.update(dt);
      this.dilo?.update(dt);
      this.treesUpdate?.(dt, this.camera.position);
      for (const h of this.highlights) h.update(dt);
      this.objMarker?.update(this.camera);
      updateBillboardsYAxis(this.billboards, this.camera.position);
      // The dodo's baked Walking cycle (via this.mixers) is its whole animation
      // now — no procedural hop/sway. It stays put until it bolts on the hiss.
      return;
    }

    this.oceanUniforms.uCamPos.value.copy(this.camera.position);
    this.updateSun();

    const jackMoving = this.jackNav?.update(dt) ?? false;
    this.applyLocomotion(this.jack, jackMoving, dt);
    this.applyLocomotion(this.sarah, false, dt);
    // Keep the walking hero on the terrain surface (Sarah is static until reached).
    if (this.jack) this.jack.position.y = beachHeight(this.jack.position.x, this.jack.position.z);
    for (const m of this.mixers) m.update(dt);
    this.treesUpdate?.(dt, this.camera.position);

    this.cameraDirector?.update(this.cameraState(), dt);
    for (const h of this.highlights) h.update(dt);
    updateBillboardsYAxis(this.billboards, this.camera.position);
  }

  /**
   * Keep the sun's shadow frustum centred on the player. The light rides a
   * fixed offset up-sun from the camera and targets the ground beneath it, so
   * the tight ±SHADOW_HALF shadow box always covers what the player can see —
   * the only way to get crisp directional shadows on an 8 km island.
   */
  private updateSun(): void {
    const sun = this.sun;
    if (!sun) return;
    const c = this.camera.position;
    const dir = ChapterOnePlaceholderScene.SUN_DIR;
    const d = ChapterOnePlaceholderScene.SUN_DIST;
    sun.target.position.set(c.x, beachHeight(c.x, c.z), c.z);
    sun.position.set(c.x + dir.x * d, sun.target.position.y + dir.y * d, c.z + dir.z * d);
    sun.target.updateMatrixWorld();
  }

  /**
   * The stance actually in effect at (x,z), clamped by the terrain slope there:
   * crawl needs ≤5°, crouch ≤15°, else walk/run. Holding a key on ground too
   * steep for it falls back to the next stance that fits, so you can never be
   * stuck in a posture that can't move. Returns that stance's slope limit (for
   * the move gate) and eye height (for the camera).
   */
  private effectivePosture(x: number, z: number): { limit: number; eye: number } {
    const S = ChapterOnePlaceholderScene;
    const slope = beachSlopeDeg(x, z);
    const input = this.ctx.input;
    if (input.isCrawling() && slope <= 5) return { limit: 5, eye: S.CRAWL_EYE };
    if ((input.isCrawling() || input.isCrouching()) && slope <= 15)
      return { limit: 15, eye: S.CROUCH_EYE };
    return { limit: 45, eye: S.EYE };
  }

  /** Post-main-render passes: the island map's live top-down minimap. */
  renderOverlays(renderer: THREE.WebGLRenderer): void {
    this.islandMap?.renderLive(renderer);
  }

  resize(width: number, height: number): void {
    this.viewportHeight = height;
    this.camera.aspect = width / height;
    this.applyFov();
  }

  dispose(): void {
    this.disposed = true;
    if (this.autoPlayTimer) clearTimeout(this.autoPlayTimer);
    this.autoPlayTimer = null;
    // Unblock any in-flight gate so the director's play() loop unwinds.
    this.director?.cancel();
    this.pending?.resolve();
    this.pending = null;
    // Overlays + the settings panel are long-lived globals: force-close anything
    // this scene opened so a mid-choice or open settings modal never survives
    // into the next scene.
    this.ctx.overlays.cancelChoice();
    closeSettingsPanel();
    closeHudEditor();
    setHudEditorContext("lab"); // island HUD leaves with the scene
    this.seaCreatures?.dispose();
    this.dilo?.dispose();
    this.objMarker?.dispose();
    this.hurtEl?.remove();
    this.unsubFeed?.();
    this.feedBtnEl?.remove();
    this.feedBarEl?.remove();
    this.trackBtnEl?.remove();
    this.petBtnEl?.remove();
    this.tameMenuEl?.remove();
    this.boundaryBox?.traverse((o) => {
      const m = o as THREE.Mesh | THREE.LineSegments;
      (m.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
      const mat = (m as THREE.Mesh).material;
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
    });
    this.boundaryBox?.removeFromParent();
    if (SpawnTools.current) SpawnTools.current = undefined; // Dev spawn tools leave with the scene
    this.survivalHud?.dispose();
    this.stats?.dispose();
    this.islandMap?.dispose();
    this.player?.dispose();
    this.inventory?.dispose();
    this.unsubClick?.();
    this.unsubSettings?.();
    this.gearEl?.remove();
    this.endCardEl?.remove();
    this.dbgEl?.remove();
    // Arrival cinematic leftovers: typing loop, skip listeners, an in-flight
    // flyover promise, the journal page, the underwater wash, and any VO.
    if (this.typeRaf !== null) cancelAnimationFrame(this.typeRaf);
    this.typeRaf = null;
    this.skipUnsub?.();
    this.skipUnsub = undefined;
    this.flyoverState?.resolve();
    this.flyoverState = null;
    this.arrivalJournal?.remove();
    this.uwTint?.remove();
    this.ctx.audio.stopVoice();
    this.ctx.dialogue.hideSubtitle();
    this.ctx.overlays.hideHint();
    this.ctx.overlays.setBlackInstant(false);
    for (const h of this.highlights) h.dispose();
    this.highlights = [];
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.scene.clear();
  }
}

/** Uniform Catmull-Rom — C1-continuous through the control points (the flight
 *  path glides through each waypoint without per-segment stop-start). */
function catmull(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  u: number,
): THREE.Vector3 {
  const u2 = u * u;
  const u3 = u2 * u;
  const c = (a: number, b: number, cc: number, d: number) =>
    0.5 *
    (2 * b +
      (-a + cc) * u +
      (2 * a - 5 * b + 4 * cc - d) * u2 +
      (-a + 3 * b - 3 * cc + d) * u3);
  return new THREE.Vector3(
    c(p0.x, p1.x, p2.x, p3.x),
    c(p0.y, p1.y, p2.y, p3.y),
    c(p0.z, p1.z, p2.z, p3.z),
  );
}

export const createChapterOneScene: SceneFactory = (ctx) =>
  new ChapterOnePlaceholderScene(ctx);
