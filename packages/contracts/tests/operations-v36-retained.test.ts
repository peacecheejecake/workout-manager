import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  accountExportSchema,
  accountExportV35Schema,
  accountExportV36Schema,
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
it('recognizes explicit V36 and leaves V35 unchanged without manufacturing new collections', () => {
  expect(accountExportSchema.parse(empty())).toEqual(empty());
  const previous = legacy();
  expect(accountExportSchema.parse(previous)).toEqual(previous);
  expect(previous.data).not.toHaveProperty('manualRaceReviews');
  expect(accountExportSchema.safeParse({ ...previous, schemaVersion: 36 }).success).toBe(false);
  expect(accountExportSchema.safeParse({ ...empty(), schemaVersion: 35 }).success).toBe(false);
});
it.each([
  'checkInTemplateVersions',
  'checkInTemplateHeads',
  'manualRaceReviews',
  'manualRaceApprovalHistory',
  'manualRaceCommandResults',
  'trainingPlanAggregates',
])('requires %s with no undefined/default shortcut', (key) => {
  const value = empty();
  expect(
    accountExportV36Schema.safeParse({ ...value, data: { ...value.data, [key]: undefined } })
      .success,
  ).toBe(false);
});
it('retains template history, semantic field order and exact microseconds', () => {
  const value = empty();
  value.data.checkInTemplateVersions.push(template(1), template(2));
  value.data.checkInTemplateHeads.push({ template_id: id(1), version_id: id(12), version: 2 });
  expect(accountExportSchema.parse(value)).toEqual(value);
  first(value.data.checkInTemplateVersions).created_at = '2026-10-08T00:00:00.123Z';
  expect(accountExportV36Schema.safeParse(value).success).toBe(false);
});
it('preserves mandatory template chain/head and manual tuple validators', () => {
  const value = empty();
  value.data.checkInTemplateVersions.push(template(2));
  value.data.checkInTemplateHeads.push({ template_id: id(1), version_id: id(12), version: 2 });
  expect(accountExportV36Schema.safeParse(value).success).toBe(false);
  const manual = approvedTraining();
  manual.data.manualRaceCommandResults.pop();
  expect(accountExportV36Schema.safeParse(manual).success).toBe(false);
});
it('requires exact retained training snapshot/body/history for original successful approvals after purge', () => {
  const value = approvedTraining();
  expect(accountExportV36Schema.parse(value)).toEqual(value);
  const missing = structuredClone(value);
  missing.data.planSnapshots = [];
  expect(accountExportV36Schema.safeParse(missing).success).toBe(false);
  const revision = structuredClone(value);
  first(revision.data.planSnapshots)['version'] = 3;
  expect(accountExportV36Schema.safeParse(revision).success).toBe(false);
  const body = structuredClone(value);
  first(body.data.planSnapshots)['draft'] = {};
  expect(accountExportV36Schema.safeParse(body).success).toBe(false);
  const history = structuredClone(value);
  history.data.planHistory = [];
  expect(accountExportV36Schema.safeParse(history).success).toBe(false);
});
it('rejects duplicate command aliases, extra secrets and mismatched approval tuple', () => {
  const value = approvedTraining();
  value.data.manualRaceCommandResults.push(first(value.data.manualRaceCommandResults));
  expect(accountExportV36Schema.safeParse(value).success).toBe(false);
  const tuple = approvedTraining();
  first(tuple.data.manualRaceApprovalHistory).versionId = id(99);
  expect(accountExportV36Schema.safeParse(tuple).success).toBe(false);
  expect(accountExportV36Schema.safeParse({ ...empty(), private_context: {} }).success).toBe(false);
});
it('preserves V35 strict nutrition and generic recovery refinements inside the versioned V36 checks', () => {
  const value = empty();
  value.data.nutritionPlanHeads.push({ plan_id: id(60), version_id: id(61), version: 1 });
  expect(accountExportV36Schema.safeParse(value).success).toBe(false);
  const recovery = empty();
  recovery.data.recoveryStrategyHeads.push({ strategy_id: id(62), version_id: id(63), version: 1 });
  expect(accountExportV36Schema.safeParse(recovery).success).toBe(false);
});
it('fails closed when a manual approval has no exact nutrition/recovery/routine stored version', () => {
  for (const domain of ['nutrition', 'recovery', 'routine_schedule'] as const) {
    const value = approvedTraining();
    const command = value.data.manualRaceCommandResults.find((row) => row.operation === 'approve');
    if (!command || command.operation !== 'approve' || command.result.status !== 'committed')
      throw Error('Fixture');
    command.result.versions =
      domain === 'routine_schedule'
        ? [{ domain, aggregateId: id(26), versionId: id(27) }]
        : [{ domain, aggregateId: id(26), versionId: id(27), version: 2 }];
    value.data.manualRaceApprovalHistory = [
      {
        candidateId: id(20),
        approvalId: id(24),
        domain,
        aggregateId: id(26),
        versionId: id(27),
        approvedAt: at,
      },
    ];
    expect(accountExportV36Schema.safeParse(value).success).toBe(false);
  }
});
it('requires every provided training aggregate association but never invents pre112 history', () => {
  const value = approvedTraining();
  const missing = structuredClone(value);
  missing.data.trainingPlanAggregates = [];
  expect(accountExportV36Schema.safeParse(missing).success).toBe(false);
  const wrong = structuredClone(value);
  first(wrong.data.trainingPlanAggregates).aggregate_id = id(98);
  expect(accountExportV36Schema.safeParse(wrong).success).toBe(false);
  const duplicated = structuredClone(value);
  duplicated.data.trainingPlanAggregates.push({
    ...first(duplicated.data.trainingPlanAggregates),
    version_id: id(27).toUpperCase(),
  });
  expect(accountExportV36Schema.safeParse(duplicated).success).toBe(false);
  const orphan = empty();
  orphan.data.trainingPlanAggregates.push({ version_id: id(90), aggregate_id: id(91) });
  expect(accountExportV36Schema.safeParse(orphan).success).toBe(false);
  const old = empty();
  old.data.planSnapshots.push(first(value.data.planSnapshots));
  expect(accountExportV36Schema.safeParse(old).success).toBe(true);
});
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
it.each(['recovery', 'routine_schedule'] as const)(
  'accepts genuine manual %s facts only through V36 without fictional integrated facts',
  (domain) => {
    const value = approvedGeneric(domain);
    expect(value.data.referencedIntegratedApprovalFacts).toEqual([]);
    expect(accountExportV36Schema.parse(value)).toEqual(value);
    const previous = {
      ...value,
      schemaVersion: 35,
      data: Object.fromEntries(
        Object.keys(legacy().data).map((key) => [key, Reflect.get(value.data, key)]),
      ),
    };
    expect(accountExportV35Schema.safeParse(previous).success).toBe(false);
    const wrong = structuredClone(value);
    first(wrong.data.manualRaceApprovalHistory).aggregateId = id(99);
    expect(accountExportV36Schema.safeParse(wrong).success).toBe(false);
    const body = structuredClone(value);
    if (domain === 'recovery')
      first(body.data.recoveryStrategyVersions).record_json.strategyId = id(99);
    else first(body.data.genericRoutineScheduleVersions).record_json.id = id(99);
    expect(accountExportV36Schema.safeParse(body).success).toBe(false);
    if (domain === 'recovery') {
      const unconfirmed = structuredClone(value);
      first(unconfirmed.data.recoveryStrategyVersions).record_json.status = 'draft';
      first(unconfirmed.data.recoveryStrategyVersions).record_json.selectedOptionId = null;
      expect(accountExportV36Schema.safeParse(unconfirmed).success).toBe(false);
    }
  },
);
it('retains canonical long nutrition IDs/zero/null and exact manual nutrition approval timestamps', () => {
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
  expect(accountExportV36Schema.parse(value)).toEqual(value);
  const wrongApproval = structuredClone(value);
  first(wrongApproval.data.nutritionPlanHistory).approval_id = id(24);
  expect(accountExportV36Schema.safeParse(wrongApproval).success).toBe(false);
  const wrong = structuredClone(value);
  first(wrong.data.nutritionPlanVersions).approved_at = '2026-10-08T00:00:00.123457Z';
  first(wrong.data.nutritionPlanVersions).record_json.approvedAt = '2026-10-08T00:00:00.123457Z';
  expect(accountExportV36Schema.safeParse(wrong).success).toBe(false);
});

it.each(['recovery', 'routine_schedule'] as const)(
  'accepts actual manual %s with central history and no integrated domain history',
  (domain) => {
    const value = approvedGeneric(domain);
    value.data.recoveryStrategyHistory = [];
    value.data.genericRoutineScheduleHistory = [];
    expect(accountExportV36Schema.safeParse(value).success).toBe(true);
    const missing = structuredClone(value);
    missing.data.manualRaceApprovalHistory = [];
    expect(accountExportV36Schema.safeParse(missing).success).toBe(false);
    const forged = structuredClone(value);
    first(forged.data.manualRaceApprovalHistory).versionId = id(99);
    expect(accountExportV36Schema.safeParse(forged).success).toBe(false);
  },
);
it('V36 preserves same schedule anchor across versions, rejects collisions within one version, and keeps V35 semantics', () => {
  const value = approvedGeneric('routine_schedule');
  value.data.genericRoutineScheduleHistory = [];
  const old = first(value.data.genericRoutineScheduleVersions),
    next = structuredClone(old);
  next.version_id = id(40);
  next.prior_version_id = old.version_id;
  next.record_json.versionId = id(40);
  value.data.genericRoutineScheduleVersions.push(next);
  value.data.genericRoutineScheduleHeads = [
    { schedule_id: old.schedule_id, version_id: next.version_id, notification_muted: false },
  ];
  value.data.genericRoutineOccurrences =
    accountExportV35Schema.shape.data.shape.genericRoutineOccurrences.parse(
      [old, next].map((row, index) => ({
        id: id(50 + index),
        schedule_id: row.schedule_id,
        schedule_version_id: row.version_id,
        blueprint_routine_id: row.blueprint_routine_id,
        blueprint_version_id: row.blueprint_version_id,
        anchor_key: 'date:2026-10-07',
        scheduled_at: at,
        record_json: {
          id: id(50 + index),
          schedule: { id: row.schedule_id, versionId: row.version_id },
          blueprint: { id: row.blueprint_routine_id, versionId: row.blueprint_version_id },
          anchorKey: 'date:2026-10-07',
          scheduledAt: at,
          timingStatus: 'resolved',
          stepBindings: [],
          selectedChoices: {},
        },
      })),
    );
  expect(accountExportV36Schema.safeParse(value).success).toBe(true);
  const historical = {
    ...value,
    schemaVersion: 35,
    data: Object.fromEntries(
      Object.keys(legacy().data).map((key) => [key, Reflect.get(value.data, key)]),
    ),
  };
  expect(accountExportV35Schema.safeParse(historical).success).toBe(false);
  const duplicate = structuredClone(value),
    row = first(duplicate.data.genericRoutineOccurrences);
  duplicate.data.genericRoutineOccurrences.push({
    ...row,
    id: id(52),
    record_json: { ...row.record_json, id: id(52) },
  });
  expect(accountExportV36Schema.safeParse(duplicate).success).toBe(false);
  const dirty = structuredClone(value);
  first(dirty.data.genericRoutineOccurrences).schedule_version_id = id(99);
  expect(accountExportV36Schema.safeParse(dirty).success).toBe(false);
});
