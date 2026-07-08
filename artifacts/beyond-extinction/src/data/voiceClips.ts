/**
 * Voice-over manifest — the single source of truth for every spoken line in
 * the prologue. Each clip's `text` is BOTH the line synthesized at dev-time by
 * the ElevenLabs generation script AND the subtitle shown on screen, so the two
 * can never drift apart.
 *
 * Voice casting rule: Jack narrates all journal/narration text and his own
 * dialogue; Sarah voices only her own lines (no third-party narrator).
 *
 * Audio is PRE-BAKED. The generator writes one mp3 per clip into
 * `public/assets/audio/vo/<id>.mp3`; nothing calls ElevenLabs at runtime.
 */
import { VOICE_DURATIONS } from "./voiceDurations";

/** Voice IDs are public identifiers (not secrets). */
export const JACK_VOICE_ID = "mkT7KpSQR9btjx2rHpQY";
export const SARAH_VOICE_ID = "MClEFoImJXBTgLwdLI5n";

export type SpeakerId = "Jack" | "Sarah";

export interface VoiceClip {
  id: string;
  speaker: SpeakerId;
  /** ElevenLabs voice id used to synthesize this clip. */
  voiceId: string;
  /** Relative path under public/ for the baked mp3. */
  src: string;
  /** Exact line to synthesize and to display as a subtitle. */
  text: string;
  /** Measured duration (ms); optional, filled in by the generator if available. */
  durationMs?: number;
  /** True for journal/narration lines (shown without a speaker name, italicized). */
  narration?: boolean;
}

const VO_DIR = "assets/audio/vo";

function jack(id: string, text: string): VoiceClip {
  return { id, speaker: "Jack", voiceId: JACK_VOICE_ID, src: `${VO_DIR}/${id}.mp3`, text };
}
function sarah(id: string, text: string): VoiceClip {
  return { id, speaker: "Sarah", voiceId: SARAH_VOICE_ID, src: `${VO_DIR}/${id}.mp3`, text };
}
/** Jack's first-person journal narration (Jack's voice, narration styling). */
function narrate(id: string, text: string): VoiceClip {
  return {
    id,
    speaker: "Jack",
    voiceId: JACK_VOICE_ID,
    src: `${VO_DIR}/${id}.mp3`,
    text,
    narration: true,
  };
}

/**
 * Prologue script, in story order. Adapted faithfully from Chapter One
 * ("Before"): Jack's first-person journal narration plus the in-scene
 * dialogue. Text is easy to tweak — edit a line here and re-run the generator.
 */
export const VOICE_CLIP_LIST: VoiceClip[] = [
  // --- Journal intro: entry zero, narrated over a black screen ---
  narrate("intro_01", "The lab journal. Entry zero. Before the island. Before everything."),
  narrate(
    "intro_02",
    "I keep this because Sarah asked me to. She said engineers make terrible storytellers, because we skip the human parts. So here are the human parts.",
  ),

  // --- Lab arrival: the Tuesday ritual ---
  narrate(
    "lab_narr_01",
    "I'd made the same mistake every Tuesday for three years. Two coffees from the cart on Level B, carried all the way down to Lab Seven. She always told me I didn't have to. She always took it anyway. That was how we worked.",
  ),
  narrate(
    "lab_narr_02",
    "The Tuesday it all ended started like every other Tuesday. But this time, when I knocked on the glass, Sarah didn't look up.",
  ),

  // --- Server room: Jack spots his dropped badge (Godot jack_badge_found) ---
  jack(
    "lab_badge_found",
    "There it is... Ah, that's right; I was working here a few minutes ago. Now let's try that again.",
  ),

  // --- At Sarah's console ---
  jack("lab_a_01", "Sarah."),
  jack("lab_a_02", "What's happening?"),
  sarah(
    "lab_a_03",
    "A resonance cascade. Something in the calibration. I've been trying to compensate for the last two hours.",
  ),
  jack("lab_a_04", "Should I call someone?"),
  sarah(
    "lab_a_05",
    "I'm the someone they would call. This is my project. My reactor. My problem.",
  ),
  jack("lab_a_06", "How bad?"),
  sarah("lab_a_07", "I don't know yet."),

  // --- The cascade and the alarms ---
  narrate(
    "lab_narr_03",
    "The alarms started at eleven forty-seven. Not the gradual kind. The immediate kind. Every light in Lab Seven turned red.",
  ),
  sarah("lab_b_01", "Get out."),
  jack("lab_b_02", "I'm not leaving you."),
  sarah("lab_b_03", "Jack. Get out of the lab. Right now."),

  // --- The vortex ---
  narrate(
    "lab_narr_04",
    "The far wall began to glow. Not white, not gold — the color of a sound too loud to hear. And then it was not subtle at all.",
  ),
  sarah("lab_c_01", "We have to go."),
  jack("lab_c_02", "Sarah, what is that—"),
  sarah("lab_c_03", "Now!"),
  narrate(
    "lab_narr_05",
    "I felt myself come apart at the seams. Not pain — dissolution. The feeling of being pulled in too many directions to stay whole. I reached for her hand. I found it.",
  ),
  sarah("lab_c_04", "Jack!"),
  jack("lab_c_05", "I've got you. I've got you—"),
  narrate(
    "lab_narr_06",
    "Her other hand wasn't reaching for the door. It had gone to her stomach. I almost had time to wonder why. Then the light swallowed everything.",
  ),
];

/** Lookup by clip id, with measured durations folded in (see voiceDurations). */
export const VOICE_CLIPS: Record<string, VoiceClip> = Object.fromEntries(
  VOICE_CLIP_LIST.map((c) => [
    c.id,
    { ...c, durationMs: c.durationMs ?? VOICE_DURATIONS[c.id] },
  ]),
);
