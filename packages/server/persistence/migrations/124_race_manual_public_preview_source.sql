-- Explicit retained-read successor; normal registry107 stays unchanged.
-- Return only the stored application candidate and its exact frozen preparation.
-- Mutable heads, present-day source recapture and approval authority are absent.
CREATE FUNCTION public.read_race_manual_public_preview_source_v1(candidate uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=public.race_manual_public_scope_v1(); retained record; result jsonb;
BEGIN
 IF $1 IS NULL THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_PREVIEW_INVALID_INPUT'; END IF;
 SELECT c.id,c.evidence_id,c.decision_id,c.proposal_id,c.candidate_json,
  c.purged_event_id,c.purged_at,e.payload,
  e.purged_event_id AS evidence_purged_event_id,e.purged_at AS evidence_purged_at
 INTO retained
 FROM public.race_manual_application_candidate_v1 c
 JOIN public.manual_race_evidence_v2 e ON e.athlete_id=c.athlete_id AND e.id=c.evidence_id
 WHERE c.athlete_id=t AND c.id=$1
 FOR SHARE OF e,c;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF retained.candidate_json IS NULL THEN
  IF retained.payload IS NOT NULL OR retained.purged_event_id IS NULL
   OR retained.purged_at IS NULL
   OR retained.purged_event_id IS DISTINCT FROM retained.evidence_purged_event_id
   OR retained.purged_at IS DISTINCT FROM retained.evidence_purged_at
  THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_PREVIEW_PROVENANCE_INVALID'; END IF;
  RETURN jsonb_build_object('reference',public.race_manual_public_reference_v1(t,retained.id),
   'bodyState','purged','candidate',NULL,'preparation',NULL);
 END IF;
 IF retained.payload IS NULL OR retained.purged_event_id IS NOT NULL
  OR retained.purged_at IS NOT NULL OR retained.evidence_purged_event_id IS NOT NULL
  OR retained.evidence_purged_at IS NOT NULL
  OR jsonb_typeof(retained.payload->'payload'->'preparation') IS DISTINCT FROM 'object'
  OR retained.candidate_json->'chain'->>'evidenceId' IS DISTINCT FROM retained.evidence_id::text
  OR retained.candidate_json->'chain'->>'decisionId' IS DISTINCT FROM retained.decision_id::text
  OR retained.candidate_json->'chain'->>'proposalId' IS DISTINCT FROM retained.proposal_id::text
 THEN RAISE EXCEPTION 'RACE_MANUAL_PUBLIC_PREVIEW_PROVENANCE_INVALID'; END IF;
 result:=jsonb_build_object('reference',public.race_manual_public_reference_v1(t,retained.id),
  'bodyState','present','candidate',retained.candidate_json,
  'preparation',retained.payload->'payload'->'preparation');
 -- The consumer additionally measures this whole result before body transport,
 -- charges its shared response budget, and strictly projects the public DTO.
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_race_manual_public_preview_source_v1(uuid) FROM PUBLIC;
