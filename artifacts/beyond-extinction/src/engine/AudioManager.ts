/**
 * Audio stub. Real sound design will be wired in later; for now it logs cues so
 * the narrative beats are traceable and the API is stable for scenes to call.
 */
export class AudioManager {
  private muted = false;
  private current: string | null = null;

  playMusic(track: string): void {
    this.current = track;
    if (!this.muted) console.info(`[Audio] music → ${track}`);
  }

  playSfx(name: string): void {
    if (!this.muted) console.info(`[Audio] sfx → ${name}`);
  }

  stopMusic(): void {
    if (this.current) console.info(`[Audio] stop music (${this.current})`);
    this.current = null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  dispose(): void {
    this.stopMusic();
  }
}
