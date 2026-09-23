-- M2-01p: a new answer replaces the unsaved answers the editor can no longer use.
--
-- Migration 035 bounds how many unsaved proposals a course and a tenant may hold (5 and 20,
-- each living 30 minutes). The bound exists so that stored private coordinates cannot pile
-- up without the owner acting, and so that one owner cannot fill the table. It counted
-- EVERY unconsumed, unexpired row, and that was the defect: the waypoint editor keeps one
-- computed route and one search, and only for the draft on screen. Every edit advances the
-- draft, so the rows of the previous drafts were already dead to the editor and still held
-- their seats for 30 minutes. The sixth recompute inside half an hour was refused with
-- ROUTE_PROPOSAL_QUOTA_EXCEEDED, after the engine had done the work — the S14 edit loop
-- stopped in ordinary use (M2-01k F1, K-s14-edit-loop).
--
-- Only not counting them would have been the wrong fix. The server has no notion of "the
-- editor's current draft": any client that sends a row's own draft revision can still save
-- it (035's consume). Leaving those rows saveable while no longer counting them would turn
-- the bound into a number that measures nothing — a client could hold any number of
-- saveable routes by stepping its draft revision. So the rows the editor has moved past are
-- REMOVED, in the transaction that stores the new answer. What is not stored cannot be
-- saved, holds no coordinates, and needs no seat.
--
-- The rule, for one course, when an answer for draft revision N is stored:
--
--   * An answer of the same kind replaces the previous one of that kind, whatever its draft.
--     The editor holds exactly one computed route and one search; a recompute or a new
--     search overwrites the one it had, and a review never carries over to a new answer.
--   * An answer of the other kind survives only if it is for the same draft N. The editor
--     shows a route and a search side by side only while both belong to the draft on screen.
--
-- "Kind" is a plain route proposal (`candidate_set_id IS NULL`) or a search. A search is
-- replaced as a whole: its set row goes and its candidates go with it through the same
-- foreign-key cascade the reaper uses.
--
-- Draft revisions are compared for EQUALITY, not order. A draft revision is numbered per
-- editing session and starts again at 1 when the editor is opened afresh, so "older" is
-- not something the server can tell. A reload must not leave the previous session's rows
-- holding seats for half an hour.
--
-- A course therefore never holds more than one route plus one search (at most four
-- candidates) — five, which is the per-course bound. The per-course check stays as the
-- invariant it now is. The per-tenant bound (20, across courses) is still reachable and is
-- what an owner editing many courses in half an hour can meet.
--
-- The cost, stated: two editors open on the same course replace each other's unsaved
-- answers. The one whose answer went finds out at save time as "expired or already saved,
-- recompute", which is true. Two editors on one course already conflict at save through
-- the revision CAS, so this is where they would have met anyway.
--
-- Nothing here edits an earlier migration or an existing function. The consume functions,
-- both reapers, deletion and erasure are unchanged.

-- Removing the rows a new answer replaces. Called under the tenant command lock, after the
-- set reaper and before the proposal reaper, so it takes rows in the one order every writer
-- of these two tables follows: searches first (their candidates go with them through the
-- cascade), then the plain proposals. Only the calling tenant's rows, only this course, and
-- only unsaved ones — a consumed row is the reaper's, and removing it here would change
-- nothing but the order.
CREATE FUNCTION public.supersede_course_route_proposals(uuid,integer,boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE removed_sets integer;
DECLARE removed_routes integer;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTE_PROPOSAL'; END IF;
  IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTE_PROPOSAL'; END IF;
  -- $3: the answer being stored is a search. A search replaces every search of the course;
  -- a route leaves the searches of its own draft alone.
  WITH gone AS (
    DELETE FROM public.course_route_candidate_set s
      WHERE s.athlete_id=tenant AND s.course_id=$1 AND s.consumed_at IS NULL
        AND ($3 OR s.draft_revision<>$2)
      RETURNING 1)
  SELECT count(*)::integer INTO removed_sets FROM gone;
  -- A route replaces every route of the course; a search leaves the route of its own draft.
  WITH gone AS (
    DELETE FROM public.course_route_proposal p
      WHERE p.athlete_id=tenant AND p.course_id=$1 AND p.candidate_set_id IS NULL
        AND p.consumed_at IS NULL
        AND (NOT $3 OR p.draft_revision<>$2)
      RETURNING 1)
  SELECT count(*)::integer INTO removed_routes FROM gone;
  RETURN removed_sets+removed_routes;
END $$;
REVOKE ALL ON FUNCTION public.supersede_course_route_proposals(uuid,integer,boolean) FROM PUBLIC;

-- How many unsaved proposals would still hold a seat once storing an answer for course $1,
-- draft $2, kind $3 has reaped and superseded what it will. The same rule as the function
-- above, read the other way round, next to it so the two are changed together.
--
-- The API asks this BEFORE it spends engine time, so an owner who is at the bound is told
-- so without the engine computing a route that would only be thrown away. It is a read and
-- takes no lock: the store checks again under the tenant lock, after it has reaped and
-- superseded, which is what closes the gap between this answer and the write.
--
-- SECURITY INVOKER: the caller's own row-level security decides what it can count.
-- VOLATILE, because it reads `clock_timestamp()` exactly as the reapers do.
CREATE FUNCTION public.course_route_proposal_room(uuid,integer,boolean)
RETURNS TABLE(for_course integer,for_tenant integer)
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT count(*) FILTER (WHERE p.course_id=$1)::integer,count(*)::integer
  FROM public.course_route_proposal p
  LEFT JOIN public.course_route_candidate_set s
    ON s.athlete_id=p.athlete_id AND s.candidate_set_id=p.candidate_set_id
  WHERE p.athlete_id=nullif(current_setting('app.athlete_id',true),'')
    -- What the proposal reaper removes: saved or expired rows.
    AND p.consumed_at IS NULL AND p.expires_at>clock_timestamp()
    -- What the search reaper removes with its cascade: candidates of a spent or expired
    -- search. A spent search's siblings can never be saved.
    AND (p.candidate_set_id IS NULL
      OR (s.consumed_at IS NULL AND s.expires_at>clock_timestamp()))
    -- What the supersession above removes.
    AND (p.course_id<>$1 OR (p.draft_revision=$2 AND (p.candidate_set_id IS NOT NULL)<>$3))
$$;
REVOKE ALL ON FUNCTION public.course_route_proposal_room(uuid,integer,boolean) FROM PUBLIC;
