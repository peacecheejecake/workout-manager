import { expect, it } from 'vitest';
import {
  routineBlueprintVersionSchema,
  routineRunSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
} from '@workout/contracts/routines';
import {
  routineReadSourcesProjectionSchema,
  validateRoutineReadSources,
} from '../src/race-plan-impact-routine-manifest.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-07T00:00:00.000Z';
function fixture(performed = true) {
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: id(1),
    versionId: id(2),
    title: 'Checklist',
    intent: 'User action',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'review',
        title: 'Review',
        content: { kind: 'checklist', prompt: 'Review condition' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: at,
  });
  const ref = { kind: 'checklist_confirmation', id: id(4), revisionId: id(5) };
  const run = routineRunSchema.parse({
    id: id(3),
    revision: performed ? 1 : 0,
    blueprint: { id: id(1), versionId: id(2) },
    origin: { kind: 'unplanned' },
    state: 'in_progress',
    progress: performed
      ? [
          {
            stepId: 'review',
            revision: 1,
            state: 'performed',
            actualRefs: [ref],
            occurredAt: at,
            recordedAt: at,
            reason: null,
          },
        ]
      : [],
    selectedChoices: {},
    startedAt: at,
    endedAt: null,
  });
  return routineReadSourcesProjectionSchema.parse({
    manifest: {
      uniqueSourceCount: performed ? 2 : 1,
      occurrences: [],
      runs: [
        {
          record: run,
          historyDigest: digest(run),
          actuals: performed
            ? [
                {
                  stepId: 'review',
                  fact: {
                    requested: ref,
                    state: 'current',
                    reason: null,
                    current: { id: id(4), revisionId: id(5) },
                    content: {
                      id: id(4),
                      run_id: id(3),
                      step_id: 'review',
                      revision_id: id(5),
                      occurred_at: at,
                      state: 'performed',
                    },
                  },
                },
              ]
            : [],
        },
      ],
      blueprints: [
        {
          record: blueprint,
          version: 1,
          currentHead: {
            state: 'present',
            versionId: id(2),
            version: 1,
            visibility: 'active',
            favorite: false,
          },
          unsupportedContent: [],
        },
      ],
      schedules: [],
      actualRosters: { activities: [], intake: [], recovery: [] },
    },
    timerReads: [{ run, timers: [] }],
  });
}
function run(c: ReturnType<typeof fixture>) {
  const r = c.manifest.runs[0];
  if (!r) throw Error('fixture');
  return r;
}
function blueprint(c: ReturnType<typeof fixture>) {
  const b = c.manifest.blueprints[0];
  if (!b) throw Error('fixture');
  return b;
}
function actual(c: ReturnType<typeof fixture>) {
  const a = run(c).actuals[0];
  if (!a) throw Error('fixture');
  return a;
}
function sync(c: ReturnType<typeof fixture>) {
  const r = run(c);
  r.historyDigest = digest(r.record);
  const read = c.timerReads?.[0];
  if (read) read.run = structuredClone(r.record);
}
function reasons(c: unknown) {
  return validateRoutineReadSources(c).blockers.map((b) => b.reason);
}
function planned(c: ReturnType<typeof fixture>) {
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: id(6),
    versionId: id(7),
    blueprint: { id: id(1), versionId: id(2) },
    state: 'active',
    window: {
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'UTC',
      maxOccurrences: 1,
    },
    rule: { kind: 'dates', dates: ['2026-10-07'], localTime: null },
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: id(8),
    schedule: { id: id(6), versionId: id(7) },
    blueprint: { id: id(1), versionId: id(2) },
    anchorKey: 'date:2026-10-07',
    scheduledAt: null,
    timingStatus: 'unresolved',
    stepBindings: [],
    selectedChoices: {},
  });
  c.manifest.schedules = [
    {
      scheduleId: id(6),
      versionId: id(7),
      sourcePlanVersionId: null,
      record: schedule,
      currentHead: { state: 'present', versionId: id(7), notificationMuted: false },
    },
  ];
  c.manifest.occurrences = [
    {
      record: occurrence,
      currentSchedule: { state: 'present', versionId: id(7) },
      startedRun: { state: 'present', runId: id(3), revision: run(c).record.revision },
    },
  ];
  run(c).record.origin = { kind: 'planned', occurrenceId: id(8) };
  c.manifest.uniqueSourceCount++;
  sync(c);
}
it('validates a nonempty exact checklist run readonly portion without claiming performance or full history', () => {
  const c = fixture(),
    before = JSON.stringify(c),
    result = validateRoutineReadSources(c);
  expect(result).toMatchObject({
    status: 'validated_read_sources',
    authority: 'none',
    freshness: 'not_checked',
    historyCoverage: 'current_revision_only',
    blockers: [],
  });
  expect(JSON.stringify(c)).toBe(before);
});
it('admits an actual closed empty manifest without timer inventory', () => {
  const c = fixture();
  c.manifest.runs = [];
  c.manifest.blueprints = [];
  c.manifest.uniqueSourceCount = 0;
  delete c.timerReads;
  expect(validateRoutineReadSources(c).status).toBe('validated_read_sources');
});
it('preserves revision zero and no actual refs for initial run', () => {
  const c = fixture(false);
  expect(run(c).record.revision).toBe(0);
  expect(validateRoutineReadSources(c).status).toBe('validated_read_sources');
});
it('does not infer timer absence from omitted port', () => {
  const c = fixture();
  delete c.timerReads;
  expect(reasons(c)).toContain('timer_inventory_missing');
});
it('requires current history digest equality without claiming complete historical roster', () => {
  const c = fixture();
  run(c).historyDigest = '0'.repeat(64);
  expect(reasons(c)).toContain('history_mismatch');
});
it('requires frozen blueprint rather than substituting current head', () => {
  const c = fixture();
  blueprint(c).record.versionId = id(99);
  expect(reasons(c)).toContain('frozen_source_missing');
});
it('retains old frozen blueprint despite newer current head', () => {
  const c = fixture();
  blueprint(c).currentHead = {
    state: 'present',
    versionId: id(99),
    version: 2,
    visibility: 'active',
    favorite: false,
  };
  expect(validateRoutineReadSources(c).status).toBe('validated_read_sources');
});
it('rejects foreign run association in checklist source', () => {
  const c = fixture();
  actual(c).fact.content = {
    id: id(4),
    run_id: id(99),
    step_id: 'review',
    revision_id: id(5),
    occurred_at: at,
    state: 'performed',
  };
  expect(reasons(c)).toContain('actual_membership_mismatch');
});
it('rejects missing current checklist fact rather than treating it as skipped', () => {
  const c = fixture();
  run(c).actuals = [];
  expect(reasons(c)).toContain('actual_membership_mismatch');
});
it('keeps unavailable source distinct from null/no actual', () => {
  const c = fixture();
  Object.assign(actual(c).fact, {
    state: 'unavailable',
    reason: 'owned_reference_unavailable',
    content: null,
    current: null,
  });
  expect(reasons(c)).toContain('actual_source_unavailable');
});
it('rejects wrong revision or timestamp for actual checklist confirmation', () => {
  const c = fixture();
  actual(c).fact.content = {
    id: id(4),
    run_id: id(3),
    step_id: 'review',
    revision_id: id(99),
    occurred_at: '2026-10-07T00:00:01.000Z',
    state: 'performed',
  };
  expect(reasons(c)).toContain('actual_membership_mismatch');
});
it('validates exact unresolved occurrence/schedule and started run association without invented date', () => {
  const c = fixture();
  planned(c);
  expect(validateRoutineReadSources(c).status).toBe('validated_read_sources');
  expect(c.manifest.occurrences[0]?.record.scheduledAt).toBeNull();
});
it('rejects missing frozen schedule', () => {
  const c = fixture();
  planned(c);
  c.manifest.schedules = [];
  expect(reasons(c)).toContain('frozen_source_missing');
});
it('rejects started-run revision mismatch', () => {
  const c = fixture();
  planned(c);
  const o = c.manifest.occurrences[0];
  if (!o) throw Error('fixture');
  o.startedRun = { state: 'present', runId: id(3), revision: 99 };
  expect(reasons(c)).toContain('source_identity_mismatch');
});
it('blocks consumed planned-reference membership port explicitly', () => {
  const c = fixture();
  planned(c);
  const o = c.manifest.occurrences[0];
  if (!o) throw Error('fixture');
  o.record.stepBindings = [
    {
      stepId: 'review',
      plannedRef: { domain: 'nutrition', planId: id(9), versionId: id(10), itemId: 'food' },
    },
  ];
  expect(reasons(c)).toContain('planned_reference_port_missing');
});
it('rejects duplicate run/actual identities and source count mismatch', () => {
  const c = fixture();
  c.manifest.runs.push(structuredClone(run(c)));
  expect(reasons(c)).toContain('source_identity_mismatch');
  const d = fixture();
  run(d).actuals.push(structuredClone(actual(d)));
  expect(reasons(d)).toContain('source_identity_mismatch');
});
it('rejects duplicate logical run IDs differing by UUID case', () => {
  const c = fixture();
  const copy = structuredClone(run(c));
  copy.record.id = copy.record.id.toUpperCase();
  copy.historyDigest = digest(copy.record);
  c.manifest.runs.push(copy);
  expect(reasons(c)).toContain('source_identity_mismatch');
});
it('validates pending timer as presentation without creating an actual', () => {
  const c = fixture(false);
  const read = c.timerReads?.[0];
  if (!read) throw Error('fixture');
  read.timers = [
    {
      runId: id(3),
      stepId: 'review',
      revision: 1,
      state: 'running',
      durationSeconds: 30,
      startedAt: at,
      pausedAt: null,
      pausedMilliseconds: 0,
    },
  ];
  expect(validateRoutineReadSources(c).status).toBe('validated_read_sources');
  expect(run(c).record.progress).toEqual([]);
});
it('rejects timer zero duration and preserves zero paused milliseconds', () => {
  const c = fixture(false);
  const read = c.timerReads?.[0];
  if (!read) throw Error('fixture');
  expect(
    reasons({
      ...c,
      timerReads: [
        {
          run: read.run,
          timers: [
            {
              runId: id(3),
              stepId: 'review',
              revision: 1,
              state: 'running',
              durationSeconds: 0,
              startedAt: at,
              pausedAt: null,
              pausedMilliseconds: 0,
            },
          ],
        },
      ],
    }),
  ).toContain('invalid_projection');
});
it('rejects timer foreign run/step and paused-null contradictions', () => {
  const c = fixture(false);
  const read = c.timerReads?.[0];
  if (!read) throw Error('fixture');
  read.timers = [
    {
      runId: id(99),
      stepId: 'foreign',
      revision: 1,
      state: 'paused',
      durationSeconds: 30,
      startedAt: at,
      pausedAt: null,
      pausedMilliseconds: 0,
    },
  ];
  expect(reasons(c)).toContain('timer_source_mismatch');
});
it('rejects stale timer read run body', () => {
  const c = fixture();
  const read = c.timerReads?.[0];
  if (!read) throw Error('fixture');
  read.run = { ...read.run, revision: 2 };
  expect(reasons(c)).toContain('timer_source_mismatch');
});
it('rejects invalid choice membership', () => {
  const c = fixture();
  run(c).record.selectedChoices = { foreign: 'review' };
  sync(c);
  expect(reasons(c)).toContain('actual_membership_mismatch');
});
it.each([
  null,
  {},
  { ...fixture(), authorized: true },
  { ...fixture(), manifest: { ...fixture().manifest, runs: [null] } },
])('rejects malformed unknown boundary %#', (value) => {
  expect(reasons(value)).toContain('invalid_projection');
});
it('bounds total serialization before parse', () => {
  expect(reasons({ ...fixture(), noise: 'x'.repeat(4194305) })).toContain('bounds_exceeded');
});
it('handles cyclic input without throwing', () => {
  const c: { cycle?: unknown } = {};
  c.cycle = c;
  expect(reasons(c)).toContain('invalid_projection');
});

function activity(c: ReturnType<typeof fixture>) {
  const b = blueprint(c);
  const step = b.record.steps[0];
  if (!step) throw Error('fixture');
  step.content = { kind: 'workout_template', ref: { id: id(9), versionId: id(10) } };
  const ref = {
    kind: 'activity' as const,
    id: id(11),
    revisionId: '1',
    detailId: null,
    allocationId: null,
  };
  const original = {
    title: null,
    kind: 'unknown' as const,
    startedAt: null,
    durationSeconds: 0,
    durationKind: 'unknown' as const,
    timezone: null,
    distanceMeters: null,
  };
  run(c).record.progress = [
    {
      stepId: 'review',
      revision: 1,
      state: 'performed',
      actualRefs: [ref],
      occurredAt: at,
      recordedAt: at,
      reason: null,
    },
  ];
  run(c).actuals = [
    {
      stepId: 'review',
      fact: {
        requested: ref,
        state: 'current',
        reason: null,
        current: { id: id(11), revision: 1, deleted: false },
        content: { original, overlay: null, detail: null },
      },
    },
  ];
  c.manifest.actualRosters.activities = [
    {
      id: id(11),
      revision: 1,
      deleted: false,
      originalDigest: digest(original),
      overlayDigest: digest(null),
      source: {
        state: 'present',
        kind: 'healthkit',
        sourceId: id(12),
        sourceRevision: 1,
        contentHash: '1'.repeat(64),
      },
    },
  ];
  sync(c);
}
it('keeps actual activity zero/null facts typed while blocking missing provider permission', () => {
  const c = fixture();
  activity(c);
  const before = JSON.stringify(c);
  expect(reasons(c)).toContain('actual_permission_port_missing');
  expect(reasons(c)).not.toContain('actual_membership_mismatch');
  expect(JSON.stringify(c)).toBe(before);
});
it('rejects activity copied body that differs from owned roster digest', () => {
  const c = fixture();
  activity(c);
  const a = actual(c);
  a.fact.content = {
    original: {
      title: null,
      kind: 'unknown',
      startedAt: null,
      durationSeconds: 5,
      durationKind: 'unknown',
      timezone: null,
      distanceMeters: null,
    },
    overlay: null,
    detail: null,
  };
  expect(reasons(c)).toContain('actual_membership_mismatch');
});
it('does not admit unsupported allocations by merely supplying current activity body', () => {
  const c = fixture();
  activity(c);
  const ref = {
    kind: 'activity' as const,
    id: id(11),
    revisionId: '1',
    detailId: null,
    allocationId: id(99),
  };
  const p = run(c).record.progress[0];
  if (!p) throw Error('fixture');
  p.actualRefs = [ref];
  actual(c).fact.requested = ref;
  sync(c);
  expect(reasons(c)).toContain('actual_membership_mismatch');
});
it('bounds a schema-valid raw frozen blueprint body at actual SQL0231MiB', () => {
  const c = fixture();
  blueprint(c).record.intent = 'x'.repeat(1048577);
  expect(reasons(c)).toContain('bounds_exceeded');
});
it('requires exact external plan source port for schedule copy', () => {
  const c = fixture();
  planned(c);
  const schedule = c.manifest.schedules[0];
  if (!schedule) throw Error('fixture');
  schedule.sourcePlanVersionId = id(99);
  expect(reasons(c)).toContain('planned_reference_port_missing');
});
it('rejects unsupported content inventory mismatch', () => {
  const c = fixture(false);
  const step = blueprint(c).record.steps[0];
  if (!step) throw Error('fixture');
  step.content = { kind: 'recovery_method', ref: { id: id(9), versionId: id(10) } };
  expect(reasons(c)).toContain('source_identity_mismatch');
});
it('rejects missing revision-history field at unknown boundary', () => {
  const c = fixture();
  expect(
    reasons({
      ...c,
      manifest: { ...c.manifest, runs: [{ record: run(c).record, actuals: run(c).actuals }] },
    }),
  ).toContain('invalid_projection');
});
it('rejects checklist state mismatch rather than turning completion into actual evidence', () => {
  const c = fixture();
  actual(c).fact.content = {
    id: id(4),
    run_id: id(3),
    step_id: 'review',
    revision_id: id(5),
    occurred_at: at,
    state: 'partial',
  };
  expect(reasons(c)).toContain('actual_membership_mismatch');
});
it('preserves existing SQL023 blueprint capacity above512KiB within1MiB', () => {
  const c = fixture();
  blueprint(c).record.intent = 'x'.repeat(600000);
  expect(validateRoutineReadSources(c).status).toBe('validated_read_sources');
});
