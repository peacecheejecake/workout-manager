import { z } from 'zod';
import { checkInTemplateVersionSchema } from '@workout/contracts/check-in-templates';
import type { Transaction } from './database.js';
import {
  impactDependencyDigest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const refSchema = z.strictObject({ id: uuid, versionId: uuid });
const headSchema = z.strictObject({
  templateId: uuid,
  versionId: uuid,
  version: z.number().int().min(1).max(2147483646),
});
/** Private read facts; parsing this shape does not establish tenant ownership. */
export const checkInTemplateSourceSchema = z.strictObject({
  requested: refSchema,
  state: z.enum(['current', 'historical', 'unavailable']),
  reason: z.enum(['owned_version_unavailable', 'reader_unavailable']).nullable(),
  record: checkInTemplateVersionSchema.nullable(),
  currentHead: headSchema.nullable(),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
export type CheckInTemplateSource = z.infer<typeof checkInTemplateSourceSchema>;
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return result.data;
}
function body(raw: string | null) {
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  }
  return parse(checkInTemplateVersionSchema, decoded);
}

/** Uses the caller's transaction and narrow tenant-derived SQL readers only.
 * RR/serializable callers retain a coherent snapshot. Under RC the readers may
 * see a later current head; these facts never assert approval freshness. The
 * exact immutable requested body is never replaced by the current head.
 * Reservations conservatively bound UTF8 response bodies, not physical wire.
 */
export async function captureCheckInTemplateSourceIn(
  tx: Transaction,
  unknownRef: unknown,
  budget: SourceBudget,
): Promise<CheckInTemplateSource> {
  if (
    typeof budget.bytes !== 'bigint' ||
    budget.bytes < 0n ||
    !Number.isSafeInteger(budget.sources) ||
    budget.sources < 0
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (
    !unknownRef ||
    typeof unknownRef !== 'object' ||
    Object.getPrototypeOf(unknownRef) !== Object.prototype ||
    Object.values(Object.getOwnPropertyDescriptors(unknownRef)).some(
      (property) => !('value' in property),
    )
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const requested = parse(refSchema, unknownRef);
  // Charge the visited reference before any dedup/capability transport.
  reserveSourceBudget(budget, 512n, 1);
  const capability = parse(
    z.strictObject({ available: z.boolean() }),
    (
      await tx.query(`SELECT COALESCE(
        has_function_privilege(current_user,to_regprocedure('public.read_check_in_template_version_v1(uuid,uuid)'),'EXECUTE')
        AND has_function_privilege(current_user,to_regprocedure('public.read_check_in_template_head_v1(uuid)'),'EXECUTE'),false) AS available`)
    ).rows[0],
  );
  if (!capability.available)
    return {
      requested,
      state: 'unavailable',
      reason: 'reader_unavailable',
      record: null,
      currentHead: null,
      authority: 'none',
      freshness: 'not_checked',
    };
  reserveSourceBudget(budget, 512n);
  const remaining = 4194304n - budget.bytes;
  // Each definer runs once. Scalar lengths gate both JSON texts before they
  // reach the driver. SQL123 constrains each stored DTO to 16KiB.
  const row = parse(
    z.strictObject({
      response_bytes: z.string().regex(/^(0|[1-9]\d*)$/),
      body_valid: z.boolean(),
      within_budget: z.boolean(),
      version_text: z.string().nullable(),
      head_text: z.string().nullable(),
    }),
    (
      await tx.query(
        `WITH observed AS MATERIALIZED (
          SELECT public.read_check_in_template_version_v1($1::uuid,$2::uuid) AS version,
                 public.read_check_in_template_head_v1($1::uuid) AS head
        ), scalar AS MATERIALIZED (
          SELECT version,head,
            coalesce(octet_length(version::text),0)+coalesce(octet_length(head::text),0) AS bytes,
            coalesce(octet_length(version::text),0)<=16384 AND coalesce(octet_length(head::text),0)<=16384 AS valid
          FROM observed
        ) SELECT bytes::text AS response_bytes,valid AS body_valid,
          bytes<=$3::bigint AS within_budget,
          CASE WHEN valid AND bytes<=$3::bigint THEN version::text ELSE NULL END AS version_text,
          CASE WHEN valid AND bytes<=$3::bigint THEN head::text ELSE NULL END AS head_text FROM scalar`,
        [requested.id, requested.versionId, remaining.toString()],
      )
    ).rows[0],
  );
  const bytes = BigInt(row.response_bytes);
  if (
    row.within_budget !== bytes <= remaining ||
    ((!row.body_valid || !row.within_budget) &&
      (row.version_text !== null || row.head_text !== null))
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (
    !row.body_valid ||
    bytes > 32768n ||
    Buffer.byteLength(row.version_text ?? '', 'utf8') > 16384 ||
    Buffer.byteLength(row.head_text ?? '', 'utf8') > 16384
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (!row.within_budget)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  if (
    bytes !==
    BigInt(
      Buffer.byteLength(row.version_text ?? '', 'utf8') +
        Buffer.byteLength(row.head_text ?? '', 'utf8'),
    )
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  reserveSourceBudget(budget, bytes);
  const record = body(row.version_text);
  const head = body(row.head_text);
  if (
    (record && (record.templateId !== requested.id || record.versionId !== requested.versionId)) ||
    (head && head.templateId !== requested.id)
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const currentHead = head
    ? { templateId: head.templateId, versionId: head.versionId, version: head.version }
    : null;
  if (!record)
    return {
      requested,
      state: 'unavailable',
      reason: 'owned_version_unavailable',
      record: null,
      currentHead,
      authority: 'none',
      freshness: 'not_checked',
    };
  if (
    !head ||
    head.version < record.version ||
    (head.versionId === record.versionId
      ? impactDependencyDigest(head) !== impactDependencyDigest(record)
      : head.version <= record.version)
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return {
    requested,
    state: head.versionId === record.versionId ? 'current' : 'historical',
    reason: null,
    record,
    currentHead,
    authority: 'none',
    freshness: 'not_checked',
  };
}
