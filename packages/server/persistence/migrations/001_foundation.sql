CREATE TABLE consent (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('app', 'provider', 'ai', 'healthkit', 'media')),
  granted boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (athlete_id, kind)
);
ALTER TABLE consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_tenant ON consent
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

CREATE TABLE outbox (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  topic text NOT NULL CHECK (length(topic) BETWEEN 1 AND 100),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  completed_at timestamptz,
  PRIMARY KEY (athlete_id, id),
  UNIQUE (athlete_id, idempotency_key),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX outbox_ready ON outbox (athlete_id, available_at, created_at, id)
  WHERE completed_at IS NULL;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant ON outbox
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

CREATE TABLE command_receipt (
  athlete_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (athlete_id, idempotency_key)
);
ALTER TABLE command_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY receipt_tenant ON command_receipt
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
