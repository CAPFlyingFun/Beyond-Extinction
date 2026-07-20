import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { PlayerController } from "../engine/PlayerController";
import { KauaiTileStreamer, type KauaiManifest } from "../engine/KauaiTileStreamer";
import { segForDevice, setSegForDevice } from "../engine/terrainSampling";
import { KauaiHydro } from "../engine/KauaiHydro";
import { KauaiWaterSim } from "../engine/KauaiWaterSim";
import { KauaiCarve } from "../engine/KauaiCarve";
import { KauaiTrees } from "../engine/KauaiTrees";
import { IslandCharacter } from "../engine/IslandCharacter";
import { SpawnStore } from "../engine/SpawnStore";
import { SpawnTools } from "../engine/SpawnTools";
import { SurvivalStats } from "../engine/SurvivalStats";
import { InventoryOverlay } from "../engine/InventoryOverlay";
import { IslandHud } from "../engine/IslandHud";
import { openSettingsPanel, closeSettingsPanel } from "../engine/SettingsPanel";
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
const EYE_JACK = 1.7; // m — Jack's first-person eye height
const EYE_SARAH = 1.65; // m — Sarah's first-person eye height
const CAM_FWD = 0.1; // eye ahead of the head (smaller = closer to the head)
const SKY = new THREE.Color(0x8fbcd4);
const SUN = new THREE.Vector3(-0.55, 0.72, 0.42).normalize();

// Player vertical physics.
const GRAVITY = 22; // m/s² (snappy game gravity)
const JUMP_V = 7.5; // m/s → ~1.3 m jump apex
const WATER_ENTER = 0.35; // water at least this deep starts to slow you
const COMPANION_MAX_DEPTH = 0.55; // companion refuses water deeper than this (knee/thigh)
const SWIM_DEPTH = 1.3; // deeper than this → swim; shallower → wade on the bed
const SWIM_EYE = 0.42; // eye height above the surface while swimming (above the swell)
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
const SPAWN = { x: 21290, z: 1288, facing: 270 }; // v0.0.133: moved to the beach — ~65 m from the real waterline (x=21355, measured from tile data; the old 20900 was 455 m out). Matches the Godot build's spawn.
const WATER_SIZE = 80000; // ocean plane extent (m)
const WATER_REPEAT = 10000; // ripple normal repeats → ~8 m wavelength
export const WATER_Y = -0.4; // surface just below the 0 m waterline (soft shoreline)
// Tide breathe amplitude (m). Deliberately whisper-small: the coastal flats are
// nearly level, so a ±0.5 m vertical swing walked the shoreline hundreds of
// metres inland and back every few seconds (the "jumping waterline" seen from
// the flyover's high wide shots). ±0.06 m keeps the surface alive up close
// while the shoreline stays visually pinned.
const TIDE_AMP = 0.06;

// ── Ocean swell (sum-of-sines) ──────────────────────────────────────────────
// A handful of directional sine waves displace the ocean surface and give the
// player (and, later, floating objects) real buoyant bob. Sum-of-sines rather
// than full Gerstner so the height at a world XZ is EXACT (no horizontal roll),
// which makes CPU buoyancy a direct evaluation. Cheap enough for mobile — no
// FFT, no compute, just a few sines per vertex on a coarse radial grid.
// Each wave: [dirX, dirZ (unit), wavelength m, amplitude m, angular speed rad/s].
// Gentle calm-coast swell. Amplitudes are deliberately small: a first-person
// swimmer floats with the eye barely above the waterline, so a tall swell would
// tower crests above the eye and fill the lower view with (currently un-fogged,
// so black) underwater. Kept low, the surface still rolls and bobs the player
// without swamping the camera. (Full underwater rendering is a follow-up.)
const OCEAN_WAVES: readonly [number, number, number, number, number][] = [
  [1.0, 0.0, 118, 0.12, 0.82],
  [0.6, 0.8, 67, 0.07, 0.98],
  [-0.7593, 0.6508, 39, 0.04, 1.2],
];

/** Human-readable ETA: "1m 13s" over a minute, else "13s". */
function fmtEta(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m > 0 ? `${m}m ${String(ss).padStart(2, "0")}s` : `${ss}s`;
}

/** Exact swell height (m, relative to the base plane) at world (x,z) & time t. */
export function oceanWaveHeight(x: number, z: number, t: number): number {
  let h = 0;
  for (const [dx, dz, len, amp, w] of OCEAN_WAVES) {
    const k = (2 * Math.PI) / len;
    h += amp * Math.sin(k * (dx * x + dz * z) - w * t);
  }
  return h;
}

/** GLSL for oceanH()/oceanGrad() built from OCEAN_WAVES — one source of truth. */
function oceanWaveGLSL(): string {
  let hL = "";
  let gL = "";
  for (const [dx, dz, len, amp, w] of OCEAN_WAVES) {
    const k = (2 * Math.PI) / len;
    const ph = `${k.toFixed(8)}*(${dx.toFixed(4)}*p.x+${dz.toFixed(4)}*p.y)-${w.toFixed(4)}*t`;
    hL += `h+=${amp.toFixed(4)}*sin(${ph});`;
    gL += `g+=${(amp * k).toFixed(8)}*cos(${ph})*vec2(${dx.toFixed(4)},${dz.toFixed(4)});`;
  }
  return `
    float oceanH(vec2 p, float t){ float h=0.0; ${hL} return h; }
    vec2 oceanGrad(vec2 p, float t){ vec2 g=vec2(0.0); ${gL} return g; }`;
}

/**
 * A radial (polar) grid centred on the camera: dense rings near the viewer for
 * visible waves, growing geometrically to the fog distance so the far ocean is
 * a cheap coarse sheet. ~rings·sectors verts total. The wave shader fades the
 * displacement out beyond a near radius (and in the shallows), so the coarse
 * far rings stay flat and don't alias.
 */
export function buildOceanGrid(rings: number, sectors: number, r0: number, rMax: number): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0]; // centre vertex
  const ratio = Math.pow(rMax / r0, 1 / (rings - 1));
  for (let i = 0; i < rings; i++) {
    const r = r0 * Math.pow(ratio, i);
    for (let j = 0; j < sectors; j++) {
      const a = (j / sectors) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < sectors; j++) idx.push(0, 1 + ((j + 1) % sectors), 1 + j); // centre fan
  for (let i = 0; i < rings - 1; i++) {
    const base = 1 + i * sectors;
    const next = 1 + (i + 1) * sectors;
    for (let j = 0; j < sectors; j++) {
      const a = base + j;
      const b = base + ((j + 1) % sectors);
      const c = next + j;
      const d = next + ((j + 1) % sectors);
      idx.push(a, d, c, a, b, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Ocean surface material: a translucent MeshStandard blue with an animated
 * ripple normal map (set by the scene) for moving wavelets + travelling sun
 * glints, plus a fresnel sky-reflection term so the surface reads as water from
 * any angle — the moving normals modulate the fresnel into a live shimmer. No
 * white foam yet (deferred).
 */
/** Translucent ocean. `waves` adds sum-of-sines vertex swell + analytic normal. */
export function makeOceanMaterial(waves = false): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1a6389,
    roughness: 0.18,
    // Keep metalness LOW: a mirror-like surface viewed steeply (a swimmer looking
    // down into deep water) reflects the dark water below and reads near-black.
    // Low metalness keeps the diffuse blue at every angle; the fresnel sheen adds
    // the bright sky glint at grazing.
    metalness: 0.1,
    transparent: true,
    opacity: 0.9,
    envMapIntensity: 0.9,
    normalScale: new THREE.Vector2(0.55, 0.55),
    side: waves ? THREE.DoubleSide : THREE.FrontSide, // see the swell from below
    // Z-fight guard: push ocean fragments deeper so near-coplanar terrain
    // (the flat wet-sand shelf right at the waterline) wins the depth test
    // consistently instead of shimmering between sand and water. Units are
    // deliberately generous AND distance-adaptive: a depth-buffer unit is a
    // fraction of a millimetre up close but grows to metres at multi-km range,
    // so a large unit count barely moves the near shoreline yet decisively
    // sinks the ocean behind the shallow reef shelf in the high wide flyover
    // shots (where the shelf and the plane were near-coplanar and shimmered).
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 12,
  });
  const sky = new THREE.Color(0x9fc6df).convertSRGBToLinear();
  // Baked coastline mask (tools/bake_coast_mask.cjs →
  // public/assets/terrain/kauai/coast_mask.png): world-locked GROUND HEIGHT
  // (encoded over [−8, +2] m) that the shader fades to alpha by height AND
  // camera distance — a tight up-close shoreline that opens out far away so the
  // shallow shelf can't shimmer in the flyover. Below-sea-level ground NOT
  // flood-fill connected to the open sea (Mānā-plain ditches etc.) is baked to
  // the land sentinel so it never shows ocean. Starts as a 1×1 deep-ocean
  // placeholder (enc 0 → ground −8 m → plain ocean everywhere) until it loads.
  const deep = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  deep.needsUpdate = true;
  const uCoast = { value: deep as THREE.Texture };
  const uTime = { value: 0 };
  // Scrolling ripple normal so the surface always has micro-detail — the sum-of-
  // sines swell fades to flat far away and in the shallows, and without this the
  // bare plane reads as glassy "ice". World-planar (sampled by world XZ) so it
  // doesn't swim with the camera-centred grid.
  const flatN = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  flatN.needsUpdate = true;
  const uRipple = { value: flatN as THREE.Texture }; // flat until the ripple loads
  void loadTexture("assets/textures/water_normal.png").then((tex) => {
    if (!tex) return;
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    uRipple.value = tex;
  });
  mat.userData.uCoast = uCoast;
  mat.userData.uTime = uTime;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSky = { value: sky };
    sh.uniforms.uCoast = uCoast;
    sh.uniforms.uTime = uTime;
    sh.uniforms.uRipple = uRipple;
    if (waves) {
      // Sum-of-sines swell: displace Y and set an ANALYTIC normal so the surface
      // shades as real waves. Faded out beyond a near radius (so the coarse far
      // rings stay flat, no aliasing) and in the shallows (so the swell never
      // walks the shoreline the way a vertical tide would).
      sh.vertexShader = sh.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vOceanWpos;
          uniform float uTime;
          ${oceanWaveGLSL()}
          float wH; // filled in beginnormal, reused in begin_vertex`,
        )
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
          vec3 wWp = (modelMatrix * vec4(position, 1.0)).xyz;
          // Distance fade only — no vertex texture fetch (unreliable on some
          // mobile GPUs / swiftshader → NaN → black triangles). Shallow-water
          // waves are simply hidden by the fragment coast-alpha, and the CPU
          // buoyancy applies its own shore fade so the swell never walks the
          // shoreline.
          float wFade = 1.0 - smoothstep(180.0, 1400.0, length(wWp.xz - cameraPosition.xz));
          wH = oceanH(wWp.xz, uTime) * wFade;
          vec2 wG = oceanGrad(wWp.xz, uTime) * wFade;
          objectNormal = normalize(vec3(-wG.x, 1.0, -wG.y));`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          transformed.y += wH;`,
        )
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
          vOceanWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );
    } else {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vOceanWpos;")
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
        vOceanWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );
    }
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 uSky;\nuniform sampler2D uCoast;\nuniform sampler2D uRipple;\nuniform float uTime;\nvarying vec3 vOceanWpos;",
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        {
          // Two world-planar scrolling octaves of the ripple normal keep the
          // surface textured everywhere the swell has faded flat (far + shallows).
          vec2 r1 = vOceanWpos.xz / 9.0 + uTime * vec2(0.03, 0.021);
          vec2 r2 = vOceanWpos.xz / 23.0 - uTime * vec2(0.017, 0.026);
          vec3 rn = (texture2D(uRipple, r1).xyz + texture2D(uRipple, r2).xyz) - 1.0;
          normal = normalize(normal + vec3(rn.x, 0.0, rn.y) * 0.30);
        }`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          // coast_mask stores the CLAMPED GROUND HEIGHT (see bake_coast_mask.cjs),
          // decoded here over [-8, +2] m. island spans 56 km centred on origin.
          float enc = texture2D(uCoast, vOceanWpos.xz / 56000.0 + 0.5).r;
          float ground = -8.0 + enc * 10.0;
          // DISTANCE-ADAPTIVE shoreline: near the camera keep a tight waterline
          // (fade in from just below the plane), but far away raise the hide
          // threshold so the whole shallow reef shelf goes transparent — that
          // near-coplanar sheet is what shimmered on/off in the moving high
          // flyover (far + >30° grazing). Deep water stays full ocean at any
          // distance, so only the thin shelf band is affected.
          float camDist = distance(vOceanWpos, cameraPosition);
          float f = clamp((camDist - 350.0) / 2650.0, 0.0, 1.0); // 0 @350 m → 1 @3 km
          float hiddenG = mix(-0.5, -2.8, f);   // ground at/above → no ocean
          float visibleG = mix(-1.8, -5.5, f);  // ground at/below → full ocean
          float t = clamp((ground - hiddenG) / (visibleG - hiddenG), 0.0, 1.0);
          float coast = t * t * (3.0 - 2.0 * t); // smoothstep
          diffuseColor.a *= coast;
          if (diffuseColor.a < 0.01) discard;

          // Depth-tinted tropical water: turquoise in the shallows deepening to a
          // rich blue offshore (Kauaʻi's reef water), replacing the flat single
          // hue that read grey. Depth from the same decoded ground height.
          float depth = clamp(-0.4 - ground, 0.0, 8.0);      // metres of water
          float shallow = 1.0 - smoothstep(0.3, 4.5, depth); // 1 near shore → 0 deep
          vec3 shallowCol = vec3(0.055, 0.52, 0.55);         // aqua/turquoise
          vec3 deepCol    = vec3(0.020, 0.16, 0.34);         // rich navy-blue
          diffuseColor.rgb = mix(deepCol, shallowCol, shallow * shallow);

          // Whitecaps + shoreline surf. A scrolling sample of the ripple map is
          // thresholded into sparse foam: broad surf right at the beach (very
          // shallow) plus occasional open-water caps where the ripple tilts hard.
          float surf = smoothstep(1.6, 0.15, depth);         // strongest at the waterline
          float surfN = texture2D(uRipple, vOceanWpos.xz / 6.0 + uTime * vec2(0.05, 0.03)).r;
          float foam = surf * smoothstep(0.60, 0.86, surfN);
          vec3 cn = texture2D(uRipple, vOceanWpos.xz / 14.0 - uTime * vec2(0.02, 0.028)).xyz * 2.0 - 1.0;
          foam = clamp(foam + smoothstep(0.55, 0.95, length(cn.xy)) * 0.45, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.95, 0.97), foam);
        }`,
      )
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
        {
          // Fresnel sky sheen. The wave NORMALS now break grazing angles into
          // sparkle instead of one uniform strip, so we can brighten it back up
          // (the near-black deep water in the flat-surface era) without the old
          // white-band blowout — the cap only tames the flattest far rings.
          float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += uSky * min(fres, 0.85) * 0.5;
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
  private sim?: KauaiWaterSim; // virtual-pipes water, window follows the player
  private simReady = false;
  private simSpunUp = false;
  private readonly simCenter = new THREE.Vector2(); // where the sim window is centred
  private trees?: KauaiTrees;
  private player?: PlayerController;
  private water?: THREE.Mesh;
  private waterNormal?: THREE.Texture;
  private waterT = 0;
  private envMap?: THREE.Texture;
  private bgMap?: THREE.Texture;
  private hud?: HTMLDivElement;
  private swapBtn?: HTMLButtonElement;
  private stats?: SurvivalStats;
  private islandHud?: IslandHud;
  private inventory?: InventoryOverlay;
  private objectiveText = "Explore the island";
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
  // The companion (the non-played hero) trails the player: true while closing a
  // gap, cleared once she's back at conversation distance (hysteresis, so small
  // player steps don't make her shuffle).
  private companionChasing = false;
  // Opt-in foot IK (adds ~2 ms; plants feet on slopes). Off unless the page is
  // loaded with `?footik=1`, so the shipping default is unchanged while it's
  // reviewed on-device.
  private readonly footIkOn =
    typeof location !== "undefined" && new URLSearchParams(location.search).get("footik") === "1";
  private disposed = false;
  // Vertical physics state (feet world Y + vertical velocity + airborne flag),
  // and last frame's XZ so water can drag the horizontal step.
  private feetY = EYE_JACK;
  private vy = 0;
  private airborne = false;
  private staminaEmpty = false; // sprint gate latch (v0.0.131)
  private playerInWater = false; // feet in a water column this frame (for foot-IK release)
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
  private wasUnderwater = false;
  private airFog!: THREE.Fog; // light haze above water
  private uwFog!: THREE.Fog; // dense teal below the surface
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
  // "Skip" during the opening: revealed once the map is READY but the baked
  // cinematic is still playing, so a ready player can cut it and go straight in.
  private skipBtn?: HTMLButtonElement;
  private openingAudioActive = false; // the baked opening track is still playing
  private arrivalSkip = false; // player asked to skip the rest of the arrival
  private skyProgress = 0; // 0..1 HDRI download fraction (real bytes via onProgress)
  private loadFracMax = 0; // monotonic clamp so the bar never slides backward
  // Rolling progress samples for the live ETA (measure the RATE over a window,
  // like counting a pulse, then extrapolate the time left). loadEtaMs is the
  // smoothed estimate so the readout doesn't twitch every tick.
  private loadSamples: { t: number; f: number }[] = [];
  private loadEtaMs = 0;
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
    // Underwater the fog swaps to dense teal (see the swim physics) so dipping
    // below the surface reads as being IN the water, not a black void.
    this.airFog = new THREE.Fog(0xbcc6cc, 6500, 17000);
    // Brighter turquoise + a much longer clear range so a shallow 3–8 m waterway
    // reads as CLEAR sunlit water, not dark murk. Depth-darkening is handled by the
    // dive tint below (deeper = darker), not by this ambient fog.
    this.uwFog = new THREE.Fog(0x2f93a8, 6, 70);
    this.scene.fog = this.airFog;

    // Sky HDRI (ambientCG, CC0): EXR → PMREM environment for real sky
    // reflections + image-based light; the tonemapped JPG is the cheap visible
    // background. The env supplies most of the ambient, so keep the fill lights
    // low and let the sun handle direct light + shadows.
    this.scene.add(new THREE.HemisphereLight(0xe6f2ff, 0x6b7550, 0.75));
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.35);
    sun.position.copy(SUN).multiplyScalar(1000);
    this.scene.add(sun);
    this.loadSky();

    // Ocean: a camera-centred radial grid (dense near the viewer, coarse to the
    // fog) carrying a sum-of-sines swell in the vertex shader, so the surface
    // visibly rolls and the player bobs on it (see oceanHeightAt / followWater).
    // The swell fades out far away and in the shallows, leaving the coast fade to
    // own the shoreline.
    const waterMat = makeOceanMaterial(true);
    const water = new THREE.Mesh(buildOceanGrid(56, 96, 3, 18000), waterMat);
    water.position.set(this.camera.position.x, WATER_Y, this.camera.position.z);
    water.frustumCulled = false; // camera-centred; its bounds always surround us
    water.renderOrder = -1;
    this.scene.add(water);
    this.water = water;
    // Swap in the baked coastline mask (see makeOceanMaterial). Until it
    // arrives the placeholder shows plain ocean everywhere — same as v74.
    void loadTexture("assets/terrain/kauai/coast_mask.png").then((tex) => {
      if (!tex) return;
      tex.colorSpace = THREE.NoColorSpace; // mask is data, not colour
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      // The bake writes PNG row 0 = north (z = −28 000) and the shader maps
      // north to v = 0, so the image must be uploaded UNFLIPPED. Three's
      // default flipY=true mirrored the mask north↔south — ocean vanished
      // over real sea and bled onto the north-shore land.
      tex.flipY = false;
      tex.needsUpdate = true;
      const uCoast = waterMat.userData.uCoast as { value: THREE.Texture };
      uCoast.value.dispose(); // the 1×1 placeholder
      uCoast.value = tex;
    });

    // Kick the shared hydro.json fetch NOW, in parallel with the manifest —
    // every tile decode awaits it before carving river/lake channels into the
    // height data, so starting early keeps tile loads off the critical path.
    void KauaiCarve.prefetch();

    // Load the manifest and start streaming around the spawn.
    try {
      const res = await fetch(assetUrl("assets/terrain/kauai/manifest.json"));
      const manifest = (await res.json()) as KauaiManifest;
      setSegForDevice(segForDevice()); // Godot-parity tip: denser grid on desktop
      this.streamer = new KauaiTileStreamer(this.scene, manifest, { radius: 2 });
      // Fresh arrival forces the spawn tile in first (see runArrival); dev/continue
      // kicks the whole ring immediately for an instant drop into first person.
      if (!this.cinematic) this.streamer.update(0, this.spawnX, this.spawnZ);
      // Real NHD rivers + lakes, draped on the tiles and streamed with them.
      this.hydro = new KauaiHydro(this.scene);
      // Billboard forest placed from the baked veg rasters, streamed + grounded
      // on the tiles, with the same distance alpha-fade as the beach map.
      this.trees = new KauaiTrees(this.scene);
      // Virtual-pipes water: a 2.56 km window that FOLLOWS the player, giving the
      // real waterways the same look/behaviour as the WaterLab testbed. It renders
      // + drives swim near the player; the hydro ribbon stays as the fallback until
      // the sim is ready and takes over (so there's never a dry gap).
      this.sim = new KauaiWaterSim(this.scene, {
        centerX: this.spawnX,
        centerZ: this.spawnZ,
        N: 256,
        cell: 10,
      });
      void KauaiCarve.prefetch().then((doc) => {
        if (doc && this.sim) this.sim.setCorridor(doc.rivers);
      });
    } catch (e) {
      console.error("[kauai] manifest load failed", e);
    }

    // First-person player controller — human-scale gameplay speeds. Vertical
    // physics (gravity/jump/wade/swim) is layered on in update().
    this.player = new PlayerController(this.camera, this.ctx.input, {
      eyeHeight: EYE_JACK, // scene physics overrides camera Y per active character
      // Speeds chosen so the animation's measured stride (Jack ~1.4 m/s walk /
      // ~3.6 m/s run) time-warps to them WITHOUT exceeding IslandCharacter's warp
      // clamp — i.e. the feet stay planted instead of moonwalking. See the
      // speed-synced locomotion in IslandCharacter.update().
      moveSpeed: 2.4, // brisk walk
      runMultiplier: 2.5, // ~6.0 m/s run
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
      this.maybeEnableFootIk(c);
      this.applyRoles();
    });
    void IslandCharacter.load("Sarah", 1.7).then((c) => {
      if (this.disposed) return void c.dispose();
      this.sarah = c;
      c.setFacing(this.sarahFacing);
      this.scene.add(c.group);
      this.groundCharacter(c, this.sarahPos);
      this.maybeEnableFootIk(c);
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
        // Companion/foot-IK diagnostics (headless verification).
        footIkOn: this.footIkOn,
        companion: () => ({
          chasing: this.companionChasing,
          sarah: { x: this.sarahPos.x, z: this.sarahPos.y, yaw: this.sarah?.group.rotation.y ?? 0 },
          jack: { x: this.jackPos.x, z: this.jackPos.y, yaw: this.jack?.group.rotation.y ?? 0 },
        }),
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
          // Reset the water-drag anchor to here, or a teleport straight into a
          // deep channel would yank the swimmer back toward the old spot.
          this.prevX = x;
          this.prevZ = z;
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
    // Callback form (not loadAsync) so onProgress can feed the loading bar with
    // REAL downloaded bytes — the HDRI is the biggest single file, so on a slow
    // connection this is what the bar's early climb actually reflects.
    void new Promise<THREE.DataTexture>((resolve, reject) => {
      new EXRLoader().load(
        assetUrl("assets/hdri/daysky.exr"),
        (exr) => resolve(exr),
        (ev) => {
          if (ev.total > 0) this.skyProgress = Math.min(1, ev.loaded / ev.total);
        },
        (err) => reject(err),
      );
    })
      .then((exr) => {
        exr.mapping = THREE.EquirectangularReflectionMapping;
        const env = pmrem.fromEquirectangular(exr).texture;
        this.scene.environment = env;
        this.envMap = env;
        this.skyProgress = 1;
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
    // v0.0.131: feet on the BED — the old Math.max(h, 0) clamp stood her ON
    // the ocean surface whenever the seabed dropped below 0. She may wade
    // shin-deep (movement blocks anything deeper); the floor is a safety net.
    c.place(at.x, Math.max(s.surfaceHeightAt(at.x, at.y), WATER_Y - 0.9), at.y);
  }

  /** Wire foot IK onto a hero when `?footik=1` is set. The ground sampler reads
   *  the rendered mesh surface where a tile has decoded, else null so the IK
   *  releases over unloaded/water spots. */
  private maybeEnableFootIk(c: IslandCharacter): void {
    if (!this.footIkOn) return;
    c.enableFootIk((x, z) => {
      const s = this.streamer;
      if (!s || !s.tileReadyAt(x, z)) return null;
      return s.surfaceHeightAt(x, z);
    });
  }

  /**
   * The companion (whichever hero isn't the played body) trails the player: she
   * closes the gap when they wander off, halts at a natural conversation
   * distance, and turns to face them while idling. Her step is driven from the
   * real distance moved this frame, so the stride-matched gait (walk vs run) and
   * facing come straight out of her actual displacement — no foot-slide, same as
   * the player. `pos` is her packed (x, z); `tx,tz` is the player's body.
   */
  private updateCompanion(
    npc: IslandCharacter,
    pos: THREE.Vector2,
    tx: number,
    tz: number,
    dt: number,
  ): void {
    const dx = tx - pos.x;
    const dz = tz - pos.y; // Vector2 packs z in .y
    const dist = Math.hypot(dx, dz);
    const STOP = 2.6; // hold at conversation distance
    const GO = 3.4; // only start closing once the gap opens past this
    const RUN_AT = 9; // break into a run when she's fallen well behind
    const yaw = dist > 1e-3 ? Math.atan2(dx, dz) : npc.group.rotation.y; // model faces +Z

    if (dist > GO || (this.companionChasing && dist > STOP)) {
      this.companionChasing = true;
      const run = dist > RUN_AT;
      const maxSpeed = run ? 5.4 : 2.2;
      const step = Math.min(dist - STOP, maxSpeed * dt);
      if (step > 1e-4 && dt > 1e-4) {
        const inv = 1 / dist;
        // v0.0.131: "companion stays ashore" for real — refuse any step whose
        // bed sits deeper than knee depth below the sea, so she waits at the
        // waterline instead of strolling across the ocean after the player.
        const nx2 = pos.x + dx * inv * step;
        const nz2 = pos.y + dz * inv * step;
        const sr = this.streamer;
        const g2 = sr && sr.tileReadyAt(nx2, nz2) ? sr.surfaceHeightAt(nx2, nz2) : null;
        if (g2 != null && g2 < WATER_Y - COMPANION_MAX_DEPTH) {
          npc.setLocomotion(0, false);
          npc.setFacing(yaw); // waiting at the shore, watching you swim
        } else {
          pos.x = nx2;
          pos.y = nz2;
          npc.setFacing(yaw);
          npc.setLocomotion(step / dt, run);
        }
      } else {
        npc.setLocomotion(0, false);
        npc.setFacing(yaw);
      }
    } else {
      this.companionChasing = false;
      npc.setLocomotion(0, false);
      npc.setFacing(yaw); // face the player while waiting
    }
    this.groundCharacter(npc, pos);
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
    // Debug tile readout (tile id · elevation · resident count) — DEV builds only;
    // it's clutter in the shipped game, so players never see it.
    if (import.meta.env.DEV) {
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

    // Underwater blue-green wash for GAMEPLAY diving: without it the translucent
    // ocean plane read as clear glass from below, so diving looked like standing
    // in tinted air. Fades in with head-submersion depth (see the play update).
    // Reuse the cinematic tint if the arrival flyover already made one.
    if (!this.uwTint) {
      const uw = document.createElement("div");
      uw.style.cssText =
        "position:fixed;inset:0;z-index:54;pointer-events:none;background:rgb(11,58,74);opacity:0;";
      this.ctx.uiLayer.appendChild(uw);
      this.uwTint = uw;
    }

    // Character-swap button: bind the FP camera to Jack or Sarah. A testing aid
    // (you play a scripted hero in the real game), so it's DEV-only — kept out of
    // the shipped UI. Sits at the leftmost slot of the top-right round-button row.
    if (import.meta.env.DEV) {
      const swap = document.createElement("button");
      swap.type = "button";
      swap.textContent = "⇄";
      swap.className = "be-ihud-btn";
      swap.setAttribute("aria-label", "Swap character");
      swap.style.right = "calc(162px + env(safe-area-inset-right, 0px))"; // slot 3, inset-aware
      swap.addEventListener("click", (e) => {
        e.preventDefault();
        this.switchCharacter();
      });
      this.ctx.uiLayer.appendChild(swap);
      this.swapBtn = swap;
    }

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
    // v0.0.131: lifted clear of the CRCH/RUN cluster they used to overlap
    const rise = mkDepthBtn("▲ RISE", 196);
    const dive = mkDepthBtn("▼ DIVE", 130);
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

    this.buildSurvivalHud();
  }

  /**
   * Compact island survival HUD (see {@link IslandHud}) + the ARK-style
   * inventory overlay. The inventory's 🎒 button + its DEV tab are how the
   * player reaches the "set Jack/Sarah start here" spawn tools (the control that
   * was previously unreachable on the streaming map). Survival drain is gentle
   * and non-lethal for now — the arc is story-first until the map's chapters are
   * complete — so death just revives instead of ending the run.
   */
  private buildSurvivalHud(): void {
    if (this.islandHud || this.disposed) return; // built once per scene
    const stats = new SurvivalStats();
    stats.onDeath = () => stats.revive();
    this.stats = stats;

    this.inventory = new InventoryOverlay(this.ctx.uiLayer, {
      getObjective: () => this.objectiveText,
      setFrozen: (frozen) => this.ctx.input.setEnabled(!frozen),
      canOpen: () => this.phase === "play" && !this.disposed,
      getRole: () => (this.active === "Jack" ? "JACK · Survivor" : "SARAH · Lead Scientist"),
      playSfx: (n) => this.ctx.audio.playSfx(n),
    });

    this.islandHud = new IslandHud({
      parent: this.ctx.uiLayer,
      stats,
      objective: this.objectiveText,
      onMenu: () => {
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
      },
      onMap: () => {
        this.ctx.audio.playSfx("ui-select");
        this.ctx.overlays.showToast("No map yet — you'll need to find one on the island.");
      },
    });
    this.islandHud.setActive(this.phase === "play");
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
      this.updateSim(focus.x, focus.z, s);
      // Advance both characters' animation mixers (idle/walk blend).
      this.jack?.update(dt);
      this.sarah?.update(dt);
      // High/low tide (two incommensurate sines → non-repeating). It now drives
      // ONLY the swim/wade depth test — NEVER the visible plane. Even a
      // whisper-small ±TIDE_AMP vertical swing walked the waterline in and out
      // across the near-level coastal flats every few seconds (the reported
      // "ocean fluctuating along the shoreline"): a pinned shoreline and a
      // vertically-moving plane simply can't coexist on a flat beach. The plane
      // is therefore held dead-flat at WATER_Y (see followWater) and the
      // world-locked coast mask owns the shoreline; surface life comes from the
      // scrolling ripple normals, not from moving the plane up and down.
      this.waterT += dt;
      const tide = play
        ? 0.6 * Math.sin(this.waterT * 0.25) + 0.4 * Math.sin(this.waterT * 0.11 + 1.3)
        : 0;
      const waterY = WATER_Y + TIDE_AMP * tide; // swim/wade surface only (NOT the plane)

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
        this.followWater(WATER_Y);
        this.islandHud?.setActive(false); // survival HUD hidden during the cinematic
        return;
      }

      // ── Player vertical physics: gravity + jump on land, wade/swim in water ──
      const x = this.camera.position.x;
      const z = this.camera.position.z;
      if (s.tileReadyAt(x, z)) {
        const ground = s.surfaceHeightAt(x, z);
        // Effective water surface here: the higher of the ocean plane (tide-lifted,
        // applies near/below sea level) and any inland river/lake filling its
        // carved trench at this spot — so the waterways are REAL water you wade
        // and swim in, not just a visual. Inland, the ocean term is far below
        // ground (huge negative depth) so the river level wins; at the coast with
        // no waterway the river term is absent and the ocean owns the surface.
        // Prefer the sim's surface where its window covers the player (so swim
        // matches the visible sim water); fall back to the hydro ribbon elsewhere.
        const riverLvl =
          (this.simReady ? this.sim?.waterLevelAt(x, z) : null) ??
          this.hydro?.waterLevelAt(x, z);
        // Ocean surface here = base/tide + the swell (faded out in the shallows,
        // exactly matching the shader's wShore), so a swimmer BOBS on the waves
        // while the shoreline stays put. Rivers/lakes are flat pools.
        const shoreF = Math.min(1, Math.max(0, (-1 - ground) / 3));
        const oceanSurf = waterY + oceanWaveHeight(x, z, this.waterT) * shoreF;
        const surfY = Math.max(oceanSurf, riverLvl ?? -Infinity);
        if (!this.grounded) {
          this.feetY = Math.max(ground, surfY);
          this.grounded = true;
        }
        const depth = surfY - ground; // > 0 → a water column stands here
        this.playerInWater = depth > WATER_ENTER;

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
          const subMax = Math.max(0, surfY - ground - this.eye);
          if (this.diveHeld) this.sub += DIVE_SPEED * dt;
          else if (this.riseHeld) this.sub -= DIVE_SPEED * dt;
          else if (this.sub < 0)
            this.sub += (-SWIM_EYE - this.sub) * Math.min(1, dt * 2); // buoy up
          this.sub = Math.max(-SWIM_EYE, Math.min(subMax, this.sub));

          const diving = this.sub > 0.02; // head under the surface → hold-depth bob
          const bob = (diving ? DIVE_BOB : FLOAT_BOB) * Math.sin(this.waterT * 2.2);
          const target = surfY - this.sub + bob - this.eye;
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

        // Underwater fog: when the eye drops below the water surface, swap the
        // haze for dense teal so diving/dipping reads as being IN the water.
        const underwater = this.camera.position.y < surfY - 0.02;
        if (underwater !== this.wasUnderwater) {
          this.scene.fog = underwater ? this.uwFog : this.airFog;
          this.wasUnderwater = underwater;
        }

        // ── Water SFX edges + environmental ambience (elevation/terrain hybrid) ──
        const submerged = swimming && this.sub > 0.02;
        const inWater = depth > WATER_ENTER;
        // Underwater wash: ramp opacity with how far the head is under, so
        // diving reads as submerged (clear at the surface, deep blue-green down).
        if (this.uwTint) {
          // Depth-driven darkening: barely-there just under the surface (clear,
          // sunlit shallows), ramping up the deeper you dive — like real water.
          const tgt = submerged ? Math.min(0.5, 0.05 + Math.max(0, this.sub) * 0.075) : 0;
          const cur = parseFloat(this.uwTint.style.opacity || "0");
          this.uwTint.style.opacity = (cur + (tgt - cur) * Math.min(1, dt * 6)).toFixed(3);
        }
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
      // Real horizontal speed this frame (m/s) from the actual displacement —
      // includes wade/swim slowdown — so the walk/run animation is time-warped to
      // the true distance travelled and the feet don't slide. Measured BEFORE
      // prevX/prevZ are advanced below.
      const bodySpeed =
        dt > 1e-4
          ? Math.hypot(this.camera.position.x - this.prevX, this.camera.position.z - this.prevZ) / dt
          : 0;
      this.prevX = this.camera.position.x;
      this.prevZ = this.camera.position.z;

      // ── First-person body: the active character IS the player. Plant it at the
      // player's feet, face it the look direction, drive the speed-synced gait,
      // and push the eye ahead of the (hidden) head so the body renders behind it.
      // The other character stands where it was placed as an NPC.
      const activeChar = this.active === "Jack" ? this.jack : this.sarah;
      const npcChar = this.active === "Jack" ? this.sarah : this.jack;
      const npcPos = this.active === "Jack" ? this.sarahPos : this.jackPos;
      // The played body sits at the camera BEFORE the eye is pushed forward, so
      // capture it here for the companion to home in on.
      const bodyX = this.camera.position.x;
      const bodyZ = this.camera.position.z;
      if (activeChar && p) {
        activeChar.place(bodyX, this.feetY, bodyZ);
        activeChar.setBodyYaw(p.yaw);
        activeChar.setLocomotion(moved?.moving ? bodySpeed : 0, this.ctx.input.isRunning());
        // Foot IK lets go while the player is off the floor (jumping) or in water.
        activeChar.setStance({ airborne: this.airborne, inWater: this.playerInWater });
        this.camera.position.x -= Math.sin(p.yaw) * CAM_FWD;
        this.camera.position.z -= Math.cos(p.yaw) * CAM_FWD;
      }
      if (npcChar) {
        npcChar.setStance({ airborne: false, inWater: false }); // companion stays ashore
        this.updateCompanion(npcChar, npcPos, bodyX, bodyZ, dt);
      }

      this.followWater(WATER_Y);

      // Survival stats + compact HUD (free roam only; frozen while a menu/inventory
      // has taken input). Flags drive stamina drain and hunger/thirst exertion.
      if (this.stats) {
        this.stats.setPaused(!this.ctx.input.inputEnabled);
        this.stats.update(dt, {
          moving: !!moved?.moving,
          running: this.ctx.input.isRunning(),
          crouching: this.ctx.input.isCrouching(),
          crawling: false,
          jumped: false,
        });
      }
      // v0.0.131: an empty tank means NO sprint. Hysteresis (block at 0,
      // release at 15) so the gate can't stutter at the boundary.
      if (this.stats) {
        if (this.stats.stamina <= 0 && !this.staminaEmpty) {
          this.staminaEmpty = true;
          this.ctx.input.setStaminaBlocked(true);
        } else if (this.staminaEmpty && this.stats.stamina >= 15) {
          this.staminaEmpty = false;
          this.ctx.input.setStaminaBlocked(false);
        }
      }
      this.islandHud?.setActive(true);
      this.islandHud?.update(dt);

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

  /** Drive the virtual-pipes water: keep its window on the player, sample the bed
   *  when it lands on fresh terrain, step the physics, and hand the render/swim
   *  over from the hydro ribbon once it's actually filling. */
  private updateSim(fx: number, fz: number, s: KauaiTileStreamer): void {
    const sim = this.sim;
    if (!sim) return;
    // Slide the window toward the player once they've drifted a few hundred metres
    // (each shift re-samples the bed, so we don't do it every step). The 2.56 km
    // window keeps the player well inside it between shifts.
    if (this.simReady && (fx - this.simCenter.x) ** 2 + (fz - this.simCenter.y) ** 2 > 400 * 400) {
      sim.recenter(fx, fz, s);
      this.simCenter.set(fx, fz);
    }
    // (Re)sample the bed until the window is fully resident.
    if (!sim.ready) sim.sampleTerrain(s);
    this.simReady = sim.ready;
    if (this.simReady) {
      if (this.simCenter.x === 0 && this.simCenter.y === 0) this.simCenter.set(fx, fz);
      if (!this.simSpunUp) {
        sim.update(600); // one-time burst so the valleys are wet on arrival
        this.simSpunUp = true;
      } else {
        sim.update(40);
      }
    }
    // The ribbon is the fallback: hide it only once the sim is rendering, so a
    // slow first load never shows a dry gap.
    sim.group.visible = this.simReady;
    if (this.hydro) this.hydro.group.visible = !this.simReady;
  }

  /** The camera-centred ocean grid follows the viewer in XZ; the swell itself is
   *  world-locked (phase uses world XZ) so it doesn't swim as you move. `planeY`
   *  is the constant base (WATER_Y) — the coast mask owns the waterline. */
  private followWater(planeY: number): void {
    if (!this.water) return;
    this.water.position.set(this.camera.position.x, planeY, this.camera.position.z);
    const uTime = (this.water.material as THREE.Material).userData.uTime as
      | { value: number }
      | undefined;
    if (uTime) uTime.value = this.waterT;
  }

  // ─── Arrival cinematic: black journal → SFX → stream the world → flyover ─────

  /** Day-One arrival: Jack's journal typed over black (with nightmare stingers)
   *  while the spawn tile + ring + heroes + forest stream in behind it, a live
   *  loading bar tracking the real (network-bound) progress; then, only once the
   *  world around Jack is ready, the establishing drone flies in and cuts to FP. */
  private async runArrival(): Promise<void> {
    const audio = this.ctx.audio;
    this.ctx.input.setEnabled(false);

    // Hand the soundstage to the radio play: fade out whatever bed carried in
    // from the menu / prologue so it doesn't bleed under the opening journal
    // line. The nightmare lays down its own chase bed (playMusic below), and the
    // island ambience takes over once we cut to first person. (Voice already
    // ducks music, but only the CURRENT bed — this stops the wrong one lingering.)
    audio.stopMusic();

    this.buildArrivalUi();
    void this.driveLoadBar(); // paint the bar from real progress for the whole arrival
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

    // The Day-One journal + the nightmare relived in first person — one pre-mixed
    // ~1:07 track over the black screen, sized so even a slow connection has
    // streamed the island in by the time it ends (non-blocking here; awaited
    // below alongside world-ready).
    const storyDone = this.runOpeningCinematic();

    await spawnReady;
    if (this.disposed) return;
    // Spawn tile exists → kick the resident ring and record Jack's ground height.
    this.streamer?.update(0, this.spawnX, this.spawnZ);
    this.jackFeetY = Math.max(
      this.streamer?.surfaceHeightAt(this.spawnX, this.spawnZ) ?? 0,
      WATER_Y,
    );

    // Hold black until the radio play has finished AND the world around Jack
    // is ready.
    await storyDone;
    if (this.disposed) return;
    await this.waitForWorldReady();
    if (this.disposed) return;

    // Straight to first person if the player pressed Skip once the map was
    // ready; otherwise the establishing drone flies in first.
    if (!this.arrivalSkip) {
      await this.runFlyover();
      if (this.disposed) return;
    }
    this.finishArrival();
  }

  /** The opening cinematic: one PRE-MIXED track (Jack's journal, the nightmare
   *  relived, its foley, and the score all bounced into a single ~1:07 file)
   *  plays over the black journal screen with the live loading bar. No on-screen
   *  text — the typewriter can't stay in sync with an offline-baked mix, and the
   *  synced captions will live in the baked opening itself (audio now, video
   *  next). Resolves when the mix ends (or a skip/teardown stops the channel). */
  private async runOpeningCinematic(): Promise<void> {
    this.openingAudioActive = true;
    try {
      await this.ctx.audio.playCinematic("assets/audio/ch2_opening.mp3");
    } finally {
      // Track ended (or was skipped) — retire the Skip button either way.
      this.openingAudioActive = false;
      if (this.skipBtn) this.skipBtn.style.display = "none";
    }
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

    // "Skip ⏭" — hidden until the world is READY (revealed in setLoadProgress);
    // pressing it cuts the remaining opening and drops straight into first person.
    const skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = "Skip ⏭";
    skip.style.cssText =
      "position:absolute;right:16px;bottom:calc(8% + env(safe-area-inset-bottom,0px));" +
      "z-index:3;display:none;padding:9px 18px;border-radius:22px;cursor:pointer;" +
      "background:rgba(10,20,28,0.72);border:1px solid rgba(120,200,220,0.42);" +
      "color:#dff2f8;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;" +
      "pointer-events:auto;-webkit-tap-highlight-color:transparent;backdrop-filter:blur(4px);";
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      this.requestArrivalSkip();
    });
    root.appendChild(skip);

    this.ctx.uiLayer.appendChild(root);
    this.journalRoot = root;
    this.journalTextEl = text;
    this.loadWrap = wrap;
    this.loadFill = fill;
    this.loadLabel = label;
    this.skipBtn = skip;
  }

  /** Player pressed "Skip": the map is loaded, so cut the rest of the opening —
   *  the baked track and the establishing flyover — and go straight to play. */
  private requestArrivalSkip(): void {
    if (this.phase === "play" || this.arrivalSkip) return;
    this.arrivalSkip = true;
    this.flyoverSkip = true; // fast-forward the flyover if it's already running
    this.ctx.audio.stopVoice(); // cut the cinematic track (resolves its await)
    if (this.skipBtn) this.skipBtn.style.display = "none";
  }

  private setLoadProgress(frac: number): void {
    const clamped = Math.min(1, Math.max(0, frac));
    const pct = Math.round(clamped * 100);
    if (this.loadFill) this.loadFill.style.width = `${pct}%`;
    if (!this.loadLabel) return;
    if (pct >= 100) {
      this.loadLabel.textContent = "READY";
      // Map's in but the baked opening is still playing → offer to skip it.
      if (this.skipBtn && this.openingAudioActive) this.skipBtn.style.display = "";
      return;
    }
    const eta = this.estimateEtaMs(clamped);
    const etaStr = eta != null ? `  ·  ~${fmtEta(eta)}` : "";
    this.loadLabel.textContent = `REACHING THE ISLAND…  ${pct}%${etaStr}`;
  }

  /**
   * Live ETA (ms) for the load — the "take a pulse" method the readout wants:
   * keep ~7 s of {time, fraction} samples, measure the fraction gained across
   * that window to get a real rate, then extrapolate the remaining fraction.
   * Returns null until there's enough recent movement for a stable estimate, and
   * a light low-pass keeps the number from jittering each 100 ms tick.
   */
  private estimateEtaMs(frac: number): number | null {
    const now = performance.now();
    const WINDOW_MS = 7000;
    const buf = this.loadSamples;
    buf.push({ t: now, f: frac });
    while (buf.length > 2 && now - buf[0].t > WINDOW_MS) buf.shift();
    const oldest = buf[0];
    const dt = now - oldest.t;
    const df = frac - oldest.f;
    if (dt < 2500 || df <= 1e-4) return null; // need ~2.5 s of real progress first
    const rate = df / dt; // fraction per ms
    const remaining = (1 - frac) / rate;
    if (!Number.isFinite(remaining) || remaining <= 0) return null;
    const capped = Math.min(remaining, 9 * 60_000); // never show an absurd ETA
    this.loadEtaMs = this.loadEtaMs > 0 ? this.loadEtaMs * 0.7 + capped * 0.3 : capped;
    return this.loadEtaMs;
  }

  /** Weighted, monotonic loading fraction built from REAL milestones (not a
   *  canned timer): manifest decoded → HDRI download bytes → spawn tile decoded →
   *  resident-ring tiles (granular ready/total) → forest planted → heroes
   *  grounded. Clamped so the bar never slides backward. */
  private computeLoadFrac(): number {
    const s = this.streamer;
    const manifestReady = !!s; // the streamer only exists once the manifest decoded
    const spawnReady = !!s && s.tileReadyAt(this.spawnX, this.spawnZ);
    const ls = s ? s.loadState(this.spawnX, this.spawnZ) : { ready: 0, total: 1 };
    const ringFrac = ls.total > 0 ? ls.ready / ls.total : 0;
    const treesReady = !!this.trees?.isReady && (this.trees?.cellCount ?? 0) > 0;
    const heroesReady =
      !!this.jack &&
      !!this.sarah &&
      (s?.tileReadyAt(this.jackPos.x, this.jackPos.y) ?? false);
    const f =
      (manifestReady ? 0.08 : 0) +
      this.skyProgress * 0.22 + // real bytes from the HDRI onProgress
      (spawnReady ? 0.15 : 0) +
      ringFrac * 0.35 +
      (treesReady ? 0.12 : 0) +
      (heroesReady ? 0.08 : 0);
    this.loadFracMax = Math.max(this.loadFracMax, Math.min(1, f));
    return this.loadFracMax;
  }

  /** Fire-and-forget: paint the arrival bar from computeLoadFrac() every ~100 ms
   *  until the world is ready (or the scene leaves the loading phase). Started at
   *  the top of the arrival so the bar climbs from the first byte in, never sits
   *  at 0 waiting for the first tile batch. */
  private async driveLoadBar(): Promise<void> {
    while (!this.disposed && this.phase === "loading") {
      this.setLoadProgress(this.computeLoadFrac());
      await this.waitMs(100);
    }
  }

  /** Gate: resolve once the resident ring has decoded, the forest has planted,
   *  and both heroes are loaded + grounded. Capped so a slow connection
   *  eventually proceeds rather than hanging black. The bar is painted by
   *  {@link driveLoadBar}; here we only decide readiness. */
  private async waitForWorldReady(): Promise<void> {
    const s = this.streamer;
    const started = performance.now();
    const MAX_MS = 120000; // slow connections need the terrain fully in before the camera starts
    for (;;) {
      if (this.disposed) return;
      const ls = s ? s.loadState(this.spawnX, this.spawnZ) : { ready: 0, total: 1 };
      const tilesReady = ls.total > 0 && ls.ready >= ls.total;
      const treesReady = !!this.trees?.isReady && (this.trees?.cellCount ?? 0) > 0;
      const heroesReady =
        !!this.jack &&
        !!this.sarah &&
        (s?.tileReadyAt(this.jackPos.x, this.jackPos.y) ?? false);
      if ((tilesReady && treesReady && heroesReady) || performance.now() - started > MAX_MS) {
        this.loadFracMax = 1;
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
      // Low sea-skimming approach (replaces the old far/high reveal): start just
      // 100 m up, far out over open water, and descend to skim the surface — so
      // the camera never takes the high, far, grazing angle over the shallow reef
      // shelf that made the ocean/seabed z-fight visible.
      { p: P(2500, 100), l: P(-200, 90), d: 0 }, // far/low reveal of the island ahead
      { p: P(2000, 20), l: P(400, 18), d: 5.0 }, // drop toward the water, aim at the coast
      { p: P(1500, 5), l: P(820, -3), d: 4.5 }, // skim the surface, aim at the dive point
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
    this.journalRoot?.remove(); // the Skip button is a child, removed with it
    this.journalRoot = undefined;
    this.journalTextEl = undefined;
    this.loadWrap = this.loadFill = this.loadLabel = this.skipBtn = undefined;

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
    this.sim?.dispose();
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
    this.islandHud?.dispose();
    this.inventory?.dispose();
    closeSettingsPanel();
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
