/**
 * Bake public/assets/terrain/kauai/coast_mask.png — the world-locked alpha
 * mask that gates the flat ocean plane's visibility (see makeOceanMaterial in
 * KauaiStreamScene.ts: uv = world.xz / 56000 + 0.5, row 0 = north, and the
 * texture is loaded with flipY = false so PNG rows map straight to +z).
 *
 * alpha = smoothstep(HIDDEN_G, VISIBLE_G, ground) over the terrarium height
 * tiles (bilinear at mask resolution), then zeroed anywhere NOT flood-fill
 * connected to the open sea — inland below-sea-level pockets (Mānā plain
 * ditches, Hanalei valley floors) must never show ocean.
 *
 * HIDDEN_G sits below the lowest the ocean plane can tide to
 * (WATER_Y −0.4 − TIDE_AMP 0.06 = −0.46), so ocean is never drawn over ground
 * that pokes above the plane — that near-coplanar band is what z-fought on
 * flat beaches at distance.
 *
 * Run (pngjs is NOT a project dep — install it somewhere ephemeral):
 *   npm install pngjs --prefix /tmp/pngjs
 *   NODE_PATH=/tmp/pngjs/node_modules node tools/bake_coast_mask.cjs
 */
const { PNG } = require("pngjs");
const fs = require("fs");
const path = require("path");

const BASE = path.join(__dirname, "..", "public", "assets", "terrain", "kauai");
const COLS = "ABCDEFGH";
const P = 513; // tile heightmap pixels
const TILE = 7000; // tile world size (m)
const HALF = 28000; // half world extent (m)
const WORLD = 56000; // full world extent (m) — must match the shader mapping
const N = 2048; // mask resolution (~27.3 m/px)

// Ocean fades in between these ground heights (m). HIDDEN_G must stay below
// WATER_Y − TIDE_AMP (−0.46) or the plane z-fights near-coplanar sand.
const HIDDEN_G = -0.5;
const VISIBLE_G = -1.6;
// Sea/land split used ONLY for connectivity (generous: anything below the old
// waterline can carry the flood fill through shallow shelf strips).
const CONNECT_G = -0.15;

const tiles = new Map();
function tileHeights(col, row) {
  const key = `${col},${row}`;
  let h = tiles.get(key);
  if (h) return h;
  const file = path.join(BASE, "height", COLS[col], `${COLS[col]}${row + 1}.png`);
  const png = PNG.sync.read(fs.readFileSync(file));
  h = new Float32Array(P * P);
  for (let i = 0; i < P * P; i++) {
    const o = i * 4;
    h[i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
  }
  tiles.set(key, h);
  return h;
}

function groundAt(x, z) {
  const step = TILE / (P - 1);
  const gx = (x + HALF) / step;
  const gz = (z + HALF) / step;
  const col = Math.min(7, Math.max(0, Math.floor(gx / (P - 1))));
  const row = Math.min(7, Math.max(0, Math.floor(gz / (P - 1))));
  const h = tileHeights(col, row);
  const lx = Math.min(P - 1, Math.max(0, gx - col * (P - 1)));
  const lz = Math.min(P - 1, Math.max(0, gz - row * (P - 1)));
  const x0 = Math.min(P - 2, Math.floor(lx));
  const z0 = Math.min(P - 2, Math.floor(lz));
  const fx = lx - x0;
  const fz = lz - z0;
  return (
    h[z0 * P + x0] * (1 - fx) * (1 - fz) +
    h[z0 * P + x0 + 1] * fx * (1 - fz) +
    h[(z0 + 1) * P + x0] * (1 - fx) * fz +
    h[(z0 + 1) * P + x0 + 1] * fx * fz
  );
}

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

console.log("sampling heights…");
const g = new Float32Array(N * N);
for (let j = 0; j < N; j++) {
  // row 0 = north (z = −HALF): plain top-to-bottom rows, shader loads flipY=false
  const z = ((j + 0.5) / N - 0.5) * WORLD;
  for (let i = 0; i < N; i++) {
    const x = ((i + 0.5) / N - 0.5) * WORLD;
    // Outside the tiled area there is only open ocean; the border ring of
    // mask pixels (and the mask's clamped uv beyond ±28 km) must read fully
    // visible — it also guarantees the flood-fill seed at pixel 0 is sea.
    // Margin must exceed half a mask pixel (WORLD/N/2 ≈ 13.7 m) or the
    // outermost sample centres never trigger it.
    g[j * N + i] =
      Math.abs(x) > HALF - 20 || Math.abs(z) > HALF - 20 ? -100 : groundAt(x, z);
  }
}

console.log("flood-filling sea connectivity…");
const sea = new Uint8Array(N * N);
for (let p = 0; p < N * N; p++) sea[p] = g[p] <= CONNECT_G ? 1 : 0;
const conn = new Uint8Array(N * N);
const stack = [0]; // corner pixel is forced deep ocean above
conn[0] = 1;
while (stack.length) {
  const p = stack.pop();
  const i = p % N;
  const j = (p / N) | 0;
  // 8-connectivity: don't sever lagoons that connect diagonally at 27 m/px
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (di === 0 && dj === 0) continue;
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const np = nj * N + ni;
      if (!conn[np] && sea[np]) {
        conn[np] = 1;
        stack.push(np);
      }
    }
  }
}

console.log("writing mask…");
const out = new PNG({ width: N, height: N });
let pocketPx = 0;
for (let p = 0; p < N * N; p++) {
  let a = smoothstep(HIDDEN_G, VISIBLE_G, g[p]);
  if (a > 0 && !conn[p]) {
    a = 0; // inland pocket — never ocean
    pocketPx++;
  }
  const v = Math.round(a * 255);
  const o = p * 4;
  out.data[o] = v;
  out.data[o + 1] = v;
  out.data[o + 2] = v;
  out.data[o + 3] = 255;
}
// colorType 0 = 8-bit greyscale — the shader only reads .r and the file stays small
fs.writeFileSync(
  path.join(BASE, "coast_mask.png"),
  PNG.sync.write(out, { colorType: 0 }),
);
console.log(`done — ${pocketPx} inland-pocket pixels zeroed`);
