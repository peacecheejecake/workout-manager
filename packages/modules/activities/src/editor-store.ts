import { createStore } from 'zustand/vanilla';
import type { Activity, ActivityReportValues } from '@workout/contracts/activity';
import type { TransportRequest } from '@workout/contracts/core';
export interface EditorFields {
  title: string;
  kind: Activity['effective']['kind'];
  startedAt: string;
  timezone: string;
  distance: string;
  duration: string;
  durationKind: Activity['effective']['durationKind'];
  sessionRpe: string;
  note: string;
  planLink: ActivityReportValues['planLink'];
  reason: string;
}
export interface EditorCommand {
  path: string;
  method: 'POST' | 'PATCH';
  body: TransportRequest['body'];
  idempotencyKey: string;
}
export function createEditorStore(startedAt: string, timezone: string) {
  const initial: EditorFields = {
    title: '',
    kind: 'running',
    startedAt,
    timezone,
    distance: '',
    duration: '',
    durationKind: 'unknown',
    sessionRpe: '',
    note: '',
    planLink: null,
    reason: '',
  };
  return createStore<{
    fields: EditorFields;
    original: Activity | null;
    dirty: boolean;
    command: EditorCommand | null;
    phase: 'draft' | 'preview' | 'pending' | 'uncertain' | 'conflict' | 'saved';
    actions: {
      change<K extends keyof EditorFields>(key: K, value: EditorFields[K]): void;
      load(record: Activity): void;
      rebase(record: Activity): void;
      preview(command: EditorCommand): void;
      phase(value: 'pending' | 'uncertain' | 'conflict' | 'saved'): void;
      edit(): void;
      reset(): void;
      dispose(): void;
    };
  }>((set, get) => ({
    fields: initial,
    original: null,
    dirty: false,
    command: null,
    phase: 'draft',
    actions: {
      change: (key, value) => {
        if (get().phase !== 'draft') return;
        set((state) => ({ fields: { ...state.fields, [key]: value }, dirty: true }));
      },
      load: (record) => {
        if (get().dirty || get().command) return;
        const v = record.effective;
        const r = record.userReport;
        set({
          original: record,
          fields: {
            title: v.title ?? '',
            kind: v.kind,
            startedAt: v.startedAt ?? '',
            timezone: v.timezone ?? '',
            distance: v.distanceMeters === null ? '' : String(v.distanceMeters),
            duration: v.durationSeconds === null ? '' : String(v.durationSeconds),
            durationKind: v.durationKind,
            sessionRpe: r?.sessionRpe == null ? '' : String(r.sessionRpe),
            note: r?.note ?? '',
            planLink: r?.planLink ?? null,
            reason: '',
          },
        });
      },
      rebase: (record) => {
        if (get().phase !== 'conflict') return;
        set({ original: record, phase: 'draft', command: null });
      },
      preview: (command) => {
        if (get().phase === 'draft') set({ phase: 'preview', command });
      },
      phase: (phase) =>
        set({
          phase,
          ...(phase === 'conflict' || phase === 'saved' ? { command: null } : {}),
          ...(phase === 'saved' ? { dirty: false } : {}),
        }),
      edit: () => {
        if (get().phase === 'preview' || get().phase === 'conflict')
          set({ phase: 'draft', command: null });
      },
      dispose: () =>
        set({ fields: initial, original: null, dirty: false, command: null, phase: 'draft' }),
      reset: () => {
        if (['pending', 'uncertain'].includes(get().phase)) return;
        set({ fields: initial, original: null, dirty: false, command: null, phase: 'draft' });
      },
    },
  }));
}
