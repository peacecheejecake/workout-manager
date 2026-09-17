import { describe, it, expect, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { createConstraintsApi, ConstraintsRequestError } from '../src/constraints-api';
import { createConstraintsDraftStore } from '../src/constraints-store';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const command = {
  expectedHeadRevision: null,
  confirmed: true as const,
  text: 'text',
  idempotencyKey: 'stable',
};
describe('constraints command foundation', () => {
  it('isolates drafts and freezes unknown command across retries', () => {
    const a = createConstraintsDraftStore(),
      b = createConstraintsDraftStore();
    a.getState().actions.edit('draft');
    const pending = { kind: 'create' as const, command: { ...command } };
    a.getState().actions.begin(pending);
    pending.command.text = 'changed';
    a.getState().actions.edit('blocked');
    expect(a.getState().text).toBe('draft');
    a.getState().actions.uncertain();
    expect(a.getState().actions.retry()?.command).toEqual(command);
    expect(b.getState().text).toBe('');
    a.getState().actions.reject('conflict', true);
    expect(a.getState().text).toBe('draft');
    expect(a.getState().actions.begin(pending)).toBe(false);
    a.getState().actions.reviewed();
    expect(a.getState().actions.begin(pending)).toBe(true);
    a.getState().actions.reset();
    expect(a.getState().pending).toBeNull();
  });
  it('separates header key and rejects wrong metadata receipts', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>().mockResolvedValue(
      transportReplySchema.parse({
        status: 200,
        body: { id, revision: 1, headRevision: 1, deleted: false },
        traceId: null,
      }),
    );
    const api = createConstraintsApi({ request });
    await api.create(command);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      idempotencyKey: 'stable',
      body: { expectedHeadRevision: null, confirmed: true, text: 'text' },
    });
    await expect(
      api.update(id, { ...command, expectedHeadRevision: 1, expectedRevision: 1 }),
    ).rejects.toThrow('CONSTRAINTS_RESPONSE_MISMATCH');
  });
  it('keeps raw server and network messages out of errors', async () => {
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValue({ status: 500, body: { error: { code: 'private' } }, traceId: null });
    const api = createConstraintsApi({ request });
    await expect(api.list()).rejects.toMatchObject({ status: 500, code: 'REQUEST_FAILED' });
    request.mockRejectedValue(new Error('private'));
    await expect(api.create(command)).rejects.not.toBeInstanceOf(ConstraintsRequestError);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
