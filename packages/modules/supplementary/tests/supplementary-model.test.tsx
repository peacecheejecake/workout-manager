import { describe, expect, it } from 'vitest';
import {
  setLogCreateCommandSchema,
  supplementarySpecSchema,
  type ExerciseVersionRead,
  type RoutineTemplateRead,
  type RestTimerState,
} from '@workout/contracts/supplementary-core';
import {
  definitionFromForm,
  emptyExerciseForm,
  newTargetForm,
  setValuesFromInputs,
  specFromTargets,
  timerRemainingSeconds,
} from '../src/supplementary-model';
import { parseSupplementaryRoute } from '../src/supplementary-route';

const exerciseId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const nextVersionId = '33333333-3333-4333-8333-333333333333';
const definitionId = 'count-v1';
const exercise: ExerciseVersionRead = {
  version: 1,
  definition: definitionFromForm(
    { ...emptyExerciseForm, name: '점프', family: 'plyometric', description: '점프 후 착지' },
    null,
    { exerciseId, versionId, definitionId },
    '2026-09-18T00:00:00.000Z',
  ),
};

describe('supplementary manual core model', () => {
  it('keeps equipment and movement family independent and marks user content unreviewed', () => {
    expect(exercise.definition.family).toBe('plyometric');
    expect(exercise.definition.equipment).toEqual(['bodyweight']);
    expect(exercise.definition.reviewState).toBe('unreviewed');
  });

  it('preserves frozen block structure and count basis on routine revision', () => {
    const priorSpec = supplementarySpecSchema.parse({
      schemaVersion: 2,
      kind: 'supplementary',
      routineVersionId: versionId,
      blocks: [
        {
          id: 'block-a',
          mode: 'circuit',
          rounds: 2,
          restBetweenRoundsSeconds: 30,
          sets: [
            {
              id: 'target-a',
              exerciseVersionId: versionId,
              side: 'left',
              count: {
                target: {
                  min: 10,
                  max: 10,
                  unit: 'count',
                  basis: 'user_confirmed',
                  evidenceIds: [],
                },
                definition: exercise.definition.countDefinitions[0],
              },
              durationSeconds: null,
              externalResistance: { kind: 'unknown' },
              restAfterSeconds: 20,
              tempo: null,
              effort: null,
            },
          ],
        },
      ],
    });
    const prior: RoutineTemplateRead = {
      version: 1,
      template: {
        schemaVersion: 2,
        routineId: exerciseId,
        versionId,
        title: '점프 루틴',
        purpose: '',
        requiredEquipment: ['bodyweight'],
        spec: priorSpec,
        createdAt: '2026-09-18T00:00:00.000Z',
      },
    };
    const revised = specFromTargets(
      [{ ...newTargetForm('target-a', versionId), side: 'left', count: '12', rest: '20' }],
      [exercise],
      nextVersionId,
      'unused',
      prior,
    );
    expect(revised.blocks[0]?.mode).toBe('circuit');
    expect(revised.blocks[0]?.rounds).toBe(2);
    expect(revised.blocks[0]?.sets[0]?.count?.definition.basis).toBe('total');
    expect(revised.blocks[0]?.sets[0]?.count?.target.min).toBe(12);
    expect(prior.template.spec.blocks[0]?.sets[0]?.count?.target.min).toBe(10);
  });

  it('does not turn a plan target or blank actual into confirmed performance', () => {
    const values = setValuesFromInputs({
      exerciseVersionId: versionId,
      definition: exercise.definition.countDefinitions[0] ?? null,
      side: 'bilateral',
      state: 'unconfirmed',
      count: '',
      duration: '',
      resistance: '',
      resistanceKind: 'unknown',
      rpe: '',
      rir: '',
      reason: '',
      occurredAt: '2026-09-18T01:00:00.000Z',
      targetSetId: 'target-a',
      blockId: 'block-a',
    });
    expect(values.count?.actual.value).toBeNull();
    expect(values.durationSeconds.value).toBeNull();
    expect(values.externalResistance.kind).toBe('unknown');
    expect(
      setLogCreateCommandSchema.safeParse({
        schemaVersion: 2,
        executionId: exerciseId,
        logId: nextVersionId,
        expectedExecutionRevision: 1,
        idempotencyKey: 'stable_key_01',
        confirmation: 'user_confirmed',
        values,
      }).success,
    ).toBe(false);
    expect(
      setLogCreateCommandSchema.safeParse({
        schemaVersion: 2,
        executionId: exerciseId,
        logId: nextVersionId,
        expectedExecutionRevision: 1,
        idempotencyKey: 'stable_key_01',
        confirmation: 'draft',
        values,
      }).success,
    ).toBe(true);
  });

  it('keeps reported zero distinct from unknown and requires positive performance confirmation', () => {
    const values = setValuesFromInputs({
      exerciseVersionId: versionId,
      definition: exercise.definition.countDefinitions[0] ?? null,
      side: 'left',
      state: 'confirmed_skipped',
      count: '0',
      duration: '',
      resistance: '0',
      resistanceKind: 'external',
      rpe: '0',
      rir: '0',
      reason: '',
      occurredAt: '2026-09-18T01:00:00.000Z',
      targetSetId: null,
      blockId: null,
    });
    expect(values.count?.actual).toMatchObject({ value: 0, status: 'reported' });
    expect(values.externalResistance).toMatchObject({ kind: 'external', totalKg: { value: 0 } });
    expect(values.effort.rpe).toBe(0);
    expect(
      setLogCreateCommandSchema.safeParse({
        schemaVersion: 2,
        executionId: exerciseId,
        logId: nextVersionId,
        expectedExecutionRevision: 1,
        idempotencyKey: 'stable_key_02',
        confirmation: 'user_confirmed',
        values,
      }).success,
    ).toBe(true);
    expect(
      setLogCreateCommandSchema.safeParse({
        schemaVersion: 2,
        executionId: exerciseId,
        logId: nextVersionId,
        expectedExecutionRevision: 1,
        idempotencyKey: 'stable_key_02',
        confirmation: 'user_confirmed',
        values: { ...values, state: 'performed' },
      }).success,
    ).toBe(false);
  });

  it('recalculates timer from the clock after foregrounding, without producing a set', () => {
    const timer: RestTimerState = {
      timerId: exerciseId,
      executionId: versionId,
      revision: 1,
      durationSeconds: 60,
      startedAt: '2026-09-18T00:00:00.000Z',
      deadlineAt: '2026-09-18T00:01:00.000Z',
      pausedAt: null,
      remainingWhenPausedSeconds: null,
      status: 'running',
    };
    expect(timerRemainingSeconds(timer, '2026-09-18T00:00:15.000Z')).toBe(45);
    expect(timerRemainingSeconds(timer, '2026-09-18T00:02:00.000Z')).toBe(0);
    expect(
      timerRemainingSeconds(
        {
          ...timer,
          status: 'paused',
          deadlineAt: null,
          pausedAt: '2026-09-18T00:00:20.000Z',
          remainingWhenPausedSeconds: 40,
        },
        '2026-09-18T00:20:00.000Z',
      ),
    ).toBe(40);
  });

  it('parses the documented screen paths', () => {
    expect(parseSupplementaryRoute('/supplementary')).toEqual({ kind: 'overview' });
    expect(parseSupplementaryRoute(`/supplementary/sessions/${exerciseId}/perform`)).toEqual({
      kind: 'execution',
      executionId: exerciseId,
    });
    expect(parseSupplementaryRoute('/supplementary/unknown')).toBeNull();
  });
});
