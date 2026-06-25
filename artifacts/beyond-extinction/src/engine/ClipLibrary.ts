import * as THREE from "three";

/**
 * A name-keyed library of animation clips harvested from the project's
 * character GLBs.
 *
 * Beyond Extinction's characters (Jack, Sarah, ...) all export the *identical*
 * bone rig — same bone names, same hierarchy (see the model-pipeline memory).
 * Three.js binds an AnimationClip's tracks to a mixer's target nodes *by name*,
 * so a clip authored for one character drives any other character when handed
 * to that character's mixer. That lets a single rich clip set (Sarah's GLB
 * ships open_door_3, Collect_Object, Checkout_Gesture, ...) animate every
 * character, even ones whose own GLB carries only idle/walk.
 *
 * Clips are *root-motion sanitized* on registration. In these rigs the only
 * bone that carries animated translation is the Hips; every other bone's
 * position track is a constant bind-pose offset. A clip meant to walk up to a
 * door therefore bakes a huge horizontal Hips drift that would slide a standing
 * character across the room. We pin the Hips' horizontal (x/z) translation to
 * its first frame while keeping the vertical (y) channel, so gestures play in
 * place yet still crouch/bob naturally.
 */
export class ClipLibrary {
  private readonly clips = new Map<string, THREE.AnimationClip>();

  /**
   * Register every clip from a loaded model, sanitizing root motion. The first
   * registration of a given name wins; later duplicates (e.g. both Jack and
   * Sarah ship "Walking") are ignored so the union stays stable.
   */
  add(clips: readonly THREE.AnimationClip[] | undefined): void {
    if (!clips) return;
    for (const clip of clips) {
      if (!clip || this.clips.has(clip.name)) continue;
      this.clips.set(clip.name, ClipLibrary.sanitizeRootMotion(clip.clone()));
    }
  }

  has(name: string): boolean {
    return this.clips.has(name);
  }

  /** The sanitized clip for `name`, or undefined if it was never registered. */
  get(name: string): THREE.AnimationClip | undefined {
    return this.clips.get(name);
  }

  /** All registered clip names — handy for logging which gestures exist. */
  names(): string[] {
    return [...this.clips.keys()];
  }

  /**
   * Pin horizontal (x/z) translation on the root/Hips track to its first frame
   * so the clip plays without sliding the character, while leaving vertical
   * motion (crouch/bob) intact. Mutates and returns the given clip.
   */
  private static sanitizeRootMotion(
    clip: THREE.AnimationClip,
  ): THREE.AnimationClip {
    for (const track of clip.tracks) {
      // Translation tracks are named "<boneName>.position". Scale/rotation
      // tracks (".scale"/".quaternion") are left untouched.
      if (!track.name.endsWith(".position")) continue;
      const node = track.name.slice(0, -".position".length);
      // Only the root carries locomotion; matching hips/root/armature keeps
      // every other bone's bind-pose offset track intact (those define bone
      // lengths and must not be flattened).
      if (!/(^|[/])(hips|root|armature)$/i.test(node)) continue;
      const v = track.values;
      if (v.length < 3) continue;
      const x0 = v[0];
      const z0 = v[2];
      for (let i = 0; i < v.length; i += 3) {
        v[i] = x0; // x pinned to first frame
        v[i + 2] = z0; // z pinned to first frame
        // v[i + 1] (y) kept so a crouch / step-up still reads naturally.
      }
    }
    return clip;
  }
}
