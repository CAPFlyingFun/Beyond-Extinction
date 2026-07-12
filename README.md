# Beyond Extinction

A cinematic, story-driven prehistoric survival adventure — **TypeScript + Three.js**,
built with **Vite** and deployed to **GitHub Pages**.

> **This repo is the web build.** It's the browser/PWA version of the game (playable
> on desktop and iOS Safari). The full-fidelity desktop/mobile engine lives in the
> separate **Beyond-Extinction-Godot** repo; this TypeScript build is the public web
> demo and shares the same story beats, sequence, and locations.

## Play

Deployed at **https://capflyingfun.github.io** — no install needed. On iOS you can
"Add to Home Screen" to run it as a PWA.

## Develop

This is a pnpm monorepo. The game lives in `artifacts/beyond-extinction` (Three.js,
no React in the game entry — `src/main.ts` mounts a canvas directly).

```bash
pnpm install
pnpm --filter @workspace/beyond-extinction dev          # local dev server
pnpm --filter @workspace/beyond-extinction typecheck     # tsc --noEmit
pnpm --filter @workspace/beyond-extinction build:github  # production Pages build
```

CI (`.github/workflows/ci.yml`) runs typecheck + build on every push and PR;
`deploy-pages.yml` builds and publishes to GitHub Pages on push to `main`.

## Layout

- `artifacts/beyond-extinction/src/engine` — scene manager, renderer, camera,
  input, quests, audio, save system, minimap/HUD, editors, sea creatures.
- `artifacts/beyond-extinction/src/scenes` — Main Menu, lab Prologue, Chapter One
  beach/island.
- `artifacts/beyond-extinction/public/assets` — GLB models (incl. `models/sea` for
  the roaming marine creatures), audio, textures.

See [`replit.md`](./replit.md) for the full architecture notes and
[`artifacts/beyond-extinction/docs/PWA_AND_GITHUB_PAGES.md`](./artifacts/beyond-extinction/docs/PWA_AND_GITHUB_PAGES.md)
for PWA / service-worker / Pages details.
