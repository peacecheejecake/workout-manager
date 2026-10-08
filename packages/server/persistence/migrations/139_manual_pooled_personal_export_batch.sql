-- Explicit raw successor; profile/registry/installer and old readers unchanged.
-- Whole retained envelopes and candidate bodies appear once. Metadata is not
-- source authentication, admission, or a portable archive.
DO $migration$
DECLARE predecessor pg_catalog.pg_proc%ROWTYPE; definition text; expected_body text;
 replacement record; dependency record; target record; new_oid oid; owner_oid oid;
 original_metadata jsonb:='[]';
BEGIN
 IF current_user<>session_user OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'POOLED_EXPORT_INSTALL_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT relowner INTO STRICT owner_oid FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass;
 IF owner_oid<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'POOLED_EXPORT_INSTALL_OWNER_REQUIRED'; END IF;
 FOR dependency IN SELECT * FROM (VALUES
  ('wm_manual_pooled.assert_owner()','9924268629b85961a0ec32398bdbd8745746c419bb05ad739f6ce9befaa601f7','plpgsql','s'),
  ('wm_manual_pooled.exact_keys(jsonb,text[])','9c1b8e95b74508d1fa33c013610cb0496cdfc78a6b1220cac5d9b63e57da4aa2','sql','i'),
  ('wm_manual_pooled.path_parts(text,boolean)','a56655e900f4bd211b9b5c27356bb37eb5fbdcb9d97197075f2e0cbea9817cdf','plpgsql','i'),
  ('wm_manual_pooled.at_exact(jsonb,text[])','9c0f04724dbef25fedb8f2f3248d425897301d09c587bfaff6cabe1f65428994','plpgsql','i'),
  ('wm_manual_pooled.check_encoded(jsonb)','d54fb68ffbaf44eab7a6956e21f16cecb5a103efef125b20976d752e9cd3f4e0','plpgsql','s'),
  ('wm_manual_pooled.lookup(jsonb,text)','f27c360738286816fee3b744c9bbbc417394a14c02c17ddffcb746ab9894ebb7','plpgsql','s')
 ) pin(signature,body_hash,language,volatility) LOOP
  SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(dependency.signature);
  IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>dependency.body_hash
   OR predecessor.proowner<>owner_oid OR predecessor.prosecdef OR predecessor.provolatile::text<>dependency.volatility
   OR predecessor.prokind<>'f' OR predecessor.proisstrict OR predecessor.proleakproof OR predecessor.proparallel<>'u'
   OR predecessor.prorettype<>(CASE dependency.signature WHEN 'wm_manual_pooled.assert_owner()' THEN 'void'::regtype WHEN 'wm_manual_pooled.exact_keys(jsonb,text[])' THEN 'boolean'::regtype WHEN 'wm_manual_pooled.path_parts(text,boolean)' THEN 'text[]'::regtype WHEN 'wm_manual_pooled.check_encoded(jsonb)' THEN 'void'::regtype ELSE 'jsonb'::regtype END)
   OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname=dependency.language)
   OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
  THEN RAISE EXCEPTION 'POOLED_PROTOCOL_RESOLVER_MISMATCH'; END IF;
 END LOOP;
 FOR target IN SELECT * FROM (VALUES
  ('public.read_manual_race_internal_personal_export_v1(integer)','public.read_manual_race_internal_personal_export_v1','wm_manual_pooled.read_internal_export_v2','b8c17832d668481dc51175dd0cb2af71ab89b94342c83136c8562e67ab7086ee'),
  ('public.read_race_manual_personal_export_v1(integer)','public.read_race_manual_personal_export_v1','wm_manual_pooled.read_public_export_metadata_v2','5583dd9a33773a5dffeebbb92b9e23f191891354c3770418bcd98362a8055f8a'),
  ('public.read_manual_race_retained_source_batch_v1(integer)','public.read_manual_race_retained_source_batch_v1','public.read_manual_race_pooled_personal_export_batch_v1','041207534eaf528741327a022e5d005e733b48d5738dcb1a717578e79d1998eb'),
  ('public.read_manual_race_source_personal_export_v1(integer)','public.read_manual_race_source_personal_export_v1',NULL,'bb052b6eb730612f5b6cceb2dd333b4fec77be6740c800b006e7d4182463d924')
 ) pin(signature,old_name,new_name,body_hash) LOOP
  SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(target.signature);
  IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>target.body_hash
   OR predecessor.proowner<>owner_oid OR NOT predecessor.prosecdef OR predecessor.provolatile<>'v'
   OR predecessor.prokind<>'f' OR predecessor.proisstrict OR predecessor.proleakproof OR predecessor.proparallel<>'u'
   OR predecessor.prorettype<>'jsonb'::regtype OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
  THEN RAISE EXCEPTION 'POOLED_EXPORT_PREDECESSOR_MISMATCH'; END IF;
  original_metadata:=original_metadata||jsonb_build_array(to_jsonb(predecessor));
  IF target.new_name IS NULL THEN CONTINUE; END IF;
  IF pg_catalog.to_regprocedure(target.new_name||'(integer)') IS NOT NULL THEN RAISE EXCEPTION 'POOLED_EXPORT_ALREADY_INSTALLED'; END IF;
  definition:=pg_catalog.pg_get_functiondef(predecessor.oid); expected_body:=predecessor.prosrc;
  IF target.old_name='public.read_manual_race_internal_personal_export_v1' THEN
   FOR replacement IN SELECT * FROM (VALUES
    ('expected_result jsonb; entry jsonb; version_ref jsonb;','expected_result jsonb; entry jsonb; version_ref jsonb; payload_encoding text;',1),
    ('''bodyState'',''purged'',''preparation'',NULL','''bodyState'',''purged'',''payloadEncoding'',NULL,''payload'',NULL',1),
    ('   entry:=jsonb_build_object(''bodyState'',''present'',''preparation'',chain_row.payload->''payload''->''preparation'',''purge'',NULL);','   IF octet_length(chain_row.payload::text)>4194304 THEN RAISE EXCEPTION ''MANUAL_INTERNAL_EXPORT_TOO_LARGE''; END IF;
   PERFORM public.manual_race_v2_assert_json_bound(chain_row.payload);
   IF chain_row.payload->''payload''->''preparation'' ?| ARRAY[''encoding'',''encodingVersion'',''skeleton'',''sourcePool'',''substitutions'',''logicalValidationProfile'',''logicalDigestMethod'',''logicalDigest''] THEN
    PERFORM wm_manual_pooled.check_encoded(chain_row.payload);
    payload_encoding:=''pooled-database-envelope-v1'';
   ELSE
    IF NOT wm_manual_pooled.exact_keys(chain_row.payload->''payload''->''preparation'',ARRAY[''context'',''sourceInput'',''candidate''])
     OR jsonb_typeof(chain_row.payload->''payload''->''preparation''->''context'') IS DISTINCT FROM ''object''
     OR jsonb_typeof(chain_row.payload->''payload''->''preparation''->''sourceInput'') IS DISTINCT FROM ''object''
     OR jsonb_typeof(chain_row.payload->''payload''->''preparation''->''candidate'') IS DISTINCT FROM ''object''
    THEN RAISE EXCEPTION ''MANUAL_INTERNAL_EXPORT_CORRUPT''; END IF;
    payload_encoding:=''legacy-retained-v2'';
   END IF;
   entry:=jsonb_build_object(''bodyState'',''present'',''payloadEncoding'',payload_encoding,''payload'',chain_row.payload,''purge'',NULL);',1),
    ('result:=jsonb_build_object(''schemaVersion'',1,''chains''','result:=jsonb_build_object(''schemaVersion'',2,''chains''',1),
    ('conservative upper bound even though only their frozen preparation is sent.','one-copy upper bound for the complete stored retained envelope.',1)
   ) changes(before_value,after_value,expected_count) LOOP
    IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
     OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
    THEN RAISE EXCEPTION 'POOLED_EXPORT_REPLACEMENT_MISMATCH'; END IF;
    expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
    definition:=replace(definition,replacement.before_value,replacement.after_value);
   END LOOP;
  ELSIF target.old_name='public.read_race_manual_personal_export_v1' THEN
   FOR replacement IN SELECT * FROM (VALUES
    ('export_candidate_row record; source jsonb;','export_candidate_row record; retained record; source jsonb;',1),
    (' SELECT coalesce(sum(coalesce(octet_length(c.candidate_json::text),0)+coalesce(octet_length(e.payload::text),0)
  +coalesce(octet_length(a.result::text),0)+coalesce((SELECT max(octet_length(p.result::text)) FROM public.race_manual_public_receipt_v1 p
   WHERE p.athlete_id=t AND p.candidate_id=c.id AND p.operation=''review''),0)*3+4096),0)
',' SELECT coalesce(sum(coalesce(octet_length(a.result::text),0)+coalesce((SELECT max(octet_length(p.result::text)) FROM public.race_manual_public_receipt_v1 p
   WHERE p.athlete_id=t AND p.candidate_id=c.id AND p.operation=''review''),0)*3+4096),0)',1),
    ('  source:=public.read_race_manual_public_preview_source_v1(export_candidate_row.id);','  SELECT c.id,c.evidence_id,c.decision_id,c.proposal_id,c.candidate_json,
   c.purged_event_id,c.purged_at,e.payload,
   e.purged_event_id AS evidence_purged_event_id,e.purged_at AS evidence_purged_at
  INTO retained
  FROM public.race_manual_application_candidate_v1 c
  JOIN public.manual_race_evidence_v2 e ON e.athlete_id=c.athlete_id AND e.id=c.evidence_id
  WHERE c.athlete_id=t AND c.id=export_candidate_row.id FOR SHARE OF e,c;
  IF NOT FOUND THEN RAISE EXCEPTION ''PERSONAL_EXPORT_CORRUPT''; END IF;
  IF retained.candidate_json IS NULL THEN
   IF retained.payload IS NOT NULL OR retained.purged_event_id IS NULL OR retained.purged_at IS NULL
    OR retained.purged_event_id IS DISTINCT FROM retained.evidence_purged_event_id
    OR retained.purged_at IS DISTINCT FROM retained.evidence_purged_at
   THEN RAISE EXCEPTION ''PERSONAL_EXPORT_CORRUPT''; END IF;
  ELSE
   IF retained.payload IS NULL OR retained.purged_event_id IS NOT NULL OR retained.purged_at IS NOT NULL
    OR retained.evidence_purged_event_id IS NOT NULL OR retained.evidence_purged_at IS NOT NULL
    OR jsonb_typeof(retained.payload->''payload''->''preparation'') IS DISTINCT FROM ''object''
    OR retained.candidate_json->''chain''->>''evidenceId'' IS DISTINCT FROM retained.evidence_id::text
    OR retained.candidate_json->''chain''->>''decisionId'' IS DISTINCT FROM retained.decision_id::text
    OR retained.candidate_json->''chain''->>''proposalId'' IS DISTINCT FROM retained.proposal_id::text
   THEN RAISE EXCEPTION ''PERSONAL_EXPORT_CORRUPT''; END IF;
  END IF;
  source:=jsonb_build_object(''candidateId'',retained.id,''evidenceId'',retained.evidence_id,
   ''reference'',public.race_manual_public_reference_v1(t,retained.id),
   ''bodyState'',CASE WHEN retained.candidate_json IS NULL THEN ''purged'' ELSE ''present'' END);',1),
    ('result:=jsonb_build_object(''schemaVersion'',1,''status''','result:=jsonb_build_object(''schemaVersion'',2,''status''',1),
    ('Conservative raw transfer accounting includes reference, source and normalized
 -- result duplicates.','Scalar transport accounting contains only references and original normalized
 -- result duplicates; no candidate or retained envelope copy.',1)
   ) changes(before_value,after_value,expected_count) LOOP
    IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
     OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
    THEN RAISE EXCEPTION 'POOLED_EXPORT_REPLACEMENT_MISMATCH'; END IF;
    expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
    definition:=replace(definition,replacement.before_value,replacement.after_value);
   END LOOP;
  ELSIF target.old_name='public.read_manual_race_retained_source_batch_v1' THEN
   FOR replacement IN SELECT * FROM (VALUES
    ('internal_json jsonb; internal_chain jsonb; preparation jsonb; preparation_binding jsonb; metadata_budget bigint;','internal_json jsonb; internal_chain jsonb; retained_payload jsonb; payload_binding jsonb; metadata_budget bigint; public_budget bigint; public_json jsonb;',1),
    (' metadata_budget:=raw_bytes+1024;',' metadata_budget:=raw_bytes+1024;
 IF (SELECT count(*) FROM public.race_manual_application_candidate_v1 c WHERE c.athlete_id=tenant AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=tenant AND p.candidate_id=c.id AND p.operation=''review''))
  +(SELECT count(*) FROM public.race_manual_application_receipt_v1 a WHERE a.athlete_id=tenant AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=tenant AND p.candidate_id=a.candidate_id AND p.operation=''review''))>1000
  OR (SELECT count(*) FROM public.plan_snapshot_aggregate a WHERE a.athlete_id=tenant)>1000
 THEN RAISE EXCEPTION ''PERSONAL_EXPORT_TOO_LARGE''; END IF;
 -- Reserve public metadata before asking for any retained body, without reading
 -- or aggregating candidate/preparation bodies through an old full reader.
 SELECT coalesce((SELECT sum(4096+3*coalesce((SELECT max(octet_length(p.result::text)) FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=tenant AND p.candidate_id=c.id AND p.operation=''review''),0)) FROM public.race_manual_application_candidate_v1 c
  WHERE c.athlete_id=tenant AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=tenant AND p.candidate_id=c.id AND p.operation=''review'')),0)
 +coalesce((SELECT sum(1024+octet_length(a.result::text)) FROM public.race_manual_application_receipt_v1 a
  WHERE a.athlete_id=tenant AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=tenant AND p.candidate_id=a.candidate_id AND p.operation=''review'')),0)
 +coalesce((SELECT count(*)*1024 FROM public.race_manual_application_history_v1 h WHERE h.athlete_id=tenant
  AND EXISTS(SELECT 1 FROM public.race_manual_public_receipt_v1 p WHERE p.athlete_id=tenant AND p.candidate_id=h.candidate_id AND p.operation=''review'')),0)
 +coalesce((SELECT sum(octet_length(jsonb_build_object(''version_id'',a.version_id,''aggregate_id'',a.aggregate_id)::text)) FROM public.plan_snapshot_aggregate a WHERE a.athlete_id=tenant),0)+2048 INTO public_budget;
 metadata_budget:=metadata_budget+public_budget;',1),
    ('internal_json:=public.read_manual_race_internal_personal_export_v1','internal_json:=wm_manual_pooled.read_internal_export_v2',1),
    ('internal_json->>''schemaVersion'' IS DISTINCT FROM ''1''','internal_json->>''schemaVersion'' IS DISTINCT FROM ''2''',1),
    ('preparation:=CASE WHEN chain_row.payload IS NULL THEN NULL ELSE chain_row.payload->''payload''->''preparation'' END;','retained_payload:=chain_row.payload;',1),
    ('internal_chain->''preparation'' IS DISTINCT FROM ''null''::jsonb','internal_chain->''payload'' IS DISTINCT FROM ''null''::jsonb OR internal_chain->''payloadEncoding'' IS DISTINCT FROM ''null''::jsonb',1),
    ('preparation_binding:=jsonb_build_object(''state'',''purged'',''digestMethod'',''postgres-jsonb-v1'',''digest'',NULL);','payload_binding:=jsonb_build_object(''state'',''purged'',''digestMethod'',''postgres-retained-envelope-jsonb-v1'',''digest'',NULL);',1),
    ('OR jsonb_typeof(preparation) IS DISTINCT FROM ''object'' OR internal_chain->''preparation'' IS DISTINCT FROM preparation','OR jsonb_typeof(retained_payload) IS DISTINCT FROM ''object'' OR internal_chain->''payload'' IS DISTINCT FROM retained_payload
    OR internal_chain->>''payloadEncoding'' IS NULL OR internal_chain->>''payloadEncoding'' NOT IN (''legacy-retained-v2'',''pooled-database-envelope-v1'')',1),
    ('preparation_binding:=jsonb_build_object(''state'',''present'',''digestMethod'',''postgres-jsonb-v1'',''digest'',encode(sha256(convert_to(preparation::text,''UTF8'')),''hex''));','payload_binding:=jsonb_build_object(''state'',''present'',''digestMethod'',''postgres-retained-envelope-jsonb-v1'',''digest'',encode(sha256(convert_to(retained_payload::text,''UTF8'')),''hex''));',1),
    ('''preparationBinding'',preparation_binding','''payloadBinding'',payload_binding',1),
    (' result:=jsonb_build_object(''schemaVersion'',1,''internal'',internal_json,''sourceMetadata'',jsonb_build_object(''schemaVersion'',1,''chains'',chains,''refs'',refs,''parents'',parents,''suppressions'',suppressions));',' public_json:=wm_manual_pooled.read_public_export_metadata_v2(public_budget::integer);
 -- Public filtered sources are a strict subset of the complete internal census.
 -- Match original identity/reference and current body state, without extra bodies.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(public_json->''sources'') s(value)
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(internal_json->''candidates'') c(value)
   JOIN jsonb_array_elements(internal_json->''chains'') e(value) ON e.value->>''evidenceId''=c.value->''chain''->>''evidenceId''
   WHERE c.value->>''candidateId''=s.value->>''candidateId'' AND e.value->>''evidenceId''=s.value->>''evidenceId''
    AND c.value->>''bodyState''=s.value->>''bodyState'' AND e.value->>''bodyState''=s.value->>''bodyState''
    AND s.value->''reference''->>''candidateId''=c.value->>''candidateId''
    AND s.value->''reference''->''chain''->>''evidenceId''=e.value->>''evidenceId''
    AND s.value->''reference''->''chain''->>''decisionId''=e.value->>''decisionId''
    AND s.value->''reference''->''chain''->>''proposalId''=e.value->>''proposalId''
    AND s.value->''reference''->''chain''->>''readonlyCandidateDigest''=e.value->''originalResult''->>''candidateDigest''))
 THEN RAISE EXCEPTION ''MANUAL_SOURCE_EXPORT_CORRUPT''; END IF;
 result:=jsonb_build_object(''batchVersion'',2,''internal'',internal_json,''sourceMetadata'',jsonb_build_object(''schemaVersion'',2,''chains'',chains,''refs'',refs,''parents'',parents,''suppressions'',suppressions),''publicMetadata'',public_json);',1)
   ) changes(before_value,after_value,expected_count) LOOP
    IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
     OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
    THEN RAISE EXCEPTION 'POOLED_EXPORT_REPLACEMENT_MISMATCH'; END IF;
    expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
    definition:=replace(definition,replacement.before_value,replacement.after_value);
   END LOOP;
  END IF;
  IF (length(definition)-length(replace(definition,target.old_name||'(','')))/length(target.old_name||'(')<>1 THEN RAISE EXCEPTION 'POOLED_EXPORT_SIGNATURE_MISMATCH'; END IF;
  definition:=replace(definition,target.old_name||'(',target.new_name||'(');
  EXECUTE definition;
  new_oid:=pg_catalog.to_regprocedure(target.new_name||'(integer)');
  EXECUTE 'REVOKE ALL ON FUNCTION '||target.new_name||'(integer) FROM PUBLIC';
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=new_oid AND p.prosrc=expected_body
   AND p.pronamespace=(CASE WHEN target.new_name LIKE 'wm_manual_pooled.%' THEN 'wm_manual_pooled' ELSE 'public' END)::regnamespace
   AND (to_jsonb(p)-ARRAY['oid','proname','pronamespace','prosrc','proacl']) IS NOT DISTINCT FROM (to_jsonb(predecessor)-ARRAY['oid','proname','pronamespace','prosrc','proacl'])
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE'))
  THEN RAISE EXCEPTION 'POOLED_EXPORT_SUCCESSOR_MISMATCH'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(original_metadata) before_row LEFT JOIN pg_catalog.pg_proc p ON p.oid=(before_row->>'oid')::oid WHERE p.oid IS NULL OR to_jsonb(p) IS DISTINCT FROM before_row)
 THEN RAISE EXCEPTION 'POOLED_EXPORT_PREDECESSOR_CHANGED'; END IF;
 -- Private namespace remains owner-only; this migration grants no runtime rights.
 IF (SELECT nspowner FROM pg_catalog.pg_namespace WHERE oid='wm_manual_pooled'::regnamespace) IS DISTINCT FROM owner_oid OR EXISTS(SELECT 1 FROM aclexplode(coalesce((SELECT nspacl FROM pg_catalog.pg_namespace WHERE oid='wm_manual_pooled'::regnamespace),acldefault('n',owner_oid))) a WHERE a.grantee<>owner_oid)
 THEN RAISE EXCEPTION 'POOLED_EXPORT_PRIVATE_SCHEMA_MISMATCH'; END IF;
END $migration$;
