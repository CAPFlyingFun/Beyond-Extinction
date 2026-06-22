import { assetUrl } from "./assets";

export interface DialogueLine {
  speaker: string;
  /** Relative portrait path, e.g. "assets/portraits/Jack.PNG". */
  portrait?: string;
  text: string;
}

/**
 * HTML/CSS portrait dialogue overlay. Plays a sequence of lines with a
 * typewriter effect; advances on click or space, resolves when finished.
 */
export class DialogueManager {
  private root: HTMLDivElement;
  private portraitEl: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private textEl: HTMLDivElement;
  private active = false;

  private resolveSeq: (() => void) | null = null;
  private queue: DialogueLine[] = [];
  private index = 0;
  private typing = false;
  private fullText = "";
  private typeTimer: number | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "be-dialogue";
    this.root.innerHTML = `
      <div class="be-dialogue__portrait"></div>
      <div class="be-dialogue__box">
        <div class="be-dialogue__name"></div>
        <div class="be-dialogue__text"></div>
        <div class="be-dialogue__hint">Click or press Space to continue</div>
      </div>`;
    parent.appendChild(this.root);
    this.portraitEl = this.root.querySelector(".be-dialogue__portrait")!;
    this.nameEl = this.root.querySelector(".be-dialogue__name")!;
    this.textEl = this.root.querySelector(".be-dialogue__text")!;

    this.root.addEventListener("click", () => this.advance());
    window.addEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      this.advance();
    }
  };

  get isActive(): boolean {
    return this.active;
  }

  play(lines: DialogueLine[]): Promise<void> {
    this.queue = lines;
    this.index = 0;
    this.active = true;
    this.root.classList.add("show");
    return new Promise((resolve) => {
      this.resolveSeq = resolve;
      this.showLine(this.queue[0]);
    });
  }

  private showLine(line: DialogueLine): void {
    this.nameEl.textContent = line.speaker;
    if (line.portrait) {
      this.portraitEl.style.backgroundImage = `url("${assetUrl(line.portrait)}")`;
      this.portraitEl.style.display = "block";
    } else {
      this.portraitEl.style.display = "none";
    }
    this.startTyping(line.text);
  }

  private startTyping(text: string): void {
    this.fullText = text;
    this.typing = true;
    let i = 0;
    this.textEl.textContent = "";
    if (this.typeTimer) window.clearInterval(this.typeTimer);
    this.typeTimer = window.setInterval(() => {
      i++;
      this.textEl.textContent = text.slice(0, i);
      if (i >= text.length) {
        this.typing = false;
        if (this.typeTimer) window.clearInterval(this.typeTimer);
        this.typeTimer = null;
      }
    }, 22);
  }

  private advance(): void {
    if (!this.active) return;
    if (this.typing) {
      // Finish the current line instantly.
      if (this.typeTimer) window.clearInterval(this.typeTimer);
      this.typeTimer = null;
      this.typing = false;
      this.textEl.textContent = this.fullText;
      return;
    }
    this.index++;
    if (this.index >= this.queue.length) {
      this.finish();
    } else {
      this.showLine(this.queue[this.index]);
    }
  }

  private finish(): void {
    this.active = false;
    this.root.classList.remove("show");
    const resolve = this.resolveSeq;
    this.resolveSeq = null;
    resolve?.();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
    if (this.typeTimer) window.clearInterval(this.typeTimer);
    this.root.remove();
  }
}
