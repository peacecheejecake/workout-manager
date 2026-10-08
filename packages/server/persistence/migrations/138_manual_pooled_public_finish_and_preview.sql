-- Additive, explicitly selected pooled public finish and frozen reader.
-- Existing public functions/receipts/tables remain byte-identical. No grants.
DO $migration$
DECLARE predecessor pg_catalog.pg_proc%ROWTYPE; definition text; expected_body text;
 replacement record; dependency record; target record; new_oid oid; owner_oid oid;
 original_metadata jsonb:='[]';
BEGIN
 IF current_user<>session_user OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'POOLED_PUBLIC_INSTALL_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT relowner INTO STRICT owner_oid FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass;
 IF owner_oid<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'POOLED_PUBLIC_INSTALL_OWNER_REQUIRED'; END IF;
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
  ('public.finish_race_manual_public_review_v1(text,jsonb,uuid)','finish_race_manual_public_review_v1','finish_race_manual_pooled_public_review_v1','4f6abd28b10f2277c08ac8591396bb62bcec406cf50efb7a6d33652b8acf8f74'),
  ('public.read_race_manual_public_preview_source_v1(uuid)','read_race_manual_public_preview_source_v1','read_race_manual_pooled_public_preview_source_v1','77e6134fa464199e777535d516aada85e0f4f427f741946aae9a0157f04adc78')
 ) pin(signature,old_name,new_name,body_hash) LOOP
  SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(target.signature);
  IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>target.body_hash
   OR predecessor.proowner<>owner_oid OR NOT predecessor.prosecdef OR predecessor.provolatile<>'v'
   OR predecessor.prokind<>'f' OR predecessor.proisstrict OR predecessor.proleakproof OR predecessor.proparallel<>'u'
   OR predecessor.prorettype<>'jsonb'::regtype OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
  THEN RAISE EXCEPTION 'POOLED_PUBLIC_PREDECESSOR_MISMATCH'; END IF;
  original_metadata:=original_metadata||jsonb_build_array(to_jsonb(predecessor));
  IF pg_catalog.to_regprocedure(replace(target.signature,target.old_name,target.new_name)) IS NOT NULL THEN RAISE EXCEPTION 'POOLED_PUBLIC_ALREADY_INSTALLED'; END IF;
  definition:=pg_catalog.pg_get_functiondef(predecessor.oid); expected_body:=predecessor.prosrc;
  IF target.old_name='finish_race_manual_public_review_v1' THEN
   FOR replacement IN SELECT * FROM (VALUES
   ('internal_key text; result jsonb;','internal_key text; result jsonb; payload_encoding text;',1),
   (' internal_key:=''race_public_review_v1_''',' IF e.payload IS NOT NULL THEN
  IF e.payload->''payload''->''preparation'' ?| ARRAY[''encoding'',''encodingVersion'',''skeleton'',''sourcePool'',''substitutions'',''logicalValidationProfile'',''logicalDigestMethod'',''logicalDigest''] THEN
   PERFORM wm_manual_pooled.check_encoded(e.payload);
   payload_encoding:=''pooled-database-envelope-v1'';
  ELSE
   IF NOT wm_manual_pooled.exact_keys(e.payload->''payload''->''preparation'',ARRAY[''context'',''sourceInput'',''candidate''])
    OR jsonb_typeof(e.payload->''payload''->''preparation''->''context'') IS DISTINCT FROM ''object''
    OR jsonb_typeof(e.payload->''payload''->''preparation''->''sourceInput'') IS DISTINCT FROM ''object''
    OR jsonb_typeof(e.payload->''payload''->''preparation''->''candidate'') IS DISTINCT FROM ''object''
   THEN RAISE EXCEPTION ''POOLED_PUBLIC_ENCODING_INVALID''; END IF;
   payload_encoding:=''legacy-retained-v2'';
  END IF;
 END IF;
 internal_key:=''race_public_review_v1_''',1),
   ('e.payload->''payload''->''preparation''->''context''->''calendarIntent''','(CASE WHEN payload_encoding=''pooled-database-envelope-v1'' THEN wm_manual_pooled.lookup(e.payload,''context.calendarIntent'') ELSE e.payload->''payload''->''preparation''->''context''->''calendarIntent'' END)',1)
   ) changes(before_value,after_value,expected_count) LOOP
    IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
     OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
    THEN RAISE EXCEPTION 'POOLED_PUBLIC_REPLACEMENT_MISMATCH'; END IF;
    expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
    definition:=replace(definition,replacement.before_value,replacement.after_value);
   END LOOP;
  ELSE
   FOR replacement IN SELECT * FROM (VALUES
   ('retained record; result jsonb;','retained record; result jsonb; payload_encoding text;',1),
   ('RETURN jsonb_build_object(''reference'',public.race_manual_public_reference_v1(t,retained.id),
   ''bodyState'',''purged'',''candidate'',NULL,''preparation'',NULL);','RETURN jsonb_build_object(''readerVersion'',2,''reference'',public.race_manual_public_reference_v1(t,retained.id),
   ''bodyState'',''purged'',''candidate'',NULL,''payloadEncoding'',NULL,''payload'',NULL);',1),
   (' result:=jsonb_build_object(''reference''',' IF octet_length(retained.payload::text)>4194304 THEN RAISE EXCEPTION ''POOLED_PUBLIC_PREVIEW_BOUND''; END IF;
 PERFORM public.manual_race_v2_assert_json_bound(retained.payload);
 IF retained.payload->''payload''->''preparation'' ?| ARRAY[''encoding'',''encodingVersion'',''skeleton'',''sourcePool'',''substitutions'',''logicalValidationProfile'',''logicalDigestMethod'',''logicalDigest''] THEN
   PERFORM wm_manual_pooled.check_encoded(retained.payload);
   payload_encoding:=''pooled-database-envelope-v1'';
  ELSE
   IF NOT wm_manual_pooled.exact_keys(retained.payload->''payload''->''preparation'',ARRAY[''context'',''sourceInput'',''candidate''])
    OR jsonb_typeof(retained.payload->''payload''->''preparation''->''context'') IS DISTINCT FROM ''object''
    OR jsonb_typeof(retained.payload->''payload''->''preparation''->''sourceInput'') IS DISTINCT FROM ''object''
    OR jsonb_typeof(retained.payload->''payload''->''preparation''->''candidate'') IS DISTINCT FROM ''object''
   THEN RAISE EXCEPTION ''POOLED_PUBLIC_ENCODING_INVALID''; END IF;
   payload_encoding:=''legacy-retained-v2'';
  END IF;
 result:=jsonb_build_object(''readerVersion'',2,''reference''',1),
   ('''preparation'',retained.payload->''payload''->''preparation''','''payloadEncoding'',payload_encoding,''payload'',retained.payload',1)
   ) changes(before_value,after_value,expected_count) LOOP
    IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
     OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
    THEN RAISE EXCEPTION 'POOLED_PUBLIC_REPLACEMENT_MISMATCH'; END IF;
    expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
    definition:=replace(definition,replacement.before_value,replacement.after_value);
   END LOOP;
  END IF;
  IF (length(definition)-length(replace(definition,'public.'||target.old_name||'(','')))/length('public.'||target.old_name||'(')<>1 THEN RAISE EXCEPTION 'POOLED_PUBLIC_SIGNATURE_MISMATCH'; END IF;
  definition:=replace(definition,'public.'||target.old_name||'(','public.'||target.new_name||'(');
  EXECUTE definition;
  new_oid:=pg_catalog.to_regprocedure(replace(target.signature,target.old_name,target.new_name));
  EXECUTE 'REVOKE ALL ON FUNCTION '||replace(target.signature,target.old_name,target.new_name)||' FROM PUBLIC';
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=new_oid AND p.prosrc=expected_body AND p.proowner=predecessor.proowner
   AND p.prosecdef=predecessor.prosecdef AND p.prolang=predecessor.prolang AND p.prorettype=predecessor.prorettype AND p.provolatile=predecessor.provolatile AND p.proconfig IS NOT DISTINCT FROM predecessor.proconfig
   AND p.proargtypes=predecessor.proargtypes AND p.proargnames IS NOT DISTINCT FROM predecessor.proargnames
   AND (to_jsonb(p)-ARRAY['oid','proname','prosrc','proacl']) IS NOT DISTINCT FROM (to_jsonb(predecessor)-ARRAY['oid','proname','prosrc','proacl'])
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE'))
  THEN RAISE EXCEPTION 'POOLED_PUBLIC_SUCCESSOR_MISMATCH'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(original_metadata) before_row LEFT JOIN pg_catalog.pg_proc p ON p.oid=(before_row->>'oid')::oid WHERE p.oid IS NULL OR to_jsonb(p) IS DISTINCT FROM before_row)
 THEN RAISE EXCEPTION 'POOLED_PUBLIC_PREDECESSOR_CHANGED'; END IF;
END $migration$;
