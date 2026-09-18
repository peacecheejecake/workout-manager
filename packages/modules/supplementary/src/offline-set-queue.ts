import { z } from 'zod';
import {
  setLogCorrectCommandSchema,
  setLogCreateCommandSchema,
  setLogDeleteCommandSchema,
  setLogReadSchema,
  type SetLogCorrectCommand,
  type SetLogCreateCommand,
  type SetLogDeleteCommand,
  type SetLogRead,
} from '@workout/contracts/supplementary-core';

/** Explicit opt-in is required before sensitive set actuals enter browser storage. */
export const OFFLINE_SET_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_COMMANDS = 100;
const MAX_STORED_BYTES = 256 * 1_024;
export const OFFLINE_SET_STORAGE_PREFIX = 'workout:private:supplementary:offline-sets:v1:';
export const OFFLINE_ACCOUNT_SCOPE_KEY = 'workout:private:account-scope';

const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), command: setLogCreateCommandSchema }),
  z.strictObject({ kind: z.literal('correct'), command: setLogCorrectCommandSchema }),
  z.strictObject({ kind: z.literal('delete'), command: setLogDeleteCommandSchema }),
]);
export type OfflineSetCommand = z.infer<typeof commandSchema>;

const identitySchema = z.strictObject({
  kind: z.enum(['create', 'correct', 'delete']),
  executionId: z.uuid(),
  logId: z.uuid(),
  idempotencyKey: z.string().min(8).max(128),
  queuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});
const pendingSchema = identitySchema.safeExtend({
  status: z.literal('pending'),
  payload: commandSchema,
});
const reviewSchema = identitySchema.safeExtend({
  status: z.literal('needs_review'),
  payload: commandSchema,
  reason: z.enum(['conflict', 'rejected', 'response_mismatch']),
});
const confirmedSchema = identitySchema.safeExtend({
  status: z.literal('confirmed'),
  confirmedAt: z.number().int().nonnegative(),
});
const entrySchema = z.discriminatedUnion('status', [pendingSchema, reviewSchema, confirmedSchema]);
export type OfflineSetEntry = z.infer<typeof entrySchema>;

const envelopeSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().min(1).max(128),
  consentedAt: z.number().int().nonnegative(),
  consentExpiresAt: z.number().int().positive(),
  entries: z.array(entrySchema).max(MAX_COMMANDS),
});
type Envelope = z.infer<typeof envelopeSchema>;

/** Minimal storage port: callers supply authenticated browser storage, never tokens. */
export interface OfflineSetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OfflineSetDispatcher {
  createSet(command: SetLogCreateCommand, signal?: AbortSignal): Promise<SetLogRead>;
  correctSet(command: SetLogCorrectCommand, signal?: AbortSignal): Promise<SetLogRead>;
  deleteSet(command: SetLogDeleteCommand, signal?: AbortSignal): Promise<SetLogRead>;
}

export class OfflineSetStorageError extends Error {
  constructor() {
    super('OFFLINE_SET_STORAGE_UNAVAILABLE');
  }
}

export class OfflineSetQueueCorruptError extends Error {
  constructor() {
    super('OFFLINE_SET_QUEUE_CORRUPT');
  }
}

export class OfflineSetQueueConflictError extends Error {
  constructor() {
    super('OFFLINE_SET_COMMAND_CONFLICT');
  }
}

export class OfflineSetConsentRequiredError extends Error {
  constructor() {
    super('OFFLINE_SET_CONSENT_REQUIRED');
  }
}

export class OfflineSetAccountScopeError extends Error {
  constructor() {
    super('OFFLINE_SET_ACCOUNT_SCOPE_CHANGED');
  }
}

export type OfflineSetSnapshot = {
  consented: boolean;
  consentExpiresAt: number | null;
  entries: readonly OfflineSetEntry[];
  expiredCount: number;
};

export type OfflineSetFlushResult = {
  confirmed: number;
  pending: number;
  needsReview: number;
  stoppedBy: 'none' | 'network' | 'review' | 'cancelled';
};

function commandIdentity(payload: OfflineSetCommand) {
  return {
    kind: payload.kind,
    executionId: payload.command.executionId,
    logId: payload.command.logId,
    idempotencyKey: payload.command.idempotencyKey,
  };
}

function isSamePayload(a: OfflineSetCommand, b: OfflineSetCommand): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function responseMatches(payload: OfflineSetCommand, value: unknown): boolean {
  const parsed = setLogReadSchema.safeParse(value);
  if (!parsed.success) return false;
  const actual = parsed.data;
  if (payload.kind === 'delete')
    return (
      actual.status === 'deleted' &&
      actual.executionId === payload.command.executionId &&
      actual.logId === payload.command.logId
    );
  return (
    actual.status === 'active' &&
    actual.current.executionId === payload.command.executionId &&
    actual.current.logId === payload.command.logId
  );
}

function failureStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  return typeof error.status === 'number' ? error.status : null;
}

/**
 * Stores at most 100 set commands for seven days. Consent also expires after seven
 * days and must be renewed explicitly. Confirmed receipts shed the sensitive body.
 * Call clear() on logout, account switch, or consent withdrawal. The caller must
 * never queue plan approval, timers, or unconfirmed set drafts through this port.
 */
export function createOfflineSetQueue(options: {
  userId: string;
  storage: OfflineSetStorage;
  now?: () => number;
}) {
  const userId = options.userId;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('INVALID_OFFLINE_SET_USER_SCOPE');
  const key = `${OFFLINE_SET_STORAGE_PREFIX}${userId}`;
  const now = options.now ?? Date.now;
  let generation = 0;
  let activeController: AbortController | null = null;
  let activeFlush: Promise<OfflineSetFlushResult> | null = null;

  function assertAccountScope(): void {
    let activeUserId: string | null;
    try {
      activeUserId = options.storage.getItem(OFFLINE_ACCOUNT_SCOPE_KEY);
    } catch {
      throw new OfflineSetStorageError();
    }
    if (activeUserId !== userId) {
      generation += 1;
      activeController?.abort();
      throw new OfflineSetAccountScopeError();
    }
  }

  function readRaw(): string | null {
    assertAccountScope();
    let raw: string | null;
    try {
      raw = options.storage.getItem(key);
    } catch {
      throw new OfflineSetStorageError();
    }
    assertAccountScope();
    return raw;
  }

  function write(envelope: Envelope): void {
    assertAccountScope();
    const raw = JSON.stringify(envelope);
    if (raw.length > MAX_STORED_BYTES) throw new OfflineSetStorageError();
    try {
      options.storage.setItem(key, raw);
    } catch {
      throw new OfflineSetStorageError();
    }
    try {
      assertAccountScope();
    } catch (error) {
      remove();
      throw error;
    }
  }

  function remove(): void {
    try {
      options.storage.removeItem(key);
    } catch {
      throw new OfflineSetStorageError();
    }
  }

  function read(): { envelope: Envelope | null; expiredCount: number } {
    const raw = readRaw();
    if (raw === null) return { envelope: null, expiredCount: 0 };
    if (raw.length > MAX_STORED_BYTES) throw new OfflineSetQueueCorruptError();
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new OfflineSetQueueCorruptError();
    }
    const parsed = envelopeSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.userId !== userId) throw new OfflineSetQueueCorruptError();
    const envelope = parsed.data;
    const currentTime = now();
    if (currentTime >= envelope.consentExpiresAt) {
      const expiredCount = envelope.entries.filter((entry) => entry.status !== 'confirmed').length;
      remove();
      return { envelope: null, expiredCount };
    }
    const entries = envelope.entries.filter((entry) => currentTime < entry.expiresAt);
    const expiredCount = envelope.entries.length - entries.length;
    if (expiredCount > 0) {
      const updated = { ...envelope, entries };
      write(updated);
      return { envelope: updated, expiredCount };
    }
    return { envelope, expiredCount: 0 };
  }

  function snapshot(): OfflineSetSnapshot {
    const { envelope, expiredCount } = read();
    return {
      consented: envelope !== null,
      consentExpiresAt: envelope?.consentExpiresAt ?? null,
      entries: envelope?.entries ?? [],
      expiredCount,
    };
  }

  function enable(): OfflineSetSnapshot {
    const currentTime = now();
    const existing = read().envelope;
    write({
      version: 1,
      userId,
      consentedAt: currentTime,
      consentExpiresAt: currentTime + OFFLINE_SET_RETENTION_MS,
      entries: existing?.entries ?? [],
    });
    return snapshot();
  }

  function clear(): void {
    cancel();
    remove();
  }

  function cancel(): void {
    generation += 1;
    activeController?.abort();
  }

  function enqueue(input: OfflineSetCommand): OfflineSetEntry {
    const payload = commandSchema.parse(input);
    if (payload.kind !== 'delete' && payload.command.confirmation !== 'user_confirmed')
      throw new Error('OFFLINE_SET_ACTUAL_REQUIRES_CONFIRMATION');
    const { envelope } = read();
    if (envelope === null) throw new OfflineSetConsentRequiredError();
    const identity = commandIdentity(payload);
    const existing = envelope.entries.find(
      (entry) => entry.idempotencyKey === identity.idempotencyKey,
    );
    if (existing) {
      if (
        existing.kind !== identity.kind ||
        existing.executionId !== identity.executionId ||
        existing.logId !== identity.logId ||
        ('payload' in existing && !isSamePayload(existing.payload, payload))
      )
        throw new OfflineSetQueueConflictError();
      return existing;
    }
    if (envelope.entries.length >= MAX_COMMANDS) throw new Error('OFFLINE_SET_QUEUE_FULL');
    const currentTime = now();
    const entry: OfflineSetEntry = {
      ...identity,
      status: 'pending',
      payload,
      queuedAt: currentTime,
      expiresAt: currentTime + OFFLINE_SET_RETENTION_MS,
    };
    write({ ...envelope, entries: [...envelope.entries, entry] });
    return entry;
  }

  async function flushOnce(dispatcher: OfflineSetDispatcher): Promise<OfflineSetFlushResult> {
    const initial = read().envelope;
    if (initial === null) throw new OfflineSetConsentRequiredError();
    const currentGeneration = generation;
    const controller = new AbortController();
    activeController = controller;
    let confirmed = 0;
    let stoppedBy: OfflineSetFlushResult['stoppedBy'] = 'none';
    try {
      for (const queued of initial.entries) {
        if (queued.status !== 'pending') {
          if (queued.status === 'needs_review') {
            stoppedBy = 'review';
            break;
          }
          continue;
        }
        if (currentGeneration !== generation || controller.signal.aborted) {
          stoppedBy = 'cancelled';
          break;
        }
        assertAccountScope();
        const latest = read().envelope;
        const entry = latest?.entries.find((item) => item.idempotencyKey === queued.idempotencyKey);
        if (!entry || entry.status !== 'pending') continue;
        let response: SetLogRead;
        try {
          switch (entry.payload.kind) {
            case 'create':
              response = await dispatcher.createSet(entry.payload.command, controller.signal);
              break;
            case 'correct':
              response = await dispatcher.correctSet(entry.payload.command, controller.signal);
              break;
            case 'delete':
              response = await dispatcher.deleteSet(entry.payload.command, controller.signal);
              break;
          }
        } catch (error) {
          if (currentGeneration !== generation || controller.signal.aborted) {
            stoppedBy = 'cancelled';
            break;
          }
          const status = failureStatus(error);
          if (status !== null && status >= 400 && status < 500) {
            const reason = status === 409 ? 'conflict' : 'rejected';
            const refreshed = read().envelope;
            if (refreshed) {
              write({
                ...refreshed,
                entries: refreshed.entries.map((item) =>
                  item.idempotencyKey === entry.idempotencyKey && item.status === 'pending'
                    ? { ...item, status: 'needs_review', reason }
                    : item,
                ),
              });
            }
            stoppedBy = 'review';
          } else stoppedBy = 'network';
          break;
        }
        if (currentGeneration !== generation || controller.signal.aborted) {
          stoppedBy = 'cancelled';
          break;
        }
        assertAccountScope();
        const refreshed = read().envelope;
        if (!refreshed) {
          stoppedBy = 'cancelled';
          break;
        }
        const matched = responseMatches(entry.payload, response);
        write({
          ...refreshed,
          entries: refreshed.entries.map((item) =>
            item.idempotencyKey === entry.idempotencyKey && item.status === 'pending'
              ? matched
                ? {
                    kind: item.kind,
                    executionId: item.executionId,
                    logId: item.logId,
                    idempotencyKey: item.idempotencyKey,
                    queuedAt: item.queuedAt,
                    expiresAt: item.expiresAt,
                    status: 'confirmed',
                    confirmedAt: now(),
                  }
                : { ...item, status: 'needs_review', reason: 'response_mismatch' }
              : item,
          ),
        });
        if (!matched) {
          stoppedBy = 'review';
          break;
        }
        confirmed += 1;
      }
    } finally {
      if (activeController === controller) activeController = null;
    }
    const entries = read().envelope?.entries ?? [];
    return {
      confirmed,
      pending: entries.filter((entry) => entry.status === 'pending').length,
      needsReview: entries.filter((entry) => entry.status === 'needs_review').length,
      stoppedBy,
    };
  }

  function flush(dispatcher: OfflineSetDispatcher): Promise<OfflineSetFlushResult> {
    if (activeFlush) return activeFlush;
    const promise = flushOnce(dispatcher);
    activeFlush = promise;
    void promise.then(
      () => {
        if (activeFlush === promise) activeFlush = null;
      },
      () => {
        if (activeFlush === promise) activeFlush = null;
      },
    );
    return promise;
  }

  return { enable, snapshot, enqueue, flush, cancel, clear };
}
