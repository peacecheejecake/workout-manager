import type {
  StretchLogValues,
  StretchPlannedTarget,
  StretchingExerciseRead,
} from '@workout/contracts/stretching';

export type StretchForm = {
  side: StretchLogValues['side'];
  state: StretchLogValues['state'];
  metric: string;
  rest: string;
  comfort: StretchLogValues['comfort'];
  discomfortNote: string;
  reason: string;
  occurredAt: string;
  allocation: 'standalone' | 'activity_block';
  plannedTargetId: string;
  blockStart: string;
  blockEnd: string;
};
export const emptyStretchForm: StretchForm = {
  side: 'unknown',
  state: 'unconfirmed',
  metric: '',
  rest: '',
  comfort: 'unknown',
  discomfortNote: '',
  reason: '',
  occurredAt: '',
  allocation: 'standalone',
  plannedTargetId: '',
  blockStart: '',
  blockEnd: '',
};
function optionalNumber(value: string, name: string, integer = false) {
  if (value.trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number)))
    throw new Error(`INVALID_${name}`);
  return number;
}
export function localDateTimeInput(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function instant(value: string, original: string | null = null) {
  if (original !== null && localDateTimeInput(original) === value) return original;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('INVALID_TIME');
  return new Date(parsed).toISOString();
}
/** Empty input stays unknown; neither target nor timer values become actuals. */
export function stretchValuesFromForm(
  form: StretchForm,
  activityId: string,
  exercise: StretchingExerciseRead,
  targets: readonly StretchPlannedTarget[] = [],
  original: Pick<StretchLogValues, 'occurredAt' | 'allocation'> | null = null,
): StretchLogValues {
  const profile = exercise.profile;
  const metric = optionalNumber(form.metric, 'METRIC', profile.method === 'dynamic_repetitions');
  const rest = optionalNumber(form.rest, 'REST');
  if ((form.blockStart === '') !== (form.blockEnd === '')) throw new Error('BLOCK_BOUNDS_REQUIRED');
  const planned =
    form.plannedTargetId === ''
      ? null
      : targets.find(
          (item) =>
            item.targetSetId === form.plannedTargetId &&
            item.exerciseVersionId === exercise.definition.versionId,
        );
  if (form.plannedTargetId !== '' && !planned) throw new Error('TARGET_UNAVAILABLE');
  return {
    activityId,
    exerciseVersionId: exercise.definition.versionId,
    plannedTarget: !planned
      ? null
      : {
          executionId: planned.executionId,
          targetSetId: planned.targetSetId,
        },
    allocation:
      form.allocation === 'standalone'
        ? { kind: 'standalone' }
        : {
            kind: 'activity_block',
            startedAt:
              form.blockStart === ''
                ? null
                : instant(
                    form.blockStart,
                    original?.allocation.kind === 'activity_block'
                      ? original.allocation.startedAt
                      : null,
                  ),
            endedAtExclusive:
              form.blockEnd === ''
                ? null
                : instant(
                    form.blockEnd,
                    original?.allocation.kind === 'activity_block'
                      ? original.allocation.endedAtExclusive
                      : null,
                  ),
          },
    side: form.side,
    state: form.state,
    holdSeconds: profile.method === 'static_hold' ? metric : null,
    repetitions: profile.method === 'dynamic_repetitions' ? metric : null,
    restSeconds: rest,
    comfort: form.comfort,
    discomfortNote: form.comfort === 'discomfort' ? form.discomfortNote.trim() || null : null,
    reason: form.reason.trim() || null,
    occurredAt: instant(form.occurredAt, original?.occurredAt ?? null),
  };
}
