-- Offline owner replay of one authenticated source transaction whose resource
-- deletion emitted version-2 share-revocation children. The caller supplies the
-- complete ordered children; this function never discovers and invents events.
CREATE TABLE public.restore_resource_compound_replay_receipt (
  parent_event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  resource_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  access_revision integer NOT NULL CHECK (access_revision BETWEEN 2 AND 2147483646),
  ordered_children jsonb NOT NULL CHECK (jsonb_typeof(ordered_children)='array'
    AND jsonb_array_length(ordered_children) BETWEEN 1 AND 256)
);
REVOKE ALL ON public.restore_resource_compound_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_resource_compound_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_resource_compound_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_resource_compound_replay_receipt_owner
  ON public.restore_resource_compound_replay_receipt
  USING (session_user=pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
    WHERE oid='public.restore_resource_compound_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
    WHERE oid='public.restore_resource_compound_replay_receipt'::regclass)));
CREATE TRIGGER restore_resource_compound_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_resource_compound_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_resource_compound_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_resource_compound_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

CREATE FUNCTION public.verify_restore_resource_compound_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE child jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.parent_event_id AND e.athlete_id=NEW.athlete_id
      AND e.kind='resource_deleted' AND e.target_id=NEW.resource_id
      AND e.occurred_at=NEW.occurred_at
      AND e.resource_access_revision=NEW.access_revision)
    OR (SELECT count(*) FROM public.restore_suppression_event e
      WHERE e.share_cause_event_id=NEW.parent_event_id
        AND e.share_cause_kind='resource_deleted')
      <>jsonb_array_length(NEW.ordered_children)
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_RECEIPT_CONFLICT'; END IF;
  FOR child IN SELECT value FROM jsonb_array_elements(NEW.ordered_children) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE e.event_id=(child->>'eventId')::uuid
        AND e.athlete_id=NEW.athlete_id AND e.record_version=2
        AND e.kind='resource_share_revoked' AND e.target_id=NEW.resource_id
        AND e.share_id=(child->>'shareId')::uuid
        AND e.occurred_at=(child->>'occurredAt')::timestamptz
        AND e.share_granted_access_revision=(child->>'shareGrantedAccessRevision')::integer
        AND e.share_revoked_access_revision=NEW.access_revision
        AND e.share_cause_kind='resource_deleted'
        AND e.share_cause_event_id=NEW.parent_event_id)
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_RECEIPT_CONFLICT'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_resource_compound_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_resource_compound_replay_receipt_verify
  BEFORE INSERT ON public.restore_resource_compound_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_resource_compound_replay_receipt();

-- Keep the 081 zero-share behavior, but never let it generate new child IDs.
ALTER FUNCTION public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer)
  RENAME TO replay_resource_deletion_exact_without_compound_guard;
REVOKE ALL ON FUNCTION public.replay_resource_deletion_exact_without_compound_guard(
  text,uuid,uuid,timestamptz,integer) FROM PUBLIC;
CREATE FUNCTION public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
  WHERE oid='public.restore_suppression_event'::regclass));
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  IF EXISTS(SELECT 1 FROM public.resource_share s
    WHERE s.athlete_id=$1 AND s.resource_id=$2 AND s.state='active')
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_REQUIRED'; END IF;
  RETURN public.replay_resource_deletion_exact_without_compound_guard($1,$2,$3,$4,$5);
END $$;
REVOKE ALL ON FUNCTION public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer)
  FROM PUBLIC;

-- orderedChildren objects carry exactly:
-- eventId, athleteId, targetId, shareId, occurredAt,
-- shareGrantedAccessRevision, shareRevokedAccessRevision,
-- shareCauseKind, shareCauseEventId, recordVersion.
CREATE FUNCTION public.replay_resource_deletion_compound_exact(
  text,uuid,uuid,timestamptz,integer,jsonb)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p
  WHERE p.oid='public.replay_resource_deletion_compound_exact(text,uuid,uuid,timestamptz,integer,jsonb)'::regprocedure));
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE parent public.restore_suppression_event%ROWTYPE;
DECLARE parent_receipt public.restore_resource_replay_receipt%ROWTYPE;
DECLARE compound_receipt public.restore_resource_compound_replay_receipt%ROWTYPE;
DECLARE head public.resource%ROWTYPE;
DECLARE share public.resource_share%ROWTYPE;
DECLARE child jsonb;
DECLARE child_id uuid;
DECLARE child_share_id uuid;
DECLARE child_time timestamptz;
DECLARE grant_rev integer;
DECLARE other_tenant text;
DECLARE seen_events uuid[]:='{}';
DECLARE seen_shares uuid[]:='{}';
DECLARE had_parent boolean;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $4>clock_timestamp()
    OR $5 IS NULL OR $5 NOT BETWEEN 2 AND 2147483646
    OR $1 IS DISTINCT FROM nullif(caller_tenant,'')
    OR $6 IS NULL OR jsonb_typeof($6)<>'array'
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_INVALID_ENTRY'; END IF;
  IF jsonb_array_length($6) NOT BETWEEN 1 AND 256
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_INVALID_ENTRY'; END IF;
  FOR child IN SELECT value FROM jsonb_array_elements($6) LOOP
    IF jsonb_typeof(child)<>'object'
      OR (SELECT count(*) FROM jsonb_object_keys(child))<>10
      OR NOT child ?& ARRAY['eventId','athleteId','targetId','shareId','occurredAt',
        'shareGrantedAccessRevision','shareRevokedAccessRevision','shareCauseKind',
        'shareCauseEventId','recordVersion']
      OR jsonb_typeof(child->'recordVersion')<>'number'
      OR child->>'recordVersion'<>'2'
      OR child->>'athleteId' IS DISTINCT FROM $1
      OR child->>'targetId' IS DISTINCT FROM $2::text
      OR child->>'shareCauseKind'<>'resource_deleted'
      OR child->>'shareCauseEventId' IS DISTINCT FROM $3::text
      OR child->>'eventId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR child->>'shareId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR jsonb_typeof(child->'occurredAt')<>'string'
      OR jsonb_typeof(child->'shareGrantedAccessRevision')<>'number'
      OR jsonb_typeof(child->'shareRevokedAccessRevision')<>'number'
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_INVALID_CHILD'; END IF;
    child_id:=(child->>'eventId')::uuid;
    child_share_id:=(child->>'shareId')::uuid;
    child_time:=(child->>'occurredAt')::timestamptz;
    grant_rev:=(child->>'shareGrantedAccessRevision')::integer;
    IF child_id=$3 OR child_id=ANY(seen_events) OR child_share_id=ANY(seen_shares)
      OR child_time<$4 OR child_time>clock_timestamp()
      OR grant_rev NOT BETWEEN 1 AND 2147483645 OR grant_rev>=$5
      OR (child->>'shareRevokedAccessRevision')::integer<>$5
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_INVALID_CHILD'; END IF;
    seen_events:=array_append(seen_events,child_id);
    seen_shares:=array_append(seen_shares,child_share_id);
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT e.* INTO parent FROM public.restore_suppression_event e
    WHERE e.event_id=$3 OR (e.athlete_id=$1 AND e.kind='resource_deleted'
      AND e.target_id=$2) FOR UPDATE;
  had_parent:=FOUND;
  IF had_parent AND (parent.event_id IS DISTINCT FROM $3
    OR parent.athlete_id IS DISTINCT FROM $1 OR parent.kind<>'resource_deleted'
    OR parent.target_id IS DISTINCT FROM $2 OR parent.occurred_at IS DISTINCT FROM $4
    OR parent.resource_access_revision IS DISTINCT FROM $5
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$3 OR (e.athlete_id=$1 AND e.kind='resource_deleted'
        AND e.target_id=$2)) AND e.event_id<>parent.event_id))
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_EVENT_CONFLICT'; END IF;
  IF had_parent THEN
    SELECT * INTO parent_receipt FROM public.restore_resource_replay_receipt r
      WHERE r.event_id=$3;
    SELECT * INTO compound_receipt FROM public.restore_resource_compound_replay_receipt r
      WHERE r.parent_event_id=$3;
    IF parent_receipt.event_id IS NULL OR compound_receipt.parent_event_id IS NULL
      OR parent_receipt.athlete_id IS DISTINCT FROM $1
      OR parent_receipt.target_id IS DISTINCT FROM $2
      OR parent_receipt.occurred_at IS DISTINCT FROM $4
      OR parent_receipt.resource_access_revision IS DISTINCT FROM $5
      OR compound_receipt.athlete_id IS DISTINCT FROM $1
      OR compound_receipt.resource_id IS DISTINCT FROM $2
      OR compound_receipt.occurred_at IS DISTINCT FROM $4
      OR compound_receipt.access_revision IS DISTINCT FROM $5
      OR compound_receipt.ordered_children IS DISTINCT FROM $6
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_resource_compound_replay_receipt r
    WHERE r.parent_event_id=$3)
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_RECEIPT_CONFLICT'; END IF;
  IF NOT had_parent AND EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_TENANT_ERASED'; END IF;
  IF had_parent AND EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
    AND NOT EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.athlete_id=$1 AND e.kind='tenant_erased')
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_TENANT_ERASED'; END IF;
  IF NOT had_parent AND NOT EXISTS(SELECT 1 FROM identity_private.account a
    WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_TENANT_UNKNOWN'; END IF;
  SELECT r.* INTO head FROM public.resource r WHERE r.athlete_id=$1 AND r.id=$2 FOR UPDATE;
  IF NOT had_parent THEN
    FOR other_tenant IN SELECT a.athlete_id::text FROM identity_private.account a
      WHERE a.athlete_id::text<>$1 ORDER BY a.athlete_id
    LOOP
      PERFORM set_config('app.athlete_id',other_tenant,true);
      IF EXISTS(SELECT 1 FROM public.resource r WHERE r.athlete_id=other_tenant AND r.id=$2)
        OR EXISTS(SELECT 1 FROM public.resource_share s
          WHERE s.athlete_id=other_tenant AND s.share_id=ANY(seen_shares))
      THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_FOREIGN_TARGET'; END IF;
    END LOOP;
    PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
    IF head.id IS NULL OR head.deleted_at IS NOT NULL
      OR head.access_revision<>$5-1 OR head.updated_at>$4
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_STATE_CONFLICT'; END IF;
    IF (SELECT count(*) FROM public.resource_share s WHERE s.athlete_id=$1
      AND s.resource_id=$2 AND s.state='active')<>jsonb_array_length($6)
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_SHARE_SET_MISMATCH'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
    AND (head.deleted_at IS DISTINCT FROM $4 OR head.access_revision IS DISTINCT FROM $5
      OR head.include_for_coach IS DISTINCT FROM false
      OR EXISTS(SELECT 1 FROM public.resource_share s WHERE s.athlete_id=$1
        AND s.resource_id=$2 AND s.state='active')
      OR NOT EXISTS(SELECT 1 FROM public.resource_access_audit a
        WHERE a.athlete_id=$1 AND a.resource_id=$2 AND a.event_id=$3
          AND a.action='resource_deleted' AND a.access_revision=$5
          AND a.occurred_at=$4))
  THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_STATE_CONFLICT'; END IF;
  FOR child IN SELECT value FROM jsonb_array_elements($6) LOOP
    child_id:=(child->>'eventId')::uuid;
    child_share_id:=(child->>'shareId')::uuid;
    child_time:=(child->>'occurredAt')::timestamptz;
    grant_rev:=(child->>'shareGrantedAccessRevision')::integer;
    IF had_parent THEN
      IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
        JOIN public.restore_resource_share_replay_receipt r ON r.event_id=e.event_id
        WHERE e.event_id=child_id AND e.athlete_id=$1 AND e.record_version=2
          AND e.kind='resource_share_revoked' AND e.target_id=$2
          AND e.share_id=child_share_id AND e.occurred_at=child_time
          AND e.share_granted_access_revision=grant_rev
          AND e.share_revoked_access_revision=$5
          AND e.share_cause_kind='resource_deleted' AND e.share_cause_event_id=$3
          AND r.athlete_id=$1 AND r.resource_id=$2 AND r.share_id=child_share_id
          AND r.occurred_at=child_time AND r.granted_access_revision=grant_rev
          AND r.revoked_access_revision=$5)
      THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_CHILD_CONFLICT'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
        AND NOT EXISTS(SELECT 1 FROM public.resource_share s
          WHERE s.athlete_id=$1 AND s.share_id=child_share_id AND s.resource_id=$2
            AND s.state='revoked' AND s.revoked_at=child_time
            AND s.granted_access_revision=grant_rev AND s.revoked_access_revision=$5)
      THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_STATE_CONFLICT'; END IF;
    ELSE
      IF EXISTS(SELECT 1 FROM public.restore_suppression_event e WHERE e.event_id=child_id
        OR (e.athlete_id=$1 AND e.kind='resource_share_revoked' AND e.share_id=child_share_id))
      THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_CHILD_CONFLICT'; END IF;
      SELECT s.* INTO share FROM public.resource_share s
        WHERE s.athlete_id=$1 AND s.share_id=child_share_id FOR UPDATE;
      IF share.share_id IS NULL OR share.resource_id IS DISTINCT FROM $2
        OR share.state IS DISTINCT FROM 'active'
        OR share.granted_access_revision IS DISTINCT FROM grant_rev
        OR share.granted_at>child_time OR share.updated_at>child_time
      THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_SHARE_SET_MISMATCH'; END IF;
    END IF;
  END LOOP;
  IF had_parent THEN
    IF (SELECT count(*) FROM public.restore_suppression_event e
      WHERE e.athlete_id=$1 AND e.share_cause_kind='resource_deleted'
        AND e.share_cause_event_id=$3)<>jsonb_array_length($6)
    THEN RAISE EXCEPTION 'RESTORE_RESOURCE_COMPOUND_CHILD_CONFLICT'; END IF;
    RETURN CASE WHEN EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
      THEN 'already_applied_by_erasure' ELSE 'already_applied' END;
  END IF;
  PERFORM set_config('app.restore_resource_event_id',$3::text,true);
  UPDATE public.resource SET access_revision=$5,updated_at=$4,deleted_at=$4,
    include_for_coach=false,coach_use_enabled_at=NULL WHERE athlete_id=$1 AND id=$2;
  PERFORM set_config('app.restore_resource_event_id','',true);
  INSERT INTO public.resource_access_audit(
    athlete_id,event_id,resource_id,action,access_revision,share_id,
    grantee_kind,grantee_principal_id,occurred_at)
    VALUES($1,$3,$2,'resource_deleted',$5,NULL,NULL,NULL,$4);
  INSERT INTO public.restore_suppression_event(
    event_id,athlete_id,kind,target_id,occurred_at,resource_access_revision)
    VALUES($3,$1,'resource_deleted',$2,$4,$5);
  INSERT INTO public.restore_resource_replay_receipt(
    event_id,athlete_id,target_id,occurred_at,resource_access_revision)
    VALUES($3,$1,$2,$4,$5);
  FOR child IN SELECT value FROM jsonb_array_elements($6) LOOP
    child_id:=(child->>'eventId')::uuid;
    child_share_id:=(child->>'shareId')::uuid;
    child_time:=(child->>'occurredAt')::timestamptz;
    grant_rev:=(child->>'shareGrantedAccessRevision')::integer;
    SELECT s.* INTO share FROM public.resource_share s
      WHERE s.athlete_id=$1 AND s.share_id=child_share_id FOR UPDATE;
    PERFORM set_config('app.restore_resource_share_event_id',child_id::text,true);
    UPDATE public.resource_share SET state='revoked',revoked_at=child_time,
      revoked_access_revision=$5,updated_at=child_time
      WHERE athlete_id=$1 AND share_id=child_share_id;
    PERFORM set_config('app.restore_resource_share_event_id','',true);
    INSERT INTO public.resource_access_audit(
      athlete_id,event_id,resource_id,action,access_revision,share_id,
      grantee_kind,grantee_principal_id,occurred_at)
      VALUES($1,child_id,$2,'share_revoked',$5,child_share_id,
        share.grantee_kind,share.grantee_principal_id,child_time);
    INSERT INTO public.restore_suppression_event(
      event_id,record_version,athlete_id,kind,target_id,share_id,occurred_at,
      share_granted_access_revision,share_revoked_access_revision,
      share_cause_kind,share_cause_event_id)
      VALUES(child_id,2,$1,'resource_share_revoked',$2,child_share_id,child_time,
        grant_rev,$5,'resource_deleted',$3);
    INSERT INTO public.restore_resource_share_replay_receipt(
      event_id,athlete_id,resource_id,share_id,occurred_at,
      granted_access_revision,revoked_access_revision)
      VALUES(child_id,$1,$2,child_share_id,child_time,grant_rev,$5);
  END LOOP;
  PERFORM public.enqueue_resource_derived_cleanup($2,'resource_deleted');
  PERFORM public.tombstone_resource_receipts($2);
  PERFORM public.cancel_resource_uploads($2,'RESOURCE_DELETED');
  PERFORM public.enqueue_resource_object_cleanup($2,'resource_deleted');
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES($1,$3,'restore:resource_deleted:'||$3::text,'resource.deleted',
      jsonb_build_object('resourceId',$2::text,'versionId',NULL));
  INSERT INTO public.restore_resource_compound_replay_receipt(
    parent_event_id,athlete_id,resource_id,occurred_at,access_revision,ordered_children)
    VALUES($3,$1,$2,$4,$5,$6);
  RETURN 'deleted';
END $$;
REVOKE ALL ON FUNCTION public.replay_resource_deletion_compound_exact(
  text,uuid,uuid,timestamptz,integer,jsonb) FROM PUBLIC;
