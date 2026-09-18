import { createStore } from 'zustand/vanilla';
import type { SetLogValues } from '@workout/contracts/supplementary-core';

export type SetDraft = {
  exerciseVersionId: string;
  targetSetId: string | null;
  blockId: string | null;
  roundIndex: string;
  side: SetLogValues['side'];
  state: SetLogValues['state'];
  count: string;
  duration: string;
  resistance: string;
  resistanceKind: 'unknown' | 'no_added_load' | 'external' | 'assisted';
  rpe: string;
  rir: string;
  reason: string;
};

const blank: SetDraft = {
  exerciseVersionId: '',
  targetSetId: null,
  blockId: null,
  roundIndex: '',
  side: 'bilateral',
  state: 'unconfirmed',
  count: '',
  duration: '',
  resistance: '',
  resistanceKind: 'unknown',
  rpe: '',
  rir: '',
  reason: '',
};

/** Created once per authenticated runner lifetime; no module singleton or private persistence. */
export function createRunnerStore() {
  return createStore<{
    draft: SetDraft;
    correcting: { logId: string; revision: number; occurredAt: string } | null;
    timerId: string | null;
    pendingKey: string | null;
    actions: {
      change<K extends keyof SetDraft>(key: K, value: SetDraft[K]): void;
      selectTarget(
        exerciseVersionId: string,
        targetSetId: string | null,
        blockId: string | null,
      ): void;
      correct(logId: string, revision: number, occurredAt: string, draft: SetDraft): void;
      setTimerId(timerId: string | null): void;
      setPendingKey(key: string | null): void;
      reset(): void;
    };
  }>((set) => ({
    draft: blank,
    correcting: null,
    timerId: null,
    pendingKey: null,
    actions: {
      change: (key, value) => set((state) => ({ draft: { ...state.draft, [key]: value } })),
      selectTarget: (exerciseVersionId, targetSetId, blockId) =>
        set({
          draft: { ...blank, exerciseVersionId, targetSetId, blockId },
          correcting: null,
          pendingKey: null,
        }),
      correct: (logId, revision, occurredAt, draft) =>
        set({ draft, correcting: { logId, revision, occurredAt }, pendingKey: null }),
      setTimerId: (timerId) => set({ timerId }),
      setPendingKey: (pendingKey) => set({ pendingKey }),
      reset: () => set({ draft: blank, correcting: null, pendingKey: null }),
    },
  }));
}
