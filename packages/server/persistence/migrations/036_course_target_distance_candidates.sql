-- M2-01i stores what one bounded target-distance search generated.
--
-- A target distance is an APPROXIMATION. A search produces at most a handful of
-- CANDIDATES, and a candidate is a proposal exactly like the one migration 035 stores:
-- not an actual, not an approved plan and not a course revision. Generating four of them
-- changes nothing about the course — no head moves, no revision appears — and at most one
-- of them can ever become a revision, because picking one consumes it in the same
-- transaction as the write.
--
-- Candidates reuse `course_route_proposal` rather than getting a table of their own. That
-- is deliberate: the write-once trigger, the reclamation on activity deletion, the bounded
-- reaper, the erasure path and the runtime role's complete lack of UPDATE and DELETE all
-- already hold there, and duplicating them would mean maintaining two copies of rules that
-- took several review rounds to get right. What a candidate adds is the search it came
-- from, its place in that search, the seed that reproduces it, and its evaluation.

CREATE TABLE course_route_candidate_set (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  candidate_set_id uuid NOT NULL,
  course_id uuid NOT NULL,
  -- The draft the search ran for. Picking a candidate must name the same one.
  draft_revision integer NOT NULL CHECK (draft_revision BETWEEN 1 AND 1000000),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  -- The approximation asked for. Never an achieved distance.
  target_distance_meters double precision NOT NULL
    CHECK (target_distance_meters>=500 AND target_distance_meters<=50000),
  -- The seed the whole search ran from. Recorded so the same search can be run again.
  search_seed text NOT NULL CHECK (search_seed ~ '^[0-9a-f]{16}$'),
  generator_version text NOT NULL CHECK (generator_version='target-distance-loop-v1'),
  evaluation_version integer NOT NULL CHECK (evaluation_version=1),
  -- The bounds this run was allowed, and what it actually did inside them. The attempt log
  -- keeps the rejected attempts, so a reader can see that eight computations produced two
  -- candidates. Neither column carries a coordinate.
  bounds jsonb NOT NULL
    CHECK (jsonb_typeof(bounds)='object' AND octet_length(bounds::text)<=2048),
  search jsonb NOT NULL
    CHECK (jsonb_typeof(search)='object' AND octet_length(search::text)<=8192),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- A search offers several routes and the owner chooses ONE. That choice is recorded HERE,
  -- on the search, not only on the chosen candidate: the draft revision cannot tell a second
  -- choice apart from the first because it is a stored value that does not move when the
  -- course does, so without this a second sibling could be saved at the new head revision
  -- and one search would become two courses.
  consumed_at timestamptz,
  consumed_proposal_id uuid,
  consumed_course_revision integer CHECK (consumed_course_revision BETWEEN 1 AND 2147483646),
  PRIMARY KEY (athlete_id,candidate_set_id),
  CHECK (expires_at>created_at),
  CHECK ((consumed_at IS NULL AND consumed_proposal_id IS NULL AND consumed_course_revision IS NULL)
      OR (consumed_at IS NOT NULL AND consumed_proposal_id IS NOT NULL
        AND consumed_course_revision IS NOT NULL)),
  FOREIGN KEY (athlete_id,course_id) REFERENCES course(athlete_id,course_id) ON DELETE CASCADE
);
CREATE INDEX course_route_candidate_set_open
  ON course_route_candidate_set(athlete_id,course_id,expires_at);

ALTER TABLE course_route_candidate_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_route_candidate_set FORCE ROW LEVEL SECURITY;
CREATE POLICY course_tenant ON course_route_candidate_set
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- A search is written once. The only change it may ever undergo is being spent: the three
-- consumption columns going from unset to set, together, once. Everything else is immutable,
-- so a spent search cannot be un-spent and a search cannot be rewritten around a save.
CREATE FUNCTION course_route_candidate_set_write_once() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE table_owner text:=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID);
BEGIN
  IF TG_OP='DELETE' THEN
    IF current_user=table_owner THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_ROUTE_CANDIDATE_SET';
  END IF;
  IF OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
    OR NEW.consumed_proposal_id IS NULL
    OR NEW.consumed_course_revision IS NULL
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.candidate_set_id IS DISTINCT FROM OLD.candidate_set_id
    OR NEW.course_id IS DISTINCT FROM OLD.course_id
    OR NEW.draft_revision IS DISTINCT FROM OLD.draft_revision
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.target_distance_meters IS DISTINCT FROM OLD.target_distance_meters
    OR NEW.search_seed IS DISTINCT FROM OLD.search_seed
    OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
    OR NEW.evaluation_version IS DISTINCT FROM OLD.evaluation_version
    OR NEW.bounds IS DISTINCT FROM OLD.bounds
    OR NEW.search IS DISTINCT FROM OLD.search
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN RAISE EXCEPTION 'IMMUTABLE_ROUTE_CANDIDATE_SET'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_route_candidate_set_write_once() FROM PUBLIC;
CREATE TRIGGER course_route_candidate_set_write_once
  BEFORE UPDATE OR DELETE ON course_route_candidate_set
  FOR EACH ROW EXECUTE FUNCTION course_route_candidate_set_write_once();

-- What makes a proposal row a candidate. All five are set together or none is: a candidate
-- without its search, its place in it or its evaluation is not a candidate.
ALTER TABLE course_route_proposal
  ADD COLUMN candidate_set_id uuid,
  ADD COLUMN candidate_ordinal integer CHECK (candidate_ordinal BETWEEN 0 AND 3),
  ADD COLUMN candidate_attempt_index integer CHECK (candidate_attempt_index BETWEEN 0 AND 7),
  ADD COLUMN candidate_seed text CHECK (candidate_seed ~ '^[0-9a-f]{16}$'),
  ADD COLUMN candidate_evaluation jsonb
    CHECK (candidate_evaluation IS NULL
      OR (jsonb_typeof(candidate_evaluation)='object'
        AND octet_length(candidate_evaluation::text)<=8192)),
  ADD CONSTRAINT course_route_proposal_candidate_complete CHECK (
    (candidate_set_id IS NULL AND candidate_ordinal IS NULL AND candidate_attempt_index IS NULL
      AND candidate_seed IS NULL AND candidate_evaluation IS NULL)
    OR (candidate_set_id IS NOT NULL AND candidate_ordinal IS NOT NULL
      AND candidate_attempt_index IS NOT NULL AND candidate_seed IS NOT NULL
      AND candidate_evaluation IS NOT NULL)),
  -- ON DELETE CASCADE: reaping or erasing a search takes its candidates with it. The
  -- runtime role has no DELETE on either table, so only the bounded SECURITY DEFINER
  -- functions below can trigger it.
  ADD CONSTRAINT course_route_proposal_candidate_set
    FOREIGN KEY (athlete_id,candidate_set_id)
    REFERENCES course_route_candidate_set(athlete_id,candidate_set_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX course_route_proposal_candidate_ordinal
  ON course_route_proposal(athlete_id,candidate_set_id,candidate_ordinal)
  WHERE candidate_set_id IS NOT NULL;

-- The write-once rule now covers the candidate columns too. Without this a consumed-at
-- update could carry a different evaluation, a different ordinal or a different search
-- alongside it, and the row would stop describing what was generated and reviewed.
CREATE OR REPLACE FUNCTION course_route_proposal_write_once() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE table_owner text:=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID);
BEGIN
  IF TG_OP='DELETE' THEN
    IF current_user=table_owner THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_ROUTE_PROPOSAL';
  END IF;
  IF OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
    OR NEW.consumed_course_revision IS NULL
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
    OR NEW.course_id IS DISTINCT FROM OLD.course_id
    OR NEW.draft_revision IS DISTINCT FROM OLD.draft_revision
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.waypoints IS DISTINCT FROM OLD.waypoints
    OR NEW.geometry IS DISTINCT FROM OLD.geometry
    OR NEW.geometry_sha256 IS DISTINCT FROM OLD.geometry_sha256
    OR NEW.engine_distance_meters IS DISTINCT FROM OLD.engine_distance_meters
    OR NEW.engine_duration_seconds IS DISTINCT FROM OLD.engine_duration_seconds
    OR NEW.snapped_waypoints IS DISTINCT FROM OLD.snapped_waypoints
    OR NEW.computation IS DISTINCT FROM OLD.computation
    OR NEW.graph_build_id IS DISTINCT FROM OLD.graph_build_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.candidate_set_id IS DISTINCT FROM OLD.candidate_set_id
    OR NEW.candidate_ordinal IS DISTINCT FROM OLD.candidate_ordinal
    OR NEW.candidate_attempt_index IS DISTINCT FROM OLD.candidate_attempt_index
    OR NEW.candidate_seed IS DISTINCT FROM OLD.candidate_seed
    OR NEW.candidate_evaluation IS DISTINCT FROM OLD.candidate_evaluation
  THEN RAISE EXCEPTION 'IMMUTABLE_ROUTE_PROPOSAL'; END IF;
  RETURN NEW;
END $$;

-- Reclamation reaches searches as well as their candidates.
--
-- Migration 035's BEFORE trigger already removes the candidate rows of a reclaimed course
-- (they are proposals). The search they belonged to would otherwise stay behind naming a
-- course whose coordinates have been removed, and its candidates would be gone while it
-- still claimed to offer them.
CREATE FUNCTION course_route_candidate_set_reclaim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  DELETE FROM public.course_route_candidate_set s
    WHERE s.athlete_id=NEW.athlete_id
      AND EXISTS(SELECT 1 FROM public.course_revision_source r
        WHERE r.athlete_id=s.athlete_id AND r.course_id=s.course_id AND r.activity_id=NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_route_candidate_set_reclaim() FROM PUBLIC;
-- BEFORE, for the same reason 035's is: the AFTER trigger that reclaims courses deletes the
-- lineage rows this one reads to find them.
CREATE TRIGGER course_route_candidate_set_reclaim BEFORE UPDATE ON activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION course_route_candidate_set_reclaim();

-- Picking one candidate, inside the transaction that writes the revision.
--
-- Everything `consume_course_route_proposal` checks is checked here, plus two more things.
-- The candidate must belong to the search the request named, otherwise a save could record
-- a revision whose conditions point at a search the line did not come from. And **the
-- search itself is spent**: it is locked first, refused if a candidate has already been
-- chosen from it, and marked in the same statement sequence as the candidate. Checking the
-- draft revision is not enough for that — it is a stored value that does not move when the
-- course does, so a sibling could be saved at the new head under the same draft revision.
-- One search, one revision, and the siblings stop being offered the moment one is taken.
--
-- The search is locked BEFORE the candidate. Every path that removes both now takes them in
-- that order too — the reaper and the activity tombstone did already, and `delete_course` is
-- replaced below to stop relying on foreign-key cascade order, which took them the other way
-- round and deadlocked against the reaper (observed as 40P01). An ordering rule is only a
-- rule if every writer of those rows follows it, including the ones this change did not
-- otherwise touch.
CREATE FUNCTION public.consume_course_route_candidate(uuid,uuid,uuid,integer,text,integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE row_found public.course_route_proposal%ROWTYPE;
DECLARE set_found public.course_route_candidate_set%ROWTYPE;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTE_PROPOSAL'; END IF;
  SELECT * INTO set_found FROM public.course_route_candidate_set s
    WHERE s.athlete_id=tenant AND s.candidate_set_id=$2 FOR UPDATE;
  IF set_found.candidate_set_id IS NULL THEN RAISE EXCEPTION 'ROUTE_CANDIDATE_SET_MISMATCH'; END IF;
  IF set_found.course_id IS DISTINCT FROM $3 THEN RAISE EXCEPTION 'ROUTE_CANDIDATE_SET_MISMATCH'; END IF;
  IF set_found.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'ROUTE_CANDIDATE_ALREADY_CHOSEN'; END IF;
  SELECT * INTO row_found FROM public.course_route_proposal p
    WHERE p.athlete_id=tenant AND p.proposal_id=$1 FOR UPDATE;
  IF row_found.proposal_id IS NULL THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_NOT_FOUND'; END IF;
  IF row_found.course_id IS DISTINCT FROM $3 THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_NOT_FOUND'; END IF;
  IF row_found.candidate_set_id IS NULL OR row_found.candidate_set_id IS DISTINCT FROM $2
    THEN RAISE EXCEPTION 'ROUTE_CANDIDATE_SET_MISMATCH'; END IF;
  IF row_found.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_ALREADY_SAVED'; END IF;
  IF set_found.expires_at<=clock_timestamp() OR row_found.expires_at<=clock_timestamp()
    THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_EXPIRED'; END IF;
  IF row_found.draft_revision IS DISTINCT FROM $4
    OR set_found.draft_revision IS DISTINCT FROM $4
    THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_STALE_DRAFT'; END IF;
  IF row_found.geometry_sha256 IS DISTINCT FROM $5
    THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_CONTENT_MISMATCH'; END IF;
  UPDATE public.course_route_candidate_set
    SET consumed_at=clock_timestamp(),consumed_proposal_id=$1,consumed_course_revision=$6
    WHERE athlete_id=tenant AND candidate_set_id=$2;
  UPDATE public.course_route_proposal
    SET consumed_at=clock_timestamp(),consumed_course_revision=$6
    WHERE athlete_id=tenant AND proposal_id=$1;
  RETURN jsonb_build_object(
    'graph_build_id',row_found.graph_build_id,
    'search_seed',set_found.search_seed,
    'target_distance_meters',set_found.target_distance_meters);
END $$;
REVOKE ALL ON FUNCTION
  public.consume_course_route_candidate(uuid,uuid,uuid,integer,text,integer) FROM PUBLIC;

-- A candidate is a proposal row, which is how it inherits every rule migration 035
-- established. It must NOT inherit the generic save with it. The generic path records
-- `routed-waypoints` conditions, which carry no target distance, no seed and no evaluation:
-- a course saved through it would be unable to say which search produced it, and the search
-- would stay unspent with its siblings still on offer. The refusal lives in the function
-- rather than only in the application, because this function is the runtime role's only way
-- to consume a proposal at all.
CREATE OR REPLACE FUNCTION public.consume_course_route_proposal(uuid,uuid,integer,text,integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE row_found public.course_route_proposal%ROWTYPE;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTE_PROPOSAL'; END IF;
  SELECT * INTO row_found FROM public.course_route_proposal p
    WHERE p.athlete_id=tenant AND p.proposal_id=$1 FOR UPDATE;
  IF row_found.proposal_id IS NULL THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_NOT_FOUND'; END IF;
  IF row_found.course_id IS DISTINCT FROM $2 THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_NOT_FOUND'; END IF;
  IF row_found.candidate_set_id IS NOT NULL THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_IS_CANDIDATE'; END IF;
  IF row_found.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_ALREADY_SAVED'; END IF;
  IF row_found.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_EXPIRED'; END IF;
  IF row_found.draft_revision IS DISTINCT FROM $3 THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_STALE_DRAFT'; END IF;
  IF row_found.geometry_sha256 IS DISTINCT FROM $4 THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_CONTENT_MISMATCH'; END IF;
  UPDATE public.course_route_proposal
    SET consumed_at=clock_timestamp(),consumed_course_revision=$5
    WHERE athlete_id=tenant AND proposal_id=$1;
  RETURN jsonb_build_object('graph_build_id',row_found.graph_build_id);
END $$;

-- Course deletion, taking the same rows in the same order as everything else.
--
-- Migration 034 deleted the course row and let two foreign keys cascade: one from
-- `course_route_proposal.course_id` and one from `course_route_candidate_set.course_id`.
-- The order between them is the database's business, and in practice it took the candidate
-- rows first and the search row second — the opposite of the reaper, which deletes the
-- search and lets ITS foreign key take the candidates. Two writers, two rows, two orders:
-- reproduced as `40P01 deadlock detected` with the real `delete_course` against the real
-- reaper's lock. Nothing about it was specific to this node's tables; it appeared the moment
-- a second foreign key started pointing at the same pair.
--
-- So the deletion does the removal itself, in the one order: searches first (their
-- candidates go with them through the same cascade the reaper uses), then any proposal that
-- was never part of a search, then the revisions and the course. By the time the course row
-- goes, both cascades have nothing left to do. The rest of the function is 034's, unchanged:
-- a missing course is `false`, and a stale expectation on an available course still raises.
CREATE OR REPLACE FUNCTION public.delete_course(uuid,integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE current_head integer;
DECLARE current_status text;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_COURSE_DELETE'; END IF;
  SELECT c.head_revision,c.status INTO current_head,current_status FROM public.course c
    WHERE c.athlete_id=tenant AND c.course_id=$1 FOR UPDATE;
  IF current_status IS NULL THEN RETURN false; END IF;
  -- A reclaimed course has no revision left to expect; its reference is removed as it is.
  IF current_status='available' AND current_head IS DISTINCT FROM $2 THEN
    RAISE EXCEPTION 'COURSE_REVISION_CONFLICT';
  END IF;
  DELETE FROM public.course_route_candidate_set
    WHERE athlete_id=tenant AND course_id=$1;
  DELETE FROM public.course_route_proposal
    WHERE athlete_id=tenant AND course_id=$1;
  DELETE FROM public.course_revision WHERE athlete_id=tenant AND course_id=$1;
  DELETE FROM public.course WHERE athlete_id=tenant AND course_id=$1;
  RETURN true;
END $$;

-- Bounded reaper for searches that are over: expired, or already spent. Called when a new
-- search is written, so the table cannot grow without an owner acting, and only the
-- tenant's own rows go. The cascade takes their candidate proposals with them.
--
-- Spent searches are included deliberately. Once a candidate has been chosen the siblings
-- can never become anything, but they are still unconsumed proposal rows holding private
-- coordinates, and they would keep counting against the proposal quota the owner needs for
-- the next search. Rows that cannot be used are not rows worth keeping.
CREATE FUNCTION public.reap_course_route_candidate_sets() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE removed integer;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTE_PROPOSAL'; END IF;
  WITH gone AS (
    DELETE FROM public.course_route_candidate_set s
      WHERE s.athlete_id=tenant
        AND (s.expires_at<=clock_timestamp() OR s.consumed_at IS NOT NULL)
      RETURNING 1)
  SELECT count(*)::integer INTO removed FROM gone;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.reap_course_route_candidate_sets() FROM PUBLIC;

-- Erasure, taking the same two rows in the same order as everything else.
--
-- Removing rows was never the problem here: `course_route_candidate_set` cascades from
-- `course`, so erasing the courses already took the searches and their candidates with
-- them, and an explicit DELETE added purely for tidiness failed no test when reverted.
-- The ORDER is the problem. Migration 035's erasure deletes every proposal row first —
-- candidates included — and only then deletes the courses, whose cascade reaches the
-- searches. That is candidate-then-search, the opposite of the reaper, the tombstone
-- triggers, the consume function and now `delete_course`. One writer going the other way is
-- all a deadlock needs, which is exactly what `delete_course` demonstrated.
--
-- So the searches go first, and the candidates go with them through the cascade the reaper
-- uses. What 035 deletes afterwards is then only the proposals that were never candidates.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_route_candidates;
REVOKE ALL ON FUNCTION public.erase_account_before_route_candidates(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_route_candidates(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_route_candidates(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  DELETE FROM public.course_route_candidate_set WHERE athlete_id=$1;
  RETURN public.erase_account_before_route_candidates($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
