import { PlayerInventory } from "./PlayerInventory";

/**
 * ARK-style inventory screen — a web port of the Godot project's inventory_ui.gd.
 * Toggled with I (or the pack button, for touch) and closed with I/Esc/✕. Dark
 * translucent teal panels with cyan borders: a category strip, INVENTORY/COSMETICS
 * /CRAFTING tabs, a search bar, a 6×5 item grid, a "YOU" stats column, and a
 * hotbar. Only the grid, the weight bar, and the objective are live (driven by
 * PlayerInventory + the current quest objective); the rest is intentionally
 * non-functional scaffolding, matching the Godot skeleton.
 *
 * Opening freezes the player (via the hooks) and frees the pointer; closing
 * restores control. Opening is gated to free-roam moments so it can never
 * interrupt a scripted beat.
 */
const COLS = 6;
const ROWS = 5;

interface ItemInfo {
  name: string;
  tint: string;
}
function itemInfo(id: string): ItemInfo {
  switch (id) {
    case "coffee":
      return { name: "Coffee", tint: "#754c2e" };
    case "badge":
      return { name: "Keycard", tint: "#1a7af2" };
    default:
      return { name: id, tint: "#4d5a66" };
  }
}

export interface InventoryHooks {
  /** Current objective line to mirror in the panel. */
  getObjective: () => string;
  /** Called with true on open, false on close — the scene freezes/unfreezes. */
  setFrozen: (frozen: boolean) => void;
  /** Whether the inventory may open right now (free roam, no cutscene). */
  canOpen: () => boolean;
  playSfx?: (name: string) => void;
}

export class InventoryOverlay {
  private readonly root: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private gridEl!: HTMLDivElement;
  private objEl!: HTMLDivElement;
  private weightFill!: HTMLDivElement;
  private weightVal!: HTMLSpanElement;
  private open = false;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(
    parent: HTMLElement,
    private readonly hooks: InventoryHooks,
  ) {
    this.root = document.createElement("div");
    this.root.className = "be-inv";
    this.root.innerHTML = this.markup();
    parent.appendChild(this.root);
    this.gridEl = this.root.querySelector(".be-inv__grid")!;
    this.objEl = this.root.querySelector(".be-inv__obj")!;
    this.weightFill = this.root.querySelector(".be-inv__weightfill")!;
    this.weightVal = this.root.querySelector(".be-inv__weightval")!;

    // A small pack button in the HUD so touch devices can open the inventory.
    this.button = document.createElement("button");
    this.button.className = "be-inv-btn";
    this.button.type = "button";
    this.button.setAttribute("aria-label", "Inventory");
    this.button.textContent = "🎒";
    parent.appendChild(this.button);
    this.button.addEventListener("click", () => this.toggle());

    this.root
      .querySelector(".be-inv__close")
      ?.addEventListener("click", () => this.close());
    // Click the dim backdrop (outside the frame) to close.
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.close();
    });

    this.onKey = (e) => {
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        this.toggle();
      } else if (e.key === "Escape" && this.open) {
        e.preventDefault();
        this.close();
      }
    };
    window.addEventListener("keydown", this.onKey);
  }

  toggle(): void {
    if (this.open) this.close();
    else this.openPanel();
  }

  private openPanel(): void {
    if (this.open || !this.hooks.canOpen()) return;
    this.open = true;
    this.refresh();
    this.root.classList.add("show");
    this.hooks.setFrozen(true);
    this.hooks.playSfx?.("ui-select");
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove("show");
    this.hooks.setFrozen(false);
    this.hooks.playSfx?.("ui-select");
  }

  /** Rebuild the live parts (grid, objective, weight) from current state. */
  private refresh(): void {
    const items: Array<{ id: string; qty: number }> = [];
    const cups = PlayerInventory.count("coffee");
    if (cups > 0) items.push({ id: "coffee", qty: cups });
    if (PlayerInventory.hasBadge) items.push({ id: "badge", qty: 1 });

    const total = COLS * ROWS;
    let html = "";
    for (let i = 0; i < total; i++) {
      const it = items[i];
      if (!it) {
        html += `<div class="be-inv__slot"></div>`;
        continue;
      }
      const info = itemInfo(it.id);
      const qty = it.qty > 1 ? `<span class="be-inv__qty">x${it.qty}</span>` : "";
      html += `<div class="be-inv__slot"><span class="be-inv__icon" style="background:${info.tint}"></span><span class="be-inv__name">${info.name}</span>${qty}</div>`;
    }
    this.gridEl.innerHTML = html;

    this.objEl.textContent = this.hooks.getObjective() || "—";
    const weight = cups * 0.3 + (PlayerInventory.hasBadge ? 0.1 : 0);
    this.weightVal.textContent = `${weight.toFixed(1)} / 80`;
    this.weightFill.style.width = `${Math.min(weight / 80, 1) * 100}%`;
  }

  private markup(): string {
    const stat = (label: string, pct: number, val: string, cls: string) =>
      `<div class="be-inv__stat"><span class="be-inv__statlbl">${label}</span>
        <span class="be-inv__bar"><i class="be-inv__fill ${cls}" style="width:${pct}%"></i></span>
        <span class="be-inv__statval">${val}</span></div>`;
    const chips = ["I", "C", "T", "M", "?", "@"]
      .map((l, i) => `<span class="be-inv__chip${i === 0 ? " on" : ""}">${l}</span>`)
      .join("");
    const hot = Array.from({ length: 8 }, () => `<div class="be-inv__hot"></div>`).join("");
    return `
      <div class="be-inv__frame" role="dialog" aria-label="Inventory">
        <div class="be-inv__chips">${chips}</div>
        <div class="be-inv__body">
          <div class="be-inv__left">
            <div class="be-inv__tabs">
              <span class="be-inv__tab on">INVENTORY</span>
              <span class="be-inv__tab">COSMETICS</span>
              <span class="be-inv__tab">CRAFTING</span>
            </div>
            <div class="be-inv__search"><input placeholder="Search" disabled /><span class="be-inv__mini">A-Z</span></div>
            <div class="be-inv__grid"></div>
          </div>
          <div class="be-inv__right">
            <div class="be-inv__you">YOU</div>
            <div class="be-inv__role">JACK · Lab Technician</div>
            <div class="be-inv__silo">[ character preview ]</div>
            ${stat("HEALTH", 100, "100 / 100", "hp")}
            ${stat("STAMINA", 100, "100 / 100", "st")}
            ${stat("FOOD", 80, "80 / 100", "fd")}
            ${stat("WATER", 90, "90 / 100", "wt")}
            <div class="be-inv__stat"><span class="be-inv__statlbl">WEIGHT</span>
              <span class="be-inv__bar"><i class="be-inv__weightfill be-inv__fill wg"></i></span>
              <span class="be-inv__statval be-inv__weightval">0.0 / 80</span></div>
            <div class="be-inv__objttl">OBJECTIVE</div>
            <div class="be-inv__obj"></div>
          </div>
        </div>
        <div class="be-inv__foot">
          <div class="be-inv__hotbar">${hot}</div>
          <button class="be-inv__close" type="button">[I] / Esc · Close</button>
        </div>
      </div>`;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
    this.root.remove();
    this.button.remove();
  }
}
