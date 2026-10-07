import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  routineScheduleVersionSchema,
} from '@workout/contracts/routines';
import type { Database, Transaction } from '../src/database.js';
import { createRoutineRepository } from '../src/routine-core.js';

function fixture() {
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic checklist',
    intent: 'Manual',
    status: 'published',
    tags: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-10-08T00:00:00Z',
    steps: [
      {
        id: 'check',
        title: 'Check',
        content: { kind: 'checklist', prompt: 'Checked?' },
        timing: { kind: 'ordered', afterStepId: null },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
  });
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: randomUUID(),
    versionId: randomUUID(),
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-10-08',
      endDateExclusive: '2026-10-09',
      timezone: 'UTC',
      maxOccurrences: 1,
    },
    rule: { kind: 'dates', dates: ['2026-10-08'], localTime: '07:00' },
    state: 'active',
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: randomUUID(),
    schedule: { id: schedule.id, versionId: schedule.versionId },
    blueprint: schedule.blueprint,
    anchorKey: 'date:2026-10-08',
    scheduledAt: '2026-10-08T07:00:00Z',
    timingStatus: 'resolved',
    stepBindings: [],
    selectedChoices: {},
  });
  const command = {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: occurrence.id,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
  return { blueprint, schedule, occurrence, command };
}
function database(query: Transaction['query']): Database {
  const tenant: Database['tenant'] = (athleteId, operation) => operation({ athleteId, query });
  return { tenant, exclusiveTenant: tenant, close: async () => undefined };
}

describe('routine current-version read/start boundaries', () => {
  it('reads only current-version occurrences while retaining their exact body', async () => {
    const f = fixture();
    const query = vi
      .fn<Transaction['query']>()
      .mockResolvedValueOnce({
        rows: [
          {
            record_json: f.schedule,
            version_id: f.schedule.versionId,
            source_plan_version_id: null,
            notification_muted: false,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ record_json: f.occurrence }], rowCount: 1 });
    const read = await createRoutineRepository(database(query)).readSchedule(
      'synthetic',
      f.schedule.id,
    );
    expect(read?.occurrences).toEqual([f.occurrence]);
    expect(query.mock.calls[1]?.[0]).toContain('schedule_version_id=$3');
    expect(query.mock.calls[1]?.[1]).toEqual(['synthetic', f.schedule.id, f.schedule.versionId]);
  });
  it.each(['historical', 'wrong_aggregate', 'wrong_head'] as const)(
    'rejects %s occurrence before creating a run',
    async (kind) => {
      const f = fixture();
      const occurrence = {
        ...f.occurrence,
        schedule: {
          ...f.occurrence.schedule,
          ...(kind === 'historical'
            ? { versionId: randomUUID() }
            : kind === 'wrong_aggregate'
              ? { id: randomUUID() }
              : {}),
        },
      };
      const query = vi.fn<Transaction['query']>().mockImplementation(async (sql) => {
        if (sql.includes('FROM consent'))
          return { rows: [{ kind: 'app', granted: true, revision: 1 }], rowCount: 1 };
        if (sql.includes('FROM routine_blueprint_version'))
          return { rows: [{ record_json: f.blueprint }], rowCount: 1 };
        if (sql.includes('FROM routine_blueprint_head'))
          return {
            rows: [{ record_json: f.blueprint, version: 1, favorite: false, visibility: 'active' }],
            rowCount: 1,
          };
        if (sql.includes('FROM routine_occurrence o'))
          return {
            rows: [
              {
                record_json: occurrence,
                schedule: f.schedule,
                version_id: kind === 'wrong_head' ? randomUUID() : f.schedule.versionId,
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      });
      await expect(
        createRoutineRepository(database(query)).startRun('synthetic', f.command),
      ).rejects.toThrow('OCCURRENCE_UNAVAILABLE');
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO routine_run'))).toBe(false);
    },
  );
  it('starts an exact current occurrence without mutating its frozen bytes', async () => {
    const f = fixture();
    let saved: unknown;
    const query = vi.fn<Transaction['query']>().mockImplementation(async (sql, values) => {
      if (sql.includes('FROM consent'))
        return { rows: [{ kind: 'app', granted: true, revision: 1 }], rowCount: 1 };
      if (sql.includes('FROM routine_blueprint_version'))
        return { rows: [{ record_json: f.blueprint }], rowCount: 1 };
      if (sql.includes('FROM routine_blueprint_head'))
        return {
          rows: [{ record_json: f.blueprint, version: 1, favorite: false, visibility: 'active' }],
          rowCount: 1,
        };
      if (sql.includes('FROM routine_occurrence o'))
        return {
          rows: [
            { record_json: f.occurrence, schedule: f.schedule, version_id: f.schedule.versionId },
          ],
          rowCount: 1,
        };
      if (sql.includes('INSERT INTO outbox')) return { rows: [{ id: values?.[1] }], rowCount: 1 };
      if (sql.includes('INSERT INTO routine_run\n')) saved = JSON.parse(String(values?.[5]));
      if (sql.includes('SELECT record_json FROM routine_run WHERE'))
        return { rows: [{ record_json: saved }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const read = await createRoutineRepository(database(query)).startRun('synthetic', f.command);
    expect(read.run.origin).toEqual({ kind: 'planned', occurrenceId: f.occurrence.id });
    expect(read.run.blueprint).toEqual(f.occurrence.blueprint);
    expect(
      query.mock.calls.some(([sql]) => /(?:UPDATE|DELETE).*routine_occurrence/s.test(sql)),
    ).toBe(false);
  });
  it('returns the original successful start receipt before current/app admission reads', async () => {
    const f = fixture();
    const original = {
      run: routineRunSchema.parse({
        id: f.command.runId,
        revision: 0,
        blueprint: f.occurrence.blueprint,
        origin: { kind: 'planned', occurrenceId: f.occurrence.id },
        state: 'in_progress',
        progress: [],
        selectedChoices: {},
        startedAt: '2026-10-08T00:00:00Z',
        endedAt: null,
      }),
      timers: [],
    };
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ type: 'startRun', input: f.command }))
      .digest('hex');
    const query = vi
      .fn<Transaction['query']>()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ request_hash: requestHash, result_json: original }],
        rowCount: 1,
      });
    expect(await createRoutineRepository(database(query)).startRun('synthetic', f.command)).toEqual(
      original,
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('routine_command_receipt');
  });
});
