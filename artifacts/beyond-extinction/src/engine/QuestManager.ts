/**
 * Minimal HUD objective tracker shown in the top-left corner.
 */
export class QuestManager {
  private root: HTMLDivElement;
  private textEl: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "be-quest";
    this.root.innerHTML = `
      <div class="be-quest__label">Objective</div>
      <div class="be-quest__text"></div>`;
    parent.appendChild(this.root);
    this.textEl = this.root.querySelector(".be-quest__text")!;
  }

  setObjective(text: string): void {
    this.textEl.textContent = text;
    this.root.classList.add("show");
  }

  clear(): void {
    this.root.classList.remove("show");
  }

  dispose(): void {
    this.root.remove();
  }
}
