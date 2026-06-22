# Beyond Extinction

A cinematic, story-driven prehistoric survival adventure game built with **vanilla
JavaScript + Three.js**, served through **Vite**. The first vertical slice covers a
3D animated Main Menu and an interactive Prologue that ends on the Chapter One beach.

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
    AudioManager.ts       # stub (logs cues; real audio TBD)
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
