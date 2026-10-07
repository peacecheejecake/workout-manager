import { expect, it } from 'vitest';
import {
  raceManualApprovalCandidateSchema,
  raceManualApprovalCommandSchema,
  raceManualApprovalExpectedHeadsSchema,
  raceManualApprovalNutritionKey,
  raceManualApprovalResultSchema,
  raceManualApprovalWriteSchema,
} from '../src/race-manual-approval.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const training = {
  domain: 'training',
  aggregateId: id(1),
  expectedHead: { kind: 'exists', versionId: 'Snapshot-식-A', version: 2 },
  proposed: {
    title: 'Training',
    timezone: 'UTC',
    periods: [
      {
        id: 'Season-식-A',
        parentId: null,
        level: 'season',
        title: 'Season',
        startDate: '2026-10-06',
        endDateExclusive: '2026-10-10',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      },
    ],
    sessions: [],
  },
};
const nutrition = {
  domain: 'nutrition',
  aggregateId: id(2),
  expectedHead: { kind: 'exists', versionId: id(12), version: 3 },
  intent: {
    schemaVersion: 4,
    intent: {
      schemaVersion: 3,
      command: {
        kind: 'update',
        planId: id(2),
        expectedHeadVersionId: id(12),
        confirmed: true,
        idempotencyKey: raceManualApprovalNutritionKey(id(30), id(2)),
        draft: {
          period: { from: '2026-10-06', toInclusive: '2026-10-09' },
          purpose: 'Manual nutrition',
          timezone: 'UTC',
          linkedTrainingPlanVersionId: null,
          items: [
            {
              id: 'Meal-식-A',
              category: 'before',
              title: 'Retained',
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
                  sourceBasis: 'unknown',
                },
              ],
              targets: [],
              instructions: 'Preserve food',
              evidenceIds: [],
              source: 'user_confirmed',
            },
          ],
        },
      },
      expectedRaceHeads: [],
      reconnectItemIds: [],
    },
  },
};
const recovery = {
  domain: 'recovery',
  aggregateId: id(3),
  expectedHead: { kind: 'exists', versionId: id(13), version: 4 },
  selectedOptionId: id(50),
  proposed: {
    title: 'Recovery',
    goal: 'Manual review',
    startDate: '2026-10-06',
    endDateExclusive: '2026-10-10',
    timezone: 'UTC',
    knownFacts: [],
    missingInformation: [],
    priority: 'normal',
    observations: [],
    planRefs: [],
    options: [
      {
        id: id(50),
        title: 'Rest',
        kind: 'full_rest',
        methodVersionId: null,
        explanation: 'Manual option',
      },
    ],
    reassessment: [
      {
        id: id(51),
        trigger: 'plan_changed',
        description: 'Review',
        plannedAt: null,
        policyVersion: null,
      },
    ],
  },
};
const routine = {
  domain: 'routine_schedule',
  aggregateId: id(4),
  expectedHead: { kind: 'exists', versionId: 'Schedule-Version-A' },
  sourcePlanVersionId: null,
  proposed: {
    schemaVersion: 4,
    id: id(4),
    versionId: 'Schedule-Version-B',
    blueprint: { id: 'Blueprint-식-A', versionId: 'Blueprint-Version-A' },
    window: {
      startDate: '2026-10-06',
      endDateExclusive: '2026-10-10',
      timezone: 'UTC',
      maxOccurrences: 4,
    },
    rule: { kind: 'dates', dates: ['2026-10-08'], localTime: '07:00' },
    state: 'active',
  },
  occurrences: [
    {
      id: 'Occurrence-식-A',
      schedule: { id: id(4), versionId: 'Schedule-Version-B' },
      blueprint: { id: 'Blueprint-식-A', versionId: 'Blueprint-Version-A' },
      anchorKey: 'Anchor-식-A',
      scheduledAt: '2026-10-08T07:00:00Z',
      timingStatus: 'resolved',
      stepBindings: [],
      selectedChoices: {},
    },
  ],
};
function candidate() {
  return {
    schemaVersion: 1,
    candidateId: id(30),
    chain: {
      evidenceId: id(31),
      decisionId: id(32),
      proposalId: id(33),
      readonlyCandidateDigest: 'a'.repeat(64),
    },
    applicationDigest: 'b'.repeat(64),
    createdAt: '2026-10-08T00:00:00Z',
    raceChange: { eventId: id(40), expectedRevision: 2, newLocalDate: '2026-10-08' },
    authority: 'server_revalidation_required',
    expectation: {
      restoreGeneration: id(41),
      appRevision: 3,
      manualPolicy: { id: 'manual-race-date-impact', version: 1, digest: 'c'.repeat(64) },
      semanticDigest: 'd'.repeat(64),
      heads: {
        training: {
          state: 'present',
          members: [{ aggregateId: training.aggregateId, head: training.expectedHead }],
        },
        nutrition: {
          state: 'present',
          members: [{ aggregateId: nutrition.aggregateId, head: nutrition.expectedHead }],
        },
        recovery: {
          state: 'present',
          members: [{ aggregateId: recovery.aggregateId, head: recovery.expectedHead }],
        },
        routine_schedule: {
          state: 'present',
          members: [{ aggregateId: routine.aggregateId, head: routine.expectedHead }],
        },
      },
    },
    applicationState: 'ready_for_explicit_approval',
    scope: 'whole_affected',
    affected: [training, nutrition, recovery, routine].map((w) => ({
      domain: w.domain,
      aggregateId: w.aggregateId,
    })),
    writes: structuredClone([training, nutrition, recovery, routine]),
    notices: [],
  };
}
function parsed() {
  const c = raceManualApprovalCandidateSchema.parse(candidate());
  if (c.applicationState !== 'ready_for_explicit_approval') throw Error('Fixture');
  return c;
}
function command() {
  const { candidateId, chain, applicationDigest, raceChange, expectation } = parsed();
  return {
    schemaVersion: 1,
    idempotencyKey: 'outer_approval_key',
    confirmed: true,
    candidateId,
    chain,
    applicationDigest,
    raceChange,
    expectation,
  };
}
it('allfour strict server recipes roundtrip; ready state is not a writer seal', () => {
  const c = parsed();
  expect(c.writes).toHaveLength(4);
  expect(c.authority).toBe('server_revalidation_required');
  expect(raceManualApprovalCommandSchema.parse(command())).toEqual(command());
  expect(c.writes.find((w) => w.domain === 'training')?.expectedHead).toEqual({
    kind: 'exists',
    versionId: 'Snapshot-식-A',
    version: 2,
  });
});
it('routine versionless and opaque snapshots are preserved independently from UUID aggregate identities', () => {
  const c = parsed();
  expect(c.expectation.heads.routine_schedule).toEqual({
    state: 'present',
    members: [{ aggregateId: id(4), head: { kind: 'exists', versionId: 'Schedule-Version-A' } }],
  });
  expect(
    raceManualApprovalExpectedHeadsSchema.safeParse({
      ...c.expectation.heads,
      routine_schedule: {
        state: 'present',
        members: [
          {
            aggregateId: id(4),
            head: { kind: 'exists', versionId: 'Schedule-Version-A', version: 1 },
          },
        ],
      },
    }).success,
  ).toBe(false);
});
it('whole absent portfolios and explicit absent write head can express a new aggregate without inventing a current version', () => {
  const c = parsed();
  c.expectation.heads.training = { state: 'absent' };
  const w = c.writes.find((w) => w.domain === 'training');
  if (w?.domain !== 'training') throw Error('fixture');
  w.expectedHead = { kind: 'absent' };
  expect(raceManualApprovalCandidateSchema.safeParse(c).success).toBe(true);
  const heads = {
    training: { state: 'absent' },
    nutrition: { state: 'absent' },
    recovery: { state: 'absent' },
    routine_schedule: { state: 'absent' },
  };
  expect(raceManualApprovalExpectedHeadsSchema.safeParse(heads).success).toBe(true);
  expect(
    raceManualApprovalExpectedHeadsSchema.safeParse({ ...heads, training: undefined }).success,
  ).toBe(false);
});
it.each([
  'omitted',
  'extra',
  'duplicate',
  'head',
  'version',
  'snapshot',
  'key',
  'plan',
  'option',
  'lineage',
  'unresolved',
  'window',
] as const)('rejects %s topology or scope mismatch', (kind) => {
  const c = parsed();
  if (kind === 'omitted') c.writes.pop();
  else if (kind === 'extra') c.affected.pop();
  else if (kind === 'duplicate') {
    const first = c.writes[0];
    if (!first) throw Error('fixture');
    c.writes.push(first);
  } else if (kind === 'head') c.expectation.heads.nutrition = { state: 'absent' };
  else if (kind === 'version') {
    const w = c.writes.find((w) => w.domain === 'nutrition');
    if (w?.domain === 'nutrition') w.expectedHead.version++;
  } else if (kind === 'snapshot') {
    const w = c.writes.find((w) => w.domain === 'training');
    if (w?.domain === 'training' && w.expectedHead.kind === 'exists')
      w.expectedHead.versionId = w.aggregateId;
  } else if (kind === 'key') {
    const w = c.writes.find((w) => w.domain === 'nutrition');
    if (w?.domain === 'nutrition') w.intent.intent.command.idempotencyKey = 'arbitrary_key';
  } else if (kind === 'plan') {
    const w = c.writes.find((w) => w.domain === 'nutrition');
    if (w?.domain === 'nutrition') w.intent.intent.command.planId = id(99);
  } else if (kind === 'option') {
    const w = c.writes.find((w) => w.domain === 'recovery');
    if (w?.domain === 'recovery') w.selectedOptionId = id(99);
  } else {
    const w = c.writes.find((w) => w.domain === 'routine_schedule');
    if (w?.domain !== 'routine_schedule') throw Error('fixture');
    const o = w.occurrences[0];
    if (!o) throw Error('fixture');
    if (kind === 'lineage') o.blueprint.versionId = 'Foreign';
    else if (kind === 'unresolved') {
      o.timingStatus = 'unresolved';
      o.scheduledAt = null;
    } else w.proposed.window.maxOccurrences = 0;
  }
  expect(raceManualApprovalCandidateSchema.safeParse(c).success).toBe(false);
});
it('UUIDcase duplicate aggregate aliases are rejected while opaque inner case/Unicode is preserved', () => {
  const c = parsed(),
    r = c.expectation.heads.nutrition;
  if (r.state !== 'present') throw Error('fixture');
  const m = r.members[0];
  if (!m) throw Error('fixture');
  r.members.push({ ...m, aggregateId: m.aggregateId.toUpperCase() });
  expect(raceManualApprovalCandidateSchema.safeParse(c).success).toBe(false);
  const w = parsed().writes.find((w) => w.domain === 'nutrition');
  if (w?.domain !== 'nutrition') throw Error('fixture');
  const item = w.intent.intent.command.draft.items[0];
  if (!item) throw Error('fixture');
  item.id = 'Meal-食-A'.repeat(1000);
  expect(raceManualApprovalWriteSchema.parse(w)).toEqual(w);
});
it.each(['recipe', 'auth', 'policy', 'hash', 'legacy2', 'legacy4'] as const)(
  'command rejects %s interchange or credential shape',
  (kind) => {
    const c = command();
    const value =
      kind === 'recipe'
        ? { ...c, writes: parsed().writes }
        : kind === 'auth'
          ? { ...c, permission: true }
          : kind === 'policy'
            ? {
                ...c,
                expectation: {
                  ...c.expectation,
                  manualPolicy: { ...c.expectation.manualPolicy, aiGranted: true },
                },
              }
            : kind === 'hash'
              ? { ...c, applicationDigest: 'unsealed' }
              : { ...c, schemaVersion: kind === 'legacy2' ? 2 : 4 };
    expect(raceManualApprovalCommandSchema.safeParse(value).success).toBe(false);
  },
);
it('blocked candidate has finite diagnostics and no mutation recipes or ready flag', () => {
  const { affected: _, writes: __, notices: ___, scope: ____, ...base } = candidate();
  const c = {
    ...base,
    applicationState: 'blocked',
    blockers: [
      {
        reason: 'affected_timing_unresolved',
        target: { domain: 'routine_schedule', aggregateId: id(4) },
      },
    ],
  };
  expect(raceManualApprovalCandidateSchema.safeParse(c).success).toBe(true);
  expect(raceManualApprovalCandidateSchema.safeParse({ ...c, blockers: [] }).success).toBe(false);
  expect(raceManualApprovalCandidateSchema.safeParse({ ...c, writes: [] }).success).toBe(false);
});
it('candidate-bound nutrition child key is deterministic and distinct per candidate/plan, not outer receipt authority', () => {
  const k = raceManualApprovalNutritionKey(id(30), id(2));
  expect(k).toHaveLength(79);
  expect(raceManualApprovalNutritionKey(id(30).toUpperCase(), id(2))).toBe(k);
  expect(raceManualApprovalNutritionKey(id(31), id(2))).not.toBe(k);
  expect(raceManualApprovalNutritionKey(id(30), id(3))).not.toBe(k);
});
it('minimal committed allfour result rejects duplicate versions, raw source/body and old wire versions', () => {
  const r = {
    schemaVersion: 1,
    status: 'committed',
    candidateId: id(30),
    approvalId: id(60),
    proposalId: id(33),
    approvedAt: '2026-10-08T00:00:00Z',
    race: { eventId: id(40), revision: 3 },
    versions: [
      { domain: 'training', aggregateId: id(1), versionId: 'NewSnapshot-食-A', version: 3 },
      { domain: 'nutrition', aggregateId: id(2), versionId: id(62), version: 4 },
      { domain: 'recovery', aggregateId: id(3), versionId: id(63), version: 5 },
      { domain: 'routine_schedule', aggregateId: id(4), versionId: 'Schedule-Version-B' },
    ],
    occurrenceIds: ['Occurrence-食-A'],
    notices: [],
  };
  expect(raceManualApprovalResultSchema.parse(r)).toEqual(r);
  for (const value of [
    { ...r, versions: [...r.versions, r.versions[0]] },
    { ...r, occurrenceIds: ['Occurrence', 'Occurrence'] },
    { ...r, payload: parsed() },
    { ...r, schemaVersion: 2 },
    { ...r, schemaVersion: 4 },
  ])
    expect(raceManualApprovalResultSchema.safeParse(value).success).toBe(false);
});
it('plain preflight rejects accessors, cycles, nonplain values, huge strings/keys and escaped output before nested decoding', () => {
  let reads = 0;
  const getter = {};
  Object.defineProperty(getter, 'schemaVersion', {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const value of [
    getter,
    cycle,
    new Date(),
    { x: Infinity },
    { x: '食'.repeat(1400000) },
    { ['x'.repeat(4194305)]: null },
    { x: '\n'.repeat(2100000) },
  ])
    expect(raceManualApprovalCommandSchema.safeParse(value).success).toBe(false);
  expect(reads).toBe(0);
});

it('V4 intent supports multiple affected race items and explicit reconnect plus retained disconnection without client pins', () => {
  const w = parsed().writes.find((w) => w.domain === 'nutrition');
  if (w?.domain !== 'nutrition') throw Error('fixture');
  const first = w.intent.intent.command.draft.items[0];
  if (!first) throw Error('fixture');
  w.intent.intent.command.draft.items.push(
    {
      ...structuredClone(first),
      id: 'Reconnect-食-A',
      anchor: {
        kind: 'relative',
        entity: 'race',
        entityId: id(40),
        point: 'start',
        offsetMinutes: -30,
      },
    },
    {
      ...structuredClone(first),
      id: 'Other-食-A',
      anchor: {
        kind: 'relative',
        entity: 'race',
        entityId: id(40),
        point: 'end',
        offsetMinutes: 0,
      },
    },
  );
  w.intent.intent.expectedRaceHeads = [{ namespace: 'race-event', eventId: id(40), revision: 3 }];
  w.intent.intent.reconnectItemIds = ['Reconnect-食-A'];
  expect(raceManualApprovalWriteSchema.safeParse(w).success).toBe(true);
  expect(
    raceManualApprovalWriteSchema.safeParse({
      ...w,
      intent: { ...w.intent, intent: { ...w.intent.intent, raceTimingPins: [] } },
    }).success,
  ).toBe(false);
  expect(
    raceManualApprovalWriteSchema.safeParse({
      ...w,
      intent: { ...w.intent, intent: { ...w.intent.intent, expectedRaceHeads: [] } },
    }).success,
  ).toBe(false);
  expect(
    raceManualApprovalWriteSchema.safeParse({
      ...w,
      intent: { ...w.intent, intent: { ...w.intent.intent, reconnectItemIds: ['Meal-식-A'] } },
    }).success,
  ).toBe(false);
});
it('opaque schedule version case remains distinct; exact unchanged version and UUID alias duplication are rejected', () => {
  const w = parsed().writes.find((w) => w.domain === 'routine_schedule');
  if (w?.domain !== 'routine_schedule') throw Error('fixture');
  w.proposed.versionId = 'Schedule-Version-A';
  for (const o of w.occurrences) o.schedule.versionId = w.proposed.versionId;
  expect(raceManualApprovalWriteSchema.safeParse(w).success).toBe(false);
  w.proposed.versionId = 'schedule-version-a';
  for (const o of w.occurrences) o.schedule.versionId = w.proposed.versionId;
  expect(raceManualApprovalWriteSchema.safeParse(w).success).toBe(true);
  const o = w.occurrences[0];
  if (!o) throw Error('fixture');
  o.id = id(80);
  w.occurrences.push({ ...structuredClone(o), id: id(80).toUpperCase(), anchorKey: 'Different' });
  expect(raceManualApprovalWriteSchema.safeParse(w).success).toBe(false);
});

it('plain preflight rejects depth/visit bounds and nonenumerable or sparse array tampering', () => {
  let deep: unknown = {};
  for (let i = 0; i < 65; i++) deep = { child: deep };
  const hidden = {};
  Object.defineProperty(hidden, 'schemaVersion', { value: 1, enumerable: false });
  const sparse = Array(4);
  for (const value of [
    deep,
    hidden,
    sparse,
    Array.from({ length: 50001 }, () => null),
    { [Symbol('authority')]: true },
  ])
    expect(raceManualApprovalCandidateSchema.safeParse(value).success).toBe(false);
});
it('aggregate/head tuple current numeric revision and UUID alias identity are separate from snapshot namespace', () => {
  const c = parsed(),
    r = c.expectation.heads.training;
  if (r.state !== 'present') throw Error('fixture');
  const m = r.members[0];
  if (!m) throw Error('fixture');
  const w = c.writes.find((w) => w.domain === 'training');
  if (w?.domain !== 'training' || w.expectedHead.kind !== 'exists') throw Error('fixture');
  m.head.versionId = id(10).toUpperCase();
  w.expectedHead.versionId = id(10);
  expect(raceManualApprovalCandidateSchema.safeParse(c).success).toBe(true);
});
