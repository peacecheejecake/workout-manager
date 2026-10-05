-- M3-02k: no legacy raw row is assumed to prove account ownership. Until an
-- explicit registration commits, the v2 ingestion boundary rejects its UUID.
CREATE TABLE healthkit_workout_registry_head (
  athlete_id text PRIMARY KEY CHECK (length(athlete_id) BETWEEN 1 AND 200),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647)
);
ALTER TABLE healthkit_workout_registry_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthkit_workout_registry_head FORCE ROW LEVEL SECURITY;
CREATE POLICY healthkit_workout_registry_head_scope ON healthkit_workout_registry_head
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- The global primary key, not tenant-scoped lookup, prevents A and B from
-- actively owning the same HealthKit UUID. A fresh epoch prevents stale v2
-- batches from a previous registration from being replayed after re-selection.
CREATE TABLE healthkit_workout_claim (
  sample_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  claim_epoch uuid NOT NULL UNIQUE,
  consent_revision integer NOT NULL CHECK (consent_revision BETWEEN 1 AND 2147483647),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX healthkit_workout_claim_owner ON healthkit_workout_claim(athlete_id,sample_id);
ALTER TABLE healthkit_workout_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthkit_workout_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY healthkit_workout_claim_scope ON healthkit_workout_claim
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- Exact idempotent registration returns the original epoch and revision.
-- Receipt contents are account-private health identifiers. A HealthKit consent
-- withdrawal removes them with the active claim and registry head, permitting
-- another account's subsequent explicit registration of the same UUID.
CREATE TABLE healthkit_workout_registration_receipt (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9_-]+$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result_json jsonb NOT NULL,
  PRIMARY KEY(athlete_id,idempotency_key)
);
ALTER TABLE healthkit_workout_registration_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthkit_workout_registration_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY healthkit_workout_registration_receipt_scope ON healthkit_workout_registration_receipt
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- This AFTER trigger shares the consent UPDATE/DELETE transaction with the raw
-- workout purge from 059. Registration and ingestion lock that consent row
-- before reading claims; do not take their earlier per-account command lock
-- here, which would invert the order and deadlock an in-flight command.
CREATE FUNCTION public.purge_healthkit_registration_on_withdrawal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target_athlete text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind <> 'healthkit' THEN RETURN NULL; END IF;
    target_athlete := OLD.athlete_id;
  ELSE
    IF NEW.kind <> 'healthkit' OR NEW.granted THEN RETURN NULL; END IF;
    target_athlete := NEW.athlete_id;
  END IF;
  DELETE FROM public.healthkit_workout_claim WHERE athlete_id=target_athlete;
  DELETE FROM public.healthkit_workout_registration_receipt WHERE athlete_id=target_athlete;
  DELETE FROM public.healthkit_workout_registry_head WHERE athlete_id=target_athlete;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.purge_healthkit_registration_on_withdrawal() FROM PUBLIC;
CREATE TRIGGER healthkit_registration_consent_withdrawal
  AFTER INSERT OR UPDATE OR DELETE ON public.consent
  FOR EACH ROW EXECUTE FUNCTION public.purge_healthkit_registration_on_withdrawal();

CREATE FUNCTION public.purge_healthkit_registration_on_erasure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  DELETE FROM public.healthkit_workout_claim WHERE athlete_id=NEW.athlete_id;
  DELETE FROM public.healthkit_workout_registration_receipt WHERE athlete_id=NEW.athlete_id;
  DELETE FROM public.healthkit_workout_registry_head WHERE athlete_id=NEW.athlete_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.purge_healthkit_registration_on_erasure() FROM PUBLIC;
CREATE TRIGGER healthkit_registration_account_erasure
  AFTER INSERT ON public.tenant_erasure
  FOR EACH ROW EXECUTE FUNCTION public.purge_healthkit_registration_on_erasure();
