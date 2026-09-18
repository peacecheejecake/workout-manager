import { createStore } from 'zustand/vanilla';
import type { TrainingCandidatePartialRequestV1 } from '@workout/contracts/coaching-candidates';

export type CandidatePending =
  | { kind: 'partial'; command: TrainingCandidatePartialRequestV1 }
  | { kind: 'approval'; expectedDigest: string; idempotencyKey: string };

export function createCandidateReviewStore() {
  return createStore<{
    sessionIds: string[];
    periodIds: string[];
    includeTitle: boolean;
    confirmed: boolean;
    pending: CandidatePending | null;
    phase: 'idle' | 'sending' | 'uncertain';
    conflict: boolean;
    feedback: string | null;
    partialCandidateId: string | null;
    approvedVersion: { id: string; version: number } | null;
    actions: {
      toggleSession(id: string): void;
      togglePeriod(id: string): void;
      setTitle(selected: boolean): void;
      setConfirmed(confirmed: boolean): void;
      begin(command: CandidatePending): boolean;
      retry(): CandidatePending | null;
      uncertain(): void;
      reject(feedback: string, conflict?: boolean): void;
      reviewed(): void;
      partialSucceeded(id: string): void;
      approvalSucceeded(version: { id: string; version: number }): void;
      reset(): void;
    };
  }>()((set, get) => ({
    sessionIds: [],
    periodIds: [],
    includeTitle: false,
    confirmed: false,
    pending: null,
    phase: 'idle',
    conflict: false,
    feedback: null,
    partialCandidateId: null,
    approvedVersion: null,
    actions: {
      toggleSession(id) {
        if (get().pending) return;
        set((state) => ({
          sessionIds: state.sessionIds.includes(id)
            ? state.sessionIds.filter((value) => value !== id)
            : [...state.sessionIds, id],
          confirmed: false,
        }));
      },
      togglePeriod(id) {
        if (get().pending) return;
        set((state) => ({
          periodIds: state.periodIds.includes(id)
            ? state.periodIds.filter((value) => value !== id)
            : [...state.periodIds, id],
          confirmed: false,
        }));
      },
      setTitle(includeTitle) {
        if (get().pending) return;
        set({ includeTitle, confirmed: false });
      },
      setConfirmed(confirmed) {
        if (get().pending) return;
        set({ confirmed });
      },
      begin(pending) {
        if (get().pending || get().conflict) return false;
        set({ pending: structuredClone(pending), phase: 'sending', feedback: null });
        return true;
      },
      retry() {
        const state = get();
        if (state.phase !== 'uncertain' || !state.pending) return null;
        set({ phase: 'sending', feedback: null });
        return structuredClone(state.pending);
      },
      uncertain() {
        if (get().pending)
          set({
            phase: 'uncertain',
            feedback: '서버 응답을 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요.',
          });
      },
      reject(feedback, conflict = false) {
        set({ pending: null, phase: 'idle', confirmed: false, feedback, conflict });
      },
      reviewed() {
        if (!get().pending)
          set({
            conflict: false,
            confirmed: false,
            feedback: '최신 후보와 계획을 확인했습니다. 변경 내용을 다시 검토하세요.',
          });
      },
      partialSucceeded(id) {
        set({
          pending: null,
          phase: 'idle',
          confirmed: false,
          partialCandidateId: id,
          feedback: '선택한 변경으로 새 후보를 만들고 검증했습니다. 새 후보를 검토하세요.',
        });
      },
      approvalSucceeded(version) {
        set({
          pending: null,
          phase: 'idle',
          confirmed: false,
          approvedVersion: version,
          feedback: `계획 버전 ${version.version} 적용을 서버에서 확인했습니다.`,
        });
      },
      reset() {
        set({
          sessionIds: [],
          periodIds: [],
          includeTitle: false,
          confirmed: false,
          pending: null,
          phase: 'idle',
          conflict: false,
          feedback: null,
          partialCandidateId: null,
          approvedVersion: null,
        });
      },
    },
  }));
}
export type CandidateReviewStore = ReturnType<typeof createCandidateReviewStore>;
