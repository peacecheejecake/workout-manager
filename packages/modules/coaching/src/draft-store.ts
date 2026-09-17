import { createStore } from 'zustand/vanilla';
import type {
  CoachingMessageAppend,
  CoachingThreadCreate,
} from '@workout/contracts/coaching-threads';

export interface MessageDraft {
  message: string;
  expectedRevision: number | null;
}
export type CoachingPending =
  | { kind: 'create'; command: CoachingThreadCreate }
  | { kind: 'append'; threadId: string; command: CoachingMessageAppend };
interface CoachingDraftState {
  title: string;
  firstMessage: string;
  messages: Record<string, MessageDraft>;
  pending: CoachingPending | null;
  phase: 'idle' | 'sending' | 'uncertain';
  feedback: string | null;
  conflictThreadId: string | null;
  actions: {
    editNew(field: 'title' | 'firstMessage', value: string): void;
    editMessage(id: string, message: string, observedRevision: number): void;
    review(id: string, revision: number): void;
    begin(command: CoachingPending): boolean;
    retry(): CoachingPending | null;
    uncertain(): void;
    reject(message: string, conflictThreadId?: string): void;
    succeeded(): void;
    reset(): void;
  };
}
/** Memory-only, instantiated per authenticated workspace lifetime. No server response cache. */
export function createCoachingDraftStore() {
  return createStore<CoachingDraftState>()((set, get) => ({
    title: '',
    firstMessage: '',
    messages: {},
    pending: null,
    phase: 'idle',
    feedback: null,
    conflictThreadId: null,
    actions: {
      reset: () =>
        set({
          title: '',
          firstMessage: '',
          messages: {},
          pending: null,
          phase: 'idle',
          feedback: null,
          conflictThreadId: null,
        }),
      editNew: (field, value) => {
        if (!get().pending) set({ [field]: value, feedback: null });
      },
      editMessage: (id, message, observedRevision) => {
        if (get().pending) return;
        set(({ messages }) => ({
          messages: {
            ...messages,
            [id]: { message, expectedRevision: messages[id]?.expectedRevision ?? observedRevision },
          },
          feedback: null,
        }));
      },
      review: (id, revision) => {
        if (!get().pending)
          set(({ messages }) => ({
            messages: {
              ...messages,
              [id]: { message: messages[id]?.message ?? '', expectedRevision: revision },
            },
            conflictThreadId: null,
            feedback: '최신 기록을 확인했습니다. 초안을 검토한 뒤 다시 저장하세요.',
          }));
      },
      begin: (pending) => {
        if (get().pending) return false;
        set({ pending: structuredClone(pending), phase: 'sending', feedback: null });
        return true;
      },
      retry: () => {
        const { pending, phase } = get();
        if (!pending || phase !== 'uncertain') return null;
        set({ phase: 'sending', feedback: null });
        return structuredClone(pending);
      },
      uncertain: () =>
        set({
          phase: 'uncertain',
          feedback:
            '저장 결과를 확인하지 못했습니다. 같은 요청 재확인으로 중복 없이 결과를 확인하세요.',
        }),
      reject: (feedback, conflictThreadId) =>
        set({ pending: null, phase: 'idle', feedback, conflictThreadId: conflictThreadId ?? null }),
      succeeded: () => {
        const pending = get().pending;
        if (!pending) return;
        if (pending.kind === 'create') set({ title: '', firstMessage: '' });
        else
          set(({ messages }) => {
            return {
              messages: Object.fromEntries(
                Object.entries(messages).filter(([id]) => id !== pending.threadId),
              ),
            };
          });
        set({
          pending: null,
          phase: 'idle',
          feedback: '사용자 기록이 저장되었습니다.',
          conflictThreadId: null,
        });
      },
    },
  }));
}
export type CoachingDraftStore = ReturnType<typeof createCoachingDraftStore>;
