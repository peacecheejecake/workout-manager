-- Owner-only exact replay of v2 share children caused by tenant erasure.
-- The authenticated caller must replay every child and then its parent in one
-- database transaction; the deferred v2 cause constraint enforces the parent.
CREATE TABLE public.restore_erasure_share_replay_receipt (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  resource_id uuid NOT NULL,
  share_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  granted_access_revision integer NOT NULL
    CHECK (granted_access_revision BETWEEN 1 AND 2147483645),
  revoked_access_revision integer NOT NULL
    CHECK (revoked_access_revision=granted_access_revision+1
      AND revoked_access_revision BETWEEN 2 AND 2147483646),
  parent_event_id uuid NOT NULL
);
REVOKE ALL ON TABLE public.restore_erasure_share_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_erasure_share_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_erasure_share_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_erasure_share_replay_receipt_owner
  ON public.restore_erasure_share_replay_receipt
  USING (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_erasure_share_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_erasure_share_replay_receipt'::regclass)));

CREATE FUNCTION public.verify_restore_erasure_share_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.record_version=2 AND e.kind='resource_share_revoked'
      AND e.target_id=NEW.resource_id AND e.share_id=NEW.share_id
      AND e.occurred_at=NEW.occurred_at
      AND e.share_granted_access_revision=NEW.granted_access_revision
      AND e.share_revoked_access_revision=NEW.revoked_access_revision
      AND e.share_cause_kind='tenant_erased'
      AND e.share_cause_event_id=NEW.parent_event_id)
  THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_erasure_share_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_erasure_share_replay_receipt_verify
  BEFORE INSERT ON public.restore_erasure_share_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_erasure_share_replay_receipt();
CREATE TRIGGER restore_erasure_share_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_erasure_share_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_erasure_share_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_erasure_share_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

CREATE FUNCTION public.replay_erasure_share_child_exact(
  text,uuid,uuid,uuid,timestamptz,integer,integer,uuid)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
   WHERE p.oid='public.replay_erasure_share_child_exact(text,uuid,uuid,uuid,timestamptz,integer,integer,uuid)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_erasure_share_replay_receipt%ROWTYPE;
DECLARE head public.resource%ROWTYPE;
DECLARE share public.resource_share%ROWTYPE;
DECLARE other_tenant text;
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE had_event boolean;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR $5>clock_timestamp()
    OR $6 IS NULL OR $6 NOT BETWEEN 1 AND 2147483645
    OR $7 IS NULL OR $7<>$6+1 OR $7>2147483646
    OR $8 IS NULL OR $8=$4
    OR $1 IS DISTINCT FROM nullif(caller_tenant,'')
  THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event e
    WHERE e.event_id=$4 OR (e.athlete_id=$1 AND e.kind='resource_share_revoked'
      AND e.share_id=$3) FOR UPDATE;
  had_event:=FOUND;
  IF had_event AND (existing.event_id IS DISTINCT FROM $4
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.record_version IS DISTINCT FROM 2
    OR existing.kind IS DISTINCT FROM 'resource_share_revoked'
    OR existing.target_id IS DISTINCT FROM $2 OR existing.share_id IS DISTINCT FROM $3
    OR existing.occurred_at IS DISTINCT FROM $5
    OR existing.share_granted_access_revision IS DISTINCT FROM $6
    OR existing.share_revoked_access_revision IS DISTINCT FROM $7
    OR existing.share_cause_kind IS DISTINCT FROM 'tenant_erased'
    OR existing.share_cause_event_id IS DISTINCT FROM $8
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$4 OR (e.athlete_id=$1 AND e.kind='resource_share_revoked'
        AND e.share_id=$3)) AND e.event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_erasure_share_replay_receipt r
      WHERE r.event_id=$4;
    IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.resource_id IS DISTINCT FROM $2 OR receipt.share_id IS DISTINCT FROM $3
      OR receipt.occurred_at IS DISTINCT FROM $5
      OR receipt.granted_access_revision IS DISTINCT FROM $6
      OR receipt.revoked_access_revision IS DISTINCT FROM $7
      OR receipt.parent_event_id IS DISTINCT FROM $8
    THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_erasure_share_replay_receipt r
    WHERE r.event_id=$4)
  THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_RECEIPT_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.event_id=$8 AND r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.event_id=$8 AND e.athlete_id=$1 AND e.kind='tenant_erased'
        AND e.occurred_at=r.occurred_at)
    THEN RETURN 'already_applied_by_erasure'; END IF;
    RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_TENANT_ERASED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_TENANT_UNKNOWN'; END IF;
  SELECT r.* INTO head FROM public.resource r
    WHERE r.athlete_id=$1 AND r.id=$2 FOR UPDATE;
  SELECT s.* INTO share FROM public.resource_share s
    WHERE s.athlete_id=$1 AND s.share_id=$3 FOR UPDATE;
  IF had_event THEN
    IF share.state IS DISTINCT FROM 'revoked' OR share.resource_id IS DISTINCT FROM $2
      OR share.granted_access_revision IS DISTINCT FROM $6
      OR share.revoked_access_revision IS DISTINCT FROM $7
      OR share.revoked_at IS DISTINCT FROM $5 OR head.id IS NULL
    THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_STATE_CONFLICT'; END IF;
    RETURN 'already_applied';
  END IF;
  FOR other_tenant IN SELECT a.athlete_id::text FROM identity_private.account a
    WHERE a.athlete_id::text<>$1 ORDER BY a.athlete_id
  LOOP
    PERFORM set_config('app.athlete_id',other_tenant,true);
    IF EXISTS(SELECT 1 FROM public.resource r WHERE r.athlete_id=other_tenant AND r.id=$2)
      OR EXISTS(SELECT 1 FROM public.resource_share s
        WHERE s.athlete_id=other_tenant AND s.share_id=$3)
    THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_FOREIGN_TARGET'; END IF;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  IF head.id IS NULL OR share.share_id IS NULL
  THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_ABSENT_UNSUPPORTED'; END IF;
  IF share.resource_id<>$2 OR share.state<>'active'
    OR share.granted_access_revision<>$6
    OR share.granted_at>$5 OR share.updated_at>$5
  THEN RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_STATE_CONFLICT'; END IF;
  PERFORM set_config('app.restore_resource_share_event_id',$4::text,true);
  UPDATE public.resource_share SET state='revoked',revoked_at=$5,
    revoked_access_revision=$7,updated_at=$5
    WHERE athlete_id=$1 AND share_id=$3;
  PERFORM set_config('app.restore_resource_share_event_id','',true);
  INSERT INTO public.restore_suppression_event(
    event_id,record_version,athlete_id,kind,target_id,share_id,occurred_at,
    share_granted_access_revision,share_revoked_access_revision,
    share_cause_kind,share_cause_event_id)
    VALUES($4,2,$1,'resource_share_revoked',$2,$3,$5,$6,$7,'tenant_erased',$8);
  INSERT INTO public.restore_erasure_share_replay_receipt(
    event_id,athlete_id,resource_id,share_id,occurred_at,
    granted_access_revision,revoked_access_revision,parent_event_id)
    VALUES($4,$1,$2,$3,$5,$6,$7,$8);
  RETURN 'revoked';
END $$;
REVOKE ALL ON FUNCTION public.replay_erasure_share_child_exact(
  text,uuid,uuid,uuid,timestamptz,integer,integer,uuid) FROM PUBLIC;

-- Preserve the 059 outermost SQL shape, permissions and nested erasure chain.
-- Owner exact replay is allowed only after every active share has been handled
-- by the coordinated child primitive; ordinary source erasure is unchanged.
CREATE OR REPLACE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE parent_id uuid;
DECLARE replay_id text:=nullif(current_setting('app.restore_replay_event_id',true),'');
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  IF replay_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.resource_share s
    WHERE s.athlete_id=$1 AND s.state='active') THEN
    IF session_user IS DISTINCT FROM pg_get_userbyid(
      (SELECT c.relowner FROM pg_catalog.pg_class c
       WHERE c.oid='public.restore_suppression_event'::regclass))
    THEN RAISE EXCEPTION 'RESTORE_REPLAY_OWNER_REQUIRED'; END IF;
    RAISE EXCEPTION 'RESTORE_ERASURE_SHARE_CHILDREN_PENDING';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF replay_id IS NOT NULL THEN
      IF session_user IS DISTINCT FROM pg_get_userbyid(
        (SELECT c.relowner FROM pg_catalog.pg_class c
         WHERE c.oid='public.restore_suppression_event'::regclass))
      THEN RAISE EXCEPTION 'RESTORE_REPLAY_OWNER_REQUIRED'; END IF;
      parent_id:=replay_id::uuid;
    ELSE parent_id:=gen_random_uuid(); END IF;
    INSERT INTO public.restore_share_erasure_context(transaction_id,athlete_id,event_id)
      VALUES(txid_current(),$1,parent_id);
  END IF;
  DELETE FROM public.healthkit_workout_sample WHERE athlete_id=$1;
  DELETE FROM public.healthkit_workout_batch_receipt WHERE athlete_id=$1;
  RETURN public.erase_account_before_healthkit_ingestion($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
