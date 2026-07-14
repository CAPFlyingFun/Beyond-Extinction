import type { AudioManager } from "./AudioManager";
import { openHudEditor } from "./HudEditor";
import { Progression } from "./Progression";
import {
  getSettings,
  resetSettings,
  setSettings,
  SETTINGS_RANGES,
  GRAPHICS_QUALITIES,
  GRAPHICS_QUALITY_LABELS,
  type GameplaySettings,
  type GraphicsQuality,
} from "./Settings";

interface OpenOptions {
  parent: HTMLElement;
  audio?: AudioManager;
  onClose?: () => void;
  /** Fired when the Unlimited Mode toggle changes (island updates the boundary). */
  onUnlimitedChange?: (on: boolean) => void;
}

let openEl: HTMLDivElement | null = null;
let activeTeardown: ((immediate: boolean) => void) | null = null;

/** Whether a settings panel is currently mounted. */
export function isSettingsPanelOpen(): boolean {
  return openEl !== null;
}

/**
 * Force the open panel (if any) to tear down immediately, without animation or
 * sound. Scenes call this on dispose so the modal and its global key listener
 * can never leak across a scene transition.
 */
export function closeSettingsPanel(): void {
  activeTeardown?.(true);
}

/**
 * Open the camera settings modal. Single-instance: a second call while one is
 * open is a no-op, so the menu button and the in-game gear can't stack panels.
 * Sliders write to the persisted settings store live, so any subscribed camera
 * updates immediately.
 */
export function openSettingsPanel({ parent, audio, onClose, onUnlimitedChange }: OpenOptions): void {
  if (openEl) return;

  const el = document.createElement("div");
  el.className = "be-settings";
  el.innerHTML = `
    <div class="be-settings__panel" role="dialog" aria-label="Game settings">
      <h2>Settings</h2>
      <p class="be-settings__hint">Adjust live — your changes are saved automatically.</p>
      <label class="be-toggle" data-key="autoPlay">
        <span class="be-toggle__text">
          <span class="be-toggle__title">Auto Play</span>
          <span class="be-toggle__hint">Routine actions play themselves. You still choose at key moments.</span>
        </span>
        <input type="checkbox" />
        <span class="be-toggle__switch" aria-hidden="true"></span>
      </label>
      <label class="be-toggle" data-key="subtitles">
        <span class="be-toggle__text">
          <span class="be-toggle__title">Subtitles (CC)</span>
          <span class="be-toggle__hint">Show captions under voiced dialogue and narration.</span>
        </span>
        <input type="checkbox" />
        <span class="be-toggle__switch" aria-hidden="true"></span>
      </label>
      <label class="be-toggle" data-key="unlimited">
        <span class="be-toggle__text">
          <span class="be-toggle__title">Unlimited Mode</span>
          <span class="be-toggle__hint">Testing: remove the chapter story boundary and open the whole island.</span>
        </span>
        <input type="checkbox" />
        <span class="be-toggle__switch" aria-hidden="true"></span>
      </label>
      <label class="be-field" data-key="fov">
        <span class="be-field__row"><span>Field of view</span><b data-readout></b></span>
        <input type="range" />
      </label>
      <label class="be-field" data-key="zoom">
        <span class="be-field__row"><span>Zoom (higher = closer)</span><b data-readout></b></span>
        <input type="range" />
      </label>
      <label class="be-field" data-key="lookSensitivity">
        <span class="be-field__row"><span>Camera speed (press &amp; swipe)</span><b data-readout></b></span>
        <input type="range" />
      </label>
      <div class="be-field" data-key="minimapCorner">
        <span class="be-field__row"><span>Minimap position</span></span>
        <div class="be-seg" role="group" aria-label="Minimap position">
          <button type="button" data-corner="tl">Top Left</button>
          <button type="button" data-corner="tr">Top Right</button>
        </div>
      </div>
      <label class="be-field" data-key="graphicsQuality">
        <span class="be-field__row"><span>Graphics quality (tree detail)</span></span>
        <select class="be-select"></select>
      </label>
      <label class="be-toggle" data-key="showFps">
        <span class="be-toggle__text">
          <span class="be-toggle__title">Show FPS</span>
          <span class="be-toggle__hint">Small framerate readout in the top-left corner.</span>
        </span>
        <input type="checkbox" />
        <span class="be-toggle__switch" aria-hidden="true"></span>
      </label>
      <div class="be-field" data-key="hudLayout">
        <span class="be-field__row"><span>HUD layout</span></span>
        <button type="button" class="be-btn be-btn--wide" data-action="hudedit">Edit HUD Layout</button>
      </div>
      <div class="be-settings__actions">
        <button class="be-btn" data-action="reset">Reset</button>
        <button class="be-btn be-btn--primary" data-action="close">Done</button>
      </div>
    </div>`;
  parent.appendChild(el);
  openEl = el;
  requestAnimationFrame(() => el.classList.add("show"));

  const syncers = {
    fov: setupField("fov", (v) => `${Math.round(v)}°`),
    zoom: setupField("zoom", (v) => `${v.toFixed(2)}×`),
    // Show the slider as a friendly 1–10 scale rather than raw radians/pixel.
    lookSensitivity: setupField("lookSensitivity", (v) => {
      const r = SETTINGS_RANGES.lookSensitivity;
      return `${Math.round(((v - r.min) / (r.max - r.min)) * 9 + 1)}`;
    }),
  };

  // Auto Play is a boolean, so it lives outside the numeric slider machinery.
  const autoPlayInput = el.querySelector(
    '[data-key="autoPlay"] input',
  ) as HTMLInputElement;
  const syncAutoPlay = (on: boolean): void => {
    autoPlayInput.checked = on;
  };
  syncAutoPlay(getSettings().autoPlay);
  autoPlayInput.addEventListener("change", () => {
    setSettings({ autoPlay: autoPlayInput.checked });
  });

  // Subtitles (CC) — another boolean toggle.
  const subtitlesInput = el.querySelector(
    '[data-key="subtitles"] input',
  ) as HTMLInputElement;
  const syncSubtitles = (on: boolean): void => {
    subtitlesInput.checked = on;
  };
  syncSubtitles(getSettings().subtitles);
  subtitlesInput.addEventListener("change", () => {
    setSettings({ subtitles: subtitlesInput.checked });
  });

  // Unlimited Mode — persisted campaign flag (Progression), not a camera setting.
  const unlimitedInput = el.querySelector(
    '[data-key="unlimited"] input',
  ) as HTMLInputElement;
  unlimitedInput.checked = Progression.unlimitedMode;
  unlimitedInput.addEventListener("change", () => {
    Progression.setUnlimited(unlimitedInput.checked);
    onUnlimitedChange?.(unlimitedInput.checked);
  });

  // Graphics quality — a preset picker that fixes the tree draw distance (or
  // "auto" to scale it with the framerate).
  const qualitySelect = el.querySelector(
    '[data-key="graphicsQuality"] select',
  ) as HTMLSelectElement;
  for (const q of GRAPHICS_QUALITIES) {
    const opt = document.createElement("option");
    opt.value = q;
    opt.textContent = GRAPHICS_QUALITY_LABELS[q];
    qualitySelect.appendChild(opt);
  }
  const syncQuality = (q: GraphicsQuality): void => {
    qualitySelect.value = q;
  };
  syncQuality(getSettings().graphicsQuality);
  qualitySelect.addEventListener("change", () => {
    setSettings({ graphicsQuality: qualitySelect.value as GraphicsQuality });
  });

  // Show FPS — a boolean toggle.
  const showFpsInput = el.querySelector(
    '[data-key="showFps"] input',
  ) as HTMLInputElement;
  const syncShowFps = (on: boolean): void => {
    showFpsInput.checked = on;
  };
  syncShowFps(getSettings().showFps);
  showFpsInput.addEventListener("change", () => {
    setSettings({ showFps: showFpsInput.checked });
  });

  // Minimap position — a 4-way corner preset (segmented buttons).
  const cornerBtns = Array.from(
    el.querySelectorAll<HTMLButtonElement>('[data-key="minimapCorner"] [data-corner]'),
  );
  const syncCorner = (corner: string): void => {
    for (const b of cornerBtns) b.classList.toggle("active", b.dataset.corner === corner);
  };
  syncCorner(getSettings().minimapCorner);
  for (const b of cornerBtns) {
    b.addEventListener("click", () => {
      const corner = b.dataset.corner as GameplaySettings["minimapCorner"];
      setSettings({ minimapCorner: corner });
      syncCorner(corner);
    });
  }

  function setupField(
    key: "fov" | "zoom" | "lookSensitivity",
    format: (v: number) => string,
  ): (v: number) => void {
    const wrap = el.querySelector(`[data-key="${key}"]`) as HTMLElement;
    const input = wrap.querySelector("input") as HTMLInputElement;
    const readout = wrap.querySelector("[data-readout]") as HTMLElement;
    const range = SETTINGS_RANGES[key];
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    const sync = (v: number) => {
      input.value = String(v);
      readout.textContent = format(v);
    };
    sync(getSettings()[key]);
    input.addEventListener("input", () => {
      const next = setSettings({ [key]: parseFloat(input.value) } as Partial<GameplaySettings>);
      readout.textContent = format(next[key]);
    });
    return sync;
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  function close(immediate = false, silent = false): void {
    if (!openEl) return;
    if (!silent) audio?.playSfx("ui-select");
    document.removeEventListener("keydown", onKey);
    activeTeardown = null;
    openEl = null;
    el.classList.remove("show");
    const finish = () => {
      el.remove();
      onClose?.();
    };
    if (immediate) finish();
    else setTimeout(finish, 250);
  }
  activeTeardown = (immediate) => close(immediate, immediate);

  // HUD layout editor — close the panel first so the full-screen editor has
  // the stage to itself (CODM-style: drag to move, tap to resize, save).
  el.querySelector('[data-action="hudedit"]')?.addEventListener("click", () => {
    audio?.playSfx("ui-select");
    close(true, true);
    openHudEditor({ parent, audio });
  });

  el.querySelector('[data-action="close"]')?.addEventListener("click", () => close());
  el.querySelector('[data-action="reset"]')?.addEventListener("click", () => {
    audio?.playSfx("ui-select");
    const s = resetSettings();
    syncers.fov(s.fov);
    syncers.zoom(s.zoom);
    syncers.lookSensitivity(s.lookSensitivity);
    syncAutoPlay(s.autoPlay);
    syncSubtitles(s.subtitles);
    syncCorner(s.minimapCorner);
    syncQuality(s.graphicsQuality);
    syncShowFps(s.showFps);
  });
  el.addEventListener("click", (e) => {
    if (e.target === el) close();
  });
}
