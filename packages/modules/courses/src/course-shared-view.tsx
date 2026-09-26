'use client';

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from 'react';
import type { SharedCourse } from '@workout/contracts/course-sharing';
import type { BasemapDescriptor } from '@workout/geo-kit/basemap';
import type { MapAdapterFactory } from '@workout/geo-kit/map-adapter';
import type { MapPath } from '@workout/geo-kit/map-path';
import type { MapViewProps } from '@workout/geo-kit/map-view';
import { Button } from '@workout/ui-foundation/button';

import { readSharedCourse } from './course-sharing-api';
import { RouteDataNotice } from './route-data-notice';
import styles from './course-sharing.module.css';

/**
 * The recipient's screen for a view-only link (M2-01k-o §3 B, R7, R8, B-7, B-8).
 *
 * **Nothing happens until "코스 보기".** A messenger's link-preview bot that opens the address
 * gets this text and nothing else: the fragment is not read, no request is made and no map
 * code is loaded before the click. On the click the token is taken out of the fragment and
 * the fragment is removed from the address and history at once — before any request — and
 * then read with a POST that carries no credentials and no referrer.
 *
 * What is shown is only what the server's allowlist answered: the line, the waypoint roles,
 * names only if the owner kept them, the planned length and the expiry date. There is no
 * download control and no word here about what was or was not removed from the line.
 */
const LazyCourseMapLeaf = lazy(() =>
  import('./course-map-leaf').then((module) => ({ default: module.CourseMapLeaf })),
);

export interface SharedCourseViewProps {
  /** The self-hosted background map, already known (Next shell). */
  readonly basemap?: BasemapDescriptor | null;
  /** Or how to learn it — only ever called after "코스 보기" (Vite shell). */
  readonly loadBasemap?: (signal: AbortSignal) => Promise<BasemapDescriptor | null>;
  readonly mapWorkerUrl?: string;
  /** Test seams. */
  readonly fetcher?: typeof fetch;
  readonly mapView?: ComponentType<MapViewProps>;
  readonly createMapAdapter?: MapAdapterFactory;
}

type ViewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly course: SharedCourse }
  | { readonly status: 'missing' };

const roleLabel = { start: '출발', via: '경유', finish: '도착' } as const;

function metres(value: number): string {
  return value >= 1000 ? `약 ${(value / 1000).toFixed(1)}km` : `약 ${value}m`;
}

/**
 * Every link on this screen leaves without a referrer. The one external link is the map's
 * data attribution, which the renderer writes itself; it is given `rel="noreferrer
 * noopener"` here as soon as it appears (B-8).
 */
function useNoReferrerLinks(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const fix = () => {
      for (const anchor of element.querySelectorAll('a[href]')) {
        anchor.setAttribute('rel', 'noreferrer noopener');
        anchor.setAttribute('referrerpolicy', 'no-referrer');
      }
    };
    fix();
    const observer = new MutationObserver(fix);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root]);
}

export function SharedCourseView({
  basemap = null,
  loadBasemap,
  mapWorkerUrl,
  fetcher,
  mapView,
  createMapAdapter,
}: SharedCourseViewProps) {
  const [state, setState] = useState<ViewState>({ status: 'idle' });
  const [loadedBasemap, setLoadedBasemap] = useState<BasemapDescriptor | null>(basemap);
  const root = useRef<HTMLElement>(null);
  const controller = useRef<AbortController | null>(null);
  useNoReferrerLinks(root);
  useEffect(() => () => controller.current?.abort(), []);

  const adapterFactory = useMemo<MapAdapterFactory | undefined>(() => {
    if (createMapAdapter) return createMapAdapter;
    if (!mapWorkerUrl) return undefined;
    return async (options) => {
      const module = await import('@workout/geo-kit/maplibre-adapter');
      module.configureMapWorker(mapWorkerUrl);
      return module.createMapLibreAdapter(options);
    };
  }, [mapWorkerUrl, createMapAdapter]);

  async function open() {
    // The fragment is read now and only now, and removed before anything is sent.
    const token = window.location.hash.slice(1);
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    setState({ status: 'loading' });
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    try {
      const course = token === '' ? null : await readSharedCourse(token, fetcher);
      if (current.signal.aborted) return;
      if (course === null) {
        setState({ status: 'missing' });
        return;
      }
      if (loadBasemap && loadedBasemap === null) {
        const resolved = await loadBasemap(current.signal).catch(() => null);
        if (!current.signal.aborted) setLoadedBasemap(resolved);
      }
      setState({ status: 'ready', course });
    } catch {
      if (!current.signal.aborted) setState({ status: 'missing' });
    }
  }

  return (
    <section ref={root} className={styles.view} aria-labelledby="shared-course-title">
      <h1 id="shared-course-title">공유된 코스</h1>
      {state.status === 'idle' ? (
        <>
          <p>
            누군가 보기 전용으로 공유한 코스입니다. 아래 버튼을 누르기 전에는 아무것도 불러오지
            않습니다.
          </p>
          <div>
            <Button onClick={() => void open()}>코스 보기</Button>
          </div>
        </>
      ) : null}
      {state.status === 'loading' ? <p role="status">코스를 불러오는 중입니다.</p> : null}
      {state.status === 'missing' ? (
        <p role="alert">
          이 링크로 볼 수 있는 코스가 없습니다. 링크가 만료되었거나 꺼졌거나 잘못되었을 수 있습니다.
        </p>
      ) : null}
      {state.status === 'ready' ? (
        <SharedCourseBody
          course={state.course}
          basemap={loadedBasemap}
          {...(mapView ? { mapView } : {})}
          {...(adapterFactory ? { createMapAdapter: adapterFactory } : {})}
        />
      ) : null}
    </section>
  );
}

function SharedCourseBody({
  course,
  basemap,
  mapView,
  createMapAdapter,
}: {
  readonly course: SharedCourse;
  readonly basemap: BasemapDescriptor | null;
  readonly mapView?: ComponentType<MapViewProps>;
  readonly createMapAdapter?: MapAdapterFactory;
}) {
  const paths = useMemo<MapPath[]>(
    () => [
      {
        id: 'shared-course',
        role: 'planned',
        revision: 'shared',
        positions: course.coordinates.map((position) => [position[0], position[1]] as const),
      },
    ],
    [course],
  );
  return (
    <>
      {course.name ? <h2>{course.name}</h2> : null}
      <dl>
        <dt>계획 선 길이</dt>
        <dd>{metres(course.distanceMeters)}</dd>
        <dt>링크 만료일</dt>
        <dd data-testid="shared-course-expiry">{course.expiresOn}</dd>
      </dl>
      <div className={styles.map}>
        <Suspense fallback={<p role="status">지도를 준비하는 중입니다.</p>}>
          <LazyCourseMapLeaf
            label="공유된 코스 지도"
            paths={paths}
            selection={null}
            onSelect={() => undefined}
            basemap={basemap}
            fitRequest={1}
            onStatusChange={() => undefined}
            loadFailureFallback={
              <p role="status">지도를 불러오지 못했습니다. 아래 목록에서 지점을 볼 수 있습니다.</p>
            }
            {...(mapView ? { mapView } : {})}
            {...(createMapAdapter ? { createAdapter: createMapAdapter } : {})}
          />
        </Suspense>
      </div>
      {course.routeDataNotice === true ? <RouteDataNotice /> : null}
      <ul aria-label="코스 지점">
        {course.waypoints.map((waypoint, index) => (
          <li key={`${waypoint.role}:${index}`}>
            {roleLabel[waypoint.role]}
            {waypoint.name ? ` · ${waypoint.name}` : ''} · 위도 {waypoint.position[1].toFixed(5)},
            경도 {waypoint.position[0].toFixed(5)}
          </li>
        ))}
      </ul>
      <p className={styles.note}>
        보기 전용 링크입니다. 이 화면에서는 파일을 받을 수 없고, 링크는 공유한 사람이 언제든 끌 수
        있습니다.
      </p>
    </>
  );
}
