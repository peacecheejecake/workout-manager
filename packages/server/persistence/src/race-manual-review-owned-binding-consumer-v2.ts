import { z } from 'zod';
import type { Database, Transaction } from './database.js';
import { prepareRaceManualReviewCompatibleV4In } from './race-manual-review-preparation-v2.js';
import {
  enumerateRaceManualReviewCopiedSourcesV2,
  raceManualReviewSourceInventoryV2Schema,
} from './race-manual-review-source-inventory-v2.js';
import {
  captureRaceManualReviewOwnedSourceInventoryV2In,
  raceManualReviewOwnedSourceInventoryV2Schema,
} from './race-manual-review-owned-source-inventory-v2.js';
import { raceProjectionIntentSchema } from './race-plan-impact-projection-input.js';
import { RacePlanImpactPreviewError } from './race-plan-impact-preview.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';

const identitySchema =
  raceManualReviewSourceInventoryV2Schema.out.shape.refs.element.shape.identity;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z
  .string()
  .regex(/^[0-9]+$/)
  .max(32);
const anchorSchema = z.strictObject({
  transactionId: decimal,
  callerRole: z.string().min(1).max(63),
  athleteId: z.string().min(1).max(200),
  isolation: z.enum(['repeatable read', 'serializable']),
});
const sqlFactSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ordinal: z.number().int().min(1).max(5000),
    identity: identitySchema,
    relation: z.string().min(1).max(64),
    state: z.literal('observed'),
    sourceRowDigest: hash,
    reason: z.null(),
  }),
  z.strictObject({
    ordinal: z.number().int().min(1).max(5000),
    identity: identitySchema,
    relation: z.string().min(1).max(64),
    state: z.literal('unavailable'),
    sourceRowDigest: z.null(),
    reason: z.literal('source_unavailable'),
  }),
]);
const observerSchema = z.strictObject({
  bindingVersion: z.literal(2),
  scope: z.literal('candidate_v2_copied_full_bodies_only'),
  hashMethod: z.literal('postgres-owned-source-row-jsonb-utc-v2'),
  sqlRefsDigest: hash,
  transactionId: decimal,
  callerRole: anchorSchema.shape.callerRole,
  athleteId: anchorSchema.shape.athleteId,
  rows: z.array(sqlFactSchema).min(1).max(5000),
  storage: z.literal('not_persisted'),
  admissionAllowed: z.literal(false),
  sourceCompleteness: z.literal('unverified'),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
const relations = {
  'race-event': 'race_event',
  'plan-snapshot': 'plan_snapshot',
  'nutrition-plan-version': 'nutrition_plan_version',
  'routine-schedule-version': 'routine_schedule_version',
  'routine-blueprint-version': 'routine_blueprint_version',
  'routine-occurrence': 'routine_occurrence',
  'routine-run': 'routine_run_revision',
  'session-completion': 'session_completion_revision',
} satisfies Record<z.infer<typeof identitySchema>['kind'], string>;
function invalid(): never {
  throw new RaceImpactDependencyError('INVALID_CONTEXT');
}
/** Guard before schema access; no accessors, sparse arrays, cycles or oversized JSON. */
function boundedPlain(value: unknown): number {
  const active = new WeakSet<object>();
  let nodes = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > 4194305 || depth > 64) invalid();
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || active.has(v)) invalid();
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      invalid();
    if (Object.getOwnPropertySymbols(v).length) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      invalid();
    active.add(v);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) invalid();
      visit(descriptor.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > 4194304) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  return size;
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  boundedPlain(raw);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) invalid();
  return parsed.data;
}
function equal(a: unknown, b: unknown): boolean {
  return impactDependencyDigest(a) === impactDependencyDigest(b);
}
const limitations = {
  budgetCoverage: 'owned_transfer_only' as const,
  aggregatePhysicalTransfer: 'not_verified' as const,
  sourceCompleteness: 'unverified' as const,
  storage: 'not_persisted' as const,
  authority: 'none' as const,
  freshness: 'not_checked' as const,
  admissionAllowed: false as const,
  approvalAllowed: false as const,
};
const anchorSql = `SELECT txid_current()::text AS "transactionId",current_user::text AS "callerRole",current_setting('app.athlete_id',true) AS "athleteId",current_setting('transaction_isolation') AS isolation`;

/** Caller owns one fenced snapshot throughout. This reconciles transient copied
 * DTOs with independently observed SQL rows; it never seals, stores or approves. */
export async function prepareRaceManualReviewOwnedBindingV2In(
  tx: Transaction,
  unknownIntent: unknown,
  ownedTransferBudget: SourceBudget,
) {
  if (
    ownedTransferBudget.bytes < 0n ||
    !Number.isSafeInteger(ownedTransferBudget.sources) ||
    ownedTransferBudget.sources < 0
  )
    invalid();
  const intent = raceProjectionIntentSchema.safeParse(unknownIntent);
  if (!intent.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
  reserveSourceBudget(ownedTransferBudget, 0n);
  const anchorRows = await tx.query(anchorSql);
  if (anchorRows.rows.length !== 1) invalid();
  const anchor = parse(anchorSchema, anchorRows.rows[0]);
  if (anchor.athleteId !== tx.athleteId) invalid();
  reserveSourceBudget(ownedTransferBudget, BigInt(boundedPlain(anchor)));
  const preparation = await prepareRaceManualReviewCompatibleV4In(tx, intent.data);
  if (preparation.status === 'blocked') {
    const result = { status: 'blocked' as const, preparation, ...limitations };
    boundedPlain(result);
    return result;
  }
  const inventory = raceManualReviewSourceInventoryV2Schema.parse(
    enumerateRaceManualReviewCopiedSourcesV2(preparation.candidate),
  );
  if (inventory.inventoryState !== 'mapped' || !inventory.allCopiedBodiesIndexed) invalid();
  const refs = inventory.refs.map((ref) => ref.identity);
  const owned = parse(
    raceManualReviewOwnedSourceInventoryV2Schema,
    await captureRaceManualReviewOwnedSourceInventoryV2In(
      tx,
      preparation.candidate,
      ownedTransferBudget,
    ),
  );
  if (owned.candidateDigest !== preparation.candidate.digest || owned.facts.length !== refs.length)
    invalid();
  for (const [index, fact] of owned.facts.entries()) {
    const ref = inventory.refs[index];
    if (
      !ref ||
      !equal(fact.identity, ref.identity) ||
      (fact.state === 'matched' && fact.dtoDigest !== ref.dtoDigest)
    )
      invalid();
  }
  // This reserve concerns new refs/response metadata, not earlier preview body transfers.
  reserveSourceBudget(
    ownedTransferBudget,
    BigInt(boundedPlain(refs)) + BigInt(refs.length) * 1024n,
    refs.length,
  );
  const observedRows = await tx.query(
    `/* manual_review_owned_binding_consumer_v2 */ SELECT public.observe_manual_review_owned_source_bindings_v2($1::jsonb) AS observation,encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex') AS "expectedRefsDigest",txid_current()::text AS "transactionId",current_user::text AS "callerRole",current_setting('app.athlete_id',true) AS "athleteId",current_setting('transaction_isolation') AS isolation`,
    [JSON.stringify(refs)],
  );
  if (observedRows.rows.length !== 1) invalid();
  const wireSchema = anchorSchema
    .extend({ observation: observerSchema, expectedRefsDigest: hash })
    .strict();
  const wire = parse(wireSchema, observedRows.rows[0]);
  const observation = wire.observation;
  if (
    !equal(anchor, {
      transactionId: wire.transactionId,
      callerRole: wire.callerRole,
      athleteId: wire.athleteId,
      isolation: wire.isolation,
    }) ||
    observation.transactionId !== anchor.transactionId ||
    observation.callerRole !== anchor.callerRole ||
    observation.athleteId !== anchor.athleteId ||
    observation.sqlRefsDigest !== wire.expectedRefsDigest ||
    observation.rows.length !== refs.length
  )
    invalid();
  for (const [index, row] of observation.rows.entries()) {
    const identity = refs[index];
    if (
      !identity ||
      row.ordinal !== index + 1 ||
      !equal(row.identity, identity) ||
      row.relation !== relations[identity.kind]
    )
      invalid();
  }
  reserveSourceBudget(ownedTransferBudget, BigInt(boundedPlain(wire)));
  const result = {
    status:
      preparation.status === 'prepared_readonly' &&
      owned.status === 'observed_correspondence' &&
      observation.rows.every((row) => row.state === 'observed')
        ? ('observed_readonly' as const)
        : ('observed_blocked' as const),
    preparation,
    inventory,
    owned,
    sqlObservation: observation,
    ...limitations,
  };
  boundedPlain(result);
  return result;
}
export type RaceManualReviewOwnedBindingV2 = Awaited<
  ReturnType<typeof prepareRaceManualReviewOwnedBindingV2In>
>;

/** Snapshot capability is mandatory; a committed preview or RC fallback is invalid. */
export function createRaceManualReviewOwnedBindingV2Service(database: Database) {
  return {
    async prepare(
      athleteId: string,
      unknownIntent: unknown,
    ): Promise<RaceManualReviewOwnedBindingV2> {
      const intent = raceProjectionIntentSchema.safeParse(unknownIntent);
      if (!intent.success) throw new RacePlanImpactPreviewError('INVALID_INTENT');
      const snapshot = database.snapshotTenant;
      if (!snapshot) throw new RacePlanImpactPreviewError('CONTEXT_UNAVAILABLE');
      return snapshot(athleteId, (tx) =>
        prepareRaceManualReviewOwnedBindingV2In(tx, intent.data, { bytes: 0n, sources: 0 }),
      );
    },
  };
}
