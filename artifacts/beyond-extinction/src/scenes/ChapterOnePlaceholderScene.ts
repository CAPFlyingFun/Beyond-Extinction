import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { loadModel, loadTexture } from "../engine/assets";
import { updateBillboardsYAxis } from "../engine/Billboard";
import { buildIslandFoliage } from "../engine/islandFoliage";
import { loadIslandTrees } from "../engine/islandTrees";
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
import { beachStory } from "../data/beachSequences";
import {
  buildBeachTerrain,
  buildOceanWater,
  loadIslandHeightmap,
  loadIslandGround,
  beachHeight,
  MAP_SCALE,
  HEIGHT_SCALE,
  type OceanWater,
} from "../engine/beachTerrain";
import { SaveManager } from "../engine/SaveManager";
import { SpawnStore } from "../engine/SpawnStore";
import { SpawnTools } from "../engine/SpawnTools";
import { IslandMap } from "../engine/IslandMap";
import { PlayerInventory } from "../engine/PlayerInventory";
import { MarkerStore } from "../engine/MarkerStore";
import { spawnSceneMarkers } from "../engine/MarkerEditor";
import { AnimStore } from "../engine/AnimStore";
import { RIGS, bakeHumanoidClips, STD_CLIPS } from "../engine/proceduralAnimator";

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
  private static readonly EYE = 6.4; // eye height above terrain ≈ 1.8 m (a standing stance)
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
  private static readonly GRAVITY = 38; // world u/s² (~9.8 m/s²)
  private static readonly JUMP_SPEED = 18; // world u/s (~1.3 m jump)
  private static readonly STEP = 3; // step-down snap tolerance (u) so gentle slopes stay grounded
  private vy = 0; // vertical velocity (world u/s)
  private camY = 0; // integrated eye height (the controller resets camera.y each frame)
  private onGround = true;

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
  private static readonly PLAY = {
    minX: -170 * MAP_SCALE,
    maxX: 170 * MAP_SCALE,
    minZ: -48 * MAP_SCALE,
    maxZ: 292 * MAP_SCALE,
  };

  constructor(private ctx: SceneContext) {
    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      2, // near ~0.56 m — the island is ~3 km, so push far out for the horizon
      60000,
    );
  }

  async enter(): Promise<void> {
    // Reaching the island is the game's main progression checkpoint: from here
    // "Continue" brings the player straight back to the beach. Restore inventory
    // if this was a resume, then (re)write the island autosave. (See SaveManager.)
    const resume = SaveManager.consumeResume();
    if (resume && resume.scene === "island") {
      // Loading an island save — keep exactly what was saved.
      PlayerInventory.hasBadge = resume.inventory.hasBadge;
      PlayerInventory.heldItems = [...resume.inventory.heldItems];
    } else {
      // Fresh arrival through the portal: set Jack's carry-over loadout
      // explicitly (the prologue's end-state inventory is unreliable). Jack keeps
      // a badge and one coffee.
      PlayerInventory.hasBadge = true;
      PlayerInventory.heldItems = ["coffee"];
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

    this.ctx.audio.playMusic("beach-dawn");

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
    this.dodo = this.buildDodo();
    this.dodo.position.set(
      14 * MAP_SCALE,
      beachHeight(14 * MAP_SCALE, 244 * MAP_SCALE),
      244 * MAP_SCALE, // mirrored with the true-aerial-view flip (was z=0)
    );
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
        // Realistic human pace. Full joystick = WALK at 3 mph (1.34 m/s ≈ 4.76
        // u/s); hold-Shift / the Run toggle sprints at 10 mph (4.47 m/s). The
        // 8 km island is a long walk on foot by design — mounts/vehicles later.
        moveSpeed: 4.76,
        runMultiplier: 3.34,
        lookSensitivity: this.settings.lookSensitivity,
      });
      this.player.placeAt(this.jack.position.x, this.jack.position.z, this.jackFacingDeg);
      this.camY = beachHeight(this.jack.position.x, this.jack.position.z) + ChapterOnePlaceholderScene.EYE;
      this.player.setActive(true);
      this.jack.visible = false;
      this.applyFov();
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
      // Expose spawn-editing to the Dev menu: walk to a spot, open Dev tools, and
      // save it as Jack's or Sarah's island start point (persists to localStorage).
      this.registerSpawnTools();
      // Satellite minimap (tap to open the full map with pinch-zoom/pan).
      // Passing the world scene switches the minimap to a LIVE top-down render
      // (what's really there — no baked image, immune to world rescales).
      this.islandMap = new IslandMap(this.ctx.uiLayer, this.scene);
    } else {
      // Legacy directed-gameplay path (click-to-move + cinematic story).
      this.unsubClick = this.ctx.input.onClick(() => this.handleClick());
    }

    // The prologue hands off with the screen blacked out (its closing cut); lift
    // it so the beach is actually visible.
    await this.ctx.overlays.fadeFromBlack(900);
    if (this.disposed) return;
    if (!this.firstPerson) void this.runStory();
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
    // Foliage + trees are OFF while the 8192 m terrain is being signed off —
    // bare ground textures make the new scale and slopes easy to judge. Flip
    // this back on (and retune islandTrees spacing to metres) afterwards.
    const FOLIAGE_ENABLED = false;
    if (!FOLIAGE_ENABLED) return;
    this.scene.add(buildIslandFoliage({ trees: false }));
    const trees = await loadIslandTrees();
    if (this.disposed) return;
    this.scene.add(trees.group);
    this.treesUpdate = trees.update;
    console.info(`[Beyond Extinction] island trees placed: ${trees.count}`);
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

  private buildDodo(): THREE.Group {
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
    g.userData.baseX = 14;
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
    const p = ChapterOnePlaceholderScene.PLAY;
    return {
      x: THREE.MathUtils.clamp(nx, p.minX, p.maxX),
      z: THREE.MathUtils.clamp(nz, p.minZ, p.maxZ),
    };
  }

  /** Manual save from the island inventory screen. */
  private manualSaveIsland(): void {
    SaveManager.save("manual-1", {
      label: "Chapter One — The Island",
      scene: "island",
      inventory: {
        hasBadge: PlayerInventory.hasBadge,
        heldItems: [...PlayerInventory.heldItems],
      },
    });
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

  // ---------- Loop ----------

  update(dt: number, elapsed: number): void {
    this.elapsed = elapsed;
    this.oceanUniforms.uTime.value = elapsed;

    if (this.firstPerson && this.player) {
      // Drive first-person movement, clamped to the play area, then ride the
      // beach surface so the camera walks the terrain instead of a flat plane.
      const res = this.player.update(dt, (_from, to) => {
        const c = this.clampToPlay(to.x, to.z);
        return { x: c.x, y: to.y, z: c.z };
      });
      // Vertical physics: the eye rests EYE above the ground under it, but is not
      // locked there. Gravity pulls it down; a jump launches it up; walking off a
      // ledge lets it fall. Gentle slopes (drop < STEP per frame) stay grounded so
      // you don't float downhill.
      const EYE = ChapterOnePlaceholderScene.EYE;
      const cx = this.camera.position.x;
      const cz = this.camera.position.z;
      const yaw = this.player.yaw;
      const groundEye = beachHeight(cx, cz) + EYE;
      if (this.ctx.input.consumeJump() && this.onGround) {
        this.vy = ChapterOnePlaceholderScene.JUMP_SPEED;
        this.onGround = false;
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
      // Keep hidden Jack under the camera and walking, so a later third-person
      // reveal reads correctly; Sarah idles where she woke.
      if (this.jack) {
        this.jack.position.set(
          this.camera.position.x,
          beachHeight(this.camera.position.x, this.camera.position.z),
          this.camera.position.z,
        );
        this.jack.rotation.y = this.player.yaw;
        this.applyLocomotion(this.jack, res.moving, dt);
      }
      this.applyLocomotion(this.sarah, false, dt);
      for (const m of this.mixers) m.update(dt);
      this.treesUpdate?.(dt, this.camera.position);
      for (const h of this.highlights) h.update(dt);
      updateBillboardsYAxis(this.billboards, this.camera.position);
      if (this.dodo) {
        this.dodo.position.x = this.dodo.userData.baseX + Math.sin(elapsed * 0.6) * 2;
        this.dodo.position.y =
          beachHeight(this.dodo.position.x, this.dodo.position.z) +
          Math.abs(Math.sin(elapsed * 4)) * 0.3;
        this.dodo.rotation.y = this.hissDone ? Math.PI : Math.sin(elapsed * 0.6) * 0.4;
      }
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

    if (this.dodo) {
      this.dodo.position.x = this.dodo.userData.baseX + Math.sin(elapsed * 0.6) * 2;
      this.dodo.position.y =
        beachHeight(this.dodo.position.x, this.dodo.position.z) +
        Math.abs(Math.sin(elapsed * 4)) * 0.3;
      this.dodo.rotation.y = this.hissDone ? Math.PI : Math.sin(elapsed * 0.6) * 0.4;
    }
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
    if (SpawnTools.current) SpawnTools.current = undefined; // Dev spawn tools leave with the scene
    this.islandMap?.dispose();
    this.player?.dispose();
    this.inventory?.dispose();
    this.unsubClick?.();
    this.unsubSettings?.();
    this.gearEl?.remove();
    this.endCardEl?.remove();
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

export const createChapterOneScene: SceneFactory = (ctx) =>
  new ChapterOnePlaceholderScene(ctx);
