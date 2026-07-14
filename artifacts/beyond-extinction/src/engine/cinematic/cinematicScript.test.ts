import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Read the generated script data directly (decoupled from the Vite JSON-import
// path and from THREE) so this validates the canonical file the game ships.
const dataUrl = new URL("../../story/ch0203.json", import.meta.url);
const script = JSON.parse(readFileSync(fileURLToPath(dataUrl), "utf8")) as {
  scenes: { id: string; beats: { id: string; steps: { kind: string; [k: string]: unknown }[] }[] }[];
};

// The §8 "Marker IDs used" set — spawn/move/gate targets must stay within it.
const KNOWN_MARKERS = new Set([
  "jungle_edge_01",
  "jungle_edge_02",
  "bob_approach_01",
  "bob_approach_02",
  "zara_reveal",
  "zara_step_01",
  "zara_step_02",
  "sarah_body",
  "chase_path_01",
  "chase_path_02",
  "ravine_edge",
  "ravine_behind",
  "river_bank",
  "treeline_parallel",
  "cave_mouth",
]);

const KNOWN_ACTORS = new Set(["jack", "sarah", "bob", "zara", "dream_predator", "narrator"]);

function allSteps(): { kind: string; [k: string]: unknown }[] {
  return script.scenes.flatMap((s) => s.beats.flatMap((b) => b.steps));
}

test("script has the two expected scenes", () => {
  assert.equal(script.scenes.length, 2);
  assert.deepEqual(
    script.scenes.map((s) => s.id),
    ["ch02_arrival", "ch03_chase"],
  );
});

test("77 unique say clips (§8 audio total), no duplicate clip ids", () => {
  const clips = allSteps()
    .filter((s) => s.kind === "say")
    .map((s) => s.clip as string);
  assert.equal(clips.length, 77);
  assert.equal(new Set(clips).size, 77, "duplicate clip id in script");
});

test("every spawn/move/gate target is a known marker", () => {
  for (const s of allSteps()) {
    if (s.kind === "spawn" || s.kind === "move") {
      const m = (s.kind === "spawn" ? s.at : s.to) as string;
      assert.ok(KNOWN_MARKERS.has(m), `unknown marker "${m}" in ${s.kind}`);
    }
    if (s.kind === "gate" && typeof s.target === "string") {
      assert.ok(KNOWN_MARKERS.has(s.target), `unknown gate target "${s.target}"`);
    }
  }
});

test("every actor referenced is a known actor", () => {
  for (const s of allSteps()) {
    if (typeof s.actor === "string") {
      assert.ok(KNOWN_ACTORS.has(s.actor), `unknown actor "${s.actor}" in ${s.kind}`);
    }
  }
});

test("every beat has a stable chapter.scene.beat id", () => {
  for (const scene of script.scenes) {
    for (const beat of scene.beats) {
      assert.match(beat.id, /^\d+\.\d+\.[A-Z]$/, `bad beat id "${beat.id}"`);
    }
  }
});
