-- Additive unregistered staging protocol. Read-only facts, never a purpose seal.
-- JSONB flat identities make accepted input depth exactly two; nested values fail.
-- UTC jsonb full-row bytes are a distinct namespace from canonical public DTOs.
CREATE FUNCTION public.observe_manual_review_owned_source_bindings_v2(refs jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD'
AS $function$
DECLARE
 tenant text:=nullif(current_setting('app.athlete_id',true),'');
 normalized jsonb; facts jsonb; normalized_refs jsonb[]:='{}'; fact_refs jsonb[]:='{}'; fact jsonb; fact_bytes bigint:=0; i jsonb; k text; keys text[];
 n bigint; maximum bigint; row_bytes bigint; total bigint:=0; row_digest text; relation_name text;
 expected_keys text[]; number_key text; number_max numeric; uuid_key text;
 edge_whitespace constant text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
 uuid_pattern constant text:='^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
 position_index integer:=0; result jsonb;
BEGIN
 IF tenant IS NULL THEN RAISE EXCEPTION 'MANUAL_BINDING_TENANT_REQUIRED'; END IF;
 IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
  RAISE EXCEPTION 'MANUAL_BINDING_SNAPSHOT_REQUIRED'; END IF;
 IF refs IS NULL OR jsonb_typeof(refs)<>'array' THEN RAISE EXCEPTION 'MANUAL_BINDING_INVALID_REFS'; END IF;
 IF jsonb_array_length(refs) NOT BETWEEN 1 AND 5000 OR octet_length(refs::text)>4194304 THEN
  RAISE EXCEPTION 'MANUAL_BINDING_INPUT_BOUND'; END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(refs) LOOP
  IF jsonb_typeof(i)<>'object' THEN RAISE EXCEPTION 'MANUAL_BINDING_INVALID_REF'; END IF;
  k:=i->>'kind'; number_key:=NULL; number_max:=NULL;
  CASE k
   WHEN 'race-event' THEN expected_keys:=ARRAY['kind','revision','sourceId']; number_key:='revision'; number_max:=2147483647;
   WHEN 'plan-snapshot' THEN expected_keys:=ARRAY['kind','sourceId','version']; number_key:='version'; number_max:=2147483647;
   WHEN 'nutrition-plan-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'routine-schedule-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'routine-blueprint-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'routine-occurrence' THEN expected_keys:=ARRAY['kind','sourceId'];
   WHEN 'routine-run' THEN expected_keys:=ARRAY['kind','revision','sourceId']; number_key:='revision'; number_max:=9007199254740991;
   WHEN 'session-completion' THEN expected_keys:=ARRAY['kind','planVersionId','revision','sourceId']; number_key:='revision'; number_max:=2147483646;
   ELSE RAISE EXCEPTION 'MANUAL_BINDING_UNKNOWN_KIND';
  END CASE;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(i) key;
  IF keys IS DISTINCT FROM expected_keys OR jsonb_typeof(i->'kind')<>'string' THEN RAISE EXCEPTION 'MANUAL_BINDING_INVALID_KEYS'; END IF;
  FOREACH uuid_key IN ARRAY expected_keys LOOP
   IF uuid_key IN ('kind','revision','version') THEN CONTINUE; END IF;
   IF jsonb_typeof(i->uuid_key)<>'string' OR length(i->>uuid_key)=0 OR (i->>uuid_key) ~ ('^['||edge_whitespace||']|['||edge_whitespace||']$') THEN RAISE EXCEPTION 'MANUAL_BINDING_INVALID_ID'; END IF;
   IF (k IN ('race-event','nutrition-plan-version') AND uuid_key IN ('sourceId','versionId')) OR uuid_key='planVersionId' THEN
    IF lower(i->>uuid_key)!~uuid_pattern THEN RAISE EXCEPTION 'MANUAL_BINDING_INVALID_UUID'; END IF;
    i:=jsonb_set(i,ARRAY[uuid_key],to_jsonb(lower(i->>uuid_key)));
   END IF;
  END LOOP;
  IF k IN ('plan-snapshot','session-completion') AND (SELECT coalesce(sum(CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END),0) FROM regexp_split_to_table(i->>'sourceId','') c)>200 THEN RAISE EXCEPTION 'MANUAL_BINDING_INVALID_ID'; END IF;
  IF number_key IS NOT NULL THEN
   IF jsonb_typeof(i->number_key)<>'number' THEN RAISE EXCEPTION 'MANUAL_BINDING_INVALID_REVISION'; END IF;
   IF (i->>number_key)::numeric<>trunc((i->>number_key)::numeric)
    OR (i->>number_key)::numeric>number_max OR (i->>number_key)::numeric < (CASE WHEN k IN ('plan-snapshot','session-completion') THEN 1 ELSE 0 END) THEN
     RAISE EXCEPTION 'MANUAL_BINDING_INVALID_REVISION'; END IF;
  END IF;
  normalized_refs:=array_append(normalized_refs,i);
 END LOOP;
 normalized:=to_jsonb(normalized_refs);
 IF (SELECT count(*) FROM jsonb_array_elements(normalized) e WHERE e->>'kind'='race-event')<>1 THEN RAISE EXCEPTION 'MANUAL_BINDING_RACE_ROSTER'; END IF;
 IF (SELECT count(DISTINCT e) FROM jsonb_array_elements(normalized) e)<>jsonb_array_length(normalized) THEN RAISE EXCEPTION 'MANUAL_BINDING_DUPLICATE'; END IF;
 -- First pass bounds all selected full-row encoding work before any hashing.
 FOREACH i IN ARRAY normalized_refs LOOP
  CASE i->>'kind'
   WHEN 'race-event' THEN SELECT count(*),coalesce(sum(octet_length(to_jsonb(r)::text)),0),coalesce(max(octet_length(to_jsonb(r)::text)),0) INTO n,row_bytes,maximum FROM public.race_event r WHERE r.athlete_id=tenant AND r.id::text=i->>'sourceId' AND r.id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.revision::numeric=(i->>'revision')::numeric AND NOT r.deleted;
   WHEN 'plan-snapshot' THEN SELECT count(*),coalesce(sum(octet_length(to_jsonb(r)::text)),0),coalesce(max(octet_length(to_jsonb(r)::text)),0) INTO n,row_bytes,maximum FROM public.plan_snapshot r WHERE r.athlete_id=tenant AND r.id::text=i->>'sourceId' AND r.id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.version::numeric=(i->>'version')::numeric;
   WHEN 'nutrition-plan-version' THEN SELECT count(*),coalesce(sum(octet_length(to_jsonb(r)::text)),0),coalesce(max(octet_length(to_jsonb(r)::text)),0) INTO n,row_bytes,maximum FROM public.nutrition_plan_version r WHERE r.athlete_id=tenant AND r.plan_id::text=i->>'sourceId' AND r.plan_id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.version_id::text=i->>'versionId' AND r.version_id=CASE WHEN i->>'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'versionId')::uuid ELSE NULL END;
   WHEN 'routine-schedule-version' THEN SELECT count(*),coalesce(sum(octet_length(to_jsonb(r)::text)),0),coalesce(max(octet_length(to_jsonb(r)::text)),0) INTO n,row_bytes,maximum FROM public.routine_schedule_version r WHERE r.athlete_id=tenant AND r.schedule_id::text=i->>'sourceId' AND r.schedule_id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.version_id::text=i->>'versionId' AND r.version_id=CASE WHEN i->>'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'versionId')::uuid ELSE NULL END;
   WHEN 'routine-blueprint-version' THEN SELECT count(*),coalesce(sum(octet_length(to_jsonb(r)::text)),0),coalesce(max(octet_length(to_jsonb(r)::text)),0) INTO n,row_bytes,maximum FROM public.routine_blueprint_version r WHERE r.athlete_id=tenant AND r.routine_id::text=i->>'sourceId' AND r.routine_id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.version_id::text=i->>'versionId' AND r.version_id=CASE WHEN i->>'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'versionId')::uuid ELSE NULL END;
   WHEN 'routine-occurrence' THEN SELECT count(*),coalesce(sum(octet_length(to_jsonb(r)::text)),0),coalesce(max(octet_length(to_jsonb(r)::text)),0) INTO n,row_bytes,maximum FROM public.routine_occurrence r WHERE r.athlete_id=tenant AND r.id::text=i->>'sourceId' AND r.id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END;
   WHEN 'routine-run' THEN SELECT count(*),coalesce(sum(octet_length(to_jsonb(r)::text)),0),coalesce(max(octet_length(to_jsonb(r)::text)),0) INTO n,row_bytes,maximum FROM public.routine_run_revision r WHERE r.athlete_id=tenant AND r.run_id::text=i->>'sourceId' AND r.run_id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.revision::numeric=(i->>'revision')::numeric AND EXISTS(SELECT 1 FROM public.routine_run p WHERE p.athlete_id=r.athlete_id AND p.id=r.run_id);
   WHEN 'session-completion' THEN SELECT count(*),coalesce(sum(octet_length(to_jsonb(r)::text)),0),coalesce(max(octet_length(to_jsonb(r)::text)),0) INTO n,row_bytes,maximum FROM public.session_completion_revision r WHERE r.athlete_id=tenant AND r.session_id=i->>'sourceId' AND r.revision::numeric=(i->>'revision')::numeric AND r.record_json->>'planVersionId'=i->>'planVersionId' AND EXISTS(SELECT 1 FROM public.session_completion p WHERE p.athlete_id=r.athlete_id AND p.session_id=r.session_id) AND EXISTS(SELECT 1 FROM public.plan_snapshot p WHERE p.athlete_id=r.athlete_id AND p.id=(i->>'planVersionId')::uuid AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.draft->'sessions')='array' THEN p.draft->'sessions' ELSE '[]'::jsonb END) s WHERE s->>'id'=r.session_id AND s->>'blockId'=r.record_json->'schedule'->>'blockId' AND s->>'date'=r.record_json->'schedule'->>'date' AND s->'localStartTime'=r.record_json->'schedule'->'localStartTime') AND p.draft->>'timezone'=r.record_json->'schedule'->>'timezone');
  END CASE;
  IF n>1 THEN RAISE EXCEPTION 'MANUAL_BINDING_AMBIGUOUS_SOURCE'; END IF;
  total:=total+row_bytes;
  IF maximum>4194304 OR total>4194304 THEN RAISE EXCEPTION 'MANUAL_BINDING_SOURCE_BOUND'; END IF;
 END LOOP;
 FOREACH i IN ARRAY normalized_refs LOOP
  row_digest:=NULL; position_index:=position_index+1;
  CASE i->>'kind'
   WHEN 'race-event' THEN relation_name:='race_event'; SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') INTO row_digest FROM public.race_event r WHERE r.athlete_id=tenant AND r.id::text=i->>'sourceId' AND r.id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.revision::numeric=(i->>'revision')::numeric AND NOT r.deleted;
   WHEN 'plan-snapshot' THEN relation_name:='plan_snapshot'; SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') INTO row_digest FROM public.plan_snapshot r WHERE r.athlete_id=tenant AND r.id::text=i->>'sourceId' AND r.id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.version::numeric=(i->>'version')::numeric;
   WHEN 'nutrition-plan-version' THEN relation_name:='nutrition_plan_version'; SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') INTO row_digest FROM public.nutrition_plan_version r WHERE r.athlete_id=tenant AND r.plan_id::text=i->>'sourceId' AND r.plan_id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.version_id::text=i->>'versionId' AND r.version_id=CASE WHEN i->>'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'versionId')::uuid ELSE NULL END;
   WHEN 'routine-schedule-version' THEN relation_name:='routine_schedule_version'; SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') INTO row_digest FROM public.routine_schedule_version r WHERE r.athlete_id=tenant AND r.schedule_id::text=i->>'sourceId' AND r.schedule_id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.version_id::text=i->>'versionId' AND r.version_id=CASE WHEN i->>'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'versionId')::uuid ELSE NULL END;
   WHEN 'routine-blueprint-version' THEN relation_name:='routine_blueprint_version'; SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') INTO row_digest FROM public.routine_blueprint_version r WHERE r.athlete_id=tenant AND r.routine_id::text=i->>'sourceId' AND r.routine_id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.version_id::text=i->>'versionId' AND r.version_id=CASE WHEN i->>'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'versionId')::uuid ELSE NULL END;
   WHEN 'routine-occurrence' THEN relation_name:='routine_occurrence'; SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') INTO row_digest FROM public.routine_occurrence r WHERE r.athlete_id=tenant AND r.id::text=i->>'sourceId' AND r.id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END;
   WHEN 'routine-run' THEN relation_name:='routine_run_revision'; SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') INTO row_digest FROM public.routine_run_revision r WHERE r.athlete_id=tenant AND r.run_id::text=i->>'sourceId' AND r.run_id=CASE WHEN i->>'sourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (i->>'sourceId')::uuid ELSE NULL END AND r.revision::numeric=(i->>'revision')::numeric AND EXISTS(SELECT 1 FROM public.routine_run p WHERE p.athlete_id=r.athlete_id AND p.id=r.run_id);
   WHEN 'session-completion' THEN relation_name:='session_completion_revision'; SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') INTO row_digest FROM public.session_completion_revision r WHERE r.athlete_id=tenant AND r.session_id=i->>'sourceId' AND r.revision::numeric=(i->>'revision')::numeric AND r.record_json->>'planVersionId'=i->>'planVersionId' AND EXISTS(SELECT 1 FROM public.session_completion p WHERE p.athlete_id=r.athlete_id AND p.session_id=r.session_id) AND EXISTS(SELECT 1 FROM public.plan_snapshot p WHERE p.athlete_id=r.athlete_id AND p.id=(i->>'planVersionId')::uuid AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.draft->'sessions')='array' THEN p.draft->'sessions' ELSE '[]'::jsonb END) s WHERE s->>'id'=r.session_id AND s->>'blockId'=r.record_json->'schedule'->>'blockId' AND s->>'date'=r.record_json->'schedule'->>'date' AND s->'localStartTime'=r.record_json->'schedule'->'localStartTime') AND p.draft->>'timezone'=r.record_json->'schedule'->>'timezone');
  END CASE;
  fact:=jsonb_build_object('ordinal',position_index,'identity',i,'relation',relation_name,
   'state',CASE WHEN row_digest IS NULL THEN 'unavailable' ELSE 'observed' END,'sourceRowDigest',row_digest,
   'reason',CASE WHEN row_digest IS NULL THEN 'source_unavailable' ELSE NULL END);
  fact_bytes:=fact_bytes+octet_length(fact::text)+2; fact_refs:=array_append(fact_refs,fact);
  IF fact_bytes>4194304 THEN RAISE EXCEPTION 'MANUAL_BINDING_OUTPUT_BOUND'; END IF;
 END LOOP;
 facts:=to_jsonb(fact_refs);
 result:=jsonb_build_object('bindingVersion',2,'scope','candidate_v2_copied_full_bodies_only',
  'hashMethod','postgres-owned-source-row-jsonb-utc-v2','sqlRefsDigest',encode(sha256(convert_to(normalized::text,'UTF8')),'hex'),
  'transactionId',txid_current()::text,'callerRole',current_user,'athleteId',tenant,'rows',facts,
  'storage','not_persisted','admissionAllowed',false,'sourceCompleteness','unverified','authority','none','freshness','not_checked');
 IF octet_length(result::text)>4194304 THEN RAISE EXCEPTION 'MANUAL_BINDING_OUTPUT_BOUND'; END IF;
 RETURN result;
END
$function$;
REVOKE ALL ON FUNCTION public.observe_manual_review_owned_source_bindings_v2(jsonb) FROM PUBLIC;
