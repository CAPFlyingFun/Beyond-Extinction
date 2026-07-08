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

/**
 * Cold open: Jack's journal narration plays over a scripted "establishing"
 * camera path (setCameraMoment("establishing") in playLabOpening) that opens on
 * Sarah at the lab console and travels west through the glass door, down the
 * hallway and across the cafeteria to Jack, then hard-cuts to first-person. Jack
 * stays idle at the cafeteria end the whole time — the camera moves, not him
 * (see PrologueCafeteriaScene.playLabOpening + OPENING_CAM_PATH).
 */
export const labOpeningNarration: TimelineStep[] = [
  // Hold a beat so the lab-calm crossfade (kicked off on scene enter, ~4s) is
  // most of the way done and clearly the music playing BEFORE Jack's first line.
  { kind: "wait", ms: 3000 },
  { kind: "say", clip: "lab_narr_01" },
  { kind: "say", clip: "lab_narr_02" },
  { kind: "wait", ms: 400 },
  { kind: "clearSubtitle" },
];

/**
 * Jack picks up his dropped badge in the server room. In Godot the badge reader
 * stays locked until this line finishes (so the player can't re-scan mid-audio);
 * the scene reproduces that by only re-arming the glass-door reader once this
 * sequence resolves (see PrologueCafeteriaScene.onPickUpBadge).
 */
export const badgeFound: TimelineStep[] = [
  { kind: "say", clip: "jack_badge_found" },
];

/**
 * The coffee-ritual exchange at Sarah's console, voiced with the uploaded
 * Godot recordings — verbatim from lab_builder.gd:866-872.
 */
export const introSequence: TimelineStep[] = [
  { kind: "say", clip: "sarah_dont_have_to" }, // Sarah: You don't have to do that.
  { kind: "say", clip: "jack_i_did_it_anyway" }, // Jack: I know. I did it anyway.
  { kind: "gesture", actor: "sarah", clip: "Checkout_Gesture" },
  { kind: "say", clip: "sarah_look_at_readings" }, // Sarah: Look at these readings...
  { kind: "say", clip: "jack_should_i_call" }, // Jack: Should I call someone?
  { kind: "say", clip: "sarah_im_the_someone" }, // Sarah: I'm the someone they would call.
  { kind: "say", clip: "jack_how_bad" }, // Jack: How bad?
  { kind: "gesture", actor: "sarah", clip: "Shrug" },
  { kind: "say", clip: "sarah_dont_know_yet" }, // Sarah: I don't know yet.
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

/**
 * The portal cutscene's voiced climax, played CONCURRENTLY with the visual
 * pull-in (see PrologueCafeteriaScene.playPortalCutscene). No camera step here:
 * the portal owns the "core-pull" framing, so this only drives the narration and
 * the final two-shot lines while the ring goes white-hot and both are drawn in.
 */
export const portalClimax: TimelineStep[] = [
  { kind: "say", clip: "lab_narr_04" }, // The far wall began to glow...
  { kind: "say", clip: "lab_narr_05" }, // I reached for her hand. I found it.
  { kind: "say", clip: "lab_c_04" }, // Sarah: Jack!
  { kind: "say", clip: "lab_c_05" }, // Jack: I've got you. I've got you—
  { kind: "say", clip: "lab_narr_06" }, // ...the light swallowed everything.
];
