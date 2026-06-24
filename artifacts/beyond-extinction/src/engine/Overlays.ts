/**
 * Cinematic full-screen overlays: fade-to-black, white flash, centered
 * captions, and an on-screen clock used in the prologue.
 */
export class Overlays {
  private fade: HTMLDivElement;
  private flash: HTMLDivElement;
  private caption: HTMLDivElement;
  private clock: HTMLDivElement;
  private hint: HTMLDivElement;
  private toast: HTMLDivElement;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private confirm: HTMLDivElement;
  private confirmText: HTMLDivElement;
  private confirmResolve: ((value: boolean) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.fade = this.make(parent, "be-fade");
    this.flash = this.make(parent, "be-flash");
    this.caption = this.make(parent, "be-caption");
    this.clock = this.make(parent, "be-clock");
    this.hint = this.make(parent, "be-hint");
    this.toast = this.make(parent, "be-toast");

    this.confirm = this.make(parent, "be-confirm");
    const panel = document.createElement("div");
    panel.className = "be-confirm__panel";
    this.confirmText = document.createElement("div");
    this.confirmText.className = "be-confirm__text";
    const actions = document.createElement("div");
    actions.className = "be-confirm__actions";
    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.className = "be-confirm__btn";
    noBtn.textContent = "No";
    noBtn.addEventListener("click", () => this.resolveConfirm(false));
    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.className = "be-confirm__btn be-confirm__btn--yes";
    yesBtn.textContent = "Yes";
    yesBtn.addEventListener("click", () => this.resolveConfirm(true));
    actions.append(noBtn, yesBtn);
    panel.append(this.confirmText, actions);
    this.confirm.appendChild(panel);
  }

  private make(parent: HTMLElement, cls: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = cls;
    parent.appendChild(el);
    return el;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async fadeToBlack(durationMs = 1000): Promise<void> {
    this.fade.style.transitionDuration = `${durationMs}ms`;
    this.fade.classList.add("show");
    await this.wait(durationMs);
  }

  async fadeFromBlack(durationMs = 1000): Promise<void> {
    this.fade.style.transitionDuration = `${durationMs}ms`;
    this.fade.classList.remove("show");
    await this.wait(durationMs);
  }

  setBlackInstant(on: boolean): void {
    this.fade.style.transitionDuration = "0ms";
    this.fade.classList.toggle("show", on);
  }

  async whiteFlash(): Promise<void> {
    this.flash.classList.remove("be-flash--anim");
    // Force reflow so the animation restarts.
    void this.flash.offsetWidth;
    this.flash.classList.add("be-flash--anim");
    await this.wait(1400);
  }

  async showCaption(text: string, holdMs = 2600): Promise<void> {
    this.caption.textContent = text;
    this.caption.classList.add("show");
    await this.wait(holdMs);
    this.caption.classList.remove("show");
    await this.wait(1000);
  }

  showClock(time: string, alarm = false): void {
    this.clock.textContent = time;
    this.clock.classList.add("show");
    this.clock.classList.toggle("alarm", alarm);
  }

  hideClock(): void {
    this.clock.classList.remove("show");
  }

  showHint(text: string): void {
    this.hint.textContent = text;
    this.hint.classList.add("show");
  }

  hideHint(): void {
    this.hint.classList.remove("show");
  }

  showToast(text: string, holdMs = 2200): void {
    this.toast.textContent = text;
    this.toast.classList.add("show");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.classList.remove("show");
    }, holdMs);
  }

  /** Shows a Yes/No prompt and resolves once the player picks one. */
  showConfirm(message: string): Promise<boolean> {
    this.confirmText.textContent = message;
    this.confirm.classList.add("show");
    return new Promise((resolve) => {
      this.confirmResolve = resolve;
    });
  }

  private resolveConfirm(value: boolean): void {
    this.confirm.classList.remove("show");
    const resolve = this.confirmResolve;
    this.confirmResolve = null;
    resolve?.(value);
  }

  dispose(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.resolveConfirm(false);
    [
      this.fade,
      this.flash,
      this.caption,
      this.clock,
      this.hint,
      this.toast,
      this.confirm,
    ].forEach((e) => e.remove());
  }
}
