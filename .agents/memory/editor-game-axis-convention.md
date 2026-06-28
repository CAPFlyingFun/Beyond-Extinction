---
name: Level-editor ↔ game axis convention
description: Why the level-editor and Beyond-Extinction game must share -Z=north, and how the N/S-swap bug arose and was fixed.
---

# Level-editor ↔ game coordinate convention

Both the level-editor (`artifacts/level-editor`) and the game
(`artifacts/beyond-extinction/.../PrologueCafeteriaScene.ts`) use the SAME world coords:
**+X east, -Z = north (forward into the room), +Z = south, +Y up; meters.**

**The bug:** the editor originally declared `+Z = north` — opposite on Z only. Because X
(east/west) matched, the symptom was exactly "N/S swapped, E/W fine." Layouts traced in the
editor came out N/S-mirrored when transferred to the game.

**Why:** the game is ground truth (cafeteria south=+Z, lab north=-Z, hallway south, spawn
(-52,0,28) facing east). The editor must match it so coordinates transfer 1:1.

**How to apply:**
- Saved level JSON `{x,z}` transfer 1:1 to the game (same X, same scale). Do NOT add a flip in
  movement or raycast math — those are "move where you look" and already correct.
- A level file authored under the OLD +Z-north editor is converted to game coords by **negating
  every z** (then optionally rounding to whole meters). That is what was done to
  `levels/prologue-room.json`.
- Spawn `facing` in the JSON is a **compass heading** (0=north/-Z, 90=east/+X, clockwise), NOT a
  raw `rotation.y`. A game-side importer must convert (the game's char forward is +Z, so
  `rotation.y ≈ π - degToRad(facing)`), not apply `facing` degrees directly.
- Floor-plan overlay: `rotation.x = -90°` maps the image's top (+Y) to world -Z, which is the
  correct north-up orientation under -Z-north. Do NOT "fix" it.

**Strafe vector gotcha:** in `CameraController.move()` the right/strafe vector must be
`right = forward × up = (-forward.z, 0, forward.x)` (facing -Z north → right = +X east). The
original shipped code used `(forward.z, 0, -forward.x)` (the negation), so left/right joystick
strafing was inverted while forward/back was fine. Don't reintroduce the negated form.

**Reading "the latest" game code:** local `main` can be STALE / diverged from the GitHub remote
(local fetch is blocked). Claudia's newest prologue work (e.g. the "tight two-rectangle room
shell, 8 walls" rewrite) existed ONLY on remote `main`. To read the real latest game scene,
fetch the file via the GitHub connector contents API at the remote ref — do not trust local.
