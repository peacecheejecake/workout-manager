import { createStore } from 'zustand/vanilla';
import { courseLimits, type CoursePosition, type CourseWaypoint } from '@workout/contracts/courses';

/**
 * The waypoint draft behind S14 (M2-01h).
 *
 * A draft is memory only, scoped by its owner to one user and one course. Nothing here is
 * persisted, written to `localStorage` or sent anywhere: it is what the owner is editing,
 * and it becomes a course only when they explicitly save a route they have reviewed.
 *
 * Two properties carry most of the weight.
 *
 * **`revision` only ever goes up.** Every change — adding, moving, reordering, removing,
 * renaming, locking, and undo and redo as well — advances it by one. It is therefore not a
 * position in the history but an identity for "the draft as it is right now", which is what
 * lets a computation that comes back late be recognised as belonging to a draft that no
 * longer exists and be discarded rather than applied. An undo that restored the revision
 * number would make two different drafts share one identity, and a result computed for the
 * first would silently apply to the second.
 *
 * **A computed route belongs to exactly one revision.** The draft remembers the revision a
 * route was computed for; the moment anything changes, the route is no longer current and
 * the screen says so instead of showing a line that no longer matches the waypoints.
 *
 * **A draft is not discarded because the stored course moved.** An unsaved edit is the
 * owner's work. When the head advances the draft compares what it was seeded from with what
 * is stored now: a change that leaves the waypoints alone (a rename) simply moves the seed
 * forward, the draft's own saved route continues from what was written, and anything else
 * is surfaced as a conflict the owner has to resolve explicitly. Rebuilding the store on
 * every head revision — which is what this did first — lost a waypoint the moment the
 * course was renamed on the same screen.
 */
export interface DraftWaypoint {
  readonly id: string;
  readonly role: 'start' | 'via' | 'finish';
  readonly position: CoursePosition;
  readonly name: string | null;
  /** The recorded sample this waypoint came from, kept only while it has not been moved. */
  readonly sourceSampleId: string | null;
  readonly locked: boolean;
}

export type DraftProblem =
  | 'WAYPOINT_LOCKED'
  | 'WAYPOINT_LIMIT_REACHED'
  | 'WAYPOINT_MINIMUM_REACHED'
  | 'WAYPOINT_POSITION_INVALID'
  | 'WAYPOINT_NOT_FOUND'
  | 'DRAFT_LIMIT_REACHED';

export class DraftRefusal extends Error {
  constructor(readonly code: DraftProblem) {
    super(code);
    this.name = 'DraftRefusal';
  }
}

/** Roles are positional: the first is the start, the last the finish, the rest are via. */
export function withPositionalRoles(waypoints: readonly DraftWaypoint[]): readonly DraftWaypoint[] {
  return waypoints.map((waypoint, index) => {
    const role = index === 0 ? 'start' : index === waypoints.length - 1 ? 'finish' : 'via';
    return waypoint.role === role ? waypoint : { ...waypoint, role };
  });
}

export function isValidPosition(position: CoursePosition): boolean {
  const [longitude, latitude] = position;
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
}

export interface ComputedDraftRoute {
  /** The draft revision this route was computed for. It is current only for that one. */
  readonly draftRevision: number;
  readonly proposalId: string;
  readonly coordinates: readonly CoursePosition[];
  readonly engineDistanceMeters: number;
  readonly engineDurationSeconds: number;
  readonly maxSnapDistanceMeters: number;
  readonly graphBuildId: string;
  readonly engineVersion: string | null;
  readonly computedAt: string;
  readonly warnings: readonly string[];
}

interface DraftSnapshot {
  readonly waypoints: readonly DraftWaypoint[];
}

/** Store-private bookkeeping, not part of what a screen reads. */
interface DraftHeadTracking {
  pendingHead: {
    readonly headRevision: number;
    readonly waypoints: readonly CourseWaypoint[];
  } | null;
  acknowledgedSave: { readonly headRevision: number; readonly draftRevision: number } | null;
}

export interface CourseDraftState {
  readonly courseId: string;
  waypoints: readonly DraftWaypoint[];
  /** Monotonic. Never reset, never decreased, not even by undo. */
  revision: number;
  past: readonly DraftSnapshot[];
  future: readonly DraftSnapshot[];
  /** The last computed route, with the revision it belongs to. */
  route: ComputedDraftRoute | null;
  /** Why the last attempted change was refused, so the screen can say it in words. */
  refusal: DraftProblem | null;
  /** The stored revision this draft was seeded from, and the waypoints it was seeded with. */
  seededRevision: number;
  seededWaypoints: readonly CourseWaypoint[];
  /** True once the owner has unsaved work: an edited waypoint list or a computed route. */
  dirty: boolean;
  /**
   * A stored change the owner has to resolve before it can replace their draft.
   * `external` is somebody else's write; `edited-after-own-save` is this draft's own save
   * arriving after the owner has moved on from what it saved.
   */
  headConflict: {
    readonly headRevision: number;
    readonly reason: 'external' | 'edited-after-own-save';
  } | null;
  addVia(position: CoursePosition): void;
  movePosition(id: string, position: CoursePosition): void;
  rename(id: string, name: string | null): void;
  setLocked(id: string, locked: boolean): void;
  moveEarlier(id: string): void;
  moveLater(id: string): void;
  remove(id: string): void;
  undo(): void;
  redo(): void;
  clearRefusal(): void;
  /**
   * The stored course as it is now. Called whenever the screen reads a head revision.
   * A clean draft, a head this draft itself wrote, and a change that leaves the stored
   * waypoints identical all continue silently; anything else raises `headConflict`.
   */
  syncHead(headRevision: number, waypoints: readonly CourseWaypoint[]): void;
  /** The owner's explicit "start again from what is stored". Discards the draft. */
  adoptHead(): void;
  /** The owner's explicit "keep my edits". The conflict notice goes, the draft stays. */
  keepDraft(): void;
  /**
   * This head revision is this draft's own save of `draftRevision`. Continuing from it is
   * only silent while the draft is still that one: an edit made while the save was in
   * flight is unsaved work the save knew nothing about.
   */
  acknowledgeSave(headRevision: number, draftRevision: number): void;
  /** Record a computed route. Ignored unless it belongs to the draft as it is now. */
  applyRoute(route: ComputedDraftRoute): boolean;
  /** Drop a computed route, for example after it was saved or the engine refused. */
  clearRoute(): void;
}

/** Bounded history: an editing session is not a document store. */
const HISTORY_LIMIT = 50;

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `w${sequence}`;
}

export function draftWaypointsFromCourse(
  waypoints: readonly CourseWaypoint[],
): readonly DraftWaypoint[] {
  return withPositionalRoles(
    waypoints.map((waypoint) => ({
      id: nextId(),
      role: waypoint.role,
      position: waypoint.position,
      name: waypoint.name,
      sourceSampleId: waypoint.sourceSampleId,
      locked: waypoint.locked,
    })),
  );
}

/** What a draft sends when it asks for a route. Roles are recomputed from the order. */
export function draftRequestWaypoints(waypoints: readonly DraftWaypoint[]): CourseWaypoint[] {
  return withPositionalRoles(waypoints).map((waypoint) => ({
    role: waypoint.role,
    position: waypoint.position,
    name: waypoint.name,
    sourceSampleId: waypoint.sourceSampleId,
    locked: waypoint.locked,
  }));
}

/** Two stored waypoint lists describing the same thing. Used to tell a rename apart. */
export function sameStoredWaypoints(
  left: readonly CourseWaypoint[],
  right: readonly CourseWaypoint[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((waypoint, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      waypoint.role === other.role &&
      waypoint.position[0] === other.position[0] &&
      waypoint.position[1] === other.position[1] &&
      waypoint.name === other.name &&
      waypoint.sourceSampleId === other.sourceSampleId &&
      waypoint.locked === other.locked
    );
  });
}

export function createCourseDraftStore(input: {
  readonly courseId: string;
  readonly headRevision: number;
  readonly waypoints: readonly CourseWaypoint[];
}) {
  const initial = draftWaypointsFromCourse(input.waypoints);
  return createStore<CourseDraftState & DraftHeadTracking>()((set, get) => {
    /**
     * One change. The previous waypoints go on the undo stack, the redo stack is dropped —
     * a new edit after an undo is a new branch — and the revision advances, which is what
     * invalidates any route computed for the draft as it was.
     */
    const change = (
      next: readonly DraftWaypoint[],
      options: { readonly history: boolean } = { history: true },
    ) => {
      const state = get();
      if (state.revision >= courseLimits.maxDraftRevision) {
        set({ refusal: 'DRAFT_LIMIT_REACHED' });
        return;
      }
      set({
        waypoints: withPositionalRoles(next),
        revision: state.revision + 1,
        dirty: true,
        past: options.history
          ? [...state.past, { waypoints: state.waypoints }].slice(-HISTORY_LIMIT)
          : state.past,
        future: options.history ? [] : state.future,
        refusal: null,
      });
    };

    const refuse = (code: DraftProblem) => set({ refusal: code });

    const find = (id: string) => get().waypoints.findIndex((waypoint) => waypoint.id === id);

    return {
      courseId: input.courseId,
      waypoints: initial,
      revision: 1,
      past: [],
      future: [],
      route: null,
      refusal: null,
      seededRevision: input.headRevision,
      seededWaypoints: input.waypoints,
      dirty: false,
      headConflict: null,
      pendingHead: null,
      acknowledgedSave: null,

      addVia: (position) => {
        if (!isValidPosition(position)) return refuse('WAYPOINT_POSITION_INVALID');
        const waypoints = get().waypoints;
        if (waypoints.length >= courseLimits.waypoints) return refuse('WAYPOINT_LIMIT_REACHED');
        // A via waypoint goes before the finish, so the start and the finish keep their
        // roles. Reordering afterwards is the list's job, not a side effect of adding.
        const next = [
          ...waypoints.slice(0, -1),
          {
            id: nextId(),
            role: 'via' as const,
            position,
            name: null,
            sourceSampleId: null,
            locked: false,
          },
          ...waypoints.slice(-1),
        ];
        change(next);
      },

      movePosition: (id, position) => {
        if (!isValidPosition(position)) return refuse('WAYPOINT_POSITION_INVALID');
        const index = find(id);
        if (index < 0) return refuse('WAYPOINT_NOT_FOUND');
        const waypoints = get().waypoints;
        const current = waypoints[index];
        if (!current) return refuse('WAYPOINT_NOT_FOUND');
        if (current.locked) return refuse('WAYPOINT_LOCKED');
        const next = [...waypoints];
        // A moved waypoint is no longer the recorded sample it started as. Keeping the
        // sample id would claim an observation for a position that was never observed.
        next[index] = { ...current, position, sourceSampleId: null };
        change(next);
      },

      rename: (id, name) => {
        const index = find(id);
        if (index < 0) return refuse('WAYPOINT_NOT_FOUND');
        const waypoints = get().waypoints;
        const current = waypoints[index];
        if (!current) return refuse('WAYPOINT_NOT_FOUND');
        const next = [...waypoints];
        next[index] = { ...current, name: name === null || name === '' ? null : name };
        change(next);
      },

      setLocked: (id, locked) => {
        const index = find(id);
        if (index < 0) return refuse('WAYPOINT_NOT_FOUND');
        const waypoints = get().waypoints;
        const current = waypoints[index];
        if (!current) return refuse('WAYPOINT_NOT_FOUND');
        const next = [...waypoints];
        next[index] = { ...current, locked };
        change(next);
      },

      moveEarlier: (id) => {
        const index = find(id);
        if (index <= 0) return refuse('WAYPOINT_NOT_FOUND');
        const waypoints = get().waypoints;
        const current = waypoints[index];
        const previous = waypoints[index - 1];
        if (!current || !previous) return refuse('WAYPOINT_NOT_FOUND');
        // Reordering moves both of them, so a lock on either one refuses the swap.
        if (current.locked || previous.locked) return refuse('WAYPOINT_LOCKED');
        const next = [...waypoints];
        next[index - 1] = current;
        next[index] = previous;
        change(next);
      },

      moveLater: (id) => {
        const waypoints = get().waypoints;
        const index = find(id);
        if (index < 0 || index >= waypoints.length - 1) return refuse('WAYPOINT_NOT_FOUND');
        const current = waypoints[index];
        const following = waypoints[index + 1];
        if (!current || !following) return refuse('WAYPOINT_NOT_FOUND');
        if (current.locked || following.locked) return refuse('WAYPOINT_LOCKED');
        const next = [...waypoints];
        next[index + 1] = current;
        next[index] = following;
        change(next);
      },

      remove: (id) => {
        const index = find(id);
        if (index < 0) return refuse('WAYPOINT_NOT_FOUND');
        const waypoints = get().waypoints;
        const current = waypoints[index];
        if (!current) return refuse('WAYPOINT_NOT_FOUND');
        if (current.locked) return refuse('WAYPOINT_LOCKED');
        if (waypoints.length <= 2) return refuse('WAYPOINT_MINIMUM_REACHED');
        change(waypoints.filter((waypoint) => waypoint.id !== id));
      },

      undo: () => {
        const state = get();
        if (state.revision >= courseLimits.maxDraftRevision) return refuse('DRAFT_LIMIT_REACHED');
        const previous = state.past.at(-1);
        if (!previous) return;
        set({
          past: state.past.slice(0, -1),
          future: [{ waypoints: state.waypoints }, ...state.future],
        });
        change(previous.waypoints, { history: false });
      },

      redo: () => {
        const state = get();
        if (state.revision >= courseLimits.maxDraftRevision) return refuse('DRAFT_LIMIT_REACHED');
        const [next, ...rest] = state.future;
        if (!next) return;
        set({
          past: [...state.past, { waypoints: state.waypoints }].slice(-HISTORY_LIMIT),
          future: rest,
        });
        change(next.waypoints, { history: false });
      },

      clearRefusal: () => set({ refusal: null }),

      /**
       * A result is applied only to the draft it was computed for.
       *
       * This is the whole point of the monotonic revision: by the time an answer arrives
       * the owner may have moved a waypoint, and applying a line computed for the previous
       * arrangement would show a route that does not belong to the waypoints on screen.
       * The stale answer is discarded and the caller is told so it can say what happened.
       */
      applyRoute: (route) => {
        if (route.draftRevision !== get().revision) return false;
        // A computed but unsaved route is unsaved work too: losing it to a rename would be
        // the same defect as losing a waypoint.
        set({ route, dirty: true });
        return true;
      },

      clearRoute: () => set({ route: null }),

      syncHead: (headRevision, waypoints) => {
        const state = get();
        if (headRevision === state.seededRevision) return;
        const adopt = () =>
          set({
            waypoints: draftWaypointsFromCourse(waypoints),
            revision: state.revision + 1,
            past: [],
            future: [],
            route: null,
            refusal: null,
            seededRevision: headRevision,
            seededWaypoints: waypoints,
            dirty: false,
            headConflict: null,
            pendingHead: null,
            acknowledgedSave: null,
          });
        const acknowledged = state.acknowledgedSave;
        const ownSave = acknowledged !== null && acknowledged.headRevision === headRevision;
        // Own save, and the draft is still the one that was saved: continue from it.
        // Own save of an *earlier* draft is not — the owner kept editing while the reply
        // was outstanding, and adopting would delete work the save never carried.
        if (!state.dirty || (ownSave && acknowledged.draftRevision === state.revision)) {
          adopt();
          return;
        }
        // The stored waypoints did not move — a rename, or anything else that leaves this
        // draft's subject alone. The seed moves forward and the edit continues untouched.
        if (sameStoredWaypoints(waypoints, state.seededWaypoints)) {
          set({ seededRevision: headRevision, seededWaypoints: waypoints, pendingHead: null });
          return;
        }
        set({
          pendingHead: { headRevision, waypoints },
          headConflict: {
            headRevision,
            reason: ownSave ? 'edited-after-own-save' : 'external',
          },
        });
      },

      adoptHead: () => {
        const pending = get().pendingHead;
        if (!pending) {
          set({ headConflict: null });
          return;
        }
        set({
          waypoints: draftWaypointsFromCourse(pending.waypoints),
          revision: get().revision + 1,
          past: [],
          future: [],
          route: null,
          refusal: null,
          seededRevision: pending.headRevision,
          seededWaypoints: pending.waypoints,
          dirty: false,
          headConflict: null,
          pendingHead: null,
          acknowledgedSave: null,
        });
      },

      // Keeping the draft does not pretend the conflict away: the seed stays where it was,
      // so the next stored change raises it again, and the save still carries the revision
      // the screen is showing, which the server compares under CAS.
      keepDraft: () => set({ headConflict: null }),

      acknowledgeSave: (headRevision, draftRevision) =>
        set({ acknowledgedSave: { headRevision, draftRevision } }),
    };
  });
}

export type CourseDraftStore = ReturnType<typeof createCourseDraftStore>;

/** The computed route, but only while it still belongs to the draft as it is now. */
export function currentRoute(state: CourseDraftState): ComputedDraftRoute | null {
  return state.route && state.route.draftRevision === state.revision ? state.route : null;
}
