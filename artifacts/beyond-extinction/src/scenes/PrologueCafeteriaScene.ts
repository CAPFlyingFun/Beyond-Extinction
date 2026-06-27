import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { loadModel } from "../engine/assets";
import { ClipLibrary } from "../engine/ClipLibrary";
import { SequenceDirector } from "../engine/SequenceDirector";
import {
  labOpeningNarration,
  introSequence,
  consoleSequence,
  alarmNarration,
  vortexNarration,
  vortexDialogue,
  climaxReach,
  climaxEnd,
} from "../data/prologueSequences";
import { VOICE_DURATIONS } from "../data/voiceDurations";
import { createChapterOneScene } from "./ChapterOnePlaceholderScene";
import {
  getSettings,
  subscribeSettings,
  type GameplaySettings,
} from "../engine/Settings";
import { autoFramingScale, portraitFovBoost } from "../engine/cameraFraming";
import { CameraDirector, type CameraZone } from "../engine/CameraDirector";
import { ObjectiveHighlight, type ObjectiveHighlightOptions } from "../engine/ObjectiveHighlight";
import { Navigator } from "../engine/Navigator";
import { openSettingsPanel, closeSettingsPanel } from "../engine/SettingsPanel";
import {
  createEquipmentPanelTexture,
  createFloorTexture,
  createHazardStripeTexture,
  createWallTexture,
  FLOOR_TEXTURE_WORLD_SIZE,
  WALL_TEXTURE_WORLD_SIZE,
} from "../engine/proceduralTextures";

/**
 * Total run-time (ms) of the opening narration timeline — the baked VO lengths
 * plus its scripted waits — read straight from the timeline so it stays correct
 * if the VO is re-baked or the waits change. Used to size the opening push-in so
 * it moves continuously across the whole narration instead of finishing early.
 */
const OPENING_NARRATION_MS = labOpeningNarration.reduce((ms, step) => {
  if (step.kind === "wait") return ms + step.ms;
  if (step.kind === "say" || step.kind === "voice") return ms + (VOICE_DURATIONS[step.clip] ?? 0);
  return ms;
}, 0);

type Phase =
  | "coffee"
  | "to-sarah"
  | "intro-dialogue"
  | "to-console"
  | "console-dialogue"
  | "reach-sarah"
  | "vortex"
  | "cutscene"
  | "done";

// The three distinct hand/character situations a coffee cup gets gripped in,
// each with its own tuned offset (see gripOffsets).
type GripContext = "jackRight" | "jackLeft" | "sarahRight";

// What each camera zone needs to decide if it's active and where to point —
// see buildCameraZones().
interface CameraZoneState {
  phase: Phase;
  jack: THREE.Vector3;
  sarah: THREE.Vector3;
  framingScale: number;
  /** Seconds since the scene started — lets zones drive time-based moves (the dialogue orbit). */
  elapsed: number;
  /** Which counter cup is collected next (0 or 1) — slides the coffee-counter framing toward the active cup/hand. */
  coffeeIndex: number;
}

/**
 * The animation actions a rigged character drives: a continuous idle/walk
 * crossfade plus an optional one-shot gesture overlaid on top of it (see
 * applyLocomotion and playGesture).
 */
interface CharacterActions {
  idle: THREE.AnimationAction;
  walk?: THREE.AnimationAction;
  gesture?: THREE.AnimationAction;
}

/**
 * The Prologue: a single continuous scene that moves Jack from the Level B
 * cafeteria coffee machine, to Sarah at the Lab Seven accelerator console,
 * through the resonance cascade, the colorless vortex, and the white-out that
 * ends the night the world changed.
 */
class PrologueCafeteriaScene implements IScene {
  readonly name = "prologue-cafeteria";
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private viewportHeight = window.innerHeight;

  private jack!: THREE.Group;
  private sarah!: THREE.Group;
  private coffeeMachine!: THREE.Mesh;
  private console!: THREE.Group;
  private vortex!: THREE.Group;
  private vortexUniforms!: { uTime: { value: number } };
  private redLights: THREE.PointLight[] = [];
  private coffees: THREE.Mesh[] = [];
  // Sarah's coffee (handed to her at the intro) so it can be set on the console.
  private sarahCup: THREE.Object3D | null = null;
  private mixers: THREE.AnimationMixer[] = [];

  private ambient!: THREE.AmbientLight;
  /** Wall-clock seconds into the scene, mirrored from update() each frame so
   * async event handlers (e.g. dialogue start) can timestamp themselves. */
  private elapsed = 0;
  /** elapsed captured when the intro dialogue began, so the camera orbit angle
   * advances from zero as the conversation plays. */
  private introOrbitStart = 0;
  private mainLights: THREE.Light[] = [];

  private phase: Phase = "coffee";
  private coffeeCount = 0;
  private interactables: THREE.Object3D[] = [];
  private unsubClick?: () => void;
  private disposed = false;

  // Cutscene timeline runner (voiced lines, subtitles, scripted camera,
  // gestures). The Phase machine still gates BETWEEN beats; the director drives
  // what happens within one. See SequenceDirector / prologueSequences.
  private director!: SequenceDirector;
  // When set, a top-priority camera zone (see buildCameraZones) frames this
  // named scripted moment instead of the phase-based zones. Cleared back to
  // null to hand framing back to gameplay.
  private scriptedCameraMoment: string | null = null;
  // Wall-clock (scene `elapsed`, seconds) captured the first frame the opening
  // "establishing" push-in becomes active, so cameraMoment() can drive a
  // time-based dolly. Null whenever that moment isn't running. Captured lazily
  // on the first active frame (not when the moment is set) so the start time is
  // the first RENDERED frame regardless of when the timeline fires it.
  private openingPushStartElapsed: number | null = null;
  // Duration of the opening push-in. The brief said ~10-12s, but the baked
  // narration runs far longer (~23s), so a literal 11s dolly would arrive and
  // then freeze for the rest of the VO — exactly the static hold this redesign
  // removes. Sized to span the narration (less a short settle) so the camera
  // keeps moving throughout and lands just as the narration ends, handing off
  // to the coffee-counter framing — matching the brief's described structure.
  private readonly openingPushDurationS = Math.max(8, (OPENING_NARRATION_MS - 1500) / 1000);

  // Fixed 2.5D view: a high, angled camera that tracks Jack's position but
  // never rotates with him, giving a diorama / three-quarter look.
  private camOffset = new THREE.Vector3(0, 18.5, 24.5);
  // Every character GLB is normalized to this world height so the camera
  // framing is correct regardless of how a given model was exported.
  private static readonly CHARACTER_HEIGHT = 7.2;
  private cascadeTimer = 0;
  private alarmOn = false;

  // Two physical coffee cups on the counter; collected by proximity + E.
  private coffeeStations: THREE.Object3D[] = [];
  private floor!: THREE.Mesh;
  private nearStation: THREE.Object3D | null = null;
  private readonly pickupRadius = 6;
  private nearConsole = false;
  private nearSarah = false;
  // True while a tap-to-confirm prompt is on screen — guards against stacking
  // a second prompt from another tap before the player answers the first.
  private confirmOpen = false;
  private reachSarahZone = new THREE.Vector3(20, 0, -36);
  // The console desk sits to the EAST of the central accelerator lane (see
  // buildConsole), so Jack approaches and operates it here while the lane to
  // Sarah and the vortex stays clear.
  private consoleDeskWorld = new THREE.Vector3(30, 0, -28);
  /** Sarah's spot at the console — beside Jack on the west side of the desk.
   * She navigates here during "to-console" and is settled here before the
   * console gesture so the two-up beat always reads. */
  private readonly sarahConsoleSpot = new THREE.Vector3(24, 0, -26);
  // Where the coffee counter sits, for the coffee-counter camera zone's
  // proximity trigger (see buildCoffeeMachine for the actual mesh).
  private coffeeCounterWorld = new THREE.Vector3(-26, 0, -8.5);

  /** Shared, root-motion-sanitized clip set harvested from every rigged
   * character's GLB so any character can play any gesture (identical bone
   * rigs => clips retarget by name; see ClipLibrary). */
  private readonly clipLibrary = new ClipLibrary();

  /** Resolvers for gestures still in flight, so dispose() can settle their
   * promises (the mixer 'finished' event never fires once the scene is torn
   * down) and the awaiting interaction handlers don't dangle. */
  private readonly pendingGestureResolvers = new Set<() => void>();

  // Picks the most specific cinematic framing that applies right now (close on
  // the coffee counter, a two-shot with Sarah, the console, the vortex chase)
  // and falls back to the plain follow camera otherwise — see
  // buildCameraZones(). The plain follow camera (updateCamera()) is kept
  // intact and still used for the very first frame's snap.
  private cameraDirector!: CameraDirector<CameraZoneState>;

  // Story Focus highlights for the current phase's tappable objects, keyed by
  // the same object userData.kind is tagged on — see addHighlight()/tryInteract().
  // dynamicOpts lets a single highlight re-skin itself (e.g. Sarah's marker
  // turning from 💬 to ! once the emergency starts) instead of registering a
  // second, conflicting highlight on the same object.
  private highlights = new Map<
    THREE.Object3D,
    { highlight: ObjectiveHighlight; isRelevant: () => boolean; dynamicOpts?: () => ObjectiveHighlightOptions }
  >();
  // Hides a highlight's marker the moment its object is selected (tapped, or
  // mid-walk toward it); restored if the player backs out of the confirm
  // prompt, cleared for good once the interaction actually happens.
  private selectedHighlightTarget: THREE.Object3D | null = null;
  // Reusable auto-walkers — see Navigator. Jack's is collider-aware (slides
  // along props); Sarah's scripted moves don't need that.
  private jackNav!: Navigator;
  private sarahNav!: Navigator;

  // Solid props the player can't walk through, as world-space XZ boxes already
  // grown by the player's radius (see buildColliders).
  private colliders: Array<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }> = [];
  private static readonly PLAYER_RADIUS = 1.5;

  // Live-tunable cup grip offsets, one per hand/character context, expressed
  // in an arm-relative basis (see gripPoint()). Exposed via an on-screen
  // panel behind ?tune=1 (buildGripTuner) so each can be dialed in visually
  // without a rebuild, even on the deployed site. Values below are the
  // final ones dialed in via the tuner.
  private gripOffsets: Record<GripContext, { along: number; up: number; side: number }> = {
    jackRight: { along: 0.51, up: 0.08, side: -0.31 },
    jackLeft: { along: 0.51, up: -0.12, side: 0.24 },
    sarahRight: { along: 0.3, up: 0.08, side: 0.0 },
  };
  // Cups currently riding a hand bone via the grip point, so the tuner panel
  // can reposition them live as its sliders move.
  private activeGrips: Array<{
    cup: THREE.Object3D;
    hand: THREE.Object3D;
    foreArm: THREE.Object3D | null;
    context: GripContext;
  }> = [];
  private gripTunerEl: HTMLElement | null = null;
  private unbindTunerGesture: (() => void) | null = null;
  private static readonly TUNER_STORAGE_KEY = "be-dev-tuner";

  constructor(private ctx: SceneContext) {
    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
  }

  async enter(): Promise<void> {
    const scene = this.scene;
    scene.background = new THREE.Color(0x3a4f73);
    scene.fog = new THREE.Fog(0x3a4f73, 60, 190);

    // ---- Lab lighting (clinical, brightly lit — a real lab, not a cave) ----
    this.ambient = new THREE.AmbientLight(0x8194ad, 1.65);
    scene.add(this.ambient);
    const key = new THREE.DirectionalLight(0xeaf2ff, 1.95);
    key.position.set(20, 40, 20);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    this.mainLights.push(key);
    // Ceiling fill lights (cool clinical glow), each with a visible fixture
    // housing so the light source reads as part of the room, not floating.
    const fixtureMat = new THREE.MeshStandardMaterial({
      color: 0xe7f3ff,
      emissive: 0xbfe0ff,
      emissiveIntensity: 1.45,
      roughness: 0.4,
    });
    const fixtureHousingMat = new THREE.MeshStandardMaterial({
      color: 0x2a3650,
      roughness: 0.6,
      metalness: 0.3,
    });
    for (let i = -2; i <= 2; i++) {
      const strip = new THREE.PointLight(0xdfeeff, 27, 80, 2);
      strip.position.set(i * 12, 14, 0);
      scene.add(strip);
      this.mainLights.push(strip);

      const fixture = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 1.6), fixtureMat);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.3, 2), fixtureHousingMat);
      fixture.position.set(i * 12, 13.6, 0);
      housing.position.set(i * 12, 13.95, 0);
      scene.add(fixture, housing);
    }

    this.buildRoom();
    this.buildCoffeeMachine();
    this.buildConsole();
    this.buildVortex();
    this.buildLabDetails();
    this.buildColliders();

    // ---- Characters ----
    this.jack = await this.buildCharacter("Jack", 0x3a78d0);
    // Spawn in the open aisle between the cafeteria tables — clear of every
    // collider grown by PLAYER_RADIUS.
    this.jack.position.set(-24, 0, 14);
    scene.add(this.jack);
    // Safety net: with the player radius baked into the colliders, never let
    // Jack spawn wedged inside one — a future prop/spawn tweak shouldn't be able
    // to soft-lock the opening. Nudge him toward the open floor until clear.
    for (
      let i = 0;
      i < 40 && this.isBlocked(this.jack.position.x, this.jack.position.z);
      i++
    ) {
      this.jack.position.z -= 1;
    }

    this.jackNav = new Navigator(this.jack, {
      speed: 16,
      resolveMove: (cx, cz, nx, nz) =>
        this.resolveMove(
          cx,
          cz,
          THREE.MathUtils.clamp(nx, -55, 55),
          THREE.MathUtils.clamp(nz, -38, 40),
        ),
    });

    this.sarah = await this.buildCharacter("Sarah", 0x36b27a);
    this.sarah.position.set(20, 0, -18);
    this.sarah.rotation.y = Math.PI;
    this.sarah.userData.kind = "sarah";
    scene.add(this.sarah);
    this.sarahNav = new Navigator(this.sarah, { speed: 10, arriveDistance: 0.5 });
    this.addHighlight(
      this.sarah,
      { color: "friendly", icon: "\u{1F4AC}", radius: 1.8, markerHeight: 8.2 },
      () => this.phase === "to-sarah" || this.phase === "reach-sarah",
      () =>
        this.phase === "reach-sarah"
          ? { color: "danger", icon: "!", radius: 1.8, markerHeight: 8.2 }
          : { color: "friendly", icon: "\u{1F4AC}", radius: 1.8, markerHeight: 8.2 },
    );

    // Emergency lights exist from the start (dark) so the alarm never changes
    // the scene's light count mid-play, which would otherwise recompile every
    // material at the climax — a crash-prone moment on mobile (a fresh compile
    // while the GL context is momentarily lost, e.g. across an orientation
    // change, throws "createShader returned null").
    this.buildRedLights();

    // Camera behind Jack.
    this.updateCamera(true);
    this.cameraDirector = new CameraDirector(this.camera);
    this.buildCameraZones();
    this.director = new SequenceDirector({
      playVoice: (id) => this.ctx.audio.playVoice(id),
      showSubtitle: (o) => this.ctx.dialogue.showSubtitle(o),
      hideSubtitle: () => this.ctx.dialogue.hideSubtitle(),
      setCameraMoment: (m, o) => this.setCameraMoment(m, o),
      clearCameraMoment: () => this.clearCameraMoment(),
      playGesture: (actor, clip) =>
        this.playGesture(actor === "sarah" ? this.sarah : this.jack, clip),
      setObjective: (t) =>
        t ? this.ctx.quest.setObjective(t) : this.ctx.quest.clear(),
      waitForInteraction: () => Promise.resolve(),
      chooseOption: () => Promise.resolve(""),
    });

    // With the camera in position and all lights present, warm up every shader
    // program now while the context is healthy. The vortex is briefly made
    // visible (and is never frustum-culled, see buildVortex) so its custom
    // ShaderMaterial is compiled here rather than for the first time at the
    // climax.
    this.vortex.visible = true;
    try {
      this.ctx.renderer.precompile(this.scene, this.camera);
    } finally {
      this.vortex.visible = false;
    }

    // Interaction.
    this.unsubClick = this.ctx.input.onClick(() => this.handleClick());

    this.phase = "coffee";
    // Cold open: the establishing shot + Jack's journal narration play over the
    // revealed scene, then control and the first objective are handed over. NOT
    // awaited so SceneManager can finish enter() and lift the black fade —
    // awaiting here would play the narration behind the fade.
    this.ctx.input.setEnabled(false);
    // As the lab opens, crossfade the main theme (playing since the menu and
    // through the journal intro) into the calm lab bed over ~4s — a smooth
    // blend, not a hard cut. Anchored here, after the async model/shader setup
    // above, so it starts the moment the scene actually appears.
    this.ctx.audio.playMusic("lab-calm");
    void this.playLabOpening();

    // Camera settings: apply persisted prefs, react to live slider changes, and
    // mount the in-game gear that opens the panel.
    this.applyFov();
    this.unsubSettings = subscribeSettings((s) => {
      this.settings = s;
      this.applyFov();
    });
    this.buildSettingsButton();
    // Visible in any build (including the deployed GitHub Pages site) via
    // ?tune=1, not just `pnpm dev` — DEV-only code is stripped from
    // production bundles, which would make the panel unreachable there.
    // ?tune=1 also flips a persistent "developer mode" flag (localStorage),
    // so once enabled the panel keeps showing on later visits without the
    // query param, and can be toggled by triple-tapping anywhere on screen —
    // handy for ongoing tuning during early development without needing to
    // re-type the URL each time.
    if (new URLSearchParams(location.search).has("tune")) {
      localStorage.setItem(PrologueCafeteriaScene.TUNER_STORAGE_KEY, "1");
    }
    if (localStorage.getItem(PrologueCafeteriaScene.TUNER_STORAGE_KEY) === "1") {
      this.buildGripTuner();
    }
    this.bindTunerGesture();
  }

  // ---------- World building ----------

  private buildRoom(): void {
    const scene = this.scene;
    const floorTex = createFloorTexture();
    const floorRepeat = 120 / FLOOR_TEXTURE_WORLD_SIZE;
    floorTex.repeat.set(floorRepeat, floorRepeat);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.75, metalness: 0.15 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.floor = floor;

    // Each wall clones the base wall texture so it can carry its own repeat
    // (whole tiles only — no stretching) without affecting the other walls.
    const wallTexBase = createWallTexture();
    const mkWall = (w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const tex = wallTexBase.clone();
      tex.repeat.set(w / WALL_TEXTURE_WORLD_SIZE.width, h / WALL_TEXTURE_WORLD_SIZE.height);
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, 0.6),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }),
      );
      wall.position.set(x, y, z);
      wall.rotation.y = ry;
      wall.receiveShadow = true;
      scene.add(wall);
    };
    mkWall(120, 24, 0, 12, -45, 0);
    mkWall(120, 24, 0, 12, 45, 0);
    mkWall(90, 24, -60, 12, 0, Math.PI / 2);
    mkWall(90, 24, 60, 12, 0, Math.PI / 2);

    // A few cafeteria tables on Jack's side
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x33445c, roughness: 0.6 });
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.4, 16), tableMat);
      t.position.set(-30 + (i % 2) * 12, 4, 6 + Math.floor(i / 2) * 12);
      t.castShadow = true;
      t.userData.solid = true;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 4, 8), tableMat);
      leg.position.copy(t.position);
      leg.position.y = 2;
      scene.add(t, leg);
    }

    // Sign hint at the far side: "LAB SEVEN"
    const signCanvas = document.createElement("canvas");
    signCanvas.width = 512;
    signCanvas.height = 128;
    const sctx = signCanvas.getContext("2d")!;
    sctx.fillStyle = "#0a1422";
    sctx.fillRect(0, 0, 512, 128);
    sctx.fillStyle = "#7fd0ff";
    sctx.font = "bold 64px Inter, sans-serif";
    sctx.textAlign = "center";
    sctx.textBaseline = "middle";
    sctx.fillText("LAB SEVEN →", 256, 64);
    const signTex = new THREE.CanvasTexture(signCanvas);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 4),
      new THREE.MeshBasicMaterial({ map: signTex }),
    );
    sign.position.set(20, 16, -44.6);
    scene.add(sign);
  }

  /** Set dressing that sells "research facility" beyond bare walls/floor: support
   * pillars, ceiling ducting, wall equipment racks, and a floor hazard stripe
   * marking the boundary between the cafeteria and the lab-proper beyond it. */
  private buildLabDetails(): void {
    const scene = this.scene;

    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x283450,
      roughness: 0.6,
      metalness: 0.4,
    });
    const bandMat = new THREE.MeshStandardMaterial({
      color: 0x1a2438,
      roughness: 0.5,
      metalness: 0.5,
    });
    const pillarPositions: Array<[number, number]> = [
      [-55, -40],
      [55, -40],
      [-55, 40],
      [55, 40],
      [-55, 0],
      [55, 0],
    ];
    for (const [x, z] of pillarPositions) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(2, 24, 2), pillarMat);
      pillar.position.set(x, 12, z);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      pillar.userData.solid = true;
      scene.add(pillar);
      for (const y of [4, 12, 20]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 2.4), bandMat);
        band.position.set(x, y, z);
        scene.add(band);
      }
    }

    // Ceiling pipe ducts running the length of the room, with collar joints.
    const pipeMat = new THREE.MeshStandardMaterial({
      color: 0x4a5568,
      roughness: 0.4,
      metalness: 0.7,
    });
    const collarMat = new THREE.MeshStandardMaterial({
      color: 0xc9a227,
      roughness: 0.5,
      metalness: 0.5,
    });
    const pipeRuns = [
      { x: -40, z0: -42, z1: 42 },
      { x: 40, z0: -42, z1: 42 },
    ];
    for (const run of pipeRuns) {
      const length = run.z1 - run.z0;
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, length, 12), pipeMat);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(run.x, 21.5, (run.z0 + run.z1) / 2);
      scene.add(pipe);
      const collars = Math.floor(length / 12);
      for (let i = 0; i <= collars; i++) {
        const collar = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.18, 8, 16), collarMat);
        collar.rotation.x = Math.PI / 2;
        collar.position.set(run.x, 21.5, run.z0 + i * 12);
        scene.add(collar);
      }
    }

    // Wall-mounted equipment racks — blinking-LED decal on a recessed panel.
    const equipTex = createEquipmentPanelTexture();
    const equipBodyMat = new THREE.MeshStandardMaterial({
      color: 0x222d40,
      roughness: 0.5,
      metalness: 0.4,
    });
    const equipScreenMat = new THREE.MeshBasicMaterial({ map: equipTex });
    const equipSpots = [
      { x: -58.6, y: 6, z: -10, faceSign: 1 },
      { x: -58.6, y: 6, z: 4, faceSign: 1 },
      { x: 58.6, y: 6, z: -30, faceSign: -1 },
    ];
    for (const spot of equipSpots) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3, 4), equipBodyMat);
      body.position.set(spot.x, spot.y, spot.z);
      body.castShadow = true;
      scene.add(body);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.6), equipScreenMat);
      screen.position.set(spot.x + spot.faceSign * 0.21, spot.y, spot.z);
      screen.rotation.y = spot.faceSign > 0 ? Math.PI / 2 : -Math.PI / 2;
      scene.add(screen);
    }

    // Floor hazard stripe marking the boundary between the cafeteria and the
    // lab-proper area where the console and vortex live.
    const hazardTex = createHazardStripeTexture();
    hazardTex.repeat.set(6, 1);
    const hazard = new THREE.Mesh(
      new THREE.PlaneGeometry(48, 1.6),
      new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.7 }),
    );
    hazard.rotation.x = -Math.PI / 2;
    hazard.position.set(-5, 0.03, -2);
    scene.add(hazard);
  }

  /**
   * Collect every mesh tagged `userData.solid` into a flat list of world-space
   * XZ boxes, each grown by the player's radius, so the movement code can keep
   * Jack from walking through tables, pillars, and the coffee machine. Boxes
   * (rather than circles) keep the test to a couple of comparisons per prop —
   * cheap to run every frame — and squaring off the round tables is invisible
   * at the game's three-quarter camera distance.
   */
  private buildColliders(): void {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const r = PrologueCafeteriaScene.PLAYER_RADIUS;
    this.scene.traverse((obj) => {
      if (!obj.userData || !obj.userData.solid) return;
      box.setFromObject(obj);
      if (!isFinite(box.min.x) || !isFinite(box.max.x)) return;
      this.colliders.push({
        minX: box.min.x - r,
        maxX: box.max.x + r,
        minZ: box.min.z - r,
        maxZ: box.max.z + r,
      });
    });
  }

  /** Push Jack and Sarah apart on the XZ plane if their bodies overlap. */
  private resolveCharacterOverlap(): void {
    const dx = this.jack.position.x - this.sarah.position.x;
    const dz = this.jack.position.z - this.sarah.position.z;
    const minDist = PrologueCafeteriaScene.PLAYER_RADIUS * 2;
    const distSq = dx * dx + dz * dz;
    if (distSq >= minDist * minDist || distSq < 1e-6) return;
    const dist = Math.sqrt(distSq);
    const push = (minDist - dist) / dist / 2;
    this.jack.position.x += dx * push;
    this.jack.position.z += dz * push;
    this.sarah.position.x -= dx * push;
    this.sarah.position.z -= dz * push;
  }

  /** True if an XZ point lies inside any solid prop's (player-grown) box. */
  private isBlocked(x: number, z: number): boolean {
    for (const c of this.colliders) {
      if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ) return true;
    }
    return false;
  }

  /**
   * Step from (curX,curZ) toward (nx,nz) one axis at a time so the player
   * slides along an obstacle instead of sticking to it, and can always back
   * out the way they came in.
   */
  private resolveMove(
    curX: number,
    curZ: number,
    nx: number,
    nz: number,
  ): { x: number; z: number } {
    let x = curX;
    let z = curZ;
    if (!this.isBlocked(nx, z)) x = nx;
    if (!this.isBlocked(x, nz)) z = nz;
    return { x, z };
  }

  private buildCoffeeMachine(): void {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(4, 7, 3),
      new THREE.MeshStandardMaterial({ color: 0x9aa6b3, roughness: 0.4, metalness: 0.6 }),
    );
    body.position.y = 3.5;
    body.castShadow = true;
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.6, 0.2),
      new THREE.MeshStandardMaterial({
        color: 0x123,
        emissive: 0x2f6ad0,
        emissiveIntensity: 0.8,
      }),
    );
    panel.position.set(0, 5, 1.6);

    // Counter the cups sit on.
    const counter = new THREE.Mesh(
      new THREE.BoxGeometry(14, 1, 4),
      new THREE.MeshStandardMaterial({ color: 0x394a63, roughness: 0.6, metalness: 0.3 }),
    );
    counter.position.set(4, 4, 1.5);
    counter.castShadow = true;
    counter.receiveShadow = true;

    g.add(body, panel, counter);
    g.position.set(-30, 0, -10);
    g.userData.solid = true;
    this.coffeeMachine = body;
    this.scene.add(g);

    // Two coffee cups on the counter — collected by tapping, then confirming.
    const cupPositions = [
      new THREE.Vector3(-28, 4.9, -8),
      new THREE.Vector3(-25, 4.9, -8),
    ];
    cupPositions.forEach((pos, i) => {
      const cup = this.makeCup();
      cup.scale.setScalar(0.4);
      cup.position.copy(pos);
      cup.userData.kind = "coffee";
      cup.userData.index = i;
      this.scene.add(cup);
      this.coffeeStations.push(cup);
      // Only the next cup to collect glows — not both at once (see ObjectiveHighlight).
      this.addHighlight(
        cup,
        { color: "story", icon: "☕", radius: 1.1, markerHeight: 2.2 },
        () => this.phase === "coffee" && this.coffeeCount === i,
      );
    });
  }

  private makeCup(): THREE.Group {
    const cup = new THREE.Group();
    const mug = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.4, 1.1, 14),
      new THREE.MeshStandardMaterial({ color: 0xf3ede0, roughness: 0.8 }),
    );
    mug.castShadow = true;
    const brew = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 0.1, 14),
      new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.5 }),
    );
    brew.position.y = 0.55;
    cup.add(mug, brew);
    return cup;
  }

  /**
   * Places a carried cup at the hand's grip point (palm, not the wrist
   * pivot — see gripPoint()), then reparents it onto the bone with attach()
   * so the cup's local transform is computed to keep that exact spot — from
   * then on it rides the bone through every animated pose instead of
   * drifting from a static offset.
   */
  private attachCupToHand(
    cup: THREE.Object3D,
    hand: THREE.Object3D,
    foreArm: THREE.Object3D | null,
    context: GripContext,
  ): void {
    const gripWorld = this.gripPoint(hand, foreArm, context);
    this.scene.attach(cup);
    cup.position.copy(gripWorld);
    hand.attach(cup);
    this.activeGrips.push({ cup, hand, foreArm, context });
  }

  private spawnCoffee(index: number): void {
    const cup = this.makeCup();
    cup.scale.setScalar(0.4);
    this.coffees.push(cup as unknown as THREE.Mesh);
    this.scene.add(cup);
    // index 0 sits on Jack's right side, index 1 on his left, matching the two
    // counter cups' relative positions.
    const side = index === 0 ? "right" : "left";
    const hand = this.handBone(this.jack, side);
    if (hand) {
      this.attachCupToHand(
        cup,
        hand,
        this.foreArmBone(this.jack, side),
        side === "right" ? "jackRight" : "jackLeft",
      );
    } else {
      // Placeholder capsule has no rig — fall back to a static offset.
      this.scene.remove(cup);
      this.jack.add(cup);
      cup.position.set(index === 0 ? -1.9 : 1.9, 3.1, 1.0);
    }
  }

  /**
   * Jack hands one of his two coffees to Sarah when they meet: the cup detaches
   * into world space (keeping its on-screen position), glides across to her
   * hand's current world position, and is then parented to that hand bone so
   * it keeps tracking her pose for the rest of the scene.
   */
  private async handCoffeeToSarah(): Promise<void> {
    const cup = this.coffees.pop();
    if (!cup) return;
    this.activeGrips = this.activeGrips.filter((g) => g.cup !== cup);
    this.scene.attach(cup);
    const hand = this.handBone(this.sarah, "right") ?? this.sarah;
    const foreArm = this.foreArmBone(this.sarah, "right");
    const gripWorld = this.gripPoint(hand, foreArm, "sarahRight");
    await this.tween(cup.position, gripWorld, 600);
    if (this.disposed) return;
    hand.attach(cup);
    this.sarahCup = cup;
    this.activeGrips.push({ cup, hand, foreArm, context: "sarahRight" });
  }

  /**
   * When Jack works the console, both characters set their coffees down on the
   * desktop: Jack's carried cup and the one he gave Sarah detach into world
   * space and glide onto the desk surface.
   */
  private async setCoffeesOnConsole(): Promise<void> {
    const top = 4.94; // desk top (y=4.5) + scaled cup half-height
    const slots = [
      new THREE.Vector3(28.8, top, -26.5),
      new THREE.Vector3(28.8, top, -29.5),
    ];
    const cups: THREE.Object3D[] = [];
    while (this.coffees.length) {
      const c = this.coffees.pop();
      if (c) cups.push(c);
    }
    if (this.sarahCup) {
      cups.push(this.sarahCup);
      this.sarahCup = null;
    }
    this.activeGrips = this.activeGrips.filter((g) => !cups.includes(g.cup));
    const tweens = cups.slice(0, slots.length).map((cup, i) => {
      this.scene.attach(cup);
      return this.tween(cup.position, slots[i], 450);
    });
    await Promise.all(tweens);
  }

  private buildConsole(): void {
    const g = new THREE.Group();
    // The desk is a control bank standing off to the EAST of the central
    // accelerator lane (long axis along Z), not a wall across it. This keeps the
    // straight path from the approach point to the accelerator/vortex clear, so
    // Jack and Sarah walk past the console rather than through it.
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(4, 1, 12),
      new THREE.MeshStandardMaterial({ color: 0x2b3a52, roughness: 0.5, metalness: 0.4 }),
    );
    desk.position.set(10, 4, 0);
    desk.castShadow = true;
    g.add(desk);
    // Holographic screens line the desk's west face, angled toward the lane so
    // the player reads them while operating the console from the west.
    for (let i = -1; i <= 1; i++) {
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 2.2),
        new THREE.MeshStandardMaterial({
          color: 0x0a1828,
          emissive: 0x39c5ff,
          emissiveIntensity: 0.7,
          transparent: true,
          opacity: 0.92,
        }),
      );
      screen.position.set(7.8, 7, i * 4);
      screen.rotation.y = -Math.PI / 2;
      screen.rotation.x = -0.12;
      g.add(screen);
    }
    // Accelerator ring — centered in the lane behind the approach point.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(9, 0.7, 16, 60),
      new THREE.MeshStandardMaterial({
        color: 0x55708f,
        emissive: 0x2a6cff,
        emissiveIntensity: 0.5,
        metalness: 0.8,
        roughness: 0.3,
      }),
    );
    ring.position.set(0, 11, -14);
    g.add(ring);
    (g.userData as { ring?: THREE.Mesh }).ring = ring;

    g.position.set(20, 0, -28);
    this.console = g;
    desk.userData.kind = "console";
    // Permanently solid: it sits beside the lane, so it never needs to be
    // dropped for the finale.
    desk.userData.solid = true;
    this.scene.add(g);
    this.interactables.push(desk);
    this.addHighlight(
      desk,
      { color: "tech", icon: "⚙", radius: 2.2, markerHeight: 5.5 },
      () => this.phase === "to-console",
    );
  }

  private buildVortex(): void {
    const g = new THREE.Group();
    this.vortexUniforms = { uTime: { value: 0 } };

    // A colorless, pressure-like swirl — desaturated greys/whites, NOT a blue
    // portal. Built from layered transparent rings.
    const geo = new THREE.RingGeometry(0.5, 9, 64, 8);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      uniforms: this.vortexUniforms,
      vertexShader: `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        varying vec2 vUv;
        void main(){
          vec2 c = vUv - 0.5;
          float a = atan(c.y, c.x);
          float r = length(c);
          float swirl = sin(a * 6.0 + uTime * 3.0 - r * 24.0);
          float pressure = smoothstep(0.5, 0.0, r) * (0.6 + 0.4 * swirl);
          // Colorless: value only, faintly cool but essentially grey/white.
          vec3 col = vec3(0.86, 0.88, 0.9) * pressure;
          float alpha = pressure * 0.9;
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    const disc = new THREE.Mesh(geo, mat);
    // The vortex is a focal climax effect; never cull it, so its custom shader
    // is reliably included when we pre-warm shader programs at scene start.
    disc.frustumCulled = false;
    g.add(disc);

    // Faint outer distortion shell
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(11, 32, 32),
      new THREE.MeshBasicMaterial({
        color: 0xdfe2e6,
        transparent: true,
        opacity: 0.06,
        side: THREE.BackSide,
      }),
    );
    shell.frustumCulled = false;
    g.add(shell);

    g.position.set(20, 9, -40);
    g.rotation.x = 0;
    g.visible = false;
    g.scale.setScalar(0.01);
    this.vortex = g;
    this.scene.add(g);
  }

  /**
   * Emergency lights are created up-front at zero intensity (not when the alarm
   * fires) so the scene's light count — and therefore every material's compiled
   * shader program — is final from the start. Adding lights mid-scene would
   * force a shader recompile at the dramatic moment, which on mobile is exactly
   * where the resonance-cascade beat could crash.
   */
  private buildRedLights(): void {
    for (let i = 0; i < 4; i++) {
      const rl = new THREE.PointLight(0xff2d22, 0, 80);
      rl.position.set(20 + (i % 2 ? 18 : -18), 16, -28 + (i < 2 ? 14 : -14));
      this.scene.add(rl);
      this.redLights.push(rl);
    }
  }

  private async buildCharacter(
    name: string,
    color: number,
  ): Promise<THREE.Group> {
    const group = new THREE.Group();
    // Try a real GLB; fall back to a colored capsule placeholder.
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
    // GLB exports vary wildly in scale and origin, so normalize the loaded
    // model to a consistent on-screen height and plant its feet on the floor.
    // This keeps the camera framing correct and makes future (animated) model
    // swaps drop-in without re-tuning.
    this.groundAndScale(model, PrologueCafeteriaScene.CHARACTER_HEIGHT);
    if (model.animations && model.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(model);
      const clips = model.animations;
      const byRe = (re: RegExp) => clips.find((c) => re.test(c.name));
      const idleClip =
        THREE.AnimationClip.findByName(clips, "Idle") ??
        byRe(/idle/i) ??
        clips[0];
      // Prefer a plain walk; fall back to any walk/run-style locomotion clip so
      // every rig (Jack: Walking, Sarah: Walking/Casual_Walk) animates on move.
      const walkClip =
        byRe(/^walking$/i) ??
        byRe(/walk/i) ??
        byRe(/^running$/i) ??
        byRe(/run/i) ??
        null;

      // Both clips run continuously; locomotion is a weighted crossfade between
      // them (see applyLocomotion), so movement reads as walking and stopping
      // settles back to idle without a pop.
      const idleAction = mixer.clipAction(idleClip);
      idleAction.play();
      const actions: CharacterActions = { idle: idleAction };
      if (walkClip && walkClip !== idleClip) {
        const walkAction = mixer.clipAction(walkClip);
        walkAction.play();
        walkAction.setEffectiveWeight(0);
        actions.walk = walkAction;
      }

      // Force the idle pose onto the skeleton immediately so the very first
      // rendered frame never shows the raw bind pose (which can look like
      // limbs clipping through the body) before the game loop's first tick.
      mixer.update(0);

      this.mixers.push(mixer);
      group.userData.mixer = mixer;
      group.userData.actions = actions;
      group.userData.walkBlend = 0;
      group.userData.gestureBlend = 0;
      group.userData.gesturing = false;
      // Contribute this rig's clips to the shared library so any character can
      // play them later (Jack adds idle/walk/run; Sarah adds the rich gesture
      // set). The continuous idle/walk actions above keep using the originals,
      // so locomotion is unaffected by the library's root-motion sanitizing.
      this.clipLibrary.add(clips);
    }
    // Cache the rig's hand and forearm bones (Mixamo-style naming) so carried
    // props can be parented directly to the hand — that way a held cup tracks
    // the actual animated hand pose instead of a static offset from the
    // character root, which used to drift away from the hand mid-gesture. The
    // forearm bone is kept too: it gives the forearm->hand direction needed to
    // push a grip point past the wrist into the palm (see attachCupToHand).
    let leftHand: THREE.Object3D | null = null;
    let rightHand: THREE.Object3D | null = null;
    let leftForeArm: THREE.Object3D | null = null;
    let rightForeArm: THREE.Object3D | null = null;
    model.traverse((obj) => {
      // Skinned meshes keep their *bind-pose* bounding volume, so once an arm
      // animates outside it Three.js can frustum-cull the whole mesh the moment
      // that stale volume leaves the view — limbs (or the entire figure) pop in
      // and out as the dialogue camera orbits, and a culled hand leaves its
      // carried cup floating with no hand around it. Disable culling for the two
      // hero characters (always near camera; negligible cost) so they always draw.
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) mesh.frustumCulled = false;
      if ((obj as THREE.Bone).isBone) {
        if (obj.name === "LeftHand") leftHand = obj;
        else if (obj.name === "RightHand") rightHand = obj;
        else if (obj.name === "LeftForeArm") leftForeArm = obj;
        else if (obj.name === "RightForeArm") rightForeArm = obj;
      }
    });
    group.userData.leftHand = leftHand;
    group.userData.rightHand = rightHand;
    group.userData.leftForeArm = leftForeArm;
    group.userData.rightForeArm = rightForeArm;
    group.userData.name = name;
    return group;
  }

  /** The rig's left/right hand bone, or null for the capsule placeholder. */
  private handBone(
    character: THREE.Group,
    side: "left" | "right",
  ): THREE.Object3D | null {
    return (character.userData[side === "left" ? "leftHand" : "rightHand"] as
      | THREE.Object3D
      | undefined) ?? null;
  }

  /** The rig's left/right forearm bone, or null for the capsule placeholder. */
  private foreArmBone(
    character: THREE.Group,
    side: "left" | "right",
  ): THREE.Object3D | null {
    return (character.userData[
      side === "left" ? "leftForeArm" : "rightForeArm"
    ] as THREE.Object3D | undefined) ?? null;
  }

  /**
   * A grip point in the palm, offset from the wrist bone along an
   * arm-relative basis: `along` the forearm->hand axis (push deeper into/out
   * of the palm), `up`/`side` perpendicular to it (world-up and left/right
   * relative to the arm). The rig has no finger bones, so this approximates
   * where a closed hand would actually hold an object. Values live in
   * `gripOffsets`, keyed by which hand/character is gripping, tunable at
   * runtime via the ?tune=1 panel (buildGripTuner). Falls back to the wrist
   * position itself if there's no forearm bone to derive a direction from.
   */
  private gripPoint(
    hand: THREE.Object3D,
    foreArm: THREE.Object3D | null,
    context: GripContext,
  ): THREE.Vector3 {
    hand.updateMatrixWorld(true);
    const handWorld = new THREE.Vector3();
    hand.getWorldPosition(handWorld);
    if (!foreArm) return handWorld;
    foreArm.updateMatrixWorld(true);
    const foreArmWorld = new THREE.Vector3();
    foreArm.getWorldPosition(foreArmWorld);
    const along = handWorld.clone().sub(foreArmWorld);
    if (along.lengthSq() < 1e-8) return handWorld;
    along.normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    let side = along.clone().cross(worldUp);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const up = side.clone().cross(along).normalize();
    const offset = this.gripOffsets[context];
    return handWorld
      .add(along.multiplyScalar(offset.along))
      .add(up.multiplyScalar(offset.up))
      .add(side.multiplyScalar(offset.side));
  }

  /** Recomputes every held cup's local position from the current gripOffsets. */
  private regripAll(): void {
    for (const { cup, hand, foreArm, context } of this.activeGrips) {
      const gripWorld = this.gripPoint(hand, foreArm, context);
      cup.position.copy(hand.worldToLocal(gripWorld));
    }
  }

  /**
   * Lets three quick taps/clicks anywhere on screen show or hide the grip
   * tuner panel and flip the persisted developer-mode flag, so it can be
   * reached again later without re-adding ?tune=1 to the URL.
   */
  private bindTunerGesture(): void {
    let tapTimes: number[] = [];
    const onTap = () => {
      const now = performance.now();
      tapTimes = tapTimes.filter((t) => now - t < 600);
      tapTimes.push(now);
      if (tapTimes.length < 3) return;
      tapTimes = [];
      if (this.gripTunerEl) {
        this.gripTunerEl.remove();
        this.gripTunerEl = null;
        localStorage.setItem(PrologueCafeteriaScene.TUNER_STORAGE_KEY, "0");
      } else {
        localStorage.setItem(PrologueCafeteriaScene.TUNER_STORAGE_KEY, "1");
        this.buildGripTuner();
      }
    };
    window.addEventListener("pointerdown", onTap);
    this.unbindTunerGesture = () => window.removeEventListener("pointerdown", onTap);
  }

  /**
   * Panel (behind ?tune=1, persisted developer mode, or a triple-tap — see
   * bindTunerGesture) with a context switcher (Jack R / Jack L / Sarah R),
   * sliders for the selected context's gripOffsets axes, and a "Copy all"
   * button that dumps every context's tuned values at once, so they can be
   * pasted back into gripOffsets' initializer above. Re-tuning later (e.g.
   * if Jack's or Sarah's model is swapped) just means revisiting this panel
   * — the offsets are per hand/character, not hardcoded geometry.
   */
  private buildGripTuner(): void {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:9999;background:rgba(10,16,28,0.85);" +
      "color:#dfe9ff;font:12px monospace;padding:10px;border-radius:8px;width:220px;" +
      "display:flex;flex-direction:column;gap:6px;";

    const title = document.createElement("div");
    title.textContent = "Grip tuner";
    title.style.fontWeight = "bold";
    el.appendChild(title);

    const contexts: Array<{ key: GripContext; label: string }> = [
      { key: "jackRight", label: "Jack R" },
      { key: "jackLeft", label: "Jack L" },
      { key: "sarahRight", label: "Sarah R" },
    ];
    let current: GripContext = "jackRight";

    const tabRow = document.createElement("div");
    tabRow.style.cssText = "display:flex;gap:4px;";
    const tabButtons = new Map<GripContext, HTMLButtonElement>();

    const slidersBox = document.createElement("div");
    slidersBox.style.cssText = "display:flex;flex-direction:column;gap:6px;";

    const sliderInputs: Array<{
      key: "along" | "up" | "side";
      input: HTMLInputElement;
      val: HTMLElement;
    }> = [];

    const refreshSliders = () => {
      const offset = this.gripOffsets[current];
      for (const { key, input, val } of sliderInputs) {
        input.value = String(offset[key]);
        val.textContent = offset[key].toFixed(2);
      }
      for (const [key, btn] of tabButtons) {
        btn.style.background = key === current ? "#3d6fb5" : "#2a3650";
      }
    };

    const slider = (label: string, key: "along" | "up" | "side") => {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;flex-direction:column;gap:2px;";
      const top = document.createElement("span");
      top.style.cssText = "display:flex;justify-content:space-between;";
      const name = document.createElement("span");
      name.textContent = label;
      const val = document.createElement("b");
      top.append(name, val);
      const input = document.createElement("input");
      input.type = "range";
      input.min = "-0.6";
      input.max = "0.8";
      input.step = "0.01";
      input.addEventListener("input", () => {
        this.gripOffsets[current][key] = parseFloat(input.value);
        val.textContent = this.gripOffsets[current][key].toFixed(2);
        this.regripAll();
      });
      row.append(top, input);
      slidersBox.appendChild(row);
      sliderInputs.push({ key, input, val });
    };
    slider("Along arm", "along");
    slider("Up / down", "up");
    slider("Left / right", "side");

    for (const { key, label } of contexts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.style.cssText =
        "flex:1;background:#2a3650;color:#dfe9ff;border:1px solid #4a5b7a;border-radius:4px;" +
        "padding:4px;cursor:pointer;font:11px monospace;";
      btn.addEventListener("click", () => {
        current = key;
        refreshSliders();
      });
      tabButtons.set(key, btn);
      tabRow.appendChild(btn);
    }
    el.append(tabRow, slidersBox);
    refreshSliders();

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy all";
    copyBtn.style.cssText =
      "background:#2a3650;color:#dfe9ff;border:1px solid #4a5b7a;border-radius:4px;padding:4px;cursor:pointer;";
    const log = document.createElement("pre");
    log.style.cssText = "white-space:pre-wrap;font-size:10px;opacity:.8;margin:0;";
    copyBtn.addEventListener("click", async () => {
      const text = JSON.stringify(this.gripOffsets, null, 2);
      log.textContent = text;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied!";
      } catch {
        copyBtn.textContent = "Copy failed — see below";
      }
      setTimeout(() => (copyBtn.textContent = "Copy all"), 1200);
    });
    el.append(copyBtn, log);

    this.ctx.uiLayer.appendChild(el);
    this.gripTunerEl = el;
  }

  /** Scale a model to `targetHeight` world units and sit its feet at y=0. */
  private groundAndScale(model: THREE.Object3D, targetHeight: number): void {
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(model).getSize(size);
    if (size.y > 1e-3) {
      model.scale.multiplyScalar(targetHeight / size.y);
    }
    const grounded = new THREE.Box3().setFromObject(model);
    model.position.y -= grounded.min.y;
  }

  /**
   * Crossfade a character between its idle and walk clips by easing the two
   * action weights toward the movement state every frame. Both clips always
   * play; only the weights change, which sidesteps the timing pitfalls of
   * scheduled crossfades and reads as a smooth walk<->idle transition.
   */
  private applyLocomotion(
    group: THREE.Group,
    moving: boolean,
    dt: number,
  ): void {
    const actions = group.userData.actions as CharacterActions | undefined;
    if (!actions) return;

    // Idle<->walk crossfade (only when the rig actually has a walk clip).
    let idleW = 1;
    let walkW = 0;
    if (actions.walk) {
      const target = moving ? 1 : 0;
      const k = 1 - Math.pow(0.0015, dt); // ~0.15s ease, frame-rate independent
      const blend = THREE.MathUtils.lerp(
        (group.userData.walkBlend as number) ?? 0,
        target,
        k,
      );
      group.userData.walkBlend = blend;
      walkW = blend;
      idleW = 1 - blend;
    }

    // One-shot gesture overlay: ease a 0..1 blend toward 1 while a gesture is
    // active and back to 0 once it finishes. At full blend the gesture owns the
    // body and locomotion fades out underneath it. Driving the gesture's weight
    // here (instead of action.fadeIn/Out) keeps a single source of truth, so the
    // two systems never fight over setEffectiveWeight each frame.
    const gestureTarget = (group.userData.gesturing as boolean) ? 1 : 0;
    const gk = 1 - Math.pow(0.0008, dt); // ~0.2s ease
    const gestureBlend = THREE.MathUtils.lerp(
      (group.userData.gestureBlend as number) ?? 0,
      gestureTarget,
      gk,
    );
    group.userData.gestureBlend = gestureBlend;

    const loco = 1 - gestureBlend;
    actions.idle.setEffectiveWeight(idleW * loco);
    if (actions.walk) actions.walk.setEffectiveWeight(walkW * loco);
    if (actions.gesture) actions.gesture.setEffectiveWeight(gestureBlend);
  }

  /**
   * Play a one-shot, full-body gesture on a character by clip name, retargeted
   * from the shared ClipLibrary onto that character's rig (bound by bone name).
   * The gesture crossfades in over the idle/walk locomotion — held back by
   * gestureBlend in applyLocomotion — plays once, clamps on its final frame,
   * then crossfades back out. Resolves once the clip has finished. A missing
   * clip is a no-op that resolves immediately, so callers stay functional even
   * if a clip name is wrong or absent.
   */
  private playGesture(
    character: THREE.Group,
    clipName: string,
    opts: { duration?: number } = {},
  ): Promise<void> {
    const mixer = character.userData.mixer as THREE.AnimationMixer | undefined;
    const actions = character.userData.actions as CharacterActions | undefined;
    const clip = this.clipLibrary.get(clipName);
    if (!mixer || !actions || !clip) {
      if (!clip) {
        console.warn(
          `[Beyond Extinction] gesture clip "${clipName}" not in ClipLibrary — skipping.`,
        );
      }
      return Promise.resolve();
    }

    // Retire any in-flight gesture so a new one takes over cleanly.
    actions.gesture?.stop();

    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset();
    // Long clips (open_door_3 is a ~9s walk-to-a-door) are time-scaled to a
    // readable beat; the action's weight is driven by gestureBlend, not here.
    action.timeScale =
      opts.duration && opts.duration > 0 ? clip.duration / opts.duration : 1;
    action.setEffectiveWeight(0);
    action.play();
    actions.gesture = action;
    character.userData.gesturing = true;

    return new Promise<void>((resolve) => {
      let onFinished: (event: { action: THREE.AnimationAction }) => void;
      const finish = (): void => {
        mixer.removeEventListener("finished", onFinished as never);
        this.pendingGestureResolvers.delete(finish);
        character.userData.gesturing = false;
        resolve();
      };
      onFinished = (event) => {
        if (event.action === action) finish();
      };
      this.pendingGestureResolvers.add(finish);
      mixer.addEventListener("finished", onFinished as never);
    });
  }

  // ---------- Cutscene direction ----------

  /**
   * Resolve a named scripted camera framing to a concrete position/lookAt,
   * computed live from current world positions so a moment can track moving
   * actors (the climax two-shot follows Jack and Sarah). Unknown ids return
   * null and the scripted zone falls back to a plain follow framing.
   */
  private cameraMoment(
    id: string,
    s: CameraZoneState,
  ): { position: THREE.Vector3; lookAt: THREE.Vector3 } | null {
    if (id === "establishing") {
      // "Before Everything": a slow, continuous eye-level push-in from the
      // entrance end, drifting deep toward the accelerator while Jack's journal
      // narration plays — the camera quietly entering a space it doesn't belong
      // in yet, rather than cutting to a static hold. Held at ~8u (a person
      // walking in, not a god-cam) and centered on X=0 so the accelerator and
      // Sarah stay framed without the portrait/narrow-window edge drift the
      // layout pass flagged. Position is absolute (no framingScale): the
      // centered framing is what keeps it portrait-safe, and the wider portrait
      // FOV (see applyFov) opens up around the subject on its own.
      const p = this.openingPushProgress(s.elapsed);
      const e = p * p * (3 - 2 * p); // smoothstep: gentle start, gentle settle
      return {
        position: new THREE.Vector3(0, 8, 30).lerp(new THREE.Vector3(0, 8, -5), e),
        // Aimed down the lane toward the accelerator end (-Z), biased slightly
        // east (X=6) so the ring and Sarah's console (both at X=20) read without
        // pulling the coffee counter off the left edge.
        lookAt: new THREE.Vector3(6, 7, -38),
      };
    }
    if (id === "climax") {
      // Tight two-shot tracking the midpoint between Jack and Sarah.
      const mid = s.jack.clone().lerp(s.sarah, 0.5);
      const look = mid.clone();
      look.y += 4.2;
      return {
        position: mid
          .clone()
          .add(new THREE.Vector3(2, 5, 16).multiplyScalar(s.framingScale)),
        lookAt: look,
      };
    }
    return null;
  }

  private setCameraMoment(moment: string, opts?: { cut?: boolean }): void {
    this.scriptedCameraMoment = moment;
    if (opts?.cut) this.cameraDirector.cut();
  }

  private clearCameraMoment(): void {
    this.scriptedCameraMoment = null;
    this.openingPushStartElapsed = null;
  }

  /**
   * Normalized 0..1 progress of the opening "establishing" push-in, from the
   * frame it first became active to {@link openingPushDurationS} later. Returns
   * 0 before the start frame is captured.
   */
  private openingPushProgress(elapsed: number): number {
    if (this.openingPushStartElapsed === null) return 0;
    return THREE.MathUtils.clamp(
      (elapsed - this.openingPushStartElapsed) / this.openingPushDurationS,
      0,
      1,
    );
  }

  /** Cold-open narration, then control + first objective (see enter()). */
  private async playLabOpening(): Promise<void> {
    await this.director.play(labOpeningNarration);
    if (this.disposed) return;
    this.ctx.input.setEnabled(true);
    this.ctx.quest.setObjective("Get two coffees from the counter.");
    this.ctx.overlays.showHint(this.walkHint);
  }

  // ---------- Interaction & phases ----------

  /** Tap/click targets worth raycasting against in the current phase. */
  private tapTargets(): THREE.Object3D[] {
    if (this.phase === "coffee") {
      // Only the next cup to collect is tappable — matches its highlight.
      const next = this.coffeeStations.find((s) => s.userData.index === this.coffeeCount);
      return next ? [next] : [];
    }
    if (this.phase === "to-sarah" || this.phase === "reach-sarah") return [this.sarah];
    if (this.phase === "to-console") return this.interactables;
    return [];
  }

  /** Walk up from a raycast hit (often a deep mesh) to its tagged ancestor. */
  private resolveInteractable(obj: THREE.Object3D): THREE.Object3D | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur.userData.kind) return cur;
      cur = cur.parent;
    }
    return null;
  }

  /** How close Jack must be to act on a tagged object, and the point to measure from. */
  private interactionRange(target: THREE.Object3D): {
    anchor: THREE.Vector3;
    radius: number;
    /** Optional point to walk to instead of `anchor` (e.g. stop short of a person). */
    walkTo?: THREE.Vector3;
  } {
    if (target.userData.kind === "console") {
      return {
        anchor: this.consoleDeskWorld.clone().add(new THREE.Vector3(-6, 0, 0)),
        radius: 7,
      };
    }
    if (target.userData.kind === "sarah") {
      // The emergency dash: no Yes/No prompt, so only count as "arrived"
      // once Jack is genuinely at her side (see tryInteract).
      if (this.phase === "reach-sarah") return { anchor: target.position, radius: 4 };
      // Stop a conversational step short of her: the nav target is otherwise
      // her body centre, so Jack walks into her and grinds there while
      // resolveCharacterOverlap shoves them apart. walkTo is offset back along
      // his approach bearing (4 > 2*PLAYER_RADIUS, so no overlap); anchor +
      // radius still gate "already close enough to talk".
      const stand = target.position.clone();
      const toJack = this.jack.position.clone().sub(target.position);
      toJack.y = 0;
      stand.add(
        toJack.lengthSq() > 1e-4
          ? toJack.normalize().multiplyScalar(4)
          : new THREE.Vector3(-4, 0, 0),
      );
      return { anchor: target.position, radius: 7, walkTo: stand };
    }
    if (target.userData.kind === "coffee") {
      // Jack walks up to ONE spot centered in front of the counter and stays
      // planted there for both cups — he only rotates to face each one (see
      // pickUpCoffee). Anchoring both cups to the same point means tapping the
      // second cup never makes him shuffle sideways. The cups sit on the solid
      // counter, so the stand point is just south of it.
      return {
        anchor: new THREE.Vector3(this.coffeeCounterWorld.x, 0, -3),
        radius: this.pickupRadius,
      };
    }
    return { anchor: target.position, radius: this.pickupRadius };
  }

  /**
   * The Lab Prologue is guided, not free-roam: the player never moves Jack
   * directly. Tapping the current story objective is the only input that
   * moves him — see Navigator. Taps on anything else (floor, scenery) do
   * nothing, by design ("the player learns: I tap important things").
   */
  private handleClick(): void {
    if (this.ctx.dialogue.isActive || this.confirmOpen) return;
    if (
      this.phase !== "coffee" &&
      this.phase !== "to-sarah" &&
      this.phase !== "to-console" &&
      this.phase !== "reach-sarah"
    ) {
      return;
    }

    const targets = this.tapTargets();
    if (targets.length === 0) return;
    const hits = this.ctx.input.intersect(this.camera, targets);
    // Each phase exposes exactly one active objective, so a miss (e.g. it's
    // off-screen — Sarah can start a whole room away from the coffee
    // counter) still resolves to it: there's nothing else a tap on the game
    // world could mean right now.
    const interactable =
      hits.length > 0 ? this.resolveInteractable(hits[0].object) : targets[0];
    if (!interactable) return;

    const { anchor, radius, walkTo } = this.interactionRange(interactable);
    if (this.jack.position.distanceTo(anchor) <= radius) {
      this.tryInteract(interactable);
      return;
    }
    // Out of range — auto-walk to the interaction point and open the prompt
    // (or, for the emergency dash, trigger the vortex) the instant Jack
    // arrives, hiding the marker while he's selected/walking. walkTo lets a
    // target stop Jack short of its centre (e.g. Sarah) without moving the
    // in-range gate above.
    this.selectedHighlightTarget = interactable;
    this.jackNav.goTo(walkTo ?? anchor, () => this.tryInteract(interactable));
  }

  /** Opens a Yes/No prompt for a tapped, in-range object and acts on "Yes". */
  private async tryInteract(target: THREE.Object3D): Promise<void> {
    const kind = target.userData.kind as string | undefined;

    // The emergency dash to Sarah skips the prompt entirely — urgency, not a
    // decision — and goes straight into the vortex beat.
    if (kind === "sarah" && this.phase === "reach-sarah") {
      this.faceTowards(this.jack, target.position);
      this.dismissHighlight(target);
      this.triggerVortex();
      return;
    }

    let message: string;
    let onYes: () => void;
    if (kind === "coffee" && this.phase === "coffee") {
      message = "Pick up coffee cup?";
      onYes = () => this.pickUpCoffee(target);
    } else if (kind === "sarah" && this.phase === "to-sarah") {
      message = "Deliver the coffee to Sarah?";
      onYes = () => this.triggerIntroDialogue();
    } else if (kind === "console" && this.phase === "to-console") {
      message = "Stabilise the accelerator?";
      onYes = () => this.triggerConsoleDialogue();
    } else {
      return;
    }

    // Arrived — face the object before the prompt comes up.
    this.faceTowards(this.jack, target.position);
    // Selected — hide its Story Focus marker while the prompt's up.
    this.selectedHighlightTarget = target;
    this.confirmOpen = true;
    this.ctx.input.setEnabled(false);
    const yes = await this.ctx.overlays.showConfirm(message);
    if (this.disposed) return;
    this.confirmOpen = false;
    this.ctx.input.setEnabled(true);
    if (yes) {
      // Sarah's highlight stays registered across this delivery and the later
      // emergency dash (its isRelevant/dynamicOpts cover both phases — see
      // the addHighlight call in buildCharacter's Sarah setup); coffee cups
      // and the console are one-shot, so only those get permanently retired.
      if (kind === "sarah") {
        if (this.selectedHighlightTarget === target) this.selectedHighlightTarget = null;
      } else {
        this.dismissHighlight(target);
      }
      onYes();
    } else if (this.selectedHighlightTarget === target) {
      this.selectedHighlightTarget = null;
    }
  }

  private pickUpCoffee(station: THREE.Object3D): void {
    if (this.coffeeCount >= 2) return;
    const idx = (station.userData.index as number) ?? this.coffeeCount;
    // Plant Jack and turn him to the cup he's collecting — no walking between
    // cups. (The pickup "reach" gesture is intentionally disabled for now; the
    // shared gesture system stays wired via playGesture for a future clip.)
    this.jackNav.stop();
    this.faceTowards(this.jack, station.position);
    this.ctx.audio.playSfx("coffee-pour");
    // Remove the cup from the counter and give Jack a carried one (index 0 ->
    // right hand, index 1 -> left hand; see spawnCoffee).
    station.parent?.remove(station);
    this.coffeeStations = this.coffeeStations.filter((s) => s !== station);
    this.spawnCoffee(idx);
    this.coffeeCount++;
    this.nearStation = null;
    this.ctx.overlays.hideHint();
    if (this.coffeeCount === 1) {
      this.ctx.quest.setObjective("Get two coffees — one more to go.");
    } else {
      this.phase = "to-sarah";
      this.jackNav.stop();
      this.ctx.quest.setObjective(
        "Take the coffees to Sarah in Lab Seven (head right →).",
      );
      this.ctx.overlays.showHint("Tap Sarah to deliver the coffee");
    }
  }

  private updateCoffeePrompt(): void {
    // Find the nearest uncollected cup within reach.
    let nearest: THREE.Object3D | null = null;
    let bestDist = Infinity;
    for (const station of this.coffeeStations) {
      const d = this.jack.position.distanceTo(station.position);
      if (d < this.pickupRadius && d < bestDist) {
        bestDist = d;
        nearest = station;
      }
    }

    if (nearest !== this.nearStation) {
      this.nearStation = nearest;
      this.ctx.overlays.showHint(
        nearest ? `${this.actionWord} the coffee cup` : this.walkHint,
      );
    }
  }

  private updateConsolePrompt(): void {
    // Approach point is just west of the desk (in the lane), since the desk now
    // sits to the east.
    const consoleFront = this.consoleDeskWorld
      .clone()
      .add(new THREE.Vector3(-6, 0, 0));
    const near = this.jack.position.distanceTo(consoleFront) < 7;
    if (near !== this.nearConsole) {
      this.nearConsole = near;
      this.ctx.overlays.showHint(
        near ? `${this.actionWord} the console to stabilise it` : "Tap the console to stabilise it",
      );
    }
  }

  private updateSarahPrompt(): void {
    const near = this.jack.position.distanceTo(this.sarah.position) < 7;
    if (near !== this.nearSarah) {
      this.nearSarah = near;
      this.ctx.overlays.showHint(
        near ? `${this.actionWord} Sarah to deliver the coffee` : "Tap Sarah to deliver the coffee",
      );
    }
  }

  private async triggerIntroDialogue(): Promise<void> {
    this.phase = "intro-dialogue";
    this.introOrbitStart = this.elapsed;
    this.cameraDirector.cut();
    this.ctx.input.setEnabled(false);
    this.ctx.overlays.hideHint();
    // Jack and Sarah turn to face each other for the exchange.
    this.faceTowards(this.jack, this.sarah.position);
    this.faceTowards(this.sarah, this.jack.position);
    // Jack hands Sarah one of the two coffees before they talk.
    await this.handCoffeeToSarah();
    if (this.disposed) return;
    await this.director.play(introSequence);
    if (this.disposed) return;
    this.ctx.input.setEnabled(true);
    this.phase = "to-console";
    this.ctx.quest.setObjective("Follow Sarah to the accelerator console.");
    this.ctx.overlays.showHint("Tap the console to stabilise it");
    // Sarah walks to the console, beside Jack on the west side of the desk.
    this.sarahNav.goTo(this.sarahConsoleSpot.clone());
  }

  private async triggerConsoleDialogue(): Promise<void> {
    this.phase = "console-dialogue";
    this.cameraDirector.cut();
    this.nearConsole = false;
    this.ctx.input.setEnabled(false);
    this.ctx.overlays.hideHint();
    this.faceTowards(this.jack, this.consoleDeskWorld);
    // Settle Sarah at her console spot (the snap is masked by the camera cut
    // above) so she's beside Jack at the desk for the beat instead of caught
    // mid-stride. (The console "reach" gesture is disabled for now — see
    // pickUpCoffee.)
    this.sarahNav.stop();
    this.sarah.position.copy(this.sarahConsoleSpot);
    this.faceTowards(this.sarah, this.consoleDeskWorld);
    // Both characters set their coffees down on the desk before working it.
    await this.setCoffeesOnConsole();
    if (this.disposed) return;
    this.ctx.overlays.showClock("11:46 PM");
    await this.director.play(consoleSequence);
    if (this.disposed) return;
    void this.activateAlarm();
  }

  /**
   * Console activation triggers the resonance cascade: warm lab lights give way
   * to pulsing red alarm lighting. Sarah breaks for the accelerator and the
   * objective becomes "Reach Sarah" — the vortex only forms once Jack reaches
   * her trigger zone.
   */
  private async activateAlarm(): Promise<void> {
    this.cascadeTimer = 0;
    this.alarmOn = true;
    this.ctx.audio.playSfx("alarm");
    // The calm lab bed crossfades into the suspense bed on the alarm beat.
    this.ctx.audio.playMusic("lab-suspense");
    this.ctx.overlays.showClock("11:47 PM", true);
    // Emergency lights were created up-front (see buildRedLights); the pulse in
    // update() ramps their intensity now that the cascade is active.
    // Sarah runs down the now-clear lane to the accelerator; the player follows.
    // The console sits to the east of the lane, so nothing needs to be dropped.
    this.sarahNav.goTo(this.reachSarahZone.clone());
    this.phase = "reach-sarah";
    // The alarm narration plays over the cascade with control withheld, then
    // the player gets the "Reach Sarah" objective.
    this.ctx.input.setEnabled(false);
    await this.director.play(alarmNarration);
    if (this.disposed) return;
    this.ctx.input.setEnabled(true);
    this.ctx.quest.setObjective("Reach Sarah!");
    this.ctx.overlays.showHint("Tap Sarah to reach her");
  }

  private async triggerVortex(): Promise<void> {
    this.phase = "vortex";
    this.ctx.input.setEnabled(false);
    this.ctx.overlays.hideHint();
    this.ctx.quest.clear();
    this.vortex.visible = true;
    this.ctx.audio.playSfx("vortex-open");
    // Grow the vortex.
    const grow = (target: number, ms: number) =>
      new Promise<void>((resolve) => {
        const start = performance.now();
        const from = this.vortex.scale.x;
        const tick = () => {
          const k = Math.min((performance.now() - start) / ms, 1);
          const s = from + (target - from) * k;
          this.vortex.scale.setScalar(s);
          if (k < 1) requestAnimationFrame(tick);
          else resolve();
        };
        tick();
      });
    // The wall-glow narration plays as the vortex grows, then the final
    // exchange before the pull-in.
    await Promise.all([grow(1, 1800), this.director.play(vortexNarration)]);
    if (this.disposed) return;

    await this.director.play(vortexDialogue);
    if (this.disposed) return;
    this.startCutscene();
  }

  private async startCutscene(): Promise<void> {
    this.phase = "cutscene";
    this.ctx.input.setEnabled(false);

    // Jack reaches toward Sarah; Sarah's free hand rests on her stomach
    // (the quiet pregnancy beat — preserved as staging, not stated outright).
    this.sarahNav.stop();
    this.faceTowards(this.jack, this.sarah.position);
    this.faceTowards(this.sarah, this.jack.position);

    // Tight two-shot for the climax, overriding the wide chase framing.
    this.setCameraMoment("climax", { cut: true });

    // Jack leans toward Sarah as the climax exchange plays.
    await Promise.all([
      this.tween(this.jack.position, new THREE.Vector3(18, 0, -30), 1400),
      this.director.play(climaxReach),
    ]);
    if (this.disposed) return;

    // Hold the tableau for the closing narration.
    await this.director.play(climaxEnd);
    if (this.disposed) return;

    // Pull both into the vortex.
    this.ctx.audio.playSfx("vortex-pull");
    await Promise.all([
      this.tween(this.jack.position, this.vortex.position.clone(), 1100),
      this.tween(this.sarah.position, this.vortex.position.clone(), 1100),
    ]);
    if (this.disposed) return;

    await this.ctx.overlays.whiteFlash();
    if (this.disposed) return;
    this.ctx.overlays.setBlackInstant(true);
    this.ctx.overlays.hideClock();
    await new Promise((r) => setTimeout(r, 1200));
    if (this.disposed) return;

    this.phase = "done";
    this.ctx.scenes.goTo(createChapterOneScene, false);
  }

  // ---------- Helpers ----------

  private faceTowards(obj: THREE.Object3D, target: THREE.Vector3): void {
    const dir = new THREE.Vector3().subVectors(target, obj.position);
    dir.y = 0;
    if (dir.lengthSq() > 0.0001) {
      obj.rotation.y = Math.atan2(dir.x, dir.z);
    }
  }

  private tween(
    vec: THREE.Vector3,
    to: THREE.Vector3,
    ms: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const from = vec.clone();
      const start = performance.now();
      const tick = () => {
        const k = Math.min((performance.now() - start) / ms, 1);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        vec.lerpVectors(from, to, e);
        if (k < 1) requestAnimationFrame(tick);
        else resolve();
      };
      tick();
    });
  }

  private settings: GameplaySettings = getSettings();
  private unsubSettings?: () => void;
  private gearEl?: HTMLButtonElement;

  /**
   * Push the current FOV preference onto the live gameplay camera, widened in
   * narrow portrait to match the dolly-back in framingScale() — a wider view
   * opens up around the subject instead of just rendering the same crop from
   * further away.
   */
  private applyFov(): void {
    this.camera.fov = this.settings.fov + portraitFovBoost(this.camera.aspect);
    this.camera.updateProjectionMatrix();
  }

  /** "Tap" on touch, "Click" with a mouse — used to phrase interaction hints. */
  private get actionWord(): string {
    return this.ctx.input.isTouch ? "Tap" : "Click";
  }

  /** Generic "nothing selected yet" hint, phrased for whichever input the player is using. */
  private get walkHint(): string {
    return this.ctx.input.isTouch
      ? "Tap the glowing objective to interact"
      : "Click the glowing objective to interact";
  }

  /**
   * Effective camera-distance multiplier applied to every camera offset:
   * the player's distance preference times the automatic per-viewport framing
   * (which dollies in on both narrow portrait and very wide landscape phones).
   */
  private framingScale(): number {
    // Higher zoom = closer, so divide the per-viewport framing offset by it.
    return autoFramingScale(this.camera.aspect, this.viewportHeight) / this.settings.zoom;
  }

  /**
   * Camera pull-back distance for a fixed-direction travel zone (one camera
   * angle used for both "walking toward the objective" and "arrived, framed
   * for the close interaction"), sized so both `a` and `b` actually land
   * inside the camera's FOV from that angle — a flat per-unit-of-separation
   * factor doesn't work here because the same separation projects to very
   * different screen-space spreads depending on how it's aligned with the
   * fixed viewing direction. Falls through to `base` once they're close
   * enough that the original tuned close-up framing already covers it.
   */
  private travelPullback(a: THREE.Vector3, b: THREE.Vector3, dir: THREE.Vector3, base: number, max: number): number {
    const viewDir = dir.clone().normalize().multiplyScalar(-1);
    const half = b.clone().sub(a).multiplyScalar(0.5);
    const depth = viewDir.clone().multiplyScalar(half.dot(viewDir));
    const perp = half.sub(depth).length() + 2; // +2: rough character half-width/bob margin
    const vFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const hFov = Math.atan(Math.tan(vFov) * this.camera.aspect);
    const required = (perp * 1.4) / Math.tan(Math.min(vFov, hFov));
    return THREE.MathUtils.clamp(required, base, max);
  }

  /** Mount the in-game gear button that opens the camera settings panel. */
  private buildSettingsButton(): void {
    const btn = document.createElement("button");
    btn.className = "be-gear";
    btn.type = "button";
    btn.setAttribute("aria-label", "Settings");
    btn.textContent = "\u2699";
    btn.addEventListener("click", () => {
      this.ctx.audio.playSfx("ui-select");
      // Freeze controls while the panel is open, then restore whatever state
      // they were in (a cutscene may have already disabled them).
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

  private updateCamera(snap = false): void {
    // Fixed-angle 2.5D camera: a constant world-space offset (no rotation with
    // Jack) so the view stays a stable three-quarter diorama as he moves.
    const desired = this.jack.position
      .clone()
      .add(this.camOffset.clone().multiplyScalar(this.framingScale()));
    if (snap) {
      this.camera.position.copy(desired);
    } else {
      this.camera.position.lerp(desired, 0.08);
    }
    const look = this.jack.position.clone();
    look.y += 2;
    this.camera.lookAt(look);
  }

  /**
   * Declares the cinematic camera moments for this scene, highest-priority
   * first: emergency/vortex chase, console work, the Sarah two-shot, the
   * coffee counter close-up, and the plain follow camera as the fallback.
   * CameraDirector picks whichever's isActive() and eases toward it — see
   * CameraDirector for why eased zone-switching beats each spot owning its
   * own lerp. Hard cuts (cameraDirector.cut()) are called explicitly right
   * before a phase enters dialogue or the closing cutscene.
   */
  private buildCameraZones(): void {
    const defaultLab: CameraZone<CameraZoneState> = {
      id: "default-lab",
      priority: 0,
      easeSpeed: 0.08,
      isActive: () => true,
      position: (s) => s.jack.clone().add(this.camOffset.clone().multiplyScalar(s.framingScale)),
      lookAt: (s) => {
        const l = s.jack.clone();
        l.y += 2;
        return l;
      },
    };

    const coffeeCounter: CameraZone<CameraZoneState> = {
      id: "coffee-counter",
      priority: 30,
      easeSpeed: 0.06,
      isActive: (s) => s.phase === "coffee" && s.jack.distanceTo(this.coffeeCounterWorld) < 13,
      // Raised and rotated across the counter so neither cup hides behind Jack
      // as he steps up. The framing slides laterally toward whichever cup he's
      // collecting next (index 0 sits left at x=-28 -> right hand; index 1 sits
      // right at x=-25 -> left hand), so the camera follows his reaching hand.
      position: (s) => {
        const cupX = s.coffeeIndex === 1 ? -25 : -28;
        const lateral = cupX - this.coffeeCounterWorld.x; // -2 for cup0, +1 for cup1
        return this.coffeeCounterWorld
          .clone()
          .add(
            new THREE.Vector3(-6 + lateral * 1.6, 11, 12).multiplyScalar(
              s.framingScale,
            ),
          );
      },
      lookAt: (s) => {
        // Aim at the active cup, dropped to counter height, with only a light
        // pull toward Jack so he stays framed without dragging the aim off it.
        const cupX = s.coffeeIndex === 1 ? -25 : -28;
        const l = new THREE.Vector3(cupX, 3.4, -8).lerp(s.jack, 0.25);
        l.y += 0.6;
        return l;
      },
    };

    // Active for the *entire* walk to the objective, not just once Jack is
    // already close, so the approach never falls through to defaultLab's plain
    // over-the-shoulder framing (which tracks only Jack and would drop Sarah).
    // Composition: Camera > Sarah > Jack — the camera sits beyond Sarah on the
    // side away from Jack, raised and skewed for a 3/4 angle, so Sarah fills the
    // foreground while Jack reads in the background and grows as he crosses the
    // cafeteria toward her.
    const sarahInteraction: CameraZone<CameraZoneState> = {
      id: "sarah-interaction",
      priority: 35,
      easeSpeed: 0.07,
      isActive: (s) => s.phase === "to-sarah" || s.phase === "intro-dialogue",
      position: (s) => {
        // Horizontal Jack -> Sarah direction; "beyond Sarah" continues past her
        // along it. Guard the degenerate case when Jack is right on top of her.
        const toSarah = s.sarah.clone().sub(s.jack);
        toSarah.y = 0;
        if (toSarah.lengthSq() < 1) toSarah.set(1, 0, 0);
        toSarah.normalize();
        // Perpendicular for a 3/4 skew so Sarah doesn't fully eclipse Jack.
        const lateral = new THREE.Vector3(-toSarah.z, 0, toSarah.x);
        // ~13u past Sarah keeps the camera well clear of the east wall (x=60;
        // console ~x=24); +11 up looks down over her shoulder toward Jack.
        const offset = toSarah
          .clone()
          .multiplyScalar(13)
          .add(lateral.multiplyScalar(6))
          .add(new THREE.Vector3(0, 11, 0));
        return s.sarah.clone().add(offset.multiplyScalar(s.framingScale));
      },
      lookAt: (s) => {
        // Center Sarah's upper body, nudged toward Jack so his approach stays
        // in frame in the background.
        const l = s.sarah.clone().lerp(s.jack, 0.18);
        l.y += 3;
        return l;
      },
    };

    // While Jack and Sarah talk over the coffee, slowly orbit the camera around
    // Sarah (the pivot) so the exchange plays against a moving view of the lab
    // instead of a locked two-shot. Outranks sarahInteraction so it owns the
    // dialogue beat; the walk up (to-sarah) still uses sarahInteraction. It
    // starts on the same bearing the two-shot held, so the hard cut into
    // dialogue lands on a familiar angle before the drift begins.
    const dialogueOrbit: CameraZone<CameraZoneState> = {
      id: "dialogue-orbit",
      priority: 45,
      easeSpeed: 0.05,
      isActive: (s) => s.phase === "intro-dialogue",
      position: (s) => {
        const t = Math.max(0, s.elapsed - this.introOrbitStart);
        const angle = Math.atan2(10, 16) + t * 0.1;
        const dist = 24 * s.framingScale;
        return new THREE.Vector3(
          s.sarah.x + Math.sin(angle) * dist,
          s.sarah.y + 10 * s.framingScale,
          s.sarah.z + Math.cos(angle) * dist,
        );
      },
      lookAt: (s) => {
        // Keep Sarah centered, pulled a touch toward Jack so he stays in frame.
        const l = s.sarah.clone().lerp(s.jack, 0.2);
        l.y += 3.5;
        return l;
      },
    };

    const console_: CameraZone<CameraZoneState> = {
      id: "console",
      priority: 40,
      easeSpeed: 0.06,
      isActive: (s) => s.phase === "to-console" || s.phase === "console-dialogue",
      position: (s) => {
        const dir = new THREE.Vector3(-18, 14, 18).normalize();
        const pull = this.travelPullback(s.jack, this.consoleDeskWorld, dir, 21, 60);
        // Bias toward Jack the further out he still is, so he stays in frame
        // alongside the desk instead of the shot holding fixed on the desk
        // alone for the whole approach.
        const anchor = this.consoleDeskWorld.clone().lerp(s.jack, 0.3);
        return anchor.add(dir.multiplyScalar(pull * s.framingScale));
      },
      lookAt: (s) => {
        // Frame the desk and the accelerator ring together — but ease toward
        // Jack's own position while he's still far out so he isn't looking
        // at empty space off-frame.
        const ringWorld = this.console.position.clone().add(new THREE.Vector3(0, 11, -14));
        const deskFocus = this.consoleDeskWorld.clone().lerp(ringWorld, 0.4);
        const sep = s.jack.distanceTo(this.consoleDeskWorld);
        const t = THREE.MathUtils.clamp(1 - sep / 40, 0, 1);
        const l = s.jack.clone().lerp(deskFocus, t);
        l.y += 2;
        return l;
      },
    };

    // Top-priority scripted framing: active only while a cutscene has set a
    // named moment (see setCameraMoment), so it overrides every gameplay zone.
    const scripted: CameraZone<CameraZoneState> = {
      id: "scripted",
      priority: 100,
      easeSpeed: 0.06,
      isActive: () => this.scriptedCameraMoment !== null,
      position: (s) =>
        this.cameraMoment(this.scriptedCameraMoment ?? "", s)?.position ??
        s.jack.clone().add(this.camOffset.clone().multiplyScalar(s.framingScale)),
      lookAt: (s) => {
        const m = this.cameraMoment(this.scriptedCameraMoment ?? "", s);
        if (m) return m.lookAt;
        const l = s.jack.clone();
        l.y += 2;
        return l;
      },
    };

    const emergencyVortex: CameraZone<CameraZoneState> = {
      id: "emergency-vortex",
      priority: 50,
      easeSpeed: 0.045,
      isActive: (s) => s.phase === "reach-sarah" || s.phase === "vortex" || s.phase === "cutscene",
      position: (s) => {
        if (s.phase === "reach-sarah") {
          // Pull wider during the chase so the player can see where to run.
          return s.jack
            .clone()
            .lerp(this.vortex.position, 0.25)
            .add(new THREE.Vector3(0, 20, 26).multiplyScalar(s.framingScale));
        }
        return this.vortex.position.clone().add(new THREE.Vector3(0, 6, 26).multiplyScalar(s.framingScale));
      },
      lookAt: (s) => {
        const l = s.jack.clone().lerp(this.vortex.position, 0.5);
        l.y += s.phase === "reach-sarah" ? 5 : 4;
        return l;
      },
    };

    for (const zone of [scripted, emergencyVortex, console_, dialogueOrbit, sarahInteraction, coffeeCounter, defaultLab]) {
      this.cameraDirector.addZone(zone);
    }
  }

  // ---------- Story Focus highlights ----------

  /**
   * Registers a Story Focus highlight for a tappable object, shown only
   * while `isRelevant()` holds — e.g. only during the phase that object's
   * tap actually does something.
   */
  private addHighlight(
    target: THREE.Object3D,
    opts: ObjectiveHighlightOptions,
    isRelevant: () => boolean,
    dynamicOpts?: () => ObjectiveHighlightOptions,
  ): void {
    const highlight = new ObjectiveHighlight(this.scene, target, opts);
    this.highlights.set(target, { highlight, isRelevant, dynamicOpts });
  }

  /** Permanently retires a highlight once its object has been acted on. */
  private dismissHighlight(target: THREE.Object3D): void {
    const tracked = this.highlights.get(target);
    if (!tracked) return;
    tracked.highlight.dispose();
    this.highlights.delete(target);
    if (this.selectedHighlightTarget === target) this.selectedHighlightTarget = null;
  }

  /** Drives every live highlight's pulse/visibility/icon for this frame. */
  private updateHighlights(dt: number): void {
    for (const [target, tracked] of this.highlights) {
      const relevant = tracked.isRelevant();
      tracked.highlight.setVisible(relevant && this.selectedHighlightTarget !== target);
      if (relevant && tracked.dynamicOpts) {
        const o = tracked.dynamicOpts();
        tracked.highlight.setIcon(o.icon, o.color);
      }
      tracked.highlight.update(dt);
    }
  }

  // ---------- Update loop ----------

  update(dt: number, elapsed: number): void {
    for (const m of this.mixers) m.update(dt);

    this.vortexUniforms.uTime.value = elapsed;
    this.vortex.rotation.z += dt * 0.6;
    this.elapsed = elapsed;

    // Opening "establishing" push-in: capture the first active frame as the
    // dolly's start (see cameraMoment), and let the accelerator ring's glow
    // grow slightly brighter as the camera approaches. Skipped once the alarm
    // owns the ring (it recolors it red below).
    if (this.scriptedCameraMoment === "establishing") {
      if (this.openingPushStartElapsed === null) this.openingPushStartElapsed = elapsed;
      const ring = (this.console.userData as { ring?: THREE.Mesh }).ring;
      if (ring && !this.alarmOn) {
        const m = ring.material as THREE.MeshStandardMaterial;
        m.emissiveIntensity = 0.5 + this.openingPushProgress(elapsed) * 0.35;
      }
    }

    // The Lab Prologue is guided: Jack never moves except auto-walking to a
    // tapped story objective (see handleClick/Navigator). No WASD, no
    // tap-anywhere — full manual control comes later, once the story leaves
    // the lab.
    const jackMoving = this.jackNav.update(dt);
    this.applyLocomotion(this.jack, jackMoving, dt);

    // Proximity hints: the actual pickup/delivery/console action happens by
    // tapping the object itself (see tryInteract(), called from handleClick()).
    if (this.phase === "coffee") {
      this.updateCoffeePrompt();
    } else if (this.phase === "to-console") {
      this.updateConsolePrompt();
    } else if (this.phase === "to-sarah") {
      this.updateSarahPrompt();
    }

    // Sarah's scripted moves (to the console, to the accelerator) share the
    // same Navigator Jack's tap-to-walk uses.
    const sarahMoving = this.sarahNav.update(dt);
    this.applyLocomotion(this.sarah, sarahMoving, dt);
    // Keep Jack and Sarah from standing inside one another — split the push
    // evenly so neither character's deliberate movement "wins" outright.
    this.resolveCharacterOverlap();

    // Alarm pulse: once the cascade is active, the red emergency lights pulse
    // and the warm ambient drains. Runs through the reach-sarah and vortex beats.
    if (this.alarmOn) {
      this.cascadeTimer += dt;
      const pulse = (Math.sin(elapsed * 8) * 0.5 + 0.5) * 6;
      for (const rl of this.redLights) rl.intensity = pulse;
      this.ambient.intensity = 1.65 - Math.min(this.cascadeTimer / 4, 1.0) * 1.45;
      // Console ring glows hot.
      const ring = (this.console.userData as { ring?: THREE.Mesh }).ring;
      if (ring) {
        const m = ring.material as THREE.MeshStandardMaterial;
        m.emissive.setHex(0xff3322);
        m.emissiveIntensity = 0.5 + pulse * 0.2;
      }
    }

    // Camera: hand off to the cinematic director, which picks the most
    // specific zone that applies right now (see buildCameraZones) and falls
    // back to the plain follow camera otherwise.
    this.cameraDirector.update(
      {
        phase: this.phase,
        jack: this.jack.position,
        sarah: this.sarah.position,
        framingScale: this.framingScale(),
        elapsed,
        coffeeIndex: this.coffeeCount,
      },
      dt,
    );

    this.updateHighlights(dt);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.viewportHeight = height;
    this.applyFov();
  }

  dispose(): void {
    this.disposed = true;
    this.director?.cancel();
    this.ctx.audio.stopVoice();
    this.ctx.dialogue.hideSubtitle();
    // Settle any in-flight gesture promises: the mixer 'finished' event won't
    // fire after teardown, so resolve them here to free the awaiting handlers.
    this.pendingGestureResolvers.forEach((resolve) => resolve());
    this.pendingGestureResolvers.clear();
    for (const m of this.mixers) m.stopAllAction();
    this.mixers = [];
    this.unsubClick?.();
    this.unsubSettings?.();
    closeSettingsPanel();
    this.gearEl?.remove();
    this.gripTunerEl?.remove();
    this.unbindTunerGesture?.();
    this.ctx.overlays.hideClock();
    this.ctx.input.setEnabled(true);
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

export const createPrologueScene: SceneFactory = (ctx) =>
  new PrologueCafeteriaScene(ctx);
