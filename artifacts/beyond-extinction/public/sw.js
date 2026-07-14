/*
 * Beyond Extinction — service worker (hand-rolled, no build-time dependency).
 *
 * Goal: after the first visit the whole game runs with no network, and it can
 * be installed to the home screen on iOS/Android.
 *
 * Base-path agnostic: the SW derives its own base from its URL, so the same
 * file works on the Replit preview, a local production build, and the GitHub
 * Pages subpath (/Beyond-Extinction/) without edits.
 *
 * Caching strategy:
 *   - install: precache the app shell + always-present assets (portraits,
 *     icons, manifest). Large models are gitignored and may be absent, so they
 *     are fetched best-effort and never fail the install.
 *   - navigations: network-first, falling back to the cached shell offline.
 *   - everything else (hashed JS/CSS/fonts, models when present): cache-first,
 *     populating the cache on first fetch so it is available offline next time.
 *
 * Bump VERSION whenever the caching logic changes to retire old caches.
 */
const VERSION = "v44";
const CACHE = `beyond-extinction-${VERSION}`;

// Base path this SW is served from, e.g. "/Beyond-Extinction/" or "/".
const BASE = self.location.pathname.replace(/sw\.js$/, "");

// Must all cache successfully or install fails — these are guaranteed present.
const CORE = [
  BASE,
  BASE + "index.html",
  BASE + "manifest.webmanifest",
  BASE + "favicon.svg",
  BASE + "icons/icon-192.png",
  BASE + "icons/icon-512.png",
  BASE + "icons/apple-touch-icon.png",
  BASE + "assets/branding/splash-landscape.jpg",
  BASE + "assets/branding/splash-portrait.jpg",
  BASE + "assets/portraits/Jack.PNG",
  BASE + "assets/portraits/Sarah.PNG",
];

// Best-effort: may not exist yet (models are gitignored / hosted later).
const OPTIONAL = [
  BASE + "assets/models/Jack.glb",
  BASE + "assets/models/Sarah.glb",
  BASE + "opengraph.jpg",
  // Island ground textures — cached best-effort so Chapter 2 works offline.
  BASE + "assets/textures/island_height.png",
  BASE + "assets/textures/island_color.jpg",
  BASE + "assets/textures/reef.jpg",
  BASE + "assets/textures/sand.jpg",
  BASE + "assets/textures/grass.jpg",
  BASE + "assets/textures/jungle.jpg",
  BASE + "assets/textures/dirt.jpg",
  BASE + "assets/textures/swamp.jpg",
  BASE + "assets/textures/mountain.jpg",
  BASE + "assets/textures/cliff.jpg",
  BASE + "assets/textures/volcano.jpg",
  // Island tree species — cached best-effort so the jungle works offline.
  BASE + "assets/models/trees/palm.glb",
  BASE + "assets/models/trees/fern.glb",
  BASE + "assets/models/trees/banyan.glb",
  BASE + "assets/models/trees/monkeypuzzle.glb",
  BASE + "assets/models/trees/conifer.glb",
  // Cave rock textures — cached best-effort so the Chapter 3 cave works offline.
  BASE + "assets/textures/godot/cave/cave-wall.jpg",
  BASE + "assets/textures/godot/cave/cave-floor.jpg",
  // Forage bush billboards.
  BASE + "assets/foliage/bush-ripe.png",
  BASE + "assets/foliage/bush-bare.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE);
      await Promise.allSettled(
        OPTIONAL.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* asset absent — fine, will be cached at runtime if added later */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("beyond-extinction-") && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only handle same-origin

  // Navigations: try network for the freshest shell, fall back to cache offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Only cache a genuine shell response — never an error/redirect page.
          if (fresh && fresh.ok && fresh.type === "basic") {
            const cache = await caches.open(CACHE);
            cache.put(BASE + "index.html", fresh.clone());
          }
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(BASE + "index.html")) ||
            (await cache.match(BASE)) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // <audio>/<video> elements issue ranged GETs (Range: bytes=...) to probe
  // metadata and seek. The Cache API has no concept of partial content, so a
  // cached 206 gets keyed by URL alone and is later replayed for *any* range
  // on that URL, returning the wrong bytes. Always defer ranged requests
  // straight to the network instead of risking the cache poisoning itself.
  if (req.headers.has("Range")) {
    event.respondWith(fetch(req));
    return;
  }

  // Everything else: cache-first, then network (and cache the response).
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        // Only cache a complete 200 — never a 206 that slipped through some
        // other way (the Range-header guard above should already keep us out
        // of this path for it, but res.ok is true for 206 too, so be explicit).
        if (fresh && fresh.status === 200 && fresh.type === "basic") {
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        return cached || Response.error();
      }
    })(),
  );
});
