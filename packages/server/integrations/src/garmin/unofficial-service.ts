import { createHmac } from 'node:crypto';
import {
  garminUnofficialLoginSchema,
  garminUnofficialMfaSchema,
  garminUnofficialStatusSchema,
  type GarminUnofficialStatus,
} from '@workout/contracts/garmin-unofficial';
import {
  runGarminCollection,
  type GarminActivityImportPort,
  type GarminCollectionRunState,
  type GarminCollectionStorePort,
  type GarminCredentialCipher,
} from './collection.js';
import type { GarminLoginStep, GarminUnofficialWorker } from './unofficial-worker.js';

/**
 * The temporary, unofficial, OWNER-ONLY in-app Garmin collector (M1-06b-tmp).
 *
 * - Exactly one app account (the deployment's configured owner) may use any of this; every
 *   other account gets the same 403 code. The adapter is absent unless configured.
 * - The password is used for one login message to the worker and is not kept anywhere.
 * - A pending MFA step is the worker process itself, held in this server's memory, bound
 *   to the app session that started it, and killed after a short TTL. With more than one
 *   API instance the MFA submit must reach the same instance (session affinity).
 * - Runs go through the provider-neutral runner (`collection.ts`); this service only decides
 *   when one is due for the owner and never runs one inside a request.
 */
export class GarminUnofficialError extends Error {
  constructor(
    readonly code:
      | 'GARMIN_UNOFFICIAL_OWNER_ONLY'
      | 'GARMIN_UNOFFICIAL_LOGIN_LOCKED'
      | 'GARMIN_UNOFFICIAL_LOGIN_REJECTED'
      | 'GARMIN_UNOFFICIAL_LOGIN_BUSY'
      | 'GARMIN_UNOFFICIAL_ALREADY_CONNECTED'
      | 'GARMIN_UNOFFICIAL_PROFILE_MISMATCH'
      | 'GARMIN_UNOFFICIAL_MFA_EXPIRED'
      | 'GARMIN_UNOFFICIAL_MFA_REJECTED'
      | 'GARMIN_UNOFFICIAL_PROVIDER_RATE_LIMITED'
      | 'GARMIN_UNOFFICIAL_UNAVAILABLE'
      | 'GARMIN_UNOFFICIAL_NOT_CONNECTED'
      | 'GARMIN_UNOFFICIAL_RUN_BLOCKED'
      | 'GARMIN_UNOFFICIAL_RUN_BUSY'
      | 'COOKIE_SESSION_REQUIRED',
  ) {
    super(code);
  }
}

export const GARMIN_UNOFFICIAL_MFA_TTL_MS = 5 * 60_000;
export const GARMIN_UNOFFICIAL_TICK_MS = 60_000;

/**
 * The pinned Garmin profile is stored as an HMAC-SHA-256 under a dedicated pin key, never as
 * the id. A profile id is a small integer, so a plain digest could be reversed by trying every
 * id; without the key the stored value is not. The pin key is separate from the session
 * keyring and is not rotated with it: rotating it would unpin (and so refuse) the owner's own
 * Garmin account. The key comes from the secret manager, never the repository or database.
 */
export function createGarminProfilePin(key: Buffer): (profileId: string) => string {
  if (key.length < 32) throw new Error('INVALID_GARMIN_UNOFFICIAL_PIN_KEY');
  const secret = Buffer.from(key);
  return (profileId) =>
    createHmac('sha256', secret).update(`garmin-connect-profile:${profileId}`).digest('hex');
}

export interface GarminUnofficialStorePort extends GarminCollectionStorePort {
  view(
    athleteId: string,
    now: Date,
  ): Promise<{
    state: 'not_connected' | 'connected' | 'reconnect_required';
    profilePinned: boolean;
    connectedAt: Date | null;
    scheduleEnabled: boolean;
    schedulePaused: boolean;
    nextScheduledAt: Date | null;
    blockedUntil: Date | null;
    loginLockedUntil: Date | null;
    runRequested: boolean;
    running: boolean;
    lastRun: {
      id: string;
      trigger: 'manual' | 'scheduled';
      state: GarminCollectionRunState | 'running';
      started_at: Date;
      finished_at: Date | null;
      listed: number;
      imported: number;
      unchanged: number;
      suppressed: number;
      skipped: number;
      failed: number;
      complete: boolean | null;
    } | null;
  }>;
  beginLogin(
    athleteId: string,
    now: Date,
  ): Promise<{ allowed: true } | { allowed: false; lockedUntil: Date }>;
  recordLoginFailure(athleteId: string, now: Date, minimumLockMs?: number): Promise<Date | null>;
  commitLogin(input: {
    athleteId: string;
    profileHash: string;
    encryptedSession: ReturnType<GarminCredentialCipher['seal']>;
    now: Date;
  }): Promise<'connected' | 'profile_mismatch' | 'already_connected'>;
  disconnect(athleteId: string): Promise<void>;
  setSchedule(athleteId: string, enabled: boolean, now: Date): Promise<'updated' | 'not_connected'>;
  requestRun(
    athleteId: string,
    now: Date,
  ): Promise<'requested' | 'not_connected' | 'blocked' | 'running'>;
  provenance(
    athleteId: string,
    activityId: string,
  ): Promise<{
    provider: 'garmin-connect-unofficial' | 'garmin-official';
    official: boolean;
    garminActivityId: string;
    collectedAt: string;
  } | null>;
}

export interface GarminUnofficialServiceOptions {
  /** The single app account allowed to use the collector. */
  ownerAthleteId: string;
  store: GarminUnofficialStorePort;
  worker: GarminUnofficialWorker;
  cipher: GarminCredentialCipher;
  /** Keyed pin of a Garmin profile id; see `createGarminProfilePin`. */
  profilePin: (profileId: string) => string;
  activities: GarminActivityImportPort;
  now?: () => Date;
  window?: (now: Date) => { start: string; end: string; limit: number };
  /** Fixed event names and codes only. */
  onEvent?: (event: { event: string; code?: string; state?: string }) => void;
}

interface PendingMfa {
  sessionId: string;
  expiresAt: Date;
  step: Extract<GarminLoginStep, { kind: 'mfa_required' }>;
  timer: ReturnType<typeof setTimeout>;
}

export function createGarminUnofficialService(options: GarminUnofficialServiceOptions) {
  const now = options.now ?? (() => new Date());
  const owner = options.ownerAthleteId;
  let pending: PendingMfa | null = null;
  let loginInFlight = false;
  let running: Promise<GarminCollectionRunState | null> | null = null;
  let runAbort: AbortController | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  /** The login worker being waited on (password step or MFA submit); killed by close(). */
  let loginAbort: AbortController | null = null;
  let closed = false;

  /** The one owner check; the routes and every method below go through it. */
  const isOwner = (athleteId: string) => athleteId === owner;
  function requireOwner(athleteId: string) {
    if (!isOwner(athleteId)) throw new GarminUnofficialError('GARMIN_UNOFFICIAL_OWNER_ONLY');
  }
  async function dropPending() {
    const current = pending;
    pending = null;
    if (current === null) return;
    clearTimeout(current.timer);
    await current.step.cancel();
  }
  function livePending(sessionId: string) {
    if (pending === null) return null;
    if (pending.expiresAt <= now()) {
      void dropPending();
      return null;
    }
    return pending.sessionId === sessionId ? pending : null;
  }

  async function settle(athleteId: string, step: GarminLoginStep, sessionId: string) {
    if (step.kind === 'mfa_required') {
      const expiresAt = new Date(now().getTime() + GARMIN_UNOFFICIAL_MFA_TTL_MS);
      const entry: PendingMfa = {
        sessionId,
        expiresAt,
        step,
        timer: setTimeout(() => {
          if (pending === entry) void dropPending();
        }, GARMIN_UNOFFICIAL_MFA_TTL_MS),
      };
      entry.timer.unref?.();
      pending = entry;
      return { state: 'mfa_required' as const };
    }
    if (step.kind === 'failed') {
      const failure = step.failure;
      if (failure.kind === 'rate_limited') {
        await options.store.recordLoginFailure(athleteId, now(), 15 * 60_000);
        throw new GarminUnofficialError('GARMIN_UNOFFICIAL_PROVIDER_RATE_LIMITED');
      }
      if (failure.kind === 'auth') {
        await options.store.recordLoginFailure(athleteId, now());
        throw new GarminUnofficialError('GARMIN_UNOFFICIAL_LOGIN_REJECTED');
      }
      if (failure.kind === 'mfa_invalid')
        throw new GarminUnofficialError('GARMIN_UNOFFICIAL_MFA_REJECTED');
      options.onEvent?.({ event: 'garmin_unofficial_login_failed', code: failure.code });
      throw new GarminUnofficialError('GARMIN_UNOFFICIAL_UNAVAILABLE');
    }
    const committed = await options.store.commitLogin({
      athleteId,
      profileHash: options.profilePin(step.profileId),
      encryptedSession: options.cipher.seal(athleteId, step.session),
      now: now(),
    });
    if (committed === 'profile_mismatch') {
      // The session just obtained is dropped unstored; it cannot be revoked at Garmin.
      await options.store.recordLoginFailure(athleteId, now());
      options.onEvent?.({ event: 'garmin_unofficial_profile_refused' });
      throw new GarminUnofficialError('GARMIN_UNOFFICIAL_PROFILE_MISMATCH');
    }
    if (committed === 'already_connected')
      throw new GarminUnofficialError('GARMIN_UNOFFICIAL_ALREADY_CONNECTED');
    options.onEvent?.({ event: 'garmin_unofficial_connected' });
    return { state: 'connected' as const };
  }

  async function runIfDue(): Promise<GarminCollectionRunState | null> {
    if (closed) return null;
    if (running !== null) return running;
    runAbort = new AbortController();
    running = runGarminCollection(
      {
        store: options.store,
        collector: options.worker.collector,
        cipher: options.cipher,
        activities: options.activities,
        accountHash: options.profilePin,
        now,
        ...(options.window === undefined ? {} : { window: options.window }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      },
      owner,
      runAbort.signal,
    ).finally(() => {
      running = null;
      runAbort = null;
    });
    return running;
  }

  return {
    ownerAthleteId: owner,
    isOwner,

    async status(athleteId: string, sessionId: string | null): Promise<GarminUnofficialStatus> {
      requireOwner(athleteId);
      const view = await options.store.view(athleteId, now());
      const mfa = sessionId === null ? null : livePending(sessionId);
      const run = view.lastRun;
      return garminUnofficialStatusSchema.parse({
        provider: 'garmin-connect-unofficial',
        official: false,
        state: mfa !== null && view.state !== 'connected' ? 'mfa_required' : view.state,
        connectedAt: view.connectedAt?.toISOString() ?? null,
        profilePinned: view.profilePinned,
        mfaExpiresAt:
          mfa !== null && view.state !== 'connected' ? mfa.expiresAt.toISOString() : null,
        schedule: {
          enabled: view.scheduleEnabled,
          paused: view.schedulePaused,
          intervalHours: 6,
          nextRunAt: view.nextScheduledAt?.toISOString() ?? null,
        },
        blockedUntil: view.blockedUntil?.toISOString() ?? null,
        loginLockedUntil: view.loginLockedUntil?.toISOString() ?? null,
        runRequested: view.runRequested || view.running,
        lastRun:
          run === null
            ? null
            : {
                id: run.id,
                trigger: run.trigger,
                state: run.state,
                startedAt: run.started_at.toISOString(),
                finishedAt: run.finished_at?.toISOString() ?? null,
                listed: run.listed,
                imported: run.imported,
                unchanged: run.unchanged,
                suppressed: run.suppressed,
                skipped: run.skipped,
                failed: run.failed,
                complete: run.complete,
              },
      });
    },

    /**
     * One login request. The password is passed to the worker over stdin and is not stored,
     * logged, queued or returned; this function does not keep a reference after the call.
     */
    async login(
      athleteId: string,
      sessionId: string,
      input: unknown,
    ): Promise<{ state: 'connected' | 'mfa_required' }> {
      requireOwner(athleteId);
      const credentials = garminUnofficialLoginSchema.parse(input);
      if (loginInFlight) throw new GarminUnofficialError('GARMIN_UNOFFICIAL_LOGIN_BUSY');
      loginInFlight = true;
      try {
        const view = await options.store.view(athleteId, now());
        if (view.state === 'connected')
          throw new GarminUnofficialError('GARMIN_UNOFFICIAL_ALREADY_CONNECTED');
        const gate = await options.store.beginLogin(athleteId, now());
        if (!gate.allowed) throw new GarminUnofficialError('GARMIN_UNOFFICIAL_LOGIN_LOCKED');
        await dropPending();
        if (closed) throw new GarminUnofficialError('GARMIN_UNOFFICIAL_UNAVAILABLE');
        loginAbort = new AbortController();
        const step = await options.worker.login(credentials, loginAbort.signal);
        // Shut down while Garmin was answering: nothing from this login is kept.
        if (closed) {
          if (step.kind === 'mfa_required') await step.cancel();
          throw new GarminUnofficialError('GARMIN_UNOFFICIAL_UNAVAILABLE');
        }
        return await settle(athleteId, step, sessionId);
      } finally {
        loginAbort = null;
        loginInFlight = false;
      }
    },

    async submitMfa(athleteId: string, sessionId: string, input: unknown) {
      requireOwner(athleteId);
      const { code } = garminUnofficialMfaSchema.parse(input);
      if (closed) throw new GarminUnofficialError('GARMIN_UNOFFICIAL_UNAVAILABLE');
      const current = livePending(sessionId);
      if (current === null) throw new GarminUnofficialError('GARMIN_UNOFFICIAL_MFA_EXPIRED');
      if (loginInFlight) throw new GarminUnofficialError('GARMIN_UNOFFICIAL_LOGIN_BUSY');
      loginInFlight = true;
      try {
        const step = await current.step.submit(code);
        // Shut down while the code was being checked: nothing from this login is kept.
        if (closed) {
          if (step.kind === 'mfa_required') await step.cancel();
          throw new GarminUnofficialError('GARMIN_UNOFFICIAL_UNAVAILABLE');
        }
        if (step.kind === 'failed' && step.failure.kind === 'mfa_invalid')
          throw new GarminUnofficialError('GARMIN_UNOFFICIAL_MFA_REJECTED');
        if (pending === current) {
          clearTimeout(current.timer);
          pending = null;
        }
        return await settle(athleteId, step, sessionId);
      } finally {
        loginInFlight = false;
      }
    },

    async cancelLogin(athleteId: string, sessionId: string) {
      requireOwner(athleteId);
      if (livePending(sessionId) !== null) await dropPending();
    },

    /** Deletes the stored session. Garmin's side cannot be revoked by this path. */
    async disconnect(athleteId: string) {
      requireOwner(athleteId);
      await dropPending();
      await options.store.disconnect(athleteId);
      runAbort?.abort();
      options.onEvent?.({ event: 'garmin_unofficial_disconnected' });
    },

    async setSchedule(athleteId: string, enabled: boolean) {
      requireOwner(athleteId);
      if ((await options.store.setSchedule(athleteId, enabled, now())) === 'not_connected')
        throw new GarminUnofficialError('GARMIN_UNOFFICIAL_NOT_CONNECTED');
      if (enabled) void runIfDue();
    },

    /** Records the owner's request; the run itself happens outside the request. */
    async requestRun(athleteId: string) {
      requireOwner(athleteId);
      const result = await options.store.requestRun(athleteId, now());
      if (result === 'not_connected')
        throw new GarminUnofficialError('GARMIN_UNOFFICIAL_NOT_CONNECTED');
      if (result === 'blocked') throw new GarminUnofficialError('GARMIN_UNOFFICIAL_RUN_BLOCKED');
      if (result === 'running') throw new GarminUnofficialError('GARMIN_UNOFFICIAL_RUN_BUSY');
      void runIfDue();
      return { requested: true as const };
    },

    runIfDue,

    /** Provenance of a stored activity; not owner-gated, since it describes the caller's data. */
    provenance: (athleteId: string, activityId: string) =>
      options.store.provenance(athleteId, activityId),

    start() {
      if (ticker !== null) return;
      ticker = setInterval(() => void runIfDue(), GARMIN_UNOFFICIAL_TICK_MS);
      ticker.unref?.();
    },

    async close() {
      closed = true;
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      // An in-flight login's Python process is killed, not left to finish after shutdown.
      loginAbort?.abort();
      await dropPending();
      runAbort?.abort();
      await running?.catch(() => undefined);
    },
  };
}
export type GarminUnofficialService = ReturnType<typeof createGarminUnofficialService>;
