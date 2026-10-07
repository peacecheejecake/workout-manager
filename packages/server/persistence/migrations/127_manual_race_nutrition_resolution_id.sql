-- Explicit staged successor only. Historical SQL122 and normal registry107 stay unchanged.
-- Canonical nutritionPlanItemCoreSchema.shape.id has no scalar length maximum.
-- Remove exactly the obsolete public review itemId maximum; whole-command 4MiB,
-- finite nutrition/routine rosters, receipt-first replay and provenance gates remain.
-- No relation, data, role, grant, or public API change is made here.

DO $migration$
DECLARE
 predecessor pg_catalog.pg_proc%ROWTYPE;
 successor pg_catalog.pg_proc%ROWTYPE;
 definition text;
 expected_body text;
 faulty constant text := $item$"itemId":{"type":"string","minLength":1,"maxLength":200}$item$;
 corrected constant text := $item$"itemId":{"type":"string","minLength":1}$item$;
BEGIN
 IF pg_catalog.to_regprocedure('public.race_manual_public_wire_v1(text)') IS NULL THEN
  RAISE EXCEPTION 'MANUAL_NUTRITION_ID_PREDECESSOR_MISSING';
 END IF;
 SELECT p.* INTO STRICT predecessor FROM pg_catalog.pg_proc p
 WHERE p.oid='public.race_manual_public_wire_v1(text)'::regprocedure;
 IF encode(sha256(convert_to(predecessor.prosrc,'UTF8')),'hex')<>'a6873605f15766bd36cd90e94de42593c6e4c1a879753f342cac3bdf6c11fe26'
  OR predecessor.prosecdef IS DISTINCT FROM false
  OR predecessor.provolatile IS DISTINCT FROM 'i'
  OR predecessor.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
  OR predecessor.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.race_manual_public_receipt_v1'::regclass)
  OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
  OR (length(predecessor.prosrc)-length(replace(predecessor.prosrc,faulty,'')))/length(faulty)<>1
 THEN RAISE EXCEPTION 'MANUAL_NUTRITION_ID_PREDECESSOR_MISMATCH'; END IF;
 expected_body:=replace(predecessor.prosrc,faulty,corrected);
 definition:=pg_catalog.pg_get_functiondef(predecessor.oid);
 IF (length(definition)-length(replace(definition,faulty,'')))/length(faulty)<>1 THEN
  RAISE EXCEPTION 'MANUAL_NUTRITION_ID_DEFINITION_MISMATCH';
 END IF;
 -- The exact pg_get_functiondef CREATE OR REPLACE preserves OID, owner and ACL.
 -- The replacement does not change approve/reference CASEs or other review fields.
 EXECUTE replace(definition,faulty,corrected);
 SELECT p.* INTO STRICT successor FROM pg_catalog.pg_proc p WHERE p.oid=predecessor.oid;
 IF successor.prosrc IS DISTINCT FROM expected_body
  OR (to_jsonb(successor)-'prosrc') IS DISTINCT FROM (to_jsonb(predecessor)-'prosrc')
 THEN RAISE EXCEPTION 'MANUAL_NUTRITION_ID_SUCCESSOR_MISMATCH'; END IF;
END $migration$;
