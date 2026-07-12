import { registerHudElement } from "./HudEditor";

export type ObjectiveState = "inactive" | "active" | "completed";

export interface ObjectiveDef {
  id: string;
  text: string;
  /** Optional progress target (e.g. gather 25) — drives the tracker's bar. */
  target?: number;
}

/** One objective's tracker-facing state (see subscribe). */
export interface TrackedObjective {
  id: string;
  text: string;
  state: ObjectiveState;
  /** Current progress toward `target` (only when the def has a target). */
  progress?: number;
  target?: number;
  /** 0..100. Progress-based when a target exists, else 0/100 by state. */
  percent: number;
}

type TrackerListener = (objectives: TrackedObjective[]) => void;

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
  private progress = new Map<string, number>();
  private activeId: string | null = null;
  private completionTimer: number | null = null;
  private unregHud: () => void;
  // PoT-style quest tracker support: listeners get the full objective list on
  // every change; the island hides the single-line card in favour of the
  // tracker while the prologue keeps the card as-is.
  private trackerListeners = new Set<TrackerListener>();
  private cardVisible = true;
  private adHocText: string | null = null;

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
    this.unregHud = registerHudElement("quest", this.root);
  }

  /** Register the ordered objective definitions for a scene. */
  configure(defs: readonly ObjectiveDef[]): void {
    // Reset any in-flight tick/HUD so a reconfigure mid-scene can't leave a
    // stale completion timer pointing at the previous objective set.
    this.clear();
    this.defs.clear();
    this.states.clear();
    this.progress.clear();
    for (const def of defs) {
      this.defs.set(def.id, def);
      this.states.set(def.id, "inactive");
      if (def.target !== undefined) this.progress.set(def.id, 0);
    }
    this.emitTracker();
  }

  /** Show a registered objective as the current active goal. */
  activate(id: string): void {
    const def = this.defs.get(id);
    if (!def) return;
    this.cancelTimer();
    this.states.set(id, "active");
    this.activeId = id;
    this.render(def.text, "active");
    this.emitTracker();
  }

  /**
   * Report progress toward an objective's target (e.g. gathered 7 of 25).
   * Clamped to 0..target. No auto-complete — the scene decides when the beat
   * is done and calls complete(), same as before.
   */
  setProgress(id: string, current: number): void {
    const def = this.defs.get(id);
    if (!def || def.target === undefined) return;
    const next = Math.min(def.target, Math.max(0, current));
    if (this.progress.get(id) === next) return;
    this.progress.set(id, next);
    this.emitTracker();
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

    // A completed objective with a target reads as fully done in the tracker.
    if (def.target !== undefined) this.progress.set(id, def.target);
    this.emitTracker();

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
    this.adHocText = text;
    this.render(text, "active");
    this.emitTracker();
  }

  clear(): void {
    this.cancelTimer();
    this.activeId = null;
    this.adHocText = null;
    this.root.classList.remove("show", "complete");
    this.statusEl.textContent = "";
    this.emitTracker();
  }

  /**
   * Show/hide the single-line objective card. The island turns the card OFF
   * (its PoT tracker panel renders the same objectives); the prologue never
   * calls this so its card behaviour is untouched. Restoring visibility
   * re-shows the card if an objective is live.
   */
  setCardVisible(visible: boolean): void {
    if (this.cardVisible === visible) return;
    this.cardVisible = visible;
    if (!visible) {
      this.root.classList.remove("show");
    } else {
      const text =
        this.adHocText ??
        (this.activeId ? this.defs.get(this.activeId)?.text : undefined);
      if (text) this.render(text, "active");
    }
  }

  /**
   * Tracker feed: called immediately with the current objective list and on
   * every change (activate/progress/complete/clear/ad-hoc). Ad-hoc objectives
   * from setObjective appear as a synthetic entry so the island tracker shows
   * story beats driven through the shim too.
   */
  subscribe(listener: TrackerListener): () => void {
    this.trackerListeners.add(listener);
    listener(this.trackedList());
    return () => {
      this.trackerListeners.delete(listener);
    };
  }

  dispose(): void {
    this.cancelTimer();
    this.trackerListeners.clear();
    this.unregHud();
    this.root.remove();
  }

  private trackedList(): TrackedObjective[] {
    const out: TrackedObjective[] = [];
    for (const def of this.defs.values()) {
      const state = this.states.get(def.id) ?? "inactive";
      if (state === "inactive") continue;
      const progress =
        def.target !== undefined ? this.progress.get(def.id) ?? 0 : undefined;
      const percent =
        state === "completed"
          ? 100
          : def.target !== undefined
            ? Math.round(((progress ?? 0) / def.target) * 100)
            : 0;
      out.push({ id: def.id, text: def.text, state, progress, target: def.target, percent });
    }
    if (this.adHocText) {
      out.push({ id: "__adhoc", text: this.adHocText, state: "active", percent: 0 });
    }
    return out;
  }

  private emitTracker(): void {
    if (this.trackerListeners.size === 0) return;
    const list = this.trackedList();
    for (const l of this.trackerListeners) l(list);
  }

  private render(text: string, state: "active" | "completed"): void {
    this.textEl.textContent = text;
    this.statusEl.textContent = state === "completed" ? "✓" : "";
    this.root.classList.toggle("complete", state === "completed");
    if (this.cardVisible) this.root.classList.add("show");
  }

  private cancelTimer(): void {
    if (this.completionTimer !== null) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
  }
}
