import type { AudioManager } from "./AudioManager";
import {
  getSettings,
  resetSettings,
  setSettings,
  SETTINGS_RANGES,
  type GameplaySettings,
} from "./Settings";

interface OpenOptions {
  parent: HTMLElement;
  audio?: AudioManager;
  onClose?: () => void;
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
export function openSettingsPanel({ parent, audio, onClose }: OpenOptions): void {
  if (openEl) return;

  const el = document.createElement("div");
  el.className = "be-settings";
  el.innerHTML = `
    <div class="be-settings__panel" role="dialog" aria-label="Camera settings">
      <h2>Camera</h2>
      <p class="be-settings__hint">Adjust live — your changes are saved automatically.</p>
      <label class="be-field" data-key="fov">
        <span class="be-field__row"><span>Field of view</span><b data-readout></b></span>
        <input type="range" />
      </label>
      <label class="be-field" data-key="zoom">
        <span class="be-field__row"><span>Zoom (higher = closer)</span><b data-readout></b></span>
        <input type="range" />
      </label>
      <div class="be-settings__actions">
        <button class="be-btn" data-action="reset">Reset</button>
        <button class="be-btn be-btn--primary" data-action="close">Done</button>
      </div>
    </div>`;
  parent.appendChild(el);
  openEl = el;
  requestAnimationFrame(() => el.classList.add("show"));

  const syncers: Record<keyof GameplaySettings, (v: number) => void> = {
    fov: setupField("fov", (v) => `${Math.round(v)}°`),
    zoom: setupField("zoom", (v) => `${v.toFixed(2)}×`),
  };

  function setupField(
    key: keyof GameplaySettings,
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

  el.querySelector('[data-action="close"]')?.addEventListener("click", () => close());
  el.querySelector('[data-action="reset"]')?.addEventListener("click", () => {
    audio?.playSfx("ui-select");
    const s = resetSettings();
    syncers.fov(s.fov);
    syncers.zoom(s.zoom);
  });
  el.addEventListener("click", (e) => {
    if (e.target === el) close();
  });
}
