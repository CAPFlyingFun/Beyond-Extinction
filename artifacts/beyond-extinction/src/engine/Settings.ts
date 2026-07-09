/**
 * Persisted, player-facing gameplay camera settings. A tiny observable store
 * backed by localStorage so preferences survive reloads. Scenes read the
 * current values and subscribe for live updates while the settings panel is
 * open. These apply to the gameplay camera only — the menu's cinematic shot is
 * authored and intentionally left untouched.
 */
export interface GameplaySettings {
  /** Vertical field of view (degrees) for the gameplay camera. */
  fov: number;
  /** Camera zoom multiplier. Higher = closer (more zoomed in). */
  zoom: number;
  /**
   * Auto Play: routine ACTION beats (walk to an objective, pick something up)
   * play themselves so the story flows hands-free. Genuine CHOICES always still
   * pause for the player — Auto Play never decides the story for you.
   */
  autoPlay: boolean;
  /**
   * First-person look sensitivity (radians per pixel of drag). Higher = the
   * press-and-swipe camera turns faster. Player-tunable so the pan feel isn't
   * one-size-fits-all.
   */
  lookSensitivity: number;
  /**
   * Closed captions: show the cinematic lower-third subtitles under voiced
   * dialogue and narration. OFF by default — the story is fully voiced, so
   * captions are opt-in for players who want the text on screen.
   */
  subtitles: boolean;
  /** Which screen corner the island minimap sits in. */
  minimapCorner: MinimapCorner;
}

/** Minimap corner preset: top/bottom × left/right. */
export type MinimapCorner = "tl" | "tr" | "bl" | "br";
export const MINIMAP_CORNERS: readonly MinimapCorner[] = ["tl", "tr", "bl", "br"];

export const SETTINGS_RANGES = {
  fov: { min: 40, max: 75, step: 1, default: 75 },
  zoom: { min: 0.7, max: 1.8, step: 0.01, default: 1.3 },
  lookSensitivity: { min: 0.002, max: 0.013, step: 0.0005, default: 0.006 },
} as const;

const DEFAULTS: GameplaySettings = {
  fov: SETTINGS_RANGES.fov.default,
  zoom: SETTINGS_RANGES.zoom.default,
  autoPlay: false,
  lookSensitivity: SETTINGS_RANGES.lookSensitivity.default,
  subtitles: false,
  minimapCorner: "bl",
};

// v3: the default lab framing baseline moved to FOV 75 / zoom 1.3, so a reset
// (and returning testers) land on the new shot. Earlier (v2) the control
// switched from a "distance" multiplier (higher = far) to a "zoom" one
// (higher = close); either way stale values must not be reused, so bumping the
// key resets prefs to the current defaults.
const STORAGE_KEY = "beyond-extinction.settings.v3";

type Listener = (settings: GameplaySettings) => void;
const listeners = new Set<Listener>();

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function sanitize(raw: Partial<GameplaySettings>): GameplaySettings {
  return {
    fov: clamp(raw.fov ?? DEFAULTS.fov, SETTINGS_RANGES.fov.min, SETTINGS_RANGES.fov.max),
    zoom: clamp(
      raw.zoom ?? DEFAULTS.zoom,
      SETTINGS_RANGES.zoom.min,
      SETTINGS_RANGES.zoom.max,
    ),
    autoPlay:
      typeof raw.autoPlay === "boolean" ? raw.autoPlay : DEFAULTS.autoPlay,
    lookSensitivity: clamp(
      raw.lookSensitivity ?? DEFAULTS.lookSensitivity,
      SETTINGS_RANGES.lookSensitivity.min,
      SETTINGS_RANGES.lookSensitivity.max,
    ),
    subtitles:
      typeof raw.subtitles === "boolean" ? raw.subtitles : DEFAULTS.subtitles,
    minimapCorner: MINIMAP_CORNERS.includes(raw.minimapCorner as MinimapCorner)
      ? (raw.minimapCorner as MinimapCorner)
      : DEFAULTS.minimapCorner,
  };
}

function load(): GameplaySettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULTS };
    return sanitize(JSON.parse(stored) as Partial<GameplaySettings>);
  } catch {
    return { ...DEFAULTS };
  }
}

let current: GameplaySettings = load();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage unavailable (private mode / quota). Settings still apply this
    // session; they just won't survive a reload.
  }
}

export function getSettings(): GameplaySettings {
  return { ...current };
}

export function setSettings(patch: Partial<GameplaySettings>): GameplaySettings {
  current = sanitize({ ...current, ...patch });
  persist();
  const snapshot = getSettings();
  for (const listener of listeners) listener(snapshot);
  return snapshot;
}

export function resetSettings(): GameplaySettings {
  return setSettings({ ...DEFAULTS });
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
