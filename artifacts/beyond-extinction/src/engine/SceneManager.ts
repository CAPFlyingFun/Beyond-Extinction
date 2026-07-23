import type { IScene, SceneContext, SceneFactory } from "./IScene";
import type { Overlays } from "./Overlays";

/**
 * Owns the active scene and handles transitions between scenes. Transitions
 * fade through black so swaps feel cinematic and asset loading is hidden.
 */
export class SceneManager {
  private ctx!: SceneContext;
  private overlays!: Overlays;
  private current: IScene | null = null;
  private transitioning = false;

  bind(ctx: SceneContext, overlays: Overlays): void {
    this.ctx = ctx;
    this.overlays = overlays;
  }

  get active(): IScene | null {
    return this.current;
  }

  async goTo(factory: SceneFactory, fade = true): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;

    try {
      if (fade && this.current) {
        await this.overlays.fadeToBlack(900);
      }

      this.current?.dispose();
      this.current = null;
      // Silence the outgoing scene's audio on EVERY transition. Scene dispose()
      // stops scene-owned 3D/DOM, but the AudioManager is global and some scenes
      // (e.g. the Main Menu) don't stop their own music — so without this the
      // previous track leaks across the swap. It only *sounded* clean because the
      // next scene's voice ducks the leftover bed; the menu theme would then swell
      // back once that voice ended. Stopping voice + music here guarantees the new
      // scene starts from silence, so only its own audio plays. SFX are one-shots.
      this.ctx.audio.stopVoice();
      this.ctx.audio.stopMusic();
      this.ctx.input.clearClickHandlers();
      this.ctx.input.setEnabled(true);
      this.ctx.quest.clear();
      this.ctx.overlays.hideHint();

      const next = factory(this.ctx);
      await next.enter();
      this.current = next;
      next.resize(this.ctx.renderer.width, this.ctx.renderer.height);

      if (fade) {
        await this.overlays.fadeFromBlack(900);
      }
    } catch (err) {
      console.error("[Beyond Extinction] Scene transition failed:", err);
      // Reveal whatever we can so the game isn't stuck behind a black screen.
      this.overlays.setBlackInstant(false);
    } finally {
      this.transitioning = false;
    }
  }

  update(dt: number, elapsed: number): void {
    this.current?.update(dt, elapsed);
  }

  resize(width: number, height: number): void {
    this.current?.resize(width, height);
  }
}
