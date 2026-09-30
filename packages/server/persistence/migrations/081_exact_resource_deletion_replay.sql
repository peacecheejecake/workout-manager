-- Owner-only offline replay of a resource deletion already authenticated by the
-- caller's complete backup-bound chain. An absent resource cannot be rebuilt
-- from this minimal event and is deliberately refused.
CREATE TABLE public.restore_resource_replay_receipt (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  target_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  resource_access_revision integer NOT NULL
    CHECK (resource_access_revision BETWEEN 1 AND 2147483646)
);
REVOKE ALL ON TABLE public.restore_resource_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_resource_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_resource_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_resource_replay_receipt_owner ON public.restore_resource_replay_receipt
  USING (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_resource_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_resource_replay_receipt'::regclass)));

CREATE FUNCTION public.verify_restore_resource_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.kind='resource_deleted' AND e.target_id=NEW.target_id
      AND e.occurred_at=NEW.occurred_at
      AND e.resource_access_revision=NEW.resource_access_revision)
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_resource_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_resource_replay_receipt_verify
  BEFORE INSERT ON public.restore_resource_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_resource_replay_receipt();
CREATE TRIGGER restore_resource_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_resource_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_resource_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_resource_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- The ordinary head transition still runs every cleanup trigger. Suppress only
-- its newly generated event while the owner replays the authenticated identity.
CREATE OR REPLACE FUNCTION public.record_resource_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_resource_event_id',true),'');
BEGIN
  IF replay_id IS NOT NULL THEN
    IF session_user IS DISTINCT FROM pg_get_userbyid(
      (SELECT c.relowner FROM pg_catalog.pg_class c
       WHERE c.oid='public.restore_suppression_event'::regclass))
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,resource_access_revision)
  VALUES(NEW.athlete_id,'resource_deleted',NEW.id,NEW.deleted_at,NEW.access_revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_resource_deletion_suppression_event() FROM PUBLIC;

CREATE FUNCTION public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
   WHERE p.oid='public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_resource_replay_receipt%ROWTYPE;
DECLARE head public.resource%ROWTYPE;
DECLARE other_tenant text;
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE had_event boolean;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $2::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $3 IS NULL OR $4 IS NULL OR $4>clock_timestamp()
    OR $5 IS NULL OR $5 NOT BETWEEN 1 AND 2147483646
    OR $1 IS DISTINCT FROM nullif(caller_tenant,'')
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event
    WHERE event_id=$3 OR (athlete_id=$1 AND kind='resource_deleted' AND target_id=$2)
    FOR UPDATE;
  had_event:=FOUND;
  IF had_event AND (existing.event_id IS DISTINCT FROM $3
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.kind IS DISTINCT FROM 'resource_deleted'
    OR existing.target_id IS DISTINCT FROM $2 OR existing.occurred_at IS DISTINCT FROM $4
    OR existing.resource_access_revision IS DISTINCT FROM $5
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$3 OR (e.athlete_id=$1 AND e.kind='resource_deleted' AND e.target_id=$2))
        AND e.event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_resource_replay_receipt r WHERE r.event_id=$3;
    IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.target_id IS DISTINCT FROM $2 OR receipt.occurred_at IS DISTINCT FROM $4
      OR receipt.resource_access_revision IS DISTINCT FROM $5
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_resource_replay_receipt r WHERE r.event_id=$3)
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_RECEIPT_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.athlete_id=$1 AND e.kind='tenant_erased')
    THEN RETURN 'already_applied_by_erasure'; END IF;
    RAISE EXCEPTION 'RESTORE_RESOURCE_TENANT_ERASED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_TENANT_UNKNOWN'; END IF;
  SELECT r.* INTO head
    FROM public.resource r WHERE r.athlete_id=$1 AND r.id=$2 FOR UPDATE;
  IF had_event THEN
    IF head.deleted_at IS DISTINCT FROM $4 OR head.access_revision IS DISTINCT FROM $5
      OR head.include_for_coach IS DISTINCT FROM false
      OR EXISTS(SELECT 1 FROM public.resource_share s
        WHERE s.athlete_id=$1 AND s.resource_id=$2 AND s.state='active')
      OR NOT EXISTS(SELECT 1 FROM public.resource_access_audit a
        WHERE a.athlete_id=$1 AND a.resource_id=$2
          AND a.event_id=$3 AND a.action='resource_deleted'
          AND a.access_revision=$5 AND a.occurred_at=$4)
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_STATE_CONFLICT'; END IF;
    RETURN 'already_applied';
  END IF;
  -- FORCE RLS hides a foreign resource from the caller's tenant. Probe each
  -- live tenant under the same owner session before declaring this head absent.
  FOR other_tenant IN SELECT a.athlete_id::text FROM identity_private.account a
    WHERE a.athlete_id::text<>$1 ORDER BY a.athlete_id
  LOOP
    PERFORM set_config('app.athlete_id',other_tenant,true);
    IF EXISTS(SELECT 1 FROM public.resource r WHERE r.athlete_id=other_tenant AND r.id=$2)
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_FOREIGN_RESOURCE'; END IF;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  IF head.access_revision IS NULL THEN RAISE EXCEPTION 'RESTORE_RESOURCE_ABSENT_UNSUPPORTED'; END IF;
  IF head.deleted_at IS NOT NULL OR head.access_revision<>$5-1
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_STATE_CONFLICT'; END IF;
  PERFORM set_config('app.restore_resource_event_id',$3::text,true);
  UPDATE public.resource SET access_revision=$5,updated_at=$4,deleted_at=$4,
    include_for_coach=false,coach_use_enabled_at=NULL
    WHERE athlete_id=$1 AND id=$2;
  PERFORM set_config('app.restore_resource_event_id','',true);
  INSERT INTO public.resource_access_audit(
    athlete_id,event_id,resource_id,action,access_revision,share_id,
    grantee_kind,grantee_principal_id,occurred_at)
    VALUES($1,$3,$2,'resource_deleted',$5,NULL,NULL,NULL,$4);
  PERFORM public.revoke_resource_shares($2,'RESOURCE_DELETED');
  PERFORM public.enqueue_resource_derived_cleanup($2,'resource_deleted');
  PERFORM public.tombstone_resource_receipts($2);
  PERFORM public.cancel_resource_uploads($2,'RESOURCE_DELETED');
  PERFORM public.enqueue_resource_object_cleanup($2,'resource_deleted');
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES($1,$3,'restore:resource_deleted:'||$3::text,'resource.deleted',
      jsonb_build_object('resourceId',$2::text,'versionId',NULL));
  INSERT INTO public.restore_suppression_event(
    event_id,athlete_id,kind,target_id,occurred_at,resource_access_revision)
    VALUES($3,$1,'resource_deleted',$2,$4,$5);
  INSERT INTO public.restore_resource_replay_receipt(
    event_id,athlete_id,target_id,occurred_at,resource_access_revision)
    VALUES($3,$1,$2,$4,$5);
  RETURN 'deleted';
END $$;
REVOKE ALL ON FUNCTION public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer)
  FROM PUBLIC;
