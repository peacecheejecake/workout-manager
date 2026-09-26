-- Preserve the frozen share snapshot while crediting OSM on legacy computed links.
CREATE OR REPLACE FUNCTION public.read_course_share(text,integer,text,integer,integer,integer)
RETURNS TABLE(outcome text,snapshot jsonb,include_names boolean,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE minute_start timestamptz:=date_trunc('minute',clock_timestamp());
DECLARE hour_start timestamptz:=date_trunc('hour',clock_timestamp());
DECLARE client_hits integer;
DECLARE failures integer;
DECLARE share_hits integer;
DECLARE found_share public.course_share%ROWTYPE;
DECLARE caller_tenant text;
DECLARE source_generation jsonb;
DECLARE tenant_erased boolean:=false;
BEGIN
  IF $2 IS NULL OR $2 NOT BETWEEN 1 AND 2147483646
    OR $3 IS NULL OR $3 !~ '^[a-f0-9]{64}$'
    OR $4 IS NULL OR $4 NOT BETWEEN 1 AND 10000
    OR $5 IS NULL OR $5 NOT BETWEEN 1 AND 10000
    OR $6 IS NULL OR $6 NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'INVALID_SHARE_READ';
  END IF;
  -- Housekeeping, bounded: counters older than two hours (B-4) and expired links.
  DELETE FROM public.course_share_rate r WHERE (r.bucket,r.window_start) IN (
    SELECT g.bucket,g.window_start FROM public.course_share_rate g
    WHERE g.window_start<database_now-interval '2 hours'
    ORDER BY g.window_start LIMIT 200 FOR UPDATE SKIP LOCKED);
  PERFORM public.reap_course_shares(50);
  -- Every read counts against its client, found or not.
  INSERT INTO public.course_share_rate(bucket,window_start,hits) VALUES ('c:'||$3,minute_start,1)
    ON CONFLICT (bucket,window_start) DO UPDATE SET hits=public.course_share_rate.hits+1
    RETURNING hits INTO client_hits;
  SELECT r.hits INTO failures FROM public.course_share_rate r
    WHERE r.bucket='f:'||$3 AND r.window_start=hour_start;
  IF client_hits>$4 OR coalesce(failures,0)>=$6 THEN
    INSERT INTO public.course_share_rate(bucket,window_start,hits) VALUES ('f:'||$3,hour_start,1)
      ON CONFLICT (bucket,window_start) DO UPDATE SET hits=public.course_share_rate.hits+1;
    RETURN QUERY SELECT 'limited'::text,NULL::jsonb,NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;
  -- One index lookup on the digest. Every condition below is checked on the row it found.
  SELECT s.* INTO found_share FROM public.course_share s WHERE s.token_digest=$1;
  IF FOUND THEN
    -- Erased? Asked through 005's tenant policy on `tenant_erasure`, with the link's own tenant
    -- named for this one statement and the caller's setting put back at once, so the answer
    -- does not depend on the owner being superuser or BYPASSRLS and no wider policy exists.
    caller_tenant:=current_setting('app.athlete_id',true);
    PERFORM set_config('app.athlete_id',found_share.athlete_id,true);
    tenant_erased:=EXISTS(SELECT 1 FROM public.tenant_erasure e
      WHERE e.athlete_id=found_share.athlete_id);
    PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  END IF;
  IF found_share.share_id IS NULL
    OR found_share.state<>'active'
    OR found_share.expires_at<=database_now
    OR found_share.epoch<>$2
    -- The configuration went backwards (a restore without an epoch increase, then a new link
    -- under the higher epoch, then a rollback): serve nothing at all.
    OR EXISTS(SELECT 1 FROM public.course_share h WHERE h.epoch>$2)
    OR tenant_erased
  THEN
    INSERT INTO public.course_share_rate(bucket,window_start,hits) VALUES ('f:'||$3,hour_start,1)
      ON CONFLICT (bucket,window_start) DO UPDATE SET hits=public.course_share_rate.hits+1;
    RETURN QUERY SELECT 'not_found'::text,NULL::jsonb,NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;
  -- Counted only for a read that matched a link, and keyed by the link (R-5): an unknown
  -- digest creates no row here.
  INSERT INTO public.course_share_rate(bucket,window_start,hits)
    VALUES ('s:'||replace(found_share.share_id::text,'-',''),minute_start,1)
    ON CONFLICT (bucket,window_start) DO UPDATE SET hits=public.course_share_rate.hits+1
    RETURNING hits INTO share_hits;
  IF share_hits>$5 THEN
    RETURN QUERY SELECT 'limited'::text,NULL::jsonb,NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;
  -- Historical frozen snapshots predate the route-data notice. Read only the exact
  -- immutable source revision, never the current head, and add only the notice bit to
  -- this response. The stored snapshot remains byte-for-byte unchanged.
  IF NOT found_share.snapshot ? 'routeDataNotice' THEN
    caller_tenant:=current_setting('app.athlete_id',true);
    PERFORM set_config('app.athlete_id',found_share.athlete_id,true);
    SELECT r.generation INTO source_generation FROM public.course_revision r
      WHERE r.athlete_id=found_share.athlete_id AND r.course_id=found_share.course_id
        AND r.course_revision=found_share.course_revision;
    PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
    -- A missing or unrecognized source must not be guessed or served without provenance.
    IF source_generation IS NULL OR coalesce(source_generation->>'kind','') NOT IN
      ('recorded-segment','imported-file','privacy-trimmed','routed-waypoints',
       'target-distance-loop') THEN
      RETURN QUERY SELECT 'not_found'::text,NULL::jsonb,NULL::boolean,NULL::timestamptz;
      RETURN;
    END IF;
    IF source_generation->>'kind' IN ('routed-waypoints','target-distance-loop')
      OR (source_generation->>'kind'='privacy-trimmed'
        AND source_generation->>'sourceGraphBuildId' IS NOT NULL) THEN
      found_share.snapshot:=jsonb_set(found_share.snapshot,'{routeDataNotice}','true'::jsonb,true);
    END IF;
  END IF;
  RETURN QUERY SELECT 'ok'::text,found_share.snapshot,found_share.include_names,
    found_share.expires_at;
END $$;
