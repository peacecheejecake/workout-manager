import { createStore } from 'zustand/vanilla';
import type { CheckIn, CheckInValues } from '@workout/contracts/check-ins';

export interface CheckInFields {
  observedAt: string;
  timezone: string;
  fatigue: string;
  discomfort: string;
  bodyLocation: string;
  note: string;
  reason: string;
}
export type CheckInDraft =
  | { mode: 'create'; fields: CheckInFields }
  | { mode: 'edit'; original: CheckIn; fields: CheckInFields };
export function fieldsFromValues(values: CheckInValues): CheckInFields {
  return {
    ...values,
    fatigue: values.fatigue === null ? '' : String(values.fatigue),
    discomfort: values.discomfort === null ? '' : String(values.discomfort),
    bodyLocation: values.bodyLocation ?? '',
    note: values.note ?? '',
    reason: '',
  };
}
export function createCheckInDraftStore(observedAt: string, timezone: string) {
  const initial = (): CheckInDraft => ({
    mode: 'create',
    fields: fieldsFromValues({
      observedAt,
      timezone,
      fatigue: null,
      discomfort: null,
      bodyLocation: null,
      note: null,
    }),
  });
  return createStore<{
    draft: CheckInDraft;
    dirty: boolean;
    actions: {
      change(field: keyof CheckInFields, value: string): void;
      edit(record: CheckIn): void;
      rebase(record: CheckIn): void;
      reset(): void;
    };
  }>((set) => ({
    draft: initial(),
    dirty: false,
    actions: {
      change: (field, value) =>
        set((state) => ({
          dirty: true,
          draft: { ...state.draft, fields: { ...state.draft.fields, [field]: value } },
        })),
      edit: (record) =>
        set({
          draft: { mode: 'edit', original: record, fields: fieldsFromValues(record.values) },
          dirty: false,
        }),
      rebase: (record) =>
        set((state) => ({
          draft: { mode: 'edit', original: record, fields: state.draft.fields },
          dirty: true,
        })),
      reset: () => set({ draft: initial(), dirty: false }),
    },
  }));
}
