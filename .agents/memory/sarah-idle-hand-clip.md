---
name: Sarah dialogue right-hand clipping
description: Why Sarah's right hand clips during prologue dialogue and why idle-swapping won't fix it
---

# Sarah's right-hand clip during dialogue

Symptom: during the prologue two-shot, Sarah's right hand appears to clip into her
body while she holds the coffee cup.

## Ruled out (with evidence)
- **Not "merging two idles."** Each character loads its own GLB with its own
  clips; the idle selector picks the first `/idle/i` match. For Sarah that's a
  single clip, `Idle_4` (walk resolves to `Walking`). Only one idle ever plays.
- **Not a fidgety/wrong idle.** Measured avg right-arm rotation per Sarah idle:
  `Idle_4` 0.234 rad (calmest real idle), `Idle_6` 0.367, `Idle_Turn_Left/Right`
  are ~1 s **turn** clips (not standing poses). So swapping to another idle makes
  the arm move MORE, not less — it won't help.
- **Not a "frame 0" blend artifact.** During the static two-shot Sarah never
  walked, so walkBlend≈0 and she's in pure `Idle_4`.

## Actual cause
The clip is inherent to `Idle_4`'s arms-at-side rest pose: her right hand sits by
her hip, and the cup (parented to the RightHand bone via grip context `sarahRight`,
offset {along:0.3,up:0.08,side:0}) grazes her thigh. It's a pose/model issue, not
an animation-blend bug.

**Why it matters:** future "fix the clip" attempts should not chase idle selection
or blend logic. The real levers are the `sarahRight` grip offset (push the cup
outward from the hip) or accepting a minor graze — and both need eyes-on (no WebGL
in the headless screenshot tool, so verify visually in the live preview).
