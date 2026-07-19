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

  // ===================================================================
  // Prologue VO imported from the uploaded assets pack. These mp3s are the
  // Godot project's own recordings (assets/audio/vo/jack_*·sarah_*) and the
  // line text is copied verbatim from lab_builder.gd — the single source of
  // truth — so the web plays exactly what the Godot prologue does.
  // ===================================================================
  narrate(
    "jack_journal_entry_zero",
    "The lab journal, entry zero. Before the island. Before everything. I keep this because Sarah asked me to. She said engineers make terrible storytellers because we skip the human parts. So here are the human parts.",
  ),
  jack("jack_get_coffee", "It's almost midnight, let me get Sarah some coffee and bring it to her."),
  jack("jack_to_sarah", "Nice. Now to Sarah."),
  jack("jack_no_response", "Hmm, that's strange. No response, but I do need to find my badge to make sure everything is okay."),
  jack("jack_badge_found", "There it is... Ah, that's right; I was working here a few minutes ago. Now let's try that again."),
  // Coffee-ritual exchange at Sarah's console (Godot lab_builder.gd:866-872).
  sarah("sarah_dont_have_to", "You don't have to do that."),
  jack("jack_i_did_it_anyway", "I know. I did it anyway."),
  sarah("sarah_look_at_readings", "Look at these readings. Something's wrong."),
  jack("jack_should_i_call", "Should I call someone?"),
  sarah("sarah_im_the_someone", "I'm the someone they would call."),
  jack("jack_how_bad", "How bad?"),
  sarah("sarah_dont_know_yet", "I don't know yet."),
  // The accident (Godot lab_builder.gd:907-918).
  jack("jack_what_happened", "What happened?"),
  sarah("sarah_cascade_failing", "The cascade is failing — I need to get to the manual override."),
  sarah("sarah_find_flashlight", "There's an emergency flashlight on my station. Go — find it!"),

  // --- At Sarah's console (earlier web-scripted alt take, kept for the opening) ---
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

  // --- Chapter Two: "Day One — Arrival" (the island) ---
  narrate(
    "ch2_jack_journal",
    "Day one. I don't know where we are. I don't know how we got here. I know we're alive. For now, that's enough.",
  ),
  // The nightmare — Jack relives the chase in first person, radio-drama style
  // over the black journal screen while the island streams in. Split into
  // beats so each page of text fits the screen and the SFX can hit between
  // lines (roar before it starts, crashes/roar/lunge on their own beats).
  narrate(
    "ch2_nightmare_01",
    "I was running. Not jogging. Not sprinting. Full terror running. The kind where your lungs catch fire and your legs scream for mercy. The kind where stopping means dying.",
  ),
  narrate(
    "ch2_nightmare_02",
    "Behind me, something massive crashed through the jungle. Trees splintered like dry bones. The ground shook with each thundering footstep. Closer. Always closer.",
  ),
  narrate(
    "ch2_nightmare_03",
    "I risked a glance over my shoulder. Golden eyes burned through the green. Rows of teeth gleamed like wet daggers. A roar shook the air and rattled my ribs.",
  ),
  narrate(
    "ch2_nightmare_04",
    "The creature lunged. I stumbled on my knees hitting the dirt. The prehistoric beast filled my vision, jaws wide, breath hot and rank. I threw up my arms, waking up gasping for air.",
  ),
  jack("ch2_jack_sarah_shout", "SARAH!"),
];

/** Lookup by clip id, with measured durations folded in (see voiceDurations). */
export const VOICE_CLIPS: Record<string, VoiceClip> = Object.fromEntries(
  VOICE_CLIP_LIST.map((c) => [
    c.id,
    { ...c, durationMs: c.durationMs ?? VOICE_DURATIONS[c.id] },
  ]),
);
