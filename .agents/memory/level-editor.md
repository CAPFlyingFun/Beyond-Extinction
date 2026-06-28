---
name: Level Editor (artifacts/level-editor)
description: Durable decisions for the first-person level editor devtool, its GitHub auto-push auth model, and the in-game dev portal gate.
---

# Level Editor devtool

A first-person Three.js level editor (slug `level-editor`, path `/level-editor/`) in the
Beyond Extinction monorepo. Drops wall/object/spawn markers, saves `levels/<name>.json` at
repo root via the shared api-server. Coords match the game: +X east, **-Z north**, +Y up, meters.

## GitHub auto-push auth model
- Saving (`POST /api/levels/:name` in api-server) writes the local file **and** commits the
  file to GitHub via the Contents API, using a FRESH connector token fetched per-call (never
  cached/logged). Push is **non-fatal** — a failed push never fails the local save; the
  response carries `github.{pushed,commitSha,htmlUrl,error}`.
- The write endpoint is **OPEN by default** (no auth) to preserve the original dev workflow.
  **Why:** the editor is a personal devtool and the pre-existing file-write endpoint was
  already open; mandatory auth would break the verified curl/editor flow.
- It can be **locked down**: set server env `LEVELS_API_TOKEN`; then writes must send a
  matching `x-levels-token` header or get 401. The editor stores that token in
  **localStorage only** (`levels.apiToken`, "API write token" panel) — never in source or the
  bundle, so embedding it can't leak it. **How to apply:** if you ever expose the api-server
  publicly, set `LEVELS_API_TOKEN` — do NOT rely on the in-game PIN to protect repo writes.
- SHA conflicts (concurrent save / replica lag → 409/422) get **one** automatic retry that
  re-reads the live blob sha before giving up.

## In-game dev portal (DevPortal.ts) is a shortcut, NOT security
- Press-and-hold ~10s stationary anywhere in the game (drag past ~24px cancels) reveals a
  4-digit PIN gate (PIN `2026`) that navigates to `/level-editor/`. Disabled on `*.github.io`.
- The PIN and the hidden gesture are **convenience only**. `/level-editor/` is directly
  reachable without the PIN, and the PIN does not protect the save/push endpoint. Treat repo
  write protection as the `LEVELS_API_TOKEN` server gate above, never the client PIN.

## Build env gotcha
- The editor and game vite builds **fail without `PORT` and `BASE_PATH`** env set (vite.config
  requires them). Build with e.g. `PORT=5001 BASE_PATH=/level-editor/ pnpm --filter ... run build`
  (game: `BASE_PATH=/`). tsc + vite build is the right verification path (headless screenshot
  has no WebGL — see webgl-screenshot-limitation).
