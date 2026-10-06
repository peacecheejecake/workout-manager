-- Bounded owner-only SQL100 family loading into a CLOSED SQL102 target.
-- No full archive proof, admission, reopen, or implicit restore authority.
-- The host authenticates independent archive expectations before calling this seam.
CREATE SCHEMA wm_app_load;
REVOKE ALL ON SCHEMA wm_app_load FROM PUBLIC;
CREATE TABLE wm_app_load.target (
 singleton boolean PRIMARY KEY CHECK(singleton), nonce uuid NOT NULL,
 schema_hash text NOT NULL CHECK(schema_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state='CLOSED'),
 state_version integer NOT NULL CHECK(state_version>0)
);
CREATE TABLE wm_app_load.descriptor (
 run_id uuid PRIMARY KEY, owner_xid bigint NOT NULL UNIQUE,
 proof_hash text NOT NULL CHECK(proof_hash ~ '^[a-f0-9]{64}$'),
 purpose text NOT NULL CHECK(purpose='owner_restore_app_family'),
 expected_control_revision bigint NOT NULL CHECK(expected_control_revision>=1),
 target_incarnation uuid NOT NULL,
 target_nonce uuid NOT NULL, schema_hash text NOT NULL,
 expected_state_version integer NOT NULL, athlete_id text NOT NULL,
 expected_count integer NOT NULL CHECK(expected_count BETWEEN 1 AND 8),
 expected_digest text NOT NULL CHECK(expected_digest ~ '^[a-f0-9]{64}$'), sealed boolean NOT NULL DEFAULT false
);
CREATE TABLE wm_app_load.evidence_stage (
 run_id uuid NOT NULL REFERENCES wm_app_load.descriptor(run_id), subject_id uuid NOT NULL,
 source_row jsonb NOT NULL, row_digest text NOT NULL CHECK(row_digest ~ '^[a-f0-9]{64}$'),
 original_binding jsonb, original_absence boolean NOT NULL,
 tuple_digest text NOT NULL CHECK(tuple_digest ~ '^[a-f0-9]{64}$'), consumed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(run_id,subject_id),
 CHECK((original_absence AND original_binding IS NULL OR NOT original_absence AND original_binding IS NOT NULL) IS TRUE)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['target','descriptor','evidence_stage'] LOOP
  EXECUTE format('ALTER TABLE wm_app_load.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE wm_app_load.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY live_owner ON wm_app_load.%I USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass))) WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass)))',t,'wm_app_load.'||t,'wm_app_load.'||t);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA wm_app_load FROM PUBLIC;
CREATE FUNCTION wm_app_load.owner_check() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE own text:=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_app_load.target'::regclass));
BEGIN
 IF session_user IS DISTINCT FROM own OR current_user IS DISTINCT FROM own
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=own AND (rolsuper OR rolbypassrls))
 OR own IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.core_evidence_snapshot'::regclass))
 OR own IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass))
 OR own IS DISTINCT FROM pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='wm_app_load.capture_evidence()'::regprocedure))
 THEN RAISE EXCEPTION 'LOAD_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION wm_app_load.hash_json(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex') $$;
CREATE FUNCTION wm_app_load.row_digest(v public.core_evidence_snapshot) RETURNS text LANGUAGE sql STABLE STRICT SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$ SELECT wm_app_load.hash_json(to_jsonb(v)) $$;
CREATE FUNCTION wm_app_load.assert_context(run uuid) RETURNS wm_app_load.descriptor LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE d wm_app_load.descriptor; t wm_app_load.target;
BEGIN
 PERFORM wm_app_load.owner_check();
 SELECT * INTO STRICT d FROM wm_app_load.descriptor WHERE run_id=run;
 -- Global exclusive always precedes target row, lifecycle77206 and tenant0 locks.
 IF (public.assert_restore_processing_closed(d.expected_control_revision,d.target_nonce,d.target_incarnation)->>'generationId')::uuid IS DISTINCT FROM public.current_restore_generation() THEN RAISE EXCEPTION 'LOAD_GENERATION_REJECTED'; END IF;
 SELECT * INTO STRICT t FROM wm_app_load.target WHERE singleton FOR UPDATE;
 IF d.owner_xid IS DISTINCT FROM txid_current() OR t.state<>'CLOSED'
 OR d.target_nonce IS DISTINCT FROM t.nonce OR d.schema_hash IS DISTINCT FROM t.schema_hash
 OR d.expected_state_version IS DISTINCT FROM t.state_version
 OR d.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 THEN RAISE EXCEPTION 'LOAD_CONTEXT_REJECTED'; END IF;
 RETURN d;
END $$;
CREATE FUNCTION wm_app_load.begin_stage(run uuid,proof text,purpose text,nonce uuid,schema_hash text,state_version integer,athlete text,count integer,set_digest text,control_revision bigint,incarnation uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t wm_app_load.target;
BEGIN
 PERFORM wm_app_load.owner_check();
 IF (public.assert_restore_processing_closed(control_revision,nonce,incarnation)->>'generationId')::uuid IS DISTINCT FROM public.current_restore_generation() THEN RAISE EXCEPTION 'LOAD_GENERATION_REJECTED'; END IF;
 SELECT * INTO STRICT t FROM wm_app_load.target WHERE singleton FOR UPDATE;
 IF nonce IS NULL OR schema_hash IS NULL OR state_version IS NULL OR athlete IS NULL
 OR t.state<>'CLOSED' OR nonce IS DISTINCT FROM t.nonce OR schema_hash IS DISTINCT FROM t.schema_hash OR state_version IS DISTINCT FROM t.state_version
 OR athlete IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 OR NOT EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id=athlete::uuid)
 OR EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=athlete)
 THEN RAISE EXCEPTION 'LOAD_TARGET_REJECTED'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(athlete,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(athlete,0));
 INSERT INTO wm_app_load.descriptor(run_id,owner_xid,proof_hash,purpose,target_nonce,schema_hash,expected_state_version,athlete_id,expected_count,expected_digest,expected_control_revision,target_incarnation)
 VALUES(run,txid_current(),proof,purpose,nonce,schema_hash,state_version,athlete,count,set_digest,control_revision,incarnation);
END $$;
CREATE FUNCTION wm_app_load.stage_evidence(run uuid,row_json jsonb,row_hash text,binding jsonb,absence boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE d wm_app_load.descriptor; r public.core_evidence_snapshot; b public.evidence_app_admission_binding;
BEGIN
 d:=wm_app_load.assert_context(run);
 IF d.sealed OR jsonb_typeof(row_json) IS DISTINCT FROM 'object' OR absence IS NULL
 OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(row_json) k) IS DISTINCT FROM ARRAY['athlete_id','body','created_at','id','purged_reason','thread_id']
 THEN RAISE EXCEPTION 'LOAD_ROW_REJECTED'; END IF;
 r:=jsonb_populate_record(NULL::public.core_evidence_snapshot,row_json);
 IF r.athlete_id IS DISTINCT FROM d.athlete_id OR r.id IS NULL OR r.thread_id IS NULL OR r.created_at IS NULL
 OR row_hash IS DISTINCT FROM wm_app_load.row_digest(r)
 OR NOT EXISTS(SELECT 1 FROM public.coaching_thread WHERE athlete_id=d.athlete_id AND id=r.thread_id)
 THEN RAISE EXCEPTION 'LOAD_ROW_REJECTED'; END IF;
 IF absence THEN
  IF binding IS NOT NULL THEN RAISE EXCEPTION 'LOAD_BINDING_REJECTED'; END IF;
 ELSE
  IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
  OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(binding) k) IS DISTINCT FROM ARRAY['app_revision','athlete_id','binding_version','captured_at','evidence_snapshot_id']
  THEN RAISE EXCEPTION 'LOAD_BINDING_REJECTED'; END IF;
  b:=jsonb_populate_record(NULL::public.evidence_app_admission_binding,binding);
  IF b.athlete_id IS DISTINCT FROM r.athlete_id OR b.evidence_snapshot_id IS DISTINCT FROM r.id OR b.binding_version IS DISTINCT FROM 1 OR b.app_revision IS NULL OR b.app_revision NOT BETWEEN 1 AND 2147483647 OR b.captured_at IS NULL
  THEN RAISE EXCEPTION 'LOAD_BINDING_REJECTED'; END IF;
 END IF;
 IF (SELECT count(*) FROM wm_app_load.evidence_stage WHERE run_id=run)>=d.expected_count THEN RAISE EXCEPTION 'LOAD_CAP_REJECTED'; END IF;
 INSERT INTO wm_app_load.evidence_stage(run_id,subject_id,source_row,row_digest,original_binding,original_absence,tuple_digest)
 VALUES(run,r.id,to_jsonb(r),row_hash,CASE WHEN absence THEN NULL ELSE to_jsonb(b) END,absence,
 wm_app_load.hash_json(jsonb_build_object('row',row_hash,'binding',CASE WHEN absence THEN NULL ELSE to_jsonb(b) END,'absence',absence)));
END $$;
CREATE FUNCTION wm_app_load.seal_stage(run uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE d wm_app_load.descriptor; n bigint; h text;
BEGIN
 d:=wm_app_load.assert_context(run);
 SELECT count(*),wm_app_load.hash_json(jsonb_agg(jsonb_build_object('id',subject_id,'digest',tuple_digest) ORDER BY subject_id)) INTO n,h FROM wm_app_load.evidence_stage WHERE run_id=run;
 IF d.sealed OR n IS DISTINCT FROM d.expected_count::bigint OR h IS DISTINCT FROM d.expected_digest THEN RAISE EXCEPTION 'LOAD_INVENTORY_REJECTED'; END IF;
 UPDATE wm_app_load.descriptor SET sealed=true WHERE run_id=run;
END $$;
CREATE FUNCTION wm_app_load.capture_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE d wm_app_load.descriptor; s wm_app_load.evidence_stage; b public.evidence_app_admission_binding; revision integer; tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
 IF tenant IS DISTINCT FROM NEW.athlete_id THEN RAISE EXCEPTION 'APP_BINDING_TENANT_MISMATCH'; END IF;
 IF session_user=current_user AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_app_load.target'::regclass)) THEN
  SELECT * INTO d FROM wm_app_load.descriptor WHERE owner_xid=txid_current();
  IF FOUND THEN
   d:=wm_app_load.assert_context(d.run_id);
   SELECT * INTO s FROM wm_app_load.evidence_stage WHERE run_id=d.run_id AND subject_id=NEW.id;
   IF NOT FOUND OR NOT d.sealed OR s.consumed OR s.row_digest IS DISTINCT FROM wm_app_load.row_digest(NEW) OR d.athlete_id IS DISTINCT FROM NEW.athlete_id THEN RAISE EXCEPTION 'LOAD_ROW_REJECTED'; END IF;
   IF NOT s.original_absence THEN
    b:=jsonb_populate_record(NULL::public.evidence_app_admission_binding,s.original_binding);
    INSERT INTO public.evidence_app_admission_binding SELECT b.*;
   END IF;
   UPDATE wm_app_load.evidence_stage SET consumed=true WHERE run_id=d.run_id AND subject_id=NEW.id;
   RETURN NEW;
  END IF;
 END IF;
 -- Original SQL100 normal runtime/owner live gate. Never trusts caller GUC flags.
 revision:=public.require_app_admission_revision(NULL);
 INSERT INTO public.evidence_app_admission_binding(athlete_id,evidence_snapshot_id,app_revision) VALUES(tenant,NEW.id,revision);
 RETURN NEW;
END $$;
CREATE FUNCTION wm_app_load.load_evidence(run uuid,subject uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE d wm_app_load.descriptor; s wm_app_load.evidence_stage; r public.core_evidence_snapshot;
BEGIN
 d:=wm_app_load.assert_context(run);
 SELECT * INTO STRICT s FROM wm_app_load.evidence_stage WHERE run_id=run AND subject_id=subject;
 IF NOT d.sealed OR s.consumed THEN RAISE EXCEPTION 'LOAD_STAGE_REJECTED'; END IF;
 r:=jsonb_populate_record(NULL::public.core_evidence_snapshot,s.source_row);
 INSERT INTO public.core_evidence_snapshot SELECT r.*;
END $$;
CREATE FUNCTION wm_app_load.finish_stage(run uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE d wm_app_load.descriptor; s wm_app_load.evidence_stage; r public.core_evidence_snapshot; b public.evidence_app_admission_binding;
BEGIN
 d:=wm_app_load.assert_context(run);
 IF NOT d.sealed OR (SELECT count(*) FROM wm_app_load.evidence_stage WHERE run_id=run AND consumed) IS DISTINCT FROM d.expected_count::bigint THEN RAISE EXCEPTION 'LOAD_INCOMPLETE'; END IF;
 FOR s IN SELECT * FROM wm_app_load.evidence_stage WHERE run_id=run LOOP
  SELECT * INTO r FROM public.core_evidence_snapshot WHERE athlete_id=d.athlete_id AND id=s.subject_id;
  IF NOT FOUND OR wm_app_load.row_digest(r) IS DISTINCT FROM s.row_digest THEN RAISE EXCEPTION 'LOAD_POSTCONDITION_REJECTED'; END IF;
  SELECT * INTO b FROM public.evidence_app_admission_binding WHERE athlete_id=d.athlete_id AND evidence_snapshot_id=s.subject_id;
  IF (s.original_absence AND FOUND) OR (NOT s.original_absence AND (NOT FOUND OR to_jsonb(b) IS DISTINCT FROM s.original_binding)) THEN RAISE EXCEPTION 'LOAD_POSTCONDITION_REJECTED'; END IF;
 END LOOP;
END $$;
CREATE FUNCTION wm_app_load.guard_inventory() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM wm_app_load.owner_check();
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LOAD_INVENTORY_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='descriptor' THEN
  IF TG_OP='INSERT' AND (NEW.owner_xid IS DISTINCT FROM txid_current() OR NEW.sealed) THEN RAISE EXCEPTION 'LOAD_XID_REJECTED'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)-'sealed') IS DISTINCT FROM (to_jsonb(NEW)-'sealed') OR OLD.sealed OR NOT NEW.sealed) THEN RAISE EXCEPTION 'LOAD_INVENTORY_IMMUTABLE'; END IF;
 ELSIF TG_OP='UPDATE' AND ((to_jsonb(OLD)-'consumed') IS DISTINCT FROM (to_jsonb(NEW)-'consumed') OR OLD.consumed OR NOT NEW.consumed) THEN RAISE EXCEPTION 'LOAD_INVENTORY_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER descriptor_inventory_guard BEFORE INSERT OR UPDATE OR DELETE ON wm_app_load.descriptor FOR EACH ROW EXECUTE FUNCTION wm_app_load.guard_inventory();
CREATE TRIGGER evidence_inventory_guard BEFORE UPDATE OR DELETE ON wm_app_load.evidence_stage FOR EACH ROW EXECUTE FUNCTION wm_app_load.guard_inventory();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_app_load FROM PUBLIC;
DROP TRIGGER capture_app_binding ON public.core_evidence_snapshot;
CREATE TRIGGER capture_app_binding AFTER INSERT ON public.core_evidence_snapshot FOR EACH ROW EXECUTE FUNCTION wm_app_load.capture_evidence();

-- Bounded family extension; historical private v2/v3 probes are preserved separately.
ALTER TABLE wm_app_load.descriptor DROP CONSTRAINT descriptor_expected_count_check;
ALTER TABLE wm_app_load.descriptor ADD CHECK(expected_count BETWEEN 1 AND 32);
CREATE TABLE wm_app_load.family_stage (
 run_id uuid NOT NULL REFERENCES wm_app_load.descriptor(run_id), ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 32),
 relation_name text NOT NULL, source_row jsonb NOT NULL, source_digest text NOT NULL,
 binding_row jsonb, original_absence boolean NOT NULL, witness jsonb,
 tuple_digest text NOT NULL, bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 4198400), consumed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(run_id,ordinal)
);
ALTER TABLE wm_app_load.family_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_app_load.family_stage FORCE ROW LEVEL SECURITY;
CREATE POLICY live_owner ON wm_app_load.family_stage USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_app_load.family_stage'::regclass))) WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_app_load.family_stage'::regclass)));
REVOKE ALL ON wm_app_load.family_stage FROM PUBLIC;
CREATE TRIGGER family_inventory_guard BEFORE UPDATE OR DELETE ON wm_app_load.family_stage FOR EACH ROW EXECUTE FUNCTION wm_app_load.guard_inventory();
CREATE FUNCTION wm_app_load.relation_rank(t text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE t
 WHEN 'plan_snapshot' THEN 1 WHEN 'nutrition_plan_version' THEN 1 WHEN 'routine_blueprint_version' THEN 1
 WHEN 'recovery_strategy_version' THEN 1 WHEN 'routine_schedule_version' THEN 1
 WHEN 'plan_head' THEN 2 WHEN 'nutrition_plan_head' THEN 2 WHEN 'routine_blueprint_head' THEN 2 WHEN 'recovery_strategy_head' THEN 2 WHEN 'routine_schedule_head' THEN 2
 WHEN 'routine_occurrence' THEN 3 WHEN 'coaching_thread' THEN 3 WHEN 'coaching_message' THEN 4 WHEN 'core_evidence_snapshot' THEN 5
 WHEN 'coaching_run' THEN 6 WHEN 'coaching_analysis_output' THEN 7 WHEN 'coaching_decision' THEN 7 WHEN 'coaching_proposal' THEN 8
 WHEN 'coaching_candidate' THEN 9 WHEN 'integrated_candidate_v4' THEN 9 WHEN 'integrated_approval_v4' THEN 10
 WHEN 'command_receipt' THEN 11 WHEN 'plan_history' THEN 12 WHEN 'nutrition_plan_history' THEN 12 WHEN 'recovery_strategy_history' THEN 12 WHEN 'routine_schedule_history' THEN 12
 WHEN 'approval_app_admission_binding' THEN 13 END $$;
CREATE FUNCTION wm_app_load.typed_row(t text,v jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE keys text[]; expected text[]; result jsonb;
BEGIN
 IF wm_app_load.relation_rank(t) IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'object' OR octet_length(v::text)>4194304 THEN RAISE EXCEPTION 'LOAD_FAMILY_RELATION_REJECTED'; END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(v) k;
 SELECT array_agg(attname::text ORDER BY attname) INTO expected FROM pg_attribute WHERE attrelid=to_regclass('public.'||t) AND attnum>0 AND NOT attisdropped;
 IF keys IS DISTINCT FROM expected THEN RAISE EXCEPTION 'LOAD_FAMILY_COLUMNS_REJECTED'; END IF;
 EXECUTE format('SELECT to_jsonb(jsonb_populate_record(NULL::public.%I,$1))',t) INTO result USING v;
 RETURN result;
END $$;
CREATE FUNCTION wm_app_load.binding_table(t text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE t WHEN 'core_evidence_snapshot' THEN 'evidence_app_admission_binding' WHEN 'coaching_run' THEN 'run_app_admission_binding' WHEN 'coaching_candidate' THEN 'candidate_app_admission_binding' WHEN 'integrated_candidate_v4' THEN 'integrated_candidate_app_admission_binding' END $$;
CREATE FUNCTION wm_app_load.stage_family(run uuid,p_ordinal integer,t text,v jsonb,h text,b jsonb,absence boolean,w jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE d wm_app_load.descriptor; typed jsonb; binding jsonb; bt text; n integer; binding_keys text[]; expected text[];
BEGIN
 d:=wm_app_load.assert_context(run);
 typed:=wm_app_load.typed_row(t,v);
 bt:=wm_app_load.binding_table(t);
 IF d.sealed OR absence IS NULL OR typed->>'athlete_id' IS DISTINCT FROM d.athlete_id OR wm_app_load.hash_json(typed) IS DISTINCT FROM h THEN RAISE EXCEPTION 'LOAD_FAMILY_ROW_REJECTED'; END IF;
 IF bt IS NULL THEN
  IF b IS NOT NULL OR NOT absence THEN RAISE EXCEPTION 'LOAD_FAMILY_BINDING_REJECTED'; END IF;
 ELSIF absence THEN
  IF b IS NOT NULL THEN RAISE EXCEPTION 'LOAD_FAMILY_BINDING_REJECTED'; END IF;
 ELSE
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'LOAD_FAMILY_BINDING_REJECTED'; END IF;
  SELECT array_agg(k ORDER BY k) INTO binding_keys FROM jsonb_object_keys(b) k;
  SELECT array_agg(attname::text ORDER BY attname) INTO expected FROM pg_attribute WHERE attrelid=to_regclass('public.'||bt) AND attnum>0 AND NOT attisdropped;
  IF binding_keys IS DISTINCT FROM expected THEN RAISE EXCEPTION 'LOAD_FAMILY_BINDING_REJECTED'; END IF;
  EXECUTE format('SELECT to_jsonb(jsonb_populate_record(NULL::public.%I,$1))',bt) INTO binding USING b;
  IF binding->>'athlete_id' IS DISTINCT FROM d.athlete_id OR binding->>'binding_version' IS DISTINCT FROM '1'
  OR (bt='evidence_app_admission_binding' AND (binding->>'evidence_snapshot_id' IS DISTINCT FROM typed->>'id' OR binding->>'captured_at' IS NULL OR binding->>'app_revision' IS NULL))
  OR (bt='run_app_admission_binding' AND (binding->>'run_id' IS DISTINCT FROM typed->>'id' OR binding->>'evidence_snapshot_id' IS DISTINCT FROM typed->>'evidence_snapshot_id'))
  OR (bt='candidate_app_admission_binding' AND binding->>'candidate_id' IS DISTINCT FROM typed->>'id')
  OR (bt='integrated_candidate_app_admission_binding' AND (binding->>'candidate_id' IS DISTINCT FROM typed->>'id' OR binding->>'evidence_snapshot_id' IS DISTINCT FROM typed->'body'->'basis'->>'evidenceSnapshotId'))
  THEN RAISE EXCEPTION 'LOAD_FAMILY_BINDING_REJECTED'; END IF;
 END IF;
 IF w IS NOT NULL AND (jsonb_typeof(w) IS DISTINCT FROM 'object' OR octet_length(w::text)>131072) THEN RAISE EXCEPTION 'LOAD_FAMILY_WITNESS_REJECTED'; END IF;
 n:=octet_length(typed::text)+coalesce(octet_length(binding::text),0)+coalesce(octet_length(w::text),0);
 IF (SELECT count(*) FROM wm_app_load.family_stage WHERE run_id=run)>=d.expected_count OR n>4198400 OR (SELECT coalesce(sum(bytes),0) FROM wm_app_load.family_stage WHERE run_id=run)+n>16777216 THEN RAISE EXCEPTION 'LOAD_FAMILY_CAP_REJECTED'; END IF;
 INSERT INTO wm_app_load.family_stage VALUES(run,p_ordinal,t,typed,h,binding,absence,w,wm_app_load.hash_json(jsonb_build_object('relation',t,'row',typed,'binding',binding,'absence',absence,'witness',w)),n,false);
END $$;
CREATE FUNCTION wm_app_load.seal_family(run uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE d wm_app_load.descriptor; n bigint; h text;
BEGIN
 d:=wm_app_load.assert_context(run);
 SELECT count(*),wm_app_load.hash_json(jsonb_agg(jsonb_build_object('ordinal',ordinal,'digest',tuple_digest) ORDER BY ordinal)) INTO n,h FROM wm_app_load.family_stage WHERE run_id=run;
 IF d.sealed OR n IS DISTINCT FROM d.expected_count::bigint OR h IS DISTINCT FROM d.expected_digest THEN RAISE EXCEPTION 'LOAD_FAMILY_INVENTORY_REJECTED'; END IF;
 UPDATE wm_app_load.descriptor SET sealed=true WHERE run_id=run;
END $$;
CREATE FUNCTION wm_app_load.family_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE d wm_app_load.descriptor; s wm_app_load.family_stage; bt text; evidence uuid; run uuid; tenant text:=nullif(current_setting('app.athlete_id',true),''); revision integer; legacy wm_app_load.evidence_stage; original public.evidence_app_admission_binding;
BEGIN
 IF tenant IS DISTINCT FROM NEW.athlete_id THEN RAISE EXCEPTION 'APP_BINDING_TENANT_MISMATCH'; END IF;
 IF session_user=current_user AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_app_load.target'::regclass)) THEN
  SELECT * INTO d FROM wm_app_load.descriptor WHERE owner_xid=txid_current();
  IF FOUND AND EXISTS(SELECT 1 FROM wm_app_load.family_stage WHERE run_id=d.run_id) THEN
   d:=wm_app_load.assert_context(d.run_id);
   SELECT * INTO s FROM wm_app_load.family_stage WHERE run_id=d.run_id AND relation_name=TG_TABLE_NAME AND source_row->>'id'=NEW.id::text;
   IF NOT FOUND OR NOT d.sealed OR s.consumed OR s.source_row IS DISTINCT FROM to_jsonb(NEW) THEN RAISE EXCEPTION 'LOAD_FAMILY_CAPTURE_REJECTED'; END IF;
   bt:=wm_app_load.binding_table(TG_TABLE_NAME);
   IF NOT s.original_absence THEN
    IF TG_TABLE_NAME='coaching_candidate' THEN
     SELECT run_id INTO run FROM public.coaching_decision WHERE athlete_id=tenant AND id=NEW.decision_id;
     IF run::text IS DISTINCT FROM s.binding_row->>'run_id' THEN RAISE EXCEPTION 'LOAD_FAMILY_LINEAGE_REJECTED'; END IF;
    END IF;
    EXECUTE format('INSERT INTO public.%I SELECT r.* FROM jsonb_populate_record(NULL::public.%I,$1) r',bt,bt) USING s.binding_row;
   END IF;
   RETURN NEW;
  END IF;
 END IF;
 -- SQL100 live branch unchanged for runtime. v2 core loader remains a separate path.
 IF TG_TABLE_NAME='core_evidence_snapshot' THEN
  IF session_user=current_user THEN
   SELECT * INTO d FROM wm_app_load.descriptor WHERE owner_xid=txid_current();
   IF FOUND THEN
    d:=wm_app_load.assert_context(d.run_id);
    SELECT * INTO legacy FROM wm_app_load.evidence_stage WHERE run_id=d.run_id AND subject_id=NEW.id;
    IF NOT FOUND OR NOT d.sealed OR legacy.consumed OR legacy.row_digest IS DISTINCT FROM wm_app_load.row_digest(NEW) THEN RAISE EXCEPTION 'LOAD_ROW_REJECTED'; END IF;
    IF NOT legacy.original_absence THEN original:=jsonb_populate_record(NULL::public.evidence_app_admission_binding,legacy.original_binding); INSERT INTO public.evidence_app_admission_binding SELECT original.*; END IF;
    UPDATE wm_app_load.evidence_stage SET consumed=true WHERE run_id=d.run_id AND subject_id=NEW.id; RETURN NEW;
   END IF;
  END IF;
  revision:=public.require_app_admission_revision(NULL);
  INSERT INTO public.evidence_app_admission_binding(athlete_id,evidence_snapshot_id,app_revision) VALUES(tenant,NEW.id,revision);
 ELSIF TG_TABLE_NAME='coaching_run' THEN
  PERFORM public.require_evidence_app_binding(NEW.evidence_snapshot_id);
  INSERT INTO public.run_app_admission_binding(athlete_id,run_id,evidence_snapshot_id) VALUES(tenant,NEW.id,NEW.evidence_snapshot_id);
 ELSIF TG_TABLE_NAME='coaching_candidate' THEN
  SELECT run_id INTO run FROM public.coaching_decision WHERE athlete_id=tenant AND id=NEW.decision_id;
  SELECT evidence_snapshot_id INTO evidence FROM public.run_app_admission_binding WHERE athlete_id=tenant AND run_id=run;
  IF evidence IS NULL THEN RAISE EXCEPTION 'APP_BINDING_UNAVAILABLE'; END IF;
  PERFORM public.require_evidence_app_binding(evidence);
  INSERT INTO public.candidate_app_admission_binding(athlete_id,candidate_id,run_id) VALUES(tenant,NEW.id,run);
 ELSE
  evidence:=(NEW.body->'basis'->>'evidenceSnapshotId')::uuid;
  IF evidence IS NULL THEN RAISE EXCEPTION 'APP_BINDING_UNAVAILABLE'; END IF;
  PERFORM public.require_evidence_app_binding(evidence);
  INSERT INTO public.integrated_candidate_app_admission_binding(athlete_id,candidate_id,evidence_snapshot_id) VALUES(tenant,NEW.id,evidence);
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION wm_app_load.verify_approval_row(v jsonb,w jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); receipt public.command_receipt; candidate public.coaching_candidate; integrated public.integrated_candidate_v4; a public.integrated_approval_v4; parsed jsonb; saved_version uuid;
BEGIN
 SELECT * INTO STRICT receipt FROM public.command_receipt WHERE athlete_id=tenant AND idempotency_key=v->>'receipt_key';
 IF v->>'candidate_id' IS NOT NULL THEN
  SELECT * INTO STRICT candidate FROM public.coaching_candidate WHERE athlete_id=tenant AND id=(v->>'candidate_id')::uuid;
  IF jsonb_typeof(w) IS DISTINCT FROM 'object' OR w-'canonicalRequest'<>'{}'::jsonb OR jsonb_typeof(w->'canonicalRequest') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'LOAD_APPROVAL_WITNESS_REJECTED'; END IF;
  parsed:=(w->>'canonicalRequest')::jsonb;
  IF parsed-'schemaVersion'-'operation'-'candidateId'-'confirmed'-'expectedDigest'<>'{}'::jsonb OR parsed->>'schemaVersion' IS DISTINCT FROM '1' OR parsed->>'operation' IS DISTINCT FROM 'training_candidate_approve' OR parsed->>'candidateId' IS DISTINCT FROM v->>'candidate_id' OR parsed->>'confirmed' IS DISTINCT FROM 'true' OR parsed->>'expectedDigest' IS DISTINCT FROM candidate.digest
  OR receipt.request IS DISTINCT FROM jsonb_build_object('requestHash',encode(sha256(convert_to(w->>'canonicalRequest','UTF8')),'hex')) THEN RAISE EXCEPTION 'LOAD_APPROVAL_REQUEST_REJECTED'; END IF;
  saved_version:=(receipt.result->>'versionId')::uuid;
  IF v->>'integrated_approval_id' IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.plan_snapshot p JOIN public.plan_history h ON h.athlete_id=p.athlete_id AND h.version_id=p.id WHERE p.athlete_id=tenant AND p.id=saved_version AND h.action='candidate_approved') THEN RAISE EXCEPTION 'LOAD_APPROVAL_HISTORY_REJECTED'; END IF;
 ELSE
  SELECT * INTO STRICT integrated FROM public.integrated_candidate_v4 WHERE athlete_id=tenant AND id=(v->>'integrated_candidate_id')::uuid;
  SELECT * INTO STRICT a FROM public.integrated_approval_v4 WHERE athlete_id=tenant AND approval_id=(v->>'integrated_approval_id')::uuid;
  IF receipt.request->>'kind' IS DISTINCT FROM 'integrated_approve_v4' OR receipt.request->>'candidateId' IS DISTINCT FROM integrated.id::text OR receipt.result IS DISTINCT FROM a.result_json OR a.candidate_id IS DISTINCT FROM integrated.id OR a.proposal_id IS DISTINCT FROM integrated.proposal_id OR a.proposal_digest IS DISTINCT FROM integrated.digest OR a.approval_id::text IS DISTINCT FROM receipt.result->>'approvalId' THEN RAISE EXCEPTION 'LOAD_INTEGRATED_APPROVAL_REJECTED'; END IF;
  IF jsonb_typeof(a.result_json->'versions') IS DISTINCT FROM 'array' OR jsonb_typeof(a.result_json->'occurrenceIds') IS DISTINCT FROM 'array' OR a.result_json->>'schemaVersion' IS DISTINCT FROM '4' OR a.result_json->>'candidateId' IS DISTINCT FROM integrated.id::text THEN RAISE EXCEPTION 'LOAD_INTEGRATED_RESULT_REJECTED'; END IF;
  IF jsonb_array_length(a.result_json->'versions')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.result_json->'occurrenceIds') occ(value) WHERE NOT EXISTS(SELECT 1 FROM public.routine_occurrence r WHERE r.athlete_id=tenant AND r.id::text=occ.value)) THEN RAISE EXCEPTION 'LOAD_INTEGRATED_RESULT_REJECTED'; END IF;
  -- All exact domain result/version/history identities are checked before loader receipt.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(a.result_json->'versions') item WHERE
   CASE item->>'domain'
    WHEN 'training' THEN NOT EXISTS(SELECT 1 FROM public.plan_history h WHERE h.athlete_id=tenant AND h.version_id::text=item->>'versionId' AND h.action='candidate_approved' AND EXISTS(SELECT 1 FROM public.plan_head p WHERE p.athlete_id=tenant AND p.aggregate_id::text=item->>'aggregateId' AND p.version_id::text=h.version_id::text))
    WHEN 'nutrition' THEN NOT EXISTS(SELECT 1 FROM public.nutrition_plan_history h JOIN public.nutrition_plan_version p ON p.athlete_id=h.athlete_id AND p.plan_id=h.plan_id AND p.version_id::text=h.version_id::text AND p.approval_id=h.approval_id WHERE h.athlete_id=tenant AND h.version_id::text=item->>'versionId' AND h.plan_id::text=item->>'aggregateId' AND h.action='candidate_approved')
    WHEN 'recovery' THEN NOT EXISTS(SELECT 1 FROM public.recovery_strategy_history h WHERE h.athlete_id=tenant AND h.version_id::text=item->>'versionId' AND h.approval_id::text=a.approval_id::text AND EXISTS(SELECT 1 FROM public.recovery_strategy_head p WHERE p.athlete_id=tenant AND p.strategy_id::text=item->>'aggregateId' AND p.version_id::text=h.version_id::text))
    WHEN 'routine_schedule' THEN NOT EXISTS(SELECT 1 FROM public.routine_schedule_history h WHERE h.athlete_id=tenant AND h.version_id::text=item->>'versionId' AND h.approval_id::text=a.approval_id::text AND EXISTS(SELECT 1 FROM public.routine_schedule_head p WHERE p.athlete_id=tenant AND p.schedule_id::text=item->>'aggregateId' AND p.version_id::text=h.version_id::text))
    ELSE true END) THEN RAISE EXCEPTION 'LOAD_INTEGRATED_HISTORY_REJECTED'; END IF;
 END IF;
END $$;
CREATE FUNCTION wm_app_load.load_family(run uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE d wm_app_load.descriptor; s wm_app_load.family_stage;
BEGIN
 d:=wm_app_load.assert_context(run);
 IF NOT d.sealed THEN RAISE EXCEPTION 'LOAD_STAGE_REJECTED'; END IF;
 FOR s IN SELECT * FROM wm_app_load.family_stage WHERE run_id=run ORDER BY wm_app_load.relation_rank(relation_name),ordinal LOOP
  IF s.consumed THEN RAISE EXCEPTION 'LOAD_STAGE_REJECTED'; END IF;
  IF s.relation_name='approval_app_admission_binding' THEN PERFORM wm_app_load.verify_approval_row(s.source_row,s.witness); END IF;
  EXECUTE format('INSERT INTO public.%I SELECT r.* FROM jsonb_populate_record(NULL::public.%I,$1) r',s.relation_name,s.relation_name) USING s.source_row;
  UPDATE wm_app_load.family_stage SET consumed=true WHERE run_id=run AND ordinal=s.ordinal;
 END LOOP;
END $$;
CREATE FUNCTION wm_app_load.finish_family(run uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE d wm_app_load.descriptor; s wm_app_load.family_stage; exists_exact boolean; b jsonb; bt text; predicate text;
BEGIN
 d:=wm_app_load.assert_context(run);
 IF NOT d.sealed OR (SELECT count(*) FROM wm_app_load.family_stage WHERE run_id=run AND consumed) IS DISTINCT FROM d.expected_count::bigint THEN RAISE EXCEPTION 'LOAD_FAMILY_INCOMPLETE'; END IF;
 FOR s IN SELECT * FROM wm_app_load.family_stage WHERE run_id=run LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I r WHERE r.athlete_id=$1 AND to_jsonb(r)=$2)',s.relation_name) INTO exists_exact USING d.athlete_id,s.source_row;
  IF NOT exists_exact THEN RAISE EXCEPTION 'LOAD_FAMILY_POSTCONDITION_REJECTED'; END IF;
  bt:=wm_app_load.binding_table(s.relation_name);
  IF bt IS NOT NULL THEN
   predicate:=CASE s.relation_name WHEN 'core_evidence_snapshot' THEN 'evidence_snapshot_id' WHEN 'coaching_run' THEN 'run_id' ELSE 'candidate_id' END;
   EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE r.athlete_id=$1 AND r.%I::text=$2',bt,predicate) INTO b USING d.athlete_id,s.source_row->>'id';
   IF (s.original_absence AND b IS NOT NULL) OR (NOT s.original_absence AND b IS DISTINCT FROM s.binding_row) THEN RAISE EXCEPTION 'LOAD_FAMILY_BINDING_POSTCONDITION_REJECTED'; END IF;
  END IF;
 END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['core_evidence_snapshot','coaching_run','coaching_candidate','integrated_candidate_v4'] LOOP
  EXECUTE format('DROP TRIGGER capture_app_binding ON public.%I',t);
  EXECUTE format('CREATE TRIGGER capture_app_binding AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION wm_app_load.family_capture()',t);
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_app_load FROM PUBLIC;
