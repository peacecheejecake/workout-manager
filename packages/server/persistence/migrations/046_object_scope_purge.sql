-- M2-01y: deleting an activity arms a purge of that activity's object-storage prefix, and of
-- the prefix of every course the deletion reclaims.
--
-- M2-01x closed this hole for an erased tenant; this is the same hole on a live one. The drill
-- takes the database dump and THEN copies the object archive, so whatever a live tenant stores
-- between the two is in the archive and in no row of the dump. When that tenant deletes the
-- activity after the backup, the restore replays the deletion: the tombstone trigger (033)
-- queues the track keys the restored rows name, the course reclamation (038) queues the
-- picture keys its rows name, the sweeps read their indexes — and the objects stored in the
-- gap stay forever, because no restored row names them, and the tenant is alive, so the
-- tenant purge (044) is never armed for it. Reproduced on PostgreSQL 14 and the real
-- filesystem for all three shapes (drill check `live_tenant_gap_uploads_survive_…`):
--   (a) the track of an activity that is in the dump, uploaded in the gap;
--   (b) an activity recorded and tracked entirely in the gap (the restored cluster has no
--       row for it at all);
--   (c) a new revision of a course cut from the deleted activity, drawn in the gap.
--
-- What does name those objects is their key. Every object of an activity is under
-- `private/v1/tenants/<tenant>/activities/<activity>/` (its track's three artifacts, temporary
-- and final — the only family written there), and every object of a course is under
-- `…/courses/<course>/` (its pictures). Deletion is terminal for both: a tombstoned activity is
-- never un-deleted (this migration makes the database refuse it), and an unavailable course
-- never becomes available again (034's transition trigger). So once one of them is gone,
-- nothing under its directory can ever be live again, and the whole directory may go.
--
-- When. Once, after the in-flight writers' fences — read with the very expressions 044 and the
-- queue use (a track upload's publication window; a render's publication and lease windows +1h).
-- Not re-armed for thirty days as a tenant purge is: 044 re-arms because an erased tenant has
-- fence-less writers (resource, gallery and URL uploads). Nothing without a fence writes under
-- an activity or a course: a track upload cannot even be reserved for a deleted activity (033's
-- ingestion trigger), and a render of an unavailable course is superseded with its lease
-- columns kept, so its fence is read here.
--
-- Arming.
--   * The tombstone itself: a trigger on `activity_canonical`, as 033's and 034's are, so no
--     deletion path can skip it — the live deletion, and the restore's replayed tombstone of an
--     activity the dump holds. Named to fire after both of those triggers, so the purge row is
--     the last row the deletion writes.
--   * The course reclamation that deletion causes: a trigger on the course's transition to
--     `unavailable`, which only that reclamation performs.
--   * `replay_absent_activity_deletion`, for the restore only: a replayed ledger entry whose
--     activity the restored cluster does not have at all (shape (b)) has no row to tombstone.
--     Arming a purge alone is not enough there: with no source head the restored database
--     could not suppress the source, and a device re-sync would re-import the deleted activity
--     as a new one. So the function rebuilds exactly what suppression needs from the ledger —
--     an already-deleted canonical row carrying NO activity values, the source head (kind,
--     source id, source revision and content hash, all ledger fields) and the suppression row —
--     and arms the purge. Anything it cannot verify refuses the whole entry (see below).
-- Only canonical lowercase UUIDs name a key prefix; a scope with any other tenant or owner id
-- gets no purge row (the function's test and the table's CHECK both say so).
--
-- Backfill. Every deleted activity and unavailable course that exists when this migration runs
-- is armed now: an earlier restore can already have brought back objects no row names.
--
-- Who is never touched. The lease refuses — by not returning it — a row whose activity is
-- present and not deleted, or whose course is present and available. With the terminal
-- tombstone that makes "live" unreachable for a leased scope for the whole run. Another scope,
-- another tenant, the tenant's shared directories: the store walks exactly this one directory,
-- and the worker deletes only keys that begin with it, through the guarded `delete`.
--
-- Lock order. The deletion takes the command lock (0) and the activity row, and its triggers
-- touch their rows; the purge row is written last, so the only new edge is (every row the
-- deletion touches) → the purge row. Erasure (77206 → 0 → rows) deletes activity rows and fires
-- no UPDATE trigger, so it never reaches the purge row. The worker's functions lock nothing but
-- the purge row and read everything else without a lock, so no cycle runs through it.
CREATE TABLE object_scope_purge (
  athlete_id text NOT NULL
    CHECK (athlete_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  scope_kind text NOT NULL CHECK (scope_kind IN ('activity','course')),
  scope_id uuid NOT NULL
    CHECK (scope_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
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
  PRIMARY KEY (athlete_id,scope_kind,scope_id),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (completed_at IS NULL OR lease_owner IS NULL)
);
CREATE INDEX object_scope_purge_pending
  ON object_scope_purge(available_at,athlete_id,scope_kind,scope_id)
  WHERE completed_at IS NULL AND attempts<100;
ALTER TABLE object_scope_purge ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_scope_purge FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE object_scope_purge FROM PUBLIC;

-- A tombstone is terminal. Nothing un-deletes an activity today; this makes it impossible, so a
-- purge leased because its activity was deleted can never meet that activity alive again.
CREATE FUNCTION activity_tombstone_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  RAISE EXCEPTION 'ACTIVITY_TOMBSTONE_TERMINAL';
END $$;
REVOKE ALL ON FUNCTION activity_tombstone_terminal() FROM PUBLIC;
CREATE TRIGGER activity_tombstone_terminal BEFORE UPDATE ON activity_canonical
  FOR EACH ROW WHEN (OLD.deleted AND NOT NEW.deleted)
  EXECUTE FUNCTION activity_tombstone_terminal();

-- Arm (or re-arm) one scope's purge. Not granted to anyone: it is reached through the two
-- triggers below, which run as the owner, and through the restore-only function after them.
CREATE FUNCTION public.arm_object_scope_purge(text,text,uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE writer_fence timestamptz;
BEGIN
  IF $1 IS NULL OR $3 IS NULL
    OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $3::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RETURN false; END IF;
  -- The latest moment one of this scope's writers could still publish (plain reads, no locks),
  -- by the expressions 044 reads for a whole tenant.
  IF $2='activity' THEN
    SELECT max(coalesce(i.publication_lease_until+interval '1 hour',i.expires_at))
      INTO writer_fence FROM public.activity_track_upload_intent i
      WHERE i.athlete_id=$1 AND i.activity_id=$3 AND i.state IN ('prepared','staged','failed');
  ELSIF $2='course' THEN
    SELECT max(greatest(t.publication_lease_until+interval '1 hour',
        t.lease_until+interval '1 hour'))
      INTO writer_fence FROM public.course_thumbnail t
      WHERE t.athlete_id=$1 AND t.course_id=$3;
  ELSE
    RAISE EXCEPTION 'INVALID_OBJECT_SCOPE';
  END IF;
  INSERT INTO public.object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
    VALUES($1,$2,$3,clock_timestamp(),greatest(clock_timestamp(),writer_fence))
    ON CONFLICT(athlete_id,scope_kind,scope_id) DO UPDATE SET armed_at=EXCLUDED.armed_at,
      -- Re-armed, never pulled earlier than an open purge was already due (M2-01s's rule).
      available_at=CASE WHEN public.object_scope_purge.completed_at IS NULL
        THEN greatest(public.object_scope_purge.available_at,EXCLUDED.available_at)
        ELSE EXCLUDED.available_at END,
      attempts=0,passes=0,lease_owner=NULL,lease_until=NULL,completed_at=NULL,
      last_error_code=NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.arm_object_scope_purge(text,text,uuid) FROM PUBLIC;

-- The tombstone. `object_scope_…` sorts after `activity_track_cleanup_on_delete` and
-- `course_reclaim_on_activity_delete`, so this fires last among the deletion's triggers.
CREATE FUNCTION object_scope_purge_on_activity_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  PERFORM public.arm_object_scope_purge(NEW.athlete_id,'activity',NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION object_scope_purge_on_activity_delete() FROM PUBLIC;
CREATE TRIGGER object_scope_purge_on_activity_delete AFTER UPDATE ON activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION object_scope_purge_on_activity_delete();

-- The course reclamation that deleting its source activity performs. The render rows are still
-- there when this fires (the reclamation deletes the revisions after updating the course), so
-- their fences are read.
CREATE FUNCTION object_scope_purge_on_course_reclaim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  PERFORM public.arm_object_scope_purge(NEW.athlete_id,'course',NEW.course_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION object_scope_purge_on_course_reclaim() FROM PUBLIC;
CREATE TRIGGER object_scope_purge_on_course_reclaim AFTER UPDATE ON course
  FOR EACH ROW WHEN (OLD.status='available' AND NEW.status='unavailable')
  EXECUTE FUNCTION object_scope_purge_on_course_reclaim();

-- Restore only (no grant): replaying an activity-deletion ledger entry whose activity the
-- restored cluster does not hold at all. Arguments are the ledger entry: tenant, activity id,
-- source kind, source id, source revision, the activity revision at deletion, and the source
-- head's content hash.
--
-- What it writes, and why each row:
--   * `activity_canonical` — the activity, already deleted, at the ledger's revision, with an
--     EMPTY `original`: no title, time, distance or anything else of the deleted activity is
--     brought back or invented. Every reader of activity values filters deleted rows.
--   * `activity_source_head` — the ledger's kind, source id, source revision and content hash.
--     This is what import looks up: with it, re-importing the source answers `suppressed`
--     (import treats a head whose activity is deleted, or whose source is suppressed, as
--     suppressed) instead of creating a new activity.
--   * `activity_suppression` — the explicit suppression, as the live deletion writes it (and
--     what course lineage checks).
--   * the activity's object-prefix purge.
--
-- What it refuses, failing the replay transaction (fail closed, never a silent commit):
--   * a tenant that is not the session's, as for every replayed entry;
--   * a malformed entry: any NULL, a tenant or activity id that is not a canonical lowercase
--     UUID, an unknown source kind, a source id outside 1..200 characters, a non-positive
--     revision, a content hash that is not 64 lowercase hex characters;
--   * an erased tenant (its erasure replay satisfies the entry), and a tenant with no identity
--     account in the restored cluster (not a tenant this database knows);
--   * an activity id the restored cluster already holds — this tenant's (then it is not absent:
--     tombstone the row instead) or any other tenant's (a foreign id);
--   * a source this tenant's restored cluster already knows under another activity.
-- The tenant's command lock (0) is taken first, as the repository takes it, so the rebuild
-- cannot interleave with a runtime writer of the same tenant.
CREATE FUNCTION public.replay_absent_activity_deletion(text,uuid,text,text,integer,integer,text)
RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
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

-- Backfill: what is already deleted when this migration runs, due now. Throughput (N4): the
-- worker runs up to 20 scope purges per invocation (`OBJECT_SCOPE_PURGE_RUNS_PER_INVOCATION`),
-- 1,200 an hour at one invocation a minute, and each scope needs one complete pass — so a
-- backfill of N rows drains in about N/1,200 hours after the tenant purges ahead of it.
INSERT INTO object_scope_purge(athlete_id,scope_kind,scope_id,armed_at,available_at)
  SELECT c.athlete_id,'activity',c.id,clock_timestamp(),clock_timestamp()
  FROM activity_canonical c
  WHERE c.deleted
    AND c.athlete_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND c.id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  UNION ALL
  SELECT o.athlete_id,'course',o.course_id,clock_timestamp(),clock_timestamp()
  FROM course o
  WHERE o.status='unavailable'
    AND o.athlete_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND o.course_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- No silent stuck state (N5, M2-01z's rules for the tenant purge, applied here from the start).
--
--   * A lost lease is visible: taking over a row whose lease expired records `LEASE_EXPIRED`,
--     and a row whose 100th (last) attempt lost its lease is dead-lettered as
--     `DEAD_LETTER:LEASE_EXPIRED` with its stale lease cleared — never out of rotation unlabelled.
--   * A row the lease refuses because its owner is live is stamped once
--     `INCONSISTENT_LEDGER:ACTIVITY_LIVE` or `INCONSISTENT_LEDGER:COURSE_AVAILABLE`: not
--     leased, not charged, nothing deleted. Decided yes, for 045's reason: no path of this
--     system arms a purge under a live owner (the tombstone and reclamation triggers fire only
--     on the transition, the restore rebuild refuses a present activity, the backfill takes only
--     deleted/unavailable owners, and a tombstone is terminal), so such a row can only come from
--     a hand-edited or corrupted ledger. No retry fixes that; it needs a person, and without the
--     stamp it sits due for ever with `attempts` 0 and no code. If the owner is later deleted,
--     its trigger re-arms the row and clears the code.
--
-- Labelling before the CHECK: the table is new in this migration and every backfilled row has
-- `attempts` 0, so this statement matches nothing here; it is kept so the CHECK below is always
-- added over a labelled table, as 045 does for `tenant_object_purge`.
UPDATE object_scope_purge SET
  last_error_code=CASE WHEN lease_owner IS NOT NULL THEN 'DEAD_LETTER:LEASE_EXPIRED'
    ELSE 'DEAD_LETTER:'||left(coalesce(last_error_code,'SCOPE_PURGE_FAILED'),88) END,
  lease_owner=NULL,lease_until=NULL
WHERE completed_at IS NULL AND attempts>=100
  AND (lease_owner IS NULL OR lease_until<=clock_timestamp())
  AND NOT coalesce(starts_with(last_error_code,'DEAD_LETTER:'),false);

-- `coalesce(…,false)`: a CHECK passes on NULL, so a bare LIKE would let the NULL code through.
ALTER TABLE object_scope_purge ADD CONSTRAINT object_scope_purge_dead_letter_labelled
  CHECK (attempts<100 OR completed_at IS NOT NULL OR lease_owner IS NOT NULL
    OR coalesce(starts_with(last_error_code,'DEAD_LETTER:'),false));

CREATE INDEX object_scope_purge_final_lease ON object_scope_purge(athlete_id,scope_kind,scope_id)
  WHERE completed_at IS NULL AND attempts>=100 AND lease_owner IS NOT NULL;

-- One due scope purge, leased. Refuses — by not returning it — a row whose activity is present
-- and not deleted, or whose course is present and available: whatever armed it, nothing under
-- a live owner's directory is touched. Every statement locks object_scope_purge rows only
-- (`FOR UPDATE SKIP LOCKED`) and reads activities and courses without a lock, so the lease
-- never waits for anything while it holds a purge row.
CREATE FUNCTION public.lease_object_scope_purge(uuid,timestamptz,timestamptz)
RETURNS TABLE(athlete_id text,scope_kind text,scope_id uuid,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
      AND (EXISTS(SELECT 1 FROM public.activity_canonical c
          WHERE p.scope_kind='activity' AND c.athlete_id=p.athlete_id AND c.id=p.scope_id
            AND NOT c.deleted)
        OR EXISTS(SELECT 1 FROM public.course c
          WHERE p.scope_kind='course' AND c.athlete_id=p.athlete_id AND c.course_id=p.scope_id
            AND c.status='available'))
    ORDER BY p.available_at,p.athlete_id,p.scope_kind,p.scope_id FOR UPDATE SKIP LOCKED LIMIT 100);
  RETURN QUERY WITH candidate AS (
    SELECT p.athlete_id,p.scope_kind,p.scope_id FROM public.object_scope_purge p
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND NOT EXISTS(SELECT 1 FROM public.activity_canonical c
        WHERE p.scope_kind='activity' AND c.athlete_id=p.athlete_id AND c.id=p.scope_id
          AND NOT c.deleted)
      AND NOT EXISTS(SELECT 1 FROM public.course c
        WHERE p.scope_kind='course' AND c.athlete_id=p.athlete_id AND c.course_id=p.scope_id
          AND c.status='available')
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

-- The end of one leased run: `$5` ok, `$6` error code, `$7` objects deleted in this run, `$8`
-- unrecognized entries seen, `$9` whether the run stopped at its budget with more to do. A run
-- that stopped at its budget is due again at once and is not a pass; the first complete pass
-- closes the purge (see "When" above). A failed run backs off as the queue does and
-- dead-letters at 100 attempts.
CREATE FUNCTION public.finish_object_scope_purge(text,text,uuid,uuid,boolean,text,integer,integer,boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $7 IS NULL OR $7<0 OR $8 IS NULL OR $8<0 OR $5 IS NULL OR $9 IS NULL
  THEN RAISE EXCEPTION 'INVALID_PURGE_OUTCOME'; END IF;
  UPDATE public.object_scope_purge SET
    objects_purged=objects_purged+$7,
    unrecognized_entries=CASE WHEN $5 THEN $8 ELSE unrecognized_entries END,
    passes=CASE WHEN $5 AND NOT $9 THEN passes+1 ELSE passes END,
    last_pass_at=CASE WHEN $5 AND NOT $9 THEN database_now ELSE last_pass_at END,
    completed_at=CASE WHEN $5 AND NOT $9 THEN database_now ELSE NULL END,
    available_at=CASE
      WHEN $5 THEN database_now
      ELSE database_now+least(attempts,10)*interval '30 seconds' END,
    attempts=CASE WHEN $5 THEN 0 ELSE attempts END,
    last_error_code=CASE
      WHEN $5 THEN NULL
      WHEN attempts>=100 THEN 'DEAD_LETTER:'||left(coalesce($6,'SCOPE_PURGE_FAILED'),88)
      ELSE left(coalesce($6,'SCOPE_PURGE_FAILED'),100) END,
    lease_owner=NULL,lease_until=NULL
  WHERE athlete_id=$1 AND scope_kind=$2 AND scope_id=$3 AND lease_owner=$4
    AND completed_at IS NULL AND lease_until>database_now;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_object_scope_purge(text,text,uuid,uuid,boolean,text,integer,integer,boolean) FROM PUBLIC;
