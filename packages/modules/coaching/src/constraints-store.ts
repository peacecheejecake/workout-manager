import { createStore } from 'zustand/vanilla';
import type {
  CoachingConstraintCreate,
  CoachingConstraintUpdate,
  CoachingConstraintDelete,
} from '@workout/contracts/coaching-constraints';
export type ConstraintsPending =
  | { kind: 'create'; command: CoachingConstraintCreate }
  | { kind: 'update'; id: string; command: CoachingConstraintUpdate }
  | { kind: 'delete'; id: string; command: CoachingConstraintDelete };
export function createConstraintsDraftStore() {
  return createStore<{
    text: string;
    editing: string | null;
    pending: ConstraintsPending | null;
    phase: 'idle' | 'sending' | 'uncertain';
    feedback: string | null;
    conflict: boolean;
    actions: {
      edit(text: string): void;
      select(id: string | null, text: string): void;
      begin(command: ConstraintsPending): boolean;
      retry(): ConstraintsPending | null;
      uncertain(): void;
      reject(message: string, conflict?: boolean): void;
      reviewed(): void;
      succeeded(): void;
      reset(): void;
    };
  }>()((set, get) => ({
    text: '',
    editing: null,
    pending: null,
    phase: 'idle',
    feedback: null,
    conflict: false,
    actions: {
      edit(text) {
        if (!get().pending) set({ text });
      },
      select(editing, text) {
        if (!get().pending) set({ editing, text, feedback: null });
      },
      begin(pending) {
        if (get().pending || get().conflict) return false;
        set({ pending: structuredClone(pending), phase: 'sending', feedback: null });
        return true;
      },
      retry() {
        const { pending, phase } = get();
        if (!pending || phase !== 'uncertain') return null;
        set({ phase: 'sending' });
        return structuredClone(pending);
      },
      uncertain() {
        if (get().pending)
          set({
            phase: 'uncertain',
            feedback: '저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.',
          });
      },
      reject(feedback, conflict = false) {
        set({ pending: null, phase: 'idle', feedback, conflict });
      },
      reviewed() {
        if (!get().pending)
          set({
            conflict: false,
            feedback: '최신 제약을 확인했습니다. 초안을 다시 검토하고 확인하세요.',
          });
      },
      succeeded() {
        const pending = get().pending;
        const keepDraft = pending?.kind === 'delete' && get().editing !== pending.id;
        set({
          ...(keepDraft ? {} : { text: '', editing: null }),
          pending: null,
          phase: 'idle',
          feedback: '사용자 제약 변경이 확인되었습니다.',
          conflict: false,
        });
      },
      reset() {
        set({
          text: '',
          editing: null,
          pending: null,
          phase: 'idle',
          feedback: null,
          conflict: false,
        });
      },
    },
  }));
}
export type ConstraintsDraftStore = ReturnType<typeof createConstraintsDraftStore>;
