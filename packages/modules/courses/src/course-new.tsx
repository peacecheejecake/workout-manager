'use client';

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type { CourseCreateRequest, CoursePosition } from '@workout/contracts/courses';
import type { BasemapDescriptor } from '@workout/geo-kit/basemap';
import type { MapAdapterFactory } from '@workout/geo-kit/map-adapter';
import type { MapViewProps } from '@workout/geo-kit/map-view';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { courseNameSchema } from '@workout/contracts/courses';
import { createCourseApi, CourseRequestError, type CourseApi } from './course-api';
import { currentRoute, draftRequestWaypoints } from './course-draft';
import { CourseDraftProvider, useCourseDraft, useCourseDraftStore } from './course-draft-context';
import { outcomes, provesNothingWasStored, RouteReviewSummary } from './course-editor';
import { CoursePlaceSearch } from './course-extras';
import { createCourseExtrasApi } from './course-extras-api';
import { WaypointListEditor } from './course-waypoint-list';
import { useLayoutModeFromViewport } from './course-layout';
import { CourseMapPane } from './course-workbench';
import styles from './courses.module.css';

/**
 * S14 `/courses/new` (M2-01r): a course started on an empty map.
 *
 * The same screen parts as editing a stored course — the same map pane, the same waypoint
 * list with its select, reorder, lock, move, remove and coordinate input, the same place
 * search and the same review summary — composed around a draft that is not a course yet.
 * Search → start, via and finish points → foot routing → review → save, in that order.
 *
 * Three rules, the same ones the stored-course editor keeps:
 *
 * 1. **An answer belongs to one draft.** The draft revision travels with the request and
 *    comes back with the answer; a draft that moved on discards it.
 * 2. **Nothing is saved without review**, and what is saved is what was reviewed. A preview
 *    stores nothing. Saving asks the server to compute again, and the server writes its own
 *    answer only when it is the reviewed line on the reviewed graph.
 * 3. **An uncomputed draft is never a course.** Until a route is computed for the draft on
 *    screen, the only line on the map is the dashed uncomputed one and the save control
 *    does nothing.
 */
export interface NewCourseWorkbenchProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  basemap?: BasemapDescriptor | null;
  mapWorkerUrl?: string;
  mapView?: ComponentType<MapViewProps>;
  createMapAdapter?: MapAdapterFactory;
  /** Where the shell takes the owner once the course exists, by its id. */
  onCreated: (courseId: string) => void;
}

const createErrors: Record<string, string> = {
  ROUTE_PREVIEW_CHANGED:
    '저장하려고 다시 계산한 경로가 검토한 경로와 달랐습니다. 저장된 것은 없습니다. 다시 계산해 새 결과를 검토하세요.',
  ROUTE_PREVIEW_NOT_REPRODUCED:
    '저장하려고 다시 계산했지만 검토한 경로를 다시 얻지 못했습니다. 저장된 것은 없습니다. 다시 계산하세요.',
  COURSE_GRAPH_ACKNOWLEDGEMENT_STALE:
    '그 사이 경로 계산에 쓰는 지도 데이터가 바뀌었습니다. 저장된 것은 없습니다. 다시 계산하세요.',
  ROUTING_NOT_CONFIGURED: '이 서버에는 경로 계산 기능이 구성되어 있지 않습니다.',
  COURSE_QUOTA_EXCEEDED: '코스를 더 만들 수 없습니다. 쓰지 않는 코스를 지운 뒤 시도하세요.',
};

/**
 * Everything on this screen — the picked position, the draft, the review — belongs to one
 * owner and one session, so the whole screen is keyed by them: a logout or an account switch
 * starts from nothing rather than handing one owner's unsaved points to the next.
 */
export function NewCourseWorkbench(props: NewCourseWorkbenchProps) {
  return <NewCourseScreen key={`${props.athleteId}:${props.sessionId}`} {...props} />;
}

function NewCourseScreen({
  athleteId,
  sessionId,
  transport,
  basemap = null,
  mapWorkerUrl,
  mapView,
  createMapAdapter,
  onCreated,
}: NewCourseWorkbenchProps) {
  const [api] = useState(() => createCourseApi(transport));
  const [extrasApi] = useState(() => createCourseExtrasApi(transport));
  const layout = useLayoutModeFromViewport();
  const [picked, setPicked] = useState<CoursePosition | null>(null);
  const [placeMessage, setPlaceMessage] = useState('');
  const adapterFactory = useMemo<MapAdapterFactory | undefined>(() => {
    if (createMapAdapter) return createMapAdapter;
    if (!mapWorkerUrl) return undefined;
    return async (options) => {
      const module = await import('@workout/geo-kit/maplibre-adapter');
      module.configureMapWorker(mapWorkerUrl);
      return module.createMapLibreAdapter(options);
    };
  }, [mapWorkerUrl, createMapAdapter]);
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
  return (
    <section className={styles.workbench} aria-label="새 코스" data-layout={layout}>
      <h2>새 코스</h2>
      <p className={styles.note}>
        지도에서 위치를 고르거나 장소를 검색해 시작·경유·끝 지점을 놓고, 보행 경로를 계산해 검토한
        뒤 저장합니다. 코스는 비공개입니다.
      </p>
      <p>
        <a href="/courses">내 코스 목록으로</a>
      </p>
      <CourseDraftProvider
        courseId={`new:${athleteId}:${sessionId}`}
        headRevision={0}
        waypoints={noWaypoints}
      >
        <div className={styles.newPanes} data-layout={layout}>
          <NewCourseMap
            basemap={stableBasemap}
            onPickPosition={setPicked}
            {...(mapView ? { mapView } : {})}
            {...(adapterFactory ? { createMapAdapter: adapterFactory } : {})}
          />
          <div className={styles.pane} data-pane="draft">
            {picked ? (
              <p className={styles.note} data-testid="picked-position">
                선택한 위치: {picked[1].toFixed(5)}, {picked[0].toFixed(5)}
              </p>
            ) : null}
            {placeMessage ? <p role="status">{placeMessage}</p> : null}
            <CoursePlaceSearch
              api={extrasApi}
              onPick={(position, placeName) => {
                setPicked(position);
                setPlaceMessage(`선택한 장소: ${placeName}`);
              }}
            />
            <NewCourseEditor
              api={api}
              sessionId={sessionId}
              pickedPosition={picked}
              onCreated={onCreated}
            />
          </div>
        </div>
      </CourseDraftProvider>
    </section>
  );
}

/**
 * The map of a new draft. There is no stored course to frame, so the view is fitted to the
 * points each time one is added or removed: fitting once, to the first point alone, left
 * every later point off screen (seen in the real renderer, M2-01r visual check).
 */
function NewCourseMap(
  props: Omit<Parameters<typeof CourseMapPane>[0], 'storedCoordinates' | 'fitRequest'>,
) {
  const count = useCourseDraft((state) => state.waypoints.length);
  return <CourseMapPane {...props} storedCoordinates={noCoordinates} fitRequest={count} />;
}

const noWaypoints: readonly never[] = [];
const noCoordinates: readonly never[] = [];

export interface NewCourseEditorProps {
  readonly api: CourseApi;
  readonly sessionId: string;
  readonly pickedPosition: CoursePosition | null;
  readonly onCreated: (courseId: string) => void;
}

/**
 * Compute, review and save one new course. Reads and writes the draft of the provider it is
 * rendered in; everything it asks the server is bound to the draft revision it asked for.
 */
export function NewCourseEditor({
  api,
  sessionId,
  pickedPosition,
  onCreated,
}: NewCourseEditorProps) {
  const store = useCourseDraftStore();
  const state = useCourseDraft((value) => value);
  const route = currentRoute(state);
  const [message, setMessage] = useState('');
  const [computing, setComputing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  /** The server's digest of each previewed line, by the request that produced it. */
  const [digests, setDigests] = useState<ReadonlyMap<string, string>>(new Map());
  /** What the owner actually read: one preview of one draft, nothing it could be mistaken for. */
  const [reviewed, setReviewed] = useState<{ requestId: string; draftRevision: number } | null>(
    null,
  );
  const abort = useRef<AbortController | null>(null);
  const command = useRef<{ fingerprint: string; key: string } | null>(null);
  // The session this screen was opened under. A reply that arrives after it has gone — a
  // logout, an account switch — speaks for nobody on screen and must not navigate anywhere.
  const live = useRef({ session: sessionId, active: true });
  useEffect(() => {
    const current = live.current;
    current.session = sessionId;
    current.active = true;
    return () => {
      current.active = false;
      abort.current?.abort();
      abort.current = null;
    };
  }, [sessionId]);

  const isReviewed =
    route !== null &&
    reviewed !== null &&
    reviewed.requestId === route.proposalId &&
    reviewed.draftRevision === route.draftRevision;

  async function compute() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const draftRevision = store.getState().revision;
    const requestId = crypto.randomUUID();
    setComputing(true);
    setMessage('');
    setReviewed(null);
    try {
      const answer = await api.previewRoute(
        {
          requestId,
          draftRevision,
          waypoints: draftRequestWaypoints(store.getState().waypoints),
        },
        controller.signal,
      );
      if (controller.signal.aborted || abort.current !== controller) return;
      if (answer.outcome !== 'route_computed') {
        store.getState().clearRoute();
        setMessage(outcomes[answer.outcome] ?? '경로를 계산하지 못했습니다.');
        return;
      }
      const preview = answer.preview;
      if (
        preview.requestId !== requestId ||
        preview.computation.requestId !== requestId ||
        preview.draftRevision !== draftRevision
      ) {
        store.getState().clearRoute();
        setMessage(
          '이 계산 결과가 방금 보낸 요청의 것이 아니어서 사용하지 않았습니다. 다시 계산하세요.',
        );
        return;
      }
      setDigests((known) => new Map(known).set(preview.requestId, preview.geometrySha256));
      const applied = store.getState().applyRoute({
        draftRevision: preview.draftRevision,
        // A preview has no stored id; the request that produced it names it on screen.
        proposalId: preview.requestId,
        coordinates: preview.geometry.coordinates,
        engineDistanceMeters: preview.engineDistanceMeters,
        engineDurationSeconds: preview.engineDurationSeconds,
        maxSnapDistanceMeters: preview.snappedWaypoints.reduce(
          (furthest, waypoint) => Math.max(furthest, waypoint.snapDistanceMeters),
          0,
        ),
        graphBuildId: preview.computation.graph.graphBuildId,
        engineVersion: preview.computation.graph.engineVersion,
        computedAt: preview.computation.computedAt,
        warnings: preview.computation.warnings,
      });
      setMessage(
        applied
          ? '경로를 계산했습니다. 아래 내용을 검토한 뒤 저장하세요. 아직 아무것도 저장되지 않았습니다.'
          : '계산하는 사이 초안이 바뀌어 이 결과를 적용하지 않았습니다. 현재 초안으로 다시 계산하세요.',
      );
    } catch (error) {
      if (abort.current !== controller) return;
      if (controller.signal.aborted) {
        setMessage(outcomes['cancelled'] ?? '');
        return;
      }
      if (error instanceof CourseRequestError && error.status === 404) {
        setMessage('이 서버에는 경로 계산 기능이 구성되어 있지 않습니다.');
        return;
      }
      setMessage('경로 계산 결과를 확인하지 못했습니다. 저장된 것은 없습니다.');
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setComputing(false);
      }
    }
  }

  async function save() {
    if (route === null || !isReviewed) return;
    const digest = digests.get(route.proposalId);
    if (digest === undefined) return;
    const parsedName = courseNameSchema.safeParse(name.trim());
    if (!parsedName.success) {
      setMessage(
        '코스 이름을 입력하세요. 120자 이하, 꺾쇠괄호(<, >)와 제어 문자는 쓸 수 없습니다.',
      );
      return;
    }
    const body: CourseCreateRequest = {
      name: parsedName.data,
      from: {
        kind: 'routed-waypoints',
        waypoints: draftRequestWaypoints(store.getState().waypoints),
        draftRevision: route.draftRevision,
        reviewedGeometrySha256: digest,
        acknowledgedGraph: { previous: null, next: route.graphBuildId },
      },
    };
    // One idempotency key per distinct command, kept across a retry of the same one, so a
    // save whose answer was lost is not a second course.
    const fingerprint = JSON.stringify(body);
    if (command.current?.fingerprint !== fingerprint)
      command.current = { fingerprint, key: crypto.randomUUID() };
    const key = command.current.key;
    setSaving(true);
    setMessage('');
    try {
      const result = await api.create(body, key);
      command.current = null;
      if (!live.current.active || live.current.session !== sessionId) return;
      setMessage('코스를 만들었습니다. 코스 편집 화면으로 이동합니다.');
      onCreated(result.course.courseId);
    } catch (error) {
      if (!live.current.active) return;
      if (error instanceof CourseRequestError && provesNothingWasStored(error.status)) {
        command.current = null;
        setMessage(createErrors[error.code] ?? '코스를 만들지 못했습니다. 저장된 것은 없습니다.');
        // A save refused because the answer changed has nothing left to review.
        if (
          [
            'ROUTE_PREVIEW_CHANGED',
            'ROUTE_PREVIEW_NOT_REPRODUCED',
            'COURSE_GRAPH_ACKNOWLEDGEMENT_STALE',
          ].includes(error.code)
        ) {
          store.getState().clearRoute();
          setReviewed(null);
        }
        return;
      }
      setMessage(
        '저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 저장하면 코스가 중복으로 생기지 않습니다.',
      );
    } finally {
      if (live.current.active) setSaving(false);
    }
  }

  const canCompute = state.waypoints.length >= 2;

  return (
    <section className={styles.editor} aria-label="경유지 편집">
      <h3>경유지 편집</h3>
      <p className={styles.note}>
        계산된 경로는 <strong>제안</strong>입니다. 검토하고 저장해야 코스가 됩니다. 지도에 보이는
        경로가 통행 허가나 안전을 보장하지 않습니다.
      </p>
      {message ? <p role="status">{message}</p> : null}
      <WaypointListEditor pickedPosition={pickedPosition} computing={computing} />
      <div className={styles.actions}>
        <Button onClick={() => void compute()} disabled={computing || saving || !canCompute}>
          {computing ? '경로 계산 중' : '경로 계산'}
        </Button>
        {computing ? (
          <Button
            variant="secondary"
            onClick={() => {
              const inFlight = abort.current;
              if (!inFlight) return;
              abort.current = null;
              inFlight.abort();
              setComputing(false);
              setMessage(outcomes['cancelled'] ?? '');
            }}
          >
            계산 취소
          </Button>
        ) : null}
      </div>

      {route ? (
        <div className={styles.review} role="group" aria-label="계산된 경로 검토">
          <h4>계산된 경로 (제안)</h4>
          <RouteReviewSummary route={route} />
          <TextField
            label="새 코스 이름"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={isReviewed}
              onChange={(event) =>
                setReviewed(
                  event.target.checked
                    ? { requestId: route.proposalId, draftRevision: route.draftRevision }
                    : null,
                )
              }
            />
            위 내용을 검토했습니다.
          </label>
          <Button onClick={() => void save()} disabled={!isReviewed || saving}>
            검토한 경로로 새 코스 저장
          </Button>
        </div>
      ) : null}
    </section>
  );
}
