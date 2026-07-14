import rawCh0203 from "../../story/ch0203.json";
import type { CinematicScript, CinematicScene } from "./CinematicTypes";

/**
 * The Chapter 2–3 cinematic script (generated from the Markdown; see
 * src/story/parse-script.js). Imported as data and cast to the typed model —
 * the JSON is the single source of truth shared with the Godot build.
 */
export const CH0203_SCRIPT = rawCh0203 as unknown as CinematicScript;

export const SCENE_ARRIVAL = "ch02_arrival";
export const SCENE_CHASE = "ch03_chase";

export function getScene(id: string): CinematicScene | undefined {
  return CH0203_SCRIPT.scenes.find((s) => s.id === id);
}
