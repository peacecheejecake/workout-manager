-- Private bounded preparation lookup only. No source authentication,
-- permission, storage seal, complete codec validation or approval authority.
-- Frozen DB-envelope V1 / multi-owned-v3; old migrations/functions untouched.
DO $installer$ BEGIN
 IF current_user<>session_user OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
 THEN RAISE EXCEPTION 'POOLED_INSTALL_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
END $installer$;
CREATE SCHEMA wm_manual_pooled;
REVOKE ALL ON SCHEMA wm_manual_pooled FROM PUBLIC;
CREATE FUNCTION wm_manual_pooled.assert_owner() RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
  WHERE n.nspname='wm_manual_pooled' AND r.rolname=current_user AND NOT r.rolsuper AND NOT r.rolbypassrls)
 THEN RAISE EXCEPTION 'POOLED_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION wm_manual_pooled.exact_keys(v jsonb,k text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_typeof(v)='object' AND v ?& k AND v-k='{}'::jsonb
$$;

CREATE FUNCTION wm_manual_pooled.path_parts(v text,allow_root boolean DEFAULT false) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p text[]; BEGIN
 IF v IS NULL OR octet_length(v)>4194304 OR
  NOT(v ~ '^(context|sourceInput|candidate)(\.[A-Za-z][A-Za-z0-9]*|\[(0|[1-9][0-9]*)\])+$'
      OR (allow_root AND v IN ('context','sourceInput','candidate')))
 THEN RAISE EXCEPTION 'POOLED_LOCATION_REJECTED'; END IF;
 p:=string_to_array(regexp_replace(replace(v,']',''),'\[','.', 'g'),'.');
 IF cardinality(p)>64 OR p && ARRAY['__proto__','prototype','constructor','proposed','after']
 THEN RAISE EXCEPTION 'POOLED_LOCATION_REJECTED'; END IF;
 RETURN p;
END $$;

-- JSONB #> alone conflates absent/null and accepts object '0'/negative arrays.
-- Typed tokens and explicit existence preserve absent vs actual JSON null.
CREATE FUNCTION wm_manual_pooled.at_exact(v jsonb,p text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE token text; index_value bigint; BEGIN
 FOREACH token IN ARRAY p LOOP
  IF jsonb_typeof(v)='object' AND token ~ '^[A-Za-z][A-Za-z0-9]*$' AND v ? token THEN
   v:=v->token;
  ELSIF jsonb_typeof(v)='array' AND token ~ '^(0|[1-9][0-9]*)$' THEN
   -- strlen guard precedes cast, array positions are bounded by actual array.
   IF length(token)>10 THEN RAISE EXCEPTION 'POOLED_LOCATION_REJECTED'; END IF;
   index_value:=token::bigint;
   IF index_value>=jsonb_array_length(v) THEN RAISE EXCEPTION 'POOLED_LOCATION_REJECTED'; END IF;
   v:=v->index_value::integer;
  ELSE RAISE EXCEPTION 'POOLED_LOCATION_REJECTED'; END IF;
 END LOOP;
 IF v IS NULL THEN RAISE EXCEPTION 'POOLED_LOCATION_REJECTED'; END IF;
 RETURN v;
END $$;

CREATE FUNCTION wm_manual_pooled.check_encoded(e jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; refs jsonb; normalized jsonb; r jsonb; slot jsonb; pool_row jsonb;
 n bigint; depth_value integer; visits bigint; pool_index bigint; ordinal bigint;
 previous_parts text[]; location_value text; parts text[];
BEGIN
 PERFORM wm_manual_pooled.assert_owner();
 -- The actual fixed DB envelope has old headers/inventory at historical paths.
 IF e IS NULL OR jsonb_typeof(e)<>'object' OR octet_length(e::text)>4194304
 THEN RAISE EXCEPTION 'POOLED_ENCODED_BOUND'; END IF;
 PERFORM public.manual_race_v2_assert_json_bound(e); -- ENCODED only, never hydrated.
 IF NOT wm_manual_pooled.exact_keys(e,ARRAY['codecVersion','sourceAuthentication','sqlAuthentication','storage','authority','permissionAuthority','lifecycleAuthority','freshness','admissionAllowed','approvalAllowed','state','status','reason','payloadDigest','payload','minimalAudit'])
  OR e->'codecVersion' IS DISTINCT FROM '2'::jsonb OR e->>'state' IS DISTINCT FROM 'present' OR e->>'status' IS DISTINCT FROM 'structurally_corresponding'
  OR jsonb_typeof(e->'payloadDigest') IS DISTINCT FROM 'string'
  OR jsonb_typeof(e->'minimalAudit'->'candidateDigest') IS DISTINCT FROM 'string'
  OR jsonb_typeof(e->'minimalAudit'->'readSetDigest') IS DISTINCT FROM 'string'
  OR jsonb_typeof(e->'minimalAudit'->'inventoryDigest') IS DISTINCT FROM 'string'
  OR jsonb_typeof(e->'minimalAudit'->'athleteId') IS DISTINCT FROM 'string'
  OR e->'reason' IS DISTINCT FROM 'null'::jsonb OR coalesce(e->>'payloadDigest','')!~'^[a-f0-9]{64}$'
  OR e->>'sourceAuthentication' IS DISTINCT FROM 'unverified' OR e->>'sqlAuthentication' IS DISTINCT FROM 'unverified'
  OR e->>'storage' IS DISTINCT FROM 'not_persisted' OR e->>'authority' IS DISTINCT FROM 'none' OR e->>'permissionAuthority' IS DISTINCT FROM 'none'
  OR e->>'lifecycleAuthority' IS DISTINCT FROM 'none' OR e->>'freshness' IS DISTINCT FROM 'not_checked'
  OR e->'admissionAllowed' IS DISTINCT FROM 'false'::jsonb OR e->'approvalAllowed' IS DISTINCT FROM 'false'::jsonb
  OR NOT wm_manual_pooled.exact_keys(e->'minimalAudit',ARRAY['athleteId','candidateDigest','readSetDigest','inventoryDigest'])
  OR coalesce(length(e->'minimalAudit'->>'athleteId'),0) NOT BETWEEN 1 AND 200
  OR coalesce(e->'minimalAudit'->>'candidateDigest','')!~'^[a-f0-9]{64}$'
  OR coalesce(e->'minimalAudit'->>'readSetDigest','')!~'^[a-f0-9]{64}$'
  OR coalesce(e->'minimalAudit'->>'inventoryDigest','')!~'^[a-f0-9]{64}$'
  OR NOT wm_manual_pooled.exact_keys(e->'payload',ARRAY['state','preparation','inventory','dtoObservations','sqlObservations','currentAuthority'])
  OR e->'payload'->>'state' IS DISTINCT FROM 'present'
  OR e->'payload'->'currentAuthority' IS DISTINCT FROM jsonb_build_object('authority','none','freshness','not_checked','permissionAuthority','none','lifecycleAuthority','none','admissionAllowed',false,'approvalAllowed',false)
 THEN RAISE EXCEPTION 'POOLED_FRAME_REJECTED'; END IF;
 p:=e->'payload'->'preparation'; refs:=e->'payload'->'inventory'->'refs';
 IF NOT wm_manual_pooled.exact_keys(p,ARRAY['encodingVersion','encoding','logicalValidationProfile','logicalDigestMethod','logicalDigest','authority','permissionAuthority','freshness','approvalAllowed','skeleton','sourcePool','substitutions'])
  OR p->'encodingVersion' IS DISTINCT FROM '1'::jsonb OR p->>'encoding' IS DISTINCT FROM 'typed-immutable-source-pool-v1'
  OR jsonb_typeof(p->'logicalDigest') IS DISTINCT FROM 'string'
  OR p->>'logicalValidationProfile' IS DISTINCT FROM 'multi-owned-v3' OR p->>'logicalDigestMethod' IS DISTINCT FROM 'dto-object-key-canonical-sha256-v1'
  OR coalesce(p->>'logicalDigest','')!~'^[a-f0-9]{64}$' OR p->>'authority' IS DISTINCT FROM 'none' OR p->>'permissionAuthority' IS DISTINCT FROM 'none'
  OR p->>'freshness' IS DISTINCT FROM 'not_checked' OR p->'approvalAllowed' IS DISTINCT FROM 'false'::jsonb
  OR NOT wm_manual_pooled.exact_keys(p->'skeleton',ARRAY['context','sourceInput','candidate'])
  OR jsonb_typeof(p->'skeleton'->'context') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p->'skeleton'->'sourceInput') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p->'skeleton'->'candidate') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p->'sourcePool') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'substitutions') IS DISTINCT FROM 'array'
  OR jsonb_typeof(refs) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'POOLED_FRAME_REJECTED'; END IF;
 IF jsonb_array_length(refs) NOT BETWEEN 1 AND 5000 OR jsonb_array_length(p->'sourcePool')>5000 OR jsonb_array_length(p->'substitutions')>5000
 THEN RAISE EXCEPTION 'POOLED_REF_BOUND'; END IF;
 -- Existing fixed27 identity decoder rejects unknown/excess fields, not generic JSON.
 SELECT public.manual_race_v2_normalize_refs(jsonb_agg(value->'identity' ORDER BY o)) INTO normalized
 FROM jsonb_array_elements(refs) WITH ORDINALITY a(value,o);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(refs) WITH ORDINALITY a(value,o)
  WHERE value->'identity' IS DISTINCT FROM normalized->(o-1)::integer)
 THEN RAISE EXCEPTION 'POOLED_IDENTITY_REJECTED'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(refs) a
  WHERE NOT wm_manual_pooled.exact_keys(a,ARRAY['identity','representation','dtoDigest','digestMethod','copiedLocations'])
   OR coalesce(a->>'representation','') NOT IN ('immutable_body','mutable_observation','source_fragment')
   OR jsonb_typeof(a->'dtoDigest') IS DISTINCT FROM 'string'
   OR coalesce(a->>'dtoDigest','')!~'^[a-f0-9]{64}$'
   OR a->>'digestMethod' IS DISTINCT FROM 'dto-object-key-canonical-sha256-v1'
   OR jsonb_typeof(a->'copiedLocations') IS DISTINCT FROM 'array')
 THEN RAISE EXCEPTION 'POOLED_REF_REJECTED'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(refs) a WHERE jsonb_array_length(a->'copiedLocations') NOT BETWEEN 1 AND 5000)
 THEN RAISE EXCEPTION 'POOLED_REF_BOUND'; END IF;
 SELECT coalesce(sum(jsonb_array_length(value->'copiedLocations')),0) INTO visits FROM jsonb_array_elements(refs);
 IF visits NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'POOLED_REF_BOUND'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(refs) LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'copiedLocations') a WHERE jsonb_typeof(a) IS DISTINCT FROM 'string')
   OR (SELECT count(*) FROM jsonb_array_elements(r->'copiedLocations'))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(r->'copiedLocations'))
  THEN RAISE EXCEPTION 'POOLED_LOCATION_REJECTED'; END IF;
  FOR location_value IN SELECT value FROM jsonb_array_elements_text(r->'copiedLocations') LOOP
   PERFORM wm_manual_pooled.path_parts(location_value);
  END LOOP;
 END LOOP;
 FOR pool_row,ordinal IN SELECT value,o FROM jsonb_array_elements(p->'sourcePool') WITH ORDINALITY a(value,o) LOOP
  IF NOT wm_manual_pooled.exact_keys(pool_row,ARRAY['ordinal','identity','representation','dtoDigest','digestMethod','body'])
   OR pool_row->'ordinal' IS DISTINCT FROM to_jsonb(ordinal-1) OR pool_row->>'representation' IS DISTINCT FROM 'immutable_body'
   OR jsonb_typeof(pool_row->'dtoDigest') IS DISTINCT FROM 'string'
   OR pool_row->>'digestMethod' IS DISTINCT FROM 'dto-object-key-canonical-sha256-v1' OR coalesce(pool_row->>'dtoDigest','')!~'^[a-f0-9]{64}$'
   OR pool_row->'body' IS NULL OR pool_row->'body'='null'::jsonb
   OR (SELECT count(*) FROM jsonb_array_elements(refs) a WHERE a->'identity'=pool_row->'identity' AND a->>'representation'='immutable_body' AND a->'dtoDigest'=pool_row->'dtoDigest' AND a->'digestMethod'=pool_row->'digestMethod')<>1
   OR (SELECT count(*) FROM jsonb_array_elements(p->'sourcePool') a WHERE a->'identity'=pool_row->'identity')<>1
   OR (SELECT count(*) FROM jsonb_array_elements(p->'substitutions') a WHERE a->'sourceOrdinal'=pool_row->'ordinal')<2
  THEN RAISE EXCEPTION 'POOLED_POOL_REJECTED'; END IF;
 END LOOP;
 previous_parts:=NULL;
 -- Sort token arrays: a property between textual parent and '[' cannot hide overlap.
 FOR slot IN SELECT value FROM jsonb_array_elements(p->'substitutions') a ORDER BY wm_manual_pooled.path_parts(value->>'location') COLLATE "C" LOOP
  IF NOT wm_manual_pooled.exact_keys(slot,ARRAY['location','sourceOrdinal']) OR jsonb_typeof(slot->'location') IS DISTINCT FROM 'string'
   OR jsonb_typeof(slot->'sourceOrdinal') IS DISTINCT FROM 'number' OR slot->>'sourceOrdinal'!~'^(0|[1-9][0-9]*)$'
   OR length(slot->>'sourceOrdinal')>4 THEN RAISE EXCEPTION 'POOLED_SLOT_REJECTED'; END IF;
  pool_index:=(slot->>'sourceOrdinal')::bigint;
  IF pool_index>=jsonb_array_length(p->'sourcePool') THEN RAISE EXCEPTION 'POOLED_SLOT_REJECTED'; END IF;
  location_value:=slot->>'location'; parts:=wm_manual_pooled.path_parts(location_value);
  IF previous_parts IS NOT NULL AND cardinality(previous_parts)<=cardinality(parts) AND parts[1:cardinality(previous_parts)]=previous_parts
  THEN RAISE EXCEPTION 'POOLED_SLOT_REJECTED'; END IF;
  previous_parts:=parts; pool_row:=p->'sourcePool'->pool_index::integer;
  WITH RECURSIVE w(v,d) AS (SELECT pool_row->'body',0 UNION ALL
   SELECT child.value,w.d+1 FROM w CROSS JOIN LATERAL (
    SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(w.v)='object' THEN w.v ELSE '{}'::jsonb END)
    UNION ALL SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v)='array' THEN w.v ELSE '[]'::jsonb END)
   ) child WHERE w.d<=64)
  SELECT max(d) INTO depth_value FROM w;
  -- logical frame: payload/preparation plus this rooted path.
  IF depth_value+cardinality(parts)+2>64 THEN RAISE EXCEPTION 'POOLED_LOGICAL_DEPTH_BOUND'; END IF;
  IF wm_manual_pooled.at_exact(p->'skeleton',parts) IS DISTINCT FROM 'null'::jsonb
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) a CROSS JOIN LATERAL jsonb_array_elements_text(a->'copiedLocations') loc
    WHERE a->'identity'=pool_row->'identity' AND a->'representation'=pool_row->'representation' AND a->'dtoDigest'=pool_row->'dtoDigest' AND loc=location_value)
  THEN RAISE EXCEPTION 'POOLED_SLOT_REJECTED'; END IF;
 END LOOP;
 -- Intentionally does NOT claim Nodecanonical digest proof or exact domain codec
 -- authentication. The integration points in the .md are required, not optional.
END $$;

CREATE FUNCTION wm_manual_pooled.lookup(e jsonb,path text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; parts text[]; s jsonb; sp text[]; pool_row jsonb; result jsonb;
 delta bigint:=0; raw_bytes bigint; suffix text[]; relative_parts text[];
BEGIN
 -- A later same-invocation closure can validate ONCE and keep this helper private.
 -- This helper repeats validation per call; no unchecked caller cached handle exists.
 PERFORM wm_manual_pooled.check_encoded(e);
 p:=e->'payload'->'preparation'; parts:=wm_manual_pooled.path_parts(path,true);
 -- If query falls INSIDE an immutable pool body, read that body directly.
 FOR s IN SELECT value FROM jsonb_array_elements(p->'substitutions') LOOP
  sp:=wm_manual_pooled.path_parts(s->>'location');
  IF cardinality(sp)<=cardinality(parts) AND parts[1:cardinality(sp)]=sp THEN
   pool_row:=p->'sourcePool'->(s->>'sourceOrdinal')::integer;
   suffix:=parts[cardinality(sp)+1:cardinality(parts)];
   RETURN wm_manual_pooled.at_exact(pool_row->'body',coalesce(suffix,ARRAY[]::text[]));
  END IF;
 END LOOP;
 result:=wm_manual_pooled.at_exact(p->'skeleton',parts);
 -- Query contains substitutions: exact preflight encoded byte length of this
 -- selected subtree plus inserted body lengths, before jsonb_set allocation.
 raw_bytes:=octet_length(result::text);
 FOR s IN SELECT value FROM jsonb_array_elements(p->'substitutions') LOOP
  sp:=wm_manual_pooled.path_parts(s->>'location');
  IF cardinality(parts)<cardinality(sp) AND sp[1:cardinality(parts)]=parts THEN
   delta:=delta+octet_length((p->'sourcePool'->(s->>'sourceOrdinal')::integer->'body')::text)-4;
  END IF;
 END LOOP;
 IF raw_bytes+delta>4194304 THEN RAISE EXCEPTION 'POOLED_SELECTED_BODY_BOUND'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'substitutions') LOOP
  sp:=wm_manual_pooled.path_parts(s->>'location');
  IF cardinality(parts)<cardinality(sp) AND sp[1:cardinality(parts)]=parts THEN
   relative_parts:=sp[cardinality(parts)+1:cardinality(sp)];
   result:=jsonb_set(result,relative_parts,p->'sourcePool'->(s->>'sourceOrdinal')::integer->'body',false);
  END IF;
 END LOOP;
 IF octet_length(result::text)<>raw_bytes+delta THEN RAISE EXCEPTION 'POOLED_SIZE_CORRESPONDENCE'; END IF;
 RETURN result;
END $$;
-- No public RPC authorization; all helper EXECUTE privileges remain private.

REVOKE ALL ON FUNCTION wm_manual_pooled.assert_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_manual_pooled.exact_keys(jsonb,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_manual_pooled.path_parts(text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_manual_pooled.at_exact(jsonb,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_manual_pooled.check_encoded(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_manual_pooled.lookup(jsonb,text) FROM PUBLIC;
