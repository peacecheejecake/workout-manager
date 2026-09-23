-- M2-01m sweeps the course-thumbnail object namespace against a persistent reference index.
--
-- M2-01l gave every thumbnail object a receipt in the durable `resource_object_cleanup`
-- manifest, and every path that closes a render queues one. That is a receipt-based
-- guarantee, and a receipt-based guarantee only holds while some receipt is still open.
--
-- The hole, reproduced on real PostgreSQL before this migration was written:
--
--   prepare → push the render's lease and publication fence three hours into the past →
--   `reap_course_thumbnail_renders` → drain the cleanup queue (both receipts close, because
--   the writer's fence passed more than the hour-long grace ago) → *then* the writer wakes up
--   and completes `writeTemporary` + `publishTemporary`.
--
--   Result: the final object is on the store, every receipt naming it is closed, and neither
--   the reaper, nor `prune_course_thumbnail_history`, nor another cleanup drain ever looks at
--   that key again. The object is orphaned permanently — including objects of courses the
--   owner deleted and of revisions a later edit superseded.
--
-- What that hole does NOT allow, measured rather than assumed, is why this is a separate node
-- rather than a block on M2-01l: the final key is content-addressed on `(revision_id,sha256)`
-- so a late writer can only rewrite the same bytes, never overwrite a live picture with
-- different ones; `finalize` answers `lease_lost` and `resolveThumbnailObject` answers null,
-- so a reclaimed key cannot be made visible again; account erasure re-arms its fence for
-- thirty days in `finish_resource_object_cleanup`, so an erased tenant's late object is still
-- reclaimed; and the bytes carry a 0-100 normalized path with no bbox, so no absolute
-- position survives in what leaks. It is a storage leak, not an access or privacy failure.
--
-- The fix is the reconciliation sweep M2-01c already built for exactly this problem, applied
-- to this namespace: a persistent index of every reference this server ever recorded, one
-- bounded keyset window per run, one `stat` per row, and a settle rule that stops watching a
-- reference only once every way it could still become an object is closed.
--
-- Three things differ from M2-01c, each for a reason stated where it is done: how the index
-- is maintained (a trigger, not a repository call), what "no writer can still publish this"
-- means here (a publication fence and a render lease, not an upload state machine), and where
-- erasure removes the index rows (last, not first).

-- A persistent index of every thumbnail object reference this server has ever recorded.
--
-- Scanning `course_thumbnail` itself would not do, for the same two reasons M2-01c measured
-- on its own ledger. A row of that table does not live forever — `prune_course_thumbnail_history`
-- deletes a closed render seven days after its receipts close, and `course_thumbnail` cascades
-- away entirely when the course or its source recording is deleted, which is precisely the
-- case where a leak matters most. And the reference a row carries is reachable only through
-- two different columns, so a window over that table cannot be a plain keyset scan.
--
-- This table is the keyset index the sweep reads: one row per reference, primary-keyed by it,
-- with a partial index over the rows still being watched, so a window of N candidates reads
-- exactly N rows.
CREATE TABLE course_thumbnail_object_ref (
  storage_ref text PRIMARY KEY CHECK (length(storage_ref) BETWEEN 1 AND 512),
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL,
  -- Set once the object has been observed absent and no render could still create it. A
  -- settled reference leaves the sweep's window.
  settled_at timestamptz,
  CHECK (settled_at IS NULL OR settled_at>=recorded_at)
);
CREATE INDEX course_thumbnail_object_ref_watched ON course_thumbnail_object_ref(storage_ref)
  WHERE settled_at IS NULL;
ALTER TABLE course_thumbnail_object_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_thumbnail_object_ref FORCE ROW LEVEL SECURITY;
CREATE POLICY course_thumbnail_object_ref_tenant ON course_thumbnail_object_ref
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- The index is maintained by a trigger on the ledger, not by the application.
--
-- M2-01c records its references from the repository, and can: the runtime role holds INSERT
-- on `activity_track_object_ref` and every track reference is created inside
-- `database.tenant`. Neither is true here. `course_thumbnail` is written by nothing but the
-- enqueue trigger and the bounded SECURITY DEFINER functions of M2-01l — its own
-- `course_thumbnail_writer` trigger refuses any other writer — and the render worker that
-- calls `prepare_course_thumbnail` has no table access of any kind and no tenant session
-- variable. So the index is recorded where the reference itself is recorded, in the same
-- statement's transaction: no write path can forget it, a future writer inherits it, and this
-- table needs no grant to anybody.
CREATE FUNCTION record_course_thumbnail_object_refs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  INSERT INTO public.course_thumbnail_object_ref(storage_ref,athlete_id,recorded_at)
    SELECT refs.storage_ref,NEW.athlete_id,clock_timestamp()
    FROM (VALUES(NEW.temporary_ref),(NEW.storage_ref)) refs(storage_ref)
    WHERE refs.storage_ref IS NOT NULL
    ON CONFLICT(storage_ref) DO NOTHING;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION record_course_thumbnail_object_refs() FROM PUBLIC;
-- AFTER UPDATE as well as INSERT: the temporary reference exists from the insert, the final
-- one only from `prepare_course_thumbnail`. `DO NOTHING` on conflict is enough because a
-- settled reference can never be named again — a temporary key carries a fresh job UUID, a
-- final key carries `(revision_id,sha256)` and a row for that revision is only ever created
-- by the enqueue trigger on the revision's own INSERT, which has already happened.
CREATE TRIGGER record_course_thumbnail_object_refs
  AFTER INSERT OR UPDATE ON course_thumbnail
  FOR EACH ROW EXECUTE FUNCTION record_course_thumbnail_object_refs();

-- Existing rows, so the index covers references M2-01l recorded before this table existed.
INSERT INTO course_thumbnail_object_ref(storage_ref,athlete_id,recorded_at)
  SELECT DISTINCT refs.storage_ref,t.athlete_id,t.created_at
  FROM course_thumbnail t
  CROSS JOIN LATERAL (VALUES(t.temporary_ref),(t.storage_ref)) refs(storage_ref)
  WHERE refs.storage_ref IS NOT NULL
  ON CONFLICT(storage_ref) DO NOTHING;

-- Where the sweep resumes. Its own cursor, not M2-01c's: the two indexes are different
-- keyspaces, and a shared cursor would make each sweep skip whatever the other had passed.
CREATE TABLE course_thumbnail_reconcile_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cursor_key text NOT NULL DEFAULT '' CHECK (length(cursor_key)<=512),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO course_thumbnail_reconcile_state(id) VALUES(true);
ALTER TABLE course_thumbnail_reconcile_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_thumbnail_reconcile_state FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.course_thumbnail_reconcile_cursor() RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT cursor_key FROM public.course_thumbnail_reconcile_state WHERE id;
$$;
REVOKE ALL ON FUNCTION public.course_thumbnail_reconcile_cursor() FROM PUBLIC;

CREATE FUNCTION public.advance_course_thumbnail_reconcile_cursor(text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS NULL OR length($1)>512 THEN RAISE EXCEPTION 'INVALID_RECONCILE_CURSOR'; END IF;
  UPDATE public.course_thumbnail_reconcile_state SET cursor_key=$1,updated_at=clock_timestamp()
    WHERE id;
  RETURN $1;
END $$;
REVOKE ALL ON FUNCTION public.advance_course_thumbnail_reconcile_cursor(text) FROM PUBLIC;

-- One bounded, ordered window straight out of the index. The plan is an index range scan over
-- the partial index, reading exactly as many rows as the window asks for; the limit is clamped
-- here rather than trusted, so no caller can ask for an unbounded pass.
CREATE FUNCTION public.course_thumbnail_reconcile_candidates(text,integer)
RETURNS TABLE(storage_ref text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT r.storage_ref FROM public.course_thumbnail_object_ref r
  WHERE r.settled_at IS NULL AND r.storage_ref>$1
  ORDER BY r.storage_ref LIMIT least(greatest($2,1),1000);
$$;
REVOKE ALL ON FUNCTION public.course_thumbnail_reconcile_candidates(text,integer) FROM PUBLIC;

-- Stop watching a reference, but only once every way it could still become an object is
-- closed: the object was observed absent (the caller's `stat`, which is why this is not
-- checked here), no cleanup receipt is open for it, no live picture names it, no render can
-- still publish it, and it has been watched for at least seven days.
--
-- Seven days, the same floor as M2-01c, and for a reason that is local to this table rather
-- than borrowed: `prune_course_thumbnail_history` keeps a closed render for seven days after
-- its receipts close, so settling earlier would stop watching a key whose own ledger row is
-- still there. Seven days is also far above every deadline in this lifecycle — a render
-- expires in one hour, a lease lasts at most five minutes, a publication fence two minutes,
-- and the reclaim grace an hour — so what it buys is entirely the margin for a writer that
-- resumes late, and a writer that resumes later than seven days is outside what this
-- reclaims. That is the stated floor, not an accident of the number.
--
-- "No render can still publish it" is the one condition that has to be re-derived for this
-- namespace. A track upload is a state machine with an expiry; a render is a lease plus a
-- publication fence. Both deadlines get the same one-hour grace `queue_course_thumbnail_refs`
-- already puts into a queued receipt's `available_at`, because neither gate can reach a
-- storage call that is already in flight. `greatest` ignores NULLs, so a row that never
-- leased and never prepared contributes only its own `expires_at`.
CREATE FUNCTION public.settle_course_thumbnail_object_ref(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE affected integer;
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_SETTLE_REF';
  END IF;
  UPDATE public.course_thumbnail_object_ref r SET settled_at=database_now
  WHERE r.storage_ref=$1 AND r.settled_at IS NULL
    AND r.recorded_at<database_now-interval '7 days'
    AND NOT EXISTS(SELECT 1 FROM public.resource_object_cleanup q
      WHERE q.storage_ref=$1 AND q.completed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.course_thumbnail t
      WHERE $1 IN (t.temporary_ref,t.storage_ref)
        AND (t.state IN ('prepared','ready')
          OR database_now<greatest(t.expires_at,
            t.publication_lease_until+interval '1 hour',
            t.lease_until+interval '1 hour')));
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.settle_course_thumbnail_object_ref(text) FROM PUBLIC;

-- Queue one thumbnail object the ledger does not account for.
--
-- Referenced means: a live picture points at it, a render that has not closed yet owns its
-- temporary name, or a render could still publish it inside the grace above. Anything else is
-- unreferenced, whatever the state of any earlier receipt — which is the entire point, since
-- the leak this closes is exactly the case where every receipt is already closed.
--
-- An open receipt short-circuits instead of being reopened: the queue is already going to
-- look at that key, and `authorize_resource_object_cleanup` re-verifies every live reference
-- immediately before a byte is deleted, so this cannot over-delete even if it were wrong.
CREATE FUNCTION public.reclaim_unreferenced_course_thumbnail_object(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_RECONCILE_REF';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.course_thumbnail t
    WHERE (t.storage_ref=$1 AND t.state IN ('prepared','ready'))
       OR (t.temporary_ref=$1 AND t.state IN ('queued','rendering','prepared')
         AND t.expires_at>database_now)
  ) OR EXISTS(
    SELECT 1 FROM public.course_thumbnail t
    WHERE $1 IN (t.temporary_ref,t.storage_ref)
      AND database_now<greatest(t.publication_lease_until+interval '1 hour',
        t.lease_until+interval '1 hour')
  ) OR EXISTS(
    SELECT 1 FROM public.resource_object_cleanup q
    WHERE q.storage_ref=$1 AND q.completed_at IS NULL
  ) THEN RETURN false; END IF;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    VALUES(gen_random_uuid(),$1,'upload_abandoned',database_now,database_now)
    ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,
      created_at=EXCLUDED.created_at,completed_at=NULL,delete_authorized_at=NULL,
      last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.reclaim_unreferenced_course_thumbnail_object(text) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_thumbnail_object_refs;
REVOKE ALL ON FUNCTION public.erase_account_before_thumbnail_object_refs(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_thumbnail_object_refs(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_thumbnail_object_refs(text) FROM %I',role_name); END LOOP;
END $$;
-- Erasure removes the tenant's reference index with the rest of its rows, and late writes
-- after erasure stay covered by the thirty-day `account_erased` receipt fence instead — the
-- same trade M2-01c made, and the reason the hole this node closes was never an erasure hole.
--
-- The index rows go LAST, after the delegation, and that is a deliberate divergence from
-- M2-01c's ordering. Locks on this pair of tables are only ever taken in one direction by
-- ordinary work: a write to `course_thumbnail` fires the trigger above, so the ledger row
-- comes first and the index row second. M2-01c can afford to delete its index first because
-- every writer of `activity_track_object_ref` enters through `database.tenant` and therefore
-- already holds the account lock this function takes exclusively. The render worker does not:
-- it calls `prepare_course_thumbnail`, `fail_course_thumbnail` and the rest directly, with no
-- advisory lock at all, so it can be holding a `course_thumbnail` row while it waits for an
-- index row. Deleting the index first would put erasure in the opposite order and complete
-- the cycle — the `40P01` class the three previous nodes each reproduced once. Deleting it
-- last keeps erasure in the same direction as every other writer.
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE erased_at timestamptz;
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  erased_at:=public.erase_account_before_thumbnail_object_refs($1);
  DELETE FROM public.course_thumbnail_object_ref WHERE athlete_id=$1;
  RETURN erased_at;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
