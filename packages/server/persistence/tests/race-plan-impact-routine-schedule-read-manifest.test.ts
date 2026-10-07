import { expect, it } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  routineScheduleReadManifestProjectionSchema,
  validateRoutineScheduleReadManifest,
  type RoutineScheduleReadManifestProjection,
} from '../src/race-plan-impact-routine-schedule-read-manifest.js';
const planId = '10000000-0000-4000-8000-000000000001';
const historicalId = '10000000-0000-4000-8000-000000000002';
function fixture(): RoutineScheduleReadManifestProjection {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const snapshot = planSnapshotSchema.parse({
    id: planId,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    draft: {
      title: 'Synthetic',
      timezone: 'UTC',
      periods: levels.map((level, i) => ({
        id: level,
        parentId: i ? levels[i - 1] : null,
        level,
        title: level,
        startDate: '2026-10-01',
        endDateExclusive: '2026-10-20',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'Session',
          blockId: 'block',
          date: '2026-10-06',
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
  const record = {
    schemaVersion: 4,
    id: 'schedule',
    versionId: 'saved',
    blueprint: { id: 'blueprint', versionId: 'blueprint-saved' },
    window: {
      startDate: '2026-10-01',
      endDateExclusive: '2026-10-25',
      timezone: 'UTC',
      maxOccurrences: 100,
    },
    rule: { kind: 'session_links', sessionIds: ['Session'], point: 'end', offsetMinutes: 0 },
    state: 'active',
  };
  return routineScheduleReadManifestProjectionSchema.parse({
    athleteId: 'synthetic',
    currentTraining: { aggregateId: planId, snapshot },
    sourcePlans: [snapshot],
    blueprints: [
      {
        schemaVersion: 4,
        routineId: 'blueprint',
        versionId: 'blueprint-saved',
        title: 'Synthetic',
        intent: '',
        status: 'published',
        tags: [],
        steps: [],
        choiceGroups: [],
        estimatedDurationSeconds: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    schedules: [
      {
        scheduleId: 'schedule',
        versionId: 'saved',
        sourcePlanVersionId: planId,
        record,
        currentHead: { state: 'present', versionId: 'saved', notificationMuted: false },
      },
    ],
    routines: [
      {
        aggregateId: 'schedule',
        versionId: 'saved',
        record,
        sourceVersionId: planId,
        sourceRelation: 'current',
        affected: true,
      },
    ],
    affectedRoutineIds: ['schedule'],
    calendarIntent: {
      athleteId: 'synthetic',
      event: {
        id: planId,
        revision: 1,
        title: 'Synthetic',
        localDate: '2026-10-06',
        localStartTime: null,
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
      newLocalDate: '2026-10-07',
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: planId,
        periodId: 'season',
        newStartDate: '2026-10-02',
        scope: 'descendants_and_sessions',
      },
      completionReports: [],
    },
  });
}
function row(c: RoutineScheduleReadManifestProjection) {
  const schedule = c.schedules[0],
    routine = c.routines[0],
    plan = c.sourcePlans[0];
  if (!schedule || !routine || !plan || !c.calendarIntent) throw new Error('Fixture incomplete');
  return { schedule, routine, plan, intent: c.calendarIntent };
}
const reasons = (input: unknown) =>
  validateRoutineScheduleReadManifest(input).blockers.map((b) => b.reason);
it('validates actual current frozen before and separately calculated hypothetical after without mutation or authority', () => {
  const c = fixture(),
    copy = structuredClone(c),
    result = validateRoutineScheduleReadManifest(c);
  expect(result.status).toBe('validated_read_scope');
  expect(result).toMatchObject({
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
    affectedRoutineIds: ['schedule'],
  });
  expect(result.remaining).toHaveLength(5);
  expect(result.timings[0]?.before).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-10-06T07:00:00.000Z' }],
  });
  expect(result.timings[0]?.after).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-10-07T07:00:00.000Z' }],
  });
  expect(c).toEqual(copy);
});
it('validates period_days using actual changed period membership', () => {
  const c = fixture(),
    { schedule, routine } = row(c);
  schedule.record.rule = {
    kind: 'period_days',
    periodId: 'block',
    offsetsDays: [0],
    localTime: '08:00:00',
  };
  routine.record = structuredClone(schedule.record);
  const result = validateRoutineScheduleReadManifest(c);
  expect(result.status).toBe('validated_read_scope');
  expect(result.timings[0]?.after).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-10-02T08:00:00.000Z' }],
  });
});
it('historical source remains frozen and unaffected when current head changes', () => {
  const c = fixture(),
    { schedule, routine, plan } = row(c);
  const old = structuredClone(plan);
  old.id = historicalId;
  c.sourcePlans.push(old);
  schedule.sourcePlanVersionId = historicalId;
  routine.sourceVersionId = historicalId;
  routine.sourceRelation = 'historical';
  routine.affected = false;
  c.affectedRoutineIds = [];
  const result = validateRoutineScheduleReadManifest(c);
  expect(result.status).toBe('validated_read_scope');
  expect(result.timings[0]?.after).toBeNull();
  expect(result.timings[0]?.before).toMatchObject({
    state: 'expanded',
    occurrences: [{ scheduledAt: '2026-10-06T07:00:00.000Z' }],
  });
});
it('historical schedule keeps exact immutable body beside current schedule', () => {
  const c = fixture(),
    { schedule } = row(c);
  const old = structuredClone(schedule);
  old.versionId = 'old';
  old.record.versionId = 'old';
  c.schedules.push(old);
  expect(validateRoutineScheduleReadManifest(c).status).toBe('validated_read_scope');
  expect(
    validateRoutineScheduleReadManifest(c).timings.find((t) => t.scheduleVersionId === 'old')
      ?.after,
  ).toBeNull();
});
for (const affected of [false, true])
  it(`preserves ${affected ? 'affected' : 'unrelated'} unresolved without inventing time`, () => {
    const c = fixture(),
      { plan, routine, intent } = row(c);
    const session = plan.draft.sessions[0];
    if (!session) throw new Error('No session');
    session.durationSeconds = null;
    c.currentTraining = { aggregateId: planId, snapshot: structuredClone(plan) };
    if (!affected) {
      intent.selection = { kind: 'keep_plan' };
      routine.affected = false;
      c.affectedRoutineIds = [];
    }
    const r = validateRoutineScheduleReadManifest(c);
    expect(r.status).toBe('validated_read_scope');
    expect(r.timings[0]?.notice).toBe(
      affected ? 'affected_unresolved_requires_resolution' : 'existing_unresolved_preserved',
    );
    expect(r.timings[0]?.before).toMatchObject({
      state: 'expanded',
      occurrences: [{ scheduledAt: null, timingStatus: 'unresolved' }],
    });
  });
it('ended schedule remains retained without hypothetical rewriting', () => {
  const c = fixture(),
    { schedule, routine } = row(c);
  schedule.record.state = 'ended';
  routine.record = structuredClone(schedule.record);
  const r = validateRoutineScheduleReadManifest(c);
  expect(r.status).toBe('validated_read_scope');
  expect(r.timings[0]).toMatchObject({ after: null, notice: 'ended_schedule_preserved' });
});
it('allows exact source read without calendar port only when no claimed affected scope', () => {
  const c = fixture(),
    { routine } = row(c);
  delete c.calendarIntent;
  routine.affected = false;
  c.affectedRoutineIds = [];
  expect(validateRoutineScheduleReadManifest(c).status).toBe('validated_read_scope');
});
it('blocks bare affected roster without actual selection port', () => {
  const c = fixture();
  delete c.calendarIntent;
  expect(reasons(c)).toContain('affected_selection_port_missing');
});
for (const [name, mutate, reason] of [
  [
    'foreign intent',
    (c: RoutineScheduleReadManifestProjection) => {
      row(c).intent.athleteId = 'foreign';
    },
    'foreign_source',
  ],
  [
    'wrong current CAS',
    (c: RoutineScheduleReadManifestProjection) => {
      const i = row(c).intent;
      if (i.selection.kind === 'move_period')
        i.selection.expectedCurrentPlanVersionId = historicalId;
    },
    'calendar_projection_rejected',
  ],
  [
    'missing source',
    (c: RoutineScheduleReadManifestProjection) => {
      c.sourcePlans = [];
    },
    'source_plan_missing',
  ],
  [
    'wrong source body',
    (c: RoutineScheduleReadManifestProjection) => {
      row(c).plan.draft.title = 'Changed';
    },
    'source_identity_mismatch',
  ],
  [
    'missing blueprint',
    (c: RoutineScheduleReadManifestProjection) => {
      c.blueprints = [];
    },
    'blueprint_missing',
  ],
  [
    'wrong schedule identity',
    (c: RoutineScheduleReadManifestProjection) => {
      row(c).schedule.scheduleId = 'foreign';
    },
    'source_identity_mismatch',
  ],
  [
    'wrong head',
    (c: RoutineScheduleReadManifestProjection) => {
      row(c).schedule.currentHead = {
        state: 'present',
        versionId: 'foreign',
        notificationMuted: false,
      };
    },
    'source_identity_mismatch',
  ],
  [
    'wrong relation',
    (c: RoutineScheduleReadManifestProjection) => {
      row(c).routine.sourceRelation = 'historical';
    },
    'source_relation_mismatch',
  ],
  [
    'forged affected',
    (c: RoutineScheduleReadManifestProjection) => {
      row(c).routine.affected = false;
    },
    'affected_roster_mismatch',
  ],
  [
    'missing affected',
    (c: RoutineScheduleReadManifestProjection) => {
      c.affectedRoutineIds = [];
    },
    'affected_roster_mismatch',
  ],
  [
    'wrong session opaque case',
    (c: RoutineScheduleReadManifestProjection) => {
      const { schedule, routine } = row(c);
      schedule.record.rule = {
        kind: 'session_links',
        sessionIds: ['session'],
        point: 'start',
        offsetMinutes: 0,
      };
      routine.record = structuredClone(schedule.record);
    },
    'source_membership_mismatch',
  ],
  [
    'wrong timezone',
    (c: RoutineScheduleReadManifestProjection) => {
      const { schedule, routine } = row(c);
      schedule.record.window.timezone = 'Asia/Seoul';
      routine.record = structuredClone(schedule.record);
    },
    'source_timezone_mismatch',
  ],
  [
    'unused source',
    (c: RoutineScheduleReadManifestProjection) => {
      const p = structuredClone(row(c).plan);
      p.id = historicalId;
      c.sourcePlans.push(p);
    },
    'source_membership_mismatch',
  ],
  [
    'duplicate source',
    (c: RoutineScheduleReadManifestProjection) => {
      c.sourcePlans.push(structuredClone(row(c).plan));
    },
    'source_identity_mismatch',
  ],
  [
    'duplicate affected',
    (c: RoutineScheduleReadManifestProjection) => {
      c.affectedRoutineIds.push('schedule');
    },
    'source_identity_mismatch',
  ],
] as const)
  it(`blocks ${name}`, () => {
    const c = fixture();
    mutate(c);
    expect(reasons(c)).toContain(reason);
  });
it('rejects unknown permission booleans', () => {
  expect(reasons({ ...fixture(), sourceAuthorized: true })).toContain('invalid_projection');
});
it('preflights UTF8 4MiB input', () => {
  expect(reasons({ ...fixture(), extra: '원'.repeat(1400000) })).toContain('projection_limit');
});
it('rejects schedule roster beyond1000', () => {
  const c = fixture();
  const s = row(c).schedule;
  c.schedules = Array.from({ length: 1001 }, () => structuredClone(s));
  expect(reasons(c)).toContain('invalid_projection');
});
it('validates source-free date rules without inferring race linkage', () => {
  const c = fixture(),
    { schedule, routine } = row(c);
  schedule.sourcePlanVersionId = null;
  schedule.record.rule = { kind: 'dates', dates: ['2026-10-06'], localTime: null };
  routine.record = structuredClone(schedule.record);
  routine.sourceVersionId = null;
  routine.sourceRelation = 'absent';
  routine.affected = false;
  c.affectedRoutineIds = [];
  expect(validateRoutineScheduleReadManifest(c)).toMatchObject({
    status: 'validated_read_scope',
    affectedRoutineIds: [],
    timings: [{ after: null, notice: 'existing_unresolved_preserved' }],
  });
});
it('does not treat an unchanged actual calendar as affected', () => {
  const c = fixture(),
    { intent } = row(c);
  if (intent.selection.kind === 'move_period') intent.selection.newStartDate = '2026-10-01';
  expect(reasons(c)).toContain('affected_roster_mismatch');
});
it('preserves missing historical source as a specific blocked port instead of repinning current', () => {
  const c = fixture(),
    { schedule, routine } = row(c);
  schedule.sourcePlanVersionId = historicalId;
  routine.sourceVersionId = historicalId;
  routine.sourceRelation = 'historical';
  routine.affected = false;
  c.affectedRoutineIds = [];
  expect(reasons(c)).toContain('source_plan_missing');
});
it('rejects orphan historical current head not represented by current roster', () => {
  const c = fixture(),
    { schedule } = row(c);
  const old = structuredClone(schedule);
  old.versionId = 'old';
  old.record.versionId = 'old';
  old.currentHead = { state: 'present', versionId: 'invented', notificationMuted: false };
  c.schedules.push(old);
  expect(reasons(c)).toContain('source_identity_mismatch');
});
it('keeps unknown timing after bounded expansion failure observable without approving it', () => {
  const c = fixture(),
    { schedule, routine } = row(c);
  schedule.record.window.maxOccurrences = 101;
  routine.record = structuredClone(schedule.record);
  const r = validateRoutineScheduleReadManifest(c);
  expect(r.status).toBe('validated_read_scope');
  expect(r.timings[0]).toMatchObject({
    before: { state: 'unresolved', reason: 'EXPANSION_LIMIT_EXCEEDED' },
    after: { state: 'unresolved', reason: 'EXPANSION_LIMIT_EXCEEDED' },
    notice: 'affected_unresolved_requires_resolution',
  });
  expect(r.authority).toBe('none');
});
it('preflights aggregate source visits above5000', () => {
  const c = fixture(),
    { schedule, routine, plan, intent } = row(c);
  const b = c.blueprints[0];
  if (!b) throw new Error('No blueprint');
  c.schedules = Array.from({ length: 1000 }, () => structuredClone(schedule));
  c.routines = Array.from({ length: 1000 }, () => structuredClone(routine));
  c.sourcePlans = Array.from({ length: 1000 }, () => structuredClone(plan));
  c.blueprints = Array.from({ length: 1000 }, () => structuredClone(b));
  c.affectedRoutineIds = Array.from({ length: 1000 }, () => 'schedule');
  intent.completionReports = [
    {
      sessionId: 'Session',
      revision: 1,
      planVersionId: planId,
      schedule: {
        blockId: 'block',
        date: '2026-10-06',
        localStartTime: '07:00:00',
        timezone: 'UTC',
      },
      status: 'completed',
      reportedAt: '2026-10-06T07:00:00Z',
      reason: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'session-completion-v1',
    },
  ];
  expect(reasons(c)).toContain('projection_limit');
});
it('validates same-start selection with an empty exact affected roster', () => {
  const c = fixture(),
    { intent, routine } = row(c);
  if (intent.selection.kind === 'move_period') intent.selection.newStartDate = '2026-10-01';
  routine.affected = false;
  c.affectedRoutineIds = [];
  const r = validateRoutineScheduleReadManifest(c);
  expect(r.status).toBe('validated_read_scope');
  expect(r.affectedRoutineIds).toEqual([]);
  expect(r.timings[0]?.after).toBeNull();
});
it('stops derived expansion above5000 without returning an oversized timing roster', () => {
  const c = fixture(),
    { schedule, routine, intent } = row(c);
  const dates = Array.from({ length: 100 }, (_, i) => {
    const d = new Date('2026-01-01T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  schedule.sourcePlanVersionId = null;
  schedule.record.rule = { kind: 'dates', dates, localTime: null };
  schedule.record.window = {
    startDate: '2026-01-01',
    endDateExclusive: '2026-05-01',
    timezone: 'UTC',
    maxOccurrences: 100,
  };
  routine.sourceVersionId = null;
  routine.sourceRelation = 'absent';
  routine.affected = false;
  intent.selection = { kind: 'keep_plan' };
  c.affectedRoutineIds = [];
  c.schedules = Array.from({ length: 51 }, (_, i) => {
    const s = structuredClone(schedule);
    s.scheduleId = `schedule${i}`;
    s.versionId = `version${i}`;
    s.record.id = s.scheduleId;
    s.record.versionId = s.versionId;
    s.currentHead = { state: 'present', versionId: s.versionId, notificationMuted: false };
    return s;
  });
  c.routines = c.schedules.map((s) => ({
    ...structuredClone(routine),
    aggregateId: s.scheduleId,
    versionId: s.versionId,
    record: structuredClone(s.record),
  }));
  const r = validateRoutineScheduleReadManifest(c);
  expect(r.blockers).toContainEqual({ path: 'timings', reason: 'projection_limit' });
  expect(r.timings).toEqual([]);
});
