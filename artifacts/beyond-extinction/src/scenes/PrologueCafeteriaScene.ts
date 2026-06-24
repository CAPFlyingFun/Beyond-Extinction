import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { loadModel } from "../engine/assets";
import {
  cafeteriaIntro,
  consoleBeat,
  vortexBeat,
} from "../data/dialogue";
import { createChapterOneScene } from "./ChapterOnePlaceholderScene";
import {
  getSettings,
  subscribeSettings,
  type GameplaySettings,
} from "../engine/Settings";
import { autoFramingScale, portraitFovBoost } from "../engine/cameraFraming";
import { openSettingsPanel, closeSettingsPanel } from "../engine/SettingsPanel";
import {
  createEquipmentPanelTexture,
  createFloorTexture,
  createHazardStripeTexture,
  createWallTexture,
  FLOOR_TEXTURE_WORLD_SIZE,
  WALL_TEXTURE_WORLD_SIZE,
} from "../engine/proceduralTextures";

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
  private mainLights: THREE.Light[] = [];

  private phase: Phase = "coffee";
  private coffeeCount = 0;
  private interactables: THREE.Object3D[] = [];
  private unsubClick?: () => void;
  private disposed = false;

  // Fixed 2.5D view: a high, angled camera that tracks Jack's position but
  // never rotates with him, giving a diorama / three-quarter look.
  private camOffset = new THREE.Vector3(0, 17, 22);
  // Every character GLB is normalized to this world height so the camera
  // framing is correct regardless of how a given model was exported.
  private static readonly CHARACTER_HEIGHT = 7.2;
  private cascadeTimer = 0;
  private alarmOn = false;

  // Two physical coffee cups on the counter; collected by proximity + E.
  private coffeeStations: THREE.Object3D[] = [];
  private floor!: THREE.Mesh;
  private clickTarget: THREE.Vector3 | null = null;
  private nearStation: THREE.Object3D | null = null;
  private readonly pickupRadius = 6;
  private nearConsole = false;
  private nearSarah = false;
  // True while a tap-to-confirm prompt is on screen — guards against stacking
  // a second prompt from another tap before the player answers the first.
  private confirmOpen = false;
  private reachSarahZone = new THREE.Vector3(20, 0, -36);
  private reachPromptShown = false;
  // The console desk sits to the EAST of the central accelerator lane (see
  // buildConsole), so Jack approaches and operates it here while the lane to
  // Sarah and the vortex stays clear.
  private consoleDeskWorld = new THREE.Vector3(30, 0, -28);

  // Solid props the player can't walk through, as world-space XZ boxes already
  // grown by the player's radius (see buildColliders).
  private colliders: Array<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }> = [];
  private static readonly PLAYER_RADIUS = 1.5;

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
    scene.background = new THREE.Color(0x223450);
    scene.fog = new THREE.Fog(0x223450, 45, 150);

    this.ctx.audio.playMusic("lab-ambient");

    // ---- Lab lighting (clinical, brightly lit — a real lab, not a cave) ----
    this.ambient = new THREE.AmbientLight(0x5a7aa0, 1.3);
    scene.add(this.ambient);
    const key = new THREE.DirectionalLight(0xdfe9ff, 1.7);
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
      emissiveIntensity: 1.2,
      roughness: 0.4,
    });
    const fixtureHousingMat = new THREE.MeshStandardMaterial({
      color: 0x2a3650,
      roughness: 0.6,
      metalness: 0.3,
    });
    for (let i = -2; i <= 2; i++) {
      const strip = new THREE.PointLight(0xcfe4ff, 22, 75, 2);
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

    this.sarah = await this.buildCharacter("Sarah", 0x36b27a);
    this.sarah.position.set(20, 0, -18);
    this.sarah.rotation.y = Math.PI;
    this.sarah.userData.kind = "sarah";
    scene.add(this.sarah);

    // Emergency lights exist from the start (dark) so the alarm never changes
    // the scene's light count mid-play, which would otherwise recompile every
    // material at the climax — a crash-prone moment on mobile (a fresh compile
    // while the GL context is momentarily lost, e.g. across an orientation
    // change, throws "createShader returned null").
    this.buildRedLights();

    // Camera behind Jack.
    this.updateCamera(true);

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
    this.ctx.quest.setObjective("Get two coffees from the counter.");
    this.ctx.overlays.showHint(this.walkHint);

    // Camera settings: apply persisted prefs, react to live slider changes, and
    // mount the in-game gear that opens the panel.
    this.applyFov();
    this.unsubSettings = subscribeSettings((s) => {
      this.settings = s;
      this.applyFov();
    });
    this.buildSettingsButton();
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

    // Two coffee cups on the counter — collected by walking up and pressing E.
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
  ): void {
    const gripWorld = this.gripPoint(hand, foreArm);
    this.scene.attach(cup);
    cup.position.copy(gripWorld);
    hand.attach(cup);
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
      this.attachCupToHand(cup, hand, this.foreArmBone(this.jack, side));
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
    this.scene.attach(cup);
    const hand = this.handBone(this.sarah, "right") ?? this.sarah;
    const foreArm = this.foreArmBone(this.sarah, "right");
    const gripWorld = this.gripPoint(hand, foreArm);
    await this.tween(cup.position, gripWorld, 600);
    if (this.disposed) return;
    hand.attach(cup);
    this.sarahCup = cup;
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
      const actions: {
        idle: THREE.AnimationAction;
        walk?: THREE.AnimationAction;
      } = { idle: idleAction };
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
   * A grip point in the palm, extrapolated past the wrist bone along the
   * forearm->hand axis. The rig has no finger bones, so this approximates
   * where a closed hand would actually hold an object: roughly 0.4x the
   * forearm length beyond the wrist, based on average hand-to-forearm
   * proportions. Falls back to the wrist position itself if there's no
   * forearm bone to derive a direction from.
   */
  private gripPoint(hand: THREE.Object3D, foreArm: THREE.Object3D | null): THREE.Vector3 {
    hand.updateMatrixWorld(true);
    const handWorld = new THREE.Vector3();
    hand.getWorldPosition(handWorld);
    if (!foreArm) return handWorld;
    foreArm.updateMatrixWorld(true);
    const foreArmWorld = new THREE.Vector3();
    foreArm.getWorldPosition(foreArmWorld);
    const direction = handWorld.clone().sub(foreArmWorld);
    if (direction.lengthSq() < 1e-8) return handWorld;
    direction.normalize();
    return handWorld.add(direction.multiplyScalar(0.15));
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
    const actions = group.userData.actions as
      | { idle: THREE.AnimationAction; walk?: THREE.AnimationAction }
      | undefined;
    if (!actions || !actions.walk) return;
    const target = moving ? 1 : 0;
    const k = 1 - Math.pow(0.0015, dt); // ~0.15s ease, frame-rate independent
    const blend = THREE.MathUtils.lerp(
      (group.userData.walkBlend as number) ?? 0,
      target,
      k,
    );
    group.userData.walkBlend = blend;
    actions.walk.setEffectiveWeight(blend);
    actions.idle.setEffectiveWeight(1 - blend);
  }

  // ---------- Interaction & phases ----------

  /** Tap/click targets worth raycasting against in the current phase. */
  private tapTargets(): THREE.Object3D[] {
    if (this.phase === "coffee") return this.coffeeStations;
    if (this.phase === "to-sarah") return [this.sarah];
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
  } {
    if (target.userData.kind === "console") {
      return {
        anchor: this.consoleDeskWorld.clone().add(new THREE.Vector3(-6, 0, 0)),
        radius: 7,
      };
    }
    if (target.userData.kind === "sarah") {
      return { anchor: target.position, radius: 7 };
    }
    return { anchor: target.position, radius: this.pickupRadius };
  }

  private handleClick(): void {
    if (this.ctx.dialogue.isActive || this.confirmOpen) return;
    // Click-to-move / tap-to-interact: only during free-roam phases.
    if (
      this.phase !== "coffee" &&
      this.phase !== "to-sarah" &&
      this.phase !== "to-console" &&
      this.phase !== "reach-sarah"
    ) {
      return;
    }

    const targets = this.tapTargets();
    if (targets.length > 0) {
      const hits = this.ctx.input.intersect(this.camera, targets);
      if (hits.length > 0) {
        const interactable = this.resolveInteractable(hits[0].object);
        if (interactable) {
          const { anchor, radius } = this.interactionRange(interactable);
          if (this.jack.position.distanceTo(anchor) <= radius) {
            this.tryInteract(interactable);
            return;
          }
          // Too far to act on it yet — walk toward where it was tapped.
          const p = hits[0].point.clone();
          p.x = THREE.MathUtils.clamp(p.x, -55, 55);
          p.z = THREE.MathUtils.clamp(p.z, -38, 40);
          p.y = 0;
          this.clickTarget = p;
          return;
        }
      }
    }

    const hits = this.ctx.input.intersect(this.camera, [this.floor]);
    if (hits.length === 0) return;
    const p = hits[0].point.clone();
    p.x = THREE.MathUtils.clamp(p.x, -55, 55);
    p.z = THREE.MathUtils.clamp(p.z, -38, 40);
    p.y = 0;
    this.clickTarget = p;
  }

  /** Opens a Yes/No prompt for a tapped, in-range object and acts on "Yes". */
  private async tryInteract(target: THREE.Object3D): Promise<void> {
    const kind = target.userData.kind as string | undefined;
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

    this.confirmOpen = true;
    this.ctx.input.setEnabled(false);
    const yes = await this.ctx.overlays.showConfirm(message);
    if (this.disposed) return;
    this.confirmOpen = false;
    this.ctx.input.setEnabled(true);
    if (yes) onYes();
  }

  private pickUpCoffee(station: THREE.Object3D): void {
    if (this.coffeeCount >= 2) return;
    const idx = (station.userData.index as number) ?? this.coffeeCount;
    this.ctx.audio.playSfx("coffee-pour");
    // Remove the cup from the counter and give Jack a carried one.
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
      this.clickTarget = null;
      this.ctx.quest.setObjective(
        "Take the coffees to Sarah in Lab Seven (head right →).",
      );
      this.ctx.overlays.showHint("Walk to Sarah");
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
        near ? `${this.actionWord} the console to stabilise it` : "Walk to the console",
      );
    }
  }

  private updateSarahPrompt(): void {
    const near = this.jack.position.distanceTo(this.sarah.position) < 7;
    if (near !== this.nearSarah) {
      this.nearSarah = near;
      this.ctx.overlays.showHint(
        near ? `${this.actionWord} Sarah to deliver the coffee` : "Walk to Sarah",
      );
    }
  }

  private async triggerIntroDialogue(): Promise<void> {
    this.phase = "intro-dialogue";
    this.ctx.input.setEnabled(false);
    this.ctx.overlays.hideHint();
    // Jack and Sarah turn to face each other for the exchange.
    this.faceTowards(this.jack, this.sarah.position);
    this.faceTowards(this.sarah, this.jack.position);
    // Jack hands Sarah one of the two coffees before they talk.
    await this.handCoffeeToSarah();
    if (this.disposed) return;
    await this.ctx.dialogue.play(cafeteriaIntro);
    if (this.disposed) return;
    this.ctx.input.setEnabled(true);
    this.phase = "to-console";
    this.ctx.quest.setObjective("Follow Sarah to the accelerator console.");
    this.ctx.overlays.showHint("Walk to the console");
    // Sarah walks to the console, beside Jack on the west side of the desk.
    this.sarahTarget = new THREE.Vector3(24, 0, -26);
  }

  private async triggerConsoleDialogue(): Promise<void> {
    this.phase = "console-dialogue";
    this.nearConsole = false;
    this.ctx.input.setEnabled(false);
    this.ctx.overlays.hideHint();
    this.faceTowards(this.jack, this.consoleDeskWorld);
    // Both characters set their coffees down on the desk before working it.
    await this.setCoffeesOnConsole();
    if (this.disposed) return;
    this.ctx.overlays.showClock("11:46 PM");
    await this.ctx.dialogue.play(consoleBeat);
    if (this.disposed) return;
    this.activateAlarm();
  }

  /**
   * Console activation triggers the resonance cascade: warm lab lights give way
   * to pulsing red alarm lighting. Sarah breaks for the accelerator and the
   * objective becomes "Reach Sarah" — the vortex only forms once Jack reaches
   * her trigger zone.
   */
  private activateAlarm(): void {
    this.cascadeTimer = 0;
    this.alarmOn = true;
    this.ctx.audio.playSfx("alarm");
    this.ctx.overlays.showClock("11:47 PM", true);
    // Emergency lights were created up-front (see buildRedLights); the pulse in
    // update() ramps their intensity now that the cascade is active.
    // Sarah runs down the now-clear lane to the accelerator; the player follows.
    // The console sits to the east of the lane, so nothing needs to be dropped.
    this.sarahTarget = this.reachSarahZone.clone();
    this.phase = "reach-sarah";
    this.reachPromptShown = false;
    this.ctx.input.setEnabled(true);
    this.ctx.quest.setObjective("Reach Sarah!");
    this.ctx.overlays.showHint("Get to Sarah at the accelerator");
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
    await grow(1, 1800);
    if (this.disposed) return;

    await this.ctx.dialogue.play(vortexBeat);
    if (this.disposed) return;
    this.startCutscene();
  }

  private async startCutscene(): Promise<void> {
    this.phase = "cutscene";
    this.ctx.input.setEnabled(false);

    // Jack reaches toward Sarah; Sarah's free hand rests on her stomach
    // (the quiet pregnancy beat — preserved as staging, not stated outright).
    this.sarahTarget = null;
    this.faceTowards(this.jack, this.sarah.position);
    this.faceTowards(this.sarah, this.jack.position);

    // Lean Jack toward Sarah.
    await this.tween(this.jack.position, new THREE.Vector3(18, 0, -30), 1400);
    if (this.disposed) return;

    await this.ctx.overlays.showCaption(
      "Her other hand pressed flat against her stomach.",
      2800,
    );
    if (this.disposed) return;

    // Pull both into the vortex.
    this.ctx.audio.playSfx("vortex-pull");
    await Promise.all([
      this.tween(this.jack.position, this.vortex.position.clone(), 1200),
      this.tween(this.sarah.position, this.vortex.position.clone(), 1200),
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

  private sarahTarget: THREE.Vector3 | null = null;

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

  /** Generic "nothing nearby" hint, phrased for whichever input the player is using. */
  private get walkHint(): string {
    return this.ctx.input.isTouch
      ? "Tap the floor to walk · tap an object to interact"
      : "WASD / Arrows or click to walk · click an object to interact";
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

  // ---------- Update loop ----------

  update(dt: number, elapsed: number): void {
    for (const m of this.mixers) m.update(dt);

    this.vortexUniforms.uTime.value = elapsed;
    this.vortex.rotation.z += dt * 0.6;

    // Player movement during free-roam phases.
    const freeRoam =
      this.phase === "coffee" ||
      this.phase === "to-sarah" ||
      this.phase === "to-console" ||
      this.phase === "reach-sarah";
    let jackMoving = false;
    if (freeRoam) {
      const speed = 16;
      const mv = this.ctx.input.getMoveVector();
      if (mv.lengthSq() > 0) {
        // Keyboard movement cancels any pending click destination.
        this.clickTarget = null;
        const nx = THREE.MathUtils.clamp(
          this.jack.position.x + mv.x * speed * dt,
          -55,
          55,
        );
        const nz = THREE.MathUtils.clamp(
          this.jack.position.z + mv.y * speed * dt,
          -38,
          40,
        );
        const r = this.resolveMove(
          this.jack.position.x,
          this.jack.position.z,
          nx,
          nz,
        );
        // Only animate the walk if a collider didn't fully cancel the step.
        jackMoving =
          Math.hypot(r.x - this.jack.position.x, r.z - this.jack.position.z) >
          1e-3;
        this.jack.position.x = r.x;
        this.jack.position.z = r.z;
        this.jack.rotation.y = Math.atan2(mv.x, mv.y);
      } else if (this.clickTarget) {
        // Click-to-move: walk toward the clicked floor point.
        const to = new THREE.Vector3().subVectors(this.clickTarget, this.jack.position);
        to.y = 0;
        if (to.length() > 0.6) {
          to.normalize();
          const step = speed * dt;
          const nx = THREE.MathUtils.clamp(
            this.jack.position.x + to.x * step,
            -55,
            55,
          );
          const nz = THREE.MathUtils.clamp(
            this.jack.position.z + to.z * step,
            -38,
            40,
          );
          const r = this.resolveMove(
            this.jack.position.x,
            this.jack.position.z,
            nx,
            nz,
          );
          const moved = Math.hypot(
            r.x - this.jack.position.x,
            r.z - this.jack.position.z,
          );
          this.jack.position.x = r.x;
          this.jack.position.z = r.z;
          this.jack.rotation.y = Math.atan2(to.x, to.z);
          jackMoving = moved > step * 0.05;
          // A prop fully blocks the straight path — abandon the click target
          // rather than grinding against it forever.
          if (moved < step * 0.05) this.clickTarget = null;
        } else {
          this.clickTarget = null;
        }
      }
    }
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

    // Sarah walks to her target if set.
    let sarahMoving = false;
    if (this.sarahTarget) {
      const toT = new THREE.Vector3().subVectors(this.sarahTarget, this.sarah.position);
      toT.y = 0;
      if (toT.length() > 0.5) {
        toT.normalize();
        this.sarah.position.addScaledVector(toT, 10 * dt);
        this.sarah.rotation.y = Math.atan2(toT.x, toT.z);
        sarahMoving = true;
      } else {
        this.sarahTarget = null;
      }
    }
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
      this.ambient.intensity = 1.3 - Math.min(this.cascadeTimer / 4, 1.0);
      // Console ring glows hot.
      const ring = (this.console.userData as { ring?: THREE.Mesh }).ring;
      if (ring) {
        const m = ring.material as THREE.MeshStandardMaterial;
        m.emissive.setHex(0xff3322);
        m.emissiveIntensity = 0.5 + pulse * 0.2;
      }
    }

    // Reach Sarah: vortex only forms once Jack reaches Sarah's trigger zone.
    if (this.phase === "reach-sarah") {
      if (this.jack.position.distanceTo(this.sarah.position) < 5) {
        this.triggerVortex();
      }
    }

    // Camera: follow Jack during play; during the climax, frame the vortex.
    if (
      this.phase === "vortex" ||
      this.phase === "cutscene"
    ) {
      const focus = this.vortex.position.clone();
      const camPos = focus
        .clone()
        .add(new THREE.Vector3(0, 6, 26).multiplyScalar(this.framingScale()));
      this.camera.position.lerp(camPos, 0.04);
      const mid = this.jack.position.clone().lerp(focus, 0.5);
      mid.y += 4;
      this.camera.lookAt(mid);
    } else {
      this.updateCamera();
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.viewportHeight = height;
    this.applyFov();
  }

  dispose(): void {
    this.disposed = true;
    for (const m of this.mixers) m.stopAllAction();
    this.mixers = [];
    this.unsubClick?.();
    this.unsubSettings?.();
    closeSettingsPanel();
    this.gearEl?.remove();
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
