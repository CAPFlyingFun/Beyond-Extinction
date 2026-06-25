---
name: Viewport camera framing in Beyond Extinction
description: why 3D scenes dolly the camera in on awkward viewports (both portrait and wide landscape phones), and how to keep new scenes consistent
---

The 3D scenes use a `THREE.PerspectiveCamera` with a **fixed vertical FOV** and resize only updates `camera.aspect`. With a fixed vertical FOV the subject's on-screen *height* fraction is constant across aspect ratios, so on a tall portrait phone the character ends up small in a dark, mostly-empty frame, and on a very wide/short landscape phone it sits marooned in empty width — users read both as "looks weird / too small."

**Decision:** scenes dolly the camera *closer* on awkward viewports instead of changing FOV. The shared helper `engine/cameraFraming.ts` `autoFramingScale(aspect)` returns 1.0 in a comfortable desktop/tablet band (~1.25–2.0) and eases the offset multiplier down toward both extremes — ~0.55 at portrait (~0.45) and ~0.8 at ultrawide (~2.6). The scene multiplies its camera offset vector by it (scaling the whole offset preserves the three-quarter angle, just pulls in).

**Why:** keeping vertical coverage constant (the default) can't make the subject bigger; locking horizontal FOV would zoom *out* on portrait (worse). Trading visible width for a larger subject is the only lever that fixes both "too small on portrait" and "lost in empty width on landscape phones."

**How to apply:** any new 3D gameplay/cutscene scene should run its camera offsets through `autoFramingScale(aspect)`, evaluated per-frame (aspect updates on resize). Player-facing camera prefs live in `engine/Settings.ts` as `{fov, zoom}` (zoom: **higher = closer**, range 0.7–1.8). Composition: effective offset = baseOffset × `autoFramingScale(aspect)` ÷ `settings.zoom` (divide, not multiply — bigger zoom dollies in); FOV is applied via `camera.fov` + `updateProjectionMatrix()`. The localStorage key was bumped to `...settings.v2` when the old `distanceMul` (higher = farther) was inverted to `zoom`, so don't reuse v1 values. Scope to gameplay cameras only — the main-menu cinematic shot is authored and left untouched.
