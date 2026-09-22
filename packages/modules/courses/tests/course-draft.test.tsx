import { describe, expect, it } from 'vitest';
import type { CourseWaypoint } from '@workout/contracts/courses';
import {
  createCourseDraftStore,
  currentRoute,
  draftRequestWaypoints,
  type ComputedDraftRoute,
} from '../src/course-draft';

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
    store.getState().moveEarlier(second.id);
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
    store.getState().moveEarlier(via.id);
    expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
    store.getState().moveLater(via.id);
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
    store.getState().moveEarlier(via.id);
    expect(store.getState().refusal).toBe('WAYPOINT_LOCKED');
    expect(store.getState().waypoints[0]?.id).toBe(start.id);
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
