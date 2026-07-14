#!/usr/bin/env node
/**
 * Beyond Extinction — script parser
 * Reads the markdown cinematic script, emits engine-neutral JSON.
 *
 * The .md is the SINGLE SOURCE OF TRUTH. Never hand-edit the JSON.
 *   node parse_script.js BE_Ch02-03_Cinematic_Script.md be_ch02_03.json
 *
 * Consumed by:  Godot 4.7 (JSON.parse_string -> story_data steps)
 *               TypeScript mobile (import as typed StoryScene[])
 */
const fs = require("fs");

const inPath = process.argv[2];
const outPath = process.argv[3] || "be_script.json";

const src = fs.readFileSync(inPath, "utf8");
const lines = src.split("\n");

// ---- helpers ---------------------------------------------------------------

// `key=value` / `key={a:1, b:2}` / `key=[a, b]`  -> {key: parsed}
function parseParams(str) {
  const out = {};
  const re = /(\w+)=(\{[^}]*\}|\[[^\]]*\]|"[^"]*"|[^\s]+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const key = m[1];
    let raw = m[2];
    if (raw.startsWith("{")) {
      const obj = {};
      raw.slice(1, -1).split(",").forEach((pair) => {
        const i = pair.indexOf(":");
        if (i === -1) return;
        obj[pair.slice(0, i).trim()] = coerce(pair.slice(i + 1).trim());
      });
      out[key] = obj;
    } else if (raw.startsWith("[")) {
      out[key] = raw.slice(1, -1).split(",").map((s) => coerce(s.trim())).filter((s) => s !== "");
    } else {
      out[key] = coerce(raw);
    }
  }
  return out;
}

function coerce(v) {
  if (typeof v !== "string") return v;
  v = v.replace(/^"|"$/g, "");
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !isNaN(Number(v))) return Number(v);
  return v;
}

// strip markdown emphasis + bracketed performance direction (subtitle-safe)
function cleanDialogue(s) {
  return s.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
}

// ---- parse -----------------------------------------------------------------

const scenes = [];
let scene = null;
let beat = null;
let pendingSpeaker = null;

function pushBeat() {
  if (beat && scene) scene.beats.push(beat);
  beat = null;
}
function pushScene() {
  pushBeat();
  if (scene) scenes.push(scene);
  scene = null;
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trim();

  // Scene:  # SCENE 2 — ARRIVAL   followed by  ### `ch02_arrival` · ...
  const sceneHead = t.match(/^#\s+SCENE\s+(\d+)\s+—\s+(.+)$/);
  if (sceneHead) {
    pushScene();
    scene = { id: null, number: Number(sceneHead[1]), title: sceneHead[2].trim(), beats: [] };
    continue;
  }
  // scene id line: ### `ch02_arrival` · Day One · EXT...
  if (scene && !scene.id) {
    const idm = t.match(/^###\s+`([^`]+)`/);
    if (idm) {
      scene.id = idm[1];
      const parts = t.split("·").map((s) => s.trim());
      if (parts.length > 2) scene.slug = parts[parts.length - 1];
      continue;
    }
  }

  // Beat:  ### 2.3.B — CINEMATIC — MidpointCam
  const beatHead = t.match(/^###\s+(\d+\.\d+\.[A-Z])\s+—\s+([A-Z]+)(?:\s+—\s+(.+))?$/);
  if (beatHead && scene) {
    pushBeat();
    beat = {
      id: beatHead[1],
      mode: beatHead[2].toLowerCase(), // playable | cinematic
      rig: beatHead[3] ? beatHead[3].split("·")[0].trim() : null,
      steps: [],
    };
    pendingSpeaker = null;
    continue;
  }

  if (!beat) continue;

  // Cue:  > `camera` moment=midpoint   OR   > camera  moment=midpoint
  if (t.startsWith(">")) {
    const body = t.slice(1).trim();
    // skip prose design notes (**Design:** ...)
    if (body.startsWith("**")) continue;
    const kindMatch = body.match(/^`?(\w+)`?\s*(.*)$/);
    if (!kindMatch) continue;
    const kind = kindMatch[1];
    const known = ["camera","move","say","face","control","objective","spawn","despawn",
                   "anim","sfx","vfx","wait","gate","fade"];
    if (!known.includes(kind)) continue;
    beat.steps.push(Object.assign({ kind }, parseParams(kindMatch[2])));
    continue;
  }

  // Speaker:  **SARAH** *(arr_sarah_04)*
  const spk = t.match(/^\*\*([A-Z]+)\*\*\s*\*\(([a-z0-9_]+)\)\*$/);
  if (spk) {
    pendingSpeaker = { actor: spk[1].toLowerCase(), clip: spk[2] };
    continue;
  }

  // Dialogue line following a speaker
  if (pendingSpeaker && t !== "") {
    const step = {
      kind: "say",
      actor: pendingSpeaker.actor,
      clip: pendingSpeaker.clip,
      text: cleanDialogue(t),
    };
    const dir = t.match(/\[([^\]]*)\]/);
    if (dir) step.direction = dir[1];
    beat.steps.push(step);
    pendingSpeaker = null;
    continue;
  }
}
pushScene();

// ---- emit ------------------------------------------------------------------

const doc = {
  version: 1,
  source: inPath.split("/").pop(),
  generated: new Date().toISOString().split("T")[0],
  note: "GENERATED FILE - do not hand-edit. Edit the .md and re-run parse_script.js",
  scenes,
};

fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));

// ---- report ----------------------------------------------------------------
let beats = 0, steps = 0, says = 0;
const kinds = {};
scenes.forEach((s) => s.beats.forEach((b) => {
  beats++;
  b.steps.forEach((st) => { steps++; kinds[st.kind] = (kinds[st.kind]||0)+1; if (st.kind==="say") says++; });
}));
console.log(`scenes: ${scenes.length}`);
scenes.forEach((s) => console.log(`  ${s.id}  "${s.title}"  beats=${s.beats.length}`));
console.log(`beats: ${beats}   steps: ${steps}   say-lines: ${says}`);
console.log("step kinds:", Object.entries(kinds).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join("  "));
