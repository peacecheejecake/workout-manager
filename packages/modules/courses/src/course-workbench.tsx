'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import type { CourseCard } from '@workout/contracts/course-cards';
import type {
  CourseGeneration,
  CourseHead,
  CoursePosition,
  CoursePreference,
  CoursePreferenceUpdate,
  CourseReadResult,
  CourseThumbnailState,
} from '@workout/contracts/courses';
import type { BasemapDescriptor } from '@workout/geo-kit/basemap';
import type { MapAdapterFactory } from '@workout/geo-kit/map-adapter';
import type { MapViewProps, MapViewStatus } from '@workout/geo-kit/map-view';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { courseExportPath, createCourseApi, CourseRequestError } from './course-api';
import {
  CourseDraftProvider,
  draftMapPaths,
  useCourseDraft,
  useDraftMapSelection,
} from './course-draft-context';
import {
  accessibilityNoteSummary,
  CourseAccessibilityNotePanel,
  useAccessibilityNotes,
} from './course-accessibility-note';
import { CourseEditor } from './course-editor';
import { CourseListCardFacts, type CourseCardRead } from './course-list-card';
import { createCourseExtrasApi } from './course-extras-api';
import { CourseThumbnail, StoredCourseThumbnail } from './course-thumbnail';
import {
  CourseElevationPanel,
  CourseImportPanel,
  CoursePlaceSearch,
  CoursePrivacyPanel,
  readableExtrasError,
} from './course-extras';
import { useLayoutModeFromViewport } from './course-layout';
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
 * viewport specification: a sheet over the list on mobile; on tablet the map beside the open
 * course, whose waypoint list folds (07 §4 "지도+접히는 경유점 목록"), under a course list that
 * folds too; and map and list side by side on desktop. No breakpoint number lives in
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
  /**
   * The course named by the address, for `/courses/:id/edit` (M2-01r, S14). The screen opens
   * with it selected; whether it exists and is the caller's is the server's answer, shown as
   * such, never assumed from the address.
   */
  initialCourseId?: string;
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

/**
 * How this revision's line was made, in the owner's words. Every kind is named: a course
 * that was imported says so, and a trimmed one says it is a derived revision rather than
 * quietly looking like the line it came from.
 */
function generationLabel(generation: CourseGeneration): string {
  switch (generation.kind) {
    case 'recorded-segment':
      return '기록 구간 잘라내기';
    case 'routed-waypoints':
      return `경유지 경로 계산 · 지도 데이터 ${generation.computation.graph.graphBuildId}`;
    case 'target-distance-loop':
      return `목표 거리 후보 · 지도 데이터 ${generation.computation.graph.graphBuildId}`;
    case 'imported-file':
      return `가져온 파일 · ${generation.sourceKind === 'gpx-trk' ? 'GPX 기록(trk)' : 'GPX 경로(rte)'} · 읽은 도구 ${generation.parserId} v${generation.parserVersion}`;
    case 'privacy-trimmed':
      return `보호 구역 제거본 · 수정본 ${generation.sourceRevision}에서 파생 · 정책 v${generation.policyVersion}`;
  }
}

function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
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
export function CourseMapPane({
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
  // One selection shared with the waypoint list (M2-01r): picking a waypoint here selects
  // it there, and the list's select button marks it here.
  const [selection, setSelection] = useDraftMapSelection();
  const [status, setStatus] = useState<MapViewStatus>('preparing');
  const paths = draftMapPaths({ state, storedCoordinates });
  // `status` is the map's own, and it says "drawn" only after the renderer went idle with
  // the course line among what it drew: a style load is not enough (M2-01k F2/F3). The map
  // section carries the drawn line and point counts as data for acceptance tests.
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
      {status === 'unavailable' || status === 'not-drawn' ? (
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
  initialCourseId,
}: CourseWorkbenchProps) {
  // Created once for this screen. Held in state rather than a ref because it is read
  // during render to compose the editor, which a ref may not be.
  const [api] = useState(() => createCourseApi(transport));
  const [extrasApi] = useState(() => createCourseExtrasApi(transport));
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
  const [selected, setSelected] = useState<string | null>(initialCourseId ?? null);
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
  const [trimMessage, setTrimMessage] = useState('');
  // Ordering is a preference, not a fact about a course: the list is the owner's own.
  const [order, setOrder] = useState<'name' | 'recent'>('name');

  const list = useQuery({
    queryKey: [...scope, 'list'],
    queryFn: ({ signal }) => api.list(signal),
  });
  // The S13 card facts (M2-01k-a) are their own read under the same scope, so every write
  // that invalidates the scope refreshes them too and nothing crosses an account.
  //
  // A card describes an immutable head revision, so it is not re-read on every focus or
  // mount: a write re-reads it through the scope invalidation, and the one fact that moves
  // without a write — the stored thumbnail becoming ready — is caught below, from the
  // detail read of the course the owner opens.
  const cards = useQuery({
    queryKey: [...scope, 'cards'],
    queryFn: ({ signal }) => extrasApi.cards(signal),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const cardOf = useMemo(() => {
    const byCourse = new Map<string, CourseCard>();
    for (const card of cards.data?.cards ?? []) byCourse.set(card.course.courseId, card);
    return byCourse;
  }, [cards.data]);
  const cardRead = (courseId: string): CourseCardRead =>
    cards.isPending
      ? { status: 'pending' }
      : cards.isError
        ? { status: 'error' }
        : { status: 'ready', card: cardOf.get(courseId) };
  const detail = useQuery({
    queryKey: [...scope, 'detail', selected ?? ''],
    enabled: selected !== null,
    queryFn: ({ signal }) => api.read(selected ?? '', signal),
  });

  // Preferences (M2-01j) are private to this owner and this session's cache: the key is
  // scoped like every other one here, so a logout or an account switch cannot leave a
  // favourite mark or a last-used moment behind for the next account.
  const preferences = useQuery({
    queryKey: [...scope, 'preferences'],
    queryFn: ({ signal }) => extrasApi.preferences(signal),
  });
  const writePreference = useMutation({
    mutationFn: (input: { courseId: string; update: CoursePreferenceUpdate }) =>
      extrasApi.writePreference(input.courseId, input.update),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: [...scope, 'preferences'] });
    },
    // A preference is not course content: a failed favourite mark says so and changes
    // nothing else on the screen. It names the course it belongs to, because a favourite
    // is marked from the list and the course it is about need not be the one now open —
    // an unattributed failure would look like a failure of whatever is on screen.
    onError: (_error: unknown, input) => {
      const affected = list.data?.courses.find((course) => course.courseId === input.courseId);
      setMessage(
        `${affected ? affected.name : '이 코스'}: 기본 설정을 저장하지 못했습니다. 코스 자체는 그대로입니다.`,
      );
    },
  });

  /**
   * The privacy trim. It appends a derived revision and leaves the one it trimmed exactly
   * as it was, which is what the message says: the ledger keeps both.
   */
  const trim = useMutation({
    mutationFn: (input: { courseId: string; expectedRevision: number; zoneSetDigest: string }) =>
      api.update(
        input.courseId,
        {
          expectedRevision: input.expectedRevision,
          change: { kind: 'privacy-trim', acknowledgedZoneSetDigest: input.zoneSetDigest },
        },
        crypto.randomUUID(),
      ),
    onSuccess: async (result: CourseReadResult, input) => {
      if (input.courseId === openCourse.current)
        setTrimMessage(
          result.status === 'available'
            ? `보호 구역을 제거한 파생본을 만들었습니다. 현재 수정 번호 ${result.course.headRevision} · 이전 수정본은 그대로 남아 있습니다.`
            : '코스를 사용할 수 없습니다.',
        );
      await queries.invalidateQueries({ queryKey: scope });
    },
    onError: (error: unknown, input) => {
      if (input.courseId === openCourse.current) setTrimMessage(readableExtrasError(error));
      if (error instanceof CourseRequestError && [404, 409, 410].includes(error.status))
        void queries.invalidateQueries({ queryKey: scope });
    },
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

  const preferenceOf = useMemo(() => {
    const byCourse = new Map<string, CoursePreference>();
    for (const preference of preferences.data?.preferences ?? [])
      byCourse.set(preference.courseId, preference);
    return byCourse;
  }, [preferences.data]);
  const courses: readonly CourseHead[] = useMemo(() => {
    const stored = list.data?.courses ?? [];
    // Favourites first in both orders, because that is what the mark is for. The rest is
    // either the stored order or the owner's own last-used moments; a course never used
    // sorts last rather than pretending to a date.
    return [...stored].sort((left, right) => {
      const leftPreference = preferenceOf.get(left.courseId);
      const rightPreference = preferenceOf.get(right.courseId);
      const favourite =
        Number(rightPreference?.favourite ?? false) - Number(leftPreference?.favourite ?? false);
      if (favourite !== 0) return favourite;
      if (order === 'recent') {
        const leftUsed = leftPreference?.lastUsedAt ?? '';
        const rightUsed = rightPreference?.lastUsedAt ?? '';
        if (leftUsed !== rightUsed) return leftUsed < rightUsed ? 1 : -1;
      }
      return left.name.localeCompare(right.name);
    });
  }, [list.data, preferenceOf, order]);
  const current = detail.data ?? null;
  // The detail read of the open course already knows its stored picture is ready while its
  // card still says otherwise: the picture was made after the card was read. `ready` is
  // final for a revision, so this asks once and cannot loop.
  const openCard = current?.status === 'available' ? cardOf.get(current.course.courseId) : null;
  const cardThumbnailBehind =
    current?.status === 'available' &&
    openCard?.status === 'available' &&
    openCard.course.headRevision === current.course.headRevision &&
    current.thumbnail.status === 'ready' &&
    openCard.thumbnail.state.status !== 'ready';
  useEffect(() => {
    if (cardThumbnailBehind)
      void queries.invalidateQueries({
        queryKey: ['users', athleteId, 'sessions', sessionId, 'courses', 'cards'],
      });
  }, [cardThumbnailBehind, queries, athleteId, sessionId]);
  // The course named by the address has no list click to carry its name into the rename
  // field, so it is taken from the course once it has been read — once, so it never
  // overwrites what the owner has started typing.
  const [namedFromAddress, setNamedFromAddress] = useState(false);
  if (
    !namedFromAddress &&
    initialCourseId !== undefined &&
    current?.status === 'available' &&
    current.course.courseId === initialCourseId
  ) {
    setNamedFromAddress(true);
    setName(current.course.name);
  }
  // Opening a course by its address is opening it, exactly as a list click is: the moment
  // is the server's own. Only once the server has answered that the course is this owner's
  // and available — an address naming someone else's course is a "not found", not a use.
  const markUsed = writePreference.mutate;
  const openedFromAddress = namedFromAddress ? initialCourseId : undefined;
  useEffect(() => {
    if (openedFromAddress !== undefined)
      markUsed({ courseId: openedFromAddress, update: { markUsed: true } });
  }, [openedFromAddress, markUsed]);
  const accessibilityNotes = useAccessibilityNotes(extrasApi, scope);

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

  /**
   * Six different facts, said six different ways.
   *
   * "Not there yet", "cannot be made", "failed and coming back" and "failed for good" are not
   * the same answer, and the owner is told which one it is rather than being shown one
   * silence for all of them. In every case but `ready` the picture beside this line is the
   * drawn one, which is why none of these is an error.
   */
  function thumbnailLabel(state: CourseThumbnailState): string {
    if (state.status === 'ready') return '저장된 썸네일을 보고 있습니다.';
    if (state.status === 'pending') return '썸네일을 만드는 중입니다. 지금은 직접 그린 그림입니다.';
    if (state.status === 'unavailable')
      return '이 선으로는 썸네일을 만들 수 없습니다. 직접 그린 그림입니다.';
    if (state.status === 'retrying')
      return `썸네일 만들기가 실패해 다시 시도합니다(${state.attemptCount}번째). 지금은 직접 그린 그림입니다.`;
    if (state.status === 'abandoned')
      return '썸네일 만들기를 더 시도하지 않습니다. 직접 그린 그림입니다.';
    return '저장된 썸네일이 없습니다. 직접 그린 그림입니다.';
  }

  const detailBody =
    current?.status === 'available' ? (
      <div className={styles.detail}>
        <h3>{current.course.name}</h3>
        {/*
          The stored picture when there is one for THIS head revision, and the drawn one
          otherwise. Both come from the same projection and the same coordinates, so a
          privacy-trimmed course shows its trimmed line either way — and the stored picture
          of the pre-trim line was superseded and queued for reclamation by the trim itself.
        */}
        {current.thumbnail.status === 'ready' ? (
          <StoredCourseThumbnail
            courseId={current.course.courseId}
            sessionId={sessionId}
            contentHash={current.thumbnail.contentHash}
            coordinates={current.revision.geometry.coordinates}
            label={`${current.course.name} 선 미리보기 (수정 번호 ${current.course.headRevision})`}
          />
        ) : (
          <CourseThumbnail
            coordinates={current.revision.geometry.coordinates}
            label={`${current.course.name} 선 미리보기 (수정 번호 ${current.course.headRevision})`}
          />
        )}
        <p data-testid="course-thumbnail-state">{thumbnailLabel(current.thumbnail)}</p>
        <dl>
          <dt>현재 수정 번호</dt>
          <dd data-testid="course-revision">{current.course.headRevision}</dd>
          <dt>계획 선 길이</dt>
          <dd>{metres(current.revision.distanceMeters)}</dd>
          <dt>경유점</dt>
          <dd>{current.revision.waypoints.length}개</dd>
          <dt>만들어진 방법</dt>
          <dd data-testid="course-generation">{generationLabel(current.revision.generation)}</dd>
          <dt>출처 기록</dt>
          <dd>
            {current.revision.lineage.length === 0
              ? '없음 · 가져온 파일에서 만든 코스입니다'
              : current.revision.lineage
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
      <p>
        <a href="/courses/new">새 코스 만들기</a>
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
        <p>
          아직 저장한 코스가 없습니다. 활동 상세의 경로 탭에서 구간을 고르거나, 새 코스 만들기에서
          지도에 지점을 놓아 만들 수 있습니다.
        </p>
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
            <Button
              className={styles.listControl}
              variant="secondary"
              aria-pressed={order === 'recent'}
              onClick={() => setOrder((value) => (value === 'name' ? 'recent' : 'name'))}
            >
              {order === 'name' ? '최근 사용순으로 보기' : '이름순으로 보기'}
            </Button>
            <ul className={styles.list} aria-label="코스 목록">
              {courses.map((course) => (
                <li key={course.courseId}>
                  <Button
                    id={`course-name-${course.courseId}`}
                    variant={selected === course.courseId ? 'primary' : 'secondary'}
                    aria-pressed={selected === course.courseId}
                    onClick={() => {
                      setSelected(course.courseId);
                      setName(course.name);
                      setMessage('');
                      setTrimMessage('');
                      setPicked(null);
                      setFitRequest((value) => value + 1);
                      // Opening a course is what "used" means here, and the moment is the
                      // server's own: a client cannot backdate it.
                      writePreference.mutate({
                        courseId: course.courseId,
                        update: { markUsed: true },
                      });
                    }}
                  >
                    {preferenceOf.get(course.courseId)?.favourite ? '★ ' : ''}
                    {course.name}
                  </Button>
                  {/*
                    The favourite toggle names the action, and `aria-describedby` points at
                    the course button beside it so assistive technology still reads which
                    course it belongs to. Putting the course name *in* this button's own
                    accessible name would make two controls in the same row answer to that
                    name, which is ambiguous for a screen-reader user working by name and
                    for anything else that addresses a control by its name.
                  */}
                  <Button
                    variant="secondary"
                    aria-label={
                      preferenceOf.get(course.courseId)?.favourite ? '즐겨찾기 해제' : '즐겨찾기'
                    }
                    aria-describedby={`course-name-${course.courseId}`}
                    aria-pressed={preferenceOf.get(course.courseId)?.favourite ?? false}
                    // Read from the list, which is refreshed after the write settles. Two
                    // fast clicks therefore send the same value twice: the write is an
                    // idempotent set of one field rather than a toggle on the server, so
                    // the stored value is what the last click asked for either way, and
                    // the second click looks ignored rather than producing a wrong mark.
                    onClick={() =>
                      writePreference.mutate({
                        courseId: course.courseId,
                        update: {
                          favourite: !(preferenceOf.get(course.courseId)?.favourite ?? false),
                        },
                      })
                    }
                  >
                    {preferenceOf.get(course.courseId)?.favourite ? '즐겨찾기 해제' : '즐겨찾기'}
                  </Button>
                  <span>
                    {course.status === 'available'
                      ? `수정 번호 ${course.headRevision}`
                      : '사용 불가 · 원본 기록 삭제됨'}
                    {` · ${accessibilityNoteSummary(
                      accessibilityNotes.byCourse.get(course.courseId),
                      course.status === 'available' ? course.headRevision : null,
                      accessibilityNotes,
                    )}`}
                  </span>
                  <CourseListCardFacts
                    courseName={course.name}
                    sessionId={sessionId}
                    read={cardRead(course.courseId)}
                    lastUsed={
                      preferences.isPending
                        ? { status: 'pending' }
                        : preferences.isError
                          ? { status: 'error' }
                          : {
                              status: 'ready',
                              lastUsedAt: preferenceOf.get(course.courseId)?.lastUsedAt ?? null,
                            }
                    }
                  />
                </li>
              ))}
            </ul>
            <CourseImportPanel
              api={extrasApi}
              onImported={(result) => {
                void queries.invalidateQueries({ queryKey: scope });
                setSelected(result.course.courseId);
                setName(result.course.name);
                setFitRequest((value) => value + 1);
              }}
            />
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
            {detail.isError && selected !== null ? (
              <p role="alert">{readableError(detail.error)}</p>
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
                  elevation={extrasApi}
                  current={current}
                  pickedPosition={picked}
                  onSaved={onSaved}
                  onStale={onSaved}
                />
                <CoursePlaceSearch
                  api={extrasApi}
                  onPick={(position, placeName) => {
                    // The editor already knows how to turn a picked position into a
                    // waypoint; a searched place is one more way to pick one.
                    setPicked(position);
                    setMessage(`선택한 장소: ${placeName}`);
                  }}
                />
                <CourseAccessibilityNotePanel
                  key={`accessibility-note:${current.course.courseId}`}
                  api={extrasApi}
                  scope={scope}
                  courseId={current.course.courseId}
                  headRevision={current.course.headRevision}
                />
                <CourseElevationPanel
                  api={extrasApi}
                  scope={scope}
                  courseId={current.course.courseId}
                />
                <CoursePrivacyPanel
                  api={extrasApi}
                  scope={scope}
                  courseId={current.course.courseId}
                  headRevision={current.course.headRevision}
                  generationKind={current.revision.generation.kind}
                  onTrim={(input) => trim.mutate(input)}
                  trimMessage={trimMessage}
                />
              </>
            ) : null}
          </div>
        </div>
      </CourseDraftProvider>
    </section>
  );
}
