-- M2-01f stores private courses: planned lines with their own identity, cut from a stored
-- recording or copied from another course. A course is not an Activity and not a
-- PlanVersion, and nothing here can write to either: the tables below reference
-- activity_canonical only to remember where coordinates came from, and the recording keeps
-- its own rows untouched.
--
-- Three invariants are enforced here rather than in the application in front of them:
-- a revision is immutable, the head advances by exactly one revision at a time, and a
-- course whose source recording is deleted is reclaimed in the same transaction as the
-- tombstone. Public sharing is not modelled at all — there is no visibility value other
-- than 'private' and no ACL column to set.

CREATE TABLE course (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  -- User text. It is the only thing kept when a course is reclaimed, so the owner can see
  -- which of their courses became unavailable; no coordinate survives reclamation.
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name=btrim(name)),
  visibility text NOT NULL CHECK (visibility='private'),
  status text NOT NULL CHECK (status IN ('available','unavailable')),
  head_revision integer CHECK (head_revision BETWEEN 1 AND 2147483646),
  revision_id uuid,
  unavailable_reason text
    CHECK (unavailable_reason IS NULL OR unavailable_reason='source_activity_deleted'),
  reclaimed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,course_id),
  CHECK (updated_at>=created_at),
  CHECK ((status='available' AND head_revision IS NOT NULL AND revision_id IS NOT NULL
        AND unavailable_reason IS NULL AND reclaimed_at IS NULL)
      OR (status='unavailable' AND head_revision IS NULL AND revision_id IS NULL
        AND unavailable_reason IS NOT NULL AND reclaimed_at IS NOT NULL))
);

-- Immutable revisions. Geometry, waypoints, the conditions the revision was generated
-- under and its content digest are written once; an edit appends the next revision.
CREATE TABLE course_revision (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  course_revision integer NOT NULL CHECK (course_revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name=btrim(name)),
  geometry jsonb NOT NULL
    CHECK (jsonb_typeof(geometry)='object' AND octet_length(geometry::text)<=1048576),
  waypoints jsonb NOT NULL
    CHECK (jsonb_typeof(waypoints)='array' AND octet_length(waypoints::text)<=65536),
  generation jsonb NOT NULL
    CHECK (jsonb_typeof(generation)='object' AND octet_length(generation::text)<=4096),
  -- What produced this revision: created, renamed, retrimmed or copied. It records the
  -- edit, not the geometry conditions, and it is not part of the content digest.
  edit jsonb NOT NULL
    CHECK (jsonb_typeof(edit)='object' AND octet_length(edit::text)<=512),
  vertex_count integer NOT NULL CHECK (vertex_count BETWEEN 2 AND 20000),
  -- Length of this planned line. Never a device distance, a recomputed recording distance
  -- or a routing estimate.
  distance_meters double precision NOT NULL
    CHECK (distance_meters>=0 AND distance_meters<=1000000000),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,course_id,course_revision),
  UNIQUE (athlete_id,revision_id),
  FOREIGN KEY (athlete_id,course_id) REFERENCES course(athlete_id,course_id)
);
ALTER TABLE course ADD CONSTRAINT course_head_revision_fk
  FOREIGN KEY (athlete_id,course_id,head_revision)
  REFERENCES course_revision(athlete_id,course_id,course_revision)
  DEFERRABLE INITIALLY DEFERRED;

-- Lineage: every recording a revision's coordinates came from. A revision inherits the
-- lineage of whatever it was derived from, so an independently edited copy still names the
-- original recording and deleting that recording still reaches the copy.
CREATE TABLE course_revision_source (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  course_revision integer NOT NULL CHECK (course_revision BETWEEN 1 AND 2147483646),
  activity_id uuid NOT NULL,
  track_id uuid NOT NULL,
  track_revision integer NOT NULL CHECK (track_revision BETWEEN 1 AND 2147483646),
  PRIMARY KEY (athlete_id,course_id,course_revision,activity_id,track_id,track_revision),
  FOREIGN KEY (athlete_id,course_id,course_revision)
    REFERENCES course_revision(athlete_id,course_id,course_revision) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id,activity_id) REFERENCES activity_canonical(athlete_id,id)
);
CREATE INDEX course_revision_source_activity
  ON course_revision_source(athlete_id,activity_id);
CREATE INDEX course_revision_course ON course_revision(athlete_id,course_id,course_revision);

DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['course','course_revision','course_revision_source'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY course_tenant ON %I USING (athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',table_name);
  END LOOP;
END
$migration$;

-- A stored revision is never edited. Only the table owner may remove one, which is what
-- reclamation, owner-initiated course deletion and account erasure do.
CREATE FUNCTION course_revision_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_COURSE_REVISION';
END $$;
REVOKE ALL ON FUNCTION course_revision_append_only() FROM PUBLIC;
CREATE TRIGGER course_revision_append_only BEFORE UPDATE OR DELETE ON course_revision
  FOR EACH ROW EXECUTE FUNCTION course_revision_append_only();

-- The head advances by exactly one revision onto a new revision id, or is reclaimed by the
-- owner. It never goes backwards, never skips, and a reclaimed course never becomes
-- available again.
CREATE FUNCTION course_head_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE table_owner text:=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID);
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.course_id IS DISTINCT FROM OLD.course_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.visibility IS DISTINCT FROM OLD.visibility
    OR NEW.updated_at<OLD.updated_at
    OR OLD.status='unavailable'
  THEN RAISE EXCEPTION 'INVALID_COURSE_TRANSITION'; END IF;
  IF NEW.status='available' THEN
    IF NEW.head_revision<>OLD.head_revision+1
      OR NEW.revision_id IS NOT DISTINCT FROM OLD.revision_id
      OR NEW.reclaimed_at IS NOT NULL
    THEN RAISE EXCEPTION 'INVALID_COURSE_TRANSITION'; END IF;
    RETURN NEW;
  END IF;
  -- Reclamation is the owner's transition, performed by the tombstone trigger. The runtime
  -- role cannot mark a course unavailable, so "unavailable" always means a real deletion.
  IF current_user<>table_owner OR NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'INVALID_COURSE_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_head_transition_valid() FROM PUBLIC;
CREATE TRIGGER course_head_transition BEFORE UPDATE ON course
  FOR EACH ROW EXECUTE FUNCTION course_head_transition_valid();

-- Deriving a course from a deleted activity or a suppressed source is refused here, in the
-- database, so no application path can become a way around deletion suppression.
CREATE FUNCTION course_lineage_allowed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.activity_canonical c
    WHERE c.athlete_id=NEW.athlete_id AND c.id=NEW.activity_id AND c.deleted)
  THEN RAISE EXCEPTION 'ACTIVITY_DELETED'; END IF;
  IF EXISTS(SELECT 1 FROM public.activity_source_head h
    JOIN public.activity_suppression s ON s.athlete_id=h.athlete_id AND s.kind=h.kind
      AND s.source_id=h.source_id
    WHERE h.athlete_id=NEW.athlete_id AND h.activity_id=NEW.activity_id)
  THEN RAISE EXCEPTION 'ACTIVITY_SOURCE_SUPPRESSED'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_lineage_allowed() FROM PUBLIC;
CREATE TRIGGER course_lineage_allowed BEFORE INSERT ON course_revision_source
  FOR EACH ROW EXECUTE FUNCTION course_lineage_allowed();

-- Deleting an activity reclaims every course derived from its coordinates, in the same
-- transaction as the tombstone. The head row stays as an explicitly unavailable reference
-- — the plan asks for "unavailable rather than dangling" — and every revision, with its
-- geometry and waypoints, is removed. Lineage rows go with their revisions, so a copy made
-- from such a course is reached by the same rule instead of escaping it.
CREATE FUNCTION course_reclaim_on_activity_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  -- Scope is the course, not the single revision: a course reached through any of its
  -- revisions loses all of them, so an earlier revision cannot keep the coordinates alive.
  UPDATE public.course c SET status='unavailable',head_revision=NULL,revision_id=NULL,
    unavailable_reason='source_activity_deleted',reclaimed_at=database_now,
    updated_at=greatest(c.updated_at,database_now)
    WHERE c.athlete_id=NEW.athlete_id AND c.status='available'
      AND EXISTS(SELECT 1 FROM public.course_revision_source s
        WHERE s.athlete_id=c.athlete_id AND s.course_id=c.course_id AND s.activity_id=NEW.id);
  DELETE FROM public.course_revision r
    WHERE r.athlete_id=NEW.athlete_id
      AND EXISTS(SELECT 1 FROM public.course_revision_source s
        WHERE s.athlete_id=r.athlete_id AND s.course_id=r.course_id AND s.activity_id=NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION course_reclaim_on_activity_delete() FROM PUBLIC;
CREATE TRIGGER course_reclaim_on_activity_delete AFTER UPDATE ON activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION course_reclaim_on_activity_delete();

-- What deleting this activity would reclaim. The delete confirmation reads exactly the
-- rule the tombstone trigger applies, so the preview cannot drift from the action.
CREATE FUNCTION public.courses_affected_by_activity_deletion(uuid)
RETURNS TABLE(course_id uuid,name text,head_revision integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT c.course_id,c.name,c.head_revision FROM public.course c
  WHERE c.athlete_id=nullif(current_setting('app.athlete_id',true),'')
    AND c.status='available'
    AND EXISTS(SELECT 1 FROM public.course_revision_source s
      WHERE s.athlete_id=c.athlete_id AND s.course_id=c.course_id AND s.activity_id=$1)
  ORDER BY c.created_at,c.course_id LIMIT 200;
$$;
REVOKE ALL ON FUNCTION public.courses_affected_by_activity_deletion(uuid) FROM PUBLIC;

-- The affected-course list and its digest, from ONE snapshot.
--
-- These must describe the same instant. Reading them as two statements does not guarantee
-- that even inside one transaction: at READ COMMITTED each statement takes a fresh
-- snapshot, so a course created between them produced a list of one course and a digest
-- covering two — and a deletion confirmed against that digest then reclaimed a course the
-- user was never shown (reproduced on real PostgreSQL). One statement, one snapshot.
CREATE FUNCTION public.activity_course_impact(uuid)
RETURNS TABLE(courses jsonb,digest text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH affected AS (
    SELECT i.course_id,i.name,i.head_revision
    FROM public.courses_affected_by_activity_deletion($1) i
  )
  SELECT
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'course_id',a.course_id,'name',a.name,'head_revision',a.head_revision)
      ORDER BY a.course_id),'[]'::jsonb) FROM affected a),
    (SELECT encode(sha256(convert_to(coalesce(string_agg(
        a.course_id::text||'|'||a.name,E'\n' ORDER BY a.course_id),''),'UTF8')),'hex')
     FROM affected a);
$$;
REVOKE ALL ON FUNCTION public.activity_course_impact(uuid) FROM PUBLIC;

-- Digest of that same list. The delete command carries back the digest of the list the
-- user confirmed and it is compared inside the deletion transaction: a course created
-- between the confirmation and the delete changes this value, and the Activity revision —
-- which does not move when a course is cut — cannot express that. There is exactly one
-- definition of this digest, and it is the one above.
CREATE FUNCTION public.activity_course_impact_digest(uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT i.digest FROM public.activity_course_impact($1) i;
$$;
REVOKE ALL ON FUNCTION public.activity_course_impact_digest(uuid) FROM PUBLIC;

-- Owner-initiated deletion of one course, under the same expected revision every other
-- write uses. The runtime role has no DELETE privilege on these tables; this bounded
-- function is the only way it can remove a course.
CREATE FUNCTION public.delete_course(uuid,integer) RETURNS boolean
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
  DELETE FROM public.course_revision WHERE athlete_id=tenant AND course_id=$1;
  DELETE FROM public.course WHERE athlete_id=tenant AND course_id=$1;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.delete_course(uuid,integer) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_courses;
REVOKE ALL ON FUNCTION public.erase_account_before_courses(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_courses(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_courses(text) FROM %I',role_name); END LOOP;
END $$;
-- Erasure removes courses, their revisions and their lineage before the activities they
-- reference are erased. Courses own no objects of their own, so there is nothing to queue:
-- the recording's objects are queued by the stage this wraps.
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  DELETE FROM public.course_revision WHERE athlete_id=$1;
  DELETE FROM public.course WHERE athlete_id=$1;
  RETURN public.erase_account_before_courses($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
