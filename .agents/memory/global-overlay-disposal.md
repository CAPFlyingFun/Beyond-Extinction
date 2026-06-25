---
name: Global overlay/settings-panel disposal
description: Scenes must force-close shared global modals (choice overlay, settings panel) on dispose, or they leak into the next scene.
---

# Global overlay/settings-panel disposal

Overlays and the settings panel are long-lived **global** services. Their own
`dispose()` runs only at full game teardown, NOT on normal scene transitions.

**Rule:** any scene that opens one of these MUST force-close it in its own
`dispose()`:
- `ctx.overlays.cancelChoice()` — settles a pending `showChoice()` promise with
  `""` and hides the modal. Without it, a scene torn down mid-choice leaves the
  choice buttons visible in the next scene and the awaiting promise/closure
  retained until a stale button is clicked.
- `closeSettingsPanel()` (from `engine/SettingsPanel`) — closes the modal and
  removes its global key listener. `MainMenuScene` already does this; new scenes
  that call `openSettingsPanel(...)` must mirror it.

**Why:** `SequenceDirector.gate()`/`cancel()` only unwinds the director's own
await; it does NOT clean up the underlying adapter (e.g. the `showChoice`
promise). So `director.cancel()` alone is insufficient — the visible modal and
its promise survive.

**How to apply:** when a directed scene's adapters await a global overlay,
pair every open with an explicit close in `dispose()`. Treat `director.cancel()`
as "unblock my play loop", and the overlay close calls as "tidy the shared UI".

**Auto Play note (directed engine):** routine ACTION (`interaction`) gates
auto-execute only when `settings.autoPlay` is true; genuine `choice` gates have
NO auto-resolver and ALWAYS pause for the player — never add one. The action
auto-timer is scheduled at gate entry, so toggling Auto Play on while already
paused at a gate won't retroactively start it (acceptable; not a bug).
