-- Exact SQL118 nutrition V4 successor, plus SQL110 descriptor validator indexing.
-- One atomic owner-only DO: original 110/118 bytes and all existing RPC ACLs remain.
-- No cap/deadline/current-race/recipe/receipt/atomicity relaxation or new authority.
DO $nutrition_index133$
BEGIN
DECLARE n integer;
BEGIN
 IF current_user IS DISTINCT FROM session_user OR current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.nutrition_plan_version'::regclass)) OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'NUTRITION_INDEX_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(872194,1);
 PERFORM pg_advisory_xact_lock(77210,1);
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=ANY(ARRAY['public.nutrition_race_disconnection_lineage'::regclass,'public.nutrition_v4_commit_seal'::regclass])) THEN RAISE EXCEPTION 'NUTRITION_INDEX_HOOK_MISMATCH'; END IF;
 SELECT count(*) INTO n FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY(ARRAY['public.nutrition_race_disconnection_lineage'::regclass,'public.nutrition_v4_commit_seal'::regclass]) AND NOT t.tgisinternal AND (t.tgtype & 4)=4;
 IF n<>3 OR EXISTS(
  SELECT 1 FROM (VALUES ('nutrition_race_disconnection_lineage','nutrition_lineage_insert','guard_nutrition_lineage_insert',7,false,false,'aa9c5592114bd09b4c10320c369ccc92d9eb21bc43ae6f8569f1d85a52c853ed'),
('nutrition_v4_commit_seal','nutrition_v4_commit_final','verify_nutrition_v4_commit_final',5,true,true,'d917cc90a1ad1bfa717fffe3adb29115287185134f3a94b332e30e778489b88f'),
('nutrition_v4_commit_seal','nutrition_v4_seal_guard','guard_nutrition_v4_seal',31,false,false,'05fef65fd978525e864e35ead4153f2890c0f4d8217923736440f81e1729e983')) expected(table_name,trigger_name,function_name,trigger_type,is_deferrable,is_initially_deferred,body_hash)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass('public.'||expected.table_name)
  LEFT JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid AND t.tgname=expected.trigger_name
  LEFT JOIN pg_catalog.pg_proc f ON f.oid=t.tgfoid
  WHERE t.oid IS NULL OR t.tgisinternal OR t.tgenabled IS DISTINCT FROM 'O'::"char" OR t.tgtype IS DISTINCT FROM expected.trigger_type::smallint
   OR t.tgdeferrable IS DISTINCT FROM expected.is_deferrable OR t.tginitdeferred IS DISTINCT FROM expected.is_initially_deferred
   OR f.proname IS DISTINCT FROM expected.function_name OR f.proowner IS DISTINCT FROM c.relowner
   OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_hash
 ) THEN RAISE EXCEPTION 'NUTRITION_INDEX_HOOK_MISMATCH'; END IF;
END;

DECLARE predecessor pg_catalog.pg_proc%ROWTYPE; successor pg_catalog.pg_proc%ROWTYPE;
 definition text; expected_body text; patch record;
BEGIN
 IF to_regprocedure('public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)') IS NULL THEN RAISE EXCEPTION 'NUTRITION_INDEX_PREDECESSOR_MISSING'; END IF;
 SELECT p.* INTO STRICT predecessor FROM pg_catalog.pg_proc p WHERE p.oid='public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>'bb5eca0bd23f90cdf1ea082e229e95188b808ce1ff01a9c34c63cfaa72f257bd'
  OR predecessor.prosecdef IS DISTINCT FROM true
  OR predecessor.provolatile IS DISTINCT FROM 'v'
  OR predecessor.prorettype<>'jsonb'::regtype
  OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR predecessor.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.nutrition_plan_version'::regclass)
  OR current_user IS DISTINCT FROM session_user
  OR current_user IS DISTINCT FROM pg_get_userbyid(predecessor.proowner)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
  OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
 THEN RAISE EXCEPTION 'NUTRITION_INDEX_PREDECESSOR_MISMATCH'; END IF;
 expected_body:=predecessor.prosrc;
 definition:=pg_catalog.pg_get_functiondef(predecessor.oid);
 FOR patch IN SELECT * FROM (VALUES
 (1,$old0$unchanged boolean; reconnect boolean; source_instant timestamptz; linked jsonb; content jsonb;$old0$,$new0$unchanged boolean; reconnect boolean; source_instant timestamptz; linked jsonb; content jsonb;
 old_items_by_id jsonb; saved_bindings_by_id jsonb; old_bindings_by_id jsonb; saved_pins_by_tuple jsonb; old_pins_by_tuple jsonb;$new0$,1),
 (2,$old1$ FOR item IN SELECT value FROM jsonb_array_elements(saved->'items') LOOP$old1$,$new1$ -- Index only the already bounded and independently validated original rosters.
 -- Duplicate checks precede object aggregation; last-wins cannot hide a member.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(saved->'itemRaceTimingBindings','[]'::jsonb)) x GROUP BY x->>'itemId' HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(prior.record_json->'itemRaceTimingBindings','[]'::jsonb)) x GROUP BY x->>'itemId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NUTRITION_V4_BINDING_ORDER'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(saved->'raceTimingPins','[]'::jsonb)) x GROUP BY x->>'eventId',x->'eventRevision' HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(prior.record_json->'raceTimingPins','[]'::jsonb)) x GROUP BY x->>'eventId',x->'eventRevision' HAVING count(*)>1) THEN RAISE EXCEPTION 'NUTRITION_V4_PIN_ORDER'; END IF;
 SELECT coalesce(jsonb_object_agg(i->>'id',i),'{}'::jsonb) INTO old_items_by_id FROM jsonb_array_elements(prior.record_json->'items') i;
 SELECT coalesce(jsonb_object_agg(i->>'itemId',i),'{}'::jsonb) INTO saved_bindings_by_id FROM jsonb_array_elements(saved->'itemRaceTimingBindings') i;
 SELECT coalesce(jsonb_object_agg(i->>'itemId',i),'{}'::jsonb) INTO old_bindings_by_id FROM jsonb_array_elements(coalesce(prior.record_json->'itemRaceTimingBindings','[]'::jsonb)) i;
 SELECT coalesce(jsonb_object_agg(event_id,revision_map),'{}'::jsonb) INTO saved_pins_by_tuple FROM (SELECT p->>'eventId' AS event_id,jsonb_object_agg(trim_scale((p->>'eventRevision')::numeric)::text,p) AS revision_map FROM jsonb_array_elements(coalesce(saved->'raceTimingPins','[]'::jsonb)) p GROUP BY p->>'eventId') grouped;
 SELECT coalesce(jsonb_object_agg(event_id,revision_map),'{}'::jsonb) INTO old_pins_by_tuple FROM (SELECT p->>'eventId' AS event_id,jsonb_object_agg(trim_scale((p->>'eventRevision')::numeric)::text,p) AS revision_map FROM jsonb_array_elements(coalesce(prior.record_json->'raceTimingPins','[]'::jsonb)) p GROUP BY p->>'eventId') grouped;
 FOR item IN SELECT value FROM jsonb_array_elements(saved->'items') LOOP$new1$,1),
 (3,$old2$  SELECT i INTO old_item FROM jsonb_array_elements(prior.record_json->'items') i WHERE i->>'id'=item->>'id';$old2$,$new2$  old_item:=old_items_by_id->(item->>'id');$new2$,1),
 (4,$old3$   SELECT x INTO bind FROM jsonb_array_elements(saved->'itemRaceTimingBindings') x WHERE x->>'itemId'=item->>'id';$old3$,$new3$   bind:=saved_bindings_by_id->(item->>'id');$new3$,1),
 (5,$old4$   SELECT x INTO old_bind FROM jsonb_array_elements(coalesce(prior.record_json->'itemRaceTimingBindings','[]')) x WHERE x->>'itemId'=item->>'id';$old4$,$new4$   old_bind:=old_bindings_by_id->(item->>'id');$new4$,1),
 (6,$old5$SELECT x INTO pin FROM jsonb_array_elements(saved->'raceTimingPins') x WHERE x->>'eventId'=bind->'binding'->>'eventId' AND x->'eventRevision'=bind->'binding'->'eventRevision';$old5$,$new5$pin:=saved_pins_by_tuple->(bind->'binding'->>'eventId')->trim_scale((bind->'binding'->>'eventRevision')::numeric)::text;$new5$,2),
 (7,$old6$SELECT x INTO old_pin FROM jsonb_array_elements(prior.record_json->'raceTimingPins') x WHERE x->>'eventId'=bind->'binding'->>'eventId' AND x->'eventRevision'=bind->'binding'->'eventRevision';$old6$,$new6$old_pin:=old_pins_by_tuple->(bind->'binding'->>'eventId')->trim_scale((bind->'binding'->>'eventRevision')::numeric)::text;$new6$,1)
 ) x(ordinal,faulty,corrected,expected_count) ORDER BY ordinal LOOP
  IF (length(expected_body)-length(replace(expected_body,patch.faulty,'')))/length(patch.faulty)<>patch.expected_count
   OR (length(definition)-length(replace(definition,patch.faulty,'')))/length(patch.faulty)<>patch.expected_count
  THEN RAISE EXCEPTION 'NUTRITION_INDEX_PATCH_COUNT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,patch.faulty,patch.corrected);
  definition:=replace(definition,patch.faulty,patch.corrected);
 END LOOP;
 IF encode(sha256(convert_to(expected_body,'UTF8')),'hex')<>'7f9bf7c936e809f47cccb83d57ee8f052234629f454a5cd5c3afbb5bcf4a2636' THEN RAISE EXCEPTION 'NUTRITION_INDEX_EXPECTED_BODY_MISMATCH'; END IF;
 EXECUTE definition;
 SELECT p.* INTO STRICT successor FROM pg_catalog.pg_proc p WHERE p.oid=predecessor.oid;
 IF successor.prosrc IS DISTINCT FROM expected_body OR (to_jsonb(successor)-'prosrc') IS DISTINCT FROM (to_jsonb(predecessor)-'prosrc')
 THEN RAISE EXCEPTION 'NUTRITION_INDEX_SUCCESSOR_METADATA_MISMATCH'; END IF;
END;

DECLARE predecessor pg_catalog.pg_proc%ROWTYPE; successor pg_catalog.pg_proc%ROWTYPE;
 definition text; expected_body text; patch record;
BEGIN
 IF to_regprocedure('public.assert_nutrition_disconnect_body(jsonb)') IS NULL THEN RAISE EXCEPTION 'NUTRITION_INDEX_PREDECESSOR_MISSING'; END IF;
 SELECT p.* INTO STRICT predecessor FROM pg_catalog.pg_proc p WHERE p.oid='public.assert_nutrition_disconnect_body(jsonb)'::regprocedure;
 IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>'ff1c1996a25f93a8ad096f2622b2f3a2897f7283d6d0a4a9698fe60cae37475b'
  OR predecessor.prosecdef IS DISTINCT FROM false
  OR predecessor.provolatile IS DISTINCT FROM 'v'
  OR predecessor.prorettype<>'void'::regtype
  OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR predecessor.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.nutrition_plan_version'::regclass)
  OR current_user IS DISTINCT FROM session_user
  OR current_user IS DISTINCT FROM pg_get_userbyid(predecessor.proowner)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
  OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 THEN RAISE EXCEPTION 'NUTRITION_INDEX_PREDECESSOR_MISMATCH'; END IF;
 expected_body:=predecessor.prosrc;
 definition:=pg_catalog.pg_get_functiondef(predecessor.oid);
 FOR patch IN SELECT * FROM (VALUES
 (1,$old0$DECLARE entry jsonb; prior_pin jsonb; key text; used text[]:='{}'; ids text[]:='{}'; last_id text;$old0$,$new0$DECLARE entry jsonb; prior_pin jsonb; key text; used text[]:='{}'; ids text[]:='{}'; last_id text; items_by_id jsonb; pins_by_tuple jsonb; indexed_item jsonb;$new0$,1),
 (2,$old1$ FOR entry IN SELECT value FROM jsonb_array_elements(b->'raceTimingPins') LOOP$old1$,$new1$ SELECT coalesce(jsonb_object_agg(i->>'id',i),'{}'::jsonb) INTO items_by_id FROM jsonb_array_elements(b->'items') i;
 FOR entry IN SELECT value FROM jsonb_array_elements(b->'raceTimingPins') LOOP$new1$,1),
 (3,$old2$ FOR entry IN SELECT value FROM jsonb_array_elements(b->'itemRaceTimingBindings') LOOP$old2$,$new2$ SELECT coalesce(jsonb_object_agg(event_id,revision_map),'{}'::jsonb) INTO pins_by_tuple FROM (SELECT p->>'eventId' AS event_id,jsonb_object_agg(trim_scale((p->>'eventRevision')::numeric)::text,p) AS revision_map FROM jsonb_array_elements(coalesce(b->'raceTimingPins','[]'::jsonb)) p GROUP BY p->>'eventId') grouped;
 FOR entry IN SELECT value FROM jsonb_array_elements(b->'itemRaceTimingBindings') LOOP$new2$,1),
 (4,$old3$  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'items') i WHERE i->>'id'=entry->>'itemId' AND i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race') THEN RAISE EXCEPTION 'NUTRITION_V4_BINDING_MEMBER'; END IF;$old3$,$new3$  indexed_item:=items_by_id->(entry->>'itemId');
  IF indexed_item IS NULL OR indexed_item->'anchor'->>'kind' IS DISTINCT FROM 'relative' OR indexed_item->'anchor'->>'entity' IS DISTINCT FROM 'race' THEN RAISE EXCEPTION 'NUTRITION_V4_BINDING_MEMBER'; END IF;$new3$,1),
 (5,$old4$   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'items') i WHERE i->>'id'=last_id AND i->'anchor'->>'entityId'=entry->'binding'->>'eventId')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'raceTimingPins') p WHERE p->>'eventId'=entry->'binding'->>'eventId' AND p->'eventRevision'=entry->'binding'->'eventRevision') THEN RAISE EXCEPTION 'NUTRITION_V4_PIN_MEMBER'; END IF;$old4$,$new4$   IF indexed_item->'anchor'->>'entityId' IS DISTINCT FROM entry->'binding'->>'eventId'
    OR pins_by_tuple->(entry->'binding'->>'eventId')->trim_scale((entry->'binding'->>'eventRevision')::numeric)::text IS NULL THEN RAISE EXCEPTION 'NUTRITION_V4_PIN_MEMBER'; END IF;$new4$,1)
 ) x(ordinal,faulty,corrected,expected_count) ORDER BY ordinal LOOP
  IF (length(expected_body)-length(replace(expected_body,patch.faulty,'')))/length(patch.faulty)<>patch.expected_count
   OR (length(definition)-length(replace(definition,patch.faulty,'')))/length(patch.faulty)<>patch.expected_count
  THEN RAISE EXCEPTION 'NUTRITION_INDEX_PATCH_COUNT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,patch.faulty,patch.corrected);
  definition:=replace(definition,patch.faulty,patch.corrected);
 END LOOP;
 IF encode(sha256(convert_to(expected_body,'UTF8')),'hex')<>'92a0643c5eff075ec00bacd21152666755dc439c1c01571640e8827a618edc6f' THEN RAISE EXCEPTION 'NUTRITION_INDEX_EXPECTED_BODY_MISMATCH'; END IF;
 EXECUTE definition;
 SELECT p.* INTO STRICT successor FROM pg_catalog.pg_proc p WHERE p.oid=predecessor.oid;
 IF successor.prosrc IS DISTINCT FROM expected_body OR (to_jsonb(successor)-'prosrc') IS DISTINCT FROM (to_jsonb(predecessor)-'prosrc')
 THEN RAISE EXCEPTION 'NUTRITION_INDEX_SUCCESSOR_METADATA_MISMATCH'; END IF;
END;

DECLARE predecessor pg_catalog.pg_proc%ROWTYPE; successor pg_catalog.pg_proc%ROWTYPE;
 definition text; expected_body text; patch record;
BEGIN
 SELECT p.* INTO STRICT predecessor FROM pg_catalog.pg_proc p WHERE p.oid='public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>'7f9bf7c936e809f47cccb83d57ee8f052234629f454a5cd5c3afbb5bcf4a2636'
  OR predecessor.prosecdef IS DISTINCT FROM true OR predecessor.provolatile IS DISTINCT FROM 'v'
  OR predecessor.prorettype<>'jsonb'::regtype
  OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR predecessor.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.nutrition_plan_version'::regclass)
  OR current_user IS DISTINCT FROM session_user OR current_user IS DISTINCT FROM pg_get_userbyid(predecessor.proowner)
  OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD']::text[]
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(predecessor.proacl,acldefault('f',predecessor.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
 THEN RAISE EXCEPTION 'NUTRITION_OPTION_B_PREDECESSOR_MISMATCH'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid='public.assert_nutrition_disconnect_body(jsonb)'::regprocedure AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='92a0643c5eff075ec00bacd21152666755dc439c1c01571640e8827a618edc6f') THEN RAISE EXCEPTION 'NUTRITION_OPTION_B_VALIDATOR_MISMATCH'; END IF;
 expected_body:=predecessor.prosrc; definition:=pg_get_functiondef(predecessor.oid);
 FOR patch IN SELECT * FROM (VALUES
(1,$oldB0$ old_pins_by_tuple jsonb;$oldB0$,$newB0$ old_pins_by_tuple jsonb;
 application_context_id uuid; application_context_count bigint;
 application_preserved_loaded boolean:=false; application_affected_loaded boolean:=false;
 application_preserved_value boolean; application_affected_value boolean;
 application_preserved_ids jsonb; application_affected_ids jsonb;$newB0$,1),
(2,$oldB1$  unchanged:=((old_item IS NOT NULL AND old_item-'planVersionId'=item-'planVersionId' AND prior.record_json->'period'=saved->'period' AND prior.record_json->'timezone'=saved->'timezone' AND prior.record_json->'linkedTrainingPlanVersionId'=saved->'linkedTrainingPlanVersionId') OR public.race_manual_nutrition_item_preserved_v1(tenant,plan,expected,item->>'id',item->'anchor',request)) AND NOT public.race_manual_nutrition_item_affected_v1(tenant,plan,expected,item->>'id',item->'anchor',request);$oldB1$,$newB1$  unchanged:=(old_item IS NOT NULL AND old_item-'planVersionId'=item-'planVersionId' AND prior.record_json->'period'=saved->'period' AND prior.record_json->'timezone'=saved->'timezone' AND prior.record_json->'linkedTrainingPlanVersionId'=saved->'linkedTrainingPlanVersionId');
  -- SQL OR/AND three-valued short-circuit: do not eagerly call a helper.
  IF unchanged IS NOT TRUE THEN
   IF NOT application_preserved_loaded THEN
    application_preserved_value:=public.race_manual_nutrition_item_preserved_v1(tenant,plan,expected,item->>'id',item->'anchor',request);
   SELECT count(*),min(x.id::text)::uuid INTO application_context_count,application_context_id
   FROM public.race_manual_application_context_v1 x JOIN public.race_manual_application_candidate_v1 c ON c.athlete_id=x.athlete_id AND c.id=x.candidate_id
   WHERE x.athlete_id=tenant AND x.owner_xid=txid_current() AND x.creator_role=session_user AND x.result IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.candidate_json->'writes') w WHERE w->>'domain'='nutrition' AND w->>'aggregateId'=plan::text);
    IF application_context_count=1 THEN
     application_preserved_ids:=public.race_manual_nutrition_preserved_items_v1(application_context_id,request);
     application_preserved_loaded:=true;
    ELSIF application_context_count=0 THEN
     application_preserved_ids:='[]'::jsonb; application_preserved_loaded:=true;
    END IF;
   ELSE
    application_preserved_value:=application_preserved_ids @> jsonb_build_array(item->>'id') AND item->'anchor'->>'kind'='relative' AND item->'anchor'->>'entity'='race';
   END IF;
   unchanged:=unchanged OR application_preserved_value;
  END IF;
  IF unchanged IS NOT FALSE THEN
   IF NOT application_affected_loaded THEN
    application_affected_value:=public.race_manual_nutrition_item_affected_v1(tenant,plan,expected,item->>'id',item->'anchor',request);
   SELECT count(*),min(x.id::text)::uuid INTO application_context_count,application_context_id
   FROM public.race_manual_application_context_v1 x JOIN public.race_manual_application_candidate_v1 c ON c.athlete_id=x.athlete_id AND c.id=x.candidate_id
   WHERE x.athlete_id=tenant AND x.owner_xid=txid_current() AND x.creator_role=session_user AND x.result IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.candidate_json->'writes') w WHERE w->>'domain'='nutrition' AND w->>'aggregateId'=plan::text);
    IF application_context_count=1 THEN
     application_affected_ids:=public.race_manual_nutrition_affected_items_v1(application_context_id,request);
     application_affected_loaded:=true;
    ELSIF application_context_count=0 THEN
     application_affected_ids:='[]'::jsonb; application_affected_loaded:=true;
    END IF;
   ELSE
    application_affected_value:=application_affected_ids @> jsonb_build_array(item->>'id') AND item->'anchor'->>'kind'='relative' AND item->'anchor'->>'entity'='race';
   END IF;
   unchanged:=unchanged AND NOT application_affected_value;
  END IF;$newB1$,1)
 ) x(ordinal,faulty,corrected,expected_count) ORDER BY ordinal LOOP
  IF (length(expected_body)-length(replace(expected_body,patch.faulty,'')))/length(patch.faulty)<>patch.expected_count
   OR (length(definition)-length(replace(definition,patch.faulty,'')))/length(patch.faulty)<>patch.expected_count THEN RAISE EXCEPTION 'NUTRITION_OPTION_B_PATCH_COUNT_MISMATCH'; END IF;
  expected_body:=replace(expected_body,patch.faulty,patch.corrected); definition:=replace(definition,patch.faulty,patch.corrected);
 END LOOP;
 IF encode(sha256(convert_to(expected_body,'UTF8')),'hex')<>'16b2dc4c79dec56d417f504d4c005034b2769fefc4249dc8244698c6593a75a6' THEN RAISE EXCEPTION 'NUTRITION_OPTION_B_BODY_MISMATCH'; END IF;
 EXECUTE definition;
 SELECT p.* INTO STRICT successor FROM pg_catalog.pg_proc p WHERE p.oid=predecessor.oid;
 IF successor.prosrc IS DISTINCT FROM expected_body OR (to_jsonb(successor)-'prosrc') IS DISTINCT FROM (to_jsonb(predecessor)-'prosrc') THEN RAISE EXCEPTION 'NUTRITION_OPTION_B_METADATA_MISMATCH'; END IF;
END;
END $nutrition_index133$;
