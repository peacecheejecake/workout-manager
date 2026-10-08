-- Named pooled successors only; historical function OIDs/bodies/ACLs remain unchanged.
-- Encoded DB envelope <=4MiB; selected roots/DTOs <=4MiB. Never reconstruct
-- a whole expanded retained object. Node canonical digests do not prove SQL authority.
DO $migration$
DECLARE predecessor pg_catalog.pg_proc%ROWTYPE; original_definition text; definition text;
 expected_body text; replacement record; dependency record; new_oid oid; store_mode boolean;
 old_name text; new_name text; encoded_arg text; source_hash text; owner_oid oid;
BEGIN
 IF current_user<>session_user OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'POOLED_PROTOCOL_INSTALL_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT relowner INTO STRICT owner_oid FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass;
 IF owner_oid<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'POOLED_PROTOCOL_INSTALL_OWNER_REQUIRED'; END IF;
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
   OR predecessor.prorettype<>(CASE dependency.signature
    WHEN 'wm_manual_pooled.assert_owner()' THEN 'void'::regtype
    WHEN 'wm_manual_pooled.exact_keys(jsonb,text[])' THEN 'boolean'::regtype
    WHEN 'wm_manual_pooled.path_parts(text,boolean)' THEN 'text[]'::regtype
    WHEN 'wm_manual_pooled.check_encoded(jsonb)' THEN 'void'::regtype
    ELSE 'jsonb'::regtype END)
   OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname=dependency.language)
   OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
  THEN RAISE EXCEPTION 'POOLED_PROTOCOL_RESOLVER_MISMATCH'; END IF;
 END LOOP;
 FOR store_mode IN SELECT unnest(ARRAY[true,false]) LOOP
  IF store_mode THEN
   old_name:='store_manual_race_multi_owned_chain_v3'; new_name:='store_manual_race_pooled_chain_v1'; encoded_arg:='$6';
   SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc WHERE oid='public.store_manual_race_multi_owned_chain_v3(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure;
   source_hash:='cebc600818ea852473d718006ba6f939cf81e7b56c1e7770dbed33f60d7a926b';
  ELSE
   old_name:='validate_race_manual_multi_owned_basis_v3'; new_name:='validate_race_manual_pooled_application_basis_v1'; encoded_arg:='$1';
   SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc WHERE oid='public.validate_race_manual_multi_owned_basis_v3(jsonb,jsonb,jsonb)'::regprocedure;
   source_hash:='37af20b64a540ef98c9246e10fe564b2549523615f060d3d76b756b5a675b339';
  END IF;
  IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>source_hash OR NOT predecessor.prosecdef
   OR predecessor.proowner<>owner_oid OR predecessor.provolatile<>'v' OR predecessor.prorettype<>'jsonb'::regtype AND store_mode
   OR predecessor.prorettype<>'void'::regtype AND NOT store_mode
   OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
  THEN RAISE EXCEPTION 'POOLED_PROTOCOL_PREDECESSOR_MISMATCH'; END IF;
  original_definition:=pg_catalog.pg_get_functiondef(predecessor.oid); definition:=original_definition; expected_body:=predecessor.prosrc;
  -- Count every replacement against the independently pinned final body.
  FOR replacement IN SELECT * FROM (VALUES
   ('inner_payload jsonb;', 'inner_payload jsonb; pooled_context jsonb; pooled_candidate jsonb;',1),
   ('PERFORM public.manual_race_v2_assert_json_bound('||encoded_arg||');',
    'PERFORM wm_manual_pooled.check_encoded('||encoded_arg||'); pooled_context:=wm_manual_pooled.lookup('||encoded_arg||',''context''); pooled_candidate:=wm_manual_pooled.lookup('||encoded_arg||',''candidate'');',1),
   (encoded_arg||'->''payload''->''preparation''->''context''','pooled_context',3),
   (encoded_arg||'->''payload''->''preparation''->''candidate''','pooled_candidate',2),
   ('inner_payload->''preparation''->''context''','pooled_context',2),
   ('public.manual_race_v2_json_at(inner_payload->''preparation'',location)',
    'wm_manual_pooled.lookup('||encoded_arg||',location)',1)
  ) changes(before_value,after_value,expected_count) LOOP
   IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
    OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
   THEN RAISE EXCEPTION 'POOLED_PROTOCOL_REPLACEMENT_MISMATCH'; END IF;
   expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
   definition:=replace(definition,replacement.before_value,replacement.after_value);
  END LOOP;
  IF (length(definition)-length(replace(definition,'public.'||old_name||'(','')))/length('public.'||old_name||'(')<>1 THEN RAISE EXCEPTION 'POOLED_PROTOCOL_SIGNATURE_MISMATCH'; END IF;
  definition:=replace(definition,'public.'||old_name||'(','public.'||new_name||'(');
  IF store_mode THEN
   IF pg_catalog.to_regprocedure('public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'POOLED_PROTOCOL_ALREADY_INSTALLED'; END IF;
  ELSE
   IF pg_catalog.to_regprocedure('public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'POOLED_PROTOCOL_ALREADY_INSTALLED'; END IF;
  END IF;
  EXECUTE definition;
  IF store_mode THEN
   new_oid:='public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure;
   EXECUTE 'REVOKE ALL ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC';
  ELSE
   new_oid:='public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)'::regprocedure;
   EXECUTE 'REVOKE ALL ON FUNCTION public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb) FROM PUBLIC';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=new_oid AND p.prosrc=expected_body AND p.proowner=predecessor.proowner
   AND p.prosecdef=predecessor.prosecdef AND p.prolang=predecessor.prolang AND p.prorettype=predecessor.prorettype AND p.provolatile=predecessor.provolatile
   AND p.proconfig IS NOT DISTINCT FROM predecessor.proconfig
   AND (to_jsonb(p)-ARRAY['oid','proname','prosrc','proacl']) IS NOT DISTINCT FROM (to_jsonb(predecessor)-ARRAY['oid','proname','prosrc','proacl'])
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE'))
  THEN RAISE EXCEPTION 'POOLED_PROTOCOL_SUCCESSOR_MISMATCH'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=predecessor.oid AND to_jsonb(p) IS DISTINCT FROM to_jsonb(predecessor)) THEN RAISE EXCEPTION 'POOLED_PROTOCOL_PREDECESSOR_CHANGED'; END IF;
 END LOOP;
END $migration$;
