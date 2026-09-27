-- A HealthKit UUID may supplement exactly one existing Activity. The Activity's
-- primary source and values remain unchanged, so it is counted only once.
ALTER TABLE healthkit_workout_lineage DROP CONSTRAINT healthkit_workout_lineage_state_check;
ALTER TABLE healthkit_workout_lineage ADD CONSTRAINT healthkit_workout_lineage_state_check
  CHECK (state IN ('pending_review', 'linked_existing', 'suppressed', 'deleted'));

CREATE TABLE healthkit_existing_binding (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  sample_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  sample_digest text NOT NULL CHECK (sample_digest ~ '^[a-f0-9]{64}$'),
  target_revision integer NOT NULL CHECK (target_revision > 0),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (athlete_id, sample_id),
  FOREIGN KEY (athlete_id, sample_id)
    REFERENCES healthkit_workout_sample (athlete_id, sample_id) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id, activity_id)
    REFERENCES activity_canonical (athlete_id, id) ON DELETE CASCADE
);
CREATE INDEX healthkit_existing_binding_activity
  ON healthkit_existing_binding (athlete_id, activity_id, sample_id);
ALTER TABLE healthkit_existing_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthkit_existing_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY healthkit_existing_binding_scope ON healthkit_existing_binding
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- A direct table insert cannot bypass the same live-source, consent, tenant and
-- target checks used by the repository. The caller holds the command lock first;
-- this function locks the consent row before the sample and target rows.
CREATE FUNCTION public.validate_healthkit_existing_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
DECLARE sample_row record; target_row record; lineage_state text;
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
    OR NOT coalesce(public.healthkit_ingestion_consent_locked(), false)
  THEN RAISE EXCEPTION 'HEALTHKIT_CONSENT_REQUIRED'; END IF;

  SELECT state, payload_digest INTO sample_row
    FROM public.healthkit_workout_sample
    WHERE athlete_id=NEW.athlete_id AND sample_id=NEW.sample_id FOR UPDATE;
  IF NOT FOUND OR sample_row.state <> 'active' OR sample_row.payload_digest <> NEW.sample_digest
  THEN RAISE EXCEPTION 'HEALTHKIT_SAMPLE_UNAVAILABLE'; END IF;

  SELECT state INTO lineage_state FROM public.healthkit_workout_lineage
    WHERE athlete_id=NEW.athlete_id AND sample_id=NEW.sample_id FOR UPDATE;
  IF NOT FOUND OR lineage_state <> 'pending_review'
  THEN RAISE EXCEPTION 'HEALTHKIT_SAMPLE_UNAVAILABLE'; END IF;

  SELECT revision,deleted INTO target_row FROM public.activity_canonical
    WHERE athlete_id=NEW.athlete_id AND id=NEW.activity_id FOR UPDATE;
  IF NOT FOUND OR target_row.deleted OR target_row.revision <> NEW.target_revision
  THEN RAISE EXCEPTION 'HEALTHKIT_TARGET_UNAVAILABLE'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.activity_source_head h
    WHERE h.athlete_id=NEW.athlete_id AND h.activity_id=NEW.activity_id
      AND h.kind IN ('fit','manual')
      AND NOT EXISTS (
        SELECT 1 FROM public.activity_suppression s
        WHERE s.athlete_id=h.athlete_id AND s.kind=h.kind AND s.source_id=h.source_id
      )
  ) THEN RAISE EXCEPTION 'HEALTHKIT_TARGET_UNAVAILABLE'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_healthkit_existing_binding() FROM PUBLIC;
CREATE TRIGGER healthkit_existing_binding_validate BEFORE INSERT ON healthkit_existing_binding
  FOR EACH ROW EXECUTE FUNCTION public.validate_healthkit_existing_binding();

CREATE FUNCTION public.project_healthkit_existing_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
BEGIN
  UPDATE public.healthkit_workout_lineage SET state='linked_existing'
    WHERE athlete_id=NEW.athlete_id AND sample_id=NEW.sample_id
      AND state='pending_review';
  IF NOT FOUND THEN RAISE EXCEPTION 'HEALTHKIT_SAMPLE_UNAVAILABLE'; END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.project_healthkit_existing_binding() FROM PUBLIC;
CREATE TRIGGER healthkit_existing_binding_project AFTER INSERT ON healthkit_existing_binding
  FOR EACH ROW EXECUTE FUNCTION public.project_healthkit_existing_binding();

-- A real HealthKit delete removes the supplement before the raw row becomes a
-- tombstone. Migration 060's trigger then marks the lineage deleted.
CREATE FUNCTION public.remove_healthkit_existing_binding_on_tombstone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
BEGIN
  DELETE FROM public.healthkit_existing_binding
    WHERE athlete_id=NEW.athlete_id AND sample_id=NEW.sample_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.remove_healthkit_existing_binding_on_tombstone() FROM PUBLIC;
CREATE TRIGGER healthkit_existing_binding_on_tombstone
  AFTER UPDATE OF state ON healthkit_workout_sample
  FOR EACH ROW WHEN (NEW.state='deleted' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION public.remove_healthkit_existing_binding_on_tombstone();

-- Explicit Activity deletion suppresses all linked HealthKit UUIDs. A delayed
-- raw upsert cannot make a deleted Activity reappear or return to review.
CREATE FUNCTION public.suppress_healthkit_existing_binding_on_activity_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
BEGIN
  UPDATE public.healthkit_workout_lineage l SET state='suppressed'
    WHERE l.athlete_id=NEW.athlete_id AND l.state='linked_existing'
      AND EXISTS (SELECT 1 FROM public.healthkit_existing_binding b
        WHERE b.athlete_id=l.athlete_id AND b.sample_id=l.sample_id
          AND b.activity_id=NEW.id);
  DELETE FROM public.healthkit_existing_binding
    WHERE athlete_id=NEW.athlete_id AND activity_id=NEW.id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.suppress_healthkit_existing_binding_on_activity_delete() FROM PUBLIC;
CREATE TRIGGER healthkit_existing_binding_on_activity_delete
  AFTER UPDATE OF deleted ON activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION public.suppress_healthkit_existing_binding_on_activity_delete();

-- Suppression can also be recorded before the canonical tombstone. Remove the
-- supplement at that first irreversible source decision, including a direct
-- source suppression that does not update the Activity row.
CREATE FUNCTION public.suppress_healthkit_existing_binding_on_source_suppression()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
DECLARE target_id uuid;
BEGIN
  SELECT activity_id INTO target_id FROM public.activity_source_head
    WHERE athlete_id=NEW.athlete_id AND kind=NEW.kind AND source_id=NEW.source_id;
  IF target_id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.healthkit_workout_lineage l SET state='suppressed'
    WHERE l.athlete_id=NEW.athlete_id AND l.state='linked_existing'
      AND EXISTS (SELECT 1 FROM public.healthkit_existing_binding b
        WHERE b.athlete_id=l.athlete_id AND b.sample_id=l.sample_id
          AND b.activity_id=target_id);
  DELETE FROM public.healthkit_existing_binding
    WHERE athlete_id=NEW.athlete_id AND activity_id=target_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.suppress_healthkit_existing_binding_on_source_suppression()
  FROM PUBLIC;
CREATE TRIGGER healthkit_existing_binding_on_source_suppression
  AFTER INSERT ON activity_suppression
  FOR EACH ROW
  EXECUTE FUNCTION public.suppress_healthkit_existing_binding_on_source_suppression();

-- The command receipt contains the source UUID and Activity link. Withdrawal
-- removes raw rows (and cascades bindings) and redacts that receipt atomically.
CREATE FUNCTION public.purge_healthkit_binding_receipts_on_withdrawal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
DECLARE target_athlete text;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.kind <> 'healthkit' THEN RETURN NULL; END IF;
    target_athlete := OLD.athlete_id;
  ELSE
    IF NEW.kind <> 'healthkit' OR NEW.granted THEN RETURN NULL; END IF;
    target_athlete := NEW.athlete_id;
  END IF;
  UPDATE public.command_receipt SET request='{"purged":true}'::jsonb,
    result='{"purged":true}'::jsonb
    WHERE athlete_id=target_athlete
      AND idempotency_key LIKE 'healthkit-bind-existing:%';
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_healthkit_binding_receipts_on_withdrawal() FROM PUBLIC;
CREATE TRIGGER healthkit_binding_receipts_withdrawal
  AFTER INSERT OR UPDATE OR DELETE ON consent
  FOR EACH ROW EXECUTE FUNCTION public.purge_healthkit_binding_receipts_on_withdrawal();
