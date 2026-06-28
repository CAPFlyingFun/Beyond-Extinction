// Shared coordinate system (matches the game's PrologueCafeteriaScene):
//   +X east, -Z north (so +Z is south), +Y up; units = meters.

export type Vec2 = { x: number; z: number };

export type MarkerKind = "wall" | "object" | "spawn";

export type ObjectShape = "square" | "circle";

/** A connected chain of wall points. Segments run between consecutive points. */
export interface WallChain {
  id: string;
  kind: "wall";
  tag: string;
  closed: boolean;
  height: number;
  thickness: number;
  points: Vec2[];
}

export interface ObjectMarker {
  id: string;
  kind: "object";
  tag: string;
  shape: ObjectShape;
  x: number;
  z: number;
  rot: number; // degrees, yaw about +Y
  size: number; // meters (square side / circle diameter)
}

export interface SpawnMarker {
  id: string;
  kind: "spawn";
  tag: string;
  x: number;
  z: number;
  facing: number; // degrees, 0 = facing -Z (north), 90 = +X (east), CW
}

export type Marker = WallChain | ObjectMarker | SpawnMarker;

// --- Serialized layout schema written to levels/<name>.json ---

export interface SerializedWall {
  tag: string;
  closed: boolean;
  height: number;
  thickness: number;
  points: Vec2[];
}

export interface SerializedObject {
  tag: string;
  shape: ObjectShape;
  x: number;
  z: number;
  rot: number;
  size: number;
}

export interface SerializedSpawn {
  tag: string;
  x: number;
  z: number;
  facing: number;
}

export interface LevelData {
  name: string;
  version: number;
  units: "meters";
  axes: string;
  walls: SerializedWall[];
  objects: SerializedObject[];
  spawns: SerializedSpawn[];
}

export const LEVEL_VERSION = 1;
export const AXES = "+X east,-Z north,+Y up";
