/**
 * Hidden developer portal: press-and-hold anywhere for 10 seconds to reveal a
 * PIN gate; entering the correct PIN opens the in-game Dev menu (Marker Editor,
 * and later the Animation Editor). Everything dev lives behind this one PIN
 * gate — there is no visible Dev tab.
 *
 * Design notes:
 * - The hold must stay roughly stationary. Any drag past MOVE_TOLERANCE cancels
 *   it, so normal gameplay (look drag, move joystick) never triggers the portal.
 * - A subtle progress pill only appears after INDICATOR_DELAY_MS so casual taps
 *   reveal nothing; an intentional long hold gets feedback to "keep holding".
 * - Self-contained: injects its own styles and sits above all game UI. Because
 *   the editors are in-app now (not a separate route), it is enabled on the
 *   public build too — the PIN is the only gate.
 */

const DEV_PIN = "2026";
const HOLD_MS = 10_000;
const INDICATOR_DELAY_MS = 2_500;
const MOVE_TOLERANCE_PX = 24;

export interface DevPortalActions {
  /** Open the Marker Editor for the active scene. */
  onMarkerEditor: () => void;
  /** Open the Animation Editor (optional until it ships). */
  onAnimationEditor?: () => void;
}

export class DevPortal {
  private readonly enabled: boolean;
  private suspended = false;
  private menu?: HTMLDivElement;
  private root: HTMLDivElement;
  private indicator: HTMLDivElement;
  private bar: HTMLDivElement;
  private overlay: HTMLDivElement;
  private dotsWrap: HTMLDivElement;
  private dots: HTMLSpanElement[] = [];

  private entered = "";
  private holding = false;
  private holdStart = 0;
  private startX = 0;
  private startY = 0;
  private rafId = 0;
  private indicatorShown = false;
  private overlayOpen = false;

  constructor(private actions: DevPortalActions) {
    // Enabled everywhere now — the PIN is the only gate (the editors run in-app,
    // so there's no separate route to withhold on the public build).
    this.enabled = true;
    injectStyles();

    this.root = document.createElement("div");
    this.root.className = "be-dev";

    // Hold-progress pill (bottom-center).
    this.indicator = document.createElement("div");
    this.indicator.className = "be-dev__hold";
    const label = document.createElement("span");
    label.className = "be-dev__hold-label";
    label.textContent = "Opening dev tools…";
    const track = document.createElement("div");
    track.className = "be-dev__hold-track";
    this.bar = document.createElement("div");
    this.bar.className = "be-dev__hold-bar";
    track.appendChild(this.bar);
    this.indicator.append(label, track);

    // PIN overlay.
    this.overlay = document.createElement("div");
    this.overlay.className = "be-dev__overlay";
    const panel = document.createElement("div");
    panel.className = "be-dev__panel";

    const title = document.createElement("div");
    title.className = "be-dev__title";
    title.textContent = "Developer Access";
    const sub = document.createElement("div");
    sub.className = "be-dev__sub";
    sub.textContent = "Enter PIN to open Dev tools";

    this.dotsWrap = document.createElement("div");
    this.dotsWrap.className = "be-dev__dots";
    for (let i = 0; i < 4; i += 1) {
      const dot = document.createElement("span");
      dot.className = "be-dev__dot";
      this.dots.push(dot);
      this.dotsWrap.appendChild(dot);
    }

    const pad = document.createElement("div");
    pad.className = "be-dev__pad";
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "✕", "0", "⌫"];
    for (const key of keys) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "be-dev__key";
      btn.textContent = key;
      if (key === "✕") btn.classList.add("be-dev__key--cancel");
      if (key === "⌫") btn.classList.add("be-dev__key--back");
      btn.addEventListener("click", () => this.onKey(key));
      pad.appendChild(btn);
    }

    panel.append(title, sub, this.dotsWrap, pad);
    this.overlay.appendChild(panel);
    // A tap on the dim backdrop (outside the panel) closes the gate.
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.closeOverlay();
    });

    this.root.append(this.indicator, this.overlay);
    document.body.appendChild(this.root);

    if (this.enabled) {
      document.addEventListener("pointerdown", this.onDown, { passive: true });
      document.addEventListener("pointermove", this.onMove, { passive: true });
      document.addEventListener("pointerup", this.onUp, { passive: true });
      document.addEventListener("pointercancel", this.onUp, { passive: true });
      window.addEventListener("blur", this.onUp);
    }
  }

  /** Suspend the hold gesture (e.g. while an editor is already open). */
  setSuspended(s: boolean): void {
    this.suspended = s;
    if (s) this.cancelHold();
  }

  /**
   * Open the PIN gate directly — the quick path used by the inventory's DEV tab
   * (no 10s hold). Ignored while an editor is already open.
   */
  requestUnlock(): void {
    if (this.suspended || this.overlayOpen) return;
    this.cancelHold();
    this.openOverlay();
  }

  private onDown = (e: PointerEvent): void => {
    if (this.overlayOpen || this.suspended || !e.isPrimary) return;
    this.holding = true;
    this.holdStart = performance.now();
    this.startX = e.clientX;
    this.startY = e.clientY;
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.holding) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) {
      this.cancelHold();
    }
  };

  private onUp = (): void => {
    this.cancelHold();
  };

  private tick = (): void => {
    if (!this.holding) return;
    const elapsed = performance.now() - this.holdStart;

    if (elapsed >= INDICATOR_DELAY_MS && !this.indicatorShown) {
      this.indicatorShown = true;
      this.indicator.classList.add("show");
    }
    if (this.indicatorShown) {
      const pct = Math.min(100, (elapsed / HOLD_MS) * 100);
      this.bar.style.width = `${pct}%`;
    }

    if (elapsed >= HOLD_MS) {
      this.cancelHold();
      this.openOverlay();
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  private cancelHold(): void {
    this.holding = false;
    cancelAnimationFrame(this.rafId);
    if (this.indicatorShown) {
      this.indicatorShown = false;
      this.indicator.classList.remove("show");
      this.bar.style.width = "0%";
    }
  }

  private openOverlay(): void {
    this.overlayOpen = true;
    this.entered = "";
    this.renderDots();
    this.overlay.classList.add("show");
  }

  private closeOverlay(): void {
    this.overlayOpen = false;
    this.entered = "";
    this.renderDots();
    this.overlay.classList.remove("show");
  }

  /** After a correct PIN: a small chooser for the available dev tools. */
  private openDevMenu(): void {
    this.menu?.remove();
    const menu = document.createElement("div");
    menu.className = "be-dev__overlay show be-dev__menu";
    menu.innerHTML = `
      <div class="be-dev__panel">
        <div class="be-dev__title">Dev Tools</div>
        <div class="be-dev__sub">PIN accepted</div>
        <div class="be-dev__tools">
          <button class="be-dev__tool" data-tool="markers">◈ Marker Editor</button>
          <button class="be-dev__tool" data-tool="anim">🦴 Animation Editor</button>
        </div>
        <button class="be-dev__key be-dev__key--cancel be-dev__menuclose" type="button">Close</button>
      </div>`;
    this.root.appendChild(menu);
    this.menu = menu;
    const close = () => {
      menu.remove();
      if (this.menu === menu) this.menu = undefined;
    };
    menu.addEventListener("pointerdown", (e) => {
      if (e.target === menu) close();
    });
    menu.querySelector('[data-tool="markers"]')?.addEventListener("click", () => {
      close();
      this.actions.onMarkerEditor();
    });
    const animBtn = menu.querySelector<HTMLButtonElement>('[data-tool="anim"]');
    if (this.actions.onAnimationEditor) {
      animBtn?.addEventListener("click", () => {
        close();
        this.actions.onAnimationEditor!();
      });
    } else if (animBtn) {
      animBtn.disabled = true;
      animBtn.textContent = "🦴 Animation Editor — soon";
    }
    menu.querySelector(".be-dev__menuclose")?.addEventListener("click", close);
  }

  private onKey(key: string): void {
    if (key === "✕") {
      this.closeOverlay();
      return;
    }
    if (key === "⌫") {
      this.entered = this.entered.slice(0, -1);
      this.renderDots();
      return;
    }
    if (this.entered.length >= DEV_PIN.length) return;
    this.entered += key;
    this.renderDots();
    if (this.entered.length === DEV_PIN.length) {
      if (this.entered === DEV_PIN) {
        this.closeOverlay();
        this.openDevMenu();
      } else {
        this.dotsWrap.classList.remove("shake");
        void this.dotsWrap.offsetWidth; // restart animation
        this.dotsWrap.classList.add("shake");
        this.entered = "";
        setTimeout(() => this.renderDots(), 350);
      }
    }
  }

  private renderDots(): void {
    this.dots.forEach((dot, i) => {
      dot.classList.toggle("filled", i < this.entered.length);
    });
  }

  dispose(): void {
    document.removeEventListener("pointerdown", this.onDown);
    document.removeEventListener("pointermove", this.onMove);
    document.removeEventListener("pointerup", this.onUp);
    document.removeEventListener("pointercancel", this.onUp);
    window.removeEventListener("blur", this.onUp);
    cancelAnimationFrame(this.rafId);
    this.menu?.remove();
    this.root.remove();
  }
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.be-dev { position: fixed; inset: 0; pointer-events: none; z-index: 9999; }

.be-dev__hold {
  position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 10px 16px; border-radius: 999px;
  background: rgba(8, 12, 16, 0.72); border: 1px solid rgba(120, 200, 255, 0.28);
  color: #cfe8ff; font: 600 12px/1 ui-monospace, monospace; letter-spacing: 0.08em;
  opacity: 0; transition: opacity 160ms ease; backdrop-filter: blur(6px);
}
.be-dev__hold.show { opacity: 1; }
.be-dev__hold-track { width: 160px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.14); overflow: hidden; }
.be-dev__hold-bar { width: 0%; height: 100%; background: linear-gradient(90deg, #4ea3ff, #7ee0ff); }

.be-dev__overlay {
  position: absolute; inset: 0; display: none;
  align-items: center; justify-content: center;
  background: rgba(4, 7, 10, 0.78); backdrop-filter: blur(10px);
  pointer-events: auto;
}
.be-dev__overlay.show { display: flex; }

.be-dev__panel {
  width: min(92vw, 320px); padding: 28px 24px 24px;
  border-radius: 18px; text-align: center;
  background: rgba(14, 19, 26, 0.94); border: 1px solid rgba(120, 200, 255, 0.25);
  box-shadow: 0 24px 70px rgba(0,0,0,0.6);
  color: #e8f3ff; font-family: ui-monospace, monospace;
}
.be-dev__title { font-size: 18px; font-weight: 700; letter-spacing: 0.04em; }
.be-dev__sub { margin-top: 6px; font-size: 12px; opacity: 0.66; }

.be-dev__dots { display: flex; gap: 14px; justify-content: center; margin: 22px 0 24px; }
.be-dev__dot { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid rgba(150, 210, 255, 0.55); transition: background 120ms, transform 120ms; }
.be-dev__dot.filled { background: #6fd0ff; border-color: #6fd0ff; transform: scale(1.08); }
.be-dev__dots.shake { animation: be-dev-shake 0.35s ease; }
@keyframes be-dev-shake {
  10%, 90% { transform: translateX(-2px); }
  20%, 80% { transform: translateX(4px); }
  30%, 50%, 70% { transform: translateX(-7px); }
  40%, 60% { transform: translateX(7px); }
}

.be-dev__pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.be-dev__key {
  height: 56px; border-radius: 12px; cursor: pointer;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
  color: #e8f3ff; font: 600 20px/1 ui-monospace, monospace;
  transition: background 120ms, transform 80ms;
}
.be-dev__key:hover { background: rgba(120, 200, 255, 0.16); }
.be-dev__key:active { transform: scale(0.95); }
.be-dev__key--cancel { color: #ff9a9a; font-size: 18px; }
.be-dev__key--back { color: #cfe8ff; font-size: 18px; }

.be-dev__tools { display: flex; flex-direction: column; gap: 12px; margin: 22px 0 18px; }
.be-dev__tool {
  padding: 14px 16px; border-radius: 12px; cursor: pointer;
  background: rgba(120, 200, 255, 0.1); border: 1px solid rgba(120, 200, 255, 0.3);
  color: #e8f3ff; font: 600 15px/1 ui-monospace, monospace; text-align: left;
  transition: background 120ms;
}
.be-dev__tool:hover:not(:disabled) { background: rgba(120, 200, 255, 0.22); }
.be-dev__tool:disabled { opacity: 0.4; cursor: default; }
.be-dev__menuclose { width: 100%; height: auto; padding: 10px; }
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
