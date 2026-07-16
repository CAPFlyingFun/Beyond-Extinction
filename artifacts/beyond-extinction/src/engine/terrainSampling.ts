/**
 * Pure sampling math for the streamed Kauaʻi terrain — no three.js, no DOM —
 * shared by KauaiTileStreamer (rendering + physics grounding) and unit tests.
 *
 * A tile is a P×P heightmap (row-major, north→south) rendered as a SEG×SEG
 * PlaneGeometry grid whose vertex heights are bilinear samples of the
 * heightmap. Everything that "stands on the ground" must sample the surface
 * the GPU actually draws: the grid's TRIANGLES, not the smooth bilinear patch.
 */

// Grid resolution per tile. The source DEM is 513²/tile (~13.7 m/px), so 512 is
// the real detail ceiling. 192 (193² ≈ 37k verts, ~36 m spacing) halves the old
// 96's ~73 m facets for much smoother hillsides, and deliberately stays under
// the 65 536-vertex 16-bit index limit — so tiles keep a Uint16 index buffer
// and the resident set (~25 tiles) stays ~46 MB of geometry, mobile-safe.
// (Bumping toward 256/512 smooths further but tips into 32-bit indices and
// materially more memory — raise only if the target devices have the headroom.)
export const SEG = 192;

/**
 * Height of mesh vertex (gi, gj) of a SEG-grid tile: the bilinear sample of
 * the P×P heightmap at that vertex's position — exactly what buildMesh bakes
 * into the vertex buffer. gi/gj ∈ [0, SEG].
 */
export function vertexHeight(
  h: ArrayLike<number>,
  P: number,
  gi: number,
  gj: number,
): number {
  const px = (gi / SEG) * (P - 1);
  const py = (gj / SEG) * (P - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(P - 1, x0 + 1);
  const y1 = Math.min(P - 1, y0 + 1);
  const tx = px - x0;
  const ty = py - y0;
  return (
    h[y0 * P + x0] * (1 - tx) * (1 - ty) +
    h[y0 * P + x1] * tx * (1 - ty) +
    h[y1 * P + x0] * (1 - tx) * ty +
    h[y1 * P + x1] * tx * ty
  );
}

/**
 * Height of the RENDERED terrain surface at local tile coords (lx, lz ∈
 * [-S/2, S/2] from the tile centre; +x east, +z south).
 *
 * Triangle-exact: PlaneGeometry splits every grid cell on the fx+fz = 1
 * diagonal into triangles (00,01,10) and (01,11,10); we pick the same triangle
 * the GPU rasterises and interpolate planarly across it. This matters because
 * a bilinear patch differs from the two drawn triangles by the cell's "twist"
 * term |h00+h11−h01−h10|/4 — metres on rough 36 m cells — which was exactly
 * the gap river ribbons kept clipping through.
 */
export function renderedSurfaceHeight(
  h: ArrayLike<number>,
  P: number,
  S: number,
  lx: number,
  lz: number,
): number {
  const gu = Math.min(SEG, Math.max(0, (lx / S + 0.5) * SEG));
  const gv = Math.min(SEG, Math.max(0, (lz / S + 0.5) * SEG));
  const gi0 = Math.min(SEG - 1, Math.floor(gu));
  const gj0 = Math.min(SEG - 1, Math.floor(gv));
  const fx = gu - gi0;
  const fz = gv - gj0;
  const h00 = vertexHeight(h, P, gi0, gj0);
  const h10 = vertexHeight(h, P, gi0 + 1, gj0);
  const h01 = vertexHeight(h, P, gi0, gj0 + 1);
  const h11 = vertexHeight(h, P, gi0 + 1, gj0 + 1);
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}
