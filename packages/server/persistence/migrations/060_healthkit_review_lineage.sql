-- M3-02d: one review-only lineage per HealthKit UUID. This is deliberately
-- separate from activity_source_head/activity_canonical and period summaries.
CREATE TABLE healthkit_workout_lineage (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  sample_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending_review', 'suppressed', 'deleted')),
  PRIMARY KEY (athlete_id, sample_id),
  FOREIGN KEY (athlete_id, sample_id)
    REFERENCES healthkit_workout_sample (athlete_id, sample_id) ON DELETE CASCADE
);

-- Migration runs as a plain table owner. Lift FORCE only within migrate()'s
-- transaction and ACCESS EXCLUSIVE DDL lock so the owner can see all tenant
-- rows for the backfill. Runtime roles remain subject to the existing policy.
ALTER TABLE healthkit_workout_sample NO FORCE ROW LEVEL SECURITY;
-- Upgrade existing raw rows before enabling RLS on the new table. No canonical
-- activity is made.
INSERT INTO healthkit_workout_lineage (athlete_id, sample_id, state)
SELECT athlete_id, sample_id,
  CASE WHEN state = 'deleted' THEN 'deleted' ELSE 'pending_review' END
FROM healthkit_workout_sample;
ALTER TABLE healthkit_workout_sample FORCE ROW LEVEL SECURITY;

ALTER TABLE healthkit_workout_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthkit_workout_lineage FORCE ROW LEVEL SECURITY;
CREATE POLICY healthkit_workout_lineage_scope ON healthkit_workout_lineage
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- The raw write and lineage transition must commit or roll back together. A
-- late active sample never clears a prior suppression/deletion decision.
CREATE FUNCTION public.project_healthkit_workout_lineage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public.healthkit_workout_lineage (athlete_id, sample_id, state)
  VALUES (NEW.athlete_id, NEW.sample_id,
    CASE WHEN NEW.state = 'deleted' THEN 'deleted' ELSE 'pending_review' END)
  ON CONFLICT (athlete_id, sample_id) DO UPDATE
    SET state = CASE
      WHEN EXCLUDED.state = 'deleted' THEN 'deleted'
      ELSE healthkit_workout_lineage.state
    END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.project_healthkit_workout_lineage() FROM PUBLIC;
CREATE TRIGGER healthkit_workout_lineage_projection
  AFTER INSERT OR UPDATE OF state ON healthkit_workout_sample
  FOR EACH ROW EXECUTE FUNCTION public.project_healthkit_workout_lineage();
