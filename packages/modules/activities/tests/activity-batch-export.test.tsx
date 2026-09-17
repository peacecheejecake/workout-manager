import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import type { Activity } from '@workout/contracts/activity';
import { createBatchSelectionStore, toBatchTarget } from '../src/batch-selection';
import { ActivityBatchExport } from '../src/activity-batch-export';
const activity: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 2,
  source: { kind: 'fixture', sourceId: 'test', revision: 1, contentHash: 'a'.repeat(64) },
  original: {
    title: '합성',
    kind: 'running',
    startedAt: null,
    timezone: null,
    durationSeconds: 0,
    durationKind: 'timer',
    distanceMeters: null,
  },
  overlay: {},
  effective: {
    title: '합성',
    kind: 'running',
    startedAt: null,
    timezone: null,
    durationSeconds: 0,
    durationKind: 'timer',
    distanceMeters: null,
  },
  userReport: {
    definitionVersion: 'activity-report-v1',
    source: 'user',
    method: 'self_report',
    sessionRpe: 0,
    note: '개인 메모 fixture',
    rpeReportedAt: '2026-09-17T00:00:00Z',
    planLink: null,
  },
};
const reply = (body: unknown, status = 200) =>
  transportReplySchema.parse({ status, body, traceId: null });
function setup(request: AuthenticatedTransport['request']) {
  const store = createBatchSelectionStore();
  store.getState().selectPage([toBatchTarget(activity)]);
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-export');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const view = render(
    <ActivityBatchExport
      store={store}
      transport={{ request }}
      scope={['activities', 'alice', 'session']}
      now={() => '2026-09-17T01:00:00Z'}
    />,
  );
  return { ...view, store, create, revoke };
}
async function preview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' }));
  return screen.findByRole('button', { name: '확인하고 내보내기 파일 만들기' });
}
afterEach(() => vi.restoreAllMocks());
describe('selected summary export confirmation', () => {
  it('creates no file until explicit confirmation and preserves 0/null/report in its JSON Blob', async () => {
    const user = userEvent.setup(),
      request = vi.fn().mockResolvedValue(reply(activity));
    const { create, store } = setup(request);
    expect(request).not.toHaveBeenCalled();
    const confirm = await preview(user);
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(store.getState().locked).toBe(true);
    await user.click(confirm);
    const link = screen.getByRole('link', { name: '선택 활동 JSON 다운로드' });
    expect(link).toHaveAttribute('download', 'workout-manager-activity-summary.json');
    expect(link).toHaveFocus();
    const blob = create.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new Error('Missing Blob');
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Expected JSON text'));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    const json = JSON.parse(content);
    expect(json.activities[0]).toEqual(activity);
    expect(json.consistency).toBe('per-activity-revision');
    expect(json.format).toBe('workout-manager-activity-summary');
    expect(json.generatedAt).toBe('2026-09-17T01:00:00Z');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].method).toBe('GET');
  });
  it('requires all targets ready and never produces partial files on conflict', async () => {
    const user = userEvent.setup(),
      request = vi
        .fn()
        .mockResolvedValueOnce(reply(activity))
        .mockResolvedValueOnce(
          reply({ ...activity, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 3 }),
        );
    const { store, create } = setup(request);
    act(() =>
      store
        .getState()
        .selectPage([toBatchTarget({ ...activity, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })]),
    );
    const confirm = await preview(user);
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/수정 충돌/)).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '내보내기 닫기' }));
    expect(store.getState().targets).toHaveLength(2);
    expect(store.getState().locked).toBe(false);
  });
  it('revokes owned URLs on close and unmount while preserving selection', async () => {
    const user = userEvent.setup();
    const { revoke, store, unmount } = setup(vi.fn().mockResolvedValue(reply(activity)));
    await user.click(await preview(user));
    await user.click(screen.getByRole('button', { name: '내보내기 닫기' }));
    expect(revoke).toHaveBeenCalledWith('blob:test-export');
    expect(store.getState().targets).toEqual([toBatchTarget(activity)]);
    expect(screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' })).toHaveFocus();
    await user.click(await preview(user));
    unmount();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
  it('keeps the preview available after Blob creation failure and permits explicit retry', async () => {
    const user = userEvent.setup();
    const { create } = setup(vi.fn().mockResolvedValue(reply(activity)));
    create.mockImplementationOnce(() => {
      throw new Error('unsupported');
    });
    await user.click(await preview(user));
    expect(screen.getByRole('alert')).toHaveTextContent('파일을 만들지 못했습니다');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인하고 내보내기 파일 만들기' }));
    expect(screen.getByRole('link', { name: '선택 활동 JSON 다운로드' })).toBeVisible();
  });
  it('cancels reading and ignores the late response after close', async () => {
    const user = userEvent.setup();
    let finish: (value: ReturnType<typeof reply>) => void = () => {};
    const request = vi.fn<AuthenticatedTransport['request']>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { store, create } = setup(request);
    await user.click(screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' }));
    expect(screen.getByRole('button', { name: '내보내기 닫기' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await act(async () => finish(reply(activity)));
    expect(create).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('group', { name: '선택 활동 내보내기 확인' }),
    ).not.toBeInTheDocument();
    expect(store.getState().locked).toBe(false);
  });
  it('revokes files on account scope change and ignores earlier account reads', async () => {
    const user = userEvent.setup();
    const request = vi.fn().mockResolvedValue(reply(activity));
    const { rerender, create, revoke } = setup(request);
    await user.click(await preview(user));
    const next = createBatchSelectionStore();
    next.getState().selectPage([toBatchTarget(activity)]);
    rerender(
      <ActivityBatchExport
        store={next}
        transport={{ request }}
        scope={['activities', 'bob', 'new-session']}
      />,
    );
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(next.getState().locked).toBe(false);
  });
  it('blocks preview when another batch owns the selection lock', async () => {
    const request = vi.fn();
    const { store } = setup(request);
    act(() => store.getState().setLocked(true));
    expect(screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' })).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
  });
  it('aborts stale account reads without creating a file or showing old results', async () => {
    const user = userEvent.setup();
    let finish: (value: ReturnType<typeof reply>) => void = () => {};
    const request = vi.fn<AuthenticatedTransport['request']>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender, create } = setup(request);
    await user.click(screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' }));
    const next = createBatchSelectionStore();
    rerender(
      <ActivityBatchExport
        store={next}
        transport={{ request }}
        scope={['activities', 'bob', 'session']}
      />,
    );
    await act(async () => finish(reply(activity)));
    await waitFor(() => expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true));
    expect(create).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('group', { name: '선택 활동 내보내기 확인' }),
    ).not.toBeInTheDocument();
  });
});
