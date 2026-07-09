/**
 * PlayerInventory — the web mirror of the Godot project's `PlayerInventory`
 * autoload. A single shared store tracking whether Jack (or Sarah) is carrying
 * the badge and which loose items are held in-hand.
 *
 * Design parity with the Godot build:
 *  - `hasBadge` (bool) gates ONLY the Lab Seven glass door. The cafeteria and
 *    server-room doors are proximity-only and never consult it.
 *  - `heldItems` (array) tracks carried props (e.g. the two coffee cups). Setting
 *    an item down is a pure inventory toggle here — no physical world object is
 *    spawned or removed, exactly as specified for the coffee cups.
 *
 * It is a module singleton so any system can read/write the same state without
 * threading it through constructors, matching an autoload. Scenes call
 * {@link reset} on enter so a replay always starts empty-handed.
 */
class PlayerInventoryStore {
  /** True once the Lab Seven badge has been picked up. Gates the glass door. */
  hasBadge = false;

  /** Loose items currently held in-hand (e.g. "coffee", "coffee"). */
  heldItems: string[] = [];

  // ── Companion (Sarah) ──────────────────────────────────────────────────────
  // The primary fields above are the CONTROLLED character (Jack in the prologue
  // and on the island). Sarah travels with the party and carries her own kit
  // (badge + flashlight) on the island, tracked here so future crafting can read
  // each character's pack. Set explicitly by the island scene on arrival.
  /** True if Sarah is carrying a badge. */
  companionHasBadge = false;
  /** Loose items Sarah is carrying (e.g. "flashlight"). */
  companionItems: string[] = [];

  /** Pick up / start holding an item (allows duplicates — two coffee cups). */
  hold(item: string): void {
    this.heldItems.push(item);
  }

  /** Set down / stop holding one instance of an item — inventory toggle only. */
  drop(item: string): void {
    const i = this.heldItems.indexOf(item);
    if (i >= 0) this.heldItems.splice(i, 1);
  }

  /** How many of `item` are currently held. */
  count(item: string): number {
    return this.heldItems.reduce((n, it) => (it === item ? n + 1 : n), 0);
  }

  /** True if at least one `item` is held. */
  isHolding(item: string): boolean {
    return this.heldItems.includes(item);
  }

  /** Clear everything (called on scene enter so replays start fresh). */
  reset(): void {
    this.hasBadge = false;
    this.heldItems = [];
    this.companionHasBadge = false;
    this.companionItems = [];
  }
}

/** Shared inventory instance (autoload-equivalent). */
export const PlayerInventory = new PlayerInventoryStore();
