import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
export { PersistenceConflict } from './outbox.js';

export const consentKindSchema = z.enum(['app', 'provider', 'ai', 'healthkit', 'media']);
const consentSchema = z.object({
  kind: consentKindSchema,
  granted: z.boolean(),
  revision: z.number().int().nonnegative(),
});
const updateSchema = z
  .object({
    kind: consentKindSchema,
    granted: z.boolean(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export type ConsentKind = z.infer<typeof consentKindSchema>;
export type Consent = z.infer<typeof consentSchema>;
export type ConsentUpdate = z.infer<typeof updateSchema>;
export interface ConsentRepository {
  getConsent(athleteId: string, kind: ConsentKind): Promise<Consent>;
  setConsent(athleteId: string, input: ConsentUpdate): Promise<Consent>;
}
export function createConsentRepository(database: Database): ConsentRepository {
  return {
    getConsent(athleteId, kind) {
      consentKindSchema.parse(kind);
      return database.tenant(athleteId, async (transaction) => {
        const result = await transaction.query(
          'SELECT kind, granted, revision FROM consent WHERE athlete_id = $1 AND kind = $2',
          [athleteId, kind],
        );
        return result.rows.length === 0
          ? { kind, granted: false, revision: 0 }
          : consentSchema.parse(result.rows[0]);
      });
    },
    setConsent(athleteId, input) {
      const update = updateSchema.parse(input);
      const request = {
        kind: update.kind,
        granted: update.granted,
        expectedRevision: update.expectedRevision,
      };
      return database.tenant(athleteId, async (transaction) => {
        // Lock the tenant command stream so absent consent heads and receipts serialize too.
        await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          athleteId,
        ]);
        const previous = await transaction.query(
          'SELECT request = $3::jsonb AS matches, result FROM command_receipt WHERE athlete_id = $1 AND idempotency_key = $2',
          [athleteId, update.idempotencyKey, JSON.stringify(request)],
        );
        if (previous.rows.length > 0) {
          if (previous.rows[0]?.['matches'] !== true)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return consentSchema.parse(previous.rows[0]?.['result']);
        }
        const result = await transaction.query(
          `INSERT INTO consent (athlete_id, kind, granted, revision)
          SELECT $1, $2, $3, 1 WHERE $4::integer = 0
          ON CONFLICT (athlete_id, kind) DO NOTHING RETURNING kind, granted, revision`,
          [athleteId, update.kind, update.granted, update.expectedRevision],
        );
        if (result.rows.length === 0) {
          const changed = await transaction.query(
            `UPDATE consent SET granted = $3, revision = revision + 1
            WHERE athlete_id = $1 AND kind = $2 AND revision = $4 RETURNING kind, granted, revision`,
            [athleteId, update.kind, update.granted, update.expectedRevision],
          );
          result.rows = changed.rows;
        }
        if (result.rows.length === 0) throw new PersistenceConflict('REVISION_CONFLICT');
        const consent = consentSchema.parse(result.rows[0]);
        await enqueue(transaction, {
          id: randomUUID(),
          idempotencyKey: update.idempotencyKey,
          topic: 'consent.changed',
          payload: consent,
        });
        await transaction.query(
          'INSERT INTO command_receipt (athlete_id, idempotency_key, request, result) VALUES ($1, $2, $3::jsonb, $4::jsonb)',
          [athleteId, update.idempotencyKey, JSON.stringify(request), JSON.stringify(consent)],
        );
        return consent;
      });
    },
  };
}
