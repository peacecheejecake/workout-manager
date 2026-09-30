-- Owner-only offline replay of a backup-authenticated check-in deletion.
-- The minimal event cannot reconstruct an absent check-in or its history.
CREATE TABLE public.restore_check_in_replay_receipt (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  target_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  check_in_revision integer NOT NULL CHECK (check_in_revision BETWEEN 2 AND 2147483646)
);
REVOKE ALL ON TABLE public.restore_check_in_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_check_in_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_check_in_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_check_in_replay_receipt_owner ON public.restore_check_in_replay_receipt
  USING (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_check_in_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_check_in_replay_receipt'::regclass)));

CREATE FUNCTION public.verify_restore_check_in_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.kind='check_in_deleted' AND e.target_id=NEW.target_id
      AND e.occurred_at=NEW.occurred_at
      AND e.check_in_revision=NEW.check_in_revision)
  THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_check_in_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_check_in_replay_receipt_verify
  BEFORE INSERT ON public.restore_check_in_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_check_in_replay_receipt();
CREATE TRIGGER restore_check_in_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_check_in_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_check_in_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_check_in_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- Keep the ordinary deletion validation and evidence purge triggers. Suppress
-- only their secondary event while the plain migration owner inserts its ID.
CREATE OR REPLACE FUNCTION public.record_check_in_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_check_in_event_id',true),'');
BEGIN
  IF OLD.deleted AND NOT NEW.deleted THEN
    RAISE EXCEPTION 'CHECK_IN_DELETION_REVERSAL';
  END IF;
  IF OLD.deleted OR NOT NEW.deleted THEN RETURN NULL; END IF;
  IF OLD.athlete_id IS DISTINCT FROM NEW.athlete_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR NEW.revision IS DISTINCT FROM OLD.revision+1
    OR NEW.values_json IS NOT NULL OR NEW.local_date IS NOT NULL
    OR NEW.updated_at IS NULL
  THEN RAISE EXCEPTION 'CHECK_IN_DELETION_INVALID'; END IF;
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'CHECK_IN_DELETION_TENANT_MISMATCH'; END IF;
  IF replay_id IS NOT NULL THEN
    IF session_user IS DISTINCT FROM pg_get_userbyid(
      (SELECT c.relowner FROM pg_catalog.pg_class c
       WHERE c.oid='public.restore_suppression_event'::regclass))
    THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,check_in_revision)
  VALUES(NEW.athlete_id,'check_in_deleted',NEW.id,NEW.updated_at,NEW.revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_check_in_deletion_suppression_event() FROM PUBLIC;

CREATE FUNCTION public.replay_check_in_deletion_exact(text,uuid,uuid,timestamptz,integer)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
   WHERE p.oid='public.replay_check_in_deletion_exact(text,uuid,uuid,timestamptz,integer)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_check_in_replay_receipt%ROWTYPE;
DECLARE head public.check_in%ROWTYPE;
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE other_tenant text;
DECLARE had_event boolean;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $2::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $3 IS NULL OR $4 IS NULL OR $4>clock_timestamp()
    OR $5 IS NULL OR $5 NOT BETWEEN 2 AND 2147483646
    OR $1 IS DISTINCT FROM nullif(caller_tenant,'')
  THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77209));
  SELECT * INTO existing FROM public.restore_suppression_event
    WHERE event_id=$3 OR (athlete_id=$1 AND kind='check_in_deleted' AND target_id=$2)
    FOR UPDATE;
  had_event:=FOUND;
  IF had_event AND (existing.event_id IS DISTINCT FROM $3
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.kind IS DISTINCT FROM 'check_in_deleted'
    OR existing.target_id IS DISTINCT FROM $2 OR existing.occurred_at IS DISTINCT FROM $4
    OR existing.check_in_revision IS DISTINCT FROM $5
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$3 OR (e.athlete_id=$1 AND e.kind='check_in_deleted' AND e.target_id=$2))
        AND e.event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_check_in_replay_receipt r WHERE r.event_id=$3;
    IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.target_id IS DISTINCT FROM $2 OR receipt.occurred_at IS DISTINCT FROM $4
      OR receipt.check_in_revision IS DISTINCT FROM $5
    THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_check_in_replay_receipt r WHERE r.event_id=$3)
  THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_RECEIPT_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.athlete_id=$1 AND e.kind='tenant_erased')
    THEN RETURN 'already_applied_by_erasure'; END IF;
    RAISE EXCEPTION 'RESTORE_CHECK_IN_TENANT_ERASED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_TENANT_UNKNOWN'; END IF;
  SELECT c.* INTO head FROM public.check_in c
    WHERE c.athlete_id=$1 AND c.id=$2 FOR UPDATE;
  IF had_event THEN
    IF head.deleted IS DISTINCT FROM true OR head.revision IS DISTINCT FROM $5
      OR head.updated_at IS DISTINCT FROM $4
      OR head.values_json IS NOT NULL OR head.local_date IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.check_in_revision r
        WHERE r.athlete_id=$1 AND r.check_in_id=$2)
    THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_STATE_CONFLICT'; END IF;
    RETURN 'already_applied';
  END IF;
  FOR other_tenant IN SELECT a.athlete_id::text FROM identity_private.account a
    WHERE a.athlete_id::text<>$1 ORDER BY a.athlete_id
  LOOP
    PERFORM set_config('app.athlete_id',other_tenant,true);
    IF EXISTS(SELECT 1 FROM public.check_in c
      WHERE c.athlete_id=other_tenant AND c.id=$2)
    THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_FOREIGN_TARGET'; END IF;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  IF head.id IS NULL THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_ABSENT_UNSUPPORTED'; END IF;
  IF head.deleted OR head.revision<>$5-1 OR head.updated_at>$4
    OR head.recorded_at>$4
    OR head.values_json IS NULL OR head.local_date IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.check_in_revision r
      WHERE r.athlete_id=$1 AND r.check_in_id=$2 AND r.revision=head.revision)
    OR EXISTS(SELECT 1 FROM public.check_in_revision r
      WHERE r.athlete_id=$1 AND r.check_in_id=$2 AND r.revision>head.revision)
    OR NOT EXISTS(SELECT 1 FROM public.check_in_collection_head h
      WHERE h.athlete_id=$1 AND h.revision BETWEEN 1 AND 2147483645)
  THEN RAISE EXCEPTION 'RESTORE_CHECK_IN_STATE_CONFLICT'; END IF;
  DELETE FROM public.check_in_revision WHERE athlete_id=$1 AND check_in_id=$2;
  PERFORM set_config('app.restore_check_in_event_id',$3::text,true);
  UPDATE public.check_in SET revision=$5,deleted=true,values_json=NULL,
    local_date=NULL,updated_at=$4 WHERE athlete_id=$1 AND id=$2;
  PERFORM set_config('app.restore_check_in_event_id','',true);
  UPDATE public.check_in_collection_head SET revision=revision+1 WHERE athlete_id=$1;
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES($1,$3,'restore:check_in_deleted:'||$3::text,'checkin.changed',
      jsonb_build_object('checkInId',$2::text,'revision',$5,
        'collectionRevision',(SELECT revision FROM public.check_in_collection_head WHERE athlete_id=$1),
        'action','delete'));
  INSERT INTO public.restore_suppression_event(
    event_id,athlete_id,kind,target_id,occurred_at,check_in_revision)
    VALUES($3,$1,'check_in_deleted',$2,$4,$5);
  INSERT INTO public.restore_check_in_replay_receipt(
    event_id,athlete_id,target_id,occurred_at,check_in_revision)
    VALUES($3,$1,$2,$4,$5);
  RETURN 'deleted';
END $$;
REVOKE ALL ON FUNCTION public.replay_check_in_deletion_exact(text,uuid,uuid,timestamptz,integer)
  FROM PUBLIC;
