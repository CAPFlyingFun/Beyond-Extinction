---
name: WebGL screenshot limitation
description: Why the screenshot tool falsely shows Three.js/WebGL apps as broken
---

The automated `screenshot` tool runs a headless browser with **no WebGL context**.
Any Three.js / WebGL app will show its boot-error / "Something broke" fallback there.

**Why:** This is an environment limitation of the screenshot tool, not a bug in the
app. The same build renders correctly in the user's real browser via the preview pane.

**How to apply:** Do not trust the screenshot tool to validate a WebGL app. Verify
instead with `tsc --noEmit` and a production `vite build` (both must pass), and check
the dev workflow logs for a clean HMR bundle. Tell the user the preview works in their
real browser.
