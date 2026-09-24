import { createStore } from 'zustand/vanilla';
import {
  courseLimits,
  type CourseCandidateEvaluation,
  type CourseCandidateSearchSummary,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';

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

/**
 * One generated target-distance candidate as the screen holds it (M2-01i).
 *
 * It is a proposal. Holding four of them changes nothing about the course, picking one
 * changes nothing either, and only an explicit save writes a revision. The evaluation
 * travels with it because the owner has to read it before picking: target error, loop
 * closure, repeated sections, and the facts we have no data for at all.
 */
export interface DraftCandidate {
  readonly proposalId: string;
  readonly ordinal: number;
  readonly attemptIndex: number;
  readonly candidateSeed: string;
  readonly coordinates: readonly CoursePosition[];
  readonly engineDistanceMeters: number;
  readonly engineDurationSeconds: number;
  readonly graphBuildId: string;
  readonly engineVersion: string | null;
  readonly computedAt: string;
  readonly warnings: readonly string[];
  readonly evaluation: CourseCandidateEvaluation;
}

/** One bounded search, with the seed and bounds it ran under. */
export interface DraftCandidateSet {
  /** The draft revision this search ran for. It is current only for that one. */
  readonly draftRevision: number;
  readonly candidateSetId: string;
  readonly targetDistanceMeters: number;
  readonly searchSeed: string;
  readonly generatorVersion: string;
  readonly evaluationVersion: number;
  readonly bounds: {
    readonly maxCandidates: number;
    readonly maxAttempts: number;
    readonly searchBudgetMilliseconds: number;
    readonly maxSearchRadiusMeters: number;
    readonly distanceToleranceRatio: number;
  };
  readonly search: CourseCandidateSearchSummary;
  readonly candidates: readonly DraftCandidate[];
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
  /** The last generated candidate set, with the revision it belongs to. */
  candidates: DraftCandidateSet | null;
  /** Which candidate the owner has picked to look at. Picking saves nothing. */
  pickedCandidateId: string | null;
  /** Why the last attempted change was refused, so the screen can say it in words. */
  refusal: DraftProblem | null;
  /**
   * The waypoint the owner has selected, from the list or on the map — one selection, two
   * ways to make it. Selecting is not an edit: it advances no revision and has no history.
   */
  selectedWaypointId: string | null;
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
  /**
   * Put one waypoint at `toIndex` of the list. The only way the order changes: the list's
   * "앞으로/뒤로" buttons ask for one step, a drag (pointer or keyboard) for wherever it was
   * dropped, and both land here, so both are one undoable change under the same lock rule.
   */
  moveWaypoint(id: string, toIndex: number): void;
  remove(id: string): void;
  undo(): void;
  redo(): void;
  clearRefusal(): void;
  /** Select one waypoint, or none. Changes nothing about the draft itself. */
  selectWaypoint(id: string | null): void;
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
  /**
   * Record one generated candidate set. Ignored unless it belongs to the draft as it is
   * now — a search that finished after the waypoints moved is about a draft that is gone.
   */
  applyCandidates(set: DraftCandidateSet): boolean;
  /** Drop the candidate set, after a save or when the search produced nothing. */
  clearCandidates(): void;
  /** Look at one candidate. This is a selection on screen, not a save and not an approval. */
  pickCandidate(proposalId: string | null): void;
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
      candidates: null,
      pickedCandidateId: null,
      refusal: null,
      selectedWaypointId: null,
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
        const added = {
          id: nextId(),
          role: 'via' as const,
          position,
          name: null,
          sourceSampleId: null,
          locked: false,
        };
        // A draft started on an empty map (M2-01r) has no ends yet. Its first two points
        // are the start and the finish, in the order they were placed; putting the second
        // one before the first would make the point placed first the finish.
        if (waypoints.length < 2) {
          change([...waypoints, added]);
          return;
        }
        // A via waypoint goes before the finish, so the start and the finish keep their
        // roles. Reordering afterwards is the list's job, not a side effect of adding.
        change([...waypoints.slice(0, -1), added, ...waypoints.slice(-1)]);
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

      moveWaypoint: (id, toIndex) => {
        const waypoints = get().waypoints;
        const from = find(id);
        if (from < 0) return refuse('WAYPOINT_NOT_FOUND');
        if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= waypoints.length)
          return refuse('WAYPOINT_NOT_FOUND');
        // Dropped where it already was: nothing changed, so no revision and no history.
        if (toIndex === from) return;
        // Every waypoint between the two places shifts by one, so each of them moves — the
        // one carried and every one it passes. A lock on any of them refuses the move: a
        // locked waypoint keeps its place, and nothing is carried over it either.
        const low = Math.min(from, toIndex);
        const high = Math.max(from, toIndex);
        if (waypoints.slice(low, high + 1).some((waypoint) => waypoint.locked))
          return refuse('WAYPOINT_LOCKED');
        const next = [...waypoints];
        const [moved] = next.splice(from, 1);
        if (!moved) return refuse('WAYPOINT_NOT_FOUND');
        next.splice(toIndex, 0, moved);
        change(next);
      },

      remove: (id) => {
        const index = find(id);
        if (index < 0) return refuse('WAYPOINT_NOT_FOUND');
        const waypoints = get().waypoints;
        const current = waypoints[index];
        if (!current) return refuse('WAYPOINT_NOT_FOUND');
        if (current.locked) return refuse('WAYPOINT_LOCKED');
        // A stored course always keeps its two ends. A draft started on an empty map has no
        // stored ends to keep, so its points can all be taken back.
        if (get().seededWaypoints.length >= 2 && waypoints.length <= 2)
          return refuse('WAYPOINT_MINIMUM_REACHED');
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

      selectWaypoint: (id) => {
        if (id !== null && find(id) < 0) return refuse('WAYPOINT_NOT_FOUND');
        set({ selectedWaypointId: id });
      },

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

      /**
       * A search is applied only to the draft it ran for, for the same reason a computed
       * route is: by the time four candidates come back the owner may have moved a pin, and
       * offering loops built around the previous arrangement would be offering routes that
       * do not belong to the waypoints on screen.
       */
      applyCandidates: (candidateSet) => {
        if (candidateSet.draftRevision !== get().revision) return false;
        // Generated but unpicked candidates are unsaved work too, and a new search always
        // starts with nothing picked: nobody has read these yet.
        set({ candidates: candidateSet, pickedCandidateId: null, dirty: true });
        return true;
      },

      clearCandidates: () => set({ candidates: null, pickedCandidateId: null }),

      pickCandidate: (proposalId) => set({ pickedCandidateId: proposalId }),

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
            candidates: null,
            pickedCandidateId: null,
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
          candidates: null,
          pickedCandidateId: null,
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

/** The generated candidates, but only while they still belong to the draft as it is now. */
export function currentCandidates(state: CourseDraftState): DraftCandidateSet | null {
  return state.candidates && state.candidates.draftRevision === state.revision
    ? state.candidates
    : null;
}

/**
 * The candidate the owner is looking at, or `null`. A pick from a search that no longer
 * belongs to this draft is not a pick: it names a line computed for waypoints that have
 * since moved, and the screen has to say so rather than let it be saved.
 */
export function pickedCandidate(state: CourseDraftState): DraftCandidate | null {
  const set = currentCandidates(state);
  if (!set || state.pickedCandidateId === null) return null;
  return set.candidates.find((c) => c.proposalId === state.pickedCandidateId) ?? null;
}

/**
 * What the owner is looking at, as one of the distinct states the plan names (section 5:
 * "미계산·계산 중·stale" are told apart, and none of them is an error).
 *
 * - `stored`: the waypoints are exactly the ones saved. Nothing to compute.
 * - `incomplete`: a draft started on an empty map with fewer than two points. There is no
 *   start and finish yet, so there is nothing to join and nothing to compute.
 * - `uncomputed`: the waypoints differ from what is saved and no route has been computed for
 *   them. This is the **uncomputed draft** (S14 "미계산 초안"): whatever joins them on the map
 *   is a straight line nobody computed, and it is neither a walkable course nor a distance.
 * - `stale`: a route was computed, but for an earlier arrangement. It no longer belongs to the
 *   waypoints on screen, so the draft is uncomputed again — said differently because the
 *   owner did compute something and has to know it no longer applies.
 * - `computing`: a computation or a search for this draft is in flight.
 * - `computed`: a route or a picked candidate belongs to the draft as it is now.
 *
 * `computing` is the caller's to say — the store does not know about requests.
 */
export type DraftRouteStatus =
  'stored' | 'incomplete' | 'uncomputed' | 'stale' | 'computing' | 'computed';

export function draftRouteStatus(
  state: CourseDraftState,
  options: { readonly computing: boolean },
): DraftRouteStatus {
  if (options.computing) return 'computing';
  if (currentRoute(state) !== null || pickedCandidate(state) !== null) return 'computed';
  if (state.waypoints.length < 2) return 'incomplete';
  if (
    state.seededWaypoints.length >= 2 &&
    sameStoredWaypoints(draftRequestWaypoints(state.waypoints), state.seededWaypoints)
  )
    return 'stored';
  if (state.route !== null || state.candidates !== null) return 'stale';
  return 'uncomputed';
}
