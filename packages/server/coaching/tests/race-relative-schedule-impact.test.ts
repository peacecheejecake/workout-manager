import { expect, it, vi } from 'vitest';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import {
  projectRaceRelativeScheduleImpact,
  type RaceRelativeScheduleImpactInput,
  type RaceScheduleCalculationPorts,
} from '../src/race-relative-schedule-impact.js';
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing synthetic fixture');
  return value;
}
const planId = '10000000-0000-4000-8000-000000000001',
  eventId = '20000000-0000-4000-8000-000000000001';
function fixture(): RaceRelativeScheduleImpactInput {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const plan = planSnapshotSchema.parse({
    id: planId,
    version: 1,
    createdAt: '2026-03-01T00:00:00Z',
    draft: {
      title: 'Synthetic',
      timezone: 'America/New_York',
      periods: levels.map((level, index) => ({
        id: level,
        parentId: index === 0 ? null : levels[index - 1],
        level,
        title: level,
        startDate: '2026-03-01',
        endDateExclusive: '2026-04-01',
        timezone: 'America/New_York',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: eventId,
          blockId: 'block',
          date: '2026-03-07',
          localStartTime: '07:00:00',
          title: 'Synthetic planned',
          sport: 'running',
          durationSeconds: null,
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
  const event = raceEventSchema.parse({
    id: eventId,
    revision: 1,
    title: 'Synthetic race',
    localDate: '2026-03-07',
    localStartTime: '07:00:00',
    timezone: 'America/New_York',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: planId,
  });
  const versionId = '30000000-0000-4000-8000-000000000001';
  const record = nutritionPlanVersionSchema.parse({
    planId: '30000000-0000-4000-8000-000000000002',
    versionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-03-01', toInclusive: '2026-03-31' },
    timezone: 'America/New_York',
    purpose: 'Synthetic',
    linkedTrainingPlanVersionId: planId,
    approvedAt: '2026-03-01T00:00:00Z',
    approvalId: '30000000-0000-4000-8000-000000000003',
    items: [
      ['race-start', 'race', 'start', eventId],
      ['session', 'session', 'start', eventId],
      ['race-end', 'race', 'end', eventId],
      ['unrelated', 'race', 'start', '20000000-0000-4000-8000-000000000002'],
    ].map(([id, entity, point, entityId]) => ({
      id,
      planVersionId: versionId,
      category: 'before',
      title: 'Synthetic timing',
      anchor: { kind: 'relative', entity, entityId, point, offsetMinutes: 0 },
      foods: [],
      targets: [],
      instructions: 'Review timing',
      evidenceIds: [],
      source: 'user_confirmed',
    })),
  });
  return {
    event,
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
            item.id === 'unrelated' || item.id === 'race-end'
              ? { state: 'unresolved', reason: 'missing_anchor' }
              : { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
        })),
      },
    ],
    routines: [],
    resolutions: { nutrition: [], routines: [] },
  };
}
function moved() {
  const input = fixture();
  input.selection = {
    kind: 'move_period',
    expectedCurrentPlanVersionId: planId,
    periodId: 'season',
    newStartDate: '2026-03-03',
    scope: 'descendants_and_sessions',
  };
  return input;
}
function routine() {
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: 'blueprint',
    versionId: 'blueprint-v1',
    title: 'Frozen',
    intent: '',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Checklist',
        content: { kind: 'checklist', prompt: 'Synthetic' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
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
      timezone: 'America/New_York',
      maxOccurrences: 2,
    },
    rule: { kind: 'session_links', sessionIds: [eventId], point: 'start', offsetMinutes: 0 },
    state: 'active',
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: 'occurrence',
    schedule: { id: record.id, versionId: record.versionId },
    blueprint: record.blueprint,
    anchorKey: `${eventId}:start`,
    scheduledAt: '2026-03-07T12:00:00Z',
    timingStatus: 'resolved',
    stepBindings: [],
    selectedChoices: {},
  });
  return { record, sourcePlanVersionId: planId, blueprint, occurrences: [occurrence], runs: [] };
}
/** Deliberate unit calculation fixtures. They do not establish real runtime DST/DB/recurrence acceptance. */
function ports(): RaceScheduleCalculationPorts {
  return {
    resolveNutrition: vi.fn(
      (context: Parameters<RaceScheduleCalculationPorts['resolveNutrition']>[0]) => {
        const { item, event, sourcePlan } = context;
        const anchor = item.anchor;
        if (anchor.kind === 'absolute')
          return { state: 'resolved', date: anchor.date, localTime: anchor.localTime };
        return {
          state: 'resolved',
          date:
            anchor.entity === 'race'
              ? event.localDate
              : (sourcePlan?.sessions.find((session) => session.id === anchor.entityId)?.date ??
                '2026-03-09'),
          localTime: '07:00:00',
        };
      },
    ),
    expandRoutine: vi.fn(() => ({ state: 'unresolved', reason: 'UNSUPPORTED_MAPPING' })),
  };
}
function projected(input: unknown, calculations = ports()) {
  const result = projectRaceRelativeScheduleImpact(input, calculations);
  if (result.status !== 'projected') throw new Error(`Rejected: ${result.reason}`);
  return result;
}
function item(result: ReturnType<typeof projected>, id: string) {
  const value = result.nutrition[0]?.items.find((item) => item.itemId === id);
  if (!value) throw new Error('Missing synthetic item');
  return value;
}
it('keep_plan affects only the race namespace and preserves unrelated unresolved/no-call snapshots', () => {
  const input = fixture(),
    before = structuredClone(input),
    calculations = ports(),
    result = projected(input, calculations);
  expect(item(result, 'race-start')).toMatchObject({
    state: 'affected',
    after: { date: '2026-03-09' },
  });
  expect(item(result, 'session')).toMatchObject({
    state: 'unchanged',
    after: { date: '2026-03-07' },
  });
  expect(item(result, 'unrelated')).toMatchObject({
    state: 'unchanged',
    notice: 'existing_unresolved_preserved',
  });
  expect(item(result, 'unrelated').item).toEqual(input.nutrition[0]?.record.items[3]);
  expect(calculations.resolveNutrition).toHaveBeenCalledTimes(1);
  expect(item(result, 'race-end')).toMatchObject({
    after: { state: 'unresolved', reason: 'missing_race_end' },
  });
  expect(result.approval.status).toBe('blocked');
  expect(input).toEqual(before);
});
it('passes civil Plan date shifts across DST to the runtime port without changing timezone/clock/zero/null', () => {
  const input = moved(),
    calculations = ports(),
    result = projected(input, calculations);
  expect(item(result, 'session')).toMatchObject({
    state: 'affected',
    after: { date: '2026-03-09' },
  });
  expect(calculations.resolveNutrition).toHaveBeenCalledWith(
    expect.objectContaining({
      sourcePlan: expect.objectContaining({
        timezone: 'America/New_York',
        sessions: [
          expect.objectContaining({
            date: '2026-03-09',
            localStartTime: '07:00:00',
            distanceMeters: 0,
            durationSeconds: null,
          }),
        ],
      }),
    }),
  );
  expect(result.calendar.eventDate.deltaCalendarDays).toBe(2);
});
it('affected existing unresolved remains blocked even if automatic calculation becomes resolved', () => {
  const input = moved();
  required(input.nutrition[0]).timings = required(input.nutrition[0]).timings.map((entry) =>
    entry.itemId === 'session'
      ? { itemId: entry.itemId, timing: { state: 'unresolved', reason: 'ambiguous_local_time' } }
      : entry,
  );
  const first = projected(input);
  expect(item(first, 'session').notice).toBe('affected_unresolved_requires_resolution');
  input.resolutions.nutrition = [
    {
      planVersionId: required(input.nutrition[0]).record.versionId,
      itemId: 'session',
      action: 'replace_anchor',
      anchor: {
        kind: 'absolute',
        date: '2026-03-09',
        localTime: '07:00:00',
        timezone: 'America/New_York',
      },
    },
  ];
  const resolved = projected(input);
  expect(item(resolved, 'session')).toMatchObject({
    notice: null,
    resolution: { state: 'explicit', outcome: 'resolved' },
  });
  expect(resolved.approval.status).toBe('blocked');
});
it('requires explicit absolute reanchoring for unknown race end and never uses targetSeconds as an end', () => {
  const input = fixture();
  input.resolutions.nutrition = [
    {
      planVersionId: required(input.nutrition[0]).record.versionId,
      itemId: 'race-end',
      action: 'replace_anchor',
      anchor: {
        kind: 'absolute',
        date: '2026-03-09',
        localTime: '09:00:00',
        timezone: 'America/New_York',
      },
    },
  ];
  const result = projected(input);
  expect(item(result, 'race-end')).toMatchObject({
    after: { state: 'resolved', localTime: '09:00:00' },
    resolution: { state: 'explicit' },
  });
  expect(result.calendar.plan).toEqual(input.currentPlan?.draft);
  expect(result.approval.status).toBe('blocked');
});
it('missing race start never calls a resolver that could invent a time', () => {
  const input = fixture(),
    calculations = ports();
  input.event.localStartTime = null;
  const result = projected(input, calculations);
  expect(item(result, 'race-start')).toMatchObject({
    after: { state: 'unresolved', reason: 'missing_race_time' },
  });
  expect(calculations.resolveNutrition).not.toHaveBeenCalled();
});
it('preserves frozen blueprint, stopped actual refs and started occurrence while projecting unstarted schedules', () => {
  const input = moved(),
    context = routine();
  const run = routineRunSchema.parse({
    id: 'run',
    revision: 1,
    blueprint: context.record.blueprint,
    origin: { kind: 'planned', occurrenceId: 'occurrence' },
    state: 'stopped',
    progress: [
      {
        stepId: 'step',
        revision: 1,
        recordedAt: '2026-03-07T12:00:00Z',
        state: 'stopped',
        actualRefs: [
          { kind: 'checklist_confirmation', id: 'confirmation', revisionId: 'confirmation-v1' },
        ],
        occurredAt: '2026-03-07T12:00:00Z',
        reason: 'Synthetic stop',
      },
    ],
    selectedChoices: {},
    startedAt: '2026-03-07T12:00:00Z',
    endedAt: '2026-03-07T12:00:00Z',
  });
  input.routines = [{ ...context, runs: [run] }];
  const calculations = ports();
  calculations.expandRoutine = vi.fn(() => ({
    state: 'expanded',
    occurrences: [{ ...context.occurrences[0], scheduledAt: '2026-03-09T11:00:00Z' }],
  }));
  const result = projected(input, calculations),
    project = result.routines[0];
  expect(project?.runs).toEqual([run]);
  expect(project?.blueprint).toEqual(context.blueprint);
  expect(project?.projection?.retainedOccurrences).toEqual(context.occurrences);
  expect(project?.projection?.plannedOccurrences).toEqual([]);
  expect(calculations.expandRoutine).toHaveBeenCalledWith(
    expect.objectContaining({
      sourcePlan: expect.objectContaining({
        sessions: [expect.objectContaining({ date: '2026-03-09' })],
      }),
    }),
  );
});
it('unaffected and ended routines preserve snapshots without calling expansion', () => {
  const input = fixture(),
    context = routine();
  input.routines = [context];
  const calculations = ports(),
    result = projected(input, calculations);
  expect(result.routines[0]).toMatchObject({
    state: 'unchanged',
    occurrences: context.occurrences,
  });
  expect(calculations.expandRoutine).not.toHaveBeenCalled();
  const changed = moved();
  changed.routines = [{ ...context, record: { ...context.record, state: 'ended' } }];
  expect(projected(changed, calculations).routines[0]?.state).toBe('retained_ended');
  expect(calculations.expandRoutine).not.toHaveBeenCalled();
});
it('affected routine unresolved requires explicit rule resolution and preserves paused lifecycle', () => {
  const input = moved(),
    context = routine();
  required(context.occurrences[0]).scheduledAt = null;
  required(context.occurrences[0]).timingStatus = 'unresolved';
  input.routines = [{ ...context, record: { ...context.record, state: 'paused' } }];
  const calculations = ports();
  calculations.expandRoutine = vi.fn(() => ({
    state: 'expanded',
    occurrences: [
      { ...context.occurrences[0], timingStatus: 'resolved', scheduledAt: '2026-03-09T11:00:00Z' },
    ],
  }));
  expect(projected(input, calculations).routines[0]?.notice).toBe(
    'affected_unresolved_requires_resolution',
  );
  input.resolutions.routines = [
    {
      scheduleVersionId: context.record.versionId,
      action: 'replace_rule',
      rule: context.record.rule,
      window: context.record.window,
      sourcePlanVersionId: planId,
    },
  ];
  const resolved = projected(input, calculations);
  expect(resolved.routines[0]?.notice).toBeNull();
  expect(resolved.routines[0]?.projection?.proposed.state).toBe('paused');
  expect(resolved.approval.status).toBe('blocked');
});
it('propagates DST ambiguity/expansion failures and bounds recurrence without inventing timestamps', () => {
  const input = moved();
  input.routines = [routine()];
  const calculations = ports();
  calculations.resolveNutrition = vi.fn(() => ({
    state: 'unresolved',
    reason: 'ambiguous_local_time',
  }));
  expect(item(projected(input, calculations), 'session').after).toEqual({
    state: 'unresolved',
    reason: 'ambiguous_local_time',
  });
  required(input.routines[0]).record.window.maxOccurrences = 101;
  vi.mocked(calculations.expandRoutine).mockClear();
  expect(projected(input, calculations).routines[0]?.projection?.expansion).toEqual({
    state: 'unresolved',
    reason: 'EXPANSION_LIMIT_EXCEEDED',
  });
  expect(calculations.expandRoutine).not.toHaveBeenCalled();
});
it('preserves locked sessions and rejects moving their Block away before any schedule calculation', () => {
  const input = moved();
  required(required(input.currentPlan).draft.sessions[0]).locks.date = true;
  expect(item(projected(input), 'session').state).toBe('unchanged');
  input.selection = {
    ...input.selection,
    kind: 'move_period',
    expectedCurrentPlanVersionId: planId,
    periodId: 'season',
    newStartDate: '2026-04-03',
    scope: 'descendants_and_sessions',
  };
  const calculations = ports();
  expect(projectRaceRelativeScheduleImpact(input, calculations)).toMatchObject({
    status: 'rejected',
    reason: 'fixed_session_outside_block',
    approval: { status: 'blocked' },
  });
  expect(calculations.resolveNutrition).not.toHaveBeenCalled();
});
it('rejects unknown commands, unmatched/unaffected resolutions and forged source identity', () => {
  const input = fixture();
  expect(projectRaceRelativeScheduleImpact({ ...input, approve: true }, ports())).toMatchObject({
    status: 'rejected',
    reason: 'invalid_input',
  });
  input.resolutions.nutrition = [
    {
      planVersionId: required(input.nutrition[0]).record.versionId,
      itemId: 'session',
      action: 'replace_anchor',
      anchor: { kind: 'absolute', date: '2026-03-09', localTime: null, timezone: 'UTC' },
    },
  ];
  expect(projectRaceRelativeScheduleImpact(input, ports())).toMatchObject({
    status: 'rejected',
    reason: 'unsupported_resolution',
  });
  const forged = moved(),
    context = routine();
  required(context.occurrences[0]).blueprint.versionId = 'foreign';
  forged.routines = [context];
  expect(projectRaceRelativeScheduleImpact(forged, ports())).toMatchObject({
    status: 'rejected',
    reason: 'source_identity_mismatch',
  });
});
it('runtime decodes port outputs and rejects duplicate/foreign occurrences, unknown reasons and oversized results', () => {
  const input = moved(),
    calculations = ports();
  calculations.resolveNutrition = () => ({ state: 'unresolved', reason: 'invented' });
  expect(projectRaceRelativeScheduleImpact(input, calculations)).toMatchObject({
    status: 'rejected',
    reason: 'invalid_port_result',
  });
  const context = routine();
  input.routines = [context];
  calculations.resolveNutrition = ports().resolveNutrition;
  calculations.expandRoutine = () => ({
    state: 'expanded',
    occurrences: [context.occurrences[0], context.occurrences[0]],
  });
  expect(projectRaceRelativeScheduleImpact(input, calculations)).toMatchObject({
    status: 'rejected',
    reason: 'source_identity_mismatch',
  });
  calculations.expandRoutine = () => ({
    state: 'expanded',
    occurrences: [{ ...context.occurrences[0], schedule: { id: 'foreign', versionId: 'foreign' } }],
  });
  expect(projectRaceRelativeScheduleImpact(input, calculations)).toMatchObject({
    status: 'rejected',
    reason: 'invalid_port_result',
  });
  calculations.resolveNutrition = () => ({
    state: 'resolved',
    date: '2026-03-09',
    localTime: '07:00:00',
    payload: 'x'.repeat(4194304),
  });
  expect(projectRaceRelativeScheduleImpact(input, calculations)).toMatchObject({
    status: 'rejected',
    reason: 'projection_bound',
  });
  expect(
    projectRaceRelativeScheduleImpact({ payload: 'x'.repeat(4194304) }, ports()),
  ).toMatchObject({ status: 'rejected', reason: 'projection_bound' });
});
it('deterministically orders changed/unchanged results without changing source snapshots', () => {
  const input = fixture();
  required(input.nutrition[0]).record.items.reverse();
  required(input.nutrition[0]).timings.reverse();
  const before = structuredClone(input);
  const result = projected(input);
  expect(result.nutrition[0]?.items.map((item) => item.itemId)).toEqual([
    'race-end',
    'race-start',
    'session',
    'unrelated',
  ]);
  expect(input).toEqual(before);
  expect(projected(input)).toEqual(result);
});
it('preserves completed self reports and fixes their session while moving surrounding periods', () => {
  const input = moved();
  input.completionReports = [
    {
      sessionId: eventId,
      revision: 1,
      planVersionId: planId,
      schedule: {
        blockId: 'block',
        date: '2026-03-07',
        localStartTime: '07:00:00',
        timezone: 'America/New_York',
      },
      status: 'completed',
      reportedAt: '2026-03-08T00:00:00Z',
      reason: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'session-completion-v1',
    },
  ];
  const result = projected(input);
  expect(item(result, 'session').state).toBe('unchanged');
  expect(result.calendar.fixedSessionIds).toEqual([eventId]);
  expect(result.completionReports).toEqual(input.completionReports);
});
it('rejects a mutating calculation adapter without changing input or retained facts', () => {
  const input = fixture(),
    before = structuredClone(input),
    calculations = ports();
  calculations.resolveNutrition = ({ record }) => {
    record.items.length = 0;
    return { state: 'resolved', date: '2026-03-09', localTime: null };
  };
  expect(projectRaceRelativeScheduleImpact(input, calculations)).toMatchObject({
    status: 'rejected',
    reason: 'invalid_port_result',
  });
  expect(input).toEqual(before);
});
it('bounds nested Plan identities before invoking any calculation', () => {
  const input = fixture(),
    plan = required(input.currentPlan),
    calculations = ports();
  input.sourcePlans = Array.from({ length: 1000 }, (_, index) => ({
    ...plan,
    id: `10000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
  }));
  expect(projectRaceRelativeScheduleImpact(input, calculations)).toMatchObject({
    status: 'rejected',
    reason: 'projection_bound',
  });
  expect(calculations.resolveNutrition).not.toHaveBeenCalled();
  expect(calculations.expandRoutine).not.toHaveBeenCalled();
});

it.each(['x'.repeat(201), '한글항목'.repeat(60)])(
  'projects explicit replacement for a canonical long nutrition identity: %s',
  (itemId) => {
    const input = fixture();
    const context = required(input.nutrition[0]);
    context.record.items = context.record.items.map((entry) =>
      entry.id === 'race-end' ? { ...entry, id: itemId } : entry,
    );
    context.timings = context.timings.map((entry) =>
      entry.itemId === 'race-end' ? { ...entry, itemId } : entry,
    );
    input.resolutions.nutrition = [
      {
        planVersionId: context.record.versionId,
        itemId,
        action: 'replace_anchor',
        anchor: {
          kind: 'absolute',
          date: '2026-03-09',
          localTime: '09:00:00',
          timezone: 'America/New_York',
        },
      },
    ];
    expect(item(projected(input), itemId)).toMatchObject({
      after: { state: 'resolved', localTime: '09:00:00' },
      resolution: { state: 'explicit' },
    });
  },
);

for (const movedSource of [false, true])
  it(`retains ended unresolved bodies with notice only when source ${movedSource ? 'moves' : 'stays'}`, () => {
    const input = movedSource ? moved() : fixture(),
      context = routine(),
      calculations = ports();
    input.nutrition = []; // Isolate the ended branch from unrelated nutrition resolution requirements.
    context.record.state = 'ended';
    const occurrence = required(context.occurrences[0]);
    occurrence.scheduledAt = null;
    occurrence.timingStatus = 'unresolved';
    input.routines = [context];
    const original = structuredClone(context),
      result = projected(input, calculations);
    expect(result.routines[0]).toMatchObject({
      state: movedSource ? 'retained_ended' : 'unchanged',
      record: original.record,
      blueprint: original.blueprint,
      occurrences: original.occurrences,
      runs: original.runs,
      projection: null,
      notice: 'existing_unresolved_preserved',
    });
    expect(result.requiresResolution).toBe(false);
    expect(context).toEqual(original);
    expect(calculations.expandRoutine).not.toHaveBeenCalled();
    expect(result.approval.status).toBe('blocked'); // This pure projector still grants no authority.
  });
it('explicit ended rule resolution remains unsupported and never retimes its unresolved occurrence', () => {
  const input = moved(),
    context = routine(),
    calculations = ports();
  input.nutrition = [];
  context.record.state = 'ended';
  required(context.occurrences[0]).scheduledAt = null;
  required(context.occurrences[0]).timingStatus = 'unresolved';
  input.routines = [context];
  input.resolutions.routines = [
    {
      scheduleVersionId: context.record.versionId,
      action: 'replace_rule',
      rule: context.record.rule,
      window: context.record.window,
      sourcePlanVersionId: planId,
    },
  ];
  const original = structuredClone(context);
  expect(projectRaceRelativeScheduleImpact(input, calculations)).toMatchObject({
    status: 'rejected',
    reason: 'unsupported_resolution',
  });
  expect(context).toEqual(original);
  expect(calculations.expandRoutine).not.toHaveBeenCalled();
});
