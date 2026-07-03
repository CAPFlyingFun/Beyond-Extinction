import * as THREE from "three";
import type { IScene, SceneContext, SceneFactory } from "../engine/IScene";
import { CameraManager } from "../engine/CameraManager";
import { assetUrl } from "../engine/assets";
import { createJournalIntroScene } from "./JournalIntroScene";
import { openSettingsPanel, closeSettingsPanel } from "../engine/SettingsPanel";

const SPLASH_LANDSCAPE = assetUrl("assets/branding/splash-landscape.jpg");
const SPLASH_PORTRAIT = assetUrl("assets/branding/splash-portrait.jpg");

/**
 * Title screen. The branded key art is the backdrop (portrait art on tall
 * screens, landscape art on wide ones) with the menu overlaid. The 3D scene is
 * intentionally empty — the opaque splash covers the whole viewport, so
 * rendering a live vista behind it would only waste GPU/battery on phones.
 *
 * The menu works in either orientation. Because the game plays best in
 * landscape, pressing New Game while a phone is held in portrait triggers a
 * best-effort orientation lock and, if that can't be enforced (iOS), a
 * "rotate your device" prompt that clears once the player turns to landscape.
 * The gate runs here on the menu, *before* any gameplay clock starts, so it
 * never pauses a running scene.
 */
class MainMenuScene implements IScene {
  readonly name = "main-menu";
  readonly scene = new THREE.Scene();
  private cam: CameraManager;
  get camera(): THREE.Camera {
    return this.cam.camera;
  }

  private menuEl?: HTMLDivElement;
  private backdropEl?: HTMLDivElement;
  private creditsEl?: HTMLDivElement;
  private rotateEl?: HTMLDivElement;
  /** Tears down the rotate gate's listeners/timers and unblocks its promise. */
  private rotateCleanup?: () => void;
  private starting = false;
  private disposed = false;

  constructor(private ctx: SceneContext) {
    this.cam = new CameraManager(50, 0.1, 3000);
  }

  enter(): void {
    this.scene.background = new THREE.Color(0x05070d);
    this.cam.place({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });

    this.ctx.audio.playMusic("main-theme");

    this.buildBackdrop();
    this.buildMenu();
  }

  private buildBackdrop(): void {
    const el = document.createElement("div");
    el.className = "be-splash-bg";
    this.ctx.uiLayer.appendChild(el);
    this.backdropEl = el;
    this.updateBackdrop();
    requestAnimationFrame(() => el.classList.add("show"));
  }

  private updateBackdrop(): void {
    if (!this.backdropEl) return;
    const url = this.isPortrait() ? SPLASH_PORTRAIT : SPLASH_LANDSCAPE;
    this.backdropEl.style.backgroundImage = `url("${url}")`;
  }

  /** True when the viewport is taller than it is wide (device in portrait). */
  private isPortrait(): boolean {
    if (window.matchMedia) {
      return window.matchMedia("(orientation: portrait)").matches;
    }
    return window.innerHeight > window.innerWidth;
  }

  /**
   * Real touch device (phone/tablet) — deliberately stricter than
   * InputManager.isTouch, which also flags narrow desktop windows. We only want
   * to nudge users who can actually rotate a device toward landscape.
   */
  private isMobile(): boolean {
    return (
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      navigator.maxTouchPoints > 0
    );
  }

  private buildMenu(): void {
    const el = document.createElement("div");
    el.className = "be-menu";
    el.innerHTML = `
      <div class="be-menu__buttons">
        <button class="be-btn" data-action="continue">Continue</button>
        <button class="be-btn be-btn--primary" data-action="new">New Game</button>
        <button class="be-btn" data-action="load">Load Game</button>
        <button class="be-btn" data-action="settings">Settings</button>
        <button class="be-btn" data-action="credits">Credits</button>
      </div>
      <div class="be-menu__footer">
        <span>PWA Engine · Prologue</span>
        <span>Three.js · v${__APP_VERSION__}</span>
      </div>`;
    this.ctx.uiLayer.appendChild(el);
    this.menuEl = el;
    requestAnimationFrame(() => el.classList.add("show"));

    el.querySelector('[data-action="new"]')?.addEventListener("click", () => {
      this.ctx.audio.playSfx("ui-confirm");
      this.startNewGame();
    });

    for (const action of ["continue", "load"]) {
      el.querySelector(`[data-action="${action}"]`)?.addEventListener("click", () => {
        this.ctx.audio.playSfx("ui-select");
        this.ctx.overlays.showToast(`${this.label(action)} — Coming Soon`);
      });
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
          <p><span>PWA Direction</span>Installable, offline-capable web app</p>
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
    if (this.starting) return; // ignore double-taps
    this.starting = true;
    this.menuEl
      ?.querySelectorAll("button")
      .forEach((b) => ((b as HTMLButtonElement).disabled = true));

    // Fire the orientation lock immediately, while the click gesture is still
    // "active" — fullscreen/lock requests are rejected outside a user gesture.
    const lock = this.tryLockLandscape();

    this.menuEl?.classList.remove("show");
    this.backdropEl?.classList.remove("show");
    await new Promise((r) => setTimeout(r, 600));
    if (this.disposed) return;

    await lock;
    if (this.disposed) return;

    // If the platform couldn't force landscape (iOS ignores the API), ask the
    // player to rotate. The gate also offers a "Continue anyway" escape so a
    // device that never reports landscape can never be permanently stuck.
    if (this.isMobile() && this.isPortrait()) {
      await this.waitForLandscape();
    }
    if (this.disposed) return;

    this.ctx.scenes.goTo(createJournalIntroScene);
  }

  /**
   * Best-effort landscape lock. Requests fullscreen (required by Chrome/Android
   * before an orientation lock is allowed) then locks to landscape. Every step
   * is wrapped so unsupported platforms (notably iOS Safari) simply fall
   * through to the manual rotate prompt instead of throwing.
   */
  private async tryLockLandscape(): Promise<void> {
    if (!this.isMobile()) return;
    try {
      const root = document.documentElement as HTMLElement & {
        requestFullscreen?: (opts?: unknown) => Promise<void>;
      };
      if (!document.fullscreenElement && typeof root.requestFullscreen === "function") {
        await root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
      }
      const orientation = screen.orientation as
        | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
        | undefined;
      if (orientation && typeof orientation.lock === "function") {
        await orientation.lock("landscape").catch(() => {});
      }
    } catch {
      /* Unsupported (iOS) — the rotate prompt handles it. */
    }
  }

  /**
   * Full-screen "please rotate" gate. Resolves when the device turns landscape
   * OR the player taps "Continue anyway" (revealed after a short delay so we ask
   * for rotation first but never hard-block a device that can't rotate). It is
   * fully cancellable via `rotateCleanup` so `dispose()` can't leave dangling
   * window listeners, timers, or an unresolved promise.
   */
  private waitForLandscape(): Promise<void> {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "be-rotate";
      overlay.innerHTML = `
        <div class="be-rotate__inner">
          <div class="be-rotate__phone"></div>
          <div class="be-rotate__title">Rotate your device</div>
          <p class="be-rotate__hint">Beyond Extinction plays best in landscape.</p>
          <button class="be-btn be-rotate__skip" data-action="skip">Continue anyway</button>
        </div>`;
      this.ctx.uiLayer.appendChild(overlay);
      this.rotateEl = overlay;
      requestAnimationFrame(() => overlay.classList.add("show"));

      const skipBtn = overlay.querySelector<HTMLButtonElement>('[data-action="skip"]');
      let settleTimer = 0;
      let removeTimer = 0;
      let skipReveal = 0;

      const teardown = () => {
        window.removeEventListener("resize", check);
        window.removeEventListener("orientationchange", check);
        window.clearTimeout(skipReveal);
        this.rotateCleanup = undefined;
      };

      // Graceful path: fade the overlay, settle the viewport, then resolve.
      const finish = () => {
        teardown();
        overlay.classList.remove("show");
        removeTimer = window.setTimeout(() => {
          overlay.remove();
          if (this.rotateEl === overlay) this.rotateEl = undefined;
        }, 300);
        // Give the browser a beat to settle the new viewport size before the
        // next scene reads it for camera framing.
        settleTimer = window.setTimeout(resolve, 360);
      };

      const check = () => {
        if (!this.isPortrait()) finish();
      };

      // Hard cancel for dispose(): drop everything immediately and unblock the
      // promise so startNewGame() can fall through its `disposed` guard.
      this.rotateCleanup = () => {
        teardown();
        window.clearTimeout(settleTimer);
        window.clearTimeout(removeTimer);
        overlay.remove();
        if (this.rotateEl === overlay) this.rotateEl = undefined;
        resolve();
      };

      window.addEventListener("resize", check);
      window.addEventListener("orientationchange", check);
      skipBtn?.addEventListener("click", () => {
        this.ctx.audio.playSfx("ui-select");
        finish();
      });
      skipReveal = window.setTimeout(() => skipBtn?.classList.add("show"), 3500);
    });
  }

  update(dt: number, elapsed: number): void {
    this.cam.update(dt, elapsed);
  }

  resize(width: number, height: number): void {
    this.cam.resize(width, height);
    this.updateBackdrop();
  }

  dispose(): void {
    this.disposed = true;
    // Cancel any in-flight rotate gate: removes window listeners/timers and
    // resolves its promise so startNewGame() exits via its `disposed` guard.
    this.rotateCleanup?.();
    closeSettingsPanel();
    this.menuEl?.remove();
    this.backdropEl?.remove();
    this.creditsEl?.remove();
    this.rotateEl?.remove();
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
