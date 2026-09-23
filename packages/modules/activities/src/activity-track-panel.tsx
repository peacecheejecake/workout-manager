'use client';

/**
 * S09 route panel for a **stored** activity track.
 *
 * This is the first screen that reads a track the server stored (M2-01c) and draws it on
 * the self-hosted basemap (M2-01d). It is a different composition from the local-file
 * preview, not the same screen with a flag: the preview owns a file and a parser, this
 * one owns two server queries and joins the activity's existing selection store, and the
 * only thing they share is the map leaf.
 *
 * Selection travels as a **sample id**. A drawn vertex resolves to the sample id the
 * server recorded for it, and a chart observation, a lap or a time range resolves to
 * sample ids too, so nothing in here ever treats a display index as a source index.
 *
 * Nothing here recomputes a training number. The summary is derived from the samples, so
 * which vertices are drawn cannot change an elapsed time, a distance or a pace.
 */
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { ActivityDetails } from '@workout/contracts/activity-details';
import type { ActivityTrackRevision } from '@workout/contracts/activity-tracks';
import type { MapPath, RecordedTrack } from '@workout/contracts/tracks';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type { BasemapDescriptor } from '@workout/geo-kit/basemap';
import type { MapAdapterFactory, MapAdapterFailure } from '@workout/geo-kit/map-adapter';
import type { MapSelection } from '@workout/geo-kit/map-path';
import type { MapViewProps, MapViewStatus } from '@workout/geo-kit/map-view';
import { Button } from '@workout/ui-foundation/button';
import { getLayoutMode, type LayoutMode } from '@workout/ui-foundation/responsive';
import { StatusNotice } from '@workout/ui-foundation/status-notice';
import { CourseFromSegment } from './course-from-segment';
import { createDetailSelectionStore } from './detail-selection';
import { useSharedDetailSelectionStore } from './detail-selection-provider';
import { lapTimeRange, type TimeRange } from './detail-projection';
import { MapLeaf } from './map-leaf';
import {
  buildHighlightPath,
  buildRecordInstantIndex,
  buildStoredTrackGeometry,
  definiteRecordForSample,
  definiteSampleForRecord,
  indexStoredTrack,
  lapCorrespondence,
  samplesInRange,
  type InstantCorrespondence,
} from './stored-track-geometry';
import {
  storedTrackArtifactsQueryOptions,
  storedTrackQueryOptions,
  type TrackQueryScope,
} from './stored-track-queries';
import { countBreaks, summarizeTrack } from './track-preview-geometry';
import styles from './activity-track-panel.module.css';

export interface ActivityTrackPanelProps {
  readonly athleteId: string;
  readonly sessionId: string;
  readonly transport: AuthenticatedTransport;
  readonly activityId: string;
  /** Current source revision of the activity, used to detect a track built from an older one. */
  readonly activitySourceRevision: number;
  /** Detail observations already loaded by the owner; `null` when they are unavailable. */
  readonly details: ActivityDetails | null;
  readonly scope: TrackQueryScope;
  /** `null` draws the recording with no background map. */
  readonly basemap?: BasemapDescriptor | null;
  readonly mapWorkerUrl?: string;
  /** Renderer override for hosts and tests; not a mode flag. */
  readonly createMapAdapter?: MapAdapterFactory;
  readonly mapView?: ComponentType<MapViewProps>;
}

const pathId = 'stored-track';
const highlightPathId = 'stored-track-range';
const samplesPerPage = 50;
/** Observations drawn in one chart page. Matches the interval workbench's own page size. */
const recordsPerChartPage = 500;

/**
 * S09 asks for the large graph and the map together on desktop and as separate tabs on
 * mobile. These are the three panes of one DOM; the layout mode decides how they are shown.
 */
type PaneId = 'map' | 'chart' | 'detail';
const paneOrder = [
  ['map', '지도'],
  ['chart', '그래프'],
  ['detail', '요약·표본'],
] as const satisfies readonly (readonly [PaneId, string])[];

const breakLabels: Record<string, string> = {
  'stream-start': '기록 시작',
  'gpx-trkseg': 'GPX trkseg 분리',
  'fit-session': 'FIT session 분리',
  'fit-event-stop': '타이머 정지',
  'missing-position': '위치 결손',
  'time-gap': '시간 간격',
  'position-gap': '위치 간격',
  'time-reversal': '시간 역전',
  'duplicate-timestamp': '중복 시각',
  'antimeridian-crossing': '경도 경계 횡단',
};

const insufficientLabels: Record<string, string> = {
  'single-point': '표본이 하나뿐이라 선을 그리지 않고 점으로 표시했습니다',
  'no-position': '위치가 없어 표시하지 않았습니다',
};

function subscribeToViewport(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
  };
}

/**
 * Layout mode from the **generated** viewport specification, never from a breakpoint
 * copied into this package and never from the user agent. The server snapshot is the
 * narrowest mode, so the first paint is the one that fits everywhere.
 */
function useLayoutModeFromViewport(): LayoutMode {
  return useSyncExternalStore(
    subscribeToViewport,
    () => getLayoutMode(window.innerWidth),
    () => 'mobile' as const,
  );
}

export function ActivityTrackPanel(props: ActivityTrackPanelProps) {
  return (
    <section className={styles.root} aria-label="저장된 경로">
      <TrackPanel {...props} />
    </section>
  );
}

function TrackPanel({
  transport,
  activityId,
  activitySourceRevision,
  details,
  scope,
  basemap = null,
  mapWorkerUrl,
  createMapAdapter,
  mapView,
}: ActivityTrackPanelProps) {
  const metadata = useQuery(storedTrackQueryOptions(scope, transport, activityId));
  const track = metadata.data ?? null;
  const reloadMetadata = useCallback(() => void metadata.refetch(), [metadata]);

  if (metadata.isPending)
    return <StatusNotice state="loading">저장된 경로를 확인하고 있습니다.</StatusNotice>;
  if (metadata.isError)
    return (
      <StatusNotice
        state="error"
        action={
          <Button variant="secondary" onClick={reloadMetadata}>
            경로 다시 조회
          </Button>
        }
      >
        저장된 경로를 확인하지 못했습니다. 요약과 차트는 그대로 사용할 수 있습니다.
      </StatusNotice>
    );
  if (track === null)
    return (
      <StatusNotice
        state="empty"
        action={
          <Button variant="secondary" onClick={reloadMetadata}>
            경로 다시 조회
          </Button>
        }
      >
        이 활동에는 저장된 경로가 없습니다. 기록 파일을 저장하면 여기에 표시됩니다.
      </StatusNotice>
    );

  const stale = track.sourceRevision !== activitySourceRevision;
  return (
    <>
      <dl className={styles.identity}>
        <div>
          <dt>경로 수정 번호</dt>
          <dd>{track.trackRevision}</dd>
        </div>
        <div>
          <dt>원본 수정 번호</dt>
          <dd>{track.sourceRevision}</dd>
        </div>
        <div>
          <dt>원본 형식</dt>
          <dd>
            {track.file.format} · {track.recordedSourceKind}
          </dd>
        </div>
        <div>
          <dt>표본</dt>
          <dd>
            전체 {track.sampleCount}개 · 위치 있음 {track.positionedSampleCount}개 · 구간{' '}
            {track.segmentCount}개
          </dd>
        </div>
      </dl>
      {stale ? (
        <StatusNotice
          state="stale"
          action={
            <Button variant="secondary" onClick={reloadMetadata}>
              경로 다시 조회
            </Button>
          }
        >
          이 경로는 원본 수정 {track.sourceRevision}에서 만들어졌고 현재 활동은 원본 수정{' '}
          {activitySourceRevision}입니다. 아래 내용은 예전 원본 기준입니다.
        </StatusNotice>
      ) : null}
      {track.positionedSampleCount === 0 ? (
        <StatusNotice state="partial">
          위치가 기록되지 않은 활동입니다. 지도는 표시하지 않고 요약만 보여 줍니다.
        </StatusNotice>
      ) : null}
      {/*
        The geometry objects are a separate, revision-keyed query, mounted only once a
        revision exists. Keeping it in its own component means there is no disabled query
        with a made-up identity, and a new revision remounts the view below it.
      */}
      <StoredTrackArtifacts
        key={`${track.trackId}:${track.trackRevision}`}
        track={track}
        transport={transport}
        scope={scope}
        details={details}
        basemap={basemap}
        onReloadMetadata={reloadMetadata}
        {...(mapWorkerUrl ? { mapWorkerUrl } : {})}
        {...(createMapAdapter ? { createMapAdapter } : {})}
        {...(mapView ? { mapView } : {})}
      />
    </>
  );
}

interface StoredTrackArtifactsProps {
  readonly track: ActivityTrackRevision;
  readonly transport: AuthenticatedTransport;
  readonly scope: TrackQueryScope;
  readonly details: ActivityDetails | null;
  readonly basemap: BasemapDescriptor | null;
  readonly onReloadMetadata: () => void;
  readonly mapWorkerUrl?: string;
  readonly createMapAdapter?: MapAdapterFactory;
  readonly mapView?: ComponentType<MapViewProps>;
}

function StoredTrackArtifacts({
  track,
  transport,
  scope,
  details,
  basemap,
  onReloadMetadata,
  mapWorkerUrl,
  createMapAdapter,
  mapView,
}: StoredTrackArtifactsProps) {
  const artifacts = useQuery(storedTrackArtifactsQueryOptions(scope, transport, track));
  const reload = useCallback(() => {
    onReloadMetadata();
    void artifacts.refetch();
  }, [onReloadMetadata, artifacts]);
  if (artifacts.isPending)
    return <StatusNotice state="loading">경로 좌표를 불러오고 있습니다.</StatusNotice>;
  if (artifacts.isError)
    return (
      <StatusNotice
        state="error"
        action={
          <Button variant="secondary" onClick={reload}>
            경로 다시 조회
          </Button>
        }
      >
        경로 좌표를 불러오지 못했습니다 ({artifacts.error.message}). 요약과 차트는 그대로 사용할 수
        있습니다.
      </StatusNotice>
    );
  return (
    <StoredTrackView
      recorded={artifacts.data.track}
      mapPath={artifacts.data.mapPath}
      transport={transport}
      activityId={track.activityId}
      details={details}
      basemap={basemap}
      onReload={reload}
      {...(mapWorkerUrl ? { mapWorkerUrl } : {})}
      {...(createMapAdapter ? { createMapAdapter } : {})}
      {...(mapView ? { mapView } : {})}
    />
  );
}

interface StoredTrackViewProps {
  readonly recorded: RecordedTrack;
  readonly mapPath: MapPath;
  readonly transport: AuthenticatedTransport;
  readonly activityId: string;
  readonly details: ActivityDetails | null;
  readonly basemap: BasemapDescriptor | null;
  readonly onReload: () => void;
  readonly mapWorkerUrl?: string;
  readonly createMapAdapter?: MapAdapterFactory;
  readonly mapView?: ComponentType<MapViewProps>;
}

function StoredTrackView({
  recorded,
  mapPath,
  transport,
  activityId,
  details,
  basemap,
  onReload,
  mapWorkerUrl,
  createMapAdapter,
  mapView,
}: StoredTrackViewProps) {
  const layout = useLayoutModeFromViewport();
  const [pane, setPane] = useState<PaneId>('map');
  const [fitRequest, setFitRequest] = useState(0);
  const [page, setPage] = useState(0);
  const [failure, setFailure] = useState<MapAdapterFailure | null>(null);
  const [mapStatus, setMapStatus] = useState<MapViewStatus>('preparing');
  const tabsId = useId();

  const shared = useSharedDetailSelectionStore();
  const [ownStore] = useState(createDetailSelectionStore);
  const store = shared ?? ownStore;
  const recordIndex = useStore(store, (state) => state.recordIndex);
  const lapIndex = useStore(store, (state) => state.lapIndex);
  const range = useStore(store, (state) => state.range);
  const pickedSample = useStore(store, (state) => state.sample);
  const selectRecord = useStore(store, (state) => state.selectRecord);
  const selectSample = useStore(store, (state) => state.selectSample);
  const clearSelection = useStore(store, (state) => state.clear);

  const geometry = useMemo(() => buildStoredTrackGeometry(mapPath, pathId), [mapPath]);
  const index = useMemo(() => indexStoredTrack(recorded), [recorded]);
  const summary = useMemo(() => summarizeTrack(recorded), [recorded]);
  const breaks = useMemo(() => countBreaks(recorded), [recorded]);
  const recordInstants = useMemo(
    () => buildRecordInstantIndex(details?.records ?? []),
    [details?.records],
  );
  const trackRevision = geometry.path.revision;

  // Everything below is derived from the shared selection; the screen keeps no second copy.
  const selectedRecord = details?.records.find((record) => record.index === recordIndex) ?? null;
  const selectedLap = details?.laps.find((lap) => lap.index === lapIndex) ?? null;
  const lapMatch = useMemo(
    () =>
      selectedLap === null
        ? null
        : lapCorrespondence(index, selectedLap.index, lapTimeRange(selectedLap)),
    [index, selectedLap],
  );
  // A range highlight is built only for a lap or an explicit range — never for a single
  // observation, whose selection must move the marker alone and not the drawn data.
  const highlightedSampleIds = useMemo(() => {
    if (lapMatch) return lapMatch.sampleIds;
    if (recordIndex !== null || pickedSample !== null) return [];
    if (range === null || range.start === range.end) return [];
    return samplesInRange(index, range);
  }, [lapMatch, recordIndex, pickedSample, range, index]);
  const highlight = useMemo(
    () =>
      highlightedSampleIds.length === 0
        ? null
        : buildHighlightPath(geometry, highlightedSampleIds, highlightPathId),
    [geometry, highlightedSampleIds],
  );
  const paths = useMemo(
    () => (highlight ? [geometry.path, highlight] : [geometry.path]),
    [geometry, highlight],
  );

  /**
   * The marker. A directly picked sample wins — that is what the user chose, and it is
   * kept even when its instant links to no observation. Otherwise it is derived from the
   * selected observation, and only when that link is unambiguous.
   */
  const derived: InstantCorrespondence = selectedRecord
    ? definiteSampleForRecord(index, recordInstants, parseInstant(selectedRecord.timestamp))
    : { kind: 'none' };
  const sampleId =
    pickedSample && pickedSample.trackRevision === trackRevision
      ? pickedSample.sampleId
      : derived.kind === 'unique'
        ? derived.sampleId
        : null;
  const sample = sampleId === null ? null : (index.bySampleId.get(sampleId) ?? null);
  const vertexIndex = sampleId === null ? undefined : geometry.vertexIndexBySampleId.get(sampleId);
  const selection: MapSelection | null = vertexIndex === undefined ? null : { pathId, vertexIndex };
  const ambiguousObservation = sampleId === null && derived.kind === 'ambiguous' ? derived : null;

  const pick = useCallback(
    (nextSampleId: string | null) => {
      if (nextSampleId === null) {
        clearSelection();
        return;
      }
      // The observation is selected only when the instant identifies exactly one sample
      // and exactly one observation. Otherwise the pick stands on its own and the chart
      // keeps whatever it had, rather than jumping to a point nobody chose.
      const definite = definiteRecordForSample(index, recordInstants, nextSampleId);
      selectSample(
        { trackRevision, sampleId: nextSampleId },
        definite?.recordIndex ?? null,
        definite?.instant ?? null,
      );
    },
    [index, recordInstants, selectSample, clearSelection, trackRevision],
  );

  const onMapSelect = useCallback(
    (next: MapSelection | null) =>
      pick(
        next === null || next.pathId !== pathId
          ? null
          : (geometry.vertexSampleIds[next.vertexIndex] ?? null),
      ),
    [geometry, pick],
  );

  const onChartSelect = useCallback(
    (nextIndex: number, time: number) => selectRecord(nextIndex, time),
    [selectRecord],
  );

  const adapterFactory = useMemo<MapAdapterFactory | undefined>(() => {
    if (createMapAdapter) return createMapAdapter;
    if (!mapWorkerUrl) return undefined;
    return async (options) => {
      const module = await import('@workout/geo-kit/maplibre-adapter');
      module.configureMapWorker(mapWorkerUrl);
      return module.createMapLibreAdapter(options);
    };
  }, [mapWorkerUrl, createMapAdapter]);
  // A new object every render would re-create the renderer on every parent render.
  const stableBasemap = useMemo(
    () =>
      basemap === null
        ? null
        : {
            styleUrl: basemap.styleUrl,
            attribution: basemap.attribution,
            ...(basemap.localIdeographFontFamily
              ? { localIdeographFontFamily: basemap.localIdeographFontFamily }
              : {}),
          },
    [basemap],
  );

  const onFailure = useCallback((next: MapAdapterFailure) => setFailure(next), []);

  const total = geometry.vertexSampleIds.length;
  const pages = Math.max(1, Math.ceil(total / samplesPerPage));
  const shownPage = Math.min(
    vertexIndex === undefined ? page : Math.floor(vertexIndex / samplesPerPage),
    pages - 1,
  );
  const start = shownPage * samplesPerPage;
  const listed = geometry.path.positions.slice(start, start + samplesPerPage);

  const basemapFailed = failure === 'STYLE_LOAD_FAILED' || failure === 'BASEMAP_REJECTED';
  const rendererFailed = failure === 'RENDERER_UNAVAILABLE' || failure === 'CONTEXT_LOST';

  return (
    <>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onReload}>
          경로 다시 조회
        </Button>
        <Button
          variant="secondary"
          disabled={total === 0}
          onClick={() => pick(geometry.vertexSampleIds[0] ?? null)}
        >
          시작 지점
        </Button>
        <Button
          variant="secondary"
          disabled={total === 0}
          onClick={() => pick(geometry.vertexSampleIds[total - 1] ?? null)}
        >
          끝 지점
        </Button>
        <Button
          variant="secondary"
          disabled={total === 0}
          onClick={() => setFitRequest((value) => value + 1)}
        >
          전체 보기
        </Button>
        <Button variant="secondary" onClick={() => pick(null)}>
          선택 해제
        </Button>
      </div>

      {layout === 'mobile' ? (
        <div role="tablist" aria-label="저장된 경로 보기" className={styles.tabs}>
          {paneOrder.map(([id, label]) => (
            <Button
              key={id}
              variant="secondary"
              role="tab"
              id={`${tabsId}-${id}`}
              aria-selected={pane === id}
              aria-controls={`${tabsId}-${id}-pane`}
              tabIndex={pane === id ? 0 : -1}
              onClick={() => setPane(id)}
              onKeyDown={(event) => {
                // Modifier combinations and IME composition are never intercepted.
                if (
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing
                )
                  return;
                const current = paneOrder.findIndex(([candidate]) => candidate === id);
                const next =
                  event.key === 'ArrowRight'
                    ? (current + 1) % paneOrder.length
                    : event.key === 'ArrowLeft'
                      ? (current + paneOrder.length - 1) % paneOrder.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? paneOrder.length - 1
                          : null;
                const target = next === null ? undefined : paneOrder[next]?.[0];
                if (target === undefined) return;
                event.preventDefault();
                setPane(target);
                document.getElementById(`${tabsId}-${target}`)?.focus();
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}

      <p role="status" className={styles.note}>
        {sample
          ? `선택 표본 ${sample.sampleId} · ${sample.recordedAt ?? '시각 미확인'} · ${
              sample.heartRateBpm === null ? '심박 미확인' : `${sample.heartRateBpm}bpm`
            }${vertexIndex === undefined ? ' · 지도에 그려진 지점이 아닙니다' : ''}`
          : '선택한 지점이 없습니다.'}
      </p>
      {ambiguousObservation ? (
        <p className={styles.note}>
          {ambiguousObservation.reason === 'samples'
            ? `선택한 관측 ${selectedRecord?.index}의 시각에 표본 ${ambiguousObservation.count}개가 있어 어느 지점인지 정할 수 없습니다. 표본 목록에서 직접 선택하세요.`
            : `이 시각의 관측이 ${ambiguousObservation.count}개여서 선택한 관측 ${selectedRecord?.index}이 어느 지점인지 정할 수 없습니다. 표본 목록에서 직접 선택하세요.`}
        </p>
      ) : selectedRecord && sample === null ? (
        <p className={styles.note}>
          선택한 관측 {selectedRecord.index}의 시각에 대응하는 위치 표본이 없습니다.
        </p>
      ) : null}
      {sample && recordIndex === null && lapIndex === null ? (
        <p className={styles.note}>
          이 표본의 기록 시각에 대응하는 관측이 하나로 정해지지 않아 차트 선택은 바꾸지 않았습니다.
        </p>
      ) : null}
      {highlight ? (
        <p className={styles.note}>
          선택한 구간의 표본 {highlight.positions.length}개를 지도에서 강조했습니다. 끊긴 구간은
          이어 붙이지 않습니다.
        </p>
      ) : null}
      {lapMatch && lapMatch.basis === 'time-range' ? (
        <p className={styles.note}>
          이 기록의 표본에는 랩 번호가 없어 랩의 시작·경과 시간 구간으로 대응했습니다.
        </p>
      ) : null}
      {lapMatch && lapMatch.basis === 'none' ? (
        <p className={styles.note}>선택한 랩에 대응하는 위치 표본이 없습니다.</p>
      ) : null}
      <p className={styles.note}>
        관측·랩·구간 선택은 저장된 표본 식별자로 대응합니다. 현재 파서는 표본에 관측 순번 링크를
        남기지 않으므로 기록 시각이 같은 표본으로 대응하며, 같은 시각이 없으면 대응 없음으로
        표시합니다.
      </p>

      {/*
        One DOM for every layout. The panes are always mounted and only their visibility
        changes, so switching a tab or crossing a breakpoint keeps the renderer, the
        selection and the list page instead of remounting the map.
      */}
      <div
        className={styles.panes}
        data-testid="stored-track-panes"
        data-layout={layout}
        data-pane={pane}
      >
        <div
          className={`${styles.pane} ${styles.mapPane}`}
          id={`${tabsId}-map-pane`}
          {...(layout === 'mobile'
            ? { role: 'tabpanel', 'aria-labelledby': `${tabsId}-map` }
            : { role: 'group', 'aria-label': '저장된 경로 지도' })}
        >
          {total > 0 ? (
            <MapLeaf
              label="저장된 활동 경로"
              paths={paths}
              selection={selection}
              onSelect={onMapSelect}
              basemap={stableBasemap}
              fitRequest={fitRequest}
              onStatusChange={setMapStatus}
              onFailure={onFailure}
              loadFailureFallback={
                <p role="status">
                  지도 구성 요소를 불러오지 못했습니다. 아래 요약과 표본 목록은 그대로 사용할 수
                  있습니다.
                </p>
              }
              {...(adapterFactory ? { createAdapter: adapterFactory } : {})}
              {...(mapView ? { mapView } : {})}
            />
          ) : (
            <StatusNotice state="empty">
              그릴 좌표가 없습니다. 아래 요약과 표본 목록을 사용하세요.
            </StatusNotice>
          )}
          {/*
            Plain notes, not live regions: the map's own status line already announces the
            classified failure (review N6). These add only what this screen owns — that the
            summary and the sample list still work.
          */}
          {basemapFailed ? (
            <p className={styles.note}>
              배경 지도를 불러오지 못했습니다. 경로와 요약은 그대로 사용할 수 있습니다.
            </p>
          ) : null}
          {rendererFailed ? (
            <p className={styles.note}>
              이 브라우저에서 지도 렌더러(WebGL)를 사용할 수 없습니다. 아래 표본 목록으로 같은
              지점을 선택할 수 있습니다.
            </p>
          ) : null}
          {/*
            Whether the path is drawn is the map's own status line, tied to what the
            renderer actually drew; a second count here once contradicted it.
          */}
          {mapStatus === 'invalid' ? (
            <StatusNotice state="error">
              저장된 좌표가 표시 계약을 만족하지 않아 그리지 않았습니다.
            </StatusNotice>
          ) : null}
        </div>

        <div
          className={`${styles.pane} ${styles.chartPane}`}
          id={`${tabsId}-chart-pane`}
          {...(layout === 'mobile'
            ? { role: 'tabpanel', 'aria-labelledby': `${tabsId}-chart` }
            : { role: 'group', 'aria-label': '저장된 경로 관측 그래프' })}
        >
          <h4>관측 그래프</h4>
          {details === null ? (
            <StatusNotice state="unavailable">
              원본 관측 상세를 함께 조회하지 못해 그래프를 표시하지 않습니다. 지도와 표본 목록은
              그대로 사용할 수 있습니다.
            </StatusNotice>
          ) : (
            <TrackChartPane
              records={details.records}
              selected={recordIndex}
              range={range}
              onSelect={onChartSelect}
            />
          )}
        </div>

        <div
          className={`${styles.pane} ${styles.detailPane}`}
          id={`${tabsId}-detail-pane`}
          {...(layout === 'mobile'
            ? { role: 'tabpanel', 'aria-labelledby': `${tabsId}-detail` }
            : { role: 'group', 'aria-label': '저장된 경로 요약과 표본' })}
        >
          <h4>기본 요약</h4>
          <dl className={styles.summary}>
            <div>
              <dt>시작 시각</dt>
              <dd>{summary.startedAt ?? '미확인'}</dd>
            </div>
            <div>
              <dt>끝 시각</dt>
              <dd>{summary.endedAt ?? '미확인'}</dd>
            </div>
            <div>
              <dt>경과 시간</dt>
              <dd>{summary.elapsedSeconds === null ? '미확인' : `${summary.elapsedSeconds}초`}</dd>
            </div>
            <div>
              <dt>기기 보고 거리</dt>
              <dd>
                {summary.deviceDistanceMeters === null
                  ? '미확인'
                  : `${Math.round(summary.deviceDistanceMeters)}m`}
              </dd>
            </div>
            <div>
              <dt>GPS 재계산 거리</dt>
              <dd>
                {summary.recomputedDistanceMeters === null
                  ? '미확인'
                  : `${Math.round(summary.recomputedDistanceMeters)}m`}
              </dd>
            </div>
            <div>
              <dt>평균 페이스(기기 거리 기준)</dt>
              <dd>
                {summary.averagePaceSecondsPerKilometer === null
                  ? '미확인'
                  : `${Math.round(summary.averagePaceSecondsPerKilometer)}초/km`}
              </dd>
            </div>
            <div>
              <dt>평균 심박(표본 평균)</dt>
              <dd>
                {summary.averageHeartRateBpm === null
                  ? '미확인'
                  : `${Math.round(summary.averageHeartRateBpm)}bpm`}
              </dd>
            </div>
          </dl>
          {breaks.length > 0 ? (
            <ul className={styles.breaks}>
              {breaks.map((item) => (
                <li key={item.reason}>
                  {breakLabels[item.reason] ?? item.reason} {item.count}회
                </li>
              ))}
            </ul>
          ) : null}
          {geometry.insufficient.length > 0 ? (
            <ul className={styles.breaks}>
              {geometry.insufficient.map((item) => (
                <li key={`${item.segmentIndex}:${item.reason}`}>
                  구간 {item.segmentIndex}: {insufficientLabels[item.reason] ?? item.reason} (표본{' '}
                  {item.sampleIds.length}개)
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            A course can only be cut from a recording the server stored, so the section is
            offered only when this geometry carries stored provenance.
          */}
          {mapPath.sourceRevision.kind === 'activity-source' ? (
            <CourseFromSegment
              transport={transport}
              activityId={activityId}
              trackRevision={mapPath.sourceRevision.trackRevision}
              selectedSampleId={sampleId}
              selectedIsDrawn={vertexIndex !== undefined}
            />
          ) : null}

          <h4 id={`${tabsId}-samples`}>표본 목록</h4>
          {total === 0 ? (
            <p className={styles.note}>그려진 표본이 없습니다.</p>
          ) : (
            <>
              <p className={styles.note}>
                좌표 {total}개 중 {start + 1}–{start + listed.length}번째. 지도 없이도 모든 표본을
                선택할 수 있습니다.
              </p>
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  disabled={shownPage === 0}
                  onClick={() => {
                    pick(null);
                    setPage(Math.max(0, shownPage - 1));
                  }}
                >
                  이전 표본 묶음
                </Button>
                <Button
                  variant="secondary"
                  disabled={shownPage >= pages - 1}
                  onClick={() => {
                    pick(null);
                    setPage(Math.min(pages - 1, shownPage + 1));
                  }}
                >
                  다음 표본 묶음
                </Button>
                <Button
                  variant="secondary"
                  disabled={shownPage >= pages - 1}
                  onClick={() => {
                    pick(null);
                    setPage(pages - 1);
                  }}
                >
                  마지막 묶음
                </Button>
              </div>
              <ol className={styles.samples} aria-labelledby={`${tabsId}-samples`}>
                {listed.map((position, offset) => {
                  const vertex = start + offset;
                  const id = geometry.vertexSampleIds[vertex] ?? String(vertex);
                  return (
                    <li key={id}>
                      <Button
                        variant="secondary"
                        aria-pressed={sampleId === id}
                        onClick={() => pick(id)}
                      >
                        {id} · {position[1].toFixed(5)}, {position[0].toFixed(5)}
                      </Button>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The large graph S09 asks for next to the map.
 *
 * It renders the same `DetailChart` the interval workbench uses and writes to the same
 * selection store, so a point picked here is the same selection the map shows — there is
 * no second chart implementation and no second selection. Long recordings are paged with
 * the same page size as the workbench; the page follows the selection.
 */
function TrackChartPane({
  records,
  selected,
  range,
  onSelect,
}: {
  readonly records: ActivityDetails['records'];
  readonly selected: number | null;
  readonly range: TimeRange | null;
  readonly onSelect: (index: number, time: number) => void;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(records.length / recordsPerChartPage));
  const position = selected === null ? -1 : records.findIndex((r) => r.index === selected);
  const shown = Math.min(
    position < 0 ? page : Math.floor(position / recordsPerChartPage),
    pages - 1,
  );
  const start = shown * recordsPerChartPage;
  const listed = records.slice(start, start + recordsPerChartPage);
  return (
    <>
      <p className={styles.note}>
        차트 원본 순번 범위:{' '}
        {listed.length ? `${listed[0]?.index}–${listed.at(-1)?.index}` : '없음'} · 전체{' '}
        {records.length}개 중 {listed.length}개 표시 (페이지당 최대 {recordsPerChartPage}개)
      </p>
      {pages > 1 ? (
        <div className={styles.actions}>
          <Button variant="secondary" disabled={shown === 0} onClick={() => setPage(shown - 1)}>
            이전 차트 페이지
          </Button>
          <Button
            variant="secondary"
            disabled={shown + 1 >= pages}
            onClick={() => setPage(shown + 1)}
          >
            다음 차트 페이지
          </Button>
        </div>
      ) : null}
      {listed.length === 0 ? (
        <StatusNotice state="empty">표시할 개별 관측이 없습니다.</StatusNotice>
      ) : (
        <ChartBoundary>
          <Suspense
            fallback={<p role="status">관측 차트 불러오는 중… 표본 목록으로 선택할 수 있습니다.</p>}
          >
            <LazyDetailChart
              records={listed}
              metric="distanceMeters"
              selected={selected}
              range={range}
              onSelect={onSelect}
            />
            <LazyDetailChart
              records={listed}
              metric="heartRateBpm"
              selected={selected}
              range={range}
              onSelect={onSelect}
            />
          </Suspense>
        </ChartBoundary>
      )}
    </>
  );
}

/** The chart is lazily loaded, and its failure must not take the map down with it. */
const LazyDetailChart = lazy(() =>
  import('./detail-chart').then((module) => ({ default: module.DetailChart })),
);

class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p role="alert">
        관측 차트를 불러오지 못했습니다. 지도와 표본 목록은 그대로 사용할 수 있습니다.
      </p>
    ) : (
      this.props.children
    );
  }
}

function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
