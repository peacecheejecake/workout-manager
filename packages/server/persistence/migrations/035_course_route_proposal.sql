-- M2-01h stores what our own pedestrian engine computed for an edited waypoint draft.
--
-- A row here is a PROPOSAL: not an actual, not an approved plan and not a course revision.
-- Nothing about a course changes because one exists. It becomes a revision only when the
-- owner explicitly saves it, and that save consumes the row in the same transaction as the
-- revision write, so one computation can never become two courses and a course can never
-- be saved with the geometry of one draft and the waypoints of another.
--
-- This table is also where M2-01g's RouteComputationRecord finally lands. The adapter
-- records which engine, profile and graph answered and deliberately stores nothing; the
-- record travels from here into the immutable revision's generation conditions, which is
-- what lets a stored course say what computed it instead of being silently recomputed on a
-- newer graph later.

CREATE TABLE course_route_proposal (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  proposal_id uuid NOT NULL,
  -- Proposals belong to a course. The waypoint editor edits an existing course, so a
  -- proposal always has an owner row to be reclaimed and erased with.
  course_id uuid NOT NULL,
  -- The draft revision the waypoints were taken from. A save must name the same one: a
  -- draft that moved on has to be recomputed rather than saved from a stale answer.
  draft_revision integer NOT NULL CHECK (draft_revision BETWEEN 1 AND 1000000),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  -- Planned input the owner placed, and the line the engine answered with. Both are
  -- private location data and both are removed by reclamation, deletion and erasure.
  waypoints jsonb NOT NULL
    CHECK (jsonb_typeof(waypoints)='array' AND octet_length(waypoints::text)<=65536),
  geometry jsonb NOT NULL
    CHECK (jsonb_typeof(geometry)='object' AND octet_length(geometry::text)<=1048576),
  -- SHA-256 of the geometry as it was stored. The save compares the content it is about to
  -- write against this value inside the writing transaction, so what is recorded is the
  -- line that was actually proposed and reviewed.
  geometry_sha256 text NOT NULL CHECK (geometry_sha256 ~ '^[a-f0-9]{64}$'),
  -- The engine's own estimates. Never a device distance, a recomputed recording distance
  -- or the planned line length the course itself carries.
  engine_distance_meters double precision NOT NULL
    CHECK (engine_distance_meters>=0 AND engine_distance_meters<=250000),
  engine_duration_seconds double precision NOT NULL
    CHECK (engine_duration_seconds>=0 AND engine_duration_seconds<=2592000),
  snapped_waypoints jsonb NOT NULL
    CHECK (jsonb_typeof(snapped_waypoints)='array'
      AND octet_length(snapped_waypoints::text)<=65536),
  -- The RouteComputationRecord. Engine, profile, graph identity, conditions, request
  -- revision, computation time and warnings; no coordinate is in here.
  computation jsonb NOT NULL
    CHECK (jsonb_typeof(computation)='object' AND octet_length(computation::text)<=8192),
  graph_build_id text NOT NULL CHECK (graph_build_id ~ '^[0-9a-f]{16}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_course_revision integer CHECK (consumed_course_revision BETWEEN 1 AND 2147483646),
  PRIMARY KEY (athlete_id,proposal_id),
  CHECK (expires_at>created_at),
  CHECK ((consumed_at IS NULL AND consumed_course_revision IS NULL)
      OR (consumed_at IS NOT NULL AND consumed_course_revision IS NOT NULL)),
  -- ON DELETE CASCADE: deleting a course takes its unsaved proposals with it. The runtime
  -- role has no DELETE on this table, so that cascade and the bounded functions below are
  -- the only ways a row leaves.
  FOREIGN KEY (athlete_id,course_id) REFERENCES course(athlete_id,course_id) ON DELETE CASCADE
);
CREATE INDEX course_route_proposal_open
  ON course_route_proposal(athlete_id,course_id,expires_at) WHERE consumed_at IS NULL;

ALTER TABLE course_route_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_route_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY course_tenant ON course_route_proposal
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- A proposal is written once. Only `consumed_at`/`consumed_course_revision` may ever
-- change, and only from unset to set: consuming one twice is not an update, it is a second
-- course from one reviewed computation.
CREATE FUNCTION course_route_proposal_write_once() RETURNS trigger
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
  THEN RAISE EXCEPTION 'IMMUTABLE_ROUTE_PROPOSAL'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_route_proposal_write_once() FROM PUBLIC;
CREATE TRIGGER course_route_proposal_write_once
  BEFORE UPDATE OR DELETE ON course_route_proposal
  FOR EACH ROW EXECUTE FUNCTION course_route_proposal_write_once();

-- Reclamation reaches proposals too.
--
-- A draft's waypoints are frequently the recording's own coordinates, moved or not, and the
-- computed line runs between them. Leaving proposals behind when the source activity is
-- deleted would keep exactly the coordinates the reclamation exists to remove, and would
-- leave a saveable route pointing at a course that no longer has any. The tombstone
-- transaction removes them in the same statement sequence that empties the revisions.
CREATE FUNCTION course_route_proposal_reclaim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  DELETE FROM public.course_route_proposal p
    WHERE p.athlete_id=NEW.athlete_id
      AND EXISTS(SELECT 1 FROM public.course_revision_source s
        WHERE s.athlete_id=p.athlete_id AND s.course_id=p.course_id AND s.activity_id=NEW.id);
  -- A BEFORE row trigger that returns NULL cancels the statement. This one only cleans up
  -- alongside the tombstone; it must never stop the deletion it is reacting to.
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_route_proposal_reclaim() FROM PUBLIC;
-- BEFORE, because the AFTER trigger that reclaims courses deletes the lineage rows this
-- one reads to find them. Naming alone would not help: triggers on the same event fire in
-- name order, and `course_reclaim_…` sorts before `course_route_proposal_…`.
CREATE TRIGGER course_route_proposal_reclaim BEFORE UPDATE ON activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION course_route_proposal_reclaim();

-- Consuming one proposal, inside the transaction that writes the revision.
--
-- Everything that makes a save honest is checked here rather than in the application in
-- front of it: the proposal belongs to this course, it was computed from the draft being
-- saved, it has not expired, it has not already been used, and the geometry about to be
-- written is byte-for-byte the line that was proposed. The runtime role has no UPDATE
-- privilege on the table, so this function is its only way to consume one.
CREATE FUNCTION public.consume_course_route_proposal(uuid,uuid,integer,text,integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE row_found public.course_route_proposal%ROWTYPE;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTE_PROPOSAL'; END IF;
  SELECT * INTO row_found FROM public.course_route_proposal p
    WHERE p.athlete_id=tenant AND p.proposal_id=$1 FOR UPDATE;
  IF row_found.proposal_id IS NULL THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_NOT_FOUND'; END IF;
  IF row_found.course_id IS DISTINCT FROM $2 THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_NOT_FOUND'; END IF;
  IF row_found.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_ALREADY_SAVED'; END IF;
  IF row_found.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_EXPIRED'; END IF;
  IF row_found.draft_revision IS DISTINCT FROM $3 THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_STALE_DRAFT'; END IF;
  IF row_found.geometry_sha256 IS DISTINCT FROM $4 THEN RAISE EXCEPTION 'ROUTE_PROPOSAL_CONTENT_MISMATCH'; END IF;
  UPDATE public.course_route_proposal
    SET consumed_at=clock_timestamp(),consumed_course_revision=$5
    WHERE athlete_id=tenant AND proposal_id=$1;
  RETURN jsonb_build_object('graph_build_id',row_found.graph_build_id);
END $$;
REVOKE ALL ON FUNCTION public.consume_course_route_proposal(uuid,uuid,integer,text,integer)
  FROM PUBLIC;

-- Bounded reaper for proposals nobody saved. It is called when a new one is written, so
-- the table cannot grow without an owner acting, and it only ever removes the tenant's own
-- expired rows.
CREATE FUNCTION public.reap_course_route_proposals() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE removed integer;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTE_PROPOSAL'; END IF;
  WITH gone AS (
    DELETE FROM public.course_route_proposal p
      WHERE p.athlete_id=tenant
        AND (p.expires_at<=clock_timestamp() OR p.consumed_at IS NOT NULL)
      RETURNING 1)
  SELECT count(*)::integer INTO removed FROM gone;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.reap_course_route_proposals() FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_route_proposals;
REVOKE ALL ON FUNCTION public.erase_account_before_route_proposals(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_route_proposals(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_route_proposals(text) FROM %I',role_name); END LOOP;
END $$;
-- Erasure removes unsaved proposals before the courses they belong to, so the cascade has
-- nothing left to do and no computed line outlives the account.
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  DELETE FROM public.course_route_proposal WHERE athlete_id=$1;
  RETURN public.erase_account_before_route_proposals($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
