-- M2-01x: account erasure arms a purge of the tenant's whole object-storage prefix.
--
-- Every path by which erasure deletes objects is row-based. The ledger stages (033, 038) queue
-- the keys their rows name, 042 queues the keys the reference indexes watch, and the
-- reconciliation sweeps read those indexes. A key that no row names is invisible to all of
-- them. Backup makes that the ordinary case: the drill takes the database dump and THEN
-- copies the object archive, so an object uploaded between the two is in the archive and in
-- no row of the dump. After a restore, replaying the erasure of its owner deletes every row
-- and queues every named key, and that object stays forever. Reproduced on PostgreSQL 14 and
-- the real filesystem (drill check `gap_upload_…`; integration test `purges an object no row
-- names`).
--
-- What does name it is its key: every key is `private/v1/tenants/<tenant>/…`. So erasure arms
-- a durable purge of that prefix and a worker walks it — no database row involved.
--
-- When. Not at once and not once. A writer that was mid-publication when the account was
-- erased can still publish after the erasure commits; that is what the queue's fences and the
-- thirty-day `account_erased` re-arm exist for (028/029/033/038's `finish`). The purge takes
-- the same two rules:
--   * its first pass is due when the tenant's in-flight writers' fences have passed — read
--     before the chain deletes the rows that carry them, with the very expressions the queue
--     uses (038's erasure stage for renders, `finish`'s publication window for track uploads);
--   * after every complete pass it re-arms an hour later while it was armed less than thirty
--     days ago, exactly as an `account_erased` receipt does; the first complete pass after
--     that closes it. Every writer fence is bounded well inside that (a render's publication
--     lease by 24 hours, a track upload by its 24-hour expiry).
--
-- Where. Its own table, keyed by the tenant and tied to `tenant_erasure` by a foreign key, so
-- a purge row cannot exist for a tenant that was not erased. Not columns on `tenant_erasure`:
-- that ledger is runtime-readable under tenant RLS and is what the restore replays from; the
-- purge's lease and retry state belong to the worker, which has no table access at all.
--
-- Restore. Replaying the erasure ledger calls `erase_account` for every erased tenant, and
-- this link arms (or re-arms) the purge on every call, whether or not the tenant was already
-- erased in the dump. That is how the restored cluster purges what the archive brought back.
--
-- Which tenants. Only a canonical lowercase UUID names a key prefix; any other id owns no
-- objects and gets no purge row (the table's CHECK says so too). An id that is not in the
-- canonical form is never mapped onto one, so erasing some other spelling of a live tenant's
-- id can never arm a purge of that live tenant's directory.
--
-- Lock order. The account lock (77206), then the per-tenant command lock (0), then rows — the
-- repository's order, re-entrant here. The purge row is written after the whole chain, so the
-- only new edge is (every row the chain touches) → the purge row. The worker's functions lock
-- nothing but the purge row and read nothing under a lock, so no cycle through it exists. No
-- reference-index row is touched here: M2-01m's "the thumbnail index goes last" still holds.
CREATE TABLE tenant_object_purge (
  athlete_id text PRIMARY KEY REFERENCES tenant_erasure(athlete_id)
    CHECK (athlete_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  armed_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  passes integer NOT NULL DEFAULT 0 CHECK (passes>=0),
  objects_purged bigint NOT NULL DEFAULT 0 CHECK (objects_purged>=0),
  unrecognized_entries integer NOT NULL DEFAULT 0 CHECK (unrecognized_entries>=0),
  lease_owner uuid,
  lease_until timestamptz,
  last_pass_at timestamptz,
  completed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code)<=100),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (completed_at IS NULL OR lease_owner IS NULL)
);
CREATE INDEX tenant_object_purge_pending ON tenant_object_purge(available_at,athlete_id)
  WHERE completed_at IS NULL AND attempts<100;
ALTER TABLE tenant_object_purge ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_object_purge FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tenant_object_purge FROM PUBLIC;

-- Tenants erased before this migration get the same purge, due now. The hole is not new: an
-- earlier restore can already have brought back objects no row names, and nothing else will
-- ever look for them. A tenant with nothing stored costs a few `lstat`s per pass.
INSERT INTO tenant_object_purge(athlete_id,armed_at,available_at)
  SELECT e.athlete_id,clock_timestamp(),clock_timestamp() FROM tenant_erasure e
  WHERE e.athlete_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- One due purge, leased. Refuses — by not returning it — a row whose tenant still has an
-- identity account: an erased tenant has none (erasure deletes it and a retired id is never
-- issued again), so a live account under that id means something is wrong and nothing under
-- that prefix may be touched. The `tenant_erasure` join repeats what the foreign key already
-- guarantees.
CREATE FUNCTION public.lease_tenant_object_purge(uuid,timestamptz,timestamptz)
RETURNS TABLE(athlete_id text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE lease_duration interval:=$3-$2;
BEGIN
  IF lease_duration<=interval '0 seconds' OR lease_duration>interval '5 minutes'
  THEN RAISE EXCEPTION 'INVALID_PURGE_LEASE'; END IF;
  RETURN QUERY WITH candidate AS (
    SELECT p.athlete_id FROM public.tenant_object_purge p
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=p.athlete_id)
      AND NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=p.athlete_id)
    ORDER BY p.available_at,p.athlete_id FOR UPDATE OF p SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE public.tenant_object_purge q SET lease_owner=$1,lease_until=database_now+lease_duration,
      attempts=q.attempts+1
    FROM candidate c WHERE q.athlete_id=c.athlete_id RETURNING q.athlete_id,q.attempts
  ) SELECT * FROM changed;
END $$;
REVOKE ALL ON FUNCTION public.lease_tenant_object_purge(uuid,timestamptz,timestamptz) FROM PUBLIC;

-- The end of one leased run. `$3` ok, `$4` error code, `$5` objects deleted in this run, `$6`
-- unrecognized entries seen, `$7` whether the run stopped at its budget with more to do.
-- A run that stopped at its budget is due again at once and is not a pass. A complete pass
-- re-arms an hour later while the purge was armed less than thirty days ago — the rule an
-- `account_erased` receipt follows in `finish_resource_object_cleanup` — and closes the purge
-- otherwise. A failed run backs off as the queue does and dead-letters at 100 attempts.
CREATE FUNCTION public.finish_tenant_object_purge(text,uuid,boolean,text,integer,integer,boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $5 IS NULL OR $5<0 OR $6 IS NULL OR $6<0 OR $3 IS NULL OR $7 IS NULL
  THEN RAISE EXCEPTION 'INVALID_PURGE_OUTCOME'; END IF;
  UPDATE public.tenant_object_purge SET
    objects_purged=objects_purged+$5,
    unrecognized_entries=CASE WHEN $3 THEN $6 ELSE unrecognized_entries END,
    passes=CASE WHEN $3 AND NOT $7 THEN passes+1 ELSE passes END,
    last_pass_at=CASE WHEN $3 AND NOT $7 THEN database_now ELSE last_pass_at END,
    completed_at=CASE
      WHEN $3 AND NOT $7 AND NOT (armed_at>database_now-interval '30 days') THEN database_now
      ELSE NULL END,
    available_at=CASE
      WHEN $3 AND $7 THEN database_now
      WHEN $3 THEN database_now+interval '1 hour'
      ELSE database_now+least(attempts,10)*interval '30 seconds' END,
    attempts=CASE WHEN $3 THEN 0 ELSE attempts END,
    last_error_code=CASE
      WHEN $3 THEN NULL
      WHEN attempts>=100 THEN 'DEAD_LETTER:'||left(coalesce($4,'TENANT_PURGE_FAILED'),88)
      ELSE left(coalesce($4,'TENANT_PURGE_FAILED'),100) END,
    lease_owner=NULL,lease_until=NULL
  WHERE athlete_id=$1 AND lease_owner=$2 AND completed_at IS NULL AND lease_until>database_now;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_tenant_object_purge(text,uuid,boolean,text,integer,integer,boolean) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_tenant_object_purge;
REVOKE ALL ON FUNCTION public.erase_account_before_tenant_object_purge(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_tenant_object_purge(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_tenant_object_purge(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE erased_at timestamptz;
DECLARE writer_fence timestamptz;
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  -- The latest moment one of this tenant's writers could still publish, read (plain reads,
  -- no row locks) before the chain deletes the rows that record it.
  SELECT max(fences.fence) INTO writer_fence FROM (
    SELECT greatest(t.publication_lease_until+interval '1 hour',
      t.lease_until+interval '1 hour') AS fence
      FROM public.course_thumbnail t WHERE t.athlete_id=$1
    UNION ALL
    SELECT coalesce(i.publication_lease_until+interval '1 hour',i.expires_at) AS fence
      FROM public.activity_track_upload_intent i
      WHERE i.athlete_id=$1 AND i.state IN ('prepared','staged','failed')
  ) fences;
  erased_at:=public.erase_account_before_tenant_object_purge($1);
  IF $1 ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    INSERT INTO public.tenant_object_purge(athlete_id,armed_at,available_at)
      VALUES($1,clock_timestamp(),greatest(clock_timestamp(),writer_fence))
      ON CONFLICT(athlete_id) DO UPDATE SET armed_at=EXCLUDED.armed_at,
        -- Re-armed, never pulled earlier than an open purge was already due (M2-01s's rule).
        available_at=CASE WHEN public.tenant_object_purge.completed_at IS NULL
          THEN greatest(public.tenant_object_purge.available_at,EXCLUDED.available_at)
          ELSE EXCLUDED.available_at END,
        attempts=0,passes=0,lease_owner=NULL,lease_until=NULL,completed_at=NULL,
        last_error_code=NULL;
  END IF;
  RETURN erased_at;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
