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

describe('routine CheckIn template exact source validation', () => {
  function setup(
    mode: 'current' | 'historical' | 'missing' | 'no_reader' | 'malformed' | 'sql_error',
  ) {
    const f = fixture();
    const templateId = randomUUID(),
      versionId = randomUUID();
    const record = {
      templateId,
      versionId,
      version: 1,
      previousVersionId: null,
      previousVersion: null,
      createdAt: f.blueprint.createdAt,
      content: {
        definitionVersion: 'checkin-v1',
        source: 'user',
        method: 'self_report',
        title: 'Own report',
        instructions: null,
        fields: ['fatigue', 'note'],
      },
    };
    const head =
      mode === 'historical'
        ? {
            ...record,
            versionId: randomUUID(),
            version: 2,
            previousVersionId: versionId,
            previousVersion: 1,
          }
        : record;
    const blueprint = routineBlueprintVersionSchema.parse({
      ...f.blueprint,
      steps: f.blueprint.steps.map((step) => ({
        ...step,
        content: { kind: 'checkin_template', ref: { id: templateId, versionId } },
      })),
    });
    let inserted = false;
    const query = vi.fn<Transaction['query']>().mockImplementation(async (sql, values) => {
      if (sql.includes('has_function_privilege'))
        return { rows: [{ available: mode !== 'no_reader' }], rowCount: 1 };
      if (sql.includes('WITH observed AS MATERIALIZED')) {
        if (mode === 'sql_error') throw new Error('REAL_SQL_FAILURE');
        const version_text =
          mode === 'missing'
            ? null
            : JSON.stringify(
                mode === 'malformed' ? { ...record, versionId: randomUUID() } : record,
              );
        const head_text = JSON.stringify(head);
        return {
          rows: [
            {
              response_bytes: String(
                Buffer.byteLength(version_text ?? '') + Buffer.byteLength(head_text),
              ),
              body_valid: true,
              within_budget: true,
              version_text,
              head_text,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO routine_blueprint_version')) inserted = true;
      if (sql.includes('FROM routine_blueprint_head') && inserted)
        return {
          rows: [{ record_json: blueprint, version: 1, favorite: false, visibility: 'active' }],
          rowCount: 1,
        };
      if (sql.includes('INSERT INTO outbox')) return { rows: [{ id: values?.[1] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const save = () =>
      createRoutineRepository(database(query)).saveBlueprint('tenant', {
        blueprint,
        expectedVersionId: null,
        idempotencyKey: randomUUID(),
        confirmed: true,
      });
    return { save, blueprint, query };
  }
  it.each(['current', 'historical'] as const)(
    'accepts %s exact immutable template without repinning',
    async (mode) => {
      const f = setup(mode);
      expect((await f.save()).blueprint).toEqual(f.blueprint);
      expect(
        f.query.mock.calls.filter(([sql]) => sql.includes('WITH observed AS MATERIALIZED')),
      ).toHaveLength(1);
    },
  );
  it.each(['missing', 'no_reader', 'malformed'] as const)(
    'rejects %s before blueprint writes with the existing finite reference error',
    async (mode) => {
      const f = setup(mode);
      await expect(f.save()).rejects.toThrow('CONTENT_REFERENCE_UNAVAILABLE');
      expect(
        f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO routine_blueprint')),
      ).toBe(false);
    },
  );
  it('rejects a non-UUID catalog reference before source transport or blueprint writes', async () => {
    const f = setup('current');
    const content = f.blueprint.steps[0]?.content;
    if (!content || content.kind !== 'checkin_template') throw Error('FIXTURE_CONTENT');
    content.ref.id = 'opaque-not-a-template-uuid';
    await expect(f.save()).rejects.toThrow('CONTENT_REFERENCE_UNAVAILABLE');
    expect(
      f.query.mock.calls.some(
        ([sql]) =>
          sql.includes('has_function_privilege') || sql.includes('INSERT INTO routine_blueprint'),
      ),
    ).toBe(false);
  });
  it('propagates actual SQL failure without treating it as unavailable capability', async () => {
    await expect(setup('sql_error').save()).rejects.toThrow('REAL_SQL_FAILURE');
  });
});
