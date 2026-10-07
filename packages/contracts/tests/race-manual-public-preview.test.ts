import { describe, expect, it } from 'vitest';
import type { PlanDraft } from '../src/planning.js';
import type { RoutineOccurrence } from '../src/routines.js';
import {
  raceManualPublicPreviewSchema,
  raceManualPublicPreviewBlockedSchema,
} from '../src/race-manual-public-preview.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-08T00:00:00.123456Z';
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw Error('Fixture row required');
  return row;
}
function fixture() {
  const plan: PlanDraft = {
    title: 'Calendar',
    timezone: 'UTC',
    periods: [
      {
        id: 'p',
        parentId: null,
        level: 'season',
        title: 'Season',
        startDate: '2026-10-08',
        endDateExclusive: '2026-10-12',
        timezone: 'UTC',
        intent: 'Build',
        isPartial: false,
      },
    ],
    sessions: [
      {
        id: 's',
        blockId: 'block',
        date: '2026-10-09',
        localStartTime: null,
        title: 'Run',
        sport: 'running',
        durationSeconds: 0,
        distanceMeters: null,
        targetRpe: 0,
        purpose: 'Build',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  const levels: Array<'wave' | 'phase' | 'block'> = ['wave', 'phase', 'block'];
  for (const [index, level] of levels.entries())
    plan.periods.push({
      ...first(plan.periods),
      id: level,
      parentId: index === 0 ? 'p' : index === 1 ? 'wave' : 'phase',
      level,
    });
  const item = {
    id: 'Meal-식-' + 'a'.repeat(201),
    category: 'before',
    title: 'Meal',
    anchor: { kind: 'disconnected', entity: 'race' },
    foods: [
      {
        foodVersionId: null,
        description: 'Zero',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
      {
        foodVersionId: null,
        description: 'Unknown',
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'manual_total',
      },
    ],
    targets: [],
    instructions: 'Eat',
  };
  const nutrition = {
    period: { from: '2026-10-08', toInclusive: '2026-10-11' },
    purpose: 'Fuel',
    timezone: 'UTC',
    items: [item],
  };
  const suspended = {
    state: 'suspended',
    reason: 'race_disconnected',
    resume: 'explicit_reconnect_and_reapproval_required',
  };
  const recovery = {
    title: 'Recover',
    goal: 'Rest',
    startDate: '2026-10-08',
    endDateExclusive: '2026-10-12',
    timezone: 'UTC',
    priority: 'normal',
    options: [
      {
        id: id(8),
        title: 'Rest',
        kind: 'full_rest',
        methodVersionId: null,
        explanation: 'Rest planned',
      },
    ],
    reassessment: [
      {
        id: id(9),
        trigger: 'plan_changed',
        plannedAt: null,
        description: 'Reassess',
        policyVersion: null,
      },
    ],
  };
  const blueprint = {
    schemaVersion: 4,
    routineId: 'bp',
    versionId: 'bp-v1',
    title: 'Routine',
    intent: 'Check',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Check',
        content: { kind: 'checklist', prompt: 'Ready?' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: 0,
    createdAt: stamp,
  };
  const schedule = {
    schemaVersion: 4,
    id: id(4),
    versionId: 'schedule-current',
    blueprint: { id: 'bp', versionId: 'bp-v1' },
    window: {
      startDate: '2026-10-08',
      endDateExclusive: '2026-10-12',
      timezone: 'UTC',
      maxOccurrences: 10,
    },
    rule: { kind: 'period_days', periodId: 'p', offsetsDays: [0, 1], localTime: null },
    state: 'active',
  };
  const race = {
    title: 'Race',
    localDate: '2026-10-09',
    localStartTime: null,
    timezone: 'UTC',
    distance: { kind: 'standard', class: '5k' },
    priority: null,
    participation: 'registered',
    targetSeconds: 0,
  };
  return {
    schemaVersion: 1,
    status: 'present',
    reference: {
      schemaVersion: 1,
      candidateId: id(30),
      applicationDigest: 'a'.repeat(64),
      chain: {
        evidenceId: id(31),
        decisionId: id(32),
        proposalId: id(33),
        readonlyCandidateDigest: 'b'.repeat(64),
      },
      createdAt: stamp,
    },
    storedCandidateState: 'ready_for_explicit_approval',
    beforeBasis: 'frozen_review',
    afterBasis: 'hypothetical_on_approval',
    freshness: 'not_checked_on_read',
    scope: 'whole_affected',
    race: {
      eventId: id(5),
      expectedRevision: 2,
      before: race,
      after: { ...race, localDate: '2026-10-10' },
    },
    training: {
      state: 'present',
      members: [
        {
          aggregateId: id(1),
          before: { ref: { versionId: 'Snapshot-식-A', version: 2 }, plan },
          after: { kind: 'retained', plan: structuredClone(plan) },
        },
      ],
    },
    nutrition: {
      state: 'present',
      members: [
        {
          aggregateId: id(2),
          before: {
            ref: { versionId: id(12), version: 3 },
            plan: nutrition,
            linkedTraining: { kind: 'absent' },
          },
          after: {
            kind: 'retained',
            plan: structuredClone(nutrition),
            linkedTraining: { kind: 'absent' },
          },
          timings: [
            {
              itemId: item.id,
              state: 'unchanged',
              before: suspended,
              after: structuredClone(suspended),
            },
          ],
        },
      ],
    },
    recovery: {
      state: 'present',
      members: [
        {
          aggregateId: id(3),
          before: {
            ref: { versionId: id(13), version: 4 },
            plan: recovery,
            status: 'draft',
            selectedOptionId: null,
            planLinks: [],
          },
          after: {
            kind: 'retained',
            plan: structuredClone(recovery),
            status: 'draft',
            selectedOptionId: null,
            planLinks: [],
          },
        },
      ],
    },
    routines: {
      state: 'present',
      members: [
        {
          aggregateId: id(4),
          blueprint,
          before: { schedule, expansion: { state: 'expanded', occurrences: [] } },
          after: {
            kind: 'retained',
            schedule: structuredClone(schedule),
            expansion: { state: 'expanded', occurrences: [] },
          },
          retainedStarted: [
            {
              runId: 'run',
              occurrenceId: 'occ-old',
              scheduleVersionId: 'schedule-historical',
              blueprintVersionId: 'bp-old',
              anchorKey: 'old-anchor',
              preservation: 'started_run_frozen',
            },
          ],
          retainedUnplanned: [],
        },
      ],
    },
    affected: [],
    notices: [
      { domain: 'nutrition', aggregateId: id(2), itemId: item.id, code: 'DISCONNECTED_RETAINED' },
      {
        domain: 'routine_schedule',
        aggregateId: id(4),
        itemId: null,
        code: 'STARTED_RUN_PRESERVED',
      },
    ],
  };
}
const parse = (value: unknown) => raceManualPublicPreviewSchema.safeParse(value).success;
function available() {
  const value = raceManualPublicPreviewSchema.parse(fixture());
  if (
    value.status !== 'present' ||
    value.training.state !== 'present' ||
    value.nutrition.state !== 'present' ||
    value.recovery.state !== 'present' ||
    value.routines.state !== 'present'
  )
    throw Error('Fixture must be populated');
  return {
    value,
    training: first(value.training.members),
    nutrition: first(value.nutrition.members),
    recovery: first(value.recovery.members),
    routine: first(value.routines.members),
  };
}

describe('whole public frozen/hypothetical preview', () => {
  it('preserves full planned goals/rules/food quantities, null/zero and long item IDs', () => {
    const { value, nutrition, training, routine } = available();
    expect(value.reference.createdAt).toBe(stamp);
    expect(nutrition.before.plan.items[0]?.foods.map((food) => food.quantity)).toEqual([0, null]);
    expect(nutrition.before.plan.items[0]?.id.length).toBeGreaterThan(201);
    expect(training.before.plan.periods[0]?.intent).toBe('Build');
    expect(training.before.plan.sessions[0]?.durationSeconds).toBe(0);
    expect(routine.before.schedule.rule).toEqual({
      kind: 'period_days',
      periodId: 'p',
      offsetsDays: [0, 1],
      localTime: null,
    });
    expect(routine.retainedStarted[0]?.scheduleVersionId).toBe('schedule-historical');
  });
  it('accepts independent absent domain sections without inventing heads', () => {
    const f = fixture();
    expect(
      parse({
        ...f,
        training: { state: 'absent' },
        nutrition: { state: 'absent' },
        recovery: { state: 'absent' },
        routines: { state: 'absent' },
        notices: [],
      }),
    ).toBe(true);
  });
  it('purge permits only original minimal reference and no domain body', () => {
    const reference = fixture().reference;
    const purged = {
      schemaVersion: 1,
      status: 'unavailable',
      reference,
      reason: 'review_body_purged',
      preview: null,
    };
    expect(raceManualPublicPreviewSchema.parse(purged)).toEqual(purged);
    expect(parse({ ...purged, nutrition: fixture().nutrition })).toBe(false);
    expect(parse({ ...purged, sourceId: id(90), purgedEventId: id(91) })).toBe(false);
  });
  it.each([
    'context',
    'basis',
    'lifecycle',
    'sqlRowDigest',
    'providerPayload',
    'approvalAllowed',
    'currentPermission',
  ])('rejects private/authority field %s', (field) =>
    expect(parse({ ...fixture(), [field]: {} })).toBe(false),
  );
  it('rejects unresolved affected timing without changing unrelated unresolved data', () => {
    const { value, nutrition } = available();
    first(nutrition.before.plan.items).anchor = {
      kind: 'relative',
      entity: 'race',
      entityId: id(5),
      point: 'start',
      offsetMinutes: 0,
    };
    nutrition.after.plan = structuredClone(nutrition.before.plan);
    first(nutrition.timings).before = { state: 'unresolved', reason: 'missing_race_time' };
    first(nutrition.timings).after = structuredClone(first(nutrition.timings).before);
    first(value.notices).code = 'UNCHANGED_UNRESOLVED';
    expect(parse(value)).toBe(true);
    first(nutrition.timings).state = 'affected';
    nutrition.after.kind = 'new_version_on_approval';
    expect(parse(value)).toBe(false);
  });
  it('requires disconnected suspension and rejects implicit reconnection/time fallback', () => {
    const { value, nutrition } = available();
    first(nutrition.after.plan.items).anchor = {
      kind: 'absolute',
      date: '2026-10-10',
      localTime: null,
      timezone: 'UTC',
    };
    first(nutrition.timings).after = {
      state: 'resolved',
      date: '2026-10-10',
      localTime: null,
      timezone: 'UTC',
    };
    expect(parse(value)).toBe(false);
  });
  it('accepts affected training/linked recovery and blocks missing hypothetical target', () => {
    const { value, training, recovery } = available();
    training.after.kind = 'new_version_on_approval';
    first(training.after.plan.sessions).date = '2026-10-10';
    recovery.after.kind = 'new_version_on_approval';
    recovery.after.status = 'user_confirmed';
    recovery.after.selectedOptionId = id(8);
    value.affected = [
      { domain: 'training', aggregateId: id(1) },
      { domain: 'recovery', aggregateId: id(3) },
    ];
    recovery.after.planLinks = [
      { domain: 'training', aggregateId: id(1), version: { kind: 'follows_approval' } },
    ];
    expect(parse(value)).toBe(true);
    first(recovery.after.planLinks).aggregateId = id(999);
    expect(parse(value)).toBe(false);
  });
  it('does not choose a recovery option on behalf of the user', () => {
    const { value, recovery } = available();
    recovery.after.kind = 'new_version_on_approval';
    expect(parse(value)).toBe(false);
  });
  it('retained plan/body cannot drift while claiming unchanged', () => {
    const { value, training } = available();
    first(training.after.plan.sessions).durationSeconds = 10;
    expect(parse(value)).toBe(false);
  });
  it('rejects duplicate member identities and unknown timing items', () => {
    const { value, nutrition } = available();
    first(nutrition.timings).itemId = 'missing';
    expect(parse(value)).toBe(false);
    const f = fixture();
    expect(
      parse({
        ...f,
        training: { state: 'present', members: [f.training.members[0], f.training.members[0]] },
      }),
    ).toBe(false);
  });
  it('keeps started anchors out of newly approved occurrence candidates', () => {
    const { value, routine } = available();
    routine.after.kind = 'new_version_on_approval';
    value.affected = [{ domain: 'routine_schedule', aggregateId: id(4) }];
    routine.after.schedule.versionId = 'next';
    routine.after.expansion = {
      state: 'expanded',
      occurrences: [
        {
          id: 'new',
          schedule: { id: id(4), versionId: 'next' },
          blueprint: { id: 'bp', versionId: 'bp-v1' },
          anchorKey: 'old-anchor',
          scheduledAt: stamp,
          timingStatus: 'resolved',
          stepBindings: [],
          selectedChoices: {},
        },
      ],
    };
    expect(parse(value)).toBe(false);
    first(routine.after.expansion.occurrences).anchorKey = 'new-anchor';
    expect(parse(value)).toBe(true);
  });
  it('checks exact blueprint identity and duplicate retained runs', () => {
    const { value, routine } = available();
    routine.blueprint.versionId = 'other';
    expect(parse(value)).toBe(false);
    const f = fixture();
    first(f.routines.members).retainedStarted.push(
      structuredClone(first(first(f.routines.members).retainedStarted)),
    );
    expect(parse(f)).toBe(false);
  });
  it('race target/distance/time cannot be silently altered by a date review', () => {
    const { value } = available();
    value.race.after.targetSeconds = 10;
    expect(parse(value)).toBe(false);
  });
  it('bounds raw UTF8 before parsing and preserves escaped multibyte IDs', () => {
    const f = fixture();
    expect(parse({ ...f, unknown: '한'.repeat(1500000) })).toBe(false);
    const { value, nutrition } = available();
    const long = '식"\\'.repeat(100);
    first(nutrition.before.plan.items).id = long;
    first(nutrition.after.plan.items).id = long;
    first(nutrition.timings).itemId = long;
    first(value.notices).itemId = long;
    expect(parse(value)).toBe(true);
  });
  it('bounds complete global node visits even for individually valid arrays', () => {
    const { value, training } = available();
    training.before.plan.sessions = Array.from({ length: 600 }, (_, index) => ({
      ...first(training.before.plan.sessions),
      id: String(index),
    }));
    training.after.plan = structuredClone(training.before.plan);
    expect(parse(value)).toBe(false);
  });
  it('rejects getters without evaluating them, cycles, exotic values and deep input', () => {
    let calls = 0;
    const f = { ...fixture() };
    Object.defineProperty(f, 'context', {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    expect(parse(f)).toBe(false);
    expect(calls).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle.loop = cycle;
    expect(parse(cycle)).toBe(false);
    expect(parse({ ...fixture(), source: new Date() })).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(parse(deep)).toBe(false);
  });
  it('requires exact preservation notices and affected roster without false claims', () => {
    const f = fixture();
    expect(parse({ ...f, notices: [] })).toBe(false);
    expect(parse({ ...f, affected: [{ domain: 'training', aggregateId: id(1) }] })).toBe(false);
    expect(
      parse({
        ...f,
        notices: [
          ...f.notices,
          {
            domain: 'nutrition',
            aggregateId: id(2),
            itemId: 'other',
            code: 'DISCONNECTED_RETAINED',
          },
        ],
      }),
    ).toBe(false);
  });
  it('preserves ordered arrays but does not mistake object-key order for a change', () => {
    const { value, routine } = available();
    const occurrence: RoutineOccurrence = {
      id: 'occ',
      schedule: { id: id(4), versionId: routine.before.schedule.versionId },
      blueprint: { id: 'bp', versionId: 'bp-v1' },
      anchorKey: 'key',
      scheduledAt: stamp,
      timingStatus: 'resolved',
      stepBindings: [],
      selectedChoices: { groupA: 'a', groupB: 'b' },
    };
    routine.before.expansion = { state: 'expanded', occurrences: [occurrence] };
    routine.after.expansion = {
      state: 'expanded',
      occurrences: [{ ...occurrence, selectedChoices: { groupB: 'b', groupA: 'a' } }],
    };
    expect(parse(value)).toBe(true);
    routine.after.schedule.rule = {
      kind: 'period_days',
      periodId: 'p',
      offsetsDays: [1, 0],
      localTime: null,
    };
    expect(parse(value)).toBe(false);
  });
  it('fresh blocked response is separate and does not mint a stored reference', () => {
    const blocked = {
      schemaVersion: 1,
      status: 'blocked',
      stage: 'application',
      blockers: [
        {
          reason: 'affected_timing_unresolved',
          target: { domain: 'nutrition', aggregateId: id(2) },
        },
      ],
      resolutionRequirements: [
        {
          domain: 'nutrition',
          aggregateId: id(2),
          planVersionId: id(12),
          itemId: 'Meal',
          action: 'replace_anchor_and_review',
        },
      ],
    };
    expect(raceManualPublicPreviewBlockedSchema.safeParse(blocked).success).toBe(true);
    expect(parse(blocked)).toBe(false);
    expect(
      raceManualPublicPreviewBlockedSchema.safeParse({ ...blocked, reference: fixture().reference })
        .success,
    ).toBe(false);
  });
});
