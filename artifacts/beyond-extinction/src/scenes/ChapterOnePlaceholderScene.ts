import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { loadModel, loadTexture } from "../engine/assets";
import { createBillboard, updateBillboardsYAxis } from "../engine/Billboard";
import { Navigator } from "../engine/Navigator";
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
  private oceanUniforms!: { uTime: { value: number } };
  private dodo!: THREE.Group;
  private billboards: THREE.Mesh[] = [];

  private jack!: THREE.Group;
  private sarah!: THREE.Group;
  private jackNav!: Navigator;
  private mixers: THREE.AnimationMixer[] = [];
  private readonly clipLibrary = new ClipLibrary();

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
  private static readonly PLAY = { minX: -52, maxX: 52, minZ: -8, maxZ: 34 };

  constructor(private ctx: SceneContext) {
    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      3000,
    );
  }

  async enter(): Promise<void> {
    const scene = this.scene;
    // Unnaturally vivid, high-oxygen sky.
    scene.background = new THREE.Color(0x2f8ff5);
    scene.fog = new THREE.Fog(0x9fd2ff, 140, 700);

    this.ctx.audio.playMusic("beach-dawn");

    const hemi = new THREE.HemisphereLight(0xbfe4ff, 0xc8b78a, 1.0);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d6, 2.3);
    sun.position.set(120, 120, -60);
    sun.castShadow = true;
    scene.add(sun);

    // Beach sand.
    const sand = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe8d6a6, roughness: 1 }),
    );
    sand.rotation.x = -Math.PI / 2;
    sand.receiveShadow = true;
    scene.add(sand);

    // Ocean with a gently rolling vertex shader.
    this.oceanUniforms = { uTime: { value: 0 } };
    const oceanMat = new THREE.MeshStandardMaterial({
      color: 0x2c86b8,
      roughness: 0.3,
      metalness: 0.1,
    });
    oceanMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.oceanUniforms.uTime;
      shader.vertexShader =
        `uniform float uTime;\n` +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `vec3 transformed = vec3(position);
           transformed.z += sin(position.x*0.03 + uTime)*1.2 + cos(position.y*0.04 + uTime*0.8)*1.0;`,
        );
    };
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 600, 120, 90),
      oceanMat,
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.set(0, -0.5, -260);
    scene.add(ocean);

    await this.buildJungle();
    if (this.disposed) return;

    // Jack, just come to on the sand — standing dazed (no lying clip; tipping
    // him would snap upright when he first walks).
    this.jack = await this.buildCharacter("Jack", 0x3a78d0);
    if (this.disposed) return;
    this.jack.position.set(0, 0, 8);
    scene.add(this.jack);
    this.jackNav = new Navigator(this.jack, {
      speed: 16,
      arriveDistance: 0.6,
      resolveMove: (_cx, _cz, nx, nz) => this.clampToPlay(nx, nz),
    });

    // Sarah, washed up further down the beach — prone until Jack reaches her.
    this.sarah = await this.buildCharacter("Sarah", 0x36b27a);
    if (this.disposed) return;
    this.sarah.position.set(-26, 0, 2);
    this.sarah.rotation.y = Math.PI / 2;
    scene.add(this.sarah);
    this.setProne(this.sarah, true);

    // A curious dodo nearby.
    this.dodo = this.buildDodo();
    this.dodo.position.set(14, 0, 0);
    scene.add(this.dodo);

    // Driftwood scattered up the sand (the "gather" objective anchor).
    const driftwood = this.buildDriftwood();
    driftwood.position.set(22, 0, 14);
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
    });
    this.buildSettingsButton();

    this.unsubClick = this.ctx.input.onClick(() => this.handleClick());
    this.ctx.input.setEnabled(true);

    // The prologue hands off with the screen blacked out (its closing cut); lift
    // it so the beach is actually visible before the story plays.
    await this.ctx.overlays.fadeFromBlack(900);
    if (this.disposed) return;
    void this.runStory();
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
    const [backdrop, palm, jungleTree, vine, bush, fern, grass, rock, log] =
      await Promise.all([
        loadTexture("assets/billboards/billboard_jungle_background_layer_01.png"),
        loadTexture("assets/billboards/billboard_palm_tree_01.png"),
        loadTexture("assets/billboards/billboard_jungle_tree_01.png"),
        loadTexture("assets/billboards/billboard_vine_cluster_01.png"),
        loadTexture("assets/billboards/billboard_bush_01.png"),
        loadTexture("assets/billboards/billboard_fern_01.png"),
        loadTexture("assets/billboards/billboard_grass_clump_01.png"),
        loadTexture("assets/billboards/billboard_rock_01.png"),
        loadTexture("assets/billboards/billboard_fallen_log_01.png"),
      ]);
    if (this.disposed) return;
    const scene = this.scene;

    if (backdrop) {
      for (let i = -2; i <= 2; i++) {
        const b = createBillboard(backdrop, 70);
        b.position.set(i * 95, 0, 115 + Math.random() * 15);
        scene.add(b);
        this.billboards.push(b);
      }
    }

    const treeTextures = [palm, jungleTree].filter((t): t is THREE.Texture => !!t);
    if (treeTextures.length) {
      for (let i = 0; i < 16; i++) {
        const tex = treeTextures[i % treeTextures.length];
        const height = 16 + Math.random() * 8;
        const tree = createBillboard(tex, height);
        tree.position.set(-120 + i * 16 + Math.random() * 6, 0, 60 + Math.random() * 30);
        scene.add(tree);
        this.billboards.push(tree);
      }
    }

    if (vine) {
      for (let i = 0; i < 4; i++) {
        const v = createBillboard(vine, 8 + Math.random() * 4);
        v.position.set(-90 + i * 55 + Math.random() * 10, 6, 58 + Math.random() * 15);
        scene.add(v);
        this.billboards.push(v);
      }
    }

    const scatterTextures = [bush, fern, grass, rock].filter(
      (t): t is THREE.Texture => !!t,
    );
    if (scatterTextures.length) {
      for (let i = 0; i < 14; i++) {
        const tex = scatterTextures[i % scatterTextures.length];
        const height = 2.5 + Math.random() * 2.5;
        const s = createBillboard(tex, height);
        s.position.set(-60 + Math.random() * 120, 0, 18 + Math.random() * 28);
        scene.add(s);
        this.billboards.push(s);
      }
    }

    if (log) {
      for (let i = 0; i < 2; i++) {
        const l = createBillboard(log, 3);
        l.position.set(-30 + i * 60 + Math.random() * 10, 0, 40 + Math.random() * 10);
        scene.add(l);
        this.billboards.push(l);
      }
    }
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

  /** Tip a character onto their back (prone) and re-ground, or restore upright. */
  private setProne(group: THREE.Group, prone: boolean): void {
    const model = group.userData.model as THREE.Object3D | undefined;
    if (!model) return;
    model.rotation.z = prone ? Math.PI / 2 : 0;
    const grounded = new THREE.Box3().setFromObject(model);
    model.position.y -= grounded.min.y;
    if (prone) group.userData.proneY = model.position.y;
  }

  /** Ease a prone character up to standing (rotation + grounded height). */
  private wake(group: THREE.Group, ms: number): Promise<void> {
    const model = group.userData.model as THREE.Object3D | undefined;
    if (!model) return Promise.resolve();
    const fromRot = model.rotation.z;
    const fromY = model.position.y;
    const toY = (group.userData.standY as number) ?? 0;
    return new Promise<void>((resolve) => {
      const start = performance.now();
      const tick = () => {
        if (this.disposed) return resolve();
        const k = Math.min((performance.now() - start) / ms, 1);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        model.rotation.z = fromRot * (1 - e);
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

    const jackMoving = this.jackNav?.update(dt) ?? false;
    this.applyLocomotion(this.jack, jackMoving, dt);
    this.applyLocomotion(this.sarah, false, dt);
    for (const m of this.mixers) m.update(dt);

    this.cameraDirector?.update(this.cameraState(), dt);
    for (const h of this.highlights) h.update(dt);
    updateBillboardsYAxis(this.billboards, this.camera.position);

    if (this.dodo) {
      this.dodo.position.y = Math.abs(Math.sin(elapsed * 4)) * 0.3;
      this.dodo.position.x = this.dodo.userData.baseX + Math.sin(elapsed * 0.6) * 2;
      this.dodo.rotation.y = this.hissDone ? Math.PI : Math.sin(elapsed * 0.6) * 0.4;
    }
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
