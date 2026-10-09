-- New v2 batches carry exact payload UUID membership. Existing receipts remain
-- unknown until a runtime verifies an exact original v2 payload/digest retry.
ALTER TABLE public.healthkit_workout_batch_receipt ADD COLUMN sample_ids uuid[];
CREATE FUNCTION public.valid_healthkit_batch_membership(uuid[],integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT cardinality($1) BETWEEN 1 AND 100 AND cardinality($1)=$2
  AND array_position($1,NULL) IS NULL
  AND cardinality($1)=(SELECT count(DISTINCT value) FROM unnest($1) value);
$$;
ALTER TABLE public.healthkit_workout_batch_receipt ADD CONSTRAINT healthkit_batch_membership_valid
 CHECK(sample_ids IS NULL OR (protocol_version=2 AND purged_at IS NULL
   AND public.valid_healthkit_batch_membership(sample_ids,accepted_count)));
CREATE INDEX healthkit_batch_membership ON public.healthkit_workout_batch_receipt USING gin(sample_ids)
 WHERE purged_at IS NULL;
CREATE FUNCTION public.guard_healthkit_batch_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 -- Every privacy purge removes UUID membership too. Opaque batch IDs remain.
 IF NEW.purged_at IS NOT NULL THEN NEW.sample_ids:=NULL;
 ELSIF TG_OP='INSERT' AND NOT NEW.pre_registration_historical AND NEW.protocol_version=2
   AND NEW.sample_ids IS NULL THEN RAISE EXCEPTION 'RECEIPT_MEMBERSHIP_REQUIRED';
 END IF;
 IF TG_OP='UPDATE' AND NEW.purged_at IS NULL THEN
  IF OLD.sample_ids IS NOT NULL AND NEW.sample_ids IS DISTINCT FROM OLD.sample_ids
   THEN RAISE EXCEPTION 'HEALTHKIT_RECEIPT_MEMBERSHIP_IMMUTABLE'; END IF;
  IF OLD.sample_ids IS NULL AND NEW.sample_ids IS NOT NULL AND
   (OLD.purged_at IS NOT NULL OR OLD.request_digest IS NULL OR OLD.protocol_version<>2
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest)
   THEN RAISE EXCEPTION 'HEALTHKIT_RECEIPT_MEMBERSHIP_REPLAY_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_healthkit_batch_membership() FROM PUBLIC;
CREATE TRIGGER healthkit_batch_membership_guard BEFORE INSERT OR UPDATE ON public.healthkit_workout_batch_receipt
 FOR EACH ROW EXECUTE FUNCTION public.guard_healthkit_batch_membership();

-- Product deregistration retains the global UUID until real object cleanup finishes.
-- No function in this migration writes to the device's original HealthKit store.
CREATE TABLE public.healthkit_workout_deregistration (
  athlete_id text NOT NULL,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  sample_id uuid NOT NULL,
  claim_epoch uuid NOT NULL,
  consent_revision integer NOT NULL CHECK(consent_revision BETWEEN 1 AND 2147483647),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('pending_cleanup','released')),
  registry_revision integer NOT NULL CHECK(registry_revision BETWEEN 1 AND 2147483647),
  object_scopes jsonb NOT NULL DEFAULT '[]',
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  PRIMARY KEY(athlete_id,operation_id),
  UNIQUE(athlete_id,idempotency_key),
  UNIQUE(athlete_id,claim_epoch),
  CHECK((state='released')=(released_at IS NOT NULL))
);
ALTER TABLE public.healthkit_workout_deregistration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.healthkit_workout_deregistration FORCE ROW LEVEL SECURITY;
CREATE POLICY healthkit_workout_deregistration_scope ON public.healthkit_workout_deregistration
  USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
REVOKE ALL ON public.healthkit_workout_deregistration FROM PUBLIC;

CREATE FUNCTION public.valid_healthkit_object_scopes(jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof($1)='array' THEN
   jsonb_array_length($1)<=1000 AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements($1) s WHERE jsonb_typeof(s)<>'object'
      OR (s - 'kind' - 'id')<>'{}'::jsonb
      OR (s->>'kind') NOT IN ('activity','course') OR (s->>'kind') IS NULL
      OR (s->>'id') IS NULL
      OR (s->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   AND (SELECT count(*)=count(DISTINCT s) FROM jsonb_array_elements($1) s)
 ELSE false END;
$$;
ALTER TABLE public.healthkit_workout_deregistration ADD CONSTRAINT healthkit_release_scopes_valid
 CHECK(public.valid_healthkit_object_scopes(object_scopes));

ALTER TABLE public.restore_suppression_event
 ADD COLUMN healthkit_claim_epoch uuid,
 ADD COLUMN healthkit_operation_id uuid,
 ADD COLUMN healthkit_consent_revision integer,
 ADD COLUMN healthkit_registry_previous_revision integer,
 ADD COLUMN healthkit_registry_revision integer,
 ADD COLUMN healthkit_object_scopes jsonb;
-- Preserve every existing legacy constraint expression and extend only the two
-- discriminator constraints. New fields must all be absent on old event kinds.
DO $$ DECLARE constraint_name text; existing_expression text; BEGIN
 FOREACH constraint_name IN ARRAY ARRAY['restore_suppression_event_kind_target_check','restore_suppression_event_record_version_check'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO existing_expression FROM pg_constraint
   WHERE conrelid='public.restore_suppression_event'::regclass AND conname=constraint_name;
  IF existing_expression IS NULL THEN RAISE EXCEPTION 'HEALTHKIT_RELEASE_EVENT_SCHEMA_MISSING'; END IF;
  EXECUTE format('ALTER TABLE public.restore_suppression_event DROP CONSTRAINT %I',constraint_name);
  EXECUTE format('ALTER TABLE public.restore_suppression_event ADD CONSTRAINT %I CHECK ((%s) OR (record_version=3 AND kind IN (''healthkit_workout_deregistration_pending'',''healthkit_workout_deregistration_released'') AND target_id IS NOT NULL))',constraint_name,existing_expression);
 END LOOP;
END $$;
ALTER TABLE public.restore_suppression_event ADD CONSTRAINT healthkit_release_event_fields CHECK(
 (kind IN ('healthkit_workout_deregistration_pending','healthkit_workout_deregistration_released'))
 = (healthkit_claim_epoch IS NOT NULL)
 AND ((healthkit_claim_epoch IS NULL AND healthkit_operation_id IS NULL
   AND healthkit_consent_revision IS NULL AND healthkit_registry_previous_revision IS NULL
   AND healthkit_registry_revision IS NULL AND healthkit_object_scopes IS NULL)
 OR (record_version=3 AND healthkit_claim_epoch IS NOT NULL AND healthkit_operation_id IS NOT NULL
   AND healthkit_consent_revision IS NOT NULL AND healthkit_consent_revision BETWEEN 1 AND 2147483647
   AND healthkit_registry_previous_revision IS NOT NULL AND healthkit_registry_previous_revision BETWEEN 0 AND 2147483646
   AND healthkit_registry_revision IS NOT NULL AND healthkit_registry_revision=healthkit_registry_previous_revision+1
   AND public.valid_healthkit_object_scopes(healthkit_object_scopes)
   AND activity_revision IS NULL
   AND source_kind IS NULL
   AND source_id IS NULL
   AND source_revision IS NULL
   AND source_content_hash IS NULL
   AND resource_access_revision IS NULL
   AND gallery_access_revision IS NULL
   AND consent_previous_revision IS NULL
   AND consent_previous_granted IS NULL
   AND consent_revision IS NULL
   AND consent_granted IS NULL
   AND check_in_revision IS NULL
   AND share_id IS NULL
   AND share_granted_access_revision IS NULL
   AND share_revoked_access_revision IS NULL
   AND course_share_id IS NULL
   AND course_share_epoch IS NULL
   AND course_share_course_revision IS NULL
   AND actual_deletion_revision IS NULL
   AND share_cause_kind IS NULL
   AND share_cause_event_id IS NULL
   AND course_share_revoke_reason IS NULL
   AND course_share_audit_id IS NULL
   AND course_share_audit_occurred_at IS NULL
   AND actual_previous_revision_id IS NULL
   AND actual_deleted_revision_id IS NULL))
);
CREATE UNIQUE INDEX healthkit_release_event_once ON public.restore_suppression_event
 (athlete_id,healthkit_operation_id,kind) WHERE record_version=3;

-- A database fence protects old v2 binaries too. Cleanup deletes remain allowed.
CREATE FUNCTION public.reject_pending_healthkit_reentry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE sample uuid;
BEGIN
 IF TG_TABLE_NAME='activity_source_head' THEN
  IF NEW.kind<>'healthkit' THEN RETURN NEW; END IF;
  sample:=NEW.source_id::uuid;
 ELSE sample:=NEW.sample_id;
 END IF;
 IF EXISTS(SELECT 1 FROM public.healthkit_workout_deregistration d
   JOIN public.healthkit_workout_claim c ON c.athlete_id=d.athlete_id
    AND c.sample_id=d.sample_id AND c.claim_epoch=d.claim_epoch
   WHERE d.athlete_id=NEW.athlete_id AND d.sample_id=sample AND d.state='pending_cleanup')
 THEN RAISE EXCEPTION 'DEREGISTRATION_PENDING'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.reject_pending_healthkit_reentry() FROM PUBLIC;
CREATE TRIGGER healthkit_pending_raw_insert BEFORE INSERT ON public.healthkit_workout_sample
 FOR EACH ROW EXECUTE FUNCTION public.reject_pending_healthkit_reentry();
CREATE TRIGGER healthkit_pending_raw_update BEFORE UPDATE ON public.healthkit_workout_sample
 FOR EACH ROW WHEN(NEW.state='active') EXECUTE FUNCTION public.reject_pending_healthkit_reentry();
CREATE TRIGGER healthkit_pending_binding BEFORE INSERT ON public.healthkit_existing_binding
 FOR EACH ROW EXECUTE FUNCTION public.reject_pending_healthkit_reentry();
CREATE TRIGGER healthkit_pending_source BEFORE INSERT ON public.activity_source_head
 FOR EACH ROW EXECUTE FUNCTION public.reject_pending_healthkit_reentry();

-- Workload-private receipts can contain UUIDs and content digests. Raw deletion
-- invokes existing canonical redaction/citation/track/course cleanup hooks.
CREATE FUNCTION public.purge_healthkit_deregistered_records(text,uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.healthkit_workout_batch_receipt
   WHERE athlete_id=$1 AND purged_at IS NULL AND sample_ids IS NULL)
 THEN RAISE EXCEPTION 'RECEIPT_MEMBERSHIP_REQUIRED'; END IF;
 DELETE FROM public.healthkit_workout_sample WHERE athlete_id=$1 AND sample_id=$2;
 UPDATE public.healthkit_workout_batch_receipt SET request_digest=NULL,purged_at=clock_timestamp()
  WHERE athlete_id=$1 AND purged_at IS NULL AND $2=ANY(sample_ids);
 DELETE FROM public.healthkit_workout_registration_receipt r WHERE r.athlete_id=$1
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.result_json->'claims') c WHERE c->>'sampleId'=$2::text);
 UPDATE public.command_receipt SET request='{"purged":true}',result='{"purged":true}'
  WHERE athlete_id=$1 AND (idempotency_key LIKE 'healthkit-create:%'
    OR idempotency_key LIKE 'healthkit-bind-existing:%') AND result->>'sampleId'=$2::text;
END $$;
REVOKE ALL ON FUNCTION public.purge_healthkit_deregistered_records(text,uuid) FROM PUBLIC;

CREATE FUNCTION public.healthkit_deregistration_result(public.healthkit_workout_deregistration)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schemaVersion',1,'operationId',$1.operation_id,
   'status',$1.state,'registryRevision',$1.registry_revision);
$$;
REVOKE ALL ON FUNCTION public.healthkit_deregistration_result(public.healthkit_workout_deregistration) FROM PUBLIC;

CREATE FUNCTION public.deregister_healthkit_workout(uuid,uuid,integer,integer,text,text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE locked_consent_revision integer; head integer; activity uuid; activity_already_deleted boolean:=false; scopes jsonb:='[]';
DECLARE operation public.healthkit_workout_deregistration%ROWTYPE;
BEGIN
 IF tenant IS NULL THEN RAISE EXCEPTION 'HEALTHKIT_TENANT_REQUIRED'; END IF;
 IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL
   OR $3 NOT BETWEEN 1 AND 2147483647 OR $4 NOT BETWEEN 0 AND 2147483646
   OR $5 IS NULL OR $5 !~ '^[A-Za-z0-9_-]{8,128}$'
   OR $6 IS NULL OR $6 !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 SELECT public.healthkit_ingestion_consent_revision_locked() INTO locked_consent_revision;
 IF locked_consent_revision IS NULL THEN RAISE EXCEPTION 'CONSENT_REQUIRED'; END IF;
 IF locked_consent_revision<>$3 THEN RAISE EXCEPTION 'CONSENT_EPOCH_EXPIRED'; END IF;
 SELECT * INTO operation FROM public.healthkit_workout_deregistration
  WHERE athlete_id=tenant AND idempotency_key=$5;
 IF FOUND THEN
  IF operation.request_digest<>$6 THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  RETURN public.healthkit_deregistration_result(operation);
 END IF;
 SELECT revision INTO head FROM public.healthkit_workout_registry_head WHERE athlete_id=tenant;
 IF coalesce(head,0)<>$4 THEN RAISE EXCEPTION 'REGISTRY_REVISION_CONFLICT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim WHERE athlete_id=tenant
   AND sample_id=$1 AND claim_epoch=$2 AND consent_revision=$3)
 THEN RAISE EXCEPTION 'CLAIM_EPOCH_EXPIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.healthkit_workout_deregistration WHERE athlete_id=tenant
  AND claim_epoch=$2) THEN RAISE EXCEPTION 'DEREGISTRATION_PENDING'; END IF;
 SELECT h.activity_id,c.deleted INTO activity,activity_already_deleted FROM public.activity_source_head h
   JOIN public.activity_canonical c ON c.athlete_id=h.athlete_id AND c.id=h.activity_id
   WHERE h.athlete_id=tenant AND h.kind='healthkit' AND h.source_id=$1::text;
 IF activity IS NOT NULL THEN
  SELECT coalesce(jsonb_agg(s ORDER BY s->>'kind',s->>'id'),'[]') INTO scopes FROM (
    SELECT jsonb_build_object('kind','activity','id',activity) s
    UNION SELECT jsonb_build_object('kind','course','id',course_id)
     FROM public.course_revision_source WHERE athlete_id=tenant AND activity_id=activity
    -- Earlier deletion removed course lineage. Waiting on the same tenant's
    -- remaining course purges is conservative; it never deletes other records
    -- and never includes another tenant's queue. It may delay release because
    -- the exact historical course relationship can no longer be recovered.
    UNION SELECT jsonb_build_object('kind','course','id',scope_id)
      FROM public.object_scope_purge WHERE athlete_id=tenant AND scope_kind='course'
        AND completed_at IS NULL AND activity_already_deleted) q;
 END IF;
 INSERT INTO public.healthkit_workout_deregistration(athlete_id,sample_id,claim_epoch,
   consent_revision,idempotency_key,request_digest,state,registry_revision,object_scopes)
 VALUES(tenant,$1,$2,$3,$5,$6,'pending_cleanup',head+1,scopes) RETURNING * INTO operation;
 PERFORM public.purge_healthkit_deregistered_records(tenant,$1);
 -- Even a raw row previously deleted still has its HealthKit canonical barrier.
 IF activity IS NOT NULL THEN
  UPDATE public.activity_canonical SET deleted=true,revision=revision+1
   WHERE athlete_id=tenant AND id=activity AND NOT deleted;
 END IF;
 UPDATE public.healthkit_workout_registry_head SET revision=head+1 WHERE athlete_id=tenant;
 INSERT INTO public.restore_suppression_event(record_version,athlete_id,kind,target_id,occurred_at,
  healthkit_claim_epoch,healthkit_operation_id,healthkit_consent_revision,
  healthkit_registry_previous_revision,healthkit_registry_revision,healthkit_object_scopes)
 VALUES(3,tenant,'healthkit_workout_deregistration_pending',$1,clock_timestamp(),$2,operation.operation_id,$3,head,head+1,scopes);
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
 VALUES(tenant,gen_random_uuid(),'healthkit-deregister:'||operation.operation_id,'healthkit.workout.deregistration_requested',
   jsonb_build_object('operationId',operation.operation_id));
 RETURN public.healthkit_deregistration_result(operation);
END $$;
REVOKE ALL ON FUNCTION public.deregister_healthkit_workout(uuid,uuid,integer,integer,text,text) FROM PUBLIC;

CREATE FUNCTION public.finalize_healthkit_deregistration(uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE operation public.healthkit_workout_deregistration%ROWTYPE; head integer;
DECLARE locked_consent_revision integer;
BEGIN
 IF tenant IS NULL THEN RAISE EXCEPTION 'HEALTHKIT_TENANT_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 SELECT public.healthkit_ingestion_consent_revision_locked() INTO locked_consent_revision;
 IF locked_consent_revision IS NULL THEN RAISE EXCEPTION 'CONSENT_REQUIRED'; END IF;
 SELECT * INTO operation FROM public.healthkit_workout_deregistration
  WHERE athlete_id=tenant AND operation_id=$1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DEREGISTRATION_NOT_FOUND'; END IF;
 IF operation.state='released' THEN RETURN public.healthkit_deregistration_result(operation); END IF;
 IF locked_consent_revision<>operation.consent_revision THEN RAISE EXCEPTION 'CONSENT_EPOCH_EXPIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim WHERE athlete_id=tenant
  AND sample_id=operation.sample_id AND claim_epoch=operation.claim_epoch)
 THEN RAISE EXCEPTION 'CLAIM_EPOCH_EXPIRED'; END IF;
 -- Rows, object prefixes, named object deletes and in-flight publication fences
 -- must all be clear. A queued purge or dead letter cannot satisfy this gate.
 IF EXISTS(SELECT 1 FROM public.healthkit_workout_sample WHERE athlete_id=tenant AND sample_id=operation.sample_id)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(operation.object_scopes) s
   LEFT JOIN public.object_scope_purge p ON p.athlete_id=tenant AND p.scope_kind=s->>'kind'
     AND p.scope_id=(s->>'id')::uuid
   WHERE p.completed_at IS NULL OR p.lease_owner IS NOT NULL OR p.unrecognized_entries<>0)
  OR EXISTS(SELECT 1 FROM public.resource_object_cleanup q WHERE q.completed_at IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(operation.object_scopes) s
    WHERE starts_with(q.storage_ref,'private/v1/tenants/'||tenant||'/'||
      CASE WHEN s->>'kind'='activity' THEN 'activities' ELSE 'courses' END||'/'||(s->>'id')||'/')))
  OR EXISTS(SELECT 1 FROM public.activity_track_upload_intent i WHERE i.athlete_id=tenant
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(operation.object_scopes) s
      WHERE s->>'kind'='activity' AND i.activity_id=(s->>'id')::uuid)
    AND i.state IN ('prepared','staged','failed')
    AND clock_timestamp()<coalesce(i.publication_lease_until+interval '1 hour',i.expires_at))
  OR EXISTS(SELECT 1 FROM public.course_thumbnail t WHERE t.athlete_id=tenant
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(operation.object_scopes) s
      WHERE s->>'kind'='course' AND t.course_id=(s->>'id')::uuid)
    AND clock_timestamp()<greatest(t.publication_lease_until+interval '1 hour',t.lease_until+interval '1 hour'))
 THEN RETURN public.healthkit_deregistration_result(operation); END IF;
 SELECT revision INTO head FROM public.healthkit_workout_registry_head WHERE athlete_id=tenant;
 IF head IS NULL OR head>=2147483647 THEN RAISE EXCEPTION 'REGISTRY_REVISION_CONFLICT'; END IF;
 DELETE FROM public.healthkit_workout_claim WHERE athlete_id=tenant AND sample_id=operation.sample_id
  AND claim_epoch=operation.claim_epoch;
 UPDATE public.healthkit_workout_registry_head SET revision=head+1 WHERE athlete_id=tenant;
 UPDATE public.healthkit_workout_deregistration SET state='released',released_at=clock_timestamp(),
  registry_revision=head+1 WHERE athlete_id=tenant AND operation_id=$1 RETURNING * INTO operation;
 INSERT INTO public.restore_suppression_event(record_version,athlete_id,kind,target_id,occurred_at,
  healthkit_claim_epoch,healthkit_operation_id,healthkit_consent_revision,
  healthkit_registry_previous_revision,healthkit_registry_revision,healthkit_object_scopes)
 VALUES(3,tenant,'healthkit_workout_deregistration_released',operation.sample_id,clock_timestamp(),operation.claim_epoch,
  operation.operation_id,operation.consent_revision,head,head+1,operation.object_scopes);
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
 VALUES(tenant,gen_random_uuid(),'healthkit-deregister-released:'||operation.operation_id,'healthkit.workout.deregistered',
  jsonb_build_object('operationId',operation.operation_id));
 RETURN public.healthkit_deregistration_result(operation);
END $$;
REVOKE ALL ON FUNCTION public.finalize_healthkit_deregistration(uuid) FROM PUBLIC;

CREATE FUNCTION public.purge_healthkit_deregistrations_on_withdrawal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.kind<>'healthkit' THEN RETURN NULL; END IF; tenant:=OLD.athlete_id;
 ELSE
  IF NEW.kind<>'healthkit' OR NEW.granted THEN RETURN NULL; END IF; tenant:=NEW.athlete_id;
 END IF;
 DELETE FROM public.healthkit_workout_deregistration WHERE athlete_id=tenant;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.purge_healthkit_deregistrations_on_withdrawal() FROM PUBLIC;
CREATE TRIGGER healthkit_deregistration_withdrawal AFTER INSERT OR UPDATE OR DELETE ON public.consent
 FOR EACH ROW EXECUTE FUNCTION public.purge_healthkit_deregistrations_on_withdrawal();
CREATE FUNCTION public.purge_healthkit_deregistrations_on_erasure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN DELETE FROM public.healthkit_workout_deregistration WHERE athlete_id=NEW.athlete_id; RETURN NULL; END $$;
REVOKE ALL ON FUNCTION public.purge_healthkit_deregistrations_on_erasure() FROM PUBLIC;
CREATE TRIGGER healthkit_deregistration_erasure AFTER INSERT ON public.tenant_erasure
 FOR EACH ROW EXECUTE FUNCTION public.purge_healthkit_deregistrations_on_erasure();
-- Backup-chain authenticated replay. Runtime and SECURITY DEFINER sessions cannot
-- invoke it, and an old A epoch never removes B or a newly registered A epoch.
CREATE TABLE public.restore_healthkit_deregistration_replay_receipt (
 event_id uuid PRIMARY KEY REFERENCES public.restore_suppression_event(event_id)
);
REVOKE ALL ON public.restore_healthkit_deregistration_replay_receipt FROM PUBLIC;
CREATE TRIGGER restore_healthkit_deregistration_receipt_immutable
 BEFORE UPDATE OR DELETE ON public.restore_healthkit_deregistration_replay_receipt
 FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_healthkit_deregistration_receipt_immutable_truncate
 BEFORE TRUNCATE ON public.restore_healthkit_deregistration_replay_receipt
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE FUNCTION public.replay_healthkit_workout_deregistration_exact(
 text,uuid,timestamptz,text,uuid,uuid,uuid,integer,integer,integer,jsonb)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE
 oid='public.replay_healthkit_workout_deregistration_exact(text,uuid,timestamptz,text,uuid,uuid,uuid,integer,integer,integer,jsonb)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE pending public.restore_suppression_event%ROWTYPE;
DECLARE operation public.healthkit_workout_deregistration%ROWTYPE;
DECLARE scope jsonb;
BEGIN
 IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=owner_name AND (rolsuper OR rolbypassrls))
 THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_OWNER_REQUIRED'; END IF;
 IF $1 IS NULL OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  OR $2 IS NULL OR $3 IS NULL OR $3>clock_timestamp() OR $4 IS NULL
  OR $4 NOT IN ('healthkit_workout_deregistration_pending','healthkit_workout_deregistration_released')
  OR $5 IS NULL OR $6 IS NULL OR $7 IS NULL OR $8 IS NULL OR $8 NOT BETWEEN 1 AND 2147483647
  OR $9 IS NULL OR $9 NOT BETWEEN 0 AND 2147483646 OR $10 IS DISTINCT FROM $9+1
  OR NOT coalesce(public.valid_healthkit_object_scopes($11),false)
 THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_INVALID_ENTRY'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 SELECT * INTO existing FROM public.restore_suppression_event WHERE event_id=$2
  OR (athlete_id=$1 AND kind=$4 AND healthkit_operation_id=$7);
 IF FOUND THEN
  IF existing.event_id IS DISTINCT FROM $2 OR existing.record_version<>3
   OR existing.athlete_id IS DISTINCT FROM $1 OR existing.kind IS DISTINCT FROM $4
   OR existing.target_id IS DISTINCT FROM $5 OR existing.occurred_at IS DISTINCT FROM $3
   OR existing.healthkit_claim_epoch IS DISTINCT FROM $6 OR existing.healthkit_operation_id IS DISTINCT FROM $7
   OR existing.healthkit_consent_revision IS DISTINCT FROM $8
   OR existing.healthkit_registry_previous_revision IS DISTINCT FROM $9
   OR existing.healthkit_registry_revision IS DISTINCT FROM $10 OR existing.healthkit_object_scopes IS DISTINCT FROM $11
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_EVENT_CONFLICT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.restore_healthkit_deregistration_replay_receipt WHERE event_id=$2)
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_RECEIPT_MISSING'; END IF;
  RETURN 'already_applied';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=$1)
 THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_TENANT_ERASED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id::text=$1)
 THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_TENANT_UNKNOWN'; END IF;
 SELECT * INTO operation FROM public.healthkit_workout_deregistration WHERE athlete_id=$1 AND operation_id=$7;
 IF FOUND AND (operation.sample_id IS DISTINCT FROM $5 OR operation.claim_epoch IS DISTINCT FROM $6
  OR operation.consent_revision IS DISTINCT FROM $8 OR operation.object_scopes IS DISTINCT FROM $11)
 THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_OPERATION_CONFLICT'; END IF;
 IF $4='healthkit_workout_deregistration_released' THEN
  SELECT * INTO pending FROM public.restore_suppression_event WHERE athlete_id=$1
   AND kind='healthkit_workout_deregistration_pending' AND healthkit_operation_id=$7;
  IF NOT FOUND OR pending.target_id IS DISTINCT FROM $5 OR pending.healthkit_claim_epoch IS DISTINCT FROM $6
   OR pending.healthkit_consent_revision IS DISTINCT FROM $8 OR pending.healthkit_object_scopes IS DISTINCT FROM $11
   OR pending.healthkit_registry_revision>$9 OR pending.occurred_at>$3 OR operation.operation_id IS NULL
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_PENDING_REQUIRED'; END IF;
 ELSE
  -- Each affected Activity's exact deletion record must have been applied first.
  IF EXISTS(SELECT 1 FROM public.activity_source_head h JOIN public.activity_canonical c
    ON c.athlete_id=h.athlete_id AND c.id=h.activity_id
    WHERE h.athlete_id=$1 AND h.kind='healthkit' AND h.source_id=$5::text AND NOT c.deleted)
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_ACTIVITY_DELETION_REQUIRED'; END IF;
  -- Do not reconstruct a released old A claim over a current B/A epoch.
  INSERT INTO public.healthkit_workout_claim(sample_id,athlete_id,claim_epoch,consent_revision)
   VALUES($5,$1,$6,$8) ON CONFLICT DO NOTHING;
  INSERT INTO public.healthkit_workout_deregistration(athlete_id,operation_id,sample_id,claim_epoch,
   consent_revision,idempotency_key,request_digest,state,registry_revision,object_scopes,requested_at)
  VALUES($1,$7,$5,$6,$8,'restore-'||$7,repeat('0',64),'pending_cleanup',$10,$11,$3)
   ON CONFLICT(athlete_id,operation_id) DO NOTHING;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim WHERE athlete_id=$1
   AND sample_id=$5 AND claim_epoch<>$6) THEN
  PERFORM public.purge_healthkit_deregistered_records($1,$5);
 END IF;
 INSERT INTO public.healthkit_workout_registry_head(athlete_id,revision) VALUES($1,$10)
 ON CONFLICT(athlete_id) DO UPDATE SET revision=greatest(healthkit_workout_registry_head.revision,EXCLUDED.revision);
 IF $4='healthkit_workout_deregistration_released' THEN
  DELETE FROM public.healthkit_workout_claim WHERE athlete_id=$1 AND sample_id=$5 AND claim_epoch=$6;
  UPDATE public.healthkit_workout_deregistration SET state='released',released_at=$3,registry_revision=$10
   WHERE athlete_id=$1 AND operation_id=$7;
 END IF;
 -- Restored archive objects must be swept again even if production completed.
 -- Restore's global resume gate, not this historical receipt, establishes this.
 FOR scope IN SELECT * FROM jsonb_array_elements($11) LOOP
  IF NOT public.arm_object_scope_purge($1,scope->>'kind',(scope->>'id')::uuid)
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_DEREGISTRATION_PURGE_NOT_ARMED'; END IF;
 END LOOP;
 INSERT INTO public.restore_suppression_event(event_id,record_version,athlete_id,kind,target_id,occurred_at,
  healthkit_claim_epoch,healthkit_operation_id,healthkit_consent_revision,
  healthkit_registry_previous_revision,healthkit_registry_revision,healthkit_object_scopes)
 VALUES($2,3,$1,$4,$5,$3,$6,$7,$8,$9,$10,$11);
 INSERT INTO public.restore_healthkit_deregistration_replay_receipt(event_id) VALUES($2);
 RETURN CASE WHEN $4='healthkit_workout_deregistration_pending' THEN 'pending_cleanup' ELSE 'released' END;
END $$;
REVOKE ALL ON FUNCTION public.replay_healthkit_workout_deregistration_exact(
 text,uuid,timestamptz,text,uuid,uuid,uuid,integer,integer,integer,jsonb) FROM PUBLIC;
