-- Explicit successor only. This small acknowledgement replaces a repeated
-- parent-body response, never current source/purpose/application revalidation.
-- No old function, relation, grant, profile or operational table is changed.
CREATE FUNCTION public.ack_manual_race_same_tx_parent_v1(
 evidence uuid,decision uuid,proposal uuid,readonly_digest text,expected_retained jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE
 tenant text:=nullif(current_setting('app.athlete_id',true),'');
 parent record; receipt public.manual_race_chain_receipt_v2;
 expected_hash bytea; expected_result jsonb; refs jsonb; normalized_refs jsonb;
 expected_count integer; actual_count bigint; stored_bytes bigint;
BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 IF tenant IS NULL OR current_setting('transaction_isolation') NOT IN ('repeatable read','serializable')
 THEN RAISE EXCEPTION 'SAME_TX_PARENT_CONTEXT_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM public.assert_manual_review_global_lock();
 PERFORM public.assert_manual_review_lifecycle_lock(tenant);
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=tenant)
 THEN RAISE EXCEPTION 'SAME_TX_PARENT_UNAVAILABLE'; END IF;
 -- Scalar ingress bound precedes any stored body comparison or serialization.
 IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $4!~'^[a-f0-9]{64}$'
  OR $5 IS NULL OR jsonb_typeof($5) IS DISTINCT FROM 'object' OR octet_length($5::text)>4194304
 THEN RAISE EXCEPTION 'SAME_TX_PARENT_INVALID_INPUT'; END IF;
 PERFORM public.manual_race_v2_assert_json_bound($5);
 IF $5->>'state' IS DISTINCT FROM 'present' OR $5->>'status' IS DISTINCT FROM 'structurally_corresponding'
  OR $5->'minimalAudit'->>'athleteId' IS DISTINCT FROM tenant
  OR $5->'minimalAudit'->>'candidateDigest' IS DISTINCT FROM $4
  OR $5->'payload'->'preparation'->'context'->>'athleteId' IS DISTINCT FROM tenant
  OR $5->'payload'->'preparation'->'candidate'->>'status' IS DISTINCT FROM 'assembled_readonly'
  OR $5->'payload'->'preparation'->'candidate'->>'digest' IS DISTINCT FROM $4
  OR jsonb_typeof($5->'payload'->'inventory'->'refs') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'SAME_TX_PARENT_INVALID_INPUT'; END IF;
 refs:=$5->'payload'->'inventory'->'refs'; expected_count:=jsonb_array_length(refs);
 IF expected_count NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'SAME_TX_PARENT_INVALID_INPUT'; END IF;
 SELECT public.manual_race_v2_normalize_refs(jsonb_agg(ref_rows.value->'identity' ORDER BY ref_rows.ordinal))
 INTO normalized_refs FROM jsonb_array_elements(refs) WITH ORDINALITY ref_rows(value,ordinal);
 -- No stored body is returned. Keep its bounded scalar and parent privacy state
 -- separate from the following full SQLJSONB equality/hash checks.
 SELECT e.id,e.decision_id,e.proposal_id,e.created_at,e.receipt_key,e.candidate_digest,
  e.original_payload_sql_digest,e.payload IS NOT NULL AS present,e.purged_at,e.purged_event_id,
  octet_length(e.payload::text)::bigint AS bytes
 INTO parent FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=tenant AND e.id=$1 FOR SHARE;
 IF parent.id IS NULL OR NOT parent.present OR parent.purged_at IS NOT NULL OR parent.purged_event_id IS NOT NULL
 THEN RAISE EXCEPTION 'SAME_TX_PARENT_UNAVAILABLE'; END IF;
 stored_bytes:=parent.bytes;
 IF stored_bytes IS NULL OR stored_bytes>4194304 THEN RAISE EXCEPTION 'SAME_TX_PARENT_INVALID_INPUT'; END IF;
 expected_hash:=sha256(convert_to($5::text,'UTF8'));
 IF parent.decision_id IS DISTINCT FROM $2 OR parent.proposal_id IS DISTINCT FROM $3
  OR parent.candidate_digest IS DISTINCT FROM $4
  OR parent.original_payload_sql_digest IS DISTINCT FROM encode(expected_hash,'hex')
  OR NOT EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=tenant AND e.id=$1 AND e.payload=$5)
  OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_commit_v2 seal
   WHERE seal.athlete_id=tenant AND seal.evidence_id=$1 AND seal.caller_role=session_user
    AND seal.owner_xid=txid_current() AND seal.payload_hash=expected_hash)
  OR NOT EXISTS(SELECT 1 FROM public.manual_race_decision_v2 d WHERE d.athlete_id=tenant AND d.id=$2 AND d.evidence_id=$1)
  OR NOT EXISTS(SELECT 1 FROM public.manual_race_proposal_v2 p WHERE p.athlete_id=tenant AND p.id=$3 AND p.evidence_id=$1 AND p.decision_id=$2 AND NOT p.applicable)
  OR EXISTS(SELECT 1 FROM public.manual_race_chain_suppression_v2 s WHERE s.athlete_id=tenant AND s.evidence_id=$1)
 THEN RAISE EXCEPTION 'SAME_TX_PARENT_CORRESPONDENCE_MISMATCH'; END IF;
 expected_result:=jsonb_build_object('schemaVersion',2,'evidenceId',$1,'decisionId',$2,'proposalId',$3,
  'candidateDigest',$4,'createdAt',to_char(parent.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'applicable',false,'approvalAllowed',false);
 SELECT * INTO receipt FROM public.manual_race_chain_receipt_v2 r
 WHERE r.athlete_id=tenant AND r.receipt_key=parent.receipt_key AND r.evidence_id=$1;
 IF receipt.evidence_id IS NULL OR receipt.result IS DISTINCT FROM expected_result
  OR octet_length(receipt.request_digest) IS DISTINCT FROM 32
  OR NOT EXISTS(SELECT 1 FROM public.outbox o WHERE o.athlete_id=tenant AND o.id=$3
   AND o.idempotency_key='manual-race-chain:'||$3::text AND o.topic='manual.race_chain_prepared' AND o.payload=expected_result)
 THEN RAISE EXCEPTION 'SAME_TX_PARENT_CORRESPONDENCE_MISMATCH'; END IF;
 SELECT count(*) INTO actual_count FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=tenant AND r.evidence_id=$1;
 IF actual_count<>expected_count OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(refs) WITH ORDINALITY expected(value,ordinal)
  LEFT JOIN public.manual_race_chain_source_ref_v2 r ON r.athlete_id=tenant AND r.evidence_id=$1 AND r.ordinal=expected.ordinal
  WHERE r.ordinal IS NULL OR r.identity IS DISTINCT FROM normalized_refs->((expected.ordinal-1)::integer)
   OR r.identity_key IS DISTINCT FROM sha256(convert_to(r.identity::text,'UTF8'))
   OR r.dto_digest IS DISTINCT FROM expected.value->>'dtoDigest'
   OR r.copied_locations IS DISTINCT FROM expected.value->'copiedLocations'
   OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_lifecycle_edge_v2 edge
    WHERE edge.athlete_id=tenant AND edge.evidence_id=$1 AND edge.ordinal=r.ordinal)
 ) OR EXISTS(SELECT 1 FROM public.manual_race_chain_lifecycle_edge_v2 edge
  WHERE edge.athlete_id=tenant AND edge.evidence_id=$1
   AND (edge.edge_key IS DISTINCT FROM sha256(convert_to(edge.edge::text,'UTF8'))
    OR NOT EXISTS(SELECT 1 FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=tenant AND r.evidence_id=$1 AND r.ordinal=edge.ordinal)))
 THEN RAISE EXCEPTION 'SAME_TX_PARENT_CORRESPONDENCE_MISMATCH'; END IF;
 -- This is stored-body/row correspondence only. SQL118 must still revalidate
 -- current app/source/consent/absence/head/recipe facts before preparing/applying.
 RETURN jsonb_build_object('ackVersion',1,'result',receipt.result,'bodyState','present',
  'payloadDigestMethod','postgres-jsonb-v1','payloadSqlDigest',encode(expected_hash,'hex'),
  'correspondence','same_tx_stored_parent');
END $$;
REVOKE ALL ON FUNCTION public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
