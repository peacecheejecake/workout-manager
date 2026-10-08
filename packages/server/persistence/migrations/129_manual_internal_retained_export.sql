-- Internal retained enumeration only; no public122 receipt filter or new admission.
-- Source27 provenance remains private/unresolved. This RPC returns frozen input
-- only to the server renderer, never a portable raw source/archive credential.
CREATE FUNCTION public.read_manual_race_internal_personal_export_v1(byte_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE
 tenant text:=public.race_manual_public_scope_v1();
 chain_count bigint; chain_receipt_count bigint; candidate_count bigint; receipt_count bigint; history_count bigint; raw_bytes bigint;
 chain_row record; candidate_row record; receipt_row record; expected_result jsonb; entry jsonb; version_ref jsonb;
 chains jsonb:='[]'; candidates jsonb:='[]'; approvals jsonb:='[]'; histories jsonb; result jsonb;
BEGIN
 IF byte_limit IS NULL OR byte_limit NOT BETWEEN 1 AND 8388608 THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_INVALID_BOUND'; END IF;
 IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_SNAPSHOT_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,77209));
 IF EXISTS(SELECT 1 FROM public.race_manual_application_context_v1 x WHERE x.athlete_id=tenant)
 THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
 SELECT count(*) INTO chain_count FROM (SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=tenant LIMIT 1001) bounded;
 SELECT count(*) INTO chain_receipt_count FROM (SELECT 1 FROM public.manual_race_chain_receipt_v2 r WHERE r.athlete_id=tenant LIMIT 1001) bounded;
 SELECT count(*) INTO candidate_count FROM (SELECT 1 FROM public.race_manual_application_candidate_v1 c WHERE c.athlete_id=tenant LIMIT 1001) bounded;
 SELECT count(*) INTO receipt_count FROM (SELECT 1 FROM public.race_manual_application_receipt_v1 r WHERE r.athlete_id=tenant LIMIT 1001) bounded;
 SELECT count(*) INTO history_count FROM (SELECT 1 FROM public.race_manual_application_history_v1 h WHERE h.athlete_id=tenant LIMIT 1001) bounded;
 IF chain_count>1000 OR chain_receipt_count>1000 OR candidate_count>1000 OR receipt_count>1000 OR history_count>1000 THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_TOO_LARGE'; END IF;
 -- Scalar before any body aggregation/return. Whole evidence envelopes are a
 -- conservative upper bound even though only their frozen preparation is sent.
 SELECT coalesce((SELECT sum(coalesce(octet_length(e.payload::text),0)+2048) FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=tenant),0)
  +coalesce((SELECT sum(coalesce(octet_length(c.candidate_json::text),0)+1024) FROM public.race_manual_application_candidate_v1 c WHERE c.athlete_id=tenant),0)
  +coalesce((SELECT sum(octet_length(r.result::text)+512) FROM public.manual_race_chain_receipt_v2 r WHERE r.athlete_id=tenant),0)
  +coalesce((SELECT sum(octet_length(r.result::text)+512) FROM public.race_manual_application_receipt_v1 r WHERE r.athlete_id=tenant),0)
  +history_count*1024+1024 INTO raw_bytes;
 IF raw_bytes>byte_limit THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_TOO_LARGE'; END IF;
 -- Full own parent census, not an inner join that silently drops orphans.
 IF EXISTS(SELECT 1 FROM public.manual_race_decision_v2 d WHERE d.athlete_id=tenant
   AND NOT EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=d.athlete_id AND e.id=d.evidence_id AND e.decision_id=d.id))
 OR EXISTS(SELECT 1 FROM public.manual_race_proposal_v2 p WHERE p.athlete_id=tenant
   AND NOT EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=p.athlete_id AND e.id=p.evidence_id AND e.proposal_id=p.id AND e.decision_id=p.decision_id AND NOT p.applicable))
 OR EXISTS(SELECT 1 FROM public.manual_race_chain_receipt_v2 r WHERE r.athlete_id=tenant
   AND NOT EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=r.athlete_id AND e.id=r.evidence_id))
 THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
 FOR chain_row IN SELECT e.* FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=tenant ORDER BY e.id
 LOOP
  IF NOT EXISTS(SELECT 1 FROM public.manual_race_decision_v2 d WHERE d.athlete_id=tenant AND d.id=chain_row.decision_id AND d.evidence_id=chain_row.id)
   OR NOT EXISTS(SELECT 1 FROM public.manual_race_proposal_v2 p WHERE p.athlete_id=tenant AND p.id=chain_row.proposal_id AND p.evidence_id=chain_row.id AND p.decision_id=chain_row.decision_id AND NOT p.applicable)
  THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
  expected_result:=jsonb_build_object('schemaVersion',2,'evidenceId',chain_row.id,'decisionId',chain_row.decision_id,'proposalId',chain_row.proposal_id,
   'candidateDigest',chain_row.candidate_digest,'createdAt',to_char(chain_row.created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'applicable',false,'approvalAllowed',false);
  IF NOT EXISTS(SELECT 1 FROM public.manual_race_chain_receipt_v2 r WHERE r.athlete_id=tenant AND r.evidence_id=chain_row.id AND r.receipt_key=chain_row.receipt_key AND r.result=expected_result)
   OR EXISTS(SELECT 1 FROM public.manual_race_chain_receipt_v2 r WHERE r.athlete_id=tenant AND r.evidence_id=chain_row.id AND r.result IS DISTINCT FROM expected_result)
  THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
  IF chain_row.payload IS NULL THEN
   IF chain_row.purged_event_id IS NULL OR chain_row.purged_at IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_suppression_v2 s JOIN public.restore_suppression_event original
      ON original.athlete_id=s.athlete_id AND original.event_id=s.event_id
      WHERE s.athlete_id=tenant AND s.evidence_id=chain_row.id AND s.event_id=chain_row.purged_event_id
       AND s.occurred_at=chain_row.purged_at AND original.occurred_at=s.occurred_at AND s.original_payload_sql_digest=chain_row.original_payload_sql_digest)
   THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
   entry:=jsonb_build_object('bodyState','purged','preparation',NULL,'purge',jsonb_build_object('purgedAt',to_char(chain_row.purged_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'purgeEventId',chain_row.purged_event_id));
  ELSE
   IF chain_row.purged_event_id IS NOT NULL OR chain_row.purged_at IS NOT NULL
    OR jsonb_typeof(chain_row.payload->'payload'->'preparation') IS DISTINCT FROM 'object'
    OR chain_row.payload->'payload'->>'state' IS DISTINCT FROM 'present'
    OR chain_row.payload->'minimalAudit'->>'candidateDigest' IS DISTINCT FROM chain_row.candidate_digest
   THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
   entry:=jsonb_build_object('bodyState','present','preparation',chain_row.payload->'payload'->'preparation','purge',NULL);
  END IF;
  chains:=chains||jsonb_build_array(jsonb_build_object('evidenceId',chain_row.id,'decisionId',chain_row.decision_id,'proposalId',chain_row.proposal_id,
    'createdAt',to_char(chain_row.created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'originalResult',expected_result)||entry);
 END LOOP;
 FOR candidate_row IN SELECT c.*,e.payload AS parent_payload,e.decision_id AS parent_decision,e.proposal_id AS parent_proposal,
  e.purged_event_id AS parent_purge_event,e.purged_at AS parent_purge_at
  FROM public.race_manual_application_candidate_v1 c LEFT JOIN public.manual_race_evidence_v2 e ON e.athlete_id=c.athlete_id AND e.id=c.evidence_id
  WHERE c.athlete_id=tenant ORDER BY c.id
 LOOP
  IF candidate_row.parent_decision IS DISTINCT FROM candidate_row.decision_id OR candidate_row.parent_proposal IS DISTINCT FROM candidate_row.proposal_id
   OR candidate_row.parent_decision IS NULL THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
  IF candidate_row.candidate_json IS NULL THEN
   IF candidate_row.basis_json IS NOT NULL OR candidate_row.lifecycle_json IS NOT NULL OR candidate_row.parent_payload IS NOT NULL
    OR candidate_row.purged_event_id IS NULL OR candidate_row.purged_at IS NULL
    OR candidate_row.purged_event_id IS DISTINCT FROM candidate_row.parent_purge_event OR candidate_row.purged_at IS DISTINCT FROM candidate_row.parent_purge_at
   THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
   entry:=jsonb_build_object('bodyState','purged','candidate',NULL,'purge',jsonb_build_object('purgedAt',to_char(candidate_row.purged_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'purgeEventId',candidate_row.purged_event_id));
  ELSE
   IF candidate_row.basis_json IS NULL OR candidate_row.lifecycle_json IS NULL OR candidate_row.parent_payload IS NULL
    OR candidate_row.purged_event_id IS NOT NULL OR candidate_row.purged_at IS NOT NULL OR candidate_row.parent_purge_event IS NOT NULL OR candidate_row.parent_purge_at IS NOT NULL
    OR candidate_row.candidate_json->>'candidateId' IS DISTINCT FROM candidate_row.id::text
    OR candidate_row.candidate_json->>'applicationDigest' IS DISTINCT FROM candidate_row.application_digest
    OR candidate_row.candidate_json->'chain'->>'evidenceId' IS DISTINCT FROM candidate_row.evidence_id::text
    OR candidate_row.candidate_json->'chain'->>'decisionId' IS DISTINCT FROM candidate_row.decision_id::text
    OR candidate_row.candidate_json->'chain'->>'proposalId' IS DISTINCT FROM candidate_row.proposal_id::text
    OR (candidate_row.candidate_json->>'createdAt')::timestamptz IS DISTINCT FROM candidate_row.created_at
    OR NOT public.nutrition_copy_structural_codec(candidate_row.candidate_json,public.race_manual_application_wire_v1('candidate'))
   THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
   entry:=jsonb_build_object('bodyState','present','candidate',candidate_row.candidate_json,'purge',NULL);
  END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('candidateId',candidate_row.id,
   'chain',jsonb_build_object('evidenceId',candidate_row.evidence_id,'decisionId',candidate_row.decision_id,'proposalId',candidate_row.proposal_id),
   'createdAt',to_char(candidate_row.created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))||entry);
 END LOOP;
 FOR receipt_row IN SELECT r.* FROM public.race_manual_application_receipt_v1 r WHERE r.athlete_id=tenant ORDER BY r.candidate_id
 LOOP
  IF NOT EXISTS(SELECT 1 FROM public.race_manual_application_candidate_v1 c WHERE c.athlete_id=tenant AND c.id=receipt_row.candidate_id
    AND c.proposal_id::text=receipt_row.result->>'proposalId')
   OR receipt_row.result->>'status' IS DISTINCT FROM 'committed'
   OR receipt_row.result->>'candidateId' IS DISTINCT FROM receipt_row.candidate_id::text
   OR jsonb_typeof(receipt_row.result->'versions') IS DISTINCT FROM 'array'
   OR NOT (receipt_row.result ?& ARRAY['schemaVersion','status','candidateId','approvalId','proposalId','approvedAt','race','versions','occurrenceIds','notices'])
   OR (receipt_row.result-ARRAY['schemaVersion','status','candidateId','approvalId','proposalId','approvedAt','race','versions','occurrenceIds','notices'])<>'{}'::jsonb
  THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
  FOR version_ref IN SELECT v.value FROM jsonb_array_elements(receipt_row.result->'versions') v(value)
  LOOP
   IF NOT EXISTS(SELECT 1 FROM public.race_manual_application_history_v1 h WHERE h.athlete_id=tenant AND h.candidate_id=receipt_row.candidate_id
    AND h.approval_id::text=receipt_row.result->>'approvalId' AND h.domain=version_ref->>'domain'
    AND h.aggregate_id::text=version_ref->>'aggregateId' AND h.version_id::text=version_ref->>'versionId'
    AND h.approved_at=(receipt_row.result->>'approvedAt')::timestamptz)
   THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
  END LOOP;
  approvals:=approvals||jsonb_build_array(receipt_row.result);
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.race_manual_application_history_v1 h WHERE h.athlete_id=tenant
  AND NOT EXISTS(SELECT 1 FROM public.race_manual_application_receipt_v1 r WHERE r.athlete_id=h.athlete_id AND r.candidate_id=h.candidate_id
   AND r.result->>'approvalId'=h.approval_id::text AND (r.result->>'approvedAt')::timestamptz=h.approved_at
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.result->'versions') v(value) WHERE v.value->>'domain'=h.domain
    AND v.value->>'aggregateId'=h.aggregate_id::text AND v.value->>'versionId'=h.version_id::text)))
 THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('candidateId',h.candidate_id,'approvalId',h.approval_id,'domain',h.domain,'aggregateId',h.aggregate_id,
  'versionId',h.version_id,'approvedAt',to_char(h.approved_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY h.candidate_id,h.approval_id,h.domain COLLATE "C",h.aggregate_id),'[]')
 INTO histories FROM public.race_manual_application_history_v1 h WHERE h.athlete_id=tenant;
 result:=jsonb_build_object('schemaVersion',1,'chains',chains,'candidates',candidates,'approvalResults',approvals,'approvalHistory',histories);
 IF octet_length(result::text)>byte_limit THEN RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_TOO_LARGE'; END IF;
 RETURN result;
EXCEPTION WHEN insufficient_privilege THEN RAISE;
 WHEN OTHERS THEN
  IF SQLERRM IN ('MANUAL_INTERNAL_EXPORT_INVALID_BOUND','MANUAL_INTERNAL_EXPORT_SNAPSHOT_REQUIRED','MANUAL_INTERNAL_EXPORT_TOO_LARGE','MANUAL_INTERNAL_EXPORT_CORRUPT','RACE_MANUAL_TENANT_UNAVAILABLE') THEN RAISE; END IF;
  RAISE EXCEPTION 'MANUAL_INTERNAL_EXPORT_CORRUPT';
END $$;
REVOKE ALL ON FUNCTION public.read_manual_race_internal_personal_export_v1(integer) FROM PUBLIC;
