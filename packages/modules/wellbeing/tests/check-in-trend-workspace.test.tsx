import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { checkInListQuerySchema, type CheckIn } from '@workout/contracts/check-ins';
import { WellbeingWorkspace, type WellbeingWorkspaceProps } from '../src/wellbeing-workspace';
import { fetchCheckInTrend, readTrendQuery } from '../src/check-in-trend-query';

const query = checkInListQuerySchema.parse({
  from: '2026-09-01',
  toExclusive: '2026-10-01',
  limit: 100,
  offset: 0,
});
const record = (index: number): CheckIn => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  revision: 1,
  localDate: '2026-09-15',
  recordedAt: '2026-09-15T00:00:00Z',
  updatedAt: '2026-09-15T00:00:00Z',
  values: {
    observedAt: '2026-09-15T00:00:00Z',
    timezone: 'UTC',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: null,
  },
  source: 'user',
  method: 'self_report',
  definitionVersion: 'checkin-v1',
});
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (items: CheckIn[], total = items.length): Reply => ({
  status: 200,
  body: { items, total, collectionRevision: 3 },
  traceId: null,
});
const props = (transport: AuthenticatedTransport): WellbeingWorkspaceProps => ({
  athleteId: 'alice',
  sessionId: 'alice-session',
  transport,
  search: 'from=2026-09-01&toExclusive=2026-10-01',
  onSearchChange: () => {},
  initialObservedAt: '2026-09-17T00:00:00Z',
  initialTimezone: 'UTC',
});
describe('independent check-in trend page', () => {
  it('uses its own bounded offset and ignores the list page offset', () => {
    expect(readTrendQuery('offset=40&trendOffset=100', query).query).toEqual({
      ...query,
      offset: 100,
    });
    expect(readTrendQuery('trendOffset=10001', query).query).toBeNull();
    expect(readTrendQuery('trendOffset=-1', query).query).toBeNull();
    expect(readTrendQuery('', null).query).toBeNull();
  });
  it('rejects inconsistent, duplicate or out-of-window responses instead of presenting partial data as a full page', async () => {
    const first = record(0);
    for (const response of [
      reply([first], 2),
      reply([first, first]),
      reply([{ ...first, localDate: query.toExclusive }]),
      reply([{ ...first, localDate: '2026-08-31' }]),
    ]) {
      await expect(
        fetchCheckInTrend({ request: async () => response }, query, new AbortController().signal),
      ).rejects.toThrow('TREND_INVALID_PAGE');
    }
  });
  it('keeps independent pagination and drafts, resets both pages on period change and focuses selected detail', async () => {
    const records = Array.from({ length: 101 }, (_, index) => record(index));
    const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
      const url = new URL(input.path, 'http://localhost');
      if (!url.search) return { status: 200, body: records[0] ?? null, traceId: null };
      const offset = Number(url.searchParams.get('offset')),
        limit = Number(url.searchParams.get('limit'));
      return reply(records.slice(offset, offset + limit), records.length);
    });
    function Host() {
      const [search, setSearch] = useState(props({ request }).search);
      return (
        <>
          <output aria-label="URL">{search}</output>
          <WellbeingWorkspace {...props({ request })} search={search} onSearchChange={setSearch} />
        </>
      );
    }
    render(<Host />);
    const user = userEvent.setup();
    const trend = screen.getByRole('region', { name: '체크인 추세' });
    await waitFor(() =>
      expect(within(trend).getByRole('button', { name: '추세 다음 페이지' })).toBeEnabled(),
    );
    await user.type(screen.getByLabelText('체크인 메모'), '작성 중인 메모');
    await user.click(within(trend).getByRole('button', { name: '추세 다음 페이지' }));
    await waitFor(() =>
      expect(within(trend).getByRole('button', { name: '추세 다음 페이지' })).toBeDisabled(),
    );
    expect(screen.getByLabelText('URL')).toHaveTextContent('trendOffset=100');
    await user.click(screen.getByRole('button', { name: '다음 기록' }));
    await waitFor(() => expect(screen.getByLabelText('URL')).toHaveTextContent('offset=20'));
    expect(screen.getByLabelText('URL')).toHaveTextContent('trendOffset=100');
    expect(
      request.mock.calls.filter(
        ([r]) => r.path.includes('limit=100') && r.path.includes('offset=100'),
      ),
    ).toHaveLength(1);
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('작성 중인 메모');
    await user.click(screen.getByRole('button', { name: '기간 적용' }));
    await waitFor(() => expect(screen.getByLabelText('URL')).not.toHaveTextContent('Offset'));
    expect(screen.getByLabelText('URL')).not.toHaveTextContent('offset=');
    const action = within(trend).getAllByRole('button', { name: /추세 기록 상세 보기/ })[0];
    if (!action) throw new Error('Missing trend detail action');
    await user.click(action);
    const detail = await screen.findByRole('region', { name: '선택한 체크인' });
    expect(detail).toHaveFocus();
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('작성 중인 메모');
  });
  it('hides stale observations during failed refresh and recovers without dropping a draft', async () => {
    let fails = false;
    const request = async (input: TransportRequest): Promise<Reply> => {
      if (!input.path.includes('limit=100')) return reply([]);
      if (fails) throw new Error('offline');
      return reply([record(0)]);
    };
    render(<WellbeingWorkspace {...props({ request })} />);
    const trend = screen.getByRole('region', { name: '체크인 추세' });
    await within(trend).findByRole('button', { name: /추세 기록 상세 보기/ });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('체크인 메모'), '보존');
    fails = true;
    await user.click(within(trend).getByRole('button', { name: '추세 다시 확인' }));
    await within(trend).findByRole('alert');
    expect(
      within(trend).queryByRole('button', { name: /추세 기록 상세 보기/ }),
    ).not.toBeInTheDocument();
    fails = false;
    await user.click(within(trend).getByRole('button', { name: '추세 다시 확인' }));
    await within(trend).findByRole('button', { name: /추세 기록 상세 보기/ });
    expect(screen.getByLabelText('체크인 메모')).toHaveValue('보존');
  });
  it('aborts the old account request and rejects its late result after account replacement', async () => {
    let finish: ((value: Reply) => void) | undefined;
    let signal: AbortSignal | undefined;
    const request = async (input: TransportRequest): Promise<Reply> => {
      if (!input.path.includes('limit=100')) return reply([]);
      signal = input.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const mounted = render(<WellbeingWorkspace {...props({ request })} />);
    await waitFor(() => expect(finish).toBeDefined());
    mounted.rerender(
      <WellbeingWorkspace
        {...props({ request: async () => reply([]) })}
        athleteId="bob"
        sessionId="bob-session"
      />,
    );
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => {
      finish?.(reply([record(0)]));
    });
    const trend = screen.getByRole('region', { name: '체크인 추세' });
    expect(
      within(trend).queryByRole('button', { name: /추세 기록 상세 보기/ }),
    ).not.toBeInTheDocument();
  });
});
