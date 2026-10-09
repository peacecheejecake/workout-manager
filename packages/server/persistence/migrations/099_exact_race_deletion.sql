-- M2-02f: individual deletion and exact restore suppression. Verification is recorded separately.
-- Keep 098 erasure wrappers unchanged; suppression and replay receipts survive erasure.
ALTER TABLE public.restore_suppression_event
 ADD COLUMN race_previous_revision integer,
 ADD COLUMN race_deleted_revision integer;
DO $migration$
DECLARE constraint_name text; existing_expression text;
BEGIN
 FOREACH constraint_name IN ARRAY ARRAY['restore_suppression_event_kind_target_check','restore_suppression_event_record_version_check'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO existing_expression FROM pg_constraint
   WHERE conrelid='public.restore_suppression_event'::regclass AND conname=constraint_name;
  IF existing_expression IS NULL THEN RAISE EXCEPTION 'RACE_DELETION_EVENT_SCHEMA_MISSING'; END IF;
  EXECUTE format('ALTER TABLE public.restore_suppression_event DROP CONSTRAINT %I',constraint_name);
  EXECUTE format('ALTER TABLE public.restore_suppression_event ADD CONSTRAINT %I CHECK ((%s) OR (record_version=4 AND kind IN (''race_event_deleted'',''race_result_deleted'',''training_best_deleted'') AND target_id IS NOT NULL))',constraint_name,existing_expression);
 END LOOP;
END $migration$;
ALTER TABLE public.restore_suppression_event ADD CONSTRAINT race_deletion_event_fields CHECK(
 (kind IN ('race_event_deleted','race_result_deleted','training_best_deleted'))
 = (race_previous_revision IS NOT NULL)
 AND ((race_previous_revision IS NULL AND race_deleted_revision IS NULL)
 OR (record_version=4 AND target_id IS NOT NULL
  AND race_previous_revision IS NOT NULL AND race_previous_revision BETWEEN 1 AND 2147483647
  AND race_deleted_revision IS NOT NULL
  AND race_deleted_revision=least(race_previous_revision::bigint+1,2147483647)
  AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
  AND source_revision IS NULL AND source_content_hash IS NULL
  AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
  AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
  AND consent_revision IS NULL AND consent_granted IS NULL AND check_in_revision IS NULL
  AND share_id IS NULL AND share_granted_access_revision IS NULL AND share_revoked_access_revision IS NULL
  AND course_share_id IS NULL AND course_share_epoch IS NULL AND course_share_course_revision IS NULL
  AND actual_deletion_revision IS NULL AND share_cause_kind IS NULL AND share_cause_event_id IS NULL
  AND course_share_revoke_reason IS NULL AND course_share_audit_id IS NULL
  AND course_share_audit_occurred_at IS NULL
  AND actual_previous_revision_id IS NULL AND actual_deleted_revision_id IS NULL
  AND healthkit_claim_epoch IS NULL AND healthkit_operation_id IS NULL
  AND healthkit_consent_revision IS NULL AND healthkit_registry_previous_revision IS NULL
  AND healthkit_registry_revision IS NULL AND healthkit_object_scopes IS NULL))
);
CREATE UNIQUE INDEX restore_race_deletion_once ON public.restore_suppression_event
 (athlete_id,kind,target_id) WHERE record_version=4;

CREATE TABLE public.restore_race_deletion_replay_receipt (
 event_id uuid PRIMARY KEY REFERENCES public.restore_suppression_event(event_id),
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 kind text NOT NULL CHECK(kind IN ('race_event_deleted','race_result_deleted','training_best_deleted')),
 target_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
 previous_revision integer NOT NULL CHECK(previous_revision BETWEEN 1 AND 2147483647),
 deleted_revision integer NOT NULL CHECK(deleted_revision=least(previous_revision::bigint+1,2147483647)),
 UNIQUE(athlete_id,kind,target_id)
);
REVOKE ALL ON public.restore_race_deletion_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_race_deletion_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_race_deletion_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_race_deletion_receipt_owner ON public.restore_race_deletion_replay_receipt
 USING(session_user=pg_get_userbyid((SELECT relowner FROM pg_class
   WHERE oid='public.restore_race_deletion_replay_receipt'::regclass)))
 WITH CHECK(session_user=pg_get_userbyid((SELECT relowner FROM pg_class
   WHERE oid='public.restore_race_deletion_replay_receipt'::regclass)));
CREATE FUNCTION public.verify_restore_race_deletion_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
  WHERE e.event_id=NEW.event_id AND e.record_version=4 AND e.athlete_id=NEW.athlete_id
   AND e.kind=NEW.kind AND e.target_id=NEW.target_id AND e.occurred_at=NEW.occurred_at
   AND e.race_previous_revision=NEW.previous_revision AND e.race_deleted_revision=NEW.deleted_revision)
 THEN RAISE EXCEPTION 'RESTORE_RACE_RECEIPT_CONFLICT'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_race_deletion_receipt() FROM PUBLIC;
CREATE TRIGGER restore_race_deletion_receipt_verify BEFORE INSERT ON public.restore_race_deletion_replay_receipt
 FOR EACH ROW EXECUTE FUNCTION public.verify_restore_race_deletion_receipt();
CREATE TRIGGER restore_race_deletion_receipt_immutable BEFORE UPDATE OR DELETE ON public.restore_race_deletion_replay_receipt
 FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_race_deletion_receipt_immutable_truncate BEFORE TRUNCATE ON public.restore_race_deletion_replay_receipt
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- Internal owner-only primitive. No runtime grant and no caller-settable replay GUC.
-- Its callers already hold lifecycle then tenant locks. It never writes Activity/Course/Plan.
CREATE FUNCTION public.purge_race_entity_private(text,text,uuid,integer,timestamptz) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE table_name text; prior record; item record; next_revision integer;
DECLARE current_matches boolean; purged_count integer; changed boolean:=false; next_values jsonb;
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  OR $2 IS NULL OR $2 NOT IN ('race-event','race-result','training-best') OR $3 IS NULL
  OR $4 IS NULL OR $4 NOT BETWEEN 1 AND 2147483647 OR $5 IS NULL
 THEN RAISE EXCEPTION 'RACE_DELETE_INVALID_REQUEST'; END IF;
 table_name:=replace($2,'-','_');
 EXECUTE format('SELECT revision,deleted,recorded_at,updated_at FROM public.%I WHERE athlete_id=$1 AND id=$2 FOR UPDATE',table_name)
  INTO prior USING $1,$3;
 IF prior.revision IS NOT NULL THEN
  -- Replay may cover a newer restored head. Privacy suppression wins; no values are reconstructed.
  next_revision:=greatest($4,CASE WHEN prior.deleted THEN prior.revision
   ELSE least(prior.revision::bigint+1,2147483647)::integer END);
  EXECUTE format('UPDATE public.%I SET values_json=NULL,deleted=true,revision=$3,updated_at=greatest(updated_at,recorded_at,$4) WHERE athlete_id=$1 AND id=$2',table_name)
   USING $1,$3,next_revision,$5;
  changed:=NOT prior.deleted OR prior.revision IS DISTINCT FROM next_revision;
 ELSE
  EXECUTE format('INSERT INTO public.%I(athlete_id,id,revision,values_json,deleted,recorded_at,updated_at) VALUES($1,$2,$3,NULL,true,$4,$4)',table_name)
   USING $1,$3,$4,$5;
  changed:=true;
 END IF;
 EXECUTE format('DELETE FROM public.%I WHERE athlete_id=$1 AND entity_id=$2',table_name||'_revision') USING $1,$3;
 GET DIAGNOSTICS purged_count=ROW_COUNT;
 changed:=changed OR purged_count>0;
 IF changed THEN
  INSERT INTO public.race_collection_head(athlete_id,kind,revision,privacy_generation) VALUES($1,$2,1,1)
   ON CONFLICT(athlete_id,kind) DO UPDATE SET
    revision=least(race_collection_head.revision::bigint+1,2147483647)::integer,
    privacy_generation=race_collection_head.privacy_generation+1;
 END IF;
 IF $2='race-event' THEN
  FOR item IN SELECT h.id,h.revision,h.values_json,h.deleted,h.recorded_at,h.updated_at
   FROM public.race_result h WHERE h.athlete_id=$1 AND
    (h.values_json->>'raceEventId'=$3::text OR EXISTS(
      SELECT 1 FROM public.race_result_revision r WHERE r.athlete_id=$1 AND r.entity_id=h.id
       AND r.values_json->>'raceEventId'=$3::text)) ORDER BY h.id FOR UPDATE OF h
  LOOP
   current_matches:=coalesce(item.values_json->>'raceEventId'=$3::text,false);
   DELETE FROM public.race_result_revision WHERE athlete_id=$1 AND entity_id=item.id
    AND values_json->>'raceEventId'=$3::text;
   GET DIAGNOSTICS purged_count=ROW_COUNT;
   IF current_matches THEN
    next_revision:=least(item.revision::bigint+1,2147483647)::integer;
    next_values:=jsonb_set(item.values_json,'{raceEventId}','null'::jsonb,false);
    UPDATE public.race_result SET values_json=next_values,revision=next_revision,
      updated_at=greatest(updated_at,recorded_at,$5) WHERE athlete_id=$1 AND id=item.id;
    IF next_revision>item.revision THEN
     INSERT INTO public.race_result_revision(athlete_id,entity_id,revision,values_json,created_at)
      VALUES($1,item.id,next_revision,next_values,greatest(item.updated_at,item.recorded_at,$5));
    END IF;
   END IF;
   IF current_matches OR purged_count>0 THEN
    INSERT INTO public.race_collection_head(athlete_id,kind,revision,privacy_generation) VALUES($1,'race-result',1,1)
     ON CONFLICT(athlete_id,kind) DO UPDATE SET
      revision=least(race_collection_head.revision::bigint+1,2147483647)::integer,
      privacy_generation=race_collection_head.privacy_generation+1;
   END IF;
  END LOOP;
 END IF;
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION public.purge_race_entity_private(text,text,uuid,integer,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.delete_race_entity(text,uuid,integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE table_name text; prior record; deletion_revision integer; occurred_at timestamptz;
DECLARE event_kind text;
BEGIN
 IF tenant IS NULL THEN RAISE EXCEPTION 'RACE_TENANT_REQUIRED'; END IF;
 IF $1 IS NULL OR $1 NOT IN ('race-event','race-result','training-best') OR $2 IS NULL
  OR $3 IS NULL OR $3 NOT BETWEEN 1 AND 2147483647
 THEN RAISE EXCEPTION 'RACE_DELETE_INVALID_REQUEST'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=tenant)
 THEN RAISE EXCEPTION 'TENANT_ERASED'; END IF;
 table_name:=replace($1,'-','_'); event_kind:=table_name||'_deleted';
 EXECUTE format('SELECT revision,deleted,recorded_at,updated_at FROM public.%I WHERE athlete_id=$1 AND id=$2 FOR UPDATE',table_name)
  INTO prior USING tenant,$2;
 IF prior.revision IS NULL OR prior.deleted THEN RAISE EXCEPTION 'RACE_NOT_FOUND'; END IF;
 IF prior.revision<>$3 THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 deletion_revision:=least(prior.revision::bigint+1,2147483647)::integer;
 occurred_at:=greatest(clock_timestamp(),prior.recorded_at,prior.updated_at);
 PERFORM public.purge_race_entity_private(tenant,$1,$2,deletion_revision,occurred_at);
 INSERT INTO public.restore_suppression_event(record_version,athlete_id,kind,target_id,occurred_at,
   race_previous_revision,race_deleted_revision)
  VALUES(4,tenant,event_kind,$2,occurred_at,prior.revision,deletion_revision);
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
  VALUES(tenant,gen_random_uuid(),'race-delete:'||$1||':'||$2::text,'race.entity_deleted',
   jsonb_build_object('kind',$1,'id',$2,'revision',deletion_revision));
 RETURN jsonb_build_object('id',$2,'revision',deletion_revision);
END $$;
REVOKE ALL ON FUNCTION public.delete_race_entity(text,uuid,integer) FROM PUBLIC;
-- Root grants EXECUTE ONLY this signature to runtime, keeps normal minimal receipt
-- write/replay before the helper and receipt insert after it in one tenant transaction.

-- Do not let existing UPDATE grants bypass deletion or resurrect a tombstone.
CREATE FUNCTION public.guard_race_head_deletion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.id IS DISTINCT FROM OLD.id)
 THEN RAISE EXCEPTION 'RACE_IDENTITY_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND OLD.deleted AND NOT NEW.deleted
 THEN RAISE EXCEPTION 'RACE_DELETED_REENTRY'; END IF;
 IF (TG_OP='INSERT' AND NEW.deleted) OR
  (TG_OP='UPDATE' AND NEW.deleted IS DISTINCT FROM OLD.deleted)
 THEN
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  THEN RAISE EXCEPTION 'RACE_DELETION_OWNER_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_race_head_deletion() FROM PUBLIC;
CREATE FUNCTION public.guard_race_suppressed_reentry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 THEN RAISE EXCEPTION 'RACE_TENANT_MISMATCH'; END IF;
 IF NOT NEW.deleted AND EXISTS(SELECT 1 FROM public.restore_suppression_event
   WHERE athlete_id=NEW.athlete_id AND kind=TG_TABLE_NAME||'_deleted' AND target_id=NEW.id AND record_version=4)
 THEN RAISE EXCEPTION 'RACE_DELETED_REENTRY'; END IF;
 IF TG_TABLE_NAME='race_result' AND NEW.values_json->>'raceEventId' IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.race_event e WHERE e.athlete_id=NEW.athlete_id
   AND e.id::text=NEW.values_json->>'raceEventId' AND e.deleted)
 THEN RAISE EXCEPTION 'RACE_EVENT_DELETED_REFERENCE'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_race_suppressed_reentry() FROM PUBLIC;
DO $migration$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['race_event','race_result','training_best'] LOOP
  EXECUTE format('CREATE TRIGGER race_head_deletion_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_race_head_deletion()',table_name);
  EXECUTE format('CREATE TRIGGER race_suppressed_reentry_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_race_suppressed_reentry()',table_name);
 END LOOP;
END $migration$;

-- INSERT privilege on historical ledgers must not recreate private erased values.
CREATE FUNCTION public.guard_race_revision_reentry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE table_name text; active_head boolean;
BEGIN
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 THEN RAISE EXCEPTION 'RACE_TENANT_MISMATCH'; END IF;
 table_name:=left(TG_TABLE_NAME,length(TG_TABLE_NAME)-9);
 EXECUTE format('SELECT NOT deleted FROM public.%I WHERE athlete_id=$1 AND id=$2',table_name)
  INTO active_head USING NEW.athlete_id,NEW.entity_id;
 IF active_head IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM public.restore_suppression_event
  WHERE athlete_id=NEW.athlete_id AND kind=table_name||'_deleted'
   AND target_id=NEW.entity_id AND record_version=4)
 THEN RAISE EXCEPTION 'RACE_DELETED_REENTRY'; END IF;
 IF table_name='race_result' AND NEW.values_json->>'raceEventId' IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.race_event e WHERE e.athlete_id=NEW.athlete_id
   AND e.id::text=NEW.values_json->>'raceEventId' AND e.deleted)
 THEN RAISE EXCEPTION 'RACE_EVENT_DELETED_REFERENCE'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_race_revision_reentry() FROM PUBLIC;
DO $migration$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['race_event_revision','race_result_revision','training_best_revision'] LOOP
  EXECUTE format('CREATE TRIGGER race_revision_reentry_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_race_revision_reentry()',table_name);
 END LOOP;
END $migration$;

CREATE FUNCTION public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid((SELECT proowner FROM pg_proc WHERE
 oid='public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_race_deletion_replay_receipt%ROWTYPE;
DECLARE had_event boolean; entity_kind text; changed boolean;
BEGIN
 IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=owner_name AND (rolsuper OR rolbypassrls))
 THEN RAISE EXCEPTION 'RESTORE_RACE_OWNER_REQUIRED'; END IF;
 IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  OR $2 IS NULL OR $2 NOT IN ('race_event_deleted','race_result_deleted','training_best_deleted')
  OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR $5>clock_timestamp()
  OR $6 IS NULL OR $6 NOT BETWEEN 1 AND 2147483647 OR $7 IS NULL
  OR $7 IS DISTINCT FROM least($6::bigint+1,2147483647)::integer
 THEN RAISE EXCEPTION 'RESTORE_RACE_INVALID_ENTRY'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 SELECT * INTO existing FROM public.restore_suppression_event e
  WHERE e.event_id=$4 OR (e.athlete_id=$1 AND e.kind=$2 AND e.target_id=$3) FOR UPDATE;
 had_event:=FOUND;
 IF had_event AND (existing.event_id IS DISTINCT FROM $4 OR existing.record_version IS DISTINCT FROM 4
  OR existing.athlete_id IS DISTINCT FROM $1 OR existing.kind IS DISTINCT FROM $2
  OR existing.target_id IS DISTINCT FROM $3 OR existing.occurred_at IS DISTINCT FROM $5
  OR existing.race_previous_revision IS DISTINCT FROM $6 OR existing.race_deleted_revision IS DISTINCT FROM $7
  OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
   WHERE (e.event_id=$4 OR (e.athlete_id=$1 AND e.kind=$2 AND e.target_id=$3)) AND e.event_id<>existing.event_id))
 THEN RAISE EXCEPTION 'RESTORE_RACE_EVENT_CONFLICT'; END IF;
 SELECT * INTO receipt FROM public.restore_race_deletion_replay_receipt r
  WHERE r.event_id=$4 OR (r.athlete_id=$1 AND r.kind=$2 AND r.target_id=$3);
 IF FOUND AND (NOT had_event OR receipt.event_id IS DISTINCT FROM $4
  OR receipt.athlete_id IS DISTINCT FROM $1 OR receipt.kind IS DISTINCT FROM $2
  OR receipt.target_id IS DISTINCT FROM $3 OR receipt.occurred_at IS DISTINCT FROM $5
  OR receipt.previous_revision IS DISTINCT FROM $6 OR receipt.deleted_revision IS DISTINCT FROM $7)
 THEN RAISE EXCEPTION 'RESTORE_RACE_RECEIPT_CONFLICT'; END IF;
 -- Original production events in a backup have no restore receipt yet. An exact
 -- event match is allowed, but does not itself establish successful suppression.
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=$1) THEN
  IF NOT EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
   JOIN public.restore_suppression_event e ON e.event_id=r.event_id
   WHERE r.athlete_id=$1 AND r.kind='tenant_erased' AND e.athlete_id=$1 AND e.kind='tenant_erased')
  THEN RAISE EXCEPTION 'RESTORE_RACE_TENANT_ERASED'; END IF;
  changed:=false;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_RACE_TENANT_UNKNOWN'; END IF;
  entity_kind:=replace(left($2,length($2)-8),'_','-');
  changed:=public.purge_race_entity_private($1,entity_kind,$3,$7,$5);
 END IF;
 IF NOT had_event THEN
  INSERT INTO public.restore_suppression_event(event_id,record_version,athlete_id,kind,target_id,occurred_at,
   race_previous_revision,race_deleted_revision) VALUES($4,4,$1,$2,$3,$5,$6,$7);
 END IF;
 IF receipt.event_id IS NULL THEN
  INSERT INTO public.restore_race_deletion_replay_receipt(event_id,athlete_id,kind,target_id,occurred_at,previous_revision,deleted_revision)
   VALUES($4,$1,$2,$3,$5,$6,$7);
 END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=$1) THEN RETURN 'already_applied_by_erasure'; END IF;
 RETURN CASE WHEN changed THEN 'applied' ELSE 'already_applied' END;
END $$;
REVOKE ALL ON FUNCTION public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer) FROM PUBLIC;
-- No runtime grants on replay, internal purge, replay receipts, guard or old wrappers.
