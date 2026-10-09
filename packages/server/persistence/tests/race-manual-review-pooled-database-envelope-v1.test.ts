import { expect, it, vi } from 'vitest';
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
      title: '합성'.repeat(60),
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

import {
  prepareRaceManualReviewMultiOwnedRetainedPayloadV3 as retainMulti,
  raceManualReviewMultiOwnedRetainedPayloadV3Schema,
} from '../src/race-manual-review-retained-payload-v2.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 as encode } from '../src/race-manual-review-pooled-retained-payload-v1.js';
function original() {
  const retained = retainMulti(retainedInput(foodFixture(['順序B', '順序A']).p));
  return raceManualReviewMultiOwnedRetainedPayloadV3Schema.parse(retained);
}

import {
  toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase,
  fromRaceManualReviewPooledDatabaseEnvelopeV1 as fromDatabase,
  decodeRaceManualReviewPooledDatabaseEnvelopeV1 as decodeDatabase,
  raceManualReviewPooledDatabaseEnvelopeV1Schema as databaseSchema,
} from '../src/race-manual-review-pooled-database-envelope-v1.js';
it('preserves old direct markers and inventory while preparation alone is encoded', () => {
  const logical = original();
  const privateWire = encode(logical);
  const db = toDatabase(privateWire);
  if (logical.state !== 'present') throw Error('fixture');
  expect(db.state).toBe(logical.state);
  expect(db.status).toBe(logical.status);
  expect(db.minimalAudit).toEqual(logical.minimalAudit);
  expect(db.payload.inventory).toEqual(logical.payload.inventory);
  expect(db.payload.dtoObservations).toEqual(logical.payload.dtoObservations);
  expect(db.payload.sqlObservations).toEqual(logical.payload.sqlObservations);
  expect(db.payload.currentAuthority).toEqual(logical.payload.currentAuthority);
  expect(Object.keys(db.payload.preparation.skeleton)).toEqual([
    'context',
    'sourceInput',
    'candidate',
  ]);
  expect(fromDatabase(db)).toEqual(privateWire);
  expect(decodeDatabase(db)).toEqual(logical);
  expect(digest(decodeDatabase(db))).toBe(digest(logical));
  expect(db.payload.preparation.sourcePool).toEqual(privateWire.sourcePool);
  expect(db.payload.preparation.substitutions).toEqual(privateWire.substitutions);
});
it('rejects unknown/drop/null/inventory/marker/ordinal tampering and a forged purged shape', () => {
  const db = toDatabase(encode(original()));
  const { minimalAudit: removed, ...missing } = db;
  void removed;
  for (const raw of [
    { ...db, extra: true },
    missing,
    { ...db, state: 'purged' },
    { ...db, status: 'blocked' },
    { ...db, minimalAudit: null },
    { ...db, payload: null },
    { ...db, payload: { ...db.payload, inventory: null } },
    { ...db, payload: { ...db.payload, inventory: { ...db.payload.inventory, refs: [] } } },
    { ...db, payload: { ...db.payload, preparation: { ...db.payload.preparation, extra: true } } },
    {
      ...db,
      payload: {
        ...db.payload,
        preparation: {
          ...db.payload.preparation,
          skeleton: { ...db.payload.preparation.skeleton, extra: true },
        },
      },
    },
    {
      ...db,
      payload: {
        ...db.payload,
        preparation: {
          ...db.payload.preparation,
          sourcePool: db.payload.preparation.sourcePool.map((r) => ({
            ...r,
            ordinal: r.ordinal + 1,
          })),
        },
      },
    },
    {
      ...db,
      payload: {
        ...db.payload,
        currentAuthority: { ...db.payload.currentAuthority, approvalAllowed: true },
      },
    },
  ]) {
    const validation = databaseSchema.safeParse(raw);
    expect(validation.success).toBe(false);
    if (validation.success) throw Error('NEGATIVE_REQUIRED');
    try {
      decodeDatabase(raw);
      throw Error('DECODE_REJECTION_REQUIRED');
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      expect(error.issues).toEqual(validation.error.issues);
    }
  }
});
it('never accepts the private wire as a DB envelope or the old logical preparation as encoded', () => {
  const logical = original();
  const privateWire = encode(logical);
  const db = toDatabase(privateWire);
  expect(databaseSchema.safeParse(privateWire).success).toBe(false);
  expect(databaseSchema.safeParse(logical).success).toBe(false);
  expect(() =>
    fromDatabase({
      ...db,
      payload: {
        ...db.payload,
        preparation: logical.state === 'present' ? logical.payload.preparation : null,
      },
    }),
  ).toThrow();
});
it('bounds plain ingress without executing getters and rejects cycles/UTF8/escaped overflow', () => {
  let calls = 0;
  const value = Object.defineProperty({}, 'payload', {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  for (const raw of [value, cycle, { ['x'.repeat(4194305)]: null }, '\n'.repeat(3000000)])
    expect(() => fromDatabase(raw)).toThrow();
  expect(calls).toBe(0);
});
it('reports numeric compact bytes only and keeps no full old skeleton copy in the DB envelope', () => {
  const wire = encode(original());
  const db = toDatabase(wire);
  expect('skeleton' in db).toBe(false);
  expect('payload' in db.payload.preparation.skeleton).toBe(false);
  const logicalBytes = Buffer.byteLength(JSON.stringify(original()));
  const privateBytes = Buffer.byteLength(JSON.stringify(wire));
  const databaseBytes = Buffer.byteLength(JSON.stringify(db));
  expect(databaseBytes).toBeLessThan(logicalBytes);
  process.stdout.write(
    JSON.stringify({
      logicalBytes,
      privateBytes,
      databaseBytes,
      refs: db.payload.inventory.refs.length,
      pool: db.payload.preparation.sourcePool.length,
      slots: db.payload.preparation.substitutions.length,
    }) + '\n',
  );
});

it('validates each database conversion once and preserves structural out schemas', () => {
  const privateWire = encode(original());
  const db = toDatabase(privateWire);
  const spy = vi.spyOn(raceManualReviewMultiOwnedRetainedPayloadV3Schema, 'parse');
  try {
    expect(toDatabase(privateWire)).toEqual(db);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fromDatabase(db)).toEqual(privateWire);
    expect(spy).toHaveBeenCalledTimes(2);
    const first = decodeDatabase(db);
    expect(spy).toHaveBeenCalledTimes(3);
    if (first.state !== 'present') throw Error('FIXTURE_REQUIRED');
    first.payload.preparation.context.event.title = 'returned view mutation';
    const second = decodeDatabase(db);
    if (second.state !== 'present') throw Error('FIXTURE_REQUIRED');
    expect(second.payload).not.toEqual(first.payload);
    expect(spy).toHaveBeenCalledTimes(4);
    db.payload.preparation.logicalDigest = 'f'.repeat(64);
    expect(() => decodeDatabase(db)).toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(databaseSchema.out.shape.payload).toBeDefined();
});
it('reports numeric-only synthetic decoder timing without a timing pass threshold', () => {
  const preparation = foodFixture(Array.from({ length: 6001 }, (_, i) => (i % 2 ? '한글' : 'x'))).p;
  const logical = raceManualReviewMultiOwnedRetainedPayloadV3Schema.parse(
    retainMulti(retainedInput(preparation)),
  );
  const encoded = toDatabase(encode(logical));
  expect(decodeDatabase(encoded)).toEqual(logical);
  const started = performance.now();
  for (let index = 0; index < 3; index++) expect(decodeDatabase(encoded)).toEqual(logical);
  process.stdout.write(
    JSON.stringify({
      diagnostic: 'pooled_codec_invocation',
      iterations: 3,
      elapsedMs: performance.now() - started,
      logicalBytes: Buffer.byteLength(JSON.stringify(logical)),
      databaseBytes: Buffer.byteLength(JSON.stringify(encoded)),
      refs: encoded.payload.inventory.refs.length,
      pool: encoded.payload.preparation.sourcePool.length,
      slots: encoded.payload.preparation.substitutions.length,
    }) + '\n',
  );
});

import { encodeRaceManualReviewPooledDatabasePairV1 as combined } from '../src/race-manual-review-pooled-database-envelope-v1.js';
function presentOriginal() {
  const value = original();
  if (value.state !== 'present') throw Error('PRESENT_SYNTHETIC_FIXTURE_REQUIRED');
  return value;
}
const oldPipeline = (raw: unknown) => toDatabase(encode(raw));
it('combined unknown logical ingress equals public unknown-wire pipeline byte for byte', () => {
  const raw = presentOriginal(),
    before = JSON.stringify(raw),
    pair = combined(raw),
    old = oldPipeline(raw);
  expect(JSON.stringify(pair.wire)).toBe(JSON.stringify(old));
  expect(pair.logical).toEqual(raw);
  expect(decodeDatabase(pair.wire)).toEqual(raw);
  expect(JSON.stringify(raw)).toBe(before);
  expect(pair.wire.payload.currentAuthority).toEqual(old.payload.currentAuthority);
});
it('combined never accepts caller validation flags or malformed logical structure', () => {
  const raw = presentOriginal();
  for (const invalid of [
    null,
    [],
    { ...raw, validated: true },
    { ...raw, authority: 'trusted' },
    { ...raw, payload: null },
    { ...raw, minimalAudit: null },
    {
      ...raw,
      payload: {
        ...raw.payload,
        inventory: { ...raw.payload.inventory, refs: [] },
      },
    },
  ]) {
    expect(() => oldPipeline(invalid)).toThrow();
    expect(() => combined(invalid)).toThrow();
  }
});
it('combined bounds plain unknown ingress without executing accessors', () => {
  let getters = 0;
  const accessor = Object.defineProperty({}, 'state', {
    enumerable: true,
    get() {
      getters++;
      return 'present';
    },
  });
  const symbol = Object.assign({}, original(), { [Symbol('hidden')]: 'bad' });
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  const proto = Object.assign(Object.create({ inherited: true }), original());
  const nonEnumerable = Object.defineProperty({}, 'hidden', { value: 1 });
  const oversized = { ...original(), extra: '𐀀'.repeat(1048577) };
  for (const bad of [accessor, symbol, cycle, proto, nonEnumerable, oversized]) {
    expect(() => oldPipeline(bad)).toThrow();
    expect(() => combined(bad)).toThrow();
  }
  expect(getters).toBe(0);
});
it('combined does not accept encoded wire or database frame as logical bypass', () => {
  const raw = presentOriginal(),
    pooled = encode(raw),
    envelope = oldPipeline(raw);
  expect(() => combined(pooled)).toThrow();
  expect(() => combined(envelope)).toThrow();
});
it('combined is invocation local and rejects a mutated second input without reusing prior validation', () => {
  const raw = presentOriginal(),
    first = combined(raw),
    saved = JSON.stringify(first);
  const bad = {
    ...raw,
    payload: {
      ...raw.payload,
      inventory: { ...raw.payload.inventory, refs: [] },
    },
  };
  expect(() => combined(bad)).toThrow();
  expect(JSON.stringify(first)).toBe(saved);
  expect(JSON.stringify(combined(original()).wire)).toBe(JSON.stringify(first.wire));
});
it('unknown-wire APIs retain strict ordinal slot digest and overlap rejection after combined construction', () => {
  const wire = encode(original());
  const source = wire.sourcePool[0],
    slot = wire.substitutions[0];
  if (!source || !slot) throw Error('POOLED_SYNTHETIC_FIXTURE_REQUIRED');
  for (const bad of [
    {
      ...wire,
      sourcePool: wire.sourcePool.map((s, i) =>
        i === 0 ? { ...s, dtoDigest: 'f'.repeat(64) } : s,
      ),
    },
    { ...wire, substitutions: [...wire.substitutions, slot] },
    {
      ...wire,
      substitutions: wire.substitutions.map((s, i) =>
        i === 0 ? { ...s, sourceOrdinal: 5000 } : s,
      ),
    },
    { ...wire, logicalDigest: 'f'.repeat(64) },
  ])
    expect(() => toDatabase(bad)).toThrow();
});
