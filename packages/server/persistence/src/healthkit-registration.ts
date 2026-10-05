import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  healthKitListRegisteredWorkoutsQuerySchema,
  healthKitListRegisteredWorkoutsResultSchema,
  healthKitRegisterWorkoutsResultSchema,
  healthKitRegisterWorkoutsSchema,
  type HealthKitListRegisteredWorkoutsResult,
  type HealthKitRegisterWorkouts,
  type HealthKitRegisterWorkoutsResult,
} from '@workout/contracts/healthkit-registration';
import type { Database } from './database.js';

export class HealthKitRegistrationError extends Error {
  constructor(
    readonly code:
      | 'CONSENT_REQUIRED'
      | 'CONSENT_EPOCH_EXPIRED'
      | 'CLAIM_CONFLICT'
      | 'REGISTRY_REVISION_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT',
  ) {
    super(code);
  }
}

export interface HealthKitRegistrationRepository {
  registerWorkouts(
    athleteId: string,
    input: HealthKitRegisterWorkouts,
  ): Promise<HealthKitRegisterWorkoutsResult>;
  listWorkouts(
    athleteId: string,
    query: z.input<typeof healthKitListRegisteredWorkoutsQuerySchema>,
  ): Promise<HealthKitListRegisteredWorkoutsResult>;
}

const cursorData = z.strictObject({
  revision: z.number().int().min(0).max(2_147_483_647),
  lastSampleId: z.uuid(),
  ownerDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

function decodeCursor(token: string): z.infer<typeof cursorData> {
  try {
    if (Buffer.from(token, 'base64url').toString('base64url') !== token) throw new Error('cursor');
    return cursorData.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  } catch {
    throw new HealthKitRegistrationError('REGISTRY_REVISION_CONFLICT');
  }
}

function encodeCursor(revision: number, lastSampleId: string, athleteId: string): string {
  const ownerDigest = createHash('sha256').update(athleteId).digest('hex');
  return Buffer.from(JSON.stringify({ revision, lastSampleId, ownerDigest })).toString('base64url');
}

function digest(input: HealthKitRegisterWorkouts): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** All writes are one tenant transaction; the global UUID key arbitrates A/B races. */
export function createHealthKitRegistrationRepository(
  database: Database,
): HealthKitRegistrationRepository {
  return {
    registerWorkouts(athleteId, input) {
      const command = healthKitRegisterWorkoutsSchema.parse(input);
      const requestDigest = digest(command);
      return database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const consent = await tx.query(
          'SELECT public.healthkit_ingestion_consent_revision_locked() AS revision',
        );
        if (consent.rows[0]?.['revision'] == null)
          throw new HealthKitRegistrationError('CONSENT_REQUIRED');
        if (consent.rows[0]?.['revision'] !== command.expectedConsentRevision)
          throw new HealthKitRegistrationError('CONSENT_EPOCH_EXPIRED');

        const previous = await tx.query(
          `SELECT request_digest,result_json FROM healthkit_workout_registration_receipt
           WHERE athlete_id=$1 AND idempotency_key=$2`,
          [athleteId, command.idempotencyKey],
        );
        if (previous.rowCount) {
          if (previous.rows[0]?.['request_digest'] !== requestDigest)
            throw new HealthKitRegistrationError('IDEMPOTENCY_CONFLICT');
          return healthKitRegisterWorkoutsResultSchema.parse(previous.rows[0]?.['result_json']);
        }

        const head = await tx.query(
          'SELECT revision FROM healthkit_workout_registry_head WHERE athlete_id=$1',
          [athleteId],
        );
        const currentRevision = head.rows[0]?.['revision'] ?? 0;
        if (
          currentRevision !== command.expectedRegistryRevision ||
          currentRevision === 2_147_483_647
        )
          throw new HealthKitRegistrationError('REGISTRY_REVISION_CONFLICT');

        const epochs = new Map<string, string>();
        // Stable lock order avoids a multi-UUID A/B cycle; any conflict rolls back all claims.
        for (const sampleId of [...command.sampleIds].sort()) {
          const claimEpoch = randomUUID();
          const inserted = await tx.query(
            `INSERT INTO healthkit_workout_claim(sample_id,athlete_id,claim_epoch,consent_revision)
             VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING sample_id`,
            [sampleId, athleteId, claimEpoch, command.expectedConsentRevision],
          );
          if (!inserted.rowCount) throw new HealthKitRegistrationError('CLAIM_CONFLICT');
          epochs.set(sampleId, claimEpoch);
        }
        const nextRevision = currentRevision + 1;
        await tx.query(
          `INSERT INTO healthkit_workout_registry_head(athlete_id,revision) VALUES($1,$2)
           ON CONFLICT(athlete_id) DO UPDATE SET revision=EXCLUDED.revision`,
          [athleteId, nextRevision],
        );
        const result = healthKitRegisterWorkoutsResultSchema.parse({
          schemaVersion: 1,
          claims: command.sampleIds.map((sampleId) => ({
            sampleId,
            claimEpoch: epochs.get(sampleId),
          })),
          registryRevision: nextRevision,
        });
        await tx.query(
          `INSERT INTO healthkit_workout_registration_receipt
             (athlete_id,idempotency_key,request_digest,result_json)
           VALUES($1,$2,$3,$4::jsonb)`,
          [athleteId, command.idempotencyKey, requestDigest, JSON.stringify(result)],
        );
        return result;
      });
    },

    listWorkouts(athleteId, query) {
      const parsed = healthKitListRegisteredWorkoutsQuerySchema.parse(query);
      return database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const consent = await tx.query(
          'SELECT public.healthkit_ingestion_consent_revision_locked() AS revision',
        );
        if (consent.rows[0]?.['revision'] == null)
          throw new HealthKitRegistrationError('CONSENT_REQUIRED');
        const head = await tx.query(
          'SELECT revision FROM healthkit_workout_registry_head WHERE athlete_id=$1',
          [athleteId],
        );
        const revision = (head.rows[0]?.['revision'] ?? 0) as number;
        const after = parsed.cursor ? decodeCursor(parsed.cursor) : null;
        if (
          after &&
          (after.revision !== revision ||
            after.ownerDigest !== createHash('sha256').update(athleteId).digest('hex'))
        )
          throw new HealthKitRegistrationError('REGISTRY_REVISION_CONFLICT');
        const limit = parsed.limit ?? 100;
        const rows = await tx.query(
          `SELECT sample_id,claim_epoch FROM healthkit_workout_claim
           WHERE athlete_id=$1 AND ($2::uuid IS NULL OR sample_id>$2::uuid)
           ORDER BY sample_id LIMIT $3`,
          [athleteId, after?.lastSampleId ?? null, limit + 1],
        );
        const page = rows.rows.slice(0, limit).map((row) => ({
          sampleId: row['sample_id'],
          claimEpoch: row['claim_epoch'],
        }));
        const lastSampleId = page.at(-1)?.sampleId;
        return healthKitListRegisteredWorkoutsResultSchema.parse({
          schemaVersion: 1,
          claims: page,
          registryRevision: revision,
          nextCursor:
            rows.rows.length > limit && typeof lastSampleId === 'string'
              ? encodeCursor(revision, lastSampleId, athleteId)
              : null,
        });
      });
    },
  };
}
