export type ObjectiveState = "inactive" | "active" | "completed";

export interface ObjectiveDef {
  id: string;
  text: string;
}

/**
 * Top-left HUD objective tracker. Beyond the original single-line
 * setObjective/clear (kept as a compatibility shim for ad-hoc callers such as
 * the dialogue director and placeholder scenes), it now models an ordered set
 * of objectives by stable id so each beat can visibly ACTIVATE and then
 * COMPLETE — a brief "✓" tick — before the next one appears.
 */
export class QuestManager {
  private root: HTMLDivElement;
  private textEl: HTMLDivElement;
  private statusEl: HTMLDivElement;

  private defs = new Map<string, ObjectiveDef>();
  private states = new Map<string, ObjectiveState>();
  private activeId: string | null = null;
  private completionTimer: number | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "be-quest";
    this.root.innerHTML = `
      <div class="be-quest__label">Objective</div>
      <div class="be-quest__body">
        <div class="be-quest__status" aria-hidden="true"></div>
        <div class="be-quest__text"></div>
      </div>`;
    parent.appendChild(this.root);
    this.textEl = this.root.querySelector(".be-quest__text")!;
    this.statusEl = this.root.querySelector(".be-quest__status")!;
  }

  /** Register the ordered objective definitions for a scene. */
  configure(defs: readonly ObjectiveDef[]): void {
    // Reset any in-flight tick/HUD so a reconfigure mid-scene can't leave a
    // stale completion timer pointing at the previous objective set.
    this.clear();
    this.defs.clear();
    this.states.clear();
    for (const def of defs) {
      this.defs.set(def.id, def);
      this.states.set(def.id, "inactive");
    }
  }

  /** Show a registered objective as the current active goal. */
  activate(id: string): void {
    const def = this.defs.get(id);
    if (!def) return;
    this.cancelTimer();
    this.states.set(id, "active");
    this.activeId = id;
    this.render(def.text, "active");
  }

  /**
   * Mark a registered objective complete: it shows a ✓ tick for `holdMs`, then
   * either advances to `nextId` or hides the HUD. Any other quest call during
   * the hold cancels the pending handoff, so there is no stale-timer race.
   */
  complete(id: string, opts?: { holdMs?: number; nextId?: string }): void {
    const def = this.defs.get(id);
    if (!def) return;
    // Guard only against a genuine double-fire (already completed). Crucially we
    // do NOT require `id` to still be the visibly-active objective: the previous
    // beat's completion tick delays the NEXT activate by holdMs, and beats can
    // finish faster than that (e.g. grabbing both coffees quickly). Advancing the
    // logical active id immediately (below) means a rapid follow-up complete is
    // never dropped — which is exactly what left the HUD stuck on "one more to go".
    if (this.states.get(id) === "completed") return;
    this.cancelTimer();
    this.states.set(id, "completed");

    const nextId = opts?.nextId;
    // Advance the LOGICAL current objective right away so the next complete()
    // sees its target as active even while this one's ✓ tick is still showing.
    if (nextId && this.defs.has(nextId) && this.states.get(nextId) !== "completed") {
      this.states.set(nextId, "active");
      this.activeId = nextId;
    } else {
      this.activeId = null;
    }

    // Visual: brief ✓ on the just-finished objective, then reveal the next one
    // (or hide the HUD). A later complete() cancels this timer, so the HUD always
    // catches up to the newest objective rather than replaying a stale one.
    this.render(def.text, "completed");
    const holdMs = opts?.holdMs ?? 1000;
    this.completionTimer = window.setTimeout(() => {
      this.completionTimer = null;
      const nextDef = nextId ? this.defs.get(nextId) : undefined;
      if (nextDef && this.activeId === nextId && this.states.get(nextId) === "active") {
        this.render(nextDef.text, "active");
      } else if (!nextId && this.activeId === null) {
        this.clear();
      }
    }, holdMs);
  }

  /** The current active objective's text (for the inventory panel), or "". */
  activeText(): string {
    if (!this.activeId) return "";
    return this.defs.get(this.activeId)?.text ?? "";
  }

  /** Ad-hoc single-line objective (compatibility shim, no completion state). */
  setObjective(text: string): void {
    this.cancelTimer();
    this.activeId = null;
    this.render(text, "active");
  }

  clear(): void {
    this.cancelTimer();
    this.activeId = null;
    this.root.classList.remove("show", "complete");
    this.statusEl.textContent = "";
  }

  dispose(): void {
    this.cancelTimer();
    this.root.remove();
  }

  private render(text: string, state: "active" | "completed"): void {
    this.textEl.textContent = text;
    this.statusEl.textContent = state === "completed" ? "✓" : "";
    this.root.classList.toggle("complete", state === "completed");
    this.root.classList.add("show");
  }

  private cancelTimer(): void {
    if (this.completionTimer !== null) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
  }
}
