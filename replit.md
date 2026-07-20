# Beyond Extinction

A cinematic, story-driven prehistoric survival adventure game built with
**TypeScript + Three.js**, served through **Vite**. The first vertical slice
covers a 3D animated Main Menu, an interactive lab Prologue, and the Chapter One
island (arrival cinematic, survival HUD, ARK-style creature AI + passive taming).

## Architecture

This is a monorepo (pnpm). The game lives in `artifacts/beyond-extinction` and is
served at `/`. Although it is a "react-vite" artifact, the React layer was stripped:
`src/main.ts` mounts a Three.js canvas directly — there is no React, no backend, no
database.

The engine is **scene-based** (not chapter-based) so it can scale to hundreds of
distinct scenes. Each scene owns its own `THREE.Scene` + camera and implements the
`IScene` interface.

```
src/
  main.ts                 # boot: loading screen → Game → MainMenuScene
  styles.css              # all UI/overlay styling + self-hosted @fontsource imports
  engine/
    Game.ts               # bootstrap + single rAF loop (manual timing)
    Renderer.ts           # WebGLRenderer wrapper (tone mapping, shadows, resize)
    SceneManager.ts       # active scene + fade transitions (try/finally hardened)
    CameraManager.ts      # perspective camera w/ cinematic lerp + idle drift
    InputManager.ts       # WASD/arrows + pointer raycast interaction
    DialogueManager.ts    # HTML portrait dialogue overlay (typewriter, click/space)
    QuestManager.ts       # HUD objective tracker
    AudioManager.ts       # real audio: music beds, ducking, VO, procedural SFX synth
    Overlays.ts           # fade/flash/caption/clock/hint cinematic overlays
    IScene.ts             # scene interface + shared SceneContext
    assets.ts             # GLB/texture loaders with placeholder fallback
  scenes/
    MainMenuScene.ts      # ocean shader, island, figure-8 pterosaurs, menu UI
    PrologueCafeteriaScene.ts  # full narrative: coffee → console → cascade → vortex
    ChapterOnePlaceholderScene.ts  # beach wake-up, dodo, the hiss
  data/
    dialogue.ts           # dialogue line scripts
public/assets/
  models/                 # GLB character models (Jack.glb, Sarah.glb) — user-supplied
  portraits/              # Jack.PNG, Sarah.PNG (dialogue portraits)
  billboards/             # (reserved)
```

## Asset conventions (important)

- **No external CDNs.** `three` and fonts (`@fontsource/inter`, `@fontsource/cinzel`)
  are installed via npm and bundled by Vite.
- **Relative asset paths only.** Reference assets as `assets/models/Jack.glb` etc.
  Always resolve through `assetUrl()` in `engine/assets.ts`, which prefixes
  `import.meta.env.BASE_URL` so paths work regardless of mount point.
- **Missing GLBs degrade gracefully.** `loadModel()` returns a colored capsule
  placeholder (Jack = blue, Sarah = green) and logs a clear console error. Drop the
  real `.glb` into `public/assets/models/` to replace it — no code change needed.

## Running

The `artifacts/beyond-extinction: web` workflow runs `vite` (needs `PORT` and
`BASE_PATH`, supplied by the workflow). View it in the preview pane at `/`.

> Note: the WebGL game renders in a real browser. The automated screenshot tool runs
> a headless browser without a WebGL context, so it shows the boot-error fallback —
> that is a tooling limitation, not a game bug.

## User preferences

- Visual tone: beautiful, hopeful, warm — "Jurassic World meets Oceanhorn". Not
  horror, not cartoon.
- Story canon must be preserved (two coffees, 11:47 PM alarm, the colorless vortex
  that is explicitly *not* a blue portal, the quiet pregnancy beat, the Chapter One
  beach with an unnaturally blue high-oxygen sky).

## Playtest notes (2026-07-20, PC session — parked for later)
- Jack vs Sarah first-person camera heights intentionally differ by 0.05 m
  (EYE_JACK 1.7 / EYE_SARAH 1.65, KauaiStreamScene.ts) — flagged during
  playtest as "off"; if the character MODELS don't actually differ ~5 cm at
  the eyes, align these to the rigs. Not urgent.
- Idea: break ground-texture wallpaper repetition by blending 4 smaller
  texture variants per surface (2×2, "4 images = 1 image") instead of one
  repeating image. The shader already does dual-scale + brightness-noise
  anti-tiling; a 4-variant blend would be the next step up. Awaiting go-ahead.
- Godot build's blown-out white sand/underwater (screenshots): almost
  certainly the sRGB/linear double-conversion trap — web's s2l() is a NO-OP
  on purpose (KauaiTileStreamer.ts ~line 665: "texture2D already returns
  LINEAR — no manual decode needed"). Godot: albedo imports need
  source_color=true and the ported s2l must stay identity; also check
  tonemap (AgX/ACES) + sky/sun energy.
