/**
 * Bridge between the global Dev menu (DevPortal) and whichever scene currently
 * supports spawn editing (the island). The island scene assigns these callbacks
 * on enter and clears them on dispose; the Dev menu only shows its spawn buttons
 * while they are present. Mirrors the DevAccess singleton pattern.
 *
 * Each callback performs the action against the live scene and returns a short
 * confirmation message for the Dev menu to toast.
 */
export interface SpawnToolset {
  /** Save Jack's spawn = the player's current position + facing. */
  setJackHere: () => string;
  /** Save Sarah's spawn = the player's current position; moves her mesh there. */
  setSarahHere: () => string;
  /** Forget saved spawns; the scene reverts to its beach defaults next load. */
  reset: () => string;
}

export const SpawnTools: { current?: SpawnToolset } = {};
