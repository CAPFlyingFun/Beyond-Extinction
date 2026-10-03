import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advancePrologueQuest,
  initialPrologueQuestState,
  prologuePhaseFor,
  prologueQuestStateForResume,
  type PrologueQuestEvent,
  type PrologueQuestState,
} from "./prologueQuestFlow.ts";

function run(
  state: PrologueQuestState,
  ...events: PrologueQuestEvent[]
): PrologueQuestState {
  return events.reduce(advancePrologueQuest, state);
}

test("the ordered coffee-to-Sarah route reaches completion", () => {
  const events: PrologueQuestEvent[] = [
    { type: "TAKE_COFFEE", index: 0 },
    { type: "TAKE_COFFEE", index: 1 },
    { type: "USE_READER" },
    { type: "KNOCK" },
    { type: "TAKE_BADGE" },
    { type: "BADGE_LINE_FINISHED" },
    { type: "USE_READER" },
    { type: "REACH_SARAH" },
  ];

  let state = initialPrologueQuestState();
  const phases: string[] = [];
  const steps = events.map((event) => {
    state = advancePrologueQuest(state, event);
    phases.push(prologuePhaseFor(state));
    return state.step;
  });

  assert.deepEqual(steps, [
    "coffee-2",
    "reach-lab",
    "knock",
    "find-badge",
    "scan-badge",
    "scan-badge",
    "reach-sarah",
    "complete",
  ]);
  assert.deepEqual(phases, [
    "coffee",
    "to-glass",
    "knock",
    "to-badge",
    "to-badge",
    "to-glass",
    "to-sarah",
    "accident",
  ]);
});

test("early and out-of-order actions leave quest state unchanged", () => {
  const initial = initialPrologueQuestState();
  const attempted = run(
    initial,
    { type: "USE_READER" },
    { type: "KNOCK" },
    { type: "TAKE_BADGE" },
    { type: "BADGE_LINE_FINISHED" },
    { type: "REACH_SARAH" },
    { type: "TAKE_COFFEE", index: 1 },
  );

  assert.strictEqual(attempted, initial);
});

test("resume phases restore the matching stable quest state", () => {
  assert.deepEqual(prologueQuestStateForResume("to-glass"), {
    step: "reach-lab",
    coffeeCount: 2,
    hasBadge: false,
    readerEnabled: true,
  });
  assert.deepEqual(prologueQuestStateForResume("to-badge"), {
    step: "find-badge",
    coffeeCount: 2,
    hasBadge: false,
    readerEnabled: false,
  });
  assert.deepEqual(prologueQuestStateForResume("to-sarah"), {
    step: "reach-sarah",
    coffeeCount: 2,
    hasBadge: true,
    readerEnabled: true,
  });
});

test("duplicate interactions are ignored and the badge line gates the reader", () => {
  const afterFirstCoffee = advancePrologueQuest(initialPrologueQuestState(), {
    type: "TAKE_COFFEE",
    index: 0,
  });
  assert.strictEqual(
    advancePrologueQuest(afterFirstCoffee, { type: "TAKE_COFFEE", index: 0 }),
    afterFirstCoffee,
  );

  const atKnock = run(
    afterFirstCoffee,
    { type: "TAKE_COFFEE", index: 1 },
    { type: "USE_READER" },
  );
  const afterKnock = advancePrologueQuest(atKnock, { type: "KNOCK" });
  assert.strictEqual(
    advancePrologueQuest(afterKnock, { type: "KNOCK" }),
    afterKnock,
  );

  const badgeFound = advancePrologueQuest(afterKnock, { type: "TAKE_BADGE" });
  assert.equal(badgeFound.readerEnabled, false);
  assert.strictEqual(
    advancePrologueQuest(badgeFound, { type: "USE_READER" }),
    badgeFound,
  );

  const readerReady = advancePrologueQuest(badgeFound, {
    type: "BADGE_LINE_FINISHED",
  });
  assert.equal(readerReady.readerEnabled, true);
  assert.equal(
    advancePrologueQuest(readerReady, { type: "USE_READER" }).step,
    "reach-sarah",
  );
});
