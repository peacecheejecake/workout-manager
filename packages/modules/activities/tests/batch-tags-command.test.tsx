import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  prepareActivityBatchTags,
  runActivityBatchTags,
  type PreparedTags,
} from '../src/batch-tags-command';
import { toBatchTarget } from '../src/batch-selection';
import { tagActivity, tagResponse } from './tag-fixtures';
const signal = () => new AbortController().signal;
function prepared(tags = ['새 태그']): PreparedTags {
  return {
    target: toBatchTarget(tagActivity()),
    previousTags: undefined,
    command: { expectedRevision: 2, idempotencyKey: 'stable-tag-key', reason: '합성 분류', tags },
  };
}
describe('batch local tag commands', () => {
  it('normalizes one literal tag and prepares only tags without report or measurements', async () => {
    const original = tagActivity(['Run']);
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValue(tagResponse(original));
    const createId = vi.fn(() => 'stable-tag-key');
    const result = await prepareActivityBatchTags({
      targets: [toBatchTarget(original)],
      tag: ' e\u0301_% ',
      operation: 'add',
      reason: '합성 분류',
      transport: { request },
      signal: signal(),
      createId,
    });
    expect(result[0]?.status).toBe('ready');
    if (result[0]?.status !== 'ready') throw new Error('Expected ready');
    expect(result[0].prepared.command).toEqual({
      expectedRevision: 2,
      idempotencyKey: 'stable-tag-key',
      reason: '합성 분류',
      tags: ['Run', 'é_%'],
    });
    expect(original.overlay.tags).toEqual(['Run']);
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    expect(createId).toHaveBeenCalledOnce();
  });
  it('skips no-op removal from legacy and duplicate addition while allowing case-sensitive different tags', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>();
    const createId = vi.fn(() => 'stable-tag-key');
    const args = {
      targets: [toBatchTarget(tagActivity())],
      reason: '합성 분류',
      transport: { request },
      signal: signal(),
      createId,
    };
    request.mockResolvedValue(tagResponse(tagActivity()));
    expect(
      (await prepareActivityBatchTags({ ...args, tag: 'Run', operation: 'remove' }))[0]?.status,
    ).toBe('unchanged');
    request.mockResolvedValue(tagResponse(tagActivity(['Run'])));
    expect(
      (await prepareActivityBatchTags({ ...args, tag: 'Run', operation: 'add' }))[0]?.status,
    ).toBe('unchanged');
    expect(createId).not.toHaveBeenCalled();
    const changed = await prepareActivityBatchTags({ ...args, tag: 'run', operation: 'add' });
    expect(changed[0]?.status).toBe('ready');
    const removed = await prepareActivityBatchTags({ ...args, tag: 'Run', operation: 'remove' });
    expect(removed[0]?.status === 'ready' && removed[0].prepared.command.tags).toEqual([]);
  });
  it('shows item capacity and stale revisions without allocating write keys', async () => {
    const source = tagActivity(Array.from({ length: 20 }, (_, i) => `tag${i}`));
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValueOnce(tagResponse(source))
      .mockResolvedValueOnce(tagResponse({ ...source, revision: 3 }));
    const createId = vi.fn(() => 'unused');
    const args = {
      targets: [toBatchTarget(source)],
      tag: 'new',
      operation: 'add' as const,
      reason: '합성 분류',
      transport: { request },
      signal: signal(),
      createId,
    };
    expect((await prepareActivityBatchTags(args))[0]?.status).toBe('limit_exceeded');
    expect((await prepareActivityBatchTags(args))[0]?.status).toBe('conflict');
    expect(createId).not.toHaveBeenCalled();
  });
  it('retries an unknown response with frozen identical PATCH and acknowledges only matching receipts', async () => {
    const item = prepared();
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(tagResponse({ ...tagActivity(['새 태그']), revision: 3 }));
    const onResult = vi.fn();
    const args = { prepared: [item], transport: { request }, signal: signal(), onResult };
    expect((await runActivityBatchTags(args))[0]?.status).toBe('uncertain');
    expect((await runActivityBatchTags(args))[0]?.status).toBe('applied');
    expect(request.mock.calls[0]?.[0]).toEqual(request.mock.calls[1]?.[0]);
    expect(request.mock.calls[0]?.[0].body).toEqual({
      expectedRevision: 2,
      reason: '합성 분류',
      tags: ['새 태그'],
    });
    expect(item.command).not.toHaveProperty('report');
    request.mockResolvedValue(tagResponse({ ...tagActivity(['wrong']), revision: 3 }));
    expect((await runActivityBatchTags(args))[0]?.status).toBe('uncertain');
  });
  it('stops the remaining writes on authentication loss, distinguishes conflict and deleted records, and ignores aborted callbacks', async () => {
    const item = prepared(),
      other = {
        ...prepared(),
        target: { ...item.target, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      };
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValue(tagResponse(null, 401));
    const onResult = vi.fn();
    const result = await runActivityBatchTags({
      prepared: [item, other],
      transport: { request },
      signal: signal(),
      onResult,
    });
    expect(result.map((value) => value.status)).toEqual(['reauth_required', 'not_attempted']);
    expect(request).toHaveBeenCalledOnce();
    request
      .mockResolvedValueOnce(tagResponse(null, 409))
      .mockResolvedValueOnce(tagResponse(null, 404));
    expect(
      (
        await runActivityBatchTags({
          prepared: [item, other],
          transport: { request },
          signal: signal(),
          onResult,
        })
      ).map((value) => value.status),
    ).toEqual(['conflict', 'unavailable']);
    const controller = new AbortController();
    controller.abort();
    onResult.mockClear();
    expect(
      (
        await runActivityBatchTags({
          prepared: [item],
          transport: { request },
          signal: controller.signal,
          onResult,
        })
      )[0]?.status,
    ).toBe('not_attempted');
    expect(onResult).not.toHaveBeenCalled();
  });
  it('matches canonical UUID identity and rejects empty, duplicate-case and invalid targets before reading', async () => {
    const item = prepared();
    const upper = { ...item.target, id: item.target.id.toUpperCase() };
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValue(tagResponse(tagActivity()));
    const args = {
      targets: [upper],
      tag: '새 태그',
      operation: 'add' as const,
      reason: '분류',
      transport: { request },
      signal: signal(),
      createId: () => 'stable-tag-key',
    };
    const preview = await prepareActivityBatchTags(args);
    expect(preview[0]?.status).toBe('ready');
    if (preview[0]?.status !== 'ready') throw new Error('Expected ready');
    request.mockResolvedValue(tagResponse({ ...tagActivity(['새 태그']), revision: 3 }));
    expect(
      (
        await runActivityBatchTags({
          prepared: [preview[0].prepared],
          transport: { request },
          signal: signal(),
          onResult: () => {},
        })
      )[0]?.status,
    ).toBe('applied');
    request.mockClear();
    for (const targets of [
      [],
      [upper, item.target],
      [{ ...upper, id: 'not-uuid' }],
      [{ ...upper, revision: 0 }],
    ])
      await expect(prepareActivityBatchTags({ ...args, targets })).rejects.toThrow(
        'INVALID_BATCH_TARGETS',
      );
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects injected non-tag writes and invalid input before any requests', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>();
    const item = prepared();
    await expect(
      runActivityBatchTags({
        prepared: [{ ...item, command: { ...item.command, title: 'unrelated' } }],
        transport: { request },
        signal: signal(),
        onResult: () => {},
      }),
    ).rejects.toThrow('INVALID_BATCH_PREVIEW');
    await expect(
      prepareActivityBatchTags({
        targets: [item.target],
        tag: '\u0000',
        operation: 'add',
        reason: '분류',
        transport: { request },
        signal: signal(),
        createId: () => 'stable-tag-key',
      }),
    ).rejects.toThrow();
    await expect(
      prepareActivityBatchTags({
        targets: [item.target, item.target],
        tag: 'valid',
        operation: 'add',
        reason: '분류',
        transport: { request },
        signal: signal(),
        createId: () => 'stable-tag-key',
      }),
    ).rejects.toThrow('INVALID_BATCH_TARGETS');
    expect(request).not.toHaveBeenCalled();
  });
});
