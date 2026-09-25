import { z } from 'zod';
import { TenantErasedError, type Database, type Transaction } from './database.js';

/**
 * Storage for the temporary, unofficial in-app Garmin collector (M1-06b-tmp).
 *
 * Every call runs in a tenant transaction (RLS on `app.athlete_id`), and no call reaches the
 * provider: the service calls Garmin between these transactions, never inside one. The
 * session envelope is written and read as ciphertext only; this module never sees a key.
 */
const cipherSchema = z.strictObject({
  keyId: z.string().min(1).max(100),
  iv: z.string().min(16).max(64),
  ciphertext: z.string().min(1).max(60000),
  tag: z.string().min(22).max(64),
});
export type GarminUnofficialCipher = z.infer<typeof cipherSchema>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const garminActivityIdSchema = z.string().regex(/^[1-9]\d{0,23}$/);

/** How long one run may hold the connection before another instance may take it over. */
export const GARMIN_UNOFFICIAL_RUN_LEASE_MS = 20 * 60 * 1000;
/** Owner-opted schedule: one run per interval at most. */
export const GARMIN_UNOFFICIAL_SCHEDULE_HOURS = 6;
/** Login endpoint bounds: attempts per window, and the failure backoff ceiling. */
export const GARMIN_UNOFFICIAL_LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const GARMIN_UNOFFICIAL_LOGIN_ATTEMPTS = 5;
export const GARMIN_UNOFFICIAL_LOGIN_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** A 429 without a usable Retry-After blocks runs for this long. */
export const GARMIN_UNOFFICIAL_DEFAULT_RETRY_AFTER_MS = 60 * 60 * 1000;
export const GARMIN_UNOFFICIAL_MIN_RETRY_AFTER_MS = 15 * 60 * 1000;
const RUN_HISTORY = 20;

export type GarminUnofficialRunState =
  | 'succeeded'
  | 'partial'
  | 'rate_limited'
  | 'reconnect_required'
  | 'failed_transient'
  | 'failed_permanent'
  | 'cancelled';
export interface GarminUnofficialRunCounts {
  listed: number;
  imported: number;
  unchanged: number;
  suppressed: number;
  skipped: number;
  failed: number;
}

const connectionRow = z.object({
  state: z.enum(['not_connected', 'connected', 'reconnect_required']),
  profile_hash: hashSchema.nullable(),
  encrypted_session: cipherSchema.nullable(),
  session_generation: z.number().int(),
  connected_at: z.date().nullable(),
  lease_id: z.string().nullable(),
  lease_until: z.date().nullable(),
  run_requested_at: z.date().nullable(),
  schedule_enabled: z.boolean(),
  schedule_paused: z.boolean(),
  next_scheduled_at: z.date().nullable(),
  blocked_until: z.date().nullable(),
  transient_failures: z.number().int(),
  login_window_started_at: z.date().nullable(),
  login_attempts: z.number().int(),
  login_failures: z.number().int(),
  login_locked_until: z.date().nullable(),
});
const runRow = z.object({
  id: z.uuid(),
  trigger: z.enum(['manual', 'scheduled']),
  state: z.enum([
    'running',
    'succeeded',
    'partial',
    'rate_limited',
    'reconnect_required',
    'failed_transient',
    'failed_permanent',
    'cancelled',
  ]),
  started_at: z.date(),
  finished_at: z.date().nullable(),
  listed: z.number().int(),
  imported: z.number().int(),
  unchanged: z.number().int(),
  suppressed: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  complete: z.boolean().nullable(),
});
export type GarminUnofficialRunRecord = z.infer<typeof runRow>;

export interface GarminUnofficialConnectionView {
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
  lastRun: GarminUnofficialRunRecord | null;
}

async function ensureRow(tx: Transaction) {
  await tx.query(
    'INSERT INTO garmin_unofficial_connection(athlete_id) VALUES($1) ON CONFLICT DO NOTHING',
    [tx.athleteId],
  );
  const result = await tx.query(
    'SELECT * FROM garmin_unofficial_connection WHERE athlete_id=$1 FOR UPDATE',
    [tx.athleteId],
  );
  return connectionRow.parse(result.rows[0]);
}
async function lockedRow(tx: Transaction) {
  const result = await tx.query(
    'SELECT * FROM garmin_unofficial_connection WHERE athlete_id=$1 FOR UPDATE',
    [tx.athleteId],
  );
  return result.rows[0] ? connectionRow.parse(result.rows[0]) : null;
}
const leaseLive = (row: z.infer<typeof connectionRow>, now: Date) =>
  row.lease_until !== null && row.lease_until > now;
const later = (a: Date | null, b: Date | null) => (a === null ? b : b === null ? a : a > b ? a : b);
async function unlessErased<T>(fallback: T, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TenantErasedError) return fallback;
    throw error;
  }
}

export function createGarminUnofficialStore(database: Database) {
  return {
    async view(athleteId: string, now: Date): Promise<GarminUnofficialConnectionView> {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          'SELECT * FROM garmin_unofficial_connection WHERE athlete_id=$1',
          [athleteId],
        );
        const latest = await tx.query(
          'SELECT * FROM garmin_unofficial_run WHERE athlete_id=$1 ORDER BY started_at DESC,id LIMIT 1',
          [athleteId],
        );
        const lastRun = latest.rows[0] ? runRow.parse(latest.rows[0]) : null;
        const row = result.rows[0] ? connectionRow.parse(result.rows[0]) : null;
        if (row === null)
          return {
            state: 'not_connected',
            profilePinned: false,
            connectedAt: null,
            scheduleEnabled: false,
            schedulePaused: false,
            nextScheduledAt: null,
            blockedUntil: null,
            loginLockedUntil: null,
            runRequested: false,
            running: false,
            lastRun,
          };
        return {
          state: row.state,
          profilePinned: row.profile_hash !== null,
          connectedAt: row.connected_at,
          scheduleEnabled: row.schedule_enabled,
          schedulePaused: row.schedule_paused,
          nextScheduledAt: row.schedule_enabled ? row.next_scheduled_at : null,
          blockedUntil:
            row.blocked_until !== null && row.blocked_until > now ? row.blocked_until : null,
          loginLockedUntil:
            row.login_locked_until !== null && row.login_locked_until > now
              ? row.login_locked_until
              : null,
          runRequested: row.run_requested_at !== null,
          running: leaseLive(row, now),
          lastRun,
        };
      });
    },

    /**
     * Count one login attempt against the window, or refuse it. Refusal leaves the counters
     * as they are, so hammering a locked endpoint does not extend anything but cannot pass.
     */
    async beginLogin(
      athleteId: string,
      now: Date,
    ): Promise<{ allowed: true } | { allowed: false; lockedUntil: Date }> {
      return database.tenant(athleteId, async (tx) => {
        const row = await ensureRow(tx);
        if (row.login_locked_until !== null && row.login_locked_until > now)
          return { allowed: false, lockedUntil: row.login_locked_until };
        const windowOpen =
          row.login_window_started_at !== null &&
          row.login_window_started_at.getTime() + GARMIN_UNOFFICIAL_LOGIN_WINDOW_MS > now.getTime();
        const attempts = windowOpen ? row.login_attempts : 0;
        const windowStart = windowOpen ? row.login_window_started_at : now;
        if (attempts >= GARMIN_UNOFFICIAL_LOGIN_ATTEMPTS && windowStart !== null) {
          const lockedUntil = new Date(windowStart.getTime() + GARMIN_UNOFFICIAL_LOGIN_WINDOW_MS);
          await tx.query(
            'UPDATE garmin_unofficial_connection SET login_locked_until=$2 WHERE athlete_id=$1',
            [athleteId, lockedUntil],
          );
          return { allowed: false, lockedUntil };
        }
        await tx.query(
          'UPDATE garmin_unofficial_connection SET login_window_started_at=$2,login_attempts=$3 WHERE athlete_id=$1',
          [athleteId, windowStart, attempts + 1],
        );
        return { allowed: true };
      });
    },

    /** Exponential lockout after a failed login; a provider 429 locks for at least 15 min. */
    async recordLoginFailure(
      athleteId: string,
      now: Date,
      minimumLockMs = 0,
    ): Promise<Date | null> {
      return unlessErased(null, () =>
        database.tenant(athleteId, async (tx) => {
          const row = await ensureRow(tx);
          const failures = Math.min(row.login_failures + 1, 1000);
          const backoff = Math.min(
            60_000 * 2 ** Math.min(failures - 1, 16),
            GARMIN_UNOFFICIAL_LOGIN_BACKOFF_MAX_MS,
          );
          const lockedUntil = later(
            row.login_locked_until,
            new Date(now.getTime() + Math.max(backoff, minimumLockMs)),
          );
          await tx.query(
            'UPDATE garmin_unofficial_connection SET login_failures=$2,login_locked_until=$3 WHERE athlete_id=$1',
            [athleteId, failures, lockedUntil],
          );
          return lockedUntil;
        }),
      );
    },

    /**
     * Store the session of a successful login, pinning the Garmin profile the first time.
     * A different profile is refused and nothing is stored. A connected row is not replaced.
     */
    async commitLogin(input: {
      athleteId: string;
      profileHash: string;
      encryptedSession: GarminUnofficialCipher;
      now: Date;
    }): Promise<'connected' | 'profile_mismatch' | 'already_connected'> {
      hashSchema.parse(input.profileHash);
      cipherSchema.parse(input.encryptedSession);
      return unlessErased('already_connected' as const, () =>
        database.tenant(input.athleteId, async (tx) => {
          const row = await ensureRow(tx);
          if (row.profile_hash !== null && row.profile_hash !== input.profileHash)
            return 'profile_mismatch' as const;
          if (row.state === 'connected') return 'already_connected' as const;
          await tx.query(
            `UPDATE garmin_unofficial_connection SET state='connected',profile_hash=$2,encrypted_session=$3,
             session_generation=session_generation+1,connected_at=$4,login_failures=0,login_attempts=0,
             login_window_started_at=NULL,login_locked_until=NULL,lease_id=NULL,lease_until=NULL,
             run_requested_at=NULL,transient_failures=0 WHERE athlete_id=$1`,
            [input.athleteId, input.profileHash, JSON.stringify(input.encryptedSession), input.now],
          );
          return 'connected' as const;
        }),
      );
    },

    /**
     * Delete the stored session. The pin stays (a different Garmin profile stays refused).
     * Nothing is queued for revocation: an unofficial session cannot be revoked at Garmin.
     */
    async disconnect(athleteId: string): Promise<void> {
      await database.tenant(athleteId, async (tx) => {
        await tx.query(
          `UPDATE garmin_unofficial_connection SET state='not_connected',encrypted_session=NULL,
           session_generation=session_generation+1,connected_at=NULL,lease_id=NULL,lease_until=NULL,
           run_requested_at=NULL,schedule_enabled=false,schedule_paused=false,next_scheduled_at=NULL
           WHERE athlete_id=$1`,
          [athleteId],
        );
        await tx.query(
          "UPDATE garmin_unofficial_run SET state='cancelled',finished_at=greatest(started_at,clock_timestamp()) WHERE athlete_id=$1 AND state='running'",
          [athleteId],
        );
      });
    },

    async setSchedule(
      athleteId: string,
      enabled: boolean,
      now: Date,
    ): Promise<'updated' | 'not_connected'> {
      return database.tenant(athleteId, async (tx) => {
        const row = await lockedRow(tx);
        if (row === null || row.state !== 'connected') return 'not_connected' as const;
        await tx.query(
          'UPDATE garmin_unofficial_connection SET schedule_enabled=$2,schedule_paused=false,next_scheduled_at=$3 WHERE athlete_id=$1',
          [athleteId, enabled, enabled ? now : null],
        );
        return 'updated' as const;
      });
    },

    async requestRun(
      athleteId: string,
      now: Date,
    ): Promise<'requested' | 'not_connected' | 'blocked' | 'running'> {
      return database.tenant(athleteId, async (tx) => {
        const row = await lockedRow(tx);
        if (row === null || row.state !== 'connected') return 'not_connected' as const;
        if (row.blocked_until !== null && row.blocked_until > now) return 'blocked' as const;
        if (leaseLive(row, now)) return 'running' as const;
        await tx.query(
          'UPDATE garmin_unofficial_connection SET run_requested_at=coalesce(run_requested_at,$2) WHERE athlete_id=$1',
          [athleteId, now],
        );
        return 'requested' as const;
      });
    },

    /**
     * Take the connection for one run if one is due: requested by the owner, or scheduled
     * and not paused. Blocked (Retry-After/backoff), leased or not-connected rows are skipped.
     */
    async acquireRun(input: {
      athleteId: string;
      runId: string;
      leaseId: string;
      now: Date;
    }): Promise<{
      trigger: 'manual' | 'scheduled';
      sessionGeneration: number;
      encryptedSession: GarminUnofficialCipher;
      profileHash: string;
    } | null> {
      z.uuid().parse(input.runId);
      z.uuid().parse(input.leaseId);
      return unlessErased(null, () =>
        database.tenant(input.athleteId, async (tx) => {
          const row = await lockedRow(tx);
          if (row === null || row.state !== 'connected' || row.encrypted_session === null)
            return null;
          if (row.profile_hash === null) return null;
          if (leaseLive(row, input.now)) return null;
          if (row.blocked_until !== null && row.blocked_until > input.now) return null;
          const scheduled =
            row.schedule_enabled &&
            !row.schedule_paused &&
            (row.next_scheduled_at === null || row.next_scheduled_at <= input.now);
          const trigger = row.run_requested_at !== null ? 'manual' : scheduled ? 'scheduled' : null;
          if (trigger === null) return null;
          // A run whose process died keeps its row; close it before starting the next one.
          await tx.query(
            "UPDATE garmin_unofficial_run SET state='failed_transient',finished_at=greatest(started_at,$2) WHERE athlete_id=$1 AND state='running'",
            [input.athleteId, input.now],
          );
          await tx.query(
            "INSERT INTO garmin_unofficial_run(athlete_id,id,trigger,state,started_at) VALUES($1,$2,$3,'running',$4)",
            [input.athleteId, input.runId, trigger, input.now],
          );
          await tx.query(
            'UPDATE garmin_unofficial_connection SET lease_id=$2,lease_until=$3,run_requested_at=NULL WHERE athlete_id=$1',
            [
              input.athleteId,
              input.leaseId,
              new Date(input.now.getTime() + GARMIN_UNOFFICIAL_RUN_LEASE_MS),
            ],
          );
          return {
            trigger,
            sessionGeneration: row.session_generation,
            encryptedSession: row.encrypted_session,
            profileHash: row.profile_hash,
          };
        }),
      );
    },

    /** True while this run still holds a connected lease; false after a disconnect. */
    async holdsRun(athleteId: string, leaseId: string, now: Date): Promise<boolean> {
      return unlessErased(false, () =>
        database.tenant(athleteId, async (tx) => {
          const result = await tx.query(
            "SELECT 1 FROM garmin_unofficial_connection WHERE athlete_id=$1 AND lease_id=$2 AND lease_until>$3 AND state='connected'",
            [athleteId, leaseId, now],
          );
          return result.rows.length === 1;
        }),
      );
    },

    /** Compare-and-set the refreshed session; a disconnect or a newer login wins. */
    async commitSession(input: {
      athleteId: string;
      leaseId: string;
      sessionGeneration: number;
      encryptedSession: GarminUnofficialCipher;
      now: Date;
    }): Promise<boolean> {
      cipherSchema.parse(input.encryptedSession);
      return unlessErased(false, () =>
        database.tenant(input.athleteId, async (tx) => {
          const result = await tx.query(
            `UPDATE garmin_unofficial_connection SET encrypted_session=$4,session_generation=session_generation+1
             WHERE athlete_id=$1 AND lease_id=$2 AND lease_until>$5 AND session_generation=$3 AND state='connected'
             RETURNING athlete_id`,
            [
              input.athleteId,
              input.leaseId,
              input.sessionGeneration,
              JSON.stringify(input.encryptedSession),
              input.now,
            ],
          );
          return result.rows.length === 1;
        }),
      );
    },

    async finishRun(input: {
      athleteId: string;
      runId: string;
      leaseId: string;
      now: Date;
      state: GarminUnofficialRunState;
      counts: GarminUnofficialRunCounts;
      complete: boolean | null;
      retryAfterMs?: number | null;
    }): Promise<void> {
      await unlessErased(undefined, () =>
        database.tenant(input.athleteId, async (tx) => {
          const row = await lockedRow(tx);
          await tx.query(
            `UPDATE garmin_unofficial_run SET state=$3,finished_at=greatest(started_at,$4),listed=$5,imported=$6,
             unchanged=$7,suppressed=$8,skipped=$9,failed=$10,complete=$11 WHERE athlete_id=$1 AND id=$2 AND state='running'`,
            [
              input.athleteId,
              input.runId,
              input.state,
              input.now,
              input.counts.listed,
              input.counts.imported,
              input.counts.unchanged,
              input.counts.suppressed,
              input.counts.skipped,
              input.counts.failed,
              input.complete,
            ],
          );
          await tx.query(
            `DELETE FROM garmin_unofficial_run WHERE athlete_id=$1 AND state<>'running' AND id NOT IN (
               SELECT id FROM garmin_unofficial_run WHERE athlete_id=$1 ORDER BY started_at DESC,id LIMIT $2)`,
            [input.athleteId, RUN_HISTORY],
          );
          // Only the lease holder moves the connection; a disconnect already moved it.
          if (row === null || row.lease_id !== input.leaseId) return;
          const next = row.schedule_enabled
            ? new Date(input.now.getTime() + GARMIN_UNOFFICIAL_SCHEDULE_HOURS * 3_600_000)
            : null;
          switch (input.state) {
            case 'succeeded':
            case 'partial':
              await tx.query(
                'UPDATE garmin_unofficial_connection SET lease_id=NULL,lease_until=NULL,transient_failures=0,next_scheduled_at=$2 WHERE athlete_id=$1',
                [input.athleteId, next],
              );
              return;
            case 'rate_limited': {
              // Honour Retry-After (bounded below), and pause the schedule until the owner
              // turns it back on; a manual run is refused until then too.
              const wait = Math.max(
                input.retryAfterMs ?? GARMIN_UNOFFICIAL_DEFAULT_RETRY_AFTER_MS,
                GARMIN_UNOFFICIAL_MIN_RETRY_AFTER_MS,
              );
              await tx.query(
                'UPDATE garmin_unofficial_connection SET lease_id=NULL,lease_until=NULL,blocked_until=$2,schedule_paused=schedule_enabled,run_requested_at=NULL WHERE athlete_id=$1',
                [input.athleteId, later(row.blocked_until, new Date(input.now.getTime() + wait))],
              );
              return;
            }
            case 'reconnect_required':
              // Never retried: the stored session is dropped and the owner logs in again.
              await tx.query(
                `UPDATE garmin_unofficial_connection SET state='reconnect_required',encrypted_session=NULL,
                 session_generation=session_generation+1,lease_id=NULL,lease_until=NULL,run_requested_at=NULL
                 WHERE athlete_id=$1`,
                [input.athleteId],
              );
              return;
            case 'failed_transient': {
              const failures = Math.min(row.transient_failures + 1, 1000);
              const wait = Math.min(300_000 * 2 ** Math.min(failures - 1, 16), 6 * 3_600_000);
              await tx.query(
                'UPDATE garmin_unofficial_connection SET lease_id=NULL,lease_until=NULL,transient_failures=$2,blocked_until=$3,next_scheduled_at=$4 WHERE athlete_id=$1',
                [
                  input.athleteId,
                  failures,
                  new Date(input.now.getTime() + wait),
                  next === null ? null : new Date(input.now.getTime() + wait),
                ],
              );
              return;
            }
            case 'cancelled':
              await tx.query(
                'UPDATE garmin_unofficial_connection SET lease_id=NULL,lease_until=NULL WHERE athlete_id=$1',
                [input.athleteId],
              );
              return;
            case 'failed_permanent':
              await tx.query(
                'UPDATE garmin_unofficial_connection SET lease_id=NULL,lease_until=NULL,schedule_paused=schedule_enabled WHERE athlete_id=$1',
                [input.athleteId],
              );
              return;
          }
        }),
      );
    },

    /** Garmin activity ids any collector (unofficial or official) already handled. */
    async knownGarminActivities(athleteId: string, ids: readonly string[]): Promise<Set<string>> {
      const values = z
        .array(garminActivityIdSchema)
        .max(1000)
        .parse([...ids]);
      if (values.length === 0) return new Set();
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          'SELECT garmin_activity_id FROM garmin_activity_ledger WHERE athlete_id=$1 AND garmin_activity_id=ANY($2::text[])',
          [athleteId, values],
        );
        return new Set(result.rows.map((row) => z.string().parse(row['garmin_activity_id'])));
      });
    },

    async recordCollected(input: {
      athleteId: string;
      garminActivityId: string;
      provider: 'garmin-connect-unofficial' | 'garmin-official';
      outcome: 'imported' | 'unchanged' | 'stale' | 'suppressed';
      sources: readonly { kind: string; sourceId: string }[];
      now: Date;
    }): Promise<void> {
      garminActivityIdSchema.parse(input.garminActivityId);
      await unlessErased(undefined, () =>
        database.tenant(input.athleteId, async (tx) => {
          await tx.query(
            'INSERT INTO garmin_activity_ledger(athlete_id,garmin_activity_id,provider,official,outcome,collected_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [
              input.athleteId,
              input.garminActivityId,
              input.provider,
              input.provider === 'garmin-official',
              input.outcome,
              input.now,
            ],
          );
          for (const source of input.sources)
            await tx.query(
              `INSERT INTO garmin_activity_ledger_source(athlete_id,garmin_activity_id,kind,source_id)
               SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM activity_source_head WHERE athlete_id=$1 AND kind=$3 AND source_id=$4)
               ON CONFLICT DO NOTHING`,
              [input.athleteId, input.garminActivityId, source.kind, source.sourceId],
            );
        }),
      );
    },

    /** The collector that brought a stored activity in, if any; independent of the adapter. */
    async provenance(athleteId: string, activityId: string) {
      z.uuid().parse(activityId);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT l.provider,l.official,l.garmin_activity_id,l.collected_at
           FROM activity_source_head s
           JOIN activity_canonical c ON c.athlete_id=s.athlete_id AND c.id=s.activity_id AND NOT c.deleted
           JOIN garmin_activity_ledger_source ls ON ls.athlete_id=s.athlete_id AND ls.kind=s.kind AND ls.source_id=s.source_id
           JOIN garmin_activity_ledger l ON l.athlete_id=ls.athlete_id AND l.garmin_activity_id=ls.garmin_activity_id
           WHERE s.athlete_id=$1 AND s.activity_id=$2
           ORDER BY l.official DESC,l.collected_at ASC LIMIT 1`,
          [athleteId, activityId],
        );
        if (!result.rows[0]) return null;
        const row = z
          .object({
            provider: z.enum(['garmin-connect-unofficial', 'garmin-official']),
            official: z.boolean(),
            garmin_activity_id: garminActivityIdSchema,
            collected_at: z.date(),
          })
          .parse(result.rows[0]);
        return {
          provider: row.provider,
          official: row.official,
          garminActivityId: row.garmin_activity_id,
          collectedAt: row.collected_at.toISOString(),
        };
      });
    },
  };
}
export type GarminUnofficialStore = ReturnType<typeof createGarminUnofficialStore>;
