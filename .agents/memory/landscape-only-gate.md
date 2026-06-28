---
name: No orientation lock on Beyond Extinction web (landscape gate was reverted)
description: why the web game is NOT locked to landscape — a rotate-to-landscape gate was built and then reverted
---

Beyond Extinction web is **not** orientation-locked. A landscape-only "rotate your device" gate (full-screen overlay on touch devices in portrait + game pause behind it + PWA manifest `orientation: landscape` + best-effort `screen.orientation.lock`) was built once and then **reverted at the user's request**.

**Why it was reverted:** the web platform can't actually enforce landscape — iOS Safari ignores both the Screen Orientation API and the manifest `orientation`, so the device "still allows rotation to 9:16" anyway. The gate therefore just blocked/annoyed players without delivering the lock, and the user felt the camera/aspect behaved wrong with it in place. Net: it added complexity (a shared pause-clock so cutscenes wouldn't advance behind the prompt) for a guarantee the web can't keep.

**How to apply:** don't reintroduce an orientation lock / rotate-gate for the web build unless the user explicitly asks again and accepts it can't be enforced on iOS. With the gate gone, the game is NOT paused by orientation, manifest `orientation` is `any`, and story timing uses plain `setTimeout` again (no pause-clock) — that's expected, not a regression. Camera framing across aspect ratios is a *separate*, older concern (see portrait-camera-framing.md), independent of this gate.
