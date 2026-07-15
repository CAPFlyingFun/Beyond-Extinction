import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { PlayerController } from "../engine/PlayerController";
import { KauaiTileStreamer, type KauaiManifest } from "../engine/KauaiTileStreamer";
import { assetUrl } from "../engine/assets";

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

class KauaiStreamScene implements IScene {
  readonly name = "kauai-stream";
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly ctx: SceneContext;
  private streamer?: KauaiTileStreamer;
  private player?: PlayerController;
  private water?: THREE.Mesh;
  private hud?: HTMLDivElement;
  private grounded = false;

  constructor(ctx: SceneContext) {
    this.ctx = ctx;
    const aspect = ctx.renderer.width / ctx.renderer.height;
    this.camera = new THREE.PerspectiveCamera(62, aspect, 1, 22000);
    this.camera.position.set(SPAWN.x, EYE, SPAWN.z);
  }

  async enter(): Promise<void> {
    this.scene.background = SKY;
    this.scene.fog = new THREE.Fog(SKY.getHex(), 2500, 11000);

    this.scene.add(new THREE.HemisphereLight(0xe6f2ff, 0x6b7550, 1.25));
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.5);
    sun.position.copy(SUN).multiplyScalar(1000);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.18)); // lift deep-shadow slopes

    // Ocean plane at sea level, follows the camera in XZ.
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(80000, 80000),
      new THREE.MeshStandardMaterial({
        color: 0x1c5a76,
        roughness: 0.35,
        metalness: 0.1,
        transparent: true,
        opacity: 0.86,
      }),
    );
    water.geometry.rotateX(-Math.PI / 2);
    water.position.set(SPAWN.x, 0, SPAWN.z);
    water.renderOrder = -1;
    this.scene.add(water);
    this.water = water;

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
      // Ride the terrain surface once the standing tile has decoded.
      if (s.tileReadyAt(x, z)) {
        this.camera.position.y = s.heightAt(x, z) + EYE;
        this.grounded = true;
      } else if (!this.grounded) {
        this.camera.position.y = EYE; // sit at sea level until first tile lands
      }
      if (this.water) {
        this.water.position.x = x;
        this.water.position.z = z;
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
    this.hud?.remove();
    this.scene.clear();
  }
}

export const createKauaiStreamScene: SceneFactory = (ctx) =>
  new KauaiStreamScene(ctx);
