/**
 * DevAccess — a tiny bridge so any UI (e.g. the inventory's DEV tab) can open
 * the PIN-gated Dev menu without holding a reference to the DevPortal. The Game
 * wires `open` to the portal's PIN prompt at startup; callers just fire
 * {@link request}. Kept as a module singleton (autoload-equivalent) so it needs
 * no threading through constructors.
 */
class DevAccessImpl {
  /** Set by Game to the DevPortal's PIN prompt. */
  open?: () => void;

  /** Open the PIN gate (no-op until Game wires `open`). */
  request(): void {
    this.open?.();
  }
}

export const DevAccess = new DevAccessImpl();
