---
name: No-CDN constraint
description: Beyond Extinction forbids external CDNs; how to handle fonts and libs
---

Beyond Extinction has a hard requirement: **no external CDNs**. Everything must be
bundled locally by Vite.

**Why:** Stated project requirement — the game must run fully self-contained with no
runtime network dependencies.

**How to apply:**
- Fonts: install via `@fontsource/*` (npm) and `@import` them in `styles.css`. Never
  use `<link>` tags to Google Fonts or any font CDN in `index.html`.
- Libraries (e.g. `three`): install via npm so Vite bundles them; never `import` from
  a CDN URL like esm.sh / unpkg / skypack.
- Assets: reference with relative paths resolved through `assetUrl()`
  (`import.meta.env.BASE_URL`), not absolute URLs.
