-- M2-01au: the object-cleanup and derived-cleanup queues, the two sweep cursors and the restore
-- replays work when the migration owner is neither superuser nor BYPASSRLS.
--
-- M2-01at (051) fixed the two object-prefix purges only. The same shape remained on four more
-- tables that nothing but the owner's own functions touch — `resource_object_cleanup`,
-- `resource_derived_cleanup`, `activity_track_reconcile_state` and
-- `course_thumbnail_reconcile_state` are FORCE ROW LEVEL SECURITY with no policy at all. On a
-- plain owner, measured on PostgreSQL 14 with the whole schema built by such a role
-- (`queue-state-plain-owner.integration.test.ts`):
--   * every user path that queues an object fails with 42501 and rolls back: deleting an
--     activity that has a track, a duplicate upload's supersede, deleting a resource or a
--     gallery item, and erasing an account whose tenant has track or thumbnail references;
--     deleting a resource also fails on the derived-cleanup queue;
--   * an upload's protect "succeeds" without protecting: its UPDATE of the queue sees no row;
--   * the cleanup worker leases nothing, the cursors never move, history is never pruned;
--   * the restore replays' refusal of another tenant's activity or course id passes silently:
--     the owner reads `athlete_id<>$1` with the replayed tenant named, and sees no other one.
--
-- What changes:
--   1. Each of the four tables gets one policy for the migrating role only — 047/049/050/051's
--      precedent for a table only the owner's functions touch. No runtime or worker role holds
--      a privilege on any of them (the upgrade test checks, after the grant helpers), so the
--      policy widens nothing but what the owner's own functions see of these four tables.
--   2. Those functions also read tenant tables with no tenant named. Given a visible queue,
--      each such read would answer "nothing references this object" when the reference is
--      merely invisible — `authorize_resource_object_cleanup`'s thirteen reads would then let
--      the worker delete a live object (the reason 051 left this queue alone). So every such
--      read now names the tenant of the row in hand, for that read only, through the existing
--      tenant policies, and puts the caller's setting back — 050's `read_course_share` and
--      051's pattern:
--        - the cleanup queue has no tenant column; its key does (`private/v1/tenants/<t>/…`).
--          Authorize, finish, the sweep's reclaim and settle read under that tenant. A key that
--          names no tenant is refused by authorize and labelled, never authorized;
--        - the derived purge deletes under the leased manifest's tenant (before, on a plain
--          owner, it would have deleted nothing and the queue would have recorded it done).
--      No policy is added to any tenant table, so no other function of the owner sees more.
--   3. The replays keep their global read (exact for a role row security does not apply to)
--      and add a probe of every other tenant that holds an identity account, one tenant named
--      at a time. Only a tenant with an account can have been restored with rows here; a row
--      of a tenant without one is not probed (the residual, in the runbook).
--   4. `lease_object_scope_purge` (051) asks the liveness helper only for the head of the due
--      order — at most 100 rows a call — instead of for every due row: 051 made a lease over a
--      100,000-row backlog cost about 0.75 s where 046 took 35 ms.
--   5. `retarget_definer_policies()`: the `*_definer` policies of 047, 049, 050, 051 and this
--      migration name the role that applied them, so after `REASSIGN OWNED` or a `--no-owner`
--      restore the new owner has none. Run by the new owner, the function points each of them
--      at it (and recreates one a `DROP OWNED` removed). Not granted to anyone.
--
-- Every replaced function keeps its signature, so its grants survive and no grant helper has to
-- run again. Its body is the previous one with only the reads above changed (the upgrade test
-- checks that exact substitution), and its search path now ends in pg_temp as 049–051's do.
--
-- Not changed here (M2-01au progress §6): the render, URL-ingestion, upload-reap, prune and
-- sweep-window functions scan tenant tables for due work across tenants. They have no row in
-- hand whose tenant could be named, so on a plain owner they still see nothing — closed, never
-- open — until a follow-up gives them a tenant source.
--
-- Lock order. The four tables are locked first, in one statement, state before queue and the
-- derived queue before the object queue — the order a resource deletion takes them — so the
-- migration never holds one while waiting for another a runtime transaction took first in the
-- same order. The helpers take no lock; the leases lock queue rows only, as before, so
-- erasure's 77206 → 0 → rows → queue row gains no edge back.

LOCK TABLE activity_track_reconcile_state,course_thumbnail_reconcile_state,
  resource_derived_cleanup,resource_object_cleanup IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  EXECUTE format('CREATE POLICY activity_track_reconcile_state_definer '
    'ON activity_track_reconcile_state TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY course_thumbnail_reconcile_state_definer '
    'ON course_thumbnail_reconcile_state TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY resource_derived_cleanup_definer '
    'ON resource_derived_cleanup TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY resource_object_cleanup_definer '
    'ON resource_object_cleanup TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- The tenant an object key names — `private/v1/tenants/<canonical uuid>/…` — or NULL.
CREATE FUNCTION public.object_key_tenant(text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT substring($1 FROM
    '^private/v1/tenants/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/')
$$;
REVOKE ALL ON FUNCTION public.object_key_tenant(text) FROM PUBLIC;

-- The latest open publication fence of a writer that may still create this object: 033's and
-- 039's two reads, asked under the key's tenant. The caller's setting is put back.
CREATE FUNCTION public.resource_object_publication_fence(text,timestamptz) RETURNS timestamptz
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE object_ref text:=$1;
DECLARE database_now timestamptz:=$2;
DECLARE publication_fence timestamptz;
BEGIN
  PERFORM set_config('app.athlete_id',coalesce(public.object_key_tenant(object_ref),''),true);
  SELECT max(fence) INTO publication_fence FROM (
    SELECT max(i.publication_lease_until) AS fence
      FROM public.activity_track_upload_intent i
      WHERE i.publication_lease_until>database_now
        AND i.state IN ('prepared','staged','failed')
        AND object_ref IN (i.raw_temporary_ref,
        i.normalized_temporary_ref,i.map_path_temporary_ref,i.raw_storage_ref,
        i.normalized_storage_ref,i.map_path_storage_ref)
    UNION ALL
    -- A render mid-publication, or one closed under a writer that was still publishing.
    SELECT max(t.publication_lease_until) AS fence
      FROM public.course_thumbnail t
      WHERE t.publication_lease_until>database_now
        AND t.state IN ('prepared','failed','superseded','unavailable')
        AND object_ref IN (t.temporary_ref,t.storage_ref)
  ) fences;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN publication_fence;
END $$;
REVOKE ALL ON FUNCTION public.resource_object_publication_fence(text,timestamptz) FROM PUBLIC;

-- Does a live row still reference this object? The eleven reads authorize has always made,
-- asked under the key's tenant. The caller's setting is put back.
CREATE FUNCTION public.resource_object_referenced(text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE object_ref text:=$1;
DECLARE database_now timestamptz:=$2;
DECLARE answer boolean;
BEGIN
  PERFORM set_config('app.athlete_id',coalesce(public.object_key_tenant(object_ref),''),true);
  answer:=EXISTS(
    SELECT 1 FROM public.resource_version v JOIN public.resource r
      ON r.athlete_id=v.athlete_id AND r.id=v.resource_id
      WHERE v.storage_ref=object_ref AND r.deleted_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.resource_upload_intent i
      WHERE (i.storage_ref=object_ref OR i.temporary_ref=object_ref)
        AND i.state IN ('reserved','prepared','staged') AND i.expires_at>database_now
  ) OR EXISTS(
    SELECT 1 FROM public.resource_url_artifact a JOIN public.resource r
      ON r.athlete_id=a.athlete_id AND r.id=a.resource_id
      WHERE a.storage_ref=object_ref AND r.deleted_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.resource_url_ingestion u
      WHERE object_ref IN (u.raw_temporary_ref,u.raw_storage_ref,u.parsed_temporary_ref,u.parsed_storage_ref)
        AND u.state IN ('queued','fetching','parsing')
  ) OR EXISTS(
    SELECT 1 FROM public.gallery_media_item m
      WHERE m.storage_ref=object_ref AND m.deleted_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.gallery_media_derivative d JOIN public.gallery_media_item m
      ON m.athlete_id=d.athlete_id AND m.id=d.media_item_id
      WHERE d.storage_ref=object_ref AND m.deleted_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.gallery_upload_intent i
      WHERE (i.storage_ref=object_ref OR i.temporary_ref=object_ref)
        AND i.state IN ('reserved','prepared','staged') AND i.expires_at>database_now
  ) OR EXISTS(
    SELECT 1 FROM public.activity_track_revision r JOIN public.activity_canonical c
      ON c.athlete_id=r.athlete_id AND c.id=r.activity_id
      WHERE object_ref IN (r.raw_storage_ref,r.normalized_storage_ref,r.map_path_storage_ref)
        AND NOT c.deleted
  ) OR EXISTS(
    SELECT 1 FROM public.activity_track_upload_intent i
      WHERE object_ref IN (i.raw_temporary_ref,i.normalized_temporary_ref,i.map_path_temporary_ref,
        i.raw_storage_ref,i.normalized_storage_ref,i.map_path_storage_ref)
        AND i.state IN ('reserved','prepared','staged') AND i.expires_at>database_now
  ) OR EXISTS(
    -- A picture a live course still shows, or one a render can still publish.
    SELECT 1 FROM public.course_thumbnail t
      WHERE (t.storage_ref=object_ref AND t.state IN ('prepared','ready'))
         OR (t.temporary_ref=object_ref AND t.state IN ('queued','rendering','prepared')
           AND t.expires_at>database_now)
  );
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.resource_object_referenced(text,timestamptz) FROM PUBLIC;

-- Can a writer still publish this object within the hour finish waits out? Finish's two reads,
-- asked under the key's tenant. The caller's setting is put back.
CREATE FUNCTION public.resource_object_publication_window(text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE object_ref text:=$1;
DECLARE database_now timestamptz:=$2;
DECLARE publication_window boolean;
BEGIN
  PERFORM set_config('app.athlete_id',coalesce(public.object_key_tenant(object_ref),''),true);
  publication_window:=EXISTS(
    SELECT 1 FROM public.activity_track_upload_intent i
    WHERE i.state IN ('prepared','staged','failed')
      AND database_now<coalesce(i.publication_lease_until+interval '1 hour',i.expires_at)
      AND object_ref IN (i.raw_temporary_ref,
      i.normalized_temporary_ref,i.map_path_temporary_ref,i.raw_storage_ref,
      i.normalized_storage_ref,i.map_path_storage_ref))
    OR EXISTS(
    -- Only a render that was GRANTED publication can have a call in flight. One that never
    -- prepared has no final name to publish, so its receipt closes on the first pass instead
    -- of re-arming for the rest of its hour.
    SELECT 1 FROM public.course_thumbnail t
    WHERE t.state IN ('prepared','failed','superseded','unavailable')
      AND t.publication_lease_until IS NOT NULL
      AND database_now<t.publication_lease_until+interval '1 hour'
      AND object_ref IN (t.temporary_ref,t.storage_ref));
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN publication_window;
END $$;
REVOKE ALL ON FUNCTION public.resource_object_publication_window(text,timestamptz) FROM PUBLIC;

-- Does a live track revision or an open upload still hold this track object? The sweep's two
-- reads (039), asked under the key's tenant. The caller's setting is put back.
CREATE FUNCTION public.activity_track_object_held(text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE database_now timestamptz:=$2;
DECLARE answer boolean;
BEGIN
  PERFORM set_config('app.athlete_id',coalesce(public.object_key_tenant($1),''),true);
  answer:=EXISTS(
    SELECT 1 FROM public.activity_track_revision r JOIN public.activity_canonical c
      ON c.athlete_id=r.athlete_id AND c.id=r.activity_id
    WHERE NOT c.deleted
      AND $1 IN (r.raw_storage_ref,r.normalized_storage_ref,r.map_path_storage_ref)
  ) OR EXISTS(
    SELECT 1 FROM public.activity_track_upload_intent i
    WHERE i.state IN ('reserved','prepared','staged') AND i.expires_at>database_now
      AND $1 IN (i.raw_temporary_ref,i.normalized_temporary_ref,i.map_path_temporary_ref,
        i.raw_storage_ref,i.normalized_storage_ref,i.map_path_storage_ref)
  );
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.activity_track_object_held(text,timestamptz) FROM PUBLIC;

-- Does a render still show or still publish this thumbnail object? The sweep's two reads
-- (039), asked under the key's tenant. The caller's setting is put back.
CREATE FUNCTION public.course_thumbnail_object_held(text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE database_now timestamptz:=$2;
DECLARE answer boolean;
BEGIN
  PERFORM set_config('app.athlete_id',coalesce(public.object_key_tenant($1),''),true);
  answer:=EXISTS(
    SELECT 1 FROM public.course_thumbnail t
    WHERE (t.storage_ref=$1 AND t.state IN ('prepared','ready'))
       OR (t.temporary_ref=$1 AND t.state IN ('queued','rendering','prepared')
         AND t.expires_at>database_now)
  ) OR EXISTS(
    SELECT 1 FROM public.course_thumbnail t
    WHERE $1 IN (t.temporary_ref,t.storage_ref)
      AND database_now<greatest(t.publication_lease_until+interval '1 hour',
        t.lease_until+interval '1 hour')
  );
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.course_thumbnail_object_held(text,timestamptz) FROM PUBLIC;

-- Does a tenant other than $1 hold this activity or course id? The restore replays' refusal,
-- for a caller row security applies to: every other tenant with an identity account is named in
-- turn, one primary-key read each. A caller row security does not apply to already answered it
-- with its own read across tenants, so it is not asked again. The caller's setting is put back.
CREATE FUNCTION public.restore_foreign_scope_present(text,text,uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE other text;
DECLARE answer boolean:=false;
BEGIN
  IF $2 IS DISTINCT FROM 'activity' AND $2 IS DISTINCT FROM 'course' THEN
    RAISE EXCEPTION 'INVALID_OBJECT_SCOPE';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname=current_user AND (r.rolsuper OR r.rolbypassrls))
  THEN RETURN false; END IF;
  FOR other IN
    SELECT a.athlete_id::text FROM identity_private.account a
    WHERE a.athlete_id::text IS DISTINCT FROM $1 ORDER BY a.athlete_id
  LOOP
    PERFORM set_config('app.athlete_id',other,true);
    IF $2='activity' THEN
      answer:=EXISTS(SELECT 1 FROM public.activity_canonical c
        WHERE c.athlete_id=other AND c.id=$3);
    ELSE
      answer:=EXISTS(SELECT 1 FROM public.course c
        WHERE c.athlete_id=other AND c.course_id=$3);
    END IF;
    EXIT WHEN answer;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.restore_foreign_scope_present(text,text,uuid) FROM PUBLIC;

-- 033/039's authorize; the fence and reference reads go through the helpers, and a key that
-- names no tenant is refused first.
CREATE OR REPLACE FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz)
RETURNS TABLE(id uuid,storage_ref text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE object_ref text;
DECLARE publication_fence timestamptz;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  SELECT q.storage_ref INTO object_ref FROM public.resource_object_cleanup q
    WHERE q.id=$1 AND q.lease_owner=$2 AND q.completed_at IS NULL AND q.lease_until>database_now
    FOR UPDATE;
  IF object_ref IS NULL THEN RETURN; END IF;
  -- Every reference below is read under the tenant the key names (M2-01au). A key that names
  -- no tenant cannot be checked that way, so it is refused and labelled; nothing is deleted.
  IF public.object_key_tenant(object_ref) IS NULL THEN
    UPDATE public.resource_object_cleanup q SET completed_at=database_now,lease_owner=NULL,
      lease_until=NULL,delete_authorized_at=NULL,
      last_error_code='INCONSISTENT_LEDGER:OBJECT_KEY_TENANT'
      WHERE q.id=$1;
    RETURN;
  END IF;
  -- A writer holding an open publication fence may still create this object. Deletion is
  -- deferred to the end of that window instead of being recorded as done: completing the
  -- row now would strand whatever the writer publishes afterwards. The attempt is given
  -- back so waiting never consumes the dead-letter budget.
  -- Only work that could still publish is worth waiting for: an upload that prepared and
  -- has not finished, or one that was cancelled while its writer was mid-publication. A
  -- finalized upload has published everything it ever will, and its objects are protected by
  -- the live revision that references them instead, so a deletion must not wait on its fence.
  publication_fence:=public.resource_object_publication_fence(object_ref,database_now);
  IF publication_fence IS NOT NULL THEN
    UPDATE public.resource_object_cleanup q SET lease_owner=NULL,lease_until=NULL,
      delete_authorized_at=NULL,attempts=greatest(q.attempts-1,0),available_at=publication_fence,
      last_error_code='PUBLICATION_IN_PROGRESS' WHERE q.id=$1;
    RETURN;
  END IF;
  IF public.resource_object_referenced(object_ref,database_now) THEN
    UPDATE public.resource_object_cleanup q SET completed_at=database_now,lease_owner=NULL,
      lease_until=NULL,delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT'
      WHERE q.id=$1;
    RETURN;
  END IF;
  RETURN QUERY UPDATE public.resource_object_cleanup q SET delete_authorized_at=database_now
    WHERE q.id=$1 RETURNING q.id,q.storage_ref,q.attempts;
END $$;
REVOKE ALL ON FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz) FROM PUBLIC;

-- 039's finish; the publication-window reads go through the helper.
CREATE OR REPLACE FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE object_ref text;
DECLARE publication_window boolean;
BEGIN
  SELECT q.storage_ref INTO object_ref FROM public.resource_object_cleanup q WHERE q.id=$1;
  publication_window:=public.resource_object_publication_window(object_ref,database_now);
  UPDATE public.resource_object_cleanup SET
    completed_at=CASE
      WHEN $3 AND NOT publication_window
        AND NOT (reason='account_erased' AND created_at>database_now-interval '30 days')
      THEN database_now ELSE NULL END,
    available_at=CASE
      WHEN $3 AND publication_window THEN database_now+interval '1 minute'
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days'
      THEN database_now+interval '1 hour'
      WHEN $3 THEN available_at
      ELSE database_now+least(attempts,10)*interval '30 seconds' END,
    attempts=CASE
      WHEN $3 AND publication_window THEN 0
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days' THEN 0
      ELSE attempts END,
    last_error_code=CASE
      WHEN $3 AND publication_window THEN 'PUBLICATION_WINDOW_OPEN'
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days'
      THEN 'ERASURE_FENCE_ACTIVE'
      WHEN $3 THEN NULL
      WHEN attempts>=100 THEN 'DEAD_LETTER:'||left(coalesce($4,'OBJECT_DELETE_FAILED'),88)
      ELSE left(coalesce($4,'OBJECT_DELETE_FAILED'),100) END,
    lease_owner=NULL,lease_until=NULL,delete_authorized_at=NULL
  WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL AND lease_until>database_now
    AND delete_authorized_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz)
  FROM PUBLIC;

-- 039's reclaims; the reads of what still holds the object go through the helpers.
CREATE OR REPLACE FUNCTION public.reclaim_unreferenced_activity_track_object(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_RECONCILE_REF';
  END IF;
  IF public.activity_track_object_held($1,database_now) OR EXISTS(
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
REVOKE ALL ON FUNCTION public.reclaim_unreferenced_activity_track_object(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.reclaim_unreferenced_course_thumbnail_object(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_RECONCILE_REF';
  END IF;
  IF public.course_thumbnail_object_held($1,database_now) OR EXISTS(
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

-- 039's settles. The watched ref and everything that could still hold it are the key's
-- tenant's rows, so the one statement runs with that tenant named, and the caller's setting is
-- put back after it.
CREATE OR REPLACE FUNCTION public.settle_activity_track_object_ref(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE affected integer;
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_SETTLE_REF';
  END IF;
  PERFORM set_config('app.athlete_id',coalesce(public.object_key_tenant($1),''),true);
  UPDATE public.activity_track_object_ref r SET settled_at=database_now
  WHERE r.storage_ref=$1 AND r.settled_at IS NULL
    AND r.recorded_at<database_now-interval '7 days'
    AND NOT EXISTS(SELECT 1 FROM public.resource_object_cleanup q
      WHERE q.storage_ref=$1 AND q.completed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.activity_track_revision v JOIN public.activity_canonical c
      ON c.athlete_id=v.athlete_id AND c.id=v.activity_id
      WHERE NOT c.deleted
        AND $1 IN (v.raw_storage_ref,v.normalized_storage_ref,v.map_path_storage_ref))
    AND NOT EXISTS(SELECT 1 FROM public.activity_track_upload_intent i
      WHERE database_now<coalesce(i.publication_lease_until+interval '1 hour',i.expires_at)
        AND $1 IN (i.raw_temporary_ref,i.normalized_temporary_ref,i.map_path_temporary_ref,
          i.raw_storage_ref,i.normalized_storage_ref,i.map_path_storage_ref));
  GET DIAGNOSTICS affected=ROW_COUNT;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.settle_activity_track_object_ref(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.settle_course_thumbnail_object_ref(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE affected integer;
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_SETTLE_REF';
  END IF;
  PERFORM set_config('app.athlete_id',coalesce(public.object_key_tenant($1),''),true);
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
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.settle_course_thumbnail_object_ref(text) FROM PUBLIC;

-- 032's derived purge. The stores are tenant tables: the leased manifest's tenant is named for
-- the deletion, and the caller's setting is put back after it.
CREATE OR REPLACE FUNCTION public.purge_resource_derived_store(uuid,uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text;
DECLARE resource uuid;
DECLARE affected integer := 0;
DECLARE caller_tenant text := current_setting('app.athlete_id', true);
BEGIN
  SELECT q.athlete_id, q.resource_id INTO tenant, resource
    FROM public.resource_derived_cleanup q
    WHERE q.id = $1 AND q.lease_owner = $2 AND q.completed_at IS NULL
      AND q.lease_until > clock_timestamp();
  IF tenant IS NULL THEN RAISE EXCEPTION 'DERIVED_CLEANUP_LEASE_LOST'; END IF;
  PERFORM set_config('app.athlete_id', tenant, true);
  IF $3 = 'derivedData' THEN
    DELETE FROM public.resource_grounding_excerpt
      WHERE athlete_id = tenant AND resource_id = resource;
  ELSIF $3 = 'searchIndex' THEN
    DELETE FROM public.resource_passage WHERE athlete_id = tenant AND resource_id = resource;
  ELSIF $3 = 'cache' THEN
    -- A cached entry names passages from many resources, so a per-resource
    -- purge could leave an entry that still lists a withdrawn excerpt. The
    -- tenant's cache is dropped whole; it is rebuildable by definition.
    DELETE FROM public.resource_retrieval_cache WHERE athlete_id = tenant;
  ELSIF $3 = 'citations' THEN
    DELETE FROM public.resource_citation WHERE athlete_id = tenant AND resource_id = resource;
  ELSE
    RAISE EXCEPTION 'UNKNOWN_DERIVED_TARGET';
  END IF;
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM set_config('app.athlete_id', coalesce(caller_tenant, ''), true);
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.purge_resource_derived_store(uuid,uuid,text) FROM PUBLIC;

-- 051's scope lease; only the INCONSISTENT marking changed: it asks the head of the due order.
CREATE OR REPLACE FUNCTION public.lease_object_scope_purge(uuid,timestamptz,timestamptz)
RETURNS TABLE(athlete_id text,scope_kind text,scope_id uuid,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE lease_duration interval:=$3-$2;
BEGIN
  IF lease_duration<=interval '0 seconds' OR lease_duration>interval '5 minutes'
  THEN RAISE EXCEPTION 'INVALID_PURGE_LEASE'; END IF;
  -- The last attempt's lease ran out before it finished: dead-letter it, labelled.
  UPDATE public.object_scope_purge q SET last_error_code='DEAD_LETTER:LEASE_EXPIRED',
    lease_owner=NULL,lease_until=NULL
  WHERE (q.athlete_id,q.scope_kind,q.scope_id) IN (
    SELECT p.athlete_id,p.scope_kind,p.scope_id FROM public.object_scope_purge p
    WHERE p.completed_at IS NULL AND p.attempts>=100 AND p.lease_owner IS NOT NULL
      AND p.lease_until<=database_now
    ORDER BY p.athlete_id,p.scope_kind,p.scope_id FOR UPDATE SKIP LOCKED LIMIT 100);
  -- A row the lease below refuses because its owner is live: say so, once. Not leased, not
  -- charged, nothing deleted. Only the head of the due order is asked — the (at most 100)
  -- unlabelled rows the lease reaches first — so the per-row tenant read is paid a bounded
  -- number of times however long the backlog is (M2-01au). A live row further back is labelled
  -- when it reaches the head; it is never leased before then either.
  -- Both steps are materialized, so the helper runs once per head row, whatever plan joins them.
  WITH head AS MATERIALIZED (
    SELECT w.athlete_id,w.scope_kind,w.scope_id FROM public.object_scope_purge w
    WHERE w.completed_at IS NULL AND w.attempts<100 AND w.available_at<=database_now
      AND (w.lease_until IS NULL OR w.lease_until<=database_now)
      AND NOT coalesce(starts_with(w.last_error_code,'INCONSISTENT_LEDGER:'),false)
    ORDER BY w.available_at,w.athlete_id,w.scope_kind,w.scope_id LIMIT 100
  ), live AS MATERIALIZED (
    SELECT h.athlete_id,h.scope_kind,h.scope_id FROM head h
    WHERE public.object_purge_scope_live(h.athlete_id,h.scope_kind,h.scope_id)
  )
  UPDATE public.object_scope_purge q SET last_error_code=CASE q.scope_kind
      WHEN 'activity' THEN 'INCONSISTENT_LEDGER:ACTIVITY_LIVE'
      ELSE 'INCONSISTENT_LEDGER:COURSE_AVAILABLE' END
  WHERE (q.athlete_id,q.scope_kind,q.scope_id) IN (
    SELECT p.athlete_id,p.scope_kind,p.scope_id FROM public.object_scope_purge p
    JOIN live l ON l.athlete_id=p.athlete_id AND l.scope_kind=p.scope_kind
      AND l.scope_id=p.scope_id
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND NOT coalesce(starts_with(p.last_error_code,'INCONSISTENT_LEDGER:'),false)
    FOR UPDATE OF p SKIP LOCKED);
  RETURN QUERY WITH candidate AS (
    SELECT p.athlete_id,p.scope_kind,p.scope_id FROM public.object_scope_purge p
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND NOT public.object_purge_scope_live(p.athlete_id,p.scope_kind,p.scope_id)
    ORDER BY p.available_at,p.athlete_id,p.scope_kind,p.scope_id
    FOR UPDATE OF p SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE public.object_scope_purge q SET lease_owner=$1,
      lease_until=database_now+lease_duration,attempts=q.attempts+1,
      -- Taking over an expired lease: the attempt that held it was lost, and says so.
      last_error_code=CASE WHEN q.lease_owner IS NOT NULL THEN 'LEASE_EXPIRED'
        ELSE q.last_error_code END
    FROM candidate c
    WHERE q.athlete_id=c.athlete_id AND q.scope_kind=c.scope_kind AND q.scope_id=c.scope_id
    RETURNING q.athlete_id,q.scope_kind,q.scope_id,q.attempts
  ) SELECT * FROM changed;
END $$;
REVOKE ALL ON FUNCTION public.lease_object_scope_purge(uuid,timestamptz,timestamptz) FROM PUBLIC;

-- 046's activity replay; the foreign-id refusal also probes the other tenants one at a time.
CREATE OR REPLACE FUNCTION public.replay_absent_activity_deletion(text,uuid,text,text,integer,integer,text)
RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF $1 IS NULL OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ACTIVITY_REPLAY_TENANT_MISMATCH';
  END IF;
  IF $2 IS NULL
    OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_INVALID_ID'; END IF;
  IF $3 IS NULL OR $3 NOT IN ('fit','fixture')
    OR $4 IS NULL OR length($4) NOT BETWEEN 1 AND 200
    OR $5 IS NULL OR $5<1 OR $6 IS NULL OR $6<1
    OR $7 IS NULL OR $7 !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_TENANT_ERASED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_TENANT_UNKNOWN'; END IF;
  IF EXISTS(SELECT 1 FROM public.activity_canonical c WHERE c.athlete_id=$1 AND c.id=$2)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_ACTIVITY_PRESENT'; END IF;
  IF EXISTS(SELECT 1 FROM public.activity_canonical c WHERE c.athlete_id<>$1 AND c.id=$2)
    OR public.restore_foreign_scope_present($1,'activity',$2)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_FOREIGN_ACTIVITY'; END IF;
  IF EXISTS(SELECT 1 FROM public.activity_source_head h
    WHERE h.athlete_id=$1 AND h.kind=$3 AND h.source_id=$4)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_SOURCE_CONFLICT'; END IF;
  INSERT INTO public.activity_canonical(athlete_id,id,revision,original,deleted)
    VALUES($1,$2,$6,'{}'::jsonb,true);
  INSERT INTO public.activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,
      activity_id)
    VALUES($1,$3,$4,$5,$7,$2);
  INSERT INTO public.activity_suppression(athlete_id,kind,source_id) VALUES($1,$3,$4);
  IF NOT public.arm_object_scope_purge($1,'activity',$2) THEN
    RAISE EXCEPTION 'ACTIVITY_REPLAY_PURGE_NOT_ARMED';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.replay_absent_activity_deletion(text,uuid,text,text,integer,integer,text)
  FROM PUBLIC;

-- 049's course replay; the foreign-id refusal also probes the other tenants one at a time.
CREATE OR REPLACE FUNCTION public.replay_course_deletion(text,uuid,timestamptz) RETURNS text
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
    OR public.restore_foreign_scope_present($1,'course',$2)
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

-- Point every `*_definer` policy at the role running this, which must own the tables: the step
-- after `REASSIGN OWNED` or a `--no-owner` restore (runbook). A policy a `DROP OWNED` removed is
-- created again as its migration made it. Every table's owner is checked before any policy
-- changes, and the tables are taken in name order. Returns the number of policies it set.
CREATE FUNCTION public.retarget_definer_policies() RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE target record;
DECLARE touched integer:=0;
BEGIN
  IF EXISTS(
    SELECT 1 FROM (VALUES('activity_track_reconcile_state'),('course_deletion'),('course_share'),
      ('course_share_rate'),('course_thumbnail_reconcile_state'),('object_scope_purge'),
      ('resource_derived_cleanup'),('resource_object_cleanup'),('routing_admission'),
      ('tenant_object_purge')) AS t(table_name)
    JOIN pg_catalog.pg_class c ON c.oid=('public.'||t.table_name)::regclass
    WHERE c.relowner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r
      WHERE r.rolname=current_user)
  ) THEN RAISE EXCEPTION 'DEFINER_POLICY_OWNER_MISMATCH'; END IF;
  FOR target IN
    SELECT t.table_name,t.policy_name FROM (VALUES
      ('activity_track_reconcile_state','activity_track_reconcile_state_definer'),
      ('course_deletion','course_deletion_definer'),
      ('course_share','course_share_definer'),
      ('course_share_rate','course_share_rate_definer'),
      ('course_thumbnail_reconcile_state','course_thumbnail_reconcile_state_definer'),
      ('object_scope_purge','object_scope_purge_definer'),
      ('resource_derived_cleanup','resource_derived_cleanup_definer'),
      ('resource_object_cleanup','resource_object_cleanup_definer'),
      ('routing_admission','routing_admission_definer'),
      ('tenant_object_purge','tenant_object_purge_definer')) AS t(table_name,policy_name)
    ORDER BY t.table_name
  LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_policy p
      WHERE p.polrelid=('public.'||target.table_name)::regclass AND p.polname=target.policy_name)
    THEN
      EXECUTE format('ALTER POLICY %I ON public.%I TO %I',
        target.policy_name,target.table_name,current_user);
    ELSE
      EXECUTE format('CREATE POLICY %I ON public.%I TO %I USING (true) WITH CHECK (true)',
        target.policy_name,target.table_name,current_user);
    END IF;
    touched:=touched+1;
  END LOOP;
  RETURN touched;
END $$;
REVOKE ALL ON FUNCTION public.retarget_definer_policies() FROM PUBLIC;
