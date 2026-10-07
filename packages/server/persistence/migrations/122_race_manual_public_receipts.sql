-- Explicit public receipt successor. Normal registry107 and predecessors stay unchanged.
-- Public inputs contain intent or minimal approval identifiers only. Stored bodies
-- and original approval results are derived from the authenticated predecessor rows.
CREATE FUNCTION public.race_manual_public_wire_v1(kind text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $codec$
 SELECT CASE $1
 WHEN 'review' THEN '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"intent":{"type":"object","properties":{"expectedEvent":{"type":"object","properties":{"id":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"revision":{"type":"integer","minimum":1,"maximum":2147483647}},"required":["id","revision"],"additionalProperties":false},"newLocalDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"selection":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"keep_plan"}},"required":["kind"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"move_period"},"expectedCurrentPlanVersionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"periodId":{"type":"string","minLength":1,"maxLength":200},"newStartDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"scope":{"type":"string","enum":["period_only","descendants_and_sessions"]}},"required":["kind","expectedCurrentPlanVersionId","periodId","newStartDate","scope"],"additionalProperties":false}]},"resolutions":{"default":{"nutrition":[],"routines":[]},"type":"object","properties":{"nutrition":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"planVersionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"itemId":{"type":"string","minLength":1,"maxLength":200},"action":{"type":"string","const":"replace_anchor"},"anchor":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"absolute"},"date":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]},"timezone":{"type":"string"}},"required":["kind","date","localTime","timezone"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"relative"},"entity":{"type":"string","enum":["session","race"]},"entityId":{"type":"string"},"point":{"type":"string","enum":["start","end"]},"offsetMinutes":{"type":"number"}},"required":["kind","entity","entityId","point","offsetMinutes"],"additionalProperties":false}]}},"required":["planVersionId","itemId","action","anchor"],"additionalProperties":false}},"routines":{"maxItems":1000,"type":"array","items":{"type":"object","properties":{"scheduleVersionId":{"type":"string","minLength":1,"maxLength":200},"action":{"type":"string","const":"replace_rule"},"rule":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"dates"},"dates":{"minItems":1,"type":"array","items":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]}},"required":["kind","dates","localTime"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"weekdays"},"weekdays":{"minItems":1,"type":"array","items":{"type":"integer","minimum":0,"maximum":6}},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]}},"required":["kind","weekdays","localTime"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"every_n_days"},"anchorDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"intervalDays":{"type":"integer","minimum":1,"maximum":9007199254740991},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]}},"required":["kind","anchorDate","intervalDays","localTime"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"period_days"},"periodId":{"type":"string"},"offsetsDays":{"minItems":1,"type":"array","items":{"type":"integer","minimum":0,"maximum":9007199254740991}},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]}},"required":["kind","periodId","offsetsDays","localTime"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"session_links"},"sessionIds":{"minItems":1,"type":"array","items":{"type":"string"}},"point":{"type":"string","enum":["start","end"]},"offsetMinutes":{"type":"number"}},"required":["kind","sessionIds","point","offsetMinutes"],"additionalProperties":false}]},"window":{"type":"object","properties":{"startDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"endDateExclusive":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"timezone":{"type":"string"},"maxOccurrences":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["startDate","endDateExclusive","timezone","maxOccurrences"],"additionalProperties":false},"sourcePlanVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]}},"required":["scheduleVersionId","action","rule","window","sourcePlanVersionId"],"additionalProperties":false}}},"required":["nutrition","routines"],"additionalProperties":false}},"required":["expectedEvent","newLocalDate","selection","resolutions"],"additionalProperties":false},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["schemaVersion","intent","idempotencyKey"],"additionalProperties":false}'::jsonb
 WHEN 'approve' THEN '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"confirmed":{"type":"boolean","const":true},"applicationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"candidateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}},"required":["schemaVersion","confirmed","applicationDigest","idempotencyKey","candidateId"],"additionalProperties":false}'::jsonb
 WHEN 'reference' THEN '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"candidateId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"applicationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"chain":{"type":"object","properties":{"evidenceId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"decisionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"proposalId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"readonlyCandidateDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["evidenceId","decisionId","proposalId","readonlyCandidateDigest"],"additionalProperties":false},"createdAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"}},"required":["schemaVersion","candidateId","applicationDigest","chain","createdAt"],"additionalProperties":false}'::jsonb
 ELSE NULL END
$codec$;
REVOKE ALL ON FUNCTION public.race_manual_public_wire_v1(text) FROM PUBLIC;

CREATE TABLE public.race_manual_public_receipt_v1 (
 athlete_id text NOT NULL,operation text NOT NULL CHECK(operation IN ('review','approve')),
 receipt_key text NOT NULL CHECK(receipt_key~'^[A-Za-z0-9_-]{8,128}$'),
 request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
 candidate_id uuid NOT NULL,result jsonb NOT NULL CHECK(octet_length(result::text)<=4194304),
 PRIMARY KEY(athlete_id,operation,receipt_key),
 FOREIGN KEY(athlete_id,candidate_id) REFERENCES public.race_manual_application_candidate_v1(athlete_id,id) ON DELETE CASCADE
);
REVOKE ALL ON public.race_manual_public_receipt_v1 FROM PUBLIC;
ALTER TABLE public.race_manual_public_receipt_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.race_manual_public_receipt_v1 FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.race_manual_public_receipt_v1
 USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- This gate preserves the predecessor caller/owner/tenant lifecycle fence.
CREATE FUNCTION public.race_manual_public_scope_v1() RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); BEGIN
 PERFORM public.race_manual_application_owner_v1();
 PERFORM public.assert_manual_review_global_lock();
 PERFORM public.assert_manual_review_lifecycle_lock(t);
 IF t IS NULL OR EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=t)
 THEN RAISE EXCEPTION 'RACE_MANUAL_TENANT_UNAVAILABLE'; END IF;
 RETURN t;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_public_scope_v1() FROM PUBLIC;

CREATE FUNCTION public.race_manual_public_command_v1(operation text,key text,command jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF $1 NOT IN ('review','approve') OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL
 OR octet_length($3::text)>4194304 OR $3->>'idempotencyKey' IS DISTINCT FROM $2
 OR NOT coalesce(public.nutrition_copy_structural_codec($3,public.race_manual_public_wire_v1($1)),false)
 THEN RAISE EXCEPTION 'RACE_MANUAL_INVALID_COMMAND'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_public_command_v1(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.race_manual_public_reference_v1(t text,candidate uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE c public.race_manual_application_candidate_v1; r jsonb; original_stamp text; BEGIN
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 q WHERE q.athlete_id=$1 AND q.id=$2;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Preserve the original public producer spelling (normally ISO milliseconds),
 -- not a freshly formatted timestamp. After purge the minimal review receipt
 -- retains that exact spelling without retaining any candidate/source body.
 original_stamp:=c.candidate_json->>'createdAt';
 IF original_stamp IS NULL THEN
  SELECT q.result->>'createdAt' INTO original_stamp FROM public.race_manual_public_receipt_v1 q
  WHERE q.athlete_id=c.athlete_id AND q.candidate_id=c.id AND q.operation='review'
  ORDER BY q.receipt_key COLLATE "C" LIMIT 1;
 END IF;
 -- An unpublished private candidate has no original public reference. Its
 -- purged read still reports the exact relational instant, with microseconds.
 original_stamp:=coalesce(original_stamp,to_char(c.created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 r:=jsonb_build_object('schemaVersion',1,'candidateId',c.id,'applicationDigest',c.application_digest,
 'chain',jsonb_build_object('evidenceId',c.evidence_id,'decisionId',c.decision_id,'proposalId',c.proposal_id,
 'readonlyCandidateDigest',(SELECT e.candidate_digest FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=c.athlete_id AND e.id=c.evidence_id)),
 'createdAt',original_stamp);
 IF NOT coalesce(public.nutrition_copy_structural_codec(r,public.race_manual_public_wire_v1('reference')),false)
 THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_PROVENANCE_INVALID'; END IF;
 IF original_stamp::timestamptz IS DISTINCT FROM c.created_at THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_PROVENANCE_INVALID'; END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.race_manual_public_reference_v1(text,uuid) FROM PUBLIC;

CREATE FUNCTION public.guard_race_manual_public_receipt_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text; original jsonb; BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=OLD.athlete_id) THEN RETURN OLD; END IF;
 t:=public.race_manual_public_scope_v1();
 IF TG_OP<>'INSERT' OR NEW.athlete_id IS DISTINCT FROM t THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_IMMUTABLE'; END IF;
 IF NEW.operation='review' THEN original:=public.race_manual_public_reference_v1(t,NEW.candidate_id);
 ELSE
  SELECT r.result INTO original FROM public.race_manual_application_receipt_v1 r
  JOIN public.race_manual_application_candidate_v1 c ON c.athlete_id=r.athlete_id AND c.id=r.candidate_id
  WHERE r.athlete_id=t AND r.candidate_id=NEW.candidate_id;
 END IF;
 IF original IS NULL OR NEW.result IS DISTINCT FROM original THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_PROVENANCE_INVALID'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_race_manual_public_receipt_v1() FROM PUBLIC;
CREATE TRIGGER race_manual_public_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.race_manual_public_receipt_v1
 FOR EACH ROW EXECUTE FUNCTION public.guard_race_manual_public_receipt_v1();
CREATE TRIGGER race_manual_public_receipt_truncate BEFORE TRUNCATE ON public.race_manual_public_receipt_v1
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

CREATE FUNCTION public.read_race_manual_public_receipt_v1(operation text,key text,command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=public.race_manual_public_scope_v1(); r public.race_manual_public_receipt_v1; BEGIN
 PERFORM public.race_manual_public_command_v1($1,$2,$3);
 -- Serializes same public operation/key before processing or original-approval lookup.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(t,$1,$2)::text,122));
 SELECT * INTO r FROM public.race_manual_public_receipt_v1 q WHERE q.athlete_id=t AND q.operation=$1 AND q.receipt_key=$2;
 IF FOUND THEN
  IF r.request_digest IS DISTINCT FROM sha256(convert_to($3::text,'UTF8')) THEN RAISE EXCEPTION 'RACE_MANUAL_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN r.result;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.read_race_manual_public_receipt_v1(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.finish_race_manual_public_review_v1(key text,command jsonb,candidate uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=public.race_manual_public_scope_v1(); replay jsonb; c public.race_manual_application_candidate_v1;
 e public.manual_race_evidence_v2; internal_key text; result jsonb; BEGIN
 replay:=public.read_race_manual_public_receipt_v1('review',$1,$2);
 IF replay IS NOT NULL THEN
  IF replay->>'candidateId' IS DISTINCT FROM $3::text THEN RAISE EXCEPTION 'RACE_MANUAL_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN replay;
 END IF;
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 q WHERE q.athlete_id=t AND q.id=$3 FOR SHARE;
 SELECT * INTO e FROM public.manual_race_evidence_v2 q WHERE q.athlete_id=t AND q.id=c.evidence_id FOR SHARE;
 internal_key:='race_public_review_v1_'||encode(sha256(convert_to(jsonb_build_object('tenant',t,'operation','review','publicKey',$1)::text,'UTF8')),'hex');
 IF c.id IS NULL OR c.candidate_json IS NULL OR e.payload IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.race_manual_application_candidate_v1 q WHERE q.athlete_id=t AND q.id=$3 AND q.xmin::text=(txid_current()%4294967296)::text)
 OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_commit_v2 q WHERE q.athlete_id=t AND q.evidence_id=e.id AND q.owner_xid=txid_current() AND q.caller_role=session_user
  AND q.payload_hash=sha256(convert_to(e.payload::text,'UTF8')))
 OR e.receipt_key IS DISTINCT FROM internal_key
 OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_receipt_v2 q WHERE q.athlete_id=t AND q.evidence_id=e.id AND q.receipt_key=internal_key
  AND q.request_digest=sha256(convert_to(jsonb_build_object('schemaVersion',2,'idempotencyKey',internal_key,'intent',$2->'intent','expectedBasis',c.basis_json)::text,'UTF8')))
 OR c.basis_json->'intent' IS DISTINCT FROM $2->'intent'
 OR e.payload->'payload'->'preparation'->'context'->'calendarIntent' IS DISTINCT FROM $2->'intent'
 THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_PROVENANCE_INVALID'; END IF;
 result:=public.race_manual_public_reference_v1(t,c.id);
 INSERT INTO public.race_manual_public_receipt_v1 VALUES(t,'review',$1,sha256(convert_to($2::text,'UTF8')),c.id,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.finish_race_manual_public_review_v1(text,jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION public.read_race_manual_public_approval_v1(key text,command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=public.race_manual_public_scope_v1(); replay jsonb; c public.race_manual_application_candidate_v1; result jsonb; BEGIN
 replay:=public.read_race_manual_public_receipt_v1('approve',$1,$2);
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 q WHERE q.athlete_id=t AND q.id=($2->>'candidateId')::uuid FOR SHARE;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 IF c.application_digest IS DISTINCT FROM $2->>'applicationDigest' THEN RAISE EXCEPTION 'RACE_MANUAL_ALREADY_APPLIED'; END IF;
 SELECT r.result INTO result FROM public.race_manual_application_receipt_v1 r WHERE r.athlete_id=t AND r.candidate_id=c.id;
 IF result IS NOT NULL AND (NOT coalesce(public.nutrition_copy_structural_codec(result,public.race_manual_application_wire_v1('result')),false)
 OR result->>'status' IS DISTINCT FROM 'committed' OR result->>'candidateId' IS DISTINCT FROM c.id::text OR result->>'proposalId' IS DISTINCT FROM c.proposal_id::text)
 THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_PROVENANCE_INVALID'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_race_manual_public_approval_v1(text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.finish_race_manual_public_approval_v1(key text,command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=public.race_manual_public_scope_v1(); result jsonb; replay jsonb; BEGIN
 result:=public.read_race_manual_public_approval_v1($1,$2);
 IF result IS NULL THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_APPROVAL_UNAVAILABLE'; END IF;
 replay:=public.read_race_manual_public_receipt_v1('approve',$1,$2);
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 INSERT INTO public.race_manual_public_receipt_v1 VALUES(t,'approve',$1,sha256(convert_to($2::text,'UTF8')),($2->>'candidateId')::uuid,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.finish_race_manual_public_approval_v1(text,jsonb) FROM PUBLIC;

-- Internal body reader: never exposed directly as a browser DTO. Retained read
-- does not refresh processing permission or treat a purged body as unavailable refs.
CREATE FUNCTION public.read_race_manual_public_candidate_v1(candidate uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=public.race_manual_public_scope_v1(); c public.race_manual_application_candidate_v1; BEGIN
 SELECT * INTO c FROM public.race_manual_application_candidate_v1 q WHERE q.athlete_id=t AND q.id=$1 FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('reference',public.race_manual_public_reference_v1(t,c.id),'bodyState',CASE WHEN c.candidate_json IS NULL THEN 'purged' ELSE 'present' END,
 'candidate',c.candidate_json,'basis',c.basis_json,'lifecycle',c.lifecycle_json);
END $$;
REVOKE ALL ON FUNCTION public.read_race_manual_public_candidate_v1(uuid) FROM PUBLIC;
