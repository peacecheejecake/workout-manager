import { expect, it } from 'vitest';
import {
  accountExportSchema,
  accountExportV35Schema,
  accountExportV37Schema,
  accountExportV38Schema,
  parseAccountExportV38,
} from '../src/operations.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw Error('fixture');
  return row;
}
const at = '2026-10-08T00:00:00.123456Z';
function empty() {
  const base = accountExportV35Schema.parse({
    schemaVersion: 35,
    athleteId: 'synthetic',
    exportedAt: at,
    data: Object.fromEntries(
      Object.keys(accountExportV35Schema.shape.data.shape).map((k) => [k, []]),
    ),
  });
  return accountExportV37Schema.parse({
    ...base,
    schemaVersion: 37,
    data: {
      ...base.data,
      checkInTemplateVersions: [],
      checkInTemplateHeads: [],
      manualRaceReviews: [],
      manualRaceApprovalHistory: [],
      manualRaceCommandResults: [],
      trainingPlanAggregates: [],
      manualInternalChains: [],
      manualInternalCandidates: [],
      manualInternalApprovalResults: [],
      manualInternalApprovalHistory: [],
      sourceProvenanceCoverage: 'not_exported_policy_unresolved',
    },
  });
}
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

function fixture(purged = false) {
  const base = empty();
  return accountExportV38Schema.parse({
    ...base,
    schemaVersion: 38,
    data: {
      ...base.data,
      raceEventRevisions: [
        { entity_id: id(1), revision: 2, values_json: planned().race.before, created_at: at },
      ],
      sourceProvenanceCoverage: 'saved_safe_dependency_facts',
      sourceAuthentication: 'not_authenticated',
      originalEventAuthentication: 'not_authenticated',
      manualInternalChains: [
        {
          evidenceId: id(21),
          decisionId: id(22),
          proposalId: id(23),
          createdAt: at,
          proposalApplied: false,
          body: purged
            ? { state: 'purged', purgedAt: at, purgeEventId: id(50) }
            : { state: 'present', planned: planned() },
        },
      ],
      manualSourceChains: [
        {
          evidenceId: id(21),
          decisionId: id(22),
          proposalId: id(23),
          savedRefCount: 1,
          savedParentCount: 1,
          savedSuppressionCount: purged ? 1 : 0,
          body: purged
            ? { state: 'purged', eventId: id(50), occurredAt: at }
            : { state: 'present' },
        },
      ],
      manualSavedSourceRefs: [
        {
          evidenceId: id(21),
          ordinal: 1,
          identity: { kind: 'race-event', sourceId: id(1), revision: 2 },
          parentCoverage: 'saved_parents',
          existence: { basis: 'export_snapshot', state: purged ? 'deleted' : 'present' },
          location: purged
            ? { state: 'unavailable', reason: 'payload_purged' }
            : {
                state: 'known',
                members: [
                  {
                    domain: 'race',
                    aggregateId: id(1),
                    side: 'before',
                    component: 'race_timing',
                    memberId: null,
                    parent: { family: 'race-event', sourceId: id(1), revision: 2 },
                  },
                ],
              },
        },
      ],
      manualSavedSourceParents: [
        {
          evidenceId: id(21),
          ordinal: 1,
          identity: { family: 'race-event', sourceId: id(1), revision: 2 },
          role: 'source',
          membership: null,
        },
      ],
      manualSavedSourceSuppressions: purged
        ? [
            {
              evidenceId: id(21),
              eventId: id(50),
              occurredAt: at,
              recordVersion: 5,
              kind: 'race_event_deleted',
              matchedRefOrdinals: [1],
            },
          ]
        : [],
      nutritionDisconnectionOrigins: [],
      nutritionDisconnectionLineage: [],
    },
  });
}
it('accepts chain-only ALL source census and uses required bounded V38 entry without authentication', () => {
  const v = fixture();
  expect(parseAccountExportV38(v)).toEqual(v);
  expect(accountExportSchema.parse(v)).toEqual(v);
  expect(v.data.manualInternalCandidates).toEqual([]);
  expect(v.data.sourceAuthentication).toBe('not_authenticated');
});
it('preserves historical V37 exact coverage and union', () => {
  const v = empty();
  expect(accountExportSchema.parse(v)).toEqual(v);
  expect(accountExportV37Schema.parse(v)).toEqual(v);
  expect(accountExportV38Schema.safeParse(v).success).toBe(false);
});
it('requires all new source collections without defaults', () => {
  for (const key of [
    'manualSourceChains',
    'manualSavedSourceRefs',
    'manualSavedSourceParents',
    'manualSavedSourceSuppressions',
    'nutritionDisconnectionOrigins',
    'nutritionDisconnectionLineage',
  ]) {
    const v = fixture();
    Reflect.deleteProperty(v.data, key);
    expect(accountExportV38Schema.safeParse(v).success).toBe(false);
  }
});
it('rejects missing and extra ALL chains and substituted original roles', () => {
  const missing = fixture();
  missing.data.manualSourceChains = [];
  expect(accountExportV38Schema.safeParse(missing).success).toBe(false);
  const extra = fixture();
  extra.data.manualInternalChains = [];
  expect(accountExportV38Schema.safeParse(extra).success).toBe(false);
  const roles = fixture();
  first(roles.data.manualSourceChains).decisionId = id(55);
  expect(accountExportV38Schema.safeParse(roles).success).toBe(false);
});
it('requires purge source event and exact microseconds without inventing public metadata', () => {
  const v = fixture(true);
  expect(parseAccountExportV38(v)).toEqual(v);
  first(v.data.manualInternalChains).body = {
    state: 'purged',
    purgedAt: '2026-10-08T00:00:00.123457Z',
    purgeEventId: id(50),
  };
  expect(accountExportV38Schema.safeParse(v).success).toBe(false);
});
it('rejects false future or wrong frozen location without weakening full parent membership', () => {
  for (const mutate of [
    (l: {
      side: 'before' | 'hypothetical_after';
      aggregateId: string;
      memberId: string | null;
    }) => {
      l.side = 'hypothetical_after';
    },
    (l: {
      side: 'before' | 'hypothetical_after';
      aggregateId: string;
      memberId: string | null;
    }) => {
      l.aggregateId = id(33);
    },
    (l: {
      side: 'before' | 'hypothetical_after';
      aggregateId: string;
      memberId: string | null;
    }) => {
      l.memberId = 'fake';
    },
  ]) {
    const v = fixture(),
      location = first(v.data.manualSavedSourceRefs).location;
    if (location.state !== 'known') throw Error('fixture');
    mutate(first(location.members));
    expect(accountExportV38Schema.safeParse(v).success).toBe(false);
  }
  const v = fixture();
  first(v.data.manualSavedSourceParents).identity = {
    family: 'race-event',
    sourceId: id(99),
    revision: 2,
  };
  expect(accountExportV38Schema.safeParse(v).success).toBe(false);
});
it('preserves distinct saved ordinals for lossy nonmanual safe identities without identifiers', () => {
  const v = fixture();
  first(v.data.manualSourceChains).savedRefCount = 2;
  first(v.data.manualSourceChains).savedParentCount = 2;
  v.data.manualSavedSourceRefs = Array.from({ length: 2 }, (_, i) => ({
    evidenceId: id(21),
    ordinal: i + 1,
    identity: {
      kind: 'manual-activity-source',
      sourceId: id(80),
      source: { kind: 'fit', sourceRevision: 0, identifier: 'sensitive_identifier_not_exported' },
    },
    parentCoverage: 'saved_parents',
    existence: { basis: 'export_snapshot', state: 'present' },
    location: { state: 'unavailable', reason: 'private_source_not_rendered' },
  }));
  v.data.manualSavedSourceParents = Array.from({ length: 2 }, (_, i) => ({
    evidenceId: id(21),
    ordinal: i + 1,
    identity: {
      family: 'activity',
      sourceId: id(80),
      version: {
        kind: 'source_revision',
        source: { kind: 'fit', sourceRevision: 0, identifier: 'sensitive_identifier_not_exported' },
      },
    },
    role: 'source',
    membership: null,
  }));
  expect(parseAccountExportV38(v).data.manualSavedSourceRefs).toHaveLength(2);
  const second = v.data.manualSavedSourceRefs[1];
  if (!second) throw Error('fixture');
  second.ordinal = 1;
  expect(accountExportV38Schema.safeParse(v).success).toBe(false);
});
it('preguards getters, sparse arrays, cycles, oversized escapes and depth before nested decode', () => {
  let getterCalls = 0;
  const getter = {
    get data() {
      getterCalls++;
      return {};
    },
  };
  expect(() => parseAccountExportV38(getter)).toThrow();
  expect(getterCalls).toBe(0);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(() => parseAccountExportV38(cycle)).toThrow();
  expect(() => parseAccountExportV38({ ...fixture(), data: new Array(2) })).toThrow();
  const v = fixture();
  v.data.planHistory.push({ value: '\\'.repeat(4194304) });
  expect(() => parseAccountExportV38(v)).toThrow();
});

function historicalNutrition() {
  const value = fixture();
  const records = [1, 2, 3].map((version) => {
    const versionId = id(60 + version);
    return {
      schemaVersion: 4,
      planId: id(60),
      versionId,
      version,
      previousVersionId: version === 1 ? null : id(59 + version),
      approvalId: id(70 + version),
      approvedAt: at,
      period: { from: '2026-10-08', toInclusive: '2026-10-09' },
      timezone: 'UTC',
      purpose: 'Retained zero/unknown',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: '식-"\\-' + '가'.repeat(1001),
          planVersionId: versionId,
          category: 'before',
          title: 'Food',
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
          instructions: 'Retained',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
      raceTimingPins: [],
      itemRaceTimingBindings: [],
    };
  });
  value.data.nutritionPlanVersions =
    accountExportV35Schema.shape.data.shape.nutritionPlanVersions.parse(
      records.map((record) => ({
        plan_id: record.planId,
        version_id: record.versionId,
        version: record.version,
        previous_version_id: record.previousVersionId,
        period_from: record.period.from,
        period_to: record.period.toInclusive,
        linked_training_plan_version_id: null,
        approval_id: record.approvalId,
        approved_at: at,
        record_json: record,
      })),
    );
  value.data.nutritionPlanHeads = [{ plan_id: id(60), version_id: id(63), version: 3 }];
  value.data.nutritionPlanHistory = records.map((record) => ({
    plan_id: id(60),
    version_id: record.versionId,
    approval_id: record.approvalId,
    action: 'user_approved',
    created_at: at,
  }));
  const itemId = first(first(value.data.nutritionPlanVersions).record_json.items).id;
  value.data.nutritionDisconnectionOrigins = [1, 2, 3].map((version) => ({
    planId: id(60),
    versionId: id(60 + version),
    itemId,
    originVersionId: id(60 + version),
    eventId: id(version === 1 ? 81 : 82),
    occurredAt: at,
    eventKind: 'race_event_deleted',
  }));
  value.data.nutritionDisconnectionLineage = [2, 3].map((version) => ({
    planId: id(60),
    versionId: id(60 + version),
    version,
    priorVersionId: id(59 + version),
    priorVersion: version - 1,
    itemId,
    originVersionId: id(61),
    eventId: id(81),
    disposition: version === 2 ? 'reconnected' : 'carried',
  }));
  return parseAccountExportV38(value);
}
it('accepts genuine-shaped historical reconnect redacted by second deletion and carried ancestry without reconstructing pins', () => {
  const v = historicalNutrition();
  expect(parseAccountExportV38(v)).toEqual(v);
  expect(
    first(v.data.nutritionPlanVersions).record_json.items[0]?.foods.map((f) => f.quantity),
  ).toEqual([0, null]);
  expect(v.data.nutritionDisconnectionOrigins).toHaveLength(3);
});
it('rejects fake historical reconnect redaction, substituted prior version/item and absent body', () => {
  const missing = historicalNutrition();
  missing.data.nutritionDisconnectionOrigins.pop();
  expect(accountExportV38Schema.safeParse(missing).success).toBe(false);
  const prior = historicalNutrition();
  first(prior.data.nutritionDisconnectionLineage).priorVersionId = id(99);
  expect(accountExportV38Schema.safeParse(prior).success).toBe(false);
  const member = historicalNutrition();
  first(member.data.nutritionDisconnectionOrigins).itemId = 'foreign';
  expect(accountExportV38Schema.safeParse(member).success).toBe(false);
  const body = historicalNutrition();
  body.data.nutritionPlanVersions.pop();
  expect(accountExportV38Schema.safeParse(body).success).toBe(false);
});
it('requires disconnected V4 lineage/origin while preserving an unknown historical V3 association', () => {
  const v = historicalNutrition();
  v.data.nutritionDisconnectionOrigins = [];
  v.data.nutritionDisconnectionLineage = [];
  expect(accountExportV38Schema.safeParse(v).success).toBe(false);
  const legacy = fixture();
  const row = first(historicalNutrition().data.nutritionPlanVersions);
  if (!('schemaVersion' in row.record_json)) throw Error('fixture');
  legacy.data.nutritionPlanVersions =
    accountExportV35Schema.shape.data.shape.nutritionPlanVersions.parse([
      { ...row, record_json: { ...row.record_json, schemaVersion: 3 } },
    ]);
  legacy.data.nutritionPlanHeads = [
    { plan_id: row.plan_id, version_id: row.version_id, version: 1 },
  ];
  legacy.data.nutritionPlanHistory = [
    {
      plan_id: row.plan_id,
      version_id: row.version_id,
      approval_id: row.approval_id,
      action: 'user_approved',
      created_at: at,
    },
  ];
  expect(parseAccountExportV38(legacy).data.nutritionDisconnectionOrigins).toEqual([]);
});
it('rejects known race before body substitution even when all IDs, ref counts and parent membership match', () => {
  const v = fixture();
  first(v.data.raceEventRevisions)['values_json'] = { ...planned().race.before, targetSeconds: 1 };
  expect(accountExportV38Schema.safeParse(v).success).toBe(false);
});

it('checks exact nutrition frozen body/member instead of merely matching its tuple', () => {
  const v = fixture();
  const chain = first(v.data.manualInternalChains);
  if (chain.body.state !== 'present' || chain.body.planned.nutrition.state !== 'present')
    throw Error('fixture');
  const member = first(chain.body.planned.nutrition.members),
    item = first(member.before.plan.items);
  const record = {
    planId: id(2),
    versionId: id(3),
    version: 1,
    previousVersionId: null,
    approvalId: id(91),
    approvedAt: at,
    ...member.before.plan,
    linkedTrainingPlanVersionId: null,
    items: member.before.plan.items.map((i) => ({
      ...i,
      planVersionId: id(3),
      source: 'user_confirmed',
      evidenceIds: [],
    })),
  };
  v.data.nutritionPlanVersions =
    accountExportV35Schema.shape.data.shape.nutritionPlanVersions.parse([
      {
        plan_id: id(2),
        version_id: id(3),
        version: 1,
        previous_version_id: null,
        period_from: record.period.from,
        period_to: record.period.toInclusive,
        linked_training_plan_version_id: null,
        approval_id: id(91),
        approved_at: at,
        record_json: record,
      },
    ]);
  v.data.nutritionPlanHeads = [{ plan_id: id(2), version_id: id(3), version: 1 }];
  v.data.nutritionPlanHistory = [
    {
      plan_id: id(2),
      version_id: id(3),
      approval_id: id(91),
      action: 'user_approved',
      created_at: at,
    },
  ];
  first(v.data.manualSavedSourceRefs).identity = {
    kind: 'nutrition-plan-version',
    sourceId: id(2),
    versionId: id(3),
  };
  first(v.data.manualSavedSourceRefs).location = {
    state: 'known',
    members: [
      {
        domain: 'nutrition',
        aggregateId: id(2),
        side: 'before',
        component: 'nutrition_item',
        memberId: item.id,
        parent: { family: 'nutrition-plan', sourceId: id(2), versionId: id(3) },
      },
    ],
  };
  first(v.data.manualSavedSourceParents).identity = {
    family: 'nutrition-plan',
    sourceId: id(2),
    versionId: id(3),
  };
  expect(parseAccountExportV38(v)).toEqual(v);
  first(first(v.data.nutritionPlanVersions).record_json.items).foods[0] = {
    foodVersionId: null,
    description: 'Zero',
    quantity: 1,
    unit: 'g',
    sourceBasis: 'manual_total',
  };
  expect(accountExportV38Schema.safeParse(v).success).toBe(false);
});
it('does not mistake carried provenance for an unchanged-anchor policy', () => {
  const v = historicalNutrition(),
    row = v.data.nutritionPlanVersions[2];
  if (!row) throw Error('fixture');
  first(row.record_json.items).anchor = {
    kind: 'absolute',
    date: '2026-10-09',
    localTime: null,
    timezone: 'UTC',
  };
  v.data.nutritionDisconnectionOrigins.pop();
  expect(parseAccountExportV38(v).data.nutritionDisconnectionLineage[1]?.disposition).toBe(
    'carried',
  );
});
