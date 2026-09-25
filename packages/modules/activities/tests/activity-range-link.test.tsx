import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ActivityRecord } from '@workout/contracts/activity-details';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type {
  MapAdapterFactory,
  MapAdapterHandle,
  MapAdapterOptions,
} from '@workout/geo-kit/map-adapter';
import type { MapPathFeatureCollection } from '@workout/geo-kit/map-path';
import { ActivityTrackPanel } from '../src/activity-track-panel';
import { DetailChart } from '../src/detail-chart';
import { nearestChartPoint } from '../src/detail-projection';
import type { DetailSelectionStore } from '../src/detail-selection';
import {
  DetailSelectionProvider,
  useSharedDetailSelectionStore,
} from '../src/detail-selection-provider';
import { renderedHighlightSamples } from '../src/stored-track-geometry';
import {
  activityId,
  instant,
  storedDetails,
  storedMapPath,
  storedRevision,
  storedTrack,
} from './stored-track-fixtures';

/**
 * S09-range-link, V2-F13, V2-A18 (M2-01k-n): a range dragged on the chart is the shared
 * selection, the map draws exactly that range's samples without bridging a GPS gap, the lap
 * table marks the laps it overlaps, and nothing is sent to the server.
 */

/** The chart's SVG is 700 units wide; with a 700px box one CSS pixel is one unit. */
function layOutCharts() {
  for (const svg of document.querySelectorAll('svg'))
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 700, height: 190, right: 700, bottom: 190 }) as DOMRect;
}
/** The x a point is drawn at, read from the chart itself. */
function xOf(container: HTMLElement, index: number): number {
  const [circle] = within(container).getAllByRole('button', { name: `차트 관측 ${index} 선택` });
  if (!circle) throw new Error(`no chart point ${index}`);
  return Number(circle.getAttribute('cx'));
}
function drag(svg: Element, from: number, to: number) {
  fireEvent.pointerDown(svg, {
    clientX: from,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
  });
  const steps = 6;
  for (let step = 1; step <= steps; step += 1)
    fireEvent.pointerMove(svg, {
      clientX: from + ((to - from) * step) / steps,
      pointerId: 1,
      buttons: 1,
    });
  fireEvent.pointerUp(svg, { clientX: to, pointerId: 1 });
}

const records: ActivityRecord[] = storedDetails().records;

describe('the chart range drag', () => {
  it('snaps both ends to drawn observations and reports the range once per change', () => {
    const onSelect = vi.fn();
    const onSelectRange = vi.fn();
    const { container } = render(
      <DetailChart
        records={records}
        metric="heartRateBpm"
        selected={null}
        range={null}
        onSelect={onSelect}
        onSelectRange={onSelectRange}
      />,
    );
    layOutCharts();
    const svg = screen.getByRole('img', { name: '원본 심박 (bpm) 차트' });
    // A little off each point still snaps to it.
    drag(svg, xOf(container, 1) + 20, xOf(container, 3) - 20);
    expect(onSelectRange).toHaveBeenLastCalledWith({ start: instant(10), end: instant(30) });
    // Repeated moves over the same snapped range do not write it again.
    const distinct = new Set(onSelectRange.mock.calls.map(([range]) => JSON.stringify(range)));
    expect(distinct.size).toBe(onSelectRange.mock.calls.length);
    expect(onSelect).not.toHaveBeenCalled();

    // Right to left is the same range.
    onSelectRange.mockClear();
    drag(svg, xOf(container, 3), xOf(container, 1));
    expect(onSelectRange).toHaveBeenLastCalledWith({ start: instant(10), end: instant(30) });
  });

  it('does not select anything on hover or on a press that does not travel', () => {
    const onSelect = vi.fn();
    const onSelectRange = vi.fn();
    const { container } = render(
      <DetailChart
        records={records}
        metric="distanceMeters"
        selected={null}
        range={null}
        onSelect={onSelect}
        onSelectRange={onSelectRange}
      />,
    );
    layOutCharts();
    const svg = screen.getByRole('img', { name: '원본 거리 (m) 차트' });
    for (let x = 0; x < 700; x += 35) fireEvent.pointerMove(svg, { clientX: x, pointerId: 1 });
    const x2 = xOf(container, 2);
    // Below the 6 px mouse activation distance a press is still a click, not a drag.
    fireEvent.pointerDown(svg, {
      clientX: x2,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
    });
    fireEvent.pointerMove(svg, { clientX: x2 + 5, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: x2 + 5, pointerId: 1 });
    expect(onSelectRange).not.toHaveBeenCalled();
    // …and the plain click on the point still selects that one observation.
    fireEvent.click(within(container).getByRole('button', { name: '차트 관측 2 선택' }));
    expect(onSelect).toHaveBeenCalledWith(2, instant(20));
  });

  it('extends from the chosen observation with Shift+click, and draws the range band', () => {
    const onSelectRange = vi.fn();
    const { container, rerender } = render(
      <DetailChart
        records={records}
        metric="distanceMeters"
        selected={1}
        range={{ start: instant(10), end: instant(10) }}
        onSelect={vi.fn()}
        onSelectRange={onSelectRange}
      />,
    );
    fireEvent.click(within(container).getByRole('button', { name: '차트 관측 4 선택' }), {
      shiftKey: true,
    });
    expect(onSelectRange).toHaveBeenCalledWith({ start: instant(10), end: instant(40) });
    expect(screen.queryByTestId('chart-range-band')).toBeNull();
    rerender(
      <DetailChart
        records={records}
        metric="distanceMeters"
        selected={null}
        range={{ start: instant(10), end: instant(40) }}
        onSelect={vi.fn()}
        onSelectRange={onSelectRange}
      />,
    );
    const band = screen.getByTestId('chart-range-band');
    expect(Number(band.getAttribute('x'))).toBeCloseTo(xOf(container, 1));
    expect(Number(band.getAttribute('x')) + Number(band.getAttribute('width'))).toBeCloseTo(
      xOf(container, 4),
    );
    expect(
      within(container)
        .getAllByRole('button', { name: /^차트 관측 \d 선택$/u })
        .filter((point) => point.getAttribute('data-in-range') === 'true')
        .map((point) => point.getAttribute('aria-label')),
    ).toEqual(['차트 관측 1 선택', '차트 관측 2 선택', '차트 관측 3 선택', '차트 관측 4 선택']);
  });

  it('snaps to the nearest instant with a deterministic tie-break', () => {
    const points = [
      { index: 0, time: 0, value: 1 },
      { index: 1, time: 10, value: 1 },
      { index: 2, time: 20, value: 1 },
    ];
    expect(nearestChartPoint(points, 14)?.index).toBe(1);
    expect(nearestChartPoint(points, 15)?.index).toBe(1);
    expect(nearestChartPoint(points, 16)?.index).toBe(2);
    expect(nearestChartPoint(points, Number.NaN)).toBeNull();
    expect(nearestChartPoint([], 3)).toBeNull();
  });
});

describe('rendered highlight evidence', () => {
  const highlight = {
    id: 'range',
    role: 'candidate' as const,
    revision: 'r1',
    positions: [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ] as const,
    breaks: [1],
    vertexKeys: ['0:1', '0:3', '0:4', '0:5'],
  };
  it('resolves each drawn piece through its own revision and marks others stale', () => {
    expect(
      renderedHighlightSamples(highlight, 'range', [
        { pathId: 'range', revision: 'r1', startIndex: 1 },
        { pathId: 'range', revision: 'r1', startIndex: 0 },
        { pathId: 'range', revision: 'r1', startIndex: 0 },
        { pathId: 'track', revision: 'r1', startIndex: 0 },
      ]),
    ).toEqual([['0:1'], ['0:3', '0:4', '0:5']]);
    expect(
      renderedHighlightSamples(highlight, 'range', [
        { pathId: 'range', revision: 'r0', startIndex: 0 },
      ]),
    ).toEqual(['stale']);
    expect(
      renderedHighlightSamples(null, 'range', [{ pathId: 'range', revision: 'r1', startIndex: 0 }]),
    ).toEqual(['stale']);
  });
});

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

function adapterProbe() {
  let options: MapAdapterOptions | null = null;
  const handed: MapPathFeatureCollection[] = [];
  const factory: MapAdapterFactory = (next) => {
    options = next;
    next.onReady();
    const handle: MapAdapterHandle = {
      setPaths: (collection) => void handed.push(collection),
      setSelection: () => undefined,
      fitBounds: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    };
    return Promise.resolve(handle);
  };
  return { factory, options: () => options, last: () => handed.at(-1) ?? null };
}

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
        <StoreProbe onStore={(value) => void (store = value)} />
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

const panel = () => screen.getByRole('region', { name: '저장된 경로' });
const lapRows = () =>
  within(within(panel()).getByRole('table', { name: '경로 랩 표' }))
    .getAllByRole('row')
    .slice(1);
const highlightedLaps = () =>
  lapRows()
    .filter((row) => row.getAttribute('data-in-range') === 'true')
    .map((row) => within(row).getByRole('button').textContent);
/** The "선택 구간" cell of every lap row, in row order: the overlap in words, not colour. */
const lapOverlapText = () =>
  lapRows().map((row) => within(row).getAllByRole('cell')[1]?.textContent);
/** The range path handed to the renderer, as sample runs, from the features themselves. */
function handedRange(collection: MapPathFeatureCollection | null) {
  return (collection?.features ?? [])
    .filter((feature) => feature.properties.pathId === 'stored-track-range')
    .map((feature) => ({
      type: feature.geometry.type,
      startIndex: feature.properties.startIndex,
      revision: feature.properties.revision,
    }));
}

describe('the route tab links a chart range to the map and the lap table', () => {
  let width = 0;
  beforeEach(() => {
    width = window.innerWidth;
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  });
  const at = (value: number) =>
    Object.defineProperty(window, 'innerWidth', { value, configurable: true });

  it('highlights the same range on the map and in the lap table, across a GPS gap', async () => {
    at(1440);
    const { request, probe, shared } = setup();
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await within(panel()).findAllByRole('img', { name: '원본 심박 (bpm) 차트' });
    await waitFor(() => expect(probe.last()).not.toBeNull());
    expect(screen.getByTestId('stored-track-panes')).toHaveAttribute('data-layout', 'desktop');
    const loads = request.mock.calls.length;
    layOutCharts();
    const chart = within(panel()).getByRole('group', { name: '저장된 경로 관측 그래프' });
    const [svg] = within(chart).getAllByRole('img', { name: '원본 심박 (bpm) 차트' });
    if (!svg) throw new Error('no chart');
    expect(highlightedLaps()).toEqual([]);
    expect(lapOverlapText()).toEqual(['—', '—']);

    // 30 s – 40 s: samples 0:3 and 0:4, one drawn run; lap 1 only.
    act(() => drag(svg, xOf(chart, 3), xOf(chart, 4)));
    expect(shared().getState().range).toEqual({ start: instant(30), end: instant(40) });
    expect(shared().getState().recordIndex).toBeNull();
    expect(screen.getByTestId('route-range')).toHaveTextContent('관측 2개');
    expect(highlightedLaps()).toEqual(['랩 1 선택']);
    expect(lapOverlapText()).toEqual(['—', '겹침']);
    await waitFor(() =>
      expect(handedRange(probe.last()).map(({ type, startIndex }) => [type, startIndex])).toEqual([
        ['LineString', 0],
      ]),
    );

    // 10 s – 30 s crosses the fix-less sample 0:2: two pieces, never one joined line.
    act(() => drag(svg, xOf(chart, 1), xOf(chart, 3)));
    expect(shared().getState().range).toEqual({ start: instant(10), end: instant(30) });
    expect(highlightedLaps()).toEqual(['랩 0 선택', '랩 1 선택']);
    expect(lapOverlapText()).toEqual(['겹침', '겹침']);
    await waitFor(() =>
      expect(handedRange(probe.last()).map(({ type, startIndex }) => [type, startIndex])).toEqual([
        ['Point', 0],
        ['Point', 1],
      ]),
    );
    await waitFor(() =>
      expect(within(panel()).getByText(/선택한 구간의 표본 2개를 지도에서 강조했습니다/)),
    );

    // What the renderer reports drawing is shown against the current highlight only.
    const [range] = handedRange(probe.last());
    act(() =>
      probe.options()?.onIdle?.({
        renderedPathFeatures: 3,
        renderedLineFeatures: 2,
        renderedPointFeatures: 2,
        pathFeatures: 4,
        expected: { line: true, point: true },
        renderedPieces: [
          { pathId: 'stored-track', revision: 'x', startIndex: 0, kind: 'line' },
          {
            pathId: 'stored-track-range',
            revision: range?.revision ?? '',
            startIndex: 1,
            kind: 'point',
          },
          {
            pathId: 'stored-track-range',
            revision: range?.revision ?? '',
            startIndex: 0,
            kind: 'point',
          },
        ],
      }),
    );
    const mapPane = within(panel()).getByRole('group', { name: '저장된 경로 지도' });
    expect(mapPane).toHaveAttribute('data-rendered-highlight', '0:1|0:3');

    // The range is client state only: not one request while it moved.
    expect(request.mock.calls.slice(loads)).toEqual([]);

    // Choosing a lap replaces the range with the lap, in the same store.
    await userEvent.setup().click(within(panel()).getByRole('button', { name: '랩 0 선택' }));
    expect(shared().getState().lapIndex).toBe(0);
    expect(screen.getByTestId('route-range')).toHaveTextContent('선택 구간 없음');
    expect(request.mock.calls.slice(loads)).toEqual([]);
  });

  it('keeps a range chosen in the tablet graph view for the map view', async () => {
    at(1000);
    const { probe, shared } = setup();
    const tabs = await screen.findByRole('tablist', { name: '저장된 경로 보기' });
    expect(screen.getByTestId('stored-track-panes')).toHaveAttribute('data-layout', 'tablet');
    await userEvent.setup().click(within(tabs).getByRole('tab', { name: '그래프' }));
    const chart = within(panel()).getByRole('tabpanel', { name: '그래프' });
    const [svg] = await within(chart).findAllByRole('img', { name: '원본 거리 (m) 차트' });
    if (!svg) throw new Error('no chart');
    layOutCharts();
    act(() => drag(svg, xOf(chart, 3), xOf(chart, 4)));
    expect(highlightedLaps()).toEqual(['랩 1 선택']);
    await userEvent.setup().click(within(tabs).getByRole('tab', { name: '지도' }));
    expect(shared().getState().range).toEqual({ start: instant(30), end: instant(40) });
    await waitFor(() =>
      expect(handedRange(probe.last()).map(({ type }) => type)).toEqual(['LineString']),
    );
  });
});
