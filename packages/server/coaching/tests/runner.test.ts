import { afterEach, describe, expect, it, vi } from 'vitest';
import { coachingFixtureCandidateContentV1Schema } from '@workout/contracts/coaching-runs';
import { coreEvidenceBodyV2Schema } from '@workout/contracts/evidence-snapshots';
import {
  createDeterministicFixtureAdapter,
  runOneCoachingJob,
  type CoachingAdapterOutcome,
  type CoachingJobLease,
  type CoachingRunWorkerStore,
} from '../src/runner.js';

const at = '2026-09-18T00:00:00Z';
const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const messageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const lease: CoachingJobLease = {
  athleteId: 'synthetic-owner',
  eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  leaseToken: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  attempts: 1,
  leaseSeconds: 120,
};

function recordingStore() {
  const outcomes: CoachingAdapterOutcome[] = [];
  const store: CoachingRunWorkerStore = {
    async claim() {
      return lease;
    },
    async prepare() {
      return { kind: 'ready', evidence: evidence(600), grounding: null };
    },
    async renew() {
      return true;
    },
    async finish(_lease, outcome) {
      outcomes.push(outcome);
      return 'stored';
    },
  };
  return { store, outcomes };
}

function evidence(durationSeconds: number | null, includeSession = true, range = false) {
  return coreEvidenceBodyV2Schema.parse({
    schemaVersion: 2,
    scope: 'running-core-v2',
    window: { from: '2026-09-18', toExclusive: '2026-09-25', timezone: 'UTC' },
    thread: {
      id: threadId,
      planVersionId: planId,
      title: 'Synthetic review',
      scope: { kind: 'block', targetId: 'block' },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
    plan: {
      id: planId,
      version: 1,
      createdAt: at,
      draft: {
        title: 'Synthetic plan',
        timezone: 'UTC',
        periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
          id: level,
          parentId: index === 0 ? null : levels[index - 1],
          level,
          title: level,
          startDate: '2026-09-18',
          endDateExclusive: '2026-09-25',
          timezone: 'UTC',
          intent: '',
          isPartial: false,
        })),
        sessions: includeSession
          ? [
              {
                id: 'session',
                blockId: 'block',
                date: '2026-09-20',
                localStartTime: null,
                title: 'Synthetic run',
                sport: 'running',
                durationSeconds,
                ...(range ? { durationRange: { minSeconds: 300, maxSeconds: 900 } } : {}),
                distanceMeters: null,
                targetRpe: null,
                purpose: '',
                notes: '',
                priority: 'normal',
                locks: { date: false, time: false, intensity: false },
                steps: [],
              },
            ]
          : [],
      },
    },
    messages: [
      {
        id: messageId,
        threadId,
        revision: 1,
        role: 'user',
        content: 'Synthetic prompt',
        createdAt: at,
      },
    ],
    dependencies: {
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      athleteId: 'synthetic-owner',
      capturedAt: at,
      trainingPlan: { kind: 'exists', versionId: planId },
      activities: { count: '0', revisionSum: '0' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      userConstraints: { kind: 'absent' },
      aiConsent: { kind: 'exists', revision: 1, granted: true },
    },
    userConstraints: { headRevision: null, items: [] },
    activities: [],
    checkIns: [],
    sessionCompletions: [],
  });
}

describe('M1-05j3a nonproduction structured fixture', () => {
  it('proposes exactly one bounded duration change with explicit synthetic provenance', async () => {
    const adapter = createDeterministicFixtureAdapter('synthetic-v1');
    const result = await adapter.evaluate(evidence(3600), null, new AbortController().signal);
    expect(result).toMatchObject({
      kind: 'analysis',
      content: {
        schemaVersion: 1,
        scope: 'running-core-v2-training',
        intent: {
          kind: 'set_session_duration_seconds',
          sessionId: 'session',
          durationSeconds: 3900,
        },
        summary: 'Synthetic fixture duration proposal; not validated or approved.',
      },
    });
    if (typeof result !== 'object' || result === null || !('content' in result))
      throw new Error('Expected structured fixture content');
    expect(coachingFixtureCandidateContentV1Schema.safeParse(result.content).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Synthetic prompt');
    expect(JSON.stringify(result)).not.toContain('synthetic-owner');
  });

  it('subtracts at the upper bound and asks a question when exact duration is absent', async () => {
    const adapter = createDeterministicFixtureAdapter('synthetic-v1');
    expect(
      await adapter.evaluate(evidence(604800), null, new AbortController().signal),
    ).toMatchObject({
      kind: 'analysis',
      content: { intent: { durationSeconds: 604500 } },
    });
    for (const input of [evidence(null), evidence(null, true, true), evidence(null, false)]) {
      expect(await adapter.evaluate(input, null, new AbortController().signal)).toEqual({
        kind: 'needs_question',
        question: 'What exact duration should the first planned session use?',
      });
    }
  });

  it('persists only the bounded untrusted analysis outcome through the worker boundary', async () => {
    const { store, outcomes } = recordingStore();
    expect(
      await runOneCoachingJob({
        athleteId: lease.athleteId,
        store,
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('stored');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: 'analysis',
      content: { intent: { sessionId: 'session', durationSeconds: 900 } },
    });
  });
});

describe('bounded coaching evaluation', () => {
  afterEach(() => vi.useRealTimers());

  it('stores a successful result and clears its deadline timer', async () => {
    vi.useFakeTimers();
    const { store, outcomes } = recordingStore();
    let signal: AbortSignal | undefined;
    const result = await runOneCoachingJob({
      athleteId: lease.athleteId,
      store,
      evaluationTimeoutMs: 10,
      adapter: {
        async evaluate(_evidence, _grounding, receivedSignal) {
          signal = receivedSignal;
          return { kind: 'needs_question', question: 'How long?' };
        },
      },
    });
    expect(result).toBe('stored');
    expect(outcomes).toEqual([{ kind: 'needs_question', question: 'How long?' }]);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts at the deadline and stores only the budget outcome', async () => {
    vi.useFakeTimers();
    const { store, outcomes } = recordingStore();
    let signal: AbortSignal | undefined;
    const pending = runOneCoachingJob({
      athleteId: lease.athleteId,
      store,
      evaluationTimeoutMs: 10,
      adapter: {
        evaluate(_evidence, _grounding, receivedSignal) {
          signal = receivedSignal;
          return new Promise(() => {});
        },
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBe('stored');
    expect(signal?.aborted).toBe(true);
    expect(outcomes).toEqual([
      {
        kind: 'unable_to_evaluate',
        code: 'budget_exceeded',
        reason: 'Evaluation exceeded its time budget',
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores both late resolution and late rejection after a deadline', async () => {
    vi.useFakeTimers();
    for (const settle of ['resolve', 'reject'] as const) {
      const { store, outcomes } = recordingStore();
      let resolve!: (value: unknown) => void;
      let reject!: (reason?: unknown) => void;
      const pending = runOneCoachingJob({
        athleteId: lease.athleteId,
        store,
        evaluationTimeoutMs: 10,
        adapter: {
          evaluate() {
            return new Promise((accept, decline) => {
              resolve = accept;
              reject = decline;
            });
          },
        },
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toBe('stored');
      if (settle === 'resolve') resolve({ kind: 'needs_question', question: 'Late' });
      else reject(new Error('Late failure'));
      await Promise.resolve();
      await Promise.resolve();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ kind: 'unable_to_evaluate', code: 'budget_exceeded' });
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('stores an adapter throw as unavailable and clears its deadline timer', async () => {
    vi.useFakeTimers();
    const { store, outcomes } = recordingStore();
    expect(
      await runOneCoachingJob({
        athleteId: lease.athleteId,
        store,
        evaluationTimeoutMs: 10,
        adapter: {
          async evaluate() {
            throw new Error('Provider failed');
          },
        },
      }),
    ).toBe('stored');
    expect(outcomes).toEqual([
      {
        kind: 'unable_to_evaluate',
        code: 'provider_unavailable',
        reason: 'Evaluation could not be completed',
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renews through a long evaluation and clears the heartbeat after completion', async () => {
    vi.useFakeTimers();
    const { store, outcomes } = recordingStore();
    const renew = vi.fn(async () => true);
    store.renew = renew;
    store.claim = async () => ({ ...lease, leaseSeconds: 1 });
    let release!: (value: unknown) => void;
    const pending = runOneCoachingJob({
      athleteId: lease.athleteId,
      store,
      evaluationTimeoutMs: 2000,
      adapter: {
        evaluate() {
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect(renew.mock.calls.length).toBeGreaterThan(2);
    release({ kind: 'needs_question', question: 'Finished' });
    expect(await pending).toBe('stored');
    expect(outcomes).toEqual([{ kind: 'needs_question', question: 'Finished' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts and skips output when lease renewal fails during evaluation', async () => {
    vi.useFakeTimers();
    const { store, outcomes } = recordingStore();
    store.claim = async () => ({ ...lease, leaseSeconds: 1 });
    let renewals = 0;
    store.renew = async () => ++renewals === 1;
    let signal: AbortSignal | undefined;
    const pending = runOneCoachingJob({
      athleteId: lease.athleteId,
      store,
      evaluationTimeoutMs: 2000,
      adapter: {
        evaluate(_evidence, _grounding, receivedSignal) {
          signal = receivedSignal;
          return new Promise(() => {});
        },
      },
    });
    await vi.advanceTimersByTimeAsync(333);
    expect(await pending).toBe('skipped');
    expect(signal?.aborted).toBe(true);
    expect(outcomes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
