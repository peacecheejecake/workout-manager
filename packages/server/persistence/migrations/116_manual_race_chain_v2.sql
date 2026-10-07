-- Explicit staging successor: registry107 remains unchanged.
-- Canonical evidence payload is stored once; decision/proposal never duplicate source bodies.
-- DTO digests, SQL row/group fingerprints and original deletion authentication are distinct.
CREATE FUNCTION public.manual_race_v2_normalize_refs(refs jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE i jsonb; k text; field text; expected_keys text[]; keys text[]; uuid_fields text[];
 normalized_refs jsonb[]:='{}'; normalized jsonb;
 uuid_pattern constant text:='^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
BEGIN
 IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs) NOT BETWEEN 1 AND 5000
  OR octet_length(refs::text)>4194304 THEN RAISE EXCEPTION 'MANUAL_CHAIN_INVALID_REFS'; END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(refs) LOOP
  IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR jsonb_typeof(i->'kind') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'MANUAL_FULL_BINDING_INVALID_REF'; END IF;
  k:=i->>'kind';
  CASE k
   WHEN 'race-event' THEN expected_keys:=ARRAY['kind','revision','sourceId'];
   WHEN 'plan-snapshot' THEN expected_keys:=ARRAY['kind','sourceId','version'];
   WHEN 'nutrition-plan-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'routine-schedule-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'routine-blueprint-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'routine-occurrence' THEN expected_keys:=ARRAY['kind','sourceId'];
   WHEN 'routine-run' THEN expected_keys:=ARRAY['kind','revision','sourceId'];
   WHEN 'session-completion' THEN expected_keys:=ARRAY['kind','planVersionId','revision','sourceId'];
   WHEN 'food-definition-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'recovery-method-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'recovery-strategy-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'supplementary-exercise-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'workout-template-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'supplementary-session-copy' THEN expected_keys:=ARRAY['kind','sessionId','sourceId'];
   WHEN 'activity-canonical-values' THEN expected_keys:=ARRAY['kind','revision','sourceId'];
   WHEN 'manual-activity-source' THEN expected_keys:=ARRAY['kind','sourceId','sourceRecordId','sourceRevision'];
   WHEN 'activity-overlay' THEN expected_keys:=ARRAY['kind','revision','sourceId'];
   WHEN 'intake-revision' THEN expected_keys:=ARRAY['kind','revisionId','sourceId'];
   WHEN 'checkin-revision' THEN expected_keys:=ARRAY['kind','revision','sourceId'];
   WHEN 'checklist-confirmation' THEN expected_keys:=ARRAY['kind','revisionId','runId','sourceId','stepId'];
   WHEN 'routine-timer' THEN expected_keys:=ARRAY['kind','revision','sourceId','stepId'];
   WHEN 'course-revision' THEN expected_keys:=ARRAY['kind','revision','revisionId','sourceId'];
   WHEN 'course-head-descriptor' THEN expected_keys:=ARRAY['kind','revision','sourceId'];
   WHEN 'activity-track-descriptor' THEN expected_keys:=ARRAY['kind','revision','sourceId','trackId'];
   WHEN 'resource-text-version' THEN expected_keys:=ARRAY['kind','sourceId','versionId'];
   WHEN 'race-timing-pin-fragment' THEN expected_keys:=ARRAY['kind','revision','sourceId'];
   WHEN 'gallery-descriptor' THEN expected_keys:=ARRAY['accessRevision','kind','sourceId'];
   ELSE RAISE EXCEPTION 'MANUAL_FULL_BINDING_UNKNOWN_KIND';
  END CASE;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(i) key;
  IF keys IS DISTINCT FROM expected_keys THEN RAISE EXCEPTION 'MANUAL_FULL_BINDING_INVALID_KEYS'; END IF;
  uuid_fields:=CASE WHEN k IN ('plan-snapshot','routine-schedule-version','routine-blueprint-version','routine-occurrence','routine-run','intake-revision','checklist-confirmation','routine-timer','food-definition-version','session-completion') THEN '{}'::text[] ELSE ARRAY['sourceId'] END;
  IF 'planVersionId'=ANY(expected_keys) THEN uuid_fields:=array_append(uuid_fields,'planVersionId'); END IF;
  IF 'revisionId'=ANY(expected_keys) THEN uuid_fields:=array_append(uuid_fields,'revisionId'); END IF;
  IF 'trackId'=ANY(expected_keys) THEN uuid_fields:=array_append(uuid_fields,'trackId'); END IF;
  IF 'versionId'=ANY(expected_keys) AND k NOT IN ('routine-schedule-version','routine-blueprint-version') THEN uuid_fields:=array_append(uuid_fields,'versionId'); END IF;
  FOREACH field IN ARRAY expected_keys LOOP
   IF field='kind' THEN CONTINUE; END IF;
   IF field IN ('revision','version','sourceRevision','accessRevision') THEN
    IF jsonb_typeof(i->field) IS DISTINCT FROM 'number' OR (i->>field)::numeric<>trunc((i->>field)::numeric)
     OR (i->>field)::numeric NOT BETWEEN (CASE WHEN field='version' OR k IN ('race-event','activity-canonical-values','checkin-revision','course-head-descriptor','race-timing-pin-fragment') THEN 1 ELSE 0 END) AND 2147483647
    THEN RAISE EXCEPTION 'MANUAL_FULL_BINDING_INVALID_REVISION'; END IF;
   ELSE
    IF jsonb_typeof(i->field) IS DISTINCT FROM 'string' OR length(i->>field)=0 THEN RAISE EXCEPTION 'MANUAL_FULL_BINDING_INVALID_ID'; END IF;
    IF field=ANY(uuid_fields) THEN
     IF lower(i->>field)!~uuid_pattern THEN RAISE EXCEPTION 'MANUAL_FULL_BINDING_INVALID_UUID'; END IF;
     i:=jsonb_set(i,ARRAY[field],to_jsonb(lower(i->>field)));
    END IF;
   END IF;
  END LOOP;
  normalized_refs:=array_append(normalized_refs,i);
 END LOOP;
 normalized:=to_jsonb(normalized_refs);
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(normalized))<>jsonb_array_length(normalized) THEN
  RAISE EXCEPTION 'MANUAL_FULL_BINDING_DUPLICATE'; END IF;
 RETURN normalized;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_normalize_refs(jsonb) FROM PUBLIC;
CREATE FUNCTION public.manual_race_v2_event_match(identity jsonb,event_identity jsonb,scope text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN scope='exact_identity' THEN identity=event_identity
 WHEN scope='all_versions' THEN identity-ARRAY['versionId','revisionId','revision','sourceRevision','accessRevision','version']=event_identity-ARRAY['versionId','revisionId','revision','sourceRevision','accessRevision','version']
 ELSE false END
$$;
REVOKE ALL ON FUNCTION public.manual_race_v2_event_match(jsonb,jsonb,text) FROM PUBLIC;
ALTER TABLE public.restore_suppression_event ADD COLUMN manual_review_v2_source_identity jsonb,
 ADD COLUMN manual_review_v2_version_scope text;
-- Successor constraints preserve each original expression and all old wire columns.
DO $$ DECLARE c text; expression text; old_nulls text; branch text; BEGIN
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO old_nulls
 FROM pg_attribute WHERE attrelid='public.restore_suppression_event'::regclass AND attnum>0 AND NOT attisdropped
 AND attname<>ALL(ARRAY['event_id','record_version','athlete_id','kind','occurred_at','manual_review_v2_source_identity','manual_review_v2_version_scope']);
 branch:=format('(record_version=7 AND kind=''manual_review_source_suppressed_v2'' AND isfinite(occurred_at) AND manual_review_v2_version_scope IN (''exact_identity'',''all_versions'') AND manual_review_v2_source_identity=public.manual_race_v2_normalize_refs(jsonb_build_array(manual_review_v2_source_identity))->0 AND %s) IS TRUE',old_nulls);
 FOREACH c IN ARRAY ARRAY['restore_suppression_event_kind_target_check','restore_suppression_event_record_version_check'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='public.restore_suppression_event'::regclass AND conname=c;
  IF expression IS NULL THEN RAISE EXCEPTION 'MANUAL_CHAIN_EVENT_SCHEMA_MISSING'; END IF;
  EXECUTE format('ALTER TABLE public.restore_suppression_event DROP CONSTRAINT %I',c);
  EXECUTE format('ALTER TABLE public.restore_suppression_event ADD CONSTRAINT %I CHECK (((record_version<>7 AND kind<>''manual_review_source_suppressed_v2'' AND manual_review_v2_source_identity IS NULL AND manual_review_v2_version_scope IS NULL) AND (%s)) OR (%s))',c,expression,branch);
 END LOOP;
END $$;
-- convert_to is STABLE, not an immutable index expression. The actual transition
-- holds tenant0 and checks the exact JSON identity before minting; lookup indexes
-- only bounded tenant/scope columns and never truncates opaque source identities.
CREATE INDEX manual_race_v2_event_identity_lookup ON public.restore_suppression_event
 (athlete_id,manual_review_v2_version_scope) WHERE record_version=7;

CREATE TABLE public.manual_race_evidence_v2 (
 athlete_id text NOT NULL,id uuid NOT NULL,decision_id uuid NOT NULL,proposal_id uuid NOT NULL,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),receipt_key text NOT NULL,
 candidate_digest text NOT NULL CHECK(candidate_digest~'^[a-f0-9]{64}$'),
 original_payload_sql_digest text NOT NULL CHECK(original_payload_sql_digest~'^[a-f0-9]{64}$'),
 payload jsonb CHECK(payload IS NULL OR (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=4194304)),
 purged_at timestamptz,purged_event_id uuid,
 CHECK((payload IS NOT NULL AND purged_at IS NULL AND purged_event_id IS NULL) OR (payload IS NULL AND purged_at IS NOT NULL AND purged_event_id IS NOT NULL)),
 PRIMARY KEY(athlete_id,id),UNIQUE(athlete_id,receipt_key),UNIQUE(athlete_id,decision_id),UNIQUE(athlete_id,proposal_id)
);
CREATE TABLE public.manual_race_decision_v2 (
 athlete_id text NOT NULL,id uuid NOT NULL,evidence_id uuid NOT NULL,PRIMARY KEY(athlete_id,id),
 FOREIGN KEY(athlete_id,evidence_id) REFERENCES public.manual_race_evidence_v2(athlete_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.manual_race_proposal_v2 (
 athlete_id text NOT NULL,id uuid NOT NULL,evidence_id uuid NOT NULL,decision_id uuid NOT NULL,applicable boolean NOT NULL CHECK(NOT applicable),
 PRIMARY KEY(athlete_id,id),FOREIGN KEY(athlete_id,evidence_id) REFERENCES public.manual_race_evidence_v2(athlete_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(athlete_id,decision_id) REFERENCES public.manual_race_decision_v2(athlete_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.manual_race_chain_source_ref_v2 (
 athlete_id text NOT NULL,evidence_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 5000),
 identity jsonb NOT NULL,identity_key bytea NOT NULL,dto_digest text NOT NULL CHECK(dto_digest~'^[a-f0-9]{64}$'),
 copied_locations jsonb NOT NULL,sql_relations jsonb NOT NULL,
 PRIMARY KEY(athlete_id,evidence_id,ordinal),UNIQUE(athlete_id,evidence_id,identity_key),
 CHECK(identity_key=sha256(convert_to(identity::text,'UTF8'))),
 FOREIGN KEY(athlete_id,evidence_id) REFERENCES public.manual_race_evidence_v2(athlete_id,id)
);
CREATE TABLE public.manual_race_chain_lifecycle_edge_v2 (
 athlete_id text NOT NULL,evidence_id uuid NOT NULL,ordinal integer NOT NULL,edge_key bytea NOT NULL,edge jsonb NOT NULL,
 PRIMARY KEY(athlete_id,evidence_id,ordinal,edge_key),CHECK(edge_key=sha256(convert_to(edge::text,'UTF8'))),
 FOREIGN KEY(athlete_id,evidence_id,ordinal) REFERENCES public.manual_race_chain_source_ref_v2(athlete_id,evidence_id,ordinal)
);
CREATE INDEX manual_race_chain_edge_reverse ON public.manual_race_chain_lifecycle_edge_v2
 (athlete_id,(edge->>'family'));
-- Original events have event_id PK; the explicit tenant+event unique key supports
-- the composite FK without weakening the same-tenant provenance guard.
CREATE UNIQUE INDEX manual_race_v2_event_tenant_key ON public.restore_suppression_event(athlete_id,event_id);
CREATE TABLE public.manual_race_chain_suppression_v2 (
 athlete_id text NOT NULL,evidence_id uuid NOT NULL,event_id uuid NOT NULL,occurred_at timestamptz NOT NULL,
 original_payload_sql_digest text NOT NULL,PRIMARY KEY(athlete_id,evidence_id,event_id),
 FOREIGN KEY(athlete_id,evidence_id) REFERENCES public.manual_race_evidence_v2(athlete_id,id),
 FOREIGN KEY(athlete_id,event_id) REFERENCES public.restore_suppression_event(athlete_id,event_id)
);
CREATE TABLE public.manual_race_chain_receipt_v2 (
 athlete_id text NOT NULL,receipt_key text NOT NULL,request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),result jsonb NOT NULL,evidence_id uuid NOT NULL,
 PRIMARY KEY(athlete_id,receipt_key),FOREIGN KEY(athlete_id,evidence_id) REFERENCES public.manual_race_evidence_v2(athlete_id,id) DEFERRABLE INITIALLY DEFERRED
);
-- Receipt request digest uses PostgreSQL JSONB text UTF8 SHA256; no request/body copy survives purge.
-- Transaction seal contains no raw source and cannot be inserted by a caller/table owner.
CREATE TABLE public.manual_race_chain_commit_v2 (
 athlete_id text NOT NULL,evidence_id uuid NOT NULL,caller_role name NOT NULL,owner_xid bigint NOT NULL,payload_hash bytea NOT NULL,
 PRIMARY KEY(athlete_id,evidence_id),FOREIGN KEY(athlete_id,evidence_id) REFERENCES public.manual_race_evidence_v2(athlete_id,id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['manual_race_evidence_v2','manual_race_decision_v2','manual_race_proposal_v2','manual_race_chain_source_ref_v2','manual_race_chain_lifecycle_edge_v2','manual_race_chain_suppression_v2','manual_race_chain_receipt_v2','manual_race_chain_commit_v2'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($policy$CREATE POLICY tenant ON public.%I USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''))$policy$,t);
 END LOOP;
END $$;
CREATE FUNCTION public.assert_manual_race_v2_caller() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF session_user=current_user OR pg_has_role(session_user,current_user,'MEMBER')
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND relkind IN ('r','p'))
 OR current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass))
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_manual_race_v2_caller() FROM PUBLIC;
CREATE FUNCTION public.manual_race_v2_json_at(root jsonb,path text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE parts text[]; BEGIN
 IF path !~ '^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*|\[(0|[1-9][0-9]*)\])*$' THEN RAISE EXCEPTION 'MANUAL_CHAIN_INVALID_LOCATION'; END IF;
 parts:=string_to_array(replace(regexp_replace(path,'\[([0-9]+)\]',' .\1','g'),' ',''),'.');
 RETURN root#>parts;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_json_at(jsonb,text) FROM PUBLIC;

-- Rebuild the complete minimal parent roster from actual rows. Caller edges are expectations only.
CREATE FUNCTION public.manual_race_v2_parent_edges(refs jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); i jsonb; q text; f text; v text; role text;
 edges jsonb; all_facts jsonb[]:='{}'; n bigint; bytes bigint; total bigint:=0; visits bigint:=0;
BEGIN
 refs:=public.manual_race_v2_normalize_refs(refs);
 FOR i IN SELECT value FROM jsonb_array_elements(refs) LOOP
 CASE i->>'kind'
 WHEN 'race-event' THEN v:=i->>'revision'; q:=$query$SELECT 'race-event'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.race_event WHERE athlete_id=$1 AND id::text=$2->>'sourceId' AND revision=($2->>'revision')::int AND NOT deleted$query$;
 WHEN 'plan-snapshot' THEN v:=i->>'version'; q:=$query$SELECT 'plan-snapshot'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.plan_snapshot WHERE athlete_id=$1 AND id::text=$2->>'sourceId' AND version=($2->>'version')::int$query$;
 WHEN 'nutrition-plan-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'nutrition-plan'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.nutrition_plan_version WHERE athlete_id=$1 AND plan_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'routine-schedule-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'routine-schedule'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.routine_schedule_version WHERE athlete_id=$1 AND schedule_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'routine-blueprint-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'routine-blueprint'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.routine_blueprint_version WHERE athlete_id=$1 AND routine_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'routine-occurrence' THEN v:=NULL; q:=$query$SELECT 'routine-occurrence'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.routine_occurrence WHERE athlete_id=$1 AND id::text=$2->>'sourceId'$query$;
 WHEN 'routine-run' THEN v:=i->>'revision'; q:=$query$SELECT 'routine-run'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.routine_run_revision WHERE athlete_id=$1 AND run_id::text=$2->>'sourceId' AND revision=($2->>'revision')::int$query$;
 WHEN 'session-completion' THEN v:=replace(jsonb_build_array(i->>'planVersionId',(i->>'revision')::int)::text,', ', ','); q:=$query$SELECT 'session-completion'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.session_completion_revision WHERE athlete_id=$1 AND session_id=$2->>'sourceId' AND revision=($2->>'revision')::int AND record_json->>'planVersionId'=$2->>'planVersionId' UNION ALL SELECT 'plan-snapshot',p.id::text,p.version::text,'parent',NULL::jsonb FROM public.plan_snapshot p WHERE p.athlete_id=$1 AND p.id::text=$2->>'planVersionId' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.draft->'sessions') s WHERE s->>'id'=$2->>'sourceId')$query$;
 WHEN 'food-definition-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'food-definition'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.food_definition_version WHERE athlete_id=$1 AND food_id=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'recovery-strategy-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'recovery-strategy'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.recovery_strategy_version WHERE athlete_id=$1 AND strategy_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'recovery-method-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'recovery-method'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.recovery_method_version WHERE athlete_id=$1 AND method_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'workout-template-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'workout-template'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.supplementary_routine_version WHERE athlete_id=$1 AND routine_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId' UNION ALL SELECT 'supplementary-exercise',e.exercise_id::text,e.version_id::text,'target',jsonb_build_array(t.routine_version_id,t.target_set_id) FROM public.supplementary_routine_target_ref t JOIN public.supplementary_exercise_version e ON e.athlete_id=t.athlete_id AND e.version_id=t.exercise_version_id WHERE t.athlete_id=$1 AND t.routine_version_id::text=$2->>'versionId'$query$;
 WHEN 'supplementary-exercise-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'supplementary-exercise'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.supplementary_exercise_version WHERE athlete_id=$1 AND exercise_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'resource-text-version' THEN v:=i->>'versionId'; q:=$query$SELECT 'resource'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.resource_version WHERE athlete_id=$1 AND resource_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId' AND EXISTS(SELECT 1 FROM public.resource p WHERE p.athlete_id=resource_version.athlete_id AND p.id=resource_version.resource_id AND p.deleted_at IS NULL)$query$;
 WHEN 'supplementary-session-copy' THEN v:=NULL; q:=$query$SELECT 'plan-snapshot'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'parent'::text AS role, NULL::jsonb AS "membershipKey" FROM public.supplementary_session_link WHERE athlete_id=$1 AND plan_version_id::text=$2->>'sourceId' AND planned_session_id=$2->>'sessionId' UNION ALL SELECT 'supplementary-exercise',e.exercise_id::text,e.version_id::text,'target',jsonb_build_array(t.plan_version_id,t.planned_session_id,t.target_set_id) FROM public.supplementary_session_target_ref t JOIN public.supplementary_exercise_version e ON e.athlete_id=t.athlete_id AND e.version_id=t.exercise_version_id WHERE t.athlete_id=$1 AND t.plan_version_id::text=$2->>'sourceId' AND t.planned_session_id=$2->>'sessionId'$query$;
 WHEN 'manual-activity-source' THEN v:=replace(jsonb_build_array('manual',i->>'sourceRecordId',(i->>'sourceRevision')::int)::text,', ', ','); q:=$query$SELECT 'activity'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.activity_source_revision WHERE athlete_id=$1 AND kind='manual' AND source_id=$2->>'sourceRecordId' AND source_revision=($2->>'sourceRevision')::int AND EXISTS(SELECT 1 FROM public.activity_source_head h WHERE h.athlete_id=activity_source_revision.athlete_id AND h.kind='manual' AND h.source_id=activity_source_revision.source_id AND h.source_revision=activity_source_revision.source_revision AND h.activity_id::text=$2->>'sourceId' AND EXISTS(SELECT 1 FROM public.activity_canonical a WHERE a.athlete_id=h.athlete_id AND a.id=h.activity_id AND NOT a.deleted) AND NOT EXISTS(SELECT 1 FROM public.activity_suppression z WHERE z.athlete_id=h.athlete_id AND z.kind=h.kind AND z.source_id=h.source_id))$query$;
 WHEN 'activity-overlay' THEN v:=i->>'revision'; q:=$query$SELECT 'activity'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.activity_overlay_revision WHERE athlete_id=$1 AND activity_id::text=$2->>'sourceId' AND revision=($2->>'revision')::int$query$;
 WHEN 'activity-canonical-values' THEN v:=i->>'revision'; q:=$query$SELECT 'activity'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.activity_canonical WHERE athlete_id=$1 AND id::text=$2->>'sourceId' AND revision=($2->>'revision')::int AND NOT deleted$query$;
 WHEN 'intake-revision' THEN v:=i->>'revisionId'; q:=$query$SELECT 'intake'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.intake_entry_revision WHERE athlete_id=$1 AND intake_id=$2->>'sourceId' AND revision_id::text=$2->>'revisionId' AND EXISTS(SELECT 1 FROM public.intake_entry h WHERE h.athlete_id=intake_entry_revision.athlete_id AND h.id=intake_entry_revision.intake_id AND h.status='active') UNION ALL SELECT 'intake-origin',r.revision_id::text,NULL,'origin',NULL::jsonb FROM public.intake_entry_revision r JOIN public.intake_entry h ON h.athlete_id=r.athlete_id AND h.id=r.intake_id WHERE r.athlete_id=$1 AND r.intake_id=$2->>'sourceId' AND r.revision=1 AND r.status='active' AND h.status='active'$query$;
 WHEN 'checkin-revision' THEN v:=i->>'revision'; q:=$query$SELECT 'checkin'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.check_in_revision WHERE athlete_id=$1 AND check_in_id::text=$2->>'sourceId' AND revision=($2->>'revision')::int$query$;
 WHEN 'checklist-confirmation' THEN v:=i->>'revisionId'; q:=$query$SELECT 'checklist-confirmation'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.routine_checklist_confirmation WHERE athlete_id=$1 AND id=$2->>'sourceId' AND revision_id::text=$2->>'revisionId' AND run_id::text=$2->>'runId' AND step_id=$2->>'stepId' UNION ALL SELECT 'routine-run',r.id::text,NULL,'parent',NULL::jsonb FROM public.routine_run r WHERE r.athlete_id=$1 AND r.id::text=$2->>'runId'$query$;
 WHEN 'course-revision' THEN v:=replace(jsonb_build_array(i->>'revisionId',(i->>'revision')::int)::text,', ', ','); q:=$query$SELECT 'course'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.course_revision WHERE athlete_id=$1 AND course_id::text=$2->>'sourceId' AND revision_id::text=$2->>'revisionId' AND course_revision=($2->>'revision')::int UNION ALL SELECT 'activity',s.activity_id::text,NULL,'lineage',NULL::jsonb FROM public.course_revision_source s WHERE s.athlete_id=$1 AND s.course_id::text=$2->>'sourceId' AND s.course_revision=($2->>'revision')::int UNION ALL SELECT 'activity-track',s.activity_id::text,replace(jsonb_build_array(s.track_id,s.track_revision)::text,', ',','),'lineage',NULL::jsonb FROM public.course_revision_source s WHERE s.athlete_id=$1 AND s.course_id::text=$2->>'sourceId' AND s.course_revision=($2->>'revision')::int$query$;
 WHEN 'activity-track-descriptor' THEN v:=replace(jsonb_build_array(i->>'trackId',(i->>'revision')::int)::text,', ', ','); q:=$query$SELECT 'activity-track'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.activity_track_revision WHERE athlete_id=$1 AND activity_id::text=$2->>'sourceId' AND track_id::text=$2->>'trackId' AND track_revision=($2->>'revision')::int UNION ALL SELECT 'activity',a.id::text,NULL,'parent',NULL::jsonb FROM public.activity_canonical a WHERE a.athlete_id=$1 AND a.id::text=$2->>'sourceId'$query$;
 WHEN 'course-head-descriptor' THEN v:=i->>'revision'; q:=$query$SELECT 'course'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.course WHERE athlete_id=$1 AND course_id::text=$2->>'sourceId' AND head_revision=($2->>'revision')::int UNION ALL SELECT 'activity',s.activity_id::text,NULL,'lineage',NULL::jsonb FROM public.course_revision_source s WHERE s.athlete_id=$1 AND s.course_id::text=$2->>'sourceId' AND s.course_revision=($2->>'revision')::int UNION ALL SELECT 'activity-track',s.activity_id::text,replace(jsonb_build_array(s.track_id,s.track_revision)::text,', ',','),'lineage',NULL::jsonb FROM public.course_revision_source s WHERE s.athlete_id=$1 AND s.course_id::text=$2->>'sourceId' AND s.course_revision=($2->>'revision')::int$query$;
 WHEN 'gallery-descriptor' THEN v:=i->>'accessRevision'; q:=$query$SELECT 'gallery-media'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'source'::text AS role, NULL::jsonb AS "membershipKey" FROM public.gallery_media_item WHERE athlete_id=$1 AND id::text=$2->>'sourceId' AND access_revision=($2->>'accessRevision')::int AND deleted_at IS NULL$query$;
 WHEN 'routine-timer' THEN v:=replace(jsonb_build_array(i->>'stepId',(i->>'revision')::int)::text,', ', ','); q:=$query$SELECT 'routine-run'::text AS family, $2->>'sourceId' AS "sourceId", $3::text AS "versionKey", 'parent'::text AS role, NULL::jsonb AS "membershipKey" FROM public.routine_step_timer WHERE athlete_id=$1 AND run_id::text=$2->>'sourceId' AND step_id=$2->>'stepId' AND revision=($2->>'revision')::int$query$;
 WHEN 'race-timing-pin-fragment' THEN v:=NULL; q:=$query$SELECT 'nutrition-plan'::text AS family,n.plan_id::text AS "sourceId",n.version_id::text AS "versionKey",'pin_parent'::text AS role,NULL::jsonb AS "membershipKey" FROM public.nutrition_plan_version n WHERE n.athlete_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements($4) ref WHERE ref->>'kind'='nutrition-plan-version' AND ref->>'sourceId'=n.plan_id::text AND ref->>'versionId'=n.version_id::text) AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(n.record_json->'raceTimingPins','[]'::jsonb)) pin WHERE pin->>'eventId'=$2->>'sourceId' AND pin->>'eventRevision'=$2->>'revision' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(n.record_json->'itemRaceTimingBindings','[]'::jsonb)) binding WHERE binding->'binding'->>'state'='captured' AND binding->'binding'->>'eventId'=pin->>'eventId' AND binding->'binding'->>'eventRevision'=pin->>'eventRevision'))$query$;
 ELSE RAISE EXCEPTION 'MANUAL_CHAIN_UNKNOWN_PARENT'; END CASE;
 EXECUTE 'WITH parents AS ('||q||') SELECT count(*),coalesce(sum(octet_length(to_jsonb(parents)::text)),0) FROM parents' INTO n,bytes USING tenant,i,v,refs;
 total:=total+bytes; visits:=visits+n;
 IF n NOT BETWEEN 1 AND 5000 OR visits>5000 OR total>4194304 THEN RAISE EXCEPTION 'MANUAL_CHAIN_PARENT_BOUND'; END IF;
 EXECUTE 'WITH parents AS ('||q||') SELECT coalesce(jsonb_agg(body ORDER BY body::text COLLATE "C"),''[]''::jsonb) FROM (SELECT DISTINCT to_jsonb(parents) AS body FROM parents) p' INTO edges USING tenant,i,v,refs;
 IF i->>'kind'='race-timing-pin-fragment' THEN
  SELECT jsonb_agg(x ORDER BY x::text COLLATE "C") INTO edges FROM (SELECT DISTINCT x FROM jsonb_array_elements(edges||jsonb_build_array(jsonb_build_object('family','race-event','sourceId',i->>'sourceId','versionKey',i->>'revision','role','source','membershipKey',NULL))) x) a;
 END IF;
 all_facts:=array_append(all_facts,jsonb_build_object('identity',i,'edges',edges));
 END LOOP;
 RETURN to_jsonb(all_facts);
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_parent_edges(jsonb) FROM PUBLIC;

-- Exact immutable DTO projection for the supported own/core/text manual purpose.
-- Unsupported provenance remains finite; no descriptor metadata grants provider/media use.
-- Actual current local recording, independent of a supplied purpose observation.
CREATE FUNCTION public.manual_race_v2_local_activity_state(activity uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('activityId',c.id,'canonicalRevision',c.revision,
  'source',jsonb_build_object('kind',h.kind,'sourceId',h.source_id,'revision',h.source_revision,'contentHash',h.content_hash),
  'overlayRevision',(SELECT max(revision) FROM public.activity_overlay_revision z WHERE z.athlete_id=c.athlete_id AND z.activity_id=c.id),
  'overlayPresent',o.values_json IS NOT NULL)
 FROM public.activity_canonical c JOIN public.activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id
 JOIN public.activity_source_revision v ON v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision AND v.content_hash=h.content_hash
 LEFT JOIN public.activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id
 WHERE c.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND c.id=$1 AND NOT c.deleted
 AND h.kind IN ('manual','fit','fixture') AND v.normalized_raw=c.original
 AND octet_length(c.original::text)+octet_length(v.normalized_raw::text)+coalesce(octet_length(o.values_json::text),4)<=4194304
 AND NOT EXISTS(SELECT 1 FROM public.activity_suppression z WHERE z.athlete_id=h.athlete_id AND z.kind=h.kind AND z.source_id=h.source_id)
 AND NOT EXISTS(SELECT 1 FROM public.garmin_activity_ledger_source z JOIN public.garmin_activity_ledger g ON g.athlete_id=z.athlete_id AND g.garmin_activity_id=z.garmin_activity_id WHERE z.athlete_id=h.athlete_id AND z.kind=h.kind AND z.source_id=h.source_id)
$$;
REVOKE ALL ON FUNCTION public.manual_race_v2_local_activity_state(uuid) FROM PUBLIC;
CREATE FUNCTION public.manual_race_v2_verify_source_purpose(identity jsonb,purpose jsonb,course_ref jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_k text:=identity->>'kind'; v_t text:=nullif(current_setting('app.athlete_id',true),''); v_state jsonb; v_source jsonb; v_requested jsonb; v_actual jsonb;
 v_course_id uuid; v_revision integer; v_revision_id uuid; v_n bigint;
BEGIN
 IF v_k NOT IN ('activity-canonical-values','activity-overlay','course-revision','course-head-descriptor','activity-track-descriptor') THEN
  IF purpose IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF; RETURN;
 END IF;
 IF v_k IN ('activity-canonical-values','activity-overlay') THEN
  v_state:=public.manual_race_v2_local_activity_state((identity->>'sourceId')::uuid);
  IF v_state IS NULL OR v_state->>'canonicalRevision' IS DISTINCT FROM identity->>'revision' THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  IF v_state->'source'->>'kind'='manual' AND purpose='null'::jsonb THEN RETURN; END IF;
  IF purpose->>'kind' IS DISTINCT FROM 'own_imported_activity' OR v_state->'source'->>'kind' NOT IN ('fit','fixture') THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  v_actual:=jsonb_build_array(v_state);
 ELSE
  IF course_ref IS NULL OR course_ref='null'::jsonb OR purpose->>'kind' IS DISTINCT FROM 'own_manual_lineage' THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  v_course_id:=(course_ref->>'courseId')::uuid; v_revision:=(course_ref->>'courseRevision')::int; v_revision_id:=(course_ref->>'revisionId')::uuid;
  IF v_k='course-revision' AND (identity->>'sourceId'<>v_course_id::text OR identity->>'revision'<>v_revision::text OR identity->>'revisionId'<>v_revision_id::text)
   OR v_k='course-head-descriptor' AND NOT EXISTS(SELECT 1 FROM public.course h WHERE h.athlete_id=v_t AND h.course_id=v_course_id AND h.course_id::text=identity->>'sourceId' AND h.head_revision::text=identity->>'revision' AND h.status='available')
   OR v_k='activity-track-descriptor' AND NOT EXISTS(SELECT 1 FROM public.course_revision_source l WHERE l.athlete_id=v_t AND l.course_id=v_course_id AND l.course_revision=v_revision AND l.activity_id::text=identity->>'sourceId' AND l.track_id::text=identity->>'trackId' AND l.track_revision::text=identity->>'revision')
  THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.course_revision r JOIN public.course h ON h.athlete_id=r.athlete_id AND h.course_id=r.course_id WHERE r.athlete_id=v_t AND r.course_id=v_course_id AND r.course_revision=v_revision AND r.revision_id=v_revision_id AND h.status='available' AND r.generation->>'kind'='recorded-segment'
    AND EXISTS(SELECT 1 FROM public.course_revision_source l JOIN public.activity_track_revision tr ON tr.athlete_id=l.athlete_id AND tr.activity_id=l.activity_id AND tr.track_id=l.track_id AND tr.track_revision=l.track_revision WHERE l.athlete_id=r.athlete_id AND l.course_id=r.course_id AND l.course_revision=r.course_revision AND l.activity_id::text=r.generation->>'activityId' AND l.track_id::text=r.generation->>'trackId' AND l.track_revision::text=r.generation->>'trackRevision' AND tr.map_path_content_hash=r.generation->>'mapPathContentSha256'))
   OR EXISTS(SELECT 1 FROM public.export_course_deletions() d WHERE d.athlete_id=v_t AND d.course_id=v_course_id)
  THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  SELECT count(*) INTO v_n FROM public.course_revision_source l WHERE l.athlete_id=v_t AND l.course_id=v_course_id AND l.course_revision=v_revision;
  IF v_n NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  SELECT jsonb_agg(public.manual_race_v2_local_activity_state(l.activity_id) ORDER BY l.activity_id,l.track_id,l.track_revision) INTO v_actual
  FROM public.course_revision_source l JOIN public.activity_track_revision tr ON tr.athlete_id=l.athlete_id AND tr.activity_id=l.activity_id AND tr.track_id=l.track_id AND tr.track_revision=l.track_revision
  JOIN public.activity_source_head h ON h.athlete_id=tr.athlete_id AND h.activity_id=tr.activity_id AND h.kind=tr.source_kind AND h.source_id=tr.source_id AND h.source_revision=tr.source_revision
  WHERE l.athlete_id=v_t AND l.course_id=v_course_id AND l.course_revision=v_revision AND h.kind='manual';
  IF v_actual IS NULL OR jsonb_array_length(v_actual)<>v_n OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_actual) a WHERE a='null'::jsonb) THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
 END IF;
 IF jsonb_typeof(purpose) IS DISTINCT FROM 'object' OR purpose-ARRAY['adapterVersion','kind','sources']<>'{}'::jsonb OR purpose->'adapterVersion' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(purpose->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(purpose->'sources')<>jsonb_array_length(v_actual) THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
 v_requested:='[]'::jsonb;
 FOR v_source IN SELECT value FROM jsonb_array_elements(purpose->'sources') LOOP
  IF jsonb_typeof(v_source) IS DISTINCT FROM 'object' OR v_source-ARRAY['activityId','canonicalRevision','source','originalDigest','overlayRevision','overlayDigest']<>'{}'::jsonb
   OR NOT(v_source ?& ARRAY['activityId','canonicalRevision','source','originalDigest','overlayRevision','overlayDigest']) OR jsonb_typeof(v_source->'originalDigest') IS DISTINCT FROM 'string' OR v_source->>'originalDigest' !~ '^[a-f0-9]{64}$'
   OR (v_source->'overlayDigest'<>'null'::jsonb AND (jsonb_typeof(v_source->'overlayDigest') IS DISTINCT FROM 'string' OR v_source->>'overlayDigest' !~ '^[a-f0-9]{64}$'))
  THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  v_requested:=v_requested||jsonb_build_array(jsonb_build_object('activityId',v_source->'activityId','canonicalRevision',v_source->'canonicalRevision','source',v_source->'source','overlayRevision',v_source->'overlayRevision','overlayPresent',v_source->'overlayDigest'<>'null'::jsonb));
 END LOOP;
 -- DTO checksum fields remain observations, never SQL row hashes/credentials. The
 -- actual tuple/ledger hash/body equality above establishes the narrow local policy.
 IF v_requested IS DISTINCT FROM v_actual THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_verify_source_purpose(jsonb,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.manual_race_v2_source_dto(i jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),'');q text;n bigint;bytes bigint;body jsonb;
BEGIN
 CASE i->>'kind'
 WHEN 'race-event' THEN q:=$query$SELECT values_json || jsonb_build_object('id',id,'revision',revision) AS body FROM public.race_event WHERE athlete_id=$1 AND id::text=$2->>'sourceId' AND revision=($2->>'revision')::int AND NOT deleted$query$;
 WHEN 'plan-snapshot' THEN q:=$query$SELECT jsonb_build_object('id',id,'version',version,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'draft',draft) AS body FROM public.plan_snapshot WHERE athlete_id=$1 AND id::text=$2->>'sourceId' AND version=($2->>'version')::int$query$;
 WHEN 'nutrition-plan-version' THEN q:=$query$SELECT record_json AS body FROM public.nutrition_plan_version WHERE athlete_id=$1 AND plan_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'routine-schedule-version' THEN q:=$query$SELECT record_json AS body FROM public.routine_schedule_version WHERE athlete_id=$1 AND schedule_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'routine-blueprint-version' THEN q:=$query$SELECT record_json AS body FROM public.routine_blueprint_version WHERE athlete_id=$1 AND routine_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'routine-occurrence' THEN q:=$query$SELECT record_json AS body FROM public.routine_occurrence WHERE athlete_id=$1 AND id::text=$2->>'sourceId'$query$;
 WHEN 'routine-run' THEN q:=$query$SELECT record_json AS body FROM public.routine_run_revision WHERE athlete_id=$1 AND run_id::text=$2->>'sourceId' AND revision=($2->>'revision')::int$query$;
 WHEN 'session-completion' THEN q:=$query$SELECT record_json AS body FROM public.session_completion_revision WHERE athlete_id=$1 AND session_id=$2->>'sourceId' AND revision=($2->>'revision')::int AND record_json->>'planVersionId'=$2->>'planVersionId'$query$;
 WHEN 'food-definition-version' THEN q:=$query$SELECT record_json AS body FROM public.food_definition_version WHERE athlete_id=$1 AND food_id=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'recovery-strategy-version' THEN q:=$query$SELECT record_json AS body FROM public.recovery_strategy_version WHERE athlete_id=$1 AND strategy_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'recovery-method-version' THEN q:=$query$SELECT record_json AS body FROM public.recovery_method_version WHERE athlete_id=$1 AND method_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'workout-template-version' THEN q:=$query$SELECT record_json AS body FROM public.supplementary_routine_version WHERE athlete_id=$1 AND routine_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'supplementary-exercise-version' THEN q:=$query$SELECT record_json AS body FROM public.supplementary_exercise_version WHERE athlete_id=$1 AND exercise_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId'$query$;
 WHEN 'resource-text-version' THEN q:=$query$SELECT jsonb_build_object('schemaVersion',1,'id',version_id,'resourceId',resource_id,'version',version,'previousVersionId',previous_version_id,'contentHash',content_hash,'source',jsonb_build_object('kind','text','text',content),'paragraphs',paragraphs,'lifecycle',jsonb_build_object('contentStatus',content_status,'indexStatus',index_status),'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS body FROM public.resource_version WHERE athlete_id=$1 AND resource_id::text=$2->>'sourceId' AND version_id::text=$2->>'versionId' AND EXISTS(SELECT 1 FROM public.resource p WHERE p.athlete_id=resource_version.athlete_id AND p.id=resource_version.resource_id AND p.deleted_at IS NULL) AND EXISTS(SELECT 1 FROM public.resource h WHERE h.athlete_id=resource_version.athlete_id AND h.id=resource_version.resource_id AND h.deleted_at IS NULL AND h.source_kind='text') AND content_hash=encode(sha256(convert_to(content,'UTF8')),'hex')$query$;
 WHEN 'intake-revision' THEN q:=$query$SELECT record_json AS body FROM public.intake_entry_revision WHERE athlete_id=$1 AND intake_id=$2->>'sourceId' AND revision_id::text=$2->>'revisionId' AND EXISTS(SELECT 1 FROM public.intake_entry h WHERE h.athlete_id=intake_entry_revision.athlete_id AND h.id=intake_entry_revision.intake_id AND h.status='active')$query$;
 WHEN 'checkin-revision' THEN q:=$query$SELECT values_json AS body FROM public.check_in_revision WHERE athlete_id=$1 AND check_in_id::text=$2->>'sourceId' AND revision=($2->>'revision')::int AND EXISTS(SELECT 1 FROM public.check_in h WHERE h.athlete_id=check_in_revision.athlete_id AND h.id=check_in_revision.check_in_id AND NOT h.deleted)$query$;
 WHEN 'checklist-confirmation' THEN q:=$query$SELECT jsonb_build_object('id',id,'run_id',run_id,'step_id',step_id,'revision_id',revision_id,'occurred_at',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state',state) AS body FROM public.routine_checklist_confirmation WHERE athlete_id=$1 AND id=$2->>'sourceId' AND revision_id::text=$2->>'revisionId' AND run_id::text=$2->>'runId' AND step_id=$2->>'stepId'$query$;
 WHEN 'routine-timer' THEN q:=$query$SELECT jsonb_build_object('runId',run_id,'stepId',step_id,'revision',revision,'state',state,'durationSeconds',duration_seconds,'startedAt',to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'pausedAt',CASE WHEN paused_at IS NULL THEN NULL ELSE to_char(paused_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'pausedMilliseconds',paused_milliseconds) AS body FROM public.routine_step_timer WHERE athlete_id=$1 AND run_id::text=$2->>'sourceId' AND step_id=$2->>'stepId' AND revision=($2->>'revision')::int$query$;
 WHEN 'manual-activity-source' THEN q:=$query$SELECT c.original AS body FROM public.activity_canonical c JOIN public.activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id JOIN public.activity_source_revision v ON v.athlete_id=s.athlete_id AND v.kind=s.kind AND v.source_id=s.source_id AND v.source_revision=s.source_revision AND v.content_hash=s.content_hash LEFT JOIN public.activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id::text=$2->>'sourceId' AND NOT c.deleted AND s.kind='manual' AND NOT EXISTS(SELECT 1 FROM public.activity_suppression z WHERE z.athlete_id=s.athlete_id AND z.kind=s.kind AND z.source_id=s.source_id) AND s.source_id=$2->>'sourceRecordId' AND s.source_revision=($2->>'sourceRevision')::int$query$;
 WHEN 'activity-overlay' THEN q:=$query$SELECT o.values_json AS body FROM public.activity_canonical c JOIN public.activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id JOIN public.activity_source_revision v ON v.athlete_id=s.athlete_id AND v.kind=s.kind AND v.source_id=s.source_id AND v.source_revision=s.source_revision AND v.content_hash=s.content_hash LEFT JOIN public.activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id::text=$2->>'sourceId' AND NOT c.deleted AND s.kind IN ('manual','fit','fixture') AND v.normalized_raw=c.original AND NOT EXISTS(SELECT 1 FROM public.garmin_activity_ledger_source gl JOIN public.garmin_activity_ledger g ON g.athlete_id=gl.athlete_id AND g.garmin_activity_id=gl.garmin_activity_id WHERE gl.athlete_id=s.athlete_id AND gl.kind=s.kind AND gl.source_id=s.source_id) AND NOT EXISTS(SELECT 1 FROM public.activity_suppression z WHERE z.athlete_id=s.athlete_id AND z.kind=s.kind AND z.source_id=s.source_id) AND c.revision=($2->>'revision')::int AND (SELECT max(revision) FROM public.activity_overlay_revision h WHERE h.athlete_id=c.athlete_id AND h.activity_id=c.id)=c.revision$query$;
 WHEN 'activity-canonical-values' THEN q:=$query$SELECT c.original AS body FROM public.activity_canonical c JOIN public.activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id JOIN public.activity_source_revision v ON v.athlete_id=s.athlete_id AND v.kind=s.kind AND v.source_id=s.source_id AND v.source_revision=s.source_revision AND v.content_hash=s.content_hash LEFT JOIN public.activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND c.id::text=$2->>'sourceId' AND NOT c.deleted AND s.kind IN ('manual','fit','fixture') AND v.normalized_raw=c.original AND NOT EXISTS(SELECT 1 FROM public.garmin_activity_ledger_source gl JOIN public.garmin_activity_ledger g ON g.athlete_id=gl.athlete_id AND g.garmin_activity_id=gl.garmin_activity_id WHERE gl.athlete_id=s.athlete_id AND gl.kind=s.kind AND gl.source_id=s.source_id) AND NOT EXISTS(SELECT 1 FROM public.activity_suppression z WHERE z.athlete_id=s.athlete_id AND z.kind=s.kind AND z.source_id=s.source_id) AND c.revision=($2->>'revision')::int$query$;
 WHEN 'course-revision' THEN q:=$query$SELECT jsonb_build_object('courseId',r.course_id,'courseRevision',r.course_revision,'revisionId',r.revision_id,'name',r.name,'geometry',r.geometry,'waypoints',r.waypoints,'generation',r.generation,'edit',r.edit,'distanceMeters',r.distance_meters,'contentDigest',r.content_digest,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'lineage',(SELECT jsonb_agg(jsonb_build_object('activityId',l.activity_id,'trackId',l.track_id,'trackRevision',l.track_revision) ORDER BY l.activity_id,l.track_id,l.track_revision) FROM public.course_revision_source l WHERE l.athlete_id=r.athlete_id AND l.course_id=r.course_id AND l.course_revision=r.course_revision)) AS body FROM public.course_revision r JOIN public.course h ON h.athlete_id=r.athlete_id AND h.course_id=r.course_id WHERE r.athlete_id=$1 AND r.course_id::text=$2->>'sourceId' AND r.course_revision::text=$2->>'revision' AND r.revision_id::text=$2->>'revisionId' AND h.status='available' AND r.generation->>'kind'='recorded-segment'$query$;
 WHEN 'course-head-descriptor' THEN q:=$query$SELECT jsonb_build_object('status',status,'courseId',course_id,'name',name,'visibility',visibility,'headRevision',head_revision,'revisionId',revision_id,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS body FROM public.course WHERE athlete_id=$1 AND course_id::text=$2->>'sourceId' AND head_revision::text=$2->>'revision' AND status='available'$query$;
 WHEN 'activity-track-descriptor' THEN q:=$query$SELECT jsonb_build_object('activityId',r.activity_id,'trackId',r.track_id,'trackRevision',r.track_revision,'sourceKind',r.source_kind,'sourceId',r.source_id,'sourceRevision',r.source_revision,'recordedSourceKind',r.recorded_source_kind,'correspondence',jsonb_build_object('algorithm','track-correspondence-v1','parserId',r.parser_id,'parserVersion',r.parser_version,'digest',r.correspondence_digest),'file',jsonb_build_object('originalFileName',r.original_filename,'format',r.format,'byteSize',r.raw_size_bytes,'sha256',r.raw_content_hash),'derivatives',jsonb_build_array(jsonb_build_object('kind','normalized','byteSize',r.normalized_size_bytes,'sha256',r.normalized_content_hash),jsonb_build_object('kind','map_path','byteSize',r.map_path_size_bytes,'sha256',r.map_path_content_hash)),'sampleCount',r.sample_count,'positionedSampleCount',r.positioned_sample_count,'segmentCount',r.segment_count,'segmentPolicy',r.segment_policy,'distances',r.distances,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS body FROM public.activity_track_revision r JOIN public.activity_canonical c ON c.athlete_id=r.athlete_id AND c.id=r.activity_id JOIN public.activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id AND h.kind=r.source_kind AND h.source_id=r.source_id AND h.source_revision=r.source_revision WHERE r.athlete_id=$1 AND r.activity_id::text=$2->>'sourceId' AND r.track_id::text=$2->>'trackId' AND r.track_revision::text=$2->>'revision' AND NOT c.deleted AND h.kind='manual' AND public.manual_race_v2_local_activity_state(c.id) IS NOT NULL$query$;
 WHEN 'supplementary-session-copy' THEN q:=$query$SELECT l.embedded_spec_json AS body FROM public.supplementary_session_link l JOIN public.plan_snapshot p ON p.athlete_id=l.athlete_id AND p.id=l.plan_version_id WHERE l.athlete_id=$1 AND l.plan_version_id::text=$2->>'sourceId' AND l.planned_session_id=$2->>'sessionId' AND l.content_kind='embedded' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.draft->'sessions') s WHERE s->>'id'=l.planned_session_id)$query$;
 WHEN 'race-timing-pin-fragment' THEN RETURN NULL;
 ELSE RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END CASE;
 EXECUTE 'WITH source AS ('||q||') SELECT count(*),coalesce(sum(octet_length(body::text)),0) FROM source' INTO n,bytes USING t,i;
 IF n<>1 OR bytes=0 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_UNAVAILABLE'; END IF;
 IF bytes>(CASE WHEN i->>'kind'='course-revision' THEN 4194304 ELSE 1049600 END) THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_BOUND'; END IF;
 EXECUTE q INTO STRICT body USING t,i;
 RETURN body;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_source_dto(jsonb) FROM PUBLIC;
CREATE FUNCTION public.manual_race_v2_guard_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=CASE WHEN TG_OP='DELETE' THEN OLD.athlete_id ELSE NEW.athlete_id END; seal public.manual_race_chain_commit_v2;
BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=t) THEN RAISE EXCEPTION 'IMMUTABLE_MANUAL_CHAIN'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME<>'manual_race_evidence_v2' THEN RAISE EXCEPTION 'IMMUTABLE_MANUAL_CHAIN'; END IF;
  IF OLD.payload IS NULL OR NEW.payload IS NOT NULL
   OR to_jsonb(NEW)-ARRAY['payload','purged_at','purged_event_id'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['payload','purged_at','purged_event_id']
   OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_suppression_v2 s WHERE s.athlete_id=t AND s.evidence_id=NEW.id AND s.event_id=NEW.purged_event_id AND s.occurred_at=NEW.purged_at AND s.original_payload_sql_digest=OLD.original_payload_sql_digest)
  THEN RAISE EXCEPTION 'IMMUTABLE_MANUAL_CHAIN'; END IF;
  RETURN NEW;
 END IF;
 PERFORM public.assert_manual_race_v2_caller();
 IF TG_TABLE_NAME='manual_race_chain_commit_v2' THEN
  IF NEW.caller_role<>session_user OR NEW.owner_xid<>txid_current() THEN RAISE EXCEPTION 'MANUAL_CHAIN_SEAL_REQUIRED'; END IF;
 ELSE
  SELECT * INTO seal FROM public.manual_race_chain_commit_v2 c WHERE c.athlete_id=t AND c.evidence_id=CASE WHEN TG_TABLE_NAME='manual_race_evidence_v2' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'evidence_id')::uuid END;
  IF NOT FOUND OR seal.caller_role<>session_user OR seal.owner_xid<>txid_current() THEN RAISE EXCEPTION 'MANUAL_CHAIN_SEAL_REQUIRED'; END IF;
  IF TG_TABLE_NAME='manual_race_evidence_v2' AND seal.payload_hash<>sha256(convert_to((to_jsonb(NEW)->'payload')::text,'UTF8')) THEN RAISE EXCEPTION 'MANUAL_CHAIN_SEAL_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_guard_mutation() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['manual_race_evidence_v2','manual_race_decision_v2','manual_race_proposal_v2','manual_race_chain_source_ref_v2','manual_race_chain_lifecycle_edge_v2','manual_race_chain_receipt_v2','manual_race_chain_commit_v2'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_manual_chain BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.manual_race_v2_guard_mutation()',t);
  EXECUTE format('CREATE TRIGGER immutable_manual_chain_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION public.manual_race_v2_utf16_key(s text) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE cp integer; result integer[]:='{}'; ch text; BEGIN
 FOR ch IN SELECT regexp_split_to_table(s,'') LOOP
  cp:=ascii(ch); IF cp>65535 THEN cp:=cp-65536; result:=array_append(result,55296+cp/1024); result:=array_append(result,56320+cp%1024);
  ELSE result:=array_append(result,cp); END IF;
 END LOOP; RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_utf16_key(text) FROM PUBLIC;
CREATE FUNCTION public.read_manual_race_chain_receipt_v2(receipt_key text,request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.manual_race_chain_receipt_v2; t text:=nullif(current_setting('app.athlete_id',true),''); BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 IF t IS NULL OR EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=t) THEN RAISE EXCEPTION 'MANUAL_CHAIN_TENANT_UNAVAILABLE'; END IF;
 IF request IS NULL OR octet_length(request::text)>4194304 THEN RAISE EXCEPTION 'MANUAL_CHAIN_INPUT_BOUND'; END IF;
 SELECT * INTO r FROM public.manual_race_chain_receipt_v2 q WHERE q.athlete_id=t AND q.receipt_key=$1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF r.request_digest IS DISTINCT FROM sha256(convert_to($2::text,'UTF8')) THEN RAISE EXCEPTION 'MANUAL_CHAIN_IDEMPOTENCY_CONFLICT'; END IF;
 RETURN r.result;
END $$;
REVOKE ALL ON FUNCTION public.read_manual_race_chain_receipt_v2(text,jsonb) FROM PUBLIC;
CREATE FUNCTION public.read_manual_race_chain_v2(evidence_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 SELECT jsonb_build_object('schemaVersion',2,'result',r.result,'payload',e.payload) INTO result
 FROM public.manual_race_evidence_v2 e JOIN public.manual_race_chain_receipt_v2 r ON r.athlete_id=e.athlete_id AND r.evidence_id=e.id
 WHERE e.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND e.id=$1
 AND NOT EXISTS(SELECT 1 FROM public.tenant_erasure t WHERE t.athlete_id=e.athlete_id);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_manual_race_chain_v2(uuid) FROM PUBLIC;
CREATE FUNCTION public.store_manual_race_chain_v2(evidence_id uuid,decision_id uuid,proposal_id uuid,
 receipt_key text,request jsonb,payload jsonb,basis jsonb,lifecycle jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); prior jsonb; inner_payload jsonb; refs jsonb; observed jsonb; parents jsonb;
 r jsonb; i jsonb; f jsonb; e jsonb; location text; dto jsonb; copied jsonb; current_value jsonb; expected_value jsonb;
 result jsonb; stamp timestamptz:=clock_timestamp(); apprev integer; ordinal integer:=0; bytes bigint:=0; count bigint:=0; domain text; table_name text; id_field text;
 policy constant text:='{"id":"manual-race-date-impact","version":1,"existingUnresolved":"preserve_with_notice","affectedUnresolved":"resolve_before_approval","actualRecords":"preserve","application":"explicit_user_approval","calendarMovement":"civil_date","unknownRaceEnd":"remain_unresolved"}';
BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 IF t IS NULL OR current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN RAISE EXCEPTION 'MANUAL_CHAIN_SNAPSHOT_REQUIRED'; END IF;
 PERFORM public.assert_manual_review_global_lock(); PERFORM public.assert_manual_review_lifecycle_lock(t);
 PERFORM pg_advisory_xact_lock(hashtextextended(t,0));
 PERFORM public.manual_race_v2_assert_json_bound($5); PERFORM public.manual_race_v2_assert_json_bound($6); PERFORM public.manual_race_v2_assert_json_bound($7); PERFORM public.manual_race_v2_assert_json_bound($8);
 prior:=public.read_manual_race_chain_receipt_v2($4,$5); IF prior IS NOT NULL THEN RETURN prior; END IF;
 IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $1=$2 OR $1=$3 OR $2=$3
  OR $4 IS NULL OR length($4) NOT BETWEEN 8 AND 128 OR $4 !~ '^[ -~]+$'
  OR jsonb_typeof($5) IS DISTINCT FROM 'object' OR $5-ARRAY['schemaVersion','idempotencyKey','intent','expectedBasis']<>'{}'::jsonb
  OR NOT($5 ?& ARRAY['schemaVersion','idempotencyKey','intent','expectedBasis']) OR $5->>'schemaVersion'<>'2' OR $5->>'idempotencyKey' IS DISTINCT FROM $4
  OR octet_length($5::text)>4194304 OR octet_length($6::text)>4194304 OR octet_length($7::text)>4194304 OR octet_length($8::text)>4194304
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_INVALID_INPUT'; END IF;
 apprev:=public.require_app_admission_revision(($7->'manualBasis'->'app'->>'revision')::int);
 IF jsonb_typeof($7->'dependencyHeads') IS DISTINCT FROM 'array' OR jsonb_array_length($7->'dependencyHeads')<>7 OR (SELECT count(DISTINCT x->>'kind') FROM jsonb_array_elements($7->'dependencyHeads') x)<>7 OR $7->>'athleteId' IS DISTINCT FROM t OR $7->>'basisVersion' IS DISTINCT FROM '2'
  OR $7->>'restoreGeneration' IS DISTINCT FROM public.current_restore_generation()::text
  OR $7->'manualBasis'->>'purpose' IS DISTINCT FROM 'manual_race_date_change'
  OR $7->'manualBasis'->'app' IS DISTINCT FROM jsonb_build_object('state','present','granted',true,'revision',apprev)
  OR $7->'manualBasis'->'policy' IS DISTINCT FROM jsonb_build_object('id','manual-race-date-impact','version',1,'digest',encode(sha256(convert_to(policy,'UTF8')),'hex'))
  OR $5->'expectedBasis' IS DISTINCT FROM $7 OR $5->'intent' IS DISTINCT FROM $7->'intent'
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 IF $6->>'state' IS DISTINCT FROM 'present' OR $6->>'status' IS DISTINCT FROM 'structurally_corresponding'
  OR $6->'minimalAudit'->>'athleteId' IS DISTINCT FROM t OR $6->'payload'->'preparation'->'context'->>'athleteId' IS DISTINCT FROM t
  OR $6->'payload'->'preparation'->'context'->>'restoreGeneration' IS DISTINCT FROM $7->>'restoreGeneration'
  OR $6->'payload'->'preparation'->'context'->'event' IS DISTINCT FROM $7->'event'
  OR $6->'payload'->'preparation'->'candidate'->>'status' IS DISTINCT FROM 'assembled_readonly'
  OR $6->'payload'->'preparation'->'candidate'->>'digest' IS DISTINCT FROM $6->'minimalAudit'->>'candidateDigest'
  OR $6->'minimalAudit'->>'candidateDigest' !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_INVALID_PAYLOAD'; END IF;
 inner_payload:=$6->'payload';
 SELECT coalesce(jsonb_agg(x->'identity' ORDER BY n),'[]'::jsonb) INTO refs FROM jsonb_array_elements(inner_payload->'inventory'->'refs') WITH ORDINALITY a(x,n);
 refs:=public.manual_race_v2_normalize_refs(refs);
 IF (SELECT count(*) FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event')<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event' AND x->>'sourceId'=$7->'event'->>'id' AND x->>'revision'=$7->'event'->>'revision')
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
 IF $8->>'status' IS DISTINCT FROM 'dependency_correspondence' OR $8->>'athleteId' IS DISTINCT FROM t
  OR jsonb_array_length($8->'facts')<>jsonb_array_length(parents) THEN RAISE EXCEPTION 'MANUAL_CHAIN_PARENT_MISMATCH'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(parents) LOOP
  SELECT value INTO e FROM jsonb_array_elements($8->'facts') x WHERE x->'identity'=f->'identity';
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
  expected_value:=$7->'heads'->domain;
  IF expected_value IS DISTINCT FROM (CASE WHEN jsonb_array_length(current_value)=0 THEN jsonb_build_object('state','absent') ELSE jsonb_build_object('state','present','members',current_value) END) THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 END LOOP;
 SELECT jsonb_build_object('aggregateId',h.aggregate_id,'snapshot',jsonb_build_object('id',s.id,'version',s.version,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'draft',s.draft)) INTO current_value FROM public.plan_head h JOIN public.plan_snapshot s ON s.athlete_id=h.athlete_id AND s.id=h.version_id WHERE h.athlete_id=t;
 IF coalesce(current_value,'null'::jsonb) IS DISTINCT FROM $7->'currentTraining' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 SELECT values_json||jsonb_build_object('id',id,'revision',revision) INTO current_value FROM public.race_event WHERE athlete_id=t AND id::text=$7->'event'->>'id' AND revision::text=$7->'event'->>'revision' AND NOT deleted;
 IF current_value IS DISTINCT FROM $7->'event' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements($7->'dependencyHeads') LOOP
  IF f->>'kind'<>ALL(ARRAY['intake_revision','activity_revision','execution_revision','set_revision','routine_run_revision','routine_occurrence_revision','recovery_action_revision']) THEN RAISE EXCEPTION 'MANUAL_CHAIN_INVALID_BASIS'; END IF;
  EXECUTE format('SELECT jsonb_build_object(''kind'',$2,''state'',''present'',''revision'',%I) FROM public.integrated_dependency_head WHERE athlete_id=$1',f->>'kind') INTO current_value USING t,f->>'kind';
  IF coalesce(current_value,jsonb_build_object('kind',f->>'kind','state','absent')) IS DISTINCT FROM f THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 END LOOP;
 SELECT jsonb_build_object('kind',kind,'revision',revision,'privacy_generation',privacy_generation::text) INTO current_value FROM public.race_collection_head WHERE athlete_id=t AND kind='race-event';
 IF coalesce(current_value,'null'::jsonb) IS DISTINCT FROM $7->'eventCollection' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 -- Same actual core ledgers as capture; unrelated AI consent/summary/time are excluded.
 SELECT jsonb_build_object('schemaVersion',2,'scope','core-ledgers-v2','athleteId',t,
  'trainingPlan',coalesce((SELECT jsonb_build_object('kind','exists','versionId',version_id) FROM public.plan_head WHERE athlete_id=t),'{"kind":"absent"}'::jsonb),
  'checkIns',coalesce((SELECT jsonb_build_object('kind','exists','revision',revision) FROM public.check_in_collection_head WHERE athlete_id=t),'{"kind":"absent"}'::jsonb),
  'sessionCompletions',coalesce((SELECT jsonb_build_object('kind','exists','revision',revision) FROM public.session_completion_collection_head WHERE athlete_id=t),'{"kind":"absent"}'::jsonb),
  'userConstraints',coalesce((SELECT jsonb_build_object('kind','exists','revision',revision) FROM public.coaching_constraint_head WHERE athlete_id=t),'{"kind":"absent"}'::jsonb)) INTO current_value;
 IF current_value IS DISTINCT FROM $7->'core' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 SELECT count(*),coalesce(sum(octet_length(to_jsonb(c)::text)),0) INTO count,bytes FROM public.activity_canonical c WHERE c.athlete_id=t;
 IF count>5000 OR bytes>4194304 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_BOUND'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'revision',c.revision,'deleted',c.deleted,
  'overlay',jsonb_build_object('state',CASE WHEN EXISTS(SELECT 1 FROM public.activity_overlay o WHERE o.athlete_id=c.athlete_id AND o.activity_id=c.id) THEN 'present' ELSE 'absent' END,'revision',(SELECT max(revision) FROM public.activity_overlay_revision o WHERE o.athlete_id=c.athlete_id AND o.activity_id=c.id)),
  'source',CASE WHEN h.kind IS NULL THEN jsonb_build_object('state','absent') ELSE jsonb_build_object('state','present','kind',h.kind,'sourceId',h.source_id,'revision',h.source_revision,'contentHash',h.content_hash,
   'suppressed',EXISTS(SELECT 1 FROM public.activity_suppression z WHERE z.athlete_id=c.athlete_id AND z.kind=h.kind AND z.source_id=h.source_id),
   'revisionRecord',jsonb_build_object('state',CASE WHEN EXISTS(SELECT 1 FROM public.activity_source_revision v WHERE v.athlete_id=h.athlete_id AND v.kind=h.kind AND v.source_id=h.source_id AND v.source_revision=h.source_revision AND v.content_hash=h.content_hash) THEN 'present' ELSE 'absent' END)) END) ORDER BY c.id),'[]'::jsonb) INTO current_value
 FROM public.activity_canonical c LEFT JOIN public.activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id WHERE c.athlete_id=t;
 IF current_value IS DISTINCT FROM $7->'activities' THEN RAISE EXCEPTION 'MANUAL_CHAIN_STALE_BASIS'; END IF;
 IF $7->'consumedUses'->>'purpose' IS DISTINCT FROM 'manual_race_date_change' OR $7->'consumedUses'->>'purposeProjectionVersion' IS DISTINCT FROM '2'
  OR jsonb_typeof($7->'consumedUses'->'facts') IS DISTINCT FROM 'array' OR jsonb_array_length($7->'consumedUses'->'facts')<>jsonb_array_length(refs) THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(refs) LOOP
  SELECT count(*) INTO count FROM jsonb_array_elements($7->'consumedUses'->'facts') x WHERE x->'identity'=i;
  IF count<>1 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  SELECT value INTO f FROM jsonb_array_elements($7->'consumedUses'->'facts') x WHERE x->'identity'=i;
  IF f->>'reason' IS NOT NULL OR f->>'use' IS DISTINCT FROM (CASE WHEN i->>'kind'='resource-text-version' THEN 'own_retained_text' ELSE 'core_manual' END)
   OR f->'resourceSource' IS DISTINCT FROM (CASE WHEN i->>'kind'='resource-text-version' THEN jsonb_build_object('deleted',false) ELSE 'null'::jsonb END)
  THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
  IF i->>'kind' IN ('course-revision','course-head-descriptor','activity-track-descriptor') AND inner_payload->'preparation'->'context'->'course'->'ref' IS DISTINCT FROM $7->'event'->'course' THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE'; END IF;
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
 result:=jsonb_build_object('schemaVersion',2,'evidenceId',$1,'decisionId',$2,'proposalId',$3,'candidateDigest',$6->'minimalAudit'->>'candidateDigest','createdAt',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'applicable',false,'approvalAllowed',false);
 INSERT INTO public.manual_race_chain_commit_v2 VALUES(t,$1,session_user,txid_current(),sha256(convert_to($6::text,'UTF8')));
 INSERT INTO public.manual_race_evidence_v2 VALUES(t,$1,$2,$3,stamp,$4,$6->'minimalAudit'->>'candidateDigest',encode(sha256(convert_to($6::text,'UTF8')),'hex'),$6,NULL,NULL);
 INSERT INTO public.manual_race_decision_v2 VALUES(t,$2,$1);
 INSERT INTO public.manual_race_proposal_v2 VALUES(t,$3,$1,$2,false);
 FOR r IN SELECT value FROM jsonb_array_elements(inner_payload->'inventory'->'refs') LOOP
  ordinal:=ordinal+1;
  SELECT value INTO f FROM jsonb_array_elements(observed->'rows') x WHERE x->'identity'=r->'identity';
  INSERT INTO public.manual_race_chain_source_ref_v2 VALUES(t,$1,ordinal,r->'identity',sha256(convert_to((r->'identity')::text,'UTF8')),r->>'dtoDigest',r->'copiedLocations',f->'relations');
  SELECT value INTO f FROM jsonb_array_elements(parents) x WHERE x->'identity'=r->'identity';
  FOR e IN SELECT value FROM jsonb_array_elements(f->'edges') LOOP
   INSERT INTO public.manual_race_chain_lifecycle_edge_v2 VALUES(t,$1,ordinal,sha256(convert_to(e::text,'UTF8')),e);
  END LOOP;
 END LOOP;
 INSERT INTO public.manual_race_chain_receipt_v2 VALUES(t,$4,sha256(convert_to($5::text,'UTF8')),result,$1);
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload) VALUES(t,$3,'manual-race-chain:'||$3::text,'manual.race_chain_prepared',result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;

-- Exact original event correspondence. No UUID/hash/GUC by itself authorizes a purge.
CREATE FUNCTION public.manual_race_v2_event_edges(event public.restore_suppression_event) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE f text; s text; v text; BEGIN
 IF event.kind='tenant_erased' THEN RETURN jsonb_build_object('family','tenant','sourceId',event.athlete_id,'versionKey',NULL); END IF;
 IF event.record_version=7 THEN
  RETURN jsonb_build_object('identity',event.manual_review_v2_source_identity,'scope',event.manual_review_v2_version_scope);
 END IF;
 CASE event.kind
 WHEN 'race_event_deleted' THEN f:='race-event'; s:=event.target_id::text;
 WHEN 'resource_deleted' THEN f:='resource'; s:=event.target_id::text;
 WHEN 'gallery_media_deleted' THEN f:='gallery-media'; s:=event.target_id::text;
 WHEN 'activity_deleted' THEN f:='activity'; s:=event.target_id::text;
 WHEN 'course_deleted' THEN f:='course'; s:=event.target_id::text;
 WHEN 'intake_entry_deleted' THEN f:='intake-origin'; s:=event.target_id::text;
 WHEN 'check_in_deleted' THEN f:='checkin'; s:=event.target_id::text;
 WHEN 'manual_review_source_suppressed' THEN
  IF event.record_version<>6 THEN RETURN NULL; END IF;
  f:=CASE event.manual_review_source_kind WHEN 'nutrition-plan-version' THEN 'nutrition-plan' WHEN 'recovery-strategy-version' THEN 'recovery-strategy' WHEN 'routine-schedule-version' THEN 'routine-schedule' WHEN 'routine-blueprint-version' THEN 'routine-blueprint' WHEN 'resource-text-version' THEN 'resource' WHEN 'gallery-descriptor' THEN 'gallery-media' WHEN 'course-revision' THEN 'course' WHEN 'course-head-descriptor' THEN 'course' WHEN 'activity-track-descriptor' THEN 'activity-track' ELSE event.manual_review_source_kind END;
  s:=event.manual_review_source_id;
  IF event.manual_review_version_scope='exact_version' THEN v:=event.manual_review_version_key; END IF;
 ELSE RETURN NULL; END CASE;
 RETURN jsonb_build_object('family',f,'sourceId',s,'versionKey',v);
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_event_edges(public.restore_suppression_event) FROM PUBLIC;
CREATE FUNCTION public.manual_race_v2_event_matches_ref(event public.restore_suppression_event,identity jsonb,edge jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE target jsonb; family text; version text; source text; BEGIN
 target:=public.manual_race_v2_event_edges(event);
 IF target IS NULL THEN RETURN false; END IF;
 IF target->>'family'='tenant' THEN RETURN true; END IF;
 IF event.record_version<>7 THEN RETURN edge->>'family'=target->>'family' AND edge->>'sourceId'=target->>'sourceId' AND (target->>'versionKey' IS NULL OR edge->>'versionKey'=target->>'versionKey'); END IF;
 IF public.manual_race_v2_event_match(identity,target->'identity',target->>'scope') THEN RETURN true; END IF;
 IF target->'identity'->>'kind' IN ('routine-timer','checklist-confirmation','manual-activity-source','activity-overlay','activity-canonical-values','supplementary-session-copy') THEN RETURN false; END IF;
 source:=target->'identity'->>'sourceId';
 family:=CASE target->'identity'->>'kind' WHEN 'nutrition-plan-version' THEN 'nutrition-plan' WHEN 'recovery-strategy-version' THEN 'recovery-strategy' WHEN 'recovery-method-version' THEN 'recovery-method' WHEN 'food-definition-version' THEN 'food-definition' WHEN 'workout-template-version' THEN 'workout-template' WHEN 'supplementary-exercise-version' THEN 'supplementary-exercise' WHEN 'routine-schedule-version' THEN 'routine-schedule' WHEN 'routine-blueprint-version' THEN 'routine-blueprint' WHEN 'resource-text-version' THEN 'resource' WHEN 'gallery-descriptor' THEN 'gallery-media' WHEN 'course-revision' THEN 'course' WHEN 'course-head-descriptor' THEN 'course' WHEN 'activity-track-descriptor' THEN 'activity-track' ELSE target->'identity'->>'kind' END;
 version:=CASE target->'identity'->>'kind' WHEN 'activity-track-descriptor' THEN replace(jsonb_build_array(target->'identity'->>'trackId',(target->'identity'->>'revision')::int)::text,', ', ',') WHEN 'course-revision' THEN replace(jsonb_build_array(target->'identity'->>'revisionId',(target->'identity'->>'revision')::int)::text,', ', ',') ELSE coalesce(target->'identity'->>'versionId',target->'identity'->>'version',target->'identity'->>'revision') END;
 -- These are actual parent edges only, not a global sourceId namespace guess.
 RETURN edge->>'family'=family AND edge->>'sourceId'=source AND (target->>'scope'='all_versions' OR edge->>'versionKey'=version OR (family='plan-snapshot' AND edge->>'role'='parent' AND edge->>'versionKey' IS NULL));
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_event_matches_ref(public.restore_suppression_event,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION public.suppress_manual_race_chain_from_event_v2(event_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event public.restore_suppression_event; review public.manual_race_evidence_v2; BEGIN
 SELECT * INTO STRICT event FROM public.restore_suppression_event e WHERE e.event_id=$1 AND e.athlete_id=nullif(current_setting('app.athlete_id',true),'');
 IF public.manual_race_v2_event_edges(event) IS NULL THEN RETURN; END IF;
 PERFORM public.assert_manual_review_global_lock(); PERFORM public.assert_manual_review_lifecycle_lock(event.athlete_id);
 FOR review IN SELECT DISTINCT h.* FROM public.manual_race_evidence_v2 h
 JOIN public.manual_race_chain_source_ref_v2 r ON r.athlete_id=h.athlete_id AND r.evidence_id=h.id
 JOIN public.manual_race_chain_lifecycle_edge_v2 l ON l.athlete_id=r.athlete_id AND l.evidence_id=r.evidence_id AND l.ordinal=r.ordinal
 WHERE h.athlete_id=event.athlete_id AND public.manual_race_v2_event_matches_ref(event,r.identity,l.edge)
 ORDER BY h.id LOOP
  PERFORM 1 FROM public.manual_race_evidence_v2 h WHERE h.athlete_id=review.athlete_id AND h.id=review.id FOR UPDATE;
  INSERT INTO public.manual_race_chain_suppression_v2 VALUES(review.athlete_id,review.id,event.event_id,event.occurred_at,review.original_payload_sql_digest) ON CONFLICT DO NOTHING;
  IF review.payload IS NOT NULL THEN UPDATE public.manual_race_evidence_v2 SET payload=NULL,purged_at=event.occurred_at,purged_event_id=event.event_id WHERE athlete_id=review.athlete_id AND id=review.id; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.suppress_manual_race_chain_from_event_v2(uuid) FROM PUBLIC;
CREATE FUNCTION public.manual_race_v2_suppression_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.restore_suppression_event; BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=OLD.athlete_id) THEN RETURN OLD; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMMUTABLE_MANUAL_CHAIN_SUPPRESSION'; END IF;
 SELECT * INTO e FROM public.restore_suppression_event WHERE athlete_id=NEW.athlete_id AND event_id=NEW.event_id;
 IF e.event_id IS NULL OR e.occurred_at<>NEW.occurred_at OR NOT EXISTS(
  SELECT 1 FROM public.manual_race_chain_source_ref_v2 r JOIN public.manual_race_chain_lifecycle_edge_v2 l ON l.athlete_id=r.athlete_id AND l.evidence_id=r.evidence_id AND l.ordinal=r.ordinal
  JOIN public.manual_race_evidence_v2 h ON h.athlete_id=r.athlete_id AND h.id=r.evidence_id
  WHERE r.athlete_id=NEW.athlete_id AND r.evidence_id=NEW.evidence_id AND h.original_payload_sql_digest=NEW.original_payload_sql_digest AND public.manual_race_v2_event_matches_ref(e,r.identity,l.edge))
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_ORIGINAL_EVENT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_suppression_guard() FROM PUBLIC;
CREATE TRIGGER manual_race_suppression_guard BEFORE INSERT OR UPDATE OR DELETE ON public.manual_race_chain_suppression_v2 FOR EACH ROW EXECUTE FUNCTION public.manual_race_v2_suppression_guard();
CREATE TRIGGER manual_race_suppression_no_truncate BEFORE TRUNCATE ON public.manual_race_chain_suppression_v2 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE FUNCTION public.manual_race_v2_event_posthook() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF public.manual_race_v2_event_edges(NEW) IS NOT NULL AND EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 WHERE athlete_id=NEW.athlete_id) THEN
  PERFORM public.suppress_manual_race_chain_from_event_v2(NEW.event_id);
 END IF; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_event_posthook() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER manual_race_v2_event_posthook AFTER INSERT ON public.restore_suppression_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manual_race_v2_event_posthook();

-- This private row exists only while a real DELETE trigger issues a v7 event.
-- Its identity is not a user/owner credential and is never exported.
CREATE TABLE public.manual_race_v2_live_transition (
 athlete_id text NOT NULL,event_id uuid NOT NULL,identity jsonb NOT NULL,occurred_at timestamptz NOT NULL,
 owner_xid bigint NOT NULL,caller_role name NOT NULL,version_scope text NOT NULL CHECK(version_scope IN ('exact_identity','all_versions')),PRIMARY KEY(athlete_id,event_id)
);
REVOKE ALL ON public.manual_race_v2_live_transition FROM PUBLIC;
ALTER TABLE public.manual_race_v2_live_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_race_v2_live_transition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.manual_race_v2_live_transition USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
CREATE FUNCTION public.manual_race_v2_live_transition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'MANUAL_CHAIN_ACTUAL_TRANSITION_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM public.assert_manual_race_v2_caller();
 IF TG_OP='INSERT' AND (NEW.owner_xid<>txid_current() OR NEW.caller_role<>session_user OR NEW.athlete_id<>nullif(current_setting('app.athlete_id',true),'')) THEN RAISE EXCEPTION 'MANUAL_CHAIN_ACTUAL_TRANSITION_REQUIRED' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_MANUAL_CHAIN_TRANSITION'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_live_transition_guard() FROM PUBLIC;
CREATE TRIGGER manual_race_v2_live_transition_guard BEFORE INSERT OR UPDATE OR DELETE ON public.manual_race_v2_live_transition FOR EACH ROW EXECUTE FUNCTION public.manual_race_v2_live_transition_guard();
CREATE FUNCTION public.verify_manual_race_v2_event_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NEW.record_version<>7 THEN
  IF NEW.manual_review_v2_source_identity IS NOT NULL OR NEW.manual_review_v2_version_scope IS NOT NULL THEN RAISE EXCEPTION 'MANUAL_CHAIN_EVENT_FIELDS_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.kind<>'manual_review_source_suppressed_v2' OR NEW.manual_review_v2_version_scope NOT IN ('exact_identity','all_versions')
  OR NOT EXISTS(SELECT 1 FROM public.manual_race_v2_live_transition c WHERE c.athlete_id=NEW.athlete_id AND c.event_id=NEW.event_id AND c.identity=NEW.manual_review_v2_source_identity AND c.version_scope=NEW.manual_review_v2_version_scope AND c.occurred_at=NEW.occurred_at AND c.owner_xid=txid_current() AND c.caller_role=session_user)
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_ACTUAL_TRANSITION_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_manual_race_v2_event_transition() FROM PUBLIC;
CREATE TRIGGER verify_manual_race_v2_event_transition BEFORE INSERT ON public.restore_suppression_event FOR EACH ROW EXECUTE FUNCTION public.verify_manual_race_v2_event_transition();

-- Deferred source hooks see the original producer event before privacy removal is committed.
-- Corrections/current-head movement are not privacy deletion.
CREATE FUNCTION public.manual_race_v2_source_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o jsonb:=to_jsonb(OLD); n jsonb; t text:=OLD.athlete_id; family text; source text; version text; identity jsonb;
 event public.restore_suppression_event; target uuid; scope text:='exact_identity'; stamp timestamptz:=statement_timestamp(); id uuid; e jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  n:=to_jsonb(NEW);
  IF TG_TABLE_NAME IN ('race_event','activity_canonical','check_in') THEN
   IF coalesce((o->>'deleted')::boolean,false) OR NOT coalesce((n->>'deleted')::boolean,false) THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME IN ('resource','gallery_media_item') THEN
   IF o->>'deleted_at' IS NOT NULL OR n->>'deleted_at' IS NULL THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='intake_entry' THEN
   IF o->>'status'='deleted' OR n->>'status'<>'deleted' THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='course' THEN
   IF o->>'status'='deleted' OR n->>'status'<>'deleted' THEN RETURN NULL; END IF;
  ELSE RETURN NULL; END IF;
 END IF;
 CASE TG_TABLE_NAME
 WHEN 'race_event' THEN family:='race-event'; source:=o->>'id'; version:=NULL; identity:=jsonb_build_object('kind','race-event','sourceId',o->>'id','revision',(o->>'revision')::int);
 WHEN 'plan_snapshot' THEN family:='plan-snapshot'; source:=o->>'id'; version:=o->>'version'; identity:=jsonb_build_object('kind','plan-snapshot','sourceId',o->>'id','version',(o->>'version')::int);
 WHEN 'nutrition_plan_version' THEN family:='nutrition-plan'; source:=o->>'plan_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','nutrition-plan-version','sourceId',o->>'plan_id','versionId',o->>'version_id');
 WHEN 'recovery_strategy_version' THEN family:='recovery-strategy'; source:=o->>'strategy_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','recovery-strategy-version','sourceId',o->>'strategy_id','versionId',o->>'version_id');
 WHEN 'recovery_method_version' THEN family:='recovery-method'; source:=o->>'method_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','recovery-method-version','sourceId',o->>'method_id','versionId',o->>'version_id');
 WHEN 'food_definition_version' THEN family:='food-definition'; source:=o->>'food_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','food-definition-version','sourceId',o->>'food_id','versionId',o->>'version_id');
 WHEN 'supplementary_routine_version' THEN family:='workout-template'; source:=o->>'routine_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','workout-template-version','sourceId',o->>'routine_id','versionId',o->>'version_id');
 WHEN 'supplementary_exercise_version' THEN family:='supplementary-exercise'; source:=o->>'exercise_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','supplementary-exercise-version','sourceId',o->>'exercise_id','versionId',o->>'version_id');
 WHEN 'routine_schedule_version' THEN family:='routine-schedule'; source:=o->>'schedule_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','routine-schedule-version','sourceId',o->>'schedule_id','versionId',o->>'version_id');
 WHEN 'routine_blueprint_version' THEN family:='routine-blueprint'; source:=o->>'routine_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','routine-blueprint-version','sourceId',o->>'routine_id','versionId',o->>'version_id');
 WHEN 'routine_occurrence' THEN family:='routine-occurrence'; source:=o->>'id'; version:=NULL; identity:=jsonb_build_object('kind','routine-occurrence','sourceId',o->>'id');
 WHEN 'routine_run' THEN family:='routine-run'; source:=o->>'id'; version:=NULL; identity:=jsonb_build_object('kind','routine-run','sourceId',o->>'id','revision',(o->>'revision')::int);
 WHEN 'routine_run_revision' THEN family:='routine-run'; source:=o->>'run_id'; version:=o->>'revision'; identity:=jsonb_build_object('kind','routine-run','sourceId',o->>'run_id','revision',(o->>'revision')::int);
 WHEN 'session_completion_revision' THEN family:='session-completion'; source:=o->>'session_id'; version:=replace(jsonb_build_array(o->'record_json'->>'planVersionId',(o->>'revision')::int)::text,', ', ','); identity:=jsonb_build_object('kind','session-completion','sourceId',o->>'session_id','planVersionId',o->'record_json'->>'planVersionId','revision',(o->>'revision')::int);
 WHEN 'routine_checklist_confirmation' THEN family:='checklist-confirmation'; source:=o->>'id'; version:=o->>'revision_id'; identity:=jsonb_build_object('kind','checklist-confirmation','sourceId',o->>'id','revisionId',o->>'revision_id','runId',o->>'run_id','stepId',o->>'step_id');
 WHEN 'routine_step_timer' THEN family:='routine-run'; source:=o->>'run_id'; version:=replace(jsonb_build_array(o->>'step_id',(o->>'revision')::int)::text,', ', ','); identity:=jsonb_build_object('kind','routine-timer','sourceId',o->>'run_id','stepId',o->>'step_id','revision',(o->>'revision')::int);
 WHEN 'resource' THEN family:='resource'; source:=o->>'id'; version:=NULL; identity:=NULL;
 WHEN 'resource_version' THEN family:='resource'; source:=o->>'resource_id'; version:=o->>'version_id'; identity:=jsonb_build_object('kind','resource-text-version','sourceId',o->>'resource_id','versionId',o->>'version_id');
 WHEN 'gallery_media_item' THEN family:='gallery-media'; source:=o->>'id'; version:=NULL; identity:=NULL;
 WHEN 'activity_canonical' THEN family:='activity'; source:=o->>'id'; version:=NULL; identity:=NULL;
 WHEN 'activity_source_revision' THEN
  IF o->>'kind'<>'manual' THEN RETURN NULL; END IF;
  SELECT min(r.identity->>'sourceId') INTO source FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=t AND r.identity->>'kind'='manual-activity-source' AND r.identity->>'sourceRecordId'=o->>'source_id' AND r.identity->>'sourceRevision'=o->>'source_revision';
  IF source IS NULL THEN RETURN NULL; END IF;
  IF (SELECT count(DISTINCT r.identity->>'sourceId') FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=t AND r.identity->>'kind'='manual-activity-source' AND r.identity->>'sourceRecordId'=o->>'source_id' AND r.identity->>'sourceRevision'=o->>'source_revision')<>1 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_PARENT_AMBIGUOUS'; END IF;
  family:='activity'; version:=replace(jsonb_build_array('manual',o->>'source_id',(o->>'source_revision')::int)::text,', ', ','); identity:=jsonb_build_object('kind','manual-activity-source','sourceId',source,'sourceRecordId',o->>'source_id','sourceRevision',(o->>'source_revision')::int);
 WHEN 'supplementary_session_link' THEN family:='plan-snapshot'; source:=o->>'plan_version_id'; version:=NULL; identity:=jsonb_build_object('kind','supplementary-session-copy','sourceId',o->>'plan_version_id','sessionId',o->>'planned_session_id');
 WHEN 'supplementary_session_target_ref' THEN family:='plan-snapshot'; source:=o->>'plan_version_id'; version:=NULL; identity:=jsonb_build_object('kind','supplementary-session-copy','sourceId',o->>'plan_version_id','sessionId',o->>'planned_session_id');
 WHEN 'supplementary_routine_target_ref' THEN
  SELECT min(r.identity->>'sourceId') INTO source FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=t AND r.identity->>'kind'='workout-template-version' AND r.identity->>'versionId'=o->>'routine_version_id';
  IF source IS NULL THEN RETURN NULL; END IF;
  IF (SELECT count(DISTINCT r.identity->>'sourceId') FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=t AND r.identity->>'kind'='workout-template-version' AND r.identity->>'versionId'=o->>'routine_version_id')<>1 THEN RAISE EXCEPTION 'MANUAL_CHAIN_SOURCE_PARENT_AMBIGUOUS'; END IF;
  family:='workout-template'; version:=o->>'routine_version_id'; identity:=jsonb_build_object('kind','workout-template-version','sourceId',source,'versionId',version);
 WHEN 'activity_overlay_revision' THEN family:='activity'; source:=o->>'activity_id'; version:=o->>'revision'; identity:=jsonb_build_object('kind','activity-overlay','sourceId',o->>'activity_id','revision',(o->>'revision')::int);
 WHEN 'activity_track_revision' THEN family:='activity-track'; source:=o->>'activity_id'; version:=replace(jsonb_build_array(o->>'track_id',(o->>'track_revision')::int)::text,', ', ','); identity:=jsonb_build_object('kind','activity-track-descriptor','sourceId',o->>'activity_id','trackId',o->>'track_id','revision',(o->>'track_revision')::int);
 WHEN 'course' THEN family:='course'; source:=o->>'course_id'; version:=NULL; identity:=NULL;
 WHEN 'course_revision' THEN family:='course'; source:=o->>'course_id'; version:=replace(jsonb_build_array(o->>'revision_id',(o->>'course_revision')::int)::text,', ', ','); identity:=jsonb_build_object('kind','course-revision','sourceId',o->>'course_id','revisionId',o->>'revision_id','revision',(o->>'course_revision')::int);
 WHEN 'intake_entry' THEN family:='intake'; source:=o->>'id'; version:=NULL; identity:=NULL;
 WHEN 'intake_entry_revision' THEN family:='intake'; source:=o->>'intake_id'; version:=o->>'revision_id'; identity:=jsonb_build_object('kind','intake-revision','sourceId',o->>'intake_id','revisionId',o->>'revision_id');
 WHEN 'check_in' THEN family:='checkin'; source:=o->>'id'; version:=NULL; identity:=NULL;
 WHEN 'check_in_revision' THEN family:='checkin'; source:=o->>'check_in_id'; version:=o->>'revision'; identity:=jsonb_build_object('kind','checkin-revision','sourceId',o->>'check_in_id','revision',(o->>'revision')::int);
 ELSE RAISE EXCEPTION 'MANUAL_CHAIN_UNKNOWN_TRANSITION'; END CASE;
 IF NOT EXISTS(SELECT 1 FROM public.manual_race_chain_lifecycle_edge_v2 l WHERE l.athlete_id=t AND l.edge->>'family'=family AND l.edge->>'sourceId'=source AND (version IS NULL OR l.edge->>'versionKey'=version)) THEN RETURN NULL; END IF;
 PERFORM public.assert_manual_review_global_lock(); PERFORM public.assert_manual_review_lifecycle_lock(t);
 PERFORM pg_advisory_xact_lock(hashtextextended(t,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,family,source)::text,77207));
 IF t IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'MANUAL_CHAIN_TENANT_MISMATCH'; END IF;
 SELECT * INTO event FROM public.restore_suppression_event x WHERE x.athlete_id=t AND (
 x.kind='tenant_erased'
 OR (family='race-event' AND x.kind='race_event_deleted' AND x.target_id::text=source)
 OR (family='resource' AND x.kind='resource_deleted' AND x.target_id::text=source)
 OR (family='gallery-media' AND x.kind='gallery_media_deleted' AND x.target_id::text=source)
 OR (family IN ('activity','activity-track') AND x.kind='activity_deleted' AND x.target_id::text=source)
 OR (family='course' AND x.kind='course_deleted' AND x.target_id::text=source)
 OR (family='course' AND x.kind='activity_deleted' AND EXISTS(SELECT 1 FROM public.manual_race_chain_lifecycle_edge_v2 a JOIN public.manual_race_chain_lifecycle_edge_v2 b ON b.athlete_id=a.athlete_id AND b.evidence_id=a.evidence_id AND b.ordinal=a.ordinal WHERE a.athlete_id=t AND a.edge->>'family'='course' AND a.edge->>'sourceId'=source AND b.edge->>'family'='activity' AND b.edge->>'role'='lineage' AND b.edge->>'sourceId'=x.target_id::text))
 OR (family='checkin' AND x.kind='check_in_deleted' AND x.target_id::text=source)
 OR (family='intake' AND x.kind='intake_entry_deleted' AND EXISTS(SELECT 1 FROM public.manual_race_chain_lifecycle_edge_v2 a JOIN public.manual_race_chain_lifecycle_edge_v2 b ON b.athlete_id=a.athlete_id AND b.evidence_id=a.evidence_id AND b.ordinal=a.ordinal WHERE a.athlete_id=t AND a.edge->>'family'='intake' AND a.edge->>'sourceId'=source AND b.edge->>'family'='intake-origin' AND b.edge->>'sourceId'=x.target_id::text)))
 ORDER BY CASE WHEN x.kind='tenant_erased' THEN 0 ELSE 1 END,x.occurred_at,x.event_id LIMIT 1;
 IF FOUND THEN PERFORM public.suppress_manual_race_chain_from_event_v2(event.event_id); RETURN NULL; END IF;
 IF identity IS NULL OR TG_OP<>'DELETE' THEN RAISE EXCEPTION 'MANUAL_CHAIN_ORIGINAL_EVENT_REQUIRED'; END IF;
 IF TG_TABLE_NAME IN ('routine_run','routine_step_timer') THEN scope:='all_versions'; END IF;
 SELECT * INTO event FROM public.restore_suppression_event x WHERE x.athlete_id=t AND x.record_version=7 AND public.manual_race_v2_event_match(identity,x.manual_review_v2_source_identity,x.manual_review_v2_version_scope) ORDER BY x.occurred_at,x.event_id LIMIT 1;
 IF FOUND THEN PERFORM public.suppress_manual_race_chain_from_event_v2(event.event_id); RETURN NULL; END IF;
 -- A new v7 event may be issued only by the actual runtime DELETE trigger. Owner
 -- maintenance needs authenticated originals; an owner/GUC cannot mint a deletion.
 PERFORM public.assert_manual_race_v2_caller();
 IF TG_TABLE_NAME IN ('routine_run','routine_step_timer') THEN scope:='all_versions'; END IF;
 id:=gen_random_uuid();
 INSERT INTO public.manual_race_v2_live_transition VALUES(t,id,identity,stamp,txid_current(),session_user,scope);
 INSERT INTO public.restore_suppression_event(event_id,record_version,athlete_id,kind,occurred_at,manual_review_v2_source_identity,manual_review_v2_version_scope)
 VALUES(id,7,t,'manual_review_source_suppressed_v2',stamp,identity,scope);
 PERFORM public.suppress_manual_race_chain_from_event_v2(id);
 DELETE FROM public.manual_race_v2_live_transition WHERE athlete_id=t AND event_id=id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_source_transition() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['race_event','plan_snapshot','nutrition_plan_version','recovery_strategy_version','recovery_method_version','food_definition_version','supplementary_routine_version','supplementary_exercise_version','routine_schedule_version','routine_blueprint_version','routine_occurrence','routine_run','routine_run_revision','session_completion_revision','routine_checklist_confirmation','routine_step_timer','resource','resource_version','gallery_media_item','activity_canonical','activity_source_revision','activity_overlay_revision','activity_track_revision','course','course_revision','intake_entry','intake_entry_revision','check_in','check_in_revision','supplementary_session_link','supplementary_session_target_ref','supplementary_routine_target_ref'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER manual_race_chain_privacy_delete AFTER DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manual_race_v2_source_transition()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['race_event','activity_canonical','check_in','resource','gallery_media_item','intake_entry','course'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER manual_race_chain_privacy_transition AFTER UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manual_race_v2_source_transition()',t);
 END LOOP;
END $$;
-- Erasure uses the existing authentic predecessor chain. All new body/audit rows
-- are removed in that transaction; app withdrawal remains a retained-read event.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_manual_race_v2;
REVOKE ALL ON FUNCTION public.erase_account_before_manual_race_v2(text) FROM PUBLIC;
DO $$ DECLARE role text; BEGIN
 FOR role IN SELECT DISTINCT grantee FROM information_schema.routine_privileges WHERE routine_schema='public' AND routine_name='erase_account_before_manual_race_v2' AND grantee NOT IN (current_user,'PUBLIC') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_manual_race_v2(text) FROM %I',role);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(athlete text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE stamp timestamptz; BEGIN
 stamp:=public.erase_account_before_manual_race_v2($1);
 DELETE FROM public.manual_race_chain_suppression_v2 WHERE athlete_id=$1;
 DELETE FROM public.manual_race_chain_lifecycle_edge_v2 WHERE athlete_id=$1;
 DELETE FROM public.manual_race_chain_source_ref_v2 WHERE athlete_id=$1;
 DELETE FROM public.manual_race_chain_receipt_v2 WHERE athlete_id=$1;
 DELETE FROM public.manual_race_proposal_v2 WHERE athlete_id=$1;
 DELETE FROM public.manual_race_decision_v2 WHERE athlete_id=$1;
 DELETE FROM public.manual_race_chain_commit_v2 WHERE athlete_id=$1;
 DELETE FROM public.manual_race_evidence_v2 WHERE athlete_id=$1;
 RETURN stamp;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;

CREATE FUNCTION public.manual_race_v2_assert_json_bound(body jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE n bigint; depth integer; BEGIN
 IF body IS NULL OR octet_length(body::text)>4194304 THEN RAISE EXCEPTION 'MANUAL_CHAIN_INPUT_BOUND'; END IF;
 WITH RECURSIVE walk(value,depth) AS (
  SELECT body,0 UNION ALL
  SELECT child.value,parent.depth+1 FROM walk parent CROSS JOIN LATERAL (
   SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(parent.value)='object' THEN parent.value ELSE '{}'::jsonb END)
   UNION ALL SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.value)='array' THEN parent.value ELSE '[]'::jsonb END)
  ) child WHERE parent.depth<=64
 ) SELECT count(*),max(walk.depth) INTO n,depth FROM walk;
 IF n>4194305 OR depth>64 THEN RAISE EXCEPTION 'MANUAL_CHAIN_INPUT_BOUND'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_assert_json_bound(jsonb) FROM PUBLIC;
CREATE FUNCTION public.manual_race_v2_chain_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE h public.manual_race_evidence_v2; expected integer; actual integer; BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'MANUAL_CHAIN_TENANT_MISMATCH'; END IF;
 SELECT * INTO h FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=NEW.athlete_id AND e.id=NEW.id;
 IF NOT FOUND AND EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=NEW.athlete_id) THEN RETURN NULL; END IF;
 IF h.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.manual_race_decision_v2 d WHERE d.athlete_id=h.athlete_id AND d.id=h.decision_id AND d.evidence_id=h.id)
  OR NOT EXISTS(SELECT 1 FROM public.manual_race_proposal_v2 p WHERE p.athlete_id=h.athlete_id AND p.id=h.proposal_id AND p.evidence_id=h.id AND p.decision_id=h.decision_id AND NOT p.applicable)
  OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_receipt_v2 r WHERE r.athlete_id=h.athlete_id AND r.evidence_id=h.id AND r.receipt_key=h.receipt_key AND r.result->>'evidenceId'=h.id::text AND r.result->>'decisionId'=h.decision_id::text AND r.result->>'proposalId'=h.proposal_id::text)
  OR NOT EXISTS(SELECT 1 FROM public.outbox o WHERE o.athlete_id=h.athlete_id AND o.id=h.proposal_id AND o.topic='manual.race_chain_prepared' AND o.payload->>'evidenceId'=h.id::text)
 THEN RAISE EXCEPTION 'MANUAL_CHAIN_ATOMIC_ARTIFACTS_REQUIRED'; END IF;
 IF h.payload IS NOT NULL THEN
  expected:=jsonb_array_length(h.payload->'payload'->'inventory'->'refs');
  SELECT count(*) INTO actual FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=h.athlete_id AND r.evidence_id=h.id;
  IF expected<>actual OR expected<1 OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=h.athlete_id AND r.evidence_id=h.id AND r.identity->>'kind'='race-event')
   OR EXISTS(SELECT 1 FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=h.athlete_id AND r.evidence_id=h.id AND NOT EXISTS(SELECT 1 FROM public.manual_race_chain_lifecycle_edge_v2 e WHERE e.athlete_id=r.athlete_id AND e.evidence_id=r.evidence_id AND e.ordinal=r.ordinal))
  THEN RAISE EXCEPTION 'MANUAL_CHAIN_ATOMIC_ARTIFACTS_REQUIRED'; END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.manual_race_v2_chain_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER manual_race_v2_chain_complete AFTER INSERT ON public.manual_race_evidence_v2 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manual_race_v2_chain_complete();

-- Existing authentic events can be re-applied under an actual CLOSED loader
-- descriptor. This is not an importer for JSON-claimed new original events.
CREATE FUNCTION public.replay_existing_manual_race_chain_v2(athlete text,event_id uuid,
 occurred_at timestamptz,source_identity jsonb,version_scope text,load_run uuid) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE original public.restore_suppression_event; descriptor wm_app_load.descriptor; own name;
BEGIN
 own:=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.manual_race_evidence_v2'::regclass));
 IF session_user<>own OR current_user<>own OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=own AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'MANUAL_CHAIN_REPLAY_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM public.assert_manual_review_replay_global_lock();
 descriptor:=wm_app_load.assert_context($6);
 IF descriptor.athlete_id IS DISTINCT FROM $1 OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'MANUAL_CHAIN_REPLAY_CONTEXT_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206)); PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 SELECT * INTO original FROM public.restore_suppression_event e WHERE e.athlete_id=$1 AND e.event_id=$2 AND e.record_version=7 AND e.kind='manual_review_source_suppressed_v2';
 IF NOT FOUND OR original.occurred_at IS DISTINCT FROM $3 OR original.manual_review_v2_source_identity IS DISTINCT FROM $4 OR original.manual_review_v2_version_scope IS DISTINCT FROM $5 THEN RAISE EXCEPTION 'MANUAL_CHAIN_AUTHENTIC_ORIGINAL_REQUIRED'; END IF;
 PERFORM public.suppress_manual_race_chain_from_event_v2(original.event_id);
 RETURN 'already_applied';
END $$;
REVOKE ALL ON FUNCTION public.replay_existing_manual_race_chain_v2(text,uuid,timestamptz,jsonb,text,uuid) FROM PUBLIC;
