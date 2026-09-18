-- Corrections retain frozen evidence; explicit source removal scrubs the entire body.
CREATE FUNCTION purge_core_evidence_constraint() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
  RAISE EXCEPTION 'EVIDENCE_TENANT_MISMATCH';
 END IF;
 IF TG_OP='DELETE' OR (NOT OLD.deleted AND NEW.deleted) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.athlete_id,0));
  UPDATE public.core_evidence_snapshot SET body=NULL,purged_reason='source_deleted'
  WHERE athlete_id=OLD.athlete_id AND body IS NOT NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(body->'userConstraints'->'items') item WHERE item->>'id'=OLD.id::text);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION purge_core_evidence_constraint() FROM PUBLIC;
CREATE TRIGGER purge_core_evidence_constraint AFTER UPDATE OF deleted OR DELETE ON coaching_constraint
 FOR EACH ROW EXECUTE FUNCTION purge_core_evidence_constraint();

-- Only the table owner, under the matching tenant maintenance context, may replay
-- a verified latest ledger across several revisions. Runtime commands still increment one.
CREATE OR REPLACE FUNCTION guard_coaching_constraint() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE maintenance boolean;
BEGIN
 maintenance := current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'');
 IF TG_OP='DELETE' THEN
  IF maintenance THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_CONSTRAINT_IDENTITY';
 END IF;
 IF OLD.deleted OR NEW.id<>OLD.id OR NEW.athlete_id<>OLD.athlete_id
  OR NOT (NEW.revision=OLD.revision+1 OR (maintenance AND NEW.revision>OLD.revision)) THEN
  RAISE EXCEPTION 'IMMUTABLE_CONSTRAINT_IDENTITY';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_coaching_constraint() FROM PUBLIC;
