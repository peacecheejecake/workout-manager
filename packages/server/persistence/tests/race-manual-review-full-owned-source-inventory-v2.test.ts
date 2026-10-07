import { expect, it } from 'vitest';
import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { coreEvidenceDependencyManifestSchema } from '@workout/contracts/evidence-dependencies';
import { foodDefinitionVersionSchema } from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import {
  routineScheduleVersionSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  domainPlanRefSchema,
  routineStepContentSchema,
} from '@workout/contracts/routines';
import { supplementarySessionLinkSchema } from '@workout/contracts/supplementary-core';
import { assembleRaceManualReviewCandidateCompatibleV4 } from '@workout/server-coaching/race-manual-review-candidate-v2';
import type { manualActivityReadFactsSchema } from '../src/race-plan-impact-manual-activity-read-facts.js';
import type { manualIntakeReadFactsSchema } from '../src/race-plan-impact-intake-read-facts.js';
import { courseReadManifestSchema } from '../src/race-plan-impact-course-manifest.js';
import { raceImpactConsumedCaptureSchema } from '../src/race-plan-impact-complete-manifest.js';
import {
  integratedDependencyKinds,
  impactDependencyDigest as digest,
} from '../src/race-plan-impact-dependencies.js';
import {
  buildRacePlanImpactProjectionInput,
  createRacePlanImpactCapturedCalculationPorts,
  raceProjectionIntentSchema,
} from '../src/race-plan-impact-projection-input.js';
import { enumerateRaceManualReviewFullCopiedSourcesV2 as enumerate } from '../src/race-manual-review-full-copied-inventory-v2.js';
const athlete = 'synthetic-manual',
  generation = '00000000-0000-4000-8000-000000000001',
  race = '00000000-0000-4000-8000-000000000002',
  hash = '1'.repeat(64),
  now = '2026-10-07T00:00:00.000Z';
const absent = () => ({ state: 'absent' as const });
const jsonRows = () => z.array(z.json()).parse([]);
function fixture() {
  const manualIntakeFields: {
    manualIntakeReadFacts?: z.infer<typeof manualIntakeReadFactsSchema>;
    manualActivityReadFacts?: z.infer<typeof manualActivityReadFactsSchema>;
  } = {};
  return {
    ...manualIntakeFields,
    status: 'blocked' as const,
    coverage: {
      complete: false as const,
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
    restoreGeneration: generation,
    manualBasis: {
      purpose: 'manual_race_date_change' as const,
      policy: { id: 'manual-race-date-impact' as const, version: 1 as const, digest: hash },
      app: { state: 'present' as const, granted: true, revision: 1 },
    },
    event: raceEventSchema.parse({
      id: race,
      revision: 1,
      title: 'Synthetic',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: null,
    }),
    collections: [
      { kind: 'race-event', revision: 1, privacy_generation: '0' },
      { kind: 'race-result', revision: 1, privacy_generation: '0' },
      { kind: 'training-best', revision: 1, privacy_generation: '0' },
    ],
    linkedPlan: z.nullable(planSnapshotSchema).parse(null),
    currentTraining: z
      .nullable(z.strictObject({ aggregateId: z.uuid(), snapshot: planSnapshotSchema }))
      .parse(null),
    completions: z.array(sessionCompletionSchema).parse([]),
    course: courseReadManifestSchema.nullable().parse(null),
    rosters: {
      nutrition: z.array(z.strictObject({ aggregateId: z.uuid(), versionId: z.uuid() })).parse([]),
      recovery: jsonRows(),
      routine: z.array(z.strictObject({ aggregateId: z.uuid(), versionId: z.uuid() })).parse([]),
    },
    nutrition: z
      .array(
        z.strictObject({
          aggregateId: z.uuid(),
          versionId: z.uuid(),
          record: nutritionPlanVersionCompatibleV4Schema,
          sourceRelation: z.enum(['absent', 'current', 'historical']),
          relativeItems: z.array(z.json()),
        }),
      )
      .parse([]),
    recovery: jsonRows(),
    routines: z
      .array(
        z.strictObject({
          aggregateId: z.uuid(),
          versionId: z.uuid(),
          record: routineScheduleVersionSchema,
          sourceVersionId: z.uuid().nullable(),
          sourceRelation: z.enum(['absent', 'current', 'historical']),
          affected: z.boolean(),
        }),
      )
      .parse([]),
    coreDependencies: coreEvidenceDependencyManifestSchema.parse({
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
    }),
    dependencyInventory: integratedDependencyKinds.map((kind) => ({
      kind,
      state: 'absent' as const,
    })),
    supplementaryManifest: {
      sessions: z
        .array(
          z.strictObject({
            planVersionId: z.uuid(),
            plannedSessionId: z.string(),
            state: z.enum(['absent', 'present']),
          }),
        )
        .parse([]),
      copies: z
        .array(
          z.strictObject({
            link: supplementarySessionLinkSchema,
            targetSource: z.enum(['session_copy', 'routine_version']),
            contentDigest: z.string(),
            targets: z.array(
              z.strictObject({
                block_id: z.string(),
                target_set_id: z.string(),
                exercise_version_id: z.uuid(),
              }),
            ),
          }),
        )
        .parse([]),
      routines: jsonRows(),
      exercises: z
        .array(
          z.strictObject({
            exerciseId: z.uuid(),
            versionId: z.uuid(),
            version: z.number(),
            contentDigest: z.string(),
            resourceVersionIds: z.array(z.string()),
            mediaAssetIds: z.array(z.string()),
          }),
        )
        .parse([]),
    },
    routineActualManifest: {
      uniqueSourceCount: 0,
      occurrences: z
        .array(
          z.strictObject({
            record: routineOccurrenceSchema,
            currentSchedule: z.union([
              z.strictObject({ state: z.literal('absent') }),
              z.strictObject({ state: z.literal('present'), versionId: z.uuid() }),
            ]),
            startedRun: z.union([
              z.strictObject({ state: z.literal('absent') }),
              z.strictObject({
                state: z.literal('present'),
                runId: z.uuid(),
                revision: z.number().int().min(0).max(2147483646),
              }),
            ]),
          }),
        )
        .parse([]),
      runs: jsonRows(),
      blueprints: z
        .array(
          z.strictObject({
            record: routineBlueprintVersionSchema,
            version: z.number(),
            currentHead: z.strictObject({
              state: z.literal('present'),
              versionId: z.uuid(),
              version: z.number(),
              visibility: z.literal('active'),
              favorite: z.boolean(),
            }),
            unsupportedContent: z.array(z.json()),
          }),
        )
        .parse([]),
      schedules: z
        .array(
          z.strictObject({
            scheduleId: z.uuid(),
            versionId: z.uuid(),
            sourcePlanVersionId: z.uuid().nullable(),
            record: routineScheduleVersionSchema,
            currentHead: z.strictObject({
              state: z.literal('present'),
              versionId: z.uuid(),
              notificationMuted: z.boolean(),
            }),
          }),
        )
        .parse([]),
      actualRosters: { activities: jsonRows(), intake: jsonRows(), recovery: jsonRows() },
    },
    sourcePermissionManifest: {
      complete: false as const,
      planned: z
        .array(
          z.strictObject({
            requested: domainPlanRefSchema,
            state: z.enum(['current', 'historical', 'unavailable']),
            reason: z.string().nullable(),
            currentHead: z
              .strictObject({ aggregate_id: z.uuid(), version_id: z.uuid() })
              .nullable(),
            content: z.strictObject({ digest: z.string() }).nullable(),
            aggregateIdentity: z.enum(['immutable_version', 'current_head_association_only']),
            exactOwnedVersion: z
              .strictObject({ aggregateId: z.uuid(), versionId: z.uuid() })
              .nullable()
              .optional(),
          }),
        )
        .parse([]),
      resources: jsonRows(),
      catalog: jsonRows(),
      nestedNutritionSources: z
        .array(
          z.strictObject({
            versionId: z.uuid(),
            recordDigest: z.string().optional(),
            foods: z.array(z.json()),
            anchors: z.array(z.json()),
            linkedPlan: z.json(),
          }),
        )
        .parse([]),
      activityMediaPermissions: {
        activities: jsonRows(),
        garminLineage: jsonRows(),
        healthkit: jsonRows(),
        media: jsonRows(),
        healthkitRegistry: z.json().parse(absent()),
        garmin: z.json().parse(absent()),
        garminUnofficial: z.json().parse(absent()),
        consents: z
          .array(z.json())
          .parse(['provider', 'healthkit', 'media'].map((kind) => ({ kind, ...absent() }))),
      },
      aiConsent: absent(),
      missing: [
        'unsupported_domain_item_membership',
        'immutable_training_aggregate_history',
        'media_cleanup_status_port',
        'media_and_provider_source_permissions',
        'manual_purpose_app_and_policy_binding',
      ],
    },
    consumedSources: {
      plans: z.array(planSnapshotSchema).parse([]),
      races: z.array(raceEventSchema).parse([]),
    },
    readSetDigest: hash,
    affected: { nutrition: [] as string[], routine: [] as string[] },
  };
}

function input(change: (c: z.infer<typeof raceImpactConsumedCaptureSchema>) => void = () => {}) {
  const c = raceImpactConsumedCaptureSchema.parse(fixture());
  const intent = raceProjectionIntentSchema.parse({
    expectedEvent: { id: c.event.id, revision: c.event.revision },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' },
  });
  c.calendarIntent = intent;
  c.consumedSources.races = [structuredClone(c.event)];
  change(c);
  intent.expectedEvent = { id: c.event.id, revision: c.event.revision };
  c.calendarIntent = intent;
  const { status, coverage, readSetDigest, affected, ...readSet } = c;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  c.readSetDigest = digest({
    ...readSet,
    coreDependencies: { ...c.coreDependencies, capturedAt: null },
  });
  const unsupported = z.strictObject({
    stepId: z.string(),
    content: routineStepContentSchema,
    state: z.literal('unavailable'),
    reason: z.literal('producer_content_unsupported'),
  });
  const calculation = {
    ...c,
    routineActualManifest: {
      ...c.routineActualManifest,
      blueprints: c.routineActualManifest.blueprints.map((row) => ({
        ...row,
        unsupportedContent: z.array(unsupported).parse(row.unsupportedContent),
      })),
    },
    coverage: {
      ...c.coverage,
      missing: z
        .tuple([
          z.literal('complete_catalog_and_actual_manifest'),
          z.literal('supplementary_reference_manifest'),
          z.literal('routine_occurrences_and_started_runs'),
          z.literal('complete_source_permission_manifest'),
          z.literal('manual_purpose_app_and_policy_binding'),
        ])
        .parse(c.coverage.missing),
      captured: z
        .tuple([
          z.literal('integrated_dependency_inventory'),
          z.literal('immutable_supplementary_copy_references'),
          z.literal('routine_occurrence_run_and_actual_reference_facts'),
          z.literal('partial_owned_planned_reference_and_resource_permission_facts'),
          z.literal('nested_nutrition_plan_food_anchor_and_activity_media_provider_facts'),
          z.literal('manual_purpose_app_and_policy_facts'),
        ])
        .parse(c.coverage.captured),
    },
    nutrition: c.nutrition.map((row) => ({
      ...row,
      relativeItems: row.relativeItems.map((item) => {
        if (item.entity === 'race') {
          if (item.sourceRaceRevision === undefined || item.sourceRaceDigest === undefined)
            throw Error('fixture');
          return {
            itemId: item.itemId,
            entity: 'race' as const,
            entityId: item.entityId,
            sourceVersionId: null,
            affected: item.affected,
            point: item.point,
            sourceRaceRevision: item.sourceRaceRevision,
            sourceRaceDigest: item.sourceRaceDigest,
            timing: 'not_resolved' as const,
          };
        }
        if (item.sourceVersionId === null) throw Error('fixture');
        return {
          itemId: item.itemId,
          entity: 'session' as const,
          entityId: item.entityId,
          sourceVersionId: item.sourceVersionId,
          affected: item.affected,
          point: item.point,
          timing: 'not_resolved' as const,
        };
      }),
    })),
  };
  const built = buildRacePlanImpactProjectionInput(calculation, intent);
  if (built.status !== 'projected') throw Error(built.reason);
  c.collectorSelection = built.collectorSelection;
  // Collector selection participates in the read-set digest.
  const { status: s2, coverage: c2, readSetDigest: d2, affected: a2, ...finalSet } = c;
  void s2;
  void c2;
  void d2;
  void a2;
  c.readSetDigest = digest({
    ...finalSet,
    coreDependencies: { ...c.coreDependencies, capturedAt: null },
  });
  const final = buildRacePlanImpactProjectionInput(
    { ...calculation, readSetDigest: c.readSetDigest },
    intent,
  );
  if (final.status !== 'projected') throw Error(final.reason);
  const sourceInput = {
    athleteId: athlete,
    binding: {
      purpose: c.manualBasis.purpose,
      event: { id: c.event.id, revision: c.event.revision },
      appRevision: 1,
      policy: c.manualBasis.policy,
      restoreGeneration: generation,
      readSetDigest: c.readSetDigest,
    },
    projectionInput: final.input,
    sourceFacts: final.sourceFacts,
  };
  const candidate = assembleRaceManualReviewCandidateCompatibleV4(
    sourceInput,
    createRacePlanImpactCapturedCalculationPorts(calculation),
  );
  if (candidate.status !== 'assembled_readonly') throw Error(candidate.reason);
  return { context: c, sourceInput, candidate };
}

import type { Transaction } from '../src/database.js';
import {
  captureRaceManualReviewFullOwnedSourceInventoryV2In as captureOwned,
  validateRaceManualReviewFullOwnedSourceInventoryV2,
} from '../src/race-manual-review-full-owned-source-inventory-v2.js';
function transaction(
  p: ReturnType<typeof input>,
  extra?: (sql: string, values?: unknown[]) => Record<string, unknown>[],
) {
  const queries: string[] = [];
  const tx: Transaction = {
    athleteId: p.context.athleteId,
    query: async (sql, values) => {
      queries.push(sql);
      if (sql.includes('manual_review_owned_v2 scalar race-event'))
        return {
          rows: [
            {
              count: '1',
              bytes: '10000',
              bodyMaximum: '1000',
              currentMaximum: '0',
              metadataMaximum: '100',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('manual_review_owned_v2 body race-event'))
        return {
          rows: [
            {
              athlete_id: tx.athleteId,
              metadata: {
                id: p.context.event.id,
                revision: p.context.event.revision,
                deleted: false,
              },
              record_json: p.context.event,
              current_record_json: null,
            },
          ],
          rowCount: 1,
        };
      if (!extra) throw Error('UNEXPECTED_QUERY:' + sql);
      const rows = extra(sql, values);
      return { rows, rowCount: rows.length };
    },
  };
  return { tx, queries };
}
async function observe(
  p: ReturnType<typeof input>,
  extra?: (sql: string, values?: unknown[]) => Record<string, unknown>[],
) {
  const traced = transaction(p, extra),
    budget = { bytes: 0n, sources: 0 };
  const result = await captureOwned(traced.tx, enumerate(p), p, budget);
  return { ...traced, result, budget };
}
function foodFixture() {
  const datum = (unit: string) => ({ value: null, unit, status: 'unknown', evidenceIds: [] });
  const food = foodDefinitionVersionSchema.parse({
    foodId: '食/opaque-𐀀',
    versionId: generation,
    version: 1,
    previousVersionId: null,
    createdAt: now,
    name: 'Food',
    basis: { kind: 'per_100g' },
    nutrients: {
      energy: datum('kcal'),
      carbohydrate: datum('g'),
      protein: datum('g'),
      fat: datum('g'),
      fluid: datum('mL'),
      sodium: datum('mg'),
    },
    provenance: {
      kind: 'user_entered',
      reference: null,
      capturedAt: now,
      reviewState: 'unreviewed',
    },
  });
  const p = input((c) => {
    c.sourcePermissionManifest.nestedNutritionSources = [
      {
        versionId: generation,
        foods: [
          {
            requestedVersionId: generation,
            state: 'current',
            content: {
              foodId: food.foodId,
              versionId: food.versionId,
              digest: digest(food),
              record: food,
              provenance: {
                kind: food.provenance.kind,
                reviewState: food.provenance.reviewState,
                capturedAt: now,
                reference: { state: 'absent' },
              },
            },
            currentHead: {
              versionId: food.versionId,
              provenance: {
                kind: food.provenance.kind,
                reviewState: food.provenance.reviewState,
                capturedAt: now,
                reference: { state: 'absent' },
              },
            },
          },
        ],
        anchors: [],
        linkedPlan: { state: 'absent' },
      },
    ];
  });
  return { p, food };
}
it('observes actual queried race correspondence without purpose/freshness/storage authority', async () => {
  const { result, queries, budget } = await observe(input());
  expect(result.status).toBe('observed_correspondence');
  expect(result.facts).toHaveLength(1);
  expect(result).toMatchObject({
    authority: 'none',
    freshness: 'not_checked',
    sqlRowDigest: 'not_captured',
    sourceAuthentication: 'unverified',
    approvalAllowed: false,
    admissionAllowed: false,
    storage: 'not_persisted',
  });
  expect(queries).toHaveLength(2);
  expect(budget.bytes).toBe(10512n);
});
it('uses exported food reader with original opaque identity and actual immutable DTO hash', async () => {
  const { p, food } = foodFixture();
  const { result, queries } = await observe(p, (sql, values) => {
    expect(values).toEqual([athlete, food.versionId]);
    return sql.includes('octet_length')
      ? [{ bytes: '10000' }]
      : [
          {
            food_id: food.foodId,
            version_id: food.versionId,
            record_json: food,
            current_version_id: food.versionId,
            current_provenance: food.provenance,
          },
        ];
  });
  expect(result.facts.find((f) => f.identity.kind === 'food-definition-version')).toMatchObject({
    state: 'matched',
    dtoDigest: digest(food),
  });
  expect(queries.some((q) => q.includes('food_definition_version'))).toBe(true);
});
it('foreign/absent exact food yields explicit unavailable fact with no synthesized original', async () => {
  const { p } = foodFixture();
  const { result } = await observe(p, (sql) =>
    sql.includes('octet_length') ? [{ bytes: '0' }] : [],
  );
  expect(result.status).toBe('blocked');
  expect(result.facts.find((f) => f.identity.kind === 'food-definition-version')).toMatchObject({
    state: 'unavailable',
    reason: 'owned_source_unavailable',
    dtoDigest: null,
  });
});
it('owned valid but changed food body is copied-body mismatch rather than owned truth from input', async () => {
  const { p, food } = foodFixture();
  const changed = { ...food, name: 'Actual newer value' };
  const { result } = await observe(p, (sql) =>
    sql.includes('octet_length')
      ? [{ bytes: '10000' }]
      : [
          {
            food_id: food.foodId,
            version_id: food.versionId,
            record_json: changed,
            current_version_id: food.versionId,
            current_provenance: food.provenance,
          },
        ],
  );
  expect(result.facts.find((f) => f.identity.kind === 'food-definition-version')).toMatchObject({
    state: 'unavailable',
    reason: 'copied_body_mismatch',
  });
});
it('does not accept a supplied inventory digest or locations that differ from original preparation', async () => {
  const p = input(),
    i = enumerate(p),
    { tx, queries } = transaction(p);
  const first = i.refs[0];
  if (!first) throw Error('FIXTURE');
  first.dtoDigest = '0'.repeat(64);
  await expect(captureOwned(tx, i, p, { bytes: 0n, sources: 0 })).rejects.toMatchObject({
    code: 'INVALID_CONTEXT',
  });
  expect(queries).toEqual([]);
});
it('rejects foreign supplied preparation before querying', async () => {
  const p = input(),
    { tx, queries } = transaction(p);
  await expect(
    captureOwned({ ...tx, athleteId: 'other' }, enumerate(p), p, { bytes: 0n, sources: 0 }),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(queries).toEqual([]);
});
it('reserves exact scalar response before body and keeps mutable request budget identity', async () => {
  const p = input(),
    { tx, queries } = transaction(p),
    budget = { bytes: 4194300n, sources: 0 };
  await expect(captureOwned(tx, enumerate(p), p, budget)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('scalar race-event');
  expect(budget.bytes).toBeGreaterThan(4194304n);
});
it('propagates actual SQL permission failures rather than swallowing aborted transaction', async () => {
  const p = input();
  const failure = Object.assign(Error('permission'), { code: '42501' });
  const tx: Transaction = {
    athleteId: athlete,
    query: async () => {
      throw failure;
    },
  };
  await expect(captureOwned(tx, enumerate(p), p, { bytes: 0n, sources: 0 })).rejects.toBe(failure);
});
it('rejects malformed direct budget before query', async () => {
  const p = input(),
    { tx, queries } = transaction(p);
  await expect(captureOwned(tx, enumerate(p), p, { bytes: -1n, sources: 0 })).rejects.toMatchObject(
    { code: 'INVALID_CONTEXT' },
  );
  expect(queries).toEqual([]);
});
it('output codec rejects authority upgrade, duplicate facts and accessor execution', async () => {
  const { result } = await observe(input());
  expect(
    validateRaceManualReviewFullOwnedSourceInventoryV2({ ...result, authority: 'approved' })
      .success,
  ).toBe(false);
  expect(
    validateRaceManualReviewFullOwnedSourceInventoryV2({
      ...result,
      facts: [...result.facts, ...result.facts],
    }).success,
  ).toBe(false);
  let reads = 0;
  const getter = {
    get facts() {
      reads++;
      return result.facts;
    },
  };
  expect(validateRaceManualReviewFullOwnedSourceInventoryV2(getter).success).toBe(false);
  expect(reads).toBe(0);
});

import { recoveryMethodVersionSchema } from '@workout/contracts/recovery-core';
import { galleryMediaItemSchema } from '@workout/contracts/gallery';
import { raceMediaCleanupSourceSchema } from '../src/race-media-cleanup-source.js';
const extraId = '00000000-0000-4000-8000-000000000010';
function methodFixture() {
  const method = recoveryMethodVersionSchema.parse({
    schemaVersion: 1,
    methodId: extraId,
    versionId: generation,
    version: 1,
    title: 'Method',
    category: 'relaxation',
    intendedUse: 'User action',
    applicability: [],
    cautions: [],
    sourceDescription: '',
    evidenceLimitations: 'Unreviewed',
    reviewState: 'unreviewed',
    reviewedAt: null,
    source: 'user_recorded',
    createdAt: now,
  });
  const p = input((c) => {
    c.recoverySources = {
      methodCatalogRequests: [
        { kind: 'recovery_method', ref: { id: extraId, versionId: generation } },
      ],
      methods: [method],
      methodFacts: [
        {
          requested: { kind: 'recovery_method', ref: { id: extraId, versionId: generation } },
          state: 'historical',
          reason: null,
          content: { digest: digest(method) },
          currentHead: { aggregate_id: extraId, version_id: race },
          provenance: { source: 'user_recorded', reviewState: 'unreviewed', reviewedAt: null },
        },
      ],
      trainingAssociations: [],
      nutritionReferences: [],
      unavailable: [],
      authority: 'none',
      freshness: 'not_checked',
    };
  });
  return { p, method };
}
it('reconciles own historical recovery method by exact stored tuple, not current catalog permission', async () => {
  const { p, method } = methodFixture();
  const { result } = await observe(p, (sql) =>
    sql.includes('scalar')
      ? [{ count: '1', bytes: '10000', maximum: '1000' }]
      : [
          {
            athlete_id: athlete,
            metadata: { id: extraId, versionId: generation },
            record_json: method,
          },
        ],
  );
  expect(result.facts.find((f) => f.identity.kind === 'recovery-method-version')).toMatchObject({
    state: 'matched',
    dtoDigest: digest(method),
  });
});
it('wrong method metadata full tuple remains unavailable despite identical copied body', async () => {
  const { p, method } = methodFixture();
  const { result } = await observe(p, (sql) =>
    sql.includes('scalar')
      ? [{ count: '1', bytes: '10000', maximum: '1000' }]
      : [
          {
            athlete_id: athlete,
            metadata: { id: race, versionId: generation },
            record_json: method,
          },
        ],
  );
  expect(result.facts.find((f) => f.identity.kind === 'recovery-method-version')).toMatchObject({
    state: 'unavailable',
    reason: 'source_tuple_mismatch',
  });
});
it('method scalar oversize fails before body transport', async () => {
  const { p } = methodFixture();
  const { tx, queries } = transaction(p, () => [
    { count: '1', bytes: '600000', maximum: '600000' },
  ]);
  await expect(captureOwned(tx, enumerate(p), p, { bytes: 0n, sources: 0 })).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(queries.some((q) => q.includes('full_owned_v2 body recovery-method-version'))).toBe(false);
});
function mediaFixture() {
  const record = galleryMediaItemSchema.parse({
    id: extraId,
    mediaKind: 'image',
    visibility: 'private',
    includeForCoach: false,
    album: null,
    caption: null,
    activityId: null,
    capturedAt: null,
    capturedLocalDate: null,
    file: { originalFileName: 'synthetic.png', mediaType: 'image/png', byteSize: 12, sha256: hash },
    preview: null,
    accessRevision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const cleanup = raceMediaCleanupSourceSchema.parse({
    schemaVersion: 1,
    authority: 'db_cleanup_status_only',
    mediaItemId: extraId,
    expectedAccessRevision: 1,
    observedAccessRevision: 1,
    deleted: false,
    inventoryComplete: true,
    state: 'absent',
    reason: null,
    refs: [{ digest: hash, reason: null, state: 'absent' }],
    digestVersion: 'postgres-jsonb-v1',
    sourceDigest: hash,
  });
  const p = input((c) => {
    c.mediaReadFacts = {
      requestedIds: [extraId],
      facts: [
        {
          requestedId: extraId,
          state: 'owned',
          reason: null,
          record,
          current: { mediaItemId: extraId, accessRevision: 1, deleted: false },
          originalLedger: { sha256: hash, byteSize: 12, mediaType: 'image/png' },
          originalObjectIdentityDigest: hash,
          previewLedger: null,
          cleanup: { status: 'available', source: cleanup },
        },
      ],
      authority: 'none',
      freshness: 'not_checked',
      sourceScope: 'db_recorded_descriptor_only',
    };
  });
  return p;
}
it('gallery missing normal ledger capability returns finite unavailable without queue or ledger access', async () => {
  const p = mediaFixture();
  const { result, queries } = await observe(p, (sql) => {
    expect(sql).toContain('has_table_privilege');
    return [{ available: false }];
  });
  expect(result.facts.find((f) => f.identity.kind === 'gallery-descriptor')).toMatchObject({
    state: 'unavailable',
    reason: 'read_capability_unavailable',
  });
  expect(queries.filter((q) => q.includes('gallery_media_object'))).toHaveLength(1);
  expect(queries.some((q) => q.includes('resource_object_cleanup'))).toBe(false);
});

it('reserves capability scalar before SQL when inherited remaining bytes are below its envelope', async () => {
  const p = mediaFixture(),
    { tx, queries } = transaction(p, () => {
      throw Error('CAPABILITY_TRANSPORT_MUST_NOT_RUN');
    });
  const budget = { bytes: 4194304n - 400n, sources: 0 };
  await expect(captureOwned(tx, enumerate(p), p, budget)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(queries).toEqual([]);
  expect(queries.some((q) => q.includes('has_table_privilege'))).toBe(false);
});
