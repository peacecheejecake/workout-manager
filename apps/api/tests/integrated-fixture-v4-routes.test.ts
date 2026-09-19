import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  integratedCandidateV4Schema,
  type IntegratedCandidateV4,
} from '@workout/contracts/integrated-coaching';
import { IntegratedApprovalV4Error } from '@workout/server-persistence/integrated-approval-v4';
import {
  IntegratedFixtureV4Error,
  type IntegratedFixtureV4Repository,
} from '@workout/server-persistence/integrated-fixture-v4';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { registerProductRoutes } from '../src/product-routes.js';

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const threadId = id('1');
const evidenceSnapshotId = id('2');
const trainingId = id('3');
const nutritionId = id('4');
const nutritionVersionId = id('5');
const blueprintId = id('6');
const blueprintVersionId = id('7');
const recoveryId = id('8');
const scheduleId = id('9');
const optionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scheduleVersionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const occurrenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const candidateId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const proposalId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const payload = {
  threadId,
  evidenceSnapshotId,
  expectedConversationRevision: 1,
  trainingPlanVersionId: trainingId,
  nutritionPlanId: nutritionId,
  nutritionPlanVersionId: nutritionVersionId,
  routineBlueprintId: blueprintId,
  routineBlueprintVersionId: blueprintVersionId,
  recoveryStrategyId: recoveryId,
  routineScheduleId: scheduleId,
  window: { from: '2026-09-19', toExclusive: '2026-09-20', timezone: 'UTC' },
};

const basis = {
  schemaVersion: 4 as const,
  planHeads: [
    {
      domain: 'training' as const,
      aggregateId: trainingId,
      head: { kind: 'exists' as const, versionId: trainingId },
    },
    {
      domain: 'nutrition' as const,
      aggregateId: nutritionId,
      head: { kind: 'exists' as const, versionId: nutritionVersionId },
    },
    { domain: 'recovery' as const, aggregateId: recoveryId, head: { kind: 'absent' as const } },
    {
      domain: 'routine_schedule' as const,
      aggregateId: scheduleId,
      head: { kind: 'absent' as const },
    },
  ],
  contextDependencies: [{ kind: 'activity-head', id: 'tenant', revision: '0' }],
  preferenceRevision: 0,
  constraintRevision: 0,
  conversationRevision: 1,
  policyVersion: 'policy-v4',
  evidenceSnapshotId,
};

const candidate: IntegratedCandidateV4 = integratedCandidateV4Schema.parse({
  schemaVersion: 4,
  id: candidateId,
  proposalId,
  digest: 'a'.repeat(64),
  basis,
  writes: [
    {
      domain: 'training',
      aggregateId: trainingId,
      proposed: {
        timezone: 'UTC',
        title: 'Fixture training',
        periods: [
          {
            id: 'season',
            parentId: null,
            level: 'season',
            title: 'Fixture season',
            startDate: '2026-09-19',
            endDateExclusive: '2026-09-20',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          },
        ],
        sessions: [],
      },
    },
    {
      domain: 'nutrition',
      aggregateId: nutritionId,
      proposed: {
        period: { from: '2026-09-19', toInclusive: '2026-09-19' },
        timezone: 'UTC',
        purpose: 'Fixture nutrition',
        linkedTrainingPlanVersionId: null,
        items: [],
      },
    },
    {
      domain: 'recovery',
      aggregateId: recoveryId,
      selectedOptionId: optionId,
      proposed: {
        title: 'Fixture recovery',
        goal: 'Fixture recovery goal',
        startDate: '2026-09-19',
        endDateExclusive: '2026-09-20',
        timezone: 'UTC',
        knownFacts: [],
        missingInformation: [],
        priority: 'normal',
        observations: [],
        planRefs: [],
        options: [
          {
            id: optionId,
            title: 'Rest',
            kind: 'full_rest',
            methodVersionId: null,
            explanation: 'Fixture',
          },
        ],
        reassessment: [
          {
            id: id('f'),
            trigger: 'plan_changed',
            plannedAt: null,
            description: 'Reassess',
            policyVersion: null,
          },
        ],
      },
    },
    {
      domain: 'routine_schedule',
      aggregateId: scheduleId,
      sourcePlanVersionId: trainingId,
      proposed: {
        schemaVersion: 4,
        id: scheduleId,
        versionId: scheduleVersionId,
        blueprint: { id: blueprintId, versionId: blueprintVersionId },
        window: {
          startDate: '2026-09-19',
          endDateExclusive: '2026-09-20',
          timezone: 'UTC',
          maxOccurrences: 1,
        },
        rule: { kind: 'dates', dates: ['2026-09-19'], localTime: null },
        state: 'active',
      },
      occurrences: [
        {
          id: occurrenceId,
          schedule: { id: scheduleId, versionId: scheduleVersionId },
          blueprint: { id: blueprintId, versionId: blueprintVersionId },
          anchorKey: 'date:2026-09-19',
          scheduledAt: null,
          timingStatus: 'unresolved',
          stepBindings: [],
          selectedChoices: {},
        },
      ],
    },
  ],
  summary: 'Fixture candidate',
  validation: { status: 'checked', errors: [], unknowns: [] },
  createdAt: '2026-09-19T00:00:00.000Z',
});

const apps: ReturnType<typeof Fastify>[] = [];
function setup(repository?: IntegratedFixtureV4Repository) {
  const app = Fastify();
  registerProductRoutes(app, repository ? { integratedFixtureV4: repository } : {}, () => ({
    athleteId: 'authenticated-owner',
    sessionId: 'session',
    method: 'bearer',
  }));
  apps.push(app);
  return app;
}
function request(
  app: ReturnType<typeof Fastify>,
  body: unknown = payload,
  key = 'fixture-key-123',
) {
  return app.inject({
    method: 'POST',
    url: '/integrated-fixture-v4-candidates',
    headers: { 'idempotency-key': key },
    payload: body,
  });
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('integrated v4 fixture route', () => {
  it('is absent unless a nonproduction fixture repository is supplied', async () => {
    expect((await request(setup())).statusCode).toBe(404);
  });

  it('accepts identifiers only, derives tenant ownership, and replays with the same key', async () => {
    const results = new Map<string, IntegratedCandidateV4>();
    const create = vi.fn<IntegratedFixtureV4Repository['create']>(async (_owner, command) => {
      const prior = results.get(command.idempotencyKey);
      if (prior) return prior;
      results.set(command.idempotencyKey, candidate);
      return candidate;
    });
    const app = setup({ create });

    for (const invalid of [
      { ...payload, athleteId: 'foreign-owner' },
      { ...payload, writes: candidate.writes },
      { ...payload, proposed: { title: 'client proposal' } },
    ]) {
      expect((await request(app, invalid)).statusCode).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();

    const first = await request(app);
    const replay = await request(app);
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, 'authenticated-owner', {
      ...payload,
      idempotencyKey: 'fixture-key-123',
    });
    expect(create).toHaveBeenNthCalledWith(2, 'authenticated-owner', {
      ...payload,
      idempotencyKey: 'fixture-key-123',
    });
  });

  it('enforces the 4 KiB request limit before accepting extra client content', async () => {
    const create = vi.fn<IntegratedFixtureV4Repository['create']>();
    const response = await request(setup({ create }), { ...payload, proposed: 'x'.repeat(5000) });
    expect(response.statusCode).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [
      new IntegratedFixtureV4Error('INTEGRATED_FIXTURE_DISABLED'),
      404,
      'INTEGRATED_FIXTURE_DISABLED',
    ],
    [
      new IntegratedFixtureV4Error('INTEGRATED_FIXTURE_REFERENCE_INVALID'),
      422,
      'INTEGRATED_FIXTURE_REFERENCE_INVALID',
    ],
    [new IntegratedApprovalV4Error('AI_CONSENT_REQUIRED'), 403, 'AI_CONSENT_REQUIRED'],
    [new IntegratedApprovalV4Error('STALE_BASIS'), 409, 'STALE_BASIS'],
    [new PersistenceConflict('IDEMPOTENCY_CONFLICT'), 409, 'IDEMPOTENCY_CONFLICT'],
  ])('maps expected fixture failure %# to a stable response', async (error, status, code) => {
    const repository = { create: vi.fn().mockRejectedValue(error) };
    const response = await request(setup(repository));
    expect(response.statusCode).toBe(status);
    expect(response.json().message).toBe(code);
  });
});
