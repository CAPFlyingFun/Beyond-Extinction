import { VOICE_CLIPS } from "../data/voiceClips";

/**
 * A data-driven cutscene timeline. A scene authors a flat, ordered list of
 * {@link TimelineStep}s describing a story beat — voice lines, synced subtitles,
 * camera framings, character gestures, dramatic pauses, and player-interaction
 * gates — and the {@link SequenceDirector} plays them by awaiting each step in
 * turn (or running a group concurrently via a `parallel` step).
 *
 * The director owns no engine state of its own: every effect is delegated to a
 * {@link SequenceContext} of closures the scene provides, so the existing Phase
 * machine, CameraDirector, AudioManager, DialogueManager, and interaction
 * handlers stay authoritative. This keeps the cutscene layer purely additive.
 */
export type TimelineStep =
  /** Play a voice clip AND show its manifest subtitle, await the audio. */
  | { kind: "say"; clip: string }
  /** Play a voice clip with no subtitle, await the audio. */
  | { kind: "voice"; clip: string }
  /** Show a caption directly (used for non-voiced beats); optional hold. */
  | {
      kind: "subtitle";
      speaker?: string;
      text: string;
      narration?: boolean;
      holdMs?: number;
    }
  /** Hide the caption. */
  | { kind: "clearSubtitle" }
  /** Move to a named scripted camera framing; `cut` for a hard cut. */
  | { kind: "camera"; moment: string; cut?: boolean }
  /** Release the scripted framing back to the scene's own camera zones. */
  | { kind: "clearCamera" }
  /** Play a character gesture; fire-and-forget unless `await` is set. */
  | {
      kind: "gesture";
      actor: string;
      clip: string;
      fade?: number;
      hold?: boolean;
      await?: boolean;
    }
  /** Dramatic pause. */
  | { kind: "wait"; ms: number }
  /** Block until the player completes a named interaction objective. */
  | { kind: "interaction"; id: string; objective?: string | null }
  /**
   * Present a genuine branching choice and run the chosen option's sub-timeline.
   * NEVER auto-resolved — Auto Play deliberately stops here so the player always
   * owns real story decisions.
   */
  | {
      kind: "choice";
      prompt: string;
      objective?: string | null;
      options: { id: string; label: string; steps: TimelineStep[] }[];
    }
  /** Run several steps concurrently; resolves on all (default) or the first. */
  | { kind: "parallel"; steps: TimelineStep[]; await?: "all" | "first" };

export interface SequenceContext {
  playVoice(clipId: string): Promise<void>;
  showSubtitle(opts: { speaker?: string; text: string; narration?: boolean }): void;
  hideSubtitle(): void;
  setCameraMoment(moment: string, opts?: { cut?: boolean }): void;
  clearCameraMoment(): void;
  playGesture(
    actor: string,
    clip: string,
    opts?: { fade?: number; hold?: boolean },
  ): Promise<void>;
  /** Update the on-screen objective text (null clears it). */
  setObjective(text: string | null): void;
  /** Resolve when the player completes the given interaction objective. */
  waitForInteraction(id: string): Promise<void>;
  /**
   * Present a branching choice and resolve with the chosen option id. The scene
   * backs this with real player input (e.g. an on-screen prompt); it is never
   * auto-resolved, even under Auto Play.
   */
  chooseOption(
    prompt: string,
    options: { id: string; label: string }[],
  ): Promise<string>;
}

export class SequenceDirector {
  private cancelled = false;
  private waiters = new Set<() => void>();

  constructor(private readonly ctx: SequenceContext) {}

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Cancel any in-flight sequence. Pending waits and player-input gates
   * (interaction, choice) resolve immediately via `waiters`; awaited media
   * promises (voice, gesture) are expected to settle when the scene tears their
   * subsystems down on dispose, so play() unwinds cleanly.
   */
  cancel(): void {
    this.cancelled = true;
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }

  async play(steps: TimelineStep[]): Promise<void> {
    for (const step of steps) {
      if (this.cancelled) break;
      await this.runStep(step);
    }
    if (!this.cancelled) this.ctx.hideSubtitle();
  }

  private async runStep(step: TimelineStep): Promise<void> {
    if (this.cancelled) return;
    switch (step.kind) {
      case "say": {
        const clip = VOICE_CLIPS[step.clip];
        if (clip) {
          this.ctx.showSubtitle({
            speaker: clip.speaker,
            text: clip.text,
            narration: clip.narration,
          });
        }
        await this.ctx.playVoice(step.clip);
        break;
      }
      case "voice":
        await this.ctx.playVoice(step.clip);
        break;
      case "subtitle":
        this.ctx.showSubtitle({
          speaker: step.speaker,
          text: step.text,
          narration: step.narration,
        });
        if (step.holdMs) await this.waitMs(step.holdMs);
        break;
      case "clearSubtitle":
        this.ctx.hideSubtitle();
        break;
      case "camera":
        this.ctx.setCameraMoment(step.moment, { cut: step.cut });
        break;
      case "clearCamera":
        this.ctx.clearCameraMoment();
        break;
      case "gesture": {
        const p = this.ctx.playGesture(step.actor, step.clip, {
          fade: step.fade,
          hold: step.hold,
        });
        if (step.await) await p;
        else void p.catch(() => {});
        break;
      }
      case "wait":
        await this.waitMs(step.ms);
        break;
      case "interaction":
        if (step.objective !== undefined) this.ctx.setObjective(step.objective);
        await this.gate(() => this.ctx.waitForInteraction(step.id));
        if (step.objective !== undefined) this.ctx.setObjective(null);
        break;
      case "choice": {
        if (step.objective !== undefined) this.ctx.setObjective(step.objective);
        const chosen = await this.gate(() =>
          this.ctx.chooseOption(
            step.prompt,
            step.options.map((o) => ({ id: o.id, label: o.label })),
          ),
        );
        if (step.objective !== undefined) this.ctx.setObjective(null);
        if (this.cancelled || chosen == null) break;
        const opt = step.options.find((o) => o.id === chosen) ?? step.options[0];
        if (opt) {
          for (const s of opt.steps) {
            if (this.cancelled) break;
            await this.runStep(s);
          }
        }
        break;
      }
      case "parallel": {
        const ps = step.steps.map((s) => this.runStep(s));
        if (step.await === "first") await Promise.race(ps);
        else await Promise.all(ps);
        break;
      }
    }
  }

  /**
   * Await a player-input gate (interaction or choice) so that cancel() unblocks
   * it immediately: the adapter promise is raced against a canceller registered
   * in `waiters`, so leaving the scene mid-gate never hangs play(). Returns the
   * adapter's value, or undefined if cancelled first.
   */
  private gate<T>(start: () => Promise<T>): Promise<T | undefined> {
    if (this.cancelled) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve) => {
      let done = false;
      const finish = (value: T | undefined) => {
        if (done) return;
        done = true;
        this.waiters.delete(onCancel);
        resolve(value);
      };
      const onCancel = () => finish(undefined);
      this.waiters.add(onCancel);
      start().then(
        (v) => finish(v),
        () => finish(undefined),
      );
    });
  }

  private waitMs(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.cancelled) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(finish);
    });
  }
}
