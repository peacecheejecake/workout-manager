-- Explicit v3 SQL protocol; readonly observation/receipt wire2 is unchanged.
-- Derive the successor from exact installed predecessors, preserving all source,
-- purpose, lifecycle, byte-budget and genuine commit-row guards. No table/ACL/RLS
-- mutation and no caller claims become authority. Hash methods remain v2.
-- Requires the unregistered raw108..116 + raw118 profile; normal107 is unchanged.
DO $migration$
DECLARE original record; definition text;
BEGIN
 SELECT p.*,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_hash INTO STRICT original
 FROM pg_catalog.pg_proc p WHERE p.oid='public.observe_manual_review_full_owned_source_bindings_v2(jsonb)'::regprocedure;
 IF original.body_hash<>'789b41a5e88437b29a39789168904e702de726a0043e6d6290bb5fe776d277bf' OR original.prosecdef IS DISTINCT FROM false OR original.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR original.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass)
  OR original.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
 THEN RAISE EXCEPTION 'MANUAL_MULTI_PREDECESSOR_MISMATCH'; END IF;
 definition:=pg_catalog.pg_get_functiondef(original.oid);
 definition:=replace(definition,'public.observe_manual_review_full_owned_source_bindings_v2(','public.observe_manual_review_multi_owned_source_bindings_v3(');
 definition:=replace(definition,$old$(SELECT count(*) FROM jsonb_array_elements(normalized) e WHERE e->>'kind'='race-event')<>1$old$,$new$(SELECT count(*) FROM jsonb_array_elements(normalized) e WHERE e->>'kind'='race-event')<1$new$);
 EXECUTE definition;
 EXECUTE 'REVOKE ALL ON FUNCTION public.observe_manual_review_multi_owned_source_bindings_v3(jsonb) FROM PUBLIC';
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid='public.observe_manual_review_multi_owned_source_bindings_v3(jsonb)'::regprocedure AND p.prosrc IS DISTINCT FROM original.prosrc AND p.proconfig IS NOT DISTINCT FROM original.proconfig AND p.proowner=original.proowner AND p.prosecdef=original.prosecdef AND p.prorettype=original.prorettype)
 THEN RAISE EXCEPTION 'MANUAL_MULTI_SUCCESSOR_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=original.oid AND (p.prosrc IS DISTINCT FROM original.prosrc OR p.proconfig IS DISTINCT FROM original.proconfig OR p.proacl IS DISTINCT FROM original.proacl OR p.proowner<>original.proowner OR p.prosecdef<>original.prosecdef))
 THEN RAISE EXCEPTION 'MANUAL_MULTI_PREDECESSOR_CHANGED'; END IF;
END $migration$;

DO $migration$
DECLARE original record; definition text;
BEGIN
 SELECT p.*,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_hash INTO STRICT original
 FROM pg_catalog.pg_proc p WHERE p.oid='public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure;
 IF original.body_hash<>'0538523f733a77b73733431a2cd0b836c65837c1ac437d0b1bb6fe9f39196598' OR original.prosecdef IS DISTINCT FROM true OR original.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR original.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass)
  OR original.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
 THEN RAISE EXCEPTION 'MANUAL_MULTI_PREDECESSOR_MISMATCH'; END IF;
 definition:=pg_catalog.pg_get_functiondef(original.oid);
 definition:=replace(definition,'public.store_manual_race_chain_v2(','public.store_manual_race_multi_owned_chain_v3(');
 definition:=replace(definition,$old$IF (SELECT count(*) FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event')<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event' AND x->>'sourceId'=$7->'event'->>'id' AND x->>'revision'=$7->'event'->>'revision')$old$,$new$IF (SELECT count(*) FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event')<1
  OR (SELECT count(*) FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event' AND x->>'sourceId'=$7->'event'->>'id' AND x->>'revision'=$7->'event'->>'revision')<>1
  OR $7->'intent'->'expectedEvent' IS DISTINCT FROM jsonb_build_object('id',$7->'event'->'id','revision',$7->'event'->'revision')$new$);
 definition:=replace(definition,'public.observe_manual_review_full_owned_source_bindings_v2(refs)','public.observe_manual_review_multi_owned_source_bindings_v3(refs)');
 EXECUTE definition;
 EXECUTE 'REVOKE ALL ON FUNCTION public.store_manual_race_multi_owned_chain_v3(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC';
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid='public.store_manual_race_multi_owned_chain_v3(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure AND p.prosrc IS DISTINCT FROM original.prosrc AND p.proconfig IS NOT DISTINCT FROM original.proconfig AND p.proowner=original.proowner AND p.prosecdef=original.prosecdef AND p.prorettype=original.prorettype)
 THEN RAISE EXCEPTION 'MANUAL_MULTI_SUCCESSOR_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=original.oid AND (p.prosrc IS DISTINCT FROM original.prosrc OR p.proconfig IS DISTINCT FROM original.proconfig OR p.proacl IS DISTINCT FROM original.proacl OR p.proowner<>original.proowner OR p.prosecdef<>original.prosecdef))
 THEN RAISE EXCEPTION 'MANUAL_MULTI_PREDECESSOR_CHANGED'; END IF;
END $migration$;

DO $migration$
DECLARE original record; definition text;
BEGIN
 SELECT p.*,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_hash INTO STRICT original
 FROM pg_catalog.pg_proc p WHERE p.oid='public.validate_race_manual_application_basis_v1(jsonb,jsonb,jsonb)'::regprocedure;
 IF original.body_hash<>'8296205313060087587582216a4de0dba705ba9845cd88648e08c9276a483c1c' OR original.prosecdef IS DISTINCT FROM true OR original.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR original.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass)
  OR original.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
 THEN RAISE EXCEPTION 'MANUAL_MULTI_PREDECESSOR_MISMATCH'; END IF;
 definition:=pg_catalog.pg_get_functiondef(original.oid);
 definition:=replace(definition,'public.validate_race_manual_application_basis_v1(','public.validate_race_manual_multi_owned_basis_v3(');
 definition:=replace(definition,$old$IF (SELECT count(*) FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event')<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event' AND x->>'sourceId'=$2->'event'->>'id' AND x->>'revision'=$2->'event'->>'revision')$old$,$new$IF (SELECT count(*) FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event')<1
  OR (SELECT count(*) FROM jsonb_array_elements(refs) x WHERE x->>'kind'='race-event' AND x->>'sourceId'=$2->'event'->>'id' AND x->>'revision'=$2->'event'->>'revision')<>1
  OR $2->'intent'->'expectedEvent' IS DISTINCT FROM jsonb_build_object('id',$2->'event'->'id','revision',$2->'event'->'revision')$new$);
 definition:=replace(definition,'public.observe_manual_review_full_owned_source_bindings_v2(refs)','public.observe_manual_review_multi_owned_source_bindings_v3(refs)');
 EXECUTE definition;
 EXECUTE 'REVOKE ALL ON FUNCTION public.validate_race_manual_multi_owned_basis_v3(jsonb,jsonb,jsonb) FROM PUBLIC';
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid='public.validate_race_manual_multi_owned_basis_v3(jsonb,jsonb,jsonb)'::regprocedure AND p.prosrc IS DISTINCT FROM original.prosrc AND p.proconfig IS NOT DISTINCT FROM original.proconfig AND p.proowner=original.proowner AND p.prosecdef=original.prosecdef AND p.prorettype=original.prorettype)
 THEN RAISE EXCEPTION 'MANUAL_MULTI_SUCCESSOR_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=original.oid AND (p.prosrc IS DISTINCT FROM original.prosrc OR p.proconfig IS DISTINCT FROM original.proconfig OR p.proacl IS DISTINCT FROM original.proacl OR p.proowner<>original.proowner OR p.prosecdef<>original.prosecdef))
 THEN RAISE EXCEPTION 'MANUAL_MULTI_PREDECESSOR_CHANGED'; END IF;
END $migration$;
