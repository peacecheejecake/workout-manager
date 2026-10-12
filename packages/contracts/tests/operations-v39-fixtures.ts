import {
  accountExportV35Schema,
  accountExportV37Schema,
  accountExportV38Schema,
} from '../src/operations.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
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

export { empty, fixture };
