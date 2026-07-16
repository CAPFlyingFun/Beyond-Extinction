import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { PlayerController } from "../engine/PlayerController";
import { KauaiTileStreamer, type KauaiManifest } from "../engine/KauaiTileStreamer";
import { KauaiHydro } from "../engine/KauaiHydro";
import { KauaiTrees } from "../engine/KauaiTrees";
import { IslandCharacter } from "../engine/IslandCharacter";
import { SpawnStore } from "../engine/SpawnStore";
import { SpawnTools } from "../engine/SpawnTools";
import { assetUrl, loadTexture } from "../engine/assets";
import { VOICE_CLIPS } from "../data/voiceClips";
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
const EYE_JACK = 1.7; // m — Jack's first-person eye height
const EYE_SARAH = 1.65; // m — Sarah's first-person eye height
const CAM_FWD = 0.1; // eye ahead of the head (smaller = closer to the head)
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
const DIVE_SPEED = 1.4; // m/s the eye descends/rises while DIVE/RISE is held
const FLOAT_BOB = 0.04; // ± surface float bob (m) — the buoyant idle rock
const DIVE_BOB = 0.02; // ± hold-depth bob (m) while submerged (neutral buoyancy)
const STROKE_INTERVAL = 0.85; // s between swim-stroke SFX while stroking along
const ZONE_DEBOUNCE = 0.6; // s a new land ambience zone must persist before it commits

// ── Arrival cinematic (Chapter Two "Day One") ───────────────────────────────
// Real-scale island → the establishing drone starts far offshore and high, and
// dives DEEP before racing in. Numbers are metres (the whole map is 1:1), so the
// reveal pulls the camera "a lot further back" than the old beach map's flyover.
const FLYOVER_FOV = 74; // wider lens for the establishing shot (restored to 62 on FP)
const ISLAND_CENTER = new THREE.Vector2(0, 0); // grid-centre origin (m)

/** Uniform Catmull-Rom through p1→p2 (p0/p3 are the surrounding controls). */
function catmull(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  u: number,
): THREE.Vector3 {
  const u2 = u * u;
  const u3 = u2 * u;
  return new THREE.Vector3(
    0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
    0.5 * ((2 * p1.y) + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
    0.5 * ((2 * p1.z) + (-p0.z + p2.z) * u + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * u2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * u3),
  );
}

interface FlyWp {
  p: THREE.Vector3;
  l: THREE.Vector3;
  d: number;
}

// Wailua beach in metres (grid centre origin). Nudged ~1.4 km inland from the
// waterline so the scout starts on land while G5 finishes decoding.
const SPAWN = { x: 20900, z: 1288, facing: 270 };
const WATER_SIZE = 80000; // ocean plane extent (m)
const WATER_REPEAT = 10000; // ripple normal repeats → ~8 m wavelength
const WATER_Y = -0.4; // surface just below the 0 m waterline (soft shoreline)
// Tide breathe amplitude (m). Deliberately whisper-small: the coastal flats are
// nearly level, so a ±0.5 m vertical swing walked the shoreline hundreds of
// metres inland and back every few seconds (the "jumping waterline" seen from
// the flyover's high wide shots). ±0.06 m keeps the surface alive up close
// while the shoreline stays visually pinned.
const TIDE_AMP = 0.06;

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
    // Z-fight guard: push ocean fragments slightly deeper so near-coplanar
    // terrain (the flat wet-sand shelf right at the waterline) wins the depth
    // test consistently instead of shimmering between sand and water.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
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
  private feetY = EYE_JACK;
  private vy = 0;
  private airborne = false;
  private prevX = SPAWN.x;
  private prevZ = SPAWN.z;
  // Swim / dive state. `sub` = how far the eye sits BELOW the water surface (m):
  // negative = floating with the head above water (rest = -SWIM_EYE), positive =
  // submerged. DIVE/RISE nudge it; with neither held it holds depth when
  // submerged (neutral buoyancy — no buoy bob-up) and only drifts back up once
  // at/near the surface. `*Held` are driven by the on-screen DIVE/RISE buttons.
  private sub = -SWIM_EYE;
  private diveHeld = false;
  private riseHeld = false;
  private diveBtn?: HTMLButtonElement;
  private riseBtn?: HTMLButtonElement;
  private strokeT = 0;
  // Transition edges for water SFX (dive splash / gasp / exit splash).
  private wasSwimming = false;
  private wasSubmerged = false;
  private wasInWater = false;
  // Environmental ambience: the currently-sounding bed + a debounce for the next.
  private ambZone = "";
  private pendingZone = "";
  private pendingZoneT = 0;
  // Arrival cinematic. `cinematic` = play the Day-One reveal (fresh story
  // arrival); false = drop straight into first person (dev/continue). `phase`
  // gates update(): only "play" runs the FP physics + body binding; "loading"
  // and "flyover" hold the player while the world streams / the drone flies.
  private readonly cinematic: boolean;
  private phase: "loading" | "flyover" | "play" = "play";
  private readonly spawnFocus = new THREE.Vector3(SPAWN.x, 0, SPAWN.z);
  // Effective spawn: the hardcoded Wailua default unless a dev-saved start
  // (Dev menu → spawn tools, persisted by SpawnStore) overrides it.
  private spawnX = SPAWN.x;
  private spawnZ = SPAWN.z;
  private spawnFacing = SPAWN.facing;
  private sarahFacing = Math.PI / 2;
  private journalRoot?: HTMLDivElement;
  private journalTextEl?: HTMLDivElement;
  private loadWrap?: HTMLDivElement;
  private loadFill?: HTMLDivElement;
  private loadLabel?: HTMLDivElement;
  private uwTint?: HTMLDivElement;
  private typeRaf: number | null = null;
  private flyoverState: { wps: FlyWp[]; total: number; elapsed: number; resolve: () => void } | null = null;
  private flyoverSkip = false;
  private skipUnsub?: () => void;
  private jackFeetY = 0;

  constructor(ctx: SceneContext, opts: { cinematic?: boolean } = {}) {
    this.ctx = ctx;
    this.cinematic = !!opts.cinematic;
    this.phase = this.cinematic ? "loading" : "play";
    const aspect = ctx.renderer.width / ctx.renderer.height;
    // Near 0.107 m (beach/Godot parity): the camera rides at the head, so a tiny
    // near plane keeps the first-person BODY from being sliced away underfoot.
    // Distant terrain is fogged long before depth precision matters.
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.107, 22000);
    this.camera.position.set(SPAWN.x, EYE_JACK, SPAWN.z);
  }

  async enter(): Promise<void> {
    // Resolve the effective spawn: dev-saved start points (walk somewhere →
    // Dev menu "Set Jack/Sarah start here") override the Wailua defaults.
    const savedSpawns = SpawnStore.get();
    if (savedSpawns.jack) {
      this.spawnX = savedSpawns.jack.x;
      this.spawnZ = savedSpawns.jack.z;
      this.spawnFacing = savedSpawns.jack.rot;
    }
    this.spawnFocus.set(this.spawnX, 0, this.spawnZ);
    this.prevX = this.spawnX;
    this.prevZ = this.spawnZ;
    this.camera.position.set(this.spawnX, EYE_JACK, this.spawnZ);

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
    water.position.set(this.spawnX, WATER_Y, this.spawnZ);
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
      // Fresh arrival forces the spawn tile in first (see runArrival); dev/continue
      // kicks the whole ring immediately for an instant drop into first person.
      if (!this.cinematic) this.streamer.update(0, this.spawnX, this.spawnZ);
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
      eyeHeight: EYE_JACK, // scene physics overrides camera Y per active character
      moveSpeed: 2.8, // ~2.8 m/s walk
      runMultiplier: 3.4, // ~9.5 m/s sprint
      crouchMultiplier: 0.5,
      crawlMultiplier: 0.3,
      lookSensitivity: 0.0032,
    });
    this.player.placeAt(this.spawnX, this.spawnZ, this.spawnFacing);
    // Held inactive through the arrival cinematic; activated in finishArrival().
    if (!this.cinematic) this.player.setActive(true);
    // Dev-menu spawn tools work on this map: save Jack/Sarah start points from
    // wherever the player is standing (persisted via SpawnStore).
    this.registerSpawnTools();

    // Hero characters. Jack rides with the player (his body a few metres ahead
    // of the camera so it's visible while we validate grounding); Sarah stands
    // just down the beach. Both plant their feet on the rendered mesh surface,
    // so nothing clips into the sand the way it did on the old beach map.
    // A few metres inland of the spawn camera (which faces west), flanking the
    // centre so both are in view at once for the arrival beat.
    this.jackPos.set(this.spawnX - 5, this.spawnZ + 1.8);
    if (savedSpawns.sarah) {
      // Dev-saved Sarah start (position + mesh rotation.y in radians).
      this.sarahPos.set(savedSpawns.sarah.x, savedSpawns.sarah.z);
      this.sarahFacing = savedSpawns.sarah.rot;
    } else {
      this.sarahPos.set(this.spawnX - 5, this.spawnZ - 1.8);
    }
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
      c.setFacing(this.sarahFacing);
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
        phase: () => this.phase,
        cinematic: this.cinematic,
        skipArrival: () => {
          if (this.phase !== "play") {
            this.flyoverSkip = true; // let a running flyover settle first
            if (!this.flyoverState) this.finishArrival();
          }
        },
        diveHold: (v: boolean) => (this.diveHeld = v),
        riseHold: (v: boolean) => (this.riseHeld = v),
        teleport: (x: number, z: number, facing = this.spawnFacing) => {
          this.player?.placeAt(x, z, facing);
          this.grounded = false;
        },
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
            sub: +this.sub.toFixed(3),
            swimming: this.wasSwimming,
            submerged: this.wasSubmerged,
            ambZone: this.ambZone,
          };
        },
      };
    }

    if (this.cinematic) {
      // Fire-and-forget the Day-One reveal: the opaque journal owns the black
      // screen while the world streams, so enter() can return and let the
      // SceneManager finish its (fadeless) handoff underneath.
      void this.runArrival();
    } else {
      this.buildHud();
    }
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
  /** First-person eye height of whoever the camera is currently bound to. */
  private get eye(): number {
    return this.active === "Jack" ? EYE_JACK : EYE_SARAH;
  }

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

  /** Dev-menu spawn tools (the shared {@link SpawnTools} bridge): save Jack's or
   *  Sarah's start point at the player's current spot, persisted by SpawnStore
   *  so every future load starts there. The Dev menu shows its spawn buttons
   *  whenever these callbacks are present; dispose() clears them. */
  private registerSpawnTools(): void {
    SpawnTools.current = {
      setJackHere: () => {
        const x = +this.camera.position.x.toFixed(1);
        const z = +this.camera.position.z.toFixed(1);
        // placeAt uses yaw = degToRad(-facing), so facing = -deg(yaw).
        const facing = +(-THREE.MathUtils.radToDeg(this.player?.yaw ?? 0)).toFixed(1);
        SpawnStore.setJack({ x, z, rot: facing });
        return `Jack start saved (${x}, ${z})`;
      },
      setSarahHere: () => {
        const x = +this.camera.position.x.toFixed(1);
        const z = +this.camera.position.z.toFixed(1);
        const rot = this.sarah?.group.rotation.y ?? Math.PI / 2;
        SpawnStore.setSarah({ x, z, rot });
        this.sarahFacing = rot;
        this.sarahPos.set(x, z);
        if (this.sarah) this.groundCharacter(this.sarah, this.sarahPos);
        return `Sarah start saved (${x}, ${z})`;
      },
      reset: () => {
        SpawnStore.clear();
        return "Island start points reset to defaults";
      },
    };
  }

  /** Plant a character's feet on the rendered mesh surface at its XZ (or sea
   *  level over water) — only once the tile there has decoded. */
  private groundCharacter(c: IslandCharacter, at: THREE.Vector2): void {
    const s = this.streamer;
    if (!s || !s.tileReadyAt(at.x, at.y)) return;
    c.place(at.x, Math.max(s.surfaceHeightAt(at.x, at.y), 0), at.y);
  }

  /**
   * Pick the ambience bed for the player's spot — an elevation/terrain HYBRID
   * (per the Godot design): elevation bands drive it, but terrain overrides so a
   * pond in the middle of the island never sounds like the open ocean.
   *   • submerged  → underwater loop (muffled world)
   *   • standing water at sea level → ocean; inland standing water → swamp
   *   • dry land by elevation → beach → jungle-light → jungle-deep → highland →
   *     crags → volcano (summit)
   */
  private ambientZoneFor(ground: number, depth: number, submerged: boolean): string {
    if (submerged) return "amb-underwater";
    if (depth > WATER_ENTER) return ground <= 2 ? "amb-ocean" : "amb-swamp";
    if (ground < 6) return "amb-beach";
    if (ground < 120) return "amb-jungle-light";
    if (ground < 400) return "amb-jungle-deep";
    if (ground < 850) return "amb-highland";
    if (ground < 1250) return "amb-crags";
    return "amb-volcano";
  }

  /**
   * Crossfade the ambience toward the current zone's bed. Water transitions
   * (in/out/under) switch immediately; land-zone changes must persist for
   * ZONE_DEBOUNCE so you don't flicker beds while skirting a band boundary. The
   * single music channel means only one bed sounds at a time — exactly the
   * ocean-gives-way-to-jungle behaviour we want.
   */
  private updateAmbience(ground: number, depth: number, submerged: boolean, dt: number): void {
    const zone = this.ambientZoneFor(ground, depth, submerged);
    if (zone === this.ambZone) {
      this.pendingZone = "";
      this.pendingZoneT = 0;
      return;
    }
    const immediate =
      this.ambZone === "" ||
      zone === "amb-underwater" ||
      this.ambZone === "amb-underwater" ||
      zone === "amb-ocean" ||
      this.ambZone === "amb-ocean";
    if (immediate) {
      this.ambZone = zone;
      this.pendingZone = "";
      this.pendingZoneT = 0;
      this.ctx.audio.playMusic(zone);
      return;
    }
    if (zone !== this.pendingZone) {
      this.pendingZone = zone;
      this.pendingZoneT = 0;
    }
    this.pendingZoneT += dt;
    if (this.pendingZoneT >= ZONE_DEBOUNCE) {
      this.ambZone = zone;
      this.pendingZone = "";
      this.pendingZoneT = 0;
      this.ctx.audio.playMusic(zone);
    }
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

    // DIVE / RISE buttons (bottom-right, stacked): held-down controls, shown only
    // while swimming. RISE ascends toward the surface; DIVE descends; releasing
    // both holds the current depth (neutral buoyancy) rather than bobbing up.
    const mkDepthBtn = (label: string, bottom: number): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText =
        `position:absolute;right:14px;bottom:${bottom}px;z-index:61;` +
        "width:76px;height:56px;border:0;border-radius:14px;" +
        "background:rgba(6,14,22,0.66);color:#dff;" +
        "font:800 14px/1 ui-monospace,Menlo,monospace;letter-spacing:.05em;" +
        "backdrop-filter:blur(6px);touch-action:none;cursor:pointer;display:none;" +
        "user-select:none;-webkit-user-select:none;";
      this.ctx.uiLayer.appendChild(b);
      return b;
    };
    const rise = mkDepthBtn("▲ RISE", 118);
    const dive = mkDepthBtn("▼ DIVE", 52);
    const bind = (b: HTMLButtonElement, set: (v: boolean) => void) => {
      const down = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        set(true);
        b.style.background = "rgba(40,120,150,0.82)";
      };
      const up = (e: Event) => {
        e.preventDefault();
        set(false);
        b.style.background = "rgba(6,14,22,0.66)";
      };
      b.addEventListener("pointerdown", down);
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
      b.addEventListener("pointerleave", up);
    };
    bind(rise, (v) => (this.riseHeld = v));
    bind(dive, (v) => (this.diveHeld = v));
    this.riseBtn = rise;
    this.diveBtn = dive;
  }

  update(dt: number): void {
    const s = this.streamer;
    if (!s) return;
    const play = this.phase === "play";
    const p = this.player;
    // Look/move input only advances in free roam; the cinematic owns the camera.
    const moved = play && p ? p.update(dt) : null;
    if (s) {
      // During the arrival cinematic the world stays focused on the spawn island
      // (NOT the far-offshore drone) so Jack's tile + forest never unload beneath
      // the flyover; only free roam follows the live camera.
      const focus = play ? this.camera.position : this.spawnFocus;
      s.update(dt, focus.x, focus.z);
      this.hydro?.update(dt, s);
      this.trees?.update(dt, focus, s, this.hydro);
      // Advance both characters' animation mixers (idle/walk blend).
      this.jack?.update(dt);
      this.sarah?.update(dt);
      // High/low tide (two incommensurate sines → non-repeating) breathes the
      // ocean surface, used for both the plane and the swim/wade test. Frozen
      // during the cinematic so the flyover's shoreline is rock-steady; in play
      // it's a whisper-small ±TIDE_AMP (see the constant for why so small).
      this.waterT += dt;
      const tide = play
        ? 0.6 * Math.sin(this.waterT * 0.25) + 0.4 * Math.sin(this.waterT * 0.11 + 1.3)
        : 0;
      const waterY = WATER_Y + TIDE_AMP * tide; // ocean surface (also the plane Y)

      // ── Cinematic phases: hold both heroes on the terrain, fly the drone ──
      if (!play) {
        if (this.jack) {
          this.groundCharacter(this.jack, this.jackPos);
          this.jack.setMoving(false);
        }
        if (this.sarah) {
          this.groundCharacter(this.sarah, this.sarahPos);
          this.sarah.setMoving(false);
        }
        if (this.phase === "flyover") this.updateFlyover(dt);
        this.followWater(waterY);
        return;
      }

      // ── Player vertical physics: gravity + jump on land, wade/swim in water ──
      const x = this.camera.position.x;
      const z = this.camera.position.z;
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
        const swimming = depth > SWIM_DEPTH;
        if (swimming) {
          // SWIM. On breaking into deep water, enter at the float line + splash.
          if (!this.wasSwimming) {
            this.sub = -SWIM_EYE;
            this.ctx.audio.playSfx("splash-dive");
          }
          // Neutral-buoyancy dive/rise. DIVE sinks the eye, RISE lifts it; with
          // neither held the diver HOLDS depth when submerged (no buoy bob-up)
          // and only drifts back up once at/near the surface. Clamp so the eye
          // can't rise above the float line nor sink through the bed.
          const subMax = Math.max(0, waterY - ground - this.eye);
          if (this.diveHeld) this.sub += DIVE_SPEED * dt;
          else if (this.riseHeld) this.sub -= DIVE_SPEED * dt;
          else if (this.sub < 0)
            this.sub += (-SWIM_EYE - this.sub) * Math.min(1, dt * 2); // buoy up
          this.sub = Math.max(-SWIM_EYE, Math.min(subMax, this.sub));

          const diving = this.sub > 0.02; // head under the surface → hold-depth bob
          const bob = (diving ? DIVE_BOB : FLOAT_BOB) * Math.sin(this.waterT * 2.2);
          const target = waterY - this.sub + bob - this.eye;
          this.feetY += (target - this.feetY) * Math.min(1, dt * 6);
          this.vy = 0;
          this.airborne = false;

          // Swim-stroke SFX pulsed while actually stroking through the water.
          if (moved?.moving) {
            this.strokeT += dt;
            if (this.strokeT >= STROKE_INTERVAL) {
              this.strokeT = 0;
              this.ctx.audio.playSfx("swim-stroke");
            }
          } else {
            this.strokeT = STROKE_INTERVAL; // next stroke fires promptly on move
          }
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
        this.camera.position.y = this.feetY + this.eye;

        // ── Water SFX edges + environmental ambience (elevation/terrain hybrid) ──
        const submerged = swimming && this.sub > 0.02;
        const inWater = depth > WATER_ENTER;
        if (this.wasSubmerged && !submerged) this.ctx.audio.playSfx("breath-gasp");
        if (this.wasInWater && !inWater) this.ctx.audio.playSfx("splash-exit");
        this.updateAmbience(ground, depth, submerged, dt);
        this.wasSwimming = swimming;
        this.wasSubmerged = submerged;
        this.wasInWater = inWater;

        // The depth controls only make sense while swimming; hide + release them
        // (and reset the stroke clock) the moment you're back on the bed/land.
        const showDepth = swimming ? "block" : "none";
        if (this.diveBtn && this.diveBtn.style.display !== showDepth) {
          this.diveBtn.style.display = showDepth;
          this.riseBtn!.style.display = showDepth;
          if (!swimming) {
            this.diveHeld = this.riseHeld = false;
            this.diveBtn.style.background = this.riseBtn!.style.background =
              "rgba(6,14,22,0.66)";
          }
        }
      } else if (!this.grounded) {
        this.camera.position.y = this.eye; // sit at sea level until the first tile lands
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

      this.followWater(waterY);
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

  /** Ocean plane + ripple UVs follow the camera in XZ (world-locked ripples). */
  private followWater(waterY: number): void {
    if (!this.water) return;
    this.water.position.set(this.camera.position.x, waterY, this.camera.position.z);
    if (this.waterNormal) {
      const uvpm = WATER_REPEAT / WATER_SIZE;
      this.waterNormal.offset.set(
        this.camera.position.x * uvpm + this.waterT * 0.014,
        this.camera.position.z * uvpm + this.waterT * 0.01,
      );
    }
  }

  // ─── Arrival cinematic: black journal → SFX → stream the world → flyover ─────

  /** Day-One arrival: Jack's journal typed over black (with nightmare stingers)
   *  while the spawn tile + ring + heroes + forest stream in behind it, a live
   *  loading bar tracking the real (network-bound) progress; then, only once the
   *  world around Jack is ready, the establishing drone flies in and cuts to FP. */
  private async runArrival(): Promise<void> {
    const audio = this.ctx.audio;
    this.ctx.input.setEnabled(false);

    this.buildArrivalUi();
    // The prologue cut to black with a fadeless handoff, so the SceneManager veil
    // may still be up. Our opaque journal now owns the black screen — clear the
    // leftover veil so the flyover is actually seen when it fades the world in.
    this.ctx.overlays.setBlackInstant(false);

    await this.waitMs(700);
    if (this.disposed) return;

    // Force the spawn tile in FIRST so Jack has ground before anything else.
    const spawnReady = this.streamer
      ? this.streamer.ensureTileAt(this.spawnX, this.spawnZ)
      : Promise.resolve(false);

    // Journal VO + typed text; nightmare stingers ride over the black (non-blocking).
    this.typewrite(VOICE_CLIPS["ch2_jack_journal"]?.text ?? "", "ch2_jack_journal");
    const journalDone = audio.playVoice("ch2_jack_journal");
    audio.playSfx("jungle-crash");
    void (async () => {
      await this.waitMs(1400);
      if (this.disposed || this.phase !== "loading") return;
      audio.playSfx("roar-distant");
      await this.waitMs(1600);
      if (this.disposed || this.phase !== "loading") return;
      audio.playSfx("breath-gasp");
    })();

    await spawnReady;
    if (this.disposed) return;
    // Spawn tile exists → kick the resident ring and record Jack's ground height.
    this.streamer?.update(0, this.spawnX, this.spawnZ);
    this.jackFeetY = Math.max(
      this.streamer?.surfaceHeightAt(this.spawnX, this.spawnZ) ?? 0,
      WATER_Y,
    );

    // Hold black until the journal has finished AND the world around Jack is ready.
    await journalDone;
    if (this.disposed) return;
    await this.waitForWorldReady();
    if (this.disposed) return;

    await this.runFlyover();
    if (this.disposed) return;
    this.finishArrival();
  }

  /** The opaque journal page + a dynamic loading bar (real tile-stream progress). */
  private buildArrivalUi(): void {
    const root = document.createElement("div");
    root.className = "be-journal";
    root.style.transition = "none"; // opaque from the first frame
    root.classList.add("show");
    const text = document.createElement("div");
    text.className = "be-journal__text";
    root.appendChild(text);

    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:absolute;left:50%;bottom:9%;transform:translateX(-50%);" +
      "width:min(360px,64vw);z-index:2;display:flex;flex-direction:column;gap:8px;" +
      "align-items:center;font:600 11px/1 ui-monospace,Menlo,monospace;" +
      "letter-spacing:.14em;color:rgba(215,232,240,0.7);pointer-events:none;";
    const track = document.createElement("div");
    track.style.cssText =
      "width:100%;height:4px;border-radius:3px;overflow:hidden;background:rgba(120,150,165,0.18);";
    const fill = document.createElement("div");
    fill.style.cssText =
      "width:0%;height:100%;border-radius:3px;background:rgba(120,200,220,0.85);transition:width .3s ease;";
    track.appendChild(fill);
    const label = document.createElement("div");
    label.textContent = "REACHING THE ISLAND…";
    wrap.append(track, label);
    root.appendChild(wrap);

    this.ctx.uiLayer.appendChild(root);
    this.journalRoot = root;
    this.journalTextEl = text;
    this.loadWrap = wrap;
    this.loadFill = fill;
    this.loadLabel = label;
  }

  private setLoadProgress(frac: number): void {
    const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
    if (this.loadFill) this.loadFill.style.width = `${pct}%`;
    if (this.loadLabel)
      this.loadLabel.textContent = pct >= 100 ? "READY" : `REACHING THE ISLAND…  ${pct}%`;
  }

  /** Poll until the resident ring has decoded, the forest has planted, and both
   *  heroes are loaded + grounded — driving the loading bar from real progress.
   *  Capped so a slow connection eventually proceeds rather than hanging black. */
  private async waitForWorldReady(): Promise<void> {
    const s = this.streamer;
    const started = performance.now();
    const MAX_MS = 45000;
    for (;;) {
      if (this.disposed) return;
      const ls = s ? s.loadState(this.spawnX, this.spawnZ) : { ready: 0, total: 1 };
      const tilesReady = ls.total > 0 && ls.ready >= ls.total;
      const treesReady = !!this.trees?.isReady && (this.trees?.cellCount ?? 0) > 0;
      const heroesReady =
        !!this.jack &&
        !!this.sarah &&
        (s?.tileReadyAt(this.jackPos.x, this.jackPos.y) ?? false);
      const frac =
        (ls.total ? ls.ready / ls.total : 1) * 0.8 +
        (treesReady ? 0.1 : 0) +
        (heroesReady ? 0.1 : 0);
      this.setLoadProgress(frac);
      if (
        (tilesReady && treesReady && heroesReady) ||
        performance.now() - started > MAX_MS
      ) {
        this.setLoadProgress(1);
        break;
      }
      await this.waitMs(120);
    }
    await this.waitMs(300);
  }

  /** Reveal `text` in sync with voice clip `id` (tracks the real audio clock,
   *  falls back to the manifest duration when playback is blocked/muted). */
  private typewrite(text: string, id: string): void {
    if (this.typeRaf !== null) cancelAnimationFrame(this.typeRaf);
    const el = this.journalTextEl;
    if (!el) return;
    el.textContent = "";
    const len = Math.max(text.length, 1);
    const LEAD = 0.92;
    const fallbackMs = Math.max(this.ctx.audio.getVoiceDuration(id), 1);
    const startPerf = performance.now();
    let revealed = 0;
    const tick = () => {
      if (this.disposed) return;
      const pb = this.ctx.audio.getVoicePlayback();
      const frac =
        pb.active && pb.duration > 0
          ? pb.currentTime / (pb.duration * LEAD)
          : (performance.now() - startPerf) / (fallbackMs * LEAD);
      const shown = Math.max(revealed, Math.min(1, frac));
      revealed = shown;
      el.textContent = text.slice(0, Math.round(shown * len));
      if (shown < 1) this.typeRaf = requestAnimationFrame(tick);
      else {
        el.textContent = text;
        this.typeRaf = null;
      }
    };
    tick();
  }

  /** Establishing drone: far offshore + high reveal → descend → skim → DIVE deep
   *  under → surface → race in → settle just off Jack, then cut to FP. Waypoints
   *  are metres along the true seaward axis (island centre → Jack). Any key/tap
   *  skips to the settle. Resolves when the flight (or skip) completes. */
  private runFlyover(): Promise<void> {
    const jx = this.jackPos.x;
    const jz = this.jackPos.y;
    const jFeet = this.jackFeetY;
    const s2 = new THREE.Vector2(jx - ISLAND_CENTER.x, jz - ISLAND_CENTER.y);
    if (s2.lengthSq() < 1e-6) s2.set(1, 0);
    s2.normalize();
    const S = new THREE.Vector3(s2.x, 0, s2.y);
    // `sea` metres offshore of Jack, `up` metres above his feet; underwater legs
    // clamp to the seabed (+2 m) so the dive never clips terrain.
    const P = (sea: number, up: number): THREE.Vector3 => {
      const v = new THREE.Vector3(jx, jFeet, jz).addScaledVector(S, sea);
      v.y = jFeet + up;
      if (up < 0) {
        const bed = this.streamer?.surfaceHeightAt(v.x, v.z) ?? -30;
        v.y = Math.max(v.y, bed + 2);
      }
      return v;
    };
    const wps: FlyWp[] = [
      { p: P(2200, 900), l: P(-800, 130), d: 0 }, // far/high reveal of the whole island
      { p: P(1750, 430), l: P(-200, 45), d: 5.0 },
      { p: P(1350, 80), l: P(560, 8), d: 4.5 }, // descend toward the water
      { p: P(1180, -12), l: P(720, -8), d: 3.0 }, // DIVE under
      { p: P(1010, -16), l: P(560, -11), d: 3.0 },
      { p: P(840, -7), l: P(430, -4), d: 3.0 }, // surfacing
      { p: P(650, 60), l: P(150, 5), d: 3.5 },
      { p: P(320, 150), l: P(0, 4), d: 5.0 }, // race in toward the shore
      { p: P(11, 2.2), l: P(0, 1.7), d: 5.0 }, // settle just seaward of Jack → cut to FP
    ];
    const total = wps.reduce((sum, w) => sum + w.d, 0);

    this.phase = "flyover";
    this.camera.fov = FLYOVER_FOV;
    this.camera.updateProjectionMatrix();
    // The flight looks AT the heroes — show their heads (re-hidden on the FP cut).
    this.jack?.setHeadHidden(false);
    this.sarah?.setHeadHidden(false);

    // Underwater blue wash while the camera dips below the surface.
    const tint = document.createElement("div");
    tint.style.cssText =
      "position:fixed;inset:0;z-index:54;pointer-events:none;background:rgb(13,56,97);opacity:0;";
    this.ctx.uiLayer.appendChild(tint);
    this.uwTint = tint;

    // Fade the journal (+ loading bar) off across the first seconds of flight.
    if (this.loadWrap) this.loadWrap.style.display = "none";
    const page = this.journalRoot;
    if (page) {
      page.style.transition = "opacity 2.2s ease";
      page.classList.remove("show");
    }

    // Any key or tap skips to the settle.
    this.flyoverSkip = false;
    const skip = () => {
      this.flyoverSkip = true;
    };
    window.addEventListener("keydown", skip);
    window.addEventListener("pointerdown", skip);
    this.skipUnsub = () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
    };

    return new Promise<void>((resolve) => {
      this.flyoverState = { wps, total, elapsed: 0, resolve };
    });
  }

  /** Per-frame drone camera: Catmull-Rom through the waypoints + the underwater
   *  wash cross-fade. Called from update() while flyoverState is set. */
  private updateFlyover(dt: number): void {
    const f = this.flyoverState;
    if (!f) return;
    f.elapsed = this.flyoverSkip ? f.total : f.elapsed + dt;
    const t = Math.min(f.elapsed, f.total);
    const smp = this.flySample(f.wps, t);
    this.camera.position.copy(smp.p);
    this.camera.lookAt(smp.l);
    if (this.uwTint) {
      const target = this.camera.position.y < WATER_Y ? 0.6 : 0;
      const a = parseFloat(this.uwTint.style.opacity || "0");
      const step = Math.min(Math.abs(target - a), dt * 2.5);
      this.uwTint.style.opacity = (a + Math.sign(target - a) * step).toFixed(3);
    }
    if (f.elapsed >= f.total) {
      this.flyoverState = null;
      this.skipUnsub?.();
      this.skipUnsub = undefined;
      f.resolve();
    }
  }

  /** Sample the flight path at time `t` (uniform Catmull-Rom through the four
   *  surrounding waypoints — both camera position and look target). */
  private flySample(wps: FlyWp[], t: number): { p: THREE.Vector3; l: THREE.Vector3 } {
    let acc = 0;
    let i = 1;
    while (i < wps.length - 1 && t > acc + wps[i].d) {
      acc += wps[i].d;
      i++;
    }
    const seg = Math.max(wps[i].d, 0.0001);
    const u = THREE.MathUtils.clamp((t - acc) / seg, 0, 1);
    const i0 = Math.max(i - 2, 0);
    const i3 = Math.min(i + 1, wps.length - 1);
    return {
      p: catmull(wps[i0].p, wps[i - 1].p, wps[i].p, wps[i3].p, u),
      l: catmull(wps[i0].l, wps[i - 1].l, wps[i].l, wps[i3].l, u),
    };
  }

  /** Cut from the drone to first person once the flight settles behind Jack. */
  private finishArrival(): void {
    const tint = this.uwTint;
    if (tint) {
      tint.style.transition = "opacity 0.3s ease";
      tint.style.opacity = "0";
      setTimeout(() => tint.remove(), 400);
      this.uwTint = undefined;
    }
    this.journalRoot?.remove();
    this.journalRoot = undefined;
    this.journalTextEl = undefined;
    this.loadWrap = this.loadFill = this.loadLabel = undefined;

    this.camera.fov = 62;
    this.camera.updateProjectionMatrix();
    this.active = "Jack";
    this.applyRoles(); // re-hide the played body's head
    this.phase = "play";
    this.grounded = false;
    this.player?.placeAt(this.jackPos.x, this.jackPos.y, this.spawnFacing);
    this.player?.setActive(true);
    this.ctx.input.setEnabled(true);
    this.buildHud();

    // Jack calls for Sarah, then free roam.
    void (async () => {
      await this.waitMs(500);
      if (this.disposed) return;
      this.ctx.dialogue.showSubtitle({ speaker: "Jack", text: "SARAH!" });
      await this.ctx.audio.playVoice("ch2_jack_sarah_shout");
      if (this.disposed) return;
      this.ctx.dialogue.hideSubtitle();
    })();
  }

  private waitMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    SpawnTools.current = undefined; // Dev spawn tools leave with the scene
    if (this.typeRaf !== null) cancelAnimationFrame(this.typeRaf);
    this.typeRaf = null;
    this.skipUnsub?.();
    this.skipUnsub = undefined;
    this.flyoverState = null;
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
    this.diveBtn?.remove();
    this.riseBtn?.remove();
    this.journalRoot?.remove();
    this.uwTint?.remove();
    this.ctx.audio.stopMusic();
    this.scene.clear();
  }
}

/** Dev / continue entry: straight into first person (no arrival cinematic). */
export const createKauaiStreamScene: SceneFactory = (ctx) =>
  new KauaiStreamScene(ctx);

/** Story entry (fresh Chapter-Two arrival): the Day-One journal + flyover reveal. */
export const createKauaiArrivalScene: SceneFactory = (ctx) =>
  new KauaiStreamScene(ctx, { cinematic: true });
