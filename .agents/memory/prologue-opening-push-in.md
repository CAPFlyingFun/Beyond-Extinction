---
name: Prologue opening camera + narration timing
description: How the Lab prologue opening shot is driven, and why scripted camera moves must be timed off the baked VO length, not a hardcoded guess.
---

# Scripted camera moments are per-frame, so you animate them over `elapsed`

The prologue's scripted camera zone (priority 100) calls `cameraMoment(id, state)` **every frame** for both position and lookAt while a named moment is set. So a "static" moment becomes a continuous move simply by making its returned position/lookAt a function of `state.elapsed`. The director eases toward the target (easeSpeed ~0.06); for a slow dolly the trailing lag is sub-unit and negligible. Capture the move's start time lazily on the first active frame (not when `setCameraMoment` fires) so the start is the first *rendered* frame regardless of when the timeline triggers it.

# The opening narration is ~23s, not the ~10-12s a brief will assume

**Why this matters:** briefs (and intuition) badly underestimate how long the baked VO runs. The opening (`labOpeningNarration`: a 3s wait + two `lab_narr_*` clips + 0.4s) totals **~23.6s**, even though it "reads" short. A camera move hardcoded to ~11s arrives and then *freezes for ~12s* — recreating the static hold you were asked to remove.

**How to apply:** size any camera/lighting move that should span a narration off the timeline itself, e.g. sum `labOpeningNarration` using `VOICE_DURATIONS` (ms map in `src/data/voiceDurations.ts`, auto-generated from the mp3s) for `say`/`voice` steps plus `wait.ms`, then subtract a small settle. `SequenceDirector` awaits each `say` on the real audio with **no inter-step padding**, so that sum is the true clock. Re-derive rather than hardcode so a VO re-bake stays in sync.

# No post-processing pipeline exists

There is no `EffectComposer`. Adding DOF/bokeh means adding a composer pass — a real mobile-perf cost. Treat "optional, only if cheap" DOF requests as: skip it (or fake with existing fog), don't stand up a post stack.
