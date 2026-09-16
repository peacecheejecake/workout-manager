CREATE TABLE plan_snapshot (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 1048576),
  PRIMARY KEY (athlete_id, id),
  UNIQUE (athlete_id, version)
);
CREATE TABLE plan_head (
  athlete_id text PRIMARY KEY,
  version_id uuid NOT NULL,
  FOREIGN KEY (athlete_id, version_id) REFERENCES plan_snapshot (athlete_id, id)
);
CREATE TABLE plan_history (
  athlete_id text NOT NULL,
  version_id uuid NOT NULL,
  action text NOT NULL CHECK (action = 'manual_saved'),
  PRIMARY KEY (athlete_id, version_id),
  FOREIGN KEY (athlete_id, version_id) REFERENCES plan_snapshot (athlete_id, id)
);
ALTER TABLE plan_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_snapshot_tenant ON plan_snapshot
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE plan_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_head FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_head_tenant ON plan_head
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE plan_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_history FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_history_tenant ON plan_history
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
CREATE FUNCTION reject_plan_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_PLAN_RECORD'; END;
$$;
CREATE TRIGGER plan_snapshot_immutable BEFORE UPDATE OR DELETE ON plan_snapshot
  FOR EACH ROW EXECUTE FUNCTION reject_plan_mutation();
CREATE TRIGGER plan_history_immutable BEFORE UPDATE OR DELETE ON plan_history
  FOR EACH ROW EXECUTE FUNCTION reject_plan_mutation();
