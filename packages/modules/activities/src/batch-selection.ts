import { createStore } from 'zustand/vanilla';
import type { Activity } from '@workout/contracts/activity';

export type BatchTarget = {
  id: string;
  revision: number;
  title: string;
  sourceKind: Activity['source']['kind'];
};
export const batchSelectionLimit = 100;
export function toBatchTarget(activity: Activity): BatchTarget {
  return {
    id: activity.id,
    revision: activity.revision,
    title: activity.effective.title ?? '제목 없음',
    sourceKind: activity.source.kind,
  };
}
export interface BatchSelectionState {
  targets: BatchTarget[];
  limitExceeded: boolean;
  locked: boolean;
  setLocked(locked: boolean): void;
  toggle(target: BatchTarget): void;
  selectPage(targets: BatchTarget[]): void;
  remove(ids: string[]): void;
  clear(): void;
}
export function createBatchSelectionStore() {
  return createStore<BatchSelectionState>()((set, get) => ({
    targets: [],
    locked: false,
    setLocked: (locked) => set({ locked }),
    limitExceeded: false,
    toggle: (target) => {
      if (get().locked) return;
      const current = get().targets;
      if (current.some((item) => item.id === target.id))
        set({ targets: current.filter((item) => item.id !== target.id), limitExceeded: false });
      else if (current.length >= batchSelectionLimit) set({ limitExceeded: true });
      else set({ targets: [...current, { ...target }], limitExceeded: false });
    },
    selectPage: (targets) => {
      if (get().locked) return;
      const current = get().targets;
      const seen = new Set(current.map((item) => item.id));
      const added: BatchTarget[] = [];
      for (const target of targets)
        if (!seen.has(target.id)) {
          seen.add(target.id);
          added.push({ ...target });
        }
      if (current.length + added.length > batchSelectionLimit) set({ limitExceeded: true });
      else set({ targets: [...current, ...added], limitExceeded: false });
    },
    remove: (ids) => {
      const removed = new Set(ids);
      set({ targets: get().targets.filter((item) => !removed.has(item.id)), limitExceeded: false });
    },
    clear: () => {
      if (!get().locked) set({ targets: [], limitExceeded: false });
    },
  }));
}
export type BatchSelectionStore = ReturnType<typeof createBatchSelectionStore>;
