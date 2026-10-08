import { normalizeRaceManualImpactProjectionCapture } from '../src/race-manual-public-impact.js';
import { describe, expect, it } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
} from '@workout/contracts/routines';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { raceImpactConsumedCaptureSchema } from '../src/race-plan-impact-complete-manifest.js';
import {
  integratedDependencyKinds,
  impactDependencyDigest,
} from '../src/race-plan-impact-dependencies.js';
import {
  buildRacePlanImpactProjectionInput,
  createRacePlanImpactCapturedCalculationPorts,
} from '../src/race-plan-impact-projection-input.js';
import { assembleRaceManualReviewCandidateCompatibleV4 } from '@workout/server-coaching/race-manual-review-candidate-v2';
import { raceManualApprovalCandidateSchema } from '@workout/contracts/race-manual-approval';
import {
  renderRaceManualInternalPersonalExport,
  raceManualInternalPersonalExportSourceSchema,
} from '../src/race-manual-internal-personal-export-renderer.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64),
  athlete = 'synthetic-impact',
  now = '2026-10-08T00:00:00.123456Z';
function fixture() {
  const absent = { state: 'absent' };
  const c = raceImpactConsumedCaptureSchema.parse({
    status: 'blocked',
    coverage: {
      complete: false,
      missing: [
        'complete_catalog_and_actual_manifest',
        'supplementary_reference_manifest',
        'routine_occurrences_and_started_runs',
        'complete_source_permission_manifest',
        'manual_purpose_app_and_policy_binding',
      ],
      captured: [
        'integrated_dependency_inventory',
        'immutable_supplementary_copy_references',
        'routine_occurrence_run_and_actual_reference_facts',
        'partial_owned_planned_reference_and_resource_permission_facts',
        'nested_nutrition_plan_food_anchor_and_activity_media_provider_facts',
        'manual_purpose_app_and_policy_facts',
      ],
    },
    athleteId: athlete,
    restoreGeneration: id(1),
    manualBasis: {
      purpose: 'manual_race_date_change',
      policy: { id: 'manual-race-date-impact', version: 1, digest: hash },
      app: { state: 'present', granted: true, revision: 1 },
    },
    event: {
      id: id(2),
      revision: 1,
      title: 'Race',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'UTC',
      locationName: 'Private location',
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
    collections: [
      { kind: 'race-event', revision: 1, privacy_generation: '0' },
      { kind: 'race-result', revision: 1, privacy_generation: '0' },
      { kind: 'training-best', revision: 1, privacy_generation: '0' },
    ],
    linkedPlan: null,
    currentTraining: null,
    completions: [],
    course: null,
    rosters: { nutrition: [], recovery: [], routine: [] },
    nutrition: [],
    recovery: [],
    routines: [],
    coreDependencies: {
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      athleteId: athlete,
      capturedAt: now,
      trainingPlan: { kind: 'absent' },
      activities: { count: '0', revisionSum: '0' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      aiConsent: { kind: 'absent' },
      userConstraints: { kind: 'absent' },
    },
    dependencyInventory: integratedDependencyKinds.map((kind) => ({ kind, state: 'absent' })),
    supplementaryManifest: { sessions: [], copies: [], routines: [], exercises: [] },
    routineActualManifest: {
      uniqueSourceCount: 0,
      occurrences: [],
      runs: [],
      blueprints: [],
      schedules: [],
      actualRosters: { activities: [], intake: [], recovery: [] },
    },
    sourcePermissionManifest: {
      complete: false,
      planned: [],
      resources: [],
      catalog: [],
      nestedNutritionSources: [],
      activityMediaPermissions: {
        activities: [],
        garminLineage: [],
        healthkit: [],
        media: [],
        healthkitRegistry: absent,
        garmin: absent,
        garminUnofficial: absent,
        consents: ['provider', 'healthkit', 'media'].map((kind) => ({ kind, ...absent })),
      },
      aiConsent: absent,
      missing: [
        'unsupported_domain_item_membership',
        'immutable_training_aggregate_history',
        'media_cleanup_status_port',
        'media_and_provider_source_permissions',
        'manual_purpose_app_and_policy_binding',
      ],
    },
    consumedSources: { plans: [], races: [] },
    readSetDigest: hash,
    affected: { nutrition: [], routine: [] },
  });
  c.consumedSources.races = [structuredClone(c.event)];
  c.calendarIntent = {
    expectedEvent: { id: c.event.id, revision: c.event.revision },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' },
    resolutions: { nutrition: [], routines: [] },
  };
  return pin(c);
}
function pin(c: ReturnType<typeof raceImpactConsumedCaptureSchema.parse>) {
  const { status, coverage, readSetDigest, affected, ...set } = c;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  c.readSetDigest = impactDependencyDigest({
    ...set,
    coreDependencies: { ...c.coreDependencies, capturedAt: null },
  });
  return { context: c, intent: c.calendarIntent };
}
function withNutrition(relative = true, disconnected = false) {
  const f = fixture();
  const c = f.context;
  const record = nutritionPlanVersionCompatibleV4Schema.parse({
    ...(disconnected ? { schemaVersion: 3, raceTimingPins: [], itemRaceTimingBindings: [] } : {}),
    planId: id(3),
    versionId: id(4),
    version: 1,
    previousVersionId: null,
    approvedAt: now,
    approvalId: id(5),
    period: { from: '2026-10-07', toInclusive: '2026-10-10' },
    purpose: 'Fuel',
    timezone: 'UTC',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: '식사-' + 'a'.repeat(201),
        planVersionId: id(4),
        category: 'before',
        title: 'Meal',
        anchor: disconnected
          ? { kind: 'disconnected', entity: 'race' }
          : relative
            ? {
                kind: 'relative',
                entity: 'race',
                entityId: c.event.id,
                point: 'start',
                offsetMinutes: -30,
              }
            : { kind: 'absolute', date: '2026-10-08', localTime: null, timezone: 'UTC' },
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
        targets: [
          {
            metric: 'energy',
            amount: {
              min: 0,
              max: 100,
              unit: 'kcal',
              basis: 'user_confirmed',
              evidenceIds: ['PRIVATE_EVIDENCE_SENTINEL'],
            },
          },
        ],
        instructions: 'Fuel',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  });
  c.nutrition = [
    {
      aggregateId: record.planId,
      versionId: record.versionId,
      record,
      sourceRelation: 'absent',
      relativeItems: [],
    },
  ];
  c.rosters.nutrition = [{ aggregateId: record.planId, versionId: record.versionId }];
  return pin(c);
}

function allDomains() {
  const f = withNutrition();
  const c = f.context;
  const snapshot = planSnapshotSchema.parse({
    id: id(10),
    version: 1,
    createdAt: now,
    draft: {
      title: 'Train',
      timezone: 'UTC',
      periods: [
        {
          id: 'season',
          parentId: null,
          level: 'season',
          title: 'Season',
          startDate: '2026-10-07',
          endDateExclusive: '2026-10-11',
          timezone: 'UTC',
          intent: 'Build',
          isPartial: false,
        },
      ],
      sessions: [],
    },
  });
  c.currentTraining = { aggregateId: id(11), snapshot };
  c.consumedSources.plans = [snapshot];
  if (!c.calendarIntent) throw Error('fixture');
  c.calendarIntent.selection = {
    kind: 'move_period',
    expectedCurrentPlanVersionId: snapshot.id,
    periodId: 'season',
    newStartDate: '2026-10-08',
    scope: 'period_only',
  };
  const strategy = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: id(12),
    versionId: id(13),
    version: 1,
    previousVersionId: null,
    status: 'draft',
    selectedOptionId: null,
    createdAt: now,
    draft: {
      title: 'Recover',
      goal: 'Rest',
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-11',
      timezone: 'UTC',
      priority: 'normal',
      knownFacts: ['PRIVATE_ACTUAL_REPORT'],
      missingInformation: [],
      observations: [],
      planRefs: [{ kind: 'training', aggregateId: id(11), headVersionId: snapshot.id }],
      options: [
        {
          id: id(14),
          title: 'Rest',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: 'Rest',
        },
      ],
      reassessment: [
        {
          id: id(15),
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Reassess',
          policyVersion: null,
        },
      ],
    },
  });
  c.recovery = [
    { aggregateId: strategy.strategyId, versionId: strategy.versionId, record: strategy },
  ];
  c.rosters.recovery = [{ aggregateId: strategy.strategyId, versionId: strategy.versionId }];
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: id(16),
    versionId: id(17),
    title: 'Checklist',
    intent: 'Review',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Ready',
        content: { kind: 'checklist', prompt: 'Ready?' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: 0,
    createdAt: now,
  });
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: id(18),
    versionId: id(19),
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-11',
      timezone: 'UTC',
      maxOccurrences: 10,
    },
    rule: { kind: 'period_days', periodId: 'season', offsetsDays: [0], localTime: null },
    state: 'active',
  });
  c.routines = [
    {
      aggregateId: schedule.id,
      versionId: schedule.versionId,
      record: schedule,
      sourceVersionId: snapshot.id,
      sourceRelation: 'current',
      affected: true,
    },
  ];
  c.rosters.routine = [{ aggregateId: schedule.id, versionId: schedule.versionId }];
  c.routineActualManifest.schedules = [
    {
      scheduleId: schedule.id,
      versionId: schedule.versionId,
      sourcePlanVersionId: snapshot.id,
      record: schedule,
      currentHead: { state: 'present', versionId: schedule.versionId, notificationMuted: false },
    },
  ];
  c.routineActualManifest.blueprints = [
    {
      record: blueprint,
      version: 1,
      currentHead: {
        state: 'present',
        versionId: blueprint.versionId,
        version: 1,
        visibility: 'active',
        favorite: false,
      },
      unsupportedContent: [],
    },
  ];
  return pin(c);
}
function source(nutrition = false) {
  return fromCapture(nutrition ? withNutrition() : fixture());
}
function fromCapture(f: ReturnType<typeof fixture>) {
  const c = f.context,
    capture = normalizeRaceManualImpactProjectionCapture(c),
    built = buildRacePlanImpactProjectionInput(capture, f.intent);
  if (built.status !== 'projected' || c.manualBasis.app.state !== 'present') throw Error('fixture');
  const sourceInput = {
    athleteId: c.athleteId,
    binding: {
      purpose: c.manualBasis.purpose,
      event: { id: c.event.id, revision: c.event.revision },
      appRevision: c.manualBasis.app.revision,
      policy: c.manualBasis.policy,
      restoreGeneration: c.restoreGeneration,
      readSetDigest: c.readSetDigest,
    },
    projectionInput: built.input,
    sourceFacts: built.sourceFacts,
  };
  const candidate = assembleRaceManualReviewCandidateCompatibleV4(
    sourceInput,
    createRacePlanImpactCapturedCalculationPorts(capture),
  );
  if (candidate.status !== 'assembled_readonly') throw Error('fixture assembled');
  const ids = { evidenceId: id(20), decisionId: id(21), proposalId: id(22) };
  return raceManualInternalPersonalExportSourceSchema.parse({
    schemaVersion: 1,
    chains: [
      {
        ...ids,
        createdAt: now,
        originalResult: {
          schemaVersion: 2,
          ...ids,
          candidateDigest: candidate.digest,
          createdAt: now,
          applicable: false,
          approvalAllowed: false,
        },
        bodyState: 'present',
        preparation: { context: c, sourceInput, candidate },
        purge: null,
      },
    ],
    candidates: [],
    approvalResults: [],
    approvalHistory: [],
  });
}
function first<T>(rows: readonly T[]): T {
  const x = rows[0];
  if (!x) throw Error('fixture');
  return x;
}
function withCandidate(blocked = false, s = source()) {
  const p = first(s.chains);
  if (p.bodyState !== 'present') throw Error('fixture');
  const app = {
    schemaVersion: 1,
    candidateId: id(23),
    chain: {
      evidenceId: p.evidenceId,
      decisionId: p.decisionId,
      proposalId: p.proposalId,
      readonlyCandidateDigest: p.originalResult.candidateDigest,
    },
    createdAt: now,
    raceChange: {
      eventId: p.preparation.context.event.id,
      expectedRevision: p.preparation.context.event.revision,
      newLocalDate: '2026-10-09',
    },
    expectation: {
      restoreGeneration: p.preparation.context.restoreGeneration,
      appRevision: 1,
      manualPolicy: p.preparation.context.manualBasis.policy,
      semanticDigest: hash,
      heads: {
        training: { state: 'absent' },
        nutrition: { state: 'absent' },
        recovery: { state: 'absent' },
        routine_schedule: { state: 'absent' },
      },
    },
    authority: 'server_revalidation_required',
    ...(blocked
      ? { applicationState: 'blocked', blockers: [{ reason: 'source_unavailable', target: null }] }
      : {
          applicationState: 'ready_for_explicit_approval',
          scope: 'whole_affected',
          affected: [],
          writes: [],
          notices: [],
        }),
  };
  const candidate = raceManualApprovalCandidateSchema.parse({
    ...app,
    applicationDigest: impactDependencyDigest(app),
  });
  s.candidates.push({
    candidateId: id(23),
    chain: { evidenceId: p.evidenceId, decisionId: p.decisionId, proposalId: p.proposalId },
    createdAt: now,
    bodyState: 'present',
    candidate,
    purge: null,
  });
  return s;
}
describe('pure internal personal export renderer', () => {
  it('renders chain-only using actual pure builder/assembler, no public reference', () => {
    const raw = source(),
      v = renderRaceManualInternalPersonalExport(raw);
    expect(v.manualInternalCandidates).toEqual([]);
    expect(v.sourceProvenanceCoverage).toBe('not_exported_policy_unresolved');
    const text = JSON.stringify(v);
    expect(text).not.toMatch(
      /candidateDigest|readSetDigest|sourceInput|sqlObservations|Private location|authority|applicationDigest|receipt_key/,
    );
    const b = first(v.manualInternalChains).body;
    if (b.state !== 'present') throw Error('fixture');
    expect(b.planned.race.before.targetSeconds).toBe(0);
    expect(b.planned.race.before.localStartTime).toBeNull();
    expect(b.planned.persistence).toBe('stored_history');
  });
  it('preserves all five domain planned content from a frozen chain-only capture, excluding reported actual', () => {
    const v = renderRaceManualInternalPersonalExport(fromCapture(allDomains())),
      b = first(v.manualInternalChains).body;
    if (b.state !== 'present') throw Error('fixture');
    expect([
      b.planned.training.state,
      b.planned.nutrition.state,
      b.planned.recovery.state,
      b.planned.routines.state,
    ]).toEqual(['present', 'present', 'present', 'present']);
    expect(b.planned.race.after.localDate).toBe('2026-10-09');
    expect(JSON.stringify(v)).not.toContain('PRIVATE_ACTUAL_REPORT');
    expect(b.planned.resolutionRequirements.length).toBeGreaterThan(0);
  });
  it('preserves unresolved planned meals, long IDs and numeric goals without evidence/private actual', () => {
    const v = renderRaceManualInternalPersonalExport(source(true)),
      b = first(v.manualInternalChains).body;
    if (b.state !== 'present' || b.planned.nutrition.state !== 'present') throw Error('fixture');
    const m = first(b.planned.nutrition.members),
      item = first(m.before.plan.items);
    expect(item.id.length).toBeGreaterThan(200);
    expect(item.foods.map((f) => f.quantity)).toEqual([0, null]);
    expect(item.targets[0]?.amount).toEqual({
      min: 0,
      max: 100,
      unit: 'kcal',
      basis: 'user_confirmed',
    });
    expect(JSON.stringify(v)).not.toContain('PRIVATE_EVIDENCE_SENTINEL');
    expect(m.timings[0]?.after.state).toBe('unresolved');
  });
  it.each([false, true])(
    'keeps stored candidate state ready=%s with no manufactured permission',
    (blocked) => {
      const v = renderRaceManualInternalPersonalExport(withCandidate(blocked)),
        b = first(v.manualInternalCandidates).body;
      if (b.state !== 'present') throw Error('fixture');
      expect(b.storedApplicationState).toBe(blocked ? 'blocked' : 'ready_for_explicit_approval');
      expect(b.planned.approvalAllowed).toBe(false);
    },
  );
  it('renders paired purged identities and original success, no before reconstruction', () => {
    const raw = withCandidate(),
      p = first(raw.chains),
      c = first(raw.candidates),
      purge = { purgedAt: '2026-10-09T00:00:00.123456Z', purgeEventId: id(30) };
    raw.chains = [{ ...p, bodyState: 'purged', preparation: null, purge }];
    raw.candidates = [{ ...c, bodyState: 'purged', candidate: null, purge }];
    raw.approvalResults = [
      {
        schemaVersion: 1,
        status: 'committed',
        candidateId: id(23),
        approvalId: id(31),
        proposalId: id(22),
        approvedAt: now,
        race: { eventId: id(2), revision: 2 },
        versions: [],
        occurrenceIds: [],
        notices: [],
      },
    ];
    const v = renderRaceManualInternalPersonalExport(raw);
    expect(v.manualInternalApprovalResults).toHaveLength(1);
    expect(JSON.stringify(v)).not.toContain('Race');
    expect(first(v.manualInternalChains).createdAt).toBe(now);
  });
  it('rejects missing original receipt, unknown fields and purported present missing preparation', () => {
    const raw = source(),
      p = first(raw.chains);
    expect(() =>
      renderRaceManualInternalPersonalExport({
        ...raw,
        chains: [{ ...p, originalResult: undefined }],
      }),
    ).toThrow('INTERNAL_MANUAL_EXPORT_INVALID_SOURCE');
    expect(() => renderRaceManualInternalPersonalExport({ ...raw, keys: [] })).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
    expect(() =>
      renderRaceManualInternalPersonalExport({ ...raw, chains: [{ ...p, preparation: null }] }),
    ).toThrow('INTERNAL_MANUAL_EXPORT_INVALID_SOURCE');
  });
  it('rejects sourceInput mismatch and tampered readonly body without inventing a fresh candidate', () => {
    const raw = source(),
      p = first(raw.chains);
    if (p.bodyState !== 'present') throw Error('fixture');
    p.preparation.sourceInput.binding.readSetDigest = 'b'.repeat(64);
    expect(() => renderRaceManualInternalPersonalExport(raw)).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
    const other = source(),
      q = first(other.chains);
    q.originalResult.candidateDigest = 'b'.repeat(64);
    expect(() => renderRaceManualInternalPersonalExport(other)).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
  });
  it('rejects candidate tuple/digest/recipe tamper and preserves original input', () => {
    const raw = withCandidate(),
      original = JSON.stringify(raw);
    renderRaceManualInternalPersonalExport(raw);
    expect(JSON.stringify(raw)).toBe(original);
    const c = first(raw.candidates);
    if (c.bodyState !== 'present') throw Error('fixture');
    c.candidate.chain.proposalId = id(99);
    expect(() => renderRaceManualInternalPersonalExport(raw)).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
  });
  it('rejects rehashed proposed changes that contradict the original frozen intent', () => {
    const raw = withCandidate(),
      row = first(raw.candidates);
    if (row.bodyState !== 'present') throw Error('fixture');
    row.candidate.raceChange.newLocalDate = '2026-10-10';
    const { applicationDigest, ...unsigned } = row.candidate;
    void applicationDigest;
    row.candidate.applicationDigest = impactDependencyDigest(unsigned);
    expect(() => renderRaceManualInternalPersonalExport(raw)).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
  });
  it('accepts reordered exact affected membership and rejects substituted targets', () => {
    const f = allDomains(),
      c = f.context;
    c.nutrition = [];
    c.rosters.nutrition = [];
    c.routines = [];
    c.rosters.routine = [];
    c.routineActualManifest.blueprints = [];
    c.routineActualManifest.schedules = [];
    const recovery = first(c.recovery);
    recovery.record.status = 'user_confirmed';
    recovery.record.selectedOptionId = id(14);
    const raw = withCandidate(false, fromCapture(pin(c)));
    const row = first(raw.candidates),
      parent = first(raw.chains);
    if (
      row.bodyState !== 'present' ||
      parent.bodyState !== 'present' ||
      row.candidate.applicationState !== 'ready_for_explicit_approval' ||
      parent.preparation.candidate.status !== 'assembled_readonly' ||
      !c.currentTraining
    )
      throw Error('fixture');
    const plan = parent.preparation.candidate.body.projection.calendar.plan;
    if (!plan) throw Error('fixture');
    const head = {
      kind: 'exists',
      versionId: recovery.record.versionId,
      version: recovery.record.version,
    };
    const trainingHead = {
      kind: 'exists',
      versionId: c.currentTraining.snapshot.id,
      version: c.currentTraining.snapshot.version,
    };
    const { applicationDigest, ...original } = row.candidate;
    void applicationDigest;
    const unsigned = {
      ...original,
      expectation: {
        ...original.expectation,
        heads: {
          ...original.expectation.heads,
          training: {
            state: 'present',
            members: [{ aggregateId: c.currentTraining.aggregateId, head: trainingHead }],
          },
          recovery: { state: 'present', members: [{ aggregateId: recovery.aggregateId, head }] },
        },
      },
      affected: [
        { domain: 'recovery', aggregateId: recovery.aggregateId },
        { domain: 'training', aggregateId: c.currentTraining.aggregateId },
      ],
      writes: [
        {
          domain: 'training',
          aggregateId: c.currentTraining.aggregateId,
          expectedHead: trainingHead,
          proposed: plan,
        },
        {
          domain: 'recovery',
          aggregateId: recovery.aggregateId,
          expectedHead: head,
          proposed: recovery.record.draft,
          selectedOptionId: id(14),
        },
      ],
    };
    row.candidate = raceManualApprovalCandidateSchema.parse({
      ...unsigned,
      applicationDigest: impactDependencyDigest(unsigned),
    });
    const rendered = renderRaceManualInternalPersonalExport(raw);
    expect(rendered.manualInternalCandidates).toHaveLength(1);
    const wrong = structuredClone(raw),
      target = first(wrong.candidates);
    if (
      target.bodyState !== 'present' ||
      target.candidate.applicationState !== 'ready_for_explicit_approval'
    )
      throw Error('fixture');
    const modified = first(target.candidate.affected);
    modified.aggregateId = id(99);
    const write = target.candidate.writes.find((w) => w.domain === modified.domain);
    if (!write) throw Error('fixture');
    write.aggregateId = id(99);
    const { applicationDigest: old, ...changed } = target.candidate;
    void old;
    target.candidate.applicationDigest = impactDependencyDigest(changed);
    expect(() => renderRaceManualInternalPersonalExport(wrong)).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
  });
  it('rejects contradictory purge lineage, duplicate tuples and microsecond mismatch', () => {
    const raw = source(),
      p = first(raw.chains);
    p.originalResult.createdAt = '2026-10-08T00:00:00.123457Z';
    expect(() => renderRaceManualInternalPersonalExport(raw)).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
    const other = source();
    other.chains.push(first(other.chains));
    expect(() => renderRaceManualInternalPersonalExport(other)).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
  });
  it('rejects getters, sparse/cyclic/deep and oversized source before parsing', () => {
    let calls = 0;
    expect(() =>
      renderRaceManualInternalPersonalExport({
        get chains() {
          calls++;
          return [];
        },
      }),
    ).toThrow('INTERNAL_MANUAL_EXPORT_INVALID_SOURCE');
    expect(calls).toBe(0);
    expect(() => renderRaceManualInternalPersonalExport(new Array(2))).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
    const cycle: Record<string, unknown> = {};
    cycle['x'] = cycle;
    expect(() => renderRaceManualInternalPersonalExport(cycle)).toThrow(
      'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE',
    );
    let deep: unknown = null;
    for (let i = 0; i < 65; i++) deep = { x: deep };
    expect(() => renderRaceManualInternalPersonalExport(deep)).toThrow(
      'INTERNAL_MANUAL_EXPORT_LIMIT',
    );
    expect(() => renderRaceManualInternalPersonalExport({ value: '식'.repeat(3000000) })).toThrow(
      'INTERNAL_MANUAL_EXPORT_LIMIT',
    );
  });
});
