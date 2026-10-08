import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  sessionCompletionSchema,
  preservesSessionCompletions,
} from '@workout/contracts/session-completion';
import type { Transaction } from './database.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  impactDependencyDigest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
import {
  RacePlanImpactContextError,
  validateRaceSourceResponseBudget,
} from './race-plan-impact-context.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2147483647);
const commandSchema = z.strictObject({ eventId: uuid, expectedRevision: revision });
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(100);
const scalarSchema = z.strictObject({
  bytes: decimal,
  sources: decimal,
  heads: decimal,
  completions: decimal,
});
const snapshotRowSchema = z.strictObject({
  aggregate_id: uuid,
  id: uuid,
  version: revision,
  created_at: z.string(),
  draft: z.unknown(),
});
function fail(
  code: RacePlanImpactContextError['code'],
  bound?: RacePlanImpactContextError['bound'],
): never {
  throw new RacePlanImpactContextError(code, bound);
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const value = schema.safeParse(raw);
  return value.success ? value.data : fail('INVALID_CONTEXT');
}
function reserve(budget: SourceBudget, bytes: bigint, sources = 0) {
  try {
    reserveSourceBudget(budget, bytes, sources);
  } catch (error) {
    if (error instanceof RaceImpactDependencyError)
      throw new RacePlanImpactContextError(error.code, error.bound);
    throw error;
  }
}

/** Preliminary calendar inputs only, read in the caller's authenticated fenced tx.
 * The final full collector re-reads every root and validates complete source/history
 * correspondence. This is neither a retained capture nor a freshness/permission seal.
 * RC callers retain their old isolation semantics; coherent services require snapshotTenant.
 */
export async function captureRacePlanImpactCalendarRootsIn(
  tx: Transaction,
  unknownCommand: unknown,
  budget: SourceBudget,
) {
  validateRaceSourceResponseBudget(budget);
  const command = parse(commandSchema, unknownCommand);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
  // Reserve bounded scalar response before transport, then every body visit before reads.
  reserve(budget, 512n);
  const scalar = parse(
    scalarSchema,
    (
      await tx.query(
        `WITH
    event AS MATERIALIZED (SELECT id,revision,values_json FROM race_event WHERE athlete_id=$1 AND id=$2 AND NOT deleted),
    history AS MATERIALIZED (SELECT h.values_json FROM race_event_revision h JOIN event e ON h.entity_id=e.id AND h.revision=e.revision WHERE h.athlete_id=$1),
    current AS MATERIALIZED (SELECT h.aggregate_id,p.id,p.version,p.created_at,p.draft FROM plan_head h LEFT JOIN plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id WHERE h.athlete_id=$1 LIMIT 2),
    completions AS MATERIALIZED (SELECT session_id,revision,record_json FROM session_completion WHERE athlete_id=$1 ORDER BY session_id LIMIT 1001),
    bodies AS (SELECT to_jsonb(e) AS body FROM event e UNION ALL SELECT to_jsonb(h) FROM history h UNION ALL SELECT to_jsonb(c) FROM current c UNION ALL SELECT to_jsonb(c) FROM completions c)
    SELECT (coalesce(sum(coalesce(octet_length(body::text),0)+1024),0)+512)::text AS bytes,
      count(*)::text AS sources,(SELECT count(*)::text FROM current) AS heads,
      (SELECT count(*)::text FROM completions) AS completions FROM bodies`,
        [tx.athleteId, command.eventId],
      )
    ).rows[0],
  );
  if (BigInt(scalar.heads) > 1n) fail('INVALID_CONTEXT');
  if (BigInt(scalar.completions) > 1000n) fail('CONTEXT_LIMIT');
  const sources = BigInt(scalar.sources);
  if (sources > 5000n) fail('CONTEXT_UNAVAILABLE', 'unique_sources');
  // 512 is the minimum fixed body-envelope reservation, never caller measured authority.
  if (BigInt(scalar.bytes) < 512n) fail('INVALID_CONTEXT');
  reserve(budget, BigInt(scalar.bytes), Number(sources));
  let transportedBodyBytes = 0n;
  function body(raw: unknown) {
    const encoded = JSON.stringify(raw);
    if (encoded === undefined) fail('INVALID_CONTEXT');
    transportedBodyBytes += BigInt(Buffer.byteLength(encoded, 'utf8'));
    if (transportedBodyBytes > BigInt(scalar.bytes)) fail('INVALID_CONTEXT');
  }
  const eventRaw = (
    await tx.query(
      'SELECT id,revision,values_json FROM race_event WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
      [tx.athleteId, command.eventId],
    )
  ).rows[0];
  if (!eventRaw) fail('EVENT_UNAVAILABLE');
  const eventRow = parse(
    z.strictObject({ id: uuid, revision, values_json: z.record(z.string(), z.unknown()) }),
    eventRaw,
  );
  body(eventRow.values_json);
  const event = parse(raceEventSchema, {
    ...eventRow.values_json,
    id: eventRow.id,
    revision: eventRow.revision,
  });
  if (event.id !== command.eventId) fail('INVALID_CONTEXT');
  if (event.revision !== command.expectedRevision) fail('REVISION_CONFLICT');
  const history = (
    await tx.query(
      'SELECT values_json FROM race_event_revision WHERE athlete_id=$1 AND entity_id=$2 AND revision=$3',
      [tx.athleteId, event.id, event.revision],
    )
  ).rows[0];
  if (
    !history ||
    impactDependencyDigest(history['values_json']) !== impactDependencyDigest(eventRow.values_json)
  )
    fail('INVALID_CONTEXT');
  body(history['values_json']);
  const currentRows = (
    await tx.query(
      `SELECT h.aggregate_id,p.id,p.version,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,p.draft FROM plan_head h LEFT JOIN plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id WHERE h.athlete_id=$1 LIMIT 2`,
      [tx.athleteId],
    )
  ).rows;
  if (currentRows.length > 1 || currentRows.length !== Number(scalar.heads))
    fail('INVALID_CONTEXT');
  const rawCurrent = currentRows[0];
  const row = rawCurrent ? parse(snapshotRowSchema, rawCurrent) : null;
  if (row) body(row.draft);
  const currentTraining = row
    ? {
        aggregateId: row.aggregate_id,
        snapshot: parse(planSnapshotSchema, {
          id: row.id,
          version: row.version,
          createdAt: row.created_at,
          draft: row.draft,
        }),
      }
    : null;
  const completionRows = (
    await tx.query(
      'SELECT session_id,revision,record_json FROM session_completion WHERE athlete_id=$1 ORDER BY session_id LIMIT 1001',
      [tx.athleteId],
    )
  ).rows;
  if (completionRows.length > 1000) fail('CONTEXT_LIMIT');
  if (completionRows.length !== Number(scalar.completions)) fail('INVALID_CONTEXT');
  const completions = completionRows.map((raw) => {
    const completion = parse(
      z.strictObject({
        session_id: z.string().min(1).max(200),
        revision,
        record_json: sessionCompletionSchema,
      }),
      raw,
    );
    body(completion.record_json);
    if (
      completion.record_json.sessionId !== completion.session_id ||
      completion.record_json.revision !== completion.revision
    )
      fail('INVALID_CONTEXT');
    if (
      completion.record_json.status === 'completed' &&
      (!currentTraining ||
        !currentTraining.snapshot.draft.sessions.some(
          (session) => session.id === completion.session_id,
        ))
    )
      fail('INVALID_CONTEXT');
    return completion.record_json;
  });
  if (currentTraining && !preservesSessionCompletions(currentTraining.snapshot.draft, completions))
    fail('INVALID_CONTEXT');
  if (sources !== 2n + BigInt(currentRows.length) + BigInt(completionRows.length))
    fail('INVALID_CONTEXT');
  // Final full collection validates linked/history Plan bodies; no preliminary head substitute.
  return { event, currentTraining, completions };
}
