import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  expectedRaceHeadsSchema,
  raceTimingPinV1Schema,
  type RaceTimingPinV1,
} from '@workout/contracts/nutrition-race-timing';
import { raceEventSchema } from '@workout/contracts/races';
import type { Transaction } from './database.js';
import { localInstant } from './integrated-planner.js';

/** The authenticated caller owns the transaction and global→lifecycle→tenant0
 * lock order. This read adapter neither acquires processing permission nor opens
 * a transaction. A supplied port or tenant GUC is not authentication evidence. */
export type RaceTimingQueryPort = Pick<Transaction, 'athleteId' | 'query'>;
export class RaceTimingBindingError extends Error {
  constructor(
    readonly code:
      | 'RACE_TIMING_INVALID_INPUT'
      | 'RACE_TIMING_TENANT_MISMATCH'
      | 'RACE_TIMING_UNAVAILABLE'
      | 'RACE_TIMING_STALE'
      | 'RACE_TIMING_INVALID_SOURCE'
      | 'RACE_TIMING_LIMIT',
  ) {
    super(code);
  }
}
const fail = (code: RaceTimingBindingError['code']): never => {
  throw new RaceTimingBindingError(code);
};
const athleteIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((id) => id.trim() === id);
const valuesSchema = raceEventSchema.omit({ id: true, revision: true });
const headRowSchema = z.strictObject({
  id: z.uuid().refine((id) => id === id.toLowerCase()),
  revision: z.number().int().min(1).max(2147483647),
  values_json: valuesSchema,
  history_revision: z.number().int().min(1).max(2147483647),
  history_values: valuesSchema,
});
const totalsSchema = z.strictObject({
  heads: z.string().regex(/^\d+$/),
  matching_heads: z.string().regex(/^\d+$/),
  histories: z.string().regex(/^\d+$/),
  bytes: z.string().regex(/^\d+$/),
});
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return fail('RACE_TIMING_INVALID_SOURCE');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
function semanticDigest(id: string, revision: number, values: z.infer<typeof valuesSchema>) {
  // Complete validated values, including nulls and immutable Course tuple. This
  // semantic digest is distinct from SQL106 to_jsonb row hashes and artifact HMAC.
  return createHash('sha256')
    .update(
      canonical({
        domain: 'race-event-values-canonical-v1',
        namespace: 'race-event-revision',
        eventId: id,
        eventRevision: revision,
        values,
      }),
      'utf8',
    )
    .digest('hex');
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) return fail('RACE_TIMING_INVALID_SOURCE');
  return result.data;
}

async function read(tx: RaceTimingQueryPort, sql: string, values?: unknown[]) {
  try {
    return await tx.query(sql, values);
  } catch {
    return fail('RACE_TIMING_UNAVAILABLE');
  }
}

/** Captures exact live head/history facts; no history-only fallback or mutable
 * repinning is allowed. Empty expectations remain literal empty after scope check. */
export async function captureRaceTimingPins(
  tx: RaceTimingQueryPort,
  unknownExpectedHeads: unknown,
): Promise<readonly RaceTimingPinV1[]> {
  const parsed = expectedRaceHeadsSchema.safeParse(unknownExpectedHeads);
  if (!parsed.success || !athleteIdSchema.safeParse(tx.athleteId).success)
    return fail('RACE_TIMING_INVALID_INPUT');
  const scope = await read(
    tx,
    "SELECT nullif(current_setting('app.athlete_id',true),'') AS athlete_id",
  );
  if (scope.rows.length !== 1 || scope.rows[0]?.['athlete_id'] !== tx.athleteId)
    return fail('RACE_TIMING_TENANT_MISMATCH');
  const expected = parsed.data;
  if (expected.length === 0) return Object.freeze([]);
  const ids = expected.map((head) => head.eventId);
  const revisions = expected.map((head) => head.revision);
  const totalsResult = await read(
    tx,
    `WITH requested AS (SELECT * FROM unnest($2::uuid[],$3::integer[]) AS r(id,revision))
     SELECT count(h.id)::text AS heads,
       count(h.id) FILTER(WHERE h.revision=r.revision)::text AS matching_heads,
       count(v.entity_id)::text AS histories,
       coalesce(sum(octet_length(h.values_json::text)+octet_length(v.values_json::text)+1024),0)::text AS bytes
     FROM requested r LEFT JOIN race_event h
       ON h.athlete_id=$1 AND h.id=r.id AND NOT h.deleted
     LEFT JOIN race_event_revision v
       ON v.athlete_id=$1 AND v.entity_id=r.id AND v.revision=r.revision`,
    [tx.athleteId, ids, revisions],
  );
  if (totalsResult.rows.length !== 1) return fail('RACE_TIMING_INVALID_SOURCE');
  const totals = decode(totalsSchema, totalsResult.rows[0]);
  if (BigInt(totals.heads) !== BigInt(expected.length)) return fail('RACE_TIMING_UNAVAILABLE');
  if (BigInt(totals.matching_heads) !== BigInt(expected.length)) return fail('RACE_TIMING_STALE');
  if (BigInt(totals.histories) !== BigInt(expected.length))
    return fail('RACE_TIMING_INVALID_SOURCE');
  if (BigInt(totals.bytes) > 4n * 1024n * 1024n) return fail('RACE_TIMING_LIMIT');
  const result = await read(
    tx,
    `SELECT h.id,h.revision,h.values_json,v.revision AS history_revision,v.values_json AS history_values
     FROM race_event h JOIN race_event_revision v
       ON v.athlete_id=h.athlete_id AND v.entity_id=h.id AND v.revision=h.revision
     WHERE h.athlete_id=$1 AND h.id=ANY($2::uuid[]) AND NOT h.deleted ORDER BY h.id`,
    [tx.athleteId, ids],
  );
  if (result.rows.length !== expected.length) return fail('RACE_TIMING_INVALID_SOURCE');
  const pins = result.rows.map((raw, index) => {
    const row = decode(headRowSchema, raw);
    if (
      canonical(raw['values_json']) !== canonical(row.values_json) ||
      canonical(raw['history_values']) !== canonical(row.history_values)
    )
      return fail('RACE_TIMING_INVALID_SOURCE');
    const head = expected[index];
    if (!head || row.id !== head.eventId) return fail('RACE_TIMING_INVALID_SOURCE');
    if (row.revision !== head.revision) return fail('RACE_TIMING_STALE');
    if (
      row.history_revision !== row.revision ||
      canonical(row.values_json) !== canonical(row.history_values)
    )
      return fail('RACE_TIMING_INVALID_SOURCE');
    const values = row.values_json;
    const instant =
      values.localStartTime === null
        ? null
        : localInstant(values.localDate, values.localStartTime, values.timezone);
    return decode(raceTimingPinV1Schema, {
      pinVersion: 1,
      namespace: 'race-event-revision',
      eventId: row.id,
      eventRevision: row.revision,
      sourceDigestVersion: 'race-event-values-canonical-v1',
      sourceDigest: semanticDigest(row.id, row.revision, values),
      localDate: values.localDate,
      localStartTime: values.localStartTime,
      timezone: values.timezone,
      start:
        instant === null
          ? {
              state: 'unknown',
              reason:
                values.localStartTime === null ? 'start_time_not_recorded' : 'ambiguous_local_time',
            }
          : { state: 'known', instant: new Date(instant).toISOString() },
      end: { state: 'unknown', reason: 'race_end_not_recorded' },
    });
  });
  if (Buffer.byteLength(JSON.stringify(pins), 'utf8') > 512 * 1024)
    return fail('RACE_TIMING_LIMIT');
  return Object.freeze(
    pins.map((pin) =>
      Object.freeze({
        ...pin,
        start: Object.freeze(pin.start),
        end: Object.freeze(pin.end),
      }),
    ),
  );
}

/** Fresh comparison only: never substitutes the newly captured values for an
 * immutable stored pin. Retained historical reads do not call this live seam. */
export async function requireFreshRaceTimingPins(
  tx: RaceTimingQueryPort,
  unknownPins: unknown,
): Promise<void> {
  const parsed = z.array(raceTimingPinV1Schema).max(5000).safeParse(unknownPins);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 512 * 1024)
    return fail('RACE_TIMING_INVALID_INPUT');
  const pins = parsed.data;
  const current = await captureRaceTimingPins(
    tx,
    pins.map((pin) => ({
      namespace: 'race-event',
      eventId: pin.eventId,
      revision: pin.eventRevision,
    })),
  );
  if (canonical(pins) !== canonical(current)) return fail('RACE_TIMING_STALE');
}
