-- Offline, owner-only replay for one activity deletion event. This is a database
-- primitive only: caller-side complete-chain authentication, backup/LSN anchor,
-- remote tail, and access gate remain separate. Manual-source activities absent
-- from the restored database are refused because the existing absent replay
-- contract cannot reconstruct them safely.

CREATE TABLE public.restore_activity_replay_receipt (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  target_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  activity_revision integer NOT NULL CHECK (activity_revision>0),
  source_kind text NOT NULL CHECK (source_kind IN ('fit','fixture','manual','healthkit')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  source_revision integer NOT NULL CHECK (source_revision>0),
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^[a-f0-9]{64}$')
);
REVOKE ALL ON TABLE public.restore_activity_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_activity_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_activity_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_activity_replay_receipt_owner ON public.restore_activity_replay_receipt
  USING (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
      WHERE oid='public.restore_activity_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
      WHERE oid='public.restore_activity_replay_receipt'::regclass)));

CREATE FUNCTION public.verify_restore_activity_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.kind='activity_deleted' AND e.target_id=NEW.target_id
      AND e.occurred_at=NEW.occurred_at
      AND e.activity_revision=NEW.activity_revision
      AND e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id
      AND e.source_revision=NEW.source_revision
      AND e.source_content_hash=NEW.source_content_hash)
  THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_activity_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_activity_replay_receipt_verify
  BEFORE INSERT ON public.restore_activity_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_activity_replay_receipt();
CREATE TRIGGER restore_activity_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_activity_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_activity_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_activity_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- A restored live canonical must use the usual deletion hooks for evidence,
-- courses, HealthKit redaction, track cleanup, and object purge. That UPDATE
-- would normally emit a fresh suppression event. Owner-only replay suppresses
-- exactly that secondary event, then inserts the authenticated source event.
-- A runtime role can set a custom GUC, but this trigger refuses its session.
CREATE OR REPLACE FUNCTION public.record_activity_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE source_row record;
DECLARE replay_id text:=nullif(current_setting('app.restore_activity_event_id',true),'');
BEGIN
  IF replay_id IS NOT NULL THEN
    IF session_user IS DISTINCT FROM pg_get_userbyid(
      (SELECT c.relowner FROM pg_catalog.pg_class c
        WHERE c.oid='public.restore_suppression_event'::regclass))
    THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  SELECT kind,source_id,source_revision,content_hash INTO source_row
    FROM public.activity_source_head
    WHERE athlete_id=NEW.athlete_id AND activity_id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVITY_EVENT_SOURCE_MISSING'; END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,activity_revision,source_kind,source_id,
    source_revision,source_content_hash)
  VALUES(NEW.athlete_id,'activity_deleted',NEW.id,clock_timestamp(),NEW.revision,
    source_row.kind,source_row.source_id,source_row.source_revision,source_row.content_hash);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_activity_deletion_suppression_event() FROM PUBLIC;

CREATE FUNCTION public.replay_activity_deletion_exact(
  text,uuid,uuid,timestamptz,integer,text,text,integer,text) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid='public.replay_activity_deletion_exact(text,uuid,uuid,timestamptz,integer,text,text,integer,text)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_activity_replay_receipt%ROWTYPE;
DECLARE canonical_row record;
DECLARE source_row record;
DECLARE had_event boolean;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $2::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $3 IS NULL OR $4 IS NULL OR $4>clock_timestamp()
    OR $5 IS NULL OR $5<1 OR $6 IS NULL OR $6 NOT IN ('fit','fixture','manual','healthkit')
    OR $7 IS NULL OR length($7) NOT BETWEEN 1 AND 200
    OR $8 IS NULL OR $8<1 OR $9 IS NULL OR $9 !~ '^[a-f0-9]{64}$'
    OR ($6='healthkit' AND
      ($7 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR $9<>repeat('0',64)))
    OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event
    WHERE event_id=$3 OR (athlete_id=$1 AND kind='activity_deleted' AND target_id=$2)
    FOR UPDATE;
  had_event:=FOUND;
  IF had_event AND (existing.event_id IS DISTINCT FROM $3
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.kind IS DISTINCT FROM 'activity_deleted'
    OR existing.target_id IS DISTINCT FROM $2 OR existing.occurred_at IS DISTINCT FROM $4
    OR existing.activity_revision IS DISTINCT FROM $5
    OR existing.source_kind IS DISTINCT FROM $6 OR existing.source_id IS DISTINCT FROM $7
    OR existing.source_revision IS DISTINCT FROM $8
    OR existing.source_content_hash IS DISTINCT FROM $9
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$3 OR (e.athlete_id=$1 AND e.kind='activity_deleted' AND e.target_id=$2))
        AND e.event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_activity_replay_receipt r WHERE r.event_id=$3;
    IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.target_id IS DISTINCT FROM $2 OR receipt.occurred_at IS DISTINCT FROM $4
      OR receipt.activity_revision IS DISTINCT FROM $5
      OR receipt.source_kind IS DISTINCT FROM $6 OR receipt.source_id IS DISTINCT FROM $7
      OR receipt.source_revision IS DISTINCT FROM $8
      OR receipt.source_content_hash IS DISTINCT FROM $9
    THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_activity_replay_receipt r WHERE r.event_id=$3)
  THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_RECEIPT_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.athlete_id=$1 AND e.kind='tenant_erased')
    THEN RETURN 'already_applied_by_erasure'; END IF;
    RAISE EXCEPTION 'RESTORE_ACTIVITY_TENANT_ERASED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_TENANT_UNKNOWN'; END IF;
  SELECT c.revision,c.deleted INTO canonical_row FROM public.activity_canonical c
    WHERE c.athlete_id=$1 AND c.id=$2 FOR UPDATE;
  SELECT h.kind,h.source_id,h.source_revision,h.content_hash INTO source_row
    FROM public.activity_source_head h
    WHERE h.athlete_id=$1 AND h.activity_id=$2 FOR UPDATE;
  IF had_event THEN
    IF canonical_row.deleted IS DISTINCT FROM true
      OR canonical_row.revision IS DISTINCT FROM $5
      OR source_row.kind IS DISTINCT FROM $6 OR source_row.source_id IS DISTINCT FROM $7
      OR source_row.source_revision IS DISTINCT FROM $8
      OR source_row.content_hash IS DISTINCT FROM $9
      OR NOT EXISTS(SELECT 1 FROM public.activity_suppression s
        WHERE s.athlete_id=$1 AND s.kind=$6 AND s.source_id=$7)
      OR NOT EXISTS(SELECT 1 FROM public.object_scope_purge p
        WHERE p.athlete_id=$1 AND p.scope_kind='activity' AND p.scope_id=$2)
    THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_STATE_CONFLICT'; END IF;
    RETURN 'already_applied';
  END IF;
  IF public.restore_foreign_scope_present($1,'activity',$2)
  THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_FOREIGN_ACTIVITY'; END IF;
  IF canonical_row.revision IS NOT NULL THEN
    IF canonical_row.deleted IS DISTINCT FROM false OR canonical_row.revision<>$5-1
      OR source_row.kind IS DISTINCT FROM $6 OR source_row.source_id IS DISTINCT FROM $7
      OR source_row.source_revision IS DISTINCT FROM $8
      OR ($6<>'healthkit' AND source_row.content_hash IS DISTINCT FROM $9)
    THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_STATE_CONFLICT'; END IF;
    IF $6='healthkit' AND EXISTS(SELECT 1 FROM public.healthkit_workout_sample s
      WHERE s.athlete_id=$1 AND s.sample_id=$7::uuid AND s.state='deleted')
    THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_STATE_CONFLICT'; END IF;
    INSERT INTO public.activity_suppression(athlete_id,kind,source_id)
      VALUES($1,$6,$7) ON CONFLICT DO NOTHING;
    PERFORM set_config('app.restore_activity_event_id',$3::text,true);
    UPDATE public.activity_canonical SET deleted=true,revision=$5
      WHERE athlete_id=$1 AND id=$2;
    PERFORM set_config('app.restore_activity_event_id','',true);
  ELSE
    IF $6='manual' THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_MANUAL_ABSENT_UNSUPPORTED'; END IF;
    PERFORM public.replay_absent_activity_deletion($1,$2,$6,$7,$8,$5,$9);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.activity_canonical c
    WHERE c.athlete_id=$1 AND c.id=$2 AND c.deleted AND c.revision=$5)
    OR NOT EXISTS(SELECT 1 FROM public.activity_source_head h
      WHERE h.athlete_id=$1 AND h.activity_id=$2 AND h.kind=$6 AND h.source_id=$7
        AND h.source_revision=$8 AND h.content_hash=$9)
    OR NOT EXISTS(SELECT 1 FROM public.activity_suppression s
      WHERE s.athlete_id=$1 AND s.kind=$6 AND s.source_id=$7)
    OR NOT EXISTS(SELECT 1 FROM public.object_scope_purge p
      WHERE p.athlete_id=$1 AND p.scope_kind='activity' AND p.scope_id=$2
        AND p.completed_at IS NULL)
  THEN RAISE EXCEPTION 'RESTORE_ACTIVITY_STATE_CONFLICT'; END IF;
  INSERT INTO public.restore_suppression_event(
    event_id,athlete_id,kind,target_id,occurred_at,activity_revision,
    source_kind,source_id,source_revision,source_content_hash)
    VALUES($3,$1,'activity_deleted',$2,$4,$5,$6,$7,$8,$9);
  INSERT INTO public.restore_activity_replay_receipt(
    event_id,athlete_id,target_id,occurred_at,activity_revision,
    source_kind,source_id,source_revision,source_content_hash)
    VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9);
  RETURN CASE WHEN canonical_row.revision IS NULL THEN 'absent' ELSE 'deleted' END;
END $$;
REVOKE ALL ON FUNCTION public.replay_activity_deletion_exact(
  text,uuid,uuid,timestamptz,integer,text,text,integer,text) FROM PUBLIC;
