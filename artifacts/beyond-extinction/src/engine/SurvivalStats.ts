import { PlayerInventory } from "./PlayerInventory";

/**
 * SurvivalStats — the island's ARK-style survival model, feeding the hybrid
 * HUD (vitals column, stamina/water bars, temperature readout, day/time
 * counter). One instance per island scene; session-only in v1 (a fresh scene
 * enter starts a fresh day — persistence can join the island save later).
 *
 * All stats are 0..100. Weight is derived live from PlayerInventory. The game
 * clock runs at one game minute per real second (a full day = 24 real
 * minutes), starting Day 1, 06:00 — matching the dawn arrival.
 */

export interface SurvivalFlags {
  /** The player moved this frame. */
  moving: boolean;
  /** Run is engaged (Shift / mobile toggle) AND moving. */
  running: boolean;
  /** Crouched ("rest" — fastest stamina regen while stationary). */
  crouching: boolean;
  /** Crawling (prone). */
  crawling: boolean;
  /** A jump was launched this frame (one-shot cost). */
  jumped: boolean;
}

export interface SurvivalSnapshot {
  health: number;
  stamina: number;
  food: number;
  water: number;
  /** Carried weight in kg. */
  weight: number;
  maxWeight: number;
  /** Ambient temperature, °C (time-of-day curve). */
  temperature: number;
  /** Day counter, starting at 1. */
  day: number;
  /** Minutes into the day, 0..1439 (e.g. 372 = 06:12). */
  timeMin: number;
  /** "06:12" — for the HUD. */
  clock: string;
}

// Per-item carry weight, kg. Unknown items fall back to 1 kg.
const ITEM_KG: Record<string, number> = {
  coffee: 0.4,
  flashlight: 0.6,
  berries: 0.3,
};
const BADGE_KG = 0.2;
const MAX_WEIGHT_KG = 50;

// Drain/regen rates, points per second.
const STAMINA_RUN_DRAIN = 6;
const STAMINA_JUMP_COST = 8;
const STAMINA_REGEN_IDLE = 8;
const STAMINA_REGEN_REST = 14; // crouched + stationary ("rest")
const STAMINA_REGEN_WALK = 4;
// Seconds after the last sprint/jump frame before stamina starts recovering.
const STAMINA_REGEN_DELAY = 1.2;
const FOOD_DRAIN = 0.07; // ~24 real minutes from full to empty
const WATER_DRAIN = 0.11; // thirst bites first, like ARK
const EXERTION_MULT = 1.6; // food/water drain faster while running
const HEALTH_DRAIN_STARVING = 0.8; // food OR water at 0
const HEALTH_REGEN = 0.9; // fed + hydrated

const DAY_START_MIN = 6 * 60; // Day 1 begins at 06:00
const GAME_MIN_PER_SEC = 1;

type Listener = (s: SurvivalSnapshot) => void;

export class SurvivalStats {
  health = 100;
  stamina = 100;
  /** Countdown before stamina may regen again (set while sprinting/jumping). */
  private regenCd = 0;
  food = 100;
  water = 100;

  private day = 1;
  private timeMin = DAY_START_MIN;
  private paused = false;
  private dead = false;
  private listeners = new Set<Listener>();
  private notifyAcc = 0;

  /** Fired once when health first reaches 0 (the scene handles death/respawn). */
  onDeath?: () => void;

  /** Freeze all drains/clock (cinematics, menus). */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * Take combat damage (e.g. a creature bite). Clamps health at 0 and fires
   * {@link onDeath} exactly once. No-op while paused or already dead.
   */
  takeDamage(amount: number): void {
    if (this.paused || this.dead || amount <= 0) return;
    this.health = clamp(this.health - amount);
    this.notify();
    if (this.health <= 0 && !this.dead) {
      this.dead = true;
      this.onDeath?.();
    }
  }

  /** Restore to full and clear the death latch (used by respawn). */
  revive(): void {
    this.dead = false;
    this.health = 100;
    this.stamina = 100;
    this.food = Math.max(this.food, 40);
    this.water = Math.max(this.water, 40);
    this.notify();
  }

  isDead(): boolean {
    return this.dead;
  }

  /** Quick-use: eat (hotbar). Returns false if already full. */
  eat(points = 30): boolean {
    if (this.food >= 99.5) return false;
    this.food = clamp(this.food + points);
    this.notify();
    return true;
  }

  /** Quick-use: drink (hotbar / stream later). Returns false if already full. */
  drink(points = 35): boolean {
    if (this.water >= 99.5) return false;
    this.water = clamp(this.water + points);
    this.notify();
    return true;
  }

  /** Carried weight right now, kg — derived from the shared inventory. */
  weightKg(): number {
    let kg = PlayerInventory.hasBadge ? BADGE_KG : 0;
    for (const item of PlayerInventory.heldItems) kg += ITEM_KG[item] ?? 1;
    return Math.round(kg * 10) / 10;
  }

  /** Ambient °C from the time of day: ~22° pre-dawn low, ~33° mid-afternoon. */
  temperature(): number {
    const h = this.timeMin / 60;
    // Sine day-curve peaking at 14:00, trough at 02:00.
    const t = 27.5 + 5.5 * Math.sin(((h - 8) / 24) * Math.PI * 2);
    return Math.round(t);
  }

  update(dt: number, flags: SurvivalFlags): void {
    if (this.paused || dt <= 0) return;

    // Clock.
    this.timeMin += dt * GAME_MIN_PER_SEC;
    while (this.timeMin >= 1440) {
      this.timeMin -= 1440;
      this.day += 1;
    }

    // Stamina. Draining (sprint/jump) blocks regen for a short "catch your
    // breath" delay so a sustained sprint actually empties the bar to 0 instead
    // of the fast idle regen topping it back up the instant you slow down.
    if (flags.jumped) {
      this.stamina = clamp(this.stamina - STAMINA_JUMP_COST);
      this.regenCd = STAMINA_REGEN_DELAY;
    }
    if (flags.running) {
      this.stamina = clamp(this.stamina - STAMINA_RUN_DRAIN * dt);
      this.regenCd = STAMINA_REGEN_DELAY;
    } else {
      this.regenCd = Math.max(0, this.regenCd - dt);
      if (this.regenCd <= 0) {
        const rate =
          !flags.moving && (flags.crouching || flags.crawling)
            ? STAMINA_REGEN_REST
            : !flags.moving
              ? STAMINA_REGEN_IDLE
              : STAMINA_REGEN_WALK;
        this.stamina = clamp(this.stamina + rate * dt);
      }
    }

    // Hunger / thirst.
    const exert = flags.running ? EXERTION_MULT : 1;
    this.food = clamp(this.food - FOOD_DRAIN * exert * dt);
    this.water = clamp(this.water - WATER_DRAIN * exert * dt);

    // Health.
    if (this.food <= 0 || this.water <= 0) {
      this.health = clamp(this.health - HEALTH_DRAIN_STARVING * dt);
    } else if (this.food > 25 && this.water > 25) {
      this.health = clamp(this.health + HEALTH_REGEN * dt);
    }

    // Throttled notify (~5 Hz) — bars animate via CSS transitions between ticks.
    this.notifyAcc += dt;
    if (this.notifyAcc >= 0.2) {
      this.notifyAcc = 0;
      this.notify();
    }
  }

  snapshot(): SurvivalSnapshot {
    const mins = Math.floor(this.timeMin);
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    return {
      health: this.health,
      stamina: this.stamina,
      food: this.food,
      water: this.water,
      weight: this.weightKg(),
      maxWeight: MAX_WEIGHT_KG,
      temperature: this.temperature(),
      day: this.day,
      timeMin: this.timeMin,
      clock: `${hh}:${mm}`,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
  }

  private notify(): void {
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
  }
}

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}
