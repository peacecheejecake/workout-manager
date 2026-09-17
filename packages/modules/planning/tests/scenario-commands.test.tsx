import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type { PlanScenario } from '@workout/contracts/plan-scenarios';
import type { PlanSnapshot } from '@workout/contracts/planning';
import { transportReplySchema } from '@workout/contracts/core';
import {
  prepareScenarioApply,
  runScenarioCommand,
  type ScenarioCommand,
} from '../src/scenario-commands';

type TransportReply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const version = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const draft = {
  title: 'Current',
  timezone: 'UTC',
  periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
    id: level,
    parentId: index === 0 ? null : (levels[index - 1] ?? null),
    level,
    title: level,
    startDate: '2026-09-01',
    endDateExclusive: '2026-10-01',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  })),
  sessions: [
    {
      id: 'session',
      blockId: 'block',
      date: '2026-09-20',
      localStartTime: null,
      title: 'Run',
      sport: 'running' as const,
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal' as const,
      locks: { date: false, time: false, intensity: false },
      steps: [],
    },
  ],
};
const head: PlanSnapshot = { id: version, version: 1, createdAt: '2026-09-01T00:00:00Z', draft };
const scenario: PlanScenario = {
  id,
  basePlanVersionId: version,
  label: 'A',
  revision: 2,
  createdAt: head.createdAt,
  updatedAt: head.createdAt,
  draft: { ...draft, title: 'Alternative' },
};
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200) =>
  transportReplySchema.parse({ status, body, traceId: null });
function setup(
  options: {
    head?: PlanSnapshot;
    scenario?: PlanScenario;
    completionHead?: string;
    completed?: boolean;
  } = {},
) {
  const current = options.head ?? head,
    selected = options.scenario ?? scenario;
  const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (request) => {
    if (request.path === '/bff/v1/plans/current')
      return response({
        head: current,
        history: [
          {
            id: current.id,
            version: current.version,
            createdAt: current.createdAt,
            title: current.draft.title,
          },
        ],
      });
    if (request.path.endsWith('/session-completions'))
      return response({
        currentPlanVersionId: options.completionHead ?? current.id,
        collectionRevision: options.completed ? 1 : 0,
        items: options.completed
          ? [
              {
                sessionId: 'session',
                revision: 1,
                planVersionId: version,
                schedule: {
                  blockId: 'block',
                  date: '2026-09-20',
                  localStartTime: null,
                  timezone: 'UTC',
                },
                status: 'completed',
                reportedAt: head.createdAt,
                reason: null,
                source: 'user',
                method: 'self_report',
                definitionVersion: 'session-completion-v1',
              },
            ]
          : [],
      });
    return response(selected);
  });
  return { request };
}
describe('scenario command boundaries', () => {
  it('starts all three independent reads before resolving any and prepares complete current revision dependencies', async () => {
    const resolvers: ((reply: TransportReply) => void)[] = [];
    const transport = {
      request: vi
        .fn<AuthenticatedTransport['request']>()
        .mockImplementation(() => new Promise((resolve) => resolvers.push(resolve))),
    };
    const key = vi.fn(() => 'scenario-apply-key');
    const pending = prepareScenarioApply(transport, scenario, signal(), key);
    expect(transport.request).toHaveBeenCalledTimes(3);
    expect(key).not.toHaveBeenCalled();
    const normal = setup();
    for (const [index, call] of transport.request.mock.calls.entries()) {
      const resolve = resolvers[index];
      if (!resolve) throw new Error('Missing pending read');
      resolve(await normal.request(call[0]));
    }
    const prepared = await pending;
    expect(prepared.command).toEqual({
      confirmed: true,
      idempotencyKey: 'scenario-apply-key',
      expectedScenarioRevision: 2,
      expectedPlanVersionId: version,
      expectedCompletionRevision: 0,
    });
    expect(prepared.before).toEqual(head);
    expect(prepared.scenario).toEqual(scenario);
    expect(key).toHaveBeenCalledTimes(1);
  });
  it.each(['head', 'scenario'] as const)(
    'rejects stale %s evidence before generating a write key',
    async (kind) => {
      const transport = setup(
        kind === 'head' ? { completionHead: id } : { scenario: { ...scenario, revision: 3 } },
      );
      const key = vi.fn(() => 'unused-key');
      await expect(prepareScenarioApply(transport, scenario, signal(), key)).rejects.toMatchObject({
        status: 409,
        code: 'SCENARIO_STALE',
      });
      expect(key).not.toHaveBeenCalled();
    },
  );
  it('rejects a saved date lock and completed schedule movement independently', async () => {
    const moved = {
      ...scenario,
      draft: {
        ...draft,
        sessions: draft.sessions.map((session) => ({ ...session, date: '2026-09-21' })),
      },
    };
    const locked = {
      ...head,
      draft: {
        ...draft,
        sessions: draft.sessions.map((session) => ({
          ...session,
          locks: { ...session.locks, date: true },
        })),
      },
    };
    await expect(
      prepareScenarioApply(
        setup({ head: locked, scenario: moved }),
        moved,
        signal(),
        () => 'unused-key',
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_LOCKED' });
    await expect(
      prepareScenarioApply(
        setup({ scenario: moved, completed: true }),
        moved,
        signal(),
        () => 'unused-key',
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_COMPLETED' });
  });
  it('cancellation after read delivery never creates a prepared approval', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareScenarioApply(setup(), scenario, controller.signal, () => 'unused-key'),
    ).rejects.toThrow('CANCELLED');
  });
  it('retries exactly the frozen apply key and payload after an unknown transport outcome', async () => {
    const frozen = await prepareScenarioApply(setup(), scenario, signal(), () => 'same-apply-key');
    const receipt = {
      plan: { ...head, version: 2, draft: scenario.draft },
      scenarioId: id,
      scenarioRevision: 2,
    };
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(response(receipt));
    const abort = signal();
    await expect(runScenarioCommand({ request }, frozen, abort)).rejects.toThrow('response lost');
    await expect(runScenarioCommand({ request }, frozen, abort)).resolves.toEqual({
      kind: 'applied',
      result: receipt,
    });
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: `/bff/v1/plan-scenarios/${id}/apply`,
      idempotencyKey: 'same-apply-key',
      body: {
        confirmed: true,
        expectedScenarioRevision: 2,
        expectedPlanVersionId: version,
        expectedCompletionRevision: 0,
      },
    });
    expect(request.mock.calls[0]?.[0].body).not.toHaveProperty('idempotencyKey');
  });
  it.each(['create', 'save', 'apply'] as const)(
    'rejects mismatching %s receipts instead of claiming success',
    async (kind) => {
      let frozen: ScenarioCommand;
      let receipt: unknown;
      if (kind === 'create') {
        frozen = {
          kind,
          base: head,
          command: {
            confirmed: true,
            idempotencyKey: 'create-key',
            basePlanVersionId: version,
            label: 'A',
          },
        };
        receipt = { ...scenario, revision: 1, label: 'B' };
      } else if (kind === 'save') {
        frozen = {
          kind,
          scenario,
          command: {
            confirmed: true,
            idempotencyKey: 'save-key-1',
            expectedRevision: 2,
            draft: scenario.draft,
          },
        };
        receipt = { ...scenario, revision: 2 };
      } else {
        frozen = await prepareScenarioApply(setup(), scenario, signal(), () => 'apply-key-1');
        receipt = { plan: head, scenarioId: version, scenarioRevision: 2 };
      }
      const request = vi
        .fn<AuthenticatedTransport['request']>()
        .mockResolvedValue(response(receipt));
      await expect(runScenarioCommand({ request }, frozen, signal())).rejects.toThrow(
        'RECEIPT_MISMATCH',
      );
    },
  );
  it('propagates explicit conflict without converting it to a receipt', async () => {
    const frozen = await prepareScenarioApply(setup(), scenario, signal(), () => 'apply-key-1');
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValue(response({ error: { code: 'SCENARIO_REVISION_CONFLICT' } }, 409));
    await expect(runScenarioCommand({ request }, frozen, signal())).rejects.toMatchObject({
      status: 409,
    });
  });
});
