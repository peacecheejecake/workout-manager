import { createHash, randomUUID } from 'node:crypto';
import type { ActivityImport, ActivityImportResult } from '@workout/contracts/activity';

/**
 * The Garmin collection seam (M1-06b-tmp, for M1-06b).
 *
 * A collector turns a stored provider credential into ORIGINAL-FIT import commands; the
 * runner below owns everything else: the per-connection lease, the credential envelope and
 * its compare-and-set write-back, the provider-neutral activity ledger, the import through
 * the app's existing import path (dedupe, revisions, deletion suppression) and the failure
 * policy. The temporary unofficial collector implements this interface today; the official
 * adapter (M1-06b) implements the same one, so swapping them does not touch the runner, the
 * ledger or the import path.
 *
 * The runner never calls the collector inside a database transaction: every store call is
 * its own short transaction, and the collector runs between them.
 */
export type GarminCollectionProvider = 'garmin-connect-unofficial' | 'garmin-official';

export interface ListedGarminActivity {
  readonly id: string;
  readonly startedAtLocal: string;
}
export interface CollectedGarminActivity {
  readonly id: string;
  /** Import commands for the app's existing import path, one per FIT session. */
  readonly imports: readonly ActivityImport[];
}
export type GarminCollectionFailure =
  | { readonly kind: 'auth' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'transient'; readonly code: string }
  | { readonly kind: 'permanent'; readonly code: string };

export interface GarminCollectionRequest {
  /** The decrypted provider credential; never logged, never persisted by the collector. */
  readonly credential: string;
  readonly window: { readonly start: string; readonly end: string; readonly limit: number };
  /** The provider account this credential opened must be the pinned one. */
  verifyAccount(accountId: string): boolean;
  /** Choose which listed activities to download; called between provider calls. */
  select(listed: readonly ListedGarminActivity[]): Promise<readonly string[]>;
  accept(activity: CollectedGarminActivity): Promise<void>;
  acceptFailure(id: string, code: string): Promise<void>;
  readonly signal: AbortSignal;
}
export type GarminCollectionResult =
  | {
      readonly kind: 'finished';
      readonly complete: boolean;
      /** The credential after the run (the provider may have refreshed it). */
      readonly credential: string | null;
    }
  | {
      readonly kind: 'failed';
      readonly failure: GarminCollectionFailure;
      readonly credential: string | null;
    }
  | { readonly kind: 'account_mismatch' }
  | { readonly kind: 'aborted' };

export interface GarminActivityCollector {
  readonly provider: GarminCollectionProvider;
  readonly official: boolean;
  collect(request: GarminCollectionRequest): Promise<GarminCollectionResult>;
}

export interface GarminSealedCredential {
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}
export interface GarminCredentialCipher {
  seal(athleteId: string, credential: string): GarminSealedCredential;
  open(athleteId: string, sealed: GarminSealedCredential): string;
}
export interface GarminActivityImportPort {
  importActivity(athleteId: string, input: ActivityImport): Promise<ActivityImportResult>;
}
export type GarminCollectionRunState =
  | 'succeeded'
  | 'partial'
  | 'rate_limited'
  | 'reconnect_required'
  | 'failed_transient'
  | 'failed_permanent'
  | 'cancelled';
export interface GarminCollectionCounts {
  listed: number;
  imported: number;
  unchanged: number;
  suppressed: number;
  skipped: number;
  failed: number;
}
/** What the runner needs from storage; the persistence store implements it. */
export interface GarminCollectionStorePort {
  acquireRun(input: { athleteId: string; runId: string; leaseId: string; now: Date }): Promise<{
    trigger: 'manual' | 'scheduled';
    sessionGeneration: number;
    encryptedSession: GarminSealedCredential;
    profileHash: string;
  } | null>;
  holdsRun(athleteId: string, leaseId: string, now: Date): Promise<boolean>;
  commitSession(input: {
    athleteId: string;
    leaseId: string;
    sessionGeneration: number;
    encryptedSession: GarminSealedCredential;
    now: Date;
  }): Promise<boolean>;
  finishRun(input: {
    athleteId: string;
    runId: string;
    leaseId: string;
    now: Date;
    state: GarminCollectionRunState;
    counts: GarminCollectionCounts;
    complete: boolean | null;
    retryAfterMs?: number | null;
  }): Promise<void>;
  knownGarminActivities(athleteId: string, ids: readonly string[]): Promise<Set<string>>;
  recordCollected(input: {
    athleteId: string;
    garminActivityId: string;
    provider: GarminCollectionProvider;
    outcome: 'imported' | 'unchanged' | 'stale' | 'suppressed';
    sources: readonly { kind: string; sourceId: string }[];
    now: Date;
  }): Promise<void>;
}

export interface GarminCollectionRunnerOptions {
  store: GarminCollectionStorePort;
  collector: GarminActivityCollector;
  cipher: GarminCredentialCipher;
  activities: GarminActivityImportPort;
  /** sha256 of the provider account id, as pinned at login. */
  accountHash(accountId: string): string;
  now?: () => Date;
  /** The listing window of one run; bounded by the fetch limits (366 days, 200 activities). */
  window?: (now: Date) => { start: string; end: string; limit: number };
  /** Receives a fixed event name and code only; never provider text or credentials. */
  onEvent?: (event: { event: string; code?: string; state?: string }) => void;
}

const day = 86_400_000;
export const GARMIN_COLLECTION_WINDOW_DAYS = 30;
export const GARMIN_COLLECTION_LIMIT = 50;
function defaultWindow(now: Date) {
  // Local dates, not instants: Garmin lists local civil time. One day of slack each side.
  const end = new Date(now.getTime() + day).toISOString().slice(0, 10);
  const start = new Date(now.getTime() - GARMIN_COLLECTION_WINDOW_DAYS * day)
    .toISOString()
    .slice(0, 10);
  return { start, end, limit: GARMIN_COLLECTION_LIMIT };
}
/**
 * The collector's own idempotency key: a digest of the whole command under a per-provider
 * prefix. A manual import of the same FIT (key `fit-…`) and a collector import never share
 * a receipt, so the import path's own rules decide: an identical stored revision is
 * `unchanged`, a newer one is applied, and a deleted source is `suppressed` — instead of the
 * manual import's old receipt answering `imported` for an activity the user deleted.
 */
export function collectorCommand(
  provider: GarminCollectionProvider,
  command: ActivityImport,
): ActivityImport {
  const { idempotencyKey: _ignored, ...content } = command;
  const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return {
    ...content,
    idempotencyKey: `${provider === 'garmin-official' ? 'garmin-o' : 'garmin-u'}-${digest}`,
  };
}
function combine(outcomes: readonly ActivityImportResult['outcome'][]) {
  if (outcomes.includes('imported')) return 'imported' as const;
  if (outcomes.every((outcome) => outcome === 'suppressed')) return 'suppressed' as const;
  if (outcomes.includes('unchanged')) return 'unchanged' as const;
  return 'stale' as const;
}

/** The stored credential could not be decrypted (unknown key id, lost key, damaged). */
class CredentialUnreadable extends Error {
  constructor() {
    super('CREDENTIAL_UNREADABLE');
  }
}

/**
 * Run at most one collection for `athleteId`, if one is due. Returns the final run state, or
 * null when nothing was due (not connected, leased elsewhere, blocked, or not requested).
 * Never throws: a failure is recorded on the run and reported through `onEvent`.
 */
export async function runGarminCollection(
  options: GarminCollectionRunnerOptions,
  athleteId: string,
  signal?: AbortSignal,
): Promise<GarminCollectionRunState | null> {
  const now = options.now ?? (() => new Date());
  const runId = randomUUID(),
    leaseId = randomUUID();
  const lease = await options.store.acquireRun({ athleteId, runId, leaseId, now: now() });
  if (lease === null) return null;
  const counts: GarminCollectionCounts = {
    listed: 0,
    imported: 0,
    unchanged: 0,
    suppressed: 0,
    skipped: 0,
    failed: 0,
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let state: GarminCollectionRunState = 'failed_transient';
  let complete: boolean | null = null;
  let retryAfterMs: number | null = null;
  let lost = false;
  async function stillHeld() {
    if (controller.signal.aborted) return false;
    if (await options.store.holdsRun(athleteId, leaseId, now())) return true;
    lost = true;
    controller.abort();
    return false;
  }
  try {
    let credential: string;
    try {
      credential = options.cipher.open(athleteId, lease.encryptedSession);
    } catch {
      throw new CredentialUnreadable();
    }
    const result = await options.collector.collect({
      credential,
      window: (options.window ?? defaultWindow)(now()),
      verifyAccount: (accountId) => options.accountHash(accountId) === lease.profileHash,
      select: async (listed) => {
        counts.listed = listed.length;
        if (!(await stillHeld())) return [];
        const known = await options.store.knownGarminActivities(
          athleteId,
          listed.map((item) => item.id),
        );
        const wanted = listed.filter((item) => !known.has(item.id)).map((item) => item.id);
        counts.skipped = listed.length - wanted.length;
        return wanted;
      },
      accept: async (activity) => {
        if (!(await stillHeld())) return;
        const outcomes: ActivityImportResult['outcome'][] = [];
        try {
          // The existing import path: idempotency receipt, source revision rules and
          // deletion suppression all apply exactly as for a manual FIT import.
          for (const command of activity.imports)
            outcomes.push(
              (
                await options.activities.importActivity(
                  athleteId,
                  collectorCommand(options.collector.provider, command),
                )
              ).outcome,
            );
        } catch {
          counts.failed += 1;
          options.onEvent?.({ event: 'garmin_collection_import_failed' });
          return;
        }
        const outcome = combine(outcomes);
        if (outcome === 'imported') counts.imported += 1;
        else if (outcome === 'suppressed') counts.suppressed += 1;
        else counts.unchanged += 1;
        await options.store.recordCollected({
          athleteId,
          garminActivityId: activity.id,
          provider: options.collector.provider,
          outcome,
          sources: activity.imports.map((command) => ({
            kind: command.source.kind,
            sourceId: command.source.sourceId,
          })),
          now: now(),
        });
      },
      acceptFailure: async (_id, code) => {
        counts.failed += 1;
        options.onEvent?.({ event: 'garmin_collection_activity_failed', code });
      },
      signal: controller.signal,
    });
    let refreshed: string | null = null;
    // A disconnect while the provider was answering ends the run as cancelled.
    if (!lost && result.kind !== 'aborted') await stillHeld();
    if (lost || result.kind === 'aborted') state = 'cancelled';
    else if (result.kind === 'account_mismatch') state = 'reconnect_required';
    else if (result.kind === 'finished') {
      complete = result.complete;
      state = counts.failed === 0 && result.complete ? 'succeeded' : 'partial';
      refreshed = result.credential;
    } else {
      refreshed = result.credential;
      const failure = result.failure;
      if (failure.kind === 'auth') state = 'reconnect_required';
      else if (failure.kind === 'rate_limited') {
        state = 'rate_limited';
        retryAfterMs = failure.retryAfterSeconds === null ? null : failure.retryAfterSeconds * 1000;
      } else state = failure.kind === 'transient' ? 'failed_transient' : 'failed_permanent';
      options.onEvent?.({
        event: 'garmin_collection_failed',
        code:
          failure.kind === 'transient' || failure.kind === 'permanent'
            ? failure.code
            : failure.kind,
      });
    }
    if (refreshed !== null && refreshed !== credential && state !== 'reconnect_required') {
      // A disconnect or a newer login in the meantime wins; the refreshed session is dropped.
      const stored = await options.store.commitSession({
        athleteId,
        leaseId,
        sessionGeneration: lease.sessionGeneration,
        encryptedSession: options.cipher.seal(athleteId, refreshed),
        now: now(),
      });
      if (!stored) options.onEvent?.({ event: 'garmin_collection_session_not_stored' });
    }
  } catch (error) {
    if (error instanceof CredentialUnreadable) {
      // A lost or unknown key (or a damaged envelope) never heals by retrying: the envelope
      // is dropped (reconnect required) and the owner logs in again.
      state = 'reconnect_required';
      options.onEvent?.({ event: 'garmin_collection_failed', code: 'CREDENTIAL_UNREADABLE' });
    } else {
      state = 'failed_transient';
      options.onEvent?.({ event: 'garmin_collection_failed', code: 'RUNNER_ERROR' });
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  try {
    await options.store.finishRun({
      athleteId,
      runId,
      leaseId,
      now: now(),
      state,
      counts,
      complete,
      retryAfterMs,
    });
  } catch {
    options.onEvent?.({ event: 'garmin_collection_finish_failed' });
  }
  options.onEvent?.({ event: 'garmin_collection_finished', state });
  return state;
}
