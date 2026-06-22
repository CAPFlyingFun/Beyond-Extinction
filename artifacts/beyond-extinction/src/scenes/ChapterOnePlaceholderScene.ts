import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { CameraManager } from "../engine/CameraManager";

/**
 * Chapter One opening: Jack wakes on a sunlit beach beneath an impossibly blue,
 * oxygen-rich sky. A lone dodo waddles nearby — then something larger hisses
 * from the treeline. This is a placeholder vertical-slice ending: it sets the
 * tone and hands back to the menu.
 */
class ChapterOnePlaceholderScene implements IScene {
  readonly name = "chapter-one";
  readonly scene = new THREE.Scene();
  private cam: CameraManager;
  get camera(): THREE.Camera {
    return this.cam.camera;
  }

  private oceanUniforms!: { uTime: { value: number } };
  private ocean!: THREE.Mesh;
  private dodo!: THREE.Group;
  private hissDone = false;
  private startTime = 0;
  private disposed = false;

  constructor(private ctx: SceneContext) {
    this.cam = new CameraManager(52, 0.1, 3000);
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

    // Beach sand
    const sand = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe8d6a6, roughness: 1 }),
    );
    sand.rotation.x = -Math.PI / 2;
    sand.receiveShadow = true;
    scene.add(sand);

    // Ocean
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
    this.ocean = new THREE.Mesh(new THREE.PlaneGeometry(800, 600, 120, 90), oceanMat);
    this.ocean.rotation.x = -Math.PI / 2;
    this.ocean.position.set(0, -0.5, -260);
    scene.add(this.ocean);

    // Palms along the treeline
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f7a34, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 16; i++) {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.2, 12, 6), trunkMat);
      trunk.position.y = 6;
      trunk.castShadow = true;
      const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(4, 0), leafMat);
      canopy.position.y = 13;
      canopy.castShadow = true;
      tree.add(trunk, canopy);
      tree.position.set(-120 + i * 16 + Math.random() * 6, 0, 60 + Math.random() * 30);
      tree.scale.setScalar(0.9 + Math.random() * 0.6);
      scene.add(tree);
    }

    // Jack lying on the sand (placeholder capsule).
    const jack = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(1.1, 3.2, 6, 14),
      new THREE.MeshStandardMaterial({ color: 0x3a78d0, roughness: 0.6 }),
    );
    body.rotation.z = Math.PI / 2;
    body.position.y = 1.2;
    body.castShadow = true;
    jack.add(body);
    jack.position.set(0, 0, 6);
    scene.add(jack);

    // A curious dodo nearby.
    this.dodo = this.buildDodo();
    this.dodo.position.set(10, 0, 0);
    scene.add(this.dodo);

    // Camera: low, looking up the beach toward the dodo and treeline.
    this.cam.place({ x: -6, y: 6, z: 22 }, { x: 6, y: 2, z: 0 });
    this.cam.setDrift(1.2, 0.1);

    this.startTime = performance.now();
    this.runIntro();
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
    g.userData.baseX = 10;
    return g;
  }

  private async runIntro(): Promise<void> {
    await new Promise((r) => setTimeout(r, 1400));
    if (this.disposed) return;
    await this.ctx.overlays.showCaption("Chapter One", 2400);
    if (this.disposed) return;
    await this.ctx.overlays.showCaption(
      "The sky was the wrong shade of blue. Too bright. Too much air.",
      3400,
    );
    if (this.disposed) return;
    await this.ctx.dialogue.play([
      {
        speaker: "Jack",
        portrait: "assets/portraits/Jack.PNG",
        text: "Sand. Salt. Sun on my face. Sarah — where's Sarah?",
      },
      {
        speaker: "Jack",
        portrait: "assets/portraits/Jack.PNG",
        text: "And what... is that little bird? It's not afraid of me at all.",
      },
    ]);
    if (this.disposed) return;
    // The hiss from the treeline.
    this.hissDone = true;
    this.ctx.audio.playSfx("large-creature-hiss");
    await this.ctx.overlays.showCaption(
      "Something larger shifted in the trees. And hissed.",
      3200,
    );
    if (this.disposed) return;
    this.ctx.quest.setObjective(
      "To be continued — the vertical slice ends here.",
    );
    this.showEndCard();
  }

  private endCardEl?: HTMLDivElement;

  private showEndCard(): void {
    if (this.disposed || this.endCardEl) return;
    const el = document.createElement("div");
    el.className = "be-endcard";
    el.innerHTML = `
      <div class="be-endcard__panel">
        <div class="be-endcard__eyebrow">Chapter One</div>
        <h2 class="be-endcard__title">Coming Soon</h2>
        <p class="be-endcard__body">
          Jack's story on the beach continues in the next chapter.
          Thank you for playing the vertical slice.
        </p>
        <button class="be-btn be-btn--primary" data-action="menu">Return to Main Menu</button>
      </div>`;
    this.ctx.uiLayer.appendChild(el);
    this.endCardEl = el;
    requestAnimationFrame(() => el.classList.add("show"));
    el.querySelector('[data-action="menu"]')?.addEventListener("click", () => {
      this.ctx.audio.playSfx("ui-confirm");
      this.returnToMenu();
    });
  }

  private async returnToMenu(): Promise<void> {
    const { createMainMenuScene } = await import("./MainMenuScene");
    this.ctx.scenes.goTo(createMainMenuScene);
  }

  update(dt: number, elapsed: number): void {
    this.oceanUniforms.uTime.value = elapsed;
    this.cam.update(dt, elapsed);
    // Dodo bobs and waddles.
    if (this.dodo) {
      this.dodo.position.y = Math.abs(Math.sin(elapsed * 4)) * 0.3;
      this.dodo.position.x =
        this.dodo.userData.baseX + Math.sin(elapsed * 0.6) * 2;
      this.dodo.rotation.y = Math.sin(elapsed * 0.6) * 0.4;
      // When the hiss happens, the dodo startles and freezes.
      if (this.hissDone) {
        this.dodo.rotation.y = Math.PI;
      }
    }
  }

  resize(width: number, height: number): void {
    this.cam.resize(width, height);
  }

  dispose(): void {
    this.disposed = true;
    this.endCardEl?.remove();
    this.ctx.overlays.setBlackInstant(false);
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
