import { createStore } from 'zustand/vanilla';
import type { PlanDraft } from '@workout/contracts/planning';
import type { PlanScenario } from '@workout/contracts/plan-scenarios';
export type ScenarioPhase = 'idle' | 'preparing' | 'preview' | 'pending' | 'uncertain';
/** Private alternative editing state; no current-plan writes or persisted browser storage. */
export function createScenarioDraftStore() {
  return createStore<{
    phase: ScenarioPhase;
    setPhase(phase: ScenarioPhase): void;
    source: PlanScenario | null;
    draft: PlanDraft | null;
    undo: PlanDraft[];
    start(source: PlanScenario): void;
    edit(update: (draft: PlanDraft) => PlanDraft): void;
    undoEdit(): void;
    reset(): void;
    rebase(source: PlanScenario): void;
  }>((set) => ({
    phase: 'idle',
    setPhase: (phase) => set({ phase }),
    source: null,
    draft: null,
    undo: [],
    start: (source) => set({ source, draft: structuredClone(source.draft), undo: [] }),
    edit: (update) =>
      set((state) =>
        state.draft
          ? { draft: update(state.draft), undo: [...state.undo.slice(-49), state.draft] }
          : {},
      ),
    undoEdit: () =>
      set((state) => {
        const draft = state.undo.at(-1);
        return draft ? { draft, undo: state.undo.slice(0, -1) } : {};
      }),
    rebase: (source) => set({ source }),
    reset: () => set({ source: null, draft: null, undo: [] }),
  }));
}
export type ScenarioDraftStore = ReturnType<typeof createScenarioDraftStore>;
