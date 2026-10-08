-- Explicit retained-read successor. Registered baseline107/installer roster unchanged.
-- Internal source envelopes only: no processing, approval or restore authority.
CREATE FUNCTION public.read_check_in_template_personal_export_v1(byte_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=wm_check_in_templates_v1.caller(); versions bigint; heads bigint; bytes bigint; result jsonb;
BEGIN
 PERFORM public.assert_manual_review_global_lock();
 PERFORM public.assert_manual_review_lifecycle_lock(t);
 PERFORM pg_advisory_xact_lock(hashtextextended(t,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t,77209));
 IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN RAISE EXCEPTION 'PERSONAL_EXPORT_SNAPSHOT_REQUIRED'; END IF;
 IF byte_limit IS NULL OR byte_limit NOT BETWEEN 1 AND 8388608 THEN RAISE EXCEPTION 'PERSONAL_EXPORT_INVALID_BOUND'; END IF;
 -- Count complete sets, not a truncated page. Scalar pass precedes body aggregation.
 SELECT count(*),coalesce(sum(octet_length(v.record_json::text)+512),0) INTO versions,bytes
 FROM public.check_in_template_version v WHERE v.athlete_id=t;
 SELECT count(*) INTO heads FROM public.check_in_template_head h WHERE h.athlete_id=t;
 bytes:=bytes+heads*256+1024;
 IF versions>1000 OR heads>1000 OR bytes>byte_limit THEN RAISE EXCEPTION 'PERSONAL_EXPORT_TOO_LARGE'; END IF;
 SELECT jsonb_build_object('schemaVersion',1,'status','ready','data',jsonb_build_object(
 'checkInTemplateVersions',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'template_id',v.template_id,'version_id',v.version_id,'version',v.version,
  'previous_version_id',v.previous_version_id,'previous_version',v.previous_version,
  'created_at',to_char(v.created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'record_json',v.record_json)
  ORDER BY v.template_id,v.version,v.version_id) FROM public.check_in_template_version v WHERE v.athlete_id=t),'[]'),
 'checkInTemplateHeads',coalesce((SELECT jsonb_agg(jsonb_build_object('template_id',h.template_id,'version_id',h.version_id,'version',h.version)
  ORDER BY h.template_id) FROM public.check_in_template_head h WHERE h.athlete_id=t),'[]'))) INTO result;
 IF octet_length(result::text)>byte_limit THEN RAISE EXCEPTION 'PERSONAL_EXPORT_TOO_LARGE'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_check_in_template_personal_export_v1(integer) FROM PUBLIC;

CREATE FUNCTION public.read_race_manual_personal_export_v1(byte_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text:=public.race_manual_public_scope_v1(); reviews bigint; histories bigint; commands bigint; bytes bigint;
 export_candidate_row record; source jsonb; sources jsonb:='[]'; history jsonb; results jsonb; result jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t,77209));
 IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN RAISE EXCEPTION 'PERSONAL_EXPORT_SNAPSHOT_REQUIRED'; END IF;
 IF byte_limit IS NULL OR byte_limit NOT BETWEEN 1 AND 8388608 THEN RAISE EXCEPTION 'PERSONAL_EXPORT_INVALID_BOUND'; END IF;
 -- Only publicly published reviews. Internal-only candidates require a separate
 -- family export; an invented public command cannot stand in for that family.
 SELECT count(*) INTO reviews FROM public.race_manual_application_candidate_v1 c
 WHERE c.athlete_id=t AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=c.id AND p.operation='review');
 SELECT count(*) INTO histories FROM public.race_manual_application_history_v1 h
 WHERE h.athlete_id=t AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=h.candidate_id AND p.operation='review');
 SELECT reviews+count(*) INTO commands FROM public.race_manual_application_receipt_v1 a
 WHERE a.athlete_id=t AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=a.candidate_id AND p.operation='review');
 IF reviews>1000 OR histories>1000 OR commands>1000 THEN RAISE EXCEPTION 'PERSONAL_EXPORT_TOO_LARGE'; END IF;
 -- Never dedupe unequal aliases. Compare JSONB results before choosing a key.
 IF EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 a JOIN public.race_manual_public_receipt_v1 b
  ON b.athlete_id=a.athlete_id AND b.candidate_id=a.candidate_id AND b.operation=a.operation
  WHERE a.athlete_id=t AND a.result IS DISTINCT FROM b.result)
 THEN RAISE EXCEPTION 'PERSONAL_EXPORT_CORRUPT'; END IF;
 IF EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p
  LEFT JOIN public.race_manual_application_receipt_v1 a ON a.athlete_id=p.athlete_id AND a.candidate_id=p.candidate_id
  WHERE p.athlete_id=t AND p.operation='approve' AND (a.candidate_id IS NULL OR p.result IS DISTINCT FROM a.result))
 THEN RAISE EXCEPTION 'PERSONAL_EXPORT_CORRUPT'; END IF;
 -- Conservative raw transfer accounting includes reference, source and normalized
 -- result duplicates. It does not measure SQL-internal memory or archive bytes.
 SELECT coalesce(sum(coalesce(octet_length(c.candidate_json::text),0)+coalesce(octet_length(e.payload::text),0)
  +coalesce(octet_length(a.result::text),0)+coalesce((SELECT max(octet_length(p.result::text)) FROM public.race_manual_public_receipt_v1 p
   WHERE p.athlete_id=t AND p.candidate_id=c.id AND p.operation='review'),0)*3+4096),0)
 INTO bytes FROM public.race_manual_application_candidate_v1 c
 JOIN public.manual_race_evidence_v2 e ON e.athlete_id=c.athlete_id AND e.id=c.evidence_id
 LEFT JOIN public.race_manual_application_receipt_v1 a ON a.athlete_id=c.athlete_id AND a.candidate_id=c.id
 WHERE c.athlete_id=t AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=c.id AND p.operation='review');
 bytes:=bytes+histories*1024+1024;
 IF bytes>byte_limit THEN RAISE EXCEPTION 'PERSONAL_EXPORT_TOO_LARGE'; END IF;
 FOR export_candidate_row IN SELECT id FROM public.race_manual_application_candidate_v1 c WHERE c.athlete_id=t
  AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=c.id AND p.operation='review') ORDER BY c.id
 LOOP
  -- Existing exact same-tenant retained parent/purge correspondence, no live heads.
  source:=public.read_race_manual_public_preview_source_v1(export_candidate_row.id);
  IF source IS NULL OR EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=export_candidate_row.id AND p.operation='review' AND p.result IS DISTINCT FROM source->'reference') THEN RAISE EXCEPTION 'PERSONAL_EXPORT_CORRUPT'; END IF;
  sources:=sources||jsonb_build_array(source);
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('candidateId',h.candidate_id,'approvalId',h.approval_id,'domain',h.domain,
 'aggregateId',h.aggregate_id,'versionId',h.version_id,'approvedAt',to_char(h.approved_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 ORDER BY h.candidate_id,h.approval_id,h.domain COLLATE "C",h.aggregate_id),'[]') INTO history
 FROM public.race_manual_application_history_v1 h WHERE h.athlete_id=t
 AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=h.candidate_id AND p.operation='review');
 SELECT coalesce(jsonb_agg(x.result ORDER BY x.candidate_id,x.operation COLLATE "C"),'[]') INTO results FROM (
  SELECT c.id AS candidate_id,'review'::text AS operation,jsonb_build_object('operation','review','candidateId',c.id,
   'result',jsonb_build_object('status','reviewed','reference',public.race_manual_public_reference_v1(t,c.id),'bodyState','present')) AS result
  FROM public.race_manual_application_candidate_v1 c WHERE c.athlete_id=t
   AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=c.id AND p.operation='review')
  UNION ALL
  SELECT a.candidate_id,'approve',jsonb_build_object('operation','approve','candidateId',a.candidate_id,'result',a.result)
  FROM public.race_manual_application_receipt_v1 a WHERE a.athlete_id=t
   AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=t AND p.candidate_id=a.candidate_id AND p.operation='review')
 )x;
 -- Fresh successful review was necessarily present (122 provenance guard).
 -- This is original success, not the current bodyState of a later replay.
 result:=jsonb_build_object('schemaVersion',1,'status','ready','sources',sources,'approvalHistory',history,'commandResults',results);
 IF octet_length(result::text)>byte_limit THEN RAISE EXCEPTION 'PERSONAL_EXPORT_TOO_LARGE'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_race_manual_personal_export_v1(integer) FROM PUBLIC;
