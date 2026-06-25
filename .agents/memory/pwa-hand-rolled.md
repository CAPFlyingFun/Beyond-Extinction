---
name: Beyond Extinction PWA is hand-rolled (no plugin)
description: why the PWA uses a hand-written manifest + service worker instead of vite-plugin-pwa, and the deploy constraint behind it
---

The PWA (offline + installable) for Beyond Extinction is hand-rolled: `public/manifest.webmanifest` + `public/sw.js` + a `src/pwa.ts` registration linked from `index.html`. Deliberately NO `vite-plugin-pwa` or any new dependency.

**Why:** the GitHub Pages deploy (GitHub Actions) runs `pnpm install --frozen-lockfile`. Adding any build dep changes `package.json`/`pnpm-lock.yaml`, and any lockfile drift fails that install — and thus the whole deploy. Pushing to this repo is also painful (Contents API per-file; see github-api-push.md). Hand-rolling keeps the lockfile untouched so the deploy stays green.

**How to apply:**
- Keep the PWA dependency-free. If you ever MUST add a build dep, regenerate AND push `pnpm-lock.yaml` in the same change or CI breaks.
- The SW is base-path agnostic: it derives its base from `self.location.pathname.replace(/sw\.js$/, "")`, so the same file works on the Replit preview, a local prod build, and the Pages subpath `/Beyond-Extinction/`. Registration uses `${import.meta.env.BASE_URL}sw.js` with matching scope, production-only (a dev SW caches modules and hides code changes).
- Manifest uses relative `start_url`/`scope`/`id`/icons (`"./"`, `"icons/..."`) so it resolves under any base. index.html PWA links are relative for the same reason; Vite rewrites `/`-leading hrefs to include base, but relative is bulletproof.
- Models (~38MB GLBs) are gitignored and ABSENT on Pages (placeholder fallback). The SW caches them best-effort (Promise.allSettled, cache only res.ok) so a missing file never fails install; they get runtime-cached if/when model hosting is added.
- Non-hashed public assets (icons/manifest/models/opengraph) are cache-first, so bump the `VERSION` constant in `sw.js` when they change or stale copies persist. Hashed JS/CSS/fonts self-update via their content hashes.
