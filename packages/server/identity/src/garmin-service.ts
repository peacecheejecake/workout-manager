import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { garminStatusSchema } from '@workout/contracts/garmin';
import type {
  GarminStore,
  GarminProvider,
  GarminTokens,
  GarminRevocationStore,
} from './garmin-ports.js';
import type { GarminEncryption } from './garmin-crypto.js';
import { GarminProviderError } from './garmin-provider.js';
export type {
  GarminStore,
  GarminProvider,
  GarminTokens,
  GarminCipher,
  GarminRevocationStore,
} from './garmin-ports.js';
export class GarminError extends Error {
  constructor(
    readonly code:
      | 'GARMIN_NOT_CONFIGURED'
      | 'GARMIN_CALLBACK_REJECTED'
      | 'GARMIN_UNAVAILABLE'
      | 'GARMIN_CONNECTION_BUSY'
      | 'SESSION_CHANGED',
  ) {
    super(code);
  }
}
const secret = z.string().min(1).max(16384);
const storedTokens = z.strictObject({ accessToken: secret, refreshToken: secret });
const random = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function expiry(tokens: GarminTokens, now: Date) {
  return {
    accessExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000),
    refreshExpiresAt: new Date(now.getTime() + tokens.refreshTokenExpiresIn * 1000),
  };
}
export interface GarminServiceOptions {
  store: GarminStore;
  provider: GarminProvider;
  cipher: GarminEncryption;
  now?: () => Date;
}
export function createGarminService({
  store,
  provider,
  cipher,
  now = () => new Date(),
}: GarminServiceOptions) {
  async function queueGrant(athleteId: string, userId: string | null, tokens: GarminTokens) {
    await store.queueRevoke({
      athleteId,
      userId,
      encryptedTokens: cipher.encrypt(athleteId, 'tokens', {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }),
      ...expiry(tokens, now()),
      now: now(),
    });
  }
  async function refresh(athleteId: string) {
    const leaseId = randomUUID();
    const lease = await store.leaseRefresh({
      athleteId,
      leaseId,
      now: now(),
      leaseUntil: new Date(now().getTime() + 90000),
    });
    if (!lease) return;
    let rotated: GarminTokens | undefined;
    try {
      if (lease.refreshExpiresAt <= now()) throw new GarminProviderError(true);
      const tokens = storedTokens.parse(cipher.decrypt(athleteId, 'tokens', lease.encryptedTokens));
      rotated = await provider.refresh(tokens.refreshToken);
      const committed = await store.commitRefresh({
        athleteId,
        generation: lease.generation,
        leaseId,
        encryptedTokens: cipher.encrypt(athleteId, 'tokens', {
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
        }),
        ...expiry(rotated, now()),
        now: now(),
      });
      if (!committed) await queueGrant(athleteId, lease.userId, rotated);
    } catch (error) {
      if (rotated) await queueGrant(athleteId, lease.userId, rotated);
      await store.failRefresh({
        athleteId,
        generation: lease.generation,
        leaseId,
        now: now(),
        reconnectRequired: error instanceof GarminProviderError && error.reconnectRequired,
      });
      throw new GarminError('GARMIN_UNAVAILABLE');
    }
  }
  return {
    async status(athleteId: string) {
      let current = await store.status(athleteId);
      if (
        current.state === 'connected' &&
        current.accessExpiresAt !== null &&
        current.accessExpiresAt.getTime() <= now().getTime() + 600000
      ) {
        try {
          await refresh(athleteId);
        } catch {
          /* status reflects durable state; transient failure cannot fabricate refresh success */
        }
        current = await store.status(athleteId);
      }
      return garminStatusSchema.parse({
        configured: true,
        state: current.state === 'disconnected' ? 'not_connected' : current.state,
        permissions: current.state === 'connected' ? current.permissions : [],
        connectedAt: current.connectedAt?.toISOString() ?? null,
      });
    },
    async begin(athleteId: string, sessionId: string) {
      const state = random(),
        verifier = random();
      await store
        .createAttempt({
          athleteId,
          sessionId,
          stateHash: hash(state),
          encryptedVerifier: cipher.encrypt(athleteId, 'verifier', verifier),
          expiresAt: new Date(now().getTime() + 600000),
          now: now(),
        })
        .catch((error: unknown) => {
          if (error instanceof Error && 'code' in error) {
            if (error.code === 'CONNECTION_BUSY') throw new GarminError('GARMIN_CONNECTION_BUSY');
            if (error.code === 'INVALID_SESSION') throw new GarminError('SESSION_CHANGED');
          }
          throw error;
        });
      return { authorizationUrl: provider.authorizationUrl({ state, verifier }) };
    },
    async callback(
      athleteId: string,
      sessionId: string,
      query: unknown,
    ): Promise<'connected' | 'denied' | 'failed'> {
      const result = z
        .strictObject({
          state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          code: z.string().min(1).max(4096).optional(),
          error: z.string().min(1).max(256).optional(),
          error_description: z.string().max(2048).optional(),
        })
        .safeParse(query);
      if (!result.success) throw new GarminError('GARMIN_CALLBACK_REJECTED');
      const attempt = await store.consumeAttempt({
        athleteId,
        sessionId,
        stateHash: hash(result.data.state),
        now: now(),
      });
      if (!attempt) throw new GarminError('GARMIN_CALLBACK_REJECTED');
      let grant: GarminTokens | undefined;
      let userId: string | null = null;
      try {
        if (result.data.error !== undefined || result.data.code === undefined) {
          await store.failAttempt({
            athleteId,
            sessionId,
            generation: attempt.generation,
            now: now(),
          });
          return result.data.error === 'access_denied' ? 'denied' : 'failed';
        }
        const verifier = z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .parse(cipher.decrypt(athleteId, 'verifier', attempt.encryptedVerifier));
        grant = await provider.exchange({ code: result.data.code, verifier });
        const identity = await provider.identity(grant.accessToken);
        userId = identity.userId;
        const committed = await store.commitConnection({
          athleteId,
          sessionId,
          generation: attempt.generation,
          ...identity,
          encryptedTokens: cipher.encrypt(athleteId, 'tokens', {
            accessToken: grant.accessToken,
            refreshToken: grant.refreshToken,
          }),
          ...expiry(grant, now()),
          now: now(),
        });
        if (!committed) {
          await queueGrant(athleteId, userId, grant);
          await store.failAttempt({
            athleteId,
            sessionId,
            generation: attempt.generation,
            now: now(),
          });
          return 'failed';
        }
        return 'connected';
      } catch {
        if (grant) await queueGrant(athleteId, userId, grant);
        await store.failAttempt({
          athleteId,
          sessionId,
          generation: attempt.generation,
          now: now(),
        });
        return 'failed';
      }
    },
    async disconnect(athleteId: string) {
      await store.disconnect({ athleteId, now: now() });
      return this.status(athleteId);
    },
    refresh,
  };
}
export type GarminService = ReturnType<typeof createGarminService>;
export async function processGarminRevocations({
  store,
  provider,
  cipher,
  now = () => new Date(),
  limit = 10,
}: {
  store: GarminRevocationStore;
  provider: GarminProvider;
  cipher: GarminEncryption;
  now?: () => Date;
  limit?: number;
}) {
  z.number().int().min(1).max(20).parse(limit);
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const leaseId = randomUUID();
    const job = await store.leaseRevocation({
      now: now(),
      leaseId,
      leaseUntil: new Date(now().getTime() + 90000),
    });
    if (!job) break;
    let success = false;
    try {
      let tokens = storedTokens.parse(cipher.decrypt(job.athleteId, 'tokens', job.encryptedTokens));
      if (job.accessExpiresAt.getTime() <= now().getTime() + 600000) {
        if (job.refreshExpiresAt <= now()) throw new GarminProviderError(true);
        const rotated = await provider.refresh(tokens.refreshToken);
        tokens = { accessToken: rotated.accessToken, refreshToken: rotated.refreshToken };
        const retained = await store.updateRevocationTokens({
          id: job.id,
          leaseId,
          encryptedTokens: cipher.encrypt(job.athleteId, 'tokens', tokens),
          ...expiry(rotated, now()),
          now: now(),
        });
        if (!retained) throw new GarminError('GARMIN_UNAVAILABLE');
      }
      const identity = await provider.identity(tokens.accessToken);
      const prepared = await store.prepareRevocation({
        id: job.id,
        leaseId,
        userId: identity.userId,
        now: now(),
      });
      if (!prepared) {
        processed += 1;
        continue;
      }
      await provider.revoke(tokens.accessToken);
      success = true;
    } catch {
      /* No raw provider errors, tokens or response bodies escape worker status. */
    }
    await store.finishRevocation({ id: job.id, leaseId, success, now: now() });
    processed += 1;
  }
  return { processed };
}

/** Keep durable connection status and local disconnect available during credential outages. */
export function createUnconfiguredGarminService(
  store: GarminStore,
  now = () => new Date(),
): GarminService {
  const unavailable = async (): Promise<never> => {
    throw new GarminError('GARMIN_NOT_CONFIGURED');
  };
  const status: GarminService['status'] = async (athleteId) => {
    const current = await store.status(athleteId);
    return garminStatusSchema.parse({
      configured: false,
      state: current.state === 'disconnected' ? 'not_connected' : current.state,
      permissions: current.state === 'connected' ? current.permissions : [],
      connectedAt: current.connectedAt?.toISOString() ?? null,
    });
  };
  return {
    status,
    begin: unavailable,
    callback: unavailable,
    refresh: unavailable,
    disconnect: async (athleteId) => {
      await store.disconnect({ athleteId, now: now() });
      return status(athleteId);
    },
  };
}
