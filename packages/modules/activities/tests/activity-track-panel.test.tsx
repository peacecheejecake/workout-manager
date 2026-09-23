import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { MapAdapterError } from '@workout/geo-kit/map-adapter';
import type {
  MapAdapterFactory,
  MapAdapterHandle,
  MapAdapterOptions,
} from '@workout/geo-kit/map-adapter';
import type { GeoPosition } from '@workout/geo-kit/map-path';
import { ActivityTrackPanel } from '../src/activity-track-panel';
import { ActivityWorkbench } from '../src/activity-workbench';
import { DetailSelectionProvider } from '../src/detail-selection-provider';
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
const scope = ['users', 'alice', 'sessions', 'session-a'] as const;

const activity: Activity = {
  id: activityId,
  revision: 1,
  source: { kind: 'fit', sourceId, revision: 1, contentHash: 'a'.repeat(64) },
  original: {
    title: '저장된 경로 활동',
    kind: 'running',
    startedAt: null,
    timezone: null,
    durationSeconds: 40,
    durationKind: 'timer',
    distanceMeters: 250,
  },
  effective: {
    title: '저장된 경로 활동',
    kind: 'running',
    startedAt: null,
    timezone: null,
    durationSeconds: 40,
    durationKind: 'timer',
    distanceMeters: 250,
  },
  overlay: {},
};
const detailsRead: ActivityDetailsRead = {
  activityId: activity.id,
  activityRevision: activity.revision,
  source: activity.source,
  details: storedDetails(),
};

interface AdapterProbe {
  readonly factory: MapAdapterFactory;
  readonly created: number[];
  readonly setPaths: unknown[];
  readonly setSelection: (GeoPosition | null)[];
  readonly fitBounds: unknown[];
  readonly destroyed: () => number;
  readonly options: () => MapAdapterOptions | null;
}

/**
 * A renderer stand-in. The real `MapView` runs above it, so this exercises the actual
 * kit boundary — one adapter per mount, `setSelection` for a selection, `fitBounds` only
 * when a fit is requested — instead of a mocked component.
 */
function adapterProbe(): AdapterProbe {
  const created: number[] = [];
  const setPaths: unknown[] = [];
  const setSelection: (GeoPosition | null)[] = [];
  const fitBounds: unknown[] = [];
  let destroyed = 0;
  let captured: MapAdapterOptions | null = null;
  const factory: MapAdapterFactory = (options) => {
    captured = options;
    created.push(created.length);
    options.onReady();
    const handle: MapAdapterHandle = {
      setPaths: (collection) => setPaths.push(collection),
      setSelection: (position) => setSelection.push(position),
      fitBounds: (bounds) => fitBounds.push(bounds),
      resize: () => undefined,
      destroy: () => {
        destroyed += 1;
      },
    };
    return Promise.resolve(handle);
  };
  return {
    factory,
    created,
    setPaths,
    setSelection,
    fitBounds,
    destroyed: () => destroyed,
    options: () => captured,
  };
}

function transportOf(handler: (input: TransportRequest) => Reply | Promise<Reply>) {
  const request = vi.fn((input: TransportRequest) => Promise.resolve(handler(input)));
  return { transport: { request } satisfies AuthenticatedTransport, request };
}

const available =
  (overrides: { sourceRevision?: number; trackRevision?: number; positioned?: number } = {}) =>
  (input: TransportRequest): Reply => {
    if (input.path.endsWith('/track'))
      return reply({
        status: 'available',
        track: storedRevision({
          ...(overrides.sourceRevision === undefined
            ? {}
            : { sourceRevision: overrides.sourceRevision }),
          ...(overrides.trackRevision === undefined
            ? {}
            : { trackRevision: overrides.trackRevision }),
          ...(overrides.positioned === undefined
            ? {}
            : { positionedSampleCount: overrides.positioned }),
        }),
      });
    if (input.path.endsWith('variant=normalized')) return reply(storedTrack(overrides));
    return reply(storedMapPath(overrides));
  };

function renderPanel(options: {
  handler: (input: TransportRequest) => Reply | Promise<Reply>;
  probe?: AdapterProbe;
  activitySourceRevision?: number;
  details?: ActivityDetailsRead['details'];
  withWorkbench?: boolean;
}) {
  const { transport, request } = transportOf(options.handler);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <DetailSelectionProvider identity="activity-1">
        {options.withWorkbench ? (
          <ActivityWorkbench activity={activity} read={detailsRead} />
        ) : null}
        <ActivityTrackPanel
          athleteId="alice"
          sessionId="session-a"
          transport={transport}
          activityId={activityId}
          activitySourceRevision={options.activitySourceRevision ?? 1}
          details={options.details === undefined ? storedDetails() : options.details}
          scope={scope}
          basemap={null}
          {...(options.probe ? { createMapAdapter: options.probe.factory } : {})}
        />
      </DetailSelectionProvider>
    </QueryClientProvider>,
  );
  return { ...view, request, client };
}

/** The chart points are SVG circles with a click handler, not real buttons. */
const fireEventClick = (element: Element) => act(() => void fireEvent.click(element));

const routePanel = () => screen.getByRole('region', { name: '저장된 경로' });
const selectionStatus = () => within(routePanel()).getByText(/선택(한 지점| 표본)/);

let innerWidth = 0;
beforeEach(() => {
  innerWidth = window.innerWidth;
});
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true });
});

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

describe('stored activity track panel states', () => {
  it('shows a loading state and then the stored revision identity', async () => {
    let release: ((value: Reply) => void) | null = null;
    renderPanel({
      handler: (input) =>
        input.path.endsWith('/track')
          ? new Promise<Reply>((resolve) => {
              release = resolve;
            })
          : available()(input),
    });
    expect(await screen.findByText('저장된 경로를 확인하고 있습니다.')).toBeVisible();
    await act(async () => {
      release?.(reply({ status: 'available', track: storedRevision() }));
    });
    expect(await screen.findByText('전체 5개 · 위치 있음 4개 · 구간 3개')).toBeVisible();
  });

  it('distinguishes a not-yet-stored activity from a failure', async () => {
    renderPanel({ handler: () => reply({ error: { code: 'ACTIVITY_TRACK_NOT_FOUND' } }, 404) });
    expect(await screen.findByText(/저장된 경로가 없습니다/)).toBeVisible();
    expect(screen.getByRole('button', { name: '경로 다시 조회' })).toBeEnabled();
  });

  it('keeps the screen usable when the metadata request fails and re-queries on request', async () => {
    let attempt = 0;
    const { request } = renderPanel({
      handler: (input) => {
        if (input.path.endsWith('/track')) {
          attempt += 1;
          return attempt === 1 ? reply({}, 503) : available()(input);
        }
        return available()(input);
      },
    });
    expect(await screen.findByText(/저장된 경로를 확인하지 못했습니다/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '경로 다시 조회' }));
    expect(await screen.findByText('전체 5개 · 위치 있음 4개 · 구간 3개')).toBeVisible();
    expect(request.mock.calls.filter(([input]) => input.path.endsWith('/track'))).toHaveLength(2);
  });

  it('marks a track built from an older source revision as stale without hiding it', async () => {
    renderPanel({ handler: available(), activitySourceRevision: 4 });
    expect(await screen.findByText(/이 경로는 원본 수정 1에서 만들어졌고/)).toBeVisible();
    expect(screen.getByText('전체 5개 · 위치 있음 4개 · 구간 3개')).toBeVisible();
  });

  it('reports a recording with no fix and still shows the summary', async () => {
    renderPanel({
      handler: (input) => {
        if (input.path.endsWith('/track'))
          return reply({
            status: 'available',
            track: storedRevision({ positionedSampleCount: 0 }),
          });
        if (input.path.endsWith('variant=normalized')) return reply(storedTrack());
        return reply({
          ...storedMapPath(),
          geometry: { type: 'MultiLineString', coordinates: [] },
          vertexSampleIds: [],
          lineSegmentIndices: [],
          points: [],
          insufficient: [{ segmentIndex: 0, reason: 'no-position', sampleIds: ['0:0'] }],
          displayedPolylineLengthMeters: null,
        });
      },
    });
    expect(await screen.findByText(/위치가 기록되지 않은 활동입니다/)).toBeVisible();
    expect(await screen.findByText(/그릴 좌표가 없습니다/)).toBeVisible();
    expect(screen.getByText('40초')).toBeVisible();
  });

  it('refuses a geometry object from another revision and says so', async () => {
    renderPanel({
      handler: (input) =>
        input.path.endsWith('/track')
          ? reply({ status: 'available', track: storedRevision() })
          : input.path.endsWith('variant=normalized')
            ? reply(storedTrack())
            : reply(storedMapPath({ trackRevision: 2 })),
    });
    expect(await screen.findByText(/STORED_TRACK_ARTIFACT_MISMATCH/)).toBeVisible();
  });

  it('names the partial recording: gaps and segments that could not be drawn', async () => {
    renderPanel({ handler: available() });
    expect(await screen.findByText(/위치 결손 2회/)).toBeVisible();
    expect(screen.getByText(/구간 1: 위치가 없어 표시하지 않았습니다/)).toBeVisible();
  });
});

describe('stored activity track renderer failures', () => {
  it('separates an unusable renderer from a background map that would not load', async () => {
    const probe = adapterProbe();
    renderPanel({ handler: available(), probe });
    expect(
      await screen.findByText(/경로를 그리는 중입니다|지도에 경로를 표시했습니다/),
    ).toBeVisible();
    act(() => probe.options()?.onFailure('CONTEXT_LOST'));
    expect(await screen.findByText(/지도 렌더러\(WebGL\)를 사용할 수 없습니다/)).toBeVisible();
    expect(screen.queryByText(/배경 지도를 불러오지 못했습니다/)).toBeNull();
    // Announced once, by the map's own status line (review N6).
    expect(
      screen.getAllByRole('status').filter((element) => /WebGL/.test(element.textContent ?? '')),
    ).toHaveLength(1);
  });

  it('reports a background map failure as its own state', async () => {
    const probe = adapterProbe();
    renderPanel({ handler: available(), probe });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    act(() => probe.options()?.onFailure('STYLE_LOAD_FAILED'));
    expect(await screen.findByText(/배경 지도를 불러오지 못했습니다/)).toBeVisible();
    expect(screen.queryByText(/WebGL/)).toBeNull();
  });

  it('classifies a rejected initialisation through the adapter error rather than a message guess', async () => {
    const failing: MapAdapterFactory = () =>
      Promise.reject(new MapAdapterError('STYLE_LOAD_FAILED', 'STYLE_LOAD_FAILED'));
    renderPanel({
      handler: available(),
      probe: { ...adapterProbe(), factory: failing },
    });
    expect(await screen.findByText(/배경 지도를 불러오지 못했습니다/)).toBeVisible();
    // The summary and the sample list are still usable with no renderer at all.
    expect(screen.getByText('40초')).toBeVisible();
    expect(screen.getByRole('button', { name: /^0:0 · /u })).toBeEnabled();
  });
});

describe('stored activity track selection', () => {
  it('moves the marker to the sample a map pick resolves to and back to its observation', async () => {
    const probe = adapterProbe();
    renderPanel({ handler: available(), probe, withWorkbench: true });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    // A pick in map coordinates near the fourth drawn vertex.
    act(() => probe.options()?.onPick([127.024, 37.504]));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:4'));
    // The same pick selected observation 4 in the shared store, so the workbench follows.
    expect(
      within(screen.getByRole('region', { name: '관측 선택 요약' })).getByText(/선택한 관측 4/),
    ).toBeVisible();
    expect(probe.setSelection.at(-1)).toEqual([127.024, 37.504]);
  });

  it('resolves a chart/record selection to the same position on the map', async () => {
    const probe = adapterProbe();
    renderPanel({ handler: available(), probe, withWorkbench: true });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await userEvent.click(screen.getByRole('button', { name: '관측 3 선택' }));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:3'));
    expect(probe.setSelection.at(-1)).toEqual([127.023, 37.503]);
  });

  it('says so when an observation has a sample that was never drawn', async () => {
    const probe = adapterProbe();
    renderPanel({ handler: available(), probe, withWorkbench: true });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    // Observation 2 corresponds to the sample with no fix: it exists, keeps its
    // measurements, and is not a vertex.
    await userEvent.click(screen.getByRole('button', { name: '관측 2 선택' }));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:2'));
    expect(selectionStatus()).toHaveTextContent('지도에 그려진 지점이 아닙니다');
    expect(probe.setSelection.at(-1)).toBeNull();
  });

  it('highlights the range a lap covers through the stored lap ordinal', async () => {
    const probe = adapterProbe();
    renderPanel({ handler: available(), probe, withWorkbench: true });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await userEvent.click(screen.getByRole('button', { name: /^랩$/u }));
    await userEvent.click(screen.getByRole('button', { name: '랩 1 선택' }));
    // A lap is a range, not a point: it highlights the samples it covers instead of
    // claiming one of them is "the" lap position.
    await waitFor(() =>
      expect(
        within(routePanel()).getByText(/선택한 구간의 표본 2개를 지도에서 강조/),
      ).toBeVisible(),
    );
    expect(screen.queryByText(/랩 번호가 없어/)).toBeNull();
    expect(probe.setSelection.at(-1)).toBeNull();
  });

  it('never moves a selection to a different sample when an instant is ambiguous', async () => {
    // Two samples recorded at the same instant. Picking the second one must keep the
    // second one selected, and must not select an observation that could belong to either.
    const ambiguous = (input: TransportRequest): Reply => {
      if (input.path.endsWith('/track'))
        return reply({ status: 'available', track: storedRevision() });
      if (input.path.endsWith('variant=normalized')) {
        const track = storedTrack();
        return reply({
          ...track,
          samples: track.samples.map((sample) =>
            sample.sampleId === '0:1'
              ? { ...sample, recordedAt: track.samples[0]?.recordedAt }
              : sample,
          ),
        });
      }
      return reply(storedMapPath());
    };
    const probe = adapterProbe();
    renderPanel({ handler: ambiguous, probe, withWorkbench: true });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await userEvent.click(within(routePanel()).getByRole('button', { name: /^0:1 · /u }));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:1'));
    // The reproduction the review found: 0:1 → observation 0 → 0:0. The sample stays 0:1.
    expect(selectionStatus()).not.toHaveTextContent('선택 표본 0:0');
    expect(
      within(screen.getByRole('region', { name: '관측 선택 요약' })).queryByText(/선택한 관측/),
    ).toBeNull();
    expect(within(routePanel()).getByText(/관측이 하나로 정해지지 않아/)).toBeVisible();
  });

  it('refuses to place a marker when several observations share the sample instant', async () => {
    // The mirror shape: one sample, two observations at the same instant. Selecting the
    // observation must not place a marker, because clicking that sample would refuse to
    // link back and would then drop the observation selection.
    const extraRecord = (input: TransportRequest): Reply => {
      if (!input.path.endsWith('/details')) return available()(input);
      const details = storedDetails();
      const duplicate = details.records[3];
      return reply({
        activityId,
        activityRevision: 1,
        source: { kind: 'fit', sourceId, revision: 1, contentHash: 'a'.repeat(64) },
        details: {
          ...details,
          records: duplicate ? [...details.records, { ...duplicate, index: 9 }] : details.records,
        },
      });
    };
    const probe = adapterProbe();
    const details = storedDetails();
    const duplicate = details.records[3];
    renderPanel({
      handler: extraRecord,
      probe,
      withWorkbench: true,
      details: duplicate
        ? { ...details, records: [...details.records, { ...duplicate, index: 9 }] }
        : details,
    });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await userEvent.click(screen.getByRole('button', { name: '관측 3 선택' }));
    await waitFor(() =>
      expect(within(routePanel()).getByText(/이 시각의 관측이 2개여서/)).toBeVisible(),
    );
    expect(selectionStatus()).toHaveTextContent('선택한 지점이 없습니다.');
    expect(probe.setSelection.at(-1)).toBeNull();

    // And the reverse click agrees: picking that sample selects no observation, so the
    // round trip is consistent instead of silently dropping the chart selection.
    await userEvent.click(within(routePanel()).getByRole('button', { name: /^0:3 · /u }));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:3'));
    expect(within(routePanel()).getByText(/관측이 하나로 정해지지 않아/)).toBeVisible();
  });

  it('refuses to place a marker for an observation whose instant names several samples', async () => {
    const ambiguous = (input: TransportRequest): Reply => {
      if (input.path.endsWith('/track'))
        return reply({ status: 'available', track: storedRevision() });
      if (input.path.endsWith('variant=normalized')) {
        const track = storedTrack();
        return reply({
          ...track,
          samples: track.samples.map((sample) =>
            sample.sampleId === '0:1'
              ? { ...sample, recordedAt: track.samples[0]?.recordedAt }
              : sample,
          ),
        });
      }
      return reply(storedMapPath());
    };
    const probe = adapterProbe();
    renderPanel({ handler: ambiguous, probe, withWorkbench: true });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await userEvent.click(screen.getByRole('button', { name: '관측 0 선택' }));
    await waitFor(() =>
      expect(
        within(routePanel()).getByText(/표본 2개가 있어 어느 지점인지 정할 수 없습니다/),
      ).toBeVisible(),
    );
    expect(selectionStatus()).toHaveTextContent('선택한 지점이 없습니다.');
    expect(probe.setSelection.at(-1)).toBeNull();
  });

  it('reaches the first and last vertex without the map and without a drag', async () => {
    const probe = adapterProbe();
    renderPanel({ handler: available(), probe });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await userEvent.click(within(routePanel()).getByRole('button', { name: '시작 지점' }));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:0'));
    await userEvent.click(within(routePanel()).getByRole('button', { name: '끝 지점' }));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:4'));
    await userEvent.click(within(routePanel()).getByRole('button', { name: '선택 해제' }));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택한 지점이 없습니다.'));
  });

  it('keeps one renderer for the mount and fits only when a fit is requested', async () => {
    const probe = adapterProbe();
    renderPanel({ handler: available(), probe });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await waitFor(() => expect(probe.fitBounds).toHaveLength(1));
    const paths = probe.setPaths.length;
    await userEvent.click(within(routePanel()).getByRole('button', { name: '시작 지점' }));
    await userEvent.click(within(routePanel()).getByRole('button', { name: '끝 지점' }));
    expect(probe.fitBounds).toHaveLength(1);
    expect(probe.setPaths).toHaveLength(paths);
    expect(probe.created).toHaveLength(1);
    await userEvent.click(within(routePanel()).getByRole('button', { name: '전체 보기' }));
    await waitFor(() => expect(probe.fitBounds).toHaveLength(2));
    expect(probe.created).toHaveLength(1);
    expect(probe.destroyed()).toBe(0);
  });
});

describe('stored activity track responsive layout', () => {
  it('uses the generated viewport modes and keeps the renderer across a layout change', async () => {
    const probe = adapterProbe();
    setViewport(1440);
    const { container } = renderPanel({ handler: available(), probe });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    const panes = () => container.querySelector('[data-layout]');
    expect(panes()?.getAttribute('data-layout')).toBe('desktop');
    // 1279 is the last tablet pixel and 1280 the first desktop one, per the generated spec.
    setViewport(1279);
    expect(panes()?.getAttribute('data-layout')).toBe('tablet');
    setViewport(768);
    expect(panes()?.getAttribute('data-layout')).toBe('tablet');
    setViewport(767);
    expect(panes()?.getAttribute('data-layout')).toBe('mobile');
    setViewport(320);
    expect(panes()?.getAttribute('data-layout')).toBe('mobile');
    // The tab strip exists only at mobile width, and both panes stay in the document.
    expect(screen.getByRole('tablist', { name: '저장된 경로 보기' })).toBeVisible();
    expect(panes()?.getAttribute('data-pane')).toBe('map');
    expect(screen.getByRole('tabpanel', { name: '요약·표본' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: '그래프' })).toBeInTheDocument();
    // One renderer for the whole mount, across every layout change above.
    expect(probe.created).toHaveLength(1);
    expect(probe.destroyed()).toBe(0);
  });

  it('puts the large graph and the map side by side on desktop with a linked selection', async () => {
    const probe = adapterProbe();
    setViewport(1440);
    renderPanel({ handler: available(), probe });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    // S09: both are on screen at once on desktop, not on separate tabs.
    const map = screen.getByRole('group', { name: '저장된 경로 지도' });
    const chart = screen.getByRole('group', { name: '저장된 경로 관측 그래프' });
    expect(map).toBeVisible();
    expect(chart).toBeVisible();
    expect(screen.queryByRole('tablist', { name: '저장된 경로 보기' })).toBeNull();
    // A point picked in the graph moves the marker on the map next to it.
    const point = await within(chart).findAllByRole('button', { name: '차트 관측 3 선택' });
    const first = point[0];
    expect(first).toBeDefined();
    if (first) fireEventClick(first);
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:3'));
    expect(probe.setSelection.at(-1)).toEqual([127.023, 37.503]);
  });

  it('switches mobile panes with the keyboard and preserves the selection', async () => {
    const probe = adapterProbe();
    setViewport(360);
    renderPanel({ handler: available(), probe });
    await screen.findByRole('region', { name: '저장된 활동 경로' });
    await userEvent.click(within(routePanel()).getByRole('button', { name: '끝 지점' }));
    await waitFor(() => expect(selectionStatus()).toHaveTextContent('선택 표본 0:4'));
    const mapTab = screen.getByRole('tab', { name: '지도' });
    mapTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '그래프', selected: true })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '요약·표본', selected: true })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: '지도', selected: true })).toHaveFocus();
    expect(selectionStatus()).toHaveTextContent('선택 표본 0:4');
    expect(probe.created).toHaveLength(1);
  });

  it('does not intercept an IME composition or a modifier combination', async () => {
    setViewport(360);
    renderPanel({ handler: available() });
    await screen.findByRole('region', { name: '저장된 경로' });
    const mapTab = await screen.findByRole('tab', { name: '지도' });
    fireEvent.keyDown(mapTab, { key: 'ArrowRight', isComposing: true });
    expect(screen.getByRole('tab', { name: '지도', selected: true })).toBeInTheDocument();
    fireEvent.keyDown(mapTab, { key: 'ArrowRight', altKey: true });
    expect(screen.getByRole('tab', { name: '지도', selected: true })).toBeInTheDocument();
  });
});
