-- Only the current table owner may preserve offline review-stamp metadata.
-- A stored stamp is not official verification proof.
-- Preserve historical 098/099 checksums and every existing role/lifecycle guard.
CREATE FUNCTION public.guard_race_review_stamp_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  stamp jsonb;
  table_owner name;
BEGIN
  stamp := NEW.values_json #> ARRAY['source', 'verifiedAt'];
  IF stamp IS NULL OR stamp = 'null'::jsonb THEN
    RETURN NEW;
  END IF;
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT table_owner
    FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
  IF current_user IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION 'RACE_REVIEW_STAMP_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION public.guard_race_review_stamp_authority() FROM PUBLIC;

CREATE TRIGGER race_review_stamp_authority
  BEFORE INSERT OR UPDATE ON public.race_result
  FOR EACH ROW EXECUTE FUNCTION public.guard_race_review_stamp_authority();
CREATE TRIGGER race_review_stamp_authority
  BEFORE INSERT ON public.race_result_revision
  FOR EACH ROW EXECUTE FUNCTION public.guard_race_review_stamp_authority();
