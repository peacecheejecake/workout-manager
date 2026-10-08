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

import { toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import {
  parseRaceManualPooledParentDeltaV1 as parse,
  raceManualPooledParentDeltaV1Schema,
} from '../src/race-manual-pooled-parent-delta-v1.js';
const base = toDatabase(encode(original()));
const result = {
  schemaVersion: 2,
  evidenceId: '00000000-0000-4000-8000-000000000101',
  decisionId: '00000000-0000-4000-8000-000000000102',
  proposalId: '00000000-0000-4000-8000-000000000103',
  candidateDigest: base.minimalAudit.candidateDigest,
  createdAt: now,
  applicable: false,
  approvalAllowed: false,
};
function response(delta: unknown = { kind: 'same' }, deltaNodes = 1) {
  return {
    readerVersion: 1,
    parentDeltaVersion: 1,
    schemaVersion: 2,
    result,
    payloadEncoding: 'pooled-database-envelope-v1',
    baseDigestMethod: 'postgres-jsonb-v1',
    baseSqlDigest: hash,
    parentDigestMethod: 'postgres-jsonb-v1',
    parentSqlDigest: hash,
    delta,
    deltaNodes,
    purgedAt: null,
    purgedEventId: null,
  };
}
function rootDelta() {
  const entries = Object.keys(base).map((key) => ({ key, node: { kind: 'same' } }));
  return { kind: 'object', entries };
}
it('same and literal reconstruct canonical old logical parent without retaining duplicated raw delta', () => {
  for (const delta of [{ kind: 'same' }, { kind: 'literal', value: base }]) {
    const value = parse(base, response(delta));
    expect(value?.payload).toEqual(original());
    expect(value).toMatchObject({
      bodyState: 'present',
      authority: 'none',
      sourceAuthentication: 'unverified',
      approvalAllowed: false,
    });
    expect(value).not.toHaveProperty('delta');
  }
});
it('exact-key object and same-position arrays preserve Unicode/null/zero/order', () => {
  const value = rootDelta();
  expect(parse(base, response(value, 1 + value.entries.length))?.payload).toEqual(original());
  const legacy = response({ kind: 'literal', value: original() });
  legacy.payloadEncoding = 'legacy-retained-v2';
  expect(parse(base, legacy)?.payload).toEqual(original());
  expect(parse(base, legacy)?.payload?.state).toBe('present');
});
it('purge is explicit unknown encoding and never reconstructed from fresh dictionary', () => {
  const purged = {
    ...response(),
    payloadEncoding: null,
    baseDigestMethod: null,
    baseSqlDigest: null,
    parentDigestMethod: null,
    parentSqlDigest: null,
    delta: null,
    deltaNodes: 0,
    purgedAt: now,
    purgedEventId: result.evidenceId,
  };
  expect(parse(base, purged)).toMatchObject({
    payload: null,
    bodyState: 'purged',
    payloadEncoding: null,
  });
  expect(parse(base, null)).toBeNull();
  expect(() => parse(base, { ...purged, payloadEncoding: 'legacy-retained-v2' })).toThrow();
  expect(() => parse(base, { ...purged, delta: { kind: 'same' } })).toThrow();
});
it('rejects unknown wire keys/method namespaces/count/schema/candidate-digest drift', () => {
  for (const changed of [
    { ...response(), extra: true },
    { ...response(), baseDigestMethod: 'node-canonical-v2' },
    { ...response(), deltaNodes: 2 },
    { ...response(), schemaVersion: 3 },
    { ...response(), result: { ...result, candidateDigest: '2'.repeat(64) } },
    { ...response(), payloadEncoding: 'unknown' },
  ])
    expect(() => parse(base, changed)).toThrow();
});
it('rejects missing/extra/duplicate key roster, wrong type and array length instead of partial apply', () => {
  const delta = rootDelta();
  for (const entries of [
    delta.entries.slice(1),
    [...delta.entries, delta.entries[0]],
    [...delta.entries, { key: 'unknown', node: { kind: 'same' } }],
  ])
    expect(() => parse(base, response({ kind: 'object', entries }, entries.length + 1))).toThrow();
  expect(() => parse(base, response({ kind: 'array', items: [] }))).toThrow();
  expect(() =>
    parse(
      base,
      response({ kind: 'object', entries: [{ key: '__proto__', node: { kind: 'same' } }] }, 2),
    ),
  ).toThrow();
});
it('reconstructed unknown/missing/null markers and source tuple or digest tamper fail original full codec', () => {
  for (const change of [
    (x: ReturnType<typeof toDatabase>) => {
      Object.assign(x, { extra: 1 });
    },
    (x: ReturnType<typeof toDatabase>) => {
      x.payload.inventory.refs.reverse();
    },
    (x: ReturnType<typeof toDatabase>) => {
      x.payload.preparation.logicalDigest = '3'.repeat(64);
    },
    (x: ReturnType<typeof toDatabase>) => {
      x.minimalAudit.candidateDigest = '4'.repeat(64);
    },
  ]) {
    const value = structuredClone(base);
    change(value);
    expect(() => parse(base, response({ kind: 'literal', value }))).toThrow();
  }
  expect(() => parse(base, response({ kind: 'literal', value: null }))).toThrow();
});
it('bounds unknown base/response before schema inspection without invoking accessors', () => {
  let reads = 0;
  const getter = Object.defineProperty({}, 'delta', {
    enumerable: true,
    get() {
      reads++;
      return { kind: 'same' };
    },
  });
  expect(() => parse(base, getter)).toThrow();
  expect(reads).toBe(0);
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  expect(() => parse(base, cycle)).toThrow();
  expect(() =>
    parse(base, { ...response(), delta: { kind: 'literal', value: '𐀀'.repeat(1048577) } }),
  ).toThrow();
  expect(() =>
    parse(base, { ...response(), delta: { kind: 'literal', value: '\n'.repeat(2097153) } }),
  ).toThrow();
  expect(() => parse({ ...base, [Symbol('private')]: 1 }, response())).toThrow();
  expect(() => parse(Object.create(base), response())).toThrow();
});
it('public-first imports preserve lazy result binding and strict wire remains no-authority', async () => {
  const publicModule = await import('../src/race-manual-public.js');
  expect(publicModule.createRaceManualPublicRepository).toBeTypeOf('function');
  expect(raceManualPooledParentDeltaV1Schema.safeParse(response()).success).toBe(true);
  expect(() => parse(base, { ...response(), result: { ...result, applicable: true } })).toThrow();
});

function branchPath(
  value: unknown,
  keys: string[],
  leaf: unknown,
): { node: unknown; count: number } {
  const key = keys[0];
  if (key === undefined) return { node: leaf, count: 1 };
  const record = z.record(z.string(), z.json()).parse(value);
  let count = 1;
  const entries = Object.keys(record).map((k) => {
    if (k === key) {
      const child = branchPath(record[k], keys.slice(1), leaf);
      count += child.count;
      return { key: k, node: child.node };
    }
    count++;
    return { key: k, node: { kind: 'same' } };
  });
  return { node: { kind: 'object', entries }, count };
}
it('preflights combined exact escaped expansion before cloning any over4MiB target subtree', () => {
  const large = 'x'.repeat(4194304 - 4096);
  const descriptor = branchPath(base, ['payload', 'sqlObservations'], {
    kind: 'literal',
    value: large,
  });
  const wire = response(descriptor.node, descriptor.count);
  expect(Buffer.byteLength(JSON.stringify(base), 'utf8')).toBeLessThanOrEqual(4194304);
  expect(Buffer.byteLength(JSON.stringify(wire), 'utf8')).toBeLessThanOrEqual(4194304);
  expect(() => parse(base, wire)).toThrow('POOLED_PARENT_DELTA_BOUND');
});
it('same-position array descriptors preserve pool order and reject missing/extra entries', () => {
  const leaf = {
    kind: 'array',
    items: base.payload.preparation.sourcePool.map(() => ({ kind: 'same' })),
  };
  const descriptor = branchPath(base, ['payload', 'preparation', 'sourcePool'], leaf);
  expect(
    parse(base, response(descriptor.node, descriptor.count + leaf.items.length))?.payload,
  ).toEqual(original());
  const wrong = branchPath(base, ['payload', 'preparation', 'sourcePool'], {
    kind: 'array',
    items: [],
  });
  expect(() => parse(base, response(wrong.node, wrong.count))).toThrow();
});
it('node quota is rejected before recursive schema parsing even with bounded JSON wire', () => {
  const value = { kind: 'array', items: Array.from({ length: 5000 }, () => ({ kind: 'same' })) };
  expect(() => parse(base, response(value, 5000))).toThrow();
});
