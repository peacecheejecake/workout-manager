import { createStore } from 'zustand/vanilla';
import type { CoreEvidenceCapture } from '@workout/contracts/evidence-snapshots';
export interface EvidenceWindowDraft {
  from: string;
  toExclusive: string;
  timezone: string;
}
export interface EvidencePending {
  threadId: string;
  command: CoreEvidenceCapture;
}
interface EvidenceState {
  drafts: Record<string, EvidenceWindowDraft>;
  pending: EvidencePending | null;
  phase: 'idle' | 'sending' | 'uncertain';
  feedback: string | null;
  actions: {
    edit(threadId: string, field: keyof EvidenceWindowDraft, value: string): void;
    begin(pending: EvidencePending): boolean;
    retry(): EvidencePending | null;
    uncertain(): void;
    reject(feedback: string): void;
    succeeded(): void;
    reset(): void;
  };
}
/** Per-authenticated-workspace memory only. No snapshot bodies or persistent private data. */
export function createEvidenceDraftStore() {
  return createStore<EvidenceState>()((set, get) => ({
    drafts: {},
    pending: null,
    phase: 'idle',
    feedback: null,
    actions: {
      edit(threadId, field, value) {
        if (get().pending) return;
        set((state) => ({
          drafts: {
            ...state.drafts,
            [threadId]: {
              ...(state.drafts[threadId] ?? { from: '', toExclusive: '', timezone: '' }),
              [field]: value,
            },
          },
          feedback: null,
        }));
      },
      begin(pending) {
        if (get().pending) return false;
        set({ pending: structuredClone(pending), phase: 'sending', feedback: null });
        return true;
      },
      retry() {
        const { pending, phase } = get();
        if (!pending || phase !== 'uncertain') return null;
        set({ phase: 'sending', feedback: null });
        return structuredClone(pending);
      },
      uncertain() {
        if (get().pending)
          set({
            phase: 'uncertain',
            feedback: '저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.',
          });
      },
      reject(feedback) {
        set({ pending: null, phase: 'idle', feedback });
      },
      succeeded() {
        if (get().pending)
          set({ pending: null, phase: 'idle', feedback: '근거 저장 결과를 확인했습니다.' });
      },
      reset() {
        set({ drafts: {}, pending: null, phase: 'idle', feedback: null });
      },
    },
  }));
}
export type EvidenceDraftStore = ReturnType<typeof createEvidenceDraftStore>;
