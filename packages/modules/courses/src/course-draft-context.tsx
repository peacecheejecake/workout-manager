'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import type { CourseWaypoint } from '@workout/contracts/courses';
import type { MapPath, MapSelection } from '@workout/geo-kit/map-path';
import {
  createCourseDraftStore,
  currentOutAndBack,
  currentRoute,
  draftRouteStatus,
  pickedCandidate,
  type CourseDraftState,
  type CourseDraftStore,
} from './course-draft';

/**
 * One editing draft, scoped to a user and a course.
 *
 * The plan puts the draft in a per-user, per-course memory provider, above the responsive
 * layout switch: the waypoint list, the map and the review panel are three views of one
 * draft, and a layout change from tablet to desktop must not restart the edit. Nothing is
 * persisted — no `localStorage`, no service worker — so signing out takes the draft with
 * the screen.
 *
 * **The store is not rebuilt when the head revision moves.** It was at first, and that
 * threw away an unsaved waypoint the moment the course was renamed on this very screen: a
 * rename advances the head, the provider re-created the store, and the edit was gone with
 * no warning. Now the store is told what is stored and decides for itself — see
 * `syncHead` — so a rename continues, this draft's own save continues from what it wrote,
 * and a real change elsewhere becomes a conflict the owner resolves explicitly.
 */
const DraftContext = createContext<CourseDraftStore | null>(null);

export function CourseDraftProvider({
  courseId,
  headRevision,
  waypoints,
  children,
}: {
  readonly courseId: string;
  readonly headRevision: number;
  readonly waypoints: readonly CourseWaypoint[];
  readonly children: ReactNode;
}) {
  // A different course is a different draft. A different revision of the same course is
  // not: it is news about the course this draft is editing.
  const store = useMemo(
    () => createCourseDraftStore({ courseId, headRevision, waypoints }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [courseId],
  );
  // The fetched waypoint array is a new object on every response; the head revision is what
  // actually says the stored course changed, so it alone drives the comparison. The
  // waypoints are carried in through a ref written from an effect, not during render.
  const latest = useRef(waypoints);
  useEffect(() => {
    latest.current = waypoints;
  }, [waypoints]);
  useEffect(() => {
    store.getState().syncHead(headRevision, latest.current);
  }, [store, headRevision]);
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

export function useCourseDraftStore(): CourseDraftStore {
  const store = useContext(DraftContext);
  if (!store) throw new Error('COURSE_DRAFT_PROVIDER_MISSING');
  return store;
}

export function useCourseDraft<T>(selector: (state: CourseDraftState) => T): T {
  return useStore(useCourseDraftStore(), selector);
}

/** The map path whose vertices are the draft's waypoints, one point each. */
const waypointPathId = 'course-waypoints';

/**
 * The map's selection, shared with the waypoint list (M2-01r, plan section 5: "목록으로 같은
 * 위치/경유점 선택").
 *
 * A waypoint selected on the map is the waypoint selected in the list and the other way
 * round: there is one selection, held by the draft, and both views read it. A vertex of any
 * other line — the stored course, a computed proposal — is a map-only selection and clears
 * the waypoint selection rather than pretending to be one.
 */
export function useDraftMapSelection(): readonly [
  MapSelection | null,
  (next: MapSelection | null) => void,
] {
  const store = useCourseDraftStore();
  const waypoints = useCourseDraft((state) => state.waypoints);
  const selectedWaypointId = useCourseDraft((state) => state.selectedWaypointId);
  const [other, setOther] = useState<MapSelection | null>(null);
  const index = waypoints.findIndex((waypoint) => waypoint.id === selectedWaypointId);
  const selection: MapSelection | null =
    index >= 0 ? { pathId: waypointPathId, vertexIndex: index } : other;
  const select = useCallback(
    (next: MapSelection | null) => {
      if (next !== null && next.pathId === waypointPathId) {
        const waypoint = store.getState().waypoints[next.vertexIndex];
        store.getState().selectWaypoint(waypoint ? waypoint.id : null);
        setOther(null);
        return;
      }
      store.getState().selectWaypoint(null);
      setOther(next);
    },
    [store],
  );
  return [selection, select] as const;
}

/**
 * What the map draws for one draft.
 *
 * Distinct things, never merged into one line: the course as it is stored, the waypoints
 * the owner has placed (points), the computed proposal, which appears only while it belongs
 * to the draft as it is now — and, only while nothing computed belongs to the draft, the
 * uncomputed draft: the waypoints joined straight, in the renderer's dashed `uncomputed`
 * role (M2-01r). That line is the S14 "미계산 초안". It is never drawn in a route's style,
 * never measured, and never offered for saving; the plan forbids presenting it as a route,
 * and the spec asks for it to be shown as exactly what it is.
 */
export function draftMapPaths(input: {
  readonly state: CourseDraftState;
  readonly storedCoordinates: readonly (readonly [number, number])[];
}): MapPath[] {
  const paths: MapPath[] = [];
  if (input.storedCoordinates.length > 0)
    paths.push({
      id: 'course-stored',
      role: 'planned',
      revision: `stored:${input.storedCoordinates.length}`,
      positions: input.storedCoordinates.map((position) => [position[0], position[1]] as const),
    });
  const route = currentRoute(input.state);
  if (route)
    paths.push({
      id: 'course-proposal',
      role: 'candidate',
      revision: `proposal:${route.proposalId}`,
      positions: route.coordinates.map((position) => [position[0], position[1]] as const),
    });
  // The stretches of an out-and-back walked twice (M2-01k-j), over the proposal they belong
  // to. One path, broken between stretches: two separate stretches are never joined.
  const outAndBack = currentOutAndBack(input.state);
  if (route && outAndBack && outAndBack.segments.length > 0) {
    const positions: (readonly [number, number])[] = [];
    const breaks: number[] = [];
    for (const segment of outAndBack.segments) {
      if (positions.length > 0) breaks.push(positions.length);
      for (const position of segment.positions) positions.push([position[0], position[1]] as const);
    }
    paths.push({
      id: 'course-overlap',
      role: 'overlap',
      revision: `overlap:${route.proposalId}`,
      positions,
      breaks,
    });
  }
  // Only the candidate the owner picked is drawn. Four loops at once would be four lines
  // nobody asked for, and none of them is a course until one is picked and saved.
  const candidate = pickedCandidate(input.state);
  if (candidate)
    paths.push({
      id: 'course-candidate',
      role: 'candidate',
      revision: `candidate:${candidate.proposalId}`,
      positions: candidate.coordinates.map((position) => [position[0], position[1]] as const),
    });
  // The uncomputed draft (S14 "미계산 초안", M2-01r): the waypoints joined in order by
  // straight lines, drawn ONLY while nothing computed belongs to this draft and in the
  // renderer's own dashed `uncomputed` style. The editor says in words, and to a screen
  // reader, that this is not a route and not a distance. Nothing measures this line.
  const status = draftRouteStatus(input.state, { computing: false });
  if (status === 'uncomputed' || status === 'stale')
    paths.push({
      id: 'course-uncomputed',
      role: 'uncomputed',
      revision: `uncomputed:${input.state.revision}`,
      positions: input.state.waypoints.map(
        (waypoint) => [waypoint.position[0], waypoint.position[1]] as const,
      ),
    });
  if (input.state.waypoints.length > 0)
    paths.push({
      id: waypointPathId,
      role: 'planned',
      revision: `draft:${input.state.revision}`,
      positions: input.state.waypoints.map(
        (waypoint) => [waypoint.position[0], waypoint.position[1]] as const,
      ),
      // A break at every index renders each waypoint as its own point. Waypoints are
      // placed positions, not a path, and drawing them as one would show a line the engine
      // never computed.
      breaks: input.state.waypoints.map((_, index) => index).filter((index) => index > 0),
      vertexKeys: input.state.waypoints.map((waypoint) => waypoint.id),
    });
  return paths;
}
