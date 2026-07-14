import { METERS_PER_UNIT } from "../beachTerrain";

/**
 * Named marker positions for the Ch02–03 cinematic (§8 "Marker IDs used").
 *
 * These are DEFAULTS — a straight escape route laid out relative to the arrival
 * spawn (inland axis = toward the island centre, side axis = perpendicular),
 * spaced in metres. They exist so the cutscene can spawn/move actors and place
 * cameras before the world editor lets you hand-place each marker; the scene may
 * override any of them (e.g. bind `sarah_body` to Sarah's live position).
 */

export interface MarkerXZ {
  x: number;
  z: number;
}

/** (alongMetres inland, sideMetres) for each marker. */
const LAYOUT_M: Record<string, [number, number]> = {
  sarah_body: [8, -6],
  // Bob the dodo: emerges from the treeline, waddles toward the party.
  jungle_edge_01: [34, 8],
  bob_approach_01: [16, 5],
  bob_approach_02: [12, 4],
  // Zara the Dilophosaurus: reveal at the treeline, steps toward them.
  jungle_edge_02: [36, -7],
  zara_reveal: [32, -4],
  zara_step_01: [28, -3],
  zara_step_02: [24, -2],
  // The chase route into the jungle.
  chase_path_01: [60, 0],
  chase_path_02: [86, 6],
  ravine_edge: [120, 4],
  ravine_behind: [130, 4],
  river_bank: [162, -8],
  treeline_parallel: [150, -22],
  cave_mouth: [205, 10],
};

const M = 1 / METERS_PER_UNIT; // metres -> world units

/**
 * Build world-space (XZ, in units) marker positions from the arrival spawn and
 * a normalized inland direction. `side` is the left-hand perpendicular.
 */
export function buildDefaultMarkers(
  origin: MarkerXZ,
  inland: MarkerXZ,
): Record<string, MarkerXZ> {
  // Normalize inland; derive the perpendicular side axis.
  const len = Math.hypot(inland.x, inland.z) || 1;
  const ix = inland.x / len;
  const iz = inland.z / len;
  const sx = -iz;
  const sz = ix;

  const out: Record<string, MarkerXZ> = {};
  for (const [id, [alongM, sideM]] of Object.entries(LAYOUT_M)) {
    out[id] = {
      x: origin.x + ix * alongM * M + sx * sideM * M,
      z: origin.z + iz * alongM * M + sz * sideM * M,
    };
  }
  return out;
}

/** All marker ids the Ch02–03 script references (for validation/tests). */
export const CH0203_MARKER_IDS = Object.keys(LAYOUT_M);
