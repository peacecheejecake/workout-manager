-- Bind each native workout batch to the consent revision observed before collection.
-- The row lock serializes an in-flight upload with withdrawal and re-consent.
CREATE FUNCTION public.healthkit_ingestion_consent_revision_locked() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT CASE WHEN granted THEN revision ELSE NULL END
    FROM public.consent
    WHERE athlete_id = nullif(current_setting('app.athlete_id', true), '')
      AND kind = 'healthkit'
    FOR UPDATE;
$$;
REVOKE ALL ON FUNCTION public.healthkit_ingestion_consent_revision_locked() FROM PUBLIC;
