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
    navigator.serviceWorker.register(swUrl, { scope: base }).catch((err) => {
      console.warn("[Beyond Extinction] Service worker registration failed:", err);
    });
  });
}
