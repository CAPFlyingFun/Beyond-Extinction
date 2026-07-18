import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { KauaiTileStreamer, type KauaiManifest } from "../engine/KauaiTileStreamer";
import { KauaiHydro } from "../engine/KauaiHydro";
import { KauaiWaterSim } from "../engine/KauaiWaterSim";
import { KauaiCarve } from "../engine/KauaiCarve";
import { assetUrl, loadTexture } from "../engine/assets";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import {
  makeOceanMaterial,
  buildOceanGrid,
  WATER_Y,
} from "./KauaiStreamScene";

/**
 * Water R&D testbed — an isolated 3×3 tile patch around G5 (Wailua), all tiles
 * forced resident (no streaming), with a FREE-FLY camera so a good angle can be
 * found, screenshotted, and reproduced. The heavy shallow-water physics sim is
 * built and iterated HERE first, away from the 8×8 streaming map; once it looks
 * right and runs, it ports over.
 *
 * Reached with `?scene=waterlab` (dev only) or the Dev-menu shortcut. The scene
 * pins the streamer's 3×3 residency to the G5 centre no matter where the camera
 * roams, so the same nine tiles stay loaded the whole time.
 *
 * Free-fly camera state is (position, heading°, pitch°). The HUD prints those
 * live; `window.__waterlab.setCam(x,y,z,heading,pitch)` reproduces any framing
 * from a screenshot's numbers (headless verification + matching the user's
 * shots).
 */
const SKY = new THREE.Color(0x8fbcd4);
const SUN = new THREE.Vector3(-0.55, 0.72, 0.42).normalize();
// G5 / Wailua — the Chapter-2 coast. Pin the 3×3 residency to this tile centre.
const G5_CENTER = new THREE.Vector2((6 - 3.5) * 7000, (4 - 3.5) * 7000); // (17500, 3500)
// Start the fly camera over the Wailua river mouth, up a bit and looking inland.
const START = { x: 20600, y: 140, z: 1288, heading: 270, pitch: -18 };
const FLY_BASE_SPEED = 14; // m/s
const FLY_SPRINT = 5; // × while sprint held
const LOOK_SENS = 0.16; // deg per pixel dragged

interface FlyKeys {
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  sprint: boolean;
}

class WaterLabScene implements IScene {
  readonly name = "waterlab";
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly ctx: SceneContext;
  private streamer?: KauaiTileStreamer;
  private hydro?: KauaiHydro;
  private sim?: KauaiWaterSim;
  private simReady = false;
  private simSpunUp = false;
  private simOn = true; // pilot: show the shallow-water sim (hides the ribbon rivers)
  private simSubsteps = 40;
  private water?: THREE.Mesh;
  private waterT = 0;
  private envMap?: THREE.Texture;
  private bgMap?: THREE.Texture;
  private disposed = false;

  // Free-fly camera state.
  private camPos = new THREE.Vector3(START.x, START.y, START.z);
  private heading = START.heading; // compass degrees: 0=N(−Z), 90=E(+X)
  private pitch = START.pitch; // degrees, + looks up
  private keys: FlyKeys = {
    fwd: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    sprint: false,
  };
  private sprintToggle = false; // on-screen SPD button latches sprint

  // DOM (HUD + touch controls), appended to ctx.uiLayer.
  private ui?: HTMLDivElement;
  private hudText?: HTMLDivElement;
  private lookPointer: number | null = null;
  private lookLast = new THREE.Vector2();

  constructor(ctx: SceneContext) {
    this.ctx = ctx;
    this.camera = new THREE.PerspectiveCamera(
      62,
      ctx.renderer.width / ctx.renderer.height,
      0.1,
      30000,
    );
    this.applyCam();
  }

  async enter(): Promise<void> {
    this.scene.background = SKY;
    this.scene.fog = new THREE.Fog(0xbcc6cc, 6500, 17000);
    this.scene.add(new THREE.HemisphereLight(0xe6f2ff, 0x6b7550, 0.75));
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.35);
    sun.position.copy(SUN).multiplyScalar(1000);
    this.scene.add(sun);
    this.loadSky();

    // Ocean (reused verbatim from the main scene) — the "realistic water" target
    // look. Camera-centred radial grid with the sum-of-sines swell.
    const waterMat = makeOceanMaterial(true);
    const water = new THREE.Mesh(buildOceanGrid(56, 96, 3, 18000), waterMat);
    water.position.set(this.camPos.x, WATER_Y, this.camPos.z);
    water.frustumCulled = false;
    water.renderOrder = -1;
    this.scene.add(water);
    this.water = water;
    void loadTexture("assets/terrain/kauai/coast_mask.png").then((tex) => {
      if (!tex || this.disposed) return;
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.flipY = false;
      tex.needsUpdate = true;
      const uCoast = waterMat.userData.uCoast as { value: THREE.Texture };
      uCoast.value.dispose();
      uCoast.value = tex;
    });

    void KauaiCarve.prefetch();
    try {
      const res = await fetch(assetUrl("assets/terrain/kauai/manifest.json"));
      const manifest = (await res.json()) as KauaiManifest;
      // radius 2 = a 5×5 ring pinned to G5. We only care about the inner 3×3, but
      // KauaiHydro builds a tile's water only once its 4 orthogonal neighbours are
      // resident (the seam gate), so the 3×3 needs its surrounding ring loaded too
      // — otherwise the edge tiles stay dry (the "corner not filled").
      // `?raw=1` streams UNMODIFIED terrain so the sim must find the waterways on
      // its own (the diagnostic); default keeps the carve, which gives the coarse
      // 36 m mesh the channels it otherwise lacks, so the sim reads as real rivers.
      const raw = import.meta.env.DEV && new URLSearchParams(location.search).get("raw") === "1";
      this.streamer = new KauaiTileStreamer(this.scene, manifest, {
        radius: 2,
        applyHydroCarve: !raw,
      });
      this.streamer.update(0, G5_CENTER.x, G5_CENTER.y);
      this.hydro = new KauaiHydro(this.scene);
      // Virtual-pipes shallow-water pilot over a window spanning the Wailua
      // valley down to the coast (inland high → ocean drain in the east).
      this.sim = new KauaiWaterSim(this.scene, {
        centerX: 19800,
        centerZ: 1288,
        N: 256,
        cell: 10,
      });
      // Confine the sim to the REAL waterways so it can only fill the actual
      // rivers, never flood the island.
      void KauaiCarve.prefetch().then((doc) => {
        if (doc && this.sim) this.sim.setCorridor(doc.rivers);
      });
    } catch (e) {
      console.error("[waterlab] manifest load failed", e);
    }

    this.buildUI();
    this.exposeDevHook();
  }

  // ─── Free-fly camera ────────────────────────────────────────────────────────

  /** World-space forward unit vector from the current heading + pitch. */
  private forward(): THREE.Vector3 {
    const h = THREE.MathUtils.degToRad(this.heading);
    const p = THREE.MathUtils.degToRad(this.pitch);
    return new THREE.Vector3(
      Math.sin(h) * Math.cos(p),
      Math.sin(p),
      -Math.cos(h) * Math.cos(p),
    );
  }

  /** Push the fly state onto the actual camera. */
  private applyCam(): void {
    this.camera.position.copy(this.camPos);
    const target = this.camPos.clone().add(this.forward());
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
  }

  private stepFly(dt: number): void {
    const fwd = this.forward();
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const move = new THREE.Vector3();
    const k = this.keys;
    if (k.fwd) move.add(fwd);
    if (k.back) move.sub(fwd);
    if (k.right) move.add(right);
    if (k.left) move.sub(right);
    if (k.up) move.y += 1;
    if (k.down) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize();
      const sprint = k.sprint || this.sprintToggle;
      const speed = FLY_BASE_SPEED * (sprint ? FLY_SPRINT : 1);
      this.camPos.addScaledVector(move, speed * dt);
    }
    this.applyCam();
  }

  // ─── Per-frame ──────────────────────────────────────────────────────────────

  update(dt: number, _elapsed: number): void {
    this.stepFly(dt);
    // Keep the 3×3 pinned to G5 (NOT the camera) so the same tiles stay loaded.
    if (this.streamer) {
      this.streamer.update(dt, G5_CENTER.x, G5_CENTER.y);
      this.hydro?.update(dt, this.streamer);
      // Shallow-water pilot: sample the bed once resident, then step it. While
      // the sim is on, hide the ribbon rivers so we judge the sim alone.
      if (this.sim && !this.simReady) {
        this.simReady = this.sim.sampleTerrain(this.streamer);
      }
      if (this.sim && this.simReady && this.simOn) {
        if (!this.simSpunUp) {
          // One-time spin-up burst so the valleys visibly fill within a second
          // or two of the sim coming online, independent of frame rate.
          this.sim.update(600);
          this.simSpunUp = true;
        } else {
          this.sim.update(this.simSubsteps);
        }
      }
      if (this.hydro) this.hydro.group.visible = !this.simOn;
      if (this.sim) this.sim.group.visible = this.simOn && this.simReady;
    }
    // Ocean follows the camera; drive the swell clock.
    this.waterT += dt;
    if (this.water) {
      this.water.position.set(this.camPos.x, WATER_Y, this.camPos.z);
      const uTime = (this.water.material as THREE.Material).userData.uTime as
        | { value: number }
        | undefined;
      if (uTime) uTime.value = this.waterT;
    }
    this.refreshHud();
  }

  // ─── HUD + touch controls ─────────────────────────────────────────────────────

  private buildUI(): void {
    const ui = document.createElement("div");
    ui.style.cssText =
      "position:absolute;inset:0;pointer-events:none;font-family:ui-monospace,monospace;";
    this.ctx.uiLayer.appendChild(ui);
    this.ui = ui;

    // Live camera readout — the numbers to screenshot + reproduce.
    const hud = document.createElement("div");
    hud.style.cssText =
      "position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);left:50%;" +
      "transform:translateX(-50%);padding:6px 14px;border-radius:10px;" +
      "background:rgba(6,14,22,0.72);color:#dff;font-size:13px;letter-spacing:0.3px;" +
      "white-space:nowrap;";
    ui.appendChild(hud);
    this.hudText = hud;

    // Look: drag anywhere on the (transparent) look layer that isn't a button.
    const look = document.createElement("div");
    look.style.cssText = "position:absolute;inset:0;pointer-events:auto;touch-action:none;";
    ui.appendChild(look);
    look.addEventListener("pointerdown", (e) => {
      this.lookPointer = e.pointerId;
      this.lookLast.set(e.clientX, e.clientY);
      look.setPointerCapture(e.pointerId);
    });
    look.addEventListener("pointermove", (e) => {
      if (this.lookPointer !== e.pointerId) return;
      const dx = e.clientX - this.lookLast.x;
      const dy = e.clientY - this.lookLast.y;
      this.lookLast.set(e.clientX, e.clientY);
      this.heading = (this.heading + dx * LOOK_SENS + 360) % 360;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * LOOK_SENS, -89, 89);
    });
    const endLook = (e: PointerEvent): void => {
      if (this.lookPointer === e.pointerId) this.lookPointer = null;
    };
    look.addEventListener("pointerup", endLook);
    look.addEventListener("pointercancel", endLook);

    // Move pad (bottom-right) + vertical + speed. Press-and-hold each.
    const pad = document.createElement("div");
    pad.style.cssText =
      "position:absolute;right:calc(env(safe-area-inset-right,0px) + 14px);" +
      "bottom:calc(env(safe-area-inset-bottom,0px) + 18px);pointer-events:auto;" +
      "display:grid;grid-template-columns:repeat(3,52px);grid-auto-rows:52px;gap:6px;";
    ui.appendChild(pad);
    const hold = (label: string, col: number, row: number, on: () => void, off: () => void): void => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        `grid-column:${col};grid-row:${row};border:0;border-radius:12px;` +
        "background:rgba(6,14,22,0.66);color:#dff;font-size:18px;font-weight:600;" +
        "touch-action:none;user-select:none;";
      const press = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
        on();
        b.style.background = "rgba(40,120,150,0.85)";
      };
      const release = (): void => {
        off();
        b.style.background = "rgba(6,14,22,0.66)";
      };
      b.addEventListener("pointerdown", press);
      b.addEventListener("pointerup", release);
      b.addEventListener("pointerleave", release);
      b.addEventListener("pointercancel", release);
      pad.appendChild(b);
    };
    hold("▲", 2, 1, () => (this.keys.fwd = true), () => (this.keys.fwd = false));
    hold("◀", 1, 2, () => (this.keys.left = true), () => (this.keys.left = false));
    hold("▼", 2, 2, () => (this.keys.back = true), () => (this.keys.back = false));
    hold("▶", 3, 2, () => (this.keys.right = true), () => (this.keys.right = false));
    hold("⤒", 1, 1, () => (this.keys.up = true), () => (this.keys.up = false));
    hold("⤓", 3, 1, () => (this.keys.down = true), () => (this.keys.down = false));
    // Speed latch (tap).
    const spd = document.createElement("button");
    spd.textContent = "SPD";
    spd.style.cssText =
      "grid-column:2;grid-row:3;border:0;border-radius:12px;" +
      "background:rgba(6,14,22,0.66);color:#dff;font-size:13px;font-weight:700;touch-action:none;";
    spd.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.sprintToggle = !this.sprintToggle;
      spd.style.background = this.sprintToggle ? "rgba(80,190,120,0.85)" : "rgba(6,14,22,0.66)";
    });
    pad.appendChild(spd);

    // Keyboard (desktop / headless): WASD + QE + shift.
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    const down = e.type === "keydown";
    switch (e.code) {
      case "KeyW":
      case "ArrowUp":
        this.keys.fwd = down;
        break;
      case "KeyS":
      case "ArrowDown":
        this.keys.back = down;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.keys.left = down;
        break;
      case "KeyD":
      case "ArrowRight":
        this.keys.right = down;
        break;
      case "KeyE":
      case "Space":
        this.keys.up = down;
        break;
      case "KeyQ":
        this.keys.down = down;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.keys.sprint = down;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  private refreshHud(): void {
    if (!this.hudText) return;
    const p = this.camPos;
    this.hudText.textContent =
      `X ${p.x.toFixed(0)}  Y ${p.y.toFixed(0)}  Z ${p.z.toFixed(0)}` +
      `  ·  HDG ${this.heading.toFixed(0)}°  ·  PITCH ${this.pitch.toFixed(0)}°`;
  }

  /** Sky HDRI: EXR → PMREM environment; tonemapped JPG → background. */
  private loadSky(): void {
    const renderer = this.ctx.renderer.renderer;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    void new EXRLoader()
      .loadAsync(assetUrl("assets/hdri/daysky.exr"))
      .then((exr) => {
        if (this.disposed) return;
        exr.mapping = THREE.EquirectangularReflectionMapping;
        const env = pmrem.fromEquirectangular(exr).texture;
        this.scene.environment = env;
        this.envMap = env;
        exr.dispose();
        pmrem.dispose();
      })
      .catch((e) => console.error("[waterlab] HDRI env load failed", e));
    void loadTexture("assets/hdri/daysky_bg.jpg").then((tex) => {
      if (!tex || this.disposed) return;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.background = tex;
      this.bgMap = tex;
    });
  }

  /** Dev handle: reproduce any framing from a screenshot's HUD numbers. */
  private exposeDevHook(): void {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __waterlab?: unknown }).__waterlab = {
      scene: this.scene,
      camera: this.camera,
      streamer: () => this.streamer,
      hydro: () => this.hydro,
      getCam: () => ({
        x: this.camPos.x,
        y: this.camPos.y,
        z: this.camPos.z,
        heading: this.heading,
        pitch: this.pitch,
      }),
      setCam: (x: number, y: number, z: number, heading: number, pitch: number) => {
        this.camPos.set(x, y, z);
        this.heading = ((heading % 360) + 360) % 360;
        this.pitch = THREE.MathUtils.clamp(pitch, -89, 89);
        this.applyCam();
      },
      ready: () =>
        !!this.streamer &&
        this.streamer.loadState(G5_CENTER.x, G5_CENTER.y).ready ===
          this.streamer.loadState(G5_CENTER.x, G5_CENTER.y).total,
      // Shallow-water sim controls/diagnostics for the pilot.
      sim: () => this.sim,
      simReady: () => this.simReady,
      simStats: () => this.sim?.stats() ?? null,
      simRain: (on: boolean) => this.sim?.setRain(on),
      simReset: () => this.sim?.reset(),
      simToggle: (on?: boolean) => {
        this.simOn = on ?? !this.simOn;
        return this.simOn;
      },
      simSubsteps: (n: number) => {
        this.simSubsteps = Math.max(1, Math.min(200, n | 0));
        return this.simSubsteps;
      },
    };
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    this.ui?.remove();
    this.streamer?.dispose();
    this.hydro?.dispose();
    this.sim?.dispose();
    if (this.water) {
      this.water.geometry.dispose();
      (this.water.material as THREE.Material).dispose();
    }
    this.envMap?.dispose();
    this.bgMap?.dispose();
    this.scene.environment = null;
    if (import.meta.env.DEV) {
      delete (window as unknown as { __waterlab?: unknown }).__waterlab;
    }
  }
}

export const createWaterLabScene: SceneFactory = (ctx) => new WaterLabScene(ctx);
