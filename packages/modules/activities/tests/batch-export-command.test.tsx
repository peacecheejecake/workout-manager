import { z } from 'zod';
import { selectedActivityExportSchema } from '@workout/contracts/activity-export';
import { describe, it, expect, vi } from 'vitest';
import type { Activity } from '@workout/contracts/activity';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { createSessionTransport } from '@workout/platform/authenticated-workspace';
import {
  prepareActivityBatchExport,
  serializeActivityBatchExport,
  type ExportReadResult,
} from '../src/batch-export-command';
import { toBatchTarget } from '../src/batch-selection';
const generatedAt = '2026-01-01T00:00:00Z';
function activity(n = 0): Activity {
  const values = {
    title: 'Original',
    kind: 'running' as const,
    startedAt: '2026-01-01T09:00:00+09:00',
    durationSeconds: 0,
    durationKind: 'timer' as const,
    timezone: 'Asia/Seoul',
    distanceMeters: null,
  };
  return {
    id: `12345678-1234-4234-8234-${String(n).padStart(12, '0')}`,
    revision: 2,
    source: { kind: 'fit', sourceId: 'source', revision: 1, contentHash: 'a'.repeat(64) },
    original: values,
    overlay: { title: 'Corrected', reason: 'Correction' },
    effective: { ...values, title: 'Corrected' },
    userReport: null,
  };
}
function ready(value = activity()): ExportReadResult {
  return { target: toBatchTarget(value), status: 'ready', activity: value };
}
function setup() {
  const request = vi.fn<AuthenticatedTransport['request']>();
  return { request, transport: { request }, signal: new AbortController().signal };
}
const response = (status: number, body: unknown = null) => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
describe('selected activity summary export', () => {
  it('preserves source,original,overlay,effective,null,zero and detaches output', async () => {
    const f = setup(),
      value = activity(),
      target = toBatchTarget(value);
    f.request.mockResolvedValue(response(200, value));
    const results = await prepareActivityBatchExport({ ...f, targets: [target] });
    target.revision = 99;
    const exported = serializeActivityBatchExport({ results, generatedAt });
    expect(exported.data.schemaVersion).toBe(2);
    expect(exported.data.activities).toEqual([value]);
    expect(JSON.parse(exported.json)).toEqual(exported.data);
    value.effective.title = 'Later';
    expect(exported.data.activities[0]?.effective.title).toBe('Corrected');
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', body: null, idempotencyKey: null }),
    );
    expect(exported.data).not.toHaveProperty('details');
  });
  it('refuses partial exports and preserves each read failure classification', async () => {
    const f = setup();
    f.request
      .mockResolvedValueOnce(response(200, activity()))
      .mockResolvedValueOnce(response(404))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(response(200, { ...activity(3), revision: 99 }));
    const results = await prepareActivityBatchExport({
      ...f,
      targets: [0, 1, 2, 3].map((n) => toBatchTarget(activity(n))),
    });
    expect(results.map((result) => result.status)).toEqual([
      'ready',
      'unavailable',
      'read_error',
      'conflict',
    ]);
    expect(() => serializeActivityBatchExport({ results, generatedAt })).toThrow(
      'EXPORT_NOT_READY',
    );
  });
  it('rejects mismatch, malformed success and invalid artifact date', async () => {
    const f = setup();
    f.request
      .mockResolvedValueOnce(response(200, activity(1)))
      .mockResolvedValueOnce(response(200, {}));
    for (let i = 0; i < 2; i++)
      expect(
        (await prepareActivityBatchExport({ ...f, targets: [toBatchTarget(activity())] }))[0]
          ?.status,
      ).toBe('read_error');
    expect(() =>
      serializeActivityBatchExport({
        results: [{ ...ready(), status: 'ready', activity: activity(1) }],
        generatedAt,
      }),
    ).toThrow('EXPORT_REVISION_MISMATCH');
    expect(() =>
      serializeActivityBatchExport({ results: [ready()], generatedAt: 'invalid' }),
    ).toThrow();
  });
  it('enforces nonempty exact unique bounded targets before reading or serializing', async () => {
    const f = setup();
    for (const targets of [
      [],
      [toBatchTarget(activity()), toBatchTarget(activity())],
      Array.from({ length: 101 }, (_, n) => toBatchTarget(activity(n))),
    ])
      await expect(prepareActivityBatchExport({ ...f, targets })).rejects.toThrow(
        'INVALID_EXPORT_TARGETS',
      );
    expect(f.request).not.toHaveBeenCalled();
    expect(() => serializeActivityBatchExport({ results: [], generatedAt })).toThrow(
      'INVALID_EXPORT_TARGETS',
    );
  });
  it.each([401, 409])('stops on real transport session failure %s', async (status) => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { code: 'SESSION_CHANGED' } }), { status }),
      );
    try {
      const transport = createSessionTransport(
        {
          athleteId: 'a',
          sessionId: 's',
          csrfToken: 'csrf',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        vi.fn(),
      );
      const results = await prepareActivityBatchExport({
        transport,
        signal: new AbortController().signal,
        targets: [toBatchTarget(activity()), toBatchTarget(activity(1))],
      });
      expect(results.map((result) => result.status)).toEqual(['reauth_required', 'not_attempted']);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
    }
  });
  it('stops unavailable session scope and pre-aborted reads', async () => {
    const transport = createSessionTransport(
      {
        athleteId: 'a',
        sessionId: 's',
        csrfToken: 'csrf',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      vi.fn(),
      () => false,
    );
    const targets = [toBatchTarget(activity()), toBatchTarget(activity(1))];
    expect(
      (
        await prepareActivityBatchExport({
          transport,
          targets,
          signal: new AbortController().signal,
        })
      ).map((result) => result.status),
    ).toEqual(['read_error', 'not_attempted']);
    const f = setup(),
      controller = new AbortController();
    controller.abort();
    expect(
      (await prepareActivityBatchExport({ ...f, targets, signal: controller.signal })).map(
        (result) => result.status,
      ),
    ).toEqual(['not_attempted', 'not_attempted']);
    expect(f.request).not.toHaveBeenCalled();
  });
  it('discards a late read after abort and retains copied selection revisions', async () => {
    const f = setup(),
      controller = new AbortController();
    let finish: ((value: ReturnType<typeof response>) => void) | undefined;
    f.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const targets = [toBatchTarget(activity()), toBatchTarget(activity(1))];
    const pending = prepareActivityBatchExport({ ...f, targets, signal: controller.signal });
    targets[1] = toBatchTarget({ ...activity(1), revision: 99 });
    controller.abort();
    if (!finish) throw new Error('Expected read');
    finish(response(200, activity()));
    const results = await pending;
    expect(results.map((result) => result.status)).toEqual(['not_attempted', 'not_attempted']);
    expect(results[1]?.target.revision).toBe(2);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

it('exports local tags losslessly in v2 and accepts only tag-free legacy v1 artifacts', () => {
  const original = activity();
  const tagged = {
    ...original,
    overlay: { ...original.overlay, tags: ['é', 'Easy', 'easy', '산 / 길'] },
  };
  const exported = serializeActivityBatchExport({ results: [ready(tagged)], generatedAt });
  expect(exported.data.schemaVersion).toBe(2);
  expect(exported.data.activities[0]?.overlay).toEqual(tagged.overlay);
  expect(exported.data.activities[0]?.original).toEqual(original.original);
  expect(
    selectedActivityExportSchema.safeParse({ ...exported.data, schemaVersion: 1 }).success,
  ).toBe(false);
  const legacy = { ...exported.data, schemaVersion: 1, activities: [original] };
  expect(selectedActivityExportSchema.parse(legacy)).toEqual(legacy);
  const cleared = { ...tagged, overlay: { ...tagged.overlay, tags: [] } };
  expect(
    serializeActivityBatchExport({ results: [ready(cleared)], generatedAt }).data.activities[0]
      ?.overlay.tags,
  ).toEqual([]);
});
