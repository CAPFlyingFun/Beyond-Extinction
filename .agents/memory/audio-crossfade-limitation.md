---
name: Audio crossfade (per-element timers)
description: AudioManager does real two-track crossfades via per-element fade timers; don't regress to a single shared timer, and dispose must pause every fading element
---

`AudioManager` performs real two-track crossfades. Each fading element gets its
own interval keyed in a `fadeTimers` Map (element → interval), so an outgoing
track and an incoming track fade **simultaneously**. Music track changes use a
slow cinematic fade (`MUSIC_FADE_MS`), default ducking/stops use a quick fade
(`FADE_MS`), volume stepped every `FADE_TICK_MS` for smoothness.

**Why:** an earlier version stored ONE shared `fadeTimer`; every `fadeTo`
started by clearing it, so `playMusic`'s fade-out-old + fade-in-new sequence had
the second call cancel the first — the old track stayed at full volume and never
paused. It looked like a crossfade in code but wasn't one at runtime.

**How to apply (don't regress):**
- Keep fade state per element (the Map), never a single shared timer.
- `dispose()` must pause EVERY element still in `fadeTimers` (an in-progress
  crossfade holds both old and new there) — not just `currentEl` — or an
  outgoing track keeps playing after the scene is torn down. Clearing the
  intervals alone skips their `onDone` pause.
- `playMusic(track)` is a same-track no-op (`current === track`); re-calling it
  won't restart the bed. Ducking (`duckMusic`) targets `currentEl` only.
