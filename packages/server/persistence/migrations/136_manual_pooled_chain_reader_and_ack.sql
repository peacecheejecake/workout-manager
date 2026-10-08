-- Explicit pooled reader / same-xid acknowledgement, not admission or approval.
-- Historical readers, receipts, payloads and function bodies remain unchanged.
-- Encoded PGJSONB SHA and Node logical DTO digest remain distinct namespaces.
DO $migration$
DECLARE predecessor pg_catalog.pg_proc%ROWTYPE; reader_before pg_catalog.pg_proc%ROWTYPE;
 definition text; expected_body text; replacement record; dependency record; new_oid oid; owner_oid oid;
BEGIN
 IF current_user<>session_user OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'POOLED_CHAIN_INSTALL_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT relowner INTO STRICT owner_oid FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass;
 IF owner_oid<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'POOLED_CHAIN_INSTALL_OWNER_REQUIRED'; END IF;
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
   OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname=dependency.language)
   OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
  THEN RAISE EXCEPTION 'POOLED_PROTOCOL_RESOLVER_MISMATCH'; END IF;
 END LOOP;
 SELECT * INTO STRICT reader_before FROM pg_catalog.pg_proc WHERE oid='public.read_manual_race_chain_v2(uuid)'::regprocedure;
 SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc WHERE oid='public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(reader_before.prosrc,'UTF8')),'hex')<>'b943069f3995e9b582b916e862514ee44832ad413d58b937af55d7613c7dfec3'
  OR reader_before.proowner<>owner_oid OR NOT reader_before.prosecdef OR reader_before.provolatile<>'v'
  OR reader_before.prorettype<>'jsonb'::regtype OR reader_before.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR reader_before.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(reader_before.proacl,acldefault('f',reader_before.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>reader_before.proowner AND a.is_grantable))
  OR encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>'9722a2ce02b2f151d6273a5f5bcd09c3286dd8c1dadb0dcfe61df05d8be2538e'
  OR predecessor.proowner<>owner_oid OR NOT predecessor.prosecdef OR predecessor.provolatile<>'v'
  OR predecessor.prorettype<>'jsonb'::regtype OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee<>predecessor.proowner AND a.is_grantable))
 THEN RAISE EXCEPTION 'POOLED_CHAIN_PREDECESSOR_MISMATCH'; END IF;
 IF to_regprocedure('public.read_manual_race_pooled_chain_v1(uuid)') IS NOT NULL
  OR to_regprocedure('public.ack_manual_race_pooled_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'POOLED_CHAIN_ALREADY_INSTALLED'; END IF;
 expected_body:=$reader_body$
DECLARE parent record; encoding text;
BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 SELECT e.payload,r.result,e.purged_at,e.purged_event_id INTO parent
 FROM public.manual_race_evidence_v2 e JOIN public.manual_race_chain_receipt_v2 r ON r.athlete_id=e.athlete_id AND r.evidence_id=e.id
 WHERE e.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND e.id=$1
 AND NOT EXISTS(SELECT 1 FROM public.tenant_erasure t WHERE t.athlete_id=e.athlete_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF parent.payload IS NOT NULL THEN
  IF octet_length(parent.payload::text)>4194304 THEN RAISE EXCEPTION 'POOLED_CHAIN_READ_BOUND'; END IF;
  PERFORM public.manual_race_v2_assert_json_bound(parent.payload);
  IF parent.payload->'payload'->'preparation' ?| ARRAY['encoding','encodingVersion','skeleton','sourcePool','substitutions','logicalValidationProfile','logicalDigestMethod','logicalDigest'] THEN
   PERFORM wm_manual_pooled.check_encoded(parent.payload);
   encoding:='pooled-database-envelope-v1';
  ELSE
   IF NOT wm_manual_pooled.exact_keys(parent.payload->'payload'->'preparation',ARRAY['context','sourceInput','candidate'])
    OR jsonb_typeof(parent.payload->'payload'->'preparation'->'context') IS DISTINCT FROM 'object'
    OR jsonb_typeof(parent.payload->'payload'->'preparation'->'sourceInput') IS DISTINCT FROM 'object'
    OR jsonb_typeof(parent.payload->'payload'->'preparation'->'candidate') IS DISTINCT FROM 'object'
   THEN RAISE EXCEPTION 'POOLED_CHAIN_READ_ENCODING'; END IF;
   encoding:='legacy-retained-v2';
  END IF;
 END IF;
 -- Purged rows have no durable encoding discriminator. NULL is explicit unknown;
 -- never infer legacy from absence or reconstruct deleted data from receipts.
 RETURN jsonb_build_object('readerVersion',1,'schemaVersion',2,'result',parent.result,
  'payloadEncoding',encoding,'payload',parent.payload,'purgedAt',parent.purged_at,'purgedEventId',parent.purged_event_id);
END
$reader_body$;
 EXECUTE 'CREATE FUNCTION public.read_manual_race_pooled_chain_v1(evidence_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS '||quote_literal(expected_body);
 EXECUTE 'REVOKE ALL ON FUNCTION public.read_manual_race_pooled_chain_v1(uuid) FROM PUBLIC';
 new_oid:='public.read_manual_race_pooled_chain_v1(uuid)'::regprocedure;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=new_oid AND p.prosrc=expected_body AND p.proowner=reader_before.proowner
  AND p.prosecdef=reader_before.prosecdef AND p.prolang=reader_before.prolang AND p.prorettype=reader_before.prorettype AND p.provolatile=reader_before.provolatile AND p.proconfig IS NOT DISTINCT FROM reader_before.proconfig
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE'))
 THEN RAISE EXCEPTION 'POOLED_CHAIN_SUCCESSOR_MISMATCH'; END IF;
 definition:=pg_catalog.pg_get_functiondef(predecessor.oid); expected_body:=predecessor.prosrc;
 FOR replacement IN SELECT * FROM (VALUES
 ('stored_bytes bigint;','stored_bytes bigint; encoded boolean; payload_encoding text;',1),
 ('PERFORM public.manual_race_v2_assert_json_bound($5);','PERFORM public.manual_race_v2_assert_json_bound($5);
 encoded:=($5->''payload''->''preparation'' ?| ARRAY[''encoding'',''encodingVersion'',''skeleton'',''sourcePool'',''substitutions'',''logicalValidationProfile'',''logicalDigestMethod'',''logicalDigest'']);
 IF encoded THEN PERFORM wm_manual_pooled.check_encoded($5); payload_encoding:=''pooled-database-envelope-v1'';
 ELSE payload_encoding:=''legacy-retained-v2''; END IF;',1),
 ('$5->''payload''->''preparation''->''context''->>''athleteId''','(CASE WHEN encoded THEN wm_manual_pooled.lookup($5,''context.athleteId'') ELSE $5->''payload''->''preparation''->''context''->''athleteId'' END)#>>''{}''',1),
 ('$5->''payload''->''preparation''->''candidate''->>''status''','(CASE WHEN encoded THEN wm_manual_pooled.lookup($5,''candidate.status'') ELSE $5->''payload''->''preparation''->''candidate''->''status'' END)#>>''{}''',1),
 ('$5->''payload''->''preparation''->''candidate''->>''digest''','(CASE WHEN encoded THEN wm_manual_pooled.lookup($5,''candidate.digest'') ELSE $5->''payload''->''preparation''->''candidate''->''digest'' END)#>>''{}''',1),
 ('''ackVersion'',1','''ackVersion'',2,''payloadEncoding'',payload_encoding',1)
 ) changes(before_value,after_value,expected_count) LOOP
  IF (length(expected_body)-length(replace(expected_body,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
   OR (length(definition)-length(replace(definition,replacement.before_value,'')))/length(replacement.before_value)<>replacement.expected_count
  THEN RAISE EXCEPTION 'POOLED_CHAIN_REPLACEMENT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,replacement.before_value,replacement.after_value);
  definition:=replace(definition,replacement.before_value,replacement.after_value);
 END LOOP;
 IF (length(definition)-length(replace(definition,'public.ack_manual_race_same_tx_parent_v1(','')))/length('public.ack_manual_race_same_tx_parent_v1(')<>1 THEN RAISE EXCEPTION 'POOLED_CHAIN_SIGNATURE_MISMATCH'; END IF;
 definition:=replace(definition,'public.ack_manual_race_same_tx_parent_v1(','public.ack_manual_race_pooled_same_tx_parent_v1(');
 EXECUTE definition;
 EXECUTE 'REVOKE ALL ON FUNCTION public.ack_manual_race_pooled_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb) FROM PUBLIC';
 new_oid:='public.ack_manual_race_pooled_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)'::regprocedure;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=new_oid AND p.prosrc=expected_body AND p.proowner=predecessor.proowner
  AND p.prosecdef=predecessor.prosecdef AND p.prolang=predecessor.prolang AND p.prorettype=predecessor.prorettype AND p.provolatile=predecessor.provolatile AND p.proconfig IS NOT DISTINCT FROM predecessor.proconfig
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE'))
 THEN RAISE EXCEPTION 'POOLED_CHAIN_SUCCESSOR_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=reader_before.oid AND to_jsonb(p) IS DISTINCT FROM to_jsonb(reader_before))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=predecessor.oid AND to_jsonb(p) IS DISTINCT FROM to_jsonb(predecessor))
 THEN RAISE EXCEPTION 'POOLED_CHAIN_PREDECESSOR_CHANGED'; END IF;
END $migration$;
