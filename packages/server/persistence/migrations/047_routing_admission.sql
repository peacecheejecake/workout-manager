-- M2-01ah: routing admission shared by every API instance, and a cap on the engine.
--
-- Until now the tenant bounds on route computation (two at once, twenty a minute) were
-- counted inside one API process, so a second instance doubled them, and nothing bounded the
-- engine's work summed over all tenants. M2-01k-e §1.4 chose the database as the shared
-- counter: it is the only shared state already operated. This table is that counter.
--
-- One row per admitted computation (a permit):
--   * `started_at` counts toward the tenant's rate window until it falls out of it;
--   * the permit HOLDS a concurrency slot (the tenant's and the engine's) while it is not
--     released and its `lease_until` has not passed.
-- The lease is what returns the permit of an instance that died mid-computation: nothing has
-- to notice the death, the slot stops counting when the lease runs out. The API sets the
-- lease to its deadline plus the engine's hard-stop grace plus a margin, so a live instance
-- always releases before its lease runs out.
--
-- Time is the database's clock (`clock_timestamp()`), never an instance's, so instances with
-- skewed clocks still agree on what is expired and what is inside the window.
--
-- Two short transactions per computation, and none across the engine call (AGENTS: no provider
-- call inside a DB transaction): `acquire_routing_permit` decides and inserts, and commits;
-- the engine runs; `release_routing_permit` marks the row released, and commits.
--
-- Serialisation. Every acquisition takes one transaction-scoped advisory lock, (77206, 47) in
-- the two-integer key space, so it cannot collide with the bigint keys `hashtextextended`
-- produces. Under it, the tenant and engine counts and the insert are one decision: two
-- instances cannot both see "one slot left" and both take it. The lock is held for a count
-- and an insert and is released at commit. Release does not take it: releasing only ever
-- frees capacity. Lock order is the repository's: the tenant transaction's account lock
-- (77206, shared), then this lock, then rows. Housekeeping skips rows another transaction
-- holds (`SKIP LOCKED`), so an acquisition never waits on an erasure's row locks.
--
-- Visibility. Row-level security is forced, as everywhere: the runtime role sees nothing
-- directly and has no table grant at all, only EXECUTE on the two functions. The engine cap
-- has to count every tenant's rows, so the functions are SECURITY DEFINER and the migrating
-- role gets its own policy below. Without it, an owner that is neither superuser nor
-- BYPASSRLS would see only the calling tenant's rows under FORCE, and the engine cap would
-- silently become a per-tenant cap.
--
-- Erasure deletes the tenant's rows (the wrapper at the end). They hold no health data — a
-- tenant id and three instants — but they are the tenant's usage, and they are erased with it.

CREATE TABLE routing_admission (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  permit_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (athlete_id,permit_id),
  CHECK (lease_until>started_at AND lease_until<=started_at+interval '10 minutes'),
  CHECK (released_at IS NULL OR released_at>=started_at)
);
-- The engine count: every permit that may still hold a slot.
CREATE INDEX routing_admission_held ON routing_admission(lease_until) WHERE released_at IS NULL;
-- The tenant's window, and housekeeping by age.
CREATE INDEX routing_admission_started ON routing_admission(started_at);

ALTER TABLE routing_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY routing_admission_tenant ON routing_admission
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
DO $$ BEGIN
  EXECUTE format('CREATE POLICY routing_admission_definer ON routing_admission TO %I '
    'USING (true) WITH CHECK (true)', current_user);
END $$;

-- Only the owner (the functions below) writes this table, whatever a future grant says.
CREATE FUNCTION routing_admission_writer_is_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF current_user=(SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                   WHERE c.oid=TG_RELID) THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'ROUTING_ADMISSION_NOT_WRITABLE';
END $$;
REVOKE ALL ON FUNCTION routing_admission_writer_is_owner() FROM PUBLIC;
CREATE TRIGGER routing_admission_writer BEFORE INSERT OR UPDATE OR DELETE ON routing_admission
  FOR EACH ROW EXECUTE FUNCTION routing_admission_writer_is_owner();

-- Every function here pins search_path to pg_catalog, then pg_temp last, so a temporary
-- object can never shadow a catalog or table name inside these bodies.

-- Take one permit for the calling tenant, or say why not.
--   $1 permit id (the caller's, so a release can name it)
--   $2 tenant concurrency   $3 tenant requests per window   $4 window, ms
--   $5 engine concurrency, over every tenant   $6 lease, ms
-- The tenant bounds are checked first (they are the tenant's own doing), then the engine cap.
-- `engine_in_flight` is the engine count the decision saw, for the operator's log line.
CREATE FUNCTION public.acquire_routing_permit(uuid,integer,integer,integer,integer,integer)
RETURNS TABLE(permit_granted boolean,refusal text,retry_after integer,engine_in_flight integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE database_now timestamptz;
DECLARE window_start timestamptz;
DECLARE tenant_held integer;
DECLARE tenant_started integer;
DECLARE oldest_start timestamptz;
DECLARE engine_held integer;
BEGIN
  IF tenant IS NULL OR $1 IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTING_PERMIT'; END IF;
  IF $2 IS NULL OR $2 NOT BETWEEN 1 AND 64
    OR $3 IS NULL OR $3 NOT BETWEEN 1 AND 10000
    OR $4 IS NULL OR $4 NOT BETWEEN 1000 AND 3600000
    OR $5 IS NULL OR $5 NOT BETWEEN 1 AND 1024
    OR $6 IS NULL OR $6 NOT BETWEEN 100 AND 600000
    -- Housekeeping below deletes rows that have left the window and hold nothing. The window
    -- must cover the lease, so no row can leave the window while its lease still holds.
    OR $4<$6 THEN
    RAISE EXCEPTION 'INVALID_ROUTING_ADMISSION_LIMITS';
  END IF;
  PERFORM pg_advisory_xact_lock(77206,47);
  -- Read after the lock, so it is never earlier than a decision that committed before us.
  database_now:=clock_timestamp();
  window_start:=database_now-$4*interval '1 millisecond';
  -- Housekeeping, bounded: a row that holds nothing and has left the window counts for
  -- nothing any more.
  DELETE FROM public.routing_admission r
    WHERE (r.athlete_id,r.permit_id) IN (
      SELECT g.athlete_id,g.permit_id FROM public.routing_admission g
      WHERE g.started_at<=window_start
        AND (g.released_at IS NOT NULL OR g.lease_until<=database_now)
      ORDER BY g.started_at LIMIT 500 FOR UPDATE SKIP LOCKED);
  SELECT count(*) FILTER (WHERE r.released_at IS NULL AND r.lease_until>database_now),
         count(*) FILTER (WHERE r.started_at>window_start),
         min(r.started_at) FILTER (WHERE r.started_at>window_start)
    INTO tenant_held,tenant_started,oldest_start
    FROM public.routing_admission r WHERE r.athlete_id=tenant;
  SELECT count(*) INTO engine_held FROM public.routing_admission r
    WHERE r.released_at IS NULL AND r.lease_until>database_now;
  IF tenant_held>=$2 THEN
    RETURN QUERY SELECT false,'concurrency'::text,1,engine_held;
    RETURN;
  END IF;
  IF tenant_started>=$3 THEN
    RETURN QUERY SELECT false,'rate'::text,
      greatest(1,ceil(extract(epoch FROM
        (oldest_start+$4*interval '1 millisecond'-database_now)))::integer),
      engine_held;
    RETURN;
  END IF;
  IF engine_held>=$5 THEN
    RETURN QUERY SELECT false,'engine_capacity'::text,1,engine_held;
    RETURN;
  END IF;
  INSERT INTO public.routing_admission(athlete_id,permit_id,started_at,lease_until)
    VALUES (tenant,$1,database_now,database_now+$6*interval '1 millisecond');
  RETURN QUERY SELECT true,NULL::text,0,engine_held+1;
END $$;
REVOKE ALL ON FUNCTION public.acquire_routing_permit(uuid,integer,integer,integer,integer,integer)
  FROM PUBLIC;

-- Return the calling tenant's permit. Idempotent: a second call finds nothing to release.
CREATE FUNCTION public.release_routing_permit(uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
BEGIN
  IF tenant IS NULL OR $1 IS NULL THEN RAISE EXCEPTION 'INVALID_ROUTING_PERMIT'; END IF;
  UPDATE public.routing_admission SET released_at=clock_timestamp()
    WHERE athlete_id=tenant AND permit_id=$1 AND released_at IS NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.release_routing_permit(uuid) FROM PUBLIC;

-- Erasure takes the tenant's permits with it. The account lock and the per-tenant command
-- lock come first (77206 → 0 → rows, re-entrant in the chain below), then this table's rows,
-- then the rest of the chain unchanged.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_routing_admission;
REVOKE ALL ON FUNCTION public.erase_account_before_routing_admission(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_routing_admission(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_routing_admission(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  DELETE FROM public.routing_admission WHERE athlete_id=$1;
  RETURN public.erase_account_before_routing_admission($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
