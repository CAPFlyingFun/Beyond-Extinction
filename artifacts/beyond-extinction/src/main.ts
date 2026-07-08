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
