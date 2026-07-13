/**
 * Pure, dependency-free fauna decision helpers.
 *
 * Behaviour maths lives here as typed pure functions (no THREE, no terrain, no
 * DOM) so it can be unit-tested deterministically — see faunaLogic.test.ts.
 * SeaCreatures.ts calls these; keeping them separate is the roadmap's Phase 0
 * "prefer typed pure functions for behavior decisions" step.
 */

export type TamedBehavior = "follow" | "stay" | "wander";

/** How many more creatures to spawn to reach the target population (additive
 *  fill — restoring saved creatures must not starve the normal spawn). */
export function populationDeficit(current: number, target: number): number {
  return Math.max(0, target - current);
}

/**
 * Neutral temperament: engage ONLY if provoked, or the player is inside the
 * creature's personal space. This is the fix for "neutral was at least as
 * aggressive as aggressive" — an aggressive creature engages across its whole
 * perception range, a neutral one only when cornered or hit.
 */
export function neutralShouldEngage(
  distToPlayer: number,
  personalSpace: number,
  provoked: boolean,
): boolean {
  return provoked || distToPlayer <= personalSpace;
}

/**
 * Deterministic seconds until a fed creature can be fed again: it's simply the
 * scheduled next-bask time minus now (never negative). The old UI summed
 * feedWindow + agitated + baskCd, but those overlap, so it over-counted; a
 * single scheduled timestamp is exact and testable.
 */
export function feedCooldownSecs(nextBaskAt: number, now: number): number {
  return Math.max(0, Math.ceil(nextBaskAt - now));
}

/**
 * Biome gate for streaming spawns. Given the full species pool and an optional
 * allow-list (the species that belong in the current biome/chapter play area),
 * return the subset that may spawn. A null/undefined allow-list means "no
 * restriction" (every species is eligible). An allow-list that filters
 * everything out falls back to the full pool rather than spawning nothing — the
 * caller never wants an empty world from a typo'd allow-list.
 *
 * This is what keeps apex predators off the protected arrival beach: Chapter 1–3
 * passes marine-only ids, so crocs (amphibious) are simply never picked, and the
 * shore stays safe. Crocs return once we add river/swamp biomes to the list.
 */
export function filterSpawnPool<T extends { id: string }>(
  pool: readonly T[],
  allowed: readonly string[] | null | undefined,
): readonly T[] {
  if (!allowed) return pool;
  const set = new Set(allowed);
  const kept = pool.filter((sp) => set.has(sp.id));
  return kept.length > 0 ? kept : pool;
}

/** Loose shape of a persisted fauna entry, before validation. */
export interface RawFaunaEntry {
  species?: unknown;
  x?: unknown;
  z?: unknown;
  yaw?: unknown;
  tamePct?: unknown;
  tamed?: unknown;
  tracked?: unknown;
  behavior?: unknown;
  aggressive?: unknown;
}

/** A validated, sanitised fauna entry ready to spawn. */
export interface CleanFaunaEntry {
  species: string;
  x: number;
  z: number;
  yaw: number;
  tamePct: number;
  tamed: boolean;
  tracked: boolean;
  behavior: TamedBehavior;
  aggressive: boolean;
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Validate + sanitise a persisted fauna entry from an untrusted save. Returns
 * null (drop the entry) when it's unrecoverable — unknown species, or non-finite
 * position. tamePct is clamped 0..100; behaviour falls back to "wander".
 */
export function validateFaunaEntry(
  e: RawFaunaEntry,
  validSpecies: ReadonlySet<string>,
): CleanFaunaEntry | null {
  if (!e || typeof e.species !== "string" || !validSpecies.has(e.species)) return null;
  if (typeof e.x !== "number" || !Number.isFinite(e.x)) return null;
  if (typeof e.z !== "number" || !Number.isFinite(e.z)) return null;
  const behavior: TamedBehavior =
    e.behavior === "follow" || e.behavior === "stay" || e.behavior === "wander"
      ? e.behavior
      : "wander";
  return {
    species: e.species,
    x: e.x,
    z: e.z,
    yaw: finiteOr(e.yaw, 0),
    tamePct: Math.max(0, Math.min(100, finiteOr(e.tamePct, 0))),
    tamed: e.tamed === true,
    tracked: e.tracked === true,
    behavior,
    aggressive: e.aggressive === true,
  };
}
