import { z } from 'zod';
import type { Transaction } from './database.js';

const eventSchema = z.object({
  id: z.uuid(),
  idempotencyKey: z.string().min(1).max(200),
  topic: z.string().min(1).max(100),
  payload: z.json(),
});
export type OutboxEvent = z.infer<typeof eventSchema>;
export class PersistenceConflict extends Error {
  constructor(public readonly code: 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT') {
    super(code);
  }
}
export async function enqueue(transaction: Transaction, input: OutboxEvent): Promise<string> {
  const event = eventSchema.parse(input);
  const payload = JSON.stringify(event.payload);
  if (Buffer.byteLength(payload) > 64000) throw new Error('OUTBOX_PAYLOAD_TOO_LARGE');
  const result = await transaction.query(
    `INSERT INTO outbox (athlete_id, id, idempotency_key, topic, payload)
    VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (athlete_id, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    WHERE outbox.topic = EXCLUDED.topic AND outbox.payload = EXCLUDED.payload RETURNING id`,
    [transaction.athleteId, event.id, event.idempotencyKey, event.topic, payload],
  );
  if (result.rows.length === 0) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return z.uuid().parse(result.rows[0]?.['id']);
}
export interface LeasedEvent {
  id: string;
  topic: string;
  payload: z.infer<ReturnType<typeof z.json>>;
  attempts: number;
  leaseToken: string;
}
const leasedSchema = z.object({
  id: z.uuid(),
  topic: z.string(),
  payload: z.json(),
  attempts: z.number().int().positive(),
  lease_token: z.uuid(),
});
/** A tenant-scoped worker claims at most one event. No process-global privileged worker bypass. */
export async function claim(
  transaction: Transaction,
  leaseToken: string,
  leaseSeconds = 30,
): Promise<LeasedEvent | null> {
  z.uuid().parse(leaseToken);
  z.number().int().min(1).max(300).parse(leaseSeconds);
  const result = await transaction.query(
    `WITH next AS (
    SELECT id FROM outbox WHERE athlete_id = $1 AND completed_at IS NULL AND available_at <= clock_timestamp()
    AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE outbox SET lease_token = $2, lease_until = clock_timestamp() + make_interval(secs => $3), attempts = attempts + 1
  WHERE athlete_id = $1 AND id IN (SELECT id FROM next) RETURNING id, topic, payload, attempts, lease_token`,
    [transaction.athleteId, leaseToken, leaseSeconds],
  );
  if (result.rows.length === 0) return null;
  const row = leasedSchema.parse(result.rows[0]);
  return {
    id: row.id,
    topic: row.topic,
    payload: row.payload,
    attempts: row.attempts,
    leaseToken: row.lease_token,
  };
}
/** Claim only the named topic so a coaching worker cannot consume unrelated jobs. */
export async function claimTopic(
  transaction: Transaction,
  topic: string,
  leaseToken: string,
  leaseSeconds = 30,
): Promise<LeasedEvent | null> {
  z.string().min(1).max(100).parse(topic);
  z.uuid().parse(leaseToken);
  z.number().int().min(1).max(300).parse(leaseSeconds);
  const result = await transaction.query(
    `WITH next AS (
      SELECT id FROM outbox WHERE athlete_id=$1 AND topic=$2 AND completed_at IS NULL
       AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE outbox SET lease_token=$3,
      lease_until=clock_timestamp()+make_interval(secs => $4),attempts=attempts+1
    WHERE athlete_id=$1 AND id IN (SELECT id FROM next)
    RETURNING id,topic,payload,attempts,lease_token`,
    [transaction.athleteId, topic, leaseToken, leaseSeconds],
  );
  if (!result.rows[0]) return null;
  const row = leasedSchema.parse(result.rows[0]);
  return {
    id: row.id,
    topic: row.topic,
    payload: row.payload,
    attempts: row.attempts,
    leaseToken: row.lease_token,
  };
}
/** Acknowledge in the same transaction as consumer effects; expired or replaced leases cannot acknowledge. */
export async function complete(
  transaction: Transaction,
  id: string,
  leaseToken: string,
): Promise<boolean> {
  z.uuid().parse(id);
  z.uuid().parse(leaseToken);
  const result = await transaction.query(
    `UPDATE outbox SET completed_at = clock_timestamp(), lease_token = NULL, lease_until = NULL
    WHERE athlete_id = $1 AND id = $2 AND lease_token = $3 AND lease_until > clock_timestamp() AND completed_at IS NULL`,
    [transaction.athleteId, id, leaseToken],
  );
  return result.rowCount === 1;
}
export async function retry(
  transaction: Transaction,
  id: string,
  leaseToken: string,
  delaySeconds: number,
): Promise<boolean> {
  z.uuid().parse(id);
  z.uuid().parse(leaseToken);
  z.number().int().min(0).max(86400).parse(delaySeconds);
  const result = await transaction.query(
    `UPDATE outbox SET available_at = clock_timestamp() + make_interval(secs => $4), lease_token = NULL, lease_until = NULL
    WHERE athlete_id = $1 AND id = $2 AND lease_token = $3 AND lease_until > clock_timestamp() AND completed_at IS NULL`,
    [transaction.athleteId, id, leaseToken, delaySeconds],
  );
  return result.rowCount === 1;
}
