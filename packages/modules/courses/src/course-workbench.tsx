'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type FormEvent,
} from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type { CourseHead, CoursePosition, CourseReadResult } from '@workout/contracts/courses';
import type { BasemapDescriptor } from '@workout/geo-kit/basemap';
import type { MapAdapterFactory } from '@workout/geo-kit/map-adapter';
import type { MapSelection } from '@workout/geo-kit/map-path';
import type { MapViewProps, MapViewStatus } from '@workout/geo-kit/map-view';
import { Button } from '@workout/ui-foundation/button';
import { getLayoutMode, type LayoutMode } from '@workout/ui-foundation/responsive';
import { TextField } from '@workout/ui-foundation/text-field';
import { courseExportPath, createCourseApi, CourseRequestError } from './course-api';
import { CourseDraftProvider, draftMapPaths, useCourseDraft } from './course-draft-context';
import { CourseEditor } from './course-editor';
import { CourseMapLeaf } from './course-map-leaf';
import styles from './courses.module.css';

/**
 * S13 course list and detail, with the S14 waypoint editor composed into it.
 *
 * Courses are private. This screen has no sharing control, because the server has no
 * sharing route; it offers the owner's own GPX download and nothing else that leaves the
 * account. Every write sends the revision the screen was showing, so a course changed
 * elsewhere produces a visible conflict instead of a silent overwrite.
 *
 * The three S13 compositions are one DOM whose panes are shown and hidden by the generated
 * viewport specification: a sheet over the list on mobile, a collapsible list beside the
 * detail on tablet, and map and list side by side on desktop. No breakpoint number lives in
 * this package — the mode arrives as `data-layout` and the stylesheet reads only that — and
 * the draft, the selection and the map renderer all sit above the switch, so changing width
 * never restarts an edit.
 */
export interface CourseWorkbenchProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  /** Self-hosted background map descriptor, or `null` for "no background", a real state. */
  basemap?: BasemapDescriptor | null;
  /** Same-origin module URL of the renderer worker, when the shell hosts one. */
  mapWorkerUrl?: string;
  /** Injected by tests; production uses the module-scope lazy renderer. */
  mapView?: ComponentType<MapViewProps>;
  createMapAdapter?: MapAdapterFactory;
}

export function CourseWorkbench(props: CourseWorkbenchProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workbench {...props} />
    </QueryClientProvider>
  );
}

function readableError(error: unknown): string {
  if (!(error instanceof CourseRequestError)) return '요청을 완료하지 못했습니다.';
  if (error.status === 409)
    return '다른 변경이 먼저 저장되었습니다. 최신 코스를 다시 불러온 뒤 시도하세요.';
  if (error.status === 410) return '원본 기록이 삭제되어 이 코스는 더 이상 사용할 수 없습니다.';
  if (error.status === 404) return '코스를 찾을 수 없습니다.';
  return '입력을 확인한 뒤 다시 시도하세요.';
}

function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
}

function subscribeToViewport(onChange: () => void) {
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
  };
}

/**
 * Layout mode from the **generated** viewport specification, never from a breakpoint copied
 * into this package and never from the user agent. The server snapshot is the narrowest
 * mode, so the first paint is the one that fits everywhere.
 */
function useLayoutModeFromViewport(): LayoutMode {
  return useSyncExternalStore(
    subscribeToViewport,
    () => getLayoutMode(window.innerWidth),
    () => 'mobile' as const,
  );
}

/**
 * The owner's GPX download.
 *
 * A plain navigation cannot carry the session header the API requires for a cookie
 * session, so the anchor keeps its real `href` — visible, keyboard reachable and the same
 * address the API serves — while the click performs the authenticated read itself and
 * hands the bytes to the browser.
 *
 * Two checks bound it to the session that started it. The request carries an abort signal
 * that the screen fires when it goes away, and the private bytes are turned into an object
 * URL **only after** the reply has arrived and the session is still the one that asked.
 * Revoking afterwards would not help: a download already handed to the browser cannot be
 * taken back, so it must never be handed over in the first place.
 */
async function downloadCourseGpx(input: {
  readonly courseId: string;
  readonly sessionId: string;
  readonly fileName: string;
  readonly signal: AbortSignal;
  readonly stillCurrent: () => boolean;
}) {
  const response = await fetch(courseExportPath(input.courseId), {
    method: 'GET',
    headers: { 'x-workout-session-id': input.sessionId },
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: input.signal,
  });
  if (!response.ok) throw new CourseRequestError(response.status, 'EXPORT_FAILED');
  const blob = await response.blob();
  if (input.signal.aborted || !input.stillCurrent()) return;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = input.fileName;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * The map pane. It reads the draft directly, so a waypoint move repaints the marker layer
 * without the surrounding screen re-deriving anything, and the renderer itself is created
 * once per mounted pane rather than per layout.
 */
function CourseMapPane({
  storedCoordinates,
  basemap,
  mapView,
  createMapAdapter,
  onPickPosition,
  fitRequest,
}: {
  readonly storedCoordinates: readonly CoursePosition[];
  readonly basemap: BasemapDescriptor | null;
  readonly mapView?: ComponentType<MapViewProps>;
  readonly createMapAdapter?: MapAdapterFactory;
  readonly onPickPosition: (position: CoursePosition) => void;
  readonly fitRequest: number;
}) {
  const state = useCourseDraft((value) => value);
  const [selection, setSelection] = useState<MapSelection | null>(null);
  const [status, setStatus] = useState<MapViewStatus>('preparing');
  const paths = draftMapPaths({ state, storedCoordinates });
  return (
    <div className={`${styles.pane} ${styles.mapPane}`} data-pane="map">
      <CourseMapLeaf
        label="코스 지도"
        paths={paths}
        selection={selection}
        onSelect={setSelection}
        onPickPosition={(position) => onPickPosition([position[0], position[1]])}
        basemap={basemap}
        fitRequest={fitRequest}
        onStatusChange={setStatus}
        {...(mapView ? { mapView } : {})}
        {...(createMapAdapter ? { createAdapter: createMapAdapter } : {})}
        loadFailureFallback={
          <p role="status">
            지도를 불러오지 못했습니다. 아래 목록과 좌표 입력으로 계속 편집할 수 있습니다.
          </p>
        }
      />
      {status === 'unavailable' ? (
        <p className={styles.note}>
          지도를 표시할 수 없습니다. 경유점 목록과 좌표 입력만으로 편집과 저장이 가능합니다.
        </p>
      ) : null}
    </div>
  );
}

function Workbench({
  athleteId,
  sessionId,
  transport,
  basemap = null,
  mapWorkerUrl,
  mapView,
  createMapAdapter,
}: CourseWorkbenchProps) {
  // Created once for this screen. Held in state rather than a ref because it is read
  // during render to compose the editor, which a ref may not be.
  const [api] = useState(() => createCourseApi(transport));
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
  // The session this screen belongs to. An in-flight download is aborted when the screen
  // goes away, which is what the shell does on logout and on an account switch, and the
  // session it started under is compared again before any byte is handed to the browser.
  const live = useRef({ session: sessionId, active: true });
  const downloads = useRef(new Set<AbortController>());
  useEffect(() => {
    const started = downloads.current;
    const current = live.current;
    current.session = sessionId;
    current.active = true;
    return () => {
      current.active = false;
      for (const controller of started) controller.abort();
      started.clear();
    };
  }, [sessionId]);
  const queries = useQueryClient();
  const layout = useLayoutModeFromViewport();
  const scope = ['users', athleteId, 'sessions', sessionId, 'courses'] as const;
  const [selected, setSelected] = useState<string | null>(null);
  // Which course is open right now, readable from a callback that was created earlier. A
  // write started on one course must not report itself — or act — on whichever course
  // happens to be open when it lands.
  const openCourse = useRef<string | null>(null);
  useEffect(() => {
    openCourse.current = selected;
  }, [selected]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [listCollapsed, setListCollapsed] = useState(false);
  const [picked, setPicked] = useState<CoursePosition | null>(null);
  const [fitRequest, setFitRequest] = useState(0);

  const list = useQuery({
    queryKey: [...scope, 'list'],
    queryFn: ({ signal }) => api.list(signal),
  });
  const detail = useQuery({
    queryKey: [...scope, 'detail', selected ?? ''],
    enabled: selected !== null,
    queryFn: ({ signal }) => api.read(selected ?? '', signal),
  });

  const rename = useMutation({
    mutationFn: (input: { courseId: string; expectedRevision: number; name: string }) =>
      api.update(
        input.courseId,
        { expectedRevision: input.expectedRevision, change: { kind: 'rename', name: input.name } },
        crypto.randomUUID(),
      ),
    onSuccess: async (result: CourseReadResult) => {
      // The refetch is always right — the ledger did change. Saying so on screen is only
      // right while the course it happened to is the one being shown.
      if (result.course.courseId === openCourse.current)
        setMessage(
          result.status === 'available'
            ? `이름을 저장했습니다. 현재 수정 번호 ${result.course.headRevision}`
            : '코스를 사용할 수 없습니다.',
        );
      await queries.invalidateQueries({ queryKey: scope });
    },
    onError: (error: unknown, input) => {
      if (input.courseId === openCourse.current) setMessage(readableError(error));
      // A refused write means the screen is looking at something the server does not have.
      // Reading it again is what lets the draft notice a stored change at all.
      if (error instanceof CourseRequestError && [404, 409, 410].includes(error.status))
        void queries.invalidateQueries({ queryKey: scope });
    },
  });

  const remove = useMutation({
    mutationFn: (input: { courseId: string; expectedRevision: number }) =>
      api.remove(input.courseId, input.expectedRevision),
    onSuccess: async (_result, input) => {
      // Closing the detail is only correct for the course that was deleted. Doing it
      // unconditionally closed whichever course the owner had opened in the meantime.
      if (input.courseId === openCourse.current) {
        setSelected(null);
        setMessage('코스를 삭제했습니다.');
      }
      await queries.invalidateQueries({ queryKey: scope });
    },
    // Failures are scoped like successes. A delete that fails after the owner has opened
    // another course has nothing to say about the course they are looking at.
    onError: (error: unknown, input) => {
      if (input.courseId === openCourse.current) setMessage(readableError(error));
    },
  });

  const courses: readonly CourseHead[] = list.data?.courses ?? [];
  const current = detail.data ?? null;

  const onSaved = useCallback(() => {
    void queries.invalidateQueries({ queryKey: scope });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries, athleteId, sessionId]);

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (current === null || current.status !== 'available') return;
    rename.mutate({
      courseId: current.course.courseId,
      expectedRevision: current.course.headRevision,
      name,
    });
  }

  const detailBody =
    current?.status === 'available' ? (
      <div className={styles.detail}>
        <h3>{current.course.name}</h3>
        <dl>
          <dt>현재 수정 번호</dt>
          <dd data-testid="course-revision">{current.course.headRevision}</dd>
          <dt>계획 선 길이</dt>
          <dd>{metres(current.revision.distanceMeters)}</dd>
          <dt>경유점</dt>
          <dd>{current.revision.waypoints.length}개</dd>
          <dt>만들어진 방법</dt>
          <dd data-testid="course-generation">
            {current.revision.generation.kind === 'routed-waypoints'
              ? `경유지 경로 계산 · 지도 데이터 ${current.revision.generation.computation.graph.graphBuildId}`
              : '기록 구간 잘라내기'}
          </dd>
          <dt>출처 기록</dt>
          <dd>
            {current.revision.lineage
              .map(
                (source) =>
                  `활동 ${source.activityId.slice(0, 8)} · 기록본 ${source.trackRevision}`,
              )
              .join(', ')}
          </dd>
        </dl>
        <p className={styles.note}>
          계획 선 길이는 이 코스 선의 길이입니다. 기기 보고 거리·GPS 재계산 거리·경로 계산 예상
          거리와 다른 값입니다.
        </p>
        <form onSubmit={submitRename}>
          <TextField
            label="코스 이름"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={rename.isPending}>
            이름 저장
          </Button>
        </form>
        <a
          className={styles.download}
          href={courseExportPath(current.course.courseId)}
          download
          data-testid="course-export"
          onClick={(event) => {
            event.preventDefault();
            const controller = new AbortController();
            const exportedCourseId = current.course.courseId;
            downloads.current.add(controller);
            void downloadCourseGpx({
              courseId: exportedCourseId,
              sessionId,
              fileName: `${current.revision.name}-r${current.course.headRevision}.gpx`,
              signal: controller.signal,
              stillCurrent: () => live.current.active && live.current.session === sessionId,
            })
              .catch((error: unknown) => {
                // Same rule as the writes: a failed download reports itself only while the
                // course it was started for is the one on screen.
                if (
                  live.current.active &&
                  !controller.signal.aborted &&
                  exportedCourseId === openCourse.current
                )
                  setMessage(readableError(error));
              })
              .finally(() => downloads.current.delete(controller));
          }}
        >
          GPX 내보내기
        </a>
        <Button
          variant="danger"
          onClick={() =>
            remove.mutate({
              courseId: current.course.courseId,
              expectedRevision: current.course.headRevision,
            })
          }
        >
          코스 삭제
        </Button>
      </div>
    ) : null;

  return (
    <section className={styles.workbench} aria-label="내 코스" data-layout={layout}>
      <h2>내 코스</h2>
      <p className={styles.note}>
        코스는 비공개입니다. 공개 공유 기능은 없으며, 내보내기는 본인 인증 다운로드입니다.
      </p>
      {message ? <p role="status">{message}</p> : null}
      {list.isPending ? <p role="status">코스를 불러오는 중입니다.</p> : null}
      {list.isError ? (
        <div role="group" aria-label="코스 목록 오류">
          <p role="alert">코스 목록을 불러오지 못했습니다.</p>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            다시 불러오기
          </Button>
        </div>
      ) : null}
      {list.isSuccess && courses.length === 0 ? (
        <p>아직 저장한 코스가 없습니다. 활동 상세의 경로 탭에서 구간을 골라 만들 수 있습니다.</p>
      ) : null}

      <CourseDraftProvider
        courseId={current?.status === 'available' ? current.course.courseId : ''}
        headRevision={current?.status === 'available' ? current.course.headRevision : 0}
        waypoints={current?.status === 'available' ? current.revision.waypoints : []}
      >
        <div
          className={styles.panes}
          data-layout={layout}
          data-sheet={selected !== null ? 'open' : 'closed'}
          data-list={listCollapsed ? 'collapsed' : 'expanded'}
        >
          {/*
            The map pane and the editor are keyed by the course. Everything in them belongs
            to one course and must not outlive it: the renderer's selection, and the
            editor's requests and local state. Leaving that to unmount was not enough —
            switching to a course that is already cached produces no loading gap, so React
            reused the same editor and the previous course's computation went on running
            inside it, cancel button and all, on a screen showing something else.
          */}
          {current?.status === 'available' ? (
            <CourseMapPane
              key={current.course.courseId}
              storedCoordinates={current.revision.geometry.coordinates}
              basemap={stableBasemap}
              fitRequest={fitRequest}
              onPickPosition={setPicked}
              {...(mapView ? { mapView } : {})}
              {...(adapterFactory ? { createMapAdapter: adapterFactory } : {})}
            />
          ) : null}

          <div className={`${styles.pane} ${styles.listPane}`} data-pane="list">
            {layout === 'tablet' ? (
              <Button
                variant="secondary"
                aria-expanded={!listCollapsed}
                onClick={() => setListCollapsed((value) => !value)}
              >
                {listCollapsed ? '코스 목록 펼치기' : '코스 목록 접기'}
              </Button>
            ) : null}
            <ul className={styles.list} aria-label="코스 목록">
              {courses.map((course) => (
                <li key={course.courseId}>
                  <Button
                    variant={selected === course.courseId ? 'primary' : 'secondary'}
                    aria-pressed={selected === course.courseId}
                    onClick={() => {
                      setSelected(course.courseId);
                      setName(course.name);
                      setMessage('');
                      setPicked(null);
                      setFitRequest((value) => value + 1);
                    }}
                  >
                    {course.name}
                  </Button>
                  <span>
                    {course.status === 'available'
                      ? `수정 번호 ${course.headRevision}`
                      : '사용 불가 · 원본 기록 삭제됨'}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className={`${styles.pane} ${styles.sheetPane}`} data-pane="sheet">
            {layout === 'mobile' && selected !== null ? (
              <Button variant="secondary" onClick={() => setSelected(null)}>
                코스 목록으로 돌아가기
              </Button>
            ) : null}
            {detail.isPending && selected !== null ? (
              <p role="status">코스를 여는 중입니다.</p>
            ) : null}
            {current?.status === 'unavailable' ? (
              <div role="group" aria-label="사용할 수 없는 코스">
                <p role="alert">
                  {current.course.name}: 이 코스가 만들어진 활동 기록이 삭제되어 경로를 더 이상
                  사용할 수 없습니다. 참조만 남아 있습니다.
                </p>
                <Button
                  variant="danger"
                  onClick={() =>
                    remove.mutate({ courseId: current.course.courseId, expectedRevision: 1 })
                  }
                >
                  이 참조 삭제
                </Button>
              </div>
            ) : null}
            {current?.status === 'available' ? (
              <>
                {picked ? (
                  <p className={styles.note} data-testid="picked-position">
                    선택한 위치: {picked[1].toFixed(5)}, {picked[0].toFixed(5)}
                  </p>
                ) : null}
                {detailBody}
                <CourseEditor
                  key={current.course.courseId}
                  api={api}
                  current={current}
                  pickedPosition={picked}
                  onSaved={onSaved}
                  onStale={onSaved}
                />
              </>
            ) : null}
          </div>
        </div>
      </CourseDraftProvider>
    </section>
  );
}
