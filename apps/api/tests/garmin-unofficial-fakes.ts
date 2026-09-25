import type {
  GarminActivityCollector,
  GarminCollectionRequest,
  GarminCollectionResult,
  GarminCredentialCipher,
  GarminSealedCredential,
} from '@workout/server-integrations/garmin-collection';
import type { GarminUnofficialStorePort } from '@workout/server-integrations/garmin-unofficial-service';
import type {
  GarminLoginStep,
  GarminUnofficialWorker,
} from '@workout/server-integrations/garmin-unofficial-worker';

/**
 * In-memory stand-ins for unit tests of the unofficial collector's service, runner and routes.
 * The real store is exercised against PostgreSQL in
 * apps/api/tests/garmin-unofficial-collector.integration.test.ts.
 */
export function memoryStore(): GarminUnofficialStorePort & {
  rows: Map<string, Record<string, unknown>>;
  ledger: Map<string, { provider: string; outcome: string }>;
  runs: Record<string, unknown>[];
} {
  const rows = new Map<string, Record<string, unknown>>();
  const ledger = new Map<string, { provider: string; outcome: string }>();
  const runs: Record<string, unknown>[] = [];
  const row = (athleteId: string) => {
    let value = rows.get(athleteId);
    if (!value) {
      value = {
        state: 'not_connected',
        profileHash: null,
        session: null,
        generation: 0,
        connectedAt: null,
        leaseId: null,
        leaseUntil: null,
        requested: false,
        scheduleEnabled: false,
        schedulePaused: false,
        next: null,
        blockedUntil: null,
        loginLockedUntil: null,
        loginAttempts: 0,
        loginFailures: 0,
      };
      rows.set(athleteId, value);
    }
    return value;
  };
  return {
    rows,
    ledger,
    runs,
    async view(athleteId, now) {
      const value = row(athleteId);
      const last = runs.filter((run) => run['athleteId'] === athleteId).at(-1) ?? null;
      const leaseUntil = value['leaseUntil'] as Date | null;
      return {
        state: value['state'] as 'not_connected',
        profilePinned: value['profileHash'] !== null,
        connectedAt: value['connectedAt'] as Date | null,
        scheduleEnabled: value['scheduleEnabled'] as boolean,
        schedulePaused: value['schedulePaused'] as boolean,
        nextScheduledAt: value['next'] as Date | null,
        blockedUntil:
          (value['blockedUntil'] as Date | null) && (value['blockedUntil'] as Date) > now
            ? (value['blockedUntil'] as Date)
            : null,
        loginLockedUntil:
          (value['loginLockedUntil'] as Date | null) && (value['loginLockedUntil'] as Date) > now
            ? (value['loginLockedUntil'] as Date)
            : null,
        runRequested: value['requested'] as boolean,
        running: leaseUntil !== null && leaseUntil > now,
        lastRun:
          last === null
            ? null
            : {
                id: last['id'] as string,
                trigger: last['trigger'] as 'manual',
                state: last['state'] as 'succeeded',
                started_at: last['startedAt'] as Date,
                finished_at: (last['finishedAt'] as Date | null) ?? null,
                listed: 0,
                imported: (last['imported'] as number) ?? 0,
                unchanged: 0,
                suppressed: 0,
                skipped: 0,
                failed: 0,
                complete: null,
              },
      };
    },
    async beginLogin(athleteId, now) {
      const value = row(athleteId);
      const locked = value['loginLockedUntil'] as Date | null;
      if (locked && locked > now) return { allowed: false, lockedUntil: locked };
      if ((value['loginAttempts'] as number) >= 5) {
        const until = new Date(now.getTime() + 15 * 60_000);
        value['loginLockedUntil'] = until;
        return { allowed: false, lockedUntil: until };
      }
      value['loginAttempts'] = (value['loginAttempts'] as number) + 1;
      return { allowed: true };
    },
    async recordLoginFailure(athleteId, now, minimum = 0) {
      const value = row(athleteId);
      value['loginFailures'] = (value['loginFailures'] as number) + 1;
      const until = new Date(now.getTime() + Math.max(60_000, minimum));
      value['loginLockedUntil'] = until;
      return until;
    },
    async commitLogin({ athleteId, profileHash, encryptedSession, now }) {
      const value = row(athleteId);
      if (value['profileHash'] !== null && value['profileHash'] !== profileHash)
        return 'profile_mismatch';
      if (value['state'] === 'connected') return 'already_connected';
      Object.assign(value, {
        state: 'connected',
        profileHash,
        session: encryptedSession,
        generation: (value['generation'] as number) + 1,
        connectedAt: now,
        loginFailures: 0,
        loginAttempts: 0,
        loginLockedUntil: null,
      });
      return 'connected';
    },
    async disconnect(athleteId) {
      const value = row(athleteId);
      Object.assign(value, {
        state: 'not_connected',
        session: null,
        generation: (value['generation'] as number) + 1,
        connectedAt: null,
        leaseId: null,
        leaseUntil: null,
        requested: false,
        scheduleEnabled: false,
      });
    },
    async setSchedule(athleteId, enabled, now) {
      const value = row(athleteId);
      if (value['state'] !== 'connected') return 'not_connected';
      Object.assign(value, {
        scheduleEnabled: enabled,
        schedulePaused: false,
        next: enabled ? now : null,
      });
      return 'updated';
    },
    async requestRun(athleteId, now) {
      const value = row(athleteId);
      if (value['state'] !== 'connected') return 'not_connected';
      const blocked = value['blockedUntil'] as Date | null;
      if (blocked && blocked > now) return 'blocked';
      const lease = value['leaseUntil'] as Date | null;
      if (lease && lease > now) return 'running';
      value['requested'] = true;
      return 'requested';
    },
    async acquireRun({ athleteId, runId, leaseId, now }) {
      const value = row(athleteId);
      if (value['state'] !== 'connected') return null;
      const lease = value['leaseUntil'] as Date | null;
      if (lease && lease > now) return null;
      const blocked = value['blockedUntil'] as Date | null;
      if (blocked && blocked > now) return null;
      const scheduled =
        (value['scheduleEnabled'] as boolean) &&
        !(value['schedulePaused'] as boolean) &&
        (value['next'] === null || (value['next'] as Date) <= now);
      const trigger = value['requested'] ? 'manual' : scheduled ? 'scheduled' : null;
      if (trigger === null) return null;
      Object.assign(value, {
        leaseId,
        leaseUntil: new Date(now.getTime() + 20 * 60_000),
        requested: false,
      });
      runs.push({ athleteId, id: runId, trigger, state: 'running', startedAt: now });
      return {
        trigger,
        sessionGeneration: value['generation'] as number,
        encryptedSession: value['session'] as GarminSealedCredential,
        profileHash: value['profileHash'] as string,
      };
    },
    async holdsRun(athleteId, leaseId, now) {
      const value = row(athleteId);
      return (
        value['leaseId'] === leaseId &&
        value['state'] === 'connected' &&
        (value['leaseUntil'] as Date) > now
      );
    },
    async commitSession({ athleteId, leaseId, sessionGeneration, encryptedSession }) {
      const value = row(athleteId);
      if (
        value['leaseId'] !== leaseId ||
        value['generation'] !== sessionGeneration ||
        value['state'] !== 'connected'
      )
        return false;
      value['session'] = encryptedSession;
      value['generation'] = (value['generation'] as number) + 1;
      return true;
    },
    async finishRun({ athleteId, runId, leaseId, now, state, counts, retryAfterMs }) {
      const run = runs.find((item) => item['id'] === runId);
      if (run && run['state'] === 'running')
        Object.assign(run, { state, finishedAt: now, ...counts });
      const value = row(athleteId);
      if (value['leaseId'] !== leaseId) return;
      Object.assign(value, { leaseId: null, leaseUntil: null });
      if (state === 'rate_limited') {
        value['blockedUntil'] = new Date(
          now.getTime() + Math.max(retryAfterMs ?? 3_600_000, 900_000),
        );
        value['schedulePaused'] = value['scheduleEnabled'];
      }
      if (state === 'reconnect_required')
        Object.assign(value, { state: 'reconnect_required', session: null });
      if (state === 'failed_permanent') value['schedulePaused'] = value['scheduleEnabled'];
    },
    async knownGarminActivities(_athleteId, ids) {
      return new Set(ids.filter((id) => ledger.has(id)));
    },
    async recordCollected({ garminActivityId, provider, outcome }) {
      if (!ledger.has(garminActivityId)) ledger.set(garminActivityId, { provider, outcome });
    },
    async provenance() {
      return null;
    },
  };
}

/** Reversible, obviously-not-secret sealing for unit tests (the real one is AES-256-GCM). */
export const testCipher: GarminCredentialCipher = {
  seal: (athleteId, credential) => ({
    keyId: 'test',
    iv: 'A'.repeat(16),
    ciphertext: Buffer.from(JSON.stringify([athleteId, credential])).toString('base64'),
    tag: 'B'.repeat(22),
  }),
  open: (athleteId, sealed) => {
    const [owner, credential] = JSON.parse(
      Buffer.from(sealed.ciphertext, 'base64').toString('utf8'),
    ) as [string, string];
    if (owner !== athleteId) throw new Error('WRONG_ACCOUNT');
    return credential;
  },
};

export interface ScriptedWorker extends GarminUnofficialWorker {
  logins: { email: string; password: string }[];
  next: GarminLoginStep[];
  /** The abort signal each login was given (server shutdown kills the login's process). */
  signals: (AbortSignal | undefined)[];
  /** When set, the next login waits for this before answering. */
  hold: Promise<void> | null;
  collections: GarminCollectionRequest[];
  collect: (request: GarminCollectionRequest) => Promise<GarminCollectionResult>;
}
export function scriptedWorker(): ScriptedWorker {
  const logins: { email: string; password: string }[] = [];
  const next: GarminLoginStep[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const holdState = { hold: null as Promise<void> | null };
  const collections: GarminCollectionRequest[] = [];
  const state = {
    collect: async (): Promise<GarminCollectionResult> => ({
      kind: 'finished',
      complete: true,
      credential: null,
    }),
  } as { collect: (request: GarminCollectionRequest) => Promise<GarminCollectionResult> };
  const collector: GarminActivityCollector = {
    provider: 'garmin-connect-unofficial',
    official: false,
    collect: (request: GarminCollectionRequest) => {
      collections.push(request);
      return state.collect(request);
    },
  };
  return {
    logins,
    next,
    signals,
    get hold() {
      return holdState.hold;
    },
    set hold(value) {
      holdState.hold = value;
    },
    collections,
    get collect() {
      return state.collect;
    },
    set collect(value) {
      state.collect = value;
    },
    async login(credentials, signal) {
      logins.push({ ...credentials });
      signals.push(signal);
      if (holdState.hold !== null) await holdState.hold;
      if (signal?.aborted)
        return { kind: 'failed', failure: { kind: 'transient', code: 'WORKER_ABORTED' } };
      const step = next.shift();
      if (!step) throw new Error('NO_SCRIPTED_LOGIN');
      return step;
    },
    collector,
  };
}
