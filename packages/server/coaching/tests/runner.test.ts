import { describe, expect, it } from 'vitest';
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
    const result = await adapter.evaluate(evidence(3600), null);
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
    expect(await adapter.evaluate(evidence(604800), null)).toMatchObject({
      kind: 'analysis',
      content: { intent: { durationSeconds: 604500 } },
    });
    for (const input of [evidence(null), evidence(null, true, true), evidence(null, false)]) {
      expect(await adapter.evaluate(input, null)).toEqual({
        kind: 'needs_question',
        question: 'What exact duration should the first planned session use?',
      });
    }
  });

  it('persists only the bounded untrusted analysis outcome through the worker boundary', async () => {
    const lease: CoachingJobLease = {
      athleteId: 'synthetic-owner',
      eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      leaseToken: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      attempts: 1,
    };
    let stored: CoachingAdapterOutcome | null = null;
    const store: CoachingRunWorkerStore = {
      async claim() {
        return lease;
      },
      async prepare() {
        return { kind: 'ready', evidence: evidence(600), grounding: null };
      },
      async finish(_lease, outcome) {
        stored = outcome;
        return 'stored';
      },
    };
    expect(
      await runOneCoachingJob({
        athleteId: lease.athleteId,
        store,
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('stored');
    expect(stored).toMatchObject({
      kind: 'analysis',
      content: { intent: { sessionId: 'session', durationSeconds: 900 } },
    });
  });
});
