/**
 * Dev-time music & SFX baker for the prologue lab scene. Generates each cue via
 * MusicGPT — MusicAI for the looping music beds (calm + suspense),
 * SoundGenerator for the one-shot SFX — and downloads the results into
 * public/assets/audio/. WAV results are transcoded to mp3 so the committed
 * assets stay small and consistent with the rest of the audio.
 *
 * Nothing here runs at app runtime: the game ships these as static, committed
 * assets. GitHub Pages has no server, and the API key must never reach the
 * client — so all generation happens once, here, at dev time.
 *
 * RESUMABLE BY DESIGN. MusicGPT generation is asynchronous (ETAs of 1–3 min),
 * longer than a single foreground shell call. So this script splits the work:
 *   1. START  — POST each request once and record its conversion id(s) to a
 *               local state file (so a re-run NEVER re-charges credits).
 *   2. FETCH  — poll the byId endpoint for queued conversions and download the
 *               ones that have completed.
 * Run it repeatedly until it reports everything done:
 *   pnpm exec tsx scripts/generate-music.ts                 # start + fetch (~95s)
 *   pnpm exec tsx scripts/generate-music.ts --only=alarm    # just one cue
 *   pnpm exec tsx scripts/generate-music.ts --force         # re-queue everything
 *
 * Requires MUSICGPT_API_KEY in the environment (never printed).
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_KEY = process.env.MUSICGPT_API_KEY ?? "";
if (!API_KEY) {
  console.error("Missing MUSICGPT_API_KEY secret in environment.");
  process.exit(1);
}

const API = "https://api.musicgpt.com/api/public/v1";
const POLL_INTERVAL_MS = 8000;
const RUN_BUDGET_MS = 95_000; // stay under the foreground shell call limit

const FORCE = process.argv.includes("--force");
const ONLY = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;
  return new Set(arg.slice("--only=".length).split(",").map((s) => s.trim()));
})();

type MusicSpec = {
  id: string;
  kind: "music";
  prompt: string;
  music_style: string;
  output_length: number; // seconds (experimental)
};
type SfxSpec = {
  id: string;
  kind: "sfx";
  prompt: string;
  audio_length: number; // seconds (beta)
};
type Spec = MusicSpec | SfxSpec;

/**
 * The lab cue list. Music beds loop under the scene: the calm bed fades in over
 * the main theme as the lab opens, then crossfades to the suspense bed on the
 * alarm beat. The four SFX back the scripted one-shots (coffee pour, alarm,
 * vortex open, vortex pull). Prompts kept under ~280 chars per the API guidance.
 */
const TRACKS: Spec[] = [
  {
    id: "lab-calm",
    kind: "music",
    prompt:
      "Calm, mysterious ambient underscore for a late-night research lab. " +
      "Soft sustained synth pads, warm drones, a slow subtle pulse, faint " +
      "shimmer, quiet wonder and unease. No drums, no melody hook — a seamless " +
      "atmospheric bed that loops. Cinematic, restrained, tense.",
    music_style: "Ambient cinematic underscore, dark ambient, atmospheric",
    output_length: 120,
  },
  {
    id: "lab-suspense",
    kind: "music",
    prompt:
      "Tense, urgent suspense for a lab emergency. Calm pads darken into a low " +
      "driving pulse, rising dread, ticking tension, swelling bass throbs and " +
      "strings. Cinematic action underscore that loops, building danger. Same " +
      "dark synth palette as the calm bed.",
    music_style: "Cinematic suspense, dark electronic, tension underscore",
    output_length: 120,
  },
  {
    id: "coffee-pour",
    kind: "sfx",
    prompt:
      "Hot coffee pouring into a ceramic mug, steady liquid stream, gentle " +
      "splashing, close-up foley, no music.",
    audio_length: 6,
  },
  {
    id: "alarm",
    kind: "sfx",
    prompt:
      "Emergency facility alarm: a repeating electronic klaxon warning siren, " +
      "urgent, blaring, sci-fi lab evacuation.",
    audio_length: 6,
  },
  {
    id: "vortex-open",
    kind: "sfx",
    prompt:
      "A swirling energy portal tearing open: deep rising whoosh, crackling " +
      "arcane energy, sci-fi wormhole forming.",
    audio_length: 6,
  },
  {
    id: "vortex-pull",
    kind: "sfx",
    prompt:
      "Powerful suction pulling bodies into a portal: deep bass whoosh, " +
      "swirling sci-fi vortex collapse, sucking air.",
    audio_length: 6,
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = join(root, "public", "assets", "audio");
mkdirSync(outDir, { recursive: true });

// State persists queued conversion ids between runs so re-running never re-POSTs.
const STATE_FILE = join(here, ".musicgen-state.json");
type Item = {
  cid: string;
  file: string; // basename written into outDir
  optional: boolean; // alt music takes are nice-to-have, never block "done"
  done: boolean;
  failed?: boolean; // server-side FAILED/ERROR — terminal, needs --force re-queue
};
type State = Record<string, { type: "MUSIC_AI" | "SOUND_GENERATOR"; items: Item[] }>;

function loadState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}
function saveState(state: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startMusic(spec: MusicSpec): Promise<Item[]> {
  const res = await fetch(`${API}/MusicAI`, {
    method: "POST",
    headers: { Authorization: API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: spec.prompt,
      music_style: spec.music_style,
      make_instrumental: true,
      output_length: spec.output_length,
    }),
  });
  const json: any = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(`MusicAI ${spec.id} → ${res.status} ${JSON.stringify(json)}`);
  }
  console.log(`  queued ${spec.id} (eta ${json.eta}s, ~${json.credit_estimate} credits)`);
  return [
    { cid: json.conversion_id_1, file: `${spec.id}.mp3`, optional: false, done: false },
    { cid: json.conversion_id_2, file: `${spec.id}.alt.mp3`, optional: true, done: false },
  ];
}

async function startSfx(spec: SfxSpec): Promise<Item[]> {
  const res = await fetch(`${API}/sound_generator`, {
    method: "POST",
    headers: {
      Authorization: API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      prompt: spec.prompt,
      audio_length: String(spec.audio_length),
    }),
  });
  const json: any = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(`SoundGenerator ${spec.id} → ${res.status} ${JSON.stringify(json)}`);
  }
  console.log(`  queued ${spec.id} (eta ${json.eta}s, ~${json.credit_estimate} credits)`);
  return [{ cid: json.conversion_id, file: `${spec.id}.mp3`, optional: false, done: false }];
}

/** One status poll → returns audio_url if COMPLETED, null if still pending. */
async function pollOnce(
  type: "MUSIC_AI" | "SOUND_GENERATOR",
  cid: string,
): Promise<string | null> {
  const qs = new URLSearchParams({ conversionType: type, conversion_id: cid });
  const res = await fetch(`${API}/byId?${qs}`, {
    headers: { Authorization: API_KEY },
  });
  const json: any = await res.json();
  const conv = json?.conversion ?? {};
  const status = String(conv.status ?? "").toUpperCase();
  if (status === "ERROR" || status === "FAILED") {
    throw new Error(`${cid}: ${status} — ${conv.status_msg ?? conv.message ?? ""}`);
  }
  if (status !== "COMPLETED") return null;
  // MusicAI returns ONE object holding BOTH versions; pick the standard-mp3
  // path whose conversion id matches the one we're fetching. SoundGenerator
  // returns a single audio_url (often WAV → transcoded on download).
  if (type === "MUSIC_AI") {
    if (cid === conv.conversion_id_1) {
      return conv.conversion_path_1 ?? conv.conversion_path_wav_1 ?? null;
    }
    if (cid === conv.conversion_id_2) {
      return conv.conversion_path_2 ?? conv.conversion_path_wav_2 ?? null;
    }
    return conv.conversion_path_1 ?? null;
  }
  const url = conv.audio_url || conv.conversion_path || conv.conversion_path_wav;
  if (!url) throw new Error(`${cid}: COMPLETED but no audio_url`);
  return url;
}

async function downloadMp3(audioUrl: string, destMp3: string): Promise<void> {
  const res = await fetch(audioUrl);
  if (!res.ok) throw new Error(`download ${audioUrl} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!/\.wav(\?|$)/i.test(audioUrl)) {
    writeFileSync(destMp3, buf);
    return;
  }
  const tmpWav = destMp3.replace(/\.mp3$/, ".tmp.wav");
  writeFileSync(tmpWav, buf);
  try {
    execFileSync("ffmpeg", [
      "-y", "-i", tmpWav, "-codec:a", "libmp3lame", "-q:a", "4", destMp3,
    ], { stdio: "ignore" });
  } finally {
    rmSync(tmpWav, { force: true });
  }
}

function durationMs(file: string): number {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", file,
    ]).toString().trim();
    return Math.round(parseFloat(out) * 1000);
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const state = loadState();
  const selected = TRACKS.filter((s) => !ONLY || ONLY.has(s.id));

  // ── START: queue any spec that isn't already queued / already on disk. ──
  for (const spec of selected) {
    const canonical = join(outDir, `${spec.id}.mp3`);
    if (FORCE) delete state[spec.id];
    if (!FORCE && (existsSync(canonical) || state[spec.id])) continue;
    process.stdout.write(`queueing ${spec.id}... `);
    try {
      const items = spec.kind === "music"
        ? await startMusic(spec)
        : await startSfx(spec);
      state[spec.id] = {
        type: spec.kind === "music" ? "MUSIC_AI" : "SOUND_GENERATOR",
        items,
      };
      saveState(state);
    } catch (err) {
      console.error(`\n  ✘ queue ${spec.id} failed: ${String(err)}`);
    }
  }

  // ── FETCH: poll + download until required cues land or the time budget ends. ──
  const deadline = Date.now() + RUN_BUDGET_MS;
  const pending = () =>
    selected.flatMap((spec) => {
      const entry = state[spec.id];
      if (!entry) return [];
      return entry.items
        .filter((it) => !it.done && !it.failed && !existsSync(join(outDir, it.file)))
        .map((it) => ({ id: spec.id, type: entry.type, it }));
    });

  while (Date.now() < deadline) {
    const todo = pending();
    if (todo.length === 0) break;
    for (const { id, type, it } of todo) {
      try {
        const url = await pollOnce(type, it.cid);
        if (!url) continue;
        await downloadMp3(url, join(outDir, it.file));
        it.done = true;
        saveState(state);
        console.log(`  ✔ ${it.file} (${durationMs(join(outDir, it.file))}ms)`);
      } catch (err) {
        const msg = String(err);
        console.error(`  ✘ ${it.file}: ${msg}`);
        // A server-side FAILED/ERROR is terminal — stop polling it this run.
        if (/FAILED|ERROR/.test(msg)) { it.failed = true; saveState(state); }
      }
    }
    // Are all *required* cues now present? If so, stop early.
    const requiredLeft = selected.some((spec) =>
      (state[spec.id]?.items ?? []).some(
        (it) => !it.optional && !it.done && !existsSync(join(outDir, it.file)),
      ),
    );
    if (!requiredLeft && pending().every((p) => p.it.optional)) {
      // only optional (alt) takes remain — try one more pass then exit
      const opt = pending();
      for (const { type, it } of opt) {
        try {
          const url = await pollOnce(type, it.cid);
          if (url) {
            await downloadMp3(url, join(outDir, it.file));
            it.done = true;
            saveState(state);
            console.log(`  ✔ ${it.file} (alt take)`);
          }
        } catch { /* optional — ignore */ }
      }
      break;
    }
    if (pending().length) await sleep(POLL_INTERVAL_MS);
  }

  // ── Report ──
  const req = (spec: Spec, pred: (it: Item) => boolean) =>
    (state[spec.id]?.items ?? []).some((it) => !it.optional && pred(it));
  const failedIds = selected.filter((s) => req(s, (it) => !!it.failed)).map((s) => s.id);
  const pendingIds = selected
    .filter((s) => req(s, (it) => !it.done && !it.failed && !existsSync(join(outDir, it.file))))
    .map((s) => s.id);

  console.log(`\nOutput → ${outDir}`);
  if (failedIds.length) {
    console.log(`Failed (re-run with --force to retry): ${failedIds.join(", ")}`);
  }
  if (pendingIds.length) {
    console.log(`Still generating: ${pendingIds.join(", ")} — re-run to fetch.`);
  }
  if (failedIds.length || pendingIds.length) process.exit(2);
  console.log("All required cues downloaded. Done.");
}

void main();
