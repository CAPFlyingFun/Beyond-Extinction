/**
 * Registers the Beyond Extinction service worker so the game is installable and
 * works offline after the first visit.
 *
 * Only runs in production builds: during local `vite dev` a service worker would
 * aggressively cache modules and make code changes appear not to take effect.
 * The worker file lives in `public/sw.js` and is served at `${BASE_URL}sw.js`,
 * so its scope automatically matches the deployment's base path
 * (e.g. `/Beyond-Extinction/` on GitHub Pages).
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL ?? "/";
    const swUrl = `${base}sw.js`;

    // Auto-refresh on a new deploy: when a newly-installed worker takes control,
    // reload ONCE so the page runs the fresh code. Guarded to only fire when a
    // controller already existed (an update, not the first-ever install), so we
    // never reload on a first visit. This is what stops a home-screen PWA from
    // getting stuck on a stale JS bundle across deploys.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register(swUrl, { scope: base })
      .then((reg) => {
        // Check for a newer worker right now (and let the browser keep checking).
        reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn("[Beyond Extinction] Service worker registration failed:", err);
      });
  });
}
