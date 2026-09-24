import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type {
  MapAdapterFactory,
  MapAdapterHandle,
  MapAdapterOptions,
} from '@workout/geo-kit/map-adapter';
import { ActivityTrackPanel } from '../src/activity-track-panel';
import { ActivityWorkbench } from '../src/activity-workbench';
import type { DetailSelectionStore } from '../src/detail-selection';
import {
  DetailSelectionProvider,
  useSharedDetailSelectionStore,
} from '../src/detail-selection-provider';
import {
  activityId,
  sourceId,
  storedDetails,
  storedMapPath,
  storedRevision,
  storedTrack,
} from './stored-track-fixtures';

/**
 * S09-cursor-store (01_product_screen_spec §7.2): "커서 상태는 shared selection store에만 두고
 * 매 움직임을 전역 서버 상태로 저장하지 않는다". Every way the cursor moves — the observation
 * table, stepping, the chart, the map, the sample buttons — is checked against the one store
 * the provider owns, and every pointer movement over the views is checked to send nothing.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
const values = {
  title: '커서 활동',
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
const read: ActivityDetailsRead = {
  activityId,
  activityRevision: 1,
  source: activity.source,
  details: storedDetails(),
};

function adapterProbe() {
  let options: MapAdapterOptions | null = null;
  const factory: MapAdapterFactory = (next) => {
    options = next;
    next.onReady();
    const handle: MapAdapterHandle = {
      setPaths: () => undefined,
      setSelection: () => undefined,
      fitBounds: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    };
    return Promise.resolve(handle);
  };
  return { factory, options: () => options };
}

/** Reads the provider's store from inside the tree, as any other view below it would. */
function StoreProbe({ onStore }: { onStore: (store: DetailSelectionStore | null) => void }) {
  onStore(useSharedDetailSelectionStore());
  return null;
}

function setup() {
  const request = vi.fn((input: TransportRequest) => {
    if (input.path.endsWith('/track'))
      return Promise.resolve(reply({ status: 'available', track: storedRevision() }));
    if (input.path.endsWith('variant=normalized')) return Promise.resolve(reply(storedTrack()));
    return Promise.resolve(reply(storedMapPath()));
  });
  const probe = adapterProbe();
  let store: DetailSelectionStore | null = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DetailSelectionProvider identity="activity-1">
        <StoreProbe
          onStore={(value) => {
            store = value;
          }}
        />
        <ActivityWorkbench activity={activity} read={read} />
        <ActivityTrackPanel
          athleteId="alice"
          sessionId="session-a"
          transport={{ request }}
          activityId={activityId}
          activitySourceRevision={1}
          details={storedDetails()}
          scope={['users', 'alice', 'sessions', 'session-a']}
          basemap={null}
          createMapAdapter={probe.factory}
        />
      </DetailSelectionProvider>
    </QueryClientProvider>,
  );
  const shared = () => {
    if (!store) throw new Error('no shared store');
    return store;
  };
  return { request, probe, shared };
}

const workbench = () => screen.getByRole('region', { name: '원본 관측 워크벤치' });
const routeStatus = () =>
  within(screen.getByRole('region', { name: '저장된 경로' })).getByText(/선택(한 지점| 표본)/);
const observation = () => within(workbench()).getByRole('region', { name: '관측 선택 요약' });

/** Every pointer movement a hovering cursor produces, over one element. */
function hover(element: Element) {
  fireEvent.pointerOver(element);
  fireEvent.pointerEnter(element);
  fireEvent.mouseOver(element);
  fireEvent.mouseEnter(element);
  for (let step = 0; step < 5; step += 1) {
    fireEvent.pointerMove(element, { clientX: step * 7, clientY: step * 3 });
    fireEvent.mouseMove(element, { clientX: step * 7, clientY: step * 3 });
  }
  fireEvent.pointerOut(element);
  fireEvent.pointerLeave(element);
  fireEvent.mouseOut(element);
  fireEvent.mouseLeave(element);
}

describe('the S09 cursor lives in the shared selection store', () => {
  // The S09 panes mount when they are first shown (M2-01k-d). At desktop width the route
  // screen is the linked split-pane, so the map, the graph and the sample list are all on
  // screen together, as a user sees them there. jsdom's default width is a tablet's, where
  // the graph is behind its own tab.
  let width = 0;
  beforeEach(() => {
    width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  });

  it('moves through one store from every view and never reaches the server', async () => {
    const user = userEvent.setup();
    const { request, probe, shared } = setup();
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    expect(screen.getByTestId('stored-track-panes')).toHaveAttribute('data-layout', 'desktop');
    await within(workbench()).findAllByRole('button', { name: /^차트 관측 \d 선택$/u });
    await waitFor(() => expect(probe.options()).not.toBeNull());
    const loads = request.mock.calls.length;

    // Hovering over the chart, the tables, the map and the sample list sends nothing. (This
    // product moves the cursor by pick, step and keyboard; hover alone selects nothing.)
    const surfaces = [
      ...within(workbench()).getAllByRole('button', { name: /^차트 관측 \d 선택$/u }),
      ...within(workbench()).getAllByRole('row'),
      screen.getByRole('region', { name: '저장된 활동 경로' }),
      ...within(screen.getByRole('region', { name: '저장된 경로' })).getAllByRole('button'),
    ];
    expect(surfaces.length).toBeGreaterThan(10);
    for (const surface of surfaces) hover(surface);
    expect(request.mock.calls.slice(loads)).toEqual([]);

    // The observation table writes the cursor to the shared store, and the map follows.
    await user.click(within(workbench()).getByRole('button', { name: '관측 1 선택' }));
    expect(shared().getState().recordIndex).toBe(1);
    await waitFor(() => expect(routeStatus()).toHaveTextContent('선택 표본 0:1'));

    // Stepping moves the same cursor, one observation at a time.
    await user.click(within(workbench()).getByRole('button', { name: '다음 관측 선택' }));
    expect(shared().getState().recordIndex).toBe(2);
    await user.click(within(workbench()).getByRole('button', { name: '다음 관측 선택' }));
    expect(shared().getState().recordIndex).toBe(3);
    await waitFor(() => expect(routeStatus()).toHaveTextContent('선택 표본 0:3'));

    // A chart point in the route pane: the workbench follows the store.
    const [chartPoint] = within(screen.getByRole('region', { name: '저장된 경로' })).getAllByRole(
      'button',
      { name: '차트 관측 0 선택' },
    );
    if (!chartPoint) throw new Error('no chart point in the route pane');
    act(() => void fireEvent.click(chartPoint));
    expect(shared().getState().recordIndex).toBe(0);
    await waitFor(() => expect(observation()).toHaveTextContent('선택한 관측 0'));

    // A map pick: the picked sample is in the store and both views show it.
    act(() => probe.options()?.onPick([127.024, 37.504]));
    await waitFor(() =>
      expect(shared().getState().sample).toEqual({
        trackRevision: expect.any(String),
        sampleId: '0:4',
      }),
    );
    expect(shared().getState().recordIndex).toBe(4);
    await waitFor(() => expect(observation()).toHaveTextContent('선택한 관측 4'));

    // The sample buttons go through the same store.
    await user.click(
      within(screen.getByRole('region', { name: '저장된 경로' })).getByRole('button', {
        name: '시작 지점',
      }),
    );
    expect(shared().getState().sample?.sampleId).toBe('0:0');
    await waitFor(() => expect(observation()).toHaveTextContent('선택한 관측 0'));

    // Hovering again, with a cursor set, still sends nothing and leaves both views on the
    // store's cursor.
    for (const surface of surfaces) if (surface.isConnected) hover(surface);
    expect(routeStatus()).toHaveTextContent(`선택 표본 ${shared().getState().sample?.sampleId}`);
    expect(observation()).toHaveTextContent(`선택한 관측 ${shared().getState().recordIndex}`);

    // No request of any kind — no write, and no re-read — while the cursor moved.
    expect(request.mock.calls.slice(loads)).toEqual([]);
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
});
