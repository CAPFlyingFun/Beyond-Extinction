/**
 * TerrainEdit — the 1-metre height-edit layer that makes the island sculptable.
 *
 * It is a SPARSE additive field: a map of 1 m grid cells → height delta (world
 * units). `beachHeight` adds `deltaAt(x, z)` on top of the base heightmap, so a
 * single edit layer reaches everything at once — walking, collision, water,
 * tree placement, cameras. With no edits the field is empty and `deltaAt`
 * returns 0, so the terrain is byte-for-byte unchanged until the dev sculpts.
 *
 * The sculpting MATH (raise/lower/smooth/flatten, which need the base height)
 * lives in the TerrainEditor; this module only stores, samples, and persists the
 * deltas — keeping it dependency-free (no import cycle with beachTerrain) and
 * unit-testable. Persistence mirrors MarkerStore: local edits in localStorage,
 * plus an export/import of the whole field for committing to the repo.
 */

/** 1 metre in world units (matches beachTerrain's METERS_PER_UNIT = 1.8/6.4). */
export const CELL_U = 1 / (1.8 / 6.4);

const LOCAL_KEY = "beyond-extinction.terrain.edits.v1";

interface TerrainEditData {
  /** Grid cell "i,j" (i = round(x/CELL_U), j = round(z/CELL_U)) → delta (units). */
  cells: Record<string, number>;
}

class TerrainEditImpl {
  private delta = new Map<string, number>();
  private loaded = false;

  private cellKey(i: number, j: number): string {
    return `${i},${j}`;
  }

  /** Load persisted local edits (safe to call repeatedly). */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as TerrainEditData;
      if (data && data.cells) {
        for (const [k, v] of Object.entries(data.cells)) {
          if (typeof v === "number" && v !== 0) this.delta.set(k, v);
        }
      }
    } catch {
      /* corrupt / unavailable — start empty */
    }
  }

  /** True once anything has been sculpted (drives editor "unsaved" hints). */
  get hasEdits(): boolean {
    return this.delta.size > 0;
  }

  get cellCount(): number {
    return this.delta.size;
  }

  /** Raw delta at an exact grid cell (0 if untouched). */
  getCell(i: number, j: number): number {
    return this.delta.get(this.cellKey(i, j)) ?? 0;
  }

  /** Set a grid cell's delta (0 removes it, keeping the map sparse). */
  setCell(i: number, j: number, value: number): void {
    const k = this.cellKey(i, j);
    if (Math.abs(value) < 1e-4) this.delta.delete(k);
    else this.delta.set(k, value);
  }

  /** Nearest grid cell indices for a world XZ (for brush iteration). */
  cellOf(x: number, z: number): { i: number; j: number } {
    return { i: Math.round(x / CELL_U), j: Math.round(z / CELL_U) };
  }

  /** World XZ centre of a grid cell. */
  cellCentre(i: number, j: number): { x: number; z: number } {
    return { x: i * CELL_U, z: j * CELL_U };
  }

  /**
   * Bilinearly-sampled height delta at a world XZ. This is what `beachHeight`
   * adds — smooth between the 1 m cells so sculpted terrain isn't stair-stepped.
   */
  deltaAt(x: number, z: number): number {
    if (this.delta.size === 0) return 0;
    const gx = x / CELL_U;
    const gz = z / CELL_U;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gz);
    const tx = gx - i0;
    const tz = gz - j0;
    const g = (i: number, j: number): number => this.delta.get(this.cellKey(i, j)) ?? 0;
    return (
      g(i0, j0) * (1 - tx) * (1 - tz) +
      g(i0 + 1, j0) * tx * (1 - tz) +
      g(i0, j0 + 1) * (1 - tx) * tz +
      g(i0 + 1, j0 + 1) * tx * tz
    );
  }

  /** Persist local edits to localStorage. */
  save(): void {
    try {
      localStorage.setItem(LOCAL_KEY, this.serialize());
    } catch {
      /* storage full / unavailable — edits stay for this session only */
    }
  }

  /** Drop all edits (revert to the untouched heightmap). */
  clear(): void {
    this.delta.clear();
    try {
      localStorage.removeItem(LOCAL_KEY);
    } catch {
      /* nothing to clear */
    }
  }

  /** The full field as pretty JSON — committed to publish a sculpt globally. */
  serialize(): string {
    const cells: Record<string, number> = {};
    for (const [k, v] of this.delta) cells[k] = Math.round(v * 1000) / 1000;
    return JSON.stringify({ cells } satisfies TerrainEditData, null, 0);
  }

  /** Replace the field from serialized JSON (baked import / paste). */
  loadFrom(json: string): void {
    this.delta.clear();
    const data = JSON.parse(json) as TerrainEditData;
    for (const [k, v] of Object.entries(data.cells ?? {})) {
      if (typeof v === "number" && v !== 0) this.delta.set(k, v);
    }
    this.loaded = true;
  }
}

/** Shared singleton (autoload-equivalent), like MarkerStore. */
export const TerrainEdit = new TerrainEditImpl();
