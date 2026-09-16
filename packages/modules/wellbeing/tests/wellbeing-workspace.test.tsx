import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { CheckIn } from '@workout/contracts/check-ins';
import { WellbeingWorkspace, type WellbeingWorkspaceProps } from '../src/wellbeing-workspace';
import { localDateAt, readWellbeingSearch } from '../src/search';

type TransportReply = Awaited<ReturnType<AuthenticatedTransport['request']>>;

const record: CheckIn = {
  id: '00000000-0000-4000-8000-000000000001',
  revision: 1,
  values: {
    observedAt: '2026-09-15T23:30:00Z',
    timezone: 'Asia/Seoul',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: '원래 메모',
  },
  localDate: '2026-09-16',
  recordedAt: '2026-09-16T00:00:00Z',
  updatedAt: '2026-09-16T00:00:00Z',
  source: 'user',
  method: 'self_report',
  definitionVersion: 'checkin-v1',
};
const reply = (body: TransportReply['body'], status = 200): TransportReply => ({
  status,
  body,
  traceId: null,
});
const list = (items: CheckIn[] = []) =>
  reply({ items, total: items.length, collectionRevision: items.length });
const receipt = () => reply({ id: record.id, revision: 1, collectionRevision: 1, deleted: false });
function setup(handler: (input: TransportRequest) => Promise<TransportReply>, initialSearch = '') {
  const request = vi.fn(handler);
  const props: WellbeingWorkspaceProps = {
    athleteId: 'alice',
    sessionId: 'session-alice',
    transport: { request },
    search: initialSearch,
    onSearchChange: vi.fn(),
    initialObservedAt: '2026-09-15T23:30:00Z',
    initialTimezone: 'Asia/Seoul',
    createId: () => 'stable-checkin-key',
  };
  function Host({ value }: { value: WellbeingWorkspaceProps }) {
    const [search, setSearch] = useState(value.search);
    return <WellbeingWorkspace {...value} search={search} onSearchChange={setSearch} />;
  }
  return {
    ...render(<Host value={props} />),
    request,
    props,
    tree: (value: WellbeingWorkspaceProps) => <Host value={value} />,
  };
}
async function edit() {
  const panel = await screen.findByRole('region', { name: '선택한 체크인' });
  await userEvent.click(await within(panel).findByRole('button', { name: '이 기록 정정' }));
}
describe('check-in workspace', () => {
  it('preserves local date and rejects unbounded URL windows', () => {
    expect(localDateAt('2026-09-15T23:30:00Z', 'Asia/Seoul')).toBe('2026-09-16');
    expect(
      readWellbeingSearch('from=2026-01-01&toExclusive=2027-01-01', '2026-09-16').query,
    ).toBeNull();
  });
  it('saves explicit zero separately from unreported and does not save merely by editing', async () => {
    const { request } = setup(async (input) => (input.method === 'POST' ? receipt() : list()));
    const user = userEvent.setup();
    expect(screen.getByLabelText('피로 (0~10)')).toHaveAccessibleDescription(
      '관측 시점에 느낀 피로는 어느 정도인가요? 0: 피로 없음 · 10: 매우 심한 피로',
    );
    await user.selectOptions(screen.getByLabelText('피로 (0~10)'), '0');
    expect(request.mock.calls.some(([input]) => input.method === 'POST')).toBe(false);
    await user.click(screen.getByRole('button', { name: '체크인 저장' }));
    await screen.findByText('저장이 확인되었습니다.');
    expect(request.mock.calls.find(([input]) => input.method === 'POST')?.[0]).toMatchObject({
      body: {
        values: {
          fatigue: 0,
          discomfort: null,
          observedAt: record.values.observedAt,
          timezone: 'Asia/Seoul',
        },
      },
      idempotencyKey: 'stable-checkin-key',
    });
  });
  it('retries an uncertain save with its exact frozen payload and key', async () => {
    let writes = 0;
    const { request } = setup(async (input) => {
      if (input.method !== 'POST') return list();
      if (++writes === 1) throw new Error('lost response');
      return receipt();
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('체크인 메모'), '보존할 메모');
    await user.click(screen.getByRole('button', { name: '체크인 저장' }));
    await screen.findByRole('button', { name: '같은 요청 다시 시도' });
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('보존할 메모');
    expect(screen.getByLabelText('체크인 메모')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '같은 요청 다시 시도' }));
    await screen.findByText('저장이 확인되었습니다.');
    const calls = request.mock.calls
      .filter(([input]) => input.method === 'POST')
      .map(([input]) => input);
    expect(calls[0]?.body).toEqual(calls[1]?.body);
    expect(calls[0]?.idempotencyKey).toBe(calls[1]?.idempotencyKey);
  });
  it('retains a stale correction and requires explicit latest-record comparison before retry', async () => {
    let stale = false;
    const updated = { ...record, revision: 2, values: { ...record.values, note: '다른 창 수정' } };
    const { request } = setup(async (input) => {
      if (input.method === 'PUT') {
        stale = true;
        return reply({ error: { code: 'REVISION_CONFLICT' } }, 409);
      }
      return input.path.includes('?') ? list([record]) : reply(stale ? updated : record);
    }, `selected=${record.id}`);
    const user = userEvent.setup();
    await edit();
    await user.clear(screen.getByLabelText('체크인 메모'));
    await user.type(screen.getByLabelText('체크인 메모'), '나의 정정');
    await user.type(screen.getByLabelText('정정 사유'), '잘못 입력');
    await user.click(screen.getByRole('button', { name: '정정 저장' }));
    await screen.findByText(/다른 변경으로 기록이 달라졌습니다/);
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('나의 정정');
    expect(screen.getByRole('button', { name: '정정 저장' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '최신 기록 확인' }));
    await screen.findByText('다른 창 수정');
    await user.click(screen.getByRole('button', { name: '작성한 내용으로 다시 정정 준비' }));
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('나의 정정');
    expect(screen.getByRole('button', { name: '정정 저장' })).toBeEnabled();
    expect(request.mock.calls.filter(([input]) => input.method === 'PUT')).toHaveLength(1);
  });
  for (const outcome of ['conflict', 'uncertain'] as const) {
    it(`blocks an already-open discard confirmation during a delayed ${outcome} save`, async () => {
      let finish: ((reply: TransportReply) => void) | undefined;
      let writes = 0;
      const { request } = setup(async (input) => {
        if (input.method === 'PUT') {
          if (++writes === 1)
            return new Promise((resolve) => {
              finish = resolve;
            });
          return receipt();
        }
        return input.path.includes('?') ? list([record]) : reply(record);
      }, `selected=${record.id}`);
      const user = userEvent.setup();
      await edit();
      await user.clear(screen.getByLabelText('체크인 메모'));
      await user.type(screen.getByLabelText('체크인 메모'), '보존할 정정');
      await user.type(screen.getByLabelText('정정 사유'), '이전 보고 정정');
      await user.click(screen.getByRole('button', { name: '새 체크인 작성' }));
      const discard = screen.getByRole('button', { name: '작성 내용 버리고 전환' });
      await user.click(screen.getByRole('button', { name: '정정 저장' }));
      expect(discard).toBeDisabled();
      expect(screen.getByRole('button', { name: '계속 작성' })).toBeDisabled();
      await user.click(discard);
      await act(async () => {
        finish?.(
          outcome === 'conflict'
            ? reply({ error: { code: 'REVISION_CONFLICT' } }, 409)
            : reply(null, 503),
        );
      });
      expect(screen.getByLabelText('체크인 메모')).toHaveValue('보존할 정정');
      expect(screen.getByLabelText('정정 사유')).toHaveValue('이전 보고 정정');
      expect(screen.getByText('정정 기준 원본 · 수정 1')).toBeInTheDocument();
      if (outcome === 'conflict') {
        expect(screen.getByRole('button', { name: '최신 기록 확인' })).toBeEnabled();
        expect(screen.getByRole('button', { name: '정정 저장' })).toBeDisabled();
      } else {
        expect(discard).toBeDisabled();
        await user.click(discard);
        await user.click(screen.getByRole('button', { name: '같은 요청 다시 시도' }));
        await screen.findByText('저장이 확인되었습니다.');
        const sent = request.mock.calls
          .filter(([input]) => input.method === 'PUT')
          .map(([input]) => input);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.body).toEqual(sent[0]?.body);
        expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey);
      }
    });
  }
  it('does not submit while an IME composition is active', async () => {
    const { request } = setup(async () => list());
    const input = screen.getByLabelText('불편한 부위');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '무릎' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    const form = input.closest('form');
    expect(form).not.toBeNull();
    if (form) fireEvent.submit(form);
    expect(request.mock.calls.some(([value]) => value.method !== 'GET')).toBe(false);
    fireEvent.compositionEnd(input);
    expect(input).toHaveValue('무릎');
  });
  it('requires a correction reason and retains the draft on stale deletion', async () => {
    const { request } = setup(async (input) => {
      if (input.method === 'DELETE') return reply({ error: { code: 'REVISION_CONFLICT' } }, 409);
      return input.path.includes('?') ? list([record]) : reply(record);
    }, `selected=${record.id}`);
    const user = userEvent.setup();
    await edit();
    await user.type(screen.getByLabelText('체크인 메모'), ' 작성 중');
    await user.click(screen.getByRole('button', { name: '정정 저장' }));
    await screen.findByText('정정 사유를 1~500자로 입력하세요.');
    expect(request.mock.calls.some(([input]) => input.method === 'PUT')).toBe(false);
    await user.click(screen.getByLabelText('이 체크인을 삭제합니다'));
    await user.click(screen.getByRole('button', { name: '체크인 삭제' }));
    await screen.findByText(/다른 변경으로 기록이 달라졌습니다/);
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('원래 메모 작성 중');
    expect(screen.getByRole('button', { name: '체크인 삭제' })).toBeDisabled();
  });
  it('requires explicit deletion confirmation and includes the original revision', async () => {
    let deleted = false;
    const { request } = setup(async (input) => {
      if (input.method === 'DELETE') {
        deleted = true;
        return reply({ id: record.id, revision: 2, collectionRevision: 2, deleted: true });
      }
      return input.path.includes('?')
        ? list(deleted ? [] : [record])
        : deleted
          ? reply({ error: { code: 'NOT_FOUND' } }, 404)
          : reply(record);
    }, `selected=${record.id}`);
    const user = userEvent.setup();
    await edit();
    expect(screen.getByRole('button', { name: '체크인 삭제' })).toBeDisabled();
    expect(request.mock.calls.some(([input]) => input.method === 'DELETE')).toBe(false);
    await user.click(screen.getByLabelText('이 체크인을 삭제합니다'));
    await user.click(screen.getByRole('button', { name: '체크인 삭제' }));
    await screen.findByText('삭제가 확인되었습니다.');
    expect(request.mock.calls.find(([input]) => input.method === 'DELETE')?.[0].body).toEqual({
      expectedRevision: 1,
    });
  });
  it('does not expose a save receipt as a fresh list when authoritative reread fails', async () => {
    let saved = false;
    setup(async (input) => {
      if (input.method === 'POST') {
        saved = true;
        return receipt();
      }
      if (saved) throw new Error('offline');
      return list([record]);
    });
    const user = userEvent.setup();
    await screen.findByText('원래 메모');
    await user.type(screen.getByLabelText('체크인 메모'), '새 메모');
    await user.click(screen.getByRole('button', { name: '체크인 저장' }));
    await screen.findByText(/저장 또는 삭제는 확인되었지만 최신 조회/);
    expect(screen.queryByText('원래 메모')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '같은 요청 다시 시도' })).not.toBeInTheDocument();
  });
  it('keeps drafts through URL filter changes but resets them on account switch and ignores late writes', async () => {
    let finish: ((result: TransportReply) => void) | undefined;
    const { rerender, props, tree } = setup(async (input) => {
      if (input.method === 'POST')
        return new Promise((resolve) => {
          finish = resolve;
        });
      return list();
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('체크인 메모'), 'Alice 전용');
    await user.click(screen.getByRole('button', { name: '기간 적용' }));
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('Alice 전용');
    await user.click(screen.getByRole('button', { name: '체크인 저장' }));
    await waitFor(() => expect(finish).toBeDefined());
    rerender(tree({ ...props, athleteId: 'bob', sessionId: 'session-bob' }));
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('');
    await act(async () => {
      finish?.(receipt());
    });
    expect(screen.queryByText('저장이 확인되었습니다.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('');
  });
});
