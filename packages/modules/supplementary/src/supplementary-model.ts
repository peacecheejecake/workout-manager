import type {
  ExerciseVersionRead,
  RestTimerState,
  RoutineTemplateRead,
  SetLogValues,
  SupplementarySpec,
} from '@workout/contracts/supplementary-core';

export type ExerciseForm = {
  name: string;
  family: ExerciseVersionRead['definition']['family'];
  equipment: ExerciseVersionRead['definition']['equipment'][number];
  tags: string;
  description: string;
  safetyNotes: string;
  metric: 'count' | 'duration';
  countKind: 'repetitions' | 'jumps' | 'landing_events' | 'foot_contacts';
  countBasis: 'total' | 'per_side' | 'unspecified';
};

export const emptyExerciseForm: ExerciseForm = {
  name: '',
  family: 'resistance',
  equipment: 'bodyweight',
  tags: '',
  description: '',
  safetyNotes: '',
  metric: 'count',
  countKind: 'repetitions',
  countBasis: 'total',
};

export function exerciseFormFrom(read: ExerciseVersionRead): ExerciseForm {
  const { definition } = read;
  return {
    name: definition.name,
    family: definition.family,
    equipment: definition.equipment[0] ?? 'bodyweight',
    tags: definition.tags.join(', '),
    description: definition.description,
    safetyNotes: definition.safetyNotes,
    metric: definition.supportedMetrics.includes('count') ? 'count' : 'duration',
    countKind: definition.countDefinitions[0]?.kind ?? 'repetitions',
    countBasis: definition.countDefinitions[0]?.basis ?? 'total',
  };
}

export function definitionFromForm(
  form: ExerciseForm,
  prior: ExerciseVersionRead | null,
  ids: { exerciseId: string; versionId: string; definitionId: string },
  now: string,
): ExerciseVersionRead['definition'] {
  return {
    schemaVersion: 2,
    exerciseId: prior?.definition.exerciseId ?? ids.exerciseId,
    versionId: ids.versionId,
    name: form.name.trim(),
    family: form.family,
    equipment: [form.equipment],
    tags: form.tags
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    countDefinitions:
      form.metric === 'count'
        ? [{ kind: form.countKind, basis: form.countBasis, definitionId: ids.definitionId }]
        : [],
    mediaAssetIds: prior?.definition.mediaAssetIds ?? [],
    resourceVersionIds: prior?.definition.resourceVersionIds ?? [],
    description: form.description.trim(),
    safetyNotes: form.safetyNotes.trim(),
    supportedMetrics: [form.metric],
    reviewState: 'unreviewed',
    createdAt: now,
  };
}

export type TargetForm = {
  id: string;
  exerciseVersionId: string;
  side: SupplementarySpec['blocks'][number]['sets'][number]['side'];
  count: string;
  duration: string;
  rest: string;
};

export function newTargetForm(id: string, exerciseVersionId: string): TargetForm {
  return { id, exerciseVersionId, side: 'bilateral', count: '', duration: '', rest: '' };
}

export function targetFormsFrom(read: RoutineTemplateRead): TargetForm[] {
  return read.template.spec.blocks.flatMap((block) =>
    block.sets.map((set) => ({
      id: set.id,
      exerciseVersionId: set.exerciseVersionId,
      side: set.side,
      count: set.count === null ? '' : String(set.count.target.min),
      duration: set.durationSeconds === null ? '' : String(set.durationSeconds.min),
      rest: set.restAfterSeconds === null ? '' : String(set.restAfterSeconds),
    })),
  );
}

export function specFromTargets(
  targets: TargetForm[],
  exercises: ExerciseVersionRead[],
  routineVersionId: string,
  blockId: string,
  prior: RoutineTemplateRead | null = null,
): SupplementarySpec {
  const previousSets = prior?.template.spec.blocks.flatMap((block) => block.sets) ?? [];
  const mapTarget = (target: TargetForm) => {
    const previous = previousSets.find((set) => set.id === target.id);
    const exercise = exercises.find(
      (item) => item.definition.versionId === target.exerciseVersionId,
    );
    if (!exercise && !previous) throw new Error('EXERCISE_VERSION_UNAVAILABLE');
    const count = target.count.trim() === '' ? null : Number(target.count);
    const duration = target.duration.trim() === '' ? null : Number(target.duration);
    const rest = target.rest.trim() === '' ? null : Number(target.rest);
    if (count !== null && (!Number.isFinite(count) || count < 0)) throw new Error('INVALID_COUNT');
    if (duration !== null && (!Number.isFinite(duration) || duration < 0))
      throw new Error('INVALID_DURATION');
    if (rest !== null && (!Number.isFinite(rest) || rest < 0)) throw new Error('INVALID_REST');
    const definition = exercise?.definition.countDefinitions[0] ?? previous?.count?.definition;
    if (count !== null && !definition) throw new Error('COUNT_UNSUPPORTED');
    return {
      ...(previous ?? {
        tempo: null,
        effort: null,
        externalResistance: { kind: 'unknown' as const },
      }),
      id: target.id,
      exerciseVersionId: target.exerciseVersionId,
      side: target.side,
      count:
        count === null || !definition
          ? null
          : {
              target: {
                min: count,
                max: count,
                unit: 'count' as const,
                basis: 'user_confirmed' as const,
                evidenceIds: [],
              },
              definition,
            },
      durationSeconds:
        duration === null
          ? null
          : {
              min: duration,
              max: duration,
              unit: 's' as const,
              basis: 'user_confirmed' as const,
              evidenceIds: [],
            },
      restAfterSeconds: rest,
    };
  };
  const blocks = prior?.template.spec.blocks.map((block) => ({
    ...block,
    sets: targets.filter((target) => block.sets.some((set) => set.id === target.id)).map(mapTarget),
  })) ?? [
    { id: blockId, mode: 'single' as const, rounds: 1, restBetweenRoundsSeconds: null, sets: [] },
  ];
  const existingIds = new Set(previousSets.map((set) => set.id));
  const firstBlock = blocks[0];
  if (!firstBlock) throw new Error('BLOCK_UNAVAILABLE');
  firstBlock.sets.push(...targets.filter((target) => !existingIds.has(target.id)).map(mapTarget));
  return {
    schemaVersion: 2,
    kind: 'supplementary',
    routineVersionId,
    blocks,
  };
}

/** A zero is a reported value; empty input is unknown. A target never becomes an actual by default. */
export function setValuesFromInputs(input: {
  exerciseVersionId: string;
  definition: ExerciseVersionRead['definition']['countDefinitions'][number] | null;
  side: SetLogValues['side'];
  state: SetLogValues['state'];
  count: string;
  duration: string;
  resistance: string;
  resistanceKind: 'unknown' | 'no_added_load' | 'external' | 'assisted';
  rpe: string;
  rir: string;
  reason: string;
  occurredAt: string;
  targetSetId: string | null;
  blockId: string | null;
  roundIndex?: string;
}): SetLogValues {
  const parse = (value: string, name: string) => {
    if (value.trim() === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`INVALID_${name}`);
    return number;
  };
  const count = parse(input.count, 'COUNT');
  const duration = parse(input.duration, 'DURATION');
  const resistance = parse(input.resistance, 'RESISTANCE');
  const rpe = parse(input.rpe, 'RPE');
  const rir = parse(input.rir, 'RIR');
  const roundIndex = parse(input.roundIndex ?? '', 'ROUND');
  if (roundIndex !== null && !Number.isInteger(roundIndex)) throw new Error('INVALID_ROUND');
  if (rpe !== null && rpe > 10) throw new Error('INVALID_RPE');
  if (count !== null && !input.definition) throw new Error('COUNT_UNSUPPORTED');
  return {
    targetSetId: input.targetSetId,
    blockId: input.blockId,
    roundIndex,
    exerciseVersionId: input.exerciseVersionId,
    side: input.side,
    state: input.state,
    count: input.definition
      ? {
          actual: {
            value: count,
            unit: 'count',
            status: count === null ? 'unknown' : 'reported',
            evidenceIds: [],
          },
          definition: input.definition,
        }
      : null,
    durationSeconds: {
      value: duration,
      unit: 's',
      status: duration === null ? 'unknown' : 'reported',
      evidenceIds: [],
    },
    externalResistance:
      input.resistanceKind === 'no_added_load'
        ? { kind: 'no_added_load' }
        : input.resistanceKind === 'external' && resistance !== null
          ? {
              kind: 'external',
              totalKg: { value: resistance, unit: 'kg', status: 'reported', evidenceIds: [] },
            }
          : input.resistanceKind === 'assisted' && resistance !== null
            ? {
                kind: 'assisted',
                assistanceKg: {
                  value: resistance,
                  unit: 'kg',
                  status: 'reported',
                  evidenceIds: [],
                },
              }
            : { kind: 'unknown' },
    effort: { rpe, rir, scaleVersion: 'user-rpe-rir-v1' },
    occurredAt: input.occurredAt,
    reason: input.reason.trim() || null,
  };
}

export function timerRemainingSeconds(timer: RestTimerState, now: string): number {
  if (timer.status === 'finished') return 0;
  if (timer.status === 'paused') return timer.remainingWhenPausedSeconds ?? 0;
  return Math.max(0, Math.ceil((Date.parse(timer.deadlineAt ?? now) - Date.parse(now)) / 1000));
}
