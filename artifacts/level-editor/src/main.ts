import "./styles.css";
import { EditorApp } from "./engine/EditorApp";

const root = document.getElementById("editor-root");
if (!root) {
  throw new Error("Missing #editor-root element");
}

try {
  const app = new EditorApp(root);
  app.start();
  if (import.meta.env.DEV) {
    (window as unknown as { __editor: EditorApp }).__editor = app;
  }
} catch (err) {
  console.error("[Level Editor] Fatal boot error:", err);
  root.innerHTML = `
    <div class="boot-error">
      <h1>WebGL failed to start</h1>
      <p>This level editor needs WebGL. Open it in the live preview pane
      (the automated screenshot tool runs headless without WebGL).</p>
    </div>`;
}
