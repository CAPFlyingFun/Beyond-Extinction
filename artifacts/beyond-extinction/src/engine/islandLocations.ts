import { islandUVToWorld, beachHeight } from "./beachTerrain";

/**
 * The 15 named story locations on Hanifat (from the HANIFAT topographic brief).
 * Authored in the map's metre grid — mx = metres west→east, mz = metres
 * north→south, both 0..MAP_METRES — which is exactly the satellite image's
 * normalized UV (u = mx/MAP_METRES, v = mz/MAP_METRES). From there they convert
 * to our world space via islandUVToWorld, so the same list drives map pins now
 * and in-world markers / quest triggers later.
 */
export const MAP_METRES = 2500;

export interface IslandLocation {
  id: number;
  name: string;
  chapter: string;
  mx: number; // metres, west → east (0..2500)
  mz: number; // metres, north → south (0..2500)
  radius: number; // trigger radius in metres (for later)
}

export const ISLAND_LOCATIONS: IslandLocation[] = [
  { id: 1, name: "Arrival Beach", chapter: "Ch 1", mx: 1310, mz: 2150, radius: 20 },
  { id: 2, name: "Chase Jungle & Ravine", chapter: "Ch 2", mx: 900, mz: 1980, radius: 25 },
  { id: 3, name: "First Cave", chapter: "Ch 2–3", mx: 700, mz: 1980, radius: 12 },
  { id: 4, name: "The Stream", chapter: "Ch 3", mx: 780, mz: 1700, radius: 18 },
  { id: 5, name: "Home Camp", chapter: "Ch 14+", mx: 700, mz: 1600, radius: 30 },
  { id: 6, name: "Handprint Cave", chapter: "Ch 15", mx: 900, mz: 1580, radius: 12 },
  { id: 7, name: "Herd Plains", chapter: "Ch 17–21", mx: 1150, mz: 1500, radius: 50 },
  { id: 8, name: "The Obelisk", chapter: "Ch 46–57", mx: 950, mz: 1260, radius: 15 },
  { id: 9, name: "Mountain & Forge", chapter: "Ch 31", mx: 580, mz: 760, radius: 20 },
  { id: 10, name: "Coastal Cliffs", chapter: "Ch 32", mx: 2000, mz: 1480, radius: 30 },
  { id: 11, name: "The Other Camp", chapter: "Ch 20", mx: 480, mz: 1200, radius: 20 },
  { id: 12, name: "Deep Jungle", chapter: "Ch 33", mx: 1400, mz: 980, radius: 35 },
  { id: 13, name: "Broodmother Cave", chapter: "Ch 86–90", mx: 1530, mz: 800, radius: 15 },
  { id: 14, name: "Underwater Cave", chapter: "new", mx: 1960, mz: 2220, radius: 12 },
  { id: 15, name: "The Portal", chapter: "Ch 91+", mx: 1200, mz: 2260, radius: 18 },
];

/** Location → normalized satellite/heightmap UV (0..1). */
export function locationUV(loc: IslandLocation): { u: number; v: number } {
  return { u: loc.mx / MAP_METRES, v: loc.mz / MAP_METRES };
}

/** Location → world XZ + terrain elevation (for in-world markers / triggers). */
export function locationWorld(loc: IslandLocation): { x: number; z: number; y: number } {
  const { u, v } = locationUV(loc);
  const { x, z } = islandUVToWorld(u, v);
  return { x, z, y: beachHeight(x, z) };
}
