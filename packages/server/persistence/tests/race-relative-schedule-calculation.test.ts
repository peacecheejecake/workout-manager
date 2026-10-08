import { expect, it } from 'vitest';
import { projectRaceRelativeScheduleImpact } from '@workout/server-coaching/race-relative-schedule-impact';
import { planDraftSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { raceEventSchema } from '@workout/contracts/races';
import { routineScheduleVersionSchema } from '@workout/contracts/routines';
import { createRaceRelativeScheduleCalculationPorts } from '../src/race-relative-schedule-calculation.js';
import { projectNutritionItem } from '../src/integrated-planner.js';
const planId = '10000000-0000-4000-8000-000000000001';
function source(
  date = '2026-03-08',
  time: string | null = '01:30:00',
  duration: number | null = 3600,
) {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return planDraftSchema.parse({
    title: 'Synthetic historical',
    timezone: 'America/New_York',
    periods: levels.map((level, index) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2026-01-01',
      endDateExclusive: '2027-01-02',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date,
        localStartTime: time,
        title: 'Synthetic',
        sport: 'running',
        durationSeconds: duration,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
}
function nutrition() {
  const record = nutritionPlanVersionSchema.parse({
    planId: '30000000-0000-4000-8000-000000000001',
    versionId: planId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-01-01', toInclusive: '2026-12-31' },
    timezone: 'America/New_York',
    purpose: 'Synthetic',
    linkedTrainingPlanVersionId: planId,
    approvedAt: '2026-01-01T00:00:00Z',
    approvalId: planId,
    items: [
      {
        id: 'meal',
        planVersionId: planId,
        category: 'before',
        title: 'Synthetic',
        anchor: {
          kind: 'relative',
          entity: 'session',
          entityId: 'session',
          point: 'end',
          offsetMinutes: 0,
        },
        foods: [],
        targets: [],
        instructions: 'Synthetic timing action',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  });
  const item = record.items[0];
  if (!item) throw new Error('Missing fixture');
  const event = raceEventSchema.parse({
    id: planId,
    revision: 1,
    title: 'Synthetic',
    localDate: '2026-03-09',
    localStartTime: null,
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
  return { item, record, sourcePlan: source(), event };
}
function schedule() {
  return routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: 'schedule',
    versionId: 'frozen-v1',
    blueprint: { id: 'blueprint', versionId: 'frozen-blueprint' },
    window: {
      startDate: '2026-01-01',
      endDateExclusive: '2027-01-02',
      timezone: 'America/New_York',
      maxOccurrences: 100,
    },
    rule: { kind: 'session_links', sessionIds: ['session'], point: 'end', offsetMinutes: 0 },
    state: 'paused',
  });
}
const ports = createRaceRelativeScheduleCalculationPorts();
it('connects the public coaching projection to the actual runtime adapter without permitting approval', () => {
  const context = nutrition();
  const result = projectRaceRelativeScheduleImpact(
    {
      event: context.event,
      newLocalDate: '2026-03-10',
      currentPlan: {
        id: planId,
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        draft: context.sourcePlan,
      },
      sourcePlans: [],
      completionReports: [],
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: planId,
        periodId: 'season',
        newStartDate: '2026-01-02',
        scope: 'descendants_and_sessions',
      },
      nutrition: [
        {
          record: context.record,
          timings: [
            {
              itemId: context.item.id,
              timing: { state: 'resolved', date: '2026-03-08', localTime: '03:30:00' },
            },
          ],
        },
      ],
      routines: [],
      resolutions: { nutrition: [], routines: [] },
    },
    ports,
  );
  expect(result).toMatchObject({
    status: 'projected',
    approval: { status: 'blocked' },
    nutrition: [
      {
        items: [
          {
            state: 'affected',
            after: { state: 'resolved', date: '2026-03-09', localTime: '02:30:00' },
          },
        ],
      },
    ],
  });
});
it('uses the actual nutrition resolver across a DST jump, preserving exact historical source and input', () => {
  const input = nutrition(),
    before = structuredClone(input);
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'resolved',
    date: '2026-03-08',
    localTime: '03:30:00',
  });
  expect(input).toEqual(before);
  input.sourcePlan = source('2026-03-07');
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'resolved',
    date: '2026-03-07',
    localTime: '02:30:00',
  });
});
it.each([
  ['2026-03-08', '02:30:00'],
  ['2026-11-01', '01:30:00'],
])('actual nutrition resolver leaves DST gap/overlap %s unresolved', (date, time) => {
  const input = nutrition();
  input.sourcePlan = source(date, time);
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'unresolved',
    reason: 'ambiguous_local_time',
  });
});
it('preserves missing duration/time/source and missing race time rather than inventing timing', () => {
  const input = nutrition();
  input.sourcePlan = source('2026-03-08', '01:30:00', null);
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'unresolved',
    reason: 'missing_session_duration',
  });
  input.sourcePlan = source('2026-03-08', null);
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'unresolved',
    reason: 'missing_session_time',
  });
  expect(ports.resolveNutrition({ ...input, sourcePlan: null })).toEqual({
    state: 'unresolved',
    reason: 'missing_anchor',
  });
  input.item.anchor = {
    kind: 'relative',
    entity: 'race',
    entityId: input.event.id,
    point: 'start',
    offsetMinutes: 0,
  };
  expect(ports.resolveNutrition(input)).toEqual({ state: 'unresolved', reason: 'missing_anchor' });
});
function raceNutrition(date = '2026-03-08', time: string | null = '01:30:00') {
  const input = nutrition();
  input.event.localDate = date;
  input.event.localStartTime = time;
  input.item.anchor = {
    kind: 'relative',
    entity: 'race',
    entityId: input.event.id,
    point: 'start',
    offsetMinutes: 0,
  };
  return input;
}
it('resolves known race start without a linked Plan while ordinary resolver calls remain unresolved', () => {
  const input = raceNutrition();
  input.record.linkedTrainingPlanVersionId = null;
  const before = structuredClone(input);
  expect(ports.resolveNutrition({ ...input, sourcePlan: null })).toEqual({
    state: 'resolved',
    date: '2026-03-08',
    localTime: '01:30:00',
  });
  expect(
    projectNutritionItem(input.item, input.record, new Map(), input.record.timezone),
  ).toMatchObject({ reason: 'missing_anchor' });
  expect(input).toEqual(before);
});
it('known race date preview uses actual calculation with no Plan and remains approval blocked', () => {
  const input = raceNutrition();
  input.record.linkedTrainingPlanVersionId = null;
  const result = projectRaceRelativeScheduleImpact(
    {
      event: input.event,
      newLocalDate: '2026-03-09',
      currentPlan: null,
      sourcePlans: [],
      completionReports: [],
      selection: { kind: 'keep_plan' },
      nutrition: [
        {
          record: input.record,
          timings: [
            {
              itemId: input.item.id,
              timing: { state: 'resolved', date: '2026-03-08', localTime: '01:30:00' },
            },
          ],
        },
      ],
      routines: [],
      resolutions: { nutrition: [], routines: [] },
    },
    ports,
  );
  expect(result).toMatchObject({
    status: 'projected',
    approval: { status: 'blocked' },
    nutrition: [
      {
        items: [
          {
            state: 'affected',
            after: { state: 'resolved', date: '2026-03-09', localTime: '01:30:00' },
          },
        ],
      },
    ],
  });
});
it('keeps race/session UUID namespaces separate and missing/mismatched owned races unresolved', () => {
  const input = raceNutrition();
  const session = input.sourcePlan.sessions[0];
  if (!session) throw new Error('Missing session');
  session.id = input.event.id;
  input.item.anchor = {
    kind: 'relative',
    entity: 'session',
    entityId: input.event.id,
    point: 'start',
    offsetMinutes: 0,
  };
  input.sourcePlan = {
    ...input.sourcePlan,
    sessions: [{ ...session, date: '2026-03-07', localStartTime: '07:00:00' }],
  };
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'resolved',
    date: '2026-03-07',
    localTime: '07:00:00',
  });
  input.item.anchor.entity = 'race';
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'resolved',
    date: '2026-03-08',
    localTime: '01:30:00',
  });
  const wrong = { ...input.event, id: '20000000-0000-4000-8000-000000000001' };
  expect(
    projectNutritionItem(
      input.item,
      input.record,
      new Map(),
      'UTC',
      new Map([[input.event.id, wrong]]),
    ),
  ).toMatchObject({ reason: 'missing_anchor' });
  expect(ports.resolveNutrition({ ...input, event: wrong })).toEqual({
    state: 'unresolved',
    reason: 'missing_anchor',
  });
});
it.each([
  ['2026-03-08', '02:30:00'],
  ['2026-11-01', '01:30:00'],
])('known race DST gap/overlap %s remains unresolved', (date, time) => {
  expect(ports.resolveNutrition(raceNutrition(date, time))).toEqual({
    state: 'unresolved',
    reason: 'ambiguous_local_time',
  });
});
it.each([
  [60, '2026-03-08', '03:30:00'],
  [-120, '2026-03-07', '23:30:00'],
  [0, '2026-03-08', '01:30:00'],
  [0.5, '2026-03-08', '01:30:30'],
])('race elapsed offset %s preserves DST/day/fractional semantics', (offset, date, time) => {
  const input = raceNutrition();
  if (input.item.anchor.kind !== 'relative') throw new Error('Expected relative');
  input.item.anchor.offsetMinutes = Number(offset);
  expect(ports.resolveNutrition(input)).toEqual({ state: 'resolved', date, localTime: time });
});
it('projects race instant into explicit output timezone and rejects extreme finite offset', () => {
  const input = raceNutrition('2026-03-09', '00:30:00');
  input.event.timezone = 'UTC';
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'resolved',
    date: '2026-03-08',
    localTime: '20:30:00',
  });
  expect(
    projectNutritionItem(
      input.item,
      input.record,
      new Map(),
      'UTC',
      new Map([[input.event.id, input.event]]),
    ),
  ).toMatchObject({ date: '2026-03-09', value: { localTime: '00:30:00' } });
  if (input.item.anchor.kind !== 'relative') throw new Error('Expected relative');
  input.item.anchor.offsetMinutes = Number.MAX_VALUE;
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'unresolved',
    reason: 'offset_out_of_range',
  });
});
it.each([0, 3600, null])(
  'race end remains unknown even with targetSeconds %s and explicit start',
  (targetSeconds) => {
    const input = raceNutrition();
    input.event.targetSeconds = targetSeconds;
    if (input.item.anchor.kind !== 'relative') throw new Error('Expected relative');
    input.item.anchor.point = 'end';
    expect(ports.resolveNutrition(input)).toEqual({
      state: 'unresolved',
      reason: 'missing_anchor',
    });
  },
);
it('reuses actual absolute timezone conversion and retains null clock without assuming midnight', () => {
  const input = nutrition();
  input.item.anchor = {
    kind: 'absolute',
    date: '2026-03-09',
    localTime: '00:30:00',
    timezone: 'UTC',
  };
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'resolved',
    date: '2026-03-08',
    localTime: '20:30:00',
  });
  input.item.anchor.localTime = null;
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'unresolved',
    reason: 'timezone_mismatch',
  });
  input.item.anchor.timezone = 'America/New_York';
  expect(ports.resolveNutrition(input)).toEqual({
    state: 'resolved',
    date: '2026-03-09',
    localTime: null,
  });
});
it('uses actual deterministic expansion with frozen refs, paused state, DST and zero/null distinction', () => {
  const input = { schedule: schedule(), sourcePlan: source() },
    before = structuredClone(input);
  const result = ports.expandRoutine(input);
  expect(result).toMatchObject({
    state: 'expanded',
    occurrences: [
      {
        blueprint: input.schedule.blueprint,
        schedule: { id: 'schedule', versionId: 'frozen-v1' },
        scheduledAt: '2026-03-08T07:30:00.000Z',
        timingStatus: 'resolved',
      },
    ],
  });
  expect(ports.expandRoutine(input)).toEqual(result);
  expect(input).toEqual(before);
  expect(
    ports.expandRoutine({ ...input, sourcePlan: source('2026-03-08', '01:30:00', 0) }),
  ).toMatchObject({ occurrences: [{ scheduledAt: '2026-03-08T06:30:00.000Z' }] });
  expect(
    ports.expandRoutine({ ...input, sourcePlan: source('2026-03-08', '01:30:00', null) }),
  ).toMatchObject({ occurrences: [{ scheduledAt: null, timingStatus: 'unresolved' }] });
});
it('maps real expansion failures and enforces actual 366-day/100 occurrence limits', () => {
  const value = schedule();
  expect(ports.expandRoutine({ schedule: value, sourcePlan: null })).toEqual({
    state: 'unresolved',
    reason: 'SOURCE_PLAN_REQUIRED',
  });
  expect(
    ports.expandRoutine({
      schedule: value,
      sourcePlan: {
        ...source(),
        timezone: 'UTC',
        periods: source().periods.map((period) => ({ ...period, timezone: 'UTC' })),
      },
    }),
  ).toEqual({ state: 'unresolved', reason: 'SOURCE_PLAN_TIMEZONE_MISMATCH' });
  value.window.endDateExclusive = '2027-01-03';
  expect(ports.expandRoutine({ schedule: value, sourcePlan: source() })).toEqual({
    state: 'unresolved',
    reason: 'EXPANSION_LIMIT_EXCEEDED',
  });
  value.window.endDateExclusive = '2027-01-02';
  value.window.maxOccurrences = 101;
  expect(ports.expandRoutine({ schedule: value, sourcePlan: source() })).toEqual({
    state: 'unresolved',
    reason: 'EXPANSION_LIMIT_EXCEEDED',
  });
});
it('validates unknown adapter inputs, immutable version identity and bounded bytes', () => {
  expect(() => ports.resolveNutrition({ ...nutrition(), approve: true })).toThrow();
  const input = nutrition();
  input.item = { ...input.item, planVersionId: '20000000-0000-4000-8000-000000000001' };
  expect(() => ports.resolveNutrition(input)).toThrow('INVALID_CALCULATION_INPUT');
  expect(() => ports.expandRoutine({ body: 'x'.repeat(4194304) })).toThrow(
    'INVALID_CALCULATION_INPUT',
  );
});
it('actual recurrence permits exactly 100 dates within 366 days and rejects the 101st', () => {
  const value = schedule();
  const dates = Array.from({ length: 101 }, (_, index) =>
    new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  );
  value.rule = { kind: 'dates', dates: dates.slice(0, 100), localTime: '07:00:00' };
  const result = ports.expandRoutine({ schedule: value, sourcePlan: null });
  if (result.state !== 'expanded') throw new Error('Expected finite expansion');
  expect(result.occurrences).toHaveLength(100);
  value.rule.dates = dates;
  expect(() => ports.expandRoutine({ schedule: value, sourcePlan: null })).toThrow(
    'Occurrence limit exceeded',
  );
});
it.each([
  ['2026-03-08', '02:30:00'],
  ['2026-11-01', '01:30:00'],
])(
  'actual routine local resolver preserves gap/overlap %s as unresolved occurrence',
  (date, time) => {
    expect(
      ports.expandRoutine({ schedule: schedule(), sourcePlan: source(date, time) }),
    ).toMatchObject({
      state: 'expanded',
      occurrences: [{ scheduledAt: null, timingStatus: 'unresolved' }],
    });
  },
);

it('captured other race bodies retain their own timing while the explicit preview event overrides only its ID', () => {
  const input = raceNutrition();
  const other = {
    ...input.event,
    id: '20000000-0000-4000-8000-000000000002',
    localDate: '2026-03-11',
    localStartTime: '07:00:00',
  };
  const known = [input.event, other];
  const before = structuredClone(known);
  const capturedPorts = createRaceRelativeScheduleCalculationPorts(known);
  const changed = { ...input.event, revision: 2, localDate: '2026-03-10' };
  expect(capturedPorts.resolveNutrition(input)).toEqual({
    state: 'resolved',
    date: '2026-03-08',
    localTime: '01:30:00',
  });
  expect(capturedPorts.resolveNutrition({ ...input, event: changed })).toEqual({
    state: 'resolved',
    date: '2026-03-10',
    localTime: '01:30:00',
  });
  input.item.anchor = {
    kind: 'relative',
    entity: 'race',
    entityId: other.id,
    point: 'start',
    offsetMinutes: 0,
  };
  const otherTiming = { state: 'resolved', date: '2026-03-11', localTime: '07:00:00' };
  expect(capturedPorts.resolveNutrition(input)).toEqual(otherTiming);
  expect(capturedPorts.resolveNutrition({ ...input, event: changed })).toEqual(otherTiming);
  expect(known).toEqual(before);
  // The factory owns its decoded snapshot; callers cannot mutate a future preview.
  other.localDate = '2026-03-12';
  expect(capturedPorts.resolveNutrition(input)).toEqual(otherTiming);
  expect(ports.resolveNutrition(input)).toEqual({ state: 'unresolved', reason: 'missing_anchor' });
});
it('deduplicates exact captured IDs independently of object key order and rejects conflicting bodies or revisions', () => {
  const input = raceNutrition();
  const reversed = Object.fromEntries(Object.entries(input.event).reverse());
  const captured = createRaceRelativeScheduleCalculationPorts([input.event, reversed]);
  expect(captured.resolveNutrition(input)).toEqual(ports.resolveNutrition(input));
  for (const conflicting of [
    { ...input.event, revision: 2 },
    { ...input.event, localStartTime: null },
  ])
    expect(() => createRaceRelativeScheduleCalculationPorts([input.event, conflicting])).toThrow(
      'INVALID_CALCULATION_INPUT',
    );
});
it('other-race unknown starts, unknown ends and DST gaps remain unresolved without Plan timing substitution', () => {
  const input = raceNutrition();
  const other = {
    ...input.event,
    id: '20000000-0000-4000-8000-000000000002',
    localStartTime: null,
  };
  input.item.anchor = {
    kind: 'relative',
    entity: 'race',
    entityId: other.id,
    point: 'start',
    offsetMinutes: 0,
  };
  expect(createRaceRelativeScheduleCalculationPorts([other]).resolveNutrition(input)).toEqual({
    state: 'unresolved',
    reason: 'missing_anchor',
  });
  const gap = { ...other, localStartTime: '02:30:00' };
  expect(createRaceRelativeScheduleCalculationPorts([gap]).resolveNutrition(input)).toEqual({
    state: 'unresolved',
    reason: 'ambiguous_local_time',
  });
  input.item.anchor.point = 'end';
  expect(
    createRaceRelativeScheduleCalculationPorts([
      { ...other, localStartTime: '07:00:00', targetSeconds: 3600 },
    ]).resolveNutrition(input),
  ).toEqual({ state: 'unresolved', reason: 'missing_anchor' });
});
it('validates unknown captured arrays, strict event bodies and the existing 5000-input/4MiB limits', () => {
  const event = raceNutrition().event;
  for (const invalid of [
    null,
    {},
    [null],
    [{ ...event, approve: true }],
    [{ ...event, id: 'not-a-uuid' }],
    [{ ...event, revision: 0 }],
  ])
    expect(() => createRaceRelativeScheduleCalculationPorts(invalid)).toThrow();
  const many = Array.from({ length: 5000 }, (_, index) => ({
    ...event,
    id: `20000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
  }));
  expect(() => createRaceRelativeScheduleCalculationPorts(many)).not.toThrow();
  expect(() => createRaceRelativeScheduleCalculationPorts([...many, event])).toThrow();
  expect(() => createRaceRelativeScheduleCalculationPorts(['x'.repeat(4194304)])).toThrow(
    'INVALID_CALCULATION_INPUT',
  );
});
it('applies one aggregate input byte budget to captured bodies plus each nutrition/routine calculation', () => {
  const input = raceNutrition();
  const known = Array.from({ length: 1500 }, (_, index) => ({
    ...input.event,
    id: `20000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    officialUrl: `https://example.invalid/${'x'.repeat(1600)}`,
  }));
  const original = input.sourcePlan.sessions[0];
  if (!original) throw new Error('Missing session');
  input.sourcePlan.sessions = Array.from({ length: 500 }, (_, index) => ({
    ...original,
    id: `session-${index}`,
    notes: 'x'.repeat(4000),
  }));
  expect(Buffer.byteLength(JSON.stringify(known), 'utf8')).toBeLessThan(4194304);
  expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThan(4194304);
  expect(Buffer.byteLength(JSON.stringify({ known, input }), 'utf8')).toBeGreaterThan(4194304);
  const captured = createRaceRelativeScheduleCalculationPorts(known);
  expect(() => captured.resolveNutrition(input)).toThrow('INVALID_CALCULATION_INPUT');
  expect(() =>
    captured.expandRoutine({ schedule: schedule(), sourcePlan: input.sourcePlan }),
  ).toThrow('INVALID_CALCULATION_INPUT');
});

function frozenBatch(count = 400) {
  const raw = nutrition();
  const event = { ...raw.event, localDate: '2026-03-08', localStartTime: '01:30:00' };
  const first = raw.record.items[0];
  if (!first) throw Error('fixture');
  const record = {
    ...raw.record,
    schemaVersion: 4,
    items: Array.from({ length: count }, (_, index) => ({
      ...first,
      id: `meal-${index.toString().padStart(4, '0')}`,
      anchor: {
        kind: 'relative',
        entity: 'race',
        entityId: event.id,
        point: 'start',
        offsetMinutes: 0,
      },
    })),
    raceTimingPins: [
      {
        pinVersion: 1,
        namespace: 'race-event-revision',
        eventId: event.id,
        eventRevision: 1,
        sourceDigestVersion: 'race-event-values-canonical-v1',
        sourceDigest: 'a'.repeat(64),
        localDate: event.localDate,
        localStartTime: event.localStartTime,
        timezone: event.timezone,
        start: { state: 'known', instant: '2026-03-08T06:30:00Z' },
        end: { state: 'unknown', reason: 'race_end_not_recorded' },
      },
    ],
    itemRaceTimingBindings: Array.from({ length: count }, (_, index) => ({
      itemId: `meal-${index.toString().padStart(4, '0')}`,
      binding: { state: 'captured', eventId: event.id, eventRevision: 1 },
    })),
  };
  return { record, sourcePlan: raw.sourcePlan, event };
}
it('one immutable batch reuses one frozen projector for400 exact selectors and matches the single-item boundary', async () => {
  const { createRaceRelativeScheduleCalculationPortsCompatibleV4 } =
    await import('../src/race-relative-schedule-calculation.js');
  const frozen = await import('../src/nutrition-frozen-timing-projection.js');
  const { vi } = await import('vitest');
  const spy = vi.spyOn(frozen, 'createFrozenNutritionProjectorCompatibleV4');
  try {
    const input = frozenBatch();
    const ports = createRaceRelativeScheduleCalculationPortsCompatibleV4([input.event]);
    const batch = ports.prepareNutritionContext(input);
    const values = input.record.items.map((item) => batch.resolveNutrition(item));
    expect(values).toHaveLength(400);
    expect(
      values.every(
        (value) =>
          JSON.stringify(value) ===
          JSON.stringify({ state: 'resolved', date: '2026-03-08', localTime: '01:30:00' }),
      ),
    ).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    for (const index of [0, 199, 399]) {
      const item = input.record.items[index];
      if (!item) throw Error('fixture');
      expect(ports.resolveNutrition({ ...input, item })).toEqual(values[index]);
    }
  } finally {
    spy.mockRestore();
  }
});
it('batch owns a strict snapshot and preserves before/proposed facts after caller record/event/plan mutations', async () => {
  const { createRaceRelativeScheduleCalculationPortsCompatibleV4 } =
    await import('../src/race-relative-schedule-calculation.js');
  const input = frozenBatch(2),
    original = structuredClone(input);
  const item = original.record.items[0];
  if (!item) throw Error('fixture');
  const ports = createRaceRelativeScheduleCalculationPortsCompatibleV4([input.event]);
  const before = ports.prepareNutritionContext(input);
  const after = ports.prepareNutritionContext({
    ...input,
    event: { ...input.event, localDate: '2026-03-10' },
    proposedFromEvent: input.event,
  });
  input.record.items = [];
  input.record.itemRaceTimingBindings = [];
  input.event.localStartTime = '23:00:00';
  input.sourcePlan.sessions = [];
  expect(before.resolveNutrition(item)).toEqual({
    state: 'resolved',
    date: '2026-03-08',
    localTime: '01:30:00',
  });
  expect(after.resolveNutrition(item)).toEqual({
    state: 'resolved',
    date: '2026-03-10',
    localTime: '01:30:00',
  });
  expect(() => ports.prepareNutritionContext(input)).toThrow();
  expect(() => before.resolveNutrition({ ...item, id: 'foreign' })).toThrow(
    'INVALID_CALCULATION_INPUT',
  );
  expect(() =>
    before.resolveNutrition({ ...item, planVersionId: '20000000-0000-4000-8000-000000000099' }),
  ).toThrow('INVALID_CALCULATION_INPUT');
  expect(before.resolveNutrition({ ...item, title: 'tampered' })).toEqual({
    state: 'unresolved',
    reason: 'unsupported_anchor_mapping',
  });
  expect(() =>
    ports.prepareNutritionContext({
      ...original,
      record: { ...original.record, itemRaceTimingBindings: [] },
    }),
  ).toThrow();
  const stale = ports.prepareNutritionContext({
    ...original,
    proposedFromEvent: { ...original.event, revision: 2 },
  });
  expect(() => stale.resolveNutrition(item)).toThrow('INVALID_CALCULATION_INPUT');
});
it('batch unknown guard refuses accessors, cycles, holes, unknown authority and oversized bodies without executing getters', async () => {
  const { createRaceRelativeScheduleCalculationPortsCompatibleV4 } =
    await import('../src/race-relative-schedule-calculation.js');
  const ports = createRaceRelativeScheduleCalculationPortsCompatibleV4();
  const input = frozenBatch(1);
  let reads = 0;
  const getter = Object.defineProperty({}, 'record', {
    enumerable: true,
    get() {
      reads++;
      return input.record;
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const raw of [
    getter,
    cyclic,
    { ...input, record: { ...input.record, items: new Array(2) } },
    { ...input, authority: true },
    { ...input, record: { ...input.record, purpose: 'x'.repeat(4194305) } },
  ])
    expect(() => ports.prepareNutritionContext(raw)).toThrow();
  expect(reads).toBe(0);
});
