import { z } from 'zod';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import type { Transaction } from '../src/database.js';
import {
  captureRaceManualReviewOwnedSourceInventoryV2In,
  validateRaceManualReviewOwnedSourceInventoryV2,
} from '../src/race-manual-review-owned-source-inventory-v2.js';
import { enumerateRaceManualReviewCopiedSourcesV2 } from '../src/race-manual-review-source-inventory-v2.js';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import { expect, it } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  raceRelativeScheduleImpactInputCompatibleV4Schema,
  type RaceRelativeScheduleImpactInputCompatibleV4,
  type RaceScheduleCalculationPortsCompatibleV4,
} from '@workout/server-coaching/race-relative-schedule-impact';
import {
  assembleRaceManualReviewCandidateCompatibleV4,
  raceManualReviewCandidateV2InputSchema,
} from '@workout/server-coaching/race-manual-review-candidate-v2';
const eventId = '20000000-0000-4000-8000-000000000001',
  planId = '10000000-0000-4000-8000-000000000001',
  nutritionId = '30000000-0000-4000-8000-000000000001';
function fixture(
  version: 1 | 2 | 3 | 4 = 4,
  long = false,
): RaceRelativeScheduleImpactInputCompatibleV4 {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const plan = planSnapshotSchema.parse({
    id: planId,
    version: 1,
    createdAt: '2026-03-01T00:00:00Z',
    draft: {
      title: 'Synthetic',
      timezone: 'UTC',
      periods: levels.map((level, i) => ({
        id: level,
        parentId: i ? levels[i - 1] : null,
        level,
        title: level,
        startDate: '2026-03-01',
        endDateExclusive: '2026-04-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'Session',
          blockId: 'block',
          date: '2026-03-07',
          localStartTime: '07:00:00',
          title: 'Synthetic',
          sport: 'running',
          durationSeconds: 0,
          distanceMeters: 0,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  });
  const makeItem = (id: string, disconnected = false) => ({
    id,
    planVersionId: nutritionId,
    category: 'before',
    title: 'Synthetic',
    anchor: disconnected
      ? { kind: 'disconnected', entity: 'race' }
      : { kind: 'relative', entity: 'race', entityId: eventId, point: 'start', offsetMinutes: 0 },
    foods: [],
    targets: [],
    instructions: 'Explicit synthetic action',
    evidenceIds: [],
    source: 'user_confirmed',
  });
  const ids = [long ? 'a'.repeat(1000) : 'one', 'two'];
  const pin = (revision: number) => ({
    pinVersion: 1,
    namespace: 'race-event-revision',
    eventId,
    eventRevision: revision,
    sourceDigestVersion: 'race-event-values-canonical-v1',
    sourceDigest: 'a'.repeat(64),
    localDate: '2026-03-07',
    localStartTime: '06:00:00',
    timezone: 'UTC',
    start: { state: 'known', instant: '2026-03-07T06:00:00Z' },
    end: { state: 'unknown', reason: 'race_end_not_recorded' },
  });
  const record = nutritionPlanVersionCompatibleV4Schema.parse({
    planId: '30000000-0000-4000-8000-000000000002',
    versionId: nutritionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-03-01', toInclusive: '2026-03-31' },
    timezone: 'UTC',
    purpose: 'Synthetic',
    linkedTrainingPlanVersionId: planId,
    approvedAt: '2026-03-01T00:00:00Z',
    approvalId: nutritionId,
    items: [
      ...ids.map((id) => makeItem(id)),
      ...(version >= 3 ? [makeItem('unlinked', true)] : []),
    ],
    ...(version === 1
      ? {}
      : {
          schemaVersion: version,
          raceTimingPins: version === 4 ? [pin(1), pin(2)] : [pin(1)],
          itemRaceTimingBindings: ids.map((itemId, i) => ({
            itemId,
            binding: { state: 'captured', eventId, eventRevision: version === 4 ? i + 1 : 1 },
          })),
        }),
  });
  return raceRelativeScheduleImpactInputCompatibleV4Schema.parse({
    event: {
      id: eventId,
      revision: 3,
      title: 'Synthetic race',
      localDate: '2026-03-07',
      localStartTime: '07:00:00',
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: planId,
    },
    newLocalDate: '2026-03-09',
    currentPlan: plan,
    sourcePlans: [],
    completionReports: [],
    selection: { kind: 'keep_plan' },
    nutrition: [
      {
        record,
        timings: record.items.map((item) => ({
          itemId: item.id,
          timing:
            item.anchor.kind === 'disconnected'
              ? { state: 'unresolved', reason: 'unsupported_anchor_mapping' }
              : { state: 'resolved', date: '2026-03-07', localTime: '06:00:00' },
        })),
      },
    ],
    routines: [],
    resolutions: { nutrition: [], routines: [] },
  });
}
/** Pure calculation fixtures, not ownership/real timing/PG evidence. */
function ports(): RaceScheduleCalculationPortsCompatibleV4 {
  return {
    resolveNutrition: ({ event, item }) =>
      item.anchor.kind === 'absolute'
        ? { state: 'resolved', date: item.anchor.date, localTime: item.anchor.localTime }
        : { state: 'resolved', date: event.localDate, localTime: '07:00:00' },
    expandRoutine: () => ({ state: 'unresolved', reason: 'UNSUPPORTED_MAPPING' }),
  };
}

function input(version: 1 | 2 | 3 | 4 = 4, long = false) {
  const projectionInput = fixture(version, long);
  return raceManualReviewCandidateV2InputSchema.parse({
    athleteId: 'synthetic-athlete',
    binding: {
      purpose: 'manual_race_date_change',
      event: { id: eventId, revision: 3 },
      appRevision: 1,
      policy: { id: 'manual-race-date-impact', version: 1, digest: 'b'.repeat(64) },
      restoreGeneration: '40000000-0000-4000-8000-000000000001',
      readSetDigest: 'c'.repeat(64),
    },
    projectionInput,
    sourceFacts: {
      ownerAthleteId: 'synthetic-athlete',
      nutritionRacePins: projectionInput.nutrition.flatMap(({ record }) =>
        record.items
          .filter((item) => item.anchor.kind === 'relative' && item.anchor.entity === 'race')
          .map((item) => ({
            nutritionVersionId: record.versionId,
            itemId: item.id,
            binding:
              'schemaVersion' in record
                ? record.itemRaceTimingBindings.find((row) => row.itemId === item.id)?.binding
                : { state: 'legacy_unpinned' },
          })),
      ),
    },
  });
}
function assembled(value = input()) {
  const result = assembleRaceManualReviewCandidateCompatibleV4(value, ports());
  if (result.status !== 'assembled_readonly') throw Error(result.reason);
  return result;
}

function routineInput(state: 'active' | 'ended' = 'active') {
  const input = fixture();
  input.selection = {
    kind: 'move_period',
    expectedCurrentPlanVersionId: planId,
    periodId: 'season',
    newStartDate: '2026-03-03',
    scope: 'descendants_and_sessions',
  };
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: 'blueprint',
    versionId: 'blueprint-v1',
    title: 'Synthetic',
    intent: '',
    status: 'published',
    tags: [],
    steps: [],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-03-01T00:00:00Z',
  });
  const record = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: 'schedule',
    versionId: 'schedule-v1',
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-03-01',
      endDateExclusive: '2026-04-01',
      timezone: 'UTC',
      maxOccurrences: 2,
    },
    rule: { kind: 'session_links', sessionIds: ['Session'], point: 'start', offsetMinutes: 0 },
    state,
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: 'occurrence',
    schedule: { id: record.id, versionId: record.versionId },
    blueprint: record.blueprint,
    anchorKey: 'Session:start',
    scheduledAt: '2026-03-07T07:00:00Z',
    timingStatus: 'resolved',
    stepBindings: [],
    selectedChoices: {},
  });
  const run = routineRunSchema.parse({
    id: 'run',
    revision: 1,
    blueprint: record.blueprint,
    origin: { kind: 'planned', occurrenceId: occurrence.id },
    state: 'stopped',
    progress: [],
    selectedChoices: {},
    startedAt: '2026-03-07T07:00:00Z',
    endedAt: '2026-03-07T07:00:00Z',
  });
  input.routines = [
    { record, blueprint, sourcePlanVersionId: planId, occurrences: [occurrence], runs: [run] },
  ];
  return { input, occurrence };
}

function fullCandidate() {
  const v = input(),
    routine = routineInput();
  v.projectionInput = routine.input;
  v.projectionInput.completionReports = [
    sessionCompletionSchema.parse({
      sessionId: 'Session',
      revision: 1,
      planVersionId: planId,
      schedule: {
        blockId: 'block',
        date: '2026-03-07',
        localStartTime: '07:00:00',
        timezone: 'UTC',
      },
      status: 'completed',
      reportedAt: '2026-03-07T09:00:00Z',
      reason: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'session-completion-v1',
    }),
  ];
  return assembled(v);
}
function required<T>(v: T | null | undefined): T {
  if (v == null) throw Error('Missing fixture');
  return v;
}
function rowFor(
  candidate: ReturnType<typeof assembled>,
  identity: ReturnType<typeof enumerateRaceManualReviewCopiedSourcesV2>['refs'][number]['identity'],
): Record<string, unknown> {
  const p = candidate.body.projectionInput;
  let record: unknown,
    metadata: unknown,
    current: unknown = null;
  switch (identity.kind) {
    case 'race-event':
      record = p.event;
      metadata = { id: p.event.id, revision: p.event.revision, deleted: false };
      break;
    case 'plan-snapshot': {
      const b = required(p.currentPlan);
      record = b;
      metadata = { id: b.id, version: b.version };
      break;
    }
    case 'nutrition-plan-version': {
      const b = required(p.nutrition[0]).record;
      record = b;
      metadata = {
        id: b.planId,
        versionId: b.versionId,
        version: b.version,
        linkedPlanVersionId: b.linkedTrainingPlanVersionId,
        approvalId: b.approvalId,
        approvedAt: b.approvedAt,
      };
      break;
    }
    case 'routine-schedule-version': {
      const b = required(p.routines[0]).record;
      record = b;
      metadata = {
        id: b.id,
        versionId: b.versionId,
        blueprintId: b.blueprint.id,
        blueprintVersionId: b.blueprint.versionId,
      };
      break;
    }
    case 'routine-blueprint-version': {
      const b = required(p.routines[0]).blueprint;
      record = b;
      metadata = { id: b.routineId, versionId: b.versionId };
      break;
    }
    case 'routine-occurrence': {
      const b = required(required(p.routines[0]).occurrences[0]);
      record = b;
      metadata = {
        id: b.id,
        scheduleId: b.schedule.id,
        scheduleVersionId: b.schedule.versionId,
        blueprintId: b.blueprint.id,
        blueprintVersionId: b.blueprint.versionId,
        anchorKey: b.anchorKey,
        scheduledAt: b.scheduledAt,
      };
      break;
    }
    case 'routine-run': {
      const b = required(required(p.routines[0]).runs[0]);
      record = b;
      current = b;
      metadata = {
        id: b.id,
        revision: b.revision,
        currentRevision: b.revision,
        blueprintId: b.blueprint.id,
        blueprintVersionId: b.blueprint.versionId,
        occurrenceId: b.origin.kind === 'planned' ? b.origin.occurrenceId : null,
      };
      break;
    }
    case 'session-completion': {
      const b = required(p.completionReports[0]);
      record = b;
      metadata = {
        id: b.sessionId,
        revision: b.revision,
        planVersionId: b.planVersionId,
        schedule: b.schedule,
      };
      break;
    }
  }
  return {
    athlete_id: candidate.body.athleteId,
    metadata,
    record_json: structuredClone(record),
    current_record_json: structuredClone(current),
  };
}
function byteSize(v: unknown) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}
/** Query fixtures check codec and ordering, not actual SQL ownership/RLS. Root PG is separate. */
function transaction(
  candidate = fullCandidate(),
  alter?: (kind: string, row: Record<string, unknown>) => Record<string, unknown> | null,
  scalarAlter?: (kind: string, row: Record<string, unknown>) => Record<string, unknown>,
) {
  const inventory = enumerateRaceManualReviewCopiedSourcesV2(candidate),
    queries: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: candidate.body.athleteId,
    async query(sql, values) {
      queries.push({ sql, values });
      const ref = required(inventory.refs.find((r) => sql.includes(` ${r.identity.kind} */`))),
        kind = ref.identity.kind;
      const original = rowFor(candidate, ref.identity),
        row = alter ? alter(kind, original) : original;
      if (sql.includes(' scalar ')) {
        const body = row ? byteSize(row.record_json) : 0,
          current = row ? byteSize(row.current_record_json) : 0,
          meta = row ? byteSize(row.metadata) : 0;
        const scalar = {
          count: row ? '1' : '0',
          bytes: String(body + current + meta),
          bodyMaximum: String(body),
          currentMaximum: String(current),
          metadataMaximum: String(meta),
        };
        return { rows: [scalarAlter ? scalarAlter(kind, scalar) : scalar], rowCount: 1 };
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    },
  };
  return { tx, queries };
}
const emptyBudget = () => ({ bytes: 0n, sources: 0 });
for (const version of [1, 2, 3, 4] as const)
  it(`matches actual-shaped V${version} rows with readonly correspondence only`, async () => {
    const candidate = assembled(input(version)),
      copy = structuredClone(candidate),
      mock = transaction(candidate),
      budget = emptyBudget();
    const result = await captureRaceManualReviewOwnedSourceInventoryV2In(
      mock.tx,
      candidate,
      budget,
    );
    expect(result.status).toBe('observed_correspondence');
    expect(result.facts).toHaveLength(3);
    expect(result).toMatchObject({
      authority: 'none',
      freshness: 'not_checked',
      admissionAllowed: false,
      approvalAllowed: false,
      sqlRowDigest: 'not_captured',
    });
    expect(result.coverage).toEqual(candidate.body.coverage);
    expect(candidate).toEqual(copy);
    expect(budget.sources).toBe(4);
    expect(mock.queries).toHaveLength(6);
  });
it('matches all eight namespaces, retaining actual original bodies and exact completion schedule', async () => {
  const candidate = fullCandidate(),
    mock = transaction(candidate);
  const result = await captureRaceManualReviewOwnedSourceInventoryV2In(
    mock.tx,
    candidate,
    emptyBudget(),
  );
  expect(result.status).toBe('observed_correspondence');
  expect(new Set(result.facts.map((f) => f.identity.kind)).size).toBe(8);
  for (const q of mock.queries) {
    expect(q.sql).toContain('athlete_id=$1');
    expect(q.values?.[0]).toBe(candidate.body.athleteId);
  }
  expect(JSON.stringify(result)).not.toContain('Explicit synthetic action');
});
for (const kind of [
  'race-event',
  'plan-snapshot',
  'nutrition-plan-version',
  'routine-schedule-version',
  'routine-blueprint-version',
  'routine-occurrence',
  'routine-run',
  'session-completion',
])
  it(`preserves unavailable ${kind} without substituting current/history`, async () => {
    const c = fullCandidate(),
      m = transaction(c, (k, row) => (k === kind ? null : row)),
      r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
    expect(r.status).toBe('blocked');
    expect(r.facts.find((f) => f.identity.kind === kind)).toMatchObject({
      state: 'unavailable',
      reason:
        kind === 'routine-run' || kind === 'session-completion'
          ? 'history_missing'
          : 'owned_source_unavailable',
    });
    expect(m.queries.filter((q) => q.sql.includes(`body ${kind}`))).toHaveLength(0);
  });
it('blocks stale/deleted current race and foreign rows', async () => {
  for (const mode of ['stale', 'deleted', 'foreign']) {
    const c = fullCandidate(),
      m = transaction(c, (k, row) =>
        k === 'race-event'
          ? {
              ...row,
              athlete_id: mode === 'foreign' ? 'foreign' : row.athlete_id,
              record_json: mode === 'deleted' ? null : row.record_json,
              metadata: {
                id: eventId,
                revision: mode === 'stale' ? 4 : 3,
                deleted: mode === 'deleted',
              },
            }
          : row,
      ),
      r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
    expect(r.status).toBe('blocked');
    expect(r.facts.find((f) => f.identity.kind === 'race-event')?.state).toBe('unavailable');
  }
});
it('blocks exact owned tuple with changed copied content', async () => {
  const c = fullCandidate(),
    m = transaction(c, (k, row) =>
      k === 'race-event'
        ? { ...row, record_json: { ...c.body.projectionInput.event, title: 'Changed' } }
        : row,
    ),
    r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
  expect(r.facts.find((f) => f.identity.kind === 'race-event')).toMatchObject({
    state: 'unavailable',
    reason: 'copied_body_mismatch',
  });
});
it('blocks completion wrong historical plan/schedule, and never invents aggregate identity', async () => {
  for (const mode of ['plan', 'schedule']) {
    const c = fullCandidate(),
      completion = required(c.body.projectionInput.completionReports[0]),
      m = transaction(c, (k, row) =>
        k === 'session-completion'
          ? {
              ...row,
              metadata: {
                id: completion.sessionId,
                revision: 1,
                planVersionId: mode === 'plan' ? null : planId,
                schedule: mode === 'schedule' ? null : completion.schedule,
              },
            }
          : row,
      ),
      r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
    expect(r.facts.find((f) => f.identity.kind === 'session-completion')).toMatchObject({
      state: 'unavailable',
      reason: 'source_tuple_mismatch',
    });
    expect(JSON.stringify(r)).not.toContain('aggregateId');
  }
});
it('requires current run/history equality but allows exact historical run without latest body', async () => {
  const c = fullCandidate();
  for (const historical of [false, true]) {
    const m = transaction(c, (k, row) => {
        if (k !== 'routine-run') return row;
        const run = required(required(c.body.projectionInput.routines[0]).runs[0]);
        return {
          ...row,
          metadata: {
            id: run.id,
            revision: run.revision,
            currentRevision: historical ? run.revision + 1 : run.revision,
            blueprintId: run.blueprint.id,
            blueprintVersionId: run.blueprint.versionId,
            occurrenceId: run.origin.kind === 'planned' ? run.origin.occurrenceId : null,
          },
          current_record_json: historical ? null : { ...run, state: 'ended' },
        };
      }),
      r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
    expect(r.facts.find((f) => f.identity.kind === 'routine-run')?.state).toBe(
      historical ? 'matched' : 'unavailable',
    );
  }
});
it('rejects malformed scalar, duplicate rows and oversize before body transport', async () => {
  for (const mode of ['malformed', 'duplicate', 'large']) {
    const c = assembled(),
      m = transaction(c, undefined, (_k, row) =>
        mode === 'malformed'
          ? { ...row, count: '-1' }
          : mode === 'duplicate'
            ? { ...row, count: '2' }
            : { ...row, bodyMaximum: '4194305' },
      );
    await expect(
      captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget()),
    ).rejects.toThrow();
    expect(m.queries).toHaveLength(1);
  }
});
function expectedResponseCharge(candidate: ReturnType<typeof assembled>) {
  const inventory = enumerateRaceManualReviewCopiedSourcesV2(candidate);
  return inventory.refs.reduce((total, ref) => {
    const row = rowFor(candidate, ref.identity);
    return (
      total +
      BigInt(
        byteSize(row.record_json) + byteSize(row.current_record_json) + byteSize(row.metadata),
      ) +
      512n
    );
  }, 0n);
}
it('reserves copied source visits before dedup without charging local candidate or inventory bytes', async () => {
  const c = assembled(input(4, true)),
    m = transaction(c),
    budget = emptyBudget();
  const inventory = enumerateRaceManualReviewCopiedSourcesV2(c);
  const result = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, budget);
  expect(result.status).toBe('observed_correspondence');
  expect(budget.bytes).toBe(expectedResponseCharge(c));
  expect(budget.sources).toBe(inventory.refs.reduce((n, ref) => n + ref.copiedLocations.length, 0));
  expect(budget.sources).toBeGreaterThan(inventory.refs.length);
  expect(byteSize(c)).toBeGreaterThan(0);
  expect(byteSize(inventory)).toBeGreaterThan(0);
});
it('source response reservation fits the remaining shared budget exactly', async () => {
  const c = assembled(),
    m = transaction(c),
    charge = expectedResponseCharge(c);
  const budget = { bytes: 4194304n - charge, sources: 0 };
  const result = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, budget);
  expect(result.status).toBe('observed_correspondence');
  expect(budget.bytes).toBe(4194304n);
  expect(m.queries.filter((q) => q.sql.includes(' body '))).toHaveLength(3);
});
it('rejects source visits before querying but response bytes after scalar and before body transport', async () => {
  const c = assembled(),
    inventory = enumerateRaceManualReviewCopiedSourcesV2(c);
  const visits = inventory.refs.reduce((n, ref) => n + ref.copiedLocations.length, 0);
  const visitMock = transaction(c);
  await expect(
    captureRaceManualReviewOwnedSourceInventoryV2In(visitMock.tx, c, {
      bytes: 0n,
      sources: 5001 - visits,
    }),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'unique_sources' });
  expect(visitMock.queries).toHaveLength(0);
  const first = required(inventory.refs[0]),
    row = rowFor(c, first.identity);
  const charge =
    BigInt(byteSize(row.record_json) + byteSize(row.current_record_json) + byteSize(row.metadata)) +
    512n;
  const byteMock = transaction(c),
    budget = { bytes: 4194305n - charge, sources: 0 };
  await expect(
    captureRaceManualReviewOwnedSourceInventoryV2In(byteMock.tx, c, budget),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
  expect(byteMock.queries).toHaveLength(1);
  expect(byteMock.queries[0]?.sql).toContain(' scalar ');
  expect(budget.bytes).toBe(4194305n);
});
it('keeps the caller mutable budget across repeated captures without resetting previous reservations', async () => {
  const c = assembled(),
    m = transaction(c),
    budget = { bytes: 73n, sources: 11 };
  const charge = expectedResponseCharge(c),
    inventory = enumerateRaceManualReviewCopiedSourcesV2(c);
  const visits = inventory.refs.reduce((n, ref) => n + ref.copiedLocations.length, 0);
  await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, budget);
  await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, budget);
  expect(budget).toEqual({ bytes: 73n + 2n * charge, sources: 11 + 2 * visits });
  expect(m.queries).toHaveLength(12);
  expect(m.queries.every((q) => q.sql.includes('SELECT'))).toBe(true);
});
it('propagates actual SQL permission errors and rejects malformed body storage', async () => {
  const c = assembled(),
    m = transaction(c);
  const tx: Transaction = {
    athleteId: m.tx.athleteId,
    async query() {
      throw Error('SQL42501');
    },
  };
  await expect(
    captureRaceManualReviewOwnedSourceInventoryV2In(tx, c, emptyBudget()),
  ).rejects.toThrow('SQL42501');
  const bad = transaction(c, (k, row) =>
    k === 'race-event' ? { ...row, record_json: { unknown: true } } : row,
  );
  await expect(
    captureRaceManualReviewOwnedSourceInventoryV2In(bad.tx, c, emptyBudget()),
  ).rejects.toThrow('INVALID_CONTEXT');
});
it('validates structural output without granting authentication and rejects getter/cycle/authority/unknown', async () => {
  const c = assembled(),
    m = transaction(c),
    r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
  expect(validateRaceManualReviewOwnedSourceInventoryV2(r).success).toBe(true);
  for (const raw of [
    { ...r, admissionAllowed: true },
    { ...r, unknown: true },
    { ...r, status: 'blocked' },
  ])
    expect(validateRaceManualReviewOwnedSourceInventoryV2(raw).success).toBe(false);
  let called = 0;
  const getter = Object.defineProperty({}, 'scope', {
    enumerable: true,
    get() {
      called++;
      return r.scope;
    },
  });
  expect(validateRaceManualReviewOwnedSourceInventoryV2(getter).success).toBe(false);
  expect(called).toBe(0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(validateRaceManualReviewOwnedSourceInventoryV2(cycle).success).toBe(false);
});

it('does not collapse different microsecond relational approval timestamps', async () => {
  const c = assembled(),
    nutrition = required(c.body.projectionInput.nutrition[0]).record;
  const m = transaction(c, (k, row) =>
    k === 'nutrition-plan-version'
      ? {
          ...row,
          metadata: {
            id: nutrition.planId,
            versionId: nutrition.versionId,
            version: nutrition.version,
            linkedPlanVersionId: nutrition.linkedTrainingPlanVersionId,
            approvalId: nutrition.approvalId,
            approvedAt: '2026-03-01T00:00:00.000001Z',
          },
        }
      : row,
  );
  const r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
  expect(r.facts.find((f) => f.identity.kind === 'nutrition-plan-version')).toMatchObject({
    state: 'unavailable',
    reason: 'source_tuple_mismatch',
  });
});
it('rejects nonfinite, deep and above4MiB output boundaries without authenticity claims', async () => {
  const c = assembled(),
    m = transaction(c),
    r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
  for (const raw of [
    { ...r, candidateDigest: 'x'.repeat(4194304) },
    { ...r, unexpected: Infinity },
    new Date(),
  ])
    expect(validateRaceManualReviewOwnedSourceInventoryV2(raw).success).toBe(false);
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = { nested: deep };
  expect(validateRaceManualReviewOwnedSourceInventoryV2(deep).success).toBe(false);
});

it('requires one original race fact, never omitting missing identities', async () => {
  const c = fullCandidate(),
    m = transaction(c),
    r = await captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget());
  expect(validateRaceManualReviewOwnedSourceInventoryV2({ ...r, facts: [] }).success).toBe(false);
  expect(
    validateRaceManualReviewOwnedSourceInventoryV2({
      ...r,
      facts: r.facts.filter((f) => f.identity.kind !== 'race-event'),
    }).success,
  ).toBe(false);
  const race = required(r.facts.find((f) => f.identity.kind === 'race-event'));
  expect(
    validateRaceManualReviewOwnedSourceInventoryV2({ ...r, facts: [...r.facts, race] }).success,
  ).toBe(false);
  const absent = transaction(c, () => null),
    missing = await captureRaceManualReviewOwnedSourceInventoryV2In(absent.tx, c, emptyBudget());
  expect(missing.facts).toHaveLength(r.facts.length);
  expect(missing.facts.every((f) => f.state === 'unavailable')).toBe(true);
});

it('rejects a null race body without an exact deleted identity', async () => {
  const c = fullCandidate();
  for (const metadata of [
    { id: eventId, revision: 3, deleted: false },
    { id: '20000000-0000-4000-8000-000000000099', revision: 3, deleted: true },
  ]) {
    const m = transaction(c, (kind, row) =>
      kind === 'race-event' ? { ...row, record_json: null, metadata } : row,
    );
    await expect(
      captureRaceManualReviewOwnedSourceInventoryV2In(m.tx, c, emptyBudget()),
    ).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      bound: 'decoded_bytes',
    });
  }
});

it('decoded nutrition parent is returned only after actual relational and body correspondence', async () => {
  const candidate = fullCandidate();
  const ref = required(
    enumerateRaceManualReviewCopiedSourcesV2(candidate).refs.find(
      (r) => r.identity.kind === 'nutrition-plan-version',
    ),
  );
  const m = transaction(candidate, (kind, row) =>
    kind === 'nutrition-plan-version'
      ? { ...row, source_stamp: '42', source_digest: 'c'.repeat(64) }
      : row,
  );
  const { captureRaceManualReviewOwnedSourceRefDecodedV2In: decoded } =
    await import('../src/race-manual-review-owned-source-inventory-v2.js');
  const result = await decoded(
    m.tx,
    { identity: ref.identity, dtoDigest: ref.dtoDigest },
    emptyBudget(),
  );
  expect(result.fact.state).toBe('matched');
  expect(result.nutritionParent?.record).toEqual(
    candidate.body.projectionInput.nutrition[0]?.record,
  );
  expect(result.nutritionParent?.sourceStamp).toBe('42');
  expect(m.queries.at(-1)?.sql).toContain('r.xmin::text');
  expect(m.queries.at(-1)?.sql).toContain('sha256(convert_to(r.record_json::text');
  for (const metadataChange of [
    { approvalId: '30000000-0000-4000-8000-000000000099' },
    { approvedAt: '2026-03-01T00:00:00.000001Z' },
    { linkedPlanVersionId: null },
  ]) {
    const bad = transaction(candidate, (kind, row) =>
      kind === 'nutrition-plan-version'
        ? {
            ...row,
            source_stamp: '42',
            source_digest: 'c'.repeat(64),
            metadata: {
              ...z.record(z.string(), z.unknown()).parse(row.metadata),
              ...metadataChange,
            },
          }
        : row,
    );
    const rejected = await decoded(
      bad.tx,
      { identity: ref.identity, dtoDigest: ref.dtoDigest },
      emptyBudget(),
    );
    expect(rejected.fact).toMatchObject({ state: 'unavailable', reason: 'source_tuple_mismatch' });
    expect(rejected.nutritionParent).toBeNull();
  }
});
