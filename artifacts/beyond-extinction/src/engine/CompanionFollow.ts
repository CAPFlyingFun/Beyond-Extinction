import * as THREE from "three";
import { beachHeight } from "./beachTerrain";

/**
 * CompanionFollow — dead-simple follower AI for the inactive hero character
 * (Sarah trailing Jack in free roam). No pathfinding: she walks straight at
 * the player, riding the terrain, with hysteresis bands so she doesn't
 * flip-flop between idle/walk/run at the thresholds:
 *
 *   dist > START  → start walking      (stop again below STOP)
 *   dist > RUN    → break into a run   (back to walk below RUN_STOP)
 *   dist > LEASH  → teleport just behind the player (left hopelessly behind —
 *                   swimming, cliffs and story teleports all end this way)
 *
 * The scene stays the single owner of animation: update() returns
 * { moving, running } and the scene feeds that into applyLocomotion (idle↔walk
 * weight blend) plus a walk-action timeScale for the run. An optional
 * resolveMove hook lets the scene clamp her to the play area.
 */

const STOP_U = 8; // ~2.3 m — close enough, stand down
const START_U = 12; // ~3.4 m — start following
const RUN_U = 25; // ~7 m — falling behind, run
const RUN_STOP_U = 16; // back to a walk once nearly caught up
const LEASH_U = 120; // ~34 m — teleport to heel
const WALK_SPEED_U = 11.38; // 3.2 m/s, matches the player's walk
const RUN_SPEED_U = 20.5; // 5.8 m/s — a touch under Jack's 6.2 so gaps close gently
const TURN_RATE = 10; // rad/s exponential turn smoothing

export interface CompanionFlags {
  moving: boolean;
  running: boolean;
}

export class CompanionFollow {
  /** When false, update() is a no-op returning idle flags (cinematics). */
  enabled = false;

  private walking = false;
  private running = false;

  constructor(
    private readonly group: THREE.Group,
    /** Clamp a proposed step; return the allowed XZ (e.g. play-area fence). */
    private readonly resolveMove?: (nx: number, nz: number) => { x: number; z: number },
  ) {}

  update(dt: number, playerX: number, playerZ: number): CompanionFlags {
    if (!this.enabled || dt <= 0) {
      this.walking = false;
      this.running = false;
      return { moving: false, running: false };
    }

    const p = this.group.position;
    let dx = playerX - p.x;
    let dz = playerZ - p.z;
    let dist = Math.hypot(dx, dz);

    // Left hopelessly behind → teleport to just behind the player.
    if (dist > LEASH_U) {
      const nx = playerX - (dx / dist) * STOP_U;
      const nz = playerZ - (dz / dist) * STOP_U;
      p.set(nx, beachHeight(nx, nz), nz);
      dx = playerX - nx;
      dz = playerZ - nz;
      dist = Math.hypot(dx, dz);
      this.walking = false;
      this.running = false;
    }

    // Hysteresis bands.
    if (this.walking) {
      if (dist < STOP_U) this.walking = false;
    } else if (dist > START_U) {
      this.walking = true;
    }
    if (this.running) {
      if (dist < RUN_STOP_U) this.running = false;
    } else if (dist > RUN_U) {
      this.running = true;
    }
    if (!this.walking) this.running = false;

    if (this.walking && dist > 1e-3) {
      const speed = this.running ? RUN_SPEED_U : WALK_SPEED_U;
      // Never overshoot into the player's stop circle.
      const step = Math.min(speed * dt, Math.max(0, dist - STOP_U * 0.75));
      let nx = p.x + (dx / dist) * step;
      let nz = p.z + (dz / dist) * step;
      if (this.resolveMove) {
        const c = this.resolveMove(nx, nz);
        nx = c.x;
        nz = c.z;
      }
      p.set(nx, beachHeight(nx, nz), nz);

      // Face travel direction (model forward is +Z → yaw = atan2(dx, dz)),
      // smoothed exponentially so turns read as leaning in, not snapping.
      const targetYaw = Math.atan2(dx, dz);
      let delta = targetYaw - this.group.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.group.rotation.y += delta * Math.min(1, TURN_RATE * dt);
    }

    return { moving: this.walking, running: this.running };
  }
}
