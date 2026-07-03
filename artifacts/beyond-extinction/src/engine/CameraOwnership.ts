/**
 * Who is allowed to write the camera this frame.
 * - `cinematic`: a CameraDirector zone drives the camera (establishing shots, etc.).
 * - `player`:    the PlayerController drives the camera (first-person gameplay).
 * - `sequence`:  a scripted SequenceDirector moment owns the camera (cutscenes).
 *
 * Exactly one owner is current at a time. Phase 1 uses this as a simple flag so
 * the scene's per-frame update knows which system to run; later phases extend it
 * with claim/release + blended hand-offs.
 */
export type CameraOwner = "cinematic" | "player" | "sequence";

export class CameraOwnership {
  private owner: CameraOwner;
  private readonly listeners = new Set<(owner: CameraOwner) => void>();

  constructor(initial: CameraOwner = "cinematic") {
    this.owner = initial;
  }

  get current(): CameraOwner {
    return this.owner;
  }

  is(owner: CameraOwner): boolean {
    return this.owner === owner;
  }

  set(owner: CameraOwner): void {
    if (owner === this.owner) return;
    this.owner = owner;
    this.listeners.forEach((l) => l(owner));
  }

  onChange(cb: (owner: CameraOwner) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
