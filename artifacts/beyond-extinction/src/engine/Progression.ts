/**
 * Progression — campaign-wide unlocks, persisted to localStorage.
 *
 * The island (the real-scale Kauaʻi streaming map) is played chapter by chapter
 * inside a FIXED story grid. Once every chapter is finished, `unlimitedMode`
 * unlocks and the clamp is lifted — the whole island opens up as a free sandbox
 * (the "true ARK" mode).
 *
 * Module singleton (autoload-equivalent) so any scene can read the flags without
 * threading them through constructors.
 */

const KEY = "beyond-extinction.progression.v1";

interface ProgressionData {
  unlimitedMode: boolean;
  chaptersDone: string[];
}

class ProgressionStore {
  private data: ProgressionData = { unlimitedMode: false, chaptersDone: [] };

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ProgressionData>;
        this.data.unlimitedMode = !!parsed.unlimitedMode;
        this.data.chaptersDone = Array.isArray(parsed.chaptersDone) ? parsed.chaptersDone : [];
      }
    } catch {
      // no persisted progress yet
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // storage unavailable — progress just won't persist
    }
  }

  /** Open-sandbox unlocked (all chapters done, or dev override). */
  get unlimitedMode(): boolean {
    return this.data.unlimitedMode;
  }

  setUnlimited(on: boolean): void {
    this.data.unlimitedMode = on;
    this.save();
  }

  isChapterDone(id: string): boolean {
    return this.data.chaptersDone.includes(id);
  }

  /** Mark a chapter complete; auto-unlocks unlimited mode once `total` are done. */
  completeChapter(id: string, total: number): void {
    if (!this.data.chaptersDone.includes(id)) this.data.chaptersDone.push(id);
    if (this.data.chaptersDone.length >= total) this.data.unlimitedMode = true;
    this.save();
  }
}

export const Progression = new ProgressionStore();
