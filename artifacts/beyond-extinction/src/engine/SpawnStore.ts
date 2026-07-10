/**
 * Persists the island start positions for Jack and Sarah to localStorage, so a
 * developer can walk to a spot in-game, save it via the Dev menu, and have the
 * scene start there on every future load. When nothing is saved the scene falls
 * back to its hardcoded beach defaults.
 */

export interface SpawnPoint {
  x: number;
  z: number;
  /** Jack: heading in degrees (as passed to PlayerController.placeAt).
   *  Sarah: mesh rotation.y in radians. */
  rot: number;
}

export interface IslandSpawns {
  jack?: SpawnPoint;
  sarah?: SpawnPoint;
}

// v2: the world was rescaled (~40×), so any v1 points saved in the old
// coordinate system are meaningless now — a new key retires them cleanly.
// v3: the true-aerial-view flip (see worldToIslandUV) mirrored the island
// north/south — old points would land on the wrong terrain (possibly water).
const KEY = "be-island-spawns-v3";

export const SpawnStore = {
  get(): IslandSpawns {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "{}") as IslandSpawns;
    } catch {
      return {};
    }
  },
  setJack(p: SpawnPoint): void {
    const s = this.get();
    s.jack = p;
    save(s);
  },
  setSarah(p: SpawnPoint): void {
    const s = this.get();
    s.sarah = p;
    save(s);
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable — nothing to clear */
    }
  },
};

function save(s: IslandSpawns): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full / unavailable — saved spawn just won't persist */
  }
}
