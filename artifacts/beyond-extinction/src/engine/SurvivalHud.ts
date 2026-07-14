import type { AudioManager } from "./AudioManager";
import type { InputManager } from "./InputManager";
import type { QuestManager, TrackedObjective } from "./QuestManager";
import type { SurvivalStats, SurvivalSnapshot } from "./SurvivalStats";
import { PlayerInventory } from "./PlayerInventory";
import { registerHudElement } from "./HudEditor";

/**
 * SurvivalHud — the island's hybrid ARK × Path of Titans HUD.
 *
 * The HUD operates in two exclusive modes driven by `setMounted()`:
 *
 *  ON-FOOT (default)
 *    Always visible: menu row, temp/status readout, quest tracker, day/time
 *    On-foot only:   player stamina+water bars, item hotbar
 *
 *  MOUNTED (creature riding)
 *    Always visible: menu row, temp/status readout, quest tracker, day/time
 *    Mounted only:   PoT action ring (rest/dodge/ascend), bite/claw abilities,
 *                    creature vitals column (HP/Stamina/Food/Water/Weight)
 *
 * Calling setMounted(stats) switches to mounted mode and routes vitals to the
 * provided creature snapshot. setMounted(null) returns to on-foot mode and
 * resumes player-stat-driven vitals.
 *
 * Every cluster is a draggable/resizable node in the HUD editor.
 */

// ── public API ────────────────────────────────────────────────────────────────

export interface SurvivalHudOptions {
  parent: HTMLElement;
  input: InputManager;
  stats: SurvivalStats;
  quest: QuestManager;
  audio?: AudioManager;
  /** Open the pause/settings menu. */
  onOpenMenu: () => void;
  /** Open the full island map. */
  onOpenMap: () => void;
  /** Open the codex / inventory overlay. */
  onOpenCodex: () => void;
}

/**
 * Live stats snapshot for the creature currently being ridden.
 * All percentage fields (health, stamina, food, water) are 0–100.
 * Pass this to `SurvivalHud.setMounted()` each frame (or on every change).
 */
export interface MountedCreatureStats {
  /** Display name shown as the vitals header. e.g. "Triceratops" */
  name: string;
  /** HP percentage 0–100. */
  health: number;
  /** Stamina percentage 0–100. */
  stamina: number;
  /** Food (hunger) percentage 0–100. */
  food: number;
  /** Water (thirst) percentage 0–100. */
  water: number;
  /** Current carry weight in kg. */
  weight: number;
  /** Maximum carry weight in kg. */
  maxWeight: number;
  /** True for pterosaurs / flying mounts — swaps Jump → Ascend on the ring. */
  isFlyer: boolean;
}

// ── internals ─────────────────────────────────────────────────────────────────

interface VitalRow {
  row: HTMLDivElement;
  fill: HTMLElement;
  val: HTMLElement;
}

const ITEM_GLYPHS: Record<string, string> = {
  coffee: "☕",
  keycard: "🪪",
  flashlight: "🔦",
  meat: "🥩",
};

const HOTBAR_SLOTS = 6;
const BITE_CD_MS = 1300;
const CLAW_CD_MS = 2400;

// ── class ─────────────────────────────────────────────────────────────────────

export class SurvivalHud {
  private readonly root: HTMLDivElement;
  private readonly opts: SurvivalHudOptions;
  private readonly unregs: Array<() => void> = [];
  private readonly unsubs: Array<() => void> = [];
  private readonly timers = new Set<number>();

  // Cluster root elements — toggled by applyMode().
  private barsEl!: HTMLDivElement;
  private hotbarInnerEl!: HTMLDivElement;
  private ringEl!: HTMLDivElement;
  private abilitiesEl!: HTMLDivElement;
  private vitalsEl!: HTMLDivElement;

  // Live element refs — on-foot clusters.
  private statusEl!: HTMLDivElement;
  private tempEl!: HTMLElement;
  private wordEl!: HTMLElement;
  private trackerEl!: HTMLDivElement;
  private trackerList!: HTMLDivElement;
  private healthBar!: HTMLElement;
  private stamBar!: HTMLElement;
  private waterBar!: HTMLElement;
  private healthBarWrap!: HTMLDivElement;
  private stamBarWrap!: HTMLDivElement;
  private waterBarWrap!: HTMLDivElement;
  private hotbarSlotContainer!: HTMLDivElement;
  private daytimeEl!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private toastTimer: number | null = null;
  private lastHotbarKey = "";

  // Live element refs — mounted clusters.
  private restBtn!: HTMLButtonElement;
  private dodgeBtn!: HTMLButtonElement;
  private jumpBtn!: HTMLButtonElement;
  private vitals: Record<string, VitalRow> = {};
  private vitalsHeader!: HTMLElement;

  // Mode state.
  private mountedCreature: MountedCreatureStats | null = null;

  constructor(opts: SurvivalHudOptions) {
    this.opts = opts;
    this.root = document.createElement("div");
    this.root.className = "be-sh";

    // Always-visible clusters.
    this.buildMenu();
    this.buildStatus();
    this.buildTracker();
    this.buildDaytime();

    // On-foot-only clusters.
    this.buildBars();
    this.buildHotbar();

    // Mounted-only clusters.
    this.buildRing();
    this.buildAbilities();
    this.buildVitals();

    this.toastEl = document.createElement("div");
    this.toastEl.className = "be-sh-toast";
    this.root.appendChild(this.toastEl);

    opts.parent.appendChild(this.root);

    // Start in on-foot mode.
    this.applyMode();

    // The tracker replaces the single-line objective card on the island.
    opts.quest.setCardVisible(false);
    this.unsubs.push(opts.quest.subscribe((list) => this.renderTracker(list)));
    this.unsubs.push(opts.stats.subscribe((s) => this.onStats(s)));
  }

  // ── public API ──────────────────────────────────────────────────────────────

  /**
   * Switch to mounted mode, showing creature controls + vitals and hiding the
   * player's hotbar/bars. Call with null to return to on-foot mode.
   *
   * For live vitals updates while mounted, call this each frame (or on every
   * significant change) with the latest snapshot — it is cheap to call
   * repeatedly since DOM writes are skipped when nothing changes.
   */
  setMounted(creature: MountedCreatureStats | null): void {
    const wasNull = this.mountedCreature === null;
    this.mountedCreature = creature;
    if ((creature === null) !== wasNull) {
      // Mode actually changed — flip cluster visibility.
      this.applyMode();
    }
    if (creature) {
      this.renderMountedVitals(creature);
    }
  }

  /** Set the on-foot quick bars directly. The scene calls this every frame from
   *  the LIVE stats so the fill tracks the exact value and always reaches 0 —
   *  the throttled (5 Hz) onStats path could lag and appear to stop short. */
  setBars(health: number, stamina: number, water: number): void {
    if (this.mountedCreature !== null) return;
    this.healthBar.style.width = `${health}%`;
    this.stamBar.style.width = `${stamina}%`;
    this.waterBar.style.width = `${water}%`;
    this.healthBarWrap.classList.toggle("is-low", health < 25);
    this.stamBarWrap.classList.toggle("is-low", stamina < 25);
    this.waterBarWrap.classList.toggle("is-low", water < 25);
  }

  /** Reflect the current input latches on the ring buttons (call after any
   *  external change, e.g. keyboard C/Shift or a stamina auto-cancel). */
  syncRing(): void {
    this.restBtn.classList.toggle("is-active", this.opts.input.crouchLatched);
    this.dodgeBtn.classList.toggle("is-active", this.opts.input.runLatched);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    for (const u of this.unsubs) u();
    for (const u of this.unregs) u();
    this.opts.quest.setCardVisible(true);
    this.root.remove();
  }

  // ── mode switching ──────────────────────────────────────────────────────────

  /** Show/hide the on-foot vs mounted clusters based on current state. */
  private applyMode(): void {
    const mounted = this.mountedCreature !== null;

    // On-foot-only clusters: visible when NOT mounted.
    this.barsEl.style.display = mounted ? "none" : "";
    this.hotbarInnerEl.style.display = mounted ? "none" : "";

    // Mounted-only clusters: visible only when mounted.
    this.ringEl.style.display = mounted ? "" : "none";
    this.abilitiesEl.style.display = mounted ? "" : "none";
    this.vitalsEl.style.display = mounted ? "" : "none";

    if (mounted && this.mountedCreature) {
      // Update the ring's jump/ascend button to reflect flyer vs ground mount.
      const isFlyer = this.mountedCreature.isFlyer;
      this.jumpBtn.textContent = isFlyer ? "▲" : "⤒";
      this.jumpBtn.setAttribute("aria-label", isFlyer ? "Ascend" : "Jump/Leap");
    }

    this.root.classList.toggle("be-sh--mounted", mounted);
  }

  // ── cluster builders ────────────────────────────────────────────────────────

  private buildMenu(): void {
    const el = document.createElement("div");
    el.className = "be-sh-menu";
    // Codex (📖) intentionally omitted here — it lives under the inventory (🎒),
    // which now sits in this row where the Codex button used to be.
    const defs: Array<[string, string, () => void]> = [
      ["☰", "Menu", () => this.opts.onOpenMenu()],
      ["🗨", "Chat", () => this.toast("Radio channel — coming soon")],
      ["🗺", "Map", () => this.opts.onOpenMap()],
    ];
    for (const [glyph, label, fn] of defs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "be-sh-menu__btn";
      b.textContent = glyph;
      b.setAttribute("aria-label", label);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        this.opts.audio?.playSfx("ui-select");
        fn();
      });
      el.appendChild(b);
    }
    this.mount("menu", el);
  }

  private buildStatus(): void {
    const el = document.createElement("div");
    el.className = "be-sh-status";
    el.innerHTML = `<span class="be-sh-status__temp"></span><span class="be-sh-status__word"></span>`;
    this.statusEl = el;
    this.tempEl = el.querySelector(".be-sh-status__temp")!;
    this.wordEl = el.querySelector(".be-sh-status__word")!;
    this.mount("status", el);
  }

  private buildTracker(): void {
    const el = document.createElement("div");
    el.className = "be-sh-tracker";
    el.style.display = "none";
    el.innerHTML = `<div class="be-sh-tracker__title">Quests</div><div class="be-sh-tracker__list"></div>`;
    this.trackerEl = el;
    this.trackerList = el.querySelector(".be-sh-tracker__list")!;
    this.mount("tracker", el);
  }

  private buildDaytime(): void {
    const el = document.createElement("div");
    el.className = "be-sh-daytime";
    this.daytimeEl = el;
    this.mount("daytime", el);
  }

  // ── on-foot clusters ────────────────────────────────────────────────────────

  private buildBars(): void {
    const el = document.createElement("div");
    el.className = "be-sh-bars";
    el.innerHTML = `
      <div class="be-sh-bars__row"><span class="be-sh-bars__icon">❤</span><div class="be-sh-bars__bar be-sh-bars__bar--health"><i></i></div></div>
      <div class="be-sh-bars__row"><span class="be-sh-bars__icon">⚡</span><div class="be-sh-bars__bar be-sh-bars__bar--stam"><i></i></div></div>
      <div class="be-sh-bars__row"><span class="be-sh-bars__icon">💧</span><div class="be-sh-bars__bar be-sh-bars__bar--water"><i></i></div></div>`;
    this.barsEl = el;
    this.healthBarWrap = el.querySelector(".be-sh-bars__bar--health")!;
    this.stamBarWrap = el.querySelector(".be-sh-bars__bar--stam")!;
    this.waterBarWrap = el.querySelector(".be-sh-bars__bar--water")!;
    this.healthBar = this.healthBarWrap.querySelector("i")!;
    this.stamBar = this.stamBarWrap.querySelector("i")!;
    this.waterBar = this.waterBarWrap.querySelector("i")!;
    this.mount("bars", el);
  }

  private buildHotbar(): void {
    const el = document.createElement("div");
    el.className = "be-sh-hotbar";
    this.hotbarInnerEl = el;
    this.hotbarSlotContainer = el;
    el.addEventListener("pointerdown", (e) => {
      const slot = (e.target as HTMLElement).closest<HTMLElement>(".be-sh-hotbar__slot");
      if (!slot || !slot.dataset.item) return;
      e.preventDefault();
      e.stopPropagation();
      this.useItem(slot.dataset.item);
    });
    this.renderHotbar(true);
    this.mount("hotbar", el);
  }

  // ── mounted clusters ────────────────────────────────────────────────────────

  private buildRing(): void {
    const el = document.createElement("div");
    el.className = "be-sh-ring";
    this.ringEl = el;

    this.restBtn = this.ringBtn(el, "Zz", "Rest", () => {
      this.opts.input.toggleCrouch();
      this.syncRing();
    });
    this.dodgeBtn = this.ringBtn(el, "⇉", "Sprint", () => {
      if (this.opts.stats.stamina <= 0) {
        this.toast("Not enough stamina to sprint");
        return;
      }
      this.opts.input.toggleRun();
      this.syncRing();
    });
    // Jump glyph/label is updated by applyMode() based on isFlyer.
    this.jumpBtn = this.ringBtn(el, "⤒", "Jump/Leap", () => {
      this.opts.input.requestJump();
    });

    this.mount("ring", el);
  }

  private buildAbilities(): void {
    const el = document.createElement("div");
    el.className = "be-sh-abil";
    this.abilitiesEl = el;
    const mk = (label: string, big: boolean, cdMs: number) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `be-sh-abil__btn${big ? " be-sh-abil__btn--big" : ""}`;
      b.innerHTML = `${label}<span class="cd"></span>`;
      b.setAttribute("aria-label", label);
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.classList.contains("is-cd")) return;
        this.opts.audio?.playSfx("ui-select");
        const cd = b.querySelector<HTMLElement>(".cd")!;
        cd.style.animationDuration = `${cdMs}ms`;
        b.classList.add("is-cd");
        const t = window.setTimeout(() => {
          b.classList.remove("is-cd");
          this.timers.delete(t);
        }, cdMs);
        this.timers.add(t);
      });
      el.appendChild(b);
      return b;
    };
    mk("BITE", false, BITE_CD_MS);
    mk("CLAW", true, CLAW_CD_MS);
    this.mount("abilities", el);
  }

  private buildVitals(): void {
    const el = document.createElement("div");
    el.className = "be-sh-vitals";
    this.vitalsEl = el;

    // Header — shows the creature's name when mounted.
    const hdr = document.createElement("div");
    hdr.className = "be-sh-vitals__header";
    el.appendChild(hdr);
    this.vitalsHeader = hdr;

    const rows: Array<[string, string]> = [
      ["health", "❤"],
      ["stamina", "⚡"],
      ["food", "🍖"],
      ["water", "💧"],
      ["weight", "⚖"],
    ];
    for (const [key, icon] of rows) {
      const row = document.createElement("div");
      row.className = `be-sh-vital be-sh-vital--${key}`;
      row.innerHTML = `<span class="be-sh-vital__icon">${icon}</span><div class="be-sh-vital__bar"><i></i></div><span class="be-sh-vital__val"></span>`;
      el.appendChild(row);
      this.vitals[key] = {
        row,
        fill: row.querySelector("i")!,
        val: row.querySelector(".be-sh-vital__val")!,
      };
    }
    this.mount("vitals", el);
  }

  // ── mounting helper ─────────────────────────────────────────────────────────

  private mount(
    id:
      | "menu"
      | "status"
      | "tracker"
      | "daytime"
      | "bars"
      | "hotbar"
      | "ring"
      | "abilities"
      | "vitals",
    el: HTMLElement,
  ): void {
    this.root.appendChild(el);
    this.unregs.push(registerHudElement(id, el));
  }

  // ── ring helper ─────────────────────────────────────────────────────────────

  private ringBtn(
    parent: HTMLElement,
    glyph: string,
    label: string,
    fn: () => void,
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "be-sh-ring__btn";
    b.textContent = glyph;
    b.setAttribute("aria-label", label);
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.opts.audio?.playSfx("ui-select");
      fn();
    });
    parent.appendChild(b);
    return b;
  }

  // ── live updates ────────────────────────────────────────────────────────────

  private onStats(s: SurvivalSnapshot): void {
    // Status readout (always visible) — time-of-day phase, not temperature
    // (there is no temperature *mechanic* yet, so showing °C would overpromise).
    const ph = dayPhase(s.timeMin);
    this.tempEl.textContent = ph.icon;
    this.wordEl.textContent = ph.word;
    this.statusEl.classList.toggle("is-warmlight", ph.tone === "warm");
    this.statusEl.classList.toggle("is-night", ph.tone === "night");

    // Day / time (always visible).
    this.daytimeEl.textContent = `DAY ${s.day} · ${s.clock}`;

    if (this.mountedCreature !== null) {
      // Mounted mode: player bars/hotbar are hidden — skip those updates.
      // Vitals are driven by renderMountedVitals() from setMounted().
      return;
    }

    // On-foot mode: update the player's quick bars and hotbar.
    this.setBars(s.health, s.stamina, s.water);

    // Stamina hit zero → auto-cancel the sprint latch so the UI stays honest.
    if (s.stamina <= 0 && this.opts.input.runLatched) {
      this.opts.input.setRunToggled(false);
    }

    // Hotbar contents can change from pickups — cheap keyed re-render.
    this.renderHotbar(false);
  }

  /**
   * Push a creature snapshot into the vitals column (mounted mode only).
   * Called by setMounted() every time the caller supplies a fresh snapshot.
   */
  private renderMountedVitals(c: MountedCreatureStats): void {
    this.vitalsHeader.textContent = c.name;

    this.setVital("health", c.health, `${Math.round(c.health)}`);
    this.setVital("stamina", c.stamina, `${Math.round(c.stamina)}`);
    this.setVital("food", c.food, `${Math.round(c.food)}`);
    this.setVital("water", c.water, `${Math.round(c.water)}`);
    const wPct = Math.min(100, (c.weight / c.maxWeight) * 100);
    const w = this.vitals.weight;
    w.fill.style.width = `${wPct}%`;
    w.val.textContent = `${c.weight}kg`;
    w.row.classList.toggle("is-low", wPct > 85);

    // Ring: disable dodge if creature stamina is exhausted.
    this.dodgeBtn.classList.toggle("is-disabled", c.stamina <= 0);
    this.syncRing();
  }

  private setVital(key: string, pct: number, text: string): void {
    const v = this.vitals[key];
    v.fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    v.val.textContent = text;
    v.row.classList.toggle("is-low", pct < 25);
  }

  private renderTracker(list: TrackedObjective[]): void {
    if (list.length === 0) {
      this.trackerEl.style.display = "none";
      return;
    }
    this.trackerEl.style.display = "";
    let html = "";
    for (const o of list) {
      const done = o.state === "completed";
      const pctText =
        o.target !== undefined
          ? `${o.progress ?? 0}/${o.target} · ${o.percent}%`
          : done
            ? "Complete"
            : "In progress";
      html += `
        <div class="be-sh-quest${done ? " is-done" : ""}">
          <div class="be-sh-quest__text">${escapeHtml(o.text)}</div>
          <div class="be-sh-quest__bar"><i style="width:${o.percent}%"></i></div>
          <div class="be-sh-quest__pct">${pctText}</div>
        </div>`;
    }
    this.trackerList.innerHTML = html;
  }

  private renderHotbar(force: boolean): void {
    const counts = new Map<string, number>();
    if (PlayerInventory.hasBadge) counts.set("keycard", 1);
    for (const item of PlayerInventory.heldItems) {
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    const key = JSON.stringify([...counts.entries()]);
    if (!force && key === this.lastHotbarKey) return;
    this.lastHotbarKey = key;

    let html = "";
    let i = 0;
    for (const [item, qty] of counts) {
      if (i >= HOTBAR_SLOTS) break;
      const glyph = ITEM_GLYPHS[item] ?? "▪";
      const qtyHtml = qty > 1 ? `<span class="be-sh-hotbar__qty">${qty}</span>` : "";
      html += `<span class="be-sh-hotbar__slot has-item" data-item="${escapeHtml(item)}">${glyph}${qtyHtml}</span>`;
      i++;
    }
    for (; i < HOTBAR_SLOTS; i++) {
      html += `<span class="be-sh-hotbar__slot">${i + 1}</span>`;
    }
    this.hotbarSlotContainer.innerHTML = html;
  }

  private useItem(item: string): void {
    if (item === "coffee") {
      if (this.opts.stats.drink(20)) {
        PlayerInventory.drop("coffee");
        this.opts.audio?.playSfx("ui-select");
        this.toast("You drink the cold coffee (+water)");
        this.renderHotbar(true);
      } else {
        this.toast("Not thirsty right now");
      }
      return;
    }
    this.toast("Nothing to use — yet");
  }

  private toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove("show");
      this.toastTimer = null;
    }, 1600);
  }
}

/** Time-of-day phase for the status readout (minutes into the day, 0..1439). */
function dayPhase(timeMin: number): { icon: string; word: string; tone: "warm" | "day" | "night" } {
  const h = timeMin / 60;
  if (h >= 5 && h < 7) return { icon: "🌅", word: "Dawn", tone: "warm" };
  if (h >= 7 && h < 11) return { icon: "☀", word: "Morning", tone: "day" };
  if (h >= 11 && h < 14) return { icon: "☀", word: "Midday", tone: "day" };
  if (h >= 14 && h < 17) return { icon: "🌤", word: "Afternoon", tone: "day" };
  if (h >= 17 && h < 19) return { icon: "🌇", word: "Dusk", tone: "warm" };
  return { icon: "🌙", word: "Night", tone: "night" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
