import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { loadModel } from "../engine/assets";
import {
  cafeteriaIntro,
  consoleBeat,
  vortexBeat,
} from "../data/dialogue";
import { createChapterOneScene } from "./ChapterOnePlaceholderScene";

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

  private jack!: THREE.Group;
  private sarah!: THREE.Group;
  private coffeeMachine!: THREE.Mesh;
  private console!: THREE.Group;
  private vortex!: THREE.Group;
  private vortexUniforms!: { uTime: { value: number } };
  private redLights: THREE.PointLight[] = [];
  private coffees: THREE.Mesh[] = [];

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
  private cascadeTimer = 0;
  private alarmOn = false;

  // Two physical coffee cups on the counter; collected by proximity + E.
  private coffeeStations: THREE.Object3D[] = [];
  private floor!: THREE.Mesh;
  private clickTarget: THREE.Vector3 | null = null;
  private ePrev = false;
  private nearStation: THREE.Object3D | null = null;
  private readonly pickupRadius = 6;
  private nearConsole = false;
  private reachSarahZone = new THREE.Vector3(20, 0, -36);
  private reachPromptShown = false;

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
    scene.background = new THREE.Color(0x0c1320);
    scene.fog = new THREE.Fog(0x0c1320, 30, 120);

    this.ctx.audio.playMusic("lab-ambient");

    // ---- Lab lighting (calm, clinical, slightly warm) ----
    this.ambient = new THREE.AmbientLight(0x35506b, 0.7);
    scene.add(this.ambient);
    const key = new THREE.DirectionalLight(0xdfe9ff, 1.1);
    key.position.set(20, 40, 20);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    this.mainLights.push(key);
    // Ceiling fill lights (cool clinical glow).
    for (let i = -2; i <= 2; i++) {
      const strip = new THREE.PointLight(0xcfe4ff, 12, 60, 2);
      strip.position.set(i * 12, 14, 0);
      scene.add(strip);
      this.mainLights.push(strip);
    }

    this.buildRoom();
    this.buildCoffeeMachine();
    this.buildConsole();
    this.buildVortex();

    // ---- Characters ----
    this.jack = await this.buildCharacter("Jack", 0x3a78d0);
    this.jack.position.set(-22, 0, 14);
    scene.add(this.jack);

    this.sarah = await this.buildCharacter("Sarah", 0x36b27a);
    this.sarah.position.set(20, 0, -18);
    this.sarah.rotation.y = Math.PI;
    scene.add(this.sarah);

    // Camera behind Jack.
    this.updateCamera(true);

    // Interaction.
    this.unsubClick = this.ctx.input.onClick(() => this.handleClick());

    this.phase = "coffee";
    this.ctx.quest.setObjective("Get two coffees from the counter.");
    this.ctx.overlays.showHint("WASD / Arrows or click to walk · E to interact");
  }

  // ---------- World building ----------

  private buildRoom(): void {
    const scene = this.scene;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0x1b2738, roughness: 0.7, metalness: 0.2 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.floor = floor;

    // Grid sheen lines on floor
    const grid = new THREE.GridHelper(120, 40, 0x2a3c55, 0x223046);
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    grid.position.y = 0.02;
    scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x202d40, roughness: 0.85 });
    const mkWall = (w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.6), wallMat);
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
    this.coffeeMachine = body;
    this.scene.add(g);

    // Two coffee cups on the counter — collected by walking up and pressing E.
    const cupPositions = [
      new THREE.Vector3(-28, 4.9, -8),
      new THREE.Vector3(-25, 4.9, -8),
    ];
    cupPositions.forEach((pos, i) => {
      const cup = this.makeCup();
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

  private spawnCoffee(index: number): void {
    const cup = this.makeCup();
    cup.scale.setScalar(0.8);
    this.coffees.push(cup as unknown as THREE.Mesh);
    // Float near Jack as "carried".
    this.jack.add(cup);
    cup.position.set(index === 0 ? -1 : 1, 4.4, 1.4);
  }

  private buildConsole(): void {
    const g = new THREE.Group();
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(12, 1, 4),
      new THREE.MeshStandardMaterial({ color: 0x2b3a52, roughness: 0.5, metalness: 0.4 }),
    );
    desk.position.set(0, 4, 0);
    desk.castShadow = true;
    g.add(desk);
    // Holographic screens
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
      screen.position.set(i * 4, 7, -0.5);
      screen.rotation.x = -0.18;
      g.add(screen);
    }
    // Accelerator ring behind the console
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
    g.add(shell);

    g.position.set(20, 9, -40);
    g.rotation.x = 0;
    g.visible = false;
    g.scale.setScalar(0.01);
    this.vortex = g;
    this.scene.add(g);
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
    group.userData.name = name;
    return group;
  }

  // ---------- Interaction & phases ----------

  private handleClick(): void {
    if (this.ctx.dialogue.isActive) return;
    // Click-to-move: only during free-roam phases, raycast onto the floor.
    if (
      this.phase !== "coffee" &&
      this.phase !== "to-sarah" &&
      this.phase !== "to-console" &&
      this.phase !== "reach-sarah"
    ) {
      return;
    }
    const hits = this.ctx.input.intersect(this.camera, [this.floor]);
    if (hits.length === 0) return;
    const p = hits[0].point.clone();
    p.x = THREE.MathUtils.clamp(p.x, -55, 55);
    p.z = THREE.MathUtils.clamp(p.z, -38, 40);
    p.y = 0;
    this.clickTarget = p;
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

  private updateCoffeePrompt(eEdge: boolean): void {
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
      if (nearest) {
        this.ctx.overlays.showHint("Press E to pick up");
      } else {
        this.ctx.overlays.showHint(
          "WASD / Arrows or click to walk · E to interact",
        );
      }
    }

    if (eEdge && this.nearStation) {
      this.pickUpCoffee(this.nearStation);
    }
  }

  private updateConsolePrompt(eEdge: boolean): void {
    const consoleFront = this.console.position
      .clone()
      .add(new THREE.Vector3(0, 0, 8));
    const near = this.jack.position.distanceTo(consoleFront) < 7;
    if (near !== this.nearConsole) {
      this.nearConsole = near;
      this.ctx.overlays.showHint(
        near ? "Press E to stabilise the accelerator" : "Walk to the console",
      );
    }
    if (eEdge && near) {
      this.triggerConsoleDialogue();
    }
  }

  private async triggerIntroDialogue(): Promise<void> {
    this.phase = "intro-dialogue";
    this.ctx.input.setEnabled(false);
    this.ctx.overlays.hideHint();
    // Jack faces Sarah.
    this.faceTowards(this.jack, this.sarah.position);
    await this.ctx.dialogue.play(cafeteriaIntro);
    if (this.disposed) return;
    this.ctx.input.setEnabled(true);
    this.phase = "to-console";
    this.ctx.quest.setObjective("Follow Sarah to the accelerator console.");
    this.ctx.overlays.showHint("Walk to the console");
    // Sarah walks to the console.
    this.sarahTarget = new THREE.Vector3(20, 0, -24);
  }

  private async triggerConsoleDialogue(): Promise<void> {
    this.phase = "console-dialogue";
    this.nearConsole = false;
    this.ctx.input.setEnabled(false);
    this.ctx.overlays.hideHint();
    this.faceTowards(this.jack, this.console.position);
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
    // Red emergency lights around the lab.
    for (let i = 0; i < 4; i++) {
      const rl = new THREE.PointLight(0xff2d22, 0, 80);
      rl.position.set(20 + (i % 2 ? 18 : -18), 16, -28 + (i < 2 ? 14 : -14));
      this.scene.add(rl);
      this.redLights.push(rl);
    }
    // Sarah runs to the accelerator; the player must reach her there.
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

  private updateCamera(snap = false): void {
    // Fixed-angle 2.5D camera: a constant world-space offset (no rotation with
    // Jack) so the view stays a stable three-quarter diorama as he moves.
    const desired = this.jack.position.clone().add(this.camOffset);
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
    this.vortexUniforms.uTime.value = elapsed;
    this.vortex.rotation.z += dt * 0.6;

    // Edge-detect the E key once per frame so one press = one interaction. The
    // on-screen action button latches its own edge so a quick tap is never lost.
    const eDown = this.ctx.input.isDown("KeyE");
    const eEdge = (eDown && !this.ePrev) || this.ctx.input.consumeActionPress();
    this.ePrev = eDown;

    // Player movement during free-roam phases.
    const freeRoam =
      this.phase === "coffee" ||
      this.phase === "to-sarah" ||
      this.phase === "to-console" ||
      this.phase === "reach-sarah";
    if (freeRoam) {
      const speed = 16;
      const mv = this.ctx.input.getMoveVector();
      if (mv.lengthSq() > 0) {
        // Keyboard movement cancels any pending click destination.
        this.clickTarget = null;
        this.jack.position.x += mv.x * speed * dt;
        this.jack.position.z += mv.y * speed * dt;
        this.jack.position.x = THREE.MathUtils.clamp(this.jack.position.x, -55, 55);
        this.jack.position.z = THREE.MathUtils.clamp(this.jack.position.z, -38, 40);
        this.jack.rotation.y = Math.atan2(mv.x, mv.y);
      } else if (this.clickTarget) {
        // Click-to-move: walk toward the clicked floor point.
        const to = new THREE.Vector3().subVectors(this.clickTarget, this.jack.position);
        to.y = 0;
        if (to.length() > 0.6) {
          to.normalize();
          this.jack.position.addScaledVector(to, speed * dt);
          this.jack.rotation.y = Math.atan2(to.x, to.z);
        } else {
          this.clickTarget = null;
        }
      }
    }

    // Coffee pickup: proximity prompt + E to collect.
    if (this.phase === "coffee") {
      this.updateCoffeePrompt(eEdge);
    } else if (this.phase === "to-console") {
      // Console: proximity prompt + explicit E to stabilise the accelerator.
      this.updateConsolePrompt(eEdge);
    }

    // Sarah walks to her target if set.
    if (this.sarahTarget) {
      const toT = new THREE.Vector3().subVectors(this.sarahTarget, this.sarah.position);
      toT.y = 0;
      if (toT.length() > 0.5) {
        toT.normalize();
        this.sarah.position.addScaledVector(toT, 10 * dt);
        this.sarah.rotation.y = Math.atan2(toT.x, toT.z);
      } else {
        this.sarahTarget = null;
      }
    }

    // Proximity trigger: meeting Sarah starts the intro exchange.
    if (this.phase === "to-sarah") {
      if (this.jack.position.distanceTo(this.sarah.position) < 7) {
        this.triggerIntroDialogue();
      }
    }

    // Alarm pulse: once the cascade is active, the red emergency lights pulse
    // and the warm ambient drains. Runs through the reach-sarah and vortex beats.
    if (this.alarmOn) {
      this.cascadeTimer += dt;
      const pulse = (Math.sin(elapsed * 8) * 0.5 + 0.5) * 6;
      for (const rl of this.redLights) rl.intensity = pulse;
      this.ambient.intensity = 0.7 - Math.min(this.cascadeTimer / 4, 0.5);
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
      const camPos = focus.clone().add(new THREE.Vector3(0, 6, 26));
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
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubClick?.();
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
