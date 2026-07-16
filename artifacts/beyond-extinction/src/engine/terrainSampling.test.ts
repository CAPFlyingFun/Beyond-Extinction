import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { SEG, renderedSurfaceHeight, vertexHeight } from "./terrainSampling.ts";

// Deterministic pseudo-random rough terrain: big rolling shapes + gritty hash
// noise so grid cells have a large "twist" term (the case that breaks bilinear).
function makeHeights(P: number): Float32Array {
  const h = new Float32Array(P * P);
  const hash = (i: number, j: number): number => {
    let n = i * 374761393 + j * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return (((n ^ (n >> 16)) >>> 0) % 1000) / 1000;
  };
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      h[j * P + i] =
        60 * Math.sin(i * 0.11) * Math.cos(j * 0.07) +
        25 * Math.sin(i * 0.31 + j * 0.17) +
        18 * (hash(i, j) - 0.5);
    }
  }
  return h;
}

// Build the terrain mesh EXACTLY the way KauaiTileStreamer.buildMesh does:
// PlaneGeometry(S,S,SEG,SEG), rotateX(-PI/2), vertex Y = bilinear heightmap
// sample at the vertex's (u,v).
function buildTileMesh(h: Float32Array, P: number, S: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(S, S, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / S + 0.5;
    const v = pos.getZ(i) / S + 0.5;
    const fx = Math.min(P - 1, Math.max(0, u * (P - 1)));
    const fy = Math.min(P - 1, Math.max(0, v * (P - 1)));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(P - 1, x0 + 1);
    const y1 = Math.min(P - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    pos.setY(
      i,
      h[y0 * P + x0] * (1 - tx) * (1 - ty) +
        h[y0 * P + x1] * tx * (1 - ty) +
        h[y1 * P + x0] * (1 - tx) * ty +
        h[y1 * P + x1] * tx * ty,
    );
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

test("renderedSurfaceHeight matches a raycast against the real rendered mesh", () => {
  const P = 129;
  const S = 7000;
  const h = makeHeights(P);
  const mesh = buildTileMesh(h, P, S);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  // Seeded LCG so failures reproduce.
  let seed = 42;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let maxErr = 0;
  for (let n = 0; n < 60; n++) {
    const lx = (rnd() - 0.5) * S * 0.98;
    const lz = (rnd() - 0.5) * S * 0.98;
    ray.set(new THREE.Vector3(lx, 10000, lz), down);
    const hit = ray.intersectObject(mesh, false)[0];
    assert.ok(hit, `ray missed the mesh at (${lx.toFixed(1)}, ${lz.toFixed(1)})`);
    const err = Math.abs(hit.point.y - renderedSurfaceHeight(h, P, S, lx, lz));
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr < 1e-3, `max |raycast − sampler| = ${maxErr} m (want < 1 mm)`);
});

test("triangle-exact sampling differs from the bilinear patch on twisted cells", () => {
  const P = 129;
  const S = 7000;
  const h = makeHeights(P);
  // At many cell centres the bilinear patch and the drawn triangles disagree
  // by the twist term — the exact gap the old ribbons kept clipping through.
  let worst = 0;
  for (let gi = 0; gi < SEG; gi += 7) {
    for (let gj = 0; gj < SEG; gj += 7) {
      const lx = ((gi + 0.5) / SEG - 0.5) * S;
      const lz = ((gj + 0.5) / SEG - 0.5) * S;
      const h00 = vertexHeight(h, P, gi, gj);
      const h10 = vertexHeight(h, P, gi + 1, gj);
      const h01 = vertexHeight(h, P, gi, gj + 1);
      const h11 = vertexHeight(h, P, gi + 1, gj + 1);
      const bilinear = (h00 + h10 + h01 + h11) / 4;
      const gap = Math.abs(bilinear - renderedSurfaceHeight(h, P, S, lx, lz));
      if (gap > worst) worst = gap;
    }
  }
  assert.ok(worst > 0.5, `expected twisted cells to diverge (worst gap ${worst} m)`);
});
