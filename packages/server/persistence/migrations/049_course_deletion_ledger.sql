-- M2-01ao: a course the owner deleted after a backup came back when that backup was restored.
--
-- `delete_course` removes a course's rows outright — the course, its revisions and, through
-- their cascades, the lineage, the pictures' rows, the favourite mark and the accessibility
-- note. Nothing of the deletion is kept, so the source database has nothing to hand a restore:
-- an activity's deletion leaves its tombstone, an erasure its `tenant_erasure` row, but a
-- course's deletion left no row at all. Reproduced on PostgreSQL 14 with the real repository
-- (backup-restore drill, 2026-09-25): after the dump the owner deletes a course; the restore
-- replays every existing ledger (erasure, activity deletion, constraints, evidence
-- withdrawal); the runtime repository then reads the course back as `available` — its name,
-- its coordinates, the owner's favourite mark, the picture row and the picture object — and
-- lists it among the owner's courses.
--
-- What this adds:
--   * `course_deletion`, the ledger: one row per course the owner deleted — the tenant, the
--     course id and when. No name, no coordinate, nothing of the course itself: it is a
--     suppression fact, as `activity_suppression` is, and exactly what a restore needs to
--     delete the course again.
--   * `apply_course_deletion`, the one body both the live deletion and the restore replay run,
--     so a replayed deletion removes exactly what a live one does: the pictures are superseded
--     and their objects queued (038), the course's object directory is armed for a purge (046 —
--     which also reaches pictures drawn between the dump and the object-archive copy, which no
--     restored row names), the searches, proposals, revisions and course are removed in 036's
--     order, and the ledger row is written last. Shares (M2-01k-o, not yet on main) hang off
--     `course_revision` by a cascading foreign key per its requirement §4, so the revision
--     delete takes them too; its share epoch separately invalidates every restored link.
--   * `delete_course`, 038's body with its removal replaced by that one call.
--   * `course_deletion_terminal`: a deleted course id can never be inserted again for that
--     tenant, so the course purge the deletion armed can never meet the course alive (the
--     purge lease refuses only a present, available course).
--   * `replay_course_deletion`, for the restore only (no grant): one ledger entry, applied
--     after the restored cluster is complete and before any runtime access, fail-closed, and
--     idempotent (see the function).
--   * erasure removes the tenant's ledger rows (the wrapper at the end).
--
-- Not backfilled: a course deleted before this migration left no row to backfill from. A
-- restore of a backup that predates this migration can still bring back a course deleted
-- before it ran; recorded as an open item in M2-01ao.
--
-- Lock order. The live deletion runs inside `database.tenant` (account lock 77206 shared, then
-- the command lock 0) and the course row first, as before; the new rows it touches — the purge
-- row and the ledger row — come after the course row, the pictures and the cleanup queue, the
-- same place the activity tombstone's reclamation writes its course purge row. The replay takes
-- the command lock (0) itself, then the course row. Erasure keeps 77206 → 0 → rows: its new
-- link deletes ledger rows after both advisory locks and before the chain it wraps.
CREATE TABLE course_deletion (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,course_id)
);
ALTER TABLE course_deletion ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_deletion FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE course_deletion FROM PUBLIC;
CREATE POLICY course_deletion_tenant ON course_deletion
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
-- The functions below run as the owner. Under FORCE an owner that is neither superuser nor
-- BYPASSRLS would otherwise see only the session tenant's rows — enough for every function
-- here, but the terminal check must not depend on a session setting a maintenance insert may
-- not have made.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY course_deletion_definer ON course_deletion TO %I '
    'USING (true) WITH CHECK (true)', current_user);
END $$;

-- A deleted course id is never a course again.
CREATE FUNCTION course_deletion_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.course_deletion d
    WHERE d.athlete_id=NEW.athlete_id AND d.course_id=NEW.course_id)
  THEN RAISE EXCEPTION 'COURSE_DELETION_TERMINAL'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_deletion_terminal() FROM PUBLIC;
CREATE TRIGGER course_deletion_terminal BEFORE INSERT ON course
  FOR EACH ROW EXECUTE FUNCTION course_deletion_terminal();

-- The deletion itself, for a course whose row the caller has already locked. Not granted to
-- anyone: reached through `delete_course` and `replay_course_deletion`.
--
-- The pictures are superseded (their objects queued) and the directory purge armed BEFORE the
-- revisions go: the picture rows cascade from `course_revision`, and both read them — the
-- queue for the keys, the purge for the writers' fences.
CREATE FUNCTION public.apply_course_deletion(text,uuid,timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  PERFORM public.supersede_course_thumbnails($1,$2,NULL,'course_deleted');
  -- A tenant or course id that is not a canonical UUID names no key prefix; there is nothing
  -- to arm then, and the deletion goes ahead as it always did.
  PERFORM public.arm_object_scope_purge($1,'course',$2);
  DELETE FROM public.course_route_candidate_set WHERE athlete_id=$1 AND course_id=$2;
  DELETE FROM public.course_route_proposal WHERE athlete_id=$1 AND course_id=$2;
  DELETE FROM public.course_revision WHERE athlete_id=$1 AND course_id=$2;
  DELETE FROM public.course WHERE athlete_id=$1 AND course_id=$2;
  INSERT INTO public.course_deletion(athlete_id,course_id,deleted_at) VALUES($1,$2,$3)
    ON CONFLICT(athlete_id,course_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.apply_course_deletion(text,uuid,timestamptz) FROM PUBLIC;

-- 038's body: the same tenant check, row lock and revision check, and the removal replaced by
-- the shared body above.
CREATE OR REPLACE FUNCTION public.delete_course(uuid,integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
  PERFORM public.apply_course_deletion(tenant,$1,clock_timestamp());
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.delete_course(uuid,integer) FROM PUBLIC;

-- Restore only (no grant): replay one course-deletion ledger entry — tenant, course id, and
-- when the owner deleted it — onto a restored cluster, before any runtime access. Returns
--   'deleted'          the restored cluster held the course: it is deleted now, as live;
--   'absent'           it did not (a course created after the dump and deleted before the
--                      ledger was captured): the ledger row is written and the directory purge
--                      armed, because the object archive can hold pictures of it;
--   'already_applied'  the ledger row is already there and the course is not: nothing changes
--                      (a purge is armed only if the course has none at all), so replaying the
--                      same ledger twice leaves the cluster as the first replay did.
--
-- What it refuses, failing the replay transaction (fail closed, never a silent commit):
--   * a tenant that is not the session's;
--   * a tenant or course id that is not a canonical lowercase UUID, and a missing or future
--     deletion time;
--   * an erased tenant (its erasure replay satisfies the entry; the caller counts it);
--   * a tenant with no identity account in the restored cluster — not a tenant this database
--     knows, and what a cluster whose data has not been restored yet looks like: a replay run
--     before the restore completes is refused instead of recording nothing the restore would
--     then undo;
--   * a course id another tenant holds.
CREATE FUNCTION public.replay_course_deletion(text,uuid,timestamptz) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE found_status text;
DECLARE recorded boolean;
BEGIN
  IF $1 IS NULL OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'COURSE_REPLAY_TENANT_MISMATCH';
  END IF;
  IF $2 IS NULL
    OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'COURSE_REPLAY_INVALID_ID'; END IF;
  IF $3 IS NULL OR $3>clock_timestamp() THEN RAISE EXCEPTION 'COURSE_REPLAY_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
  THEN RAISE EXCEPTION 'COURSE_REPLAY_TENANT_ERASED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'COURSE_REPLAY_TENANT_UNKNOWN'; END IF;
  IF EXISTS(SELECT 1 FROM public.course c WHERE c.athlete_id<>$1 AND c.course_id=$2)
  THEN RAISE EXCEPTION 'COURSE_REPLAY_FOREIGN_COURSE'; END IF;
  SELECT c.status INTO found_status FROM public.course c
    WHERE c.athlete_id=$1 AND c.course_id=$2 FOR UPDATE;
  recorded:=EXISTS(SELECT 1 FROM public.course_deletion d
    WHERE d.athlete_id=$1 AND d.course_id=$2);
  IF found_status IS NOT NULL THEN
    PERFORM public.apply_course_deletion($1,$2,$3);
    IF NOT EXISTS(SELECT 1 FROM public.object_scope_purge p
      WHERE p.athlete_id=$1 AND p.scope_kind='course' AND p.scope_id=$2 AND p.completed_at IS NULL)
    THEN RAISE EXCEPTION 'COURSE_REPLAY_PURGE_NOT_ARMED'; END IF;
    RETURN 'deleted';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.object_scope_purge p
    WHERE p.athlete_id=$1 AND p.scope_kind='course' AND p.scope_id=$2)
  THEN
    IF NOT public.arm_object_scope_purge($1,'course',$2) THEN
      RAISE EXCEPTION 'COURSE_REPLAY_PURGE_NOT_ARMED';
    END IF;
  END IF;
  IF recorded THEN RETURN 'already_applied'; END IF;
  INSERT INTO public.course_deletion(athlete_id,course_id,deleted_at) VALUES($1,$2,$3);
  RETURN 'absent';
END $$;
REVOKE ALL ON FUNCTION public.replay_course_deletion(text,uuid,timestamptz) FROM PUBLIC;

-- Erasure removes the tenant's ledger rows: which courses an account deleted is the account's
-- own history. The account lock and the command lock come first (77206 → 0 → rows,
-- re-entrant in the chain below), then this table's rows, then the rest of the chain
-- unchanged.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_course_deletion;
REVOKE ALL ON FUNCTION public.erase_account_before_course_deletion(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_course_deletion(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_course_deletion(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  DELETE FROM public.course_deletion WHERE athlete_id=$1;
  RETURN public.erase_account_before_course_deletion($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
