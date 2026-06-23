import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { CameraManager } from "../engine/CameraManager";
import { createPrologueScene } from "./PrologueCafeteriaScene";
import { openSettingsPanel, closeSettingsPanel } from "../engine/SettingsPanel";

/**
 * Cinematic title screen: a warm, hopeful prehistoric vista — an island rising
 * from a sunlit, animated ocean with pterosaurs tracing figure-eights overhead
 * and a slowly drifting camera.
 */
class MainMenuScene implements IScene {
  readonly name = "main-menu";
  readonly scene = new THREE.Scene();
  private cam: CameraManager;
  get camera(): THREE.Camera {
    return this.cam.camera;
  }

  private ocean!: THREE.Mesh;
  private oceanUniforms!: { uTime: { value: number } };
  private pterosaurs: THREE.Group[] = [];
  private menuEl?: HTMLDivElement;

  constructor(private ctx: SceneContext) {
    this.cam = new CameraManager(50, 0.1, 3000);
  }

  enter(): void {
    const scene = this.scene;
    scene.background = new THREE.Color(0xbfe0f0);
    scene.fog = new THREE.Fog(0xcfe6f2, 120, 900);

    this.ctx.audio.playMusic("main-theme");

    // ---- Lighting: warm golden-hour key + soft sky fill ----
    const hemi = new THREE.HemisphereLight(0xdff1ff, 0x4a6a55, 0.9);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe7c2, 2.1);
    sun.position.set(-180, 160, 120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.far = 800;
    scene.add(sun);

    // ---- Animated ocean ----
    this.oceanUniforms = { uTime: { value: 0 } };
    const oceanGeo = new THREE.PlaneGeometry(4000, 4000, 220, 220);
    const oceanMat = new THREE.MeshStandardMaterial({
      color: 0x2f7fa8,
      roughness: 0.35,
      metalness: 0.1,
    });
    oceanMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.oceanUniforms.uTime;
      shader.vertexShader =
        `uniform float uTime;\n` +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `vec3 transformed = vec3(position);
           float w = sin(position.x * 0.015 + uTime * 0.9) * 2.2
                   + cos(position.y * 0.021 + uTime * 0.7) * 1.8
                   + sin((position.x + position.y) * 0.008 + uTime * 0.4) * 3.0;
           transformed.z += w;`,
        );
    };
    this.ocean = new THREE.Mesh(oceanGeo, oceanMat);
    this.ocean.rotation.x = -Math.PI / 2;
    this.ocean.position.y = -6;
    this.ocean.receiveShadow = true;
    scene.add(this.ocean);

    // ---- Island ----
    scene.add(this.buildIsland());

    // ---- Pterosaurs flying figure-eights ----
    for (let i = 0; i < 5; i++) {
      const p = this.buildPterosaur();
      p.userData.phase = (i / 5) * Math.PI * 2;
      p.userData.scaleR = 70 + i * 14;
      p.userData.height = 60 + i * 10;
      p.userData.speed = 0.18 + i * 0.02;
      this.pterosaurs.push(p);
      scene.add(p);
    }

    // ---- Camera ----
    this.cam.place({ x: 0, y: 38, z: 210 }, { x: 0, y: 24, z: 0 });
    this.cam.setDrift(2.2, 0.12);

    this.buildMenu();
  }

  private buildIsland(): THREE.Group {
    const g = new THREE.Group();

    // Base landmass
    const landMat = new THREE.MeshStandardMaterial({
      color: 0x6f8a4e,
      roughness: 0.95,
    });
    const sandMat = new THREE.MeshStandardMaterial({
      color: 0xd9c79a,
      roughness: 1,
    });

    const beach = new THREE.Mesh(new THREE.CylinderGeometry(120, 150, 12, 48), sandMat);
    beach.position.y = -3;
    beach.receiveShadow = true;
    g.add(beach);

    const land = new THREE.Mesh(new THREE.CylinderGeometry(95, 120, 18, 48), landMat);
    land.position.y = 6;
    land.receiveShadow = true;
    land.castShadow = true;
    g.add(land);

    // Central mountain
    const mountain = new THREE.Mesh(
      new THREE.ConeGeometry(70, 130, 8),
      new THREE.MeshStandardMaterial({ color: 0x5b6e4a, roughness: 1, flatShading: true }),
    );
    mountain.position.y = 70;
    mountain.castShadow = true;
    g.add(mountain);

    // Snow cap
    const cap = new THREE.Mesh(
      new THREE.ConeGeometry(26, 34, 8),
      new THREE.MeshStandardMaterial({ color: 0xeef3f7, roughness: 0.8, flatShading: true }),
    );
    cap.position.y = 130;
    g.add(cap);

    // Scattered trees (palm-ish: trunk + canopy)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 28; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 55 + Math.random() * 45;
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.6, 14, 6), trunkMat);
      trunk.position.y = 7;
      trunk.castShadow = true;
      const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(7, 0), leafMat);
      canopy.position.y = 16;
      canopy.castShadow = true;
      tree.add(trunk, canopy);
      tree.position.set(Math.cos(a) * r, 13, Math.sin(a) * r);
      tree.scale.setScalar(0.8 + Math.random() * 0.8);
      g.add(tree);
    }

    return g;
  }

  private buildPterosaur(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a3b33, roughness: 0.8, flatShading: true });
    const body = new THREE.Mesh(new THREE.ConeGeometry(1.2, 8, 6), mat);
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const wingGeo = new THREE.PlaneGeometry(14, 4);
    const wingMat = new THREE.MeshStandardMaterial({
      color: 0x5a4438,
      roughness: 0.9,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    const left = new THREE.Mesh(wingGeo, wingMat);
    left.position.x = -7;
    const right = new THREE.Mesh(wingGeo, wingMat);
    right.position.x = 7;
    g.add(left, right);
    g.userData.wings = [left, right];
    g.scale.setScalar(1.4);
    return g;
  }

  private buildMenu(): void {
    const el = document.createElement("div");
    el.className = "be-menu";
    el.innerHTML = `
      <div class="be-menu__brand">
        <div class="be-menu__eyebrow">A Prehistoric Survival Adventure</div>
        <h1 class="be-menu__title">Beyond<span>Extinction</span></h1>
      </div>
      <div class="be-menu__buttons">
        <button class="be-btn" data-action="continue">Continue</button>
        <button class="be-btn be-btn--primary" data-action="new">New Game</button>
        <button class="be-btn" data-action="load">Load Game</button>
        <button class="be-btn" data-action="settings">Settings</button>
        <button class="be-btn" data-action="credits">Credits</button>
      </div>
      <div class="be-menu__footer">
        <span>Vertical Slice · Prologue</span>
        <span>Built with Three.js</span>
      </div>`;
    this.ctx.uiLayer.appendChild(el);
    this.menuEl = el;
    requestAnimationFrame(() => el.classList.add("show"));

    el.querySelector('[data-action="new"]')?.addEventListener("click", () => {
      this.ctx.audio.playSfx("ui-confirm");
      this.startNewGame();
    });

    for (const action of ["continue", "load"]) {
      el.querySelector(`[data-action="${action}"]`)?.addEventListener(
        "click",
        () => {
          this.ctx.audio.playSfx("ui-select");
          this.ctx.overlays.showToast(
            `${this.label(action)} — Coming Soon`,
          );
        },
      );
    }

    el.querySelector('[data-action="credits"]')?.addEventListener("click", () => {
      this.ctx.audio.playSfx("ui-select");
      this.showCredits();
    });

    el.querySelector('[data-action="settings"]')?.addEventListener("click", () => {
      this.ctx.audio.playSfx("ui-select");
      openSettingsPanel({ parent: this.ctx.uiLayer, audio: this.ctx.audio });
    });
  }

  private label(action: string): string {
    switch (action) {
      case "continue":
        return "Continue";
      case "load":
        return "Load Game";
      case "settings":
        return "Settings";
      default:
        return action;
    }
  }

  private creditsEl?: HTMLDivElement;

  private showCredits(): void {
    if (this.creditsEl) return;
    const el = document.createElement("div");
    el.className = "be-credits";
    el.innerHTML = `
      <div class="be-credits__panel">
        <h2>Beyond Extinction</h2>
        <p class="be-credits__role">A Prehistoric Survival Adventure</p>
        <div class="be-credits__roll">
          <p><span>Concept &amp; Story</span>CAPFlyingFun</p>
          <p><span>Engine &amp; Code</span>Built with Three.js + Vite</p>
          <p><span>Vertical Slice</span>Main Menu &amp; Prologue</p>
        </div>
        <button class="be-btn be-btn--primary" data-action="close">Close</button>
      </div>`;
    this.ctx.uiLayer.appendChild(el);
    this.creditsEl = el;
    requestAnimationFrame(() => el.classList.add("show"));
    const close = () => {
      this.ctx.audio.playSfx("ui-select");
      el.classList.remove("show");
      setTimeout(() => {
        el.remove();
        this.creditsEl = undefined;
      }, 300);
    };
    el.querySelector('[data-action="close"]')?.addEventListener("click", close);
    el.addEventListener("click", (e) => {
      if (e.target === el) close();
    });
  }

  private async startNewGame(): Promise<void> {
    this.menuEl?.classList.remove("show");
    await new Promise((r) => setTimeout(r, 600));
    this.ctx.scenes.goTo(createPrologueScene);
  }

  update(_dt: number, elapsed: number): void {
    this.oceanUniforms.uTime.value = elapsed;
    this.cam.update(_dt, elapsed);

    for (const p of this.pterosaurs) {
      const t = elapsed * p.userData.speed + p.userData.phase;
      // Lemniscate (figure-eight) path.
      const r = p.userData.scaleR;
      const denom = 1 + Math.sin(t) * Math.sin(t);
      const x = (r * Math.cos(t)) / denom;
      const z = (r * Math.sin(t) * Math.cos(t)) / denom;
      p.position.set(x, p.userData.height + Math.sin(t * 2) * 4, z);
      // Face direction of travel.
      const nx = (r * Math.cos(t + 0.01)) / (1 + Math.sin(t + 0.01) ** 2);
      const nz = (r * Math.sin(t + 0.01) * Math.cos(t + 0.01)) / (1 + Math.sin(t + 0.01) ** 2);
      p.lookAt(nx, p.position.y, nz);
      // Wing flap.
      const flap = Math.sin(elapsed * 6 + p.userData.phase) * 0.5;
      const [lw, rw] = p.userData.wings as THREE.Mesh[];
      lw.rotation.z = flap;
      rw.rotation.z = -flap;
    }
  }

  resize(width: number, height: number): void {
    this.cam.resize(width, height);
  }

  dispose(): void {
    closeSettingsPanel();
    this.menuEl?.remove();
    this.creditsEl?.remove();
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

export const createMainMenuScene: SceneFactory = (ctx) => new MainMenuScene(ctx);
