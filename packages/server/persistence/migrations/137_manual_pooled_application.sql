-- Bounded pooled authoritative application successors. No approval is minted
-- from caller JSON/hash/status: original actual basis/recipe/context/write guards
-- remain. Original functions, tables, ACLs and historical wires are unchanged.
DO $migration$
DECLARE target record; predecessor pg_catalog.pg_proc%ROWTYPE; dependency record;
 expected_body text; definition text; replacement record; owner_oid oid; new_oid oid;
 original_functions jsonb:='[]'; original_row jsonb;
BEGIN
 IF current_user<>session_user OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'POOLED_APPLICATION_INSTALL_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT relowner INTO STRICT owner_oid FROM pg_catalog.pg_class WHERE oid='public.race_manual_application_context_v1'::regclass;
 IF owner_oid<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'POOLED_APPLICATION_INSTALL_OWNER_REQUIRED'; END IF;
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
   OR predecessor.prokind<>'f' OR predecessor.proisstrict OR predecessor.proleakproof OR predecessor.proparallel<>'u' OR predecessor.prorettype<>(CASE WHEN dependency.signature='wm_manual_pooled.assert_owner()' OR dependency.signature='wm_manual_pooled.check_encoded(jsonb)' THEN 'void'::regtype WHEN dependency.signature='wm_manual_pooled.exact_keys(jsonb,text[])' THEN 'boolean'::regtype WHEN dependency.signature='wm_manual_pooled.path_parts(text,boolean)' THEN 'text[]'::regtype ELSE 'jsonb'::regtype END)
   OR predecessor.proowner<>owner_oid OR predecessor.prosecdef OR predecessor.provolatile::text<>dependency.volatility
   OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname=dependency.language)
   OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
  THEN RAISE EXCEPTION 'POOLED_APPLICATION_RESOLVER_MISMATCH'; END IF;
 END LOOP;
 SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc WHERE oid='public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>'2ea13f35abf5773a7f5b6c267127ad500fbc021e73f8506bf180ecbc2313e2d8'
  OR predecessor.prokind<>'f' OR predecessor.proisstrict OR predecessor.proleakproof OR predecessor.proparallel<>'u'
  OR predecessor.proowner<>owner_oid OR NOT predecessor.prosecdef OR predecessor.provolatile<>'v' OR predecessor.prorettype<>'void'::regtype
  OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
 THEN RAISE EXCEPTION 'POOLED_APPLICATION_BASIS_MISMATCH'; END IF;
 FOR target IN SELECT * FROM (VALUES
 ('public.race_manual_relative_membership_v1(jsonb)','public.race_manual_pooled_relative_membership_v1(jsonb)','race_manual_relative_membership_v1','race_manual_pooled_relative_membership_v1','7b1cfd89b9abb17de7c94fb606e831e703421db935b15b41ff87bb94b9b70671',true,'void','v',ARRAY['search_path=pg_catalog, pg_temp']::text[]),
 ('public.race_manual_routine_expansion_v1(jsonb,jsonb,jsonb,text)','public.race_manual_pooled_routine_expansion_v1(jsonb,jsonb,jsonb,text)','race_manual_routine_expansion_v1','race_manual_pooled_routine_expansion_v1','c5f0ba5fcfe8f1a84abc6e32586fd538eb9e5a88b052cec372444dc791de8332',false,'jsonb','s',ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC']::text[]),
 ('public.race_manual_application_validate_recipes_v1(jsonb,jsonb)','public.race_manual_pooled_validate_recipes_v1(jsonb,jsonb)','race_manual_application_validate_recipes_v1','race_manual_pooled_validate_recipes_v1','6dba7ef0210c2c1acb2b7f772ca40f5196142e39d8263d06ba2c6f749c55de64',true,'void','v',ARRAY['search_path=pg_catalog, pg_temp']::text[]),
 ('public.prepare_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)','public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)','prepare_race_manual_application_v1','prepare_race_manual_pooled_application_v1','b4233f19ebf6b7fd246d035fc2eab91d647b477c7e8d890a3a04039154ba46c3',true,'jsonb','v',ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]),
 ('public.begin_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)','public.begin_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)','begin_race_manual_application_v1','begin_race_manual_pooled_application_v1','28eb84586bb440eded89e32eff810a46ebbc32d6ece78e136b60007721009458',true,'uuid','v',ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[])
 ) pins(old_signature,new_signature,old_name,new_name,body_sha,definer,result_type,volatility,configuration) LOOP
  SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(target.old_signature);
  IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>target.body_sha OR predecessor.proowner<>owner_oid
   OR predecessor.prokind<>'f' OR predecessor.proisstrict OR predecessor.proleakproof OR predecessor.proparallel<>'u'
   OR predecessor.prosecdef IS DISTINCT FROM target.definer OR predecessor.provolatile::text<>target.volatility
   OR predecessor.prorettype<>target.result_type::regtype OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR predecessor.proconfig IS DISTINCT FROM target.configuration
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
  THEN RAISE EXCEPTION 'POOLED_APPLICATION_PREDECESSOR_MISMATCH'; END IF;
  IF to_regprocedure(target.new_signature) IS NOT NULL THEN RAISE EXCEPTION 'POOLED_APPLICATION_ALREADY_INSTALLED'; END IF;
  original_functions:=original_functions||jsonb_build_array(to_jsonb(predecessor));
  definition:=pg_get_functiondef(predecessor.oid); expected_body:=predecessor.prosrc;
IF target.old_name='race_manual_relative_membership_v1' THEN
 FOR replacement IN SELECT * FROM (VALUES
 ('retained->''payload''->''preparation''->''context''','wm_manual_pooled.lookup(retained,''context'')',1),
 ('retained->''payload''->''preparation''->''candidate''->''body''->''projection''','wm_manual_pooled.lookup(retained,''candidate.body.projection'')',1),
 ('retained->''payload''->''preparation''->''sourceInput''->''projectionInput''','wm_manual_pooled.lookup(retained,''sourceInput.projectionInput'')',1)
 ) replacements(before_value,after_value,expected_count) LOOP
  IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
   OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
  THEN RAISE EXCEPTION 'POOLED_APPLICATION_REPLACEMENT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
  definition:=replace(definition,replacement.before_value,replacement.after_value);
 END LOOP;
END IF;
IF target.old_name='race_manual_routine_expansion_v1' THEN
 FOR replacement IN SELECT * FROM (VALUES
 ('retained->''payload''->''preparation''->''context''','wm_manual_pooled.lookup(retained,''context'')',1)
 ) replacements(before_value,after_value,expected_count) LOOP
  IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
   OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
  THEN RAISE EXCEPTION 'POOLED_APPLICATION_REPLACEMENT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
  definition:=replace(definition,replacement.before_value,replacement.after_value);
 END LOOP;
END IF;
IF target.old_name='race_manual_application_validate_recipes_v1' THEN
 FOR replacement IN SELECT * FROM (VALUES
 ('retained->''payload''->''preparation''->''context''','wm_manual_pooled.lookup(retained,''context'')',1),
 ('retained->''payload''->''preparation''->''candidate''->''body''->''projection''','wm_manual_pooled.lookup(retained,''candidate.body.projection'')',1),
 ('retained->''payload''->''preparation''->''sourceInput''->''projectionInput''->''resolutions''->''routines''','wm_manual_pooled.lookup(retained,''sourceInput.projectionInput.resolutions.routines'')',1),
 ('public.race_manual_relative_membership_v1(retained)','public.race_manual_pooled_relative_membership_v1(retained)',1),
 ('public.race_manual_routine_expansion_v1(retained,','public.race_manual_pooled_routine_expansion_v1(retained,',1)
 ) replacements(before_value,after_value,expected_count) LOOP
  IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
   OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
  THEN RAISE EXCEPTION 'POOLED_APPLICATION_REPLACEMENT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
  definition:=replace(definition,replacement.before_value,replacement.after_value);
 END LOOP;
END IF;
IF target.old_name='prepare_race_manual_application_v1' THEN
 FOR replacement IN SELECT * FROM (VALUES
 ('public.validate_race_manual_multi_owned_basis_v3($3,$2,$4)','public.validate_race_manual_pooled_application_basis_v1($3,$2,$4)',1),
 ('public.race_manual_application_validate_recipes_v1($1,$3)','public.race_manual_pooled_validate_recipes_v1($1,$3)',1),
 ('parent.payload->''payload''->''preparation''->''candidate''->''body''->''projection''','(CASE WHEN parent.payload->''payload''->''preparation'' ?| ARRAY[''encoding'',''encodingVersion'',''skeleton'',''sourcePool'',''substitutions'',''logicalValidationProfile'',''logicalDigestMethod'',''logicalDigest''] THEN wm_manual_pooled.lookup(parent.payload,''candidate.body.projection'') ELSE parent.payload->''payload''->''preparation''->''candidate''->''body''->''projection'' END)',1),
 ('$3->''payload''->''preparation''->''candidate''->''body''->''projection''','wm_manual_pooled.lookup($3,''candidate.body.projection'')',1),
 ('old_context:=parent.payload->''payload''->''preparation''->''context'';','IF parent.payload->''payload''->''preparation'' ?| ARRAY[''encoding'',''encodingVersion'',''skeleton'',''sourcePool'',''substitutions'',''logicalValidationProfile'',''logicalDigestMethod'',''logicalDigest''] THEN PERFORM wm_manual_pooled.check_encoded(parent.payload); old_context:=wm_manual_pooled.lookup(parent.payload,''context'');
 ELSE IF NOT wm_manual_pooled.exact_keys(parent.payload->''payload''->''preparation'',ARRAY[''context'',''sourceInput'',''candidate'']) OR jsonb_typeof(parent.payload->''payload''->''preparation''->''context'') IS DISTINCT FROM ''object'' OR jsonb_typeof(parent.payload->''payload''->''preparation''->''sourceInput'') IS DISTINCT FROM ''object'' OR jsonb_typeof(parent.payload->''payload''->''preparation''->''candidate'') IS DISTINCT FROM ''object'' THEN RAISE EXCEPTION ''POOLED_APPLICATION_PARENT_ENCODING''; END IF; old_context:=parent.payload->''payload''->''preparation''->''context''; END IF;',1),
 ('current_context:=$3->''payload''->''preparation''->''context''','current_context:=wm_manual_pooled.lookup($3,''context'')',1)
 ) replacements(before_value,after_value,expected_count) LOOP
  IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
   OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
  THEN RAISE EXCEPTION 'POOLED_APPLICATION_REPLACEMENT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
  definition:=replace(definition,replacement.before_value,replacement.after_value);
 END LOOP;
END IF;
IF target.old_name='begin_race_manual_application_v1' THEN
 FOR replacement IN SELECT * FROM (VALUES
 ('public.validate_race_manual_multi_owned_basis_v3($3,$2,$4)','public.validate_race_manual_pooled_application_basis_v1($3,$2,$4)',1),
 ('public.race_manual_application_validate_recipes_v1(c.candidate_json,$3)','public.race_manual_pooled_validate_recipes_v1(c.candidate_json,$3)',1)
 ) replacements(before_value,after_value,expected_count) LOOP
  IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
   OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
  THEN RAISE EXCEPTION 'POOLED_APPLICATION_REPLACEMENT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
  definition:=replace(definition,replacement.before_value,replacement.after_value);
 END LOOP;
END IF;
  IF (length(definition)-length(replace(definition,'public.'||target.old_name||'(','')))/length('public.'||target.old_name||'(')<>1 THEN RAISE EXCEPTION 'POOLED_APPLICATION_SIGNATURE_MISMATCH'; END IF;
  definition:=replace(definition,'public.'||target.old_name||'(','public.'||target.new_name||'(');
  EXECUTE definition;
  EXECUTE 'REVOKE ALL ON FUNCTION '||target.new_signature||' FROM PUBLIC';
  new_oid:=to_regprocedure(target.new_signature);
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=new_oid AND p.prosrc=expected_body AND p.proowner=predecessor.proowner
   AND (to_jsonb(p)-ARRAY['oid','proname','prosrc','proacl'])=(to_jsonb(predecessor)-ARRAY['oid','proname','prosrc','proacl'])
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE'))
  THEN RAISE EXCEPTION 'POOLED_APPLICATION_SUCCESSOR_MISMATCH'; END IF;
 END LOOP;
 FOR original_row IN SELECT value FROM jsonb_array_elements(original_functions) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=(original_row->>'oid')::oid AND to_jsonb(p)=original_row) THEN RAISE EXCEPTION 'POOLED_APPLICATION_PREDECESSOR_CHANGED'; END IF;
 END LOOP;
END $migration$;
