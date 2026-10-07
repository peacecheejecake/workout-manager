-- Current-only original membership and ordered postimages. No source authentication,
-- fresh admission, event mint, runtime grant, or normal registry activation.
-- Host must supply independently authenticated archive and ordered V7 envelopes.
CREATE SCHEMA wm_current_original_postimages;
REVOKE ALL ON SCHEMA wm_current_original_postimages FROM PUBLIC;
CREATE TABLE wm_current_original_postimages.profile (
 singleton boolean PRIMARY KEY CHECK(singleton), expected jsonb NOT NULL,
 target_digest text NOT NULL CHECK(target_digest ~ '^[a-f0-9]{64}$')
);
CREATE TABLE wm_current_original_postimages.run (
 run_id uuid PRIMARY KEY REFERENCES wm_current_app_load.descriptor(run_id), owner_xid bigint NOT NULL,
 envelope jsonb NOT NULL, expected_count integer NOT NULL CHECK(expected_count BETWEEN 1 AND 5000),
 sealed boolean NOT NULL DEFAULT false, applied boolean NOT NULL DEFAULT false, finished boolean NOT NULL DEFAULT false
);
CREATE TABLE wm_current_original_postimages.member (
 run_id uuid NOT NULL REFERENCES wm_current_original_postimages.run(run_id), ordinal integer NOT NULL,
 segment_ordinal integer NOT NULL, transaction_ordinal integer NOT NULL, record_ordinal integer NOT NULL,
 commit_lsn pg_lsn NOT NULL, end_lsn pg_lsn NOT NULL, stage_ordinal integer NOT NULL, event_id uuid NOT NULL,
 original_row_digest text NOT NULL, group_kind text, group_id uuid, group_ordinal integer,
 PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,event_id), UNIQUE(run_id,stage_ordinal),
 CHECK(ordinal BETWEEN 1 AND 5000),
 CHECK((group_kind IS NULL AND group_id IS NULL AND group_ordinal IS NULL) OR
 (group_kind IN ('resource_compound','erasure_compound','healthkit_registry') AND group_id IS NOT NULL AND group_ordinal>0))
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['profile','run','member'] LOOP
  EXECUTE format('ALTER TABLE wm_current_original_postimages.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE wm_current_original_postimages.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY live_owner ON wm_current_original_postimages.%I USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass))) WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass)))',t,'wm_current_original_postimages.'||t,'wm_current_original_postimages.'||t);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA wm_current_original_postimages FROM PUBLIC;

-- Exact projection is configured by the offline collector, not a claimed ready
-- flag. This pins SQL correspondence only; it cannot authenticate source bytes.
CREATE FUNCTION wm_current_original_postimages.catalog_projection() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('relations',(
  SELECT jsonb_agg(jsonb_build_object('relation',n.nspname||'.'||c.relname,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,'columns',(
   SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull) ORDER BY a.attnum)
   FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(
   SELECT coalesce(jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname),'[]'::jsonb) FROM pg_constraint k WHERE k.conrelid=c.oid)) ORDER BY n.nspname,c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','identity_private','garmin_private','wm_app_load','wm_current_app_load','wm_current_original_postimages') AND c.relkind IN ('r','p')),
 'schemas',(SELECT jsonb_agg(jsonb_build_object('name',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl::text) ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('public','identity_private','garmin_private','wm_app_load','wm_current_app_load','wm_current_original_postimages')),
 'policies',(SELECT jsonb_agg(jsonb_build_object('relation',polrelid::regclass::text,'name',polname,'command',polcmd,'permissive',polpermissive,'roles',polroles,'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) ORDER BY polrelid::regclass::text,polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','identity_private','garmin_private','wm_app_load','wm_current_app_load','wm_current_original_postimages')),
 'functions',(
  SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text) ORDER BY p.oid::regprocedure::text)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','identity_private','garmin_private','wm_app_load','wm_current_app_load','wm_current_original_postimages') AND p.prokind='f'),
 'triggers',(
  SELECT jsonb_agg(jsonb_build_object('relation',t.tgrelid::regclass::text,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgrelid::regclass::text,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE NOT t.tgisinternal AND n.nspname IN ('public','identity_private','garmin_private','wm_app_load','wm_current_app_load','wm_current_original_postimages')))
$$;
CREATE FUNCTION wm_current_original_postimages.configure_profile(expected jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM wm_current_app_load.owner_check(); PERFORM public.manual_race_v2_assert_json_bound(expected);
 IF NOT EXISTS(SELECT 1 FROM wm_current_app_load.target WHERE singleton AND state='CLOSED') THEN RAISE EXCEPTION 'CURRENT_POST_CLOSED_TARGET_REQUIRED'; END IF;
 PERFORM public.assert_restore_processing_closed((SELECT control_revision FROM wm_current_app_load.target WHERE singleton),(SELECT nonce FROM wm_current_app_load.target WHERE singleton),(SELECT incarnation FROM wm_current_app_load.target WHERE singleton));
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.routine_occurrence'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (athlete_id, schedule_id, anchor_key)') OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.routine_occurrence'::regclass AND conname='routine_occurrence_version_anchor_unique') THEN RAISE EXCEPTION 'CURRENT_POST_PROFILE121_UNSUPPORTED'; END IF;
 IF expected IS DISTINCT FROM wm_current_original_postimages.catalog_projection() THEN RAISE EXCEPTION 'CURRENT_POST_PROFILE_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM wm_current_original_postimages.profile) THEN RAISE EXCEPTION 'CURRENT_POST_PROFILE_ALREADY_CONFIGURED'; END IF;
 INSERT INTO wm_current_original_postimages.profile VALUES(true,expected,wm_current_app_load.hash_json(expected));
END $$;
CREATE FUNCTION wm_current_original_postimages.assert_context(p_run uuid) RETURNS wm_current_app_load.descriptor
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; p wm_current_original_postimages.profile; BEGIN
 d:=wm_current_app_load.assert_context(p_run);
 SELECT * INTO STRICT p FROM wm_current_original_postimages.profile;
 IF p.expected IS DISTINCT FROM wm_current_original_postimages.catalog_projection() THEN RAISE EXCEPTION 'CURRENT_POST_PROFILE_DRIFT'; END IF;
 IF NOT d.sealed OR NOT d.loaded OR d.post_replayed OR d.finished THEN RAISE EXCEPTION 'CURRENT_POST_LOADED_REQUIRED'; END IF;
 RETURN d;
END $$;
CREATE FUNCTION wm_current_original_postimages.begin_originals(p_run uuid,v jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; seg jsonb; tr jsonb; r jsonb; s wm_current_app_load.row_stage;
 e public.restore_suppression_event; i integer:=0; si integer:=0; ti integer; ri integer;
 previous_end pg_lsn; next_commit pg_lsn; next_end pg_lsn; group_kind text; group_id uuid; group_ordinal integer;
 identity jsonb; prior_sha text; source_binding jsonb; BEGIN
 d:=wm_current_original_postimages.assert_context(p_run); PERFORM public.manual_race_v2_assert_json_bound(v);
 IF jsonb_typeof(v)<>'object' OR v-ARRAY['profileVersion','sourceProfile','targetProfileDigest','originalRowsDigest','segments']<>'{}'::jsonb
 OR NOT(v ?& ARRAY['profileVersion','sourceProfile','targetProfileDigest','originalRowsDigest','segments']) OR v->>'profileVersion'<>'1'
 OR v->'sourceProfile' IS DISTINCT FROM jsonb_build_object('registrySha256',d.descriptor->'source'->>'registrySha256','catalogSha256',d.descriptor->'source'->>'catalogSha256')
 OR v->>'targetProfileDigest' IS DISTINCT FROM (SELECT target_digest FROM wm_current_original_postimages.profile)
 OR v->>'originalRowsDigest' IS DISTINCT FROM d.descriptor->>'originalRowsDigest'
 OR jsonb_typeof(v->'segments')<>'array' OR jsonb_array_length(v->'segments') NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'CURRENT_POST_ENVELOPE_REJECTED'; END IF;
 INSERT INTO wm_current_original_postimages.run VALUES(p_run,txid_current(),v,1,false,false,false);
 FOR seg IN SELECT value FROM jsonb_array_elements(v->'segments') LOOP
  si:=si+1; identity:=seg->'segmentIdentity';
  IF jsonb_typeof(seg)<>'object' OR seg-ARRAY['segmentOrdinal','segmentIdentity','transactions']<>'{}'::jsonb OR NOT(seg ?& ARRAY['segmentOrdinal','segmentIdentity','transactions'])
  OR seg->>'segmentOrdinal' IS DISTINCT FROM si::text OR jsonb_typeof(identity)<>'object' OR identity-ARRAY['localRecordVersion','clusterId','fromLsn','throughLsn','previousHash','sha256','source']<>'{}'::jsonb
  OR NOT(identity ?& ARRAY['localRecordVersion','clusterId','fromLsn','throughLsn','previousHash','sha256','source']) OR identity->>'localRecordVersion'<>'2'
  OR identity->>'clusterId' IS DISTINCT FROM d.descriptor->'source'->>'systemIdentifier'
  OR coalesce(identity->>'sha256','') !~ '^[a-f0-9]{64}$'
  OR (identity->'previousHash'<>'null'::jsonb AND (jsonb_typeof(identity->'previousHash')<>'string' OR coalesce(identity->>'previousHash','') !~ '^[a-f0-9]{64}$'))
  OR (si>1 AND identity->>'previousHash' IS DISTINCT FROM prior_sha)
  OR coalesce(identity->>'fromLsn','') !~ '^[0-9A-F]{1,8}/[0-9A-F]{1,8}$' OR coalesce(identity->>'throughLsn','') !~ '^[0-9A-F]{1,8}/[0-9A-F]{1,8}$'
  OR (identity->>'fromLsn')::pg_lsn>(identity->>'throughLsn')::pg_lsn
  OR jsonb_typeof(seg->'transactions')<>'array' OR jsonb_array_length(seg->'transactions') NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'CURRENT_POST_SEGMENT_REJECTED'; END IF;
  source_binding:=identity->'source';
  IF jsonb_typeof(source_binding)<>'object' OR source_binding-ARRAY['databaseName','databaseOid','slotName','publication','relationProfile','captureId','registryFingerprint']<>'{}'::jsonb
  OR NOT(source_binding ?& ARRAY['databaseName','databaseOid','slotName','publication','relationProfile','captureId','registryFingerprint'])
  OR source_binding->>'databaseOid' IS DISTINCT FROM d.descriptor->'source'->>'databaseOid'
  OR source_binding->>'captureId' IS DISTINCT FROM d.descriptor->'source'->>'captureId'
  OR source_binding->>'registryFingerprint' IS DISTINCT FROM d.descriptor->'source'->>'registrySha256'
  OR source_binding->>'publication'<>'workout_restore_suppression_events' OR source_binding->>'relationProfile'<>'suppression-physical-v7'
  OR coalesce(source_binding->>'databaseName','') !~ '^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$'
  OR coalesce(source_binding->>'slotName','') !~ '^wm_suppression_[a-z0-9_]{1,40}$' THEN RAISE EXCEPTION 'CURRENT_POST_SOURCE_REJECTED'; END IF;
  ti:=0;
  FOR tr IN SELECT value FROM jsonb_array_elements(seg->'transactions') LOOP
   ti:=ti+1;
   IF jsonb_typeof(tr)<>'object' OR tr-ARRAY['commitLsn','endLsn','records']<>'{}'::jsonb OR NOT(tr ?& ARRAY['commitLsn','endLsn','records'])
   OR coalesce(tr->>'commitLsn','') !~ '^[0-9A-F]{1,8}/[0-9A-F]{1,8}$' OR coalesce(tr->>'endLsn','') !~ '^[0-9A-F]{1,8}/[0-9A-F]{1,8}$'
   OR jsonb_typeof(tr->'records')<>'array' OR jsonb_array_length(tr->'records')>1000 THEN RAISE EXCEPTION 'CURRENT_POST_TRANSACTION_REJECTED'; END IF;
   next_commit:=(tr->>'commitLsn')::pg_lsn; next_end:=(tr->>'endLsn')::pg_lsn;
   IF next_commit>next_end OR next_commit<(identity->>'fromLsn')::pg_lsn OR next_end>(identity->>'throughLsn')::pg_lsn OR (previous_end IS NOT NULL AND next_commit<=previous_end) THEN RAISE EXCEPTION 'CURRENT_POST_ORDER_REJECTED'; END IF;
   previous_end:=next_end; ri:=0;
   FOR r IN SELECT value FROM jsonb_array_elements(tr->'records') LOOP
    ri:=ri+1; i:=i+1;
    IF i>5000 OR jsonb_typeof(r)<>'object' OR r-ARRAY['stageOrdinal','eventId','group']<>'{}'::jsonb OR NOT(r ?& ARRAY['stageOrdinal','eventId','group'])
    OR coalesce(r->>'stageOrdinal','') !~ '^[1-9][0-9]{0,3}$' OR coalesce(r->>'eventId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'CURRENT_POST_RECORD_REJECTED'; END IF;
    SELECT * INTO STRICT s FROM wm_current_app_load.row_stage WHERE run_id=p_run AND ordinal=(r->>'stageOrdinal')::integer AND relation_name='restore_suppression_event' AND consumed;
    SELECT * INTO STRICT e FROM public.restore_suppression_event WHERE event_id=(r->>'eventId')::uuid AND athlete_id=d.athlete_id;
    IF s.physical_row IS DISTINCT FROM wm_current_app_load.encode_row('restore_suppression_event',to_jsonb(e)) OR s.row_digest IS DISTINCT FROM wm_current_app_load.hash_json(s.physical_row) THEN RAISE EXCEPTION 'CURRENT_POST_ORIGINAL_MISMATCH'; END IF;
    group_kind:=NULL; group_id:=NULL; group_ordinal:=NULL;
    IF r->'group'<>'null'::jsonb THEN
     IF jsonb_typeof(r->'group')<>'object' OR (r->'group')-ARRAY['kind','id','ordinal']<>'{}'::jsonb OR NOT(r->'group' ?& ARRAY['kind','id','ordinal']) OR coalesce(r->'group'->>'ordinal','') !~ '^[1-9][0-9]{0,3}$' THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_REJECTED'; END IF;
     group_kind:=r->'group'->>'kind'; group_id:=(r->'group'->>'id')::uuid; group_ordinal:=(r->'group'->>'ordinal')::integer;
     IF (group_kind='resource_compound' AND group_id IS DISTINCT FROM CASE WHEN e.kind='resource_deleted' THEN e.event_id WHEN e.kind='resource_share_revoked' AND e.share_cause_kind='resource_deleted' THEN e.share_cause_event_id END)
     OR (group_kind='erasure_compound' AND group_id IS DISTINCT FROM CASE WHEN e.kind='tenant_erased' THEN e.event_id WHEN e.kind='resource_share_revoked' AND e.share_cause_kind='tenant_erased' THEN e.share_cause_event_id END)
     OR (group_kind='healthkit_registry' AND group_id IS DISTINCT FROM e.healthkit_operation_id)
     OR group_kind NOT IN ('resource_compound','erasure_compound','healthkit_registry') THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_REJECTED'; END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM wm_current_original_postimages.member WHERE run_id=p_run AND (event_id=e.event_id OR stage_ordinal=s.ordinal)) THEN RAISE EXCEPTION 'CURRENT_POST_MEMBER_DUPLICATE'; END IF;
    INSERT INTO wm_current_original_postimages.member VALUES(p_run,i,si,ti,ri,next_commit,next_end,s.ordinal,e.event_id,s.row_digest,group_kind,group_id,group_ordinal);
   END LOOP;
  END LOOP;
  prior_sha:=identity->>'sha256';
 END LOOP;
 IF i=0 OR i<>(SELECT count(*) FROM wm_current_app_load.row_stage WHERE run_id=p_run AND relation_name='restore_suppression_event') THEN RAISE EXCEPTION 'CURRENT_POST_ORIGINAL_CENSUS_REJECTED'; END IF;
 UPDATE wm_current_original_postimages.run SET expected_count=i WHERE run_id=p_run;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE FUNCTION wm_current_original_postimages.seal_originals(p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; r wm_current_original_postimages.run; g record; parent public.restore_suppression_event; BEGIN
 d:=wm_current_original_postimages.assert_context(p_run);
 SELECT * INTO STRICT r FROM wm_current_original_postimages.run WHERE run_id=p_run AND owner_xid=txid_current() FOR UPDATE;
 IF r.sealed OR r.applied OR r.finished OR r.expected_count<>(SELECT count(*) FROM wm_current_original_postimages.member WHERE run_id=p_run) THEN RAISE EXCEPTION 'CURRENT_POST_SEAL_REJECTED'; END IF;
 -- A caused child cannot be treated as a standalone record, including legacy
 -- shares whose missing cause prevents authenticated compound classification.
 IF EXISTS(SELECT 1 FROM wm_current_original_postimages.member m JOIN public.restore_suppression_event e ON e.event_id=m.event_id WHERE m.run_id=p_run AND (
  (e.share_cause_kind IS NOT NULL AND m.group_kind IS DISTINCT FROM CASE e.share_cause_kind WHEN 'resource_deleted' THEN 'resource_compound' WHEN 'tenant_erased' THEN 'erasure_compound' END)
  OR (e.kind IN ('healthkit_workout_deregistration_pending','healthkit_workout_deregistration_released') AND m.group_kind IS DISTINCT FROM 'healthkit_registry')
  OR (e.kind='resource_share_revoked' AND e.record_version=1 AND EXISTS(SELECT 1 FROM wm_current_original_postimages.member p JOIN public.restore_suppression_event pe ON pe.event_id=p.event_id WHERE p.run_id=p_run AND p.segment_ordinal=m.segment_ordinal AND p.transaction_ordinal=m.transaction_ordinal AND pe.kind IN ('tenant_erased','resource_deleted') AND (pe.kind='tenant_erased' OR pe.target_id=e.target_id))))) THEN RAISE EXCEPTION 'CURRENT_POST_COMPOUND_PROOF_REQUIRED'; END IF;
 FOR g IN SELECT group_kind,group_id,count(*) AS count,min(ordinal) AS first,max(ordinal) AS last,min(group_ordinal) AS first_group,max(group_ordinal) AS last_group,count(DISTINCT group_ordinal) AS unique_group,count(DISTINCT (segment_ordinal,transaction_ordinal)) AS transactions FROM wm_current_original_postimages.member WHERE run_id=p_run AND group_kind IS NOT NULL GROUP BY group_kind,group_id LOOP
  IF g.first_group<>1 OR g.last_group<>g.count OR g.unique_group<>g.count THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_ORDER_REJECTED'; END IF;
  IF g.group_kind IN ('resource_compound','erasure_compound') THEN
   IF g.transactions<>1 OR g.last-g.first+1<>g.count OR g.count NOT BETWEEN 2 AND 257 THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_CONTIGUITY_REJECTED'; END IF;
   SELECT * INTO STRICT parent FROM public.restore_suppression_event WHERE event_id=g.group_id AND athlete_id=d.athlete_id;
   IF (g.group_kind='resource_compound' AND parent.kind<>'resource_deleted') OR (g.group_kind='erasure_compound' AND parent.kind<>'tenant_erased') THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_PARENT_REJECTED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.member m WHERE m.run_id=p_run AND m.event_id=parent.event_id AND m.ordinal=CASE WHEN g.group_kind='resource_compound' THEN g.first ELSE g.last END AND m.group_ordinal=CASE WHEN g.group_kind='resource_compound' THEN 1 ELSE g.count END) THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_PARENT_ORDER_REJECTED'; END IF;
   IF EXISTS(SELECT 1 FROM wm_current_original_postimages.member m JOIN public.restore_suppression_event child ON child.event_id=m.event_id WHERE m.run_id=p_run AND m.group_id=g.group_id AND m.event_id<>parent.event_id AND (child.record_version<>2 OR child.kind<>'resource_share_revoked' OR child.athlete_id<>parent.athlete_id OR child.share_cause_event_id IS DISTINCT FROM parent.event_id OR child.share_cause_kind IS DISTINCT FROM CASE WHEN g.group_kind='resource_compound' THEN 'resource_deleted' ELSE 'tenant_erased' END OR (g.group_kind='erasure_compound' AND child.share_revoked_access_revision<>child.share_granted_access_revision+1) OR (g.group_kind='resource_compound' AND (child.target_id<>parent.target_id OR child.occurred_at<parent.occurred_at OR child.share_revoked_access_revision<>parent.resource_access_revision)) OR (g.group_kind='erasure_compound' AND child.occurred_at>parent.occurred_at))) THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_CHILD_REJECTED'; END IF;
   IF (SELECT count(*) FROM public.restore_suppression_event e WHERE e.athlete_id=d.athlete_id AND e.share_cause_event_id=parent.event_id)<>g.count-1 THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_CENSUS_REJECTED'; END IF;
  ELSE
   -- The real operation id supplies registry group identity. Preserve source TX
   -- order; pending/released may occupy distinct source transactions.
   IF g.count NOT BETWEEN 1 AND 2 OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.member m JOIN public.restore_suppression_event e ON e.event_id=m.event_id WHERE m.run_id=p_run AND m.group_id=g.group_id AND m.group_ordinal=1 AND e.kind='healthkit_workout_deregistration_pending' AND e.record_version=3)
    OR (g.count=2 AND NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.member m JOIN public.restore_suppression_event e ON e.event_id=m.event_id WHERE m.run_id=p_run AND m.group_id=g.group_id AND m.group_ordinal=2 AND e.kind='healthkit_workout_deregistration_released' AND e.record_version=3))
    OR EXISTS(SELECT 1 FROM wm_current_original_postimages.member a JOIN public.restore_suppression_event ae ON ae.event_id=a.event_id JOIN wm_current_original_postimages.member b ON b.run_id=a.run_id AND b.group_id=a.group_id AND b.group_ordinal=2 JOIN public.restore_suppression_event be ON be.event_id=b.event_id WHERE a.run_id=p_run AND a.group_id=g.group_id AND a.group_ordinal=1 AND (a.ordinal>=b.ordinal OR ae.target_id<>be.target_id OR ae.healthkit_claim_epoch<>be.healthkit_claim_epoch OR ae.healthkit_consent_revision<>be.healthkit_consent_revision OR ae.healthkit_registry_revision>be.healthkit_registry_previous_revision OR ae.healthkit_object_scopes<>be.healthkit_object_scopes)) THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_CHAIN_REJECTED'; END IF;
  END IF;
 END LOOP;
 -- Exact array order must agree with the claimed group order, not merely a set.
 IF EXISTS(SELECT 1 FROM wm_current_original_postimages.member a JOIN wm_current_original_postimages.member b ON b.run_id=a.run_id AND b.group_kind=a.group_kind AND b.group_id=a.group_id WHERE a.run_id=p_run AND a.ordinal<b.ordinal AND a.group_ordinal>=b.group_ordinal) THEN RAISE EXCEPTION 'CURRENT_POST_GROUP_ORDER_REJECTED'; END IF;
 UPDATE wm_current_original_postimages.run SET sealed=true WHERE run_id=p_run;
END $$;
CREATE FUNCTION wm_current_original_postimages.original(p_run uuid,p_event uuid) RETURNS public.restore_suppression_event
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; r wm_current_original_postimages.run; m wm_current_original_postimages.member; s wm_current_app_load.row_stage; e public.restore_suppression_event; BEGIN
 d:=wm_current_original_postimages.assert_context(p_run);
 SELECT * INTO STRICT r FROM wm_current_original_postimages.run WHERE run_id=p_run AND owner_xid=txid_current() AND sealed AND NOT finished;
 SELECT * INTO STRICT m FROM wm_current_original_postimages.member WHERE run_id=p_run AND event_id=p_event;
 SELECT * INTO STRICT s FROM wm_current_app_load.row_stage WHERE run_id=p_run AND ordinal=m.stage_ordinal AND relation_name='restore_suppression_event' AND consumed;
 SELECT * INTO STRICT e FROM public.restore_suppression_event WHERE event_id=p_event AND athlete_id=d.athlete_id FOR UPDATE;
 IF NOT isfinite(e.occurred_at) OR e.occurred_at>clock_timestamp() THEN RAISE EXCEPTION 'CURRENT_POST_ORIGINAL_TIME_REJECTED'; END IF;
 IF s.row_digest IS DISTINCT FROM m.original_row_digest OR s.physical_row IS DISTINCT FROM wm_current_app_load.encode_row('restore_suppression_event',to_jsonb(e)) THEN RAISE EXCEPTION 'CURRENT_POST_ORIGINAL_MISMATCH'; END IF;
 RETURN e;
END $$;
-- Postimage audits never impersonate historical replay contexts/receipts or their
-- xmin/caller credentials. They bind only this exact current-stage original.
CREATE TABLE wm_current_original_postimages.audit (
 run_id uuid NOT NULL,event_id uuid NOT NULL,original_row_digest text NOT NULL,
 kind text NOT NULL, outcome text NOT NULL CHECK(outcome='postimage_checked'),
 PRIMARY KEY(run_id,event_id),FOREIGN KEY(run_id,event_id) REFERENCES wm_current_original_postimages.member(run_id,event_id)
);
ALTER TABLE wm_current_original_postimages.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_current_original_postimages.audit FORCE ROW LEVEL SECURITY;
CREATE POLICY live_owner ON wm_current_original_postimages.audit USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_current_original_postimages.audit'::regclass))) WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_current_original_postimages.audit'::regclass)));
REVOKE ALL ON TABLE wm_current_original_postimages.audit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE FUNCTION wm_current_original_postimages.require_parent_profile(p_run uuid,names text[]) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY names LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(wm_current_app_load.relation_profile()) p WHERE p->>'relation'=t) AND NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.family f WHERE f.run_id=p_run AND f.sealed AND f.proof->'relationCensus' ? t) THEN RAISE EXCEPTION 'CURRENT_POST_PARENT_CODEC_UNAVAILABLE: %',t; END IF;
 END LOOP;
END $$;
CREATE FUNCTION wm_current_original_postimages.apply_original(p_run uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE e public.restore_suppression_event; state text; h record; source record; previous record; tombstone record; actual_id text; n bigint; scope jsonb; m wm_current_original_postimages.member; BEGIN
 e:=wm_current_original_postimages.original(p_run,p_event);
 SELECT * INTO STRICT m FROM wm_current_original_postimages.member WHERE run_id=p_run AND event_id=p_event;
 IF EXISTS(SELECT 1 FROM wm_current_original_postimages.audit WHERE run_id=p_run AND event_id=p_event) THEN RAISE EXCEPTION 'CURRENT_POST_DUPLICATE_APPLICATION'; END IF;
 CASE e.kind
 WHEN 'race_event_deleted','race_result_deleted','training_best_deleted' THEN
  state:=public.replay_race_deletion_exact(e.athlete_id,e.kind,e.target_id,e.event_id,e.occurred_at,e.race_previous_revision,e.race_deleted_revision);
  IF state NOT IN ('applied','already_applied','already_applied_by_erasure','deleted','absent') THEN RAISE EXCEPTION 'CURRENT_POST_RACE_REJECTED'; END IF;
 WHEN 'manual_review_source_suppressed' THEN
  -- Historical106 context remains unchanged. Current original membership permits
  -- the narrow posthook only; it never generates a fresh review/purpose seal.
  PERFORM public.suppress_manual_reviews_from_event(e.event_id);
 WHEN 'manual_review_source_suppressed_v2' THEN
  PERFORM public.suppress_manual_race_chain_from_event_v2(e.event_id);
 WHEN 'course_deleted' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['course','course_deletion']);
  --117's verified stage validates all constraints IMMEDIATE. The historical
  -- course replay removes revisions before the referencing head; restore only
  -- this originally DEFERRABLE FK's transaction timing, then check it again
  -- while exact original membership and the CLOSED descriptor remain live.
  SET CONSTRAINTS public.course_head_revision_fk DEFERRED;
  state:=public.replay_course_deletion(e.athlete_id,e.target_id,e.occurred_at);
  SET CONSTRAINTS public.course_head_revision_fk IMMEDIATE;
  PERFORM public.arm_object_scope_purge(e.athlete_id,'course',e.target_id);
  IF EXISTS(SELECT 1 FROM public.course c WHERE c.athlete_id=e.athlete_id AND c.course_id=e.target_id AND c.status='available') OR NOT EXISTS(SELECT 1 FROM public.course_deletion c WHERE c.athlete_id=e.athlete_id AND c.course_id=e.target_id AND c.deleted_at=e.occurred_at) THEN RAISE EXCEPTION 'CURRENT_POST_COURSE_STATE_REJECTED'; END IF;
 WHEN 'gallery_media_deleted' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['gallery_media_item','gallery_media_object','gallery_upload_intent']);
  SELECT * INTO STRICT h FROM public.gallery_media_item WHERE athlete_id=e.athlete_id AND id=e.target_id FOR UPDATE;
  IF h.deleted_at IS NULL THEN
   IF h.access_revision<>e.gallery_access_revision-1 OR h.updated_at>e.occurred_at THEN RAISE EXCEPTION 'CURRENT_POST_GALLERY_STATE_REJECTED'; END IF;
   PERFORM set_config('app.restore_gallery_media_event_id',e.event_id::text,true);
   UPDATE public.gallery_media_item SET access_revision=e.gallery_access_revision,updated_at=e.occurred_at,deleted_at=e.occurred_at WHERE athlete_id=e.athlete_id AND id=e.target_id;
   PERFORM set_config('app.restore_gallery_media_event_id','',true);
  ELSIF h.deleted_at<>e.occurred_at OR h.access_revision<>e.gallery_access_revision THEN RAISE EXCEPTION 'CURRENT_POST_GALLERY_STATE_REJECTED'; END IF;
  PERFORM public.tombstone_gallery_media_receipts(e.target_id);
  PERFORM public.cancel_gallery_uploads(e.target_id,'MEDIA_DELETED');
  PERFORM public.enqueue_gallery_media_cleanup(e.target_id,'resource_deleted');
 WHEN 'resource_deleted' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['resource','resource_version','resource_share','resource_access_audit']);
  -- Share children must be authenticated as a group before their source rows can
  -- be revoked; neither revoke_resource_shares nor normal hooks may mint events.
  IF m.group_kind IS NOT NULL AND m.group_kind<>'resource_compound' THEN RAISE EXCEPTION 'CURRENT_POST_COMPOUND_PARENT_REJECTED'; END IF;
  SELECT * INTO STRICT h FROM public.resource WHERE athlete_id=e.athlete_id AND id=e.target_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.resource_share s WHERE s.athlete_id=e.athlete_id AND s.resource_id=e.target_id AND s.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.member cm JOIN public.restore_suppression_event ce ON ce.event_id=cm.event_id WHERE cm.run_id=p_run AND cm.group_id=e.event_id AND cm.group_kind='resource_compound' AND ce.kind='resource_share_revoked' AND ce.share_id=s.share_id AND ce.share_granted_access_revision=s.granted_access_revision)) THEN RAISE EXCEPTION 'CURRENT_POST_SHARE_GROUP_REQUIRED'; END IF;
  IF h.deleted_at IS NULL THEN
   IF h.access_revision<>e.resource_access_revision-1 THEN RAISE EXCEPTION 'CURRENT_POST_RESOURCE_STATE_REJECTED'; END IF;
   PERFORM set_config('app.restore_resource_event_id',e.event_id::text,true);
   UPDATE public.resource SET access_revision=e.resource_access_revision,updated_at=e.occurred_at,deleted_at=e.occurred_at,include_for_coach=false,coach_use_enabled_at=NULL WHERE athlete_id=e.athlete_id AND id=e.target_id;
   PERFORM set_config('app.restore_resource_event_id','',true);
  ELSIF h.deleted_at<>e.occurred_at OR h.access_revision<>e.resource_access_revision THEN RAISE EXCEPTION 'CURRENT_POST_RESOURCE_STATE_REJECTED'; END IF;
  PERFORM public.enqueue_resource_derived_cleanup(e.target_id,'resource_deleted');
  PERFORM public.tombstone_resource_receipts(e.target_id);
  PERFORM public.cancel_resource_uploads(e.target_id,'RESOURCE_DELETED');
  PERFORM public.enqueue_resource_object_cleanup(e.target_id,'resource_deleted');
 WHEN 'activity_deleted' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['activity_canonical','activity_source_head','activity_suppression']);
  SELECT * INTO STRICT h FROM public.activity_canonical WHERE athlete_id=e.athlete_id AND id=e.target_id FOR UPDATE;
  SELECT * INTO STRICT source FROM public.activity_source_head WHERE athlete_id=e.athlete_id AND activity_id=e.target_id FOR UPDATE;
  IF source.kind<>e.source_kind OR source.source_id<>e.source_id OR source.source_revision<>e.source_revision OR source.content_hash<>e.source_content_hash THEN RAISE EXCEPTION 'CURRENT_POST_ACTIVITY_SOURCE_REJECTED'; END IF;
  IF NOT h.deleted THEN
   IF h.revision<>e.activity_revision-1 THEN RAISE EXCEPTION 'CURRENT_POST_ACTIVITY_STATE_REJECTED'; END IF;
   INSERT INTO public.activity_suppression(athlete_id,kind,source_id) VALUES(e.athlete_id,e.source_kind,e.source_id) ON CONFLICT DO NOTHING;
   PERFORM set_config('app.restore_activity_event_id',e.event_id::text,true);
   UPDATE public.activity_canonical SET deleted=true,revision=e.activity_revision WHERE athlete_id=e.athlete_id AND id=e.target_id;
   PERFORM set_config('app.restore_activity_event_id','',true);
  ELSIF h.revision<>e.activity_revision THEN RAISE EXCEPTION 'CURRENT_POST_ACTIVITY_STATE_REJECTED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.activity_suppression s WHERE s.athlete_id=e.athlete_id AND s.kind=e.source_kind AND s.source_id=e.source_id) THEN RAISE EXCEPTION 'CURRENT_POST_ACTIVITY_SUPPRESSION_REJECTED'; END IF;
  PERFORM wm_current_original_postimages.post_activity_cleanup(p_run,p_event);
  PERFORM public.arm_object_scope_purge(e.athlete_id,'activity',e.target_id);
 WHEN 'check_in_deleted' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['check_in','check_in_revision','check_in_collection_head']);
  SELECT * INTO STRICT h FROM public.check_in WHERE athlete_id=e.athlete_id AND id=e.target_id FOR UPDATE;
  IF NOT h.deleted THEN
   IF h.revision<>e.check_in_revision-1 OR h.updated_at>e.occurred_at OR h.recorded_at>e.occurred_at THEN RAISE EXCEPTION 'CURRENT_POST_CHECKIN_STATE_REJECTED'; END IF;
   DELETE FROM public.check_in_revision WHERE athlete_id=e.athlete_id AND check_in_id=e.target_id;
   PERFORM set_config('app.restore_check_in_event_id',e.event_id::text,true);
   UPDATE public.check_in SET revision=e.check_in_revision,deleted=true,values_json=NULL,local_date=NULL,updated_at=e.occurred_at WHERE athlete_id=e.athlete_id AND id=e.target_id;
   PERFORM set_config('app.restore_check_in_event_id','',true);
   UPDATE public.check_in_collection_head SET revision=revision+1 WHERE athlete_id=e.athlete_id AND revision<2147483647;
  ELSIF h.revision<>e.check_in_revision OR h.updated_at<>e.occurred_at OR h.values_json IS NOT NULL OR h.local_date IS NOT NULL THEN RAISE EXCEPTION 'CURRENT_POST_CHECKIN_STATE_REJECTED'; END IF;
  IF EXISTS(SELECT 1 FROM public.check_in_revision WHERE athlete_id=e.athlete_id AND check_in_id=e.target_id) THEN RAISE EXCEPTION 'CURRENT_POST_CHECKIN_HISTORY_REJECTED'; END IF;
 WHEN 'intake_entry_deleted','recovery_action_deleted' THEN
  IF e.record_version<>2 OR e.actual_previous_revision_id IS NULL OR e.actual_deleted_revision_id IS NULL THEN RAISE EXCEPTION 'CURRENT_POST_ACTUAL_IDENTITY_UNAVAILABLE'; END IF;
  PERFORM wm_current_original_postimages.prepare_actual_postimage(p_run,p_event);
  IF e.kind='intake_entry_deleted' THEN
   PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['intake_entry','intake_entry_revision']);
   SELECT intake_id INTO STRICT actual_id FROM public.intake_entry_revision WHERE athlete_id=e.athlete_id AND revision_id=e.target_id AND revision=1 AND status='active';
   SELECT * INTO STRICT h FROM public.intake_entry WHERE athlete_id=e.athlete_id AND id=actual_id FOR UPDATE;
   SELECT * INTO STRICT previous FROM public.intake_entry_revision WHERE athlete_id=e.athlete_id AND intake_id=actual_id AND revision=e.actual_deletion_revision-1;
   SELECT * INTO STRICT tombstone FROM public.intake_entry_revision WHERE athlete_id=e.athlete_id AND intake_id=actual_id AND revision=e.actual_deletion_revision;
   SELECT count(*) INTO n FROM public.intake_entry_revision WHERE athlete_id=e.athlete_id AND intake_id=actual_id;
   IF previous.revision_id<>e.actual_previous_revision_id OR previous.status<>'active' OR previous.recorded_at>e.occurred_at OR previous.deleted_at IS NOT NULL OR tombstone.revision_id<>e.actual_deleted_revision_id OR tombstone.status<>'deleted' OR tombstone.recorded_at<>e.occurred_at OR tombstone.deleted_at<>e.occurred_at OR tombstone.deletion_reason<>'user_requested' OR h.status<>'deleted' OR h.current_revision<>e.actual_deletion_revision OR h.current_revision_id<>e.actual_deleted_revision_id OR n<>e.actual_deletion_revision THEN RAISE EXCEPTION 'CURRENT_POST_ACTUAL_POSTIMAGE_REJECTED'; END IF;
  ELSE
   PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['recovery_action_log','recovery_action_revision']);
   SELECT * INTO STRICT h FROM public.recovery_action_log WHERE athlete_id=e.athlete_id AND action_id=e.target_id FOR UPDATE;
   SELECT * INTO STRICT previous FROM public.recovery_action_revision WHERE athlete_id=e.athlete_id AND action_id=e.target_id AND revision=e.actual_deletion_revision-1;
   SELECT * INTO STRICT tombstone FROM public.recovery_action_revision WHERE athlete_id=e.athlete_id AND action_id=e.target_id AND revision=e.actual_deletion_revision;
   SELECT count(*) INTO n FROM public.recovery_action_revision WHERE athlete_id=e.athlete_id AND action_id=e.target_id;
   IF previous.revision_id<>e.actual_previous_revision_id OR previous.status<>'active' OR tombstone.revision_id<>e.actual_deleted_revision_id OR tombstone.status<>'deleted' OR tombstone.record_json IS DISTINCT FROM jsonb_build_object('actionId',e.target_id::text,'revisionId',e.actual_deleted_revision_id::text,'revision',e.actual_deletion_revision,'status','deleted','deletedAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) OR h.status<>'deleted' OR h.revision<>e.actual_deletion_revision OR h.revision_id<>e.actual_deleted_revision_id OR n<>e.actual_deletion_revision THEN RAISE EXCEPTION 'CURRENT_POST_ACTUAL_POSTIMAGE_REJECTED'; END IF;
  END IF;
 WHEN 'app_consent_transition' THEN
  state:=public.replay_app_consent_transition_exact(e.athlete_id,e.event_id,e.occurred_at,e.consent_previous_revision,e.consent_previous_granted,e.consent_revision,e.consent_granted);
 WHEN 'healthkit_consent_transition','ai_consent_transition' THEN
  PERFORM wm_current_original_postimages.post_consent(p_run,p_event);
 WHEN 'healthkit_workout_deregistration_pending','healthkit_workout_deregistration_released' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['healthkit_workout_claim','healthkit_workout_sample','healthkit_workout_deregistration','healthkit_workout_registry_head']);
  PERFORM wm_current_original_postimages.post_healthkit_registry(p_run,p_event);
 WHEN 'resource_share_revoked' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['resource_share','resource_access_audit']);
  PERFORM wm_current_original_postimages.post_share(p_run,p_event);
 WHEN 'course_share_revoked' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['course_share','course_share_audit']);
  PERFORM wm_current_original_postimages.post_share(p_run,p_event);
 WHEN 'tenant_erased' THEN
  PERFORM wm_current_original_postimages.post_erasure(p_run,p_event);
 ELSE RAISE EXCEPTION 'CURRENT_POST_ORIGINAL_KIND_UNSUPPORTED: %',e.kind;
 END CASE;
 PERFORM public.suppress_manual_race_chain_from_event_v2(e.event_id);
 INSERT INTO wm_current_original_postimages.audit VALUES(p_run,e.event_id,m.original_row_digest,e.kind,'postimage_checked');
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

-- Future authenticated full collector passes these fixed partitions separately.
-- These tables are operational staging: source/restore disposition empty/reset,
-- never public export data or an inherited transaction/admission credential.
CREATE TABLE wm_current_original_postimages.family (
 run_id uuid NOT NULL REFERENCES wm_current_original_postimages.run(run_id), family text NOT NULL,
 proof jsonb NOT NULL, sealed boolean NOT NULL DEFAULT false, PRIMARY KEY(run_id,family)
);
CREATE TABLE wm_current_original_postimages.family_row (
 run_id uuid NOT NULL,family text NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 5000),
 relation_name text NOT NULL,physical_row jsonb NOT NULL,row_digest text NOT NULL,primary_key jsonb NOT NULL,
 PRIMARY KEY(run_id,family,ordinal),UNIQUE(run_id,family,relation_name,primary_key),
 FOREIGN KEY(run_id,family) REFERENCES wm_current_original_postimages.family(run_id,family)
);
CREATE FUNCTION wm_current_original_postimages.family_relations(f text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 RETURN CASE f
 WHEN 'gallery_media_deleted' THEN ARRAY['gallery_media_item','gallery_media_object','gallery_media_derivative','gallery_upload_intent']
 WHEN 'activity_deleted' THEN ARRAY['activity_canonical','activity_source_head','activity_source_revision','activity_overlay','activity_overlay_revision','activity_suppression','activity_track','activity_track_revision','activity_track_object','activity_track_object_ref','activity_track_upload_intent','course','course_revision','course_revision_source','course_thumbnail','course_thumbnail_object_ref','healthkit_workout_sample','healthkit_workout_claim','healthkit_workout_lineage']
 WHEN 'resource_deleted' THEN ARRAY['resource','resource_version','resource_share','resource_access_audit','resource_object','resource_upload_intent','resource_grounding','resource_grounding_excerpt','resource_passage','resource_retrieval_cache','resource_citation']
 WHEN 'resource_share_revoked' THEN ARRAY['resource','resource_share','resource_access_audit','resource_grounding','resource_grounding_excerpt','resource_passage','resource_retrieval_cache','resource_citation']
 WHEN 'course_share_revoked' THEN ARRAY['course','course_share','course_share_audit']
 WHEN 'healthkit_consent_transition' THEN ARRAY['consent','healthkit_workout_sample','healthkit_workout_claim','healthkit_workout_batch_receipt','healthkit_workout_registration_receipt','healthkit_workout_registry_head','healthkit_workout_deregistration','healthkit_existing_binding','healthkit_workout_lineage']
 WHEN 'healthkit_workout_deregistration_pending' THEN ARRAY['consent','healthkit_workout_sample','healthkit_workout_claim','healthkit_workout_batch_receipt','healthkit_workout_registration_receipt','healthkit_workout_registry_head','healthkit_workout_deregistration','healthkit_workout_lineage','activity_canonical','activity_source_head','course','course_revision']
 WHEN 'healthkit_workout_deregistration_released' THEN ARRAY['consent','healthkit_workout_sample','healthkit_workout_claim','healthkit_workout_batch_receipt','healthkit_workout_registration_receipt','healthkit_workout_registry_head','healthkit_workout_deregistration','healthkit_workout_lineage','activity_canonical','activity_source_head','course','course_revision']
 WHEN 'ai_consent_transition' THEN ARRAY['consent','resource','resource_version','resource_grounding','resource_grounding_excerpt','resource_passage','resource_retrieval_cache','resource_citation']
 WHEN 'tenant_erased' THEN ARRAY['activity_canonical','activity_import_receipt','activity_overlay','activity_overlay_revision','activity_source_head','activity_source_revision','activity_suppression','activity_track','activity_track_object','activity_track_object_ref','activity_track_revision','activity_track_upload_intent','ai_settings_head','ai_settings_revision','approval_app_admission_binding','candidate_app_admission_binding','check_in','check_in_collection_head','check_in_receipt','check_in_revision','coaching_analysis_output','coaching_candidate','coaching_constraint','coaching_constraint_head','coaching_decision','coaching_message','coaching_proposal','coaching_run','coaching_thread','command_receipt','consent','core_evidence_snapshot','course','course_accessibility_note','course_deletion','course_disclosure_receipt','course_preference','course_privacy_zone','course_privacy_zone_share_offset','course_revision','course_revision_source','course_route_candidate_set','course_route_proposal','course_share','course_share_area_budget','course_share_audit','course_thumbnail','course_thumbnail_object_ref','evidence_app_admission_binding','food_definition_head','food_definition_version','gallery_media_derivative','gallery_media_item','gallery_media_object','gallery_upload_intent','garmin_activity_ledger','garmin_activity_ledger_source','garmin_attempt','garmin_connection','garmin_unofficial_connection','garmin_unofficial_run','healthkit_deregistration_work','healthkit_existing_binding','healthkit_workout_batch_receipt','healthkit_workout_claim','healthkit_workout_deregistration','healthkit_workout_lineage','healthkit_workout_registration_receipt','healthkit_workout_registry_head','healthkit_workout_sample','intake_entry','intake_entry_revision','integrated_approval_v4','integrated_candidate_app_admission_binding','integrated_candidate_v4','integrated_dependency_head','manual_race_chain_commit_v2','manual_race_chain_lifecycle_edge_v2','manual_race_chain_receipt_v2','manual_race_chain_source_ref_v2','manual_race_chain_suppression_v2','manual_race_decision_v2','manual_race_evidence_v2','manual_race_proposal_v2','manual_race_v2_live_transition','nutrition_integrated_candidate_disconnection','nutrition_plan_head','nutrition_plan_history','nutrition_plan_version','nutrition_race_disconnection_lineage','nutrition_race_item_disconnection','nutrition_v4_commit_seal','object_scope_purge','openai_budget_reservation','operations_audit','outbox','plan_head','plan_history','plan_scenario','plan_scenario_application','plan_scenario_revision','plan_snapshot','plan_snapshot_aggregate','race_collection_head','race_command_receipt','race_event','race_event_revision','race_manual_review','race_manual_review_source_ref','race_manual_review_source_suppression','race_result','race_result_proof_ref','race_result_revision','recovery_action_log','recovery_action_revision','recovery_method_head','recovery_method_version','recovery_strategy_head','recovery_strategy_history','recovery_strategy_version','resource','resource_access_audit','resource_citation','resource_derived_cleanup','resource_grounding','resource_grounding_excerpt','resource_object','resource_passage','resource_retrieval_cache','resource_share','resource_upload_intent','resource_url_artifact','resource_url_fetch_hop','resource_url_ingestion','resource_url_ingestion_attempt','resource_url_locator','resource_url_provenance','resource_version','restore_activity_replay_receipt','restore_actual_deletion_replay_context','restore_actual_deletion_replay_receipt','restore_ai_consent_replay_receipt','restore_app_consent_replay_receipt','restore_check_in_replay_receipt','restore_course_share_replay_context','restore_course_share_replay_receipt','restore_course_share_revoke_pending','restore_erasure_share_replay_receipt','restore_exact_replay_receipt','restore_gallery_media_replay_receipt','restore_healthkit_consent_replay_receipt','restore_manual_review_source_replay_receipt','restore_race_deletion_replay_receipt','restore_resource_compound_replay_receipt','restore_resource_replay_receipt','restore_resource_share_replay_receipt','restore_share_erasure_context','restore_suppression_event','routine_blueprint_head','routine_blueprint_version','routine_checklist_confirmation','routine_command_receipt','routine_occurrence','routine_run','routine_run_revision','routine_schedule_head','routine_schedule_history','routine_schedule_version','routine_step_timer','routing_admission','run_app_admission_binding','session_completion','session_completion_collection_head','session_completion_receipt','session_completion_revision','stretch_profile','stretching_log','stretching_log_revision','supplementary_execution','supplementary_exercise_head','supplementary_exercise_version','supplementary_rest_timer','supplementary_routine_head','supplementary_routine_target_ref','supplementary_routine_version','supplementary_session_link','supplementary_session_target_ref','supplementary_set_log','supplementary_set_log_revision','tenant_erasure','tenant_object_purge','tenant_work_index','training_best','training_best_revision','identity_private.account','identity_private.session','garmin_private.ownership','garmin_private.revocation','race_manual_application_candidate_v1','race_manual_application_context_v1','race_manual_application_receipt_v1','race_manual_application_history_v1']
 ELSE NULL END;
END $$;
CREATE FUNCTION wm_current_original_postimages.family_relation(t text) RETURNS regclass
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE relation_oid regclass;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM unnest(ARRAY['gallery_media_deleted','activity_deleted','resource_deleted','resource_share_revoked','course_share_revoked','healthkit_consent_transition','healthkit_workout_deregistration_pending','healthkit_workout_deregistration_released','ai_consent_transition','tenant_erased']) f WHERE t=ANY(wm_current_original_postimages.family_relations(f))) THEN RAISE EXCEPTION 'CURRENT_POST_RELATION_REJECTED'; END IF;
 relation_oid:=to_regclass(CASE WHEN position('.' IN t)>0 THEN t ELSE format('public.%I',t) END);
 IF relation_oid IS NULL THEN RAISE EXCEPTION 'CURRENT_POST_FULL_FAMILY_PROFILE_UNAVAILABLE: %',t; END IF;
 RETURN relation_oid;
END $$;
CREATE FUNCTION wm_current_original_postimages.family_physical(t text,v jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE a record; expressions text:=''; expression text; result jsonb; BEGIN
 IF NOT EXISTS(SELECT 1 FROM unnest(ARRAY['gallery_media_deleted','activity_deleted','resource_deleted','resource_share_revoked','course_share_revoked','healthkit_consent_transition','healthkit_workout_deregistration_pending','healthkit_workout_deregistration_released','ai_consent_transition','tenant_erased']) f WHERE t=ANY(wm_current_original_postimages.family_relations(f))) THEN RAISE EXCEPTION 'CURRENT_POST_RELATION_REJECTED'; END IF;
 PERFORM public.manual_race_v2_assert_json_bound(v);
 IF jsonb_typeof(v)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v) key) IS DISTINCT FROM (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid=wm_current_original_postimages.family_relation(t) AND attnum>0 AND NOT attisdropped) THEN RAISE EXCEPTION 'CURRENT_POST_PHYSICAL_COLUMNS_REJECTED'; END IF;
 FOR a IN SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=wm_current_original_postimages.family_relation(t) AND attnum>0 AND NOT attisdropped ORDER BY attnum LOOP
  expression:=format('r.%I',a.attname);
  IF a.type='timestamp with time zone' THEN expression:=format('to_char(r.%I AT TIME ZONE ''UTC'',''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'')',a.attname);
  ELSIF a.type IN ('bigint','numeric','name') THEN expression:=expression||'::text';
  ELSIF a.type='bytea' THEN expression:=format('CASE WHEN r.%I IS NULL THEN NULL ELSE chr(92)||''x''||encode(r.%I,''hex'') END',a.attname,a.attname); END IF;
  expressions:=expressions||CASE WHEN expressions='' THEN '' ELSE ',' END||format('%L,%s',a.attname,expression);
 END LOOP;
 EXECUTE format('SELECT jsonb_build_object(%s) FROM jsonb_populate_record(NULL::%s,$1) r',expressions,wm_current_original_postimages.family_relation(t)) INTO result USING v;
 IF result IS DISTINCT FROM v THEN RAISE EXCEPTION 'CURRENT_POST_PHYSICAL_ENCODING_REJECTED'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION wm_current_original_postimages.stage_family(p_run uuid,f text,v jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ DECLARE d wm_current_app_load.descriptor; names text[]; t text; n bigint:=0; BEGIN
 d:=wm_current_original_postimages.assert_context(p_run); names:=wm_current_original_postimages.family_relations(f); PERFORM public.manual_race_v2_assert_json_bound(v);
 IF names IS NULL OR jsonb_typeof(v)<>'object' OR v-ARRAY['profileVersion','catalogDigest','relationCensus','rowsDigest']<>'{}'::jsonb OR NOT(v ?& ARRAY['profileVersion','catalogDigest','relationCensus','rowsDigest']) OR v->>'profileVersion'<>'1' OR v->>'catalogDigest' IS DISTINCT FROM (SELECT target_digest FROM wm_current_original_postimages.profile) OR coalesce(v->>'rowsDigest','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(v->'relationCensus')<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v->'relationCensus') key) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(names) x) THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_PROOF_REJECTED'; END IF;
 FOR t IN SELECT unnest(names) LOOP
  IF coalesce(v->'relationCensus'->>t,'') !~ '^(0|[1-9][0-9]{0,3})$' THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_CENSUS_REJECTED'; END IF;
  n:=n+(v->'relationCensus'->>t)::bigint;
 END LOOP;
 IF n>5000 OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.run WHERE run_id=p_run AND owner_xid=txid_current() AND NOT applied AND NOT finished) THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_BOUND'; END IF;
 INSERT INTO wm_current_original_postimages.family VALUES(p_run,f,v,false);
END $$;
CREATE FUNCTION wm_current_original_postimages.stage_family_row(p_run uuid,f text,p_ordinal integer,t text,v jsonb,h text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; body jsonb; pk jsonb; key_columns text[]; bytes bigint; BEGIN
 d:=wm_current_original_postimages.assert_context(p_run);
 IF t<>ALL(coalesce(wm_current_original_postimages.family_relations(f),ARRAY[]::text[])) OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.family WHERE run_id=p_run AND family=f AND NOT sealed) OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.run WHERE run_id=p_run AND owner_xid=txid_current() AND NOT applied AND NOT finished) THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_ROW_REJECTED'; END IF;
 body:=wm_current_original_postimages.family_physical(t,v);
 IF v->>'athlete_id' IS DISTINCT FROM d.athlete_id OR wm_current_app_load.hash_json(body) IS DISTINCT FROM h THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_ROW_REJECTED'; END IF;
 SELECT array_agg(a.attname::text ORDER BY k.n) INTO key_columns FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid=wm_current_original_postimages.family_relation(t) AND c.contype='p';
 IF key_columns IS NULL THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_PK_UNAVAILABLE'; END IF;
 SELECT jsonb_agg(v->key ORDER BY ordinal) INTO pk FROM unnest(key_columns) WITH ORDINALITY k(key,ordinal);
 SELECT coalesce(sum(octet_length(physical_row::text)),0) INTO bytes FROM wm_current_original_postimages.family_row WHERE run_id=p_run;
 IF bytes+octet_length(body::text)>16777216 OR (SELECT count(*) FROM wm_current_original_postimages.family_row WHERE run_id=p_run)>=5000 THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_BOUND'; END IF;
 INSERT INTO wm_current_original_postimages.family_row VALUES(p_run,f,p_ordinal,t,body,h,pk);
END $$;
CREATE FUNCTION wm_current_original_postimages.seal_family(p_run uuid,f text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; proof jsonb; t text; n bigint; h text; matches boolean; r wm_current_original_postimages.family_row; predicates text; BEGIN
 d:=wm_current_original_postimages.assert_context(p_run);
 SELECT p.proof INTO STRICT proof FROM wm_current_original_postimages.family p WHERE run_id=p_run AND family=f AND NOT sealed FOR UPDATE;
 SELECT wm_current_app_load.hash_json(coalesce(jsonb_agg(jsonb_build_object('ordinal',ordinal,'relation',relation_name,'rowDigest',row_digest) ORDER BY ordinal),'[]'::jsonb)) INTO h FROM wm_current_original_postimages.family_row WHERE run_id=p_run AND family=f;
 IF h IS DISTINCT FROM proof->>'rowsDigest' THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_DIGEST_REJECTED'; END IF;
 FOREACH t IN ARRAY wm_current_original_postimages.family_relations(f) LOOP
  -- Current fixed families expose a tenant column. Global object cleanup queue
  -- rows are not admitted through this generic reader; regenerate via producers.
  EXECUTE format('SELECT count(*) FROM %s WHERE athlete_id::text=$1',wm_current_original_postimages.family_relation(t)) INTO n USING d.athlete_id;
  IF n<>(proof->'relationCensus'->>t)::bigint OR n<>(SELECT count(*) FROM wm_current_original_postimages.family_row WHERE run_id=p_run AND family=f AND relation_name=t) THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_CENSUS_REJECTED'; END IF;
 END LOOP;
 FOR r IN SELECT * FROM wm_current_original_postimages.family_row WHERE run_id=p_run AND family=f ORDER BY ordinal LOOP
  SELECT string_agg(format('to_jsonb(s.%I) IS NOT DISTINCT FROM to_jsonb(jsonb_populate_record(NULL::%s,$2))->%L',a.attname,wm_current_original_postimages.family_relation(r.relation_name),a.attname),' AND ' ORDER BY k.n) INTO predicates FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid=wm_current_original_postimages.family_relation(r.relation_name) AND c.contype='p';
  -- Typed storage equality is distinct from SQL physical and Node DTO digests.
  EXECUTE format('SELECT to_jsonb(s)=to_jsonb(jsonb_populate_record(NULL::%s,$2)) FROM %s s WHERE s.athlete_id::text=$1 AND %s',wm_current_original_postimages.family_relation(r.relation_name),wm_current_original_postimages.family_relation(r.relation_name),predicates) INTO STRICT matches USING d.athlete_id,r.physical_row;
  IF matches IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_PREIMAGE_REJECTED'; END IF;
 END LOOP;
 UPDATE wm_current_original_postimages.family SET sealed=true WHERE run_id=p_run AND family=f;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['family','family_row'] LOOP
  EXECUTE format('ALTER TABLE wm_current_original_postimages.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE wm_current_original_postimages.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY live_owner ON wm_current_original_postimages.%I USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass))) WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass)))',t,'wm_current_original_postimages.'||t,'wm_current_original_postimages.'||t);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA wm_current_original_postimages FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE FUNCTION wm_current_original_postimages.post_consent(p_run uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.restore_suppression_event; c public.consent; later public.restore_suppression_event; v_kind text;
 revision integer; granted boolean; resource record; sample record; head_is_final boolean; BEGIN
 e:=wm_current_original_postimages.original(p_run,p_event);
 v_kind:=CASE e.kind WHEN 'healthkit_consent_transition' THEN 'healthkit' WHEN 'ai_consent_transition' THEN 'ai' END;
 IF v_kind IS NULL OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.family WHERE run_id=p_run AND family=e.kind AND sealed) THEN RAISE EXCEPTION 'CURRENT_POST_CONSENT_PARTITION_UNAVAILABLE'; END IF;
 SELECT * INTO c FROM public.consent WHERE athlete_id=e.athlete_id AND public.consent.kind=v_kind FOR UPDATE;
 IF c.revision IS NULL THEN
  IF e.consent_previous_revision IS NOT NULL OR e.consent_revision<>1 THEN RAISE EXCEPTION 'CURRENT_POST_CONSENT_PREIMAGE_REJECTED'; END IF;
  PERFORM set_config(CASE v_kind WHEN 'healthkit' THEN 'app.restore_healthkit_consent_event_id' ELSE 'app.restore_ai_consent_event_id' END,e.event_id::text,true);
  INSERT INTO public.consent(athlete_id,kind,revision,granted) VALUES(e.athlete_id,v_kind,e.consent_revision,e.consent_granted);
  PERFORM set_config(CASE v_kind WHEN 'healthkit' THEN 'app.restore_healthkit_consent_event_id' ELSE 'app.restore_ai_consent_event_id' END,'',true);
 ELSIF c.revision=e.consent_previous_revision AND c.granted IS NOT DISTINCT FROM e.consent_previous_granted THEN
  PERFORM set_config(CASE v_kind WHEN 'healthkit' THEN 'app.restore_healthkit_consent_event_id' ELSE 'app.restore_ai_consent_event_id' END,e.event_id::text,true);
  UPDATE public.consent SET revision=e.consent_revision,granted=e.consent_granted WHERE athlete_id=e.athlete_id AND public.consent.kind=v_kind;
  PERFORM set_config(CASE v_kind WHEN 'healthkit' THEN 'app.restore_healthkit_consent_event_id' ELSE 'app.restore_ai_consent_event_id' END,'',true);
 ELSIF c.revision<e.consent_revision THEN RAISE EXCEPTION 'CURRENT_POST_CONSENT_PREIMAGE_REJECTED';
 END IF;
 SELECT * INTO STRICT c FROM public.consent WHERE athlete_id=e.athlete_id AND public.consent.kind=v_kind;
 revision:=e.consent_revision; granted:=e.consent_granted;
 -- Later head correspondence is proved only by the exact ordered staged records,
 -- not by a claimed granted flag or historical restore receipts.
 FOR later IN SELECT x.* FROM wm_current_original_postimages.member m JOIN public.restore_suppression_event x ON x.event_id=m.event_id WHERE m.run_id=p_run AND x.kind=e.kind AND x.consent_revision>revision AND x.consent_revision<=c.revision ORDER BY m.ordinal LOOP
  IF later.athlete_id<>e.athlete_id OR later.consent_previous_revision IS DISTINCT FROM revision OR later.consent_previous_granted IS DISTINCT FROM granted OR later.consent_revision<>revision+1 THEN RAISE EXCEPTION 'CURRENT_POST_CONSENT_CHAIN_REJECTED'; END IF;
  revision:=later.consent_revision; granted:=later.consent_granted;
 END LOOP;
 IF c.revision IS DISTINCT FROM revision OR c.granted IS DISTINCT FROM granted THEN RAISE EXCEPTION 'CURRENT_POST_CONSENT_HEAD_REJECTED'; END IF;
 head_is_final:=NOT c.granted;
 IF NOT e.consent_granted AND v_kind='healthkit' THEN
  -- Preserve genuinely later registrations/samples. A raw sample lacks its own
  -- consent epoch; an unclaimed post-withdrawal sample is therefore unsupported.
  IF NOT head_is_final AND EXISTS(SELECT 1 FROM public.healthkit_workout_sample s WHERE s.athlete_id=e.athlete_id AND s.received_at>e.occurred_at AND NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim cl WHERE cl.athlete_id=e.athlete_id AND cl.sample_id=s.sample_id AND cl.consent_revision>e.consent_revision)) THEN RAISE EXCEPTION 'CURRENT_POST_HEALTHKIT_EPOCH_UNAVAILABLE'; END IF;
  FOR sample IN SELECT s.sample_id FROM public.healthkit_workout_sample s WHERE s.athlete_id=e.athlete_id AND (head_is_final OR EXISTS(SELECT 1 FROM public.healthkit_workout_claim cl WHERE cl.athlete_id=e.athlete_id AND cl.sample_id=s.sample_id AND cl.consent_revision<=e.consent_revision) OR (s.received_at<=e.occurred_at AND NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim cl WHERE cl.athlete_id=e.athlete_id AND cl.sample_id=s.sample_id AND cl.consent_revision>e.consent_revision))) ORDER BY s.sample_id LOOP
   PERFORM public.purge_healthkit_deregistered_records(e.athlete_id,sample.sample_id);
  END LOOP;
  DELETE FROM public.healthkit_workout_registration_receipt r WHERE r.athlete_id=e.athlete_id AND (head_is_final OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.result_json->'claims') claim JOIN public.healthkit_workout_claim cl ON cl.sample_id=(claim->>'sampleId')::uuid AND cl.athlete_id=e.athlete_id WHERE cl.consent_revision<=e.consent_revision));
  DELETE FROM public.healthkit_workout_claim WHERE athlete_id=e.athlete_id AND (head_is_final OR consent_revision<=e.consent_revision);
  DELETE FROM public.healthkit_workout_deregistration WHERE athlete_id=e.athlete_id AND (head_is_final OR consent_revision<=e.consent_revision);
  UPDATE public.healthkit_workout_batch_receipt SET request_digest=NULL,purged_at=e.occurred_at WHERE athlete_id=e.athlete_id AND purged_at IS NULL AND (head_is_final OR received_at<=e.occurred_at);
  IF head_is_final THEN DELETE FROM public.healthkit_workout_registry_head WHERE athlete_id=e.athlete_id; END IF;
  -- Binding command bodies carry sample/private source facts; preserve unrelated
  -- namespaces. Already minimal receipts remain minimal on repeat.
  UPDATE public.command_receipt SET request='{"purged":true}',result='{"purged":true}' WHERE athlete_id=e.athlete_id AND idempotency_key LIKE 'healthkit-bind-existing:%' AND head_is_final;
 ELSIF NOT e.consent_granted AND v_kind='ai' THEN
  -- Only derived stores are cleaned. Own retained raw text, food/intake and
  -- manual processing purpose are not interpreted as AI-derived deletion.
  DELETE FROM public.resource_grounding_excerpt ex WHERE ex.athlete_id=e.athlete_id AND (head_is_final OR EXISTS(SELECT 1 FROM public.resource_grounding g WHERE g.athlete_id=e.athlete_id AND g.grounding_id=ex.grounding_id AND g.captured_at<=e.occurred_at));
  DELETE FROM public.resource_passage WHERE athlete_id=e.athlete_id AND (head_is_final OR created_at<=e.occurred_at);
  DELETE FROM public.resource_retrieval_cache WHERE athlete_id=e.athlete_id AND (head_is_final OR created_at<=e.occurred_at);
  DELETE FROM public.resource_citation WHERE athlete_id=e.athlete_id AND (head_is_final OR created_at<=e.occurred_at);
  IF head_is_final THEN
   FOR resource IN UPDATE public.resource SET include_for_coach=false,coach_use_enabled_at=NULL,access_revision=access_revision+1,updated_at=greatest(updated_at,e.occurred_at) WHERE athlete_id=e.athlete_id AND include_for_coach AND deleted_at IS NULL AND access_revision<2147483647 RETURNING id,access_revision LOOP
    PERFORM public.queue_resource_derived_cleanup(e.athlete_id,resource.id,'consent_withdrawn',resource.access_revision);
   END LOOP;
   IF EXISTS(SELECT 1 FROM public.resource WHERE athlete_id=e.athlete_id AND include_for_coach AND deleted_at IS NULL) THEN RAISE EXCEPTION 'CURRENT_POST_RESOURCE_REVISION_OVERFLOW'; END IF;
  END IF;
 END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE TABLE wm_current_original_postimages.transition (
 run_id uuid NOT NULL,event_id uuid NOT NULL,relation_name text NOT NULL,operation text NOT NULL,
 before_row jsonb,after_row jsonb NOT NULL,owner_xid bigint NOT NULL,consumed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(run_id,event_id,relation_name),FOREIGN KEY(run_id,event_id) REFERENCES wm_current_original_postimages.member(run_id,event_id),
 CHECK(relation_name IN ('public.course_share','public.course_share_audit','public.intake_entry','public.recovery_action_log','public.tenant_erasure')),
 CHECK(operation IN ('UPDATE','INSERT'))
);
ALTER TABLE wm_current_original_postimages.transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_current_original_postimages.transition FORCE ROW LEVEL SECURITY;
CREATE POLICY live_owner ON wm_current_original_postimages.transition USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_current_original_postimages.transition'::regclass))) WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_current_original_postimages.transition'::regclass)));
REVOKE ALL ON TABLE wm_current_original_postimages.transition FROM PUBLIC;
CREATE FUNCTION wm_current_original_postimages.prepare_transition(p_run uuid,p_event uuid,relation text,old_row jsonb,new_row jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.restore_suppression_event; expected jsonb; actual jsonb; t text; actual_id text; BEGIN
 e:=wm_current_original_postimages.original(p_run,p_event);
 PERFORM public.manual_race_v2_assert_json_bound(new_row);
 IF relation='public.tenant_erasure' THEN
  IF e.kind<>'tenant_erased' OR old_row IS NOT NULL OR EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=e.athlete_id) OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.family WHERE run_id=p_run AND family='tenant_erased' AND sealed) THEN RAISE EXCEPTION 'CURRENT_POST_ERASURE_TRANSITION_REJECTED'; END IF;
  expected:=jsonb_build_object('athlete_id',e.athlete_id,'erased_at',to_jsonb(e.occurred_at));
 ELSIF relation='public.course_share' THEN
  IF e.kind<>'course_share_revoked' OR e.record_version<>2 THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_KIND_REJECTED'; END IF;
  SELECT to_jsonb(s) INTO STRICT actual FROM public.course_share s WHERE s.athlete_id=e.athlete_id AND s.share_id=e.course_share_id FOR UPDATE;
  IF actual IS DISTINCT FROM old_row OR old_row->>'course_id'<>e.target_id::text OR (old_row->>'epoch')::integer<>e.course_share_epoch OR (old_row->>'course_revision')::integer<>e.course_share_course_revision OR old_row->>'state'<>'active' OR (old_row->>'created_at')::timestamptz>e.occurred_at THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_PREIMAGE_REJECTED'; END IF;
  expected:=old_row||jsonb_build_object('state','revoked','revoked_at',to_jsonb(e.occurred_at),'revoke_reason',e.course_share_revoke_reason);
 ELSIF relation='public.course_share_audit' THEN
  IF e.kind<>'course_share_revoked' OR e.record_version<>2 OR old_row IS NOT NULL THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_KIND_REJECTED'; END IF;
  expected:=jsonb_build_object('athlete_id',e.athlete_id,'audit_id',e.course_share_audit_id,'share_id',e.course_share_id,'course_id',e.target_id,'action','revoked','reason',e.course_share_revoke_reason,'occurred_at',to_jsonb(e.course_share_audit_occurred_at));
  IF NOT EXISTS(SELECT 1 FROM public.course_share s WHERE s.athlete_id=e.athlete_id AND s.share_id=e.course_share_id AND s.course_id=e.target_id AND s.epoch=e.course_share_epoch AND s.course_revision=e.course_share_course_revision AND s.state='revoked' AND s.revoke_reason=e.course_share_revoke_reason AND s.revoked_at=e.occurred_at) THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_SHARE_REQUIRED'; END IF;
 ELSIF relation='public.intake_entry' THEN
  IF e.kind<>'intake_entry_deleted' OR e.record_version<>2 THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_KIND_REJECTED'; END IF;
  SELECT intake_id INTO STRICT actual_id FROM public.intake_entry_revision WHERE athlete_id=e.athlete_id AND revision_id=e.target_id AND revision=1 AND status='active';
  SELECT to_jsonb(h) INTO STRICT actual FROM public.intake_entry h WHERE h.athlete_id=e.athlete_id AND h.id=actual_id FOR UPDATE;
  IF actual IS DISTINCT FROM old_row OR old_row->>'status'<>'active' OR (old_row->>'current_revision')::integer<>e.actual_deletion_revision-1 OR old_row->>'current_revision_id'<>e.actual_previous_revision_id::text OR NOT EXISTS(SELECT 1 FROM public.intake_entry_revision r WHERE r.athlete_id=e.athlete_id AND r.intake_id=actual_id AND r.revision=e.actual_deletion_revision AND r.revision_id=e.actual_deleted_revision_id AND r.status='deleted' AND r.recorded_at=e.occurred_at AND r.deleted_at=e.occurred_at AND r.deletion_reason='user_requested') THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_PREIMAGE_REJECTED'; END IF;
  expected:=old_row||jsonb_build_object('status','deleted','current_revision',e.actual_deletion_revision,'current_revision_id',e.actual_deleted_revision_id);
 ELSIF relation='public.recovery_action_log' THEN
  IF e.kind<>'recovery_action_deleted' OR e.record_version<>2 THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_KIND_REJECTED'; END IF;
  SELECT to_jsonb(h) INTO STRICT actual FROM public.recovery_action_log h WHERE h.athlete_id=e.athlete_id AND h.action_id=e.target_id FOR UPDATE;
  IF actual IS DISTINCT FROM old_row OR old_row->>'status'<>'active' OR (old_row->>'revision')::integer<>e.actual_deletion_revision-1 OR old_row->>'revision_id'<>e.actual_previous_revision_id::text OR NOT EXISTS(SELECT 1 FROM public.recovery_action_revision r WHERE r.athlete_id=e.athlete_id AND r.action_id=e.target_id AND r.revision=e.actual_deletion_revision AND r.revision_id=e.actual_deleted_revision_id AND r.status='deleted' AND r.record_json=jsonb_build_object('actionId',e.target_id::text,'revisionId',e.actual_deleted_revision_id::text,'revision',e.actual_deletion_revision,'status','deleted','deletedAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_PREIMAGE_REJECTED'; END IF;
  expected:=old_row||jsonb_build_object('status','deleted','revision',e.actual_deletion_revision,'revision_id',e.actual_deleted_revision_id);
 ELSE RAISE EXCEPTION 'CURRENT_POST_TRANSITION_RELATION_REJECTED';
 END IF;
 IF expected IS DISTINCT FROM new_row THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_POSTIMAGE_REJECTED'; END IF;
 INSERT INTO wm_current_original_postimages.transition VALUES(p_run,p_event,relation,CASE WHEN old_row IS NULL THEN 'INSERT' ELSE 'UPDATE' END,old_row,new_row,txid_current(),false);
END $$;
CREATE FUNCTION wm_current_original_postimages.consume_transition(p_relation text,p_operation text,old_row jsonb,new_row jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ DECLARE t wm_current_original_postimages.transition; e public.restore_suppression_event; BEGIN
 -- Runtime calls do not probe private tables; capability is not a claimed GUC.
 IF session_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_current_original_postimages.transition'::regclass)) OR current_user<>session_user THEN RETURN false; END IF;
 SELECT * INTO t FROM wm_current_original_postimages.transition x WHERE x.owner_xid=txid_current() AND x.relation_name=p_relation AND x.operation=p_operation AND x.before_row IS NOT DISTINCT FROM old_row AND x.after_row=new_row AND NOT x.consumed FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 e:=wm_current_original_postimages.original(t.run_id,t.event_id);
 UPDATE wm_current_original_postimages.transition SET consumed=true WHERE run_id=t.run_id AND event_id=t.event_id AND relation_name=t.relation_name AND NOT consumed;
 IF NOT FOUND THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_CONSUMED'; END IF;
 RETURN true;
END $$;
CREATE TABLE wm_current_original_postimages.predecessor (
 signature text PRIMARY KEY,prosrc text NOT NULL,prosrc_digest text NOT NULL,security_definer boolean NOT NULL,
 config text[],owner_oid oid NOT NULL,acl aclitem[]
);
ALTER TABLE wm_current_original_postimages.predecessor ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_current_original_postimages.predecessor FORCE ROW LEVEL SECURITY;
CREATE POLICY live_owner ON wm_current_original_postimages.predecessor USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_current_original_postimages.predecessor'::regclass))) WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='wm_current_original_postimages.predecessor'::regclass)));
REVOKE ALL ON TABLE wm_current_original_postimages.predecessor FROM PUBLIC;
DO $$ DECLARE entry record; p pg_proc; definition text; source text; prefix text; anchor text; old_hash text; BEGIN
 FOR entry IN SELECT * FROM (VALUES
 ('public.record_course_share_revoke_suppression_event()','63d548af3409b4ed94677df93f945ff8dbe0315863abfc8769af9421f2c1e13c','  INSERT INTO public.restore_course_share_revoke_pending('),
 ('public.finish_course_share_revoke_provenance()','26e227d7c1011f952336d9d72352131061641c1da18bf6071798a7e0a19e1b05','  SELECT * INTO pending FROM public.restore_course_share_revoke_pending p'),
 ('public.record_intake_entry_deletion_suppression_event()','bce21914947c8618ee4a76a9ebb23064bdf80f5f7b75ba92a3611a44d428489f','  INSERT INTO public.restore_suppression_event('),
 ('public.record_recovery_action_deletion_suppression_event()','c81a235f7a784a6b62c698c9b3fe8be7c21a674925eed4254e1eddf75e393be9','  INSERT INTO public.restore_suppression_event(')
 ) AS pins(signature,digest,anchor) LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=entry.signature::regprocedure;
  old_hash:=encode(sha256(convert_to(p.prosrc,'UTF8')),'hex');
  IF old_hash<>entry.digest OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] OR p.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.restore_suppression_event'::regclass) OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE') THEN RAISE EXCEPTION 'CURRENT_POST_PREDECESSOR_REJECTED: %',entry.signature; END IF;
  INSERT INTO wm_current_original_postimages.predecessor VALUES(entry.signature,p.prosrc,old_hash,p.prosecdef,p.proconfig,p.proowner,p.proacl);
  prefix:=E'  -- CURRENT_POST_EXACT_TRANSITION_BEGIN\n  IF wm_current_original_postimages.consume_transition(TG_TABLE_SCHEMA||''.''||TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP=''INSERT'' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NULL; END IF;\n  -- CURRENT_POST_EXACT_TRANSITION_END\n';
  IF position(entry.anchor IN p.prosrc)=0 OR length(p.prosrc)-length(replace(p.prosrc,entry.anchor,''))<>length(entry.anchor) THEN RAISE EXCEPTION 'CURRENT_POST_PREDECESSOR_ANCHOR_REJECTED'; END IF;
  source:=replace(p.prosrc,entry.anchor,prefix||entry.anchor);
  definition:=pg_get_functiondef(p.oid);
  IF position(p.prosrc IN definition)=0 THEN RAISE EXCEPTION 'CURRENT_POST_PREDECESSOR_DEFINITION_REJECTED'; END IF;
  EXECUTE replace(definition,p.prosrc,source);
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=entry.signature::regprocedure;
  IF p.prosrc<>source OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] OR p.proacl IS DISTINCT FROM (SELECT acl FROM wm_current_original_postimages.predecessor WHERE signature=entry.signature) OR NOT p.prosecdef OR p.proowner<>(SELECT owner_oid FROM wm_current_original_postimages.predecessor WHERE signature=entry.signature) THEN RAISE EXCEPTION 'CURRENT_POST_PREDECESSOR_METADATA_CHANGED'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

-- Registry replay is derived from the exact staged original. It never invokes
-- the live deregistration producer, inserts an original, or invents a new epoch.
CREATE FUNCTION wm_current_original_postimages.post_healthkit_registry(p_run uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.restore_suppression_event; pending public.restore_suppression_event;
 op public.healthkit_workout_deregistration; scope jsonb; pending_ordinal integer; current_ordinal integer;
BEGIN
 e:=wm_current_original_postimages.original(p_run,p_event);
 IF e.record_version<>3 OR e.kind NOT IN ('healthkit_workout_deregistration_pending','healthkit_workout_deregistration_released')
 OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.family WHERE run_id=p_run AND family=e.kind AND sealed)
 OR NOT coalesce(public.valid_healthkit_object_scopes(e.healthkit_object_scopes),false)
 THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_SOURCE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=e.athlete_id)
 OR NOT EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id::text=e.athlete_id)
 THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_TENANT_REJECTED'; END IF;
 SELECT * INTO op FROM public.healthkit_workout_deregistration WHERE athlete_id=e.athlete_id AND operation_id=e.healthkit_operation_id FOR UPDATE;
 IF FOUND AND (op.sample_id IS DISTINCT FROM e.target_id OR op.claim_epoch IS DISTINCT FROM e.healthkit_claim_epoch
 OR op.consent_revision IS DISTINCT FROM e.healthkit_consent_revision OR op.object_scopes IS DISTINCT FROM e.healthkit_object_scopes)
 THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_OPERATION_REJECTED'; END IF;
 IF e.kind='healthkit_workout_deregistration_released' THEN
  SELECT p.* INTO pending FROM public.restore_suppression_event p JOIN wm_current_original_postimages.member m
   ON m.event_id=p.event_id AND m.run_id=p_run WHERE p.athlete_id=e.athlete_id AND p.kind='healthkit_workout_deregistration_pending' AND p.healthkit_operation_id=e.healthkit_operation_id;
  -- The pending original must be part of this independently supplied ordered
  -- roster and its postimage must already have been checked in this run.
  IF pending.event_id IS NULL OR pending.target_id IS DISTINCT FROM e.target_id OR pending.healthkit_claim_epoch IS DISTINCT FROM e.healthkit_claim_epoch
  OR pending.healthkit_consent_revision IS DISTINCT FROM e.healthkit_consent_revision OR pending.healthkit_object_scopes IS DISTINCT FROM e.healthkit_object_scopes
  OR pending.healthkit_registry_revision>e.healthkit_registry_previous_revision OR pending.occurred_at>e.occurred_at
  OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.audit WHERE run_id=p_run AND event_id=pending.event_id)
  OR op.operation_id IS NULL THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_PENDING_REQUIRED'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.activity_source_head h JOIN public.activity_canonical c ON c.athlete_id=h.athlete_id AND c.id=h.activity_id
   WHERE h.athlete_id=e.athlete_id AND h.kind='healthkit' AND h.source_id=e.target_id::text AND NOT c.deleted)
  THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_ACTIVITY_DELETION_REQUIRED'; END IF;
  INSERT INTO public.healthkit_workout_claim(sample_id,athlete_id,claim_epoch,consent_revision)
   VALUES(e.target_id,e.athlete_id,e.healthkit_claim_epoch,e.healthkit_consent_revision) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim WHERE athlete_id=e.athlete_id AND sample_id=e.target_id) THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_CLAIM_UNAVAILABLE'; END IF;
  INSERT INTO public.healthkit_workout_deregistration(athlete_id,operation_id,sample_id,claim_epoch,consent_revision,
   idempotency_key,request_digest,state,registry_revision,object_scopes,requested_at)
   VALUES(e.athlete_id,e.healthkit_operation_id,e.target_id,e.healthkit_claim_epoch,e.healthkit_consent_revision,
   'restore-'||e.healthkit_operation_id,repeat('0',64),'pending_cleanup',e.healthkit_registry_revision,e.healthkit_object_scopes,e.occurred_at)
   ON CONFLICT(athlete_id,operation_id) DO NOTHING;
 END IF;
 -- A subsequent distinct epoch is retained. Old raw/sample bodies and derived
 -- objects are swept again when no newer owner claim supersedes this original.
 IF NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim WHERE athlete_id=e.athlete_id AND sample_id=e.target_id AND claim_epoch<>e.healthkit_claim_epoch)
 THEN PERFORM public.purge_healthkit_deregistered_records(e.athlete_id,e.target_id); END IF;
 INSERT INTO public.healthkit_workout_registry_head(athlete_id,revision) VALUES(e.athlete_id,e.healthkit_registry_revision)
 ON CONFLICT(athlete_id) DO UPDATE SET revision=greatest(healthkit_workout_registry_head.revision,EXCLUDED.revision);
 IF e.kind='healthkit_workout_deregistration_released' THEN
  DELETE FROM public.healthkit_workout_claim WHERE athlete_id=e.athlete_id AND sample_id=e.target_id AND claim_epoch=e.healthkit_claim_epoch;
  UPDATE public.healthkit_workout_deregistration SET state='released',released_at=e.occurred_at,registry_revision=e.healthkit_registry_revision
   WHERE athlete_id=e.athlete_id AND operation_id=e.healthkit_operation_id;
 END IF;
 FOR scope IN SELECT * FROM jsonb_array_elements(e.healthkit_object_scopes) LOOP
  IF NOT public.arm_object_scope_purge(e.athlete_id,scope->>'kind',(scope->>'id')::uuid)
  THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_PURGE_NOT_ARMED'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.healthkit_workout_deregistration d WHERE d.athlete_id=e.athlete_id
  AND d.operation_id=e.healthkit_operation_id AND d.sample_id=e.target_id AND d.claim_epoch=e.healthkit_claim_epoch
  AND d.consent_revision=e.healthkit_consent_revision AND d.object_scopes=e.healthkit_object_scopes
  AND (e.kind='healthkit_workout_deregistration_pending' AND d.state IN ('pending_cleanup','released')
   OR e.kind='healthkit_workout_deregistration_released' AND d.state='released' AND d.released_at=e.occurred_at))
 THEN RAISE EXCEPTION 'CURRENT_POST_REGISTRY_POSTIMAGE_REJECTED'; END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE FUNCTION wm_current_original_postimages.post_share(p_run uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.restore_suppression_event; s record; h record; before_row jsonb; after_row jsonb; audit_row jsonb;
BEGIN
 e:=wm_current_original_postimages.original(p_run,p_event);
 IF NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.family WHERE run_id=p_run AND family=e.kind AND sealed)
 THEN RAISE EXCEPTION 'CURRENT_POST_SHARE_SOURCE_REQUIRED'; END IF;
 IF e.kind='resource_share_revoked' THEN
  SELECT * INTO STRICT s FROM public.resource_share WHERE athlete_id=e.athlete_id AND share_id=e.share_id FOR UPDATE;
  SELECT * INTO STRICT h FROM public.resource WHERE athlete_id=e.athlete_id AND id=e.target_id FOR UPDATE;
  IF s.resource_id<>e.target_id OR s.granted_access_revision<>e.share_granted_access_revision OR s.granted_at>e.occurred_at
  THEN RAISE EXCEPTION 'CURRENT_POST_SHARE_TUPLE_REJECTED'; END IF;
  IF s.state='active' THEN
   IF s.revoked_at IS NOT NULL OR s.updated_at>e.occurred_at THEN RAISE EXCEPTION 'CURRENT_POST_SHARE_PREIMAGE_REJECTED'; END IF;
   IF e.share_cause_kind='resource_deleted' THEN
    IF h.deleted_at IS NULL OR h.access_revision<>e.share_revoked_access_revision
     OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.audit WHERE run_id=p_run AND event_id=e.share_cause_event_id)
    THEN RAISE EXCEPTION 'CURRENT_POST_SHARE_PARENT_REQUIRED'; END IF;
   ELSE
    IF h.deleted_at IS NOT NULL OR h.access_revision<>e.share_revoked_access_revision-1 THEN RAISE EXCEPTION 'CURRENT_POST_SHARE_PREIMAGE_REJECTED'; END IF;
    UPDATE public.resource SET access_revision=e.share_revoked_access_revision,updated_at=e.occurred_at WHERE athlete_id=e.athlete_id AND id=e.target_id;
   END IF;
   PERFORM set_config('app.restore_resource_share_event_id',e.event_id::text,true);
   UPDATE public.resource_share SET state='revoked',revoked_at=e.occurred_at,revoked_access_revision=e.share_revoked_access_revision,updated_at=e.occurred_at
    WHERE athlete_id=e.athlete_id AND share_id=e.share_id;
   PERFORM set_config('app.restore_resource_share_event_id','',true);
  ELSIF s.state<>'revoked' OR s.revoked_at IS DISTINCT FROM e.occurred_at OR s.revoked_access_revision IS DISTINCT FROM e.share_revoked_access_revision
  THEN RAISE EXCEPTION 'CURRENT_POST_SHARE_POSTIMAGE_REJECTED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.resource_access_audit WHERE athlete_id=e.athlete_id AND event_id=e.event_id) THEN
   INSERT INTO public.resource_access_audit(athlete_id,event_id,resource_id,action,access_revision,share_id,grantee_kind,grantee_principal_id,occurred_at)
   VALUES(e.athlete_id,e.event_id,e.target_id,'share_revoked',e.share_revoked_access_revision,e.share_id,s.grantee_kind,s.grantee_principal_id,e.occurred_at);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.resource_access_audit a WHERE a.athlete_id=e.athlete_id AND a.event_id=e.event_id AND a.resource_id=e.target_id
   AND a.action='share_revoked' AND a.access_revision=e.share_revoked_access_revision AND a.share_id=e.share_id
   AND a.grantee_kind=s.grantee_kind AND a.grantee_principal_id=s.grantee_principal_id AND a.occurred_at=e.occurred_at)
  THEN RAISE EXCEPTION 'CURRENT_POST_SHARE_AUDIT_REJECTED'; END IF;
  PERFORM public.queue_resource_derived_cleanup(e.athlete_id,e.target_id,'share_revoked',e.share_revoked_access_revision);
 ELSIF e.kind='course_share_revoked' AND e.record_version=2 THEN
  SELECT * INTO STRICT s FROM public.course_share WHERE athlete_id=e.athlete_id AND share_id=e.course_share_id FOR UPDATE;
  SELECT * INTO STRICT h FROM public.course WHERE athlete_id=e.athlete_id AND course_id=e.target_id FOR UPDATE;
  IF s.course_id<>e.target_id OR s.course_revision<>e.course_share_course_revision OR s.epoch<>e.course_share_epoch OR (h.status<>'available' AND NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.member later JOIN public.restore_suppression_event cause ON cause.event_id=later.event_id WHERE later.run_id=p_run AND later.ordinal>(SELECT ordinal FROM wm_current_original_postimages.member WHERE run_id=p_run AND event_id=p_event) AND cause.athlete_id=e.athlete_id AND ((cause.kind='course_deleted' AND cause.target_id=e.target_id AND h.status='deleted') OR (cause.kind='activity_deleted' AND h.status='unavailable' AND EXISTS(SELECT 1 FROM public.course_revision_source edge WHERE edge.athlete_id=e.athlete_id AND edge.course_id=e.target_id AND edge.activity_id=cause.target_id)))))
  THEN RAISE EXCEPTION 'CURRENT_POST_COURSE_SHARE_TUPLE_REJECTED'; END IF;
  IF s.state='active' THEN
   before_row:=to_jsonb(s);after_row:=before_row||jsonb_build_object('state','revoked','revoked_at',to_jsonb(e.occurred_at),'revoke_reason',e.course_share_revoke_reason);
   PERFORM wm_current_original_postimages.prepare_transition(p_run,p_event,'public.course_share',before_row,after_row);
   UPDATE public.course_share SET state='revoked',revoked_at=e.occurred_at,revoke_reason=e.course_share_revoke_reason WHERE athlete_id=e.athlete_id AND share_id=e.course_share_id;
  ELSIF s.state<>'revoked' OR s.revoked_at IS DISTINCT FROM e.occurred_at OR s.revoke_reason IS DISTINCT FROM e.course_share_revoke_reason
  THEN RAISE EXCEPTION 'CURRENT_POST_COURSE_SHARE_POSTIMAGE_REJECTED'; END IF;
  audit_row:=jsonb_build_object('athlete_id',e.athlete_id,'audit_id',e.course_share_audit_id,'share_id',e.course_share_id,'course_id',e.target_id,
   'action','revoked','reason',e.course_share_revoke_reason,'occurred_at',to_jsonb(e.course_share_audit_occurred_at));
  IF NOT EXISTS(SELECT 1 FROM public.course_share_audit WHERE athlete_id=e.athlete_id AND audit_id=e.course_share_audit_id) THEN
   PERFORM wm_current_original_postimages.prepare_transition(p_run,p_event,'public.course_share_audit',NULL,audit_row);
   INSERT INTO public.course_share_audit SELECT (jsonb_populate_record(NULL::public.course_share_audit,audit_row)).*;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.course_share_audit a WHERE a.athlete_id=e.athlete_id AND a.audit_id=e.course_share_audit_id AND to_jsonb(a)=audit_row)
  THEN RAISE EXCEPTION 'CURRENT_POST_COURSE_SHARE_AUDIT_REJECTED'; END IF;
 ELSE RAISE EXCEPTION 'CURRENT_POST_SHARE_KIND_REJECTED'; END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE FUNCTION wm_current_original_postimages.prepare_actual_postimage(p_run uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.restore_suppression_event; h record; prior record; actual_id text; history_count bigint; before_row jsonb; after_row jsonb;
BEGIN
 e:=wm_current_original_postimages.original(p_run,p_event);
 IF e.record_version<>2 OR e.actual_deletion_revision<2 OR e.actual_previous_revision_id IS NULL OR e.actual_deleted_revision_id IS NULL
 THEN RAISE EXCEPTION 'CURRENT_POST_ACTUAL_IDENTITY_REJECTED'; END IF;
 IF e.kind='intake_entry_deleted' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['intake_entry','intake_entry_revision']);
  SELECT intake_id INTO STRICT actual_id FROM public.intake_entry_revision WHERE athlete_id=e.athlete_id AND revision_id=e.target_id AND revision=1 AND status='active';
  SELECT * INTO STRICT h FROM public.intake_entry WHERE athlete_id=e.athlete_id AND id=actual_id FOR UPDATE;
  IF h.status='deleted' THEN RETURN; END IF;
  SELECT * INTO STRICT prior FROM public.intake_entry_revision WHERE athlete_id=e.athlete_id AND intake_id=actual_id AND revision=e.actual_deletion_revision-1;
  SELECT count(*) INTO history_count FROM public.intake_entry_revision WHERE athlete_id=e.athlete_id AND intake_id=actual_id;
  IF h.status<>'active' OR h.current_revision<>e.actual_deletion_revision-1 OR h.current_revision_id<>e.actual_previous_revision_id
   OR prior.revision_id<>e.actual_previous_revision_id OR prior.status<>'active' OR prior.recorded_at>e.occurred_at
   OR prior.deleted_at IS NOT NULL OR history_count<>e.actual_deletion_revision-1
  THEN RAISE EXCEPTION 'CURRENT_POST_ACTUAL_HISTORY_REJECTED'; END IF;
  INSERT INTO public.intake_entry_revision(athlete_id,intake_id,revision,revision_id,status,recorded_at,deleted_at,deletion_reason)
   VALUES(e.athlete_id,actual_id,e.actual_deletion_revision,e.actual_deleted_revision_id,'deleted',e.occurred_at,e.occurred_at,'user_requested');
  before_row:=to_jsonb(h);after_row:=before_row||jsonb_build_object('status','deleted','current_revision',e.actual_deletion_revision,'current_revision_id',e.actual_deleted_revision_id);
  PERFORM wm_current_original_postimages.prepare_transition(p_run,p_event,'public.intake_entry',before_row,after_row);
  UPDATE public.intake_entry SET current_revision=e.actual_deletion_revision,current_revision_id=e.actual_deleted_revision_id,status='deleted'
   WHERE athlete_id=e.athlete_id AND id=actual_id;
 ELSIF e.kind='recovery_action_deleted' THEN
  PERFORM wm_current_original_postimages.require_parent_profile(p_run,ARRAY['recovery_action_log','recovery_action_revision']);
  SELECT * INTO STRICT h FROM public.recovery_action_log WHERE athlete_id=e.athlete_id AND action_id=e.target_id FOR UPDATE;
  IF h.status='deleted' THEN RETURN; END IF;
  SELECT * INTO STRICT prior FROM public.recovery_action_revision WHERE athlete_id=e.athlete_id AND action_id=e.target_id AND revision=e.actual_deletion_revision-1;
  SELECT count(*) INTO history_count FROM public.recovery_action_revision WHERE athlete_id=e.athlete_id AND action_id=e.target_id;
  IF h.status<>'active' OR h.revision<>e.actual_deletion_revision-1 OR h.revision_id<>e.actual_previous_revision_id
   OR prior.revision_id<>e.actual_previous_revision_id OR prior.status<>'active' OR history_count<>e.actual_deletion_revision-1
  THEN RAISE EXCEPTION 'CURRENT_POST_ACTUAL_HISTORY_REJECTED'; END IF;
  INSERT INTO public.recovery_action_revision(athlete_id,action_id,revision,revision_id,status,record_json)
   VALUES(e.athlete_id,e.target_id,e.actual_deletion_revision,e.actual_deleted_revision_id,'deleted',jsonb_build_object(
    'actionId',e.target_id::text,'revisionId',e.actual_deleted_revision_id::text,'revision',e.actual_deletion_revision,'status','deleted',
    'deletedAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  before_row:=to_jsonb(h);after_row:=before_row||jsonb_build_object('status','deleted','revision',e.actual_deletion_revision,'revision_id',e.actual_deleted_revision_id);
  PERFORM wm_current_original_postimages.prepare_transition(p_run,p_event,'public.recovery_action_log',before_row,after_row);
  UPDATE public.recovery_action_log SET revision=e.actual_deletion_revision,revision_id=e.actual_deleted_revision_id,status='deleted'
   WHERE athlete_id=e.athlete_id AND action_id=e.target_id;
 ELSE RAISE EXCEPTION 'CURRENT_POST_ACTUAL_KIND_REJECTED'; END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE FUNCTION wm_current_original_postimages.post_erasure(p_run uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.restore_suppression_event; stamp timestamptz; remaining bigint;
BEGIN
 e:=wm_current_original_postimages.original(p_run,p_event);
 IF e.kind<>'tenant_erased' OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.family WHERE run_id=p_run AND family=e.kind AND sealed)
 THEN RAISE EXCEPTION 'CURRENT_POST_ERASURE_SOURCE_REQUIRED'; END IF;
 -- The predecessor's base early-return deliberately remains unchanged. Current
 -- source copies must nevertheless be erased again under the same original.
 IF NOT EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=e.athlete_id) THEN
  PERFORM wm_current_original_postimages.prepare_transition(p_run,p_event,'public.tenant_erasure',NULL,jsonb_build_object('athlete_id',e.athlete_id,'erased_at',to_jsonb(e.occurred_at)));
  INSERT INTO public.tenant_erasure(athlete_id,erased_at) VALUES(e.athlete_id,e.occurred_at);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=e.athlete_id AND erased_at=e.occurred_at) THEN RAISE EXCEPTION 'CURRENT_POST_ERASURE_MARKER_REJECTED'; END IF;
 stamp:=public.erase_account(e.athlete_id);
 IF stamp<>e.occurred_at THEN RAISE EXCEPTION 'CURRENT_POST_ERASURE_MARKER_REJECTED'; END IF;
 DELETE FROM public.activity_overlay_revision WHERE athlete_id=e.athlete_id;
 DELETE FROM public.activity_overlay WHERE athlete_id=e.athlete_id;
 DELETE FROM public.activity_suppression WHERE athlete_id=e.athlete_id;
 DELETE FROM public.activity_source_revision WHERE athlete_id=e.athlete_id;
 DELETE FROM public.activity_source_head WHERE athlete_id=e.athlete_id;
 DELETE FROM public.activity_canonical WHERE athlete_id=e.athlete_id;
 DELETE FROM public.activity_import_receipt WHERE athlete_id=e.athlete_id;
 DELETE FROM public.plan_head WHERE athlete_id=e.athlete_id;
 DELETE FROM public.plan_history WHERE athlete_id=e.athlete_id;
 DELETE FROM public.plan_snapshot WHERE athlete_id=e.athlete_id;
 DELETE FROM public.command_receipt WHERE athlete_id=e.athlete_id;
 DELETE FROM public.outbox WHERE athlete_id=e.athlete_id;
 DELETE FROM public.consent WHERE athlete_id=e.athlete_id;
 DELETE FROM public.operations_audit WHERE athlete_id=e.athlete_id AND action<>'account_erased';
 DELETE FROM identity_private.session WHERE athlete_id::text=e.athlete_id;
 DELETE FROM identity_private.account WHERE athlete_id::text=e.athlete_id;
 IF EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id::text=e.athlete_id)
 OR EXISTS(SELECT 1 FROM identity_private.session WHERE athlete_id::text=e.athlete_id)
 OR EXISTS(SELECT 1 FROM public.activity_canonical WHERE athlete_id=e.athlete_id)
 OR EXISTS(SELECT 1 FROM public.plan_snapshot WHERE athlete_id=e.athlete_id)
 OR EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 WHERE athlete_id=e.athlete_id)
 THEN RAISE EXCEPTION 'CURRENT_POST_ERASURE_POSTIMAGE_REJECTED'; END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

-- Approved successor retains the exact117 loading prefix and original087 body.
DO $$
DECLARE p pg_proc; definition text; loader_prefix text; prefix text; source text; anchor text:='  SELECT c.event_id INTO parent_id FROM public.restore_share_erasure_context c'; metadata wm_current_app_load.successor_metadata;
BEGIN
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.record_tenant_erasure_suppression_event()'::regprocedure;
 SELECT * INTO STRICT metadata FROM wm_current_app_load.successor_metadata WHERE signature='public.record_tenant_erasure_suppression_event()';
 loader_prefix:=E'\n IF TG_OP=''INSERT'' THEN\n  IF session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=''wm_current_app_load.target''::regclass)) THEN\n   IF wm_current_app_load.exact_loading_row(TG_TABLE_SCHEMA,TG_TABLE_NAME,to_jsonb(NEW)) THEN RETURN NEW; END IF;\n  END IF;\n END IF;\n';
 definition:=pg_get_functiondef(p.oid);
 IF length(definition)-length(replace(definition,loader_prefix,''))<>length(loader_prefix)
 OR encode(sha256(convert_to(replace(definition,loader_prefix,''),'UTF8')),'hex')<>'f5630769ea8c2673abc541af3b2d715e3e961857d53dd2eb6c5fb9357480e8ca'
 OR p.prosecdef IS DISTINCT FROM metadata.original_security_definer OR p.proconfig IS DISTINCT FROM metadata.original_config
 OR p.proowner IS DISTINCT FROM metadata.original_owner OR p.proacl IS DISTINCT FROM metadata.original_acl
 THEN RAISE EXCEPTION 'CURRENT_POST_ERASURE_PREDECESSOR_REJECTED'; END IF;
 IF position(anchor IN p.prosrc)=0 OR length(p.prosrc)-length(replace(p.prosrc,anchor,''))<>length(anchor)
 THEN RAISE EXCEPTION 'CURRENT_POST_ERASURE_PREDECESSOR_ANCHOR_REJECTED'; END IF;
 INSERT INTO wm_current_original_postimages.predecessor VALUES('public.record_tenant_erasure_suppression_event()',p.prosrc,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),p.prosecdef,p.proconfig,p.proowner,p.proacl);
 prefix:=E'  -- CURRENT_POST_EXACT_TRANSITION_BEGIN\n  IF wm_current_original_postimages.consume_transition(TG_TABLE_SCHEMA||''.''||TG_TABLE_NAME,TG_OP,NULL,to_jsonb(NEW)) THEN RETURN NEW; END IF;\n  -- CURRENT_POST_EXACT_TRANSITION_END\n';
 source:=replace(p.prosrc,anchor,prefix||anchor);EXECUTE replace(definition,p.prosrc,source);
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.record_tenant_erasure_suppression_event()'::regprocedure;
 IF p.prosrc<>source OR p.prosecdef IS DISTINCT FROM metadata.original_security_definer OR p.proconfig IS DISTINCT FROM metadata.original_config
 OR p.proowner IS DISTINCT FROM metadata.original_owner OR p.proacl IS DISTINCT FROM metadata.original_acl
 THEN RAISE EXCEPTION 'CURRENT_POST_ERASURE_PREDECESSOR_METADATA_CHANGED'; END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

-- Application118 is a distinct required source partition, not silently folded
-- into116. The exact installed catalog pin includes all successor120 symbols.
CREATE FUNCTION wm_current_original_postimages.check_application_postimages(p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; n bigint; t text; expected text[]; actual text[];
BEGIN
 d:=wm_current_original_postimages.assert_context(p_run);
 FOREACH t IN ARRAY ARRAY['race_manual_application_candidate_v1','race_manual_application_context_v1','race_manual_application_receipt_v1','race_manual_application_history_v1'] LOOP
  IF to_regclass('public.'||t) IS NULL THEN RAISE EXCEPTION 'CURRENT_POST_APPLICATION118_PROFILE_UNAVAILABLE'; END IF;
  expected:=CASE t
   WHEN 'race_manual_application_candidate_v1' THEN ARRAY['athlete_id','id','evidence_id','decision_id','proposal_id','application_digest','candidate_json','basis_json','lifecycle_json','created_at','purged_event_id','purged_at']
   WHEN 'race_manual_application_context_v1' THEN ARRAY['athlete_id','id','candidate_id','creator_role','owner_xid','request_key','request_digest','prior_versions','expected_event','result']
   WHEN 'race_manual_application_receipt_v1' THEN ARRAY['athlete_id','receipt_key','request_digest','candidate_id','identity_digest','result']
   WHEN 'race_manual_application_history_v1' THEN ARRAY['athlete_id','approval_id','candidate_id','domain','aggregate_id','version_id','approved_at'] END;
  SELECT array_agg(attname::text ORDER BY attnum) INTO actual FROM pg_attribute WHERE attrelid=('public.'||t)::regclass AND attnum>0 AND NOT attisdropped;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CURRENT_POST_APPLICATION118_PROFILE_MISMATCH'; END IF;
 END LOOP;
 EXECUTE 'SELECT count(*) FROM public.race_manual_application_context_v1 WHERE athlete_id=$1' INTO n USING d.athlete_id;
 IF n<>0 THEN RAISE EXCEPTION 'CURRENT_POST_APPLICATION_CONTEXT_NONEMPTY'; END IF;
 -- Existing116 provenance is the sole cause. This update is accepted only by
 -- the original118 parent-purge guard and retains minimal receipt/history.
 EXECUTE 'UPDATE public.race_manual_application_candidate_v1 c SET candidate_json=NULL,basis_json=NULL,lifecycle_json=NULL,purged_event_id=e.purged_event_id,purged_at=e.purged_at FROM public.manual_race_evidence_v2 e WHERE c.athlete_id=$1 AND e.athlete_id=c.athlete_id AND e.id=c.evidence_id AND e.payload IS NULL AND c.candidate_json IS NOT NULL' USING d.athlete_id;
 EXECUTE 'SELECT count(*) FROM public.race_manual_application_candidate_v1 c JOIN public.manual_race_evidence_v2 e ON e.athlete_id=c.athlete_id AND e.id=c.evidence_id WHERE c.athlete_id=$1 AND e.payload IS NULL AND (c.candidate_json IS NOT NULL OR c.basis_json IS NOT NULL OR c.lifecycle_json IS NOT NULL OR c.purged_event_id IS DISTINCT FROM e.purged_event_id OR c.purged_at IS DISTINCT FROM e.purged_at)' INTO n USING d.athlete_id;
 IF n<>0 THEN RAISE EXCEPTION 'CURRENT_POST_APPLICATION_PURGE_REJECTED'; END IF;
END $$;
CREATE FUNCTION wm_current_original_postimages.apply_postimages(p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; r wm_current_original_postimages.run; m wm_current_original_postimages.member;
 original_digest text; final_digest text; n bigint;
BEGIN
 d:=wm_current_original_postimages.assert_context(p_run);
 SELECT * INTO STRICT r FROM wm_current_original_postimages.run WHERE run_id=p_run FOR UPDATE;
 IF NOT r.sealed OR r.applied OR r.finished OR r.owner_xid<>txid_current() THEN RAISE EXCEPTION 'CURRENT_POST_SEALED_REQUIRED'; END IF;
 -- All requested families are sealed against complete actual preimages before
 -- the first mutation. The host collector/authentication is a separate gate.
 IF EXISTS(SELECT 1 FROM wm_current_original_postimages.family WHERE run_id=p_run AND NOT sealed)
 THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_UNSEALED'; END IF;
 SELECT wm_current_app_load.hash_json(coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.event_id),'[]'::jsonb)) INTO original_digest
 FROM public.restore_suppression_event e WHERE e.athlete_id=d.athlete_id;
 -- Source transaction order is represented by ordinal, never event timestamp
 -- or UUID ordering. Reordering compound children is rejected by seal_originals.
 FOR m IN SELECT * FROM wm_current_original_postimages.member WHERE run_id=p_run ORDER BY ordinal LOOP
  PERFORM wm_current_original_postimages.apply_original(p_run,m.event_id);
 END LOOP;
 SELECT wm_current_app_load.hash_json(coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.event_id),'[]'::jsonb)) INTO final_digest
 FROM public.restore_suppression_event e WHERE e.athlete_id=d.athlete_id;
 IF original_digest IS DISTINCT FROM final_digest THEN RAISE EXCEPTION 'CURRENT_POST_ORIGINAL_MINT_OR_MUTATION'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 SELECT count(*) INTO n FROM wm_current_original_postimages.audit WHERE run_id=p_run;
 IF n<>r.expected_count OR EXISTS(SELECT 1 FROM wm_current_original_postimages.transition WHERE run_id=p_run AND NOT consumed)
 THEN RAISE EXCEPTION 'CURRENT_POST_INCOMPLETE'; END IF;
 PERFORM wm_current_original_postimages.check_application_postimages(p_run);
 SET CONSTRAINTS ALL IMMEDIATE;
 SELECT wm_current_app_load.hash_json(coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.event_id),'[]'::jsonb)) INTO final_digest FROM public.restore_suppression_event e WHERE e.athlete_id=d.athlete_id;
 IF original_digest IS DISTINCT FROM final_digest THEN RAISE EXCEPTION 'CURRENT_POST_DEFERRED_ORIGINAL_MINT_OR_MUTATION'; END IF;
 UPDATE wm_current_original_postimages.run SET applied=true WHERE run_id=p_run;
END $$;
CREATE FUNCTION wm_current_original_postimages.finish_originals(p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d wm_current_app_load.descriptor; r wm_current_original_postimages.run;
BEGIN
 d:=wm_current_original_postimages.assert_context(p_run);
 SELECT * INTO STRICT r FROM wm_current_original_postimages.run WHERE run_id=p_run FOR UPDATE;
 IF NOT r.applied OR r.finished OR r.owner_xid<>txid_current() OR r.expected_count<>(SELECT count(*) FROM wm_current_original_postimages.audit WHERE run_id=p_run) OR EXISTS(SELECT 1 FROM wm_current_original_postimages.member m WHERE m.run_id=p_run AND NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.audit a WHERE a.run_id=m.run_id AND a.event_id=m.event_id AND a.original_row_digest=m.original_row_digest)) THEN RAISE EXCEPTION 'CURRENT_POST_APPLIED_REQUIRED'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 IF EXISTS(SELECT 1 FROM wm_current_original_postimages.transition WHERE run_id=p_run AND NOT consumed)
 THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_UNCONSUMED'; END IF;
 UPDATE wm_current_original_postimages.run SET finished=true WHERE run_id=p_run;
 UPDATE wm_current_app_load.descriptor SET post_replayed=true WHERE run_id=p_run;
 -- Descriptor and membership remain live through every deferred check.
 PERFORM wm_current_app_load.finish_stage(p_run);
 -- Reset operational membership after deferred validation while the immutable
 --117 descriptor remains as historical diagnostics. These rows are never
 -- inherited authority in a restored archive.
 DELETE FROM wm_current_original_postimages.transition WHERE run_id=p_run;
 DELETE FROM wm_current_original_postimages.audit WHERE run_id=p_run;
 DELETE FROM wm_current_original_postimages.family_row WHERE run_id=p_run;
 DELETE FROM wm_current_original_postimages.family WHERE run_id=p_run;
 DELETE FROM wm_current_original_postimages.member WHERE run_id=p_run;
 DELETE FROM wm_current_original_postimages.run WHERE run_id=p_run;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE FUNCTION wm_current_original_postimages.guard_operational_row() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE v jsonb; v_run uuid; d wm_current_app_load.descriptor; r wm_current_original_postimages.run;
BEGIN
 PERFORM wm_current_app_load.owner_check();
 IF TG_TABLE_NAME IN ('profile','predecessor') THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CURRENT_POST_IMMUTABLE_CONFIGURATION'; END IF;
  RETURN NEW;
 END IF;
 v:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;v_run:=(v->>'run_id')::uuid;
 d:=wm_current_app_load.assert_context(v_run);
 IF TG_OP='DELETE' THEN
  IF NOT d.finished THEN RAISE EXCEPTION 'CURRENT_POST_LIVE_STAGE_DELETE_REJECTED'; END IF;
  RETURN OLD;
 END IF;
 IF d.finished OR d.post_replayed THEN RAISE EXCEPTION 'CURRENT_POST_STAGE_FINISHED'; END IF;
 IF TG_TABLE_NAME='run' THEN
  IF TG_OP='INSERT' AND (NEW.owner_xid<>txid_current() OR NEW.sealed OR NEW.applied OR NEW.finished) THEN RAISE EXCEPTION 'CURRENT_POST_RUN_INSERT_REJECTED'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['expected_count','sealed','applied','finished'] IS DISTINCT FROM to_jsonb(NEW)-ARRAY['expected_count','sealed','applied','finished']
   OR OLD.finished OR OLD.sealed AND NOT NEW.sealed OR OLD.applied AND NOT NEW.applied OR NEW.applied AND NOT NEW.sealed
   OR NEW.finished AND NOT NEW.applied OR OLD.sealed AND NEW.expected_count<>OLD.expected_count)
  THEN RAISE EXCEPTION 'CURRENT_POST_RUN_MUTATION_REJECTED'; END IF;
 ELSIF TG_TABLE_NAME='transition' THEN
  IF TG_OP='INSERT' AND (NEW.owner_xid<>txid_current() OR NEW.consumed) THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_INSERT_REJECTED'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'consumed' IS DISTINCT FROM to_jsonb(NEW)-'consumed' OR OLD.consumed OR NOT NEW.consumed)
  THEN RAISE EXCEPTION 'CURRENT_POST_TRANSITION_MUTATION_REJECTED'; END IF;
 ELSIF TG_TABLE_NAME='family' THEN
  IF TG_OP='INSERT' AND NEW.sealed OR TG_OP='UPDATE' AND (to_jsonb(OLD)-'sealed' IS DISTINCT FROM to_jsonb(NEW)-'sealed' OR OLD.sealed OR NOT NEW.sealed)
  THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_MUTATION_REJECTED'; END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CURRENT_POST_IMMUTABLE_MEMBERSHIP'; END IF;
  IF TG_TABLE_NAME='member' AND EXISTS(SELECT 1 FROM wm_current_original_postimages.run WHERE run_id=v_run AND sealed) THEN RAISE EXCEPTION 'CURRENT_POST_MEMBERSHIP_SEALED'; END IF;
  IF TG_TABLE_NAME='family_row' AND EXISTS(SELECT 1 FROM wm_current_original_postimages.family f WHERE f.run_id=v_run AND f.family=v->>'family' AND f.sealed) THEN RAISE EXCEPTION 'CURRENT_POST_FAMILY_SEALED'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['profile','predecessor','run','member','audit','family','family_row','transition'] LOOP
  EXECUTE format('CREATE TRIGGER current_post_guard BEFORE INSERT OR UPDATE OR DELETE ON wm_current_original_postimages.%I FOR EACH ROW EXECUTE FUNCTION wm_current_original_postimages.guard_operational_row()',t);
  EXECUTE format('CREATE TRIGGER current_post_no_truncate BEFORE TRUNCATE ON wm_current_original_postimages.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation()',t);
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;

CREATE FUNCTION wm_current_original_postimages.post_activity_cleanup(p_run uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.restore_suppression_event; upload uuid; v_course uuid;
BEGIN
 e:=wm_current_original_postimages.original(p_run,p_event);
 IF e.kind<>'activity_deleted' OR NOT EXISTS(SELECT 1 FROM wm_current_original_postimages.family WHERE run_id=p_run AND family=e.kind AND sealed)
 THEN RAISE EXCEPTION 'CURRENT_POST_ACTIVITY_FAMILY_REQUIRED'; END IF;
 FOR upload IN UPDATE public.activity_track_upload_intent SET state='failed',failure_code='ACTIVITY_DELETED',updated_at=clock_timestamp()
  WHERE athlete_id=e.athlete_id AND activity_id=e.target_id AND state IN ('reserved','prepared','staged') RETURNING upload_id
 LOOP PERFORM public.queue_activity_track_upload_refs(e.athlete_id,upload,'activity_deleted'); END LOOP;
 -- arm_object_scope_purge sweeps every recorded track object, including a job
 -- previously completed before this independent source archive was restored.
 FOR v_course IN SELECT DISTINCT edge.course_id FROM public.course_revision_source edge WHERE edge.athlete_id=e.athlete_id AND edge.activity_id=e.target_id LOOP
  PERFORM public.supersede_course_thumbnails(e.athlete_id,v_course,NULL,'activity_deleted');
 END LOOP;
 UPDATE public.course c SET status='unavailable',head_revision=NULL,revision_id=NULL,unavailable_reason='source_activity_deleted',reclaimed_at=clock_timestamp(),updated_at=greatest(c.updated_at,clock_timestamp())
 WHERE c.athlete_id=e.athlete_id AND c.status='available' AND EXISTS(SELECT 1 FROM public.course_revision_source edge WHERE edge.athlete_id=c.athlete_id AND edge.course_id=c.course_id AND edge.activity_id=e.target_id);
 DELETE FROM public.course_revision r WHERE r.athlete_id=e.athlete_id AND EXISTS(SELECT 1 FROM public.course_revision_source edge WHERE edge.athlete_id=r.athlete_id AND edge.course_id=r.course_id AND edge.activity_id=e.target_id);
 IF e.source_kind='healthkit' THEN
  -- A later current registration is not destroyed by an earlier Activity's
  -- deletion. Its exact claim/sample history is a separate source partition.
  IF NOT EXISTS(SELECT 1 FROM public.healthkit_workout_claim WHERE athlete_id=e.athlete_id AND sample_id=e.source_id::uuid AND created_at>e.occurred_at) THEN
   UPDATE public.healthkit_workout_sample SET state='deleted',source_bundle_id=NULL,source_version=NULL,activity_type=NULL,
    observed_from=NULL,observed_to=NULL,duration_seconds=NULL,distance_meters=NULL,energy_kilocalories=NULL,payload_digest=NULL,deleted_at=clock_timestamp()
    WHERE athlete_id=e.athlete_id AND sample_id=e.source_id::uuid AND state='active' AND received_at<=e.occurred_at;
   UPDATE public.healthkit_workout_lineage SET state='suppressed' WHERE athlete_id=e.athlete_id AND sample_id=e.source_id::uuid AND state='deleted';
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.course_revision r WHERE r.athlete_id=e.athlete_id AND EXISTS(SELECT 1 FROM public.course_revision_source edge WHERE edge.athlete_id=r.athlete_id AND edge.course_id=r.course_id AND edge.activity_id=e.target_id))
 THEN RAISE EXCEPTION 'CURRENT_POST_ACTIVITY_COURSE_POSTIMAGE_REJECTED'; END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_current_original_postimages FROM PUBLIC;
