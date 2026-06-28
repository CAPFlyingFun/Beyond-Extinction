import type { Vec2, WallChain } from "../state/types";

export interface SnapSettings {
  snapEnabled: boolean;
  snapRadius: number; // meters
  gridEnabled: boolean;
  gridSize: number; // meters
}

export interface SnapResult {
  point: Vec2;
  snappedToStart: boolean; // near the active chain's first point (>= 3 points)
  snappedToEndpoint: boolean;
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Trim float noise (e.g. 0.150000002 → 0.15) so saved coords stay tidy. */
function roundCoord(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Snap a free ground point to the grid (no-op when disabled). Used by object
 * and spawn placement; walls go through snapWallPoint which also grid-snaps. */
export function snapToGrid(raw: Vec2, gridEnabled: boolean, gridSize: number): Vec2 {
  if (!gridEnabled || gridSize <= 0) return { x: raw.x, z: raw.z };
  return {
    x: roundCoord(Math.round(raw.x / gridSize) * gridSize),
    z: roundCoord(Math.round(raw.z / gridSize) * gridSize),
  };
}

/**
 * Resolve a raw ground point into a snapped wall point.
 * Priority: existing endpoint snap > grid snap > raw. Auto-close takes
 * precedence: if near the active chain's first point, snap exactly to it.
 */
export function snapWallPoint(
  raw: Vec2,
  walls: WallChain[],
  activeWall: WallChain | null,
  settings: SnapSettings,
): SnapResult {
  let point: Vec2 = { x: raw.x, z: raw.z };
  let snappedToEndpoint = false;

  if (settings.snapEnabled) {
    const r2 = settings.snapRadius * settings.snapRadius;
    let best: Vec2 | null = null;
    let bestD = r2;
    const consider = (p: Vec2) => {
      const d = dist2(raw, p);
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    };
    // Endpoints of finished walls are always valid snap targets.
    for (const w of walls) for (const p of w.points) consider(p);
    // For the active chain, never snap onto the just-placed point (zero-length
    // segment); skip the start point until auto-close is allowed (>= 3 points)
    // so dropping near the start doesn't add a duplicate vertex.
    if (activeWall) {
      const pts = activeWall.points;
      for (let i = 0; i < pts.length; i += 1) {
        if (i === pts.length - 1) continue;
        if (i === 0 && pts.length < 3) continue;
        consider(pts[i]);
      }
    }
    if (best) {
      point = { x: (best as Vec2).x, z: (best as Vec2).z };
      snappedToEndpoint = true;
    }
  }

  if (!snappedToEndpoint && settings.gridEnabled && settings.gridSize > 0) {
    point = snapToGrid(raw, true, settings.gridSize);
  }

  // Auto-close: only once the chain is a real polygon (>= 3 points) and snap
  // is enabled. Manual closing is always available via the "Close loop" button.
  let snappedToStart = false;
  if (settings.snapEnabled && activeWall && activeWall.points.length >= 3) {
    const first = activeWall.points[0];
    if (dist2(raw, first) <= settings.snapRadius * settings.snapRadius) {
      point = { x: first.x, z: first.z };
      snappedToStart = true;
    }
  }

  return { point, snappedToStart, snappedToEndpoint };
}
