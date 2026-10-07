import { z } from 'zod';
import { parseRaceManualReviewFullSqlObservationV2 } from './race-manual-review-full-owned-binding-consumer-v2.js';
import { raceImpactConsumedCaptureSchema } from './race-plan-impact-complete-manifest.js';
import {
  raceManualReviewCandidateV2InputSchema,
  raceManualReviewCandidateV2ResultSchema,
} from '@workout/server-coaching/race-manual-review-candidate-v2';
import {
  enumerateRaceManualReviewFullCopiedSourcesV2,
  raceManualReviewFullCopiedInventoryV2Schema,
} from './race-manual-review-full-copied-inventory-v2.js';
import { raceManualReviewFullOwnedSourceInventoryV2Schema } from './race-manual-review-full-owned-source-inventory-v2.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';

export const RACE_MANUAL_REVIEW_RETAINED_PAYLOAD_V2_MAX_BYTES = 4 * 1024 * 1024;
/** Local JSON boundary only; never executes getters or authenticates a snapshot. */
const plain = z.unknown().superRefine((raw, ctx) => {
  const active = new WeakSet<object>();
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > 4194305 || depth > 64) throw Error('bounds');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || active.has(value)) throw Error('plain');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
      throw Error('prototype');
    if (Object.getOwnPropertySymbols(value).length) throw Error('symbols');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Array.isArray(value) &&
      (Object.keys(value).length !== value.length ||
        Object.getOwnPropertyNames(value).length !== value.length + 1)
    )
      throw Error('array');
    active.add(value);
    for (const [key, d] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!d.enumerable || !('value' in d)) throw Error('accessor');
      visit(d.value, depth + 1);
    }
    active.delete(value);
  }
  try {
    visit(raw, 0);
    const json = JSON.stringify(raw);
    if (
      json === undefined ||
      Buffer.byteLength(json, 'utf8') > RACE_MANUAL_REVIEW_RETAINED_PAYLOAD_V2_MAX_BYTES
    )
      throw Error('bytes');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid bounded plain retained payload' });
  }
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const absentAuthority = z.strictObject({
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
  permissionAuthority: z.literal('none'),
  lifecycleAuthority: z.literal('none'),
  admissionAllowed: z.literal(false),
  approvalAllowed: z.literal(false),
});
const preparation = z.strictObject({
  context: raceImpactConsumedCaptureSchema,
  sourceInput: raceManualReviewCandidateV2InputSchema,
  candidate: raceManualReviewCandidateV2ResultSchema,
});
// The SQL observation codec is supplied by the existing finite consumer below.
const presentBody = z
  .strictObject({
    state: z.literal('present'),
    preparation,
    inventory: raceManualReviewFullCopiedInventoryV2Schema,
    dtoObservations: raceManualReviewFullOwnedSourceInventoryV2Schema,
    sqlObservations: z.json(),
    currentAuthority: absentAuthority,
  })
  .superRefine((v, ctx) => {
    if (
      parseRaceManualReviewFullSqlObservationV2(
        v.sqlObservations,
        v.inventory.refs.map((ref) => ref.identity),
      ).status !== 'validated_structure'
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid finite SQL relation observation' });
  });
const auditSchema = z.strictObject({
  athleteId: z.string().min(1).max(200),
  candidateDigest: hash,
  readSetDigest: hash,
  inventoryDigest: hash,
});
const purgedBody = z.strictObject({
  state: z.literal('purged'),
  originalPayloadDigest: hash,
  minimalAudit: auditSchema,
  sourceWitness: z.literal('not_authenticated'),
  suppressionTail: z.literal('not_authenticated'),
  currentAuthority: absentAuthority,
});
export const raceManualReviewRetainedPayloadV2InputSchema = plain.pipe(
  z.discriminatedUnion('state', [presentBody, purgedBody]),
);
const limitations = {
  codecVersion: 2 as const,
  sourceAuthentication: 'unverified' as const,
  sqlAuthentication: 'unverified' as const,
  storage: 'not_persisted' as const,
  authority: 'none' as const,
  permissionAuthority: 'none' as const,
  lifecycleAuthority: 'none' as const,
  freshness: 'not_checked' as const,
  admissionAllowed: false as const,
  approvalAllowed: false as const,
};
const reasonSchema = z.enum([
  'inventory_incomplete',
  'inventory_mismatch',
  'copied_body_mismatch',
  'dto_observation_mismatch',
  'source_unavailable',
  'sql_observation_mismatch',
  'external_source_witness_required',
]);
function finish<T>(value: T): T {
  plain.parse(value);
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  return impactDependencyDigest(a) === impactDependencyDigest(b);
}
function at(root: unknown, path: string): unknown {
  if (!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*|\[(?:0|[1-9][0-9]*)\])*$/.test(path))
    return undefined;
  let value: unknown = root;
  for (const key of path.replace(/\[([0-9]+)\]/g, '.$1').split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}
/** This is JSON correspondence, not evidence of DB execution, lifecycle or storage admission. */
export function prepareRaceManualReviewRetainedPayloadV2(raw: unknown) {
  const payload = raceManualReviewRetainedPayloadV2InputSchema.parse(raw);
  if (payload.state === 'purged')
    return finish({
      ...limitations,
      state: 'purged' as const,
      status: 'blocked' as const,
      reason: 'external_source_witness_required' as const,
      originalPayloadDigest: payload.originalPayloadDigest,
      minimalAudit: payload.minimalAudit,
      requiredExternalProofs: [
        'independently_retained_original_source_witness',
        'authenticated_contiguous_suppression_tail',
      ] as const,
    });
  let reason: z.infer<typeof reasonSchema> | null = null;
  const fresh = enumerateRaceManualReviewFullCopiedSourcesV2(payload.preparation);
  if (fresh.inventoryState !== 'mapped' || !fresh.allCopiedBodiesIndexed)
    reason = 'inventory_incomplete';
  else if (!equal(fresh, payload.inventory)) reason = 'inventory_mismatch';
  else if (
    payload.inventory.refs.some((ref) =>
      ref.copiedLocations.some((location) => {
        const body = at(payload.preparation, location);
        return body === undefined || impactDependencyDigest(body) !== ref.dtoDigest;
      }),
    )
  )
    reason = 'copied_body_mismatch';
  else if (
    !equal(payload.dtoObservations.coverage, payload.inventory.candidateCoverage) ||
    payload.dtoObservations.facts.length !== payload.inventory.refs.length ||
    payload.dtoObservations.facts.some((fact, index) => {
      const ref = payload.inventory.refs[index];
      return (
        !ref ||
        !equal(fact.identity, ref.identity) ||
        fact.representation !== ref.representation ||
        (fact.state === 'matched' && fact.dtoDigest !== ref.dtoDigest)
      );
    })
  )
    reason = 'dto_observation_mismatch';
  else if (payload.dtoObservations.status !== 'observed_correspondence')
    reason = 'source_unavailable';
  const sql = parseRaceManualReviewFullSqlObservationV2(
    payload.sqlObservations,
    payload.inventory.refs.map((ref) => ref.identity),
  );
  if (sql.status !== 'validated_structure') throw Error('INVALID_RETAINED_SQL_OBSERVATION');
  if (reason === null && sql.observation.athleteId !== payload.preparation.context.athleteId)
    reason = 'sql_observation_mismatch';
  if (reason === null && sql.observation.rows.some((row) => row.state !== 'observed'))
    reason = 'source_unavailable';
  const candidate = payload.preparation.candidate;
  if (candidate.status !== 'assembled_readonly') throw Error('INVALID_RETAINED_CANDIDATE');
  return finish({
    ...limitations,
    state: 'present' as const,
    status: reason === null ? ('structurally_corresponding' as const) : ('blocked' as const),
    reason,
    payloadDigest: impactDependencyDigest(payload),
    payload,
    minimalAudit: {
      athleteId: payload.preparation.context.athleteId,
      candidateDigest: candidate.digest,
      readSetDigest: payload.preparation.context.readSetDigest,
      inventoryDigest: impactDependencyDigest(payload.inventory),
    },
  });
}
const limitationShape = {
  codecVersion: z.literal(2),
  sourceAuthentication: z.literal('unverified'),
  sqlAuthentication: z.literal('unverified'),
  storage: z.literal('not_persisted'),
  authority: z.literal('none'),
  permissionAuthority: z.literal('none'),
  lifecycleAuthority: z.literal('none'),
  freshness: z.literal('not_checked'),
  admissionAllowed: z.literal(false),
  approvalAllowed: z.literal(false),
};
export const raceManualReviewRetainedPayloadV2Schema = plain.pipe(
  z.discriminatedUnion('state', [
    z
      .strictObject({
        ...limitationShape,
        state: z.literal('present'),
        status: z.enum(['structurally_corresponding', 'blocked']),
        reason: reasonSchema.nullable(),
        payloadDigest: hash,
        payload: presentBody,
        minimalAudit: auditSchema,
      })
      .superRefine((v, ctx) => {
        try {
          if (!equal(v, prepareRaceManualReviewRetainedPayloadV2(v.payload)))
            ctx.addIssue({ code: 'custom', message: 'Retained payload correspondence mismatch' });
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Invalid retained payload correspondence' });
        }
      }),
    z.strictObject({
      ...limitationShape,
      state: z.literal('purged'),
      status: z.literal('blocked'),
      reason: z.literal('external_source_witness_required'),
      originalPayloadDigest: hash,
      minimalAudit: auditSchema,
      requiredExternalProofs: z.tuple([
        z.literal('independently_retained_original_source_witness'),
        z.literal('authenticated_contiguous_suppression_tail'),
      ]),
    }),
  ]),
);
export type RaceManualReviewRetainedPayloadV2 = z.infer<
  typeof raceManualReviewRetainedPayloadV2Schema
>;
export function validateRaceManualReviewRetainedPayloadV2(raw: unknown) {
  return raceManualReviewRetainedPayloadV2Schema.safeParse(raw);
}
