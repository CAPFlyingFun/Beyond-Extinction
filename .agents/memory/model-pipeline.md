---
name: Character model pipeline (Beyond Extinction)
description: How Sarah/Jack 3D character models are delivered, compressed, cached, and shared across weekly variants.
---

# Character model pipeline

## Delivery — do NOT try to pull from Meshy
`MESHY_AI_API_KEY` authenticates but its account holds **zero assets** on every endpoint
(text-to-3d, image-to-3d, animations, rigging, remesh). The user's models live elsewhere and are
not API-retrievable. Instead the user attaches the raw GLB/zip to a **GitHub Release**; fetch it via
the releases API (repo is public, so `browser_download_url` works), compress, commit, then the user
deletes the release.

## Rigging — user rigs, agent compresses (decided)
The Meshy **Rigging API** *can* rig an arbitrary GLB via `model_url` (public URL or base64 data URI;
`.glb` only, ≤300k faces, face must point **+Z**, 5 credits each — account balance is ample). But the
agreed division of labor is: **the user rigs each model in their own Meshy flow, names them by week,
and chooses placement; the agent only compresses + verifies rig compatibility + wires them in.**
**Why:** (1) several un-rigged Sarah source meshes exceed the API's 300k-face limit (one was 457k), so
API rigging would force a pre-decimation the user wants to avoid — they chose "keep full resolution,
just compress"; (2) the user hand-fixes Meshy's known weak spots (chin, ankle/knee skin weights) in
their tool, which the API can't do; (3) week naming/placement is the user's call.
**How to apply:** when rigged GLBs arrive, do NOT re-rig — just run the compress recipe below, diff
bone names vs the shared 24-bone rig, then wire/cache. Note Meshy's un-rigged zip exports arrive as
files all named `Meshy_AI_model.glb` under UUIDv7 folders (week names do NOT survive export), so trust
the user's re-named rigged upload for week ordering.

## Compress before committing
Meshy "merged-animation" exports are huge mostly because they **duplicate the base-color texture**;
run `gltf-transform optimize <in> <out> --compress draco --texture-compress webp --texture-size 2048 --simplify false`
(its `dedup` removes the duplicate). gltf-transform isn't installed — use `npx -y @gltf-transform/cli`.
**Why:** the bottleneck is textures, not geometry; routinely a >10x shrink with no visible loss.

## Bump the service worker when swapping a cached asset
`public/sw.js` serves models **cache-first** and lists them in `OPTIONAL`. Replacing a model file
WITHOUT bumping `sw.js` `VERSION` means returning PWA/Pages users keep the **old cached copy** forever.
**How to apply:** every time you swap/replace any precached asset, bump `VERSION`.

## Animation sharing across characters/weeks — CONFIRMED
Sarah (week 8) AND Jack both export the **identical 24-bone rig** (same names + order), so the
shared-clip plan is validated across characters, not just weeks. Three.js binds clips to bones by
name, so one clip library can drive every Meshy biped mesh. Plan: export future models **mesh-only**
and reuse a shared clip library via a name-bound `AnimationMixer`.
The user intends to **accumulate animations across uploads** (Meshy caps ~20 clips per model), so the
shared library will grow over time — dedupe clip names as they arrive. Note idle clip names vary per
export (Sarah=`Idle_4`, Jack=`Idle_11`); the `/idle/i` picker handles both.
**How to apply:** when each new model arrives, first **diff its bone names** against this rig; only
share clips if they match (else add a load-time bone-name remap).

## Caching / lazy-load policy
Keep the PWA cache **current-week-only** — do NOT add all weekly character GLBs to `OPTIONAL`.
Prologue Sarah currently = week 8 = `Sarah.glb`; week 12 swaps in after the Dilo chase (a later
chapter) and should become a per-week, lazy-loaded file. Jack is still an uncompressed placeholder
(compress next). `buildCharacter()` auto-normalizes scale/footing but NOT facing/orientation, so a
visual preview in real WebGL is always required (headless has none).
