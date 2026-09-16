import { Pool } from 'pg';
import { z } from 'zod';
import { TenantErasedError, type Database, type Transaction } from './database.js';

const cipherSchema = z.strictObject({
  keyId: z.string().min(1).max(100),
  iv: z.string().min(16).max(64),
  ciphertext: z.string().min(1).max(60000),
  tag: z.string().min(22).max(64),
});
export type GarminCipher = z.infer<typeof cipherSchema>;
type Scope = { athleteId: string; sessionId: string; now: Date };
type Tokens = { encryptedTokens: GarminCipher; accessExpiresAt: Date; refreshExpiresAt: Date };
const connectionSchema = z.object({
  generation: z.number().int(),
  state: z.enum(['disconnected', 'connecting', 'connected', 'reconnect_required']),
  user_id: z.string().nullable(),
  permissions: z.array(z.string()),
  encrypted_tokens: cipherSchema.nullable(),
  connected_at: z.date().nullable(),
  access_expires_at: z.date().nullable(),
  refresh_expires_at: z.date().nullable(),
  attempt_expires_at: z.date().nullable(),
  attempt_session_id: z.string().nullable(),
});
export class GarminStoreError extends Error {
  constructor(readonly code: 'CONNECTION_BUSY' | 'INVALID_SESSION') {
    super(code);
  }
}
async function sessionActive(tx: Transaction, sessionId: string, now: Date): Promise<boolean> {
  const result = await tx.query('SELECT public.garmin_session_active($1,$2,$3) AS valid', [
    tx.athleteId,
    sessionId,
    now,
  ]);
  return result.rows[0]?.['valid'] === true;
}
async function lockConnection(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77207))', [tx.athleteId]);
}
async function booleanUnlessErased(operation: () => Promise<boolean>): Promise<boolean> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TenantErasedError) return false;
    throw error;
  }
}
function validateTokens(input: Tokens) {
  cipherSchema.parse(input.encryptedTokens);
  z.date().parse(input.accessExpiresAt);
  z.date().parse(input.refreshExpiresAt);
}
function validateLease(input: { leaseId: string; now: Date; leaseUntil: Date }) {
  z.uuid().parse(input.leaseId);
  if (input.leaseUntil <= input.now || input.leaseUntil.getTime() - input.now.getTime() > 120000)
    throw new Error('INVALID_LEASE');
}
export function createGarminStore(database: Database) {
  return {
    async createAttempt(
      input: Scope & { stateHash: string; encryptedVerifier: GarminCipher; expiresAt: Date },
    ): Promise<{ generation: number }> {
      z.string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(input.stateHash);
      cipherSchema.parse(input.encryptedVerifier);
      if (input.expiresAt <= input.now || input.expiresAt.getTime() - input.now.getTime() > 600000)
        throw new Error('INVALID_ATTEMPT_EXPIRY');
      return database.tenant(input.athleteId, async (tx) => {
        if (!(await sessionActive(tx, input.sessionId, input.now)))
          throw new GarminStoreError('INVALID_SESSION');
        await lockConnection(tx);
        await tx.query(
          'INSERT INTO garmin_connection(athlete_id) VALUES($1) ON CONFLICT DO NOTHING',
          [input.athleteId],
        );
        const current = await tx.query(
          'SELECT encrypted_tokens IS NOT NULL OR public.garmin_pending($2) AS busy FROM garmin_connection WHERE athlete_id=$1',
          [input.athleteId, input.now],
        );
        if (current.rows[0]?.['busy'] === true) throw new GarminStoreError('CONNECTION_BUSY');
        const result = await tx.query(
          "UPDATE garmin_connection SET generation=generation+1,state='connecting',attempt_expires_at=$2,attempt_session_id=$3 WHERE athlete_id=$1 RETURNING generation",
          [input.athleteId, input.expiresAt, input.sessionId],
        );
        const generation = z.number().int().parse(result.rows[0]?.['generation']);
        await tx.query('DELETE FROM garmin_attempt WHERE athlete_id=$1', [input.athleteId]);
        await tx.query(
          'INSERT INTO garmin_attempt(athlete_id,state_hash,session_id,generation,encrypted_verifier,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            input.athleteId,
            input.stateHash,
            input.sessionId,
            generation,
            JSON.stringify(input.encryptedVerifier),
            input.now,
            input.expiresAt,
          ],
        );
        return { generation };
      });
    },
    async consumeAttempt(
      input: Scope & { stateHash: string },
    ): Promise<{ generation: number; encryptedVerifier: GarminCipher } | null> {
      try {
        return await database.tenant(input.athleteId, async (tx) => {
          if (!(await sessionActive(tx, input.sessionId, input.now))) return null;
          await lockConnection(tx);
          const result = await tx.query(
            'DELETE FROM garmin_attempt WHERE athlete_id=$1 AND state_hash=$2 AND session_id=$3 RETURNING generation,encrypted_verifier,expires_at',
            [input.athleteId, input.stateHash, input.sessionId],
          );
          if (!result.rows[0]) return null;
          const row = z
            .object({
              generation: z.number().int(),
              encrypted_verifier: cipherSchema,
              expires_at: z.date(),
            })
            .parse(result.rows[0]);
          return row.expires_at > input.now
            ? { generation: row.generation, encryptedVerifier: row.encrypted_verifier }
            : null;
        });
      } catch (error) {
        if (error instanceof TenantErasedError) return null;
        throw error;
      }
    },
    async failAttempt(input: Scope & { generation: number }): Promise<void> {
      await booleanUnlessErased(() =>
        database.tenant(input.athleteId, async (tx) => {
          await lockConnection(tx);
          await tx.query(
            "UPDATE garmin_connection SET state='disconnected',generation=generation+1,attempt_expires_at=NULL,attempt_session_id=NULL WHERE athlete_id=$1 AND generation=$2 AND state='connecting' AND attempt_session_id=$3",
            [input.athleteId, input.generation, input.sessionId],
          );
          await tx.query(
            'DELETE FROM garmin_attempt WHERE athlete_id=$1 AND generation=$2 AND session_id=$3',
            [input.athleteId, input.generation, input.sessionId],
          );
          return true;
        }),
      );
    },
    async commitConnection(
      input: Scope & Tokens & { generation: number; userId: string; permissions: string[] },
    ): Promise<boolean> {
      validateTokens(input);
      z.string().min(1).max(200).parse(input.userId);
      z.array(z.string().min(1).max(100)).max(32).parse(input.permissions);
      return booleanUnlessErased(() =>
        database.tenant(input.athleteId, async (tx) => {
          if (!(await sessionActive(tx, input.sessionId, input.now))) return false;
          await lockConnection(tx);
          const row = await tx.query(
            "SELECT 1 FROM garmin_connection WHERE athlete_id=$1 AND generation=$2 AND state='connecting' AND attempt_session_id=$3 AND attempt_expires_at>$4 AND NOT EXISTS(SELECT 1 FROM garmin_attempt WHERE athlete_id=$1 AND generation=$2)",
            [input.athleteId, input.generation, input.sessionId, input.now],
          );
          if (row.rows.length === 0) return false;
          const claim = await tx.query('SELECT public.garmin_claim_user($1,$2) AS claimed', [
            input.userId,
            input.now,
          ]);
          if (claim.rows[0]?.['claimed'] !== true) return false;
          await tx.query(
            "UPDATE garmin_connection SET state='connected',user_id=$3,permissions=$4,encrypted_tokens=$5,access_expires_at=$6,refresh_expires_at=$7,connected_at=$8,attempt_expires_at=NULL,attempt_session_id=NULL WHERE athlete_id=$1 AND generation=$2",
            [
              input.athleteId,
              input.generation,
              input.userId,
              JSON.stringify(input.permissions),
              JSON.stringify(input.encryptedTokens),
              input.accessExpiresAt,
              input.refreshExpiresAt,
              input.now,
            ],
          );
          await tx.query('DELETE FROM garmin_attempt WHERE athlete_id=$1', [input.athleteId]);
          return true;
        }),
      );
    },
    async status(athleteId: string) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          'SELECT *,public.garmin_pending(clock_timestamp()) AS pending,public.garmin_session_active($1,attempt_session_id,clock_timestamp()) AS attempt_live FROM garmin_connection WHERE athlete_id=$1',
          [athleteId],
        );
        if (!result.rows[0])
          return {
            state: 'disconnected' as const,
            generation: 0,
            userId: null,
            permissions: [],
            connectedAt: null,
            accessExpiresAt: null,
            refreshExpiresAt: null,
          };
        const row = connectionSchema
          .extend({ pending: z.boolean(), attempt_live: z.boolean() })
          .parse(result.rows[0]);
        const state = row.pending
          ? ('disconnecting' as const)
          : row.state === 'connecting' &&
              (!row.attempt_live || !row.attempt_expires_at || row.attempt_expires_at <= new Date())
            ? ('disconnected' as const)
            : row.state === 'connected' &&
                row.refresh_expires_at &&
                row.refresh_expires_at <= new Date()
              ? ('reconnect_required' as const)
              : row.state;
        return {
          state,
          generation: row.generation,
          userId: row.user_id,
          permissions: row.permissions,
          connectedAt: row.connected_at,
          accessExpiresAt: row.access_expires_at,
          refreshExpiresAt: row.refresh_expires_at,
        };
      });
    },
    async disconnect(input: { athleteId: string; now: Date }): Promise<void> {
      await database.tenant(input.athleteId, async (tx) => {
        await lockConnection(tx);
        await tx.query('SELECT public.garmin_disconnect($1)', [input.now]);
      });
    },
    async queueRevoke(
      input: { athleteId: string; userId: string | null; now: Date } & Tokens,
    ): Promise<void> {
      validateTokens(input);
      // This narrowly scoped cleanup can be registered after the account-erasure gate closes.
      await database.exclusiveTenant(input.athleteId, async (tx) => {
        await lockConnection(tx);
        await tx.query('SELECT public.garmin_queue_revoke($1,$2,$3,$4,$5)', [
          JSON.stringify(input.encryptedTokens),
          input.userId,
          input.accessExpiresAt,
          input.refreshExpiresAt,
          input.now,
        ]);
      });
    },
    async leaseRefresh(input: { athleteId: string; now: Date; leaseId: string; leaseUntil: Date }) {
      validateLease(input);
      return database.tenant(input.athleteId, async (tx) => {
        await lockConnection(tx);
        const result = await tx.query(
          "UPDATE garmin_connection SET lease_id=$2,lease_until=$4 WHERE athlete_id=$1 AND state='connected' AND refresh_expires_at>$3 AND (lease_until IS NULL OR lease_until<=$3) RETURNING generation,user_id,encrypted_tokens,access_expires_at,refresh_expires_at",
          [input.athleteId, input.leaseId, input.now, input.leaseUntil],
        );
        if (!result.rows[0]) return null;
        const row = z
          .object({
            generation: z.number().int(),
            user_id: z.string(),
            encrypted_tokens: cipherSchema,
            access_expires_at: z.date(),
            refresh_expires_at: z.date(),
          })
          .parse(result.rows[0]);
        return {
          generation: row.generation,
          userId: row.user_id,
          encryptedTokens: row.encrypted_tokens,
          accessExpiresAt: row.access_expires_at,
          refreshExpiresAt: row.refresh_expires_at,
        };
      });
    },
    async commitRefresh(
      input: { athleteId: string; generation: number; leaseId: string; now: Date } & Tokens,
    ): Promise<boolean> {
      validateTokens(input);
      return booleanUnlessErased(() =>
        database.tenant(input.athleteId, async (tx) => {
          await lockConnection(tx);
          const result = await tx.query(
            "UPDATE garmin_connection SET generation=generation+1,encrypted_tokens=$4,access_expires_at=$5,refresh_expires_at=$6,lease_id=NULL,lease_until=NULL WHERE athlete_id=$1 AND generation=$2 AND lease_id=$3 AND lease_until>$7 AND state='connected' RETURNING athlete_id",
            [
              input.athleteId,
              input.generation,
              input.leaseId,
              JSON.stringify(input.encryptedTokens),
              input.accessExpiresAt,
              input.refreshExpiresAt,
              input.now,
            ],
          );
          return result.rows.length === 1;
        }),
      );
    },
    async failRefresh(input: {
      athleteId: string;
      generation: number;
      leaseId: string;
      now: Date;
      reconnectRequired: boolean;
    }): Promise<void> {
      await booleanUnlessErased(() =>
        database.tenant(input.athleteId, async (tx) => {
          await lockConnection(tx);
          await tx.query(
            "UPDATE garmin_connection SET state=CASE WHEN $4 THEN 'reconnect_required' ELSE state END,lease_id=NULL,lease_until=NULL WHERE athlete_id=$1 AND generation=$2 AND lease_id=$3",
            [input.athleteId, input.generation, input.leaseId, input.reconnectRequired],
          );
          return true;
        }),
      );
    },
  };
}

export function createGarminRevocationStore(options: { connectionString: string }) {
  const pool = new Pool({ ...options, max: 2, connectionTimeoutMillis: 5000 });
  return {
    async leaseRevocation(input: { now: Date; leaseId: string; leaseUntil: Date }) {
      validateLease(input);
      const result = await pool.query('SELECT * FROM public.garmin_lease_revocation($1,$2,$3)', [
        input.leaseId,
        input.now,
        input.leaseUntil,
      ]);
      if (!result.rows[0]) return null;
      const row = z
        .object({
          id: z.uuid(),
          athlete_id: z.string(),
          encrypted_tokens: cipherSchema,
          access_expires_at: z.date(),
          refresh_expires_at: z.date(),
          expires_at: z.date(),
        })
        .parse(result.rows[0]);
      return {
        id: row.id,
        athleteId: row.athlete_id,
        encryptedTokens: row.encrypted_tokens,
        accessExpiresAt: row.access_expires_at,
        refreshExpiresAt: row.refresh_expires_at,
        expiresAt: row.expires_at,
      };
    },
    async prepareRevocation(input: {
      id: string;
      leaseId: string;
      userId: string;
      now: Date;
    }): Promise<boolean> {
      const result = await pool.query(
        'SELECT public.garmin_prepare_revocation($1,$2,$3,$4) AS prepared',
        [input.id, input.leaseId, input.userId, input.now],
      );
      return result.rows[0]?.prepared === true;
    },
    async updateRevocationTokens(
      input: { id: string; leaseId: string; now: Date } & Tokens,
    ): Promise<boolean> {
      validateTokens(input);
      const result = await pool.query(
        'SELECT public.garmin_update_revocation($1,$2,$3,$4,$5,$6) AS updated',
        [
          input.id,
          input.leaseId,
          JSON.stringify(input.encryptedTokens),
          input.accessExpiresAt,
          input.refreshExpiresAt,
          input.now,
        ],
      );
      return result.rows[0]?.updated === true;
    },
    async finishRevocation(input: {
      id: string;
      leaseId: string;
      success: boolean;
      now: Date;
    }): Promise<void> {
      await pool.query('SELECT public.garmin_finish_revocation($1,$2,$3,$4)', [
        input.id,
        input.leaseId,
        input.success,
        input.now,
      ]);
    },
    close: () => pool.end(),
  };
}
