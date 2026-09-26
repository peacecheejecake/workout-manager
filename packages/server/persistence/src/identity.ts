import { Pool } from 'pg';
import { z } from 'zod';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const attemptSchema = z.strictObject({
  stateHash: hashSchema,
  browserHash: hashSchema,
  nonce: z.string().min(16).max(256),
  verifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  expiresAt: z.date(),
});
const sessionInputSchema = z.strictObject({
  tokenHash: hashSchema,
  csrfToken: z.string().min(32).max(256),
  issuer: z.url().max(2048),
  subject: z.string().min(1).max(255),
  providerSessionId: z.string().min(1).max(255).optional(),
  expiresAt: z.date(),
  now: z.date(),
  previousTokenHash: hashSchema.optional(),
});
const identitySchema = z.object({ athlete_id: z.string().uuid(), session_id: z.string().uuid() });
const sessionSchema = identitySchema.extend({
  csrf_token: z.string().min(32).max(256),
  expires_at: z.date(),
});
export type LoginAttemptInput = z.infer<typeof attemptSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;
export interface IdentityRepository {
  createAttempt(input: LoginAttemptInput): Promise<void>;
  consumeAttempt(
    stateHash: string,
    browserHash: string,
    now: Date,
  ): Promise<{ nonce: string; verifier: string } | null>;
  createSession(input: SessionInput): Promise<{ athleteId: string; sessionId: string }>;
  findSession(
    tokenHash: string,
    now: Date,
  ): Promise<{ athleteId: string; sessionId: string; csrfToken: string; expiresAt: Date } | null>;
  revokeSession(tokenHash: string): Promise<void>;
  revokeProviderSessions(input: {
    issuer: string;
    jtiHash: string;
    issuedAt: Date;
    subject?: string;
    providerSessionId?: string;
  }): Promise<boolean>;
  close(): Promise<void>;
}

/** Pre-tenant lookup uses only granted functions; runtime cannot SELECT identity tables. */
export function createIdentityRepository(options: {
  connectionString: string;
  max?: number;
}): IdentityRepository {
  const pool = new Pool({
    ...options,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
  });
  async function query(sql: string, values: unknown[]) {
    const client = await pool.connect();
    try {
      const role = await client.query(`SELECT r.rolsuper, r.rolbypassrls,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'identity_private' AND c.relowner = r.oid) AS owns_identity
        FROM pg_roles r WHERE r.rolname = current_user`);
      z.object({
        rolsuper: z.literal(false),
        rolbypassrls: z.literal(false),
        owns_identity: z.literal(false),
      }).parse(role.rows[0]);
      return await client.query<Record<string, unknown>>(sql, values);
    } finally {
      client.release();
    }
  }
  return {
    async createAttempt(input) {
      const value = attemptSchema.parse(input);
      await query('SELECT public.auth_create_attempt($1, $2, $3, $4, $5)', [
        value.stateHash,
        value.browserHash,
        value.nonce,
        value.verifier,
        value.expiresAt,
      ]);
    },
    async consumeAttempt(stateHash, browserHash, now) {
      hashSchema.parse(stateHash);
      hashSchema.parse(browserHash);
      z.date().parse(now);
      const result = await query('SELECT * FROM public.auth_consume_attempt($1, $2, $3)', [
        stateHash,
        browserHash,
        now,
      ]);
      return result.rows.length === 0
        ? null
        : z
            .object({ nonce: attemptSchema.shape.nonce, verifier: attemptSchema.shape.verifier })
            .parse(result.rows[0]);
    },
    async createSession(input) {
      const value = sessionInputSchema.parse(input);
      const result = await query(
        'SELECT * FROM public.auth_create_session($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          value.tokenHash,
          value.csrfToken,
          value.issuer,
          value.subject,
          value.expiresAt,
          value.now,
          value.previousTokenHash ?? null,
          value.providerSessionId ?? null,
        ],
      );
      const identity = identitySchema.parse(result.rows[0]);
      return { athleteId: identity.athlete_id, sessionId: identity.session_id };
    },
    async findSession(tokenHash, now) {
      hashSchema.parse(tokenHash);
      z.date().parse(now);
      const result = await query('SELECT * FROM public.auth_find_session($1, $2)', [
        tokenHash,
        now,
      ]);
      if (result.rows.length === 0) return null;
      const session = sessionSchema.parse(result.rows[0]);
      return {
        athleteId: session.athlete_id,
        sessionId: session.session_id,
        csrfToken: session.csrf_token,
        expiresAt: session.expires_at,
      };
    },
    async revokeSession(tokenHash) {
      hashSchema.parse(tokenHash);
      await query('SELECT public.auth_revoke_session($1)', [tokenHash]);
    },
    async revokeProviderSessions(input) {
      const value = z
        .strictObject({
          issuer: z.url().max(2048),
          jtiHash: hashSchema,
          issuedAt: z.date(),
          subject: z.string().min(1).max(255).optional(),
          providerSessionId: z.string().min(1).max(255).optional(),
        })
        .refine((claims) => claims.subject !== undefined || claims.providerSessionId !== undefined)
        .parse(input);
      const result = await query(
        'SELECT public.auth_revoke_provider_sessions($1, $2, $3, $4, $5) AS accepted',
        [
          value.issuer,
          value.jtiHash,
          value.issuedAt,
          value.subject ?? null,
          value.providerSessionId ?? null,
        ],
      );
      return z.object({ accepted: z.boolean() }).parse(result.rows[0]).accepted;
    },
    close: () => pool.end(),
  };
}
