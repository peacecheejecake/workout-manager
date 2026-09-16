import { createStore } from 'zustand/vanilla';

export interface WorkspaceDraftState {
  state: { note: string };
  actions: { setNote(note: string): void; reset(): void };
}

/** Memory-only, one store per authenticated workspace lifetime. No server responses or tokens. */
export function createWorkspaceStore() {
  return createStore<WorkspaceDraftState>()((set) => ({
    state: { note: '' },
    actions: {
      setNote: (note) => set({ state: { note } }),
      reset: () => set({ state: { note: '' } }),
    },
  }));
}
