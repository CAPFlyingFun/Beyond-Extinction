import * as THREE from "three";

/**
 * Single source of truth for the prologue's floor plan, derived 1:1 from the
 * architectural blueprint (New_Blue_Print_Design). The blueprint is authored in
 * metres with 0,0 at the TOP-LEFT and the same axis convention the game uses
 * (+X east, +Z south, −Z north). We build at ×4 scale — 1 blueprint metre = 4
 * world units — which keeps the existing character height (7.2u ≈ 1.8m), player
 * radius, camera offsets and walk speeds valid while the rooms read at true
 * blueprint proportions. Everything is re-centred on the world origin.
 */
export const M = 4;

const BP_CENTER_X = 13; // blueprint X spans [1,25] → centre 13
const BP_CENTER_Z = 7.5; // blueprint Z spans [0,15] → centre 7.5

/** Blueprint metres → world units (centred on origin). */
export const bpx = (mx: number): number => (mx - BP_CENTER_X) * M;
export const bpz = (mz: number): number => (mz - BP_CENTER_Z) * M;

export const WALL_THICKNESS = 0.2 * M; // 0.8u
export const WALL_HEIGHT = 24; // cafeteria / hallway / server
export const LAB_WALL_HEIGHT = 34; // the lab has a taller ceiling
export const LEDGE_WIDTH = 1.2 * M; // 4.8u walkway ledge along interior lab walls
export const LEDGE_HEIGHT = 0.8;
/** Door openings are widened to 1.5m (6u) from the blueprint's 1m so the
 * 1.5u-radius player clears the jamb without snagging on doorway corners. */
export const DOOR_WIDTH = 1.5 * M;

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({
  minX: bpx(x0),
  maxX: bpx(x1),
  minZ: bpz(z0),
  maxZ: bpz(z1),
});

export const ROOMS = {
  cafeteria: rect(1, 5, 7, 11), // 6×6, west
  hallway: rect(7, 5, 10, 11), // 3×6, centre connector
  server: rect(7, 3, 9, 5), // 2×2, north off the hallway
  lab: rect(10, 0, 25, 15), // 15×15, east
} as const;

/** Last-resort movement clamp (walls do the real containment). */
export const WORLD_BOUNDS = {
  minX: bpx(1) + 0.5,
  maxX: bpx(25) - 0.5,
  minZ: bpz(0) + 0.5,
  maxZ: bpz(15) - 0.5,
};

export interface WallSeg {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  height: number;
}
const H = WALL_HEIGHT;
const L = LAB_WALL_HEIGHT;
const seg = (x0: number, z0: number, x1: number, z1: number, height = H): WallSeg => ({
  x0: bpx(x0),
  z0: bpz(z0),
  x1: bpx(x1),
  z1: bpz(z1),
  height,
});

/**
 * Wall network in blueprint metres, pre-split so each door leaves a 1.5m gap
 * centred on its door point (cafeteria↔hall z=8, server↔hall x=8, lab glass z=9).
 */
export const WALL_SEGMENTS: WallSeg[] = [
  // Cafeteria
  seg(1, 5, 1, 11), // west
  seg(1, 5, 7, 5), // north
  seg(1, 11, 10, 11), // south (cafeteria + hallway)
  seg(7, 5, 7, 7.25), // cafeteria↔hallway (door centred z=8)
  seg(7, 8.75, 7, 11),
  // Hallway north (x7–9 is the server's south wall)
  seg(9, 5, 10, 5),
  // Server room
  seg(7, 3, 7, 5), // west
  seg(7, 3, 9, 3), // north
  seg(9, 3, 9, 5), // east
  seg(7, 5, 7.25, 5), // south (door centred x=8)
  seg(8.75, 5, 9, 5),
  // Lab west wall (glass door centred z=9)
  seg(10, 0, 10, 8.25, L),
  seg(10, 9.75, 10, 15, L),
  // Lab perimeter
  seg(10, 0, 25, 0, L), // north
  seg(25, 0, 25, 15, L), // east
  seg(10, 15, 25, 15, L), // south
];

export const RING_CENTER = new THREE.Vector3(bpx(17.5), 0, bpz(7.5));
export const RING_RADIUS = (6 * M) / 2; // Ø6m → 12u radius

export type DoorAxis = "x" | "z";
export interface DoorSpec {
  x: number;
  z: number;
  /** The world axis the opening spans (i.e. the wall runs along this axis). */
  axis: DoorAxis;
  glass: boolean;
}
export const DOORS: Record<"cafeteriaHall" | "serverHall" | "labGlass", DoorSpec> = {
  cafeteriaHall: { x: bpx(7), z: bpz(8), axis: "z", glass: false },
  serverHall: { x: bpx(8), z: bpz(5), axis: "x", glass: false },
  labGlass: { x: bpx(10), z: bpz(9), axis: "z", glass: true },
};

/** Gameplay anchor points (world units). */
export const ANCHORS = {
  jackSpawn: new THREE.Vector3(bpx(2), 0, bpz(8)), // cafeteria, west end
  jackFacing: Math.PI / 2, // east
  coffeeCart: new THREE.Vector3(bpx(5), 0, bpz(10.5)), // cafeteria, south
  badge: new THREE.Vector3(bpx(8), 0, bpz(4)), // server room
  deliveryConsole: new THREE.Vector3(bpx(12.5), 0, bpz(9)), // lab, west of the ring (where Jack meets Sarah)
  sarah: new THREE.Vector3(bpx(13), 0, bpz(9)),
  reachSarah: new THREE.Vector3(bpx(12), 0, bpz(9)),
  rebootConsole: new THREE.Vector3(bpx(21), 0, bpz(7.5)), // lab, east of the ring (emergency reboot)
};
