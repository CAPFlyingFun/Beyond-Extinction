import type { AudioManager } from "./AudioManager";
import {
  getSettings,
  setSettings,
  subscribeSettings,
  HUD_ELEMENT_IDS,
  HUD_PLACEMENT_RANGES,
  type HudElementId,
  type HudLayout,
  type HudPlacement,
} from "./Settings";

/**
 * CODM-style custom HUD layout.
 *
 * Two halves:
 *  1. A tiny registry (registerHudElement) that live HUD elements join so any
 *     saved placement in settings.hudLayout is applied to them — and re-applied
 *     whenever the layout changes.
 *  2. A full-screen editor (openHudEditor) with a mock proxy of every HUD
 *     element: drag to move, tap to select, slider to resize, then Save /
 *     Reset / Cancel. Saving writes settings.hudLayout, which flows back to
 *     the live elements through the registry.
 *
 * Placement is applied with the independent CSS `translate`/`scale` properties
 * (NOT `transform`), so elements that animate their own transform (e.g. the
 * quest card's slide-in) keep working — the two compose instead of clobbering
 * each other. left/top position the element's centre as a % of the viewport.
 */

// ── live-element registry ─────────────────────────────────────────────────────

const live = new Map<HudElementId, Set<HTMLElement>>();
let unsubscribe: (() => void) | null = null;

/** Apply (or clear, when p is undefined) a placement on an element. */
function applyPlacement(el: HTMLElement, p: HudPlacement | undefined): void {
  if (p) {
    el.style.left = `${p.x}%`;
    el.style.top = `${p.y}%`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.setProperty("translate", "-50% -50%");
    el.style.setProperty("scale", String(p.scale));
  } else {
    el.style.left = "";
    el.style.top = "";
    el.style.right = "";
    el.style.bottom = "";
    el.style.removeProperty("translate");
    el.style.removeProperty("scale");
  }
}

function applyAll(layout: HudLayout): void {
  for (const [id, els] of live) {
    for (const el of els) applyPlacement(el, layout[id]);
  }
}

/**
 * Register a live HUD element under a layout id. Applies any saved placement
 * immediately and keeps it in sync with future edits. Returns an unregister
 * function — call it from the owner's dispose().
 */
export function registerHudElement(id: HudElementId, el: HTMLElement): () => void {
  let set = live.get(id);
  if (!set) {
    set = new Set();
    live.set(id, set);
  }
  set.add(el);
  applyPlacement(el, getSettings().hudLayout[id]);
  if (!unsubscribe) {
    unsubscribe = subscribeSettings((s) => applyAll(s.hudLayout));
  }
  return () => {
    set.delete(el);
  };
}

// ── the editor ────────────────────────────────────────────────────────────────

const LABELS: Record<HudElementId, string> = {
  minimap: "Minimap",
  jump: "Jump",
  run: "Run",
  crouch: "Crouch",
  interact: "Interact",
  quest: "Objective",
};

interface OpenOptions {
  parent: HTMLElement;
  audio?: AudioManager;
  onClose?: () => void;
}

let openEl: HTMLDivElement | null = null;

/** Whether the HUD editor is currently open. */
export function isHudEditorOpen(): boolean {
  return openEl !== null;
}

/**
 * Open the full-screen HUD layout editor. Single-instance. Works from any
 * scene — it edits mock proxies (styled with the real HUD CSS classes), so
 * the real elements don't need to be on screen.
 */
export function openHudEditor({ parent, audio, onClose }: OpenOptions): void {
  if (openEl) return;
  injectEditorStyles();

  // Working copy — nothing is persisted until Save.
  const layout: HudLayout = structuredClone(getSettings().hudLayout);

  const el = document.createElement("div");
  el.className = "be-hudedit";
  el.innerHTML = `
    <div class="be-hudedit__topbar">
      <div class="be-hudedit__hint">Drag any control to move it. Tap one to resize.</div>
      <div class="be-hudedit__actions">
        <button type="button" class="be-btn" data-action="resetall">Reset All</button>
        <button type="button" class="be-btn" data-action="cancel">Cancel</button>
        <button type="button" class="be-btn be-btn--primary" data-action="save">Save</button>
      </div>
    </div>
    <div class="be-hudedit__stage"></div>
    <div class="be-hudedit__scaler" style="display:none">
      <span class="be-hudedit__scname"></span>
      <input type="range" min="${HUD_PLACEMENT_RANGES.scale.min}" max="${HUD_PLACEMENT_RANGES.scale.max}" step="0.05" />
      <b class="be-hudedit__scval"></b>
      <button type="button" class="be-btn" data-action="resetone">Reset</button>
    </div>`;
  parent.appendChild(el);
  openEl = el;
  requestAnimationFrame(() => el.classList.add("show"));

  const stage = el.querySelector(".be-hudedit__stage") as HTMLDivElement;
  const scaler = el.querySelector(".be-hudedit__scaler") as HTMLDivElement;
  const scName = el.querySelector(".be-hudedit__scname") as HTMLSpanElement;
  const scInput = scaler.querySelector("input") as HTMLInputElement;
  const scVal = el.querySelector(".be-hudedit__scval") as HTMLElement;

  // ── mock proxies (reuse the real HUD classes so they look right) ──────────
  const proxies = new Map<HudElementId, HTMLElement>();

  function makeProxy(id: HudElementId): HTMLElement {
    let p: HTMLElement;
    switch (id) {
      case "minimap": {
        // Self-styled mock: the real .be-imap CSS is lazily injected by
        // IslandMap, which may never have been constructed (e.g. editing from
        // the lab), so the mock can't depend on it.
        p = document.createElement("div");
        p.className = `be-hudedit__mock-map at-${getSettings().minimapCorner}`;
        p.innerHTML = `<div class="be-hudedit__mock-mapfill">MAP</div><div class="be-hudedit__mock-range">300 m</div>`;
        break;
      }
      case "jump": {
        p = document.createElement("button");
        p.className = "be-fp-jump";
        p.textContent = "⤒";
        break;
      }
      case "run": {
        p = document.createElement("button");
        p.className = "be-fp-run";
        p.textContent = "RUN";
        break;
      }
      case "crouch": {
        p = document.createElement("button");
        p.className = "be-fp-crouch";
        p.textContent = "CRCH";
        break;
      }
      case "interact": {
        p = document.createElement("button");
        p.className = "be-fp-interact";
        p.textContent = "Interact";
        break;
      }
      case "quest": {
        p = document.createElement("div");
        p.className = "be-quest show";
        p.innerHTML = `
          <div class="be-quest__label">Objective</div>
          <div class="be-quest__body">
            <div class="be-quest__status" aria-hidden="true"></div>
            <div class="be-quest__text">Find Sarah</div>
          </div>`;
        break;
      }
    }
    p.classList.add("be-hudedit__item");
    p.dataset.hudId = id;
    if (p instanceof HTMLButtonElement) p.type = "button";
    return p;
  }

  for (const id of HUD_ELEMENT_IDS) {
    const p = makeProxy(id);
    stage.appendChild(p);
    proxies.set(id, p);
    applyPlacement(p, layout[id]);
  }

  // ── selection + scale slider ──────────────────────────────────────────────
  let selected: HudElementId | null = null;

  function select(id: HudElementId | null): void {
    selected = id;
    for (const [pid, p] of proxies) p.classList.toggle("sel", pid === id);
    if (!id) {
      scaler.style.display = "none";
      return;
    }
    scaler.style.display = "";
    scName.textContent = LABELS[id];
    const s = layout[id]?.scale ?? 1;
    scInput.value = String(s);
    scVal.textContent = `${Math.round(s * 100)}%`;
  }

  scInput.addEventListener("input", () => {
    if (!selected) return;
    const s = parseFloat(scInput.value);
    layout[selected] = { ...placementFor(selected), scale: s };
    applyPlacement(proxies.get(selected)!, layout[selected]);
    scVal.textContent = `${Math.round(s * 100)}%`;
  });

  /** Current placement for id — from the working layout, or measured from the
   *  proxy's default CSS position the first time it's touched. */
  function placementFor(id: HudElementId): HudPlacement {
    const existing = layout[id];
    if (existing) return existing;
    const r = proxies.get(id)!.getBoundingClientRect();
    return {
      x: ((r.left + r.width / 2) / window.innerWidth) * 100,
      y: ((r.top + r.height / 2) / window.innerHeight) * 100,
      scale: 1,
    };
  }

  // ── dragging ──────────────────────────────────────────────────────────────
  let dragId: HudElementId | null = null;
  let dragStart = { px: 0, py: 0, x: 0, y: 0 };

  stage.addEventListener("pointerdown", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".be-hudedit__item");
    if (!item) {
      select(null);
      return;
    }
    e.preventDefault();
    const id = item.dataset.hudId as HudElementId;
    select(id);
    const p = placementFor(id);
    dragId = id;
    dragStart = { px: e.clientX, py: e.clientY, x: p.x, y: p.y };
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — dragging still works while the pointer stays over the stage */
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragId) return;
    e.preventDefault();
    const { min: xMin, max: xMax } = HUD_PLACEMENT_RANGES.x;
    const { min: yMin, max: yMax } = HUD_PLACEMENT_RANGES.y;
    const nx = dragStart.x + ((e.clientX - dragStart.px) / window.innerWidth) * 100;
    const ny = dragStart.y + ((e.clientY - dragStart.py) / window.innerHeight) * 100;
    const prev = placementFor(dragId);
    layout[dragId] = {
      x: Math.min(xMax, Math.max(xMin, nx)),
      y: Math.min(yMax, Math.max(yMin, ny)),
      scale: prev.scale,
    };
    applyPlacement(proxies.get(dragId)!, layout[dragId]);
  });
  const endDrag = () => {
    dragId = null;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // ── actions ───────────────────────────────────────────────────────────────
  function close(): void {
    if (!openEl) return;
    openEl = null;
    el.classList.remove("show");
    setTimeout(() => {
      el.remove();
      onClose?.();
    }, 200);
  }

  el.querySelector('[data-action="save"]')?.addEventListener("click", () => {
    audio?.playSfx("ui-select");
    setSettings({ hudLayout: layout });
    close();
  });
  el.querySelector('[data-action="cancel"]')?.addEventListener("click", () => {
    audio?.playSfx("ui-select");
    close();
  });
  el.querySelector('[data-action="resetall"]')?.addEventListener("click", () => {
    audio?.playSfx("ui-select");
    for (const id of HUD_ELEMENT_IDS) {
      delete layout[id];
      applyPlacement(proxies.get(id)!, undefined);
    }
    select(selected); // refresh the slider readout
  });
  el.querySelector('[data-action="resetone"]')?.addEventListener("click", () => {
    if (!selected) return;
    audio?.playSfx("ui-select");
    delete layout[selected];
    applyPlacement(proxies.get(selected)!, undefined);
    select(selected);
  });
}

/** Force-close the editor (scene dispose safety net). */
export function closeHudEditor(): void {
  if (!openEl) return;
  const el = openEl;
  openEl = null;
  el.remove();
}

// ── styles ────────────────────────────────────────────────────────────────────

let stylesInjected = false;
function injectEditorStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.be-hudedit {
  position: fixed; inset: 0; z-index: 140;
  background:
    linear-gradient(rgba(120,200,255,0.05) 1px, transparent 1px) 0 0 / 100% 10%,
    linear-gradient(90deg, rgba(120,200,255,0.05) 1px, transparent 1px) 0 0 / 10% 100%,
    rgba(5, 10, 18, 0.92);
  opacity: 0; transition: opacity 0.2s ease;
}
.be-hudedit.show { opacity: 1; }
.be-hudedit__topbar {
  position: absolute; top: 0; left: 0; right: 0; z-index: 2;
  display: flex; align-items: center; justify-content: space-between; gap: 0.8rem;
  padding: 0.7rem 1rem; flex-wrap: wrap;
  background: rgba(6, 12, 20, 0.75);
  border-bottom: 1px solid rgba(120, 200, 255, 0.18);
}
.be-hudedit__hint {
  font: 500 0.82rem/1.3 "Inter", sans-serif; color: #9fc2e0; letter-spacing: 0.02em;
}
.be-hudedit__actions { display: flex; gap: 0.5rem; }
.be-hudedit__stage { position: absolute; inset: 0; touch-action: none; }
.be-hudedit__item {
  cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
  pointer-events: auto;
}
.be-hudedit__item.sel {
  outline: 2px dashed rgba(120, 220, 255, 0.9); outline-offset: 4px;
}
.be-hudedit__mock-map {
  position: absolute; width: 150px; height: 150px; border-radius: 50%;
  background: #10202f; box-shadow: 0 6px 22px rgba(0,0,0,0.5);
}
/* Default corner presets — mirror IslandMap's .be-imap--tl/.be-imap--tr. */
.be-hudedit__mock-map.at-tl { top: 14px; left: 14px; }
.be-hudedit__mock-map.at-tr { top: 74px; right: 14px; }
@media (max-width: 640px) { .be-hudedit__mock-map { width: 112px; height: 112px; } }
.be-hudedit__mock-mapfill {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  border-radius: 50%; border: 2px solid rgba(120, 200, 255, 0.3);
  color: #7fb2d8; font: 700 0.9rem/1 ui-monospace, monospace; letter-spacing: 0.2em;
}
.be-hudedit__mock-range {
  position: absolute; right: 6px; bottom: 6px; padding: 1px 6px; border-radius: 8px;
  background: rgba(6,12,20,0.6); color: #cfe8ff; font: 600 10px/1.4 ui-monospace, monospace;
}
.be-hudedit__scaler {
  position: absolute; left: 50%; bottom: 18px; translate: -50% 0; z-index: 2;
  display: flex; align-items: center; gap: 0.7rem;
  padding: 0.55rem 0.9rem; border-radius: 12px;
  background: rgba(6, 12, 20, 0.85); border: 1px solid rgba(120, 200, 255, 0.25);
  max-width: min(92vw, 460px);
}
.be-hudedit__scname {
  font: 600 0.8rem/1 "Inter", sans-serif; color: #e8f3ff; white-space: nowrap;
}
.be-hudedit__scaler input { width: min(40vw, 180px); }
.be-hudedit__scval {
  font: 700 0.8rem/1 ui-monospace, monospace; color: #9fe0b2; min-width: 3.2em; text-align: right;
}
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
