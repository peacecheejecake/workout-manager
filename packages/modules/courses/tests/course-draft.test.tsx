import { describe, expect, it } from 'vitest';
import type { CourseWaypoint } from '@workout/contracts/courses';
import {
  createCourseDraftStore,
  currentRoute,
  draftRequestWaypoints,
  draftRouteStatus,
  type ComputedDraftRoute,
} from '../src/course-draft';
import { draftMapPaths } from '../src/course-draft-context';

const seed: CourseWaypoint[] = [
  {
    role: 'start',
    position: [126.9779, 37.5665],
    name: null,
    sourceSampleId: '0:0',
    locked: false,
  },
  {
    role: 'finish',
    position: [126.9799, 37.5671],
    name: null,
    sourceSampleId: '0:3',
    locked: false,
  },
];

function draft() {
  return createCourseDraftStore({ courseId: 'course-1', headRevision: 1, waypoints: seed });
}

const route = (draftRevision: number): ComputedDraftRoute => ({
  draftRevision,
  proposalId: 'proposal-1',
  coordinates: [
    [126.9779, 37.5665],
    [126.9789, 37.5668],
    [126.9799, 37.5671],
  ],
  engineDistanceMeters: 210,
  engineDurationSeconds: 150,
  maxSnapDistanceMeters: 4,
  graphBuildId: '0123456789abcdef',
  engineVersion: '10.0',
  computedAt: '2026-03-02T00:00:00.000Z',
  warnings: [],
});

describe('waypoint draft', () => {
  it('keeps start and finish roles positional as the list changes', () => {
    const store = draft();
    store.getState().addVia([126.9789, 37.5668]);
    expect(store.getState().waypoints.map((waypoint) => waypoint.role)).toEqual([
      'start',
      'via',
      'finish',
    ]);
    const second = store.getState().waypoints[1];
    if (!second) throw new Error('missing waypoint');
    store.getState().moveWaypoint(second.id, 0);
    // Moving a via to the front makes it the start; the roles follow the order rather than
    // the list disagreeing with itself.
    expect(store.getState().waypoints.map((waypoint) => waypoint.role)).toEqual([
      'start',
      'via',
      'finish',
    ]);
    expect(store.getState().waypoints[0]?.id).toBe(second.id);
  });

  it('advances the revision on every change, and never rewinds it on undo or redo', () => {
    const store = draft();
    expect(store.getState().revision).toBe(1);
    store.getState().addVia([126.9789, 37.5668]);
    expect(store.getState().revision).toBe(2);
    store.getState().undo();
    // The waypoints are back, but this is a *different* draft from revision 1 as far as any
    // computation in flight is concerned: a result asked for revision 1 must not land here.
    expect(store.getState().waypoints).toHaveLength(2);
    expect(store.getState().revision).toBe(3);
    store.getState().redo();
    expect(store.getState().waypoints).toHaveLength(3);
    expect(store.getState().revision).toBe(4);
  });

  it('drops the redo branch once a new edit is made after an undo', () => {
    const store = draft();
    store.getState().addVia([126.9789, 37.5668]);
    store.getState().undo();
    store.getState().addVia([126.979, 37.5669]);
    expect(store.getState().future).toHaveLength(0);
    expect(store.getState().waypoints).toHaveLength(3);
  });

  it('applies a computed route only to the draft it was computed for', () => {
    const store = draft();
    expect(store.getState().applyRoute(route(1))).toBe(true);
    expect(currentRoute(store.getState())?.proposalId).toBe('proposal-1');
    // The owner edits while a second computation is in flight.
    store.getState().addVia([126.9789, 37.5668]);
    expect(currentRoute(store.getState())).toBeNull();
    expect(store.getState().route).not.toBeNull();
    // The late answer belongs to the draft that no longer exists.
    expect(store.getState().applyRoute(route(1))).toBe(false);
    expect(currentRoute(store.getState())).toBeNull();
    expect(store.getState().applyRoute(route(store.getState().revision))).toBe(true);
    expect(currentRoute(store.getState())?.proposalId).toBe('proposal-1');
  });

  it('refuses to move, reorder or remove a locked waypoint until it is unlocked', () => {
    const store = draft();
    store.getState().addVia([126.9789, 37.5668]);
    const via = store.getState().waypoints[1];
    if (!via) throw new Error('missing waypoint');
    store.getState().setLocked(via.id, true);
    const revisionAfterLock = store.getState().revision;

    store.getState().movePosition(via.id, [127, 37.5]);
    expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
    store.getState().remove(via.id);
    expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
    store.getState().moveWaypoint(via.id, 0);
    expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
    store.getState().moveWaypoint(via.id, 2);
    expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
    // A refused change is not a change: nothing moved and no revision was spent.
    expect(store.getState().revision).toBe(revisionAfterLock);
    expect(store.getState().waypoints[1]?.position).toEqual([126.9789, 37.5668]);

    store.getState().setLocked(via.id, false);
    store.getState().movePosition(via.id, [127, 37.5]);
    expect(store.getState().waypoints[1]?.position).toEqual([127, 37.5]);
  });

  it('refuses to reorder across a locked neighbour', () => {
    const store = draft();
    store.getState().addVia([126.9789, 37.5668]);
    const [start, via] = store.getState().waypoints;
    if (!start || !via) throw new Error('missing waypoints');
    store.getState().setLocked(start.id, true);
    store.getState().moveWaypoint(via.id, 0);
    expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
    expect(store.getState().waypoints[0]?.id).toBe(start.id);
  });

  describe('moveWaypoint — the one reorder action behind the buttons and the drag', () => {
    const four = () => {
      const store = draft();
      store.getState().addVia([126.9785, 37.5667]);
      store.getState().addVia([126.979, 37.5669]);
      return store;
    };
    const ids = (store: ReturnType<typeof draft>) =>
      store.getState().waypoints.map((waypoint) => waypoint.id);

    it('carries one waypoint several places in one change, roles following the order', () => {
      const store = four();
      const [a, b, c, d] = ids(store);
      const before = store.getState().revision;
      store.getState().moveWaypoint(c ?? '', 0);
      expect(ids(store)).toEqual([c, a, b, d]);
      expect(store.getState().waypoints.map((waypoint) => waypoint.role)).toEqual([
        'start',
        'via',
        'via',
        'finish',
      ]);
      expect(store.getState().revision).toBe(before + 1);
      // One change, so one undo puts all of it back, and redo carries it again.
      store.getState().undo();
      expect(ids(store)).toEqual([a, b, c, d]);
      store.getState().redo();
      expect(ids(store)).toEqual([c, a, b, d]);
      store.getState().moveWaypoint(c ?? '', 3);
      expect(ids(store)).toEqual([a, b, d, c]);
    });

    it('refuses to carry anything over a locked waypoint, in either direction', () => {
      const store = four();
      const [a, b, c, d] = ids(store);
      store.getState().setLocked(b ?? '', true);
      const revision = store.getState().revision;
      store.getState().moveWaypoint(c ?? '', 0);
      expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
      store.getState().moveWaypoint(a ?? '', 3);
      expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
      // The locked one itself does not move either.
      store.getState().moveWaypoint(b ?? '', 3);
      expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
      expect(ids(store)).toEqual([a, b, c, d]);
      expect(store.getState().revision).toBe(revision);
      // A move that passes no lock is still allowed.
      store.getState().moveWaypoint(d ?? '', 2);
      expect(ids(store)).toEqual([a, b, d, c]);
      expect(store.getState().refusal).toBeNull();
    });

    it('treats a drop in place as no change and refuses a place outside the list', () => {
      const store = four();
      const [a] = ids(store);
      const revision = store.getState().revision;
      store.getState().moveWaypoint(a ?? '', 0);
      expect(store.getState().revision).toBe(revision);
      expect(store.getState().past).toHaveLength(2);
      store.getState().moveWaypoint(a ?? '', 4);
      expect(store.getState().refusal).toBe('WAYPOINT_NOT_FOUND');
      store.getState().moveWaypoint(a ?? '', -1);
      expect(store.getState().refusal).toBe('WAYPOINT_NOT_FOUND');
      store.getState().moveWaypoint('not-a-waypoint', 1);
      expect(store.getState().refusal).toBe('WAYPOINT_NOT_FOUND');
      expect(store.getState().revision).toBe(revision);
    });
  });

  it('stops claiming a recorded sample for a waypoint that has been moved', () => {
    const store = draft();
    const start = store.getState().waypoints[0];
    if (!start) throw new Error('missing waypoint');
    expect(start.sourceSampleId).toBe('0:0');
    store.getState().movePosition(start.id, [126.98, 37.567]);
    expect(store.getState().waypoints[0]?.sourceSampleId).toBeNull();
  });

  it('keeps a start and a finish, and refuses an impossible position', () => {
    const store = draft();
    const start = store.getState().waypoints[0];
    if (!start) throw new Error('missing waypoint');
    store.getState().remove(start.id);
    expect(store.getState().refusal).toBe('WAYPOINT_MINIMUM_REACHED');
    expect(store.getState().waypoints).toHaveLength(2);
    store.getState().addVia([200, 37.5]);
    expect(store.getState().refusal).toBe('WAYPOINT_POSITION_INVALID');
    store.getState().addVia([126.98, Number.NaN]);
    expect(store.getState().refusal).toBe('WAYPOINT_POSITION_INVALID');
    expect(store.getState().waypoints).toHaveLength(2);
  });

  it('refuses more waypoints than a course may carry', () => {
    const store = draft();
    for (let index = 0; index < 10; index += 1)
      store.getState().addVia([126.978 + index / 10_000, 37.5665]);
    expect(store.getState().waypoints).toHaveLength(12);
    store.getState().addVia([126.99, 37.5665]);
    expect(store.getState().refusal).toBe('WAYPOINT_LIMIT_REACHED');
    expect(store.getState().waypoints).toHaveLength(12);
  });

  it('sends waypoints with their locks and no identifier of its own', () => {
    const store = draft();
    store.getState().addVia([126.9789, 37.5668]);
    const via = store.getState().waypoints[1];
    if (!via) throw new Error('missing waypoint');
    store.getState().setLocked(via.id, true);
    const sent = draftRequestWaypoints(store.getState().waypoints);
    expect(sent).toEqual([
      {
        role: 'start',
        position: [126.9779, 37.5665],
        name: null,
        sourceSampleId: '0:0',
        locked: false,
      },
      {
        role: 'via',
        position: [126.9789, 37.5668],
        name: null,
        sourceSampleId: null,
        locked: true,
      },
      {
        role: 'finish',
        position: [126.9799, 37.5671],
        name: null,
        sourceSampleId: '0:3',
        locked: false,
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain(via.id);
  });
});

describe('a draft started on an empty map (M2-01r, /courses/new)', () => {
  const empty = () => createCourseDraftStore({ courseId: 'new', headRevision: 0, waypoints: [] });

  it('makes the first point the start and the second the finish, in the order placed', () => {
    const store = empty();
    store.getState().addVia([127.0, 37.5]);
    store.getState().addVia([127.01, 37.51]);
    store.getState().addVia([127.02, 37.52]);
    expect(
      store.getState().waypoints.map((waypoint) => [waypoint.role, waypoint.position]),
    ).toEqual([
      ['start', [127.0, 37.5]],
      // The third point is a via before the finish, exactly as on a stored course.
      ['via', [127.02, 37.52]],
      ['finish', [127.01, 37.51]],
    ]);
    // No point placed on an empty map claims a recorded sample.
    expect(draftRequestWaypoints(store.getState().waypoints).map((w) => w.sourceSampleId)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('lets every point of a new draft be taken back, but keeps a stored course two ends', () => {
    const store = empty();
    store.getState().addVia([127.0, 37.5]);
    store.getState().addVia([127.01, 37.51]);
    for (const waypoint of [...store.getState().waypoints]) store.getState().remove(waypoint.id);
    expect(store.getState().waypoints).toEqual([]);
    expect(store.getState().refusal).toBeNull();

    const stored = draft();
    const first = stored.getState().waypoints[0];
    if (!first) throw new Error('missing waypoint');
    stored.getState().remove(first.id);
    expect(stored.getState().refusal).toBe('WAYPOINT_MINIMUM_REACHED');
    expect(stored.getState().waypoints).toHaveLength(2);
  });
});

describe('the uncomputed draft status (M2-01r, S14 "미계산 초안")', () => {
  it('tells stored, uncomputed, computing, computed and stale apart', () => {
    const store = draft();
    const status = (computing = false) => draftRouteStatus(store.getState(), { computing });
    expect(status()).toBe('stored');
    store.getState().addVia([126.9789, 37.5668]);
    expect(status()).toBe('uncomputed');
    expect(status(true)).toBe('computing');
    store.getState().applyRoute(route(store.getState().revision));
    expect(status()).toBe('computed');
    const via = store.getState().waypoints[1];
    if (!via) throw new Error('missing waypoint');
    store.getState().rename(via.id, '편의점');
    expect(status()).toBe('stale');
    // Undoing back to exactly what is stored is not an uncomputed draft.
    store.getState().undo();
    store.getState().undo();
    expect(status()).toBe('stored');
  });

  it('says a new draft with fewer than two points has nothing to compute', () => {
    const store = createCourseDraftStore({ courseId: 'new', headRevision: 0, waypoints: [] });
    expect(draftRouteStatus(store.getState(), { computing: false })).toBe('incomplete');
    store.getState().addVia([127.0, 37.5]);
    expect(draftRouteStatus(store.getState(), { computing: false })).toBe('incomplete');
    store.getState().addVia([127.01, 37.51]);
    expect(draftRouteStatus(store.getState(), { computing: false })).toBe('uncomputed');
  });

  it('draws the waypoints joined straight only while the draft is uncomputed, in its own role', () => {
    const store = draft();
    const stored: [number, number][] = [
      [126.9779, 37.5665],
      [126.9799, 37.5671],
    ];
    const line = () =>
      draftMapPaths({ state: store.getState(), storedCoordinates: stored }).find(
        (path) => path.id === 'course-uncomputed',
      );
    expect(line()).toBeUndefined();
    store.getState().addVia([126.9789, 37.5668]);
    expect(line()).toMatchObject({
      role: 'uncomputed',
      positions: [
        [126.9779, 37.5665],
        [126.9789, 37.5668],
        [126.9799, 37.5671],
      ],
    });
    // A straight line between points is never broken into points and never a route role.
    expect(line()?.breaks).toBeUndefined();
    store.getState().applyRoute(route(store.getState().revision));
    expect(line()).toBeUndefined();
    const via = store.getState().waypoints[1];
    if (!via) throw new Error('missing waypoint');
    store.getState().moveWaypoint(via.id, 0);
    expect(line()?.role).toBe('uncomputed');
  });

  it('selects without editing: no revision, no history, and never a missing waypoint', () => {
    const store = draft();
    const before = store.getState().revision;
    const first = store.getState().waypoints[0];
    if (!first) throw new Error('missing waypoint');
    store.getState().selectWaypoint(first.id);
    expect(store.getState().selectedWaypointId).toBe(first.id);
    expect(store.getState().revision).toBe(before);
    expect(store.getState().past).toHaveLength(0);
    store.getState().selectWaypoint('not-a-waypoint');
    expect(store.getState().refusal).toBe('WAYPOINT_NOT_FOUND');
    expect(store.getState().selectedWaypointId).toBe(first.id);
  });
});
