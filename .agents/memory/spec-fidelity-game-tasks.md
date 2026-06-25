---
name: Spec-fidelity for game tasks
description: Game task specs require literal UX, not equivalents
---

For game tasks here, the task file's "Done looks like" and "Steps" sections name
*exact* interaction mechanics and UI. Shipping a "cinematic equivalent" that feels
similar is treated as a failure in code review.

**Why:** Reviews repeatedly reject passes that swap a named control or beat for a
similar-feeling one (e.g. auto-advancing a beat the spec said must be gated behind an
explicit player interaction, or collapsing a specified line count).

**How to apply:** Before marking a game task complete, re-read the task file and check
each "Done looks like" bullet and each numbered Step literally — match named controls,
prompt text, gating/trigger conditions, beat/line counts, and exact log strings, not
just the overall feel.
