-- Explicit manual all-domain application successor. Normal107 registration remains unchanged.
-- SQL116 parents retain readonly/applyfalse semantics. New application data is
-- separately bound to current sources; caller JSON, context UUID or GUC is no seal.
CREATE FUNCTION public.validate_race_manual_application_basis_v1(retained jsonb,basis jsonb,lifecycle jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); apprev integer; inner_payload jsonb; refs jsonb; observed jsonb; parents jsonb;
 r jsonb; i jsonb; f jsonb; e jsonb; location text; dto jsonb; copied jsonb; current_value jsonb; expected_value jsonb;
 count bigint:=0; bytes bigint:=0; domain text; table_name text; id_field text;
 policy constant text:='{"id":"manual-race-date-impact","version":1,"existingUnresolved":"preserve_with_notice","affectedUnresolved":"resolve_before_approval","actualRecords":"preserve","application":"explicit_user_approval","calendarMovement":"civil_date","unknownRaceEnd":"remain_unresolved"}';
BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 IF t IS NULL OR current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN RAISE EXCEPTION 'RACE_MANUAL_SNAPSHOT_REQUIRED'; END IF;
 PERFORM public.assert_manual_review_global_lock(); PERFORM public.assert_manual_review_lifecycle_lock(t);
 PERFORM pg_advisory_xact_lock(hashtextextended(t,0));
 PERFORM public.manual_race_v2_assert_json_bound($1); PERFORM public.manual_race_v2_assert_json_bound($2); PERFORM public.manual_race_v2_assert_json_bound($3);
 apprev:=public.require_app_admission_revision(($2->'manualBasis'->'app'->>'revision')::int);
 IF jsonb_typeof($2->'dependencyHeads') IS DISTINCT FROM 'array' OR jsonb_array_length($2->'dependencyHeads')<>7 OR (SELECT count(DISTINCT x->>'kind') FROM jsonb_array_elements($2->'dependencyHeads') x)<>7 OR $2->>'athleteId' IS DISTINCT FROM t OR $2->>'basisVersion' IS DISTINCT FROM '2'
  OR $2->>'restoreGeneration' IS DISTINCT FROM public.current_restore_generation()::text
  OR $2->'manualBasis'->>'purpose' IS DISTINCT FROM 'manual_race_date_change'
  OR $2->'manualBasis'->'app' IS DISTINCT FROM jsonb_build_object('state','present','granted',true,'revision',apprev)
  OR $2->'manualBasis'->'policy' IS DISTINCT FROM jsonb_build_object('id','manual-race-date-impact','version',1,'digest',encode(sha256(convert_to(policy,'UTF8')),'hex'))

 THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 IF $1->>'state' IS DISTINCT FROM 'present' OR $1->>'status' IS DISTINCT FROM 'structurally_corresponding'
  OR $1->'minimalAudit'->>'athleteId' IS DISTINCT FROM t OR $1->'payload'->'preparation'->'context'->>'athleteId' IS DISTINCT FROM t
  OR $1->'payload'->'preparation'->'context'->>'restoreGeneration' IS DISTINCT FROM $2->>'restoreGeneration'
  OR $1->'payload'->'preparation'->'context'->'event' IS DISTINCT FROM $2->'event'
  OR $1->'payload'->'preparation'->'candidate'->>'status' IS DISTINCT FROM 'assembled_readonly'
  OR $1->'payload'->'preparation'->'candidate'->>'digest' IS DISTINCT FROM $1->'minimalAudit'->>'candidateDigest'
  OR $1->'minimalAudit'->>'candidateDigest' !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_INVALID_PAYLOAD'; END IF;
 inner_payload:=$1->'payload';
 SELECT coalesce(jsonb_agg(x->'identity' ORDER BY n),'[]'::jsonb) INTO refs FROM jsonb_array_elements(inner_payload->'inventory'->'refs') WITH ORDINALITY a(x,n);
 refs:=public.manual_race_v2_normalize_refs(refs);
 IF (SELECT count(*) FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event')<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event' AND x->>'sourceId'=$2->'event'->>'id' AND x->>'revision'=$2->'event'->>'revision')
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_EVENT_REF_REQUIRED'; END IF;
 observed:=public.observe_manual_review_full_owned_source_bindings_v2(refs);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(observed->'rows') x WHERE x->>'state'<>'observed') THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_UNAVAILABLE'; END IF;
 -- Only consumed principals/current observations are compared. Unused historical catalog
 -- current-head drift is deliberately excluded; semantic selection heads are checked below.
 FOR r IN SELECT value FROM jsonb_array_elements(observed->'rows') LOOP
  SELECT value INTO f FROM jsonb_array_elements(inner_payload->'sqlObservations'->'rows') x WHERE x->'identity'=r->'identity';
  IF NOT FOUND THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_CHANGED'; END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY x::text COLLATE "C"),'[]'::jsonb) INTO current_value FROM jsonb_array_elements(r->'relations') x WHERE x->>'role'<>'current_head' OR r->'identity'->>'kind' IN ('course-head-descriptor','activity-canonical-values','activity-overlay','routine-timer','gallery-descriptor');
  SELECT coalesce(jsonb_agg(x ORDER BY x::text COLLATE "C"),'[]'::jsonb) INTO expected_value FROM jsonb_array_elements(f->'relations') x WHERE x->>'role'<>'current_head' OR r->'identity'->>'kind' IN ('course-head-descriptor','activity-canonical-values','activity-overlay','routine-timer','gallery-descriptor');
  IF current_value IS DISTINCT FROM expected_value THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_CHANGED'; END IF;
 END LOOP;
 parents:=public.manual_race_v2_parent_edges(refs);
 IF $3->>'status' IS DISTINCT FROM 'dependency_correspondence' OR $3->>'athleteId' IS DISTINCT FROM t
  OR jsonb_array_length($3->'facts')<>jsonb_array_length(parents) THEN RAISE EXCEPTION 'MANUAL_CHAIN_PARENT_MISMATCH'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(parents) LOOP
  SELECT value INTO e FROM jsonb_array_elements($3->'facts') x WHERE x->'identity'=f->'identity';
  SELECT jsonb_agg(x ORDER BY x::text COLLATE "C") INTO current_value FROM jsonb_array_elements(e->'edges') x;
  IF e->>'state' IS DISTINCT FROM 'bound' OR current_value IS DISTINCT FROM f->'edges' THEN RAISE EXCEPTION 'MANUAL_CHAIN_PARENT_MISMATCH'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.restore_suppression_event event CROSS JOIN LATERAL jsonb_array_elements(parents) fact CROSS JOIN LATERAL jsonb_array_elements(fact->'edges') edge WHERE event.athlete_id=t AND public.manual_race_v2_event_matches_ref(event,fact->'identity',edge)) THEN RAISE EXCEPTION 'MANUAL_CHAIN_SUPPRESSED_SOURCE'; END IF;
 -- Deterministic parent locks after global/lifecycle/tenant; both delete and store use this key.
 FOR e IN SELECT x FROM (SELECT DISTINCT x FROM jsonb_array_elements(parents) p CROSS JOIN LATERAL jsonb_array_elements(p->'edges') x) q ORDER BY public.manual_race_v2_utf16_key(x::text) LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,e->>'family',e->>'sourceId')::text,77207));
 END LOOP;
 -- Exact selection roster includes absent heads: an absent->present phantom changes basis.
 FOR domain,table_name,id_field IN SELECT * FROM (VALUES ('nutrition','nutrition_plan_head','plan_id'),('recovery','recovery_strategy_head','strategy_id'),('routine','routine_schedule_head','schedule_id')) a(domain,table_name,id_field) LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''aggregateId'',%I,''versionId'',version_id) ORDER BY %I),''[]''::jsonb) FROM public.%I WHERE athlete_id=$1',id_field,id_field,table_name) INTO current_value USING t;
  expected_value:=$2->'heads'->domain;
  IF expected_value IS DISTINCT FROM (CASE WHEN jsonb_array_length(current_value)=0 THEN jsonb_build_object('state','absent') ELSE jsonb_build_object('state','present','members',current_value) END) THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 END LOOP;
 SELECT jsonb_build_object('aggregateId',h.aggregate_id,'snapshot',jsonb_build_object('id',s.id,'version',s.version,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'draft',s.draft)) INTO current_value FROM public.plan_head h JOIN public.plan_snapshot s ON s.athlete_id=h.athlete_id AND s.id=h.version_id WHERE h.athlete_id=t;
 IF coalesce(current_value,'null'::jsonb) IS DISTINCT FROM $2->'currentTraining' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 SELECT values_json||jsonb_build_object('id',id,'revision',revision) INTO current_value FROM public.race_event WHERE athlete_id=t AND id::text=$2->'event'->>'id' AND revision::text=$2->'event'->>'revision' AND NOT deleted;
 IF current_value IS DISTINCT FROM $2->'event' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements($2->'dependencyHeads') LOOP
  IF f->>'kind'<>ALL(ARRAY['intake_revision','activity_revision','execution_revision','set_revision','routine_run_revision','routine_occurrence_revision','recovery_action_revision']) THEN RAISE EXCEPTION 'MANUAL_CHAIN_INVALID_BASIS'; END IF;
  EXECUTE format('SELECT jsonb_build_object(''kind'',$2,''state'',''present'',''revision'',%I) FROM public.integrated_dependency_head WHERE athlete_id=$1',f->>'kind') INTO current_value USING t,f->>'kind';
  IF coalesce(current_value,jsonb_build_object('kind',f->>'kind','state','absent')) IS DISTINCT FROM f THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 END LOOP;
 SELECT jsonb_build_object('kind',kind,'revision',revision,'privacy_generation',privacy_generation::text) INTO current_value FROM public.race_collection_head WHERE athlete_id=t AND kind='race-event';
 IF coalesce(current_value,'null'::jsonb) IS DISTINCT FROM $2->'eventCollection' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 -- Same actual core ledgers as capture; unrelated AI consent/summary/time are excluded.
 SELECT jsonb_build_object('schemaVersion',2,'scope','core-ledgers-v2','athleteId',t,
  'trainingPlan',coalesce((SELECT jsonb_build_object('kind','exists','versionId',version_id) FROM public.plan_head WHERE athlete_id=t),'{"kind":"absent"}'::jsonb),
  'checkIns',coalesce((SELECT jsonb_build_object('kind','exists','revision',revision) FROM public.check_in_collection_head WHERE athlete_id=t),'{"kind":"absent"}'::jsonb),
  'sessionCompletions',coalesce((SELECT jsonb_build_object('kind','exists','revision',revision) FROM public.session_completion_collection_head WHERE athlete_id=t),'{"kind":"absent"}'::jsonb),
  'userConstraints',coalesce((SELECT jsonb_build_object('kind','exists','revision',revision) FROM public.coaching_constraint_head WHERE athlete_id=t),'{"kind":"absent"}'::jsonb)) INTO current_value;
 IF current_value IS DISTINCT FROM $2->'core' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 SELECT count(*),coalesce(sum(octet_length(to_jsonb(c)::text)),0) INTO count,bytes FROM public.activity_canonical c WHERE c.athlete_id=t;
 IF count>5000 OR bytes>4194304 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_BOUND'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'revision',c.revision,'deleted',c.deleted,
  'overlay',jsonb_build_object('state',CASE WHEN EXISTS(SELECT 1 FROM public.activity_overlay o WHERE o.athlete_id=c.athlete_id AND o.activity_id=c.id) THEN 'present' ELSE 'absent' END,'revision',(SELECT max(revision) FROM public.activity_overlay_revision o WHERE o.athlete_id=c.athlete_id AND o.activity_id=c.id)),
  'source',CASE WHEN h.kind IS NULL THEN jsonb_build_object('state','absent') ELSE jsonb_build_object('state','present','kind',h.kind,'sourceId',h.source_id,'revision',h.source_revision,'contentHash',h.content_hash,
   'suppressed',EXISTS(SELECT 1 FROM public.activity_suppression z WHERE z.athlete_id=c.athlete_id AND z.kind=h.kind AND z.source_id=h.source_id),
   'revisionRecord',jsonb_build_object('state',CASE WHEN EXISTS(SELECT 1 FROM public.activity_source_revision v WHERE v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision AND v.content_hash=h.content_hash) THEN 'present' ELSE 'absent' END)) END) ORDER BY c.id),'[]'::jsonb) INTO current_value
 FROM public.activity_canonical c LEFT JOIN public.activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id WHERE c.athlete_id=t;
 IF current_value IS DISTINCT FROM $2->'activities' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 IF $2->'consumedUses'->>'purpose' IS DISTINCT FROM 'manual_race_date_change' OR $2->'consumedUses'->>'purposeProjectionVersion' IS DISTINCT FROM '2'
  OR jsonb_typeof($2->'consumedUses'->'facts') IS DISTINCT FROM 'array' OR jsonb_array_length($2->'consumedUses'->'facts')<>jsonb_array_length(refs) THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(refs) LOOP
  SELECT count(*) INTO count FROM jsonb_array_elements($2->'consumedUses'->'facts') x WHERE x->'identity'=i;
  IF count<>1 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  SELECT value INTO f FROM jsonb_array_elements($2->'consumedUses'->'facts') x WHERE x->'identity'=i;
  IF f->>'reason' IS NOT NULL OR f->>'use' IS DISTINCT FROM (CASE WHEN i->>'kind'='resource-text-version' THEN 'own_retained_text' ELSE 'core_manual' END)
   OR f->>'sourceAuthentication' IS DISTINCT FROM 'unverified'
   OR f->'resourceSource' IS DISTINCT FROM (CASE WHEN i->>'kind'='resource-text-version' THEN jsonb_build_object('deleted',false) ELSE 'null'::jsonb END)
  THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  IF i->>'kind' IN ('course-revision','course-head-descriptor','activity-track-descriptor') AND inner_payload->'preparation'->'context'->'course'->'ref' IS DISTINCT FROM $2->'event'->'course' THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  PERFORM public.manual_race_v2_verify_source_purpose(i,f->'sourcePurpose',inner_payload->'preparation'->'context'->'course'->'ref');
 END LOOP;
 count:=0; bytes:=0;
 -- Full immutable DTO equality for every copied location, not just an input digest.
 FOR r IN SELECT value FROM jsonb_array_elements(inner_payload->'inventory'->'refs') LOOP
  i:=r->'identity'; dto:=public.manual_race_v2_source_dto(i);
  IF i->>'kind'='race-timing-pin-fragment' THEN
   SELECT pin INTO dto FROM public.nutrition_plan_version n CROSS JOIN LATERAL jsonb_array_elements(coalesce(n.record_json->'raceTimingPins','[]'::jsonb)) pin
   WHERE n.athlete_id=t AND pin->>'eventId'=i->>'sourceId' AND pin->>'eventRevision'=i->>'revision'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x WHERE x->>'kind'='nutrition-plan-version' AND x->>'sourceId'=n.plan_id::text AND x->>'versionId'=n.version_id::text) LIMIT 1;
   IF EXISTS(SELECT 1 FROM public.nutrition_plan_version n CROSS JOIN LATERAL jsonb_array_elements(coalesce(n.record_json->'raceTimingPins','[]'::jsonb)) pin WHERE n.athlete_id=t AND pin->>'eventId'=i->>'sourceId' AND pin->>'eventRevision'=i->>'revision' AND EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x WHERE x->>'kind'='nutrition-plan-version' AND x->>'sourceId'=n.plan_id::text AND x->>'versionId'=n.version_id::text) AND pin IS DISTINCT FROM dto) THEN RAISE EXCEPTION 'MANUAL_CHAIN_PIN_PARENT_MISMATCH'; END IF;
  END IF;
  IF dto IS NULL THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_UNAVAILABLE'; END IF;
  bytes:=bytes+octet_length(dto::text); IF bytes>4194304 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_BOUND'; END IF;
  IF jsonb_typeof(r->'copiedLocations') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'copiedLocations')<1 THEN RAISE EXCEPTION 'MANUAL_CHAIN_INVALID_LOCATION'; END IF;
  FOR location IN SELECT value#>>'{}' FROM jsonb_array_elements(r->'copiedLocations') LOOP
   count:=count+1; IF count>5000 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_BOUND'; END IF;
   copied:=public.manual_race_v2_json_at(inner_payload->'preparation',location);
   IF copied IS DISTINCT FROM dto THEN RAISE EXCEPTION 'MANUAL_CHAIN_COPIED_BODY_CHANGED'; END IF;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.validate_race_manual_application_basis_v1(jsonb,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION public.race_manual_application_wire_v1(kind text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $codec$
SELECT CASE kind
 WHEN 'candidate' THEN '{"$schema":"https://json-schema.org/draft/2020-12/schema","oneOf":[{"type":"object","properties":{"schemaVersion":{"type":"number","const":1},"candidateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"chain":{"type":"object","properties":{"evidenceId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"decisionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"proposalId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"readonlyCandidateDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["evidenceId","decisionId","proposalId","readonlyCandidateDigest"],"additionalProperties":false},"applicationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"createdAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"raceChange":{"type":"object","properties":{"eventId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedRevision":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"newLocalDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"required":["eventId","expectedRevision","newLocalDate"],"additionalProperties":false},"expectation":{"type":"object","properties":{"restoreGeneration":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"appRevision":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"manualPolicy":{"type":"object","properties":{"id":{"type":"string","const":"manual-race-date-impact"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","digest"],"additionalProperties":false},"semanticDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"heads":{"type":"object","properties":{"training":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","maxLength":200},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"nutrition":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"recovery":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"routine_schedule":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string"}},"required":["kind","versionId"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]}},"required":["training","nutrition","recovery","routine_schedule"],"additionalProperties":false}},"required":["restoreGeneration","appRevision","manualPolicy","semanticDigest","heads"],"additionalProperties":false},"authority":{"type":"string","const":"server_revalidation_required"},"applicationState":{"type":"string","const":"blocked"},"blockers":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"reason":{"type":"string","enum":["source_unavailable","source_permission_unavailable","stale_basis","incomplete_affected_scope","affected_timing_unresolved","disconnection_origin_unavailable","reconnect_target_unavailable","unsupported_source","application_port_unavailable"]},"target":{"anyOf":[{"type":"object","properties":{"domain":{"type":"string","enum":["training","nutrition","recovery","routine_schedule"]},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}},"required":["domain","aggregateId"],"additionalProperties":false},{"type":"null"}]}},"required":["reason","target"],"additionalProperties":false}}},"required":["schemaVersion","candidateId","chain","applicationDigest","createdAt","raceChange","expectation","authority","applicationState","blockers"],"additionalProperties":false},{"type":"object","properties":{"schemaVersion":{"type":"number","const":1},"candidateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"chain":{"type":"object","properties":{"evidenceId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"decisionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"proposalId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"readonlyCandidateDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["evidenceId","decisionId","proposalId","readonlyCandidateDigest"],"additionalProperties":false},"applicationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"createdAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"raceChange":{"type":"object","properties":{"eventId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedRevision":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"newLocalDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"required":["eventId","expectedRevision","newLocalDate"],"additionalProperties":false},"expectation":{"type":"object","properties":{"restoreGeneration":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"appRevision":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"manualPolicy":{"type":"object","properties":{"id":{"type":"string","const":"manual-race-date-impact"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","digest"],"additionalProperties":false},"semanticDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"heads":{"type":"object","properties":{"training":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","maxLength":200},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"nutrition":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"recovery":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"routine_schedule":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string"}},"required":["kind","versionId"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]}},"required":["training","nutrition","recovery","routine_schedule"],"additionalProperties":false}},"required":["restoreGeneration","appRevision","manualPolicy","semanticDigest","heads"],"additionalProperties":false},"authority":{"type":"string","const":"server_revalidation_required"},"applicationState":{"type":"string","const":"ready_for_explicit_approval"},"scope":{"type":"string","const":"whole_affected"},"affected":{"maxItems":1000,"type":"array","items":{"type":"object","properties":{"domain":{"type":"string","enum":["training","nutrition","recovery","routine_schedule"]},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}},"required":["domain","aggregateId"],"additionalProperties":false}},"writes":{"maxItems":1000,"type":"array","items":{"oneOf":[{"type":"object","properties":{"domain":{"type":"string","const":"training"},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedHead":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"absent"}},"required":["kind"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","maxLength":200},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}]},"proposed":{"type":"object","properties":{"timezone":{"type":"string"},"title":{"type":"string","minLength":1,"maxLength":200},"periods":{"minItems":1,"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","maxLength":200},"parentId":{"anyOf":[{"type":"string","maxLength":200},{"type":"null"}]},"level":{"type":"string","enum":["season","wave","phase","block"]},"title":{"type":"string","minLength":1,"maxLength":200},"startDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"endDateExclusive":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"timezone":{"type":"string"},"intent":{"type":"string","maxLength":2000},"isPartial":{"type":"boolean"},"priority":{"anyOf":[{"type":"string","enum":["low","normal","high"]},{"type":"null"}]},"constraints":{"type":"object","properties":{"unavailableDates":{"maxItems":3660,"type":"array","items":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"dailyTimeLimits":{"maxItems":3660,"type":"array","items":{"type":"object","properties":{"date":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"availableSeconds":{"type":"integer","minimum":0,"maximum":86400}},"required":["date","availableSeconds"],"additionalProperties":false}}},"required":["unavailableDates","dailyTimeLimits"],"additionalProperties":false}},"required":["id","parentId","level","title","startDate","endDateExclusive","timezone","intent","isPartial"],"additionalProperties":false}},"sessions":{"maxItems":1000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","maxLength":200},"blockId":{"type":"string","maxLength":200},"date":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"localStartTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]},"title":{"type":"string","minLength":1,"maxLength":200},"sport":{"type":"string","enum":["running","cycling","swimming","strength","other"]},"durationSeconds":{"anyOf":[{"type":"number","minimum":0,"maximum":604800},{"type":"null"}]},"distanceMeters":{"anyOf":[{"type":"number","minimum":0,"maximum":10000000},{"type":"null"}]},"durationRange":{"anyOf":[{"type":"object","properties":{"minSeconds":{"type":"number","minimum":0,"maximum":604800},"maxSeconds":{"type":"number","minimum":0,"maximum":604800}},"required":["minSeconds","maxSeconds"],"additionalProperties":false},{"type":"null"}]},"distanceRange":{"anyOf":[{"type":"object","properties":{"minMeters":{"type":"number","minimum":0,"maximum":10000000},"maxMeters":{"type":"number","minimum":0,"maximum":10000000}},"required":["minMeters","maxMeters"],"additionalProperties":false},{"type":"null"}]},"targetRpe":{"anyOf":[{"type":"number","minimum":0,"maximum":10},{"type":"null"}]},"intensityLabel":{"anyOf":[{"type":"string","enum":["A","B","C"]},{"type":"null"}]},"paceTarget":{"anyOf":[{"type":"object","properties":{"minSecondsPerKm":{"type":"number","exclusiveMinimum":0,"maximum":86400},"maxSecondsPerKm":{"type":"number","exclusiveMinimum":0,"maximum":86400}},"required":["minSecondsPerKm","maxSecondsPerKm"],"additionalProperties":false},{"type":"null"}]},"heartRateTarget":{"anyOf":[{"type":"object","properties":{"minBpm":{"type":"integer","minimum":1,"maximum":1000},"maxBpm":{"type":"integer","minimum":1,"maximum":1000}},"required":["minBpm","maxBpm"],"additionalProperties":false},{"type":"null"}]},"purpose":{"type":"string","maxLength":2000},"notes":{"type":"string","maxLength":4000},"priority":{"type":"string","enum":["low","normal","high"]},"locks":{"type":"object","properties":{"date":{"type":"boolean"},"time":{"type":"boolean"},"intensity":{"type":"boolean"},"attendance":{"type":"boolean"}},"required":["date","time","intensity"],"additionalProperties":false},"steps":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","maxLength":200},"kind":{"type":"string","enum":["warmup","work","recovery","cooldown"]},"durationSeconds":{"anyOf":[{"type":"number","minimum":0,"maximum":604800},{"type":"null"}]},"distanceMeters":{"anyOf":[{"type":"number","minimum":0,"maximum":10000000},{"type":"null"}]},"repetitions":{"type":"integer","minimum":1,"maximum":1000}},"required":["id","kind","durationSeconds","distanceMeters","repetitions"],"additionalProperties":false}}},"required":["id","blockId","date","localStartTime","title","sport","durationSeconds","distanceMeters","targetRpe","purpose","notes","priority","locks","steps"],"additionalProperties":false}}},"required":["timezone","title","periods","sessions"],"additionalProperties":false}},"required":["domain","aggregateId","expectedHead","proposed"],"additionalProperties":false},{"type":"object","properties":{"domain":{"type":"string","const":"nutrition"},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedHead":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false},"intent":{"type":"object","properties":{"schemaVersion":{"type":"number","const":4},"intent":{"type":"object","properties":{"schemaVersion":{"type":"number","const":3},"command":{"type":"object","properties":{"kind":{"type":"string","const":"update"},"planId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedHeadVersionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[a-zA-Z0-9_-]+$"},"confirmed":{"type":"boolean","const":true},"draft":{"type":"object","properties":{"period":{"type":"object","properties":{"from":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"toInclusive":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"required":["from","toInclusive"],"additionalProperties":false},"timezone":{"type":"string"},"purpose":{"type":"string","maxLength":160},"linkedTrainingPlanVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]},"items":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"category":{"type":"string","enum":["meal","snack","before","during","after","hydration"]},"title":{"type":"string","maxLength":160},"anchor":{"anyOf":[{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"absolute"},"date":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]},"timezone":{"type":"string"}},"required":["kind","date","localTime","timezone"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"relative"},"entity":{"type":"string","enum":["session","race"]},"entityId":{"type":"string"},"point":{"type":"string","enum":["start","end"]},"offsetMinutes":{"type":"number"}},"required":["kind","entity","entityId","point","offsetMinutes"],"additionalProperties":false}]},{"type":"object","properties":{"kind":{"type":"string","const":"disconnected"},"entity":{"type":"string","const":"race"}},"required":["kind","entity"],"additionalProperties":false}]},"foods":{"maxItems":40,"type":"array","items":{"type":"object","properties":{"foodVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]},"description":{"type":"string","maxLength":160},"quantity":{"anyOf":[{"type":"number","minimum":0},{"type":"null"}]},"unit":{"type":"string","enum":["g","mL","serving","piece","unspecified"]},"sourceBasis":{"type":"string","enum":["per_100g","per_100mL","per_serving","manual_total","unknown"]}},"required":["foodVersionId","description","quantity","unit","sourceBasis"],"additionalProperties":false}},"targets":{"maxItems":6,"type":"array","items":{"oneOf":[{"type":"object","properties":{"metric":{"type":"string","const":"energy"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"kcal"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"carbohydrate"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"protein"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"fat"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"fluid"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"mL"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"sodium"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"mg"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false}]}},"instructions":{"type":"string","maxLength":2000},"evidenceIds":{"maxItems":40,"type":"array","items":{"type":"string"}},"source":{"type":"string","const":"user_confirmed"}},"required":["id","category","title","anchor","foods","targets","instructions","evidenceIds","source"],"additionalProperties":false}}},"required":["period","timezone","purpose","linkedTrainingPlanVersionId","items"],"additionalProperties":false}},"required":["kind","planId","expectedHeadVersionId","idempotencyKey","confirmed","draft"],"additionalProperties":false},"expectedRaceHeads":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"namespace":{"type":"string","const":"race-event"},"eventId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"revision":{"type":"integer","minimum":1,"maximum":2147483647}},"required":["namespace","eventId","revision"],"additionalProperties":false}},"reconnectItemIds":{"maxItems":5000,"type":"array","items":{"type":"string"}}},"required":["schemaVersion","command","expectedRaceHeads","reconnectItemIds"],"additionalProperties":false}},"required":["schemaVersion","intent"],"additionalProperties":false}},"required":["domain","aggregateId","expectedHead","intent"],"additionalProperties":false},{"type":"object","properties":{"domain":{"type":"string","const":"recovery"},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedHead":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"absent"}},"required":["kind"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}]},"proposed":{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":160},"goal":{"type":"string","maxLength":2000},"startDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"endDateExclusive":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"timezone":{"type":"string"},"knownFacts":{"maxItems":30,"type":"array","items":{"type":"string","maxLength":2000}},"missingInformation":{"maxItems":30,"type":"array","items":{"type":"string","minLength":1,"maxLength":160}},"priority":{"type":"string","enum":["low","normal","high"]},"observations":{"maxItems":40,"type":"array","items":{"type":"object","properties":{"kind":{"type":"string","enum":["check_in","activity","intake"]},"id":{"type":"string","minLength":1,"maxLength":128},"revision":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["kind","id","revision"],"additionalProperties":false}},"planRefs":{"maxItems":20,"type":"array","items":{"type":"object","properties":{"kind":{"type":"string","enum":["training","nutrition"]},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"headVersionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}},"required":["kind","aggregateId","headVersionId"],"additionalProperties":false}},"options":{"minItems":1,"maxItems":20,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"title":{"type":"string","minLength":1,"maxLength":160},"kind":{"type":"string","enum":["full_rest","maintain_existing_plan","nonexercise_action"]},"methodVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]},"explanation":{"type":"string","maxLength":2000}},"required":["id","title","kind","methodVersionId","explanation"],"additionalProperties":false}},"reassessment":{"minItems":1,"maxItems":20,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"trigger":{"type":"string","enum":["scheduled_checkin","user_report_changed","plan_changed","source_withdrawn"]},"plannedAt":{"anyOf":[{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},{"type":"null"}]},"description":{"type":"string","minLength":1,"maxLength":160},"policyVersion":{"anyOf":[{"type":"string","minLength":1,"maxLength":80},{"type":"null"}]}},"required":["id","trigger","plannedAt","description","policyVersion"],"additionalProperties":false}}},"required":["title","goal","startDate","endDateExclusive","timezone","knownFacts","missingInformation","priority","observations","planRefs","options","reassessment"],"additionalProperties":false},"selectedOptionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}},"required":["domain","aggregateId","expectedHead","proposed","selectedOptionId"],"additionalProperties":false},{"type":"object","properties":{"domain":{"type":"string","const":"routine_schedule"},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedHead":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"absent"}},"required":["kind"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string"}},"required":["kind","versionId"],"additionalProperties":false}]},"proposed":{"type":"object","properties":{"schemaVersion":{"type":"number","const":4},"id":{"type":"string"},"versionId":{"type":"string"},"blueprint":{"type":"object","properties":{"id":{"type":"string"},"versionId":{"type":"string"}},"required":["id","versionId"],"additionalProperties":false},"window":{"type":"object","properties":{"startDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"endDateExclusive":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"timezone":{"type":"string"},"maxOccurrences":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["startDate","endDateExclusive","timezone","maxOccurrences"],"additionalProperties":false},"rule":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"dates"},"dates":{"minItems":1,"type":"array","items":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]}},"required":["kind","dates","localTime"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"weekdays"},"weekdays":{"minItems":1,"type":"array","items":{"type":"integer","minimum":0,"maximum":6}},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]}},"required":["kind","weekdays","localTime"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"every_n_days"},"anchorDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"intervalDays":{"type":"integer","minimum":1,"maximum":9007199254740991},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]}},"required":["kind","anchorDate","intervalDays","localTime"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"period_days"},"periodId":{"type":"string"},"offsetsDays":{"minItems":1,"type":"array","items":{"type":"integer","minimum":0,"maximum":9007199254740991}},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]}},"required":["kind","periodId","offsetsDays","localTime"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"session_links"},"sessionIds":{"minItems":1,"type":"array","items":{"type":"string"}},"point":{"type":"string","enum":["start","end"]},"offsetMinutes":{"type":"number"}},"required":["kind","sessionIds","point","offsetMinutes"],"additionalProperties":false}]},"state":{"type":"string","enum":["draft","active","paused","ended"]}},"required":["schemaVersion","id","versionId","blueprint","window","rule","state"],"additionalProperties":false},"sourcePlanVersionId":{"anyOf":[{"type":"string","maxLength":200},{"type":"null"}]},"occurrences":{"maxItems":1000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"schedule":{"type":"object","properties":{"id":{"type":"string"},"versionId":{"type":"string"}},"required":["id","versionId"],"additionalProperties":false},"blueprint":{"type":"object","properties":{"id":{"type":"string"},"versionId":{"type":"string"}},"required":["id","versionId"],"additionalProperties":false},"anchorKey":{"type":"string"},"scheduledAt":{"anyOf":[{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},{"type":"null"}]},"timingStatus":{"type":"string","enum":["resolved","unresolved"]},"stepBindings":{"type":"array","items":{"type":"object","properties":{"stepId":{"type":"string"},"plannedRef":{"type":"object","properties":{"domain":{"type":"string","enum":["training","nutrition","recovery","routine_schedule"]},"planId":{"type":"string"},"versionId":{"type":"string"},"itemId":{"type":"string"}},"required":["domain","planId","versionId","itemId"],"additionalProperties":false}},"required":["stepId","plannedRef"],"additionalProperties":false}},"selectedChoices":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}}},"required":["id","schedule","blueprint","anchorKey","scheduledAt","timingStatus","stepBindings","selectedChoices"],"additionalProperties":false}}},"required":["domain","aggregateId","expectedHead","proposed","sourcePlanVersionId","occurrences"],"additionalProperties":false}]}},"notices":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"domain":{"type":"string","enum":["training","nutrition","recovery","routine_schedule"]},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"itemId":{"type":["string","null"]},"code":{"type":"string","enum":["UNCHANGED_UNRESOLVED","DISCONNECTED_RETAINED"]}},"required":["domain","aggregateId","itemId","code"],"additionalProperties":false}}},"required":["schemaVersion","candidateId","chain","applicationDigest","createdAt","raceChange","expectation","authority","applicationState","scope","affected","writes","notices"],"additionalProperties":false}]}'::jsonb
 WHEN 'command' THEN '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"confirmed":{"type":"boolean","const":true},"candidateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"applicationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"chain":{"type":"object","properties":{"evidenceId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"decisionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"proposalId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"readonlyCandidateDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["evidenceId","decisionId","proposalId","readonlyCandidateDigest"],"additionalProperties":false},"raceChange":{"type":"object","properties":{"eventId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedRevision":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"newLocalDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"required":["eventId","expectedRevision","newLocalDate"],"additionalProperties":false},"expectation":{"type":"object","properties":{"restoreGeneration":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"appRevision":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"manualPolicy":{"type":"object","properties":{"id":{"type":"string","const":"manual-race-date-impact"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","digest"],"additionalProperties":false},"semanticDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"heads":{"type":"object","properties":{"training":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","maxLength":200},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"nutrition":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"recovery":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["kind","versionId","version"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]},"routine_schedule":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"absent"}},"required":["state"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"present"},"members":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"head":{"type":"object","properties":{"kind":{"type":"string","const":"exists"},"versionId":{"type":"string"}},"required":["kind","versionId"],"additionalProperties":false}},"required":["aggregateId","head"],"additionalProperties":false}}},"required":["state","members"],"additionalProperties":false}]}},"required":["training","nutrition","recovery","routine_schedule"],"additionalProperties":false}},"required":["restoreGeneration","appRevision","manualPolicy","semanticDigest","heads"],"additionalProperties":false}},"required":["schemaVersion","idempotencyKey","confirmed","candidateId","applicationDigest","chain","raceChange","expectation"],"additionalProperties":false}'::jsonb
 WHEN 'result' THEN '{"$schema":"https://json-schema.org/draft/2020-12/schema","oneOf":[{"type":"object","properties":{"schemaVersion":{"type":"number","const":1},"status":{"type":"string","const":"blocked"},"candidateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"blockers":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"reason":{"type":"string","enum":["source_unavailable","source_permission_unavailable","stale_basis","incomplete_affected_scope","affected_timing_unresolved","disconnection_origin_unavailable","reconnect_target_unavailable","unsupported_source","application_port_unavailable"]},"target":{"anyOf":[{"type":"object","properties":{"domain":{"type":"string","enum":["training","nutrition","recovery","routine_schedule"]},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}},"required":["domain","aggregateId"],"additionalProperties":false},{"type":"null"}]}},"required":["reason","target"],"additionalProperties":false}}},"required":["schemaVersion","status","candidateId","blockers"],"additionalProperties":false},{"type":"object","properties":{"schemaVersion":{"type":"number","const":1},"status":{"type":"string","const":"committed"},"candidateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"approvalId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"proposalId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"approvedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"race":{"type":"object","properties":{"eventId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"revision":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["eventId","revision"],"additionalProperties":false},"versions":{"maxItems":1000,"type":"array","items":{"oneOf":[{"type":"object","properties":{"domain":{"type":"string","const":"training"},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"versionId":{"type":"string","maxLength":200},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["domain","aggregateId","versionId","version"],"additionalProperties":false},{"type":"object","properties":{"domain":{"type":"string","const":"nutrition"},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["domain","aggregateId","versionId","version"],"additionalProperties":false},{"type":"object","properties":{"domain":{"type":"string","const":"recovery"},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647}},"required":["domain","aggregateId","versionId","version"],"additionalProperties":false},{"type":"object","properties":{"domain":{"type":"string","const":"routine_schedule"},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"versionId":{"type":"string"}},"required":["domain","aggregateId","versionId"],"additionalProperties":false}]}},"occurrenceIds":{"maxItems":1000,"type":"array","items":{"type":"string"}},"notices":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"domain":{"type":"string","enum":["training","nutrition","recovery","routine_schedule"]},"aggregateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"itemId":{"type":["string","null"]},"code":{"type":"string","enum":["UNCHANGED_UNRESOLVED","DISCONNECTED_RETAINED"]}},"required":["domain","aggregateId","itemId","code"],"additionalProperties":false}}},"required":["schemaVersion","status","candidateId","approvalId","proposalId","approvedAt","race","versions","occurrenceIds","notices"],"additionalProperties":false}]}'::jsonb
 END $codec$;
REVOKE ALL ON FUNCTION public.race_manual_application_wire_v1(text) FROM PUBLIC;
CREATE TABLE public.race_manual_application_candidate_v1 (
 athlete_id text NOT NULL,id uuid NOT NULL,evidence_id uuid NOT NULL,decision_id uuid NOT NULL,proposal_id uuid NOT NULL,
 application_digest text NOT NULL CHECK(application_digest~'^[0-9a-f]{64}$'),
 candidate_json jsonb,basis_json jsonb,lifecycle_json jsonb,created_at timestamptz NOT NULL,
 purged_event_id uuid,purged_at timestamptz,
 CHECK((candidate_json IS NOT NULL AND basis_json IS NOT NULL AND lifecycle_json IS NOT NULL AND purged_event_id IS NULL AND purged_at IS NULL)
 OR (candidate_json IS NULL AND basis_json IS NULL AND lifecycle_json IS NULL AND purged_event_id IS NOT NULL AND purged_at IS NOT NULL)),
 CHECK(candidate_json IS NULL OR octet_length(candidate_json::text)+octet_length(basis_json::text)+octet_length(lifecycle_json::text)<=4194304),
 PRIMARY KEY(athlete_id,id),
 FOREIGN KEY(athlete_id,evidence_id) REFERENCES public.manual_race_evidence_v2(athlete_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.race_manual_application_context_v1 (
 athlete_id text NOT NULL,id uuid NOT NULL,candidate_id uuid NOT NULL,creator_role name NOT NULL,owner_xid bigint NOT NULL,
 request_key text NOT NULL,request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
 prior_versions jsonb NOT NULL,expected_event jsonb NOT NULL,result jsonb,
 PRIMARY KEY(athlete_id,id),UNIQUE(athlete_id,candidate_id),
 FOREIGN KEY(athlete_id,candidate_id) REFERENCES public.race_manual_application_candidate_v1(athlete_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.race_manual_application_receipt_v1 (
 athlete_id text NOT NULL,receipt_key text NOT NULL,request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
 candidate_id uuid NOT NULL,identity_digest bytea NOT NULL CHECK(octet_length(identity_digest)=32),result jsonb NOT NULL,
 PRIMARY KEY(athlete_id,receipt_key),UNIQUE(athlete_id,candidate_id),
 FOREIGN KEY(athlete_id,candidate_id) REFERENCES public.race_manual_application_candidate_v1(athlete_id,id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['race_manual_application_candidate_v1','race_manual_application_context_v1','race_manual_application_receipt_v1'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($policy$CREATE POLICY tenant ON public.%I USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''))$policy$,t);
 END LOOP;
END $$;
CREATE FUNCTION public.race_manual_application_owner_v1() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.race_manual_application_candidate_v1'::regclass)) THEN RAISE EXCEPTION 'RACE_MANUAL_PROTOCOL_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_application_owner_v1() FROM PUBLIC;
CREATE FUNCTION public.guard_race_manual_application_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=CASE WHEN TG_OP='DELETE' THEN OLD.athlete_id ELSE NEW.athlete_id END; BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=t) THEN RETURN OLD; END IF;
 PERFORM public.race_manual_application_owner_v1();
 IF t IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'RACE_MANUAL_TENANT_MISMATCH'; END IF;
 IF TG_TABLE_NAME='race_manual_application_candidate_v1' AND TG_OP='UPDATE' THEN
  IF NEW.candidate_json IS NOT NULL OR NEW.basis_json IS NOT NULL OR NEW.lifecycle_json IS NOT NULL
   OR (to_jsonb(NEW)-ARRAY['candidate_json','basis_json','lifecycle_json','purged_event_id','purged_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['candidate_json','basis_json','lifecycle_json','purged_event_id','purged_at'])
   OR NOT EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=t AND e.id=NEW.evidence_id AND e.payload IS NULL AND e.purged_event_id=NEW.purged_event_id AND e.purged_at=NEW.purged_at)
  THEN RAISE EXCEPTION 'RACE_MANUAL_IMMUTABLE_CANDIDATE'; END IF;
 ELSIF TG_TABLE_NAME='race_manual_application_context_v1' THEN
  IF (CASE WHEN TG_OP='DELETE' THEN OLD.creator_role ELSE NEW.creator_role END)<>session_user
   OR (CASE WHEN TG_OP='DELETE' THEN OLD.owner_xid ELSE NEW.owner_xid END)<>txid_current() THEN RAISE EXCEPTION 'RACE_MANUAL_CONTEXT_REQUIRED'; END IF;
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.race_manual_application_receipt_v1 r WHERE r.athlete_id=t AND r.candidate_id=OLD.candidate_id AND r.result=OLD.result) THEN RAISE EXCEPTION 'RACE_MANUAL_ATOMIC_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'result') IS DISTINCT FROM (to_jsonb(OLD)-'result') THEN RAISE EXCEPTION 'RACE_MANUAL_CONTEXT_IMMUTABLE'; END IF;
 ELSIF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'RACE_MANUAL_IMMUTABLE_APPLICATION'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION public.guard_race_manual_application_v1() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['race_manual_application_candidate_v1','race_manual_application_context_v1','race_manual_application_receipt_v1'] LOOP
  EXECUTE format('CREATE TRIGGER race_manual_application_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_race_manual_application_v1()',t);
  EXECUTE format('CREATE TRIGGER race_manual_application_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation()',t);
 END LOOP;
END $$;
CREATE FUNCTION public.race_manual_application_purge_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NEW.payload IS NULL AND OLD.payload IS NOT NULL THEN
  UPDATE public.race_manual_application_candidate_v1 SET candidate_json=NULL,basis_json=NULL,lifecycle_json=NULL,purged_event_id=NEW.purged_event_id,purged_at=NEW.purged_at WHERE athlete_id=NEW.athlete_id AND evidence_id=NEW.id AND candidate_json IS NOT NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_application_purge_v1() FROM PUBLIC;
CREATE TRIGGER race_manual_application_parent_purge AFTER UPDATE OF payload ON public.manual_race_evidence_v2 FOR EACH ROW EXECUTE FUNCTION public.race_manual_application_purge_v1();

CREATE FUNCTION public.race_manual_application_heads_v1(context jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb:='{}'; members jsonb; family text; BEGIN
 FOREACH family IN ARRAY ARRAY['training','nutrition','recovery','routine_schedule'] LOOP
  IF family='training' THEN
   members:=CASE WHEN context->'currentTraining' IS NULL OR context->'currentTraining'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('aggregateId',context->'currentTraining'->'aggregateId','head',jsonb_build_object('kind','exists','versionId',context->'currentTraining'->'snapshot'->'id','version',context->'currentTraining'->'snapshot'->'version'))) END;
  ELSIF family='routine_schedule' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('aggregateId',r->'aggregateId','head',jsonb_build_object('kind','exists','versionId',r->'record'->'versionId')) ORDER BY r->>'aggregateId'),'[]') INTO members FROM jsonb_array_elements(context->'routines') r;
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('aggregateId',r->'aggregateId','head',jsonb_build_object('kind','exists','versionId',r->'record'->'versionId','version',r->'record'->'version')) ORDER BY r->>'aggregateId'),'[]') INTO members FROM jsonb_array_elements(context->family) r;
  END IF;
  result:=result||jsonb_build_object(family,CASE WHEN members='[]'::jsonb THEN jsonb_build_object('state','absent') ELSE jsonb_build_object('state','present','members',members) END);
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_application_heads_v1(jsonb) FROM PUBLIC;

-- Derive affected membership from owned originals and the independent calendar
-- draft, not from a caller-supplied affected flag or projected timing.
CREATE FUNCTION public.race_manual_relative_membership_v1(retained jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb:=retained->'payload'->'preparation'->'context'; p jsonb:=retained->'payload'->'preparation'->'candidate'->'body'->'projection'; input jsonb:=retained->'payload'->'preparation'->'sourceInput'->'projectionInput';
 draft jsonb; changed_sessions jsonb; changed_periods jsonb; n jsonb; original jsonb; item jsonb; old_item jsonb; resolution jsonb; expected jsonb; r jsonb; source jsonb; affected boolean; used text[]:=ARRAY[]::text[];
BEGIN
 draft:=public.race_manual_calendar_draft_v1(c);
 SELECT coalesce(jsonb_agg(after->'id'),'[]') INTO changed_sessions FROM jsonb_array_elements(draft->'sessions') after JOIN jsonb_array_elements(c->'currentTraining'->'snapshot'->'draft'->'sessions') before ON after->'id'=before->'id' WHERE after->'date' IS DISTINCT FROM before->'date';
 SELECT coalesce(jsonb_agg(after->'id'),'[]') INTO changed_periods FROM jsonb_array_elements(draft->'periods') after JOIN jsonb_array_elements(c->'currentTraining'->'snapshot'->'draft'->'periods') before ON after->'id'=before->'id' WHERE after->'startDate' IS DISTINCT FROM before->'startDate' OR after->'endDateExclusive' IS DISTINCT FROM before->'endDateExclusive';
 IF jsonb_array_length(p->'nutrition')<>jsonb_array_length(c->'nutrition') OR jsonb_array_length(p->'routines')<>jsonb_array_length(c->'routines') THEN RAISE EXCEPTION 'RACE_MANUAL_INCOMPLETE_SCOPE'; END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(p->'nutrition') LOOP
  SELECT x->'record' INTO original FROM jsonb_array_elements(c->'nutrition') x WHERE x->'versionId'=n->'planVersionId';
  IF original IS NULL OR n->'record' IS DISTINCT FROM original OR (n->>'planVersionId')=ANY(used) OR jsonb_array_length(n->'items')<>jsonb_array_length(original->'items') THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_NUTRITION'; END IF;
  used:=array_append(used,n->>'planVersionId');
  FOR item IN SELECT value FROM jsonb_array_elements(n->'items') LOOP
   SELECT value INTO old_item FROM jsonb_array_elements(original->'items') x WHERE x->'id'=item->'itemId';
   IF old_item IS NULL OR (SELECT count(*) FROM jsonb_array_elements(n->'items') x WHERE x->'itemId'=item->'itemId')<>1 THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_NUTRITION'; END IF;
   affected:=coalesce(old_item->'anchor'->>'kind'='relative' AND ((old_item->'anchor'->>'entity'='race' AND old_item->'anchor'->'entityId'=c->'event'->'id' AND c->'event'->'localDate'<>c->'calendarIntent'->'newLocalDate') OR (old_item->'anchor'->>'entity'='session' AND original->'linkedTrainingPlanVersionId'=c->'currentTraining'->'snapshot'->'id' AND changed_sessions ? (old_item->'anchor'->>'entityId'))),false);
   SELECT value INTO resolution FROM jsonb_array_elements(input->'resolutions'->'nutrition') x WHERE x->'planVersionId'=n->'planVersionId' AND x->'itemId'=item->'itemId';
   expected:=CASE WHEN resolution IS NULL THEN old_item ELSE old_item||jsonb_build_object('anchor',resolution->'anchor') END;
   IF item->'item' IS DISTINCT FROM expected OR item->>'state' IS DISTINCT FROM (CASE WHEN affected THEN 'affected' ELSE 'unchanged' END) OR (NOT affected AND resolution IS NOT NULL) OR (affected AND (item->'after'->>'state'<>'resolved' OR item->'notice'<>'null'::jsonb)) THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_NUTRITION'; END IF;
   -- Disconnected anchors remain body-identical and unresolved until a separate
   -- explicit reconnect+reapproval protocol. No race date shift restores timing.
   IF old_item->'anchor'->>'kind'='disconnected' AND (item->'after' IS DISTINCT FROM item->'before' OR item->'after'->>'state'<>'unresolved') THEN RAISE EXCEPTION 'RACE_MANUAL_DISCONNECTED_TIMING'; END IF;
  END LOOP;
 END LOOP;
 used:=ARRAY[]::text[];
 FOR r IN SELECT value FROM jsonb_array_elements(p->'routines') LOOP
  SELECT value INTO source FROM jsonb_array_elements(c->'routineActualManifest'->'schedules') x WHERE x->'versionId'=r->'scheduleVersionId';
  IF source IS NULL OR source->'record' IS DISTINCT FROM r->'record' OR (r->>'scheduleVersionId')=ANY(used) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'routines') x WHERE x->'versionId'=r->'scheduleVersionId') THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_ROUTINE'; END IF;
  used:=array_append(used,r->>'scheduleVersionId');
  original:=source->'record';
  affected:=coalesce(source->'sourcePlanVersionId'=c->'currentTraining'->'snapshot'->'id' AND ((original->'rule'->>'kind'='period_days' AND changed_periods ? (original->'rule'->>'periodId')) OR (original->'rule'->>'kind'='session_links' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(original->'rule'->'sessionIds') x WHERE changed_sessions ? x))),false);
  expected:=to_jsonb(CASE WHEN NOT affected THEN 'unchanged' WHEN original->>'state'='ended' THEN 'retained_ended' ELSE 'affected' END);
  IF r->'state' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_ROUTINE'; END IF;
  SELECT value INTO resolution FROM jsonb_array_elements(input->'resolutions'->'routines') x WHERE x->'scheduleVersionId'=r->'scheduleVersionId';
  IF NOT affected AND resolution IS NOT NULL THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_ROUTINE'; END IF;
  IF r->>'state'='affected' THEN
   expected:=CASE WHEN resolution IS NULL THEN original ELSE original||jsonb_build_object('rule',resolution->'rule','window',resolution->'window') END;
   IF r->'projection'->'proposed' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_ROUTINE'; END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_relative_membership_v1(jsonb) FROM PUBLIC;

-- Same wall-clock candidate algorithm as the bounded public expander. A gap,
-- overlap or unknown time remains unresolved instead of choosing a UTC offset.
CREATE FUNCTION public.race_manual_local_instant_v1(local_date text,local_time text,timezone_name text) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH wanted AS (SELECT ($1||'T'||$2)::timestamp AS wall), samples AS (
  SELECT wall,wall AT TIME ZONE 'UTC' + hours*interval '1 hour' AS sample FROM wanted CROSS JOIN unnest(ARRAY[-14,-12,-10,-8,-6,-4,-2,0,2,4,6,8,10,12,14]) hours
 ), candidates AS (
  SELECT DISTINCT wall AT TIME ZONE 'UTC' - ((sample AT TIME ZONE $3)-(sample AT TIME ZONE 'UTC')) AS instant,wall FROM samples
 ), valid AS (SELECT instant FROM candidates WHERE instant AT TIME ZONE $3=wall)
 SELECT CASE WHEN count(*)=1 THEN min(instant) ELSE NULL END FROM valid
$$;
REVOKE ALL ON FUNCTION public.race_manual_local_instant_v1(text,text,text) FROM PUBLIC;
CREATE FUNCTION public.race_manual_routine_expansion_v1(retained jsonb,projected jsonb,schedule jsonb,source_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE c jsonb:=retained->'payload'->'preparation'->'context'; rule jsonb:=schedule->'rule'; schedule_window jsonb:=schedule->'window'; plan jsonb; period jsonb; session jsonb; entry jsonb; anchors jsonb:='[]'; result jsonb:='[]'; instant timestamptz; day date; first date; ending date; offset_days integer; key text; time text; zone text:=schedule_window->>'timezone'; BEGIN
 first:=(schedule_window->>'startDate')::date; ending:=(schedule_window->>'endDateExclusive')::date;
 IF ending-first>366 OR (schedule_window->>'maxOccurrences')::int>100 THEN RAISE EXCEPTION 'RACE_MANUAL_EXPANSION_LIMIT'; END IF;
 IF source_id=c->'currentTraining'->'snapshot'->>'id' THEN plan:=public.race_manual_calendar_draft_v1(c);
 ELSE SELECT p->'draft' INTO plan FROM jsonb_array_elements(c->'consumedSources'->'plans') p WHERE p->>'id'=source_id; END IF;
 IF rule->>'kind' IN ('period_days','session_links') AND (plan IS NULL OR plan->>'timezone' IS DISTINCT FROM zone) THEN RAISE EXCEPTION 'RACE_MANUAL_ROUTINE_SOURCE'; END IF;
 IF rule->>'kind'='dates' THEN
  FOR entry IN SELECT value FROM jsonb_array_elements(rule->'dates') LOOP anchors:=anchors||jsonb_build_array(jsonb_build_object('date',entry,'key',entry,'time',rule->'localTime')); END LOOP;
 ELSIF rule->>'kind'='weekdays' THEN
  FOR day IN SELECT generate_series(first,ending-1,interval '1 day')::date LOOP IF EXISTS(SELECT 1 FROM jsonb_array_elements(rule->'weekdays') d WHERE (d::text)::int=extract(dow FROM day)::int) THEN anchors:=anchors||jsonb_build_array(jsonb_build_object('date',day::text,'key',day::text,'time',rule->'localTime')); END IF; END LOOP;
 ELSIF rule->>'kind'='every_n_days' THEN
  day:=(rule->>'anchorDate')::date;
  IF day>first THEN RAISE EXCEPTION 'RACE_MANUAL_ROUTINE_WINDOW'; END IF;
  WHILE day<ending LOOP IF day>=first THEN anchors:=anchors||jsonb_build_array(jsonb_build_object('date',day::text,'key',day::text,'time',rule->'localTime')); END IF; day:=day+(rule->>'intervalDays')::int; IF jsonb_array_length(anchors)>100 THEN RAISE EXCEPTION 'RACE_MANUAL_EXPANSION_LIMIT'; END IF; END LOOP;
 ELSIF rule->>'kind'='period_days' THEN
  SELECT value INTO period FROM jsonb_array_elements(plan->'periods') p WHERE p->'id'=rule->'periodId';
  IF period IS NULL THEN RAISE EXCEPTION 'RACE_MANUAL_ROUTINE_SOURCE'; END IF;
  FOR offset_days IN SELECT value::int FROM jsonb_array_elements_text(rule->'offsetsDays') LOOP
   day:=(period->>'startDate')::date+offset_days;
   IF day>=(period->>'endDateExclusive')::date THEN RAISE EXCEPTION 'RACE_MANUAL_ROUTINE_PERIOD'; END IF;
   anchors:=anchors||jsonb_build_array(jsonb_build_object('date',day::text,'key',(period->>'id')||':'||offset_days::text,'time',rule->'localTime'));
  END LOOP;
 ELSIF rule->>'kind'='session_links' THEN
  FOR entry IN SELECT value FROM jsonb_array_elements(rule->'sessionIds') LOOP
   SELECT value INTO session FROM jsonb_array_elements(plan->'sessions') p WHERE p->'id'=entry;
   IF session IS NULL THEN RAISE EXCEPTION 'RACE_MANUAL_ROUTINE_SOURCE'; END IF;
   instant:=public.race_manual_local_instant_v1(session->>'date',session->>'localStartTime',zone);
   IF rule->>'point'='end' THEN IF session->'durationSeconds'='null'::jsonb THEN instant:=NULL; ELSE instant:=instant+(session->>'durationSeconds')::numeric*interval '1 second'; END IF; END IF;
   instant:=instant+(rule->>'offsetMinutes')::numeric*interval '1 minute';
   anchors:=anchors||jsonb_build_array(jsonb_build_object('date',coalesce(to_char(instant AT TIME ZONE zone,'YYYY-MM-DD'),session->>'date'),'key',(entry#>>'{}')||':'||(rule->>'point'),'instant',instant));
  END LOOP;
 ELSE RAISE EXCEPTION 'RACE_MANUAL_INVALID_ROUTINE'; END IF;
 IF jsonb_array_length(anchors)=0 OR jsonb_array_length(anchors)>100 OR jsonb_array_length(anchors)>(schedule_window->>'maxOccurrences')::int OR (SELECT count(DISTINCT a->>'key') FROM jsonb_array_elements(anchors) a)<>jsonb_array_length(anchors) THEN RAISE EXCEPTION 'RACE_MANUAL_EXPANSION_LIMIT'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(anchors) a ORDER BY a->>'key' LOOP
  day:=(entry->>'date')::date; key:=entry->>'key';
  IF day<first OR day>=ending THEN RAISE EXCEPTION 'RACE_MANUAL_ROUTINE_WINDOW'; END IF;
  instant:=CASE WHEN entry ? 'instant' THEN (entry->>'instant')::timestamptz ELSE public.race_manual_local_instant_v1(day::text,entry->>'time',zone) END;
  -- Started occurrences retain their original source/blueprint/actuals and do
  -- not receive a new scheduled occurrence with the same anchor key.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'routineActualManifest'->'occurrences') o JOIN jsonb_array_elements(c->'routineActualManifest'->'runs') r ON r->'record'->'origin'->'occurrenceId'=o->'record'->'id' WHERE o->'record'->'schedule'->'id'=schedule->'id' AND o->'record'->>'anchorKey'=key AND r->'record'->'origin'->>'kind'='planned') THEN CONTINUE; END IF;
  IF instant IS NULL THEN RAISE EXCEPTION 'RACE_MANUAL_UNRESOLVED'; END IF;
  result:=result||jsonb_build_array(jsonb_build_object('blueprint',schedule->'blueprint','anchorKey',key,'scheduledAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'timingStatus','resolved','stepBindings','[]'::jsonb,'selectedChoices','{}'::jsonb));
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_routine_expansion_v1(jsonb,jsonb,jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.race_manual_application_validate_recipes_v1(candidate jsonb,retained jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb:=retained->'payload'->'preparation'->'context'; p jsonb:=retained->'payload'->'preparation'->'candidate'->'body'->'projection';
 w jsonb; n jsonb; r jsonb; draft jsonb; expected jsonb; targets jsonb:='[]'; training_changed boolean; used text[]:=ARRAY[]::text[]; key text; source jsonb;
BEGIN
 PERFORM public.race_manual_application_owner_v1();
 IF NOT public.nutrition_copy_structural_codec(candidate,public.race_manual_application_wire_v1('candidate')) OR candidate->>'applicationState'<>'ready_for_explicit_approval'
  OR p->>'status'<>'projected' OR p->'requiresResolution' IS DISTINCT FROM 'false'::jsonb
  OR candidate->'raceChange' IS DISTINCT FROM jsonb_build_object('eventId',c->'event'->'id','expectedRevision',c->'event'->'revision','newLocalDate',p->'calendar'->'eventDate'->'after')
 THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_RECIPE'; END IF;
 PERFORM public.race_manual_relative_membership_v1(retained);
 IF candidate->'expectation'->'heads' IS DISTINCT FROM public.race_manual_application_heads_v1(c) THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_HEAD_ROSTER'; END IF;
 IF p->'calendar'->'plan' IS DISTINCT FROM public.race_manual_calendar_draft_v1(c) THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_CALENDAR'; END IF;
 training_changed:=c->'currentTraining'<>'null'::jsonb AND p->'calendar'->'plan' IS DISTINCT FROM c->'currentTraining'->'snapshot'->'draft';
 IF training_changed THEN targets:=targets||jsonb_build_array(jsonb_build_object('domain','training','aggregateId',c->'currentTraining'->'aggregateId')); END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(p->'nutrition') LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(n->'items') i WHERE i->>'state'='affected') OR (training_changed AND n->'record'->'linkedTrainingPlanVersionId'=c->'currentTraining'->'snapshot'->'id') THEN
   targets:=targets||jsonb_build_array(jsonb_build_object('domain','nutrition','aggregateId',n->'record'->'planId'));
  END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(c->'recovery') LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'record'->'draft'->'planRefs') ref WHERE
   (ref->>'kind'='training' AND training_changed AND ref->'headVersionId'=c->'currentTraining'->'snapshot'->'id')
   OR (ref->>'kind'='nutrition' AND EXISTS(SELECT 1 FROM jsonb_array_elements(targets) t WHERE t->>'domain'='nutrition' AND t->'aggregateId'=ref->'aggregateId'))) THEN
   targets:=targets||jsonb_build_array(jsonb_build_object('domain','recovery','aggregateId',r->'aggregateId'));
  END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'routines') LOOP
  IF r->>'state'='affected' THEN
   IF r->'notice'<>'null'::jsonb OR r->'projection'->'expansion'->>'state'<>'expanded' THEN RAISE EXCEPTION 'RACE_MANUAL_UNRESOLVED'; END IF;
   targets:=targets||jsonb_build_array(jsonb_build_object('domain','routine_schedule','aggregateId',r->'record'->'id'));
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'domain',x->>'aggregateId'),'[]') INTO expected FROM jsonb_array_elements(targets) x;
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'domain',x->>'aggregateId'),'[]') INTO targets FROM jsonb_array_elements(candidate->'affected') x;
 IF expected IS DISTINCT FROM targets OR jsonb_array_length(candidate->'writes')<>jsonb_array_length(targets) THEN RAISE EXCEPTION 'RACE_MANUAL_INCOMPLETE_SCOPE'; END IF;
 FOR w IN SELECT value FROM jsonb_array_elements(candidate->'writes') LOOP
  key:=(w->>'domain')||':'||(w->>'aggregateId');
  IF key=ANY(used) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(targets) t WHERE t->'domain'=w->'domain' AND t->'aggregateId'=w->'aggregateId') THEN RAISE EXCEPTION 'RACE_MANUAL_INCOMPLETE_SCOPE'; END IF;
  used:=array_append(used,key);
  IF w->>'domain'='training' THEN
   IF w->'proposed' IS DISTINCT FROM p->'calendar'->'plan' OR w->'expectedHead' IS DISTINCT FROM jsonb_build_object('kind','exists','versionId',c->'currentTraining'->'snapshot'->'id','version',c->'currentTraining'->'snapshot'->'version') THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_RECIPE'; END IF;
  ELSIF w->>'domain'='nutrition' THEN
   SELECT value INTO n FROM jsonb_array_elements(p->'nutrition') x WHERE x->'record'->'planId'=w->'aggregateId';
   SELECT coalesce(jsonb_agg((i->'item')-'planVersionId' ORDER BY ord),'[]') INTO expected FROM jsonb_array_elements(n->'items') WITH ORDINALITY a(i,ord);
   draft:=w->'intent'->'intent'->'command'->'draft';
   IF draft->'items' IS DISTINCT FROM expected OR (draft-'items') IS DISTINCT FROM ((n->'record')-ARRAY['schemaVersion','planId','versionId','version','previousVersionId','approvalId','approvedAt','items','raceTimingPins','itemRaceTimingBindings'])
    OR w->'expectedHead' IS DISTINCT FROM jsonb_build_object('kind','exists','versionId',n->'record'->'versionId','version',n->'record'->'version')
    OR w->'intent'->'intent'->'command'->>'idempotencyKey' IS DISTINCT FROM 'race_approval_'||replace(candidate->>'candidateId','-','')||'_'||replace(w->>'aggregateId','-','')
    OR w->'intent'->'intent'->'reconnectItemIds'<>'[]'::jsonb
   THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_RECIPE'; END IF;
  ELSIF w->>'domain'='recovery' THEN
   SELECT value INTO r FROM jsonb_array_elements(c->'recovery') x WHERE x->'aggregateId'=w->'aggregateId';
   IF w->'proposed' IS DISTINCT FROM r->'record'->'draft' OR w->'selectedOptionId' IS DISTINCT FROM r->'record'->'selectedOptionId' OR r->'record'->>'status'<>'user_confirmed'
    OR w->'expectedHead' IS DISTINCT FROM jsonb_build_object('kind','exists','versionId',r->'record'->'versionId','version',r->'record'->'version') THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_RECIPE'; END IF;
  ELSIF w->>'domain'='routine_schedule' THEN
   SELECT value INTO r FROM jsonb_array_elements(p->'routines') x WHERE x->'record'->'id'=w->'aggregateId';
   SELECT value INTO source FROM jsonb_array_elements(c->'routineActualManifest'->'schedules') s WHERE s->'versionId'=r->'scheduleVersionId';
   IF ((w->'proposed')-'versionId') IS DISTINCT FROM ((r->'projection'->'proposed')-'versionId') OR w->'proposed'->'versionId'=r->'record'->'versionId'
    OR w->'sourcePlanVersionId' IS DISTINCT FROM coalesce((SELECT x->'sourcePlanVersionId' FROM jsonb_array_elements(retained->'payload'->'preparation'->'sourceInput'->'projectionInput'->'resolutions'->'routines') x WHERE x->'scheduleVersionId'=r->'scheduleVersionId'),source->'sourcePlanVersionId') OR w->'expectedHead' IS DISTINCT FROM jsonb_build_object('kind','exists','versionId',r->'record'->'versionId') THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_RECIPE'; END IF;
   SELECT coalesce(jsonb_agg(o ORDER BY o->>'anchorKey'),'[]') INTO expected FROM jsonb_array_elements(public.race_manual_routine_expansion_v1(retained,r,w->'proposed',w->>'sourcePlanVersionId')) o;
   SELECT coalesce(jsonb_agg((o-ARRAY['id','schedule']) ORDER BY o->>'anchorKey'),'[]') INTO draft FROM jsonb_array_elements(w->'occurrences') o;
   IF expected IS DISTINCT FROM draft OR EXISTS(SELECT 1 FROM jsonb_array_elements(w->'occurrences') o WHERE o->'schedule'<>jsonb_build_object('id',w->'aggregateId','versionId',w->'proposed'->'versionId') OR o->>'timingStatus'<>'resolved') THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_RECIPE'; END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_application_validate_recipes_v1(jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION public.prepare_race_manual_application_v1(candidate jsonb,basis jsonb,retained jsonb,lifecycle jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); parent public.manual_race_evidence_v2; old_context jsonb; current_context jsonb; k text;
 original_refs jsonb; fresh_refs jsonb; BEGIN
 PERFORM public.race_manual_application_owner_v1();
 PERFORM public.validate_race_manual_multi_owned_basis_v3($3,$2,$4);
 PERFORM public.race_manual_application_validate_recipes_v1($1,$3);
 IF octet_length($1::text)+octet_length($2::text)+octet_length($4::text)>4194304 THEN RAISE EXCEPTION 'RACE_MANUAL_INPUT_BOUND'; END IF;
 SELECT * INTO parent FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=t AND e.id=($1->'chain'->>'evidenceId')::uuid FOR SHARE;
 IF parent.id IS NULL OR parent.payload IS NULL OR parent.decision_id::text IS DISTINCT FROM $1->'chain'->>'decisionId' OR parent.proposal_id::text IS DISTINCT FROM $1->'chain'->>'proposalId' OR parent.candidate_digest IS DISTINCT FROM $1->'chain'->>'readonlyCandidateDigest'
  OR $1->'expectation'->>'appRevision' IS DISTINCT FROM $2->'manualBasis'->'app'->>'revision' OR $1->'expectation'->'manualPolicy' IS DISTINCT FROM $2->'manualBasis'->'policy'
  OR $1->'expectation'->'restoreGeneration' IS DISTINCT FROM $2->'restoreGeneration' THEN RAISE EXCEPTION 'RACE_MANUAL_PARENT_UNAVAILABLE'; END IF;
 IF parent.payload->'payload'->'preparation'->'candidate'->'body'->'projection' IS DISTINCT FROM $3->'payload'->'preparation'->'candidate'->'body'->'projection' THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_PARENT'; END IF;
 old_context:=parent.payload->'payload'->'preparation'->'context'; current_context:=$3->'payload'->'preparation'->'context';
 FOREACH k IN ARRAY ARRAY['event','manualBasis','restoreGeneration','currentTraining','rosters','collectorSelection','calendarIntent'] LOOP
  IF coalesce(old_context->k,'null') IS DISTINCT FROM coalesce(current_context->k,'null') THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_PARENT'; END IF;
 END LOOP;
 IF old_context->'sourcePermissionManifest'->'activityMediaPermissions'->'activities' IS DISTINCT FROM $2->'activities' THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_PARENT'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('identity',x->'identity','dtoDigest',x->'dtoDigest') ORDER BY n),'[]') INTO original_refs FROM jsonb_array_elements(parent.payload->'payload'->'inventory'->'refs') WITH ORDINALITY a(x,n);
 SELECT coalesce(jsonb_agg(jsonb_build_object('identity',x->'identity','dtoDigest',x->'dtoDigest') ORDER BY n),'[]') INTO fresh_refs FROM jsonb_array_elements($3->'payload'->'inventory'->'refs') WITH ORDINALITY a(x,n);
 IF original_refs IS DISTINCT FROM fresh_refs OR $2->'copiedSources' IS DISTINCT FROM fresh_refs THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_PARENT'; END IF;
 INSERT INTO public.race_manual_application_candidate_v1 VALUES(t,($1->>'candidateId')::uuid,parent.id,parent.decision_id,parent.proposal_id,$1->>'applicationDigest',$1,$2,$4,($1->>'createdAt')::timestamptz,NULL,NULL);
 RETURN $1;
END $$;
REVOKE ALL ON FUNCTION public.prepare_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION public.read_race_manual_application_v1(candidate uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; BEGIN
 PERFORM public.race_manual_application_owner_v1();
 SELECT jsonb_build_object('candidate',c.candidate_json,'basis',c.basis_json) INTO result FROM public.race_manual_application_candidate_v1 c JOIN public.manual_race_evidence_v2 e ON e.athlete_id=c.athlete_id AND e.id=c.evidence_id WHERE c.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND c.id=$1 AND c.candidate_json IS NOT NULL AND e.payload IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tenant_erasure x WHERE x.athlete_id=c.athlete_id);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_race_manual_application_v1(uuid) FROM PUBLIC;
CREATE FUNCTION public.read_race_manual_application_receipt_v1(key text,command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE receipt public.race_manual_application_receipt_v1; t text:=nullif(current_setting('app.athlete_id',true),''); BEGIN
 PERFORM public.race_manual_application_owner_v1();
 IF NOT public.nutrition_copy_structural_codec($2,public.race_manual_application_wire_v1('command')) OR octet_length($2::text)>4194304 OR $2->>'idempotencyKey' IS DISTINCT FROM $1 THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_COMMAND'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=t) THEN RAISE EXCEPTION 'RACE_MANUAL_TENANT_UNAVAILABLE'; END IF;
 SELECT * INTO receipt FROM public.race_manual_application_receipt_v1 r WHERE r.athlete_id=t AND r.receipt_key=$1;
 IF FOUND THEN
  IF receipt.request_digest IS DISTINCT FROM sha256(convert_to($2::text,'UTF8')) THEN RAISE EXCEPTION 'RACE_MANUAL_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN receipt.result;
 END IF;
 -- A candidate has exactly one original application identity. A different key
 -- cannot run children again; matching immutable approval facts return original refs.
 SELECT * INTO receipt FROM public.race_manual_application_receipt_v1 r WHERE r.athlete_id=t AND r.candidate_id=($2->>'candidateId')::uuid;
 IF FOUND THEN
  IF receipt.identity_digest IS DISTINCT FROM sha256(convert_to(($2-'idempotencyKey')::text,'UTF8')) THEN RAISE EXCEPTION 'RACE_MANUAL_ALREADY_APPLIED'; END IF;
  RETURN receipt.result;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.read_race_manual_application_receipt_v1(text,jsonb) FROM PUBLIC;
CREATE FUNCTION public.race_manual_versions_v1(t text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('training',(SELECT count(*)::text FROM public.plan_snapshot WHERE athlete_id=$1),
 'nutrition',(SELECT count(*)::text FROM public.nutrition_plan_version WHERE athlete_id=$1),
 'recovery',(SELECT count(*)::text FROM public.recovery_strategy_version WHERE athlete_id=$1),
 'routine_schedule',(SELECT count(*)::text FROM public.routine_schedule_version WHERE athlete_id=$1))
$$;
REVOKE ALL ON FUNCTION public.race_manual_versions_v1(text) FROM PUBLIC;
CREATE FUNCTION public.begin_race_manual_application_v1(command jsonb,basis jsonb,retained jsonb,lifecycle jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); c public.race_manual_application_candidate_v1; context_id uuid:=gen_random_uuid(); BEGIN
 PERFORM public.race_manual_application_owner_v1();
 PERFORM public.validate_race_manual_multi_owned_basis_v3($3,$2,$4);
 IF public.read_race_manual_application_receipt_v1($1->>'idempotencyKey',$1) IS NOT NULL THEN RAISE EXCEPTION 'RACE_MANUAL_ALREADY_APPLIED'; END IF;
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 WHERE athlete_id=t AND id=($1->>'candidateId')::uuid FOR UPDATE;
 IF c.id IS NULL OR c.candidate_json IS NULL OR c.basis_json IS DISTINCT FROM $2 OR c.lifecycle_json IS DISTINCT FROM $4 OR c.application_digest IS DISTINCT FROM $1->>'applicationDigest'
  OR c.candidate_json->'chain' IS DISTINCT FROM $1->'chain' OR c.candidate_json->'raceChange' IS DISTINCT FROM $1->'raceChange' OR c.candidate_json->'expectation' IS DISTINCT FROM $1->'expectation'
 THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_BASIS'; END IF;
 PERFORM public.race_manual_application_validate_recipes_v1(c.candidate_json,$3);
 IF NOT EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=t AND e.id=c.evidence_id AND e.payload IS NOT NULL) THEN RAISE EXCEPTION 'RACE_MANUAL_PARENT_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.race_manual_application_context_v1 x WHERE x.athlete_id=t AND x.owner_xid=txid_current() AND x.creator_role=session_user) THEN RAISE EXCEPTION 'RACE_MANUAL_CONTEXT_ALREADY_ACTIVE'; END IF;
 INSERT INTO public.race_manual_application_context_v1 VALUES(t,context_id,c.id,session_user,txid_current(),$1->>'idempotencyKey',sha256(convert_to($1::text,'UTF8')),public.race_manual_versions_v1(t),$2->'event',NULL);
 RETURN context_id;
END $$;
REVOKE ALL ON FUNCTION public.begin_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION public.apply_race_manual_event_v1(context uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); x public.race_manual_application_context_v1; c public.race_manual_application_candidate_v1; e public.race_event; values jsonb; collection integer; stamp timestamptz:=clock_timestamp(); BEGIN
 PERFORM public.race_manual_application_owner_v1();
 SELECT * INTO x FROM public.race_manual_application_context_v1 WHERE athlete_id=t AND id=$1 AND owner_xid=txid_current() AND creator_role=session_user;
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 WHERE athlete_id=t AND id=x.candidate_id;
 PERFORM public.require_app_admission_revision((c.basis_json->'manualBasis'->'app'->>'revision')::integer);
 SELECT * INTO e FROM public.race_event WHERE athlete_id=t AND id=(x.expected_event->>'id')::uuid AND NOT deleted FOR UPDATE;
 IF x.id IS NULL OR c.candidate_json IS NULL OR e.revision IS DISTINCT FROM (x.expected_event->>'revision')::integer OR e.values_json||jsonb_build_object('id',e.id,'revision',e.revision) IS DISTINCT FROM x.expected_event THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_BASIS'; END IF;
 SELECT revision INTO collection FROM public.race_collection_head WHERE athlete_id=t AND kind='race-event' FOR UPDATE;
 IF collection IS NULL OR collection>=2147483647 OR e.revision>=2147483647 THEN RAISE EXCEPTION 'RACE_MANUAL_REVISION_BOUND'; END IF;
 values:=e.values_json||jsonb_build_object('localDate',c.candidate_json->'raceChange'->'newLocalDate');
 IF e.values_json->'planVersionId'=c.basis_json->'currentTraining'->'snapshot'->'id' AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.candidate_json->'writes') w WHERE w->>'domain'='training') THEN
  values:=values||jsonb_build_object('planVersionId',(SELECT version_id FROM public.plan_head WHERE athlete_id=t));
  IF NOT EXISTS(SELECT 1 FROM public.plan_head h JOIN public.plan_snapshot s ON s.athlete_id=h.athlete_id AND s.id=h.version_id WHERE h.athlete_id=t AND s.version=(c.basis_json->'currentTraining'->'snapshot'->>'version')::integer+1 AND s.draft=(SELECT w->'proposed' FROM jsonb_array_elements(c.candidate_json->'writes') w WHERE w->>'domain'='training')) THEN RAISE EXCEPTION 'RACE_MANUAL_TRAINING_REQUIRED'; END IF;
 END IF;
 UPDATE public.race_event SET revision=e.revision+1,values_json=values,updated_at=stamp WHERE athlete_id=t AND id=e.id;
 INSERT INTO public.race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES(t,e.id,e.revision+1,values,stamp);
 UPDATE public.race_collection_head SET revision=collection+1 WHERE athlete_id=t AND kind='race-event';
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload) VALUES(t,gen_random_uuid(),'race:race-event:'||e.id::text||':'||(e.revision+1)::text,'race.race-event_changed',jsonb_build_object('id',e.id,'revision',e.revision+1,'kind','race-event','collectionRevision',collection+1,'action','update'));
 RETURN jsonb_build_object('eventId',e.id,'revision',e.revision+1);
END $$;
REVOKE ALL ON FUNCTION public.apply_race_manual_event_v1(uuid) FROM PUBLIC;
CREATE FUNCTION public.race_manual_nutrition_affected_items_v1(context uuid,request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); x public.race_manual_application_context_v1; c public.race_manual_application_candidate_v1;
 w jsonb; expected jsonb; draft jsonb; linked uuid; h jsonb; heads jsonb:='[]'; row public.race_event; prior public.nutrition_plan_version; result jsonb;
BEGIN
 PERFORM public.race_manual_application_owner_v1();
 SELECT * INTO x FROM public.race_manual_application_context_v1 WHERE athlete_id=t AND id=$1 AND owner_xid=txid_current() AND creator_role=session_user;
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 WHERE athlete_id=t AND id=x.candidate_id AND candidate_json IS NOT NULL;
 IF x.id IS NULL OR c.id IS NULL OR x.result IS NOT NULL THEN RAISE EXCEPTION 'RACE_MANUAL_CONTEXT_REQUIRED'; END IF;
 PERFORM public.require_app_admission_revision((c.basis_json->'manualBasis'->'app'->>'revision')::integer);
 SELECT value INTO w FROM jsonb_array_elements(c.candidate_json->'writes') q WHERE q->>'domain'='nutrition' AND q->'aggregateId'=$2->'planId';
 IF w IS NULL THEN RAISE EXCEPTION 'RACE_MANUAL_NUTRITION_SCOPE'; END IF;
 draft:=w->'intent'->'intent'->'command'->'draft';
 IF draft->'linkedTrainingPlanVersionId'=c.basis_json->'currentTraining'->'snapshot'->'id' AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.candidate_json->'writes') q WHERE q->>'domain'='training') THEN
  SELECT h.version_id INTO linked FROM public.plan_head h JOIN public.plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id WHERE h.athlete_id=t AND p.version=(c.basis_json->'currentTraining'->'snapshot'->>'version')::integer+1 AND p.draft=(SELECT q->'proposed' FROM jsonb_array_elements(c.candidate_json->'writes') q WHERE q->>'domain'='training');
  IF linked IS NULL THEN RAISE EXCEPTION 'RACE_MANUAL_TRAINING_REQUIRED'; END IF;
  draft:=draft||jsonb_build_object('linkedTrainingPlanVersionId',linked);
 END IF;
 FOR h IN SELECT value FROM jsonb_array_elements(w->'intent'->'intent'->'expectedRaceHeads') LOOP
  SELECT * INTO row FROM public.race_event WHERE athlete_id=t AND id=(h->>'eventId')::uuid AND NOT deleted;
  IF h->'eventId'=x.expected_event->'id' THEN
   IF row.revision<>(x.expected_event->>'revision')::integer+1 OR row.values_json->'localDate' IS DISTINCT FROM c.candidate_json->'raceChange'->'newLocalDate'
    OR NOT EXISTS(SELECT 1 FROM public.race_event_revision r WHERE r.athlete_id=t AND r.entity_id=row.id AND r.revision=row.revision AND r.values_json=row.values_json) THEN RAISE EXCEPTION 'RACE_MANUAL_EVENT_REQUIRED'; END IF;
   heads:=heads||jsonb_build_array(h||jsonb_build_object('revision',row.revision));
  ELSE
   IF row.id IS NULL OR row.revision<>(h->>'revision')::integer THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_SOURCE'; END IF;
   heads:=heads||jsonb_build_array(h);
  END IF;
 END LOOP;
 expected:=w->'intent'->'intent'->'command'||jsonb_build_object('operation','nutrition_plan_save','intentSchemaVersion',4,'draft',draft,'expectedRaceHeads',heads,'reconnectItemIds',w->'intent'->'intent'->'reconnectItemIds');
 IF expected IS DISTINCT FROM $2 THEN RAISE EXCEPTION 'RACE_MANUAL_NUTRITION_RECIPE'; END IF;
 SELECT * INTO prior FROM public.nutrition_plan_version v WHERE v.athlete_id=t AND v.plan_id=(request->>'planId')::uuid AND v.version_id=(request->>'expectedHeadVersionId')::uuid;
 IF prior.version_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.nutrition_plan_head h WHERE h.athlete_id=t AND h.plan_id=prior.plan_id AND h.version_id=prior.version_id AND h.version=prior.version) THEN RAISE EXCEPTION 'RACE_MANUAL_STALE_SOURCE'; END IF;
 SELECT coalesce(jsonb_agg(i->'id' ORDER BY public.manual_race_v2_utf16_key(i->>'id')),'[]') INTO result FROM jsonb_array_elements(prior.record_json->'items') i
 WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND i->'anchor'->'entityId'=x.expected_event->'id'
 AND x.expected_event->'localDate' IS DISTINCT FROM c.candidate_json->'raceChange'->'newLocalDate'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(prior.record_json->'itemRaceTimingBindings','[]')) b WHERE b->'itemId'=i->'id' AND b->'binding'->>'state'='captured' AND b->'binding'->'eventId'=x.expected_event->'id')
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(draft->'items') d WHERE d->'id'=i->'id' AND d->'anchor'=i->'anchor');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_nutrition_affected_items_v1(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION public.race_manual_nutrition_preserved_items_v1(context uuid,request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); x public.race_manual_application_context_v1; old jsonb; ids jsonb; BEGIN
 -- This call verifies immutable candidate, creator/xid, actual app/source heads,
 -- exact child request and owned prior, and the target race's actual postimage.
 PERFORM public.race_manual_nutrition_affected_items_v1($1,$2);
 SELECT * INTO x FROM public.race_manual_application_context_v1 WHERE athlete_id=t AND id=$1 AND owner_xid=txid_current() AND creator_role=session_user AND result IS NULL;
 SELECT record_json INTO old FROM public.nutrition_plan_version WHERE athlete_id=t AND plan_id=(request->>'planId')::uuid AND version_id=(request->>'expectedHeadVersionId')::uuid;
 IF old->'period' IS DISTINCT FROM request->'draft'->'period' OR old->'timezone' IS DISTINCT FROM request->'draft'->'timezone' THEN RETURN '[]'; END IF;
 SELECT coalesce(jsonb_agg(i->'id' ORDER BY public.manual_race_v2_utf16_key(i->>'id')),'[]') INTO ids FROM jsonb_array_elements(old->'items') i
 WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND i->'anchor'->'entityId' IS DISTINCT FROM x.expected_event->'id'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(request->'draft'->'items') n WHERE n->'id'=i->'id' AND n IS NOT DISTINCT FROM (i-'planVersionId'))
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(old->'itemRaceTimingBindings') b WHERE b->'itemId'=i->'id' AND b->'binding'->>'state'='captured' AND b->'binding'->'eventId'=i->'anchor'->'entityId');
 RETURN ids;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_nutrition_preserved_items_v1(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION public.race_manual_nutrition_item_preserved_v1(t text,plan uuid,prior uuid,item text,anchor jsonb,request jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ DECLARE context uuid; ids jsonb; BEGIN
 SELECT x.id INTO context FROM public.race_manual_application_context_v1 x JOIN public.race_manual_application_candidate_v1 c ON c.athlete_id=x.athlete_id AND c.id=x.candidate_id WHERE x.athlete_id=t AND x.owner_xid=txid_current() AND x.creator_role=session_user AND x.result IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.candidate_json->'writes') w WHERE w->>'domain'='nutrition' AND w->>'aggregateId'=plan::text);
 IF context IS NULL THEN RETURN false; END IF;
 IF t IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') OR (request->>'planId')::uuid IS DISTINCT FROM plan OR (request->>'expectedHeadVersionId')::uuid IS DISTINCT FROM prior THEN RAISE EXCEPTION 'RACE_MANUAL_CONTEXT_REQUIRED'; END IF;
 ids:=public.race_manual_nutrition_preserved_items_v1(context,request);
 RETURN ids @> jsonb_build_array(item) AND anchor->>'kind'='relative' AND anchor->>'entity'='race';
END $$;
REVOKE ALL ON FUNCTION public.race_manual_nutrition_item_preserved_v1(text,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION public.race_manual_nutrition_item_affected_v1(t text,plan uuid,prior uuid,item text,anchor jsonb,request jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ DECLARE context uuid; ids jsonb; BEGIN
 SELECT x.id INTO context FROM public.race_manual_application_context_v1 x JOIN public.race_manual_application_candidate_v1 c ON c.athlete_id=x.athlete_id AND c.id=x.candidate_id
 WHERE x.athlete_id=t AND x.owner_xid=txid_current() AND x.creator_role=session_user AND x.result IS NULL
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.candidate_json->'writes') w WHERE w->>'domain'='nutrition' AND w->>'aggregateId'=plan::text);
 IF context IS NULL THEN RETURN false; END IF;
 PERFORM public.race_manual_application_owner_v1();
 IF t IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') OR (request->>'planId')::uuid IS DISTINCT FROM plan OR (request->>'expectedHeadVersionId')::uuid IS DISTINCT FROM prior THEN RAISE EXCEPTION 'RACE_MANUAL_CONTEXT_REQUIRED'; END IF;
 ids:=public.race_manual_nutrition_affected_items_v1(context,request);
 RETURN ids @> jsonb_build_array(item) AND anchor->>'kind'='relative' AND anchor->>'entity'='race';
END $$;
REVOKE ALL ON FUNCTION public.race_manual_nutrition_item_affected_v1(text,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC;

-- Exact SQL110 successor: original signature/security/config/ACL preserved; only
-- unchanged pin selection consults the actual xid-scoped application context.
CREATE OR REPLACE FUNCTION public.commit_nutrition_plan_v4(plan uuid,expected uuid,request jsonb,saved jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); prior public.nutrition_plan_version%ROWTYPE;
 receipt public.command_receipt%ROWTYPE; app_revision integer; key text; request_digest text; result jsonb;
 command jsonb; nested jsonb; item jsonb; old_item jsonb; bind jsonb; old_bind jsonb; pin jsonb; old_pin jsonb;
 expected_head jsonb; race public.race_event%ROWTYPE; rev public.race_event_revision%ROWTYPE; ancestor record;
 unchanged boolean; reconnect boolean; source_instant timestamptz; linked jsonb; content jsonb;
BEGIN
 PERFORM public.assert_nutrition_v4_caller();
 PERFORM public.manual_review_owner();
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 IF tenant IS NULL OR NOT EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id=tenant::uuid) THEN RAISE EXCEPTION 'NUTRITION_V4_ACCOUNT_REQUIRED'; END IF;
 app_revision:=public.require_app_admission_revision(NULL);
 IF jsonb_typeof(request)<>'object' OR octet_length(request::text)>524288 OR request->>'operation' IS DISTINCT FROM 'nutrition_plan_save' OR request->'intentSchemaVersion' IS DISTINCT FROM '4'::jsonb THEN RAISE EXCEPTION 'NUTRITION_V4_INTENT_INVALID'; END IF;
 command:=request-ARRAY['operation','intentSchemaVersion','expectedRaceHeads','reconnectItemIds'];
 nested:=jsonb_build_object('schemaVersion',4,'intent',jsonb_build_object('schemaVersion',3,'command',command,'expectedRaceHeads',request->'expectedRaceHeads','reconnectItemIds',request->'reconnectItemIds'));
 IF NOT public.nutrition_copy_structural_codec(nested,public.nutrition_v4_wire_schema('intent')) OR command->>'kind' IS DISTINCT FROM 'update' OR command->'confirmed' IS DISTINCT FROM 'true'::jsonb OR (command->>'planId')::uuid IS DISTINCT FROM plan OR (command->>'expectedHeadVersionId')::uuid IS DISTINCT FROM expected THEN RAISE EXCEPTION 'NUTRITION_V4_INTENT_INVALID'; END IF;
 key:='nutrition-plan:'||(command->>'idempotencyKey');
 request_digest:=encode(sha256(convert_to(request::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM public.command_receipt WHERE athlete_id=tenant AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.request IS DISTINCT FROM jsonb_build_object('receiptVersion',3,'digestVersion','postgres-jsonb-sha256-v1','requestDigest',request_digest) THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  IF receipt.result->>'kind' IS DISTINCT FROM 'nutrition_plan' OR NOT EXISTS(SELECT 1 FROM public.nutrition_plan_version v WHERE v.athlete_id=tenant AND v.plan_id=plan AND v.version_id=(receipt.result->>'versionId')::uuid AND v.approval_id=(receipt.result->>'approvalId')::uuid) THEN RAISE EXCEPTION 'NUTRITION_V4_RECEIPT_INVALID'; END IF;
  RETURN receipt.result;
 END IF;
 SELECT v.* INTO prior FROM public.nutrition_plan_head head JOIN public.nutrition_plan_version v ON v.athlete_id=head.athlete_id AND v.plan_id=head.plan_id AND v.version_id=head.version_id AND v.version=head.version WHERE head.athlete_id=tenant AND head.plan_id=plan FOR UPDATE OF head,v;
 IF NOT FOUND OR prior.version_id<>expected OR prior.version>=2147483646 OR octet_length(prior.record_json::text)>524288 THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 PERFORM public.assert_nutrition_disconnect_body(prior.record_json);
 PERFORM public.assert_nutrition_disconnect_body(saved);
 IF saved->>'schemaVersion' IS DISTINCT FROM '4' OR saved->>'planId' IS DISTINCT FROM plan::text OR saved->>'previousVersionId' IS DISTINCT FROM expected::text OR (saved->>'version')::int<>prior.version+1 OR (saved->>'versionId')::uuid=expected
  OR (saved-ARRAY['schemaVersion','planId','versionId','version','previousVersionId','approvalId','approvedAt','raceTimingPins','itemRaceTimingBindings','items']) IS DISTINCT FROM (command->'draft')-'items'
  OR (SELECT coalesce(jsonb_agg(i-'planVersionId' ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(saved->'items') WITH ORDINALITY x(i,n)) IS DISTINCT FROM command->'draft'->'items'
  OR (saved->>'approvedAt')::timestamptz>clock_timestamp() OR (saved->>'approvedAt')::timestamptz<statement_timestamp()-interval '30 seconds'
 THEN RAISE EXCEPTION 'NUTRITION_V4_SAVED_IDENTITY'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements_text(request->'reconnectItemIds'))<>(SELECT count(DISTINCT x) FROM jsonb_array_elements_text(request->'reconnectItemIds') x)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(request->'reconnectItemIds') x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(saved->'items') i WHERE i->>'id'=x AND i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race'))
  OR (SELECT coalesce(jsonb_agg(x ORDER BY public.nutrition_copy_utf16_key(x)),'[]'::jsonb) FROM jsonb_array_elements_text(request->'reconnectItemIds') x) IS DISTINCT FROM request->'reconnectItemIds'
 THEN RAISE EXCEPTION 'NUTRITION_V4_RECONNECT_MEMBERSHIP'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(request->'expectedRaceHeads'))<>(SELECT count(DISTINCT (x->>'eventId')::uuid) FROM jsonb_array_elements(request->'expectedRaceHeads') x)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(saved->'items') i WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(request->'expectedRaceHeads') h WHERE h->>'eventId'=i->'anchor'->>'entityId'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(request->'expectedRaceHeads') h WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(saved->'items') i WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND i->'anchor'->>'entityId'=h->>'eventId'))
 THEN RAISE EXCEPTION 'NUTRITION_V4_RACE_ROSTER'; END IF;
 FOR expected_head IN SELECT value FROM jsonb_array_elements(request->'expectedRaceHeads') LOOP
  SELECT * INTO race FROM public.race_event WHERE athlete_id=tenant AND id=(expected_head->>'eventId')::uuid AND NOT deleted;
  IF NOT FOUND OR race.revision<>(expected_head->>'revision')::int THEN RAISE EXCEPTION 'RACE_TIMING_STALE'; END IF;
 END LOOP;
 IF (saved->>'linkedTrainingPlanVersionId') IS NOT NULL THEN
  SELECT draft INTO linked FROM public.plan_snapshot WHERE athlete_id=tenant AND id=(saved->>'linkedTrainingPlanVersionId')::uuid;
  IF NOT FOUND OR octet_length(linked::text)+octet_length(prior.record_json::text)+octet_length(saved::text)>4194304 THEN RAISE EXCEPTION 'SESSION_LINK_INVALID'; END IF;
 END IF;
 INSERT INTO public.nutrition_v4_commit_seal VALUES(tenant,(saved->>'versionId')::uuid,plan,expected,session_user,txid_current(),app_revision,key,request_digest,encode(sha256(convert_to(saved::text,'UTF8')),'hex'),statement_timestamp()+interval '30 seconds');
 FOR item IN SELECT value FROM jsonb_array_elements(saved->'items') LOOP
  SELECT i INTO old_item FROM jsonb_array_elements(prior.record_json->'items') i WHERE i->>'id'=item->>'id';
  unchanged:=((old_item IS NOT NULL AND old_item-'planVersionId'=item-'planVersionId' AND prior.record_json->'period'=saved->'period' AND prior.record_json->'timezone'=saved->'timezone' AND prior.record_json->'linkedTrainingPlanVersionId'=saved->'linkedTrainingPlanVersionId') OR public.race_manual_nutrition_item_preserved_v1(tenant,plan,expected,item->>'id',item->'anchor',request)) AND NOT public.race_manual_nutrition_item_affected_v1(tenant,plan,expected,item->>'id',item->'anchor',request);
  reconnect:=request->'reconnectItemIds' @> jsonb_build_array(item->>'id');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(item->'foods') f WHERE f->>'foodVersionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.food_definition_version v WHERE v.athlete_id=tenant AND v.version_id=(f->>'foodVersionId')::uuid)) THEN RAISE EXCEPTION 'FOOD_VERSION_NOT_FOUND'; END IF;
  IF item->'anchor'->>'kind'='relative' AND item->'anchor'->>'entity'='session' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(linked->'sessions') s WHERE s->>'id'=item->'anchor'->>'entityId') THEN RAISE EXCEPTION 'SESSION_LINK_INVALID'; END IF;
  IF item->'anchor'->>'kind'='disconnected' OR old_item->'anchor'->>'kind'='disconnected' THEN
   SELECT * INTO ancestor FROM public.nutrition_v4_origin(tenant,plan,expected,item->>'id');
   IF NOT FOUND OR old_item->'anchor' IS DISTINCT FROM '{"kind":"disconnected","entity":"race"}'::jsonb THEN RAISE EXCEPTION 'NUTRITION_V4_ORIGIN_REQUIRED'; END IF;
   IF item->'anchor'->>'kind'='disconnected' AND reconnect THEN RAISE EXCEPTION 'NUTRITION_V4_RECONNECT_MEMBERSHIP'; END IF;
   IF item->'anchor'->>'kind'<>'disconnected' AND (NOT reconnect OR item->'anchor'->>'entity'<>'race' OR item->'anchor'->>'kind'<>'relative') THEN RAISE EXCEPTION 'NUTRITION_V4_RECONNECT_REQUIRED'; END IF;
   INSERT INTO public.nutrition_race_disconnection_lineage VALUES(tenant,plan,(saved->>'versionId')::uuid,prior.version+1,expected,prior.version,sha256(convert_to(item->>'id','UTF8')),item->>'id',ancestor.origin_version_id,ancestor.origin_event_id,CASE WHEN item->'anchor'->>'kind'='disconnected' THEN 'retained' ELSE 'reconnected' END,'postgres-row-jsonb-utc-v1',encode(sha256(convert_to(to_jsonb(prior)::text,'UTF8')),'hex'));
  ELSIF reconnect THEN RAISE EXCEPTION 'NUTRITION_V4_RECONNECT_MEMBERSHIP';
  ELSIF EXISTS(SELECT 1 FROM public.nutrition_race_disconnection_lineage l WHERE l.athlete_id=tenant AND l.version_id=expected AND l.item_key=sha256(convert_to(item->>'id','UTF8')) AND l.item_id=item->>'id') THEN
   INSERT INTO public.nutrition_race_disconnection_lineage SELECT tenant,plan,(saved->>'versionId')::uuid,prior.version+1,expected,prior.version,l.item_key,l.item_id,l.origin_version_id,l.origin_event_id,'carried','postgres-row-jsonb-utc-v1',encode(sha256(convert_to(to_jsonb(prior)::text,'UTF8')),'hex') FROM public.nutrition_race_disconnection_lineage l WHERE l.athlete_id=tenant AND l.version_id=expected AND l.item_key=sha256(convert_to(item->>'id','UTF8')) AND l.item_id=item->>'id';
  END IF;
  IF item->'anchor'->>'kind'='relative' AND item->'anchor'->>'entity'='race' THEN
   SELECT x INTO bind FROM jsonb_array_elements(saved->'itemRaceTimingBindings') x WHERE x->>'itemId'=item->>'id';
   SELECT x INTO old_bind FROM jsonb_array_elements(coalesce(prior.record_json->'itemRaceTimingBindings','[]')) x WHERE x->>'itemId'=item->>'id';
   IF unchanged AND NOT reconnect THEN
    IF old_bind IS NOT NULL THEN
     IF bind IS DISTINCT FROM old_bind THEN RAISE EXCEPTION 'NUTRITION_V4_UNTOUCHED_BINDING'; END IF;
     IF bind->'binding'->>'state'='captured' THEN
      SELECT x INTO pin FROM jsonb_array_elements(saved->'raceTimingPins') x WHERE x->>'eventId'=bind->'binding'->>'eventId' AND x->'eventRevision'=bind->'binding'->'eventRevision';
      SELECT x INTO old_pin FROM jsonb_array_elements(prior.record_json->'raceTimingPins') x WHERE x->>'eventId'=bind->'binding'->>'eventId' AND x->'eventRevision'=bind->'binding'->'eventRevision';
      IF pin IS DISTINCT FROM old_pin THEN RAISE EXCEPTION 'NUTRITION_V4_UNTOUCHED_PIN'; END IF;
     END IF;
    ELSE
     IF bind->'binding' IS DISTINCT FROM jsonb_build_object('state','legacy_unpinned','priorNutritionVersionId',expected,'priorItemId',item->>'id','priorAnchorDigest',encode(sha256(convert_to(public.nutrition_copy_canonical_json(jsonb_build_object('domain','nutrition-anchor-canonical-v1','anchor',old_item->'anchor')),'UTF8')),'hex')) THEN RAISE EXCEPTION 'NUTRITION_V4_LEGACY_PRIOR_REQUIRED'; END IF;
    END IF;
   ELSE
    IF bind->'binding'->>'state' IS DISTINCT FROM 'captured' THEN RAISE EXCEPTION 'NUTRITION_V4_CAPTURE_REQUIRED'; END IF;
    SELECT x INTO pin FROM jsonb_array_elements(saved->'raceTimingPins') x WHERE x->>'eventId'=bind->'binding'->>'eventId' AND x->'eventRevision'=bind->'binding'->'eventRevision';
    SELECT * INTO race FROM public.race_event WHERE athlete_id=tenant AND id=(pin->>'eventId')::uuid AND NOT deleted;
    SELECT * INTO rev FROM public.race_event_revision WHERE athlete_id=tenant AND entity_id=race.id AND revision=race.revision;
    source_instant:=public.nutrition_v4_local_instant((race.values_json->>'localDate')::date,(race.values_json->>'localStartTime')::time,race.values_json->>'timezone');
    IF race.id IS NULL OR rev.entity_id IS NULL OR race.revision<>(pin->>'eventRevision')::int OR rev.values_json IS DISTINCT FROM race.values_json
     OR pin->>'localDate' IS DISTINCT FROM race.values_json->>'localDate' OR pin->>'localStartTime' IS DISTINCT FROM race.values_json->>'localStartTime' OR pin->>'timezone' IS DISTINCT FROM race.values_json->>'timezone'
     OR pin->>'sourceDigest' IS DISTINCT FROM encode(sha256(convert_to(public.nutrition_copy_canonical_json(jsonb_build_object('domain','race-event-values-canonical-v1','namespace','race-event-revision','eventId',race.id,'eventRevision',race.revision,'values',race.values_json)),'UTF8')),'hex')
     OR source_instant IS NULL OR pin->'start'->>'state' IS DISTINCT FROM 'known' OR (pin->'start'->>'instant')::timestamptz IS DISTINCT FROM source_instant
     OR pin->'end' IS DISTINCT FROM '{"state":"unknown","reason":"race_end_not_recorded"}'::jsonb OR item->'anchor'->>'point'<>'start'
    THEN RAISE EXCEPTION 'NUTRITION_V4_SOURCE_CAPTURE_INVALID'; END IF;
   END IF;
  END IF;
 END LOOP;
 INSERT INTO public.nutrition_plan_version VALUES(tenant,plan,(saved->>'versionId')::uuid,prior.version+1,expected,prior.version,(saved->'period'->>'from')::date,(saved->'period'->>'toInclusive')::date,(saved->>'linkedTrainingPlanVersionId')::uuid,(saved->>'approvalId')::uuid,(saved->>'approvedAt')::timestamptz,saved);
 UPDATE public.nutrition_plan_head SET version=prior.version+1,version_id=(saved->>'versionId')::uuid WHERE athlete_id=tenant AND plan_id=$1 AND version_id=expected;
 INSERT INTO public.nutrition_plan_history VALUES(tenant,plan,(saved->>'versionId')::uuid,(saved->>'approvalId')::uuid,'user_approved',(saved->>'approvedAt')::timestamptz);
 result:=jsonb_build_object('receiptVersion',3,'outcome','committed','kind','nutrition_plan','planId',plan,'versionId',saved->'versionId','version',prior.version+1,'approvalId',saved->'approvalId');
 INSERT INTO public.command_receipt VALUES(tenant,key,jsonb_build_object('receiptVersion',3,'digestVersion','postgres-jsonb-sha256-v1','requestDigest',request_digest),result);
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload) VALUES(tenant,gen_random_uuid(),key,'nutrition.plan_changed',jsonb_build_object('planId',plan,'versionId',saved->'versionId','approvalId',saved->'approvalId'));
 RETURN result;
END $$;
-- Independent civil-date transformation, preserving every non-date field and
-- semantic array order. This is not permission; owned source validation is separate.
CREATE FUNCTION public.race_manual_calendar_draft_v1(context jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE original jsonb:=context->'currentTraining'->'snapshot'->'draft'; intent jsonb:=context->'calendarIntent'; selection jsonb; period jsonb; session jsonb; shifted jsonb;
 moving text[]; subtree text[]; delta integer; periods jsonb:='[]'; sessions jsonb:='[]'; date date; start date; ending date; block jsonb; parent jsonb;
BEGIN
 IF original IS NULL THEN RETURN 'null'; END IF;
 selection:=intent->'selection';
 IF selection->>'kind'='keep_plan' THEN RETURN original; END IF;
 IF selection->>'kind'<>'move_period' OR selection->'expectedCurrentPlanVersionId' IS DISTINCT FROM context->'currentTraining'->'snapshot'->'id' THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_CALENDAR'; END IF;
 SELECT value INTO period FROM jsonb_array_elements(original->'periods') p WHERE p->'id'=selection->'periodId';
 IF period IS NULL THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_CALENDAR'; END IF;
 delta:=(selection->>'newStartDate')::date-(period->>'startDate')::date;
 IF abs(delta)>3660 THEN RAISE EXCEPTION 'RACE_MANUAL_CALENDAR_BOUND'; END IF;
 WITH RECURSIVE descendants(id) AS (
  SELECT period->>'id' UNION ALL SELECT p->>'id' FROM jsonb_array_elements(original->'periods') p JOIN descendants d ON p->>'parentId'=d.id
 ) SELECT array_agg(id) INTO subtree FROM descendants;
 moving:=CASE WHEN selection->>'scope'='descendants_and_sessions' THEN subtree ELSE ARRAY[period->>'id'] END;
 FOR period IN SELECT value FROM jsonb_array_elements(original->'periods') LOOP
  shifted:=period;
  IF period->>'id'=ANY(moving) THEN
   start:=(period->>'startDate')::date+delta; ending:=(period->>'endDateExclusive')::date+delta;
   IF start<DATE '0001-01-01' OR ending>DATE '9999-12-31' THEN RAISE EXCEPTION 'RACE_MANUAL_CALENDAR_BOUND'; END IF;
   shifted:=period||jsonb_build_object('startDate',to_char(start,'YYYY-MM-DD'),'endDateExclusive',to_char(ending,'YYYY-MM-DD'));
   IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(period->'constraints'->'unavailableDates','[]')) d WHERE d::date<start OR d::date>=ending)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(period->'constraints'->'dailyTimeLimits','[]')) d WHERE (d->>'date')::date<start OR (d->>'date')::date>=ending) THEN RAISE EXCEPTION 'RACE_MANUAL_CONSTRAINT_OUTSIDE_PERIOD'; END IF;
  END IF;
  periods:=periods||jsonb_build_array(shifted);
 END LOOP;
 FOR session IN SELECT value FROM jsonb_array_elements(original->'sessions') LOOP
  shifted:=session;
  IF session->>'blockId'=ANY(subtree) AND selection->>'scope'='descendants_and_sessions' AND session->'locks'->'date'='false'::jsonb
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(context->'completions') c WHERE c->>'status'='completed' AND c->'sessionId'=session->'id') THEN
   date:=(session->>'date')::date+delta;
   IF date<DATE '0001-01-01' OR date>DATE '9999-12-31' THEN RAISE EXCEPTION 'RACE_MANUAL_CALENDAR_BOUND'; END IF;
   shifted:=session||jsonb_build_object('date',to_char(date,'YYYY-MM-DD'));
  END IF;
  sessions:=sessions||jsonb_build_array(shifted);
 END LOOP;
 FOR period IN SELECT value FROM jsonb_array_elements(periods) LOOP
  SELECT value INTO parent FROM jsonb_array_elements(periods) p WHERE p->'id'=period->'parentId';
  IF parent IS NOT NULL AND ((period->>'startDate')::date<(parent->>'startDate')::date OR (period->>'endDateExclusive')::date>(parent->>'endDateExclusive')::date) THEN RAISE EXCEPTION 'RACE_MANUAL_OUTSIDE_PARENT'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(periods) p WHERE p->'id'<>period->'id' AND p->'parentId'=period->'parentId' AND (p->>'startDate')::date<(period->>'endDateExclusive')::date AND (period->>'startDate')::date<(p->>'endDateExclusive')::date) THEN RAISE EXCEPTION 'RACE_MANUAL_SIBLING_OVERLAP'; END IF;
 END LOOP;
 FOR session IN SELECT value FROM jsonb_array_elements(sessions) LOOP
  SELECT value INTO block FROM jsonb_array_elements(periods) p WHERE p->'id'=session->'blockId';
  IF block IS NULL OR (session->>'date')::date<(block->>'startDate')::date OR (session->>'date')::date>=(block->>'endDateExclusive')::date THEN RAISE EXCEPTION 'RACE_MANUAL_FIXED_SESSION_OUTSIDE_BLOCK'; END IF;
 END LOOP;
 RETURN original||jsonb_build_object('periods',periods,'sessions',sessions);
END $$;
REVOKE ALL ON FUNCTION public.race_manual_calendar_draft_v1(jsonb) FROM PUBLIC;
CREATE TABLE public.race_manual_application_history_v1 (
 athlete_id text NOT NULL,approval_id uuid NOT NULL,candidate_id uuid NOT NULL,
 domain text NOT NULL CHECK(domain IN ('training','nutrition','recovery','routine_schedule')),
 aggregate_id uuid NOT NULL,version_id uuid NOT NULL,approved_at timestamptz NOT NULL,
 PRIMARY KEY(athlete_id,approval_id,domain,aggregate_id),
 FOREIGN KEY(athlete_id,candidate_id) REFERENCES public.race_manual_application_candidate_v1(athlete_id,id) DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON public.race_manual_application_history_v1 FROM PUBLIC;
ALTER TABLE public.race_manual_application_history_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.race_manual_application_history_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.race_manual_application_history_v1 USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
CREATE TRIGGER race_manual_history_guard BEFORE INSERT OR UPDATE OR DELETE ON public.race_manual_application_history_v1 FOR EACH ROW EXECUTE FUNCTION public.guard_race_manual_application_v1();
CREATE TRIGGER race_manual_history_truncate BEFORE TRUNCATE ON public.race_manual_application_history_v1 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE FUNCTION public.verify_race_manual_application_final_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=NEW.athlete_id; c public.race_manual_application_candidate_v1; receipt public.race_manual_application_receipt_v1; after_counts jsonb; w jsonb; v jsonb; domain text; count bigint; actual jsonb; expected jsonb; ref jsonb; refs jsonb; linked text; r public.race_event;
BEGIN
 PERFORM public.race_manual_application_owner_v1();
 IF NEW.owner_xid<>txid_current() OR NEW.creator_role<>session_user OR EXISTS(SELECT 1 FROM public.race_manual_application_context_v1 x WHERE x.athlete_id=t AND x.id=NEW.id)
  OR EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=t) THEN RAISE EXCEPTION 'RACE_MANUAL_ATOMIC_REQUIRED'; END IF;
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 WHERE athlete_id=t AND id=NEW.candidate_id;
 SELECT * INTO receipt FROM public.race_manual_application_receipt_v1 WHERE athlete_id=t AND candidate_id=c.id AND receipt_key=NEW.request_key;
 IF c.candidate_json IS NULL OR receipt.candidate_id IS NULL OR receipt.request_digest<>NEW.request_digest OR NOT public.nutrition_copy_structural_codec(receipt.result,public.race_manual_application_wire_v1('result')) OR receipt.result->>'status'<>'committed'
  OR receipt.result->>'candidateId'<>c.id::text OR receipt.result->>'proposalId'<>c.proposal_id::text THEN RAISE EXCEPTION 'RACE_MANUAL_ATOMIC_REQUIRED'; END IF;
 PERFORM public.require_app_admission_revision((c.basis_json->'manualBasis'->'app'->>'revision')::integer);
 IF c.basis_json->>'restoreGeneration'<>public.current_restore_generation()::text OR NOT EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=t AND e.id=c.evidence_id AND e.payload IS NOT NULL) THEN RAISE EXCEPTION 'RACE_MANUAL_SOURCE_CHANGED'; END IF;
 after_counts:=public.race_manual_versions_v1(t);
 -- These are append-only mutation counts, NOT semantic source freshness. Exact
 -- source/Activity rosters were separately validated before any write.
 FOREACH domain IN ARRAY ARRAY['training','nutrition','recovery','routine_schedule'] LOOP
  SELECT count(*) INTO count FROM jsonb_array_elements(c.candidate_json->'writes') AS write_rows(value) WHERE write_rows.value->>'domain'=domain;
  IF (after_counts->>domain)::bigint-(NEW.prior_versions->>domain)::bigint<>count THEN RAISE EXCEPTION 'RACE_MANUAL_EXTRA_OR_MISSING_WRITE'; END IF;
 END LOOP;
 IF jsonb_array_length(receipt.result->'versions')<>jsonb_array_length(c.candidate_json->'writes') THEN RAISE EXCEPTION 'RACE_MANUAL_INCOMPLETE_SCOPE'; END IF;
 FOR w IN SELECT value FROM jsonb_array_elements(c.candidate_json->'writes') LOOP
  SELECT value INTO v FROM jsonb_array_elements(receipt.result->'versions') x WHERE x->'domain'=w->'domain' AND x->'aggregateId'=w->'aggregateId';
  IF v IS NULL OR NOT EXISTS(SELECT 1 FROM public.race_manual_application_history_v1 h WHERE h.athlete_id=t AND h.candidate_id=c.id AND h.approval_id=(receipt.result->>'approvalId')::uuid AND h.domain=w->>'domain' AND h.aggregate_id=(w->>'aggregateId')::uuid AND h.version_id=(v->>'versionId')::uuid AND h.approved_at=(receipt.result->>'approvedAt')::timestamptz) THEN RAISE EXCEPTION 'RACE_MANUAL_HISTORY_REQUIRED'; END IF;
  IF w->>'domain'='training' THEN
   SELECT s.draft INTO actual FROM public.plan_head h JOIN public.plan_snapshot s ON s.athlete_id=h.athlete_id AND s.id=h.version_id JOIN public.plan_snapshot_aggregate a ON a.athlete_id=s.athlete_id AND a.version_id=s.id WHERE h.athlete_id=t AND h.aggregate_id=(w->>'aggregateId')::uuid AND a.aggregate_id=h.aggregate_id AND s.id=(v->>'versionId')::uuid AND s.version=(w->'expectedHead'->>'version')::integer+1 AND s.version=(v->>'version')::integer;
   IF actual IS DISTINCT FROM w->'proposed' OR NOT EXISTS(SELECT 1 FROM public.plan_history h WHERE h.athlete_id=t AND h.version_id=(v->>'versionId')::uuid AND h.action='candidate_approved') THEN RAISE EXCEPTION 'RACE_MANUAL_TRAINING_REQUIRED'; END IF;
  ELSIF w->>'domain'='nutrition' THEN
   expected:=w->'intent'->'intent'->'command'->'draft'; linked:=expected->>'linkedTrainingPlanVersionId';
   IF linked IS NOT NULL THEN SELECT x->>'versionId' INTO linked FROM jsonb_array_elements(receipt.result->'versions') x JOIN jsonb_array_elements(c.candidate_json->'writes') y ON x->'domain'=y->'domain' AND x->'aggregateId'=y->'aggregateId' WHERE x->>'domain'='training' AND y->'expectedHead'->>'versionId'=expected->>'linkedTrainingPlanVersionId'; END IF;
   IF linked IS NOT NULL THEN expected:=expected||jsonb_build_object('linkedTrainingPlanVersionId',linked); END IF;
   SELECT n.record_json INTO actual FROM public.nutrition_plan_head h JOIN public.nutrition_plan_version n ON n.athlete_id=h.athlete_id AND n.plan_id=h.plan_id AND n.version_id=h.version_id AND n.version=h.version WHERE h.athlete_id=t AND h.plan_id=(w->>'aggregateId')::uuid AND n.version_id=(v->>'versionId')::uuid AND n.previous_version_id=(w->'expectedHead'->>'versionId')::uuid AND n.version=(w->'expectedHead'->>'version')::integer+1 AND n.version=(v->>'version')::integer;
   IF actual IS NULL OR (actual-ARRAY['schemaVersion','planId','versionId','version','previousVersionId','approvalId','approvedAt','items','raceTimingPins','itemRaceTimingBindings']) IS DISTINCT FROM (expected-'items') THEN RAISE EXCEPTION 'RACE_MANUAL_NUTRITION_REQUIRED'; END IF;
   SELECT coalesce(jsonb_agg(i-'planVersionId' ORDER BY ord),'[]') INTO actual FROM jsonb_array_elements(actual->'items') WITH ORDINALITY a(i,ord);
   IF actual IS DISTINCT FROM expected->'items' THEN RAISE EXCEPTION 'RACE_MANUAL_NUTRITION_REQUIRED'; END IF;
  ELSIF w->>'domain'='recovery' THEN
   refs:='[]';
   FOR ref IN SELECT value FROM jsonb_array_elements(w->'proposed'->'planRefs') LOOP
    SELECT x->>'versionId' INTO linked FROM jsonb_array_elements(receipt.result->'versions') x JOIN jsonb_array_elements(c.candidate_json->'writes') y ON x->'domain'=y->'domain' AND x->'aggregateId'=y->'aggregateId' WHERE x->'domain'=ref->'kind' AND x->'aggregateId'=ref->'aggregateId' AND y->'expectedHead'->'versionId'=ref->'headVersionId';
    refs:=refs||jsonb_build_array(CASE WHEN linked IS NULL THEN ref ELSE ref||jsonb_build_object('headVersionId',linked) END);
   END LOOP;
   expected:=w->'proposed'||jsonb_build_object('planRefs',refs);
   SELECT s.record_json INTO actual FROM public.recovery_strategy_head h JOIN public.recovery_strategy_version s ON s.athlete_id=h.athlete_id AND s.strategy_id=h.strategy_id AND s.version_id=h.version_id AND s.version=h.version WHERE h.athlete_id=t AND h.strategy_id=(w->>'aggregateId')::uuid AND s.version_id=(v->>'versionId')::uuid AND s.previous_version_id=(w->'expectedHead'->>'versionId')::uuid AND s.version=(w->'expectedHead'->>'version')::integer+1 AND s.version=(v->>'version')::integer;
   IF actual->'draft' IS DISTINCT FROM expected OR actual->'selectedOptionId' IS DISTINCT FROM w->'selectedOptionId' OR actual->>'status'<>'user_confirmed' THEN RAISE EXCEPTION 'RACE_MANUAL_RECOVERY_REQUIRED'; END IF;
  ELSIF w->>'domain'='routine_schedule' THEN
   SELECT s.record_json INTO actual FROM public.routine_schedule_head h JOIN public.routine_schedule_version s ON s.athlete_id=h.athlete_id AND s.schedule_id=h.schedule_id AND s.version_id=h.version_id WHERE h.athlete_id=t AND h.schedule_id=(w->>'aggregateId')::uuid AND s.version_id=(v->>'versionId')::uuid AND s.prior_version_id=(w->'expectedHead'->>'versionId')::uuid;
   IF actual IS DISTINCT FROM w->'proposed' THEN RAISE EXCEPTION 'RACE_MANUAL_ROUTINE_REQUIRED'; END IF;
   SELECT coalesce(jsonb_agg(o.record_json ORDER BY o.record_json->>'anchorKey'),'[]') INTO actual FROM public.routine_occurrence o WHERE o.athlete_id=t AND o.schedule_version_id=(v->>'versionId')::uuid;
   SELECT coalesce(jsonb_agg(o ORDER BY o->>'anchorKey'),'[]') INTO expected FROM jsonb_array_elements(w->'occurrences') o;
   IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RACE_MANUAL_OCCURRENCE_REQUIRED'; END IF;
  END IF;
 END LOOP;
 SELECT * INTO r FROM public.race_event WHERE athlete_id=t AND id=(NEW.expected_event->>'id')::uuid AND NOT deleted;
 expected:=(NEW.expected_event-ARRAY['id','revision'])||jsonb_build_object('localDate',c.candidate_json->'raceChange'->'newLocalDate');
 IF NEW.expected_event->'planVersionId'=c.basis_json->'currentTraining'->'snapshot'->'id' THEN
  SELECT x->>'versionId' INTO linked FROM jsonb_array_elements(receipt.result->'versions') x WHERE x->>'domain'='training';
  IF linked IS NOT NULL THEN expected:=expected||jsonb_build_object('planVersionId',linked); END IF;
 END IF;
 IF r.id IS NULL OR r.revision<>(NEW.expected_event->>'revision')::integer+1 OR r.values_json IS DISTINCT FROM expected OR receipt.result->'race' IS DISTINCT FROM jsonb_build_object('eventId',r.id,'revision',r.revision)
  OR NOT EXISTS(SELECT 1 FROM public.race_event_revision h WHERE h.athlete_id=t AND h.entity_id=r.id AND h.revision=r.revision AND h.values_json=r.values_json)
  OR NOT EXISTS(SELECT 1 FROM public.outbox o WHERE o.athlete_id=t AND o.idempotency_key='race-manual-approval:'||c.id::text AND o.topic='race.manual_plan_approved' AND o.payload=receipt.result)
 THEN RAISE EXCEPTION 'RACE_MANUAL_ATOMIC_REQUIRED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_race_manual_application_final_v1() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER race_manual_application_final AFTER INSERT ON public.race_manual_application_context_v1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_race_manual_application_final_v1();
CREATE FUNCTION public.commit_race_manual_application_v1(context uuid,committed_result jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); x public.race_manual_application_context_v1; c public.race_manual_application_candidate_v1; v jsonb;
BEGIN
 PERFORM public.race_manual_application_owner_v1();
 SELECT * INTO x FROM public.race_manual_application_context_v1 WHERE athlete_id=t AND id=$1 AND owner_xid=txid_current() AND creator_role=session_user AND result IS NULL;
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 WHERE athlete_id=t AND id=x.candidate_id;
 IF x.id IS NULL OR c.candidate_json IS NULL OR NOT public.nutrition_copy_structural_codec($2,public.race_manual_application_wire_v1('result')) OR $2->>'status'<>'committed' OR $2->>'candidateId'<>c.id::text OR $2->>'proposalId'<>c.proposal_id::text THEN RAISE EXCEPTION 'RACE_MANUAL_CONTEXT_REQUIRED'; END IF;
 PERFORM public.require_app_admission_revision((c.basis_json->'manualBasis'->'app'->>'revision')::integer);
 FOR v IN SELECT value FROM jsonb_array_elements($2->'versions') LOOP
  INSERT INTO public.race_manual_application_history_v1 VALUES(t,($2->>'approvalId')::uuid,c.id,v->>'domain',(v->>'aggregateId')::uuid,(v->>'versionId')::uuid,($2->>'approvedAt')::timestamptz);
 END LOOP;
 INSERT INTO public.race_manual_application_receipt_v1 VALUES(t,x.request_key,x.request_digest,c.id,sha256(convert_to((jsonb_build_object('schemaVersion',1,'confirmed',true,'candidateId',c.id,'applicationDigest',c.application_digest,'chain',c.candidate_json->'chain','raceChange',c.candidate_json->'raceChange','expectation',c.candidate_json->'expectation'))::text,'UTF8')),$2);
 UPDATE public.race_manual_application_context_v1 SET result=$2 WHERE athlete_id=t AND id=x.id;
 DELETE FROM public.race_manual_application_context_v1 WHERE athlete_id=t AND id=x.id;
 RETURN $2;
END $$;
REVOKE ALL ON FUNCTION public.commit_race_manual_application_v1(uuid,jsonb) FROM PUBLIC;

-- Erasure removes the whole application family in the same established erasure
-- transaction. Deferred parent FKs cannot turn retained candidate bodies into a
-- substitute for a purged EvidenceSnapshot. No permission or receipt is minted.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_manual_application_v1;
REVOKE ALL ON FUNCTION public.erase_account_before_manual_application_v1(text) FROM PUBLIC;
DO $$ DECLARE role text; BEGIN
 FOR role IN SELECT DISTINCT grantee FROM information_schema.routine_privileges WHERE routine_schema='public' AND routine_name='erase_account_before_manual_application_v1' AND grantee NOT IN (current_user,'PUBLIC') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_manual_application_v1(text) FROM %I',role);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(athlete text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE stamp timestamptz; BEGIN
 stamp:=public.erase_account_before_manual_application_v1($1);
 DELETE FROM public.race_manual_application_context_v1 WHERE athlete_id=$1;
 DELETE FROM public.race_manual_application_history_v1 WHERE athlete_id=$1;
 DELETE FROM public.race_manual_application_receipt_v1 WHERE athlete_id=$1;
 DELETE FROM public.race_manual_application_candidate_v1 WHERE athlete_id=$1;
 RETURN stamp;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
