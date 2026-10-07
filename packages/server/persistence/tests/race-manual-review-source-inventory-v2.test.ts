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

import { createHash } from 'node:crypto';
import {
  enumerateRaceManualReviewCopiedSourcesV2,
  raceManualReviewSourceInventoryV2Schema,
} from '../src/race-manual-review-source-inventory-v2.js';
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw Error('Missing fixture');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function reseal(value: ReturnType<typeof assembled>) {
  return { ...value, digest: createHash('sha256').update(canonical(value.body)).digest('hex') };
}
for (const version of [1, 2, 3, 4] as const)
  it(`indexes actual V${version} copied bodies without lifecycle authority`, () => {
    const candidate = assembled(input(version, true)),
      original = structuredClone(candidate);
    const result = enumerateRaceManualReviewCopiedSourcesV2(candidate);
    expect(result.inventoryState).toBe('mapped');
    expect(result.allCopiedBodiesIndexed).toBe(true);
    expect(result.refs.map((r) => r.identity.kind)).toEqual([
      'race-event',
      'plan-snapshot',
      'nutrition-plan-version',
    ]);
    expect(
      result.refs.find((r) => r.identity.kind === 'nutrition-plan-version')?.copiedLocations,
    ).toEqual(['body.projectionInput.nutrition[0].record', 'body.projection.nutrition[0].record']);
    expect(result).toMatchObject({
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      approvalAllowed: false,
      sourceCompleteness: 'unverified',
      candidateCoverage: { complete: false },
    });
    expect(result.candidateCoverage?.missing).toHaveLength(5);
    expect(result.notCopied).toContain('food-definitions');
    expect(result.notCopied).toContain('manual-actual-bodies');
    expect(raceManualReviewSourceInventoryV2Schema.parse(result)).toEqual(result);
    expect(candidate).toEqual(original);
  });
it('keeps historical pin fragments separate from full event and proposed references', () => {
  const result = enumerateRaceManualReviewCopiedSourcesV2(assembled());
  expect(
    result.fragments.filter((r) => r.kind === 'race-timing-pin').map((r) => r.sourceIdentity),
  ).toContainEqual({ kind: 'race-event', sourceId: eventId, revision: 1 });
  expect(
    result.fragments.filter((r) => r.kind === 'race-timing-pin').map((r) => r.sourceIdentity),
  ).toContainEqual({ kind: 'race-event', sourceId: eventId, revision: 2 });
  expect(
    result.refs.filter((r) => r.identity.kind === 'race-event').map((r) => r.identity),
  ).toEqual([{ kind: 'race-event', sourceId: eventId, revision: 3 }]);
  expect(result.referenceOnly.some((r) => r.location.includes('proposedReferences'))).toBe(true);
  expect(result.refs.some((r) => 'revision' in r.identity && r.identity.revision === 4)).toBe(
    false,
  );
});
it('rejects invalid digest and unknown candidate fields', () => {
  expect(
    enumerateRaceManualReviewCopiedSourcesV2({ ...assembled(), extra: true }).blockers[0]?.reason,
  ).toBe('invalid_candidate');
  expect(
    enumerateRaceManualReviewCopiedSourcesV2({ ...assembled(), digest: 'f'.repeat(64) })
      .inventoryState,
  ).toBe('blocked');
});
it('rejects accessors without evaluating them and cyclic input', () => {
  let called = false;
  const raw = {
    get status() {
      called = true;
      return 'assembled_readonly';
    },
  };
  expect(enumerateRaceManualReviewCopiedSourcesV2(raw).allCopiedBodiesIndexed).toBe(false);
  expect(called).toBe(false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(enumerateRaceManualReviewCopiedSourcesV2(cycle).inventoryState).toBe('blocked');
});
it('merges identical full tuple copies and rejects divergent copies', () => {
  const candidate = structuredClone(assembled());
  candidate.body.projectionInput.sourcePlans = [
    structuredClone(required(candidate.body.projectionInput.currentPlan)),
  ];
  expect(
    enumerateRaceManualReviewCopiedSourcesV2(reseal(candidate)).refs.find(
      (r) => r.identity.kind === 'plan-snapshot',
    )?.copiedLocations,
  ).toHaveLength(2);
  required(candidate.body.projectionInput.sourcePlans[0]).draft.title = 'Changed immutable body';
  expect(enumerateRaceManualReviewCopiedSourcesV2(reseal(candidate)).blockers).toContainEqual({
    reason: 'divergent_copied_body',
    location: 'body.projectionInput.currentPlan',
  });
});
it('separates same aggregate multiple revisions and preserves semantic array ordering', () => {
  const candidate = structuredClone(assembled());
  const plan = structuredClone(required(candidate.body.projectionInput.currentPlan));
  plan.version = 2;
  candidate.body.projectionInput.sourcePlans = [plan];
  expect(
    enumerateRaceManualReviewCopiedSourcesV2(reseal(candidate)).refs.filter(
      (r) => r.identity.kind === 'plan-snapshot',
    ),
  ).toHaveLength(2);
  const before = enumerateRaceManualReviewCopiedSourcesV2(reseal(candidate));
  required(candidate.body.projectionInput.currentPlan).draft.periods.reverse();
  const after = enumerateRaceManualReviewCopiedSourcesV2(reseal(candidate));
  expect(
    before.refs.find((r) => r.identity.kind === 'plan-snapshot' && r.identity.version === 1)
      ?.dtoDigest,
  ).not.toBe(
    after.refs.find((r) => r.identity.kind === 'plan-snapshot' && r.identity.version === 1)
      ?.dtoDigest,
  );
});
it('does not index the proposed draft as an actual plan or reinstate disconnected timing', () => {
  const result = enumerateRaceManualReviewCopiedSourcesV2(assembled(input(4)));
  expect(result.derived.some((r) => r.kind === 'calendar')).toBe(true);
  expect(result.refs.filter((r) => r.identity.kind === 'plan-snapshot')).toHaveLength(1);
  expect(
    result.fragments.every((r) => r.digestMethod === 'dto-fragment-object-key-canonical-sha256-v1'),
  ).toBe(true);
});
it('blocks rejected candidate without inventing copied paths', () => {
  const result = enumerateRaceManualReviewCopiedSourcesV2(
    assembleRaceManualReviewCandidateCompatibleV4({}, ports()),
  );
  expect(result.blockers[0]?.reason).toBe('candidate_not_assembled');
  expect(result.refs).toEqual([]);
});
it('rejects larger than 4MiB input before enumeration', () => {
  const candidate = structuredClone(assembled());
  candidate.body.projectionInput.event.title = 'x'.repeat(4194305);
  expect(enumerateRaceManualReviewCopiedSourcesV2(candidate).blockers[0]?.reason).toBe(
    'invalid_candidate',
  );
});
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

it('indexes public opaque routine IDs in separate namespaces and exact retained bodies', () => {
  const value = input();
  value.projectionInput = routineInput('active').input;
  const result = enumerateRaceManualReviewCopiedSourcesV2(assembled(value));
  expect(result.inventoryState).toBe('mapped');
  expect(result.refs.find((r) => r.identity.kind === 'routine-schedule-version')?.identity).toEqual(
    { kind: 'routine-schedule-version', sourceId: 'schedule', versionId: 'schedule-v1' },
  );
  expect(
    result.refs.find((r) => r.identity.kind === 'routine-blueprint-version')?.identity,
  ).toEqual({
    kind: 'routine-blueprint-version',
    sourceId: 'blueprint',
    versionId: 'blueprint-v1',
  });
  expect(
    result.refs.find((r) => r.identity.kind === 'routine-occurrence')?.copiedLocations,
  ).toContain('body.projection.routines[0].projection.retainedOccurrences[0]');
  expect(result.refs.find((r) => r.identity.kind === 'routine-run')?.identity).toEqual({
    kind: 'routine-run',
    sourceId: 'run',
    revision: 1,
  });
});
it('preserves Unicode opaque plan identities and case rather than narrowing to UUID', () => {
  const value = input();
  const plan = value.projectionInput.currentPlan;
  if (!plan) throw Error('fixture');
  value.projectionInput.currentPlan = null;
  value.projectionInput.sourcePlans = [
    { ...plan, id: 'Opaque计划-A' },
    { ...plan, id: 'Opaque计划-a' },
  ];
  value.projectionInput.event.planVersionId = null;
  value.projectionInput.nutrition = [];
  value.sourceFacts.nutritionRacePins = [];
  const result = enumerateRaceManualReviewCopiedSourcesV2(assembled(value));
  expect(result.inventoryState).toBe('mapped');
  expect(
    result.refs.filter((r) => r.identity.kind === 'plan-snapshot').map((r) => r.identity.sourceId),
  ).toEqual(['Opaque计划-A', 'Opaque计划-a']);
});
it('counts copied body visits before identical tuple deduplication', () => {
  const candidate = structuredClone(assembled());
  const plan = candidate.body.projectionInput.currentPlan;
  if (!plan) throw Error('fixture');
  const report = {
    sessionId: 'Session',
    revision: 1,
    planVersionId: planId,
    schedule: { blockId: 'block', date: '2026-03-07', localStartTime: '07:00:00', timezone: 'UTC' },
    status: 'completed' as const,
    reportedAt: '2026-03-07T08:00:00Z',
    reason: null,
    source: 'user' as const,
    method: 'self_report' as const,
    definitionVersion: 'session-completion-v1' as const,
  };
  candidate.body.projectionInput.sourcePlans = [];
  candidate.body.projectionInput.completionReports = Array.from({ length: 1000 }, () =>
    structuredClone(report),
  );
  // Repeated full source copies are valid structural input but must consume traversal budget.
  const row = candidate.body.projectionInput.nutrition[0];
  if (!row) throw Error('fixture');
  candidate.body.projectionInput.nutrition = Array.from({ length: 1000 }, () =>
    structuredClone(row),
  );
  const result = enumerateRaceManualReviewCopiedSourcesV2(reseal(candidate));
  expect(result.allCopiedBodiesIndexed).toBe(false);
  expect(result.blockers.some((r) => r.reason === 'reference_bound')).toBe(true);
});

it('guards external inventory accessors and aggregate output bytes', () => {
  let called = false;
  const bad = Object.defineProperty({}, 'refs', {
    enumerable: true,
    get() {
      called = true;
      return [];
    },
  });
  expect(raceManualReviewSourceInventoryV2Schema.safeParse(bad).success).toBe(false);
  expect(called).toBe(false);
  const output = enumerateRaceManualReviewCopiedSourcesV2(assembled());
  const entry = output.refs[0];
  if (!entry) throw Error('fixture');
  entry.copiedLocations = ['x'.repeat(4194304)];
  expect(raceManualReviewSourceInventoryV2Schema.safeParse(output).success).toBe(false);
});

it('indexes independent unplanned original blueprint/run at exact candidate locations', () => {
  const { input: projectionInput } = routineInput();
  const scheduled = projectionInput.routines[0];
  if (!scheduled) throw Error('fixture');
  const run = routineRunSchema.parse({
    ...scheduled.runs[0],
    origin: { kind: 'unplanned' },
    id: 'Run-食',
  });
  projectionInput.routines = [];
  projectionInput.retainedUnplannedRuns = [{ blueprint: scheduled.blueprint, run }];
  const value = input();
  value.projectionInput = projectionInput;
  const result = enumerateRaceManualReviewCopiedSourcesV2(assembled(value));
  expect(result.inventoryState).toBe('mapped');
  const ref = result.refs.find(
    (row) => row.identity.kind === 'routine-run' && row.identity.sourceId === run.id,
  );
  expect(ref?.copiedLocations).toEqual([
    'body.projectionInput.retainedUnplannedRuns[0].run',
    'body.projection.retainedUnplannedRuns[0].run',
  ]);
});
