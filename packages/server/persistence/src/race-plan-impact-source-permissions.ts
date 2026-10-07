import { captureCheckInTemplateSourceIn } from './check-in-template-source.js';
import { checkInTemplateCatalogDescriptorSchema } from './race-plan-impact-routine-manifest.js';
import {
  readTrainingPlanAggregateSource,
  type TrainingPlanAggregateSource,
} from './training-plan-aggregate-source.js';
import {
  captureNestedNutritionSources,
  captureActivityAndMediaPermissions,
  reserveSourceBudget,
  type SourceBudget,
} from './race-plan-impact-nested-sources.js';
import type { NutritionPlanVersionCompatibleV4 } from '@workout/contracts/nutrition-race-plan-v4';
import type { PlanSnapshot } from '@workout/contracts/planning';
import type { RaceEvent } from '@workout/contracts/races';
import type { captureSupplementaryReferenceManifest } from './race-plan-impact-dependencies.js';
import {
  routineTemplateVersionSchema,
  supplementaryExerciseVersionSchema,
} from '@workout/contracts/supplementary-core';
import { z } from 'zod';
import { planDraftSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { recoveryMethodVersionSchema } from '@workout/contracts/recovery-core';
import {
  routineStepContentSchema,
  domainPlanRefSchema,
  type DomainPlanRef,
} from '@workout/contracts/routines';
import type { Transaction } from './database.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';

const uuid = z.uuid();
const decimal = z.string().regex(/^\d+$/);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return result.data;
}
const currentHead = z.strictObject({ aggregate_id: uuid, version_id: uuid });
/** Private manual-read facts, not an AI authorization or an approval capability.
 * Caller holds lifecycle/tenant0 locks. Exact owned versions and current heads stay separate.
 * PostgreSQL scalar accounting precedes every additional body transport. */
export async function captureRaceImpactSourcePermissions(
  tx: Transaction,
  input: {
    plannedRefs: readonly DomainPlanRef[];
    resourceVersionIds: readonly string[];
    catalogRefs?: readonly z.infer<typeof routineStepContentSchema>[];
    nutritionRecords?: readonly NutritionPlanVersionCompatibleV4[];
    mediaIds?: readonly string[];
    sources?: { plan(id: string): Promise<PlanSnapshot>; race(id: string): Promise<RaceEvent> };
    captureSupplementary?: (
      sourceCount: number,
    ) => Promise<Awaited<ReturnType<typeof captureSupplementaryReferenceManifest>>>;
    baseBytes: bigint;
    existingSourceCount: number;
    sharedBudget?: SourceBudget;
  },
) {
  parse(z.number().int().min(0).max(5000), input.existingSourceCount);
  if (input.baseBytes < 0n) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (
    input.sharedBudget !== undefined &&
    (input.sharedBudget.bytes !== input.baseBytes ||
      input.sharedBudget.sources !== input.existingSourceCount)
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const refs = [
    ...new Map(
      input.plannedRefs.map((ref) => {
        const valid = parse(domainPlanRefSchema, ref);
        parse(uuid, valid.planId);
        parse(uuid, valid.versionId);
        return [impactDependencyDigest(valid), valid] as const;
      }),
    ).values(),
  ].sort((a, b) => impactDependencyDigest(a).localeCompare(impactDependencyDigest(b)));
  const resourceIds = [
    ...new Set(parse(z.array(z.string().min(1).max(200)).max(5000), input.resourceVersionIds)),
  ].sort();
  const catalogRequests = [
    ...new Map(
      parse(z.array(routineStepContentSchema).max(5000), input.catalogRefs ?? [])
        .filter((ref) => ref.kind !== 'checklist')
        .map((ref) => [impactDependencyDigest(ref), ref]),
    ).values(),
  ];
  if (input.existingSourceCount + refs.length + resourceIds.length + catalogRequests.length > 5000)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE');
  let bytes =
    input.baseBytes + BigInt((refs.length + resourceIds.length + catalogRequests.length) * 2048);
  if (bytes > 4194304n) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  const nutritionRecords = new Map(
    (input.nutritionRecords ?? []).map((record) => [
      record.versionId,
      parse(nutritionPlanVersionCompatibleV4Schema, record),
    ]),
  );
  const mediaIds = new Set(input.mediaIds ?? []);
  const planned = [];
  const trainingAssociations = new Map<string, Promise<TrainingPlanAggregateSource | null>>();
  for (const requested of refs) {
    // These two producers have concrete session/item membership. Recovery and
    // routine_schedule generic itemId semantics are not implemented by their writers.
    if (requested.domain !== 'training' && requested.domain !== 'nutrition') {
      const recovery = requested.domain === 'recovery';
      const table = recovery ? 'recovery_strategy_version' : 'routine_schedule_version';
      const headTable = recovery ? 'recovery_strategy_head' : 'routine_schedule_head';
      const aggregateColumn = recovery ? 'strategy_id' : 'schedule_id';
      const rows = (
        await tx.query(
          `SELECT v.${aggregateColumn} AS aggregate_id,v.version_id,h.version_id AS head_version_id
        FROM ${table} v LEFT JOIN ${headTable} h ON h.athlete_id=v.athlete_id AND h.${aggregateColumn}=v.${aggregateColumn}
        WHERE v.athlete_id=$1 AND v.version_id=$2::uuid`,
          [tx.athleteId, requested.versionId],
        )
      ).rows;
      if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
      const exact = rows[0]
        ? parse(currentHead.extend({ head_version_id: uuid.nullable() }), rows[0])
        : null;
      planned.push({
        requested,
        state: 'unavailable' as const,
        reason: !exact
          ? 'owned_version_unavailable'
          : exact.aggregate_id !== requested.planId
            ? 'aggregate_mismatch'
            : 'item_contract_unavailable',
        currentHead: exact?.head_version_id
          ? { aggregate_id: exact.aggregate_id, version_id: exact.head_version_id }
          : null,
        exactOwnedVersion: exact
          ? { aggregateId: exact.aggregate_id, versionId: exact.version_id }
          : null,
        content: null,
      });
      continue;
    }
    const training = requested.domain === 'training';
    const table = training ? 'plan_snapshot' : 'nutrition_plan_version';
    const column = training ? 'id' : 'version_id';
    const body = training ? 'draft' : 'record_json';
    const count = parse(
      z.strictObject({ bytes: decimal }),
      (
        await tx.query(
          `SELECT coalesce(sum(octet_length(${body}::text)+1024),0)::text AS bytes FROM ${table} WHERE athlete_id=$1 AND ${column}=$2::uuid`,
          [tx.athleteId, requested.versionId],
        )
      ).rows[0],
    );
    bytes += BigInt(count.bytes);
    if (bytes > 4194304n)
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
    const rows = (
      await tx.query(
        `SELECT ${body} AS body FROM ${table} WHERE athlete_id=$1 AND ${column}=$2::uuid`,
        [tx.athleteId, requested.versionId],
      )
    ).rows;
    const heads = (
      await tx.query(
        training
          ? 'SELECT aggregate_id,version_id FROM plan_head WHERE athlete_id=$1'
          : 'SELECT plan_id AS aggregate_id,version_id FROM nutrition_plan_head WHERE athlete_id=$1 AND plan_id=$2::uuid',
        training ? [tx.athleteId] : [tx.athleteId, requested.planId],
      )
    ).rows.map((row) => parse(currentHead, row));
    if (rows.length > 1 || heads.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const head = heads[0] ?? null;
    if (!rows[0]) {
      planned.push({
        requested,
        state: 'unavailable' as const,
        reason: 'owned_version_unavailable',
        currentHead: head,
        content: null,
      });
      continue;
    }
    const row = parse(z.strictObject({ body: z.unknown() }), rows[0]);
    const record = training
      ? parse(planDraftSchema, row.body)
      : parse(nutritionPlanVersionCompatibleV4Schema, row.body);
    if ('versionId' in record && record.versionId !== requested.versionId)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if ('planId' in record) nutritionRecords.set(record.versionId, record);
    let immutableAssociation: TrainingPlanAggregateSource | null = null;
    if (training) {
      const key = requested.versionId.toLowerCase();
      let pending = trainingAssociations.get(key);
      if (!pending) {
        pending = readTrainingPlanAggregateSource(tx, key);
        trainingAssociations.set(key, pending);
      }
      immutableAssociation = await pending;
    }
    const aggregateMatches = training
      ? immutableAssociation
        ? immutableAssociation.aggregateId === requested.planId.toLowerCase()
        : head?.aggregate_id.toLowerCase() === requested.planId.toLowerCase() &&
          head.version_id.toLowerCase() === requested.versionId.toLowerCase()
      : 'planId' in record && record.planId === requested.planId;
    const member =
      'sessions' in record
        ? record.sessions.some((item) => item.id === requested.itemId)
        : record.items.some((item) => item.id === requested.itemId);
    if (!aggregateMatches || !member) {
      planned.push({
        requested,
        state: 'unavailable' as const,
        reason: !aggregateMatches
          ? training
            ? 'aggregate_identity_unavailable'
            : 'aggregate_mismatch'
          : 'item_unavailable',
        currentHead: head,
        content: null,
      });
      continue;
    }
    if (training && input.sources && 'sessions' in record) {
      // Expose the actual exact owned version in the shared consumed-source
      // cache, so frozen supplementary/session membership is checked too.
      // The association above never substitutes the current head body.
      const consumed = await input.sources.plan(requested.versionId);
      if (
        consumed.id.toLowerCase() !== requested.versionId.toLowerCase() ||
        impactDependencyDigest(consumed.draft) !== impactDependencyDigest(record)
      )
        throw new RaceImpactDependencyError('INVALID_CONTEXT');
    }
    planned.push({
      requested,
      state:
        head?.version_id === requested.versionId ? ('current' as const) : ('historical' as const),
      reason: null,
      currentHead: head,
      content: { digest: impactDependencyDigest(record) },
      aggregateIdentity: training
        ? immutableAssociation
          ? ('immutable_version' as const)
          : ('current_head_association_only' as const)
        : ('immutable_version' as const),
      ...(immutableAssociation
        ? {
            exactOwnedVersion: {
              aggregateId: immutableAssociation.aggregateId,
              versionId: immutableAssociation.versionId,
            },
          }
        : {}),
    });
  }
  const catalog = [];
  let extraSources = catalogRequests.length;
  const exercises = new Map<
    string,
    Promise<z.infer<typeof supplementaryExerciseVersionSchema> | null>
  >();
  async function exactBody(
    table:
      'supplementary_routine_version' | 'supplementary_exercise_version' | 'nutrition_plan_version',
    versionId: string,
  ) {
    parse(uuid, versionId);
    const size = parse(
      z.strictObject({ bytes: decimal }),
      (
        await tx.query(
          `SELECT coalesce(sum(octet_length(record_json::text)+1024),0)::text AS bytes FROM ${table} WHERE athlete_id=$1 AND version_id=$2::uuid`,
          [tx.athleteId, versionId],
        )
      ).rows[0],
    );
    bytes += BigInt(size.bytes);
    if (bytes > 4194304n)
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
    const rows = (
      await tx.query(
        `SELECT record_json FROM ${table} WHERE athlete_id=$1 AND version_id=$2::uuid`,
        [tx.athleteId, versionId],
      )
    ).rows;
    if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    return rows[0]
      ? parse(z.strictObject({ record_json: z.unknown() }), rows[0]).record_json
      : null;
  }
  async function exercise(versionId: string) {
    const old = exercises.get(versionId);
    if (old) return old;
    extraSources++;
    if (input.existingSourceCount + refs.length + resourceIds.length + extraSources > 5000)
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE');
    const pending = (async () => {
      const body = await exactBody('supplementary_exercise_version', versionId);
      if (body === null) return null;
      const record = parse(supplementaryExerciseVersionSchema, body);
      if (record.versionId !== versionId) throw new RaceImpactDependencyError('INVALID_CONTEXT');
      for (const id of record.mediaAssetIds) mediaIds.add(id);
      for (const id of record.resourceVersionIds)
        if (!resourceIds.includes(id)) {
          resourceIds.push(id);
          bytes += 2048n;
        }
      if (input.existingSourceCount + refs.length + resourceIds.length + extraSources > 5000)
        throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE');
      if (bytes > 4194304n)
        throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
      return record;
    })();
    exercises.set(versionId, pending);
    return pending;
  }
  const recoveryMethods = new Map<
    string,
    Promise<{
      record: z.infer<typeof recoveryMethodVersionSchema>;
      head: z.infer<typeof currentHead> | null;
    } | null>
  >();
  async function recoveryMethod(versionId: string) {
    const old = recoveryMethods.get(versionId);
    if (old) return old;
    const pending = (async () => {
      // Budget the transported exact DTO BEFORE decoding. Current head is scalar
      // identity only; it never substitutes a current method body for this version.
      const size = parse(
        z.strictObject({ bytes: decimal }),
        (
          await tx.query(
            'SELECT coalesce(sum(octet_length(v.record_json::text)+1024),0)::text AS bytes FROM recovery_method_version v WHERE v.athlete_id=$1 AND v.version_id=$2::uuid',
            [tx.athleteId, versionId],
          )
        ).rows[0],
      );
      bytes += BigInt(size.bytes);
      if (bytes > 4194304n)
        throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
      const rows = (
        await tx.query(
          `SELECT v.method_id,v.version_id,v.version,v.record_json,h.method_id AS head_method_id,h.version_id AS head_version_id,h.version AS head_version
         FROM recovery_method_version v LEFT JOIN recovery_method_head h ON h.athlete_id=v.athlete_id AND h.method_id=v.method_id
         WHERE v.athlete_id=$1 AND v.version_id=$2::uuid`,
          [tx.athleteId, versionId],
        )
      ).rows;
      if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
      if (!rows[0]) return null;
      const row = parse(
        z.strictObject({
          method_id: uuid,
          version_id: uuid,
          version: z.number().int().positive().max(2147483646),
          record_json: z.unknown(),
          head_method_id: uuid.nullable(),
          head_version_id: uuid.nullable(),
          head_version: z.number().int().positive().max(2147483646).nullable(),
        }),
        rows[0],
      );
      const record = parse(recoveryMethodVersionSchema, row.record_json);
      if (
        record.methodId !== row.method_id ||
        record.versionId !== row.version_id ||
        record.version !== row.version ||
        record.versionId !== versionId
      )
        throw new RaceImpactDependencyError('INVALID_CONTEXT');
      if (
        (row.head_method_id === null) !== (row.head_version_id === null) ||
        (row.head_method_id === null) !== (row.head_version === null) ||
        (row.head_method_id !== null && row.head_method_id !== row.method_id)
      )
        throw new RaceImpactDependencyError('INVALID_CONTEXT');
      return {
        record,
        head:
          row.head_method_id === null
            ? null
            : parse(currentHead, {
                aggregate_id: row.head_method_id,
                version_id: row.head_version_id,
              }),
      };
    })();
    recoveryMethods.set(versionId, pending);
    return pending;
  }
  for (const untrusted of catalogRequests) {
    const requested = parse(routineStepContentSchema, untrusted);
    if (requested.kind === 'checklist') continue;
    parse(uuid, requested.ref.id);
    parse(uuid, requested.ref.versionId);
    if (requested.kind === 'recovery_method') {
      const exact = await recoveryMethod(requested.ref.versionId);
      if (exact && exact.record.methodId !== requested.ref.id)
        throw new RaceImpactDependencyError('INVALID_CONTEXT');
      catalog.push({
        requested,
        state: !exact
          ? ('unavailable' as const)
          : exact.head?.version_id === exact.record.versionId
            ? ('current' as const)
            : ('historical' as const),
        reason: exact ? null : 'owned_version_unavailable',
        content: exact ? { digest: impactDependencyDigest(exact.record) } : null,
        currentHead: exact?.head ?? null,
        provenance: exact
          ? {
              source: exact.record.source,
              reviewState: exact.record.reviewState,
              reviewedAt: exact.record.reviewedAt,
            }
          : null,
      });
      continue;
    }
    if (requested.kind === 'checkin_template') {
      // The catalog visit was reserved above. The reader owns exact body/scalar
      // reservations; its one visit replaces that reservation rather than doubling it.
      const templateBudget = {
        bytes,
        sources: input.existingSourceCount + refs.length + resourceIds.length + extraSources - 1,
      };
      const exact = await captureCheckInTemplateSourceIn(tx, requested.ref, templateBudget);
      bytes = templateBudget.bytes;
      if (!exact.record || !exact.currentHead) {
        catalog.push({
          requested,
          state: 'unavailable' as const,
          reason: exact.reason,
          content: null,
          currentHead: null,
        });
        continue;
      }
      const contentDigest = impactDependencyDigest(exact.record);
      // Drop title/instructions/field prompts here: no new copied template body.
      const descriptor = checkInTemplateCatalogDescriptorSchema.parse({
        templateId: exact.record.templateId,
        versionId: exact.record.versionId,
        version: exact.record.version,
        currentHead: exact.currentHead,
        contentDigest,
        definitionVersion: exact.record.content.definitionVersion,
        source: exact.record.content.source,
        method: exact.record.content.method,
        authority: 'none',
        freshness: 'not_checked',
      });
      catalog.push({
        requested,
        state: exact.state,
        reason: null,
        content: { digest: contentDigest },
        currentHead: {
          aggregate_id: exact.currentHead.templateId,
          version_id: exact.currentHead.versionId,
        },
        checkInTemplateSource: descriptor,
      });
      continue;
    }
    const workout = requested.kind === 'workout_template';
    const body = await exactBody(
      workout ? 'supplementary_routine_version' : 'nutrition_plan_version',
      requested.ref.versionId,
    );
    if (body === null) {
      catalog.push({
        requested,
        state: 'unavailable' as const,
        reason: 'owned_version_unavailable',
        content: null,
        currentHead: null,
      });
      continue;
    }
    const record = workout
      ? parse(routineTemplateVersionSchema, body)
      : parse(nutritionPlanVersionCompatibleV4Schema, body);
    if ('planId' in record) nutritionRecords.set(record.versionId, record);
    const id = 'routineId' in record ? record.routineId : record.planId;
    if (id !== requested.ref.id || record.versionId !== requested.ref.versionId)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const heads = (
      await tx.query(
        workout
          ? 'SELECT routine_id AS aggregate_id,version_id FROM supplementary_routine_head WHERE athlete_id=$1 AND routine_id=$2::uuid'
          : 'SELECT plan_id AS aggregate_id,version_id FROM nutrition_plan_head WHERE athlete_id=$1 AND plan_id=$2::uuid',
        [tx.athleteId, id],
      )
    ).rows;
    if (heads.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const head = heads[0] ? parse(currentHead, heads[0]) : null;
    const linked = [];
    if ('spec' in record) {
      for (const versionId of [
        ...new Set(
          record.spec.blocks.flatMap((block) => block.sets.map((set) => set.exerciseVersionId)),
        ),
      ].sort()) {
        const exact = await exercise(versionId);
        const headRows = exact
          ? (
              await tx.query(
                'SELECT exercise_id AS aggregate_id,version_id FROM supplementary_exercise_head WHERE athlete_id=$1 AND exercise_id=$2::uuid',
                [tx.athleteId, exact.exerciseId],
              )
            ).rows
          : [];
        if (headRows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
        linked.push({
          requestedVersionId: versionId,
          state: exact ? ('owned' as const) : ('unavailable' as const),
          content: exact
            ? {
                exerciseId: exact.exerciseId,
                versionId: exact.versionId,
                digest: impactDependencyDigest(exact),
                resourceVersionIds: exact.resourceVersionIds,
                mediaAssetIds: exact.mediaAssetIds,
              }
            : null,
          currentHead: headRows[0] ? parse(currentHead, headRows[0]) : null,
        });
      }
    }
    catalog.push({
      requested,
      state: head?.version_id === record.versionId ? ('current' as const) : ('historical' as const),
      reason: null,
      content: { digest: impactDependencyDigest(record) },
      currentHead: head,
      exercises: linked,
    });
  }
  const budget = {
    bytes,
    sources: input.existingSourceCount + refs.length + resourceIds.length + extraSources,
  };
  const nestedSources = await captureNestedNutritionSources(
    tx,
    [...nutritionRecords.values()],
    budget,
    input.sources,
  );
  if (input.captureSupplementary) {
    const supplementary = await input.captureSupplementary(budget.sources);
    reserveSourceBudget(budget, 0n, supplementary.routines.length + supplementary.exercises.length);
    for (const exercise of supplementary.exercises) {
      for (const id of exercise.resourceVersionIds)
        if (!resourceIds.includes(id)) {
          resourceIds.push(id);
          reserveSourceBudget(budget, 2048n, 1);
        }
      for (const id of exercise.mediaAssetIds) mediaIds.add(id);
    }
  }
  const activityMediaPermissions = await captureActivityAndMediaPermissions(
    tx,
    [...mediaIds],
    budget,
  );
  resourceIds.sort();
  const consentRows = (
    await tx.query("SELECT granted,revision FROM consent WHERE athlete_id=$1 AND kind='ai'", [
      tx.athleteId,
    ])
  ).rows;
  if (consentRows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const aiConsent = consentRows[0]
    ? {
        state: 'present' as const,
        ...parse(
          z.strictObject({
            granted: z.boolean(),
            revision: z.number().int().positive().max(2147483647),
          }),
          consentRows[0],
        ),
      }
    : { state: 'absent' as const };
  const resources = [];
  for (const requestedVersionId of resourceIds) {
    // IDs in catalog contracts are bounded opaque strings. A non-UUID has no
    // matching PostgreSQL resource version; never cast it or infer foreign ownership.
    if (!uuid.safeParse(requestedVersionId).success) {
      resources.push({
        requestedVersionId,
        state: 'unavailable' as const,
        reason: 'owned_version_unavailable',
        content: null,
        current: null,
      });
      continue;
    }
    const rows = (
      await tx.query(
        `SELECT v.resource_id,v.version_id,v.version,v.content_hash,r.current_version_id,r.access_revision,
      r.deleted_at IS NOT NULL AS deleted,r.include_for_coach,r.reviewed_state,r.reviewed_version_id,
      public.resource_derived_cleanup_pending(r.id) AS cleanup_pending,
      public.resource_coach_use_authorized(r.id) AS ai_authorized
      FROM resource_version v JOIN resource r ON r.athlete_id=v.athlete_id AND r.id=v.resource_id
      WHERE v.athlete_id=$1 AND v.version_id=$2::uuid`,
        [tx.athleteId, requestedVersionId],
      )
    ).rows;
    if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (!rows[0]) {
      resources.push({
        requestedVersionId,
        state: 'unavailable' as const,
        reason: 'owned_version_unavailable',
        content: null,
        current: null,
      });
      continue;
    }
    const row = parse(
      z.strictObject({
        resource_id: uuid,
        version_id: uuid,
        version: z.number().int().positive(),
        content_hash: z.string().regex(/^[a-f0-9]{64}$/),
        current_version_id: uuid,
        access_revision: z.number().int().positive(),
        deleted: z.boolean(),
        include_for_coach: z.boolean(),
        reviewed_state: z.enum(['reviewed', 'unreviewed']),
        reviewed_version_id: uuid.nullable(),
        cleanup_pending: z.boolean(),
        ai_authorized: z.boolean(),
      }),
      rows[0],
    );
    resources.push({
      requestedVersionId,
      state: row.deleted
        ? ('deleted' as const)
        : row.current_version_id === requestedVersionId
          ? ('current' as const)
          : ('historical' as const),
      reason: null,
      content: row.deleted
        ? null
        : {
            resourceId: row.resource_id,
            versionId: row.version_id,
            version: row.version,
            contentHash: row.content_hash,
          },
      current: {
        versionId: row.current_version_id,
        accessRevision: row.access_revision,
        deleted: row.deleted,
        reviewedState: row.reviewed_state,
        reviewedVersionId: row.reviewed_version_id,
        includeForCoach: row.include_for_coach,
        cleanupPending: row.cleanup_pending,
        aiAuthorized: row.ai_authorized,
      },
    });
  }
  // Carry all intermediate catalog/body accounting into subsequent source
  // readers. The optional port preserves existing standalone callers.
  if (input.sharedBudget !== undefined) {
    input.sharedBudget.bytes = budget.bytes;
    input.sharedBudget.sources = budget.sources;
  }
  return {
    complete: false as const,
    planned,
    resources,
    catalog,
    nestedNutritionSources: nestedSources.nutrition,
    activityMediaPermissions,
    aiConsent,
    missing: [
      'unsupported_domain_item_membership',
      'immutable_training_aggregate_history',
      'media_cleanup_status_port',
      'media_and_provider_source_permissions',
      'manual_purpose_app_and_policy_binding',
    ] as const,
  };
}
