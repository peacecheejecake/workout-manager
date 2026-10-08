import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  accountExportSchema,
  accountExportV35Schema,
  accountExportV36Schema,
  accountExportV37Schema,
  parseAccountExportV37,
} from '../src/operations.js';
import { checkInTemplateVersionSchema } from '../src/check-in-templates.js';
import { raceManualApprovalResultSchema } from '../src/race-manual-approval.js';
import { planDraftSchema } from '../src/planning.js';
function first<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (value === undefined) throw Error('Missing fixture row');
  return value;
}
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const at = '2026-10-08T00:00:00.123456Z';
function legacy() {
  return accountExportV35Schema.parse({
    schemaVersion: 35,
    athleteId: 'synthetic',
    exportedAt: at,
    data: Object.fromEntries(
      Object.keys(accountExportV35Schema.shape.data.shape).map((key) => [key, []]),
    ),
  });
}
function empty() {
  return accountExportV36Schema.parse({
    ...legacy(),
    schemaVersion: 36,
    data: {
      ...legacy().data,
      checkInTemplateVersions: [],
      checkInTemplateHeads: [],
      manualRaceReviews: [],
      manualRaceApprovalHistory: [],
      manualRaceCommandResults: [],
      trainingPlanAggregates: [],
    },
  });
}
function template(version = 1) {
  const body = checkInTemplateVersionSchema.parse({
    templateId: id(1),
    versionId: id(10 + version),
    version,
    previousVersionId: version === 1 ? null : id(10 + version - 1),
    previousVersion: version === 1 ? null : version - 1,
    createdAt: at,
    content: {
      definitionVersion: 'checkin-v1',
      source: 'user',
      method: 'self_report',
      title: '직접 기록 질문',
      instructions: null,
      fields: ['note', 'fatigue'],
    },
  });
  return {
    template_id: body.templateId,
    version_id: body.versionId,
    version,
    previous_version_id: body.previousVersionId,
    previous_version: body.previousVersion,
    created_at: at,
    record_json: body,
  };
}
function approvedTraining() {
  const value = empty(),
    reference = {
      schemaVersion: 1 as const,
      candidateId: id(20),
      applicationDigest: 'a'.repeat(64),
      chain: {
        evidenceId: id(21),
        decisionId: id(22),
        proposalId: id(23),
        readonlyCandidateDigest: 'b'.repeat(64),
      },
      createdAt: at,
    };
  const result = raceManualApprovalResultSchema.parse({
    schemaVersion: 1,
    status: 'committed',
    candidateId: id(20),
    approvalId: id(24),
    proposalId: id(23),
    approvedAt: at,
    race: { eventId: id(25), revision: 2 },
    versions: [{ domain: 'training', aggregateId: id(26), versionId: id(27), version: 2 }],
    occurrenceIds: [],
    notices: [],
  });
  if (result.status !== 'committed') throw Error('Committed fixture required');
  const draft = planDraftSchema.parse({
    title: 'Retained training',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, ids) => ({
      id: level,
      parentId: index ? ids[index - 1] : null,
      level,
      title: level,
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [],
  });
  value.data.trainingPlanAggregates.push({ version_id: id(27), aggregate_id: id(26) });
  value.data.planSnapshots.push({
    id: id(27),
    version: 2,
    created_at: at,
    draft: z.json().parse(draft),
  });
  value.data.planHistory.push({ version_id: id(27), action: 'candidate_approved' });
  value.data.manualRaceReviews.push({
    reference,
    createdAt: at,
    bodyState: 'purged',
    preview: null,
  });
  value.data.manualRaceCommandResults.push(
    {
      operation: 'review',
      candidateId: id(20),
      result: { status: 'reviewed', reference, bodyState: 'present' },
    },
    { operation: 'approve', candidateId: id(20), result },
  );
  value.data.manualRaceApprovalHistory.push({
    candidateId: id(20),
    approvalId: id(24),
    domain: 'training',
    aggregateId: id(26),
    versionId: id(27),
    approvedAt: at,
  });
  return value;
}
function approvedGeneric(domain: 'recovery' | 'routine_schedule') {
  const value = approvedTraining(),
    command = value.data.manualRaceCommandResults.find((row) => row.operation === 'approve');
  if (!command || command.operation !== 'approve' || command.result.status !== 'committed')
    throw Error('Fixture');
  command.result.versions =
    domain === 'recovery'
      ? [{ domain, aggregateId: id(30), versionId: id(31), version: 1 }]
      : [{ domain, aggregateId: id(30), versionId: id(31) }];
  value.data.manualRaceApprovalHistory = [
    {
      candidateId: id(20),
      approvalId: id(24),
      domain,
      aggregateId: id(30),
      versionId: id(31),
      approvedAt: at,
    },
  ];
  if (domain === 'recovery') {
    const body = {
      schemaVersion: 1,
      strategyId: id(30),
      versionId: id(31),
      version: 1,
      previousVersionId: null,
      status: 'user_confirmed',
      selectedOptionId: id(32),
      createdAt: at,
      draft: {
        title: 'Recovery',
        goal: '',
        startDate: '2026-10-07',
        endDateExclusive: '2026-10-08',
        timezone: 'UTC',
        knownFacts: [],
        missingInformation: [],
        priority: 'normal',
        observations: [],
        planRefs: [],
        options: [
          { id: id(32), title: 'Rest', kind: 'full_rest', methodVersionId: null, explanation: '' },
        ],
        reassessment: [
          {
            id: id(35),
            trigger: 'plan_changed',
            plannedAt: null,
            description: 'Review',
            policyVersion: null,
          },
        ],
      },
    };
    value.data.recoveryStrategyVersions =
      accountExportV35Schema.shape.data.shape.recoveryStrategyVersions.parse([
        {
          strategy_id: id(30),
          version_id: id(31),
          version: 1,
          previous_version_id: null,
          previous_version: null,
          record_json: body,
        },
      ]);
    value.data.recoveryStrategyHeads = [{ strategy_id: id(30), version_id: id(31), version: 1 }];
    value.data.recoveryStrategyHistory = [
      { version_id: id(31), approval_id: id(24), action: 'candidate_approved' },
    ];
  } else {
    const blueprint = {
      schemaVersion: 4,
      routineId: id(33),
      versionId: id(34),
      title: 'Routine',
      intent: '',
      status: 'draft',
      tags: [],
      steps: [
        {
          id: 'check',
          title: 'Check',
          content: { kind: 'checklist', prompt: 'Ready?' },
          timing: { kind: 'ordered', afterStepId: null },
          required: true,
          choiceGroupId: null,
        },
      ],
      choiceGroups: [],
      estimatedDurationSeconds: null,
      createdAt: at,
    };
    value.data.genericRoutineBlueprintVersions =
      accountExportV35Schema.shape.data.shape.genericRoutineBlueprintVersions.parse([
        {
          routine_id: id(33),
          version_id: id(34),
          version: 1,
          previous_version_id: null,
          record_json: blueprint,
          created_at: at,
        },
      ]);
    value.data.genericRoutineBlueprintHeads = [
      { routine_id: id(33), version_id: id(34), version: 1, favorite: false, visibility: 'active' },
    ];
    const body = {
      schemaVersion: 4,
      id: id(30),
      versionId: id(31),
      blueprint: { id: id(33), versionId: id(34) },
      window: {
        startDate: '2026-10-07',
        endDateExclusive: '2026-10-08',
        timezone: 'UTC',
        maxOccurrences: 1,
      },
      rule: { kind: 'dates', dates: ['2026-10-07'], localTime: '00:00' },
      state: 'active',
    };
    value.data.genericRoutineScheduleVersions =
      accountExportV35Schema.shape.data.shape.genericRoutineScheduleVersions.parse([
        {
          schedule_id: id(30),
          version_id: id(31),
          prior_version_id: null,
          blueprint_routine_id: id(33),
          blueprint_version_id: id(34),
          source_plan_version_id: null,
          record_json: body,
          created_at: at,
        },
      ]);
    value.data.genericRoutineScheduleHeads = [
      { schedule_id: id(30), version_id: id(31), notification_muted: false },
    ];
    value.data.genericRoutineScheduleHistory = [
      { version_id: id(31), approval_id: id(24), action: 'candidate_approved' },
    ];
  }
  return value;
}

function retained(value = approvedTraining(), publicOverlap = false) {
  const review = first(value.data.manualRaceReviews);
  const result = value.data.manualRaceCommandResults.find((v) => v.operation === 'approve');
  if (!result || result.operation !== 'approve' || result.result.status !== 'committed')
    throw Error('fixture');
  const source = {
    ...value,
    schemaVersion: 37,
    data: {
      ...value.data,
      sourceProvenanceCoverage: 'not_exported_policy_unresolved',
      manualInternalChains: [
        {
          evidenceId: review.reference.chain.evidenceId,
          decisionId: review.reference.chain.decisionId,
          proposalId: review.reference.chain.proposalId,
          createdAt: at,
          proposalApplied: false,
          body: { state: 'purged', purgedAt: at, purgeEventId: id(88) },
        },
      ],
      manualInternalCandidates: [
        {
          candidateId: review.reference.candidateId,
          chain: {
            evidenceId: review.reference.chain.evidenceId,
            decisionId: review.reference.chain.decisionId,
            proposalId: review.reference.chain.proposalId,
          },
          createdAt: at,
          body: { state: 'purged', purgedAt: at, purgeEventId: id(88) },
        },
      ],
      manualInternalApprovalResults: [result.result],
      manualInternalApprovalHistory: value.data.manualRaceApprovalHistory,
    },
  };
  if (!publicOverlap) {
    source.data.manualRaceReviews = [];
    source.data.manualRaceCommandResults = [];
    source.data.manualRaceApprovalHistory = [];
  }
  return accountExportV37Schema.parse(source);
}
it('requires every internal collection and unresolved provenance marker with no defaults', () => {
  const value = retained();
  for (const key of [
    'manualInternalChains',
    'manualInternalCandidates',
    'manualInternalApprovalResults',
    'manualInternalApprovalHistory',
    'sourceProvenanceCoverage',
  ])
    expect(
      accountExportV37Schema.safeParse({ ...value, data: { ...value.data, [key]: undefined } })
        .success,
    ).toBe(false);
  expect(accountExportSchema.parse(value)).toEqual(value);
  expect(
    accountExportV37Schema.safeParse({
      ...value,
      data: { ...value.data, sourceProvenanceCoverage: 'complete' },
    }).success,
  ).toBe(false);
});
it('keeps historical V36 and default family semantics unchanged', () => {
  const old = approvedTraining();
  expect(accountExportV36Schema.parse(old)).toEqual(old);
  expect(accountExportV36Schema.safeParse(retained()).success).toBe(false);
  expect(accountExportV37Schema.safeParse({ ...old, schemaVersion: 37 }).success).toBe(false);
});
it('accepts internal-only original training and requires immutable body/history/association', () => {
  const value = retained();
  expect(value.data.manualRaceCommandResults).toEqual([]);
  for (const key of ['planSnapshots', 'planHistory', 'trainingPlanAggregates'])
    expect(
      accountExportV37Schema.safeParse({ ...value, data: { ...value.data, [key]: [] } }).success,
    ).toBe(false);
  const wrong = structuredClone(value);
  first(wrong.data.planSnapshots)['draft'] = {};
  expect(accountExportV37Schema.safeParse(wrong).success).toBe(false);
});
it.each(['recovery', 'routine_schedule'] as const)(
  'accepts genuine internal-only %s via shared verifier without integrated facts',
  (domain) => {
    const value = retained(approvedGeneric(domain));
    expect(value.data.referencedIntegratedApprovalFacts).toEqual([]);
    const bad = structuredClone(value);
    first(bad.data.manualInternalApprovalHistory).aggregateId = id(99);
    expect(accountExportV37Schema.safeParse(bad).success).toBe(false);
  },
);
it('validates identical public subset once, without double counting an approval', () => {
  const value = retained(approvedTraining(), true);
  expect(accountExportV37Schema.parse(value)).toEqual(value);
  expect(value.data.manualInternalApprovalResults).toHaveLength(1);
  const wrong = structuredClone(value);
  first(wrong.data.manualInternalApprovalResults).occurrenceIds = [id(89)];
  expect(accountExportV37Schema.safeParse(wrong).success).toBe(false);
  const missing = structuredClone(value);
  missing.data.manualInternalCandidates = [];
  expect(accountExportV37Schema.safeParse(missing).success).toBe(false);
});
it('rejects mismatched public current purge state while preserving original successful receipt state', () => {
  const value = retained(approvedTraining(), true);
  const command = value.data.manualRaceCommandResults.find((v) => v.operation === 'review');
  expect(command?.result.status).toBe('reviewed');
  const wrong = structuredClone(value);
  first(wrong.data.manualRaceReviews).bodyState = 'present';
  expect(accountExportV37Schema.safeParse(wrong).success).toBe(false);
});
it('rejects internal role/approval/history forgeries and duplicate originals', () => {
  const value = retained();
  const identity = structuredClone(value);
  first(identity.data.manualInternalCandidates).chain.proposalId = id(89);
  expect(accountExportV37Schema.safeParse(identity).success).toBe(false);
  const duplicate = structuredClone(value);
  duplicate.data.manualInternalApprovalResults.push(
    first(duplicate.data.manualInternalApprovalResults),
  );
  expect(accountExportV37Schema.safeParse(duplicate).success).toBe(false);
  const missing = structuredClone(value);
  missing.data.manualInternalApprovalHistory = [];
  expect(accountExportV37Schema.safeParse(missing).success).toBe(false);
});
it('preserves existing race35/template/generic guards in V37', () => {
  const value = retained();
  const nutrition = structuredClone(value);
  nutrition.data.nutritionPlanHeads.push({ plan_id: id(94), version_id: id(95), version: 1 });
  expect(accountExportV37Schema.safeParse(nutrition).success).toBe(false);
  const templates = structuredClone(value);
  templates.data.checkInTemplateVersions.push(template(2));
  expect(accountExportV37Schema.safeParse(templates).success).toBe(false);
  expect(accountExportV37Schema.safeParse({ ...value, private_context: {} }).success).toBe(false);
});
it('applies 8MiB to the entire artifact, including metadata and escaped opaque strings', () => {
  const value = retained();
  value.data.planHistory.push({ label: 'x'.repeat(8 * 1024 * 1024) });
  expect(accountExportV37Schema.safeParse(value).success).toBe(false);
  const escaped = retained();
  escaped.data.planHistory.push({ label: '\\'.repeat(4 * 1024 * 1024) });
  expect(accountExportV37Schema.safeParse(escaped).success).toBe(false);
});
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

function presentOverlap() {
  const base = empty(),
    body = planned();
  const ids = { evidenceId: id(21), decisionId: id(22), proposalId: id(23) };
  const reference = {
    schemaVersion: 1,
    candidateId: id(20),
    applicationDigest: 'a'.repeat(64),
    chain: { ...ids, readonlyCandidateDigest: 'b'.repeat(64) },
    createdAt: at,
  };
  return accountExportV37Schema.parse({
    ...base,
    schemaVersion: 37,
    data: {
      ...base.data,
      sourceProvenanceCoverage: 'not_exported_policy_unresolved',
      manualInternalChains: [
        {
          ...ids,
          createdAt: at,
          proposalApplied: false,
          body: { state: 'present', planned: body },
        },
      ],
      manualInternalCandidates: [
        {
          candidateId: id(20),
          chain: ids,
          createdAt: at,
          body: {
            state: 'present',
            storedApplicationState: 'ready_for_explicit_approval',
            planned: body,
          },
        },
      ],
      manualInternalApprovalResults: [],
      manualInternalApprovalHistory: [],
      manualRaceReviews: [
        {
          reference,
          createdAt: at,
          bodyState: 'present',
          preview: {
            schemaVersion: 1,
            status: 'present',
            reference,
            storedCandidateState: 'ready_for_explicit_approval',
            beforeBasis: 'frozen_review',
            afterBasis: 'hypothetical_on_approval',
            freshness: 'not_checked_on_read',
            scope: 'whole_affected',
            race: body.race,
            training: body.training,
            recovery: body.recovery,
            routines: body.routines,
            retainedUnplanned: body.retainedUnplanned,
            affected: body.affected,
            notices: body.notices,
            nutrition: {
              state: 'present',
              members: body.nutrition.members.map((m) => ({
                ...m,
                after: { ...m.after, kind: 'retained' },
                timings: m.timings.map(({ itemId, state, before, after }) => ({
                  itemId,
                  state,
                  before,
                  after,
                })),
              })),
            },
          },
        },
      ],
      manualRaceCommandResults: [
        {
          operation: 'review',
          candidateId: id(20),
          result: { status: 'reviewed', reference, bodyState: 'present' },
        },
      ],
    },
  });
}
it('preserves unresolved chain-only planned content without creating an application candidate', () => {
  const v = presentOverlap();
  v.data.manualRaceReviews = [];
  v.data.manualRaceCommandResults = [];
  v.data.manualInternalCandidates = [];
  expect(accountExportV37Schema.parse(v)).toEqual(v);
});
it('compares exact overlapping planned foods, unknown/zero and timing without public metadata aliases', () => {
  const v = presentOverlap();
  expect(accountExportV37Schema.parse(v)).toEqual(v);
  const altered = structuredClone(v),
    candidate = first(altered.data.manualInternalCandidates);
  if (candidate.body.state !== 'present' || candidate.body.planned.nutrition.state !== 'present')
    throw Error('fixture');
  const m = first(candidate.body.planned.nutrition.members);
  first(m.before.plan.items).foods[0] = {
    foodVersionId: null,
    description: 'Zero',
    quantity: 1,
    unit: 'g',
    sourceBasis: 'manual_total',
  };
  first(m.after.plan.items).foods[0] = first(first(m.before.plan.items).foods);
  // Also update parent frozen body so the same-family codec remains valid.
  const chain = first(altered.data.manualInternalChains);
  if (chain.body.state !== 'present') throw Error('fixture');
  chain.body.planned = candidate.body.planned;
  expect(accountExportV37Schema.safeParse(altered).success).toBe(false);
});

function approvedNutrition() {
  const value = approvedTraining(),
    command = value.data.manualRaceCommandResults.find((row) => row.operation === 'approve');
  if (!command || command.operation !== 'approve' || command.result.status !== 'committed')
    throw Error('Fixture');
  command.result.versions = [
    { domain: 'nutrition', aggregateId: id(30), versionId: id(31), version: 1 },
  ];
  value.data.manualRaceApprovalHistory = [
    {
      candidateId: id(20),
      approvalId: id(24),
      domain: 'nutrition',
      aggregateId: id(30),
      versionId: id(31),
      approvedAt: at,
    },
  ];
  const body = {
    planId: id(30),
    versionId: id(31),
    version: 1,
    previousVersionId: null,
    approvalId: id(42),
    approvedAt: at,
    period: { from: '2026-10-08', toInclusive: '2026-10-08' },
    timezone: 'UTC',
    purpose: 'Retained foods',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: '식-' + '가'.repeat(1001),
        planVersionId: id(31),
        category: 'before',
        title: 'Food',
        anchor: { kind: 'absolute', date: '2026-10-08', localTime: null, timezone: 'UTC' },
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
  };
  value.data.nutritionPlanVersions =
    accountExportV35Schema.shape.data.shape.nutritionPlanVersions.parse([
      {
        plan_id: id(30),
        version_id: id(31),
        version: 1,
        previous_version_id: null,
        period_from: '2026-10-08',
        period_to: '2026-10-08',
        linked_training_plan_version_id: null,
        approval_id: id(42),
        approved_at: at,
        record_json: body,
      },
    ]);
  value.data.nutritionPlanHeads = [{ plan_id: id(30), version_id: id(31), version: 1 }];
  value.data.nutritionPlanHistory = [
    {
      plan_id: id(30),
      version_id: id(31),
      approval_id: id(42),
      action: 'user_approved',
      created_at: at,
    },
  ];
  return value;
}

it('retains internal nutrition own approval history distinct from common approval plus zero/null and microseconds', () => {
  const v = retained(approvedNutrition());
  expect(accountExportV37Schema.parse(v)).toEqual(v);
  const wrong = structuredClone(v);
  first(wrong.data.nutritionPlanHistory).approval_id = first(
    wrong.data.manualInternalApprovalResults,
  ).approvalId;
  expect(accountExportV37Schema.safeParse(wrong).success).toBe(false);
  const atWrong = structuredClone(v);
  first(atWrong.data.manualInternalApprovalHistory).approvedAt = '2026-10-08T00:00:00.123457Z';
  expect(accountExportV37Schema.safeParse(atWrong).success).toBe(false);
});
it.each(['recovery', 'routine_schedule'] as const)(
  'accepts internal original %s with full central history and empty integrated domain history',
  (domain) => {
    const base = approvedGeneric(domain);
    base.data.recoveryStrategyHistory = [];
    base.data.genericRoutineScheduleHistory = [];
    const v = retained(base);
    expect(accountExportV37Schema.parse(v)).toEqual(v);
    const missing = structuredClone(v);
    missing.data.manualInternalApprovalHistory = [];
    expect(accountExportV37Schema.safeParse(missing).success).toBe(false);
  },
);
it('prebounds unknown V37 transport before nested parsing; the historical union only postbounds decoded37', () => {
  const v = retained();
  let calls = 0;
  Object.defineProperty(v, 'data', {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  expect(() => parseAccountExportV37(v)).toThrow();
  expect(calls).toBe(0);
  const symbol = retained();
  Object.defineProperty(symbol, Symbol('secret'), { value: true });
  expect(() => parseAccountExportV37(symbol)).toThrow();
  expect(parseAccountExportV37(retained())).toEqual(retained());
});
it('retains blocked internal candidate without success, rejects its public ready alias', () => {
  const v = presentOverlap();
  const c = first(v.data.manualInternalCandidates);
  if (c.body.state !== 'present') throw Error('fixture');
  c.body = {
    state: 'present',
    storedApplicationState: 'blocked',
    planned: c.body.planned,
    blockers: [{ reason: 'source_unavailable', target: null }],
  };
  expect(accountExportV37Schema.safeParse(v).success).toBe(false);
  v.data.manualRaceReviews = [];
  v.data.manualRaceCommandResults = [];
  expect(accountExportV37Schema.parse(v)).toEqual(v);
});
