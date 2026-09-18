import { describe, expect, it, vi } from 'vitest';
import {
  setLogCorrectCommandSchema,
  setLogCreateCommandSchema,
  setLogDeleteCommandSchema,
  setLogReadSchema,
} from '@workout/contracts/supplementary-core';
import {
  OFFLINE_SET_RETENTION_MS,
  OFFLINE_ACCOUNT_SCOPE_KEY,
  OfflineSetAccountScopeError,
  OfflineSetConsentRequiredError,
  OfflineSetQueueConflictError,
  OfflineSetQueueCorruptError,
  OfflineSetStorageError,
  createOfflineSetQueue,
  type OfflineSetDispatcher,
  type OfflineSetStorage,
} from '../src/offline-set-queue';

const executionId = '11111111-1111-4111-8111-111111111111';
const logId = '22222222-2222-4222-8222-222222222222';
const exerciseVersionId = '33333333-3333-4333-8333-333333333333';
const activityId = '44444444-4444-4444-8444-444444444444';
const revisionId = '55555555-5555-4555-8555-555555555555';
const occurredAt = '2026-09-18T01:00:00.000Z';
const create = setLogCreateCommandSchema.parse({
  schemaVersion: 2,
  executionId,
  logId,
  expectedExecutionRevision: 1,
  idempotencyKey: 'offline_create_01',
  confirmation: 'user_confirmed',
  values: {
    targetSetId: null,
    blockId: null,
    roundIndex: null,
    exerciseVersionId,
    side: 'bilateral',
    state: 'performed',
    count: {
      actual: { unit: 'count', value: 4, status: 'reported', evidenceIds: [] },
      definition: { kind: 'repetitions', basis: 'total', definitionId: 'reps-total-v1' },
    },
    durationSeconds: { unit: 's', value: null, status: 'unknown', evidenceIds: [] },
    externalResistance: { kind: 'no_added_load' },
    effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
    occurredAt,
    reason: null,
  },
});
const correct = setLogCorrectCommandSchema.parse({
  schemaVersion: 2,
  executionId,
  logId,
  expectedRevision: 1,
  idempotencyKey: 'offline_correct_01',
  confirmation: 'user_confirmed',
  values: {
    ...create.values,
    count: {
      ...create.values.count,
      actual: { unit: 'count', value: 5, status: 'reported', evidenceIds: [] },
    },
  },
});
const deletion = setLogDeleteCommandSchema.parse({
  schemaVersion: 2,
  executionId,
  logId,
  expectedRevision: 2,
  idempotencyKey: 'offline_delete_01',
  confirmed: true,
  reason: '잘못된 기록',
});
const active = setLogReadSchema.parse({
  status: 'active',
  current: {
    ...create.values,
    logId,
    revisionId,
    activityId,
    executionId,
    revision: 1,
    source: 'user',
    recordedAt: occurredAt,
  },
});
const deleted = setLogReadSchema.parse({
  status: 'deleted',
  executionId,
  logId,
  revision: 3,
  deletedAt: occurredAt,
});

function fixture() {
  const records = new Map<string, string>([[OFFLINE_ACCOUNT_SCOPE_KEY, 'user_a']]);
  const storage: OfflineSetStorage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      records.set(key, value);
    },
    removeItem: (key) => {
      records.delete(key);
    },
  };
  let time = 1_800_000_000_000;
  const queue = (userId = 'user_a') => createOfflineSetQueue({ userId, storage, now: () => time });
  return {
    records,
    storage,
    queue,
    advance: (ms: number) => (time += ms),
    activeUser: (userId: string) => records.set(OFFLINE_ACCOUNT_SCOPE_KEY, userId),
  };
}

function dispatcher(overrides: Partial<OfflineSetDispatcher> = {}): OfflineSetDispatcher {
  return {
    createSet: async () => active,
    correctSet: async () => active,
    deleteSet: async () => deleted,
    ...overrides,
  };
}

describe('consented offline supplementary actual queue', () => {
  it('requires opt-in and a user-confirmed actual; stores no draft or token', () => {
    const { queue, records } = fixture();
    const subject = queue();
    expect(() => subject.enqueue({ kind: 'create', command: create })).toThrow(
      OfflineSetConsentRequiredError,
    );
    subject.enable();
    expect(() =>
      subject.enqueue({
        kind: 'create',
        command: {
          ...create,
          confirmation: 'draft',
          values: { ...create.values, state: 'unconfirmed', count: null },
        },
      }),
    ).toThrow();
    subject.enqueue({ kind: 'create', command: create });
    expect(
      [...records.keys()].some((key) =>
        /^workout:private:supplementary:offline-sets:v1:/.test(key),
      ),
    ).toBe(true);
    expect([...records.values()].some((value) => value.includes('offline_create_01'))).toBe(true);
    expect([...records.values()].join(' ')).not.toContain('token');
    expect(subject.snapshot().entries).toMatchObject([{ status: 'pending' }]);
  });

  it('retains stable ID, key, and body across reload and ambiguous network failure', async () => {
    const { queue, records } = fixture();
    const first = queue();
    first.enable();
    first.enqueue({ kind: 'create', command: create });
    const attempts: unknown[] = [];
    const failing = dispatcher({
      createSet: async (command) => {
        attempts.push(command);
        throw new Error('response lost');
      },
    });
    expect(await first.flush(failing)).toMatchObject({ pending: 1, stoppedBy: 'network' });
    const reloaded = queue();
    expect(reloaded.snapshot().entries).toMatchObject([{ status: 'pending' }]);
    expect(
      await reloaded.flush(
        dispatcher({
          createSet: async (command) => {
            attempts.push(command);
            return active;
          },
        }),
      ),
    ).toMatchObject({ confirmed: 1, pending: 0, stoppedBy: 'none' });
    expect(attempts).toEqual([create, create]);
    expect(reloaded.snapshot().entries).toMatchObject([{ status: 'confirmed' }]);
    expect([...records.values()].join(' ')).not.toContain('reps-total-v1');
  });

  it('serializes create, correction and deletion with their original commands', async () => {
    const { queue } = fixture();
    const subject = queue();
    subject.enable();
    subject.enqueue({ kind: 'create', command: create });
    subject.enqueue({ kind: 'correct', command: correct });
    subject.enqueue({ kind: 'delete', command: deletion });
    const sent: string[] = [];
    const result = await subject.flush(
      dispatcher({
        createSet: async (command) => {
          sent.push(command.idempotencyKey);
          return active;
        },
        correctSet: async (command) => {
          sent.push(command.idempotencyKey);
          return active;
        },
        deleteSet: async (command) => {
          sent.push(command.idempotencyKey);
          return deleted;
        },
      }),
    );
    expect(result).toMatchObject({ confirmed: 3, pending: 0 });
    expect(sent).toEqual(['offline_create_01', 'offline_correct_01', 'offline_delete_01']);
  });

  it('does not replace a stable key with changed content or send after a 409', async () => {
    const { queue } = fixture();
    const subject = queue();
    subject.enable();
    subject.enqueue({ kind: 'create', command: create });
    expect(subject.enqueue({ kind: 'create', command: create })).toMatchObject({
      status: 'pending',
    });
    expect(() =>
      subject.enqueue({
        kind: 'create',
        command: { ...create, values: { ...create.values, reason: 'changed' } },
      }),
    ).toThrow(OfflineSetQueueConflictError);
    subject.enqueue({ kind: 'correct', command: correct });
    const correctSpy = vi.fn(async () => active);
    const result = await subject.flush(
      dispatcher({
        createSet: async () => {
          throw { status: 409 };
        },
        correctSet: correctSpy,
      }),
    );
    expect(result).toMatchObject({ confirmed: 0, pending: 1, needsReview: 1, stoppedBy: 'review' });
    expect(correctSpy).not.toHaveBeenCalled();
    expect(subject.snapshot().entries[0]).toMatchObject({
      status: 'needs_review',
      reason: 'conflict',
    });
  });

  it('rejects a mismatched success response instead of marking an actual confirmed', async () => {
    const { queue } = fixture();
    const subject = queue();
    subject.enable();
    subject.enqueue({ kind: 'create', command: create });
    const result = await subject.flush(dispatcher({ createSet: async () => deleted }));
    expect(result).toMatchObject({ confirmed: 0, needsReview: 1, stoppedBy: 'review' });
    expect(subject.snapshot().entries[0]).toMatchObject({
      status: 'needs_review',
      reason: 'response_mismatch',
    });
  });

  it('separates accounts, clears on withdrawal, and expires consent and pending data after seven days', () => {
    const { queue, records, advance, activeUser } = fixture();
    const userA = queue('user_a');
    userA.enable();
    userA.enqueue({ kind: 'create', command: create });
    expect(() => queue('user_b').snapshot()).toThrow(OfflineSetAccountScopeError);
    activeUser('user_b');
    expect(queue('user_b').snapshot()).toMatchObject({ consented: false, entries: [] });
    expect(() => userA.enqueue({ kind: 'create', command: create })).toThrow(
      OfflineSetAccountScopeError,
    );
    activeUser('user_a');
    userA.clear();
    expect(records.size).toBe(1);
    expect(queue('user_a').snapshot()).toMatchObject({ consented: false, entries: [] });
    userA.enable();
    userA.enqueue({ kind: 'create', command: create });
    advance(OFFLINE_SET_RETENTION_MS);
    expect(userA.snapshot()).toMatchObject({ consented: false, entries: [], expiredCount: 1 });
    expect(records.size).toBe(1);
  });

  it('does not restore or continue a queue cleared during an in-flight send', async () => {
    const { queue, records } = fixture();
    const subject = queue();
    subject.enable();
    subject.enqueue({ kind: 'create', command: create });
    subject.enqueue({ kind: 'correct', command: correct });
    let resolveSend: ((value: typeof active) => void) | undefined;
    const firstSend = new Promise<typeof active>((resolve) => {
      resolveSend = resolve;
    });
    const secondSend = vi.fn(async () => active);
    const sending = subject.flush(
      dispatcher({ createSet: async () => firstSend, correctSet: secondSend }),
    );
    subject.clear();
    resolveSend?.(active);
    expect(await sending).toMatchObject({ confirmed: 0, stoppedBy: 'cancelled' });
    expect(secondSend).not.toHaveBeenCalled();
    expect(records.size).toBe(1);
  });

  it('stops an in-flight replay when another tab switches account scope', async () => {
    const { queue, activeUser, records } = fixture();
    const subject = queue();
    subject.enable();
    subject.enqueue({ kind: 'create', command: create });
    let resolveSend: ((value: typeof active) => void) | undefined;
    const firstSend = new Promise<typeof active>((resolve) => {
      resolveSend = resolve;
    });
    const sending = subject.flush(dispatcher({ createSet: async () => firstSend }));
    activeUser('user_b');
    resolveSend?.(active);
    await expect(sending).rejects.toThrow(OfflineSetAccountScopeError);
    expect(() => subject.enqueue({ kind: 'create', command: create })).toThrow(
      OfflineSetAccountScopeError,
    );
    subject.clear();
    expect([...records.keys()]).toEqual([OFFLINE_ACCOUNT_SCOPE_KEY]);
  });

  it('fails closed when browser storage is unavailable or records are corrupt', () => {
    const { queue, storage, records } = fixture();
    const subject = queue();
    subject.enable();
    const key = [...records.keys()].find((value) => value !== OFFLINE_ACCOUNT_SCOPE_KEY);
    expect(key).toBeDefined();
    if (key === undefined) throw new Error('Expected persisted queue key');
    records.set(key, '{broken');
    expect(() => subject.snapshot()).toThrow(OfflineSetQueueCorruptError);
    const unavailable = createOfflineSetQueue({
      userId: 'user_a',
      storage: {
        ...storage,
        setItem: () => {
          throw new Error('quota');
        },
      },
    });
    expect(() => unavailable.enable()).toThrow(OfflineSetQueueCorruptError);
    records.delete(key);
    expect(() => unavailable.enable()).toThrow(OfflineSetStorageError);
    expect(() => unavailable.enqueue({ kind: 'create', command: create })).toThrow(
      OfflineSetConsentRequiredError,
    );
  });
});
