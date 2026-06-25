---
name: Portrait asset pipeline
description: How Beyond Extinction character dialogue portraits are sourced, sized, named, and wired
---

# Portrait pipeline

Dialogue/character portraits (unlike *.glb models) ARE git-tracked and ship to
GitHub Pages — only `*.glb` is gitignored. They live in
`public/assets/portraits/`.

## Sourcing
- The user delivers new portrait art via a **GitHub Release** on
  CAPFlyingFun/Beyond-Extinction (e.g. tag `model-transfer-temp`), as a single
  PNG and/or a zip. Pull release assets with the github connector token + the
  releases API; download the asset by id with `Accept: application/octet-stream`,
  following the 302 to S3 **without** the auth header.
- Source renders are huge: ~2813×5000 transparent (srgba, alpha=0 corners),
  ~7–8 MB each. **Always web-optimize before committing** — committing them raw
  bloats the repo/Pages/PWA cache.

## Optimize
- `magick <in> -resize x1600 -strip -define png:compression-level=9 <out>`
  → ~900×1600, ~600–740 KB each (on par with the originals). No pngquant in env.
- Transparent bg composites on the card's `#0a1320`; CSS box `.be-dialogue__portrait`
  is 112×150, `background: cover` top-anchored, so a full-body render shows
  head→~knees (small face). That's the intended RPG-style full-figure look.

## Naming / wiring
- Active prologue base portrait = `Sarah.PNG` (referenced by `src/data/dialogue.ts`
  SARAH const + `public/sw.js` precache). Keep that filename to avoid code churn;
  the base content is Sarah's **8-weeks lab** look.
- Pregnancy-progression + beach variants ship alongside under descriptive names
  (`Sarah_18_weeks.png` … `Sarah_40_weeks.png`, `Sarah_Beach_12.png`) for future
  scenes; not yet referenced and intentionally NOT precached (keep PWA lean).
- Jack's portrait was unchanged (release PNG byte-identical to repo copy).
- **Bump `public/sw.js` VERSION on any asset swap** (e.g. v3→v4) so old caches retire.
