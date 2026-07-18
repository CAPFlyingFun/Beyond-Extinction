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
    // reload so the page runs the fresh code — but NOT mid-session. Reloading
    // while the player is loading into / playing a scene bounces them to the main
    // menu (looks like a first-load crash that "works the second time", because
    // by then the worker is already current). So we DEFER the reload until the
    // tab is backgrounded / hidden, and apply the fresh bundle next time they
    // return. Guarded to only fire on an update (a controller already existed),
    // never on the first-ever install.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    let pendingReload = false;
    const doReload = (): void => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) return; // first install → never reload
      pendingReload = true;
      // If the tab is already hidden, it's safe to swap right now.
      if (document.visibilityState === "hidden") doReload();
    });
    document.addEventListener("visibilitychange", () => {
      if (pendingReload && document.visibilityState === "hidden") doReload();
    });
    window.addEventListener("pagehide", () => {
      if (pendingReload) doReload();
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
