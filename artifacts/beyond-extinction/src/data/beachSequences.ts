import type { TimelineStep } from "../engine/SequenceDirector";

/**
 * Chapter One opening, the first beat authored entirely on the reusable
 * "directed gameplay" timeline (see SequenceDirector). The scene hands this one
 * array to its director, which plays the narration/dialogue beats and pauses at
 * the player-input gates: `interaction` steps for routine ACTIONS (find Sarah,
 * gather driftwood) and a single genuine `choice` the player always owns.
 *
 * This beat is subtitle-driven — no baked voice-over yet (the full Chapter Two
 * VO pass is a later task). Per the project voice rule, Jack carries every
 * narration line AND his own dialogue; Sarah speaks only her own lines.
 *
 * Interaction ids (`find-sarah`, `gather-driftwood`) are resolved by the scene's
 * interaction registry, which also owns each gate's side effect (Sarah standing,
 * Jack gathering). Camera moment names map to the scene's cameraMoment().
 */
export const beachStory: TimelineStep[] = [
  // Cold open — Jack comes to on the sand, close on him.
  { kind: "camera", moment: "wake", cut: true },
  { kind: "wait", ms: 700 },
  {
    kind: "subtitle",
    narration: true,
    text: "The sky was the wrong shade of blue. Too bright. Too much air.",
    holdMs: 3600,
  },
  {
    kind: "subtitle",
    speaker: "Jack",
    text: "Sand. Salt. Sun on my face. I'm... still here.",
    holdMs: 3000,
  },
  {
    kind: "subtitle",
    speaker: "Jack",
    text: "Sarah. Where's Sarah?",
    holdMs: 2400,
  },
  { kind: "clearSubtitle" },
  { kind: "clearCamera" },

  // ACTION: find Sarah down the beach. The scene wakes her on arrival.
  { kind: "interaction", id: "find-sarah", objective: "Find Sarah" },

  // Two-shot banter once she's on her feet.
  { kind: "camera", moment: "two-shot", cut: true },
  {
    kind: "subtitle",
    speaker: "Jack",
    text: "Sarah — hey. You're okay. We made it.",
    holdMs: 2800,
  },
  {
    kind: "subtitle",
    speaker: "Sarah",
    text: "Made it where, exactly? This isn't any beach I've seen.",
    holdMs: 3400,
  },
  {
    kind: "subtitle",
    speaker: "Jack",
    text: "I don't know. But we shouldn't sit in the open. Let's get a fire going.",
    holdMs: 3600,
  },
  { kind: "clearSubtitle" },
  { kind: "clearCamera" },

  // ACTION: gather the driftwood scattered up the sand.
  {
    kind: "interaction",
    id: "gather-driftwood",
    objective: "Gather driftwood for a signal fire",
  },
  {
    kind: "subtitle",
    speaker: "Jack",
    text: "Enough for a fire. If anyone's out there, they'll see the smoke.",
    holdMs: 3400,
  },
  { kind: "clearSubtitle" },

  // A wonder beat — the dodo.
  { kind: "camera", moment: "dodo", cut: true },
  {
    kind: "subtitle",
    speaker: "Jack",
    text: "That bird... it isn't afraid of me at all. Like it's never seen a person.",
    holdMs: 3800,
  },
  {
    kind: "subtitle",
    speaker: "Sarah",
    text: "Jack. That's a dodo. They've been extinct for three hundred years.",
    holdMs: 3800,
  },
  { kind: "clearSubtitle" },
  { kind: "clearCamera" },

  // The one genuine CHOICE — never auto-resolved, even under Auto Play.
  {
    kind: "choice",
    prompt: "Which way do we go?",
    objective: "Decide which way to head",
    options: [
      {
        id: "treeline",
        label: "Head for the treeline",
        steps: [
          { kind: "camera", moment: "treeline", cut: true },
          {
            kind: "subtitle",
            speaker: "Jack",
            text: "The trees mean shade, fresh water, cover. We go in.",
            holdMs: 3400,
          },
          { kind: "clearSubtitle" },
          { kind: "clearCamera" },
        ],
      },
      {
        id: "shoreline",
        label: "Follow the shoreline",
        steps: [
          { kind: "camera", moment: "shoreline", cut: true },
          {
            kind: "subtitle",
            speaker: "Jack",
            text: "We follow the water. A coastline always leads somewhere.",
            holdMs: 3400,
          },
          { kind: "clearSubtitle" },
          { kind: "clearCamera" },
        ],
      },
    ],
  },

  // Converge — then the chase teaser that ends the slice.
  { kind: "camera", moment: "two-shot", cut: true },
  {
    kind: "subtitle",
    speaker: "Sarah",
    text: "Stay close. Whatever's out here, it isn't in any book.",
    holdMs: 3200,
  },
  { kind: "clearSubtitle" },
  { kind: "clearCamera" },

  // The hiss from the trees (the scene plays the SFX + startles the dodo when
  // this moment goes live).
  { kind: "camera", moment: "chase", cut: true },
  {
    kind: "subtitle",
    narration: true,
    text: "Something larger shifted in the trees. And hissed.",
    holdMs: 3200,
  },
  { kind: "clearSubtitle" },
];
