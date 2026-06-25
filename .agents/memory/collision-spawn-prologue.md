---
name: Collision & spawn design (Prologue cafeteria)
description: Rules for the radius-baked collider system and locomotion in PrologueCafeteriaScene so future edits don't softlock.
---

# Collision & locomotion design — Prologue cafeteria

The scene bakes the player radius into static AABB colliders (each solid prop's
box is grown by PLAYER_RADIUS at build time, then movement just point-tests).
Two consequences are easy to trip over:

- **Raising PLAYER_RADIUS can retroactively trap any entity spawned near a prop.**
  The grown boxes expand inward toward open floor, so a spawn that was just
  outside a prop can end up *inside* the grown box and wedge (per-axis resolveMove
  can't cross the boundary in one small step). **Always re-verify every spawn is
  clear after changing the radius or moving props, and keep the spawn-unstick
  guard.**
  **Why:** going 0.8→1.5 silently moved Jack's (-22,14) spawn inside the table at
  (-18,18); it presented as "game frozen at start," not a collision bug.

- **Keep required paths clear by authoring the layout, not by toggling colliders.**
  Preferred fix for a blocker on a scripted path: move/rotate the prop OFF the
  lane and keep it permanently solid. The console desk used to be a wall across
  the centre lane (accelerator ring + vortex + Sarah's reach zone all at x=20);
  it is now a side bank along the east (desk runs along Z, screens face the lane)
  so the x=20 lane stays clear for both walking and the vortex pull. Conditionally
  dropping a collider mid-beat is a fallback only — it is softlock/clip-prone and
  was removed here. **Why:** users noticed characters clipping THROUGH the desk
  during the finale; relocating it reads naturally and removes the special-casing.

## Locomotion
Characters crossfade idle↔walk by **weight**, not scheduled transitions: both
clips play continuously, an eased per-character blend sets idle weight `1-b` and
walk weight `b`. Movement is detected from *actual* displacement (a collider that
cancels the step keeps the character in idle). Works for rigs with no walk clip
(walk action simply absent → stays idle). Walk-clip picker is regex-based
(`walk`/`run` fallbacks) because clip names vary per upload.
