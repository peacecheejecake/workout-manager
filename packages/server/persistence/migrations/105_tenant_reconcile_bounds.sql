-- Keep tenant-scoped reconciliation bounded under plain-owner FORCE RLS.
-- SQL-function generic plans could scan foreign rows through the global key index.
-- Preserve the global indexes, row policies, grants, caps and public tenant wrappers.
-- Each tenant query plans its fixed SQL against captured scalar parameters; planner
-- preferences apply only inside these functions and are restored on return.
CREATE INDEX activity_track_object_ref_tenant_watched
 ON public.activity_track_object_ref(athlete_id,storage_ref) WHERE settled_at IS NULL;
CREATE INDEX course_thumbnail_object_ref_tenant_watched
 ON public.course_thumbnail_object_ref(athlete_id,storage_ref) WHERE settled_at IS NULL;

CREATE OR REPLACE FUNCTION public.activity_track_reconcile_candidates(text,integer)
RETURNS TABLE(storage_ref text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
SET enable_seqscan=off
SET enable_bitmapscan=off AS $$
DECLARE captured_tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
  -- Retain the historical bypass-owner path, with the original global semantics.
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT r.storage_ref
      FROM public.activity_track_object_ref r
      WHERE r.settled_at IS NULL AND r.storage_ref>$1
      ORDER BY r.storage_ref LIMIT least(greatest($2,1),1000);
    RETURN;
  END IF;
  IF captured_tenant IS NULL THEN RETURN; END IF;
  -- Constant SQL, bound values only. FORCE RLS still validates the captured tenant.
  RETURN QUERY EXECUTE
    'SELECT r.storage_ref
     FROM public.activity_track_object_ref r
     WHERE r.settled_at IS NULL AND r.athlete_id=$1 AND r.storage_ref>$2
     ORDER BY r.storage_ref LIMIT least(greatest($3,1),1000)'
    USING captured_tenant,$1,$2;
END $$;

CREATE OR REPLACE FUNCTION public.activity_track_reconcile_window_in_tenant(text,integer)
RETURNS TABLE(storage_ref text,sweep_attempts integer,deferred boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
SET enable_seqscan=off
SET enable_bitmapscan=off AS $$
DECLARE captured_tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
  -- Retain the historical bypass-owner path, with the original global semantics.
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT r.storage_ref,r.sweep_attempts,coalesce(r.sweep_retry_at>clock_timestamp(),false)
      FROM public.activity_track_object_ref r
      WHERE r.settled_at IS NULL AND r.storage_ref>$1
      ORDER BY r.storage_ref LIMIT least(greatest($2,1),1000);
    RETURN;
  END IF;
  IF captured_tenant IS NULL THEN RETURN; END IF;
  -- Constant SQL, bound values only. FORCE RLS still validates the captured tenant.
  RETURN QUERY EXECUTE
    'SELECT r.storage_ref,r.sweep_attempts,coalesce(r.sweep_retry_at>clock_timestamp(),false)
     FROM public.activity_track_object_ref r
     WHERE r.settled_at IS NULL AND r.athlete_id=$1 AND r.storage_ref>$2
     ORDER BY r.storage_ref LIMIT least(greatest($3,1),1000)'
    USING captured_tenant,$1,$2;
END $$;

CREATE OR REPLACE FUNCTION public.course_thumbnail_reconcile_candidates(text,integer)
RETURNS TABLE(storage_ref text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
SET enable_seqscan=off
SET enable_bitmapscan=off AS $$
DECLARE captured_tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
  -- Retain the historical bypass-owner path, with the original global semantics.
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT r.storage_ref
      FROM public.course_thumbnail_object_ref r
      WHERE r.settled_at IS NULL AND r.storage_ref>$1
      ORDER BY r.storage_ref LIMIT least(greatest($2,1),1000);
    RETURN;
  END IF;
  IF captured_tenant IS NULL THEN RETURN; END IF;
  -- Constant SQL, bound values only. FORCE RLS still validates the captured tenant.
  RETURN QUERY EXECUTE
    'SELECT r.storage_ref
     FROM public.course_thumbnail_object_ref r
     WHERE r.settled_at IS NULL AND r.athlete_id=$1 AND r.storage_ref>$2
     ORDER BY r.storage_ref LIMIT least(greatest($3,1),1000)'
    USING captured_tenant,$1,$2;
END $$;

CREATE OR REPLACE FUNCTION public.course_thumbnail_reconcile_window_in_tenant(text,integer)
RETURNS TABLE(storage_ref text,sweep_attempts integer,deferred boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
SET enable_seqscan=off
SET enable_bitmapscan=off AS $$
DECLARE captured_tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
  -- Retain the historical bypass-owner path, with the original global semantics.
  IF public.owner_reads_every_tenant() THEN
    RETURN QUERY SELECT r.storage_ref,r.sweep_attempts,coalesce(r.sweep_retry_at>clock_timestamp(),false)
      FROM public.course_thumbnail_object_ref r
      WHERE r.settled_at IS NULL AND r.storage_ref>$1
      ORDER BY r.storage_ref LIMIT least(greatest($2,1),1000);
    RETURN;
  END IF;
  IF captured_tenant IS NULL THEN RETURN; END IF;
  -- Constant SQL, bound values only. FORCE RLS still validates the captured tenant.
  RETURN QUERY EXECUTE
    'SELECT r.storage_ref,r.sweep_attempts,coalesce(r.sweep_retry_at>clock_timestamp(),false)
     FROM public.course_thumbnail_object_ref r
     WHERE r.settled_at IS NULL AND r.athlete_id=$1 AND r.storage_ref>$2
     ORDER BY r.storage_ref LIMIT least(greatest($3,1),1000)'
    USING captured_tenant,$1,$2;
END $$;
