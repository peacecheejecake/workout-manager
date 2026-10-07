import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  routineScheduleVersionSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import {
  sessionCompletionSchema,
  sessionCompletionScheduleSchema,
} from '@workout/contracts/session-completion';
import {
  raceManualReviewCandidateV2ResultSchema,
  raceManualReviewCandidateV2BodySchema,
} from '@workout/server-coaching/race-manual-review-candidate-v2';
import {
  enumerateRaceManualReviewCopiedSourcesV2,
  raceManualReviewSourceInventoryV2Schema,
} from './race-manual-review-source-inventory-v2.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
import type { Transaction } from './database.js';

const identitySchema =
  raceManualReviewSourceInventoryV2Schema.out.shape.refs.element.shape.identity;
type Identity = z.infer<typeof identitySchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reasons = z.enum([
  'owned_source_unavailable',
  'source_deleted',
  'source_tuple_mismatch',
  'copied_body_mismatch',
  'history_missing',
]);
const factSchema = z.discriminatedUnion('state', [
  z.strictObject({
    identity: identitySchema,
    state: z.literal('matched'),
    dtoDigest: hash,
    reason: z.null(),
  }),
  z.strictObject({
    identity: identitySchema,
    state: z.literal('unavailable'),
    dtoDigest: z.null(),
    reason: reasons,
  }),
]);
const plainGuard = z.unknown().superRefine((value, ctx) => {
  try {
    const visiting = new WeakSet<object>();
    let nodes = 0;
    function visit(v: unknown, depth: number): void {
      // A serialized JSON node needs at least one byte; the root is included.
      if (++nodes > 4194305 || depth > 64) throw Error('bound');
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw Error('number');
        return;
      }
      if (typeof v !== 'object' || visiting.has(v)) throw Error('plain');
      if (
        !Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      )
        throw Error('plain');
      visiting.add(v);
      const properties = Object.getOwnPropertyDescriptors(v);
      if (Reflect.ownKeys(v).some((key) => typeof key !== 'string')) throw Error('symbol');
      for (const [key, descriptor] of Object.entries(properties)) {
        if (Array.isArray(v) && key === 'length') continue;
        if (descriptor.get || descriptor.set || !descriptor.enumerable) throw Error('accessor');
        visit(descriptor.value, depth + 1);
      }
      if (Array.isArray(v) && Object.keys(v).length !== v.length) throw Error('sparse');
      visiting.delete(v);
    }
    visit(value, 0);
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > 4194304) throw Error('bytes');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid or oversized plain JSON review boundary' });
  }
});
const outputBodySchema = z
  .strictObject({
    scope: z.literal('candidate_v2_copied_full_bodies_only'),
    status: z.enum(['observed_correspondence', 'blocked']),
    candidateDigest: hash,
    facts: z.array(factSchema).min(1).max(5000),
    coverage: raceManualReviewCandidateV2BodySchema.out.shape.coverage,
    observation: z.literal('same_transaction_owned_rows'),
    sqlRowDigest: z.literal('not_captured'),
    authority: z.literal('none'),
    freshness: z.literal('not_checked'),
    storage: z.literal('not_persisted'),
    admissionAllowed: z.literal(false),
    approvalAllowed: z.literal(false),
  })
  .superRefine((v, ctx) => {
    if (
      v.status !==
      (v.facts.every((f) => f.state === 'matched') ? 'observed_correspondence' : 'blocked')
    )
      ctx.addIssue({ code: 'custom', message: 'Observation state mismatch' });
    if (v.facts.filter((f) => f.identity.kind === 'race-event').length !== 1)
      ctx.addIssue({ code: 'custom', message: 'Exactly one original race source required' });
    const keys = v.facts.map((f) => JSON.stringify(f.identity));
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate observed source' });
  });
export const raceManualReviewOwnedSourceInventoryV2Schema = plainGuard.pipe(outputBodySchema);
export type RaceManualReviewOwnedSourceInventoryV2 = z.infer<
  typeof raceManualReviewOwnedSourceInventoryV2Schema
>;
export function validateRaceManualReviewOwnedSourceInventoryV2(raw: unknown) {
  return raceManualReviewOwnedSourceInventoryV2Schema.safeParse(raw);
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return r.data;
}
function bytes(raw: unknown): number {
  const json = JSON.stringify(raw);
  if (json === undefined) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return Buffer.byteLength(json, 'utf8');
}
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const scalarSchema = plainGuard.pipe(
  z.strictObject({
    count: decimal,
    bytes: decimal,
    bodyMaximum: decimal,
    currentMaximum: decimal,
    metadataMaximum: decimal,
  }),
);
const rowSchema = plainGuard.pipe(
  z.strictObject({
    athlete_id: z.string(),
    metadata: z.unknown(),
    record_json: z.unknown(),
    current_record_json: z.unknown(),
  }),
);
const uuid = z.uuid().transform((v) => v.toLowerCase());
const opaque = z.string().min(1);
const rev = z.number().int().min(0).max(2147483647);
const raceMetadataSchema = z.strictObject({ id: uuid, revision: rev, deleted: z.boolean() });
interface Selector {
  from: string;
  where: string;
  values: unknown[];
  record: string;
  metadata: string;
  current: string;
  maximum: number;
}
/** Static domain-table selectors only. All identifiers originate here; requests
 * are parameter values. Existing grantOperations SELECT and RLS are required. */
function selector(athlete: string, id: Identity): Selector {
  const base = { current: 'NULL::jsonb', maximum: 1048576 };
  switch (id.kind) {
    case 'race-event':
      return {
        ...base,
        from: 'race_event r',
        where: 'r.athlete_id=$1 AND r.id::text=$2',
        values: [athlete, id.sourceId],
        record: "r.values_json || jsonb_build_object('id',r.id,'revision',r.revision)",
        metadata: "jsonb_build_object('id',r.id,'revision',r.revision,'deleted',r.deleted)",
        maximum: 16384,
      };
    case 'plan-snapshot':
      return {
        ...base,
        from: 'plan_snapshot r',
        where: 'r.athlete_id=$1 AND r.id::text=$2 AND r.version=$3',
        values: [athlete, id.sourceId, id.version],
        record: `jsonb_build_object('id',r.id,'version',r.version,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'draft',r.draft)`,
        metadata: "jsonb_build_object('id',r.id,'version',r.version)",
        maximum: 1049600,
      };
    case 'nutrition-plan-version':
      return {
        ...base,
        from: 'nutrition_plan_version r',
        where: 'r.athlete_id=$1 AND r.plan_id::text=$2 AND r.version_id::text=$3',
        values: [athlete, id.sourceId, id.versionId],
        record: 'r.record_json',
        metadata:
          "jsonb_build_object('id',r.plan_id,'versionId',r.version_id,'version',r.version,'linkedPlanVersionId',r.linked_training_plan_version_id,'approvalId',r.approval_id,'approvedAt',to_char(r.approved_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'))",
        maximum: 524288,
      };
    case 'routine-schedule-version':
      return {
        ...base,
        maximum: 65536,
        from: 'routine_schedule_version r',
        where: 'r.athlete_id=$1 AND r.schedule_id::text=$2 AND r.version_id::text=$3',
        values: [athlete, id.sourceId, id.versionId],
        record: 'r.record_json',
        metadata:
          "jsonb_build_object('id',r.schedule_id,'versionId',r.version_id,'blueprintId',r.blueprint_routine_id,'blueprintVersionId',r.blueprint_version_id)",
      };
    case 'routine-blueprint-version':
      return {
        ...base,
        from: 'routine_blueprint_version r',
        where: 'r.athlete_id=$1 AND r.routine_id::text=$2 AND r.version_id::text=$3',
        values: [athlete, id.sourceId, id.versionId],
        record: 'r.record_json',
        metadata: "jsonb_build_object('id',r.routine_id,'versionId',r.version_id)",
      };
    case 'routine-occurrence':
      return {
        ...base,
        from: 'routine_occurrence r',
        where: 'r.athlete_id=$1 AND r.id::text=$2',
        values: [athlete, id.sourceId],
        record: 'r.record_json',
        metadata: `jsonb_build_object('id',r.id,'scheduleId',r.schedule_id,'scheduleVersionId',r.schedule_version_id,'blueprintId',r.blueprint_routine_id,'blueprintVersionId',r.blueprint_version_id,'anchorKey',r.anchor_key,'scheduledAt',to_char(r.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`,
        maximum: 65536,
      };
    case 'routine-run':
      return {
        ...base,
        from: 'routine_run_revision r JOIN routine_run h ON h.athlete_id=r.athlete_id AND h.id=r.run_id',
        where: 'r.athlete_id=$1 AND r.run_id::text=$2 AND r.revision=$3',
        values: [athlete, id.sourceId, id.revision],
        record: 'r.record_json',
        metadata:
          "jsonb_build_object('id',r.run_id,'revision',r.revision,'currentRevision',h.revision,'blueprintId',h.blueprint_routine_id,'blueprintVersionId',h.blueprint_version_id,'occurrenceId',h.occurrence_id)",
        current: 'CASE WHEN h.revision=r.revision THEN h.record_json ELSE NULL END',
      };
    case 'session-completion':
      return {
        ...base,
        from: `session_completion_revision r LEFT JOIN plan_snapshot p ON p.athlete_id=r.athlete_id AND p.id::text=r.record_json->>'planVersionId' LEFT JOIN LATERAL (SELECT s FROM jsonb_array_elements(p.draft->'sessions') s WHERE s->>'id'=r.session_id LIMIT 2) session_source ON true`,
        where:
          "r.athlete_id=$1 AND r.session_id=$2 AND r.revision=$3 AND r.record_json->>'planVersionId'=$4",
        values: [athlete, id.sourceId, id.revision, id.planVersionId],
        record: 'r.record_json',
        metadata:
          "jsonb_build_object('id',r.session_id,'revision',r.revision,'planVersionId',p.id,'schedule',CASE WHEN session_source.s IS NULL THEN NULL ELSE jsonb_build_object('blockId',session_source.s->>'blockId','date',session_source.s->>'date','localStartTime',session_source.s->'localStartTime','timezone',p.draft->>'timezone') END)",
        maximum: 16384,
      };
  }
}
// Same precision-preserving method as retained export35; milliseconds alone
// cannot distinguish immutable PostgreSQL fractional-second tuples.
function sameInstant(left: string, right: string): boolean {
  function normalize(value: string) {
    const match = /^(.*:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match?.[1] || !match[3]) return null;
    const seconds = Date.parse(match[1] + match[3]);
    return Number.isSafeInteger(seconds)
      ? `${seconds}:${(match[2] ?? '').replace(/0+$/, '')}`
      : null;
  }
  const value = normalize(left);
  return value !== null && value === normalize(right);
}
function correspondence(
  id: Identity,
  raw: unknown,
  meta: unknown,
  current: unknown,
): { body: unknown; reason: z.infer<typeof reasons> | null } {
  const mismatch = (body: unknown, okay: boolean) => ({
    body,
    reason: okay ? null : ('source_tuple_mismatch' as const),
  });
  switch (id.kind) {
    case 'race-event': {
      const m = parse(raceMetadataSchema, meta);
      if (m.deleted) return { body: null, reason: 'source_deleted' };
      const b = parse(raceEventSchema, raw);
      return mismatch(
        b,
        m.id === id.sourceId &&
          m.revision === id.revision &&
          b.id === m.id &&
          b.revision === m.revision,
      );
    }
    case 'plan-snapshot': {
      const m = parse(z.strictObject({ id: opaque, version: rev }), meta),
        b = parse(planSnapshotSchema, raw);
      return mismatch(
        b,
        m.id === id.sourceId &&
          m.version === id.version &&
          b.id === m.id &&
          b.version === m.version,
      );
    }
    case 'nutrition-plan-version': {
      const m = parse(
          z.strictObject({
            id: uuid,
            versionId: uuid,
            version: rev,
            linkedPlanVersionId: uuid.nullable(),
            approvalId: uuid,
            approvedAt: z.iso.datetime({ offset: true }),
          }),
          meta,
        ),
        b = parse(nutritionPlanVersionCompatibleV4Schema, raw);
      return mismatch(
        b,
        m.id === id.sourceId &&
          m.versionId === id.versionId &&
          b.planId.toLowerCase() === m.id &&
          b.versionId.toLowerCase() === m.versionId &&
          b.version === m.version &&
          (b.linkedTrainingPlanVersionId?.toLowerCase() ?? null) === m.linkedPlanVersionId &&
          b.approvalId.toLowerCase() === m.approvalId &&
          sameInstant(b.approvedAt, m.approvedAt),
      );
    }
    case 'routine-schedule-version': {
      const m = parse(
          z.strictObject({
            id: opaque,
            versionId: opaque,
            blueprintId: opaque,
            blueprintVersionId: opaque,
          }),
          meta,
        ),
        b = parse(routineScheduleVersionSchema, raw);
      return mismatch(
        b,
        m.id === id.sourceId &&
          m.versionId === id.versionId &&
          b.id === m.id &&
          b.versionId === m.versionId &&
          b.blueprint.id === m.blueprintId &&
          b.blueprint.versionId === m.blueprintVersionId,
      );
    }
    case 'routine-blueprint-version': {
      const m = parse(z.strictObject({ id: opaque, versionId: opaque }), meta),
        b = parse(routineBlueprintVersionSchema, raw);
      return mismatch(
        b,
        m.id === id.sourceId &&
          m.versionId === id.versionId &&
          b.routineId === m.id &&
          b.versionId === m.versionId,
      );
    }
    case 'routine-occurrence': {
      const m = parse(
          z.strictObject({
            id: opaque,
            scheduleId: opaque,
            scheduleVersionId: opaque,
            blueprintId: opaque,
            blueprintVersionId: opaque,
            anchorKey: opaque,
            scheduledAt: z.iso.datetime({ offset: true }).nullable(),
          }),
          meta,
        ),
        b = parse(routineOccurrenceSchema, raw);
      return mismatch(
        b,
        m.id === id.sourceId &&
          b.id === m.id &&
          b.schedule.id === m.scheduleId &&
          b.schedule.versionId === m.scheduleVersionId &&
          b.blueprint.id === m.blueprintId &&
          b.blueprint.versionId === m.blueprintVersionId &&
          b.anchorKey === m.anchorKey &&
          (b.scheduledAt === null
            ? m.scheduledAt === null
            : m.scheduledAt !== null && sameInstant(b.scheduledAt, m.scheduledAt)),
      );
    }
    case 'routine-run': {
      const m = parse(
          z.strictObject({
            id: opaque,
            revision: rev,
            currentRevision: rev,
            blueprintId: opaque,
            blueprintVersionId: opaque,
            occurrenceId: opaque.nullable(),
          }),
          meta,
        ),
        b = parse(routineRunSchema, raw);
      return mismatch(
        b,
        m.id === id.sourceId &&
          m.revision === id.revision &&
          b.id === m.id &&
          b.revision === m.revision &&
          b.blueprint.id === m.blueprintId &&
          b.blueprint.versionId === m.blueprintVersionId &&
          (b.origin.kind === 'planned'
            ? b.origin.occurrenceId === m.occurrenceId
            : m.occurrenceId === null) &&
          (m.currentRevision !== m.revision ||
            (current !== null &&
              impactDependencyDigest(parse(routineRunSchema, current)) ===
                impactDependencyDigest(b))),
      );
    }
    case 'session-completion': {
      const m = parse(
          z.strictObject({
            id: opaque,
            revision: rev,
            planVersionId: uuid.nullable(),
            schedule: sessionCompletionScheduleSchema.nullable(),
          }),
          meta,
        ),
        b = parse(sessionCompletionSchema, raw);
      return mismatch(
        b,
        m.id === id.sourceId &&
          m.revision === id.revision &&
          m.planVersionId === id.planVersionId &&
          b.sessionId === m.id &&
          b.revision === m.revision &&
          b.planVersionId === m.planVersionId &&
          m.schedule !== null &&
          impactDependencyDigest(b.schedule) === impactDependencyDigest(m.schedule),
      );
    }
  }
}
/** Retained correspondence only. Caller must use its authenticated fenced snapshot
 * transaction. No injected read callback, processing permission or SQL seal exists. */
export async function captureRaceManualReviewOwnedSourceInventoryV2In(
  tx: Transaction,
  unknownCandidate: unknown,
  budget: SourceBudget,
): Promise<RaceManualReviewOwnedSourceInventoryV2> {
  parse(
    z.strictObject({
      bytes: z.bigint().min(0n).max(4194304n),
      sources: z.number().int().min(0).max(5000),
    }),
    budget,
  );
  const candidate = parse(raceManualReviewCandidateV2ResultSchema, unknownCandidate);
  if (candidate.status !== 'assembled_readonly' || candidate.body.athleteId !== tx.athleteId)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const inventory = enumerateRaceManualReviewCopiedSourcesV2(candidate);
  if (inventory.inventoryState !== 'mapped' || !inventory.allCopiedBodiesIndexed)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  // Candidate bytes already have a 4MiB ingress boundary. Charge only newly
  // transported ref metadata and owned bodies; locations count visits before dedup.
  reserveSourceBudget(
    budget,
    BigInt(bytes(inventory.refs)),
    inventory.refs.reduce((n, r) => n + r.copiedLocations.length, 0),
  );
  const facts: z.infer<typeof factSchema>[] = [];
  for (const ref of inventory.refs) {
    const id = ref.identity,
      s = selector(tx.athleteId, id);
    const unavailable = (reason: z.infer<typeof reasons>) =>
      facts.push({ identity: id, state: 'unavailable', dtoDigest: null, reason });
    const scalar = parse(
      scalarSchema,
      (
        await tx.query(
          `/* manual_review_owned_v2 scalar ${id.kind} */ SELECT count(*)::text AS count,coalesce(sum(n),0)::text AS bytes,coalesce(max(body_bytes),0)::text AS "bodyMaximum",coalesce(max(current_bytes),0)::text AS "currentMaximum",coalesce(max(metadata_bytes),0)::text AS "metadataMaximum" FROM (SELECT octet_length((${s.record})::text)+octet_length((${s.metadata})::text)+coalesce(octet_length((${s.current})::text),0) AS n,octet_length((${s.record})::text) AS body_bytes,coalesce(octet_length((${s.current})::text),0) AS current_bytes,octet_length((${s.metadata})::text) AS metadata_bytes FROM ${s.from} WHERE ${s.where} LIMIT 2) bounded`,
          s.values,
        )
      ).rows[0],
    );
    if (BigInt(scalar.count) > 1n) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    reserveSourceBudget(budget, BigInt(scalar.bytes) + 512n);
    if (scalar.count === '0') {
      unavailable(
        id.kind === 'routine-run' || id.kind === 'session-completion'
          ? 'history_missing'
          : 'owned_source_unavailable',
      );
      continue;
    }
    // n includes metadata/current body. Each transported DTO is checked separately.
    if (
      BigInt(scalar.bodyMaximum) > BigInt(s.maximum) ||
      BigInt(scalar.currentMaximum) > BigInt(s.maximum) ||
      BigInt(scalar.metadataMaximum) > 16384n
    )
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
    const rows = (
      await tx.query(
        `/* manual_review_owned_v2 body ${id.kind} */ SELECT r.athlete_id,${s.metadata} AS metadata,CASE WHEN octet_length((${s.record})::text)<=${s.maximum} THEN ${s.record} ELSE NULL END AS record_json,CASE WHEN coalesce(octet_length((${s.current})::text),0)<=${s.maximum} THEN ${s.current} ELSE NULL END AS current_record_json FROM ${s.from} WHERE ${s.where} LIMIT 2`,
        s.values,
      )
    ).rows;
    if (rows.length !== 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const row = parse(rowSchema, rows[0]);
    if (row.athlete_id !== tx.athleteId) {
      unavailable('source_tuple_mismatch');
      continue;
    }
    // Public race deletion retains its identity and clears values_json. Only an
    // exact, validated tombstone permits the contentless body through this guard.
    const deletedRace =
      id.kind === 'race-event' &&
      row.record_json === null &&
      (() => {
        const metadata = parse(raceMetadataSchema, row.metadata);
        return metadata.id === id.sourceId && metadata.deleted;
      })();
    if (
      (row.record_json === null && !deletedRace) ||
      bytes(row.record_json) > s.maximum ||
      bytes(row.current_record_json) > s.maximum
    )
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
    if (bytes(row) > Number(scalar.bytes) + 512)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const checked = correspondence(id, row.record_json, row.metadata, row.current_record_json);
    if (checked.reason) {
      unavailable(checked.reason);
      continue;
    }
    const digest = impactDependencyDigest(checked.body);
    if (digest !== ref.dtoDigest) {
      unavailable('copied_body_mismatch');
      continue;
    }
    facts.push({ identity: id, state: 'matched', dtoDigest: digest, reason: null });
  }
  const result = raceManualReviewOwnedSourceInventoryV2Schema.parse({
    scope: inventory.scope,
    status: facts.every((f) => f.state === 'matched') ? 'observed_correspondence' : 'blocked',
    candidateDigest: candidate.digest,
    facts,
    coverage: candidate.body.coverage,
    observation: 'same_transaction_owned_rows',
    sqlRowDigest: 'not_captured',
    authority: 'none',
    freshness: 'not_checked',
    storage: 'not_persisted',
    admissionAllowed: false,
    approvalAllowed: false,
  });
  if (bytes(result) > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  return result;
}
