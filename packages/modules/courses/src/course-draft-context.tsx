'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { CourseWaypoint } from '@workout/contracts/courses';
import type { MapPath } from '@workout/geo-kit/map-path';
import {
  createCourseDraftStore,
  currentRoute,
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

/**
 * What the map draws for one draft.
 *
 * Three distinct things, never merged into one line: the course as it is stored, the
 * waypoints the owner has placed (points, not a line — joining waypoints with a straight
 * line is exactly the uncomputed-draft shape the plan forbids presenting as a route), and
 * the computed proposal, which appears only while it belongs to the draft as it is now.
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
  if (input.state.waypoints.length > 0)
    paths.push({
      id: 'course-waypoints',
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
