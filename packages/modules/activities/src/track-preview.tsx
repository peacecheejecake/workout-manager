'use client';

/**
 * S09 local-file track preview.
 *
 * One file in, parsed in memory, drawn as a track. Nothing is uploaded: this component
 * receives no transport, so there is no path from here to a stored Activity, and the
 * provenance stays `local-file` with no Activity identity anywhere on screen.
 *
 * Composition instead of mode flags: the shell decides which parser to pass and whether
 * a basemap exists. There is no `readOnly`/`isEditor` boolean that changes behaviour.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { trackLimits, type RecordedTrack } from '@workout/contracts/tracks';
import type { BasemapDescriptor } from '@workout/geo-kit/basemap';
import type { MapAdapterFactory } from '@workout/geo-kit/map-adapter';
import type { MapSelection } from '@workout/geo-kit/map-path';
import type { MapViewProps, MapViewStatus } from '@workout/geo-kit/map-view';
import { Button } from '@workout/ui-foundation/button';
import { StatusNotice } from '@workout/ui-foundation/status-notice';
import {
  buildPreviewGeometry,
  countBreaks,
  sanitizeDisplayText,
  summarizeTrack,
} from './track-preview-geometry';
import { MapLeaf } from './map-leaf';
import { TrackPreviewError, type TrackPreviewParser } from './track-preview-parser';
import {
  initialTrackPreviewState,
  presentTrackPreview,
  trackPreviewReducer,
} from './track-preview-state';
import styles from './track-preview.module.css';

export interface LocalTrackPreviewProps {
  /** Scopes the preview lifetime; a different athlete or session starts an empty screen. */
  readonly athleteId: string;
  readonly sessionId: string;
  /** `null` means no parser is wired in this shell; the screen says so instead of guessing. */
  readonly parser: TrackPreviewParser | null;
  /** Same-origin MapLibre worker. Absent means the renderer uses its bundled default. */
  readonly mapWorkerUrl?: string;
  /** `null` draws the recording with no background map, which is what M2-01b requires. */
  readonly basemap?: BasemapDescriptor | null;
  /**
   * Renderer override. Present so a host (or a test) can supply its own renderer instead
   * of the lazily imported MapLibre adapter; it is not a mode flag.
   */
  readonly createMapAdapter?: MapAdapterFactory;
  /** Injected in tests to exercise the renderer chunk-load failure path. */
  readonly mapView?: ComponentType<MapViewProps>;
}

/**
 * Account switch and logout are a remount, not a cleanup pass: the reducer state, the
 * parsed file, the worker and the map source all belong to the mounted subtree.
 */
export function LocalTrackPreview(props: LocalTrackPreviewProps) {
  return <PreviewLifetime key={`${props.athleteId}:${props.sessionId}`} {...props} />;
}

const breakLabels: Record<RecordedTrack['segments'][number]['startReason'], string> = {
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

const failureMessages: Record<string, string> = {
  PREVIEW_FILE_EMPTY: '빈 파일입니다.',
  PREVIEW_FILE_TOO_LARGE: `파일이 상한(${Math.round(trackLimits.fileBytes / (1024 * 1024))} MiB)을 넘습니다.`,
  PREVIEW_PARSER_UNAVAILABLE: '이 화면에서 파일을 읽을 수 없습니다.',
  PREVIEW_WORKER_FAILED: '파싱 worker가 실패했습니다.',
  PREVIEW_REPLY_INVALID: '파싱 결과가 계약을 만족하지 않아 표시하지 않았습니다.',
  PREVIEW_TIMEOUT: '제한 시간 안에 파싱이 끝나지 않아 중단했습니다.',
  PREVIEW_PARSE_FAILED: '파일을 해석하지 못했습니다.',
  PREVIEW_READ_FAILED: '파일을 읽지 못했습니다.',
  TRACK_FILE_TOO_LARGE: '파일이 파서 상한을 넘습니다.',
  TRACK_ARCHIVE_REJECTED: '압축 파일은 받지 않습니다.',
  TRACK_FORMAT_UNSUPPORTED: '지원하는 FIT/GPX 형식이 아닙니다.',
  TRACK_FIT_INVALID: '손상된 FIT 파일입니다.',
  TRACK_GPX_INVALID_ROOT: 'GPX 루트 요소나 namespace가 올바르지 않습니다.',
  TRACK_XML_DTD_BLOCKED: 'DTD·외부 엔티티가 있는 XML은 거절합니다.',
  TRACK_NO_TRACK_DATA: '파일에 기록된 트랙이 없습니다.',
  TRACK_PARSE_TIMEOUT: '파서 시간 상한을 넘었습니다.',
  TRACK_PARSE_MEMORY_LIMIT: '파서 작업량 상한을 넘었습니다.',
};

/**
 * Bytes of the chosen file. `Blob.arrayBuffer` is the normal path; the `FileReader`
 * fallback keeps the screen working on runtimes that do not implement it.
 */
async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new TrackPreviewError('PREVIEW_READ_FAILED'));
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(result);
      else reject(new TrackPreviewError('PREVIEW_READ_FAILED'));
    };
    reader.readAsArrayBuffer(file);
  });
  return new Uint8Array(buffer);
}

function PreviewLifetime({
  parser,
  mapWorkerUrl,
  basemap = null,
  createMapAdapter,
  mapView,
}: LocalTrackPreviewProps) {
  const [state, dispatch] = useReducer(trackPreviewReducer, initialTrackPreviewState);
  // Every renderer report carries the geometry revision it describes, so a report about a
  // previous recording can never be shown against the current one. The map section is
  // unmounted and remounted when a file has no geometry, which resets the leaf but not
  // this state; without the revision a stale failure would outlive the failure itself.
  const [statusReport, setStatusReport] = useState<{
    revision: string;
    status: MapViewStatus;
  } | null>(null);

  // The report is tied to the geometry it describes, so a new recording shows no count
  // until its own renderer reports one. No effect resets it.
  const [rendered, setRendered] = useState<{ revision: string; count: number } | null>(null);
  const running = useRef<AbortController | null>(null);
  // The generation lives in a ref so two file choices in the same tick cannot share one.
  const generationRef = useRef(0);

  useEffect(
    () => () => {
      running.current?.abort();
      running.current = null;
    },
    [],
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

  const onFile = useCallback(
    (file: File | null) => {
      running.current?.abort();
      running.current = null;
      const generation = (generationRef.current += 1);
      if (!file) {
        dispatch({ type: 'file-cleared', generation });
        return;
      }
      const filename = sanitizeDisplayText(file.name, trackLimits.metadataTextLength);
      dispatch({ type: 'file-selected', filename, generation });
      if (!parser) {
        dispatch({ type: 'failed', generation, code: 'PREVIEW_PARSER_UNAVAILABLE' });
        return;
      }
      // The declared size is checked before any byte is read, and the parser re-checks
      // the real byte length. Neither the extension nor the MIME type is consulted.
      if (file.size === 0) {
        dispatch({ type: 'failed', generation, code: 'PREVIEW_FILE_EMPTY' });
        return;
      }
      if (file.size > trackLimits.fileBytes) {
        dispatch({ type: 'failed', generation, code: 'PREVIEW_FILE_TOO_LARGE' });
        return;
      }
      const controller = new AbortController();
      running.current = controller;
      void readFileBytes(file)
        .then((bytes) => {
          if (controller.signal.aborted) throw new TrackPreviewError('PREVIEW_CANCELLED');
          return parser.parse({ bytes, filename }, controller.signal);
        })
        .then((parsed) => {
          if (running.current === controller) running.current = null;
          dispatch({ type: 'parsed', generation, file: parsed });
        })
        .catch((error: unknown) => {
          if (running.current === controller) running.current = null;
          const code = error instanceof TrackPreviewError ? error.code : 'PREVIEW_READ_FAILED';
          if (code === 'PREVIEW_CANCELLED') dispatch({ type: 'cancelled', generation });
          else dispatch({ type: 'failed', generation, code });
        });
    },
    [parser],
  );

  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
  }, []);

  const track =
    state.status.kind === 'ready' && state.status.trackIndex !== null
      ? state.status.file.recorded[state.status.trackIndex]
      : undefined;
  const geometry = useMemo(
    () => (track ? buildPreviewGeometry(track, 'local-preview') : null),
    [track],
  );
  const summary = useMemo(() => (track ? summarizeTrack(track) : null), [track]);
  const breaks = useMemo(() => (track ? countBreaks(track) : []), [track]);
  const presentation = presentTrackPreview(state);
  const paths = useMemo(() => (geometry ? [geometry.path] : []), [geometry]);
  const onSelect = useCallback(
    (selection: MapSelection | null) => dispatch({ type: 'vertex-selected', selection }),
    [],
  );
  const revision = geometry?.path.revision ?? null;
  const onStatusChange = useCallback(
    (status: MapViewStatus) => {
      if (revision !== null) setStatusReport({ revision, status });
    },
    [revision],
  );
  const onRenderIdle = useCallback(
    (info: { renderedPathFeatures: number }) => {
      if (revision === null) return;
      setRendered((current) =>
        current?.revision === revision && current.count === info.renderedPathFeatures
          ? current
          : { revision, count: info.renderedPathFeatures },
      );
    },
    [revision],
  );
  const renderedFeatures = rendered && rendered.revision === revision ? rendered.count : 0;
  const mapUnavailable =
    statusReport?.revision === revision && statusReport.status === 'unavailable';
  const selectedSampleId =
    state.selection && geometry
      ? (geometry.vertexSampleIds[state.selection.vertexIndex] ?? null)
      : null;
  const selectedSample = track?.samples.find((sample) => sample.sampleId === selectedSampleId);
  const lastVertex = geometry ? geometry.path.positions.length - 1 : -1;

  return (
    <div className={styles.workspace}>
      <section aria-labelledby="track-preview-heading">
        <h2 id="track-preview-heading">로컬 파일 미리보기</h2>
        <p>
          선택한 FIT/GPX 파일을 이 브라우저 안에서만 해석합니다. 업로드하지 않으며 활동으로
          저장되지도 않습니다.
        </p>
        <label className={styles.file}>
          미리 볼 기록 파일
          <input
            type="file"
            data-testid="track-preview-file"
            onChange={(event) => onFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <p className={styles.note}>
          확장자와 MIME 유형은 신뢰하지 않고 내용으로 형식을 판별합니다. 압축 파일은 받지 않습니다.
        </p>
      </section>

      <section aria-labelledby="track-preview-state-heading">
        <h2 id="track-preview-state-heading">상태</h2>
        {presentation.kind === 'idle' ? (
          <StatusNotice state="empty">아직 파일을 선택하지 않았습니다.</StatusNotice>
        ) : null}
        {presentation.kind === 'loading' ? (
          <StatusNotice
            state="loading"
            action={
              <Button variant="secondary" onClick={cancel}>
                파싱 취소
              </Button>
            }
          >
            파일을 해석하고 있습니다.
          </StatusNotice>
        ) : null}
        {presentation.kind === 'cancelled' ? (
          <StatusNotice state="unavailable">
            사용자가 파싱을 취소했습니다. 저장된 것은 없습니다.
          </StatusNotice>
        ) : null}
        {presentation.kind === 'failed' ? (
          <StatusNotice state="error">
            {failureMessages[presentation.code] ?? '파일을 해석하지 못했습니다.'} (
            {presentation.code})
          </StatusNotice>
        ) : null}
        {presentation.kind === 'awaiting-selection' ? (
          <StatusNotice state="partial">
            기록이 {presentation.recordedCount}개 있습니다. 표시할 기록을 직접 선택하세요. 임의로
            합치거나 첫 기록을 고르지 않습니다.
          </StatusNotice>
        ) : null}
        {presentation.kind === 'no-track-data' ? (
          <StatusNotice state="empty">표시할 기록 트랙이 없습니다.</StatusNotice>
        ) : null}
        {presentation.kind === 'no-gps' ? (
          <StatusNotice state="partial">
            위치가 기록되지 않은 파일입니다. 지도는 표시하지 않고 요약만 보여 줍니다.
          </StatusNotice>
        ) : null}
        {presentation.kind === 'gap' ? (
          <StatusNotice state="partial">
            기록이 {breaks.reduce((sum, item) => sum + item.count, 0)}회 끊겼습니다. 끊긴 구간은
            직선으로 잇지 않습니다.
          </StatusNotice>
        ) : null}
      </section>

      {state.status.kind === 'ready' ? (
        <TrackChooser
          file={state.status.file}
          trackIndex={state.status.trackIndex}
          onSelect={(trackIndex) => dispatch({ type: 'track-selected', trackIndex })}
        />
      ) : null}

      {track && summary ? (
        <section aria-labelledby="track-preview-summary-heading">
          <h2 id="track-preview-summary-heading">기본 요약</h2>
          <dl className={styles.summary}>
            <div>
              <dt>출처</dt>
              <dd>
                로컬 파일 미리보기 · 저장 안 함 · 활동 ID 없음 (
                {track.provenance.kind === 'local-file' ? track.provenance.parserId : '알 수 없음'})
              </dd>
            </div>
            <div>
              <dt>파일 해시</dt>
              <dd>
                {track.provenance.kind === 'local-file'
                  ? `${track.provenance.format} · ${track.provenance.fileSha256.slice(0, 12)}…`
                  : '알 수 없음'}
              </dd>
            </div>
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
            <div>
              <dt>표본</dt>
              <dd>
                전체 {summary.sampleCount}개 · 위치 있음 {summary.positionedSampleCount}개 · 구간{' '}
                {summary.segmentCount}개
              </dd>
            </div>
          </dl>
          {breaks.length > 0 ? (
            <ul className={styles.breaks}>
              {breaks.map((item) => (
                <li key={item.reason}>
                  {breakLabels[item.reason]} {item.count}회
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {geometry && geometry.path.positions.length > 0 ? (
        <section aria-labelledby="track-preview-map-heading">
          <h2 id="track-preview-map-heading">경로</h2>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={() =>
                dispatch({
                  type: 'vertex-selected',
                  selection: { pathId: 'local-preview', vertexIndex: 0 },
                })
              }
            >
              시작 지점
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                dispatch({
                  type: 'vertex-selected',
                  selection: { pathId: 'local-preview', vertexIndex: lastVertex },
                })
              }
            >
              끝 지점
            </Button>
            <Button variant="secondary" onClick={() => dispatch({ type: 'whole-view' })}>
              전체 보기
            </Button>
            <Button
              variant="secondary"
              onClick={() => dispatch({ type: 'vertex-selected', selection: null })}
            >
              선택 해제
            </Button>
          </div>
          <p role="status" className={styles.note}>
            {selectedSample
              ? `선택 표본 ${selectedSample.sampleId} · ${selectedSample.recordedAt ?? '시각 미확인'} · ${
                  selectedSample.heartRateBpm === null
                    ? '심박 미확인'
                    : `${selectedSample.heartRateBpm}bpm`
                }`
              : '선택한 지점이 없습니다.'}
          </p>
          <MapLeaf
            label="로컬 파일 경로"
            paths={paths}
            selection={state.selection}
            onSelect={onSelect}
            basemap={basemap}
            fitRequest={state.fitRequest}
            onStatusChange={onStatusChange}
            loadFailureFallback={
              <p role="status" className={styles.note}>
                지도를 표시하지 못했습니다. 아래 표본 목록과 위 요약은 그대로 사용할 수 있습니다.
              </p>
            }
            onRenderIdle={onRenderIdle}
            {...(adapterFactory ? { createAdapter: adapterFactory } : {})}
            {...(mapView ? { mapView } : {})}
          />
          {rendered && rendered.revision === revision ? (
            <p role="status" className={styles.note}>
              {renderedFeatures > 0
                ? `지도가 경로를 그렸습니다 (렌더된 경로 feature ${renderedFeatures}개).`
                : '지도가 아직 경로를 그리지 않았습니다.'}
            </p>
          ) : null}
          {mapUnavailable ? (
            <p role="status" className={styles.note}>
              지도를 표시하지 못했습니다. 아래 표본 목록과 위 요약은 그대로 사용할 수 있습니다.
            </p>
          ) : null}
          {geometry.unpositionedSampleIds.length > 0 ? (
            <p className={styles.note}>
              위치 없는 표본 {geometry.unpositionedSampleIds.length}개는 측정값을 유지한 채 선에서
              제외했습니다.
            </p>
          ) : null}
          <SampleNavigator
            vertexSampleIds={geometry.vertexSampleIds}
            positions={geometry.path.positions}
            selection={state.selection}
            onSelect={onSelect}
          />
        </section>
      ) : null}
    </div>
  );
}

/**
 * Every drawn vertex, reachable without the map and without a drag.
 *
 * The kit's own coordinate list is bounded because a long recording would otherwise put
 * tens of thousands of controls in the document. That bound cannot be the only way to
 * reach a sample, so the owning module pages through all of them here: with the map
 * unavailable, a keyboard user can still reach the last vertex of a 20,000-point track.
 */
const samplesPerPage = 50;

function SampleNavigator({
  vertexSampleIds,
  positions,
  selection,
  onSelect,
}: {
  vertexSampleIds: readonly string[];
  positions: readonly (readonly [number, number])[];
  selection: MapSelection | null;
  onSelect: (selection: MapSelection | null) => void;
}) {
  const total = vertexSampleIds.length;
  const pages = Math.max(1, Math.ceil(total / samplesPerPage));
  const [page, setPage] = useState(0);
  // The selected vertex decides the page, so selecting from the map or from the start and
  // end buttons brings its page into view instead of stranding the list on page one.
  const current = selection ? Math.floor(selection.vertexIndex / samplesPerPage) : page;
  const shown = Math.min(current, pages - 1);
  const start = shown * samplesPerPage;
  const entries = positions.slice(start, start + samplesPerPage);
  if (total === 0) return null;
  return (
    <div className={styles.navigator}>
      <h3 id="track-preview-samples-heading">표본 목록</h3>
      <p className={styles.note}>
        좌표 {total}개 중 {start + 1}–{start + entries.length}번째. 지도 없이도 모든 표본을 선택할
        수 있습니다.
      </p>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={shown === 0}
          onClick={() => {
            onSelect(null);
            setPage(Math.max(0, shown - 1));
          }}
        >
          이전 표본 묶음
        </Button>
        <Button
          variant="secondary"
          disabled={shown >= pages - 1}
          onClick={() => {
            onSelect(null);
            setPage(Math.min(pages - 1, shown + 1));
          }}
        >
          다음 표본 묶음
        </Button>
        <Button
          variant="secondary"
          disabled={shown >= pages - 1}
          onClick={() => {
            onSelect(null);
            setPage(pages - 1);
          }}
        >
          마지막 묶음
        </Button>
      </div>
      <ol className={styles.samples} aria-labelledby="track-preview-samples-heading">
        {entries.map((position, offset) => {
          const index = start + offset;
          return (
            <li key={vertexSampleIds[index] ?? index}>
              <Button
                variant="secondary"
                aria-pressed={selection?.vertexIndex === index}
                onClick={() => onSelect({ pathId: 'local-preview', vertexIndex: index })}
              >
                {vertexSampleIds[index]} · {position[1].toFixed(5)}, {position[0].toFixed(5)}
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TrackChooser({
  file,
  trackIndex,
  onSelect,
}: {
  file: { recorded: readonly RecordedTrack[]; requiresSelection: boolean };
  trackIndex: number | null;
  onSelect: (index: number) => void;
}) {
  if (file.recorded.length <= 1) return null;
  return (
    <section aria-labelledby="track-preview-choice-heading">
      <h2 id="track-preview-choice-heading">기록 선택</h2>
      <p>
        파일에 기록이 {file.recorded.length}개 있습니다. 하나로 합치지 않으며 표시할 기록을 직접
        선택해야 합니다.
      </p>
      <ul className={styles.choices}>
        {file.recorded.map((recorded, index) => (
          <li key={`${recorded.provenance.kind}:${index}`}>
            <Button
              variant="secondary"
              aria-pressed={index === trackIndex}
              onClick={() => onSelect(index)}
            >
              {recorded.name ?? `기록 ${index + 1}`} · 표본 {recorded.samples.length}개
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
