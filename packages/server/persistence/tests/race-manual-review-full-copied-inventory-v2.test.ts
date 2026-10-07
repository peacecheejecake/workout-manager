import { nutritionPlanVersionV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  routineTemplateVersionSchema,
  supplementaryExerciseVersionSchema,
} from '@workout/contracts/supplementary-core';
import { manualActivityCreateSchema } from '@workout/contracts/activity';
import { activeIntakeEntrySchema } from '@workout/contracts/nutrition-core';
import { routineRunSchema } from '@workout/contracts/routines';
import { courseRevisionSchema } from '@workout/contracts/courses';
import { courseContentDigest } from '@workout/server-courses/digest';
import { projectManualActivityReadFacts } from '../src/race-plan-impact-manual-activity-read-facts.js';
import { createHash } from 'node:crypto';
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
import { privateTextResourceVersionSchema } from '@workout/contracts/resources';
import { galleryMediaItemSchema } from '@workout/contracts/gallery';
import { recoveryMethodVersionSchema } from '@workout/contracts/recovery-core';
import { assembleRaceManualReviewCandidateCompatibleV4 } from '@workout/server-coaching/race-manual-review-candidate-v2';
import type { manualActivityReadFactsSchema } from '../src/race-plan-impact-manual-activity-read-facts.js';
import type { manualIntakeReadFactsSchema } from '../src/race-plan-impact-intake-read-facts.js';
import { courseReadManifestSchema } from '../src/race-plan-impact-course-manifest.js';
import { raceMediaCleanupSourceSchema } from '../src/race-media-cleanup-source.js';
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
import {
  enumerateRaceManualReviewFullCopiedSourcesV2 as enumerate,
  raceManualReviewFullCopiedInventoryV2Schema,
} from '../src/race-manual-review-full-copied-inventory-v2.js';
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
function mapped(value: ReturnType<typeof input>) {
  const result = enumerate(value);
  // Test-only path dereference: verifies the handler's declared physical copy,
  // never discovers identities or grants production source authority.
  for (const ref of result.refs)
    for (const path of ref.copiedLocations) {
      let body: unknown = value;
      for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.'))
        body = /^\d+$/.test(key)
          ? z.array(z.unknown()).parse(body)[Number(key)]
          : z.record(z.string(), z.unknown()).parse(body)[key];
      expect(digest(body), path).toBe(ref.dtoDigest);
    }
  expect(result.blockers).toEqual([]);
  expect(result.inventoryState).toBe('mapped');
  expect(result).toMatchObject({
    allCopiedBodiesIndexed: true,
    sqlRowDigest: 'not_captured',
    sourceAuthentication: 'unverified',
    lifecycleAuthority: 'none',
    storage: 'not_persisted',
    approvalAllowed: false,
    admissionAllowed: false,
  });
  return result;
}
it('indexes C/S/B exact source copies and preserves readonly uncertainty', () => {
  const v = input(),
    before = structuredClone(v),
    r = mapped(v);
  expect(r.refs).toHaveLength(1);
  expect(r.refs[0]?.identity).toEqual({ kind: 'race-event', sourceId: race, revision: 1 });
  expect(r.refs[0]?.copiedLocations).toEqual(
    expect.arrayContaining([
      'context.event',
      'context.consumedSources.races[0]',
      'sourceInput.projectionInput.event',
      'candidate.body.projectionInput.event',
    ]),
  );
  expect(v).toEqual(before);
});
it.each(['context', 'sourceInput', 'candidate'] as const)(
  'rejects %s correspondence tampering without source authority',
  (field) => {
    const v = structuredClone(input());
    if (field === 'context') v.context.event.title = 'different';
    else if (field === 'sourceInput') v.sourceInput.binding.readSetDigest = '2'.repeat(64);
    else v.candidate.body.binding.appRevision = 2;
    expect(enumerate(v).inventoryState).toBe('blocked');
  },
);
it('rejects a freshly recomputed context digest whose source bodies disagree with S/B', () => {
  const v = input();
  v.context.event.title = 'changed';
  const { status, coverage, readSetDigest, affected, ...set } = v.context;
  void status;
  void coverage;
  void readSetDigest;
  void affected;
  v.context.readSetDigest = digest({
    ...set,
    coreDependencies: { ...v.context.coreDependencies, capturedAt: null },
  });
  expect(enumerate(v).inventoryState).toBe('blocked');
});
const resourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function resource() {
  const text = ' retained 零 0';
  return privateTextResourceVersionSchema.parse({
    schemaVersion: 1,
    id: versionId,
    resourceId,
    version: 1,
    previousVersionId: null,
    contentHash: createHash('sha256').update(text).digest('hex'),
    source: { kind: 'text', text },
    paragraphs: [
      {
        locator: {
          kind: 'paragraph',
          resourceVersionId: versionId,
          index: 0,
          startOffset: 0,
          endOffset: text.length,
          offsetUnit: 'utf16_code_unit',
        },
        text,
      },
    ],
    lifecycle: { contentStatus: 'parsed', indexStatus: 'not_indexed' },
    createdAt: now,
  });
}
it('indexes exact historical text while current access observation stays distinct', () => {
  const record = resource(),
    r = mapped(
      input((c) => {
        c.resourceReadFacts = {
          requestedVersionIds: [versionId],
          facts: [
            {
              requestedVersionId: versionId,
              state: 'historical',
              reason: null,
              record,
              current: {
                resourceId,
                versionId: generation,
                version: 2,
                accessRevision: 5,
                deleted: false,
              },
            },
          ],
          authority: 'none',
          freshness: 'not_checked',
        };
      }),
    );
  expect(r.refs.find((r) => r.identity.kind === 'resource-text-version')?.identity).toEqual({
    kind: 'resource-text-version',
    sourceId: resourceId,
    versionId,
  });
  expect(JSON.stringify(r)).not.toContain(record.source.text);
});
it('deleted and unavailable source diagnostics are contentless, without invented parent refs', () => {
  const r = mapped(
    input((c) => {
      c.resourceReadFacts = {
        requestedVersionIds: [versionId, 'opaque-long'],
        facts: [
          {
            requestedVersionId: versionId,
            state: 'deleted',
            reason: null,
            record: null,
            current: { resourceId, versionId, version: 1, accessRevision: 2, deleted: true },
          },
          {
            requestedVersionId: 'opaque-long',
            state: 'unavailable',
            reason: 'owned_version_unavailable',
            record: null,
            current: null,
          },
        ],
        authority: 'none',
        freshness: 'not_checked',
      };
    }),
  );
  expect(r.refs.some((r) => r.identity.kind === 'resource-text-version')).toBe(false);
  expect(r.diagnostics.map((d) => d.state)).toEqual(
    expect.arrayContaining(['deleted', 'unavailable']),
  );
});
it('text hash/paragraph/current tuple contradiction blocks mapped success', () => {
  const v = input((c) => {
    const record = resource();
    record.contentHash = '2'.repeat(64);
    c.resourceReadFacts = {
      requestedVersionIds: [versionId],
      facts: [
        {
          requestedVersionId: versionId,
          state: 'current',
          reason: null,
          record,
          current: { resourceId, versionId, version: 1, accessRevision: 1, deleted: false },
        },
      ],
      authority: 'none',
      freshness: 'not_checked',
    };
  });
  expect(enumerate(v).blockers).toContainEqual({
    location: 'context.resourceReadFacts',
    reason: 'source_tuple_mismatch',
  });
});
it('indexes recovery exact method body and keeps user-recorded unreviewed provenance', () => {
  const method = recoveryMethodVersionSchema.parse({
    schemaVersion: 1,
    methodId: resourceId,
    versionId,
    version: 1,
    title: 'Synthetic method',
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
  const r = mapped(
    input((c) => {
      c.recoverySources = {
        methodCatalogRequests: [{ kind: 'recovery_method', ref: { id: resourceId, versionId } }],
        methods: [method],
        methodFacts: [
          {
            requested: { kind: 'recovery_method', ref: { id: resourceId, versionId } },
            state: 'historical',
            reason: null,
            content: { digest: digest(method) },
            currentHead: { aggregate_id: resourceId, version_id: generation },
            provenance: { source: 'user_recorded', reviewState: 'unreviewed', reviewedAt: null },
          },
        ],
        trainingAssociations: [],
        nutritionReferences: [],
        unavailable: [],
        authority: 'none',
        freshness: 'not_checked',
      };
    }),
  );
  expect(r.refs.some((r) => r.identity.kind === 'recovery-method-version')).toBe(true);
});
it('food parent opaque ID is preserved with exact immutable version/body digest', () => {
  const datum = (unit: string) => ({ value: null, unit, status: 'unknown', evidenceIds: [] });
  const food = foodDefinitionVersionSchema.parse({
    foodId: 'food-食"0',
    versionId,
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
      reference: 'Self',
      capturedAt: now,
      reviewState: 'unreviewed',
    },
  });
  const provenance = {
    kind: food.provenance.kind,
    reference: { state: 'present' as const, digest: digest(food.provenance.reference) },
    capturedAt: now,
    reviewState: food.provenance.reviewState,
  };
  const r = mapped(
    input((c) => {
      c.sourcePermissionManifest.nestedNutritionSources = [
        {
          versionId: generation,
          foods: [
            {
              requestedVersionId: versionId,
              state: 'historical',
              content: {
                foodId: food.foodId,
                versionId,
                record: food,
                digest: digest(food),
                provenance,
              },
              currentHead: { state: 'absent' },
            },
          ],
          anchors: [],
          linkedPlan: { state: 'absent' },
        },
      ];
    }),
  );
  expect(r.refs.find((r) => r.identity.kind === 'food-definition-version')?.identity).toEqual({
    kind: 'food-definition-version',
    sourceId: food.foodId,
    versionId,
  });
});
it('media descriptor/ledger/cleanup are mutable observations, not immutable approval pins', () => {
  const record = galleryMediaItemSchema.parse({
    id: resourceId,
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
    mediaItemId: resourceId,
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
  const r = mapped(
    input((c) => {
      c.mediaReadFacts = {
        requestedIds: [resourceId],
        facts: [
          {
            requestedId: resourceId,
            state: 'owned',
            reason: null,
            record,
            current: { mediaItemId: resourceId, accessRevision: 1, deleted: false },
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
    }),
  );
  expect(r.refs.find((r) => r.identity.kind === 'gallery-descriptor')?.representation).toBe(
    'mutable_observation',
  );
});
it('metadata JSON channels reject unknown body payloads instead of whitelisting them', () => {
  const r = enumerate(
    input((c) => {
      c.sourcePermissionManifest.resources = [
        {
          requestedVersionId: versionId,
          state: 'unavailable',
          content: null,
          reason: 'owned_version_unavailable',
          current: null,
          body: { private: 'unindexable' },
        },
      ];
    }),
  );
  expect(r.blockers).toContainEqual({
    location: 'context.sourcePermissionManifest.resources[0]',
    reason: 'unindexable_body',
  });
});
it('duplicate source copies are charged before deduplication', () => {
  const v = input((c) => {
    c.consumedSources.races = Array.from({ length: 4999 }, () => structuredClone(c.event));
  });
  const r = enumerate(v);
  expect(r.inventoryState).toBe('blocked');
  expect(r.blockers.some((b) => b.reason === 'reference_bound')).toBe(true);
});
it.each([null, [], { unknown: 1 }])('rejects invalid ingress %j', (v) => {
  expect(enumerate(v)).toMatchObject({ inventoryState: 'blocked', allCopiedBodiesIndexed: false });
});
it('rejects getters/cycles/sparse arrays and oversized/overdeep envelopes before reading', () => {
  let read = false;
  const getter = Object.defineProperty({}, 'context', {
    enumerable: true,
    get() {
      read = true;
      return {};
    },
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = { deep };
  for (const v of [getter, cycle, new Array(2), { text: 'x'.repeat(4194305) }, deep])
    expect(enumerate(v).inventoryState).toBe('blocked');
  expect(read).toBe(false);
});
it('strict output rejects authority escalation, duplicate identities and mismatched mapped status', () => {
  const r = mapped(input());
  expect(
    raceManualReviewFullCopiedInventoryV2Schema.safeParse({ ...r, approvalAllowed: true }).success,
  ).toBe(false);
  expect(
    raceManualReviewFullCopiedInventoryV2Schema.safeParse({ ...r, allCopiedBodiesIndexed: false })
      .success,
  ).toBe(false);
  expect(
    raceManualReviewFullCopiedInventoryV2Schema.safeParse({ ...r, refs: [...r.refs, ...r.refs] })
      .success,
  ).toBe(false);
});
function withCourseRead() {
  const c = raceImpactConsumedCaptureSchema.parse(fixture());
  const courseId = 'aaaaaaaa-0000-4000-8000-000000000031';
  const revisionId = 'bbbbbbbb-0000-4000-8000-000000000032';
  const ref = { courseId, courseRevision: 1, revisionId };
  const record = courseRevisionSchema.parse({
    ...ref,
    name: 'Synthetic imported course',
    geometry: {
      type: 'LineString',
      coordinates: [
        [127, 37],
        [127.01, 37.01],
      ],
    },
    waypoints: [
      { role: 'start', position: [127, 37], name: null, sourceSampleId: null, locked: false },
      {
        role: 'finish',
        position: [127.01, 37.01],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
    ],
    generation: {
      kind: 'imported-file',
      format: 'gpx',
      sourceKind: 'gpx-rte',
      itemIndex: 0,
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      fileSha256: hash,
      fileByteLength: 320,
      originalFilename: null,
      fileCreator: null,
      vertexCount: 2,
      importedWaypointCount: 0,
      ignoredFileWaypointCount: 0,
    },
    edit: { kind: 'imported' },
    lineage: [],
    distanceMeters: 0,
    contentDigest: hash,
    createdAt: now,
  });
  record.contentDigest = courseContentDigest({
    ...record,
    coordinates: record.geometry.coordinates,
  });
  c.event.course = ref;
  c.course = courseReadManifestSchema.parse({
    ref,
    digest: record.contentDigest,
    owned: {
      athleteId: athlete,
      head: {
        status: 'available',
        courseId,
        name: record.name,
        visibility: 'private',
        headRevision: 1,
        revisionId,
        createdAt: now,
        updatedAt: now,
      },
      revision: record,
      deletion: absent(),
    },
    lineageSources: [],
  });
  return c;
}

it('indexes immutable course geometry and separate mutable head; no geometry copied into output', () => {
  const c = withCourseRead();
  const r = mapped(
    input((row) => {
      row.event = c.event;
      row.course = c.course;
      row.consumedSources.races = [c.event];
    }),
  );
  expect(r.refs.some((ref) => ref.identity.kind === 'course-revision')).toBe(true);
  expect(r.refs.find((ref) => ref.identity.kind === 'course-head-descriptor')?.representation).toBe(
    'mutable_observation',
  );
  expect(JSON.stringify(r)).not.toContain('coordinates');
});
function withRun(
  c: z.infer<typeof raceImpactConsumedCaptureSchema>,
  kind: 'intake' | 'activity' | 'checklist_confirmation' = 'checklist_confirmation',
) {
  const ref =
    kind === 'activity'
      ? { kind: 'activity' as const, id: race, revisionId: '1', detailId: null, allocationId: null }
      : kind === 'intake'
        ? { kind: 'intake' as const, id: 'intake-食', revisionId: versionId }
        : { kind: 'checklist_confirmation' as const, id: resourceId, revisionId: versionId };
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: resourceId,
    versionId,
    title: 'Actual source',
    intent: 'User',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Step',
        content:
          kind === 'checklist_confirmation'
            ? { kind: 'checklist', prompt: 'Review' }
            : kind === 'intake'
              ? { kind: 'nutrition_template', ref: { id: resourceId, versionId } }
              : { kind: 'workout_template', ref: { id: resourceId, versionId } },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: now,
  });
  c.routineActualManifest.blueprints = [
    {
      record: blueprint,
      version: 1,
      currentHead: {
        state: 'present',
        versionId,
        version: 1,
        visibility: 'active',
        favorite: false,
      },
      unsupportedContent: [],
    },
  ];
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: race,
    versionId: generation,
    blueprint: { id: resourceId, versionId },
    window: {
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'UTC',
      maxOccurrences: 1,
    },
    rule: { kind: 'dates', dates: ['2026-10-07'], localTime: null },
    state: 'active',
  });
  c.routineActualManifest.schedules = [
    {
      scheduleId: schedule.id,
      versionId: schedule.versionId,
      sourcePlanVersionId: null,
      record: schedule,
      currentHead: { state: 'present', versionId: schedule.versionId, notificationMuted: false },
    },
  ];
  c.routines = [
    {
      aggregateId: schedule.id,
      versionId: schedule.versionId,
      record: schedule,
      sourceVersionId: null,
      sourceRelation: 'absent',
      affected: false,
    },
  ];
  c.rosters.routine = [{ aggregateId: schedule.id, versionId: schedule.versionId }];
  const run = routineRunSchema.parse({
    id: generation,
    revision: 1,
    blueprint: { id: resourceId, versionId },
    origin: { kind: 'unplanned' },
    state: 'in_progress',
    progress: [
      {
        stepId: 'step',
        revision: 1,
        state: 'performed',
        actualRefs: [ref],
        occurredAt: now,
        recordedAt: now,
        reason: null,
      },
    ],
    selectedChoices: {},
    startedAt: now,
    endedAt: null,
  });
  c.routineActualManifest.runs = [{ record: run, historyDigest: digest(run), actuals: [] }];
  return { run, ref };
}
it('indexes checklist immutable actual tuple and timer mutable descriptor/run copy', () => {
  const r = mapped(
    input((c) => {
      const { run, ref } = withRun(c);
      if (ref.kind !== 'checklist_confirmation') throw Error('fixture');
      c.routineActualManifest.runs[0]?.actuals.push({
        stepId: 'step',
        fact: {
          requested: ref,
          state: 'current',
          reason: null,
          current: { id: resourceId, revisionId: versionId },
          content: {
            id: resourceId,
            run_id: run.id,
            step_id: 'step',
            revision_id: versionId,
            occurred_at: now,
            state: 'performed',
          },
        },
      });
      c.routineTimerReads = [
        {
          run,
          timers: [
            {
              runId: run.id,
              stepId: 'step',
              revision: 1,
              state: 'running',
              durationSeconds: 30,
              startedAt: now,
              pausedAt: null,
              pausedMilliseconds: 0,
            },
          ],
        },
      ];
    }),
  );
  expect(r.refs.some((r) => r.identity.kind === 'checklist-confirmation')).toBe(true);
  expect(r.refs.find((r) => r.identity.kind === 'routine-timer')?.representation).toBe(
    'mutable_observation',
  );
  expect(r.refs.find((r) => r.identity.kind === 'routine-run')?.copiedLocations).toHaveLength(5);
});
it('indexes exact manual intake body twice, preserving zero and unknown', () => {
  const r = mapped(
    input((c) => {
      const { ref } = withRun(c, 'intake');
      if (ref.kind !== 'intake') throw Error('fixture');
      const datum = (unit: string, value: number | null) => ({
        unit,
        value,
        status: value === null ? 'unknown' : 'reported',
        evidenceIds: [],
      });
      const content = activeIntakeEntrySchema.parse({
        intakeId: ref.id,
        revisionId: ref.revisionId,
        revision: 1,
        status: 'active',
        occurredAt: now,
        recordedAt: now,
        timezone: 'UTC',
        foods: [
          {
            foodVersionId: null,
            description: 'Zero',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
        ],
        nutrientTotal: {
          energy: datum('kcal', 0),
          carbohydrate: datum('g', null),
          protein: datum('g', null),
          fat: datum('g', null),
          fluid: datum('mL', null),
          sodium: datum('mg', null),
        },
        nutrientValueCoverage: 'partial',
        plannedItemId: null,
        relatedSessionIds: [],
        relatedActivityIds: [],
        source: 'user',
        sourceRecordId: null,
        notes: null,
      });
      const current = {
        id: ref.id,
        revision: 1,
        revisionId: ref.revisionId,
        status: 'active' as const,
      };
      const fact = { requested: ref, state: 'current' as const, reason: null, current, content };
      c.routineActualManifest.runs[0]?.actuals.push({ stepId: 'step', fact });
      c.manualIntakeReadFacts = {
        purpose: 'retained_manual_intake_read',
        athleteId: athlete,
        facts: [
          {
            ...fact,
            current: { ...current, contentDigest: digest(content) },
            contentDigest: digest(content),
          },
        ],
        authority: 'none',
        freshness: 'not_checked',
      };
    }),
  );
  expect(r.refs.find((r) => r.identity.kind === 'intake-revision')?.copiedLocations).toHaveLength(
    2,
  );
});
it.each([false, true])(
  'manual Activity source correspondence and deleted contentless state %s',
  (deleted) => {
    const r = mapped(
      input((c) => {
        const { ref } = withRun(c, 'activity');
        if (ref.kind !== 'activity') throw Error('fixture');
        const original = manualActivityCreateSchema.shape.activity.parse({
          title: 'Synthetic manual',
          kind: 'unknown',
          startedAt: now,
          durationSeconds: 0,
          durationKind: 'unknown',
          timezone: 'UTC',
          distanceMeters: null,
        });
        const current = { id: race, revision: deleted ? 2 : 1, deleted },
          content = deleted ? null : { original, overlay: null, detail: null };
        const fact = {
          requested: ref,
          state: deleted ? ('deleted' as const) : ('current' as const),
          reason: null,
          current,
          content,
        };
        const roster = {
          ...current,
          originalDigest: digest(original),
          overlayDigest: digest(null),
          source: {
            state: 'present' as const,
            kind: 'manual' as const,
            sourceId: 'manual-source',
            sourceRevision: 1,
            contentHash: createHash('sha256').update(JSON.stringify(original)).digest('hex'),
          },
        };
        const metadata = {
          ...current,
          overlay: { state: 'absent' as const, revision: null },
          source: {
            state: 'present' as const,
            kind: 'manual' as const,
            sourceId: 'manual-source',
            revision: 1,
            contentHash: roster.source.contentHash,
            suppressed: deleted,
            revisionRecord: { state: 'present' as const },
          },
        };
        c.routineActualManifest.runs[0]?.actuals.push({ stepId: 'step', fact });
        c.routineActualManifest.actualRosters.activities = [roster];
        c.sourcePermissionManifest.activityMediaPermissions.activities = [metadata];
        const p = projectManualActivityReadFacts({
          athleteId: athlete,
          refs: [ref],
          actualFacts: [fact],
          activityRosters: [roster],
          activityMetadata: [metadata],
        });
        if (p.status !== 'projected_retained_read_facts') throw Error('fixture');
        c.manualActivityReadFacts = p.facts;
      }),
    );
    expect(r.refs.some((r) => r.identity.kind === 'manual-activity-source')).toBe(!deleted);
    if (deleted) expect(r.diagnostics.some((d) => d.state === 'deleted')).toBe(true);
  },
);

it('indexes full workout/exercise catalogs and embedded session spec with exact namespace', () => {
  const count = {
    target: { min: 8, max: 10, unit: 'count', basis: 'user_confirmed', evidenceIds: [] },
    definition: { kind: 'repetitions', basis: 'per_side', definitionId: 'rep-per-side-v1' },
  };
  const set = {
    id: 'set',
    exerciseVersionId: versionId,
    side: 'left',
    count,
    durationSeconds: null,
    externalResistance: { kind: 'no_added_load' },
    restAfterSeconds: 60,
    tempo: null,
    effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
  };
  const spec = {
    schemaVersion: 2,
    kind: 'supplementary',
    routineVersionId: generation,
    blocks: [
      { id: 'block', mode: 'single', rounds: 1, sets: [set], restBetweenRoundsSeconds: null },
    ],
  };
  const record = routineTemplateVersionSchema.parse({
    schemaVersion: 2,
    routineId: resourceId,
    versionId: generation,
    title: 'Template',
    purpose: 'Own',
    requiredEquipment: ['bodyweight'],
    spec,
    createdAt: now,
  });
  const exercise = supplementaryExerciseVersionSchema.parse({
    schemaVersion: 2,
    exerciseId: resourceId,
    versionId,
    name: 'Synthetic balance',
    family: 'balance_stability',
    equipment: ['bodyweight'],
    tags: [],
    countDefinitions: [count.definition],
    mediaAssetIds: [],
    resourceVersionIds: [],
    reviewState: 'unreviewed',
    description: 'Own',
    safetyNotes: '',
    supportedMetrics: ['count', 'duration', 'effort'],
    createdAt: now,
  });
  const r = mapped(
    input((c) => {
      c.workoutTemplateSources = {
        requests: [{ kind: 'workout_template', ref: { id: resourceId, versionId: generation } }],
        templates: [record],
        templateFacts: [
          {
            requested: { kind: 'workout_template', ref: { id: resourceId, versionId: generation } },
            state: 'current',
            reason: null,
            content: { digest: digest(record) },
            currentHead: { aggregate_id: resourceId, version_id: generation, version: 1 },
          },
        ],
        exercises: [{ record: exercise, version: 1 }],
        exerciseFacts: [
          {
            requestedVersionId: versionId,
            state: 'historical',
            reason: null,
            content: { exerciseId: resourceId, versionId, digest: digest(exercise) },
            currentHead: null,
          },
        ],
        targets: [
          {
            routineVersionId: generation,
            blockId: 'block',
            setId: 'set',
            exerciseVersionId: versionId,
          },
        ],
        authority: 'none',
        freshness: 'not_checked',
      };
      c.supplementaryManifest.copies = [
        {
          link: supplementarySessionLinkSchema.parse({
            schemaVersion: 2,
            planVersionId: generation,
            plannedSessionId: 's-食',
            content: { kind: 'embedded', spec: { ...spec, routineVersionId: null } },
          }),
          targetSource: 'session_copy',
          contentDigest: digest({ ...spec, routineVersionId: null }),
          targets: [{ block_id: 'block', target_set_id: 'set', exercise_version_id: versionId }],
        },
      ];
    }),
  );
  expect(r.refs.map((r) => r.identity.kind)).toEqual(
    expect.arrayContaining([
      'workout-template-version',
      'supplementary-exercise-version',
      'supplementary-session-copy',
    ]),
  );
  expect(r.refs.find((r) => r.identity.kind === 'supplementary-session-copy')?.representation).toBe(
    'source_fragment',
  );
});
it('same immutable identity with different copied body is blocked, not latest selected', () => {
  const v = input();
  v.context.consumedSources.races.push({ ...v.context.event, title: 'conflicting' });
  expect(enumerate(v).inventoryState).toBe('blocked');
});

it.each(['current', 'historical'] as const)(
  'indexes actual numeric checkin revision namespace %s',
  (state) => {
    const r = mapped(
      input((c) => {
        const { run } = withRun(c);
        const requested = { kind: 'checkin' as const, id: resourceId, revisionId: '1' };
        const record = routineRunSchema.parse({
          ...run,
          progress: [
            {
              stepId: 'step',
              revision: 1,
              state: 'performed',
              actualRefs: [requested],
              occurredAt: now,
              recordedAt: now,
              reason: null,
            },
          ],
        });
        c.routineActualManifest.runs = [
          {
            record,
            historyDigest: digest(record),
            actuals: [
              {
                stepId: 'step',
                fact: {
                  requested,
                  state,
                  reason: null,
                  current: {
                    id: resourceId,
                    revision: state === 'current' ? 1 : 2,
                    deleted: false,
                  },
                  content: {
                    observedAt: now,
                    timezone: 'UTC',
                    fatigue: 0,
                    discomfort: null,
                    bodyLocation: null,
                    note: null,
                  },
                },
              },
            ],
          },
        ];
      }),
    );
    expect(r.refs.find((r) => r.identity.kind === 'checkin-revision')?.identity).toEqual({
      kind: 'checkin-revision',
      sourceId: resourceId,
      revision: 1,
    });
  },
);

it('V4 multipin full copies keep two immutable fragment revisions, only current full race body', () => {
  const v = input((c) => {
    c.event = { ...c.event, revision: 2, localStartTime: '09:00:00', timezone: 'UTC' };
    c.consumedSources.races = [c.event];
    const pin = (eventRevision: number, time: string) => ({
      pinVersion: 1,
      namespace: 'race-event-revision',
      eventId: race,
      eventRevision,
      sourceDigestVersion: 'race-event-values-canonical-v1',
      sourceDigest: hash,
      localDate: '2026-10-07',
      localStartTime: time,
      timezone: 'UTC',
      start: { state: 'known', instant: `2026-10-07T${time}Z` },
      end: { state: 'unknown', reason: 'race_end_not_recorded' },
    });
    const record = nutritionPlanVersionV4Schema.parse({
      schemaVersion: 4,
      planId: resourceId,
      versionId,
      version: 1,
      previousVersionId: null,
      approvedAt: now,
      approvalId: generation,
      period: { from: '2026-10-07', toInclusive: '2026-10-09' },
      timezone: 'UTC',
      purpose: 'Own',
      linkedTrainingPlanVersionId: null,
      items: ['old', 'new'].map((id) => ({
        id,
        planVersionId: versionId,
        category: 'before',
        title: id,
        anchor: {
          kind: 'relative',
          entity: 'race',
          entityId: race,
          point: 'start',
          offsetMinutes: 0,
        },
        foods: [],
        targets: [],
        instructions: 'Own',
        evidenceIds: [],
        source: 'user_confirmed',
      })),
      raceTimingPins: [pin(1, '07:00:00'), pin(2, '09:00:00')],
      itemRaceTimingBindings: [
        { itemId: 'new', binding: { state: 'captured', eventId: race, eventRevision: 2 } },
        { itemId: 'old', binding: { state: 'captured', eventId: race, eventRevision: 1 } },
      ],
    });
    c.nutrition = [
      { aggregateId: resourceId, versionId, record, sourceRelation: 'absent', relativeItems: [] },
    ];
    c.rosters.nutrition = [{ aggregateId: resourceId, versionId }];
  });
  const r = mapped(v);
  expect(r.refs.filter((r) => r.identity.kind === 'race-event').map((r) => r.identity)).toEqual([
    { kind: 'race-event', sourceId: race, revision: 2 },
  ]);
  expect(
    r.refs.filter((r) => r.identity.kind === 'race-timing-pin-fragment').map((r) => r.identity),
  ).toEqual([
    { kind: 'race-timing-pin-fragment', sourceId: race, revision: 1 },
    { kind: 'race-timing-pin-fragment', sourceId: race, revision: 2 },
  ]);
  expect(v.candidate.body.projection.nutrition[0]?.items.map((i) => i.before)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ localTime: '07:00:00' }),
      expect.objectContaining({ localTime: '09:00:00' }),
    ]),
  );
});

it.each(['fit', 'fixture', 'healthkit'] as const)(
  'indexes current %s canonical Activity values as mutable observation only',
  (kind) => {
    const envelope = input((c) => {
      const { ref } = withRun(c, 'activity');
      if (ref.kind !== 'activity') throw Error('fixture');
      const original = manualActivityCreateSchema.shape.activity.parse({
        title: 'Synthetic canonical',
        kind: 'unknown',
        startedAt: now,
        durationSeconds: 0,
        durationKind: 'unknown',
        timezone: 'UTC',
        distanceMeters: null,
      });
      const head = { id: ref.id, revision: 1, deleted: false };
      c.routineActualManifest.runs[0]?.actuals.push({
        stepId: 'step',
        fact: {
          requested: ref,
          state: 'current',
          reason: null,
          current: head,
          content: { original, overlay: null, detail: null },
        },
      });
      c.routineActualManifest.actualRosters.activities = [
        {
          ...head,
          originalDigest: digest(original),
          overlayDigest: digest(null),
          source: {
            state: 'present',
            kind,
            sourceId: kind === 'healthkit' ? generation : 'opaque-source',
            sourceRevision: 1,
            contentHash: digest({ providerSource: 'not copied' }),
          },
        },
      ];
      c.sourcePermissionManifest.activityMediaPermissions.activities = [
        {
          ...head,
          overlay: { state: 'absent', revision: null },
          source: {
            state: 'present',
            kind,
            sourceId: kind === 'healthkit' ? generation : 'opaque-source',
            revision: 1,
            contentHash: digest({ providerSource: 'not copied' }),
            suppressed: false,
            revisionRecord: { state: 'present' },
          },
        },
      ];
    });
    const result = mapped(envelope);
    const ref = result.refs.find((v) => v.identity.kind === 'activity-canonical-values');
    expect(ref?.representation).toBe('mutable_observation');
    expect(result.refs.some((v) => v.identity.kind === 'manual-activity-source')).toBe(false);
    const forged = structuredClone(envelope);
    const roster = forged.context.routineActualManifest.actualRosters.activities[0];
    if (!roster) throw Error('fixture');
    roster.originalDigest = digest({ not: 'original' });
    expect(enumerate(input((c) => Object.assign(c, forged.context))).inventoryState).toBe(
      'blocked',
    );
  },
);

it('indexes independent unplanned copies across context/sourceInput/candidate and rejects omitted roster', () => {
  const value = input((c) => {
    withRun(c);
    c.routineActualManifest.schedules = [];
    c.routines = [];
    c.rosters.routine = [];
  });
  const result = mapped(value);
  const original = value.context.routineActualManifest.runs[0]?.record;
  if (!original) throw Error('fixture');
  const ref = result.refs.find(
    (r) => r.identity.kind === 'routine-run' && r.identity.sourceId === original.id,
  );
  expect(ref?.dtoDigest).toBe(digest(original));
  expect(ref?.copiedLocations).toEqual(
    expect.arrayContaining([
      'context.routineActualManifest.runs[0].record',
      'sourceInput.projectionInput.retainedUnplannedRuns[0].run',
      'candidate.body.projectionInput.retainedUnplannedRuns[0].run',
      'candidate.body.projection.retainedUnplannedRuns[0].run',
    ]),
  );
  const omitted = structuredClone(value);
  omitted.sourceInput.projectionInput.retainedUnplannedRuns = [];
  expect(enumerate(omitted)).toMatchObject({
    inventoryState: 'blocked',
    blockers: expect.arrayContaining([
      expect.objectContaining({ reason: 'correspondence_mismatch' }),
    ]),
  });
});

it('rejects rehashed omitted input/output unplanned roster while context retains the actual run', () => {
  const value = structuredClone(
    input((c) => {
      withRun(c);
      c.routineActualManifest.schedules = [];
      c.routines = [];
      c.rosters.routine = [];
    }),
  );
  value.sourceInput.projectionInput.retainedUnplannedRuns = [];
  value.candidate.body.projectionInput.retainedUnplannedRuns = [];
  value.candidate.body.projection.retainedUnplannedRuns = [];
  value.candidate.digest = digest(value.candidate.body);
  expect(enumerate(value)).toMatchObject({
    inventoryState: 'blocked',
    blockers: expect.arrayContaining([
      expect.objectContaining({ location: 'sourceInput', reason: 'correspondence_mismatch' }),
    ]),
  });
});
it('rejects rehashed changed unplanned progress contents despite unchanged identity', () => {
  const value = structuredClone(
    input((c) => {
      withRun(c);
      c.routineActualManifest.schedules = [];
      c.routines = [];
      c.rosters.routine = [];
    }),
  );
  for (const row of [
    value.sourceInput.projectionInput.retainedUnplannedRuns?.[0],
    value.candidate.body.projectionInput.retainedUnplannedRuns?.[0],
    value.candidate.body.projection.retainedUnplannedRuns?.[0],
  ]) {
    if (!row?.run.progress[0]) throw Error('fixture');
    row.run.progress[0].reason = 'Altered original report';
  }
  value.candidate.digest = digest(value.candidate.body);
  expect(enumerate(value)).toMatchObject({
    inventoryState: 'blocked',
    blockers: expect.arrayContaining([
      expect.objectContaining({ reason: 'correspondence_mismatch' }),
    ]),
  });
});

function recoveryNutritionTupleFixture(
  state: 'current' | 'historical',
  head: { aggregateId: string; versionId: string } | null,
) {
  const planId = 'aaaaaaaa-1111-4111-8111-111111111111',
    versionId = 'bbbbbbbb-1111-4111-8111-111111111111';
  const record = nutritionPlanVersionV4Schema.parse({
    schemaVersion: 4,
    planId,
    versionId,
    version: 1,
    previousVersionId: null,
    approvedAt: now,
    approvalId: generation,
    period: { from: '2026-10-07', toInclusive: '2026-10-09' },
    timezone: 'UTC',
    purpose: 'Frozen recovery-consumed nutrition',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'food-zero-null',
        planVersionId: versionId,
        category: 'before',
        title: 'Retained instruction',
        anchor: { kind: 'absolute', date: '2026-10-07', localTime: '06:00', timezone: 'UTC' },
        foods: [],
        targets: [],
        instructions: 'Retain explicit intake instruction',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  });
  const value = input((c) => {
    c.recoveryNutritionSources = {
      records: [record],
      facts: [
        {
          requested: { aggregateId: planId, versionId },
          state,
          reason: null,
          content: { digest: digest(record) },
          currentHead: head,
        },
      ],
      nestedSources: {
        nutrition: [
          {
            versionId,
            recordDigest: digest(record),
            foods: [],
            anchors: [],
            linkedPlan: { state: 'absent' },
          },
        ],
        loadedPlans: [],
      },
      authority: 'none',
      freshness: 'not_checked',
    };
  });
  return { value, record, planId, versionId };
}
it('indexes actual camelCase current recovery nutrition tuple and exact original body/digest/location', () => {
  const id = 'aaaaaaaa-1111-4111-8111-111111111111',
    version = 'bbbbbbbb-1111-4111-8111-111111111111';
  const f = recoveryNutritionTupleFixture('current', { aggregateId: id, versionId: version });
  const inventory = mapped(f.value);
  expect(inventory.refs.find((r) => r.identity.kind === 'nutrition-plan-version')).toMatchObject({
    identity: { kind: 'nutrition-plan-version', sourceId: id, versionId: version },
    dtoDigest: digest(f.record),
    copiedLocations: expect.arrayContaining(['context.recoveryNutritionSources.records[0]']),
  });
});
it.each([
  null,
  {
    aggregateId: 'aaaaaaaa-1111-4111-8111-111111111111',
    versionId: 'cccccccc-1111-4111-8111-111111111111',
  },
])('preserves historical frozen recovery nutrition with actual head %s', (head) => {
  const f = recoveryNutritionTupleFixture('historical', head);
  const inventory = mapped(f.value);
  expect(inventory.refs.find((r) => r.identity.kind === 'nutrition-plan-version')?.dtoDigest).toBe(
    digest(f.record),
  );
  expect(f.value.context.recoveryNutritionSources?.records[0]).toEqual(f.record);
});
it.each([
  ['current', null],
  [
    'current',
    {
      aggregateId: 'aaaaaaaa-1111-4111-8111-111111111111',
      versionId: 'cccccccc-1111-4111-8111-111111111111',
    },
  ],
  [
    'current',
    {
      aggregateId: 'dddddddd-1111-4111-8111-111111111111',
      versionId: 'bbbbbbbb-1111-4111-8111-111111111111',
    },
  ],
  [
    'historical',
    {
      aggregateId: 'dddddddd-1111-4111-8111-111111111111',
      versionId: 'cccccccc-1111-4111-8111-111111111111',
    },
  ],
  [
    'historical',
    {
      aggregateId: 'aaaaaaaa-1111-4111-8111-111111111111',
      versionId: 'bbbbbbbb-1111-4111-8111-111111111111',
    },
  ],
] as const)('rejects %s recovery nutrition wrong/foreign current head', (state, head) => {
  const f = recoveryNutritionTupleFixture(state, head);
  expect(enumerate(f.value)).toMatchObject({
    inventoryState: 'blocked',
    allCopiedBodiesIndexed: false,
    blockers: expect.arrayContaining([
      { location: 'context.recoveryNutritionSources.records[0]', reason: 'source_tuple_mismatch' },
    ]),
  });
});
