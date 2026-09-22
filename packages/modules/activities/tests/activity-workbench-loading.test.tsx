import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { ActivityBrowser, type ActivityBrowserProps } from '../src/activity-browser';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const values = {
  title: '병렬 조회 활동',
  kind: 'running' as const,
  startedAt: null,
  timezone: null,
  durationSeconds: 0,
  durationKind: 'timer' as const,
  distanceMeters: 0,
};
const activity: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 1,
  source: { kind: 'fit', sourceId: 'source-a', revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
};
const other: Activity = {
  ...activity,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  original: { ...values, title: '다음 활동' },
  effective: { ...values, title: '다음 활동' },
  source: { ...activity.source, sourceId: 'source-b' },
};
const read = (value = activity): ActivityDetailsRead => ({
  activityId: value.id,
  activityRevision: value.revision,
  source: value.source,
  details: null,
});
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
const context = (value = activity) =>
  reply({
    definitionVersion: 'activity-context-v1',
    observedAt: '2026-09-16T00:00:00Z',
    activity: value,
    activityDataRevision: { count: 1, revisionSum: '1' },
    planContext: { status: 'unlinked' },
  });
function deferred() {
  let resolve!: (value: Reply) => void;
  const promise = new Promise<Reply>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(handler: (input: TransportRequest) => Promise<Reply>) {
  const request = vi.fn((input: TransportRequest) => {
    if (input.path === '/bff/v1/plans/current')
      return Promise.resolve(reply({ head: null, history: [] }));
    // The delete confirmation reads the courses a deletion would reclaim (M2-01f) and
    // cannot be confirmed until it has an answer.
    if (input.path.endsWith('/deletion-impact'))
      return Promise.resolve(
        reply({ activityId: activity.id, digest: 'a'.repeat(64), courses: [], total: 0 }),
      );
    if (input.path.includes('?')) return Promise.resolve(reply({ items: [], total: 0 }));
    return handler(input);
  });
  const props: ActivityBrowserProps = {
    athleteId: 'alice',
    sessionId: 'session-a',
    transport: { request },
    search: `selected=${activity.id}&detailTab=intervals`,
    onSearchChange: vi.fn(),
    initialTimezone: 'Asia/Seoul',
    importHref: '/activities/import',
  };
  return { ...render(<ActivityBrowser {...props} />), request, props };
}
const emptyDetail = '저장된 원본 관측 상세가 없습니다. 요약 기록은 위에서 확인할 수 있습니다.';
const detailSection = () => screen.getByRole('region', { name: '활동 세부 기록 조회' });
const callsFor = (request: ReturnType<typeof setup>['request'], suffix: string) =>
  request.mock.calls.filter(([input]) => input.path.endsWith(suffix));

describe('activity summary and source detail boundary', () => {
  it('starts independent requests together, retains the summary while pending and distinguishes absent detail from failure', async () => {
    const summary = deferred(),
      details = deferred();
    const { request } = setup((input) =>
      input.path.endsWith('/context') ? summary.promise : details.promise,
    );
    expect(callsFor(request, '/context')).toHaveLength(1);
    expect(callsFor(request, '/details')).toHaveLength(1);
    await act(async () => {
      summary.resolve(context());
    });
    expect(await screen.findByRole('region', { name: '활동 요약 출처' })).toHaveTextContent(
      values.title,
    );
    expect(within(detailSection()).getByRole('status')).toHaveTextContent(
      '레코드·랩을 확인하고 있습니다.',
    );
    expect(screen.queryByText(emptyDetail)).not.toBeInTheDocument();
    await act(async () => {
      details.resolve(reply(read()));
    });
    expect(await screen.findByText(emptyDetail)).toBeVisible();
    expect(within(detailSection()).queryByRole('alert')).not.toBeInTheDocument();
    expect(
      request.mock.calls.every(
        ([input]) => input.method === 'GET' && input.body === null && input.idempotencyKey === null,
      ),
    ).toBe(true);
  });

  it.each([
    ['canonical revision', { ...read(), activityRevision: 2 }],
    ['source kind', { ...read(), source: { ...activity.source, kind: 'fixture' } }],
    ['source ID', { ...read(), source: { ...activity.source, sourceId: 'another-source' } }],
    ['source revision', { ...read(), source: { ...activity.source, revision: 2 } }],
    ['source hash', { ...read(), source: { ...activity.source, contentHash: 'b'.repeat(64) } }],
  ])(
    'rejects mismatched %s and only recovers through a paired refresh',
    async (_label, mismatched) => {
      const user = userEvent.setup();
      let current: unknown = mismatched;
      const { request } = setup(async (input) =>
        input.path.endsWith('/context') ? context() : reply(current),
      );
      expect(await within(detailSection()).findByRole('alert')).toHaveTextContent(
        '버전이 다릅니다',
      );
      expect(screen.getByRole('region', { name: '활동 요약 출처' })).toHaveTextContent(
        values.title,
      );
      expect(screen.queryByText(emptyDetail)).not.toBeInTheDocument();
      expect(callsFor(request, '/details')).toHaveLength(1);
      current = read();
      await user.click(screen.getByRole('button', { name: '요약과 세부 기록 다시 확인' }));
      expect(await screen.findByText(emptyDetail)).toBeVisible();
      expect(callsFor(request, '/context')).toHaveLength(2);
      expect(callsFor(request, '/details')).toHaveLength(2);
    },
  );

  it.each([
    [503, { error: { code: 'UNAVAILABLE' } }, '최신 확인 실패'],
    [404, { error: { code: 'NOT_FOUND' } }, '삭제되었거나 접근할 수 없습니다'],
    [200, { ...read(), activityId: other.id }, '최신 확인 실패'],
    [200, { ...read(), details: {} }, '최신 확인 실패'],
  ])(
    'keeps summary on source response %s and validates identity and schema',
    async (status, body, message) => {
      const { request } = setup(async (input) =>
        input.path.endsWith('/context') ? context() : reply(body, status),
      );
      expect(await within(detailSection()).findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('region', { name: '활동 요약 출처' })).toHaveTextContent(
        values.title,
      );
      expect(screen.queryByText(emptyDetail)).not.toBeInTheDocument();
      expect(callsFor(request, '/details')).toHaveLength(1);
    },
  );

  it('hides cached detail until both refreshes settle and suppresses detail when the summary becomes deleted', async () => {
    const user = userEvent.setup();
    let refreshing = false;
    const summary = deferred(),
      details = deferred();
    const { request } = setup(async (input) =>
      input.path.endsWith('/context')
        ? refreshing
          ? summary.promise
          : context()
        : refreshing
          ? details.promise
          : reply(read()),
    );
    await screen.findByText(emptyDetail);
    refreshing = true;
    await user.click(screen.getByRole('button', { name: '활동 상세 다시 확인' }));
    expect(screen.getByText(emptyDetail)).not.toBeVisible();
    await act(async () => {
      details.resolve(reply(read()));
    });
    expect(screen.getByText(emptyDetail)).not.toBeVisible();
    await act(async () => {
      summary.resolve(reply({ error: { code: 'NOT_FOUND' } }, 404));
    });
    expect(await screen.findByText('기록이 삭제되었거나 접근할 수 없습니다.')).toBeVisible();
    expect(screen.queryByText(emptyDetail)).not.toBeInTheDocument();
    expect(callsFor(request, '/context')).toHaveLength(2);
    expect(callsFor(request, '/details')).toHaveLength(2);
  });

  it.each(['paired refresh', 'window focus'] as const)(
    'retains same-revision selection and unsubmitted UTC inputs through %s',
    async (trigger) => {
      const user = userEvent.setup();
      const observations: ActivityDetailsRead = {
        ...read(),
        details: {
          schemaVersion: 1,
          streamIndex: 0,
          sessionIndex: 0,
          startedAt: null,
          recordedAt: null,
          elapsedSeconds: null,
          records: [
            { index: 0, timestamp: '2026-09-16T00:00:00Z', distanceMeters: 0, heartRateBpm: null },
          ],
          laps: [],
        },
      };
      let refreshing = false;
      const summary = deferred(),
        details = deferred();
      const { request } = setup(async (input) =>
        input.path.endsWith('/context')
          ? refreshing
            ? summary.promise
            : context()
          : refreshing
            ? details.promise
            : reply(observations),
      );
      await screen.findByRole('region', { name: '원본 관측 워크벤치' });
      await user.click(screen.getByRole('button', { name: '관측 0 선택' }));
      const input = screen.getByLabelText('구간 시작 (UTC)');
      fireEvent.change(input, { target: { value: '2026-09-15T12:34' } });
      expect(input).toHaveValue('2026-09-15T12:34');
      refreshing = true;
      try {
        if (trigger === 'window focus') {
          act(() => focusManager.setFocused(false));
          act(() => focusManager.setFocused(true));
        } else await user.click(screen.getByRole('button', { name: '활동 상세 다시 확인' }));
        await waitFor(() => expect(callsFor(request, '/details')).toHaveLength(2));
        expect(callsFor(request, '/context')).toHaveLength(2);
        expect(
          screen.queryByRole('region', { name: '원본 관측 워크벤치' }),
        ).not.toBeInTheDocument();
        expect(input).toBeInTheDocument();
        expect(input).not.toBeVisible();
        await act(async () => {
          details.resolve(reply(observations));
        });
        expect(input).not.toBeVisible();
        await act(async () => {
          summary.resolve(context());
        });
        expect(await screen.findByRole('region', { name: '원본 관측 워크벤치' })).toBeVisible();
        expect(screen.getByRole('button', { name: '관측 0 선택' })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        expect(screen.getByLabelText('구간 시작 (UTC)')).toBe(input);
        expect(input).toHaveValue('2026-09-15T12:34');
      } finally {
        focusManager.setFocused(undefined);
      }
    },
  );

  it.each([404, 503])(
    'handles a failed cached pair (%s) and resets selection for a different revision',
    async (status) => {
      const user = userEvent.setup();
      const observations: ActivityDetailsRead = {
        ...read(),
        details: {
          schemaVersion: 1,
          streamIndex: 0,
          sessionIndex: 0,
          startedAt: null,
          recordedAt: null,
          elapsedSeconds: null,
          records: [{ index: 0, timestamp: null, distanceMeters: 0, heartRateBpm: null }],
          laps: [],
        },
      };
      let phase: 'initial' | 'failed' | 'changed' = 'initial';
      setup(async (input) =>
        input.path.endsWith('/context')
          ? context(phase === 'changed' ? { ...activity, revision: 2 } : activity)
          : phase === 'failed'
            ? reply({ error: { code: status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE' } }, status)
            : reply({ ...observations, activityRevision: phase === 'changed' ? 2 : 1 }),
      );
      await screen.findByRole('region', { name: '원본 관측 워크벤치' });
      await user.click(screen.getByRole('button', { name: '관측 0 선택' }));
      const input = screen.getByLabelText('구간 시작 (UTC)');
      fireEvent.change(input, { target: { value: '2026-09-15T12:34' } });
      phase = 'failed';
      await user.click(screen.getByRole('button', { name: '활동 상세 다시 확인' }));
      expect(await within(detailSection()).findByRole('alert')).toHaveTextContent(
        status === 404 ? '삭제되었거나 접근할 수 없습니다' : '최신 확인 실패',
      );
      if (status === 404) expect(input).not.toBeInTheDocument();
      else {
        expect(input).toBeInTheDocument();
        expect(input).not.toBeVisible();
      }
      expect(screen.queryByRole('button', { name: '관측 0 선택' })).not.toBeInTheDocument();
      phase = 'changed';
      await user.click(screen.getByRole('button', { name: '요약과 세부 기록 다시 확인' }));
      expect(await screen.findByRole('region', { name: '원본 관측 워크벤치' })).toBeVisible();
      expect(screen.getByRole('button', { name: '관측 0 선택' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(screen.getByLabelText('구간 시작 (UTC)')).toHaveValue('');
      expect(input).not.toBeInTheDocument();
    },
  );

  it.each([404, 409])(
    'never combines cached observations after deletion returns %s',
    async (status) => {
      const user = userEvent.setup();
      let deleted = false;
      const observations: ActivityDetailsRead = {
        ...read(),
        details: {
          schemaVersion: 1,
          streamIndex: 0,
          sessionIndex: 0,
          startedAt: null,
          recordedAt: null,
          elapsedSeconds: null,
          records: [{ index: 0, timestamp: null, distanceMeters: 0, heartRateBpm: null }],
          laps: [],
        },
      };
      const { request } = setup(async (input) => {
        if (input.method === 'DELETE') {
          deleted = true;
          return reply(
            { error: { code: status === 404 ? 'NOT_FOUND' : 'REVISION_CONFLICT' } },
            status,
          );
        }
        if (input.path.endsWith('/details')) return reply(observations);
        return deleted
          ? status === 404
            ? reply({ error: { code: 'NOT_FOUND' } }, 404)
            : context({ ...activity, revision: 2 })
          : context();
      });
      expect(await screen.findByRole('region', { name: '원본 관측 워크벤치' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '이 활동 삭제 확인' })).toBeEnabled(),
      );
      await user.click(screen.getByRole('button', { name: '이 활동 삭제 확인' }));
      await waitFor(() =>
        expect(
          screen.queryByRole('region', { name: '원본 관측 워크벤치' }),
        ).not.toBeInTheDocument(),
      );
      if (status === 409)
        expect(await within(detailSection()).findByRole('alert')).toHaveTextContent(
          '버전이 다릅니다',
        );
      else
        expect(
          await within(screen.getByRole('region', { name: '선택한 활동 상세' })).findByRole(
            'alert',
          ),
        ).toHaveTextContent('삭제되었거나 접근할 수 없습니다');
      expect(callsFor(request, '/details')).toHaveLength(1);
      expect(callsFor(request, '/context')).toHaveLength(2);
      expect(request.mock.calls.filter(([input]) => input.method === 'DELETE')).toHaveLength(1);
    },
  );

  it.each(['selection', 'account'] as const)(
    'cancels late responses across a changed %s',
    async (boundary) => {
      const pending = deferred();
      const { request, props, rerender } = setup((input) => {
        if (input.path.endsWith('/context'))
          return Promise.resolve(context(input.path.includes(other.id) ? other : activity));
        return input.path.includes(other.id)
          ? Promise.resolve(reply(read(other)))
          : pending.promise;
      });
      await screen.findByRole('region', { name: '활동 요약 출처' });
      const first = callsFor(request, '/details')[0]?.[0];
      expect(first?.signal?.aborted).toBe(false);
      rerender(
        <ActivityBrowser
          {...props}
          search={`selected=${other.id}&detailTab=intervals`}
          {...(boundary === 'account' ? { athleteId: 'bob', sessionId: 'session-b' } : {})}
        />,
      );
      await waitFor(() =>
        expect(screen.getByRole('region', { name: '활동 요약 출처' })).toHaveTextContent(
          '다음 활동',
        ),
      );
      expect(await screen.findByText(emptyDetail)).toBeVisible();
      expect(first?.signal?.aborted).toBe(true);
      await act(async () => {
        pending.resolve(reply({ ...read(), activityRevision: 99 }));
      });
      expect(screen.getByRole('region', { name: '활동 요약 출처' })).toHaveTextContent('다음 활동');
      expect(within(detailSection()).queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText(emptyDetail)).toBeVisible();
      expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    },
  );
});
