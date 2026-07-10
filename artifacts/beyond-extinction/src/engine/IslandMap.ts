import * as THREE from "three";
import { assetUrl } from "./assets";
import {
  worldToIslandUV,
  ISLAND_SPAN,
  ISLAND_CENTER,
  METERS_PER_UNIT,
} from "./beachTerrain";
import { getSettings, subscribeSettings, type MinimapCorner } from "./Settings";

/**
 * Island map HUD for Chapter 2, drawn over the real satellite image.
 *
 *  - Minimap: a round, north-up panel (bottom-left) showing a ~300 m window
 *    around the player with a facing arrow. Tap it to open the full map.
 *  - Full map: full-screen, the whole satellite, pinch-to-zoom + drag-to-pan,
 *    with the player marker in place.
 *  - Fog of war: the island is revealed in 500 m × 500 m grid cells as the
 *    player explores (persisted to localStorage). REVEAL_ALL shows everything
 *    for testing; reset() clears exploration back to nothing.
 *
 * World→image projection is shared with the terrain (worldToIslandUV), so the
 * markers and fog line up exactly with the ground.
 */

const MINIMAP_RANGE_M = 300; // metres from the player shown to the minimap edge
const CELL_M = 500; // fog-of-war reveal grid (metres)
const REVEAL_ALL = true; // TESTING: start fully revealed. Flip to false for fog.
const FOG_KEY = "be-island-fog-v1";
const FOG_W = 256; // fog-mask resolution

// ── live minimap (render-to-texture) ─────────────────────────────────────────
// When a world scene is provided, the minimap is a LIVE top-down orthographic
// render of what's actually there — no baked image, no scaling worries. The
// RTT refreshes at ~15 Hz; the heading-up rotation is applied every frame by
// spinning the composited circle, so turning stays silky.
const LIVE_RT_SIZE = 256; // minimap top-down render resolution
const LIVE_CAM_Y = 3000; // fixed camera height (volcano summit ≈ 1253 u)
const LIVE_REFRESH_MS = 66; // ~15 Hz world re-render
const FULL_RT_SIZE = 1536; // full-map top-down render resolution (whole island)
const FULL_CAM_Y = 4000; // above the volcano summit for the whole-island shot
/** Scene-graph names hidden from the map pass (trees read as noise from above;
 *  swap for a dimmed-opacity pass later if preferred). */
const LIVE_HIDE = new Set(["island-trees", "island-foliage"]);

export class IslandMap {
  private readonly root: HTMLDivElement;
  private readonly mm: HTMLCanvasElement;
  private readonly mmc: CanvasRenderingContext2D;
  private img = new Image();
  private ready = false;

  private px = 0;
  private pz = 0;
  private yaw = 0;
  private acc = 0; // redraw throttle

  private revealed = new Set<string>();
  private fog: HTMLCanvasElement;
  private cellFrac: number; // one 500 m cell as a fraction of the image

  private full?: HTMLDivElement;
  private fullCanvas?: HTMLCanvasElement;
  private view = { scale: 1, tx: 0, ty: 0, base: 1 };
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchPrev = 0;
  private unsubSettings: () => void;

  // Live top-down minimap (see renderLive). Present only when a world scene
  // was passed; otherwise the minimap falls back to the baked map image.
  private rt?: THREE.WebGLRenderTarget;
  private liveCam?: THREE.OrthographicCamera;
  private compScene?: THREE.Scene;
  private compCam?: THREE.OrthographicCamera;
  private liveMesh?: THREE.Mesh;
  private lastLive = 0;
  private readonly vp = new THREE.Vector4();
  // Full-map live snapshot: a one-off top-down render of the WHOLE island into
  // a canvas (drawn by the 2D full-map compositor in place of the baked photo).
  private fullRT?: THREE.WebGLRenderTarget;
  private fullCamO?: THREE.OrthographicCamera;
  private fullImg?: HTMLCanvasElement;
  private fullDirty = false;

  constructor(
    private readonly parent: HTMLElement,
    private readonly world?: THREE.Scene,
  ) {
    injectStyles();
    this.cellFrac = CELL_M / METERS_PER_UNIT / ISLAND_SPAN;
    this.fog = document.createElement("canvas");
    this.fog.width = this.fog.height = FOG_W;
    this.loadFog();

    this.root = document.createElement("div");
    this.root.className = "be-imap";
    this.applyCorner(getSettings().minimapCorner);
    this.unsubSettings = subscribeSettings((s) => this.applyCorner(s.minimapCorner));
    this.mm = document.createElement("canvas");
    this.mm.className = "be-imap__cv";
    this.root.appendChild(this.mm);
    const range = document.createElement("div");
    range.className = "be-imap__range";
    range.textContent = `${MINIMAP_RANGE_M} m`;
    this.root.appendChild(range);
    parent.appendChild(this.root);
    this.mmc = this.mm.getContext("2d")!;
    this.root.addEventListener("click", () => this.openFull());

    this.img.onload = () => {
      this.ready = true;
      this.buildFog();
    };
    this.img.src = assetUrl("assets/textures/island_color.jpg");
  }

  /** Move the minimap panel to one of the four screen corners. */
  private applyCorner(corner: MinimapCorner): void {
    this.root.classList.remove("be-imap--tl", "be-imap--tr", "be-imap--bl", "be-imap--br");
    this.root.classList.add(`be-imap--${corner}`);
  }

  /** Player world position + heading (radians, PlayerController.yaw). */
  setPlayer(x: number, z: number, yaw: number): void {
    this.px = x;
    this.pz = z;
    this.yaw = yaw;
    this.reveal(x, z);
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < 0.06) return; // ~16 fps is plenty for a map
    this.acc = 0;
    this.drawMinimap();
    if (this.full) this.drawFull();
  }

  /**
   * Live minimap render passes — call AFTER the main scene render each frame
   * (see IScene.renderOverlays). Pass 1 re-renders the world top-down into a
   * small render target (throttled); pass 2 composites the heading-up circle
   * into the minimap's screen rect via viewport+scissor, leaving the corners
   * showing the 3D view underneath. All renderer state is restored.
   */
  renderLive(renderer: THREE.WebGLRenderer): void {
    if (!this.world) return;
    if (this.full) {
      // Full map open: render the whole island once into fullImg, then let the
      // 2D compositor (drawFull) pan/zoom it. The minimap HUD is hidden anyway.
      if (this.fullDirty) {
        this.renderFullSnapshot(renderer);
        this.fullDirty = false;
        this.drawFull();
      }
      return;
    }
    if (!this.rt) this.initLive();
    const rt = this.rt!;
    const now = performance.now();
    if (now - this.lastLive > LIVE_REFRESH_MS) {
      this.lastLive = now;
      const cam = this.liveCam!;
      cam.position.set(this.px, LIVE_CAM_Y, this.pz);
      cam.up.set(0, 0, -1); // world −Z (north) at the top → true aerial view
      cam.lookAt(this.px, 0, this.pz);
      const hidden: THREE.Object3D[] = [];
      this.world.traverse((o) => {
        if (LIVE_HIDE.has(o.name) && o.visible) {
          o.visible = false;
          hidden.push(o);
        }
      });
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(this.world, cam);
      renderer.setRenderTarget(prevTarget);
      for (const o of hidden) o.visible = true;
    }

    // Composite the circle, heading-up: content rotates opposite the player
    // (rotation.z = −yaw; identity when facing north).
    const rect = this.root.getBoundingClientRect();
    const el = renderer.domElement;
    if (rect.width === 0 || el.clientHeight === 0) return;
    this.liveMesh!.rotation.z = -this.yaw;
    renderer.getViewport(this.vp);
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    const y = el.clientHeight - rect.bottom; // GL viewport origin: bottom-left
    renderer.setViewport(rect.left, y, rect.width, rect.height);
    renderer.setScissor(rect.left, y, rect.width, rect.height);
    renderer.setScissorTest(true);
    renderer.render(this.compScene!, this.compCam!);
    renderer.setScissorTest(false);
    renderer.setViewport(this.vp);
    renderer.autoClear = prevAutoClear;
  }

  private initLive(): void {
    this.rt = new THREE.WebGLRenderTarget(LIVE_RT_SIZE, LIVE_RT_SIZE, {
      depthBuffer: true,
    });
    const R = MINIMAP_RANGE_M / METERS_PER_UNIT; // world units to the circle edge
    this.liveCam = new THREE.OrthographicCamera(-R, R, R, -R, 1, LIVE_CAM_Y + 2000);
    this.compScene = new THREE.Scene();
    this.compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // Unit circle in NDC: its UVs span the full RTT, so the circle shows the
    // inscribed disc — the edge of the minimap is exactly MINIMAP_RANGE_M out.
    this.liveMesh = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({ map: this.rt.texture, toneMapped: false }),
    );
    this.compScene.add(this.liveMesh);
  }

  /**
   * Render the whole island top-down into fullImg — the live equivalent of the
   * baked satellite photo, framed to EXACTLY the heightmap span so worldToIslandUV
   * (used for the fog + player marker) lines up pixel-for-pixel. Read back once
   * per map-open (terrain is static); GL rows come bottom-up so we flip into the
   * canvas to match the image-top = north convention.
   */
  private renderFullSnapshot(renderer: THREE.WebGLRenderer): void {
    const N = FULL_RT_SIZE;
    const half = ISLAND_SPAN / 2;
    if (!this.fullRT) {
      // sRGB target: readRenderTargetPixels then returns display-ready bytes, so
      // blitting them to the 2D map canvas keeps the terrain's real brightness
      // (a linear target would read back dark once shown as sRGB).
      this.fullRT = new THREE.WebGLRenderTarget(N, N, {
        depthBuffer: true,
        colorSpace: THREE.SRGBColorSpace,
      });
      this.fullCamO = new THREE.OrthographicCamera(-half, half, half, -half, 1, FULL_CAM_Y + 1000);
    }
    const cam = this.fullCamO!;
    cam.position.set(ISLAND_CENTER.x, FULL_CAM_Y, ISLAND_CENTER.z);
    cam.up.set(0, 0, -1); // world −Z (north) at the top
    cam.lookAt(ISLAND_CENTER.x, 0, ISLAND_CENTER.z);
    cam.updateProjectionMatrix();

    const hidden: THREE.Object3D[] = [];
    this.world!.traverse((o) => {
      if (LIVE_HIDE.has(o.name) && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    });
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.fullRT);
    renderer.render(this.world!, cam);
    const buf = new Uint8Array(N * N * 4);
    renderer.readRenderTargetPixels(this.fullRT, 0, 0, N, N, buf);
    renderer.setRenderTarget(prev);
    for (const o of hidden) o.visible = true;

    if (!this.fullImg) {
      this.fullImg = document.createElement("canvas");
      this.fullImg.width = this.fullImg.height = N;
    }
    const ctx = this.fullImg.getContext("2d")!;
    const id = ctx.createImageData(N, N);
    const row = N * 4;
    for (let y = 0; y < N; y++) {
      id.data.set(buf.subarray((N - 1 - y) * row, (N - y) * row), y * row);
    }
    ctx.putImageData(id, 0, 0);
  }

  /** The full map's image source: the live island snapshot when available,
   *  else the baked satellite photo. */
  private fullSource(): HTMLCanvasElement | HTMLImageElement {
    return this.world ? (this.fullImg ??= this.blankFull()) : this.img;
  }
  private blankFull(): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = cv.height = FULL_RT_SIZE;
    return cv;
  }

  /** Clear all exploration (fog back to nothing). */
  reset(): void {
    this.revealed.clear();
    try {
      localStorage.removeItem(FOG_KEY);
    } catch {
      /* ignore */
    }
    this.buildFog();
  }

  // ── fog of war ─────────────────────────────────────────────────────────────
  private loadFog(): void {
    try {
      const raw = localStorage.getItem(FOG_KEY);
      if (raw) for (const k of JSON.parse(raw) as string[]) this.revealed.add(k);
    } catch {
      /* ignore */
    }
  }
  private saveFog(): void {
    try {
      localStorage.setItem(FOG_KEY, JSON.stringify([...this.revealed]));
    } catch {
      /* ignore */
    }
  }
  private reveal(x: number, z: number): void {
    if (REVEAL_ALL) return;
    const { u, v } = worldToIslandUV(x, z);
    const key = `${Math.floor(u / this.cellFrac)},${Math.floor(v / this.cellFrac)}`;
    if (this.revealed.has(key)) return;
    this.revealed.add(key);
    this.saveFog();
    this.buildFog();
  }
  /** Repaint the fog mask: opaque dark over unexplored 500 m cells. */
  private buildFog(): void {
    const c = this.fog.getContext("2d")!;
    c.clearRect(0, 0, FOG_W, FOG_W);
    if (REVEAL_ALL) return; // fully revealed → no mask
    const cell = this.cellFrac * FOG_W;
    const n = Math.ceil(1 / this.cellFrac);
    c.fillStyle = "rgba(6,12,20,0.92)";
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (this.revealed.has(`${i},${j}`)) continue;
        c.fillRect(i * cell, j * cell, cell + 1, cell + 1);
      }
    }
  }

  // ── minimap ──────────────────────────────────────────────────────────────
  private drawMinimap(): void {
    const c = this.mmc;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = this.root.clientWidth;
    if (size === 0) return;
    // Size the backing store to the CSS box × dpr. Check BOTH dimensions: a fresh
    // canvas defaults to 300×150, and on a 2× display size*dpr can equal 300,
    // so a width-only guard would leave the canvas a non-square 300×150 (which
    // squished the map into the left half). Always (re)set the transform, since
    // assigning canvas.width/height resets the context.
    const need = Math.round(size * dpr);
    if (this.mm.width !== need || this.mm.height !== need) {
      this.mm.width = need;
      this.mm.height = need;
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, size, size);
    const cc = size / 2;
    c.save();
    c.beginPath();
    c.arc(cc, cc, cc, 0, Math.PI * 2);
    c.clip();
    // Live mode: the map content is GL-composited underneath (see renderLive),
    // so this canvas keeps its disc transparent and only draws the HUD chrome
    // (frame ring, N marker, player triangle) on top.
    if (!this.world) {
      c.fillStyle = "#12303a";
      c.fillRect(0, 0, size, size);
    }

    if (this.ready && !this.world) {
      const { u, v } = worldToIslandUV(this.px, this.pz);
      const frac = MINIMAP_RANGE_M / METERS_PER_UNIT / ISLAND_SPAN; // radius as image fraction
      // Heading-up: with the map a TRUE aerial view (image-top = −Z = north,
      // see worldToIslandUV), the derivation is textbook. Player forward is
      // f = (−sin ψ, −cos ψ) and right is r = (cos ψ, −sin ψ); a canvas offset
      // (dx, dy) must show the world point dx·r − dy·f, whose image offset is
      // k·[[cos ψ, sin ψ],[−sin ψ, cos ψ]]·(dx, dy). Inverting for the draw
      // gives the pure rotation R(ψ) — identity when facing north.
      const cy = Math.cos(this.yaw);
      const sy = Math.sin(this.yaw);
      const layer = (src: HTMLImageElement | HTMLCanvasElement, dim: number) => {
        const sc = cc / (frac * dim); // image px → canvas px so the edge = range
        c.save();
        c.translate(cc, cc);
        c.transform(cy, sy, -sy, cy, 0, 0);
        c.scale(sc, sc);
        c.drawImage(src, -u * dim, -v * dim); // whole layer, player pixel at origin
        c.restore();
      };
      layer(this.img, this.img.width);
      layer(this.fog, FOG_W);
    }
    c.restore();

    // Frame.
    c.strokeStyle = "rgba(120,200,255,0.85)";
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cc, cc, cc - 1, 0, Math.PI * 2);
    c.stroke();
    // North marker — where compass-north (−Z) lies on the heading-up map:
    // R(ψ) applied to image-up gives (sin ψ, −cos ψ). Facing north → marker
    // at the top, turn right → north slides left, matching the crop.
    const nx = Math.sin(this.yaw);
    const ny = -Math.cos(this.yaw);
    c.fillStyle = "rgba(200,230,255,0.9)";
    c.font = "bold 11px ui-monospace, monospace";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("N", cc + nx * (cc - 11), cc + ny * (cc - 11));
    c.textBaseline = "alphabetic";

    // Player marker: fixed upward triangle (heading-up → you always face the top).
    c.fillStyle = "rgba(80,255,120,1)";
    c.strokeStyle = "rgba(0,0,0,0.5)";
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(cc, cc - 8);
    c.lineTo(cc - 6, cc + 6);
    c.lineTo(cc + 6, cc + 6);
    c.closePath();
    c.fill();
    c.stroke();
  }

  // ── full-screen map ────────────────────────────────────────────────────────
  private openFull(): void {
    if (this.full || (!this.ready && !this.world)) return;
    // Live mode: re-render the whole island on open (renderLive picks this up).
    this.fullDirty = !!this.world;
    const full = document.createElement("div");
    full.className = "be-imap__full";
    const cv = document.createElement("canvas");
    cv.className = "be-imap__fullcv";
    full.appendChild(cv);
    const close = document.createElement("button");
    close.className = "be-imap__close";
    close.textContent = "✕";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeFull();
    });
    full.appendChild(close);
    const reset = document.createElement("button");
    reset.className = "be-imap__reset";
    reset.textContent = "↺ fog";
    reset.addEventListener("click", (e) => {
      e.stopPropagation();
      this.reset();
      this.drawFull();
    });
    full.appendChild(reset);
    this.parent.appendChild(full);
    this.full = full;
    this.fullCanvas = cv;

    // Fit the map image to the viewport (contain), centred.
    const src = this.fullSource();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.view.base = Math.min(vw / src.width, vh / src.height);
    this.view.scale = 1;
    this.view.tx = (vw - src.width * this.view.base) / 2;
    this.view.ty = (vh - src.height * this.view.base) / 2;
    this.bindFullGestures(cv);
    this.drawFull();
  }

  private closeFull(): void {
    this.full?.remove();
    this.full = undefined;
    this.fullCanvas = undefined;
    this.pointers.clear();
  }

  private drawFull(): void {
    const cv = this.fullCanvas;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nw = Math.round(vw * dpr);
    const nh = Math.round(vh * dpr);
    if (cv.width !== nw || cv.height !== nh) {
      cv.width = nw;
      cv.height = nh;
    }
    const c = cv.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, vw, vh);
    c.fillStyle = "#0a1420";
    c.fillRect(0, 0, vw, vh);
    const src = this.fullSource();
    const s = this.view.base * this.view.scale;
    const iw = src.width * s;
    const ih = src.height * s;
    c.drawImage(src, this.view.tx, this.view.ty, iw, ih);
    c.drawImage(this.fog, this.view.tx, this.view.ty, iw, ih);
    // Player marker.
    const { u, v } = worldToIslandUV(this.px, this.pz);
    drawArrow(c, this.view.tx + u * iw, this.view.ty + v * ih, this.yaw, 11);
  }

  private bindFullGestures(cv: HTMLCanvasElement): void {
    cv.style.touchAction = "none";
    const down = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pinchPrev = 0;
    };
    const move = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const pts = [...this.pointers.values()];
      if (this.pointers.size >= 2) {
        // Pinch: scale about the midpoint of the two pointers.
        const [a, b] = pts;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (this.pinchPrev > 0) {
          const k = dist / this.pinchPrev;
          const ns = Math.max(1, Math.min(8, this.view.scale * k));
          const applied = ns / this.view.scale;
          this.view.tx = mid.x - (mid.x - this.view.tx) * applied;
          this.view.ty = mid.y - (mid.y - this.view.ty) * applied;
          this.view.scale = ns;
        }
        this.pinchPrev = dist;
      } else {
        // Pan.
        this.view.tx += e.clientX - p.x;
        this.view.ty += e.clientY - p.y;
      }
      p.x = e.clientX;
      p.y = e.clientY;
      this.drawFull();
    };
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinchPrev = 0;
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
  }

  dispose(): void {
    this.unsubSettings();
    this.closeFull();
    this.root.remove();
    this.rt?.dispose();
    this.fullRT?.dispose();
    if (this.liveMesh) {
      this.liveMesh.geometry.dispose();
      (this.liveMesh.material as THREE.Material).dispose();
    }
  }
}

/** A green facing arrow at (x,y); heading = PlayerController.yaw (radians). */
function drawArrow(c: CanvasRenderingContext2D, x: number, y: number, yaw: number, r: number): void {
  // World forward = (-sin yaw, -cos yaw); the map is a true aerial view
  // (image-top = −Z north, image y grows with world +z), so canvas dir maps
  // 1:1 — (fx, fz).
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const dx = fx;
  const dy = fz;
  const px = -dy;
  const py = dx;
  c.fillStyle = "rgba(80,255,120,1)";
  c.strokeStyle = "rgba(0,0,0,0.5)";
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(x + dx * r, y + dy * r);
  c.lineTo(x - dx * r * 0.7 + px * r * 0.7, y - dy * r * 0.7 + py * r * 0.7);
  c.lineTo(x - dx * r * 0.7 - px * r * 0.7, y - dy * r * 0.7 - py * r * 0.7);
  c.closePath();
  c.fill();
  c.stroke();
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.be-imap {
  position: absolute; width: 150px; height: 150px;
  border-radius: 50%; cursor: pointer; z-index: 60; pointer-events: auto;
  box-shadow: 0 6px 22px rgba(0,0,0,0.5); -webkit-tap-highlight-color: transparent;
}
/* Corner presets. Top corners clear the gear / inventory buttons a little. */
.be-imap--tl { top: 14px; left: 14px; }
.be-imap--tr { top: 74px; right: 14px; }
.be-imap--bl { bottom: 14px; left: 14px; }
.be-imap--br { bottom: 14px; right: 14px; }
.be-imap__cv { width: 100%; height: 100%; display: block; border-radius: 50%; }
.be-imap__range {
  position: absolute; right: 6px; bottom: 6px; padding: 1px 6px; border-radius: 8px;
  background: rgba(6,12,20,0.6); color: #cfe8ff; font: 600 10px/1.4 ui-monospace, monospace;
}
@media (max-width: 640px) { .be-imap { width: 112px; height: 112px; } }

.be-imap__full {
  position: fixed; inset: 0; z-index: 100; background: rgba(4,8,14,0.96);
  pointer-events: auto; touch-action: none;
}
.be-imap__fullcv { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.be-imap__close, .be-imap__reset {
  position: absolute; top: 14px; height: 40px; border-radius: 10px; cursor: pointer;
  background: rgba(14,22,32,0.9); border: 1px solid rgba(120,200,255,0.3);
  color: #e8f3ff; font: 600 15px/1 ui-monospace, monospace; padding: 0 14px;
}
.be-imap__close { right: 14px; width: 40px; padding: 0; }
.be-imap__reset { right: 66px; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
