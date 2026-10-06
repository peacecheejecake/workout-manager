import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import type { CompetitionWorkspaceProps } from '../src/competition-workspace';
import { CompetitionHost } from '../src/competition-host';
const workspace = vi.hoisted(() => vi.fn<(props: CompetitionWorkspaceProps) => void>());
vi.mock('../src/competition-workspace', () => ({
  CompetitionWorkspace: (props: CompetitionWorkspaceProps) => {
    workspace(props);
    return (
      <section aria-label="기존 대회 화면">
        <p>저장된 연결</p>
        {props.relations?.plans?.map((p) => (
          <p key={p.id}>{p.label}</p>
        ))}
        {props.relations?.courses?.map((c) => (
          <p key={c.ref.revisionId}>{c.label}</p>
        ))}
        <button onClick={() => props.onSectionChange?.('results')}>결과 화면</button>
      </section>
    );
  },
}));
afterEach(() => {
  cleanup();
  workspace.mockClear();
});
const id = '10000000-0000-4000-8000-000000000001';
const at = '2026-10-01T00:00:00Z';
function reply(body: unknown, status = 200) {
  return transportReplySchema.parse({ status, body, traceId: null });
}
function empty(path: string) {
  return path.includes('/plans')
    ? reply({ head: null, history: [] })
    : path.includes('/courses')
      ? reply({ courses: [], total: 0 })
      : reply({ items: [], total: 0 });
}
it('starts all three reads independently and supplies named authenticated metadata', async () => {
  const signals: AbortSignal[] = [];
  const pending: (() => void)[] = [];
  const request = vi.fn<AuthenticatedTransport['request']>(
    (input) =>
      new Promise((resolve) => {
        if (!input.signal) throw new Error('MISSING_ABORT_SIGNAL');
        signals.push(input.signal);
        pending.push(() =>
          resolve(
            input.path.includes('/plans')
              ? reply({
                  head: null,
                  history: [{ id, version: 2, createdAt: at, title: '가을 계획' }],
                })
              : empty(input.path),
          ),
        );
      }),
  );
  const onSectionChange = vi.fn();
  render(
    <CompetitionHost
      athleteId="alice"
      sessionId="session-a"
      transport={{ request }}
      section="events"
      onSectionChange={onSectionChange}
    />,
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  await act(async () => {
    pending.forEach((resolve) => resolve());
  });
  expect(await screen.findByText('가을 계획 · 계획 v2')).toBeVisible();
  expect(screen.queryByText(id)).not.toBeInTheDocument();
  expect(screen.getByText(/최근 계획 최대 100개/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '결과 화면' }));
  expect(onSectionChange).toHaveBeenCalledWith('results');
});
it('localizes failure, preserves unavailable choices and retries only that catalog', async () => {
  let failed = true;
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    input.path.includes('/courses') && failed
      ? reply({ secret: 'private failure' }, 503)
      : empty(input.path),
  );
  render(<CompetitionHost athleteId="alice" sessionId="a" transport={{ request }} />);
  expect(
    await screen.findByText('코스 목록을 불러오지 못했습니다. 저장된 연결은 유지됩니다.'),
  ).toBeVisible();
  expect(screen.getByText('저장된 연결')).toBeVisible();
  const props = workspace.mock.lastCall?.[0];
  expect(props?.relations?.courses).toBeUndefined();
  expect(props?.relations?.plans).toEqual([]);
  expect(screen.queryByText('private failure')).not.toBeInTheDocument();
  failed = false;
  await userEvent.click(screen.getByRole('button', { name: '코스 목록 다시 시도' }));
  await waitFor(() =>
    expect(screen.queryByText(/코스 목록을 불러오지 못했습니다/)).not.toBeInTheDocument(),
  );
  expect(request.mock.calls.filter(([input]) => input.path.includes('/courses'))).toHaveLength(2);
  expect(request.mock.calls.filter(([input]) => input.path.includes('/plans'))).toHaveLength(1);
});
it.each(['account', 'session'] as const)(
  'aborts and clears relation data on %s switch, ignoring late old replies',
  async (mode) => {
    const oldSignals: AbortSignal[] = [];
    const oldResolvers: (() => void)[] = [];
    const oldRequest = vi.fn<AuthenticatedTransport['request']>(
      (input) =>
        new Promise((resolve) => {
          if (!input.signal) throw new Error('MISSING_ABORT_SIGNAL');
          oldSignals.push(input.signal);
          oldResolvers.push(() =>
            resolve(
              input.path.includes('/plans')
                ? reply({
                    head: null,
                    history: [{ id, version: 1, createdAt: at, title: 'Alice 비공개 계획' }],
                  })
                : empty(input.path),
            ),
          );
        }),
    );
    const mounted = render(
      <CompetitionHost athleteId="alice" sessionId="a" transport={{ request: oldRequest }} />,
    );
    await waitFor(() => expect(oldRequest).toHaveBeenCalledTimes(3));
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) => empty(input.path));
    mounted.rerender(
      <CompetitionHost
        athleteId={mode === 'account' ? 'bob' : 'alice'}
        sessionId="b"
        transport={{ request }}
      />,
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      oldResolvers.forEach((resolve) => resolve());
    });
    expect(screen.queryByText(/Alice 비공개/)).not.toBeInTheDocument();
  },
);
it('does not issue authenticated reads when logged out and cancels pending reads on logout', async () => {
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) => empty(input.path));
  const mounted = render(
    <CompetitionHost athleteId={null} sessionId="a" transport={{ request }} />,
  );
  expect(request).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('로그인 후');
  const signals: AbortSignal[] = [];
  const pending = vi.fn<AuthenticatedTransport['request']>((input) => {
    if (!input.signal) throw new Error('MISSING_ABORT_SIGNAL');
    signals.push(input.signal);
    return new Promise(() => {});
  });
  mounted.rerender(
    <CompetitionHost athleteId="alice" sessionId="a" transport={{ request: pending }} />,
  );
  await waitFor(() => expect(pending).toHaveBeenCalledTimes(3));
  mounted.rerender(
    <CompetitionHost athleteId={null} sessionId="a" transport={{ request: pending }} />,
  );
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(screen.queryByRole('region', { name: '기존 대회 화면' })).not.toBeInTheDocument();
});
it('reports the bounded Activity page rather than claiming a complete catalog', async () => {
  const values = {
    title: null,
    kind: 'running',
    startedAt: null,
    durationSeconds: null,
    durationKind: 'unknown',
    timezone: null,
    distanceMeters: null,
  };
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    revision: 1,
    source: {
      kind: 'manual',
      sourceId: `synthetic-${index}`,
      revision: 1,
      contentHash: 'a'.repeat(64),
    },
    original: values,
    effective: values,
    overlay: {},
  }));
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    input.path.includes('/activities') ? reply({ items, total: 125 }) : empty(input.path),
  );
  render(<CompetitionHost athleteId="alice" sessionId="a" transport={{ request }} />);
  expect(await screen.findByText('실제 활동 125개 중 최근 100개를 표시합니다.')).toBeVisible();
  expect(workspace.mock.lastCall?.[0].relations?.activities).toHaveLength(100);
});
it('treats malformed DTO as localized unavailable, retaining other successful catalogs', async () => {
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    input.path.includes('/activities')
      ? reply({ items: [], total: 0, healthBody: 'private' })
      : empty(input.path),
  );
  render(<CompetitionHost athleteId="alice" sessionId="a" transport={{ request }} />);
  expect(
    await screen.findByText('실제 활동 목록을 불러오지 못했습니다. 저장된 연결은 유지됩니다.'),
  ).toBeVisible();
  expect(workspace.mock.lastCall?.[0].relations?.activities).toBeUndefined();
  expect(workspace.mock.lastCall?.[0].relations?.courses).toEqual([]);
});
