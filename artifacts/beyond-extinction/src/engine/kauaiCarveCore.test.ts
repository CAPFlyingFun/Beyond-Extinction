import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carveTileHeights,
  riverCarveRadius,
  riverCarveDepth,
  HALF_WORLD,
  LAKE_DEPTH,
  type CarveSeg,
  type CarveLakeSpec,
} from "./kauaiCarveCore.ts";

const P = 65; // small synthetic tiles: (P−1) divides tile size cleanly
const S = 7000;
const STEP = S / (P - 1);

function flatTile(elev: number): Float32Array {
  return new Float32Array(P * P).fill(elev);
}

/** World X of a tile's global pixel column. */
function worldX(col: number, i: number): number {
  return (col * (P - 1) + i) * STEP - HALF_WORLD;
}

test("river carve is bit-identical on the shared border column of two tiles", () => {
  // A river running north-south right along the border between tiles (3,3)
  // and (4,3) — the worst case for seam determinism. Border world x = 0.
  // Tiles (3,3)/(4,3) span z ∈ [−7000, 0]; keep the segment inside that range.
  const seg: CarveSeg = {
    ax: 3,
    az: -6000,
    bx: -4,
    bz: -1000,
    ay: 100, // baked ground = the flat tile elevation → burns to 100 − depth
    by: 100,
    r: riverCarveRadius(20),
    depth: riverCarveDepth(20),
  };
  const left = flatTile(100);
  const right = flatTile(100);
  carveTileHeights(left, P, S, 3, 3, [seg], []);
  carveTileHeights(right, P, S, 4, 3, [seg], []);
  // Tile (3,3)'s last column and tile (4,3)'s first column are the SAME world
  // samples (1-px overlap) — the carve must keep them byte-identical or the
  // terrain seam un-welds.
  for (let j = 0; j < P; j++) {
    const a = left[j * P + (P - 1)];
    const b = right[j * P + 0];
    assert.equal(a, b, `border row ${j}: ${a} !== ${b}`);
  }
  // And the carve actually did something on both sides (row z=−3500 is
  // mid-segment, where the centerline passes ~0.4 m from the border column).
  assert.ok(left[Math.floor(P / 2) * P + (P - 1)] < 100);
});

test("river carve depth and reach follow the cos² profile", () => {
  const w = 20;
  const r = riverCarveRadius(w);
  const d = riverCarveDepth(w);
  const h = flatTile(50);
  // Segment along z through the tile centre of tile (3,3) (centre −3500,−3500).
  const cx = worldX(3, Math.floor(P / 2));
  const seg: CarveSeg = { ax: cx, az: -6000, bx: cx, bz: -1000, ay: 50, by: 50, r, depth: d };
  carveTileHeights(h, P, S, 3, 3, [seg], []);
  const j = Math.floor(P / 2);
  const centre = h[j * P + Math.floor(P / 2)];
  assert.ok(Math.abs(centre - (50 - d)) < 1e-4, `centreline carved to ${centre}`);
  // Beyond the reach: untouched.
  const off = Math.floor(P / 2) + Math.ceil(r / STEP) + 1;
  assert.equal(h[j * P + off], 50);
});

test("lakes floor toward y − LAKE_DEPTH but never raise a deeper bed", () => {
  // Tile (3,3) spans x ∈ [−7000, 0], z ∈ [−7000, 0] — centre the lake on the
  // tile centre so the sampled interior points actually fall inside it.
  const lake: CarveLakeSpec = {
    y: 40,
    ring: [
      [worldX(3, 10), -3900],
      [worldX(3, 40), -3900],
      [worldX(3, 40), -3100],
      [worldX(3, 10), -3100],
    ],
    holes: [],
    minX: worldX(3, 10),
    maxX: worldX(3, 40),
    minZ: -3900,
    maxZ: -3100,
  };
  // Case 1: shallow bed (45 m) gets floored to 38 m deep inside.
  const shallow = flatTile(45);
  carveTileHeights(shallow, P, S, 3, 3, [], [lake]);
  const j = Math.floor(P / 2);
  const mid = shallow[j * P + 25];
  assert.ok(Math.abs(mid - (lake.y - LAKE_DEPTH)) < 1e-4, `interior floored to ${mid}`);
  // Case 2: a bed already deeper (20 m) is never raised.
  const deep = flatTile(20);
  carveTileHeights(deep, P, S, 3, 3, [], [lake]);
  assert.equal(deep[j * P + 25], 20);
});
