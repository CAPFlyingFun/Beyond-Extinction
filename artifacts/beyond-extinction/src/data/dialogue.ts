import type { DialogueLine } from "../engine/DialogueManager";

const JACK = "assets/portraits/Jack.PNG";
// Sarah's base portrait is her 8-weeks lab look. The pregnancy-progression and
// beach variants ship alongside it (assets/portraits/Sarah_18_weeks.png ...
// Sarah_40_weeks.png, Sarah_Beach_12.png) for later scenes to swap in.
const SARAH = "assets/portraits/Sarah.PNG";

/** Beat 1: Jack arrives at Lab Seven with two coffees. */
export const cafeteriaIntro: DialogueLine[] = [
  {
    speaker: "Jack",
    portrait: JACK,
    text: "Two coffees. One for me, one for the genius who forgot to sleep again.",
  },
  {
    speaker: "Sarah",
    portrait: SARAH,
    text: "You're a lifesaver. The resonance numbers finally stabilized — Jack, I think we actually did it.",
  },
  {
    speaker: "Jack",
    portrait: JACK,
    text: "It's almost midnight. Whatever 'it' is, it can wait until morning, can't it?",
  },
  {
    speaker: "Sarah",
    portrait: SARAH,
    text: "Just one more reading. The accelerator's never been this quiet. Come look at this.",
  },
  {
    speaker: "Jack",
    portrait: JACK,
    text: "Alright, alright. Lead the way. But after this, I'm driving you home — no arguments.",
  },
  {
    speaker: "Sarah",
    portrait: SARAH,
    text: "Deal. Come on — the console's right through here. You're going to want to see this for yourself.",
  },
];

/** Beat 2: at the console, right before the cascade. */
export const consoleBeat: DialogueLine[] = [
  {
    speaker: "Sarah",
    portrait: SARAH,
    text: "See the harmonic? It's holding perfectly. No drift, no decay. It shouldn't be possible.",
  },
  {
    speaker: "Jack",
    portrait: JACK,
    text: "Sarah... the gauges are climbing. All of them. That's not stable, that's—",
  },
  {
    speaker: "Sarah",
    portrait: SARAH,
    text: "Resonance cascade. It's feeding itself. Shut it down — Jack, shut it DOWN!",
  },
];

/** Beat 3: the vortex opens. */
export const vortexBeat: DialogueLine[] = [
  {
    speaker: "Jack",
    portrait: JACK,
    text: "It's not a light. It's not anything. It's like the color of pressure becoming unbearable.",
  },
  {
    speaker: "Sarah",
    portrait: SARAH,
    text: "Jack — it's pulling everything in. Take my hand. Don't let go, whatever happens, don't let go!",
  },
  {
    speaker: "Jack",
    portrait: JACK,
    text: "I've got you! Both of you — I've got you—",
  },
];
