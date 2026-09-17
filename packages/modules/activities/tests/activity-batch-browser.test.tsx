import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Activity } from '@workout/contracts/activity';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { ActivityBrowser, type ActivityBrowserProps } from '../src/activity-browser';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
function activity(index: number, revision = 1): Activity {
  const values = {
    title: `활동 ${index}`,
    kind: 'running' as const,
    startedAt: null,
    timezone: null,
    durationSeconds: 0,
    durationKind: 'timer' as const,
    distanceMeters: null,
  };
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    revision,
    source: { kind: 'fit', sourceId: `source-${index}`, revision: 1, contentHash: 'a'.repeat(64) },
    original: values,
    effective: values,
    overlay: {},
  };
}
function setup(
  list: (url: URL) => Activity[] = () => [activity(1), activity(2)],
  total = 2,
  search = '',
) {
  const changed = vi.fn();
  const deleted = new Set<string>();
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    if (input.method === 'DELETE') {
      deleted.add(input.path.split('/').at(-1) ?? '');
      return reply(null, 204);
    }
    if (input.path === '/bff/v1/plans/current') return reply({ head: null, history: [] });
    if (input.path.includes('?')) {
      const items = list(new URL(input.path, 'http://local')).filter(
        (item) => !deleted.has(item.id),
      );
      return reply({ items, total: Math.max(0, total - deleted.size) });
    }
    const directActivity = /^\/bff\/v1\/activities\/[^/]+$/.test(input.path);
    const selected = input.path.split('/').at(directActivity ? -1 : -2);
    const value = [activity(1), activity(2)].find((item) => item.id === selected) ?? activity(1);
    if (deleted.has(value.id)) return reply({ error: { code: 'NOT_FOUND' } }, 404);
    if (directActivity) return reply(value);
    if (input.path.endsWith('/details'))
      return reply({
        activityId: value.id,
        activityRevision: value.revision,
        source: value.source,
        details: null,
      });
    return reply({
      definitionVersion: 'activity-context-v1',
      observedAt: '2026-09-16T00:00:00Z',
      activity: value,
      activityDataRevision: { count: 1, revisionSum: '1' },
      planContext: { status: 'unlinked' },
    });
  });
  const props: ActivityBrowserProps = {
    athleteId: 'alice',
    sessionId: 'session-a',
    transport: { request },
    search,
    onSearchChange: changed,
    initialTimezone: 'Asia/Seoul',
    importHref: '/activities/import',
  };
  function Host({ value }: { value: ActivityBrowserProps }) {
    const [query, setQuery] = useState(value.search);
    return (
      <ActivityBrowser
        {...value}
        search={query}
        onSearchChange={(next) => {
          changed(next);
          setQuery(next);
        }}
      />
    );
  }
  return {
    ...render(<Host value={props} />),
    request,
    changed,
    props,
    tree: (value: ActivityBrowserProps) => <Host value={value} />,
  };
}
const checkbox = (index: number) =>
  screen.getByRole('checkbox', { name: `일괄 선택: 활동 ${index}` });
const selection = () => screen.getByRole('region', { name: '활동 일괄 선택' });

describe('activity batch selection in the browser', () => {
  it('keeps selection separate from detail URL across table/card, paging and filters without writes', async () => {
    const user = userEvent.setup();
    const { request, changed } = setup(
      (url) =>
        url.searchParams.get('offset') === '20' || url.searchParams.get('search')
          ? [activity(2)]
          : [activity(1)],
      21,
    );
    await screen.findByRole('checkbox', { name: '일괄 선택: 활동 1' });
    await user.click(checkbox(1));
    expect(changed).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '활동 1' }));
    await screen.findByRole('region', { name: '정정 반영 기록' });
    await user.click(screen.getByRole('button', { name: '표 보기' }));
    expect(checkbox(1)).toBeChecked();
    await user.click(screen.getByRole('button', { name: '다음 활동' }));
    await screen.findByRole('checkbox', { name: '일괄 선택: 활동 2' });
    expect(selection()).toHaveTextContent('일괄 선택 1개');
    await user.click(screen.getByRole('button', { name: '현재 페이지 선택' }));
    expect(checkbox(2)).toBeChecked();
    expect(selection()).toHaveTextContent('일괄 선택 2개');
    await user.type(screen.getByRole('textbox', { name: '활동 제목 검색' }), '별도 조건');
    await user.click(screen.getByRole('button', { name: '활동 필터 적용' }));
    await screen.findByText(/제목 별도 조건/);
    await user.click(screen.getByRole('button', { name: '카드 보기' }));
    expect(checkbox(2)).toBeChecked();
    expect(new URLSearchParams(changed.mock.lastCall?.[0]).get('selected')).toBe(activity(1).id);
    expect(selection()).toHaveTextContent('일괄 선택 2개');
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('shares the lock with plan changes and cancellation preserves off-page selection and the detail URL', async () => {
    const user = userEvent.setup();
    const { request, changed } = setup(
      (url) => (url.searchParams.get('search') ? [activity(2)] : [activity(1), activity(2)]),
      2,
      `selected=${activity(1).id}`,
    );
    await screen.findByRole('region', { name: '정정 반영 기록' });
    await user.click(screen.getByRole('button', { name: '현재 페이지 선택' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '일괄 계획 동작' }), 'unlink');
    await user.type(screen.getByRole('textbox', { name: '일괄 계획 연결 사유' }), '기존 연결 검토');
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 미리보기' }));
    const preview = await screen.findByRole('group', { name: '일괄 계획 연결 확인' });
    expect(await within(preview).findAllByText(/이미 같은 연결/)).toHaveLength(2);
    const exportOpener = screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' });
    expect(exportOpener).toBeDisabled();
    await user.click(exportOpener);
    expect(
      screen.queryByRole('group', { name: '선택 활동 내보내기 확인' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' }));
    expect(screen.queryByRole('group', { name: '일괄 로컬 삭제 확인' })).not.toBeInTheDocument();
    expect(checkbox(1)).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '표 보기' }));
    expect(checkbox(1)).toBeChecked();
    expect(checkbox(1)).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: '활동 제목 검색' }), '다른 페이지');
    await user.click(screen.getByRole('button', { name: '활동 필터 적용' }));
    await screen.findByText(/제목 다른 페이지/);
    expect(checkbox(2)).toBeDisabled();
    expect(selection()).toHaveTextContent('일괄 선택 2개');
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 취소' }));
    expect(screen.queryByRole('group', { name: '일괄 계획 연결 확인' })).not.toBeInTheDocument();
    expect(checkbox(2)).toBeChecked();
    expect(checkbox(2)).toBeEnabled();
    expect(exportOpener).toBeEnabled();
    expect(selection()).toHaveTextContent('일괄 선택 2개');
    expect(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' })).toBeEnabled();
    expect(new URLSearchParams(changed.mock.lastCall?.[0]).get('selected')).toBe(activity(1).id);
    expect(screen.getByRole('region', { name: '정정 반영 기록' })).toHaveTextContent('활동 1');
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('prevents the plan workflow from opening while deletion owns the lock', async () => {
    const user = userEvent.setup();
    const { request } = setup();
    await screen.findByRole('checkbox', { name: '일괄 선택: 활동 1' });
    await user.click(checkbox(1));
    await user.selectOptions(screen.getByRole('combobox', { name: '일괄 계획 동작' }), 'unlink');
    await user.type(screen.getByRole('textbox', { name: '일괄 계획 연결 사유' }), '검토 사유');
    await user.click(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' }));
    const opener = screen.getByRole('button', { name: '계획 연결 변경 미리보기' });
    const exportOpener = screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' });
    expect(exportOpener).toBeDisabled();
    await user.click(exportOpener);
    expect(
      screen.queryByRole('group', { name: '선택 활동 내보내기 확인' }),
    ).not.toBeInTheDocument();
    expect(opener).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '일괄 계획 동작' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '일괄 계획 연결 사유' })).toBeDisabled();
    await user.click(opener);
    expect(screen.queryByRole('group', { name: '일괄 계획 연결 확인' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '일괄 삭제 취소' }));
    expect(opener).toBeEnabled();
    expect(exportOpener).toBeEnabled();
    expect(screen.getByRole('textbox', { name: '일괄 계획 연결 사유' })).toHaveValue('검토 사유');
    expect(checkbox(1)).toBeChecked();
    await user.click(opener);
    const preview = await screen.findByRole('group', { name: '일괄 계획 연결 확인' });
    expect(await within(preview).findByText(/이미 같은 연결/)).toBeVisible();
    expect(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' })).toBeDisabled();
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('locks both mutation workflows during export preview and closes without a file, writes or selection changes', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:unconfirmed-export');
    const revokeObjectURL = vi.fn();
    const OriginalURL = URL;
    vi.stubGlobal(
      'URL',
      class extends OriginalURL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    try {
      const { request, changed } = setup(undefined, 2, `selected=${activity(1).id}`);
      await screen.findByRole('region', { name: '정정 반영 기록' });
      await user.click(screen.getByRole('button', { name: '현재 페이지 선택' }));
      await user.click(screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' }));
      const preview = await screen.findByRole('group', { name: '선택 활동 내보내기 확인' });
      await waitFor(() =>
        expect(
          within(preview).getByRole('button', { name: '확인하고 내보내기 파일 만들기' }),
        ).toBeEnabled(),
      );
      const deletion = screen.getByRole('button', { name: '선택 활동 삭제 미리보기' });
      const link = screen.getByRole('button', { name: '계획 연결 변경 미리보기' });
      expect(deletion).toBeDisabled();
      expect(link).toBeDisabled();
      expect(checkbox(1)).toBeDisabled();
      expect(screen.getByRole('button', { name: '일괄 선택 해제' })).toBeDisabled();
      await user.click(deletion);
      await user.click(link);
      expect(screen.queryByRole('group', { name: '일괄 로컬 삭제 확인' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: '일괄 계획 연결 확인' })).not.toBeInTheDocument();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('link', { name: '선택 활동 JSON 다운로드' }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '내보내기 닫기' }));
      expect(
        screen.queryByRole('group', { name: '선택 활동 내보내기 확인' }),
      ).not.toBeInTheDocument();
      expect(checkbox(1)).toBeChecked();
      expect(checkbox(2)).toBeChecked();
      expect(checkbox(1)).toBeEnabled();
      expect(selection()).toHaveTextContent('일괄 선택 2개');
      expect(deletion).toBeEnabled();
      expect(link).toBeEnabled();
      expect(changed).not.toHaveBeenCalled();
      expect(screen.getByRole('region', { name: '정정 반영 기록' })).toHaveTextContent('활동 1');
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains captured revisions until explicit deselection and locks all choices during preview', async () => {
    const user = userEvent.setup();
    let revision = 1;
    const { request } = setup(() => [activity(1, revision)], 1);
    await screen.findByRole('checkbox', { name: '일괄 선택: 활동 1' });
    await user.click(checkbox(1));
    revision = 2;
    await user.click(screen.getByRole('button', { name: '활동 목록 다시 확인' }));
    await screen.findByText(/기록 수정 2/);
    await user.click(screen.getByRole('button', { name: '현재 페이지 선택' }));
    await user.click(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' }));
    expect(screen.getByRole('group', { name: '일괄 로컬 삭제 확인' })).toHaveTextContent(
      '확인한 수정 번호 1',
    );
    expect(checkbox(1)).toBeDisabled();
    expect(screen.getByRole('button', { name: '현재 페이지 선택' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '일괄 선택 해제' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '일괄 삭제 취소' }));
    await user.click(checkbox(1));
    await user.click(checkbox(1));
    await user.click(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' }));
    expect(screen.getByRole('group', { name: '일괄 로컬 삭제 확인' })).toHaveTextContent(
      '확인한 수정 번호 2',
    );
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('rejects a page exceeding 100 atomically instead of selecting a partial page', async () => {
    const user = userEvent.setup();
    setup((url) => {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      return Array.from({ length: offset === 100 ? 2 : 20 }, (_, index) =>
        activity(offset + index + 1),
      );
    }, 102);
    for (let page = 0; page < 5; page++) {
      await screen.findByRole('checkbox', { name: `일괄 선택: 활동 ${page * 20 + 1}` });
      await user.click(screen.getByRole('button', { name: '현재 페이지 선택' }));
      expect(selection()).toHaveTextContent(`일괄 선택 ${(page + 1) * 20}개`);
      await user.click(screen.getByRole('button', { name: '다음 활동' }));
    }
    await screen.findByRole('checkbox', { name: '일괄 선택: 활동 101' });
    await user.click(screen.getByRole('button', { name: '현재 페이지 선택' }));
    expect(selection()).toHaveTextContent('일괄 선택 100개');
    expect(checkbox(101)).not.toBeChecked();
    expect(checkbox(102)).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('최대 100개');
    await user.click(screen.getByRole('button', { name: '일괄 선택 해제' }));
    expect(selection()).toHaveTextContent('일괄 선택 0개');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears selection and preview on account/session change', async () => {
    const user = userEvent.setup();
    const { props, rerender, tree } = setup();
    await screen.findByRole('checkbox', { name: '일괄 선택: 활동 1' });
    await user.click(checkbox(1));
    await user.click(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' }));
    rerender(tree({ ...props, athleteId: 'bob', sessionId: 'session-b' }));
    await screen.findByRole('checkbox', { name: '일괄 선택: 활동 1' });
    expect(selection()).toHaveTextContent('일괄 선택 0개');
    expect(checkbox(1)).not.toBeChecked();
    expect(checkbox(1)).toBeEnabled();
    expect(screen.queryByRole('group', { name: '일괄 로컬 삭제 확인' })).not.toBeInTheDocument();
  });

  it('keeps batch controls available for invalid URLs and disables page selection', async () => {
    const { request } = setup(undefined, 2, 'selected=invalid');
    expect(selection()).toHaveTextContent('일괄 선택 0개');
    expect(screen.getByRole('region', { name: '선택 활동 일괄 로컬 삭제' })).toBeVisible();
    expect(screen.getByRole('button', { name: '현재 페이지 선택' })).toBeDisabled();
    expect(
      request.mock.calls.every(
        ([input]) => input.path === '/bff/v1/plans/current' && input.method === 'GET',
      ),
    ).toBe(true);
  });

  it.each([true, false])(
    'closes only a deleted detail selection (selected deleted=%s)',
    async (selectedDeleted) => {
      const user = userEvent.setup();
      const { changed } = setup(undefined, 2, `selected=${activity(selectedDeleted ? 1 : 2).id}`);
      await screen.findByRole('region', { name: '정정 반영 기록' });
      await user.click(checkbox(1));
      await user.click(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' }));
      await user.click(screen.getByRole('button', { name: '선택 활동 삭제 확인' }));
      await within(await screen.findByRole('region', { name: '일괄 삭제 결과' })).findByText(
        /로컬 삭제 확인/,
      );
      await waitFor(() => expect(selection()).toHaveTextContent('일괄 선택 0개'));
      if (selectedDeleted) {
        expect(new URLSearchParams(changed.mock.lastCall?.[0]).has('selected')).toBe(false);
        expect(screen.queryByRole('region', { name: '선택한 활동 상세' })).not.toBeInTheDocument();
      } else {
        expect(changed).not.toHaveBeenCalled();
        expect(await screen.findByRole('region', { name: '정정 반영 기록' })).toHaveTextContent(
          '활동 2',
        );
      }
    },
  );
});
