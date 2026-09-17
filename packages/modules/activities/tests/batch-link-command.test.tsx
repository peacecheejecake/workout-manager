import { z } from 'zod';
import { describe, it, expect, vi } from 'vitest';
import { createSessionTransport } from '@workout/platform/authenticated-workspace';
import type { Activity, ActivityReportValues } from '@workout/contracts/activity';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  prepareActivityBatchLink,
  runActivityBatchLink,
  type PreparedLink,
} from '../src/batch-link-command';
import { toBatchTarget } from '../src/batch-selection';
const id = '12345678-1234-4234-8234-123456789012';
const link = { planVersionId: 'abcdefab-1234-4234-8234-123456789012', sessionId: 'session' };
function activity(): Activity {
  const values = {
    title: 'Run',
    kind: 'running' as const,
    startedAt: null,
    durationSeconds: 0,
    durationKind: 'timer' as const,
    timezone: null,
    distanceMeters: null,
  };
  return {
    id,
    revision: 1,
    source: { kind: 'fixture', sourceId: 'source', revision: 1, contentHash: 'a'.repeat(64) },
    original: values,
    effective: values,
    overlay: {},
    userReport: {
      sessionRpe: 0,
      note: 'Keep note',
      planLink: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'activity-report-v1',
      rpeReportedAt: '2026-01-01T00:00:00Z',
    },
  };
}
function prepared(): PreparedLink {
  return {
    target: toBatchTarget(activity()),
    previousLink: null,
    command: {
      expectedRevision: 1,
      idempotencyKey: 'stable-command-key',
      reason: 'Link selected plan',
      report: { sessionRpe: 0, note: 'Keep note', planLink: link },
    },
  };
}
function receipt(report: ActivityReportValues): Activity {
  const original = activity();
  return {
    ...original,
    revision: 2,
    userReport: {
      ...original.userReport,
      ...report,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'activity-report-v1',
      rpeReportedAt: report.sessionRpe === null ? null : '2026-01-01T00:00:00Z',
    },
  };
}
function setup() {
  const request = vi.fn<AuthenticatedTransport['request']>();
  return {
    transport: { request },
    request,
    signal: new AbortController().signal,
    onResult: vi.fn(),
  };
}
// Fixtures deliberately enter the same runtime reply boundary as browser transports.
const response = (status: number, body: Activity | null = null) => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
describe('batch plan link preparation and commands', () => {
  it('reads a fixed revision and preserves zero RPE/note with one key per ready item', async () => {
    const f = setup();
    f.request.mockResolvedValue(response(200, activity()));
    const createId = vi.fn(() => 'one-stable-key');
    const results = await prepareActivityBatchLink({
      ...f,
      targets: [toBatchTarget(activity())],
      link,
      reason: 'Chosen session',
      createId,
    });
    expect(results[0]).toMatchObject({
      status: 'ready',
      prepared: {
        previousLink: null,
        command: {
          expectedRevision: 1,
          idempotencyKey: 'one-stable-key',
          report: { sessionRpe: 0, note: 'Keep note', planLink: link },
        },
      },
    });
    expect(createId).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[0].method).toBe('GET');
  });
  it('does not prepare unchanged links or stale revisions', async () => {
    const f = setup();
    const value = receipt({
      sessionRpe: null,
      note: null,
      planLink: { ...link, planVersionId: link.planVersionId.toUpperCase() },
    });
    value.revision = 1;
    f.request
      .mockResolvedValueOnce(response(200, value))
      .mockResolvedValueOnce(response(200, { ...value, revision: 3 }));
    const createId = vi.fn();
    expect(
      (
        await prepareActivityBatchLink({
          ...f,
          targets: [toBatchTarget(activity())],
          link,
          reason: 'same',
          createId,
        })
      )[0]?.status,
    ).toBe('unchanged');
    expect(
      (
        await prepareActivityBatchLink({
          ...f,
          targets: [toBatchTarget(activity())],
          link: null,
          reason: 'unlink',
          createId,
        })
      )[0]?.status,
    ).toBe('conflict');
    expect(createId).not.toHaveBeenCalled();
  });
  it('preserves null reports for linking and clears only the link when unlinking', async () => {
    const f = setup();
    f.request
      .mockResolvedValueOnce(response(200, { ...activity(), userReport: null }))
      .mockResolvedValueOnce(
        response(200, {
          ...receipt({ sessionRpe: 0, note: 'Keep note', planLink: link }),
          revision: 1,
        }),
      );
    const first = await prepareActivityBatchLink({
      ...f,
      targets: [toBatchTarget(activity())],
      link,
      reason: 'link',
      createId: () => 'first-stable-key',
    });
    expect(first[0]).toMatchObject({
      status: 'ready',
      prepared: { command: { report: { sessionRpe: null, note: null, planLink: link } } },
    });
    expect(
      (
        await prepareActivityBatchLink({
          ...f,
          targets: [toBatchTarget(activity())],
          link: null,
          reason: 'unlink',
          createId: () => 'second-stable-key',
        })
      )[0],
    ).toMatchObject({
      status: 'ready',
      prepared: { command: { report: { sessionRpe: 0, note: 'Keep note', planLink: null } } },
    });
  });
  it('retries the identical frozen body/key and validates historical receipt without treating it as current', async () => {
    const f = setup();
    const command = prepared();
    f.request
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(
        response(200, receipt({ sessionRpe: 0, note: 'Keep note', planLink: link })),
      );
    const first = await runActivityBatchLink({ ...f, prepared: [command] });
    expect(first[0]?.status).toBe('uncertain');
    const result = await runActivityBatchLink({
      ...f,
      prepared: first.map((item) => item.prepared),
    });
    expect(result[0]?.status).toBe('applied');
    expect(f.request.mock.calls[0]?.[0]).toEqual(f.request.mock.calls[1]?.[0]);
    expect(f.request.mock.calls[1]?.[0].body).not.toHaveProperty('idempotencyKey');
  });
  it.each([409, 404, 500])('classifies PATCH %s', async (status) => {
    const f = setup();
    f.request.mockResolvedValue(response(status));
    expect((await runActivityBatchLink({ ...f, prepared: [prepared()] }))[0]?.status).toBe(
      status === 409 ? 'conflict' : status === 404 ? 'unavailable' : 'uncertain',
    );
  });
  it('rejects mismatched success receipt report and distinguishes invalid plan link', async () => {
    const f = setup();
    f.request
      .mockResolvedValueOnce(
        response(200, receipt({ sessionRpe: 0, note: 'changed', planLink: link })),
      )
      .mockResolvedValueOnce({
        status: 400,
        traceId: null,
        body: { error: { code: 'PLAN_LINK_INVALID' } },
      });
    expect((await runActivityBatchLink({ ...f, prepared: [prepared()] }))[0]?.status).toBe(
      'uncertain',
    );
    expect((await runActivityBatchLink({ ...f, prepared: [prepared()] }))[0]?.status).toBe(
      'invalid_link',
    );
  });
  it.each([401, 409])(
    'halts actual session transport failures %s in prepare and execute',
    async (status) => {
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          async () =>
            new Response(JSON.stringify({ error: { code: 'SESSION_CHANGED' } }), { status }),
        );
      try {
        const transport = createSessionTransport(
          {
            athleteId: 'athlete',
            sessionId: 'session',
            csrfToken: 'csrf',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
          vi.fn(),
        );
        const first = prepared(),
          second = prepared();
        second.target.id = '22345678-1234-4234-8234-123456789012';
        const options = { transport, signal: new AbortController().signal };
        const preview = await prepareActivityBatchLink({
          ...options,
          targets: [first.target, second.target],
          link,
          reason: 'link',
          createId: () => 'stable-key',
        });
        expect(preview.map((item) => item.status)).toEqual(['reauth_required', 'not_attempted']);
        const result = await runActivityBatchLink({
          ...options,
          prepared: [first, second],
          onResult: vi.fn(),
        });
        expect(result.map((item) => item.status)).toEqual(['reauth_required', 'not_attempted']);
        expect(fetcher).toHaveBeenCalledTimes(2);
      } finally {
        fetcher.mockRestore();
      }
    },
  );
  it('rejects duplicate and over-limit batches before reads or writes', async () => {
    const f = setup();
    const item = prepared();
    await expect(runActivityBatchLink({ ...f, prepared: [item, item] })).rejects.toThrow(
      'INVALID_BATCH_TARGETS',
    );
    await expect(
      prepareActivityBatchLink({
        ...f,
        targets: Array.from({ length: 101 }, (_, i) => ({ ...item.target, id: String(i) })),
        link,
        reason: 'link',
        createId: () => 'stable-key',
      }),
    ).rejects.toThrow('INVALID_BATCH_TARGETS');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('does not send commands or publish results after pre-abort', async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort();
    expect(
      (await runActivityBatchLink({ ...f, signal: controller.signal, prepared: [prepared()] }))[0]
        ?.status,
    ).toBe('not_attempted');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.onResult).not.toHaveBeenCalled();
  });
});

it('freezes requests and stops callbacks and later writes after an in-flight abort', async () => {
  const f = setup();
  const controller = new AbortController();
  let finish: ((value: ReturnType<typeof response>) => void) | undefined;
  f.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const one = prepared(),
    two = prepared();
  two.target.id = '22345678-1234-4234-8234-123456789012';
  const promise = runActivityBatchLink({ ...f, signal: controller.signal, prepared: [one, two] });
  two.command.reason = 'Changed after confirmation';
  controller.abort();
  if (!finish) throw new Error('Expected request');
  finish(response(200, receipt({ sessionRpe: 0, note: 'Keep note', planLink: link })));
  const result = await promise;
  expect(result.map((item) => item.status)).toEqual(['uncertain', 'not_attempted']);
  expect(result[1]?.prepared.command.reason).toBe('Link selected plan');
  expect(f.onResult).not.toHaveBeenCalled();
  expect(f.request).toHaveBeenCalledTimes(1);
});
it('halts unavailable session scopes without classifying a read failure as write uncertainty', async () => {
  const transport = createSessionTransport(
    {
      athleteId: 'athlete',
      sessionId: 'session',
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    vi.fn(),
    () => false,
  );
  const one = prepared(),
    two = prepared();
  two.target.id = '22345678-1234-4234-8234-123456789012';
  const options = { transport, signal: new AbortController().signal };
  expect(
    (
      await prepareActivityBatchLink({
        ...options,
        targets: [one.target, two.target],
        link,
        reason: 'link',
        createId: () => 'stable-key',
      })
    ).map((item) => item.status),
  ).toEqual(['read_error', 'not_attempted']);
  expect(
    (await runActivityBatchLink({ ...options, prepared: [one, two], onResult: vi.fn() })).map(
      (item) => item.status,
    ),
  ).toEqual(['uncertain', 'not_attempted']);
});
