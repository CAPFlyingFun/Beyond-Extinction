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
  it is now a side bank running along Z (long axis), WEST of the central lane
  (desk world x~12, Sarah/Jack operate from its east side, screens face east
  toward the lane), so the x=20 lane stays clear for both walking and the vortex
  pull. NOTE the accelerator ring is the SAME group as the desk but at group-local
  x=0 (world x20) — so the desk can slide along local x without moving the
  ring/lane; only the desk mesh, screens, consoleDeskWorld, operate-anchors,
  sarahConsoleSpot and the setCoffeesOnConsole slots move with it. Conditionally
  dropping a collider mid-beat is a fallback only — it is softlock/clip-prone and
  was removed here. **Why:** users noticed characters clipping THROUGH the desk
  during the finale; relocating it reads naturally and removes the special-casing.

- **Multi-pickup from ONE anchor: spread items PERPENDICULAR to the approach axis.**
  To let Jack collect both coffee cups from a single planted spot, the cups must
  sit across his approach direction (along Z for a straight west→east approach),
  not strung along it. `pickupRadius` has to reach every item while the anchor
  stays OUTSIDE the grown counter collider; items laid *along* the approach force
  the anchor either too far to reach the far one or inside the collider (softlock).
  Practical recipe: orient the counter long-axis along the spread axis, put cups
  on it offset to either side of centre, and plant the anchor one approach-step
  back from the counter's grown edge, ~pickupRadius-1 from each cup.
  **Why:** the straight-walk revision needed the coffee ON Jack's lane against the
  far wall (so the guided walk is one straight leg, divider deleted); cups stacked
  along Z + a west anchor was the only arrangement that reached both without
  wedging. **How to apply:** any time a single interaction anchor must service
  multiple grabbable props.

- **Openings/doorways: overhead elements across the gap must be NON-solid.**
  `buildColliders` projects each solid mesh's Box3 to XZ and grows it, *ignoring
  Y*. So a doorway header/lintel/beam (or a sign/glow strip) tagged solid closes
  the opening at floor level even though it's metres overhead. Make a doorway by
  authoring the *gap* — flank it with solid walls whose grown boxes don't touch
  the traversal lane, and leave the header/posts/trim non-solid. A trailing
  follow-cam can also clip these: keep the opening clear below the camera's max
  height (header bottom above cam y) and at least as wide as the cam's lateral
  offset×framingScale (portrait framingScale can exceed ~1.3).
  **Why:** the west hallway is a z[20.5,35.5] corridor on Jack's z=28 lane with a
  full-width framed doorway at x=-8; side walls solid (grown to ~z33.7+/~z22.3-,
  lane clear), header/posts/sign non-solid. **How to apply:** any walled corridor,
  archway, or gated passage the player must walk (or the camera must pass) through.

## Locomotion
Characters crossfade idle↔walk by **weight**, not scheduled transitions: both
clips play continuously, an eased per-character blend sets idle weight `1-b` and
walk weight `b`. Movement is detected from *actual* displacement (a collider that
cancels the step keeps the character in idle). Works for rigs with no walk clip
(walk action simply absent → stays idle). Walk-clip picker is regex-based
(`walk`/`run` fallbacks) because clip names vary per upload.
