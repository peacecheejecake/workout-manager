import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { ConstraintsPanel } from '../src/constraints-panel';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const entry = {
  id,
  revision: 1,
  text: '기존 제약',
  confirmedAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
};
const reply = (body: unknown, status = 200) =>
  transportReplySchema.parse({ body, status, traceId: null });
afterEach(cleanup);
function setup() {
  const request = vi
    .fn<AuthenticatedTransport['request']>()
    .mockResolvedValue(reply({ headRevision: null, items: [] }));
  const props = {
    athleteId: 'owner',
    sessionId: 'session',
    transport: { request },
    createId: () => 'stable',
  };
  const view = render(<ConstraintsPanel {...props} />);
  return { request, ...view, props };
}
async function draft(text = '새 제약') {
  await screen.findByText('사용자 제약을 아직 확인하지 않았습니다.');
  await userEvent.type(screen.getByRole('textbox', { name: '사용자 제약 문장' }), text);
  await userEvent.click(screen.getByRole('button', { name: '제약 변경 검토' }));
}
describe('mandatory user constraints panel', () => {
  it('requires review and confirmation, cancels without writes, then refreshes committed metadata', async () => {
    const f = setup();
    await draft();
    expect(screen.getByRole('button', { name: '제약 변경 취소' })).toHaveFocus();
    expect(f.request.mock.calls.every((c) => c[0].method === 'GET')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '제약 변경 취소' }));
    expect(screen.getByRole('textbox')).toHaveValue('새 제약');
    expect(screen.getByRole('button', { name: '제약 변경 검토' })).toHaveFocus();
    f.request.mockImplementation(async (input) =>
      input.method === 'GET'
        ? reply({ headRevision: 1, items: [{ ...entry, text: '새 제약' }] })
        : reply({ id, revision: 1, headRevision: 1, deleted: false }),
    );
    await userEvent.click(screen.getByRole('button', { name: '제약 변경 검토' }));
    await userEvent.click(screen.getByRole('button', { name: '확인하고 제약 변경' }));
    await screen.findByText('사용자 제약 변경이 확인되었습니다.');
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(await screen.findByRole('button', { name: '제약 수정 · 새 제약' })).toBeEnabled();
  });
  it('retries unknown outcome with identical key/body and locks edits', async () => {
    const f = setup();
    await draft();
    let writes = 0;
    f.request.mockImplementation(async (input) =>
      input.method === 'GET'
        ? reply({ headRevision: 1, items: [entry] })
        : ++writes === 1
          ? Promise.reject(new Error('lost'))
          : reply({ id, revision: 1, headRevision: 1, deleted: false }),
    );
    await userEvent.click(screen.getByRole('button', { name: '확인하고 제약 변경' }));
    await screen.findByRole('button', { name: '같은 제약 요청 재확인' });
    expect(screen.getByRole('textbox')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '같은 제약 요청 재확인' }));
    await screen.findByText('사용자 제약 변경이 확인되었습니다.');
    const sent = f.request.mock.calls.filter((c) => c[0].method === 'POST');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });
  it('preserves text after409 and requires explicit refresh plus new confirmation', async () => {
    const f = setup();
    await draft();
    f.request.mockImplementation(async (input) =>
      input.method === 'GET'
        ? reply({ headRevision: 1, items: [entry] })
        : reply({ error: { code: 'COACHING_CONSTRAINT_REVISION_CONFLICT' } }, 409),
    );
    await userEvent.click(screen.getByRole('button', { name: '확인하고 제약 변경' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox')).toHaveValue('새 제약');
    expect(screen.getByRole('button', { name: '제약 변경 검토' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '최신 제약 확인' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '제약 변경 검토' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: '제약 변경 검토' }));
    expect(screen.getByRole('group', { name: '사용자 제약 변경 확인' })).toBeInTheDocument();
  });
  it('updates with the reviewed item revision and keeps beforeunload draft protection', async () => {
    const f = setup();
    await screen.findByText('사용자 제약을 아직 확인하지 않았습니다.');
    f.request.mockResolvedValue(reply({ headRevision: 1, items: [entry] }));
    await userEvent.click(screen.getByRole('button', { name: '최신 제약 확인' }));
    await userEvent.click(await screen.findByRole('button', { name: '제약 수정 · 기존 제약' }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), '수정된 제약');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '제약 변경 검토' }));
    f.request.mockImplementation(async (input) =>
      input.method === 'PUT'
        ? reply({ id, revision: 2, headRevision: 2, deleted: false })
        : reply({ headRevision: 2, items: [{ ...entry, revision: 2, text: '수정된 제약' }] }),
    );
    await userEvent.click(screen.getByRole('button', { name: '확인하고 제약 변경' }));
    await screen.findByText('사용자 제약 변경이 확인되었습니다.');
    expect(f.request.mock.calls.find((c) => c[0].method === 'PUT')?.[0].body).toEqual({
      expectedHeadRevision: 1,
      expectedRevision: 1,
      confirmed: true,
      text: '수정된 제약',
    });
  });
  it('hides current text during refresh and preserves a different draft after deletion', async () => {
    const f = setup();
    await screen.findByText('사용자 제약을 아직 확인하지 않았습니다.');
    f.request.mockResolvedValue(reply({ headRevision: 1, items: [entry] }));
    await userEvent.click(screen.getByRole('button', { name: '최신 제약 확인' }));
    await screen.findByRole('button', { name: '제약 삭제 · 기존 제약' });
    await userEvent.type(screen.getByRole('textbox'), '유지할 다른 초안');
    await userEvent.click(screen.getByRole('button', { name: '제약 삭제 · 기존 제약' }));
    let finish: (value: ReturnType<typeof reply>) => void = () => {};
    const waiting = new Promise<ReturnType<typeof reply>>((resolve) => {
      finish = resolve;
    });
    f.request.mockImplementation(async (input) =>
      input.method === 'DELETE'
        ? reply({ id, revision: 2, headRevision: 2, deleted: true })
        : waiting,
    );
    await userEvent.click(screen.getByRole('button', { name: '확인하고 제약 변경' }));
    await screen.findByText('사용자 제약 조회 중');
    expect(screen.queryByText('기존 제약', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('유지할 다른 초안');
    await act(async () => finish(reply({ headRevision: 2, items: [] })));
    await screen.findByText('현재 저장된 사용자 제약 문장이 없습니다.');
  });
  it.each([403, 404])('preserves draft without uncertain retry lock after%s', async (status) => {
    const f = setup();
    await draft();
    f.request.mockImplementation(async (input) =>
      input.method === 'GET'
        ? reply({ headRevision: null, items: [] })
        : reply({ error: { code: 'FORBIDDEN' } }, status),
    );
    await userEvent.click(screen.getByRole('button', { name: '확인하고 제약 변경' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    expect(screen.getByRole('textbox')).toHaveValue('새 제약');
    expect(screen.queryByRole('button', { name: '같은 제약 요청 재확인' })).not.toBeInTheDocument();
    if (status === 404)
      expect(screen.getByRole('button', { name: '제약 변경 검토' })).toBeDisabled();
  });
  it('deletes only after confirmation and distinguishes cleared head', async () => {
    const f = setup();
    await screen.findByText('사용자 제약을 아직 확인하지 않았습니다.');
    f.request.mockResolvedValue(reply({ headRevision: 1, items: [entry] }));
    await userEvent.click(screen.getByRole('button', { name: '최신 제약 확인' }));
    await userEvent.click(await screen.findByRole('button', { name: '제약 삭제 · 기존 제약' }));
    f.request.mockImplementation(async (input) =>
      input.method === 'DELETE'
        ? reply({ id, revision: 2, headRevision: 2, deleted: true })
        : reply({ headRevision: 2, items: [] }),
    );
    await userEvent.click(screen.getByRole('button', { name: '확인하고 제약 변경' }));
    await screen.findByText('현재 저장된 사용자 제약 문장이 없습니다.');
    expect(f.request.mock.calls.find((c) => c[0].method === 'DELETE')?.[0].body).toEqual({
      expectedHeadRevision: 1,
      expectedRevision: 1,
      confirmed: true,
    });
  });
  it('clears draft and aborts pending request on account lifetime change', async () => {
    const f = setup();
    await draft();
    let signal: AbortSignal | undefined;
    f.request.mockImplementation(async (input) => {
      if (input.method !== 'GET') {
        signal = input.signal;
        return new Promise(() => {});
      }
      return reply({ headRevision: null, items: [] });
    });
    await userEvent.click(screen.getByRole('button', { name: '확인하고 제약 변경' }));
    await act(async () =>
      f.rerender(<ConstraintsPanel {...f.props} athleteId="other" sessionId="other" />),
    );
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
