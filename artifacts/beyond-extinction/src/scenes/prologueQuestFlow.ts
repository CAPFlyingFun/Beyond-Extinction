export type PrologueQuestStep =
  | "coffee-1"
  | "coffee-2"
  | "reach-lab"
  | "knock"
  | "find-badge"
  | "scan-badge"
  | "reach-sarah"
  | "complete";

export interface PrologueQuestState {
  readonly step: PrologueQuestStep;
  readonly coffeeCount: 0 | 1 | 2;
  readonly hasBadge: boolean;
  readonly readerEnabled: boolean;
}

export type PrologueQuestEvent =
  | { readonly type: "TAKE_COFFEE"; readonly index: 0 | 1 }
  | { readonly type: "USE_READER" }
  | { readonly type: "KNOCK" }
  | { readonly type: "TAKE_BADGE" }
  | { readonly type: "BADGE_LINE_FINISHED" }
  | { readonly type: "REACH_SARAH" };

export type PrologueQuestPhase =
  | "coffee"
  | "to-glass"
  | "knock"
  | "to-badge"
  | "to-sarah"
  | "accident";

export function initialPrologueQuestState(): PrologueQuestState {
  return {
    step: "coffee-1",
    coffeeCount: 0,
    hasBadge: false,
    readerEnabled: false,
  };
}

export function prologueQuestStateForResume(
  phase: "coffee" | "to-glass" | "to-badge" | "to-sarah",
): PrologueQuestState {
  switch (phase) {
    case "coffee":
      return initialPrologueQuestState();
    case "to-glass":
      return {
        step: "reach-lab",
        coffeeCount: 2,
        hasBadge: false,
        readerEnabled: true,
      };
    case "to-badge":
      return {
        step: "find-badge",
        coffeeCount: 2,
        hasBadge: false,
        readerEnabled: false,
      };
    case "to-sarah":
      return {
        step: "reach-sarah",
        coffeeCount: 2,
        hasBadge: true,
        readerEnabled: true,
      };
  }
}

export function advancePrologueQuest(
  state: PrologueQuestState,
  event: PrologueQuestEvent,
): PrologueQuestState {
  switch (event.type) {
    case "TAKE_COFFEE":
      if (state.step === "coffee-1" && event.index === 0) {
        return { ...state, step: "coffee-2", coffeeCount: 1 };
      }
      if (state.step === "coffee-2" && event.index === 1) {
        return { ...state, step: "reach-lab", coffeeCount: 2 };
      }
      return state;
    case "USE_READER":
      if (state.step === "reach-lab") return { ...state, step: "knock" };
      if (
        state.step === "scan-badge" &&
        state.hasBadge &&
        state.readerEnabled
      ) {
        return { ...state, step: "reach-sarah" };
      }
      return state;
    case "KNOCK":
      return state.step === "knock" ? { ...state, step: "find-badge" } : state;
    case "TAKE_BADGE":
      return state.step === "find-badge"
        ? { ...state, step: "scan-badge", hasBadge: true, readerEnabled: false }
        : state;
    case "BADGE_LINE_FINISHED":
      return state.step === "scan-badge" &&
        state.hasBadge &&
        !state.readerEnabled
        ? { ...state, readerEnabled: true }
        : state;
    case "REACH_SARAH":
      return state.step === "reach-sarah"
        ? { ...state, step: "complete" }
        : state;
  }
}

export function prologuePhaseFor(
  state: PrologueQuestState,
): PrologueQuestPhase {
  switch (state.step) {
    case "coffee-1":
    case "coffee-2":
      return "coffee";
    case "reach-lab":
      return "to-glass";
    case "knock":
      return "knock";
    case "find-badge":
      return "to-badge";
    case "scan-badge":
      return state.readerEnabled ? "to-glass" : "to-badge";
    case "reach-sarah":
      return "to-sarah";
    case "complete":
      return "accident";
  }
}
