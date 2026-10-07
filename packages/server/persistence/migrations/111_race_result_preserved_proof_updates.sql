-- Successor of109: preserve exact V2 proof facts during ordinary result correction.
-- The original109 migration/checksum and trigger identities remain unchanged.
-- CREATE OR REPLACE preserves the existing function OID, owner and narrow ACL.
-- No new privilege, public activation, source finalization or restore admission.
CREATE OR REPLACE FUNCTION public.guard_race_result_proof_body() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE is_redaction boolean:=false; is_clone boolean:=false; is_history_copy boolean:=false; is_preserved_successor boolean:=false;
BEGIN
 PERFORM public.assert_race_proof_owner();
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RACE_PROOF_TENANT_MISMATCH'; END IF;
 IF NEW.values_json IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.athlete_id,0));
 IF TG_OP='UPDATE' THEN
  is_redaction:=NEW.values_json IS NOT DISTINCT FROM public.race_result_proof_redacted(NEW.athlete_id,OLD.values_json)
   AND NEW.values_json IS DISTINCT FROM OLD.values_json
   AND (to_jsonb(NEW)-'values_json') IS NOT DISTINCT FROM (to_jsonb(OLD)-'values_json');
  IF TG_TABLE_NAME='race_result' THEN
   -- The legacy endpoint may correct actual facts, but cannot implicitly remove
   -- stored V2 proofs. Normal NULL tombstones keep their historical path above.
   IF OLD.values_json->'schemaVersion'='2'::jsonb
    AND NEW.values_json->'schemaVersion' IS DISTINCT FROM '2'::jsonb
   THEN RAISE EXCEPTION 'RACE_PROOF_VERSION_DOWNGRADE'; END IF;
   -- Only this exact owned predecessor supplies frozen proof identity. An
   -- unavailable descriptor must still have the authenticated source event;
   -- an available one must still match the current owned immutable content.
   is_preserved_successor:=coalesce(NOT OLD.deleted AND NOT NEW.deleted
    AND OLD.values_json->'schemaVersion'='2'::jsonb
    AND NEW.values_json->'schemaVersion'='2'::jsonb
    AND NEW.values_json->'proofs' IS NOT DISTINCT FROM OLD.values_json->'proofs'
    AND NEW.revision::bigint=OLD.revision::bigint+1
    AND NEW.updated_at>=greatest(OLD.updated_at,OLD.recorded_at)
    AND (to_jsonb(NEW)-ARRAY['values_json','revision','updated_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['values_json','revision','updated_at']),false);
   is_clone:=public.race_result_proof_source_clone(NEW.athlete_id,OLD.values_json,NEW.values_json)
    AND NEW.revision=least(OLD.revision::bigint+1,2147483647)::integer
    AND NEW.updated_at>=greatest(OLD.updated_at,OLD.recorded_at)
    AND (to_jsonb(NEW)-ARRAY['values_json','revision','updated_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['values_json','revision','updated_at']);
  END IF;
 END IF;
 IF TG_TABLE_NAME='race_result_revision' AND TG_OP='INSERT' THEN
  -- This exact tuple already passed the head guard; it is not an initial descriptor.
  SELECT EXISTS(SELECT 1 FROM public.race_result h WHERE h.athlete_id=NEW.athlete_id
   AND h.id=NEW.entity_id AND h.revision=NEW.revision AND NOT h.deleted
   AND h.values_json=NEW.values_json) INTO is_history_copy;
 END IF;
 PERFORM public.assert_race_result_proofs(NEW.athlete_id,NEW.values_json,
  NOT (is_redaction OR is_clone OR is_history_copy OR is_preserved_successor),
  is_redaction OR is_clone OR is_history_copy OR is_preserved_successor);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_race_result_proof_body() FROM PUBLIC;
