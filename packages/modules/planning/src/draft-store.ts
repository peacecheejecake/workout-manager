import { createStore } from 'zustand/vanilla';
import {
  planDraftSchema,
  type PlanDraft,
  type PlanSnapshot,
  type ManualPlanCommand,
} from '@workout/contracts/planning';

interface DraftState {
  draft: PlanDraft | null;
  baseline: PlanSnapshot | null;
  undo: PlanDraft[];
  preview: ManualPlanCommand | null;
}
export interface PlanningDraftStore {
  state: DraftState;
  actions: {
    start(snapshot: PlanSnapshot | null, empty: PlanDraft): void;
    edit(update: (draft: PlanDraft) => PlanDraft): void;
    undo(): void;
    preview(): boolean;
    returnToEditing(): void;
    rebase(snapshot: PlanSnapshot | null): void;
    reset(): void;
  };
}
const initialState = (): DraftState => ({ draft: null, baseline: null, undo: [], preview: null });

/** Explicit editable fork, memory-only, scoped above responsive renderers. */
export function createPlanningDraftStore(createId: () => string = () => crypto.randomUUID()) {
  return createStore<PlanningDraftStore>()((set, get) => ({
    state: initialState(),
    actions: {
      start: (snapshot, empty) =>
        set({
          state: { draft: snapshot?.draft ?? empty, baseline: snapshot, undo: [], preview: null },
        }),
      edit: (update) =>
        set(({ state }) =>
          state.draft
            ? {
                state: {
                  ...state,
                  draft: update(state.draft),
                  undo: [...state.undo.slice(-49), state.draft],
                  preview: null,
                },
              }
            : {},
        ),
      undo: () =>
        set(({ state }) => {
          const previous = state.undo.at(-1);
          return previous
            ? { state: { ...state, draft: previous, undo: state.undo.slice(0, -1), preview: null } }
            : {};
        }),
      preview: () => {
        const { state } = get();
        const result = planDraftSchema.safeParse(state.draft);
        if (!result.success) return false;
        if (!state.preview)
          set({
            state: {
              ...state,
              preview: {
                source: 'manual',
                confirmed: true,
                expectedVersionId: state.baseline?.id ?? null,
                draft: result.data,
                idempotencyKey: createId(),
              },
            },
          });
        return true;
      },
      returnToEditing: () => set(({ state }) => ({ state: { ...state, preview: null } })),
      rebase: (baseline) => set(({ state }) => ({ state: { ...state, baseline, preview: null } })),
      reset: () => set({ state: initialState() }),
    },
  }));
}
