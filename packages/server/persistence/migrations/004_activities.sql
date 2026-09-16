CREATE TABLE activity_canonical (
  athlete_id text NOT NULL,
  id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  original jsonb NOT NULL CHECK (octet_length(original::text) <= 8192),
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (athlete_id, id)
);
CREATE TABLE activity_source_head (
  athlete_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fit', 'fixture')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  source_revision integer NOT NULL CHECK (source_revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  activity_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, kind, source_id),
  UNIQUE (athlete_id, activity_id),
  FOREIGN KEY (athlete_id, activity_id) REFERENCES activity_canonical(athlete_id, id)
);
CREATE TABLE activity_source_revision (
  athlete_id text NOT NULL,
  kind text NOT NULL,
  source_id text NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  normalized_raw jsonb NOT NULL CHECK (octet_length(normalized_raw::text) <= 8192),
  PRIMARY KEY (athlete_id, kind, source_id, source_revision),
  FOREIGN KEY (athlete_id, kind, source_id) REFERENCES activity_source_head(athlete_id, kind, source_id)
);
CREATE TABLE activity_overlay (
  athlete_id text NOT NULL,
  activity_id uuid NOT NULL,
  values_json jsonb NOT NULL CHECK (octet_length(values_json::text) <= 8192),
  PRIMARY KEY (athlete_id, activity_id),
  FOREIGN KEY (athlete_id, activity_id) REFERENCES activity_canonical(athlete_id, id)
);
CREATE TABLE activity_overlay_revision (
  athlete_id text NOT NULL,
  activity_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  values_json jsonb NOT NULL CHECK (octet_length(values_json::text) <= 8192),
  PRIMARY KEY (athlete_id, activity_id, revision),
  FOREIGN KEY (athlete_id, activity_id) REFERENCES activity_canonical(athlete_id, id)
);
CREATE TABLE activity_suppression (
  athlete_id text NOT NULL,
  kind text NOT NULL,
  source_id text NOT NULL,
  PRIMARY KEY (athlete_id, kind, source_id),
  FOREIGN KEY (athlete_id, kind, source_id) REFERENCES activity_source_head(athlete_id, kind, source_id)
);
CREATE TABLE activity_import_receipt (
  athlete_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (octet_length(result::text) <= 1024),
  PRIMARY KEY (athlete_id, idempotency_key)
);
CREATE INDEX activity_visible ON activity_canonical(athlete_id, id) WHERE NOT deleted;
DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['activity_canonical','activity_source_head','activity_source_revision','activity_overlay','activity_overlay_revision','activity_suppression','activity_import_receipt'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY activity_tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'', true), '''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'', true), ''''))', table_name);
  END LOOP;
END
$migration$;
