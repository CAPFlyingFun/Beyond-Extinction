import type { SurvivalStats } from "./SurvivalStats";

/**
 * IslandHud — the Chapter-Two island's compact, mobile-first survival readout.
 *
 * Layout follows the "Refined B" mockup: a slim VERTICAL vitals stack in the
 * top-left (under the objective card) and a row of round action buttons in the
 * top-right. Deliberately minimal — the "The Isle / Evrima" idiom rather than
 * ARK's radial dials or Path of Titans' fat bars — so it stays out of the way
 * on a phone held in landscape and keeps the sightline clear for looking around.
 *
 * Vitals read as TIME-TO-EMPTY rather than bare percentages, so one glance
 * tells the player how long they have, not just an abstract number:
 *   HP     → percent (it's derived from food/water/damage, so a % reads clearest)
 *   STAM   → seconds of continuous sprint left   (stamina ÷ run-drain)
 *   WATER  → in-world h:mm until dry              (water  ÷ thirst-drain × clock)
 *   FOOD   → in-world h:mm until starving         (food   ÷ hunger-drain × clock)
 * No fill bars — icon, label, value only — for the simpler look that was asked
 * for. Values tint amber/red as a stat runs low.
 *
 * These drain constants MUST mirror SurvivalStats; they're duplicated here (not
 * imported) because SurvivalStats keeps them module-private. If the survival
 * model retunes its rates, retune these too.
 */
const RUN_DRAIN = 6; // STAMINA_RUN_DRAIN, points/sec
const WATER_DRAIN = 0.11; // WATER_DRAIN, points/sec
const FOOD_DRAIN = 0.07; // FOOD_DRAIN, points/sec
const GAME_MIN_PER_SEC = 1; // SurvivalStats clock rate (1 in-world minute / real sec)

export interface IslandHudOptions {
  parent: HTMLElement;
  stats: SurvivalStats;
  /** Current story objective shown in the top-left card. Empty ⇒ card hidden. */
  objective?: string;
  /** Open the pause / settings menu (☰). */
  onMenu: () => void;
  /** Tapped the map button (🗺) — locked until the player finds a map. */
  onMap: () => void;
}

export class IslandHud {
  private readonly root: HTMLDivElement;
  private readonly objEl: HTMLDivElement;
  private readonly objTextEl: HTMLSpanElement;
  private readonly val: {
    hp: HTMLSpanElement;
    stam: HTMLSpanElement;
    water: HTMLSpanElement;
    food: HTMLSpanElement;
  };
  private readonly buttons: HTMLButtonElement[] = [];
  private acc = 0;
  private active = true;

  constructor(private readonly opts: IslandHudOptions) {
    ensureStyle();

    const col = document.createElement("div");
    col.className = "be-ihud";
    col.innerHTML = `
      <div class="be-ihud__obj"><span class="be-ihud__objicon">◈</span><span class="be-ihud__objtext"></span></div>
      <div class="be-ihud__vitals">
        <div class="be-ihud__row"><span class="be-ihud__ic">💗</span><span class="be-ihud__lbl">HP</span><span class="be-ihud__val" data-k="hp">100%</span></div>
        <div class="be-ihud__row"><span class="be-ihud__ic">⚡</span><span class="be-ihud__lbl">STAM</span><span class="be-ihud__val" data-k="stam">—</span></div>
        <div class="be-ihud__row"><span class="be-ihud__ic">💧</span><span class="be-ihud__lbl">WATER</span><span class="be-ihud__val" data-k="water">—</span></div>
        <div class="be-ihud__row"><span class="be-ihud__ic">🍃</span><span class="be-ihud__lbl">FOOD</span><span class="be-ihud__val" data-k="food">—</span></div>
      </div>`;
    opts.parent.appendChild(col);
    this.root = col;
    this.objEl = col.querySelector(".be-ihud__obj") as HTMLDivElement;
    this.objTextEl = col.querySelector(".be-ihud__objtext") as HTMLSpanElement;
    this.val = {
      hp: col.querySelector('[data-k="hp"]') as HTMLSpanElement,
      stam: col.querySelector('[data-k="stam"]') as HTMLSpanElement,
      water: col.querySelector('[data-k="water"]') as HTMLSpanElement,
      food: col.querySelector('[data-k="food"]') as HTMLSpanElement,
    };
    this.setObjective(opts.objective ?? "");

    // Top-right round buttons. The inventory (🎒) button belongs to
    // InventoryOverlay and sits at the rightmost slot (see be-inv-btn override in
    // the injected CSS); Map and Menu fill the slots to its left.
    const map = this.mkBtn("🗺", "Map", opts.onMap);
    const menu = this.mkBtn("☰", "Menu", opts.onMenu);
    map.style.right = "62px";
    menu.style.right = "112px";
    this.buttons.push(map, menu);
  }

  private mkBtn(glyph: string, label: string, on: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "be-ihud-btn";
    b.setAttribute("aria-label", label);
    b.textContent = glyph;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      on();
    });
    this.opts.parent.appendChild(b);
    return b;
  }

  /** Set the story objective line; empty string hides the card. */
  setObjective(text: string): void {
    const t = (text ?? "").trim();
    this.objTextEl.textContent = t;
    this.objEl.style.display = t ? "" : "none";
  }

  /** Show/hide the whole HUD (hidden during the arrival cinematic). */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    const disp = on ? "" : "none";
    this.root.style.display = disp;
    for (const b of this.buttons) b.style.display = disp;
  }

  /** Refresh the readouts from live stats (throttled to ~5 Hz). */
  update(dt: number): void {
    if (!this.active) return;
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    const s = this.opts.stats;
    this.val.hp.textContent = `${Math.round(s.health)}%`;
    this.val.stam.textContent = fmtSec(s.stamina / RUN_DRAIN);
    this.val.water.textContent = fmtGame((s.water / WATER_DRAIN) * GAME_MIN_PER_SEC);
    this.val.food.textContent = fmtGame((s.food / FOOD_DRAIN) * GAME_MIN_PER_SEC);
    tint(this.val.hp, s.health, 30, 12);
    tint(this.val.stam, s.stamina, 30, 12);
    tint(this.val.water, s.water, 25, 10);
    tint(this.val.food, s.food, 25, 10);
  }

  dispose(): void {
    this.root.remove();
    for (const b of this.buttons) b.remove();
  }
}

/** "16s" — whole seconds of sprint remaining. */
function fmtSec(sec: number): string {
  return `${Math.max(0, Math.round(sec))}s`;
}

/** In-world time to empty: "15h 00m", or "42m" under an hour. */
function fmtGame(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h <= 0 ? `${mm}m` : `${h}h ${String(mm).padStart(2, "0")}m`;
}

/** Amber under `warn`, red under `crit`, normal otherwise. */
function tint(el: HTMLElement, val: number, warn: number, crit: number): void {
  el.classList.toggle("be-ihud__val--warn", val <= warn && val > crit);
  el.classList.toggle("be-ihud__val--crit", val <= crit);
}

let styleInjected = false;
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
  .be-ihud {
    position: fixed;
    top: calc(10px + env(safe-area-inset-top, 0px));
    left: calc(12px + env(safe-area-inset-left, 0px));
    z-index: 60;
    display: flex; flex-direction: column; gap: 8px;
    pointer-events: none; user-select: none; -webkit-user-select: none;
    font: 600 12px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: .04em;
  }
  .be-ihud__obj {
    display: inline-flex; align-items: center; gap: 8px; align-self: flex-start;
    max-width: 60vw;
    padding: 7px 12px; border-radius: 9px;
    background: rgba(6, 16, 24, 0.66);
    border: 1px solid rgba(105, 210, 231, 0.30);
    color: #eaf7ff; backdrop-filter: blur(6px);
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.40);
  }
  .be-ihud__objicon { color: #57d8f0; font-size: 13px; }
  .be-ihud__objtext { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .be-ihud__vitals {
    align-self: flex-start;
    display: flex; flex-direction: column; gap: 3px;
    padding: 8px 11px; border-radius: 9px;
    background: rgba(6, 16, 24, 0.60);
    border: 1px solid rgba(105, 210, 231, 0.22);
    backdrop-filter: blur(6px);
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.40);
  }
  .be-ihud__row { display: grid; grid-template-columns: 16px 44px auto; align-items: center; gap: 8px; }
  .be-ihud__ic { font-size: 12px; text-align: center; filter: saturate(1.05); }
  .be-ihud__lbl { color: #9fb6c4; font-weight: 700; }
  .be-ihud__val { color: #f0fbff; text-align: right; min-width: 52px; font-variant-numeric: tabular-nums; }
  .be-ihud__val--warn { color: #ffd15a; }
  .be-ihud__val--crit { color: #ff6b5a; }

  .be-ihud-btn {
    position: fixed;
    top: calc(10px + env(safe-area-inset-top, 0px));
    right: calc(12px + env(safe-area-inset-right, 0px));
    z-index: 62;
    width: 42px; height: 42px; border-radius: 50%;
    border: 1px solid rgba(105, 210, 231, 0.45);
    background: radial-gradient(circle at 50% 35%, rgba(20, 40, 56, 0.85), rgba(8, 18, 28, 0.85));
    color: #d9f2ff; font-size: 19px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; pointer-events: auto;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45), inset 0 0 10px rgba(105, 210, 231, 0.12);
    -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  .be-ihud-btn:active { transform: scale(0.94); }
  /* Move the InventoryOverlay button from its default top-left slot into the
     rightmost slot of this HUD's top-right button row. */
  .be-inv-btn {
    top: calc(10px + env(safe-area-inset-top, 0px)) !important;
    left: auto !important;
    right: calc(12px + env(safe-area-inset-right, 0px)) !important;
    z-index: 62;
  }
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}
