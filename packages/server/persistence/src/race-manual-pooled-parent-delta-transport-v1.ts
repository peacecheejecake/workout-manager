import { z } from 'zod';
import type { Transaction } from './database.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import { parseRaceManualPooledParentDeltaV1 } from './race-manual-pooled-parent-delta-v1.js';
import { RaceImpactDependencyError } from './race-plan-impact-dependencies.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const responseRow = z.strictObject({
  bytes: z
    .string()
    .max(20)
    .regex(/^(0|[1-9][0-9]*)$/),
  value: z.unknown(),
});
const unavailable = {
  status: 'unavailable',
  authority: 'none',
  permissionAuthority: 'none',
  freshness: 'not_checked',
  approvalAllowed: false,
  planApplied: false,
} as const;
function invalid(): never {
  throw new RaceImpactDependencyError('INVALID_CONTEXT');
}
function plain(raw: unknown): void {
  try {
    assertRaceManualPlainV2(raw);
  } catch {
    invalid();
  }
}
/** A measured read in the caller's fenced transaction. The fresh dictionary is
 * reconstruction data, never a source permission, approval seal or cache. */
export async function readRaceManualPooledParentDeltaTransportV1In(
  tx: Transaction,
  rawEvidenceId: unknown,
  rawFreshEncoded: unknown,
  budget: SourceBudget,
) {
  validateRaceSourceResponseBudget(budget);
  const parsedId = uuid.safeParse(rawEvidenceId);
  if (!parsedId.success) invalid();
  plain(rawFreshEncoded);
  // Capture before the await. Later caller mutation cannot change the dictionary
  // sent to SQL or the one used by the strict lossless decoder.
  const base: unknown = structuredClone(rawFreshEncoded);
  const request = JSON.stringify(base);
  if (request === undefined || Buffer.byteLength(request, 'utf8') > 4194304) invalid();
  const remaining = 4194304n - budget.bytes;
  const rows = (
    await tx.query(
      "WITH observed AS MATERIALIZED (SELECT public.read_manual_race_pooled_parent_delta_v1($1::uuid,$2::jsonb) AS value), measured AS MATERIALIZED (SELECT value,octet_length(COALESCE(value::text,'null'))::bigint AS bytes FROM observed) SELECT bytes::text AS bytes,CASE WHEN bytes <= $3::bigint THEN value ELSE NULL END AS value FROM measured",
      [parsedId.data, request, remaining.toString()],
    )
  ).rows;
  plain(rows);
  if (rows.length !== 1) invalid();
  const parsedRow = responseRow.safeParse(rows[0]);
  if (!parsedRow.success) invalid();
  const measured = BigInt(parsedRow.data.bytes);
  if (measured > remaining)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  plain(parsedRow.data.value);
  if (BigInt(Buffer.byteLength(JSON.stringify(parsedRow.data.value), 'utf8')) > measured) invalid();
  reserveSourceBudget(budget, measured, 0);
  if (parsedRow.data.value === null) return unavailable;
  const read = (() => {
    try {
      return parseRaceManualPooledParentDeltaV1(base, parsedRow.data.value);
    } catch {
      return invalid();
    }
  })();
  if (read === null) invalid();
  if (
    read.result.evidenceId !== parsedId.data ||
    (read.payload !== null && read.payload.minimalAudit.athleteId !== tx.athleteId)
  )
    invalid();
  return { status: 'read' as const, ...read };
}
