-- M3-02a: native HealthKit workout delivery remains raw source data. It does not create
-- canonical activities; matching across providers requires a separate explicit decision.
CREATE TABLE healthkit_workout_sample (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  sample_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'deleted')),
  source_bundle_id text CHECK (length(source_bundle_id) BETWEEN 1 AND 255),
  source_version text CHECK (length(source_version) BETWEEN 1 AND 128),
  activity_type integer CHECK (activity_type >= 0),
  observed_from timestamptz,
  observed_to timestamptz,
  duration_seconds double precision CHECK (duration_seconds BETWEEN 0 AND 2678400),
  distance_meters double precision CHECK (distance_meters BETWEEN 0 AND 1000000000),
  energy_kilocalories double precision CHECK (energy_kilocalories BETWEEN 0 AND 1000000000),
  payload_digest text CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (athlete_id, sample_id),
  CHECK (
    (state = 'active' AND source_bundle_id IS NOT NULL AND activity_type IS NOT NULL
      AND observed_from IS NOT NULL AND observed_to IS NOT NULL
      AND observed_to >= observed_from AND duration_seconds IS NOT NULL
      AND payload_digest IS NOT NULL AND deleted_at IS NULL)
    OR
    (state = 'deleted' AND source_bundle_id IS NULL AND source_version IS NULL
      AND activity_type IS NULL AND observed_from IS NULL AND observed_to IS NULL
      AND duration_seconds IS NULL AND distance_meters IS NULL
      AND energy_kilocalories IS NULL AND payload_digest IS NULL AND deleted_at IS NOT NULL)
  )
);
CREATE INDEX healthkit_workout_sample_received ON healthkit_workout_sample
  (athlete_id, received_at, sample_id);
ALTER TABLE healthkit_workout_sample ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthkit_workout_sample FORCE ROW LEVEL SECURITY;
CREATE POLICY healthkit_workout_sample_scope ON healthkit_workout_sample
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- The receipt stores only the digest and ACK facts. On consent withdrawal its digest is
-- erased; the content-independent batch IDs survive as a replay barrier.
CREATE TABLE healthkit_workout_batch_receipt (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  installation_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  request_digest text,
  accepted_count integer NOT NULL CHECK (accepted_count BETWEEN 1 AND 100),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  purged_at timestamptz,
  PRIMARY KEY (athlete_id, installation_id, batch_id),
  CHECK (
    (purged_at IS NULL AND request_digest IS NOT NULL AND request_digest ~ '^[a-f0-9]{64}$')
    OR (purged_at IS NOT NULL AND request_digest IS NULL)
  )
);
ALTER TABLE healthkit_workout_batch_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthkit_workout_batch_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY healthkit_workout_batch_receipt_scope ON healthkit_workout_batch_receipt
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- Lock the consent row without granting UPDATE on consent to the ingestion role.
-- The lock is held until the caller commits, and serializes with a withdrawal.
CREATE FUNCTION public.healthkit_ingestion_consent_locked() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT granted FROM public.consent
    WHERE athlete_id = nullif(current_setting('app.athlete_id', true), '')
      AND kind = 'healthkit'
    FOR UPDATE;
$$;
REVOKE ALL ON FUNCTION public.healthkit_ingestion_consent_locked() FROM PUBLIC;

-- Consent and ingestion serialize on the consent row. This trigger runs within the
-- withdrawal transaction, removing source bodies before the revoke can commit.
CREATE FUNCTION public.purge_healthkit_workouts_on_withdrawal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
DECLARE target_athlete text;
BEGIN
  target_athlete := CASE WHEN TG_OP = 'DELETE' THEN OLD.athlete_id ELSE NEW.athlete_id END;
  IF (CASE WHEN TG_OP = 'DELETE' THEN OLD.kind ELSE NEW.kind END) <> 'healthkit' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' OR NOT NEW.granted THEN
    DELETE FROM public.healthkit_workout_sample WHERE athlete_id = target_athlete;
    UPDATE public.healthkit_workout_batch_receipt
      SET request_digest = NULL, purged_at = clock_timestamp()
      WHERE athlete_id = target_athlete AND purged_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_healthkit_workouts_on_withdrawal() FROM PUBLIC;
CREATE TRIGGER healthkit_workout_consent_withdrawal
  AFTER INSERT OR UPDATE OR DELETE ON consent
  FOR EACH ROW EXECUTE FUNCTION public.purge_healthkit_workouts_on_withdrawal();

-- Erase even the replay barrier; no HealthKit data or receipt survives account erasure.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_healthkit_ingestion;
REVOKE ALL ON FUNCTION public.erase_account_before_healthkit_ingestion(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_healthkit_ingestion(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_healthkit_ingestion(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  DELETE FROM public.healthkit_workout_sample WHERE athlete_id=$1;
  DELETE FROM public.healthkit_workout_batch_receipt WHERE athlete_id=$1;
  RETURN public.erase_account_before_healthkit_ingestion($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
