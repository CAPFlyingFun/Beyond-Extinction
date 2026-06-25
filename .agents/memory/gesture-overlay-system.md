---
name: Gesture overlay system
description: How one-shot gestures are layered on top of idle/walk in the prologue, and the weight-ownership rule that keeps them from fighting.
---

# Shared gesture overlay (ClipLibrary + playGesture)

Characters share an identical bone rig (see model-pipeline), so a single
`ClipLibrary` harvests every loaded GLB's clips and any character can play any
clip as a one-shot gesture, bound by bone name via `mixer.clipAction(clip)`.

## Rule: ONE owner of the gesture action's weight
A one-shot gesture is overlaid on the continuous idle/walk actions. Its weight is
driven **only** by an eased `gestureBlend` (0..1) inside `applyLocomotion`, which
also scales idle/walk by `(1 - gestureBlend)`. Do **NOT** also call
`action.fadeIn/fadeOut` on the gesture.

**Why:** `applyLocomotion` calls `setEffectiveWeight` every frame. If the action
*also* ran its own fade, the two writers fight each frame and the blend flickers.
One writer = stable crossfade.

**How to apply:** start the gesture with `setEffectiveWeight(0)` + `play()` (an
enabled, playing action advances and fires `finished` even at weight 0), flip
`userData.gesturing = true`, and let `applyLocomotion` ramp the weight. On the
mixer `finished` event, set `gesturing = false` and resolve the promise; the
blend eases back to locomotion on its own.

## Root motion must be stripped per-clip
Only the Hips carry animated translation. A clip authored as a walk-to-X
(e.g. `open_door_3`) bakes huge Hips x/z drift; `ClipLibrary` pins Hips/root/
armature `.position` x/z to the first frame but keeps y, so gestures play in
place yet still crouch/bob. Other bones' constant position tracks are bind-pose
offsets — never flatten them.

## In-flight promises must be settled on dispose
The `finished` event never fires after scene teardown, so a pending gesture
promise would leave its awaiting handler dangling. Keep a set of resolvers and
drain it in `dispose()`.

**Gesture clip choice is data-driven:** swap the `*_GESTURE` static constants to
retarget which clip plays (e.g. `Collect_Object`/`Checkout_Gesture` are tighter
pickup motions than the big `open_door_3` reach).
