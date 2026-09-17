import type { CoreEvidenceSnapshot } from '@workout/contracts/evidence-snapshots';
export const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  at = '2026-09-18T00:00:00Z';
const command = {
  expectedConversationRevision: 1,
  window: { from: '2026-09-17', toExclusive: '2026-09-19', timezone: 'UTC' },
  idempotencyKey: 'stable',
};
export const purged = {
  id,
  threadId: id,
  createdAt: at,
  status: 'purged',
  reason: 'source_deleted',
};
export function available(): CoreEvidenceSnapshot {
  return {
    id,
    threadId: id,
    createdAt: at,
    status: 'available',
    body: {
      schemaVersion: 1,
      scope: 'running-core-v1',
      window: command.window,
      thread: {
        id,
        planVersionId: id,
        title: 'thread',
        scope: { kind: 'phase', targetId: 'phase' },
        revision: 1,
        createdAt: at,
        updatedAt: at,
      },
      plan: {
        id,
        version: 1,
        createdAt: at,
        draft: {
          title: 'plan',
          timezone: 'UTC',
          sessions: [],
          periods: (['season', 'wave', 'phase'] as const).map((level, i, levels) => ({
            id: level,
            parentId: i ? (levels[i - 1] ?? null) : null,
            level,
            title: level,
            startDate: '2026-09-17',
            endDateExclusive: '2026-09-19',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          })),
        },
      },
      messages: [
        { id, threadId: id, revision: 1, role: 'user', content: 'question', createdAt: at },
      ],
      activities: [],
      checkIns: [],
      sessionCompletions: [],
      dependencies: {
        schemaVersion: 1,
        scope: 'core-ledgers-v1',
        athleteId: 'owner',
        capturedAt: at,
        trainingPlan: { kind: 'exists', versionId: id },
        activities: { count: '0', revisionSum: '0' },
        checkIns: { kind: 'absent' },
        sessionCompletions: { kind: 'absent' },
        aiConsent: { kind: 'absent' },
      },
    },
  };
}
