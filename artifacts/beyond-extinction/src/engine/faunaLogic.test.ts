import { test } from "node:test";
import assert from "node:assert/strict";
import {
  populationDeficit,
  neutralShouldEngage,
  feedCooldownSecs,
  validateFaunaEntry,
} from "./faunaLogic.ts";

test("populationDeficit fills additively after a restore", () => {
  // 6 target, 1 restored → still need 5 (restore must not starve the spawn).
  assert.equal(populationDeficit(1, 6), 5);
  assert.equal(populationDeficit(0, 6), 6);
  assert.equal(populationDeficit(6, 6), 0);
  assert.equal(populationDeficit(8, 6), 0); // more pinned than target → no deficit
});

test("neutral engages only in personal space or when provoked", () => {
  const space = 8;
  assert.equal(neutralShouldEngage(30, space, false), false); // far, unprovoked → ignore
  assert.equal(neutralShouldEngage(30, space, true), true); // hit from afar → fight back
  assert.equal(neutralShouldEngage(5, space, false), true); // inside personal space
  assert.equal(neutralShouldEngage(8, space, false), true); // exactly on the edge
  assert.equal(neutralShouldEngage(8.1, space, false), false);
});

test("feed cooldown is the scheduled next-bask time, never a sum/negative", () => {
  assert.equal(feedCooldownSecs(20, 8), 12); // 12 s until it baskes again
  assert.equal(feedCooldownSecs(8, 20), 0); // already due → 0, not negative
  assert.equal(feedCooldownSecs(10.2, 10), 1); // ceils partial seconds
});

test("validateFaunaEntry sanitises and rejects bad saves", () => {
  const species = new Set(["deinosuchus", "megalodon"]);
  // Good entry passes through, clamped.
  const ok = validateFaunaEntry(
    { species: "deinosuchus", x: 5, z: -3, yaw: 1, tamePct: 140, tamed: true, tracked: false, behavior: "follow" },
    species,
  );
  assert.ok(ok);
  assert.equal(ok.tamePct, 100); // clamped 0..100
  assert.equal(ok.behavior, "follow");
  assert.equal(ok.tamed, true);

  // Unknown species → dropped.
  assert.equal(validateFaunaEntry({ species: "unicorn", x: 0, z: 0 }, species), null);
  // Non-finite position → dropped.
  assert.equal(validateFaunaEntry({ species: "megalodon", x: NaN, z: 0 }, species), null);
  assert.equal(validateFaunaEntry({ species: "megalodon", x: 0 }, species), null);
  // Bad behaviour string → falls back to "wander".
  const w = validateFaunaEntry({ species: "megalodon", x: 0, z: 0, behavior: "attack" }, species);
  assert.equal(w?.behavior, "wander");
  // Negative tamePct clamps to 0.
  const n = validateFaunaEntry({ species: "megalodon", x: 0, z: 0, tamePct: -50 }, species);
  assert.equal(n?.tamePct, 0);
});
