-- M2-01at: the object-prefix purges (044–046) work when the migration owner is neither superuser
-- nor BYPASSRLS.
--
-- Both purge tables are FORCE ROW LEVEL SECURITY with no policy at all. The owner's definer
-- functions — `erase_account` (arms the tenant purge), the tombstone and reclamation triggers,
-- `delete_course` (arm the scope purge), and the worker's leases and finishes — are the only
-- things that touch them, and a superuser owner sees through FORCE. Every test cluster's owner
-- is a superuser, so nothing showed. On a plain owner, measured on PostgreSQL 14 with the whole
-- schema built by such a role (`object-purge-plain-owner.integration.test.ts`):
--   * `erase_account` fails: its arming INSERT is refused by RLS (42501), and the whole erasure
--     rolls back. Deleting an activity or a course fails the same way on `object_scope_purge`.
--   * Both leases see no row, so nothing is ever purged. `lease_tenant_object_purge` also reads
--     `tenant_erasure` with no tenant set, and `lease_object_scope_purge` reads
--     `activity_canonical` and `course` with no tenant set: under their tenant policies those
--     reads see nothing either. For the scope lease that is the dangerous half — its refusal of
--     a live activity or an available course is "NOT EXISTS (live row)", which is TRUE when the
--     live row is merely invisible. Making the queue visible without fixing that read would
--     lease a live owner's directory. So both halves change together.
--   * 044's and 046's backfills ran as that owner and saw no erased tenant, deleted activity or
--     unavailable course: nothing was armed for them.
--
-- What changes:
--   1. Each purge table gets one policy for the migrating role only (`TO current_user`, 047's,
--      049's and 050's precedent for a table only the owner's functions touch). No runtime or
--      worker role holds any privilege on either table (the upgrade test checks), so the policy
--      widens nothing but what the owner's own purge functions see — which is the point.
--   2. No policy is added to `tenant_erasure`, `activity_canonical` or `course`: an owner-wide
--      policy there would widen what every other definer function of that owner sees. The two
--      leases ask their questions through the existing tenant policies instead, per row, with
--      the row's own tenant named for that one statement and the caller's setting put back at
--      once — exactly what 050's `read_course_share` does. Two small helpers do that; they are
--      not definer functions, granted to no one, and reached only from the leases.
--   3. The leases are replaced in place (so the worker's EXECUTE grant survives and no grant
--      helper has to run again). Their bodies are 045's and 046's with only those reads changed,
--      and the search path now ends in pg_temp as 049/050's functions do.
--   4. The backfills are repeated for what is still unarmed: an erased tenant, a deleted activity
--      or an unavailable course that has no purge row at all. To read across tenants the
--      migration lifts FORCE on the three tables it reads, as their owner, for these two
--      statements only, and puts it back before it ends (the whole migration is one
--      transaction). On a superuser-owned database every such row already has a purge row, so
--      this arms nothing there.
--
-- Unchanged: the finish functions, `erase_account` and its chain, the arming function and the
-- triggers — once the policy exists, their writes go through. The refusals keep their meaning
-- and their labels.
--
-- Lock order. The helpers take no lock. The leases still lock purge rows only (FOR UPDATE SKIP
-- LOCKED) and read everything else without a lock, so erasure's 77206 → 0 → rows → purge row
-- gains no edge back. The backfill runs at migration time under the migration's own lock.
--
-- Not fixed here, and reported (M2-01at progress §5): the same FORCE-without-policy shape on
-- `resource_object_cleanup`, `resource_derived_cleanup` and the two reconcile-state tables, and
-- cross-tenant reads in the queue, sweep, thumbnail and URL-ingestion workers. On a plain owner
-- those still fail — closed (they refuse or see nothing), except that a policy added there
-- without per-row tenant reads would open `authorize_resource_object_cleanup`'s liveness checks,
-- which is why that is its own change.

DO $$ BEGIN
  EXECUTE format('CREATE POLICY tenant_object_purge_definer ON tenant_object_purge TO %I '
    'USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY object_scope_purge_definer ON object_scope_purge TO %I '
    'USING (true) WITH CHECK (true)', current_user);
END $$;

-- Is this tenant erased? Asked through 005's tenant policy with the tenant named for this one
-- statement; the caller's setting is put back before returning.
CREATE FUNCTION public.object_purge_tenant_erased(text) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  PERFORM set_config('app.athlete_id',$1,true);
  answer:=EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1);
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.object_purge_tenant_erased(text) FROM PUBLIC;

-- Is this scope's owner live — the activity present and not deleted, the course present and
-- available? Asked through the tables' tenant policies the same way. An unknown kind is an
-- error, not an answer (the table's CHECK already rules it out).
CREATE FUNCTION public.object_purge_scope_live(text,text,uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE answer boolean;
BEGIN
  IF $2 IS DISTINCT FROM 'activity' AND $2 IS DISTINCT FROM 'course' THEN
    RAISE EXCEPTION 'INVALID_OBJECT_SCOPE';
  END IF;
  PERFORM set_config('app.athlete_id',$1,true);
  IF $2='activity' THEN
    answer:=EXISTS(SELECT 1 FROM public.activity_canonical c
      WHERE c.athlete_id=$1 AND c.id=$3 AND NOT c.deleted);
  ELSE
    answer:=EXISTS(SELECT 1 FROM public.course c
      WHERE c.athlete_id=$1 AND c.course_id=$3 AND c.status='available');
  END IF;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.object_purge_scope_live(text,text,uuid) FROM PUBLIC;

-- 045's lease; only the erasure read changed.
CREATE OR REPLACE FUNCTION public.lease_tenant_object_purge(uuid,timestamptz,timestamptz)
RETURNS TABLE(athlete_id text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE lease_duration interval:=$3-$2;
BEGIN
  IF lease_duration<=interval '0 seconds' OR lease_duration>interval '5 minutes'
  THEN RAISE EXCEPTION 'INVALID_PURGE_LEASE'; END IF;
  -- The last attempt's lease ran out before it finished: dead-letter it, labelled.
  UPDATE public.tenant_object_purge q SET last_error_code='DEAD_LETTER:LEASE_EXPIRED',
    lease_owner=NULL,lease_until=NULL
  WHERE q.athlete_id IN (
    SELECT p.athlete_id FROM public.tenant_object_purge p
    WHERE p.completed_at IS NULL AND p.attempts>=100 AND p.lease_owner IS NOT NULL
      AND p.lease_until<=database_now
    ORDER BY p.athlete_id FOR UPDATE SKIP LOCKED LIMIT 100);
  -- A row the lease below refuses because its tenant still has an account: say so, once.
  -- Not leased, not charged, nothing deleted.
  UPDATE public.tenant_object_purge q
    SET last_error_code='INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT'
  WHERE q.athlete_id IN (
    SELECT p.athlete_id FROM public.tenant_object_purge p
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND p.last_error_code IS DISTINCT FROM 'INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT'
      AND EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=p.athlete_id)
    ORDER BY p.available_at,p.athlete_id FOR UPDATE SKIP LOCKED LIMIT 100);
  RETURN QUERY WITH candidate AS (
    SELECT p.athlete_id FROM public.tenant_object_purge p
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND public.object_purge_tenant_erased(p.athlete_id)
      AND NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=p.athlete_id)
    ORDER BY p.available_at,p.athlete_id FOR UPDATE OF p SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE public.tenant_object_purge q SET lease_owner=$1,lease_until=database_now+lease_duration,
      attempts=q.attempts+1,
      -- Taking over an expired lease: the attempt that held it was lost, and says so.
      last_error_code=CASE WHEN q.lease_owner IS NOT NULL THEN 'LEASE_EXPIRED'
        ELSE q.last_error_code END
    FROM candidate c WHERE q.athlete_id=c.athlete_id RETURNING q.athlete_id,q.attempts
  ) SELECT * FROM changed;
END $$;
REVOKE ALL ON FUNCTION public.lease_tenant_object_purge(uuid,timestamptz,timestamptz) FROM PUBLIC;

-- 046's lease; only the two liveness reads changed.
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
  -- charged, nothing deleted.
  UPDATE public.object_scope_purge q SET last_error_code=CASE q.scope_kind
      WHEN 'activity' THEN 'INCONSISTENT_LEDGER:ACTIVITY_LIVE'
      ELSE 'INCONSISTENT_LEDGER:COURSE_AVAILABLE' END
  WHERE (q.athlete_id,q.scope_kind,q.scope_id) IN (
    SELECT p.athlete_id,p.scope_kind,p.scope_id FROM public.object_scope_purge p
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND NOT coalesce(starts_with(p.last_error_code,'INCONSISTENT_LEDGER:'),false)
      AND public.object_purge_scope_live(p.athlete_id,p.scope_kind,p.scope_id)
    ORDER BY p.available_at,p.athlete_id,p.scope_kind,p.scope_id FOR UPDATE SKIP LOCKED LIMIT 100);
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

-- The backfills again, for what is still unarmed. FORCE is lifted only while these two
-- statements read, by the tables' owner, and put back before the migration commits.
ALTER TABLE tenant_erasure NO FORCE ROW LEVEL SECURITY;
ALTER TABLE activity_canonical NO FORCE ROW LEVEL SECURITY;
ALTER TABLE course NO FORCE ROW LEVEL SECURITY;
INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
  SELECT e.athlete_id,clock_timestamp(),clock_timestamp() FROM tenant_erasure e
  WHERE e.athlete_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND NOT EXISTS(SELECT 1 FROM tenant_object_purge p WHERE p.athlete_id=e.athlete_id);
INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
  SELECT c.athlete_id,'activity',c.id,clock_timestamp(),clock_timestamp()
  FROM activity_canonical c
  WHERE c.deleted
    AND c.athlete_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND c.id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND NOT EXISTS(SELECT 1 FROM object_scope_purge p
      WHERE p.athlete_id=c.athlete_id AND p.scope_kind='activity' AND p.scope_id=c.id)
  UNION ALL
  SELECT o.athlete_id,'course',o.course_id,clock_timestamp(),clock_timestamp()
  FROM course o
  WHERE o.status='unavailable'
    AND o.athlete_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND o.course_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND NOT EXISTS(SELECT 1 FROM object_scope_purge p
      WHERE p.athlete_id=o.athlete_id AND p.scope_kind='course' AND p.scope_id=o.course_id);
ALTER TABLE tenant_erasure FORCE ROW LEVEL SECURITY;
ALTER TABLE activity_canonical FORCE ROW LEVEL SECURITY;
ALTER TABLE course FORCE ROW LEVEL SECURITY;
