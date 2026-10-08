import { describe, expect, it } from 'vitest';
import { raceManualInternalPersonalExportSchema } from '../src/race-manual-internal-personal-export.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const at = '2026-10-08T00:00:00.123456Z';
function planned() {
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
  const item = {
    id: 'meal-식-' + 'x'.repeat(201),
    category: 'before',
    title: 'Meal',
    anchor: { kind: 'absolute', date: '2026-10-09', localTime: null, timezone: 'UTC' },
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
  const plan = {
    period: { from: '2026-10-08', toInclusive: '2026-10-11' },
    purpose: 'Fuel',
    timezone: 'UTC',
    items: [item],
  };
  const unresolved = { state: 'unresolved', reason: 'missing_session_time' };
  return {
    schemaVersion: 1,
    status: 'projected',
    approvalAllowed: false,
    persistence: 'stored_history',
    freshness: 'not_checked',
    expectedEvent: { id: id(1), revision: 2 },
    intent: {
      expectedEvent: { id: id(1), revision: 2 },
      newLocalDate: '2026-10-10',
      selection: { kind: 'keep_plan' },
      resolutions: { nutrition: [], routines: [] },
    },
    beforeBasis: 'frozen_review',
    afterBasis: 'hypothetical',
    race: {
      eventId: id(1),
      expectedRevision: 2,
      before: race,
      after: { ...race, localDate: '2026-10-10' },
    },
    training: { state: 'absent' },
    recovery: { state: 'absent' },
    routines: { state: 'absent' },
    nutrition: {
      state: 'present',
      members: [
        {
          aggregateId: id(2),
          before: {
            ref: { versionId: id(3), version: 1 },
            plan,
            linkedTraining: { kind: 'absent' },
          },
          after: { plan: structuredClone(plan), linkedTraining: { kind: 'absent' } },
          timings: [
            {
              itemId: item.id,
              state: 'unchanged',
              before: unresolved,
              after: unresolved,
              resolution: 'absent',
              requirement: 'none',
            },
          ],
        },
      ],
    },
    retainedUnplanned: [],
    affected: [],
    resolutionRequirements: [],
    notices: [
      { domain: 'nutrition', aggregateId: id(2), itemId: item.id, code: 'UNCHANGED_UNRESOLVED' },
    ],
  };
}

function fixture() {
  const chain = { evidenceId: id(20), decisionId: id(21), proposalId: id(22) };
  return {
    schemaVersion: 1,
    sourceProvenanceCoverage: 'not_exported_policy_unresolved',
    manualInternalChains: [
      {
        ...chain,
        createdAt: at,
        proposalApplied: false,
        body: { state: 'present', planned: planned() },
      },
    ],
    manualInternalCandidates: [
      {
        candidateId: id(23),
        chain,
        createdAt: at,
        body: {
          state: 'present',
          storedApplicationState: 'ready_for_explicit_approval',
          planned: planned(),
        },
      },
    ],
    manualInternalApprovalResults: [
      {
        schemaVersion: 1,
        status: 'committed',
        candidateId: id(23),
        approvalId: id(24),
        proposalId: id(22),
        approvedAt: at,
        race: { eventId: id(1), revision: 3 },
        versions: [],
        occurrenceIds: [],
        notices: [],
      },
    ],
    manualInternalApprovalHistory: [],
  };
}
function parsed() {
  return raceManualInternalPersonalExportSchema.parse(fixture());
}
function chain(v: ReturnType<typeof parsed>) {
  const x = v.manualInternalChains[0];
  if (!x) throw Error('fixture');
  return x;
}
function candidate(v: ReturnType<typeof parsed>) {
  const x = v.manualInternalCandidates[0];
  if (!x) throw Error('fixture');
  return x;
}
describe('internal retained personal facts', () => {
  it('retains internal race-only approval without any public receipt/reference', () => {
    const v = parsed();
    expect(v.manualInternalApprovalResults).toHaveLength(1);
    expect(JSON.stringify(v)).not.toMatch(
      /applicationDigest|candidateDigest|idempotencyKey|sourceInput|sqlObservations/,
    );
    expect(chain(v).createdAt).toBe(at);
  });
  it('retains chain-only unresolved planned food quantities and long opaque ID', () => {
    const v = parsed();
    v.manualInternalCandidates = [];
    v.manualInternalApprovalResults = [];
    const x = raceManualInternalPersonalExportSchema.parse(v),
      b = chain(x).body;
    if (b.state !== 'present' || b.planned.nutrition.state !== 'present') throw Error('fixture');
    const m = b.planned.nutrition.members[0];
    if (!m) throw Error('fixture');
    expect(m.before.plan.items[0]?.id.length).toBeGreaterThan(200);
    expect(m.before.plan.items[0]?.foods.map((f) => f.quantity)).toEqual([0, null]);
    expect(m.timings[0]?.after.state).toBe('unresolved');
  });
  it('retains blocked application as stored blocked, never success', () => {
    const v = parsed();
    v.manualInternalApprovalResults = [];
    const parentBody = chain(v).body;
    if (parentBody.state !== 'present') throw Error('fixture');
    candidate(v).body = {
      state: 'present',
      storedApplicationState: 'blocked',
      planned: parentBody.planned,
      blockers: [{ reason: 'source_unavailable', target: null }],
    };
    expect(
      raceManualInternalPersonalExportSchema.parse(v).manualInternalCandidates[0]?.body.state,
    ).toBe('present');
  });
  it('keeps original success after authentic paired purge metadata without body', () => {
    const v = parsed();
    chain(v).body = { state: 'purged', purgedAt: at, purgeEventId: id(30) };
    candidate(v).body = { state: 'purged', purgedAt: at, purgeEventId: id(30) };
    const x = raceManualInternalPersonalExportSchema.parse(v);
    expect(x.manualInternalApprovalResults).toHaveLength(1);
    expect(JSON.stringify(x)).not.toContain('Meal');
  });
  it.each(['context', 'permission', 'publicReference', 'recipe', 'rawProvider'])(
    'rejects extra private field %s',
    (field) => {
      expect(
        raceManualInternalPersonalExportSchema.safeParse({ ...fixture(), [field]: {} }).success,
      ).toBe(false);
    },
  );
  it('preserves planned numerical goal definitions while rejecting nested evidence IDs', () => {
    const v = parsed();
    for (const b of [chain(v).body, candidate(v).body]) {
      if (b.state !== 'present' || b.planned.nutrition.state !== 'present') throw Error('fixture');
      const m = b.planned.nutrition.members[0];
      if (!m) throw Error('fixture');
      for (const side of [m.before, m.after]) {
        const item = side.plan.items[0];
        if (!item) throw Error('fixture');
        item.targets = [
          { metric: 'energy', amount: { min: 0, max: 100, unit: 'kcal', basis: 'user_confirmed' } },
        ];
      }
    }
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(true);
    const b = chain(v).body;
    if (b.state !== 'present' || b.planned.nutrition.state !== 'present') throw Error('fixture');
    const m = b.planned.nutrition.members[0],
      item = m?.before.plan.items[0];
    if (!m || !item) throw Error('fixture');
    const goal = item.targets[0];
    if (!goal) throw Error('fixture');
    const dirty = {
      ...v,
      manualInternalChains: [
        {
          ...chain(v),
          body: {
            ...b,
            planned: {
              ...b.planned,
              nutrition: {
                state: 'present',
                members: [
                  {
                    ...m,
                    before: {
                      ...m.before,
                      plan: {
                        ...m.before.plan,
                        items: [
                          {
                            ...item,
                            targets: [
                              {
                                ...goal,
                                amount: {
                                  ...goal.amount,
                                  evidenceIds: ['PRIVATE_EVIDENCE_SENTINEL'],
                                },
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    };
    expect(raceManualInternalPersonalExportSchema.safeParse(dirty).success).toBe(false);
  });
  it('rejects wrong committed race revision and affected membership', () => {
    const v = parsed(),
      r = v.manualInternalApprovalResults[0];
    if (!r) throw Error('fixture');
    r.race.revision = 4;
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
    r.race.revision = 3;
    r.versions = [{ domain: 'nutrition', aggregateId: id(2), versionId: id(3), version: 1 }];
    v.manualInternalApprovalHistory = [
      {
        candidateId: id(23),
        approvalId: id(24),
        domain: 'nutrition',
        aggregateId: id(2),
        versionId: id(3),
        approvedAt: at,
      },
    ];
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
  });
  it('compares equivalent timestamp spelling without discarding microseconds', () => {
    const v = parsed();
    chain(v).body = {
      state: 'purged',
      purgedAt: '2026-10-08T00:00:00.1234560Z',
      purgeEventId: id(30),
    };
    candidate(v).body = { state: 'purged', purgedAt: at, purgeEventId: id(30) };
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(true);
    candidate(v).body = {
      state: 'purged',
      purgedAt: '2026-10-08T00:00:00.123457Z',
      purgeEventId: id(30),
    };
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
  });
  it('rejects foreign before body even when intent/IDs agree', () => {
    const v = parsed(),
      b = candidate(v).body;
    if (b.state !== 'present' || b.planned.nutrition.state !== 'present') throw Error('fixture');
    const m = b.planned.nutrition.members[0];
    if (!m) throw Error('fixture');
    m.before.plan.purpose = 'Other';
    m.after.plan.purpose = 'Other';
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
  });
  it('rejects mixed purge state and conflicting event', () => {
    const v = parsed();
    candidate(v).body = { state: 'purged', purgedAt: at, purgeEventId: id(30) };
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
    chain(v).body = { state: 'purged', purgedAt: at, purgeEventId: id(31) };
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
  });
  it('rejects duplicate/case alias chain identities', () => {
    const v = parsed();
    v.manualInternalChains.push({ ...chain(v), evidenceId: chain(v).evidenceId.toUpperCase() });
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
  });
  it('rejects extra history and missing original version history', () => {
    const v = parsed();
    v.manualInternalApprovalHistory.push({
      candidateId: id(23),
      approvalId: id(24),
      domain: 'nutrition',
      aggregateId: id(2),
      versionId: id(3),
      approvedAt: at,
    });
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
    chain(v).body = { state: 'purged', purgedAt: at, purgeEventId: id(30) };
    candidate(v).body = { state: 'purged', purgedAt: at, purgeEventId: id(30) };
    const r = v.manualInternalApprovalResults[0];
    if (!r) throw Error('fixture');
    r.versions = [{ domain: 'nutrition', aggregateId: id(2), versionId: id(3), version: 1 }];
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(true);
    v.manualInternalApprovalHistory = [];
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
  });
  it('rejects caller digest/seal and transient metadata substitution', () => {
    const v = parsed(),
      b = chain(v).body;
    if (b.state !== 'present') throw Error('fixture');
    expect(
      raceManualInternalPersonalExportSchema.safeParse({
        ...v,
        manualInternalChains: [{ ...chain(v), candidateDigest: 'a'.repeat(64) }],
      }).success,
    ).toBe(false);
    expect(
      raceManualInternalPersonalExportSchema.safeParse({
        ...v,
        manualInternalChains: [
          { ...chain(v), body: { ...b, planned: { ...b.planned, persistence: 'not_stored' } } },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects missing required collections and source coverage authority claim', () => {
    const { manualInternalCandidates: _missing, ...v } = fixture();
    void _missing;
    expect(raceManualInternalPersonalExportSchema.safeParse(v).success).toBe(false);
    expect(
      raceManualInternalPersonalExportSchema.safeParse({
        ...fixture(),
        sourceProvenanceCoverage: 'authenticated',
      }).success,
    ).toBe(false);
  });
  it('rejects getters, cycles, depth and complete visit overflow before nested parsing', () => {
    const raw = {
      get manualInternalChains() {
        throw Error('accessed');
      },
    };
    expect(raceManualInternalPersonalExportSchema.safeParse(raw).success).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(raceManualInternalPersonalExportSchema.safeParse(cycle).success).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 65; i++) deep = { next: deep };
    expect(raceManualInternalPersonalExportSchema.safeParse(deep).success).toBe(false);
    expect(
      raceManualInternalPersonalExportSchema.safeParse({
        ...fixture(),
        extra: Array.from({ length: 5001 }, () => null),
      }).success,
    ).toBe(false);
  });
});
