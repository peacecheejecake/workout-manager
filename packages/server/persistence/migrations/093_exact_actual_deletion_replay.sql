-- Owner-only offline replay for future v2 actual deletions. The authenticated
-- event can replay one head transition when its complete predecessor history
-- exists in the backup. It cannot reconstruct absent creates/corrections, the
-- original command receipt, or original outbox identity.
CREATE TABLE public.restore_actual_deletion_replay_receipt (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('intake_entry_deleted','recovery_action_deleted')),
  target_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  deletion_revision integer NOT NULL CHECK (deletion_revision BETWEEN 2 AND 2147483646),
  previous_revision_id uuid NOT NULL,
  deleted_revision_id uuid NOT NULL CHECK (deleted_revision_id<>previous_revision_id),
  UNIQUE (athlete_id,kind,target_id)
);
REVOKE ALL ON public.restore_actual_deletion_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_actual_deletion_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_actual_deletion_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_actual_deletion_receipt_owner ON public.restore_actual_deletion_replay_receipt
  USING (session_user=pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
    WHERE oid='public.restore_actual_deletion_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
    WHERE oid='public.restore_actual_deletion_replay_receipt'::regclass)));
CREATE FUNCTION public.verify_restore_actual_deletion_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.record_version=2
      AND e.athlete_id=NEW.athlete_id AND e.kind=NEW.kind
      AND e.target_id=NEW.target_id AND e.occurred_at=NEW.occurred_at
      AND e.actual_deletion_revision=NEW.deletion_revision
      AND e.actual_previous_revision_id=NEW.previous_revision_id
      AND e.actual_deleted_revision_id=NEW.deleted_revision_id)
  THEN RAISE EXCEPTION 'RESTORE_ACTUAL_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_actual_deletion_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_actual_deletion_receipt_verify
  BEFORE INSERT ON public.restore_actual_deletion_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_actual_deletion_replay_receipt();
CREATE TRIGGER restore_actual_deletion_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_actual_deletion_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_actual_deletion_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_actual_deletion_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- This owner-only source context prevents a caller-settable app.* GUC from
-- suppressing the normal event. A deferred check forbids a committed bypass
-- without its exact event and receipt in the same transaction.
CREATE TABLE public.restore_actual_deletion_replay_context (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('intake_entry_deleted','recovery_action_deleted')),
  target_id uuid NOT NULL,
  source_txid bigint NOT NULL,
  UNIQUE (athlete_id,kind,target_id)
);
REVOKE ALL ON public.restore_actual_deletion_replay_context FROM PUBLIC;
ALTER TABLE public.restore_actual_deletion_replay_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_actual_deletion_replay_context FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_actual_deletion_context_owner ON public.restore_actual_deletion_replay_context
  USING (session_user=pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
    WHERE oid='public.restore_actual_deletion_replay_context'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
    WHERE oid='public.restore_actual_deletion_replay_context'::regclass)));
CREATE TRIGGER restore_actual_deletion_context_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_actual_deletion_replay_context
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_actual_deletion_context_immutable_truncate
  BEFORE TRUNCATE ON public.restore_actual_deletion_replay_context
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE FUNCTION public.require_restore_actual_deletion_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    JOIN public.restore_actual_deletion_replay_receipt r ON r.event_id=e.event_id
    JOIN public.restore_actual_deletion_replay_context c ON c.event_id=e.event_id
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.kind=NEW.kind AND e.target_id=NEW.target_id AND e.record_version=2
      AND r.athlete_id=NEW.athlete_id AND r.kind=NEW.kind AND r.target_id=NEW.target_id
      AND c.athlete_id=NEW.athlete_id AND c.kind=NEW.kind AND c.target_id=NEW.target_id
      AND e.xmin=c.xmin AND r.xmin=c.xmin)
  THEN RAISE EXCEPTION 'RESTORE_ACTUAL_REPLAY_INCOMPLETE'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.require_restore_actual_deletion_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER restore_actual_deletion_replay_complete
  AFTER INSERT ON public.restore_actual_deletion_replay_context
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.require_restore_actual_deletion_complete();

-- The source trigger replacements below keep 091's transition checks. Only a
-- plain owner with an exact context row for this transaction may bypass the
-- secondary randomly generated event; the replay function inserts source ID.
CREATE OR REPLACE FUNCTION public.record_intake_entry_deletion_suppression_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE first_revision_id uuid;
DECLARE predecessor record;
DECLARE tombstone record;
DECLARE head_xmin xid;
BEGIN
  IF OLD.status IS DISTINCT FROM 'active' OR NEW.status IS DISTINCT FROM 'deleted'
    OR NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.current_revision IS DISTINCT FROM OLD.current_revision+1
    OR OLD.current_revision_id IS NULL OR NEW.current_revision_id IS NULL
  THEN RAISE EXCEPTION 'INTAKE_EVENT_INVALID_TRANSITION'; END IF;
  SELECT revision_id INTO first_revision_id
    FROM public.intake_entry_revision
    WHERE athlete_id=NEW.athlete_id AND intake_id=NEW.id
      AND revision=1 AND status='active';
  IF first_revision_id IS NULL THEN RAISE EXCEPTION 'INTAKE_EVENT_ORIGIN_MISSING'; END IF;
  SELECT revision_id,status INTO predecessor FROM public.intake_entry_revision
    WHERE athlete_id=OLD.athlete_id AND intake_id=OLD.id
      AND revision=OLD.current_revision;
  IF NOT FOUND OR predecessor.revision_id IS DISTINCT FROM OLD.current_revision_id
    OR predecessor.status IS DISTINCT FROM 'active'
  THEN RAISE EXCEPTION 'INTAKE_EVENT_PREDECESSOR_INVALID'; END IF;
  SELECT revision_id,recorded_at,deleted_at,deletion_reason,xmin INTO tombstone
    FROM public.intake_entry_revision
    WHERE athlete_id=NEW.athlete_id AND intake_id=NEW.id
      AND revision=NEW.current_revision AND status='deleted';
  IF NOT FOUND THEN RAISE EXCEPTION 'INTAKE_EVENT_TOMBSTONE_INVALID'; END IF;
  SELECT xmin INTO head_xmin FROM public.intake_entry
    WHERE athlete_id=NEW.athlete_id AND id=NEW.id;
  IF tombstone.revision_id IS DISTINCT FROM NEW.current_revision_id
    OR tombstone.deleted_at IS NULL
    OR tombstone.recorded_at IS DISTINCT FROM tombstone.deleted_at
    OR tombstone.deletion_reason IS DISTINCT FROM 'user_requested'
    OR tombstone.xmin IS DISTINCT FROM head_xmin
  THEN RAISE EXCEPTION 'INTAKE_EVENT_TOMBSTONE_INVALID'; END IF;
  IF nullif(current_setting('app.restore_actual_event_id',true),'') IS NOT NULL THEN
    IF session_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
      WHERE oid='public.restore_suppression_event'::regclass))
      OR current_user IS DISTINCT FROM session_user
      OR NOT EXISTS(SELECT 1 FROM public.restore_actual_deletion_replay_context c
        WHERE c.event_id=nullif(current_setting('app.restore_actual_event_id',true),'')::uuid
          AND c.athlete_id=NEW.athlete_id AND c.kind='intake_entry_deleted'
          AND c.target_id=first_revision_id AND c.source_txid=txid_current())
    THEN RAISE EXCEPTION 'RESTORE_ACTUAL_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  INSERT INTO public.restore_suppression_event(
    record_version,athlete_id,kind,target_id,occurred_at,
    actual_deletion_revision,actual_previous_revision_id,actual_deleted_revision_id)
  VALUES(2,NEW.athlete_id,'intake_entry_deleted',first_revision_id,
    tombstone.deleted_at,NEW.current_revision,
    OLD.current_revision_id,NEW.current_revision_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_intake_entry_deletion_suppression_event() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.record_recovery_action_deletion_suppression_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE predecessor record;
DECLARE tombstone record;
DECLARE deleted_at timestamptz;
DECLARE head_xmin xid;
BEGIN
  IF OLD.status IS DISTINCT FROM 'active' OR NEW.status IS DISTINCT FROM 'deleted'
    OR NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.action_id IS DISTINCT FROM OLD.action_id
    OR NEW.revision IS DISTINCT FROM OLD.revision+1
    OR OLD.revision_id IS NULL OR NEW.revision_id IS NULL
  THEN RAISE EXCEPTION 'RECOVERY_EVENT_INVALID_TRANSITION'; END IF;
  SELECT revision_id,status INTO predecessor FROM public.recovery_action_revision
    WHERE athlete_id=OLD.athlete_id AND action_id=OLD.action_id
      AND revision=OLD.revision;
  IF NOT FOUND OR predecessor.revision_id IS DISTINCT FROM OLD.revision_id
    OR predecessor.status IS DISTINCT FROM 'active'
  THEN RAISE EXCEPTION 'RECOVERY_EVENT_PREDECESSOR_INVALID'; END IF;
  SELECT revision_id,record_json,xmin INTO tombstone
    FROM public.recovery_action_revision
    WHERE athlete_id=NEW.athlete_id AND action_id=NEW.action_id
      AND revision=NEW.revision AND status='deleted';
  IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_EVENT_TOMBSTONE_INVALID'; END IF;
  SELECT xmin INTO head_xmin FROM public.recovery_action_log
    WHERE athlete_id=NEW.athlete_id AND action_id=NEW.action_id;
  IF tombstone.revision_id IS DISTINCT FROM NEW.revision_id
    OR tombstone.xmin IS DISTINCT FROM head_xmin
    OR pg_catalog.jsonb_typeof(tombstone.record_json->'deletedAt') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'RECOVERY_EVENT_TOMBSTONE_INVALID'; END IF;
  deleted_at := (tombstone.record_json->>'deletedAt')::timestamptz;
  IF nullif(current_setting('app.restore_actual_event_id',true),'') IS NOT NULL THEN
    IF session_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
      WHERE oid='public.restore_suppression_event'::regclass))
      OR current_user IS DISTINCT FROM session_user
      OR NOT EXISTS(SELECT 1 FROM public.restore_actual_deletion_replay_context c
        WHERE c.event_id=nullif(current_setting('app.restore_actual_event_id',true),'')::uuid
          AND c.athlete_id=NEW.athlete_id AND c.kind='recovery_action_deleted'
          AND c.target_id=NEW.action_id AND c.source_txid=txid_current())
    THEN RAISE EXCEPTION 'RESTORE_ACTUAL_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  INSERT INTO public.restore_suppression_event(
    record_version,athlete_id,kind,target_id,occurred_at,
    actual_deletion_revision,actual_previous_revision_id,actual_deleted_revision_id)
  VALUES(2,NEW.athlete_id,'recovery_action_deleted',NEW.action_id,
    deleted_at,NEW.revision,OLD.revision_id,NEW.revision_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_recovery_action_deletion_suppression_event() FROM PUBLIC;

CREATE FUNCTION public.replay_actual_deletion_exact(
  text,text,uuid,uuid,timestamptz,integer,uuid,uuid) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p
  WHERE p.oid='public.replay_actual_deletion_exact(text,text,uuid,uuid,timestamptz,integer,uuid,uuid)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_actual_deletion_replay_receipt%ROWTYPE;
DECLARE context public.restore_actual_deletion_replay_context%ROWTYPE;
DECLARE intake_head public.intake_entry%ROWTYPE;
DECLARE action_head public.recovery_action_log%ROWTYPE;
DECLARE resolved_intake_id text;
DECLARE previous record;
DECLARE tombstone record;
DECLARE history_count bigint;
DECLARE had_event boolean;
DECLARE expected_topic text;
DECLARE expected_payload jsonb;
DECLARE restore_key text;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_ACTUAL_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 NOT IN ('intake_entry_deleted','recovery_action_deleted')
    OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR $5>clock_timestamp()
    OR $6 IS NULL OR $6 NOT BETWEEN 2 AND 2147483646
    OR $7 IS NULL OR $8 IS NULL OR $7=$8
    OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESTORE_ACTUAL_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event e
    WHERE e.event_id=$4 OR (e.athlete_id=$1 AND e.kind=$2 AND e.target_id=$3)
    FOR UPDATE;
  had_event:=FOUND;
  IF had_event AND (existing.event_id IS DISTINCT FROM $4
    OR existing.record_version IS DISTINCT FROM 2
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.kind IS DISTINCT FROM $2
    OR existing.target_id IS DISTINCT FROM $3
    OR existing.occurred_at IS DISTINCT FROM $5
    OR existing.actual_deletion_revision IS DISTINCT FROM $6
    OR existing.actual_previous_revision_id IS DISTINCT FROM $7
    OR existing.actual_deleted_revision_id IS DISTINCT FROM $8
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$4 OR (e.athlete_id=$1 AND e.kind=$2 AND e.target_id=$3))
        AND e.event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_ACTUAL_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_actual_deletion_replay_receipt r
      WHERE r.event_id=$4;
    SELECT * INTO context FROM public.restore_actual_deletion_replay_context c
      WHERE c.event_id=$4;
    IF receipt.event_id IS NULL OR context.event_id IS NULL
      OR receipt.athlete_id IS DISTINCT FROM $1 OR receipt.kind IS DISTINCT FROM $2
      OR receipt.target_id IS DISTINCT FROM $3
      OR receipt.occurred_at IS DISTINCT FROM $5
      OR receipt.deletion_revision IS DISTINCT FROM $6
      OR receipt.previous_revision_id IS DISTINCT FROM $7
      OR receipt.deleted_revision_id IS DISTINCT FROM $8
      OR context.athlete_id IS DISTINCT FROM $1 OR context.kind IS DISTINCT FROM $2
      OR context.target_id IS DISTINCT FROM $3
    THEN RAISE EXCEPTION 'RESTORE_ACTUAL_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_actual_deletion_replay_receipt r
      WHERE r.event_id=$4 OR (r.athlete_id=$1 AND r.kind=$2 AND r.target_id=$3))
    OR EXISTS(SELECT 1 FROM public.restore_actual_deletion_replay_context c
      WHERE c.event_id=$4 OR (c.athlete_id=$1 AND c.kind=$2 AND c.target_id=$3))
  THEN RAISE EXCEPTION 'RESTORE_ACTUAL_RECEIPT_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.athlete_id=$1 AND e.kind='tenant_erased')
    THEN RETURN 'already_applied_by_erasure'; END IF;
    RAISE EXCEPTION 'RESTORE_ACTUAL_TENANT_ERASED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_ACTUAL_TENANT_UNKNOWN'; END IF;
  IF $2='intake_entry_deleted' THEN
    SELECT r.intake_id INTO resolved_intake_id FROM public.intake_entry_revision r
      WHERE r.athlete_id=$1 AND r.revision_id=$3 AND r.revision=1 AND r.status='active';
    IF resolved_intake_id IS NULL THEN RAISE EXCEPTION 'RESTORE_ACTUAL_ORIGIN_ABSENT'; END IF;
    SELECT h.* INTO intake_head FROM public.intake_entry h
      WHERE h.athlete_id=$1 AND h.id=resolved_intake_id FOR UPDATE;
    IF intake_head.id IS NULL THEN RAISE EXCEPTION 'RESTORE_ACTUAL_ABSENT'; END IF;
    SELECT r.revision_id,r.status,r.recorded_at,r.deleted_at,r.deletion_reason
      INTO previous FROM public.intake_entry_revision r
      WHERE r.athlete_id=$1 AND r.intake_id=resolved_intake_id AND r.revision=$6-1;
    SELECT r.revision_id,r.status,r.recorded_at,r.deleted_at,r.deletion_reason
      INTO tombstone FROM public.intake_entry_revision r
      WHERE r.athlete_id=$1 AND r.intake_id=resolved_intake_id AND r.revision=$6;
    SELECT count(*) INTO history_count FROM public.intake_entry_revision r
      WHERE r.athlete_id=$1 AND r.intake_id=resolved_intake_id;
    IF previous.revision_id IS DISTINCT FROM $7 OR previous.status IS DISTINCT FROM 'active'
      OR previous.recorded_at>$5 OR previous.deleted_at IS NOT NULL
      OR (had_event AND history_count<>$6)
      OR (NOT had_event AND history_count<>$6-1)
    THEN RAISE EXCEPTION 'RESTORE_ACTUAL_HISTORY_CONFLICT'; END IF;
    IF had_event THEN
      IF intake_head.status IS DISTINCT FROM 'deleted'
        OR intake_head.current_revision IS DISTINCT FROM $6
        OR intake_head.current_revision_id IS DISTINCT FROM $8
        OR tombstone.revision_id IS DISTINCT FROM $8
        OR tombstone.status IS DISTINCT FROM 'deleted'
        OR tombstone.recorded_at IS DISTINCT FROM $5
        OR tombstone.deleted_at IS DISTINCT FROM $5
        OR tombstone.deletion_reason IS DISTINCT FROM 'user_requested'
      THEN RAISE EXCEPTION 'RESTORE_ACTUAL_STATE_CONFLICT'; END IF;
    ELSE
      IF intake_head.status IS DISTINCT FROM 'active'
        OR intake_head.current_revision IS DISTINCT FROM $6-1
        OR intake_head.current_revision_id IS DISTINCT FROM $7
        OR tombstone.revision_id IS NOT NULL
      THEN RAISE EXCEPTION 'RESTORE_ACTUAL_STATE_CONFLICT'; END IF;
    END IF;
    expected_topic:='nutrition.intake_changed';
    expected_payload:=jsonb_build_object('intakeId',resolved_intake_id,'revision',$6,'action','deleted');
  ELSE
    SELECT h.* INTO action_head FROM public.recovery_action_log h
      WHERE h.athlete_id=$1 AND h.action_id=$3 FOR UPDATE;
    IF action_head.action_id IS NULL THEN RAISE EXCEPTION 'RESTORE_ACTUAL_ABSENT'; END IF;
    SELECT r.revision_id,r.status,r.record_json INTO previous
      FROM public.recovery_action_revision r
      WHERE r.athlete_id=$1 AND r.action_id=$3 AND r.revision=$6-1;
    SELECT r.revision_id,r.status,r.record_json INTO tombstone
      FROM public.recovery_action_revision r
      WHERE r.athlete_id=$1 AND r.action_id=$3 AND r.revision=$6;
    SELECT count(*) INTO history_count FROM public.recovery_action_revision r
      WHERE r.athlete_id=$1 AND r.action_id=$3;
    IF previous.revision_id IS DISTINCT FROM $7 OR previous.status IS DISTINCT FROM 'active'
      OR (had_event AND history_count<>$6)
      OR (NOT had_event AND history_count<>$6-1)
    THEN RAISE EXCEPTION 'RESTORE_ACTUAL_HISTORY_CONFLICT'; END IF;
    IF had_event THEN
      IF action_head.status IS DISTINCT FROM 'deleted'
        OR action_head.revision IS DISTINCT FROM $6
        OR action_head.revision_id IS DISTINCT FROM $8
        OR tombstone.revision_id IS DISTINCT FROM $8
        OR tombstone.status IS DISTINCT FROM 'deleted'
        OR tombstone.record_json IS DISTINCT FROM jsonb_build_object(
          'actionId',$3::text,'revisionId',$8::text,'revision',$6,
          'status','deleted','deletedAt',
          to_char($5 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      THEN RAISE EXCEPTION 'RESTORE_ACTUAL_STATE_CONFLICT'; END IF;
    ELSE
      IF action_head.status IS DISTINCT FROM 'active'
        OR action_head.revision IS DISTINCT FROM $6-1
        OR action_head.revision_id IS DISTINCT FROM $7
        OR tombstone.revision_id IS NOT NULL
      THEN RAISE EXCEPTION 'RESTORE_ACTUAL_STATE_CONFLICT'; END IF;
    END IF;
    expected_topic:='recovery.action.deleted';
    expected_payload:=jsonb_build_object('id',$3::text);
  END IF;
  restore_key:='restore:'||$2||':'||$4::text;
  IF had_event THEN
    IF EXISTS(SELECT 1 FROM public.outbox o WHERE o.athlete_id=$1
      AND (o.id=$4 OR o.idempotency_key=restore_key)
      AND (o.id IS DISTINCT FROM $4 OR o.idempotency_key IS DISTINCT FROM restore_key
        OR o.topic IS DISTINCT FROM expected_topic OR o.payload IS DISTINCT FROM expected_payload))
    THEN RAISE EXCEPTION 'RESTORE_ACTUAL_OUTBOX_CONFLICT'; END IF;
    RETURN 'already_applied';
  END IF;
  INSERT INTO public.restore_actual_deletion_replay_context(
    event_id,athlete_id,kind,target_id,source_txid)
  VALUES($4,$1,$2,$3,txid_current());
  IF $2='intake_entry_deleted' THEN
    INSERT INTO public.intake_entry_revision(athlete_id,intake_id,revision,revision_id,
      status,recorded_at,deleted_at,deletion_reason)
    VALUES($1,resolved_intake_id,$6,$8,'deleted',$5,$5,'user_requested');
    PERFORM set_config('app.restore_actual_event_id',$4::text,true);
    UPDATE public.intake_entry SET current_revision=$6,current_revision_id=$8,status='deleted'
      WHERE athlete_id=$1 AND id=resolved_intake_id;
  ELSE
    INSERT INTO public.recovery_action_revision(athlete_id,action_id,revision,revision_id,
      status,record_json)
    VALUES($1,$3,$6,$8,'deleted',jsonb_build_object('actionId',$3::text,
      'revisionId',$8::text,'revision',$6,'status','deleted',
      'deletedAt',to_char($5 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    PERFORM set_config('app.restore_actual_event_id',$4::text,true);
    UPDATE public.recovery_action_log SET revision=$6,revision_id=$8,status='deleted'
      WHERE athlete_id=$1 AND action_id=$3;
  END IF;
  PERFORM set_config('app.restore_actual_event_id','',true);
  INSERT INTO public.restore_suppression_event(event_id,record_version,athlete_id,kind,
    target_id,occurred_at,actual_deletion_revision,actual_previous_revision_id,
    actual_deleted_revision_id)
  VALUES($4,2,$1,$2,$3,$5,$6,$7,$8);
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES($1,$4,restore_key,expected_topic,expected_payload);
  INSERT INTO public.restore_actual_deletion_replay_receipt(event_id,athlete_id,kind,
    target_id,occurred_at,deletion_revision,previous_revision_id,deleted_revision_id)
  VALUES($4,$1,$2,$3,$5,$6,$7,$8);
  RETURN 'deleted';
END $$;
REVOKE ALL ON FUNCTION public.replay_actual_deletion_exact(
  text,text,uuid,uuid,timestamptz,integer,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.replay_intake_entry_deletion_exact(
  text,uuid,uuid,timestamptz,integer,uuid,uuid) RETURNS text
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $$
  SELECT public.replay_actual_deletion_exact(
    $1,'intake_entry_deleted',$2,$3,$4,$5,$6,$7)
$$;
REVOKE ALL ON FUNCTION public.replay_intake_entry_deletion_exact(
  text,uuid,uuid,timestamptz,integer,uuid,uuid) FROM PUBLIC;
CREATE FUNCTION public.replay_recovery_action_deletion_exact(
  text,uuid,uuid,timestamptz,integer,uuid,uuid) RETURNS text
LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $$
  SELECT public.replay_actual_deletion_exact(
    $1,'recovery_action_deleted',$2,$3,$4,$5,$6,$7)
$$;
REVOKE ALL ON FUNCTION public.replay_recovery_action_deletion_exact(
  text,uuid,uuid,timestamptz,integer,uuid,uuid) FROM PUBLIC;
