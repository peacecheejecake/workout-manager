-- Explicit staged successor only; normal migration registry and SQL116 bytes are unchanged.
-- SQL023 stores routine_checklist_confirmation.id as UUID, while ->> produces text.
-- Both exact parent-edge and full DTO readers are consumed by the SQL120 store.
-- Correct only this comparison. No grants, data, schemas, or admission rules change.

DO $migration$
DECLARE
 predecessor pg_catalog.pg_proc%ROWTYPE;
 successor pg_catalog.pg_proc%ROWTYPE;
 definition text;
 expected_body text;
 faulty constant text := $comparison$AND id=$2->>'sourceId'$comparison$;
 corrected constant text := $comparison$AND id::text=$2->>'sourceId'$comparison$;
BEGIN
 IF pg_catalog.to_regprocedure('public.manual_race_v2_parent_edges(jsonb)') IS NULL THEN
  RAISE EXCEPTION 'MANUAL_CHECKLIST_PREDECESSOR_MISSING';
 END IF;
 SELECT p.* INTO STRICT predecessor FROM pg_catalog.pg_proc p
 WHERE p.oid='public.manual_race_v2_parent_edges(jsonb)'::regprocedure;
 IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>'a76a24712ee4d148e4e3abe4a97a957eb62fb2c658418a847fc25aa855ca19fc'
  OR predecessor.prosecdef IS DISTINCT FROM false
  OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR predecessor.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass)
  OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
  OR (length(predecessor.prosrc)-length(replace(predecessor.prosrc,faulty,'')))/length(faulty)<>1
 THEN RAISE EXCEPTION 'MANUAL_CHECKLIST_PREDECESSOR_MISMATCH'; END IF;
 expected_body:=replace(predecessor.prosrc,faulty,corrected);
 definition:=pg_catalog.pg_get_functiondef(predecessor.oid);
 IF (length(definition)-length(replace(definition,faulty,'')))/length(faulty)<>1 THEN
  RAISE EXCEPTION 'MANUAL_CHECKLIST_DEFINITION_MISMATCH';
 END IF;
 -- pg_get_functiondef emits CREATE OR REPLACE, preserving the existing function OID.
 EXECUTE replace(definition,faulty,corrected);
 SELECT p.* INTO STRICT successor FROM pg_catalog.pg_proc p WHERE p.oid=predecessor.oid;
 IF successor.prosrc IS DISTINCT FROM expected_body
  OR (to_jsonb(successor)-'prosrc') IS DISTINCT FROM (to_jsonb(predecessor)-'prosrc')
 THEN RAISE EXCEPTION 'MANUAL_CHECKLIST_SUCCESSOR_MISMATCH'; END IF;
END $migration$;

DO $migration$
DECLARE
 predecessor pg_catalog.pg_proc%ROWTYPE;
 successor pg_catalog.pg_proc%ROWTYPE;
 definition text;
 expected_body text;
 faulty constant text := $comparison$AND id=$2->>'sourceId'$comparison$;
 corrected constant text := $comparison$AND id::text=$2->>'sourceId'$comparison$;
BEGIN
 IF pg_catalog.to_regprocedure('public.manual_race_v2_source_dto(jsonb)') IS NULL THEN
  RAISE EXCEPTION 'MANUAL_CHECKLIST_PREDECESSOR_MISSING';
 END IF;
 SELECT p.* INTO STRICT predecessor FROM pg_catalog.pg_proc p
 WHERE p.oid='public.manual_race_v2_source_dto(jsonb)'::regprocedure;
 IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>'d645903b61651e3e679b9ee8238ee2d69d349afce021154cc2a3a11c20d468cf'
  OR predecessor.prosecdef IS DISTINCT FROM false
  OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR predecessor.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass)
  OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp','TimeZone=UTC']::text[]
  OR (length(predecessor.prosrc)-length(replace(predecessor.prosrc,faulty,'')))/length(faulty)<>1
 THEN RAISE EXCEPTION 'MANUAL_CHECKLIST_PREDECESSOR_MISMATCH'; END IF;
 expected_body:=replace(predecessor.prosrc,faulty,corrected);
 definition:=pg_catalog.pg_get_functiondef(predecessor.oid);
 IF (length(definition)-length(replace(definition,faulty,'')))/length(faulty)<>1 THEN
  RAISE EXCEPTION 'MANUAL_CHECKLIST_DEFINITION_MISMATCH';
 END IF;
 -- pg_get_functiondef emits CREATE OR REPLACE, preserving the existing function OID.
 EXECUTE replace(definition,faulty,corrected);
 SELECT p.* INTO STRICT successor FROM pg_catalog.pg_proc p WHERE p.oid=predecessor.oid;
 IF successor.prosrc IS DISTINCT FROM expected_body
  OR (to_jsonb(successor)-'prosrc') IS DISTINCT FROM (to_jsonb(predecessor)-'prosrc')
 THEN RAISE EXCEPTION 'MANUAL_CHECKLIST_SUCCESSOR_MISMATCH'; END IF;
END $migration$;
