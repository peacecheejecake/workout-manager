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
  loginStartedAt: z.date(),
  previousTokenHash: hashSchema.optional(),
});
const identitySchema = z.object({ athlete_id: z.string().uuid(), session_id: z.string().uuid() });
const sessionSchema = identitySchema.extend({
  csrf_token: z.string().min(32).max(256),
  expires_at: z.date(),
});
const nativeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const nativeAttemptSchema = z.strictObject({
  stateHash: hashSchema,
  nonce: attemptSchema.shape.nonce,
  verifier: attemptSchema.shape.verifier,
  codeChallenge: nativeChallengeSchema,
  expiresAt: z.date(),
});
const nativeCodeSchema = z.strictObject({
  codeHash: hashSchema,
  codeChallenge: nativeChallengeSchema,
  issuer: sessionInputSchema.shape.issuer,
  subject: sessionInputSchema.shape.subject,
  providerSessionId: sessionInputSchema.shape.providerSessionId,
  loginStartedAt: z.date(),
  expiresAt: z.date(),
  now: z.date(),
});
const nativeExchangeSchema = z.strictObject({
  codeHash: hashSchema,
  codeChallenge: nativeChallengeSchema,
  tokenHash: hashSchema,
  csrfToken: sessionInputSchema.shape.csrfToken,
  expiresAt: z.date(),
  now: z.date(),
});
export type LoginAttemptInput = z.infer<typeof attemptSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;
export interface IdentityRepository {
  createAttempt(input: LoginAttemptInput): Promise<void>;
  consumeAttempt(
    stateHash: string,
    browserHash: string,
    now: Date,
  ): Promise<{ nonce: string; verifier: string; createdAt: Date } | null>;
  createSession(input: SessionInput): Promise<{ athleteId: string; sessionId: string }>;
  findSession(
    tokenHash: string,
    now: Date,
    kind?: 'browser' | 'native',
  ): Promise<{ athleteId: string; sessionId: string; csrfToken: string; expiresAt: Date } | null>;
  createNativeAttempt(input: z.infer<typeof nativeAttemptSchema>): Promise<void>;
  consumeNativeAttempt(
    stateHash: string,
    now: Date,
  ): Promise<{ nonce: string; verifier: string; codeChallenge: string; createdAt: Date } | null>;
  createNativeCode(input: z.infer<typeof nativeCodeSchema>): Promise<void>;
  exchangeNativeCode(input: z.infer<typeof nativeExchangeSchema>): Promise<{
    athleteId: string;
    sessionId: string;
    expiresAt: Date;
  } | null>;
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
      const result = await query('SELECT * FROM public.auth_consume_attempt_v2($1, $2, $3)', [
        stateHash,
        browserHash,
        now,
      ]);
      return result.rows.length === 0
        ? null
        : z
            .object({
              nonce: attemptSchema.shape.nonce,
              verifier: attemptSchema.shape.verifier,
              created_at: z.date(),
            })
            .transform((value) => ({
              nonce: value.nonce,
              verifier: value.verifier,
              createdAt: value.created_at,
            }))
            .parse(result.rows[0]);
    },
    async createSession(input) {
      const value = sessionInputSchema.parse(input);
      const result = await query(
        'SELECT * FROM public.auth_create_session($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          value.tokenHash,
          value.csrfToken,
          value.issuer,
          value.subject,
          value.expiresAt,
          value.now,
          value.previousTokenHash ?? null,
          value.providerSessionId ?? null,
          value.loginStartedAt,
        ],
      );
      const identity = identitySchema.parse(result.rows[0]);
      return { athleteId: identity.athlete_id, sessionId: identity.session_id };
    },
    async findSession(tokenHash, now, kind = 'browser') {
      hashSchema.parse(tokenHash);
      z.date().parse(now);
      z.enum(['browser', 'native']).parse(kind);
      const result = await query('SELECT * FROM public.auth_find_session_v2($1, $2, $3)', [
        tokenHash,
        now,
        kind,
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
    async createNativeAttempt(input) {
      const value = nativeAttemptSchema.parse(input);
      await query('SELECT public.auth_create_native_attempt($1, $2, $3, $4, $5)', [
        value.stateHash,
        value.nonce,
        value.verifier,
        value.codeChallenge,
        value.expiresAt,
      ]);
    },
    async consumeNativeAttempt(stateHash, now) {
      hashSchema.parse(stateHash);
      z.date().parse(now);
      const result = await query('SELECT * FROM public.auth_consume_native_attempt($1, $2)', [
        stateHash,
        now,
      ]);
      return result.rows.length === 0
        ? null
        : z
            .object({
              nonce: attemptSchema.shape.nonce,
              verifier: attemptSchema.shape.verifier,
              code_challenge: nativeChallengeSchema,
              created_at: z.date(),
            })
            .transform((value) => ({
              nonce: value.nonce,
              verifier: value.verifier,
              codeChallenge: value.code_challenge,
              createdAt: value.created_at,
            }))
            .parse(result.rows[0]);
    },
    async createNativeCode(input) {
      const value = nativeCodeSchema.parse(input);
      await query('SELECT public.auth_create_native_code($1, $2, $3, $4, $5, $6, $7, $8)', [
        value.codeHash,
        value.codeChallenge,
        value.issuer,
        value.subject,
        value.providerSessionId ?? null,
        value.loginStartedAt,
        value.expiresAt,
        value.now,
      ]);
    },
    async exchangeNativeCode(input) {
      const value = nativeExchangeSchema.parse(input);
      const result = await query(
        'SELECT * FROM public.auth_exchange_native_code($1, $2, $3, $4, $5, $6)',
        [
          value.codeHash,
          value.codeChallenge,
          value.tokenHash,
          value.csrfToken,
          value.expiresAt,
          value.now,
        ],
      );
      if (result.rows.length === 0) return null;
      const session = identitySchema.extend({ expires_at: z.date() }).parse(result.rows[0]);
      return {
        athleteId: session.athlete_id,
        sessionId: session.session_id,
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
