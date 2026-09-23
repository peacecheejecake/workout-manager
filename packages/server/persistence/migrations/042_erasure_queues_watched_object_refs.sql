-- M2-01s: account erasure queues every object key the two reference indexes still watch.
--
-- The reference indexes (033 for recorded tracks, 039 for course thumbnails) exist for one
-- case: an object that a stalled writer published after every receipt for its key had
-- already closed. The ledger row that named the key is compacted or pruned seven days later,
-- and from then on the index row is the only thing in the database that still names those
-- bytes. The reconciliation sweep reads the index and reclaims them.
--
-- Erasure deleted both indexes without queueing what they watched. The tracks stage (033)
-- and the thumbnails stage (038) queue every key their *ledger* rows name, which is exactly
-- the set that no longer contains such an orphan. So an account erased while an orphan was
-- still watched lost its last pointer: not the ledger (pruned), not the index (erased), not
-- the queue (closed). Reproduced on PostgreSQL 14 for both — a raw GPX object and a thumbnail
-- SVG survived erasure, a full queue drain and a sweep.
--
-- Restore makes this the ordinary case rather than a race. A backup taken while the index
-- still watched a key restores that index row and, from the object archive, the object —
-- even when the source cluster had long since reclaimed it. The replayed erasure then drops
-- the index row and the restored object has nothing left that will ever delete it.
--
-- This outermost link reads the tenant's watched keys before the chain runs (plain reads,
-- no row locks), lets every earlier stage run unchanged, and queues those keys last. Every
-- key is queued, settled or not: settling means the object was absent when it was last
-- examined, which says nothing about an object archive copied at another moment.
--
-- Every conflicting receipt ends up `account_erased`, open or closed, as the 033 and 038
-- stages already do for the keys their ledger rows name — one rule inside one erasure, and
-- the one that brings the thirty-day erasure fence with it. A receipt this erasure's own
-- stages already made `account_erased` and left open is not touched again: 038 set its
-- `available_at` from the writer fences a moment ago.
--
-- `available_at` is the one field that is not simply overwritten. A closed receipt reopens
-- due now. An open one keeps the later of its own time and now, never an earlier one. The
-- reason is a receipt that carries a fence no ledger row carries any more: a course deleted
-- while its render held an open publication fence cascades the thumbnail row away, and the
-- `course_deleted` receipt it queued holds the key back for the fence plus an hour by its
-- `available_at` alone (`holds a reclaimed key back while a render could still publish it,
-- even with its row gone`). That key is named only by the index when the account is erased,
-- so this stage is the one that converts it, and `authorize`/`finish` can no longer see any
-- fence for it. Resetting it to now would delete while the writer can still publish.
--
-- Lock order. The account lock (77206) and then the per-tenant command lock (0), before any
-- row — the repository's order, re-entrant for a caller that already holds them. The queue
-- rows are touched after the chain has deleted both indexes, so the new edge is index →
-- queue, the direction the sweep already takes (it settles the index row, then reclaims
-- through the queue) and the one both erasure stages already take (033 deletes its index
-- before its tracks stage queues; 039 deletes its index last). No index row is touched here,
-- so M2-01m's "the thumbnail index goes last" is unchanged.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_watched_ref_queue;
REVOKE ALL ON FUNCTION public.erase_account_before_watched_ref_queue(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_watched_ref_queue(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_watched_ref_queue(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE erased_at timestamptz;
DECLARE watched text[];
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT coalesce(array_agg(refs.storage_ref),'{}'::text[]) INTO watched FROM (
    SELECT r.storage_ref FROM public.activity_track_object_ref r WHERE r.athlete_id=$1
    UNION SELECT r.storage_ref FROM public.course_thumbnail_object_ref r WHERE r.athlete_id=$1
  ) refs;
  erased_at:=public.erase_account_before_watched_ref_queue($1);
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'account_erased',clock_timestamp(),clock_timestamp()
    FROM unnest(watched) refs(storage_ref)
    ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,
      available_at=CASE WHEN public.resource_object_cleanup.completed_at IS NULL
        THEN greatest(public.resource_object_cleanup.available_at,EXCLUDED.available_at)
        ELSE EXCLUDED.available_at END,
      created_at=EXCLUDED.created_at,completed_at=NULL,delete_authorized_at=NULL,
      last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL
      OR public.resource_object_cleanup.reason<>'account_erased';
  RETURN erased_at;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
