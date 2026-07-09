/**
 * Save & Resume — real, persistent game state (previously the menu's "Continue"
 * / "Load Game" were cosmetic stubs).
 *
 * A save is a CHECKPOINT SNAPSHOT: which scene + sub-phase the player was at,
 * their inventory, and story flags. The game autosaves at every checkpoint and
 * the player can also save manually. Stored in localStorage (a player's progress
 * is personal, so it stays on-device — the dev-content editor is what goes global
 * later, not this).
 *
 * Resume flow: the menu picks a snapshot, stashes it as the pending resume, and
 * opens the matching scene; the scene consumes it on enter (see consumeResume)
 * to restore inventory, jump to the saved phase, place the player and skip the
 * intro. A scene that can't resume mid-way simply starts fresh.
 */

const STORAGE_KEY = "beyond-extinction.saves.v1";
const SAVE_VERSION = 1;

export const SAVE_SLOTS = ["autosave", "manual-1", "manual-2", "manual-3"] as const;
export type SaveSlot = (typeof SAVE_SLOTS)[number];

export interface SaveSnapshot {
  version: number;
  /** Epoch ms the save was written. */
  savedAt: number;
  /** Human label for the menu, e.g. "Lab Seven — knock on the glass". */
  label: string;
  /** Scene id the resolver maps to a factory (e.g. "prologue", "island"). */
  scene: string;
  /** Scene sub-phase to resume at (scene-specific; omitted = scene start). */
  phase?: string;
  /** Player inventory at the checkpoint. */
  inventory: { hasBadge: boolean; heldItems: string[] };
  /** Arbitrary story flags a scene wants to persist. */
  flags?: Record<string, unknown>;
}

type SaveBook = Partial<Record<SaveSlot, SaveSnapshot>>;

class SaveManagerImpl {
  /** Set by the menu before opening a scene; the scene consumes it on enter. */
  private pendingResume: SaveSnapshot | null = null;

  private read(): SaveBook {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const book = JSON.parse(raw) as SaveBook;
      return book && typeof book === "object" ? book : {};
    } catch {
      return {};
    }
  }

  private write(book: SaveBook): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(book));
    } catch {
      // Storage unavailable (private mode / quota) — saves just don't persist.
    }
  }

  /** Write a snapshot to a slot. `savedAt`/`version` are stamped here. */
  save(slot: SaveSlot, snap: Omit<SaveSnapshot, "version" | "savedAt">): SaveSnapshot {
    const full: SaveSnapshot = { ...snap, version: SAVE_VERSION, savedAt: Date.now() };
    const book = this.read();
    book[slot] = full;
    this.write(book);
    return full;
  }

  /** Autosave convenience — always the `autosave` slot. */
  autosave(snap: Omit<SaveSnapshot, "version" | "savedAt">): SaveSnapshot {
    return this.save("autosave", snap);
  }

  load(slot: SaveSlot): SaveSnapshot | null {
    const snap = this.read()[slot];
    return snap && snap.version === SAVE_VERSION ? snap : null;
  }

  /** The most recently written valid save across all slots (for "Continue"). */
  latest(): { slot: SaveSlot; snap: SaveSnapshot } | null {
    const book = this.read();
    let best: { slot: SaveSlot; snap: SaveSnapshot } | null = null;
    for (const slot of SAVE_SLOTS) {
      const snap = book[slot];
      if (!snap || snap.version !== SAVE_VERSION) continue;
      if (!best || snap.savedAt > best.snap.savedAt) best = { slot, snap };
    }
    return best;
  }

  hasAny(): boolean {
    return this.latest() !== null;
  }

  /** All slots with their snapshot (or null) for the Load menu, in slot order. */
  list(): Array<{ slot: SaveSlot; snap: SaveSnapshot | null }> {
    const book = this.read();
    return SAVE_SLOTS.map((slot) => {
      const snap = book[slot];
      return { slot, snap: snap && snap.version === SAVE_VERSION ? snap : null };
    });
  }

  clear(slot: SaveSlot): void {
    const book = this.read();
    delete book[slot];
    this.write(book);
  }

  // ── Resume hand-off (menu → scene) ──────────────────────────────────────────
  setPendingResume(snap: SaveSnapshot | null): void {
    this.pendingResume = snap;
  }

  /** A scene calls this on enter; returns the snapshot once, then clears it. */
  consumeResume(): SaveSnapshot | null {
    const snap = this.pendingResume;
    this.pendingResume = null;
    return snap;
  }
}

/** Shared singleton (autoload-equivalent). */
export const SaveManager = new SaveManagerImpl();
