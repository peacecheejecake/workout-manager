-- Additive same-RR server-private batch. The exact old129 raw preparation is
-- transported once; source130 is metadata-only with actual owned-row binding.
-- No caller artifact, admission, provider authentication or restore authority.
CREATE FUNCTION public.read_manual_race_retained_source_batch_v1(byte_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE
 tenant text:=public.race_manual_public_scope_v1();
 n bigint; raw_bytes bigint; chain_row record; ref_row record; suppression_row record;
 current_edges jsonb; chain_refs jsonb; event_row public.restore_suppression_event;
 internal_json jsonb; internal_chain jsonb; preparation jsonb; preparation_binding jsonb; metadata_budget bigint;
 chains jsonb:='[]'; refs jsonb:='[]'; parents jsonb; suppressions jsonb:='[]'; matched jsonb; result jsonb; state text;
BEGIN
 IF byte_limit IS NULL OR byte_limit NOT BETWEEN 1 AND 8388608 THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_INVALID_BOUND'; END IF;
 IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_SNAPSHOT_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,77209));
 SELECT count(*) INTO n FROM (SELECT 1 FROM public.manual_race_evidence_v2 WHERE athlete_id=tenant LIMIT 1001) counted;
 IF n>1000 THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_TOO_LARGE'; END IF;
 -- Each saved reference census is bounded before requesting any internal body.
 IF EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=tenant AND
  (SELECT count(*) FROM (SELECT 1 FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=tenant AND r.evidence_id=e.id LIMIT 5001) bounded) NOT BETWEEN 1 AND 5000)
 THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
 -- Count and scalar metadata bytes precede any body/array aggregation. Per-event
 -- matching reserves every ordinal in that chain before computing exact matches.
 SELECT coalesce((SELECT sum(768) FROM public.manual_race_evidence_v2 WHERE athlete_id=tenant),0)
 +coalesce((SELECT sum(octet_length(identity::text)+octet_length(copied_locations::text)+512) FROM public.manual_race_chain_source_ref_v2 WHERE athlete_id=tenant),0)
 +coalesce((SELECT sum(octet_length(edge::text)+512) FROM public.manual_race_chain_lifecycle_edge_v2 WHERE athlete_id=tenant),0)
 +coalesce((SELECT sum(512+12*(SELECT count(*) FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=s.athlete_id AND r.evidence_id=s.evidence_id)) FROM public.manual_race_chain_suppression_v2 s WHERE s.athlete_id=tenant),0)+1024 INTO raw_bytes;
 -- Metadata has no preparation body. Reserve its existing encoded identity,
 -- copied-location, edge and matched-ordinal upper bounds exactly once. The
 -- original129 whole-evidence conservative scalar guard still runs unchanged.
 metadata_budget:=raw_bytes+1024;
 IF metadata_budget>=byte_limit THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_TOO_LARGE'; END IF;
 internal_json:=public.read_manual_race_internal_personal_export_v1((byte_limit-metadata_budget)::integer);
 IF jsonb_typeof(internal_json) IS DISTINCT FROM 'object' OR internal_json->>'schemaVersion' IS DISTINCT FROM '1'
  OR jsonb_typeof(internal_json->'chains') IS DISTINCT FROM 'array'
  OR jsonb_array_length(internal_json->'chains')<>n
 THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
 FOR chain_row IN SELECT e.* FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=tenant ORDER BY e.created_at,e.id LOOP
  IF NOT EXISTS(SELECT 1 FROM public.manual_race_decision_v2 d JOIN public.manual_race_proposal_v2 p ON p.athlete_id=d.athlete_id AND p.evidence_id=d.evidence_id AND p.decision_id=d.id WHERE d.athlete_id=tenant AND d.evidence_id=chain_row.id AND d.id=chain_row.decision_id AND p.id=chain_row.proposal_id)
  THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
  IF chain_row.payload IS NULL AND NOT EXISTS(SELECT 1 FROM public.manual_race_chain_suppression_v2 s JOIN public.restore_suppression_event e ON e.athlete_id=s.athlete_id AND e.event_id=s.event_id WHERE s.athlete_id=tenant AND s.evidence_id=chain_row.id AND s.event_id=chain_row.purged_event_id AND s.occurred_at=chain_row.purged_at AND s.original_payload_sql_digest=chain_row.original_payload_sql_digest AND e.occurred_at=s.occurred_at)
  THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
  IF chain_row.payload IS NOT NULL AND (chain_row.purged_event_id IS NOT NULL OR chain_row.purged_at IS NOT NULL) THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
  IF (SELECT count(*) FROM (SELECT 1 FROM public.manual_race_chain_source_ref_v2 WHERE athlete_id=tenant AND evidence_id=chain_row.id LIMIT 5001) bounded) NOT BETWEEN 1 AND 5000
  THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
  SELECT jsonb_agg(r.identity ORDER BY r.ordinal) INTO chain_refs FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=tenant AND r.evidence_id=chain_row.id;
  IF chain_refs IS NULL OR jsonb_array_length(chain_refs) NOT BETWEEN 1 AND 5000 OR (SELECT max(ordinal) FROM public.manual_race_chain_source_ref_v2 WHERE athlete_id=tenant AND evidence_id=chain_row.id)<>jsonb_array_length(chain_refs) THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;

  SELECT element.value INTO internal_chain FROM jsonb_array_elements(internal_json->'chains') element(value)
   WHERE element.value->>'evidenceId'=chain_row.id::text;
  IF internal_chain IS NULL OR (SELECT count(*) FROM jsonb_array_elements(internal_json->'chains') element(value) WHERE element.value->>'evidenceId'=chain_row.id::text)<>1
   OR internal_chain->>'decisionId' IS DISTINCT FROM chain_row.decision_id::text
   OR internal_chain->>'proposalId' IS DISTINCT FROM chain_row.proposal_id::text
  THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
  preparation:=CASE WHEN chain_row.payload IS NULL THEN NULL ELSE chain_row.payload->'payload'->'preparation' END;
  IF chain_row.payload IS NULL THEN
   IF internal_chain->>'bodyState' IS DISTINCT FROM 'purged'
    OR internal_chain->'preparation' IS DISTINCT FROM 'null'::jsonb
    OR internal_chain->'purge'->>'purgeEventId' IS DISTINCT FROM chain_row.purged_event_id::text
    OR internal_chain->'purge'->>'purgedAt' IS DISTINCT FROM to_char(chain_row.purged_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
   THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
   preparation_binding:=jsonb_build_object('state','purged','digestMethod','postgres-jsonb-v1','digest',NULL);
  ELSE
   IF internal_chain->>'bodyState' IS DISTINCT FROM 'present' OR internal_chain->'purge' IS DISTINCT FROM 'null'::jsonb
    OR jsonb_typeof(preparation) IS DISTINCT FROM 'object' OR internal_chain->'preparation' IS DISTINCT FROM preparation
   THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
   preparation_binding:=jsonb_build_object('state','present','digestMethod','postgres-jsonb-v1','digest',encode(sha256(convert_to(preparation::text,'UTF8')),'hex'));
  END IF;
  chains:=chains||jsonb_build_array(jsonb_build_object('evidenceId',chain_row.id,'decisionId',chain_row.decision_id,'proposalId',chain_row.proposal_id,
   'preparationBinding',preparation_binding,
   'savedRefCount',jsonb_array_length(chain_refs),
   'savedParentCount',(SELECT count(*) FROM public.manual_race_chain_lifecycle_edge_v2 WHERE athlete_id=tenant AND evidence_id=chain_row.id),
   'savedSuppressionCount',(SELECT count(*) FROM public.manual_race_chain_suppression_v2 WHERE athlete_id=tenant AND evidence_id=chain_row.id),
   'body',CASE WHEN chain_row.payload IS NULL THEN jsonb_build_object('state','purged','eventId',chain_row.purged_event_id,'occurredAt',to_char(chain_row.purged_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ELSE jsonb_build_object('state','present') END));
  FOR ref_row IN SELECT r.* FROM public.manual_race_chain_source_ref_v2 r WHERE r.athlete_id=tenant AND r.evidence_id=chain_row.id ORDER BY r.ordinal LOOP
   state:=CASE WHEN public.manual_source_personal_row_exists_v1(ref_row.identity,chain_refs) THEN 'present' ELSE 'unavailable' END;
   IF EXISTS(SELECT 1 FROM public.manual_race_chain_suppression_v2 s JOIN public.restore_suppression_event e ON e.athlete_id=s.athlete_id AND e.event_id=s.event_id JOIN public.manual_race_chain_lifecycle_edge_v2 l ON l.athlete_id=s.athlete_id AND l.evidence_id=s.evidence_id AND l.ordinal=ref_row.ordinal WHERE s.athlete_id=tenant AND s.evidence_id=chain_row.id AND s.original_payload_sql_digest=chain_row.original_payload_sql_digest AND e.occurred_at=s.occurred_at AND public.manual_race_v2_event_matches_ref(e,ref_row.identity,l.edge)) THEN state:='deleted'; END IF;
   refs:=refs||jsonb_build_array(jsonb_build_object('evidenceId',chain_row.id,'ordinal',ref_row.ordinal,'identity',ref_row.identity,'dtoDigest',ref_row.dto_digest,'copiedLocations',ref_row.copied_locations,
    'trainingAggregateId',CASE WHEN ref_row.identity->>'kind'='plan-snapshot' THEN (SELECT a.aggregate_id FROM public.plan_snapshot_aggregate a WHERE a.athlete_id=tenant AND a.version_id::text=ref_row.identity->>'sourceId') ELSE NULL END,
    'sourceKind',CASE WHEN ref_row.identity->>'kind'='manual-activity-source' THEN (SELECT x.value->'key'->>0 FROM jsonb_array_elements(ref_row.sql_relations) x(value) WHERE x.value->>'relation'='activity_source_revision' LIMIT 1) ELSE NULL END,
    'parentCoverage',CASE WHEN EXISTS(SELECT 1 FROM public.manual_race_chain_lifecycle_edge_v2 WHERE athlete_id=tenant AND evidence_id=chain_row.id AND ordinal=ref_row.ordinal) THEN 'saved_parents' ELSE 'legacy_association_unavailable' END,
    'existence',jsonb_build_object('basis','export_snapshot','state',state),
    'location',jsonb_build_object('state','unavailable','reason',CASE WHEN chain_row.payload IS NULL THEN 'payload_purged' ELSE 'private_source_not_rendered' END)));
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('evidenceId',e.evidence_id,'ordinal',e.ordinal,'edge',e.edge) ORDER BY e.evidence_id,e.ordinal,e.edge_key),'[]') INTO parents FROM public.manual_race_chain_lifecycle_edge_v2 e WHERE e.athlete_id=tenant;
 FOR suppression_row IN SELECT s.* FROM public.manual_race_chain_suppression_v2 s WHERE s.athlete_id=tenant ORDER BY s.evidence_id,s.occurred_at,s.event_id LOOP
  SELECT * INTO event_row FROM public.restore_suppression_event WHERE athlete_id=tenant AND event_id=suppression_row.event_id;
  IF NOT FOUND OR event_row.occurred_at IS DISTINCT FROM suppression_row.occurred_at OR NOT EXISTS(SELECT 1 FROM public.manual_race_evidence_v2 e WHERE e.athlete_id=tenant AND e.id=suppression_row.evidence_id AND e.original_payload_sql_digest=suppression_row.original_payload_sql_digest) THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
  SELECT coalesce(jsonb_agg(o.ordinal ORDER BY o.ordinal),'[]') INTO matched FROM (SELECT DISTINCT r.ordinal FROM public.manual_race_chain_source_ref_v2 r JOIN public.manual_race_chain_lifecycle_edge_v2 l ON l.athlete_id=r.athlete_id AND l.evidence_id=r.evidence_id AND l.ordinal=r.ordinal WHERE r.athlete_id=tenant AND r.evidence_id=suppression_row.evidence_id AND public.manual_race_v2_event_matches_ref(event_row,r.identity,l.edge)) o;
  IF jsonb_array_length(matched)=0 THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_CORRUPT'; END IF;
  suppressions:=suppressions||jsonb_build_array(jsonb_build_object('evidenceId',suppression_row.evidence_id,'eventId',event_row.event_id,'occurredAt',to_char(event_row.occurred_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'recordVersion',event_row.record_version,'kind',event_row.kind,'matchedRefOrdinals',matched));
 END LOOP;
 result:=jsonb_build_object('schemaVersion',1,'internal',internal_json,'sourceMetadata',jsonb_build_object('schemaVersion',1,'chains',chains,'refs',refs,'parents',parents,'suppressions',suppressions));
 IF octet_length(result::text)>byte_limit THEN RAISE EXCEPTION 'MANUAL_SOURCE_EXPORT_TOO_LARGE'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_manual_race_retained_source_batch_v1(integer) FROM PUBLIC;
