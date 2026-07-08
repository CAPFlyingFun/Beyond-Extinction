import "./styles.css";
import { Game } from "./engine/Game";
import { createMainMenuScene } from "./scenes/MainMenuScene";
import { registerServiceWorker } from "./pwa";

// Make the game installable and offline-capable (production builds only).
registerServiceWorker();

// Game feel: suppress the native right-click / long-press context menu and any
// stray text selection everywhere. The CSS reset already sets `user-select:none`
// and `-webkit-touch-callout:none`, but killing the `contextmenu` event as well
// stops the desktop right-click menu and the Android long-press popup — the
// latter would otherwise fight our own long-press-to-interact gesture.
window.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("selectstart", (e) => e.preventDefault());

// iOS Safari can leave the LAYOUT VIEWPORT stuck at the previous orientation's
// width after a rotation — especially when the device is turned mid-transition
// (e.g. right as the "rotate to landscape" gate appears). The page then lays out
// at the old (portrait) width and the browser scales it up, so the menu buttons
// and the settings panel render huge/overflowing. Re-assert the viewport meta on
// every orientation change: momentarily collapse it, then restore, which forces
// the engine to recompute the layout viewport for the new orientation.
const VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
function kickViewport(): void {
  const vp = document.querySelector('meta[name="viewport"]');
  if (!vp) return;
  vp.setAttribute("content", "width=device-width");
  requestAnimationFrame(() => vp.setAttribute("content", VIEWPORT_CONTENT));
}
window.addEventListener("orientationchange", () => {
  kickViewport();
  // Re-kick after the rotation animation settles (iOS reports final size late).
  setTimeout(kickViewport, 350);
});

const root = document.getElementById("game-root");
if (!root) {
  throw new Error("Missing #game-root element");
}

// Lightweight loading screen shown until the first scene is ready.
const loading = document.createElement("div");
loading.className = "be-loading";
loading.innerHTML = `
  <div class="be-loading__title">Beyond Extinction</div>
  <div class="be-loading__bar"><i></i></div>`;
root.appendChild(loading);

async function boot() {
  const game = new Game(root!);
  if (import.meta.env.DEV) (window as any).__game = game;
  await game.start(createMainMenuScene);
  loading.classList.add("hide");
  setTimeout(() => loading.remove(), 900);
}

boot().catch((err) => {
  console.error("[Beyond Extinction] Fatal boot error:", err);
  loading.innerHTML = `
    <div class="be-loading__title">Something broke</div>
    <p style="opacity:.7;max-width:60ch;text-align:center">
      The game failed to start. Check the browser console for details.
    </p>`;
});
