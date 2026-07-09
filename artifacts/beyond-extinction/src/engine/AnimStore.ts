import * as THREE from "three";
import { assetUrl } from "./assets";

/**
 * AnimStore — persistence for the in-game Animation Editor. Custom clips are
 * authored as bone-quaternion keyframes, saved here, and recalled into the game.
 *
 * Like MarkerStore: BAKED defaults live in `public/editor/animations.json` (the
 * "Editor" folder), overlaid with LOCAL edits in localStorage. Export merges
 * both to the JSON committed to publish globally. Cloudflare-backed store later.
 *
 * Because every character shares the same `Bone_NNN` rig, a clip's tracks bind
 * by bone name to any character's mixer — so an edited clip named "Idle" or
 * "Walking" transparently overrides that character's baked locomotion (see
 * {@link applyTo}), which is what "modify any animation" means here.
 */

const LOCAL_KEY = "beyond-extinction.editor.anim.v1";
const BAKED_URL = assetUrl("editor/animations.json");

export interface SerTrack {
  /** Bone name the quaternion track targets (e.g. "Bone_025"). */
  bone: string;
  times: number[];
  /** Flat [x,y,z,w, ...] per keyframe time. */
  values: number[];
}
export interface SerClip {
  name: string;
  duration: number;
  tracks: SerTrack[];
}

type AnimBook = Record<string, SerClip>;

class AnimStoreImpl {
  private baked: AnimBook = {};
  private local: AnimBook = {};
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.local = this.readLocal();
    try {
      const res = await fetch(BAKED_URL, { cache: "no-cache" });
      if (res.ok) {
        const json = (await res.json()) as AnimBook;
        if (json && typeof json === "object") this.baked = json;
      }
    } catch {
      /* no baked file yet — local layer alone still works */
    }
  }

  /** All clip names (local overrides baked). */
  names(): string[] {
    return [...new Set([...Object.keys(this.baked), ...Object.keys(this.local)])];
  }

  get(name: string): SerClip | undefined {
    return this.local[name] ?? this.baked[name];
  }

  isLocal(name: string): boolean {
    return name in this.local;
  }

  save(clip: SerClip): void {
    this.local[clip.name] = clip;
    this.persist();
  }

  remove(name: string): void {
    delete this.local[name];
    this.persist();
  }

  exportJson(): string {
    const merged: AnimBook = { ...this.baked, ...this.local };
    return JSON.stringify(merged, null, 2);
  }

  /** Build a THREE clip from stored keyframes (tracks target bones by name). */
  toClip(ser: SerClip): THREE.AnimationClip {
    const tracks = ser.tracks.map(
      (t) => new THREE.QuaternionKeyframeTrack(`${t.bone}.quaternion`, t.times, t.values),
    );
    return new THREE.AnimationClip(ser.name, ser.duration, tracks);
  }

  /**
   * Overlay saved clips onto a character's baked clip list: replace same-named
   * clips and append brand-new ones. Returns a new array (originals untouched).
   * Called from character construction so edits reach the live game.
   */
  applyTo(animations: readonly THREE.AnimationClip[]): THREE.AnimationClip[] {
    const out = animations.slice();
    for (const name of this.names()) {
      const ser = this.get(name);
      if (!ser || ser.tracks.length === 0) continue;
      const clip = this.toClip(ser);
      const i = out.findIndex((c) => c.name === name);
      if (i >= 0) out[i] = clip;
      else out.push(clip);
    }
    return out;
  }

  private readLocal(): AnimBook {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return {};
      const book = JSON.parse(raw) as AnimBook;
      return book && typeof book === "object" ? book : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(this.local));
    } catch {
      /* storage unavailable — session-only */
    }
  }
}

/** Shared singleton (autoload-equivalent). */
export const AnimStore = new AnimStoreImpl();
