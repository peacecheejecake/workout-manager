import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Activity } from '@workout/contracts/activity';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { ActivityBrowser, type ActivityBrowserProps } from '../src/activity-browser';
import {
  activityId,
  sourceId,
  storedDetails,
  storedMapPath,
  storedRevision,
  storedTrack,
} from './stored-track-fixtures';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
const values = {
  title: '저장된 경로 활동',
  kind: 'running' as const,
  startedAt: null,
  timezone: null,
  durationSeconds: 40,
  durationKind: 'timer' as const,
  distanceMeters: 250,
};
const activity: Activity = {
  id: activityId,
  revision: 1,
  source: { kind: 'fit', sourceId, revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
};

function handler(input: TransportRequest): Reply {
  const path = input.path;
  if (path === '/bff/v1/plans/current') return reply({ head: null, history: [] });
  if (path.endsWith('/track')) return reply({ status: 'available', track: storedRevision() });
  if (path.includes('variant=normalized')) return reply(storedTrack());
  if (path.includes('variant=map_path')) return reply(storedMapPath());
  if (path.endsWith('/context'))
    return reply({
      definitionVersion: 'activity-context-v1',
      observedAt: '2026-09-16T00:00:00Z',
      activity,
      activityDataRevision: { count: 1, revisionSum: '1' },
      planContext: { status: 'unlinked' },
    });
  if (path.endsWith('/details'))
    return reply({
      activityId: activity.id,
      activityRevision: activity.revision,
      source: activity.source,
      details: storedDetails(),
    });
  if (path.includes('?')) return reply({ items: [], total: 0 });
  return reply({}, 404);
}

function props(overrides: Partial<ActivityBrowserProps> = {}): ActivityBrowserProps {
  return {
    athleteId: 'alice',
    sessionId: 'session-a',
    transport: { request: vi.fn(handler) as unknown as AuthenticatedTransport['request'] },
    search: `selected=${activityId}&detailTab=route`,
    onSearchChange: vi.fn(),
    initialTimezone: 'Asia/Seoul',
    importHref: '/activities/import',
    ...overrides,
  };
}

describe('route tab wiring in the activity browser', () => {
  // The route tab lazy-loads the track panel. Its first import in a worker compiles the panel
  // and its dependencies (≈185 ms at load 8), and the first test's findBy window is 1 s, so
  // on a loaded machine that window ran out while the compiler, not the screen, was working.
  // Loading the module here keeps the lazy boundary (React still awaits the same import)
  // but takes compile time out of what the assertions wait for.
  beforeAll(async () => {
    await import('../src/activity-track-panel');
  });
  it('reaches the stored track through the route tab and scopes its cache to the athlete', async () => {
    const request = vi.fn((input: TransportRequest) => Promise.resolve(handler(input)));
    const view = render(<ActivityBrowser {...props({ transport: { request } })} />);
    expect(await screen.findByRole('region', { name: '저장된 경로' })).toBeVisible();
    expect(await screen.findByText('전체 5개 · 위치 있음 4개 · 구간 3개')).toBeVisible();
    expect(screen.getByRole('tab', { name: '경로', selected: true })).toBeEnabled();
    const trackCalls = () => request.mock.calls.filter(([input]) => input.path.endsWith('/track'));
    expect(trackCalls()).toHaveLength(1);

    // Account switch: the browser remounts on a new athlete, so the previous athlete's
    // cache is gone and the track is fetched again under the new scope.
    view.rerender(<ActivityBrowser {...props({ transport: { request }, athleteId: 'bob' })} />);
    await waitFor(() => expect(trackCalls().length).toBe(2));
    expect(
      request.mock.calls.every(([input]) => input.method === 'GET' && input.body === null),
    ).toBe(true);
  });

  it('never creates an object URL for stored geometry', async () => {
    const created = vi.fn();
    const original = URL.createObjectURL;
    Object.defineProperty(URL, 'createObjectURL', { value: created, configurable: true });
    try {
      render(<ActivityBrowser {...props()} />);
      expect(await screen.findByText('전체 5개 · 위치 있음 4개 · 구간 3개')).toBeVisible();
      expect(created).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(URL, 'createObjectURL', { value: original, configurable: true });
    }
  });

  it('drops a reply that arrives after the account changed', async () => {
    let release: ((value: Reply) => void) | null = null;
    const request = vi.fn((input: TransportRequest) =>
      input.path.endsWith('/track')
        ? new Promise<Reply>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(handler(input)),
    );
    const view = render(<ActivityBrowser {...props({ transport: { request } })} />);
    expect(await screen.findByText('저장된 경로를 확인하고 있습니다.')).toBeVisible();
    view.rerender(<ActivityBrowser {...props({ transport: { request }, athleteId: 'bob' })} />);
    // The previous athlete's in-flight reply now resolves. It must not paint anything:
    // its query client was cleared with the subtree it belonged to.
    await act(async () => {
      release?.(reply({ status: 'available', track: storedRevision() }));
    });
    expect(screen.queryByText('전체 5개 · 위치 있음 4개 · 구간 3개')).toBeNull();
  });

  it('does not mount the route panel on another tab', async () => {
    // The panel is a lazy leaf, so it must not be loaded — nor its map kit pulled in — for
    // a tab that does not show it. This does not exercise a chunk-load failure; the
    // boundary around it is asserted at the leaf level in `track-preview.test.tsx`.
    render(
      <ActivityBrowser {...props({ search: `selected=${activityId}&detailTab=intervals` })} />,
    );
    expect(await screen.findByRole('region', { name: '원본 관측 워크벤치' })).toBeVisible();
    expect(screen.queryByRole('region', { name: '저장된 경로' })).toBeNull();
  });

  it('keeps a sample selection that links to no observation across a tab round trip', async () => {
    // Observation 4 is removed, so sample `0:4` corresponds to nothing in the chart. That
    // selection must still survive leaving the route tab, which unmounts the map screen.
    const withoutLastRecord = (input: TransportRequest): Reply => {
      if (!input.path.endsWith('/details')) return handler(input);
      const details = storedDetails();
      return reply({
        activityId: activity.id,
        activityRevision: activity.revision,
        source: activity.source,
        details: { ...details, records: details.records.filter((record) => record.index !== 4) },
      });
    };
    const request = vi.fn((input: TransportRequest) => Promise.resolve(withoutLastRecord(input)));
    const intervals = `selected=${activityId}&detailTab=intervals`;
    const route = `selected=${activityId}&detailTab=route`;
    const view = render(<ActivityBrowser {...props({ transport: { request }, search: route })} />);
    await screen.findByRole('region', { name: '저장된 경로' });
    await userEvent.click(await screen.findByRole('button', { name: /^0:4 · /u }));
    await waitFor(() => expect(screen.getByText(/선택 표본 0:4/)).toBeInTheDocument());

    view.rerender(<ActivityBrowser {...props({ transport: { request }, search: intervals })} />);
    expect(await screen.findByRole('region', { name: '원본 관측 워크벤치' })).toBeVisible();
    expect(screen.queryByText(/선택 표본 0:4/)).toBeNull();
    view.rerender(<ActivityBrowser {...props({ transport: { request }, search: route })} />);
    expect(await screen.findByText(/선택 표본 0:4/)).toBeVisible();
  });

  it('carries one selection between the interval workbench and the stored-track map, both ways', async () => {
    const intervals = `selected=${activityId}&detailTab=intervals`;
    const route = `selected=${activityId}&detailTab=route`;
    const request = vi.fn((input: TransportRequest) => Promise.resolve(handler(input)));
    const view = render(
      <ActivityBrowser {...props({ transport: { request }, search: intervals })} />,
    );
    // Chart/record selection on the interval tab…
    await userEvent.click(await screen.findByRole('button', { name: '관측 4 선택' }));
    expect(screen.getByText(/선택한 관측 4/)).toBeVisible();

    // …resolves to the stored track's own sample on the route tab, through the shared store.
    view.rerender(<ActivityBrowser {...props({ transport: { request }, search: route })} />);
    expect(await screen.findByText(/선택 표본 0:4/)).toBeVisible();

    // And back: picking a different sample without the map selects its observation.
    await userEvent.click(screen.getByRole('button', { name: /^0:1 · /u }));
    await waitFor(() => expect(screen.getByText(/선택 표본 0:1/)).toBeInTheDocument());
    view.rerender(<ActivityBrowser {...props({ transport: { request }, search: intervals })} />);
    expect(await screen.findByText(/선택한 관측 1/)).toBeVisible();
  });
});
