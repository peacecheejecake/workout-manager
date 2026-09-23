-- M2-01n isolates a reconciliation sweep's failures to the one reference that raised them.
--
-- The two sweeps (M2-01c's track sweep, 033; M2-01m's thumbnail sweep, 039) read one bounded
-- keyset window of watched references per run and `stat` each one. A reference whose `stat`
-- always raises — a directory the worker cannot read (EACCES), a symbolic link planted on the
-- watched path (`UnsafeStoragePathError`, the symlink guard firing) — used to end the whole
-- run at that reference, every run. Reproduced on real PostgreSQL and a real filesystem before
-- this migration was written, and the reproduction is an integration test
-- (`reconcile-sweep-faults.integration.test.ts`):
--
--   the window never finishes, so the cursor is never advanced and the next run reads the
--   same window and fails at the same reference; every reference sorting after it in that
--   window is never examined again, so an orphan behind it is never reclaimed; and because
--   the run ends there, the five history prunes that follow the sweep in the worker are
--   skipped on every tick.
--
-- The worker deliberately has no `catch` around the sweep (M2-01m, fixed by a unit test):
-- turning a store error into "swept, nothing found" is treating an error as a known outcome.
-- This migration keeps that. What changes is that a per-reference store error now has
-- somewhere durable to go: it is recorded against that one reference, with its code, its
-- attempt count and when it may be tried next, and the sweep moves on to the next reference.
-- The error is not swallowed — it is written down where an operator can see it, it is
-- reported in the run's outcome, and if it cannot be written down the original error still
-- ends the run. Failures that are not about one reference (the database, the window read, the
-- cursor) still end the run exactly as before.
--
-- A recorded fault never settles and never reclaims anything (plan section 7, no
-- over-deletion). The object behind a faulting reference may be a live picture or a live
-- track; nothing here can tell, which is exactly why nothing here acts on it. The reference
-- stays watched (`settled_at` untouched), stays in the window, and is retried on a capped
-- backoff; the only functions that settle or reclaim are the existing ones, and the sweep
-- reaches them only after a `stat` that answered.

-- The fault is kept on the index row itself rather than in a table of its own. The index row
-- is exactly one per reference, is already behind forced row-level security, is already
-- removed by account erasure, and is the row the sweep reads anyway — so a separate table
-- would add a second place to erase, a foreign key to lock through, and a join to the window.
ALTER TABLE activity_track_object_ref
  ADD COLUMN sweep_attempts integer NOT NULL DEFAULT 0 CHECK (sweep_attempts>=0),
  ADD COLUMN sweep_error_code text
    CHECK (sweep_error_code IS NULL OR length(sweep_error_code) BETWEEN 1 AND 100),
  ADD COLUMN sweep_first_failed_at timestamptz,
  ADD COLUMN sweep_failed_at timestamptz,
  ADD COLUMN sweep_retry_at timestamptz,
  ADD CONSTRAINT activity_track_object_ref_sweep_fault CHECK (
    (sweep_attempts=0)=(sweep_error_code IS NULL)
    AND (sweep_attempts=0)=(sweep_first_failed_at IS NULL)
    AND (sweep_attempts=0)=(sweep_failed_at IS NULL)
    AND (sweep_attempts=0)=(sweep_retry_at IS NULL)
    AND (sweep_failed_at IS NULL OR sweep_failed_at>=sweep_first_failed_at)
    AND (sweep_retry_at IS NULL OR sweep_retry_at>sweep_failed_at));
ALTER TABLE course_thumbnail_object_ref
  ADD COLUMN sweep_attempts integer NOT NULL DEFAULT 0 CHECK (sweep_attempts>=0),
  ADD COLUMN sweep_error_code text
    CHECK (sweep_error_code IS NULL OR length(sweep_error_code) BETWEEN 1 AND 100),
  ADD COLUMN sweep_first_failed_at timestamptz,
  ADD COLUMN sweep_failed_at timestamptz,
  ADD COLUMN sweep_retry_at timestamptz,
  ADD CONSTRAINT course_thumbnail_object_ref_sweep_fault CHECK (
    (sweep_attempts=0)=(sweep_error_code IS NULL)
    AND (sweep_attempts=0)=(sweep_first_failed_at IS NULL)
    AND (sweep_attempts=0)=(sweep_failed_at IS NULL)
    AND (sweep_attempts=0)=(sweep_retry_at IS NULL)
    AND (sweep_failed_at IS NULL OR sweep_failed_at>=sweep_first_failed_at)
    AND (sweep_retry_at IS NULL OR sweep_retry_at>sweep_failed_at));

-- The window, now carrying each reference's fault state.
--
-- A new function rather than `CREATE OR REPLACE` of the candidate functions: a function's
-- result columns cannot be changed in place, and 033 and 039 stay exactly as they were. The
-- plan is the same index range scan over the same partial index, reading exactly as many rows
-- as the window asks for. A reference that is waiting out its backoff is still RETURNED, as
-- `deferred`, rather than filtered out: filtering would let a run read past any number of
-- deferred rows to fill its window, and the bound is "N rows per run", not "N stats per run".
-- A deferred row costs its row read and nothing else — no `stat`, no statement.
--
-- `deferred` is decided on the database clock, like every other deadline in this lifecycle,
-- so no worker clock can bring a retry forward.
CREATE FUNCTION public.activity_track_reconcile_window(text,integer)
RETURNS TABLE(storage_ref text,sweep_attempts integer,deferred boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT r.storage_ref,r.sweep_attempts,coalesce(r.sweep_retry_at>clock_timestamp(),false)
  FROM public.activity_track_object_ref r
  WHERE r.settled_at IS NULL AND r.storage_ref>$1
  ORDER BY r.storage_ref LIMIT least(greatest($2,1),1000);
$$;
REVOKE ALL ON FUNCTION public.activity_track_reconcile_window(text,integer) FROM PUBLIC;

CREATE FUNCTION public.course_thumbnail_reconcile_window(text,integer)
RETURNS TABLE(storage_ref text,sweep_attempts integer,deferred boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT r.storage_ref,r.sweep_attempts,coalesce(r.sweep_retry_at>clock_timestamp(),false)
  FROM public.course_thumbnail_object_ref r
  WHERE r.settled_at IS NULL AND r.storage_ref>$1
  ORDER BY r.storage_ref LIMIT least(greatest($2,1),1000);
$$;
REVOKE ALL ON FUNCTION public.course_thumbnail_reconcile_window(text,integer) FROM PUBLIC;

-- Record that one watched reference's `stat` raised, and when it may be tried again.
--
-- Backoff: one minute, doubling per consecutive failure, capped at one day — so a reference
-- that fails for good costs one `stat` a day, and one that failed for a moment (a permission
-- fixed, a stray link removed) is examined again within minutes. From the tenth consecutive
-- failure the code carries the `DEAD_LETTER:` prefix the cleanup queue already uses (028), so
-- an operator finds both kinds of stuck work with one query. Unlike a queue item, a
-- dead-lettered reference is NOT taken out of rotation: retrying it costs one read-only `stat`
-- a day and can never delete anything, while taking it out would leave an orphan behind a
-- transient fault unreclaimed for good.
--
-- Only a reference that is still watched and due is counted. A reference a concurrent sweep
-- already recorded inside the current backoff reports its existing count without adding one,
-- so two workers on one window cannot double the backoff. NULL means there is no watched row
-- to record against — erased, or settled by a concurrent sweep — and the caller then lets the
-- original error end its run instead of claiming it was recorded.
--
-- The code is validated rather than trusted: upper-case identifier characters only, so no
-- message text, path or tenant data can be written here by a caller.
--
-- Locking: one statement, one row, no advisory lock. It waits at most once — for that row —
-- and holds nothing while it waits, so it cannot close a cycle with any writer, including
-- `erase_account`'s `77206` → `0` → rows order, whatever that writer holds.
CREATE FUNCTION public.record_activity_track_sweep_fault(text,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE recorded integer;
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_SWEEP_FAULT_REF';
  END IF;
  IF $2 IS NULL OR $2 !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'INVALID_SWEEP_FAULT_CODE';
  END IF;
  UPDATE public.activity_track_object_ref r SET
    sweep_attempts=r.sweep_attempts+1,
    sweep_error_code=CASE WHEN r.sweep_attempts+1>=10 THEN 'DEAD_LETTER:'||$2 ELSE $2 END,
    sweep_first_failed_at=coalesce(r.sweep_first_failed_at,database_now),
    sweep_failed_at=database_now,
    sweep_retry_at=database_now+least(interval '1 minute'*power(2,least(r.sweep_attempts,11)),
      interval '1 day')
  WHERE r.storage_ref=$1 AND r.settled_at IS NULL
    AND (r.sweep_retry_at IS NULL OR r.sweep_retry_at<=database_now)
  RETURNING r.sweep_attempts INTO recorded;
  IF recorded IS NULL THEN
    SELECT r.sweep_attempts INTO recorded FROM public.activity_track_object_ref r
    WHERE r.storage_ref=$1 AND r.settled_at IS NULL AND r.sweep_attempts>0;
  END IF;
  RETURN recorded;
END $$;
REVOKE ALL ON FUNCTION public.record_activity_track_sweep_fault(text,text) FROM PUBLIC;

CREATE FUNCTION public.record_course_thumbnail_sweep_fault(text,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE recorded integer;
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_SWEEP_FAULT_REF';
  END IF;
  IF $2 IS NULL OR $2 !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'INVALID_SWEEP_FAULT_CODE';
  END IF;
  UPDATE public.course_thumbnail_object_ref r SET
    sweep_attempts=r.sweep_attempts+1,
    sweep_error_code=CASE WHEN r.sweep_attempts+1>=10 THEN 'DEAD_LETTER:'||$2 ELSE $2 END,
    sweep_first_failed_at=coalesce(r.sweep_first_failed_at,database_now),
    sweep_failed_at=database_now,
    sweep_retry_at=database_now+least(interval '1 minute'*power(2,least(r.sweep_attempts,11)),
      interval '1 day')
  WHERE r.storage_ref=$1 AND r.settled_at IS NULL
    AND (r.sweep_retry_at IS NULL OR r.sweep_retry_at<=database_now)
  RETURNING r.sweep_attempts INTO recorded;
  IF recorded IS NULL THEN
    SELECT r.sweep_attempts INTO recorded FROM public.course_thumbnail_object_ref r
    WHERE r.storage_ref=$1 AND r.settled_at IS NULL AND r.sweep_attempts>0;
  END IF;
  RETURN recorded;
END $$;
REVOKE ALL ON FUNCTION public.record_course_thumbnail_sweep_fault(text,text) FROM PUBLIC;

-- Forget a reference's fault once its `stat` answers again. Called by the sweep only after
-- the answer has been acted on through the existing settle or reclaim function, so clearing
-- the record never decides anything by itself. It applies whether or not that call settled
-- the row. Same locking shape as recording: one row, one statement.
CREATE FUNCTION public.clear_activity_track_sweep_fault(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_SWEEP_FAULT_REF';
  END IF;
  UPDATE public.activity_track_object_ref r SET sweep_attempts=0,sweep_error_code=NULL,
    sweep_first_failed_at=NULL,sweep_failed_at=NULL,sweep_retry_at=NULL
  WHERE r.storage_ref=$1 AND r.sweep_attempts>0;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.clear_activity_track_sweep_fault(text) FROM PUBLIC;

CREATE FUNCTION public.clear_course_thumbnail_sweep_fault(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_SWEEP_FAULT_REF';
  END IF;
  UPDATE public.course_thumbnail_object_ref r SET sweep_attempts=0,sweep_error_code=NULL,
    sweep_first_failed_at=NULL,sweep_failed_at=NULL,sweep_retry_at=NULL
  WHERE r.storage_ref=$1 AND r.sweep_attempts>0;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.clear_course_thumbnail_sweep_fault(text) FROM PUBLIC;

-- The sweep no longer calls the two candidate functions, so nobody keeps EXECUTE on them.
-- They are left in place, unchanged, rather than dropped: 033 and 039 are not edited, and a
-- worker still running the previous build against this schema fails loudly with a permission
-- error instead of sweeping without fault isolation.
DO $$ DECLARE target regprocedure; role_name text; BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.activity_track_reconcile_candidates(text,integer)'::regprocedure,
    'public.course_thumbnail_reconcile_candidates(text,integer)'::regprocedure]
  LOOP
    FOR role_name IN SELECT pg_get_userbyid(a.grantee)
      FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=target AND a.grantee<>0 AND a.grantee<>p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',target,role_name); END LOOP;
  END LOOP;
END $$;

-- The runtime role records track references itself (M2-01c), and was granted INSERT on the
-- whole of `activity_track_object_ref` to do it. A whole-row INSERT reaches every column,
-- including the fault columns above — a tenant could insert its own reference already
-- deferred for a century and hide it from the sweep — and `settled_at`, which could already
-- hide one before this migration. Recording needs `storage_ref`, `athlete_id` and
-- `recorded_at`, so that is what every holder of the table-level grant keeps.
--
-- Narrowing the grant helper alone would not reach an existing database: a table-level grant
-- already given stays until it is revoked. Revoking table-level INSERT also revokes the
-- column-level INSERT privileges, so the column grant is given back afterwards, to exactly the
-- roles that held the table-level one. `course_thumbnail_object_ref` has no grant to anyone
-- (039) and needs nothing here.
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
    FROM pg_class c,LATERAL aclexplode(c.relacl) a
    WHERE c.oid='public.activity_track_object_ref'::regclass AND a.privilege_type='INSERT'
      AND a.grantee<>0 AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('REVOKE INSERT ON public.activity_track_object_ref FROM %I',role_name);
    EXECUTE format(
      'GRANT INSERT(storage_ref,athlete_id,recorded_at) ON public.activity_track_object_ref TO %I',
      role_name);
  END LOOP;
END $$;
