import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { PlayerController } from "../engine/PlayerController";
import { KauaiTileStreamer, type KauaiManifest } from "../engine/KauaiTileStreamer";
import { KauaiHydro } from "../engine/KauaiHydro";
import { KauaiTrees } from "../engine/KauaiTrees";
import { IslandCharacter } from "../engine/IslandCharacter";
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
const EYE = 1.8; // m — beach/Godot first-person eye height
const CAM_FWD = 0.10; // eye ahead of the head (smaller = closer to the head)
const SKY = new THREE.Color(0x8fbcd4);
const SUN = new THREE.Vector3(-0.55, 0.72, 0.42).normalize();

// Player vertical physics.
const GRAVITY = 22; // m/s² (snappy game gravity)
const JUMP_V = 7.5; // m/s → ~1.3 m jump apex
const WATER_ENTER = 0.35; // water at least this deep starts to slow you
const SWIM_DEPTH = 1.3; // deeper than this → swim; shallower → wade on the bed
const SWIM_EYE = 0.25; // eye height above the surface while swimming
const WADE_SLOW = 0.6; // horizontal speed factor while wading
const SWIM_SLOW = 0.45; // horizontal speed factor while swimming

// Wailua beach in metres (grid centre origin). Nudged ~1.4 km inland from the
// waterline so the scout starts on land while G5 finishes decoding.
const SPAWN = { x: 20900, z: 1288, facing: 270 };
const WATER_SIZE = 80000; // ocean plane extent (m)
const WATER_REPEAT = 10000; // ripple normal repeats → ~8 m wavelength
const WATER_Y = -0.4; // surface just below the 0 m waterline (soft shoreline)

/**
 * Ocean surface material: a translucent MeshStandard blue with an animated
 * ripple normal map (set by the scene) for moving wavelets + travelling sun
 * glints, plus a fresnel sky-reflection term so the surface reads as water from
 * any angle — the moving normals modulate the fresnel into a live shimmer. No
 * white foam yet (deferred).
 */
/** Flat translucent ocean (the v51 look — no vertex swells). */
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
  private hydro?: KauaiHydro;
  private trees?: KauaiTrees;
  private player?: PlayerController;
  private water?: THREE.Mesh;
  private waterNormal?: THREE.Texture;
  private waterT = 0;
  private envMap?: THREE.Texture;
  private bgMap?: THREE.Texture;
  private hud?: HTMLDivElement;
  private swapBtn?: HTMLButtonElement;
  private grounded = false;
  // Hero characters: Jack (player) and Sarah (standing NPC). Both feet-planted
  // on the rendered mesh surface each frame so they never sink into terrain.
  private jack?: IslandCharacter;
  private sarah?: IslandCharacter;
  private jackPos = new THREE.Vector2(SPAWN.x, SPAWN.z);
  private sarahPos = new THREE.Vector2();
  // Which character the first-person camera is bound to (the played body). The
  // other stands as an NPC. Toggle with switchCharacter().
  private active: "Jack" | "Sarah" = "Jack";
  private disposed = false;
  // Vertical physics state (feet world Y + vertical velocity + airborne flag),
  // and last frame's XZ so water can drag the horizontal step.
  private feetY = EYE;
  private vy = 0;
  private airborne = false;
  private prevX = SPAWN.x;
  private prevZ = SPAWN.z;

  constructor(ctx: SceneContext) {
    this.ctx = ctx;
    const aspect = ctx.renderer.width / ctx.renderer.height;
    // Near 0.107 m (beach/Godot parity): the camera rides at the head, so a tiny
    // near plane keeps the first-person BODY from being sliced away underfoot.
    // Distant terrain is fogged long before depth precision matters.
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.107, 22000);
    this.camera.position.set(SPAWN.x, EYE, SPAWN.z);
  }

  async enter(): Promise<void> {
    this.scene.background = SKY; // fallback until the HDRI background loads
    // Neutral light haze (not saturated sky-blue) pushed far out, so distant
    // terrain keeps its colour and only melts into a soft horizon haze rather
    // than a blue fade. With streamer radius 2 the loaded edge sits past this.
    this.scene.fog = new THREE.Fog(0xbcc6cc, 6500, 17000);

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
    // Sit the surface a touch below the 0 m waterline so the terrain's soft
    // wet-sand → reef fade forms the shoreline, not a hard water edge.
    water.position.set(SPAWN.x, WATER_Y, SPAWN.z);
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
      this.streamer = new KauaiTileStreamer(this.scene, manifest, { radius: 2 });
      this.streamer.update(0, SPAWN.x, SPAWN.z); // kick the first ring
      // Real NHD rivers + lakes, draped on the tiles and streamed with them.
      this.hydro = new KauaiHydro(this.scene);
      // Billboard forest placed from the baked veg rasters, streamed + grounded
      // on the tiles, with the same distance alpha-fade as the beach map.
      this.trees = new KauaiTrees(this.scene);
    } catch (e) {
      console.error("[kauai] manifest load failed", e);
    }

    // First-person player controller — human-scale gameplay speeds. Vertical
    // physics (gravity/jump/wade/swim) is layered on in update().
    this.player = new PlayerController(this.camera, this.ctx.input, {
      eyeHeight: EYE,
      moveSpeed: 2.8, // ~2.8 m/s walk
      runMultiplier: 3.4, // ~9.5 m/s sprint
      crouchMultiplier: 0.5,
      crawlMultiplier: 0.3,
      lookSensitivity: 0.0032,
    });
    this.player.placeAt(SPAWN.x, SPAWN.z, SPAWN.facing);
    this.player.setActive(true);

    // Hero characters. Jack rides with the player (his body a few metres ahead
    // of the camera so it's visible while we validate grounding); Sarah stands
    // just down the beach. Both plant their feet on the rendered mesh surface,
    // so nothing clips into the sand the way it did on the old beach map.
    // A few metres inland of the spawn camera (which faces west), flanking the
    // centre so both are in view at once for the arrival beat.
    this.jackPos.set(SPAWN.x - 5, SPAWN.z + 1.8);
    this.sarahPos.set(SPAWN.x - 5, SPAWN.z - 1.8);
    void IslandCharacter.load("Jack", 1.83).then((c) => {
      if (this.disposed) return void c.dispose();
      this.jack = c;
      c.setFacing(Math.PI / 2); // face east, toward the ocean/camera
      this.scene.add(c.group);
      this.groundCharacter(c, this.jackPos);
      this.applyRoles();
    });
    void IslandCharacter.load("Sarah", 1.7).then((c) => {
      if (this.disposed) return void c.dispose();
      this.sarah = c;
      c.setFacing(Math.PI / 2);
      this.scene.add(c.group);
      this.groundCharacter(c, this.sarahPos);
      this.applyRoles();
    });

    // Dev-only handle for headless render/inspection of the streaming world.
    if (import.meta.env.DEV) {
      (window as unknown as { __kauai?: unknown }).__kauai = {
        scene: this.scene,
        camera: this.camera,
        trees: this.trees,
        hydro: this.hydro,
        streamer: this.streamer,
        player: this.player,
        input: this.ctx.input,
        switchCharacter: () => this.switchCharacter(),
        getActive: () => this.active,
        step: (dt = 0.016, n = 1) => {
          for (let i = 0; i < n; i++) this.update(dt);
        },
        render: () => this.ctx.renderer.render(this.scene, this.camera),
        dbg: () => {
          const x = this.camera.position.x;
          const z = this.camera.position.z;
          return {
            camXZ: [Math.round(x), Math.round(z)],
            tileReady: this.streamer?.tileReadyAt(x, z) ?? false,
            grounded: this.grounded,
            feetY: +this.feetY.toFixed(2),
            vy: +this.vy.toFixed(2),
            airborne: this.airborne,
            camY: +this.camera.position.y.toFixed(2),
          };
        },
      };
    }

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

  /** Head-hide the played (active) character so the head-height camera doesn't
   *  render skull interior; restore the NPC's head. */
  private applyRoles(): void {
    const activeChar = this.active === "Jack" ? this.jack : this.sarah;
    const npcChar = this.active === "Jack" ? this.sarah : this.jack;
    activeChar?.setHeadHidden(true);
    npcChar?.setHeadHidden(false);
  }

  /** Swap which character the first-person camera is bound to. The outgoing body
   *  is left standing (as an NPC) where the player currently is. */
  switchCharacter(): void {
    const here = new THREE.Vector2(this.camera.position.x, this.camera.position.z);
    if (this.active === "Jack") this.jackPos.copy(here);
    else this.sarahPos.copy(here);
    this.active = this.active === "Jack" ? "Sarah" : "Jack";
    this.applyRoles();
    this.ctx.overlays.showToast(`Now playing: ${this.active}`);
  }

  /** Plant a character's feet on the rendered mesh surface at its XZ (or sea
   *  level over water) — only once the tile there has decoded. */
  private groundCharacter(c: IslandCharacter, at: THREE.Vector2): void {
    const s = this.streamer;
    if (!s || !s.tileReadyAt(at.x, at.y)) return;
    c.place(at.x, Math.max(s.surfaceHeightAt(at.x, at.y), 0), at.y);
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

    // Character-swap button (top-left): bind the FP camera to Jack or Sarah.
    const swap = document.createElement("button");
    swap.type = "button";
    swap.textContent = "⇄ SWAP";
    swap.style.cssText =
      "position:absolute;top:10px;left:10px;z-index:61;padding:8px 12px;" +
      "border:0;border-radius:10px;background:rgba(6,14,22,0.72);color:#dff;" +
      "font:700 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.04em;" +
      "backdrop-filter:blur(6px);touch-action:manipulation;cursor:pointer;";
    swap.addEventListener("click", (e) => {
      e.preventDefault();
      this.switchCharacter();
    });
    this.ctx.uiLayer.appendChild(swap);
    this.swapBtn = swap;
  }

  update(dt: number): void {
    const p = this.player;
    const s = this.streamer;
    const moved = p ? p.update(dt) : null;
    if (s) {
      const x = this.camera.position.x;
      const z = this.camera.position.z;
      s.update(dt, x, z);
      this.hydro?.update(dt, s);
      this.trees?.update(dt, this.camera.position, s, this.hydro);
      // Advance both characters' animation mixers (idle/walk blend).
      this.jack?.update(dt);
      this.sarah?.update(dt);
      // ── Player vertical physics: gravity + jump on land, wade/swim in water ──
      // High/low tide (two incommensurate sines → non-repeating) drives the
      // ocean surface, used for both the plane and the swim/wade test.
      this.waterT += dt;
      const tide =
        0.6 * Math.sin(this.waterT * 0.25) + 0.4 * Math.sin(this.waterT * 0.11 + 1.3);
      const waterY = WATER_Y + 0.5 * tide; // ocean surface (also the plane Y)

      if (s.tileReadyAt(x, z)) {
        const ground = s.surfaceHeightAt(x, z);
        if (!this.grounded) {
          this.feetY = Math.max(ground, waterY);
          this.grounded = true;
        }
        const depth = waterY - ground; // > 0 → a water column stands here

        // Water drags the horizontal step: pull the just-moved camera (and the
        // controller's authoritative position, so it doesn't snap back) part-way
        // toward last frame's spot.
        if (depth > WATER_ENTER && this.player) {
          const f = depth > SWIM_DEPTH ? SWIM_SLOW : WADE_SLOW;
          const nx = this.prevX + (this.camera.position.x - this.prevX) * f;
          const nz = this.prevZ + (this.camera.position.z - this.prevZ) * f;
          this.camera.position.x = nx;
          this.camera.position.z = nz;
          this.player.position.x = nx;
          this.player.position.z = nz;
        }

        const jump = this.ctx.input.consumeJump();
        if (depth > SWIM_DEPTH) {
          // SWIM: bob at the surface (eye just above the water), no gravity.
          const target = waterY - (EYE - SWIM_EYE);
          this.feetY += (target - this.feetY) * Math.min(1, dt * 6);
          this.vy = 0;
          this.airborne = false;
        } else {
          // LAND / WADE: stick to the ground (or riverbed), jump + gravity.
          if (jump && !this.airborne) {
            this.vy = JUMP_V;
            this.airborne = true;
          }
          if (this.airborne) {
            this.vy -= GRAVITY * dt;
            this.feetY += this.vy * dt;
            if (this.feetY <= ground) {
              this.feetY = ground;
              this.vy = 0;
              this.airborne = false;
            }
          } else {
            this.feetY = ground;
          }
        }
        this.camera.position.y = this.feetY + EYE;
      } else if (!this.grounded) {
        this.camera.position.y = EYE; // sit at sea level until the first tile lands
      }
      this.prevX = this.camera.position.x;
      this.prevZ = this.camera.position.z;

      // ── First-person body: the active character IS the player. Plant it at the
      // player's feet, face it the look direction, blend idle↔walk, and push the
      // eye ahead of the (hidden) head so the body renders behind it. The other
      // character stands where it was placed as an NPC.
      const activeChar = this.active === "Jack" ? this.jack : this.sarah;
      const npcChar = this.active === "Jack" ? this.sarah : this.jack;
      const npcPos = this.active === "Jack" ? this.sarahPos : this.jackPos;
      if (activeChar && p) {
        activeChar.place(this.camera.position.x, this.feetY, this.camera.position.z);
        activeChar.setBodyYaw(p.yaw);
        activeChar.setMoving(!!moved?.moving);
        this.camera.position.x -= Math.sin(p.yaw) * CAM_FWD;
        this.camera.position.z -= Math.cos(p.yaw) * CAM_FWD;
      }
      if (npcChar) {
        npcChar.setMoving(false);
        this.groundCharacter(npcChar, npcPos);
      }

      if (this.water) {
        // The plane follows the player in XZ; ripple UVs are world-locked (so
        // they don't swim with the plane) then scrolled for wave motion.
        this.water.position.set(this.camera.position.x, waterY, this.camera.position.z);
        if (this.waterNormal) {
          const uvpm = WATER_REPEAT / WATER_SIZE;
          this.waterNormal.offset.set(
            this.camera.position.x * uvpm + this.waterT * 0.014,
            this.camera.position.z * uvpm + this.waterT * 0.01,
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
    this.disposed = true;
    this.player?.setActive(false);
    this.player?.dispose();
    this.jack?.dispose();
    this.sarah?.dispose();
    this.hydro?.dispose();
    this.trees?.dispose();
    this.streamer?.dispose();
    this.envMap?.dispose();
    this.bgMap?.dispose();
    this.hud?.remove();
    this.swapBtn?.remove();
    this.scene.clear();
  }
}

export const createKauaiStreamScene: SceneFactory = (ctx) =>
  new KauaiStreamScene(ctx);
