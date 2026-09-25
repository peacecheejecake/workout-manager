-- M2-01av: the worker paths that scan tenant tables across tenants get a tenant source, so they
-- run when the migration owner is neither superuser nor BYPASSRLS.
--
-- 051 and 052 (M2-01at, M2-01au) fixed every path that holds a row whose tenant it can name.
-- What remained scans for due work with no tenant at all: the render and URL-ingestion leases
-- and every function a leased worker calls by job or request id, the upload, render and URL
-- reaps, the upload and thumbnail history prunes, the search-cache prune, the two sweep windows
-- and the four sweep-fault functions, `prepare_course_thumbnail`,
-- `requeue_course_thumbnail_refs` and `enqueue_abandoned_resource_url_object`. On such an owner
-- the tenant policies show them nothing: renders are never drawn, URLs never fetched, expired
-- uploads never reclaimed, the sweep never looks at a reference (measured before this migration,
-- `worker-tenant-source-plain-owner.integration.test.ts`). Closed, never open — but not working.
--
-- The tenant source (M2-01av progress §1 has the choice and its measurements):
--   1. `tenant_work_index`, one table only the owner's functions touch (047/049–052's precedent:
--      FORCE row security, one policy for the migrating role, no grant to anyone). Per source
--      row it holds that row's tenant, its key, and — once per kind of work that may act on
--      it — when that work can first be due. Row triggers on the eight source tables keep it in
--      the same transaction as the row, and one function per table decides the entries, used by
--      the trigger and by the backfill below alike.
--   2. Every worker function keeps its body, byte for byte, under a new name
--      (`<name>_in_tenant`, EXECUTE moved to the public name). The public name becomes a
--      wrapper that names a tenant and calls the body under it — so every check the body makes,
--      the liveness and head and reference checks included, reads under the row's own tenant
--      through the existing tenant policies. The index only says where to look: a stale or
--      planted index row can make a wrapper look under the wrong tenant, where the body finds
--      nothing (closed), never make a body act on a row it cannot see or skip a check.
--        - a scan asks the index which tenants hold work due now, earliest first (at most 100,
--          read from the first 1,000 due entries), and runs the body under each in turn until
--          it has done what it was asked for;
--        - a function the worker calls by job or request id names the tenant the index holds
--          for that id (none, or more than one, names no tenant);
--        - the sweep's fault functions name the tenant of the watched row (clearing, once the row
--          has settled, the key's);
--        - `enqueue_abandoned_resource_url_object` names the tenant that holds the request, or
--          the one it is given when none does.
--      The caller's setting is put back afterwards (050–052's pattern).
--   3. An owner row security does not apply to (superuser or BYPASSRLS) calls the body directly,
--      exactly as before: the index is kept there too, but not read.
--   4. A prune that can do nothing more for a tenant (every due row waits on an open cleanup
--      receipt) pushes that tenant's due entries back an hour, so a receipt that never closes —
--      a dead letter — cannot hold the head of the order for good. Nothing else defers.
--   5. `retarget_definer_policies()` (052) also points the index's policy at a new owner.
--
-- Nothing else changes: no policy is added to or changed on any tenant table (so no other
-- definer function sees more), no grant on anything that existed changes (the public names keep
-- theirs; the renamed bodies are granted to no one), and the triggers only write the index.
--
-- Backfill: the index is filled from the rows that exist. On an owner row security applies to,
-- the eight source tables' FORCE is lifted for the owner for the backfill statements only and
-- put back before the migration ends (051's precedent; migrate is one transaction).
--
-- Lock order. The eight source tables are taken first, in one statement, in the order account
-- erasure deletes them (039's stage, 038's, 033's two, 032's, 031's, 029's, 028's). The index is
-- new. At run time the triggers add one edge — a source row, then its index row — and nothing
-- waits on an index row while holding anything but a source row: scans read the index without
-- locking it, and the prune's push-back takes index rows with SKIP LOCKED after its last body
-- call. Erasure's 77206 → 0 → rows gains no edge back.

LOCK TABLE course_thumbnail_object_ref,course_thumbnail,activity_track_object_ref,
  activity_track_upload_intent,resource_retrieval_cache,gallery_upload_intent,
  resource_url_ingestion,resource_upload_intent IN ACCESS EXCLUSIVE MODE;

CREATE TABLE tenant_work_index (
  kind text NOT NULL CHECK (kind IN (
    'course_thumbnail:job','course_thumbnail:lease','course_thumbnail:reap',
    'course_thumbnail:prune',
    'resource_url_ingestion:request','resource_url_ingestion:lease',
    'resource_url_ingestion:reap',
    'resource_upload_intent:reap','resource_upload_intent:prune',
    'gallery_upload_intent:reap','gallery_upload_intent:prune',
    'activity_track_upload_intent:reap','activity_track_upload_intent:prune',
    'resource_retrieval_cache:prune',
    'activity_track_object_ref:window','course_thumbnail_object_ref:window')),
  item text NOT NULL CHECK (length(item) BETWEEN 1 AND 512),
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  -- When the work of this kind may first be due. NULL for the entries that only say whose an
  -- id is (`:job`, `:request`) or that the sweep walks in key order (`:window`).
  due_at timestamptz,
  PRIMARY KEY (kind,item,athlete_id)
);
CREATE INDEX tenant_work_index_due ON tenant_work_index(kind,due_at) WHERE due_at IS NOT NULL;
ALTER TABLE tenant_work_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_work_index FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY tenant_work_index_definer '
    'ON tenant_work_index TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
REVOKE ALL ON tenant_work_index FROM PUBLIC;

-- Does row security pass over the role running this? Then a scan reads every tenant already.
CREATE FUNCTION public.owner_reads_every_tenant() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname=current_user AND (r.rolsuper OR r.rolbypassrls))
$$;
REVOKE ALL ON FUNCTION public.owner_reads_every_tenant() FROM PUBLIC;

-- Make one source row's entries exactly $4 (due at $5), among the kinds $3 its table has.
CREATE FUNCTION public.put_tenant_work(text,text,text[],text[],timestamptz[]) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  -- A row that has every kind of its table has nothing to drop (the common write).
  IF coalesce(cardinality($4),0)<cardinality($3) THEN
    DELETE FROM public.tenant_work_index w
      WHERE w.kind=ANY($3) AND w.item=$2 AND w.athlete_id=$1
        AND NOT (w.kind=ANY(coalesce($4,'{}'::text[])));
  END IF;
  INSERT INTO public.tenant_work_index(kind,item,athlete_id,due_at)
    SELECT d.kind,$2,$1,d.due_at FROM unnest($4,$5) AS d(kind,due_at)
    ON CONFLICT(kind,item,athlete_id) DO UPDATE SET due_at=EXCLUDED.due_at
    WHERE public.tenant_work_index.due_at IS DISTINCT FROM EXCLUDED.due_at;
END $$;
REVOKE ALL ON FUNCTION public.put_tenant_work(text,text,text[],text[],timestamptz[]) FROM PUBLIC;

-- The entries of each source row. Each kind is the scan it feeds, and its due time is the
-- earliest moment that scan's own condition can hold for the row (the body checks it again,
-- under the row's tenant; an entry that is due early only costs a look).
CREATE FUNCTION public.course_thumbnail_work_items(public.course_thumbnail)
RETURNS TABLE(kind text,due_at timestamptz)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT w.kind,w.due_at FROM (VALUES
    ('course_thumbnail:job',true,NULL::timestamptz),
    -- lease_course_thumbnail_render: waiting or retryable, attempts left, lease and retry over.
    ('course_thumbnail:lease',
      ($1.state IN ('queued','rendering') OR ($1.state='failed' AND $1.failure_retryable))
        AND $1.attempt_count<5,
      greatest($1.updated_at,$1.lease_until,
        CASE WHEN $1.state='failed' THEN coalesce($1.retry_at,'infinity') END)),
    -- reap_course_thumbnail_renders: a lease that ran out, or a render past its deadline.
    ('course_thumbnail:reap',
      $1.state IN ('queued','rendering','prepared')
        OR ($1.state='failed' AND $1.failure_retryable),
      least(CASE WHEN $1.state IN ('rendering','prepared') THEN $1.lease_until END,
        $1.expires_at)),
    -- prune_course_thumbnail_history: closed for good, seven days after its last change.
    ('course_thumbnail:prune',
      $1.state IN ('superseded','failed') AND NOT $1.failure_retryable,
      $1.updated_at+interval '7 days')
  ) AS w(kind,member,due_at) WHERE w.member
$$;
REVOKE ALL ON FUNCTION public.course_thumbnail_work_items(public.course_thumbnail) FROM PUBLIC;

CREATE FUNCTION public.resource_url_ingestion_work_items(public.resource_url_ingestion)
RETURNS TABLE(kind text,due_at timestamptz)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT w.kind,w.due_at FROM (VALUES
    ('resource_url_ingestion:request',true,NULL::timestamptz),
    -- lease_resource_url_ingestion
    ('resource_url_ingestion:lease',
      ($1.state IN ('queued','fetching','parsing')
        OR ($1.state='failed' AND $1.failure_retryable)) AND $1.attempt_count<5,
      greatest($1.updated_at,$1.lease_until,
        CASE WHEN $1.state='failed' THEN coalesce($1.retry_at,'infinity') END)),
    -- reap_resource_url_ingestions
    ('resource_url_ingestion:reap',
      $1.state IN ('queued','fetching','parsing')
        OR ($1.state='failed' AND $1.failure_retryable),
      $1.expires_at)
  ) AS w(kind,member,due_at) WHERE w.member
$$;
REVOKE ALL ON FUNCTION public.resource_url_ingestion_work_items(public.resource_url_ingestion)
  FROM PUBLIC;

-- The three upload intents: reap_expired_resource_uploads and prune_resource_upload_history.
CREATE FUNCTION public.upload_intent_work_items(text,text,timestamptz,timestamptz)
RETURNS TABLE(kind text,due_at timestamptz)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT w.kind,w.due_at FROM (VALUES
    ($1||':reap',$2 IN ('reserved','prepared','staged'),$4),
    ($1||':prune',$2='failed',$3+interval '7 days')
  ) AS w(kind,member,due_at) WHERE w.member
$$;
REVOKE ALL ON FUNCTION public.upload_intent_work_items(text,text,timestamptz,timestamptz)
  FROM PUBLIC;

-- The trigger of each source table: a deleted row's entries go, and a written row's entries
-- become exactly what its entry function says. A row's tenant and key never change (no path
-- writes them), so an update only ever changes the entries of the key it already had.
CREATE FUNCTION public.course_thumbnail_work_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE kinds text[]:=ARRAY['course_thumbnail:job','course_thumbnail:lease',
  'course_thumbnail:reap','course_thumbnail:prune'];
DECLARE due_kinds text[];
DECLARE dues timestamptz[];
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.put_tenant_work(OLD.athlete_id,OLD.job_id::text,kinds,NULL,NULL);
    RETURN NULL;
  END IF;
  SELECT array_agg(w.kind),array_agg(w.due_at) INTO due_kinds,dues
    FROM public.course_thumbnail_work_items(NEW) w;
  PERFORM public.put_tenant_work(NEW.athlete_id,NEW.job_id::text,kinds,due_kinds,dues);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.course_thumbnail_work_index() FROM PUBLIC;

CREATE FUNCTION public.resource_url_ingestion_work_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE kinds text[]:=ARRAY['resource_url_ingestion:request','resource_url_ingestion:lease',
  'resource_url_ingestion:reap'];
DECLARE due_kinds text[];
DECLARE dues timestamptz[];
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.put_tenant_work(OLD.athlete_id,OLD.request_id::text,kinds,NULL,NULL);
    RETURN NULL;
  END IF;
  SELECT array_agg(w.kind),array_agg(w.due_at) INTO due_kinds,dues
    FROM public.resource_url_ingestion_work_items(NEW) w;
  PERFORM public.put_tenant_work(NEW.athlete_id,NEW.request_id::text,kinds,due_kinds,dues);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.resource_url_ingestion_work_index() FROM PUBLIC;

-- Shared by the three upload intents; the table's name is the kinds' prefix.
CREATE FUNCTION public.upload_intent_work_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE kinds text[]:=ARRAY[TG_TABLE_NAME||':reap',TG_TABLE_NAME||':prune'];
DECLARE due_kinds text[];
DECLARE dues timestamptz[];
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.put_tenant_work(OLD.athlete_id,OLD.upload_id::text,kinds,NULL,NULL);
    RETURN NULL;
  END IF;
  SELECT array_agg(w.kind),array_agg(w.due_at) INTO due_kinds,dues
    FROM public.upload_intent_work_items(TG_TABLE_NAME,NEW.state,NEW.updated_at,NEW.expires_at) w;
  PERFORM public.put_tenant_work(NEW.athlete_id,NEW.upload_id::text,kinds,due_kinds,dues);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.upload_intent_work_index() FROM PUBLIC;

-- prune_resource_retrieval_cache: every entry, due when it expires.
CREATE FUNCTION public.resource_retrieval_cache_work_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE kinds text[]:=ARRAY['resource_retrieval_cache:prune'];
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.put_tenant_work(OLD.athlete_id,OLD.cache_key,kinds,NULL,NULL);
    RETURN NULL;
  END IF;
  PERFORM public.put_tenant_work(NEW.athlete_id,NEW.cache_key,kinds,kinds,
    ARRAY[NEW.expires_at]);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.resource_retrieval_cache_work_index() FROM PUBLIC;

-- The two sweep windows: every watched reference that is not settled, walked in key order.
-- Shared by both reference tables; the table's name is the kind's prefix.
CREATE FUNCTION public.object_ref_work_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE kinds text[]:=ARRAY[TG_TABLE_NAME||':window'];
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.put_tenant_work(OLD.athlete_id,OLD.storage_ref,kinds,NULL,NULL);
    RETURN NULL;
  END IF;
  IF NEW.settled_at IS NULL THEN
    PERFORM public.put_tenant_work(NEW.athlete_id,NEW.storage_ref,kinds,kinds,
      ARRAY[NULL::timestamptz]);
  ELSE
    PERFORM public.put_tenant_work(NEW.athlete_id,NEW.storage_ref,kinds,NULL,NULL);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.object_ref_work_index() FROM PUBLIC;

CREATE TRIGGER course_thumbnail_work_index AFTER INSERT OR UPDATE OR DELETE ON course_thumbnail
  FOR EACH ROW EXECUTE FUNCTION public.course_thumbnail_work_index();
CREATE TRIGGER resource_url_ingestion_work_index AFTER INSERT OR UPDATE OR DELETE
  ON resource_url_ingestion FOR EACH ROW EXECUTE FUNCTION public.resource_url_ingestion_work_index();
CREATE TRIGGER resource_upload_intent_work_index AFTER INSERT OR UPDATE OR DELETE
  ON resource_upload_intent FOR EACH ROW EXECUTE FUNCTION public.upload_intent_work_index();
CREATE TRIGGER gallery_upload_intent_work_index AFTER INSERT OR UPDATE OR DELETE
  ON gallery_upload_intent FOR EACH ROW EXECUTE FUNCTION public.upload_intent_work_index();
CREATE TRIGGER activity_track_upload_intent_work_index AFTER INSERT OR UPDATE OR DELETE
  ON activity_track_upload_intent FOR EACH ROW EXECUTE FUNCTION public.upload_intent_work_index();
CREATE TRIGGER resource_retrieval_cache_work_index AFTER INSERT OR UPDATE OR DELETE
  ON resource_retrieval_cache FOR EACH ROW
  EXECUTE FUNCTION public.resource_retrieval_cache_work_index();
CREATE TRIGGER activity_track_object_ref_work_index AFTER INSERT OR UPDATE OR DELETE
  ON activity_track_object_ref FOR EACH ROW EXECUTE FUNCTION public.object_ref_work_index();
CREATE TRIGGER course_thumbnail_object_ref_work_index AFTER INSERT OR UPDATE OR DELETE
  ON course_thumbnail_object_ref FOR EACH ROW EXECUTE FUNCTION public.object_ref_work_index();

-- Backfill from the rows that exist. FORCE is lifted for the owner for these statements only.
ALTER TABLE course_thumbnail_object_ref NO FORCE ROW LEVEL SECURITY;
ALTER TABLE course_thumbnail NO FORCE ROW LEVEL SECURITY;
ALTER TABLE activity_track_object_ref NO FORCE ROW LEVEL SECURITY;
ALTER TABLE activity_track_upload_intent NO FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_retrieval_cache NO FORCE ROW LEVEL SECURITY;
ALTER TABLE gallery_upload_intent NO FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_url_ingestion NO FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_upload_intent NO FORCE ROW LEVEL SECURITY;
INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
  SELECT w.kind,t.job_id::text,t.athlete_id,w.due_at FROM course_thumbnail t
  CROSS JOIN LATERAL public.course_thumbnail_work_items(t) w;
INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
  SELECT w.kind,t.request_id::text,t.athlete_id,w.due_at FROM resource_url_ingestion t
  CROSS JOIN LATERAL public.resource_url_ingestion_work_items(t) w;
INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
  SELECT w.kind,t.upload_id::text,t.athlete_id,w.due_at FROM resource_upload_intent t
  CROSS JOIN LATERAL public.upload_intent_work_items('resource_upload_intent',t.state,
    t.updated_at,t.expires_at) w;
INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
  SELECT w.kind,t.upload_id::text,t.athlete_id,w.due_at FROM gallery_upload_intent t
  CROSS JOIN LATERAL public.upload_intent_work_items('gallery_upload_intent',t.state,
    t.updated_at,t.expires_at) w;
INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
  SELECT w.kind,t.upload_id::text,t.athlete_id,w.due_at FROM activity_track_upload_intent t
  CROSS JOIN LATERAL public.upload_intent_work_items('activity_track_upload_intent',t.state,
    t.updated_at,t.expires_at) w;
INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
  SELECT 'resource_retrieval_cache:prune',t.cache_key,t.athlete_id,t.expires_at
  FROM resource_retrieval_cache t;
INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
  SELECT 'activity_track_object_ref:window',t.storage_ref,t.athlete_id,NULL
  FROM activity_track_object_ref t WHERE t.settled_at IS NULL;
INSERT INTO tenant_work_index(kind,item,athlete_id,due_at)
  SELECT 'course_thumbnail_object_ref:window',t.storage_ref,t.athlete_id,NULL
  FROM course_thumbnail_object_ref t WHERE t.settled_at IS NULL;
ALTER TABLE course_thumbnail_object_ref FORCE ROW LEVEL SECURITY;
ALTER TABLE course_thumbnail FORCE ROW LEVEL SECURITY;
ALTER TABLE activity_track_object_ref FORCE ROW LEVEL SECURITY;
ALTER TABLE activity_track_upload_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_retrieval_cache FORCE ROW LEVEL SECURITY;
ALTER TABLE gallery_upload_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_url_ingestion FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_upload_intent FORCE ROW LEVEL SECURITY;

-- The one tenant the index holds for this id — or NULL when it holds none, or more than one.
CREATE FUNCTION public.tenant_work_item_tenant(text,text) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT CASE WHEN count(*)=1 THEN min(w.athlete_id) END FROM public.tenant_work_index w
  WHERE w.kind=$1 AND w.item=$2
$$;
REVOKE ALL ON FUNCTION public.tenant_work_item_tenant(text,text) FROM PUBLIC;

-- Tenants that hold work of kinds $1 due by $2, earliest first: at most 100, read from the
-- first 1,000 due entries of each kind.
CREATE FUNCTION public.tenant_work_due(text[],timestamptz) RETURNS SETOF text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT d.athlete_id FROM unnest($1) AS k(kind)
  CROSS JOIN LATERAL (SELECT w.athlete_id,w.due_at FROM public.tenant_work_index w
    WHERE w.kind=k.kind AND w.due_at<=$2 ORDER BY w.due_at LIMIT 1000) d
  GROUP BY d.athlete_id ORDER BY min(d.due_at),d.athlete_id LIMIT 100
$$;
REVOKE ALL ON FUNCTION public.tenant_work_due(text[],timestamptz) FROM PUBLIC;

-- The tenants of the first $3 unsettled references after $2, in key order, and how many of
-- those references each holds.
CREATE FUNCTION public.tenant_work_window(text,text,integer)
RETURNS TABLE(athlete_id text,items integer)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT w.athlete_id,count(*)::integer FROM (
    SELECT i.athlete_id,i.item FROM public.tenant_work_index i
    WHERE i.kind=$1 AND i.item>$2 ORDER BY i.item LIMIT $3
  ) w GROUP BY w.athlete_id ORDER BY min(w.item)
$$;
REVOKE ALL ON FUNCTION public.tenant_work_window(text,text,integer) FROM PUBLIC;

-- A prune that could do nothing more for tenant $2: its entries of kinds $1 due by $3 wait an
-- hour. Rows another transaction holds are left alone (never waited on).
CREATE FUNCTION public.defer_tenant_work(text[],text[],timestamptz) RETURNS void
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $$
  UPDATE public.tenant_work_index w SET due_at=$3+interval '1 hour'
  WHERE (w.kind,w.item,w.athlete_id) IN (
    SELECT d.kind,d.item,d.athlete_id FROM public.tenant_work_index d
    WHERE d.kind=ANY($1) AND d.athlete_id=ANY($2) AND d.due_at<=$3
    FOR UPDATE SKIP LOCKED)
$$;
REVOKE ALL ON FUNCTION public.defer_tenant_work(text[],text[],timestamptz) FROM PUBLIC;

-- Every worker body keeps its name's grants on its public name; the body itself is renamed and
-- kept exactly as it was.
ALTER FUNCTION public.lease_course_thumbnail_render(uuid,interval)
  RENAME TO lease_course_thumbnail_render_in_tenant;
ALTER FUNCTION public.prepare_course_thumbnail(uuid,uuid,text,text,bigint,integer)
  RENAME TO prepare_course_thumbnail_in_tenant;
ALTER FUNCTION public.course_thumbnail_publication_fence_open(uuid,uuid)
  RENAME TO course_thumbnail_publication_fence_open_in_tenant;
ALTER FUNCTION public.finalize_course_thumbnail(uuid,uuid)
  RENAME TO finalize_course_thumbnail_in_tenant;
ALTER FUNCTION public.release_course_thumbnail_render(uuid,uuid)
  RENAME TO release_course_thumbnail_render_in_tenant;
ALTER FUNCTION public.mark_course_thumbnail_unavailable(uuid,uuid,text)
  RENAME TO mark_course_thumbnail_unavailable_in_tenant;
ALTER FUNCTION public.fail_course_thumbnail(uuid,uuid,text,boolean,interval)
  RENAME TO fail_course_thumbnail_in_tenant;
ALTER FUNCTION public.requeue_course_thumbnail_refs(uuid)
  RENAME TO requeue_course_thumbnail_refs_in_tenant;
ALTER FUNCTION public.reap_course_thumbnail_renders(integer)
  RENAME TO reap_course_thumbnail_renders_in_tenant;
ALTER FUNCTION public.prune_course_thumbnail_history(integer)
  RENAME TO prune_course_thumbnail_history_in_tenant;
ALTER FUNCTION public.lease_resource_url_ingestion(uuid,interval)
  RENAME TO lease_resource_url_ingestion_in_tenant;
ALTER FUNCTION public.record_resource_url_hop(uuid,uuid,integer,text,text,integer,inet[],text)
  RENAME TO record_resource_url_hop_in_tenant;
ALTER FUNCTION public.prepare_resource_url_raw(uuid,uuid,text,text,bigint,text)
  RENAME TO prepare_resource_url_raw_in_tenant;
ALTER FUNCTION public.mark_resource_url_raw_published(uuid,uuid)
  RENAME TO mark_resource_url_raw_published_in_tenant;
ALTER FUNCTION public.prepare_resource_url_parsed(uuid,uuid,text,text,bigint,text,jsonb,text,text)
  RENAME TO prepare_resource_url_parsed_in_tenant;
ALTER FUNCTION public.mark_resource_url_parsed_published(uuid,uuid)
  RENAME TO mark_resource_url_parsed_published_in_tenant;
ALTER FUNCTION public.finalize_resource_url_ingestion(uuid,uuid)
  RENAME TO finalize_resource_url_ingestion_in_tenant;
ALTER FUNCTION public.mark_resource_url_bookmark_only(uuid,uuid,text,text)
  RENAME TO mark_resource_url_bookmark_only_in_tenant;
ALTER FUNCTION public.fail_resource_url_ingestion(uuid,uuid,text,boolean,interval)
  RENAME TO fail_resource_url_ingestion_in_tenant;
ALTER FUNCTION public.reap_resource_url_ingestions(integer)
  RENAME TO reap_resource_url_ingestions_in_tenant;
ALTER FUNCTION public.enqueue_abandoned_resource_url_object(text,uuid,uuid,text)
  RENAME TO enqueue_abandoned_resource_url_object_in_tenant;
ALTER FUNCTION public.reap_expired_resource_uploads(timestamptz,integer)
  RENAME TO reap_expired_resource_uploads_in_tenant;
ALTER FUNCTION public.prune_resource_upload_history(integer)
  RENAME TO prune_resource_upload_history_in_tenant;
ALTER FUNCTION public.prune_resource_retrieval_cache(integer)
  RENAME TO prune_resource_retrieval_cache_in_tenant;
ALTER FUNCTION public.activity_track_reconcile_window(text,integer)
  RENAME TO activity_track_reconcile_window_in_tenant;
ALTER FUNCTION public.course_thumbnail_reconcile_window(text,integer)
  RENAME TO course_thumbnail_reconcile_window_in_tenant;
ALTER FUNCTION public.record_activity_track_sweep_fault(text,text)
  RENAME TO record_activity_track_sweep_fault_in_tenant;
ALTER FUNCTION public.record_course_thumbnail_sweep_fault(text,text)
  RENAME TO record_course_thumbnail_sweep_fault_in_tenant;
ALTER FUNCTION public.clear_activity_track_sweep_fault(text)
  RENAME TO clear_activity_track_sweep_fault_in_tenant;
ALTER FUNCTION public.clear_course_thumbnail_sweep_fault(text)
  RENAME TO clear_course_thumbnail_sweep_fault_in_tenant;

-- ---------------------------------------------------------------------------------------------
-- Scans. An owner row security passes over calls the body once, as before. Otherwise the body
-- runs under each tenant the index names, until the call has what it asked for.

CREATE FUNCTION public.lease_course_thumbnail_render(uuid,interval)
RETURNS TABLE(athlete_id text,course_id uuid,course_revision integer,revision_id uuid,
  job_id uuid,lease_token uuid,temporary_ref text,geometry jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE tenant text;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT * FROM public.lease_course_thumbnail_render_in_tenant($1,$2);
    RETURN;
  END IF;
  IF $2<=interval '0 seconds' OR $2>interval '5 minutes' THEN
    RAISE EXCEPTION 'INVALID_COURSE_THUMBNAIL_LEASE';
  END IF;
  FOR tenant IN SELECT public.tenant_work_due(ARRAY['course_thumbnail:lease'],clock_timestamp())
  LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    RETURN QUERY SELECT * FROM public.lease_course_thumbnail_render_in_tenant($1,$2);
    EXIT WHEN FOUND;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
END $$;
REVOKE ALL ON FUNCTION public.lease_course_thumbnail_render(uuid,interval) FROM PUBLIC;

CREATE FUNCTION public.reap_course_thumbnail_renders(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE tenant text;
DECLARE affected integer:=0;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.reap_course_thumbnail_renders_in_tenant($1);
  END IF;
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_REAP_LIMIT'; END IF;
  FOR tenant IN SELECT public.tenant_work_due(ARRAY['course_thumbnail:reap'],statement_timestamp())
  LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    affected:=affected+public.reap_course_thumbnail_renders_in_tenant($1-affected);
    EXIT WHEN affected>=$1;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.reap_course_thumbnail_renders(integer) FROM PUBLIC;

CREATE FUNCTION public.prune_course_thumbnail_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE tenant text;
DECLARE affected integer:=0;
DECLARE pruned integer;
DECLARE exhausted text[]:='{}';
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.prune_course_thumbnail_history_in_tenant($1);
  END IF;
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_PRUNE_LIMIT'; END IF;
  FOR tenant IN SELECT public.tenant_work_due(ARRAY['course_thumbnail:prune'],statement_timestamp())
  LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    pruned:=public.prune_course_thumbnail_history_in_tenant($1-affected);
    -- Fewer than asked for: whatever of this tenant is still due waits on a cleanup receipt.
    IF pruned<$1-affected THEN exhausted:=exhausted||tenant; END IF;
    affected:=affected+pruned;
    EXIT WHEN affected>=$1;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  PERFORM public.defer_tenant_work(ARRAY['course_thumbnail:prune'],exhausted,statement_timestamp());
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_course_thumbnail_history(integer) FROM PUBLIC;

CREATE FUNCTION public.lease_resource_url_ingestion(uuid,interval)
RETURNS TABLE(athlete_id text,request_id uuid,attempt_no integer,phase text,lease_token uuid,
  requested_url text,display_url text,resource_id uuid,version_id uuid,raw_temporary_ref text,
  raw_storage_ref text,raw_media_type text,parsed_temporary_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE tenant text;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT * FROM public.lease_resource_url_ingestion_in_tenant($1,$2);
    RETURN;
  END IF;
  IF $2<=interval '0 seconds' OR $2>interval '5 minutes' THEN
    RAISE EXCEPTION 'INVALID_URL_LEASE';
  END IF;
  FOR tenant IN
    SELECT public.tenant_work_due(ARRAY['resource_url_ingestion:lease'],clock_timestamp())
  LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    RETURN QUERY SELECT * FROM public.lease_resource_url_ingestion_in_tenant($1,$2);
    EXIT WHEN FOUND;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
END $$;
REVOKE ALL ON FUNCTION public.lease_resource_url_ingestion(uuid,interval) FROM PUBLIC;

CREATE FUNCTION public.reap_resource_url_ingestions(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE tenant text;
DECLARE affected integer:=0;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.reap_resource_url_ingestions_in_tenant($1);
  END IF;
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_REAP_LIMIT'; END IF;
  FOR tenant IN
    SELECT public.tenant_work_due(ARRAY['resource_url_ingestion:reap'],statement_timestamp())
  LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    affected:=affected+public.reap_resource_url_ingestions_in_tenant($1-affected);
    EXIT WHEN affected>=$1;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.reap_resource_url_ingestions(integer) FROM PUBLIC;

CREATE FUNCTION public.reap_expired_resource_uploads(timestamptz,integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE tenant text;
DECLARE affected integer:=0;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.reap_expired_resource_uploads_in_tenant($1,$2);
  END IF;
  IF $2<1 OR $2>100 THEN RAISE EXCEPTION 'INVALID_REAP_LIMIT'; END IF;
  FOR tenant IN SELECT public.tenant_work_due(ARRAY['resource_upload_intent:reap',
    'gallery_upload_intent:reap','activity_track_upload_intent:reap'],statement_timestamp())
  LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    affected:=affected+public.reap_expired_resource_uploads_in_tenant($1,$2-affected);
    EXIT WHEN affected>=$2;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.reap_expired_resource_uploads(timestamptz,integer) FROM PUBLIC;

CREATE FUNCTION public.prune_resource_upload_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE tenant text;
DECLARE affected integer:=0;
DECLARE pruned integer;
DECLARE exhausted text[]:='{}';
DECLARE kinds text[]:=ARRAY['resource_upload_intent:prune','gallery_upload_intent:prune',
  'activity_track_upload_intent:prune'];
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.prune_resource_upload_history_in_tenant($1);
  END IF;
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_PRUNE_LIMIT'; END IF;
  FOR tenant IN SELECT public.tenant_work_due(kinds,statement_timestamp()) LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    pruned:=public.prune_resource_upload_history_in_tenant($1-affected);
    -- Fewer than asked for (each table is asked for as many): whatever of this tenant is
    -- still due waits on a cleanup receipt.
    IF pruned<$1-affected THEN exhausted:=exhausted||tenant; END IF;
    affected:=affected+pruned;
    EXIT WHEN affected>=$1;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  PERFORM public.defer_tenant_work(kinds,exhausted,statement_timestamp());
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_resource_upload_history(integer) FROM PUBLIC;

CREATE FUNCTION public.prune_resource_retrieval_cache(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE tenant text;
DECLARE affected integer:=0;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.prune_resource_retrieval_cache_in_tenant($1);
  END IF;
  IF $1<1 OR $1>1000 THEN RAISE EXCEPTION 'INVALID_PRUNE_LIMIT'; END IF;
  FOR tenant IN
    SELECT public.tenant_work_due(ARRAY['resource_retrieval_cache:prune'],clock_timestamp())
  LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    affected:=affected+public.prune_resource_retrieval_cache_in_tenant($1-affected);
    EXIT WHEN affected>=$1;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_resource_retrieval_cache(integer) FROM PUBLIC;

-- The sweep windows: each tenant's part of the global window, read under that tenant, merged
-- back into key order.
CREATE FUNCTION public.activity_track_reconcile_window(text,integer)
RETURNS TABLE(storage_ref text,sweep_attempts integer,deferred boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE part record;
DECLARE refs text[]:='{}';
DECLARE attempts integer[]:='{}';
DECLARE waits boolean[]:='{}';
DECLARE window_size integer:=least(greatest($2,1),1000);
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT * FROM public.activity_track_reconcile_window_in_tenant($1,$2);
    RETURN;
  END IF;
  FOR part IN
    SELECT * FROM public.tenant_work_window('activity_track_object_ref:window',$1,window_size)
  LOOP
    PERFORM set_config('app.athlete_id',part.athlete_id,true);
    SELECT refs||array_agg(w.storage_ref),attempts||array_agg(w.sweep_attempts),
      waits||array_agg(w.deferred) INTO refs,attempts,waits
    FROM public.activity_track_reconcile_window_in_tenant($1,part.items) w;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN QUERY SELECT u.ref,u.attempt,u.waiting FROM unnest(refs,attempts,waits)
    AS u(ref,attempt,waiting) ORDER BY u.ref LIMIT window_size;
END $$;
REVOKE ALL ON FUNCTION public.activity_track_reconcile_window(text,integer) FROM PUBLIC;

CREATE FUNCTION public.course_thumbnail_reconcile_window(text,integer)
RETURNS TABLE(storage_ref text,sweep_attempts integer,deferred boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE part record;
DECLARE refs text[]:='{}';
DECLARE attempts integer[]:='{}';
DECLARE waits boolean[]:='{}';
DECLARE window_size integer:=least(greatest($2,1),1000);
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT * FROM public.course_thumbnail_reconcile_window_in_tenant($1,$2);
    RETURN;
  END IF;
  FOR part IN
    SELECT * FROM public.tenant_work_window('course_thumbnail_object_ref:window',$1,window_size)
  LOOP
    PERFORM set_config('app.athlete_id',part.athlete_id,true);
    SELECT refs||array_agg(w.storage_ref),attempts||array_agg(w.sweep_attempts),
      waits||array_agg(w.deferred) INTO refs,attempts,waits
    FROM public.course_thumbnail_reconcile_window_in_tenant($1,part.items) w;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN QUERY SELECT u.ref,u.attempt,u.waiting FROM unnest(refs,attempts,waits)
    AS u(ref,attempt,waiting) ORDER BY u.ref LIMIT window_size;
END $$;
REVOKE ALL ON FUNCTION public.course_thumbnail_reconcile_window(text,integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- By id. The body runs once, under the tenant the index holds for the job or request.

CREATE FUNCTION public.prepare_course_thumbnail(uuid,uuid,text,text,bigint,integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.prepare_course_thumbnail_in_tenant($1,$2,$3,$4,$5,$6);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('course_thumbnail:job',$1::text),''),true);
  answer:=public.prepare_course_thumbnail_in_tenant($1,$2,$3,$4,$5,$6);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.prepare_course_thumbnail(uuid,uuid,text,text,bigint,integer)
  FROM PUBLIC;

CREATE FUNCTION public.course_thumbnail_publication_fence_open(uuid,uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.course_thumbnail_publication_fence_open_in_tenant($1,$2);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('course_thumbnail:job',$1::text),''),true);
  answer:=public.course_thumbnail_publication_fence_open_in_tenant($1,$2);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.course_thumbnail_publication_fence_open(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.finalize_course_thumbnail(uuid,uuid) RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT * FROM public.finalize_course_thumbnail_in_tenant($1,$2);
    RETURN;
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('course_thumbnail:job',$1::text),''),true);
  RETURN QUERY SELECT * FROM public.finalize_course_thumbnail_in_tenant($1,$2);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
END $$;
REVOKE ALL ON FUNCTION public.finalize_course_thumbnail(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.release_course_thumbnail_render(uuid,uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.release_course_thumbnail_render_in_tenant($1,$2);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('course_thumbnail:job',$1::text),''),true);
  answer:=public.release_course_thumbnail_render_in_tenant($1,$2);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.release_course_thumbnail_render(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.mark_course_thumbnail_unavailable(uuid,uuid,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.mark_course_thumbnail_unavailable_in_tenant($1,$2,$3);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('course_thumbnail:job',$1::text),''),true);
  answer:=public.mark_course_thumbnail_unavailable_in_tenant($1,$2,$3);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.mark_course_thumbnail_unavailable(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.fail_course_thumbnail(uuid,uuid,text,boolean,interval) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.fail_course_thumbnail_in_tenant($1,$2,$3,$4,$5);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('course_thumbnail:job',$1::text),''),true);
  answer:=public.fail_course_thumbnail_in_tenant($1,$2,$3,$4,$5);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.fail_course_thumbnail(uuid,uuid,text,boolean,interval) FROM PUBLIC;

CREATE FUNCTION public.requeue_course_thumbnail_refs(uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer integer;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.requeue_course_thumbnail_refs_in_tenant($1);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('course_thumbnail:job',$1::text),''),true);
  answer:=public.requeue_course_thumbnail_refs_in_tenant($1);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.requeue_course_thumbnail_refs(uuid) FROM PUBLIC;

CREATE FUNCTION public.record_resource_url_hop(uuid,uuid,integer,text,text,integer,inet[],text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.record_resource_url_hop_in_tenant($1,$2,$3,$4,$5,$6,$7,$8);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('resource_url_ingestion:request',$1::text),''),true);
  answer:=public.record_resource_url_hop_in_tenant($1,$2,$3,$4,$5,$6,$7,$8);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION
  public.record_resource_url_hop(uuid,uuid,integer,text,text,integer,inet[],text) FROM PUBLIC;

CREATE FUNCTION public.prepare_resource_url_raw(uuid,uuid,text,text,bigint,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.prepare_resource_url_raw_in_tenant($1,$2,$3,$4,$5,$6);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('resource_url_ingestion:request',$1::text),''),true);
  answer:=public.prepare_resource_url_raw_in_tenant($1,$2,$3,$4,$5,$6);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.prepare_resource_url_raw(uuid,uuid,text,text,bigint,text)
  FROM PUBLIC;

CREATE FUNCTION public.mark_resource_url_raw_published(uuid,uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.mark_resource_url_raw_published_in_tenant($1,$2);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('resource_url_ingestion:request',$1::text),''),true);
  answer:=public.mark_resource_url_raw_published_in_tenant($1,$2);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.mark_resource_url_raw_published(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.prepare_resource_url_parsed(uuid,uuid,text,text,bigint,text,jsonb,text,text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.prepare_resource_url_parsed_in_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('resource_url_ingestion:request',$1::text),''),true);
  answer:=public.prepare_resource_url_parsed_in_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION
  public.prepare_resource_url_parsed(uuid,uuid,text,text,bigint,text,jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION public.mark_resource_url_parsed_published(uuid,uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.mark_resource_url_parsed_published_in_tenant($1,$2);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('resource_url_ingestion:request',$1::text),''),true);
  answer:=public.mark_resource_url_parsed_published_in_tenant($1,$2);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.mark_resource_url_parsed_published(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.finalize_resource_url_ingestion(uuid,uuid)
RETURNS TABLE(resource_id uuid,version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT * FROM public.finalize_resource_url_ingestion_in_tenant($1,$2);
    RETURN;
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('resource_url_ingestion:request',$1::text),''),true);
  RETURN QUERY SELECT * FROM public.finalize_resource_url_ingestion_in_tenant($1,$2);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
END $$;
REVOKE ALL ON FUNCTION public.finalize_resource_url_ingestion(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.mark_resource_url_bookmark_only(uuid,uuid,text,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.mark_resource_url_bookmark_only_in_tenant($1,$2,$3,$4);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('resource_url_ingestion:request',$1::text),''),true);
  answer:=public.mark_resource_url_bookmark_only_in_tenant($1,$2,$3,$4);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.mark_resource_url_bookmark_only(uuid,uuid,text,text) FROM PUBLIC;

CREATE FUNCTION public.fail_resource_url_ingestion(uuid,uuid,text,boolean,interval)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.fail_resource_url_ingestion_in_tenant($1,$2,$3,$4,$5);
  END IF;
  PERFORM set_config('app.athlete_id',
    coalesce(public.tenant_work_item_tenant('resource_url_ingestion:request',$1::text),''),true);
  answer:=public.fail_resource_url_ingestion_in_tenant($1,$2,$3,$4,$5);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.fail_resource_url_ingestion(uuid,uuid,text,boolean,interval)
  FROM PUBLIC;

-- Under the tenant that holds the request, or — when none does — the one the worker names. The
-- body refuses a key outside the named tenant's prefix, and a request that is not that tenant's,
-- exactly as it does reading every tenant.
CREATE FUNCTION public.enqueue_abandoned_resource_url_object(text,uuid,uuid,text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.enqueue_abandoned_resource_url_object_in_tenant($1,$2,$3,$4);
  END IF;
  PERFORM set_config('app.athlete_id',coalesce(
    public.tenant_work_item_tenant('resource_url_ingestion:request',$2::text),$1,''),true);
  answer:=public.enqueue_abandoned_resource_url_object_in_tenant($1,$2,$3,$4);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_abandoned_resource_url_object(text,uuid,uuid,text)
  FROM PUBLIC;

-- The sweep's fault functions: the watched row's tenant. Recording needs a watched row, which
-- the index always holds; clearing also follows a settle, when the row is no longer watched,
-- so it falls back to the tenant the key names.
CREATE FUNCTION public.record_activity_track_sweep_fault(text,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer integer;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.record_activity_track_sweep_fault_in_tenant($1,$2);
  END IF;
  PERFORM set_config('app.athlete_id',coalesce(
    public.tenant_work_item_tenant('activity_track_object_ref:window',$1),''),true);
  answer:=public.record_activity_track_sweep_fault_in_tenant($1,$2);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.record_activity_track_sweep_fault(text,text) FROM PUBLIC;

CREATE FUNCTION public.record_course_thumbnail_sweep_fault(text,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer integer;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.record_course_thumbnail_sweep_fault_in_tenant($1,$2);
  END IF;
  PERFORM set_config('app.athlete_id',coalesce(
    public.tenant_work_item_tenant('course_thumbnail_object_ref:window',$1),''),true);
  answer:=public.record_course_thumbnail_sweep_fault_in_tenant($1,$2);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.record_course_thumbnail_sweep_fault(text,text) FROM PUBLIC;

CREATE FUNCTION public.clear_activity_track_sweep_fault(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.clear_activity_track_sweep_fault_in_tenant($1);
  END IF;
  PERFORM set_config('app.athlete_id',coalesce(
    public.tenant_work_item_tenant('activity_track_object_ref:window',$1),
    public.object_key_tenant($1),''),true);
  answer:=public.clear_activity_track_sweep_fault_in_tenant($1);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.clear_activity_track_sweep_fault(text) FROM PUBLIC;

CREATE FUNCTION public.clear_course_thumbnail_sweep_fault(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF public.owner_reads_every_tenant() THEN
    RETURN public.clear_course_thumbnail_sweep_fault_in_tenant($1);
  END IF;
  PERFORM set_config('app.athlete_id',coalesce(
    public.tenant_work_item_tenant('course_thumbnail_object_ref:window',$1),
    public.object_key_tenant($1),''),true);
  answer:=public.clear_course_thumbnail_sweep_fault_in_tenant($1);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.clear_course_thumbnail_sweep_fault(text) FROM PUBLIC;

-- EXECUTE moves from each renamed body to its public name: whoever could call the function
-- still can, and nobody can call a body directly.
DO $$ DECLARE target record; grantee_name text; BEGIN
  FOR target IN SELECT p.oid AS body,
      format('public.%I(%s)',left(p.proname::text,length(p.proname::text)-length('_in_tenant')),
        pg_get_function_identity_arguments(p.oid))::regprocedure AS wrapper
    FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname::text LIKE '%\_in\_tenant'
  LOOP
    FOR grantee_name IN SELECT pg_get_userbyid(a.grantee)
      FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=target.body AND a.grantee<>0 AND a.grantee<>p.proowner
        AND a.privilege_type='EXECUTE'
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',target.wrapper,grantee_name);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',target.body::regprocedure,grantee_name);
    END LOOP;
  END LOOP;
END $$;

-- 052's retarget, with the index's policy among the ones it points at the new owner.
CREATE OR REPLACE FUNCTION public.retarget_definer_policies() RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE target record;
DECLARE touched integer:=0;
BEGIN
  IF EXISTS(
    SELECT 1 FROM (VALUES('activity_track_reconcile_state'),('course_deletion'),('course_share'),
      ('course_share_rate'),('course_thumbnail_reconcile_state'),('object_scope_purge'),
      ('resource_derived_cleanup'),('resource_object_cleanup'),('routing_admission'),
      ('tenant_object_purge'),('tenant_work_index')) AS t(table_name)
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
      ('tenant_object_purge','tenant_object_purge_definer'),
      ('tenant_work_index','tenant_work_index_definer')) AS t(table_name,policy_name)
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
