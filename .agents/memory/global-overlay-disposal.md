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

**Auto Play rule (directed engine):** routine ACTION (interaction) gates may
auto-execute under Auto Play; genuine CHOICE gates have NO auto-resolver and
ALWAYS pause for the player — never add one.

Auto Play is **reactive**, not just checked once at gate entry: it must fire both
when Auto Play is already on as a trigger opens AND when the player toggles it on
while a trigger is already waiting (the user's rule: "see autoplay is on and do
it without waiting"). Funnel every auto path through the scene's single
walk-and-perform routine, and guard re-entry (a drive already scheduled/in
flight, a gate actually pending, no choice open) so the two paths can't
double-drive. Choices live on a separate code path from action gates, so they're
exempt by construction — keep it that way.
