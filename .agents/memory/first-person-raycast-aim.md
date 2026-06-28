---
name: First-person aim/raycast direction
description: Derive crosshair/aim rays from the live Three.js camera, never a hand-rolled forward vector.
---

In any first-person view (game or devtool), the screen-center crosshair / pick ray
must come from `camera.getWorldDirection(target)` after the camera's position and
quaternion have been applied for the frame — NOT from a hand-built forward vector.

**Why:** A hand-rolled forward such as `(sin yaw·cos pitch, sin pitch, cos yaw·cos pitch) × -1`
silently flips the Y (pitch) component relative to what the camera actually renders.
For `THREE.Euler(pitch, yaw, 0, "YXZ")` the true camera forward is
`(-sin yaw·cos pitch, sin pitch, -cos yaw·cos pitch)`. A blanket `multiplyScalar(-1)`
negates Y too, so when the user visually aims down the ray casts upward and the
ground-plane reticle disappears — the core "aim → ground cursor → drop" loop breaks.

**How to apply:** Whenever you compute an aim/pick ray in a first-person camera, read
it straight from the camera so it can never drift from the rendered orientation. Only
hand-roll a direction if you have matched the exact Euler order AND signs and have a
reason not to use `getWorldDirection`.
