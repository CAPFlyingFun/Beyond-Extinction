import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { PlayerController } from "../engine/PlayerController";
import { KauaiTileStreamer, type KauaiManifest } from "../engine/KauaiTileStreamer";
import { assetUrl, loadTexture } from "../engine/assets";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

/**
 * Kauaʻi streaming-terrain test scene. A fast first-person scout over the
 * full-scale 8×8 Kauaʻi tile grid, driving {@link KauaiTileStreamer} so tiles
 * load/cross-fade as you cross the map. Reached from the PIN-gated Dev menu
 * ("🗺️ Kauaʻi Stream"). Everything is in real metres; sea level = 0.
 *
 * Spawn: G5 / Wailua (east coast) — the locked-in Chapter-2 arrival. Ocean is
 * to the east (+X); you face inland (west) toward the interior + summit.
 */
const EYE = 1.7; // m
const SKY = new THREE.Color(0x8fbcd4);
const SUN = new THREE.Vector3(-0.55, 0.72, 0.42).normalize();

// Wailua beach in metres (grid centre origin). Nudged ~1.4 km inland from the
// waterline so the scout starts on land while G5 finishes decoding.
const SPAWN = { x: 20900, z: 1288, facing: 270 };
const WATER_SIZE = 80000; // ocean plane extent (m)
const WATER_REPEAT = 10000; // ripple normal repeats → ~8 m wavelength

/**
 * Ocean surface material: a translucent MeshStandard blue with an animated
 * ripple normal map (set by the scene) for moving wavelets + travelling sun
 * glints, plus a fresnel sky-reflection term so the surface reads as water from
 * any angle — the moving normals modulate the fresnel into a live shimmer. No
 * white foam yet (deferred).
 */
function makeOceanMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x14526e,
    roughness: 0.13,
    metalness: 0.22, // reflect the sky HDRI (scene.environment) off the ripples
    transparent: true,
    opacity: 0.82,
    envMapIntensity: 1.1,
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
  const sky = new THREE.Color(0x9fc6df).convertSRGBToLinear();
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSky = { value: sky };
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSky;")
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
        {
          float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += uSky * fres * 0.35; // subtle sheen atop the HDRI reflection
        }`,
      );
  };
  return mat;
}

class KauaiStreamScene implements IScene {
  readonly name = "kauai-stream";
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly ctx: SceneContext;
  private streamer?: KauaiTileStreamer;
  private player?: PlayerController;
  private water?: THREE.Mesh;
  private waterNormal?: THREE.Texture;
  private waterT = 0;
  private envMap?: THREE.Texture;
  private bgMap?: THREE.Texture;
  private hud?: HTMLDivElement;
  private grounded = false;

  constructor(ctx: SceneContext) {
    this.ctx = ctx;
    const aspect = ctx.renderer.width / ctx.renderer.height;
    this.camera = new THREE.PerspectiveCamera(62, aspect, 1, 22000);
    this.camera.position.set(SPAWN.x, EYE, SPAWN.z);
  }

  async enter(): Promise<void> {
    this.scene.background = SKY; // fallback until the HDRI background loads
    this.scene.fog = new THREE.Fog(SKY.getHex(), 2500, 12000);

    // Sky HDRI (ambientCG, CC0): EXR → PMREM environment for real sky
    // reflections + image-based light; the tonemapped JPG is the cheap visible
    // background. The env supplies most of the ambient, so keep the fill lights
    // low and let the sun handle direct light + shadows.
    this.scene.add(new THREE.HemisphereLight(0xe6f2ff, 0x6b7550, 0.35));
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.35);
    sun.position.copy(SUN).multiplyScalar(1000);
    this.scene.add(sun);
    this.loadSky();

    // Ocean plane at sea level, follows the camera in XZ. An animated ripple
    // normal map gives moving wavelets + travelling specular glints (no foam).
    const waterMat = makeOceanMaterial();
    const water = new THREE.Mesh(new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE), waterMat);
    water.geometry.rotateX(-Math.PI / 2);
    water.position.set(SPAWN.x, 0, SPAWN.z);
    water.renderOrder = -1;
    this.scene.add(water);
    this.water = water;
    void loadTexture("assets/textures/water_normal.png").then((tex) => {
      if (!tex) return;
      tex.colorSpace = THREE.NoColorSpace; // normal maps are linear data
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(WATER_REPEAT, WATER_REPEAT);
      waterMat.normalMap = tex;
      waterMat.needsUpdate = true;
      this.waterNormal = tex;
    });

    // Load the manifest and start streaming around the spawn.
    try {
      const res = await fetch(assetUrl("assets/terrain/kauai/manifest.json"));
      const manifest = (await res.json()) as KauaiManifest;
      this.streamer = new KauaiTileStreamer(this.scene, manifest, { radius: 1 });
      this.streamer.update(0, SPAWN.x, SPAWN.z); // kick the first ring
    } catch (e) {
      console.error("[kauai] manifest load failed", e);
    }

    // First-person scout controller (fast, so 7 km tiles are quick to cross).
    this.player = new PlayerController(this.camera, this.ctx.input, {
      eyeHeight: EYE,
      moveSpeed: 8, // 8 m/s jog
      runMultiplier: 25, // 200 m/s sprint — traverse a tile in ~35 s
      crouchMultiplier: 0.5,
      crawlMultiplier: 0.3,
      lookSensitivity: 0.0032,
    });
    this.player.placeAt(SPAWN.x, SPAWN.z, SPAWN.facing);
    this.player.setActive(true);

    this.buildHud();
  }

  /** Load the sky HDRI: EXR → PMREM environment, tonemapped JPG → background. */
  private loadSky(): void {
    const renderer = this.ctx.renderer.renderer;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    void new EXRLoader()
      .loadAsync(assetUrl("assets/hdri/daysky.exr"))
      .then((exr) => {
        exr.mapping = THREE.EquirectangularReflectionMapping;
        const env = pmrem.fromEquirectangular(exr).texture;
        this.scene.environment = env;
        this.envMap = env;
        exr.dispose();
        pmrem.dispose();
      })
      .catch((e) => console.error("[kauai] HDRI env load failed", e));
    void loadTexture("assets/hdri/daysky_bg.jpg").then((tex) => {
      if (!tex) return;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.background = tex;
      this.bgMap = tex;
    });
  }

  private buildHud(): void {
    const hud = document.createElement("div");
    hud.style.cssText =
      "position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:60;" +
      "padding:6px 12px;border-radius:9px;background:rgba(6,14,22,0.72);color:#dff;" +
      "font:600 12px/1.3 ui-monospace,Menlo,monospace;letter-spacing:.04em;" +
      "pointer-events:none;text-align:center;backdrop-filter:blur(6px);";
    hud.textContent = "loading terrain…";
    this.ctx.uiLayer.appendChild(hud);
    this.hud = hud;
  }

  update(dt: number): void {
    const p = this.player;
    const s = this.streamer;
    if (p) p.update(dt);
    if (s) {
      const x = this.camera.position.x;
      const z = this.camera.position.z;
      s.update(dt, x, z);
      // Ride the terrain surface once the standing tile has decoded; over
      // ocean, stay at the water surface (don't sink below sea level).
      if (s.tileReadyAt(x, z)) {
        this.camera.position.y = Math.max(s.heightAt(x, z), 0) + EYE;
        this.grounded = true;
      } else if (!this.grounded) {
        this.camera.position.y = EYE; // sit at sea level until first tile lands
      }
      if (this.water) {
        this.water.position.x = x;
        this.water.position.z = z;
        // World-lock the ripple UVs to (x,z) so they don't swim with the
        // camera-following plane, then scroll them for the wave motion.
        if (this.waterNormal) {
          this.waterT += dt;
          const uvpm = WATER_REPEAT / WATER_SIZE;
          this.waterNormal.offset.set(
            x * uvpm + this.waterT * 0.014,
            z * uvpm + this.waterT * 0.010,
          );
        }
      }
      if (this.hud) {
        const col = String.fromCharCode(65 + Math.min(7, Math.max(0, Math.round(x / 7000 + 3.5))));
        const row = Math.min(8, Math.max(1, Math.round(z / 7000 + 3.5) + 1));
        const elev = Math.round(s.heightAt(x, z));
        this.hud.textContent = s.tileReadyAt(x, z)
          ? `tile ${col}${row}  ·  ${elev} m  ·  resident ${s.resident}  ·  sprint = run`
          : "streaming…";
      }
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.player?.setActive(false);
    this.player?.dispose();
    this.streamer?.dispose();
    this.envMap?.dispose();
    this.bgMap?.dispose();
    this.hud?.remove();
    this.scene.clear();
  }
}

export const createKauaiStreamScene: SceneFactory = (ctx) =>
  new KauaiStreamScene(ctx);
