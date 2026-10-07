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

import {
  prepareRaceManualReviewRetainedPayloadV2 as retain,
  prepareRaceManualReviewMultiOwnedRetainedPayloadV3 as retainMulti,
  raceManualReviewMultiOwnedRetainedPayloadV3Schema,
  validateRaceManualReviewRetainedPayloadV2 as validate,
  raceManualReviewRetainedPayloadV2InputSchema,
} from '../src/race-manual-review-retained-payload-v2.js';
function retainedInput(preparation = input()) {
  const inventory = enumerate(preparation);
  return {
    state: 'present' as const,
    preparation,
    inventory,
    dtoObservations: {
      scope: inventory.scope,
      status: 'observed_correspondence' as const,
      copiedInventoryComplete: true,
      coverage: inventory.candidateCoverage,
      facts: inventory.refs.map((ref) => ({
        identity: ref.identity,
        representation: ref.representation,
        state: 'matched' as const,
        dtoDigest: ref.dtoDigest,
        reason: null,
      })),
      observation: 'same_transaction_owned_rows' as const,
      sqlRowDigest: 'not_captured' as const,
      sourceAuthentication: 'unverified' as const,
      sourceCompleteness: 'unverified' as const,
      lifecycleAuthority: 'none' as const,
      permissionAuthority: 'none' as const,
      authority: 'none' as const,
      freshness: 'not_checked' as const,
      storage: 'not_persisted' as const,
      admissionAllowed: false as const,
      approvalAllowed: false as const,
    },
    sqlObservations: {
      bindingVersion: 2 as const,
      scope: 'prepared_full_context_relation_groups_only' as const,
      hashMethod: 'postgres-owned-relation-row-jsonb-utc-v2' as const,
      sqlRefsDigest: hash,
      transactionId: '123',
      callerRole: 'synthetic_app',
      athleteId: athlete,
      rows: inventory.refs.map((ref, index) => {
        const identity = ref.identity;
        if (identity.kind !== 'race-event' && identity.kind !== 'food-definition-version')
          throw Error('unsupported synthetic SQL fixture');
        const relations =
          identity.kind === 'race-event'
            ? [
                {
                  role: 'current_body',
                  relation: 'race_event',
                  key: [identity.sourceId, identity.revision],
                  hashMethod: 'postgres-owned-relation-row-jsonb-utc-v2' as const,
                  sourceRowDigest: hash,
                },
              ]
            : [
                {
                  role: 'immutable_version',
                  relation: 'food_definition_version',
                  key: [identity.sourceId, identity.versionId],
                  hashMethod: 'postgres-owned-relation-row-jsonb-utc-v2' as const,
                  sourceRowDigest: hash,
                },
                {
                  role: 'current_head',
                  relation: 'food_definition_head',
                  key: [identity.sourceId],
                  hashMethod: 'postgres-owned-relation-row-jsonb-utc-v2' as const,
                  sourceRowDigest: hash,
                },
              ];
        return {
          ordinal: index + 1,
          identity,
          state: 'observed' as const,
          reason: null,
          relations,
          relationGroupHashMethod: 'postgres-owned-relation-group-jsonb-v2' as const,
          relationGroupDigest: hash,
          cleanupHashMethod: 'postgres-narrow-cleanup-observation-jsonb-v1' as const,
          cleanupObservationDigest: null,
        };
      }),
      storage: 'not_persisted' as const,
      admissionAllowed: false as const,
      sourceCompleteness: 'unverified' as const,
      authority: 'none' as const,
      freshness: 'not_checked' as const,
    },
    currentAuthority: {
      authority: 'none' as const,
      freshness: 'not_checked' as const,
      permissionAuthority: 'none' as const,
      lifecycleAuthority: 'none' as const,
      admissionAllowed: false as const,
      approvalAllowed: false as const,
    },
  };
}
it('round trips exact original C/S/B and ordered copied source rosters without authority', () => {
  const v = retainedInput(),
    result = retain(v);
  expect(result.status).toBe('structurally_corresponding');
  expect(validate(result).success).toBe(true);
  if (result.state !== 'present') throw Error('present');
  expect(result.payload.preparation).toEqual(v.preparation);
  expect(result).toMatchObject({
    authority: 'none',
    freshness: 'not_checked',
    admissionAllowed: false,
    approvalAllowed: false,
    storage: 'not_persisted',
  });
});
it('does not use SQL fingerprints as DTO checksums', () => {
  const v = retainedInput();
  expect(v.inventory.refs[0]?.digestMethod).toBe('dto-object-key-canonical-sha256-v1');
  expect(retain(v).sqlAuthentication).toBe('unverified');
});
it('blocks altered copied locations even if the supplied inventory claims mapped', () => {
  const v = retainedInput(),
    ref = v.inventory.refs[0];
  if (!ref) throw Error('ref');
  ref.copiedLocations = ['candidate.body.unknown'];
  expect(retain(v)).toMatchObject({ status: 'blocked', reason: 'inventory_mismatch' });
});
it('blocks omitted copied refs and preserves exact observed roster requirements', () => {
  const v = retainedInput();
  v.inventory.refs = [];
  expect(() => retain(v)).toThrow();
});
it('blocks wrong DTO digest separately from SQL evidence', () => {
  const v = retainedInput(),
    fact = v.dtoObservations.facts[0];
  if (!fact) throw Error('fact');
  fact.dtoDigest = 'f'.repeat(64);
  expect(retain(v)).toMatchObject({ status: 'blocked', reason: 'dto_observation_mismatch' });
});
it('rejects unknown keys and positive authority claims', () => {
  const v = retainedInput();
  expect(() => retain({ ...v, storeAllowed: true })).toThrow();
  expect(() =>
    retain({ ...v, currentAuthority: { ...v.currentAuthority, admissionAllowed: true } }),
  ).toThrow();
});
it('keeps null distinct from zero in the original event', () => {
  const v = retainedInput();
  const result = retain(v);
  if (result.state !== 'present') throw Error('present');
  expect(result.payload.preparation.context.event.targetSeconds).toBeNull();
  expect(
    validate({
      ...result,
      payload: {
        ...result.payload,
        preparation: {
          ...result.payload.preparation,
          context: {
            ...result.payload.preparation.context,
            event: { ...result.payload.preparation.context.event, targetSeconds: 0 },
          },
        },
      },
    }).success,
  ).toBe(false);
});
it('rejects changed checksum or audit while keeping output validation unauthenticated', () => {
  const result = retain(retainedInput());
  if (result.state !== 'present') throw Error('present');
  expect(validate({ ...result, payloadDigest: 'f'.repeat(64) }).success).toBe(false);
  expect(
    validate({
      ...result,
      minimalAudit: { ...result.minimalAudit, candidateDigest: 'f'.repeat(64) },
    }).success,
  ).toBe(false);
});
it('keeps a purged artifact minimal and blocked for independent original proof', () => {
  const v = retainedInput();
  const original = retain(v);
  if (original.state !== 'present') throw Error('present');
  const tombstone = retain({
    state: 'purged',
    originalPayloadDigest: original.payloadDigest,
    minimalAudit: original.minimalAudit,
    sourceWitness: 'not_authenticated',
    suppressionTail: 'not_authenticated',
    currentAuthority: v.currentAuthority,
  });
  expect(tombstone).toMatchObject({
    status: 'blocked',
    reason: 'external_source_witness_required',
    originalPayloadDigest: original.payloadDigest,
    minimalAudit: original.minimalAudit,
  });
  expect('payload' in tombstone).toBe(false);
  expect(validate(tombstone).success).toBe(true);
  expect(() =>
    retain({
      state: 'purged',
      originalPayloadDigest: original.payloadDigest,
      minimalAudit: original.minimalAudit,
      sourceWitness: 'authenticated',
      suppressionTail: 'not_authenticated',
      currentAuthority: v.currentAuthority,
    }),
  ).toThrow();
});
it('rejects accessors without execution', () => {
  let calls = 0;
  const value = Object.defineProperty({}, 'state', {
    enumerable: true,
    get() {
      calls++;
      return 'present';
    },
  });
  expect(raceManualReviewRetainedPayloadV2InputSchema.safeParse(value).success).toBe(false);
  expect(calls).toBe(0);
});
it.each([NaN, Infinity, undefined, BigInt(0)])('rejects non JSON primitive %s', (value) => {
  expect(
    raceManualReviewRetainedPayloadV2InputSchema.safeParse({ state: 'present', value }).success,
  ).toBe(false);
});
it('rejects cycles, excessive depth, prototypes and UTF8 byte overflow', () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(raceManualReviewRetainedPayloadV2InputSchema.safeParse(cycle).success).toBe(false);
  let depth: unknown = null;
  for (let i = 0; i < 66; i++) depth = { child: depth };
  expect(raceManualReviewRetainedPayloadV2InputSchema.safeParse(depth).success).toBe(false);
  expect(raceManualReviewRetainedPayloadV2InputSchema.safeParse(new Date()).success).toBe(false);
  expect(
    raceManualReviewRetainedPayloadV2InputSchema.safeParse({ text: '한'.repeat(1400000) }).success,
  ).toBe(false);
});

function foodFixture(energyEvidenceIds: string[] = []) {
  const datum = (unit: string) => ({
    value: null,
    unit,
    status: 'unknown',
    evidenceIds: unit === 'kcal' ? energyEvidenceIds : [],
  });
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

it('preserves opaque food identity, null nutrients and semantic arrays in original payload', () => {
  const { p, food } = foodFixture(),
    v = retainedInput(p),
    result = retain(v);
  expect(result.status).toBe('structurally_corresponding');
  if (result.state !== 'present') throw Error('present');
  expect(
    result.payload.inventory.refs.some(
      (ref) =>
        ref.identity.kind === 'food-definition-version' && ref.identity.sourceId === food.foodId,
    ),
  ).toBe(true);
  expect(
    result.payload.preparation.context.sourcePermissionManifest.nestedNutritionSources[0]?.foods[0]
      ?.content?.record,
  ).toEqual(food);
  expect(food.nutrients.energy.value).toBeNull();
});
it('rejects SQL unknown keys, wrong namespace, wrong principal and ordinal', () => {
  const v = retainedInput();
  const row = v.sqlObservations.rows[0];
  if (!row) throw Error('row');
  for (const sqlObservations of [
    { ...v.sqlObservations, verified: true },
    { ...v.sqlObservations, hashMethod: 'dto-object-key-canonical-sha256-v1' },
    { ...v.sqlObservations, rows: [{ ...row, ordinal: 2 }] },
    {
      ...v.sqlObservations,
      rows: [{ ...row, relations: [{ ...row.relations[0], relation: 'nutrition_plan_version' }] }],
    },
  ])
    expect(() => retain({ ...v, sqlObservations })).toThrow();
});
it('blocks foreign SQL diagnostic tenant without treating current_user as ownership proof', () => {
  const v = retainedInput();
  expect(
    retain({ ...v, sqlObservations: { ...v.sqlObservations, athleteId: 'foreign' } }),
  ).toMatchObject({ status: 'blocked', reason: 'sql_observation_mismatch' });
});
it('retains SQL hash-shaped claims but explicitly does not verify those hashes', () => {
  const v = retainedInput();
  const result = retain({
    ...v,
    sqlObservations: {
      ...v.sqlObservations,
      sqlRefsDigest: 'f'.repeat(64),
      rows: v.sqlObservations.rows.map((row) => ({ ...row, relationGroupDigest: 'e'.repeat(64) })),
    },
  });
  expect(result.status).toBe('structurally_corresponding');
  expect(result.sqlAuthentication).toBe('unverified');
});
it('blocks unavailable owned source while retaining the exact identity audit', () => {
  const v = retainedInput();
  const result = retain({
    ...v,
    dtoObservations: {
      ...v.dtoObservations,
      status: 'blocked',
      facts: v.dtoObservations.facts.map((row) => ({
        ...row,
        state: 'unavailable',
        dtoDigest: null,
        reason: 'history_missing',
      })),
    },
  });
  expect(result).toMatchObject({ status: 'blocked', reason: 'source_unavailable' });
});
it('blocks unavailable SQL source without accepting an empty relation as observed', () => {
  const v = retainedInput();
  const rows = v.sqlObservations.rows.map((row) => ({
    ...row,
    state: 'unavailable',
    reason: 'source_unavailable',
    relations: [],
    relationGroupDigest: null,
  }));
  expect(retain({ ...v, sqlObservations: { ...v.sqlObservations, rows } })).toMatchObject({
    status: 'blocked',
    reason: 'source_unavailable',
  });
  expect(() =>
    retain({
      ...v,
      sqlObservations: {
        ...v.sqlObservations,
        rows: rows.map((row) => ({ ...row, state: 'observed', reason: null })),
      },
    }),
  ).toThrow();
});
it('checks ordered DTO roster and rejects duplicate SQL identities', () => {
  const { p } = foodFixture(),
    v = retainedInput(p);
  expect(
    retain({
      ...v,
      dtoObservations: { ...v.dtoObservations, facts: [...v.dtoObservations.facts].reverse() },
    }),
  ).toMatchObject({ status: 'blocked', reason: 'dto_observation_mismatch' });
  expect(() =>
    retain({
      ...v,
      sqlObservations: {
        ...v.sqlObservations,
        rows: [v.sqlObservations.rows[0], v.sqlObservations.rows[0]],
      },
    }),
  ).toThrow();
});
it('rejects a self-claimed tombstone witness or extra copied body', () => {
  const v = retainedInput(),
    original = retain(v);
  if (original.state !== 'present') throw Error('present');
  const purged = {
    state: 'purged',
    originalPayloadDigest: original.payloadDigest,
    minimalAudit: original.minimalAudit,
    sourceWitness: 'not_authenticated',
    suppressionTail: 'not_authenticated',
    currentAuthority: v.currentAuthority,
  };
  expect(() => retain({ ...purged, eventWitness: { verified: true } })).toThrow();
  expect(() => retain({ ...purged, payload: v })).toThrow();
});

it('preserves semantic evidence array order instead of set-sorting it', () => {
  const { p } = foodFixture(['z', 'a', '한글']);
  const result = retain(retainedInput(p));
  if (result.state !== 'present') throw Error('present');
  expect(
    result.payload.preparation.context.sourcePermissionManifest.nestedNutritionSources[0]?.foods[0]
      ?.content?.record?.nutrients.energy.evidenceIds,
  ).toEqual(['z', 'a', '한글']);
});
it('accepts dense legitimate JSON above 100000 structure nodes within the explicit byte boundary', () => {
  const { p } = foodFixture(Array.from({ length: 120000 }, () => 'x'));
  const v = retainedInput(p),
    result = retain(v);
  expect(Buffer.byteLength(JSON.stringify(v), 'utf8')).toBeGreaterThan(400000);
  expect(result.status).toBe('structurally_corresponding');
  expect(validate(result).success).toBe(true);
});
it('rejects copied visit overflow before allowing a larger roster', () => {
  const v = retainedInput(),
    ref = v.inventory.refs[0];
  if (!ref) throw Error('ref');
  ref.copiedLocations = Array.from({ length: 5001 }, () => 'context.event');
  expect(() => retain(v)).toThrow();
});

it('explicit multi-owned profile retains both copied race bodies while old V2 still rejects them', () => {
  const preparation = input((c) => {
    c.consumedSources.races.push({
      ...structuredClone(c.event),
      id: '00000000-0000-4000-8000-000000000003',
      title: 'Unrelated frozen source',
    });
  });
  const value = retainedInput(preparation);
  expect(value.inventory.refs.filter((r) => r.identity.kind === 'race-event')).toHaveLength(2);
  expect(() => retain(value)).toThrow();
  const retained = retainMulti(value);
  expect(retained).toMatchObject({
    state: 'present',
    status: 'structurally_corresponding',
    codecVersion: 2,
    authority: 'none',
    sourceAuthentication: 'unverified',
    approvalAllowed: false,
  });
  expect(raceManualReviewMultiOwnedRetainedPayloadV3Schema.parse(retained)).toEqual(retained);
  expect(validate(retained).success).toBe(false);
});
it('multi-owned retained profile preserves old single-race bytes and no-authority limitations', () => {
  const value = retainedInput();
  expect(retainMulti(value)).toEqual(retain(value));
});
it('multi-owned profile rejects duplicate/unknown observation authority without weakening correspondence', () => {
  const value = retainedInput();
  expect(() =>
    retainMulti({
      ...value,
      sqlObservations: { ...value.sqlObservations, authority: 'authenticated' },
    }),
  ).toThrow();
  expect(() =>
    retainMulti({
      ...value,
      sqlObservations: {
        ...value.sqlObservations,
        rows: [...value.sqlObservations.rows, ...value.sqlObservations.rows],
      },
    }),
  ).toThrow();
});
