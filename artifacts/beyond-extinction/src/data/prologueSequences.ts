import type { TimelineStep } from "../engine/SequenceDirector";

/**
 * The Lab Prologue as voiced cutscene timelines. Each array is a story beat the
 * scene hands to its {@link SequenceDirector} (see PrologueCafeteriaScene); the
 * scene's Phase machine still gates BETWEEN beats (the player must deliver the
 * coffee, reach the console, dash to Sarah), while these timelines drive the
 * voiced lines, synced subtitles, scripted camera framings, and character
 * gestures WITHIN each beat.
 *
 * Clip ids reference the VOICE_CLIPS manifest, the single source of truth for
 * both the baked audio and the on-screen subtitle text. Gesture clip names are
 * real animations shipped in the character GLBs (the shared rig retargets any
 * clip to either character — see ClipLibrary); a missing name is a safe no-op.
 */

/** Cold open: a wide establishing shot while Jack's journal narration plays. */
export const labOpeningNarration: TimelineStep[] = [
  { kind: "camera", moment: "establishing", cut: true },
  { kind: "wait", ms: 1000 },
  { kind: "say", clip: "lab_narr_01" },
  { kind: "say", clip: "lab_narr_02" },
  { kind: "wait", ms: 400 },
  { kind: "clearSubtitle" },
  { kind: "clearCamera" },
];

/** Coffee delivery / first exchange at Sarah's side (intro-dialogue phase). */
export const introSequence: TimelineStep[] = [
  { kind: "say", clip: "lab_a_01" }, // Jack: Sarah.
  { kind: "say", clip: "lab_a_02" }, // Jack: What's happening?
  { kind: "gesture", actor: "sarah", clip: "Checkout_Gesture" },
  { kind: "say", clip: "lab_a_03" }, // Sarah: A resonance cascade...
  { kind: "say", clip: "lab_a_04" }, // Jack: Should I call someone?
  { kind: "say", clip: "lab_a_05" }, // Sarah: I'm the someone they would call.
  { kind: "say", clip: "lab_a_06" }, // Jack: How bad?
  { kind: "gesture", actor: "sarah", clip: "Shrug" },
  { kind: "say", clip: "lab_a_07" }, // Sarah: I don't know yet.
];

/** Console work as the cascade goes critical (console-dialogue phase). */
export const consoleSequence: TimelineStep[] = [
  { kind: "gesture", actor: "sarah", clip: "Checkout_Gesture" },
  { kind: "say", clip: "lab_b_01" }, // Sarah: Get out.
  { kind: "say", clip: "lab_b_02" }, // Jack: I'm not leaving you.
  { kind: "gesture", actor: "sarah", clip: "Catching_Breath" },
  { kind: "say", clip: "lab_b_03" }, // Sarah: Jack. Get out of the lab. Right now.
];

/** Alarm narration over the cascade (reach-sarah phase, control withheld). */
export const alarmNarration: TimelineStep[] = [
  { kind: "say", clip: "lab_narr_03" }, // The alarms started at eleven forty-seven...
];

/** The vortex opens: wall-glow narration as it grows (vortex phase). */
export const vortexNarration: TimelineStep[] = [
  { kind: "camera", moment: "climax", cut: true },
  { kind: "say", clip: "lab_narr_04" }, // The far wall began to glow...
];

/** The final exchange before the pull-in. */
export const vortexDialogue: TimelineStep[] = [
  { kind: "say", clip: "lab_c_01" }, // Sarah: We have to go.
  { kind: "say", clip: "lab_c_02" }, // Jack: Sarah, what is that—
  { kind: "gesture", actor: "sarah", clip: "Catching_Breath" },
  { kind: "say", clip: "lab_c_03" }, // Sarah: Now!
];

/** Jack reaches for Sarah's hand; the climax exchange on a tight two-shot. */
export const climaxReach: TimelineStep[] = [
  { kind: "say", clip: "lab_narr_05" }, // I reached for her hand. I found it.
  { kind: "say", clip: "lab_c_04" }, // Sarah: Jack!
  { kind: "say", clip: "lab_c_05" }, // Jack: I've got you. I've got you—
];

/** The closing narration as the light takes everything. */
export const climaxEnd: TimelineStep[] = [
  { kind: "say", clip: "lab_narr_06" }, // Her other hand... the light swallowed everything.
];
