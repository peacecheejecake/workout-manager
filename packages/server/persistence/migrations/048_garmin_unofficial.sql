-- M1-06b-tmp: the TEMPORARY, UNOFFICIAL in-app Garmin collector (python-garminconnect), for
-- one deployment-configured owner account. It is NOT the official integration (006_garmin):
-- it has its own tables, never touches garmin_connection/garmin_attempt, and never queues
-- anything into garmin_private.revocation, because an unofficial session cannot be revoked
-- at Garmin. See docs/implementation/research/garmin-temporary-gate.md.

-- One row per owner. `profile_hash` is an HMAC-SHA-256, under a dedicated pin key held
-- outside the database, of the Garmin profile id pinned by the first successful login (the
-- id is a small integer, so an unkeyed digest would be reversible); it survives a disconnect (a different Garmin profile stays refused) and
-- leaves only with account erasure. `encrypted_session` is the AES-256-GCM envelope of the
-- library session (distinct AAD purpose); the key is never in the database.
CREATE TABLE garmin_unofficial_connection (
  athlete_id text PRIMARY KEY CHECK (length(athlete_id) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'not_connected'
    CHECK (state IN ('not_connected', 'connected', 'reconnect_required')),
  profile_hash text CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  encrypted_session jsonb CHECK (garmin_private.valid_cipher(encrypted_session)),
  session_generation integer NOT NULL DEFAULT 0 CHECK (session_generation >= 0),
  connected_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  run_requested_at timestamptz,
  schedule_enabled boolean NOT NULL DEFAULT false,
  schedule_paused boolean NOT NULL DEFAULT false,
  next_scheduled_at timestamptz,
  blocked_until timestamptz,
  transient_failures integer NOT NULL DEFAULT 0 CHECK (transient_failures BETWEEN 0 AND 1000),
  login_window_started_at timestamptz,
  login_attempts integer NOT NULL DEFAULT 0 CHECK (login_attempts BETWEEN 0 AND 1000),
  login_failures integer NOT NULL DEFAULT 0 CHECK (login_failures BETWEEN 0 AND 1000),
  login_locked_until timestamptz,
  CHECK ((state = 'connected') = (encrypted_session IS NOT NULL)),
  CHECK (state = 'not_connected' OR profile_hash IS NOT NULL),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK (connected_at IS NULL OR state <> 'not_connected')
);

CREATE TABLE garmin_unofficial_run (
  athlete_id text NOT NULL REFERENCES garmin_unofficial_connection ON DELETE CASCADE,
  id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'partial', 'rate_limited',
    'reconnect_required', 'failed_transient', 'failed_permanent', 'cancelled')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz CHECK (finished_at IS NULL OR finished_at >= started_at),
  listed integer NOT NULL DEFAULT 0 CHECK (listed >= 0),
  imported integer NOT NULL DEFAULT 0 CHECK (imported >= 0),
  unchanged integer NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
  suppressed integer NOT NULL DEFAULT 0 CHECK (suppressed >= 0),
  skipped integer NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  complete boolean,
  PRIMARY KEY (athlete_id, id),
  CHECK ((state = 'running') = (finished_at IS NULL))
);
-- One run per connection at a time, independent of the lease column.
CREATE UNIQUE INDEX garmin_unofficial_one_running ON garmin_unofficial_run(athlete_id)
  WHERE state = 'running';
CREATE INDEX garmin_unofficial_run_recent ON garmin_unofficial_run(athlete_id, started_at DESC);

-- Provider-neutral record of every Garmin activity a collector has handled, keyed by the
-- Garmin activity id. The official adapter (M1-06b) reads and writes the same ledger, so an
-- activity the unofficial collector brought in is not collected again by the official one,
-- and the reverse. Rows stay after a disconnect and after the activity is deleted: a deleted
-- activity is never downloaded again, and its import would be suppressed if it were.
CREATE TABLE garmin_activity_ledger (
  athlete_id text NOT NULL,
  garmin_activity_id text NOT NULL CHECK (garmin_activity_id ~ '^[1-9][0-9]{0,23}$'),
  provider text NOT NULL CHECK (provider IN ('garmin-connect-unofficial', 'garmin-official')),
  official boolean NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('imported', 'unchanged', 'stale', 'suppressed')),
  collected_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id, garmin_activity_id),
  CHECK (official = (provider = 'garmin-official'))
);
-- Which stored activity sources a Garmin activity became (a multi-session FIT gives several).
CREATE TABLE garmin_activity_ledger_source (
  athlete_id text NOT NULL,
  garmin_activity_id text NOT NULL,
  kind text NOT NULL,
  source_id text NOT NULL,
  PRIMARY KEY (athlete_id, kind, source_id),
  FOREIGN KEY (athlete_id, garmin_activity_id)
    REFERENCES garmin_activity_ledger(athlete_id, garmin_activity_id) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id, kind, source_id)
    REFERENCES activity_source_head(athlete_id, kind, source_id)
);
CREATE INDEX garmin_activity_ledger_source_activity
  ON garmin_activity_ledger_source(athlete_id, garmin_activity_id);

ALTER TABLE garmin_unofficial_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_unofficial_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY garmin_unofficial_connection_scope ON garmin_unofficial_connection
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE garmin_unofficial_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_unofficial_run FORCE ROW LEVEL SECURITY;
CREATE POLICY garmin_unofficial_run_scope ON garmin_unofficial_run
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE garmin_activity_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_activity_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY garmin_activity_ledger_scope ON garmin_activity_ledger
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE garmin_activity_ledger_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_activity_ledger_source FORCE ROW LEVEL SECURITY;
CREATE POLICY garmin_activity_ledger_source_scope ON garmin_activity_ledger_source
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- Erasure removes the session, the pin, the run history and the ledger. There is nothing to
-- queue: an unofficial session cannot be revoked at Garmin (the screens say so), and the
-- official revocation queue must never receive it. Lock order: the account lock (77206),
-- then the per-tenant command lock (0), then rows; the ledger goes before the activity rows
-- the rest of the chain deletes, because its source rows reference them.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_garmin_unofficial;
REVOKE ALL ON FUNCTION public.erase_account_before_garmin_unofficial(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_garmin_unofficial(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_garmin_unofficial(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  DELETE FROM public.garmin_activity_ledger_source WHERE athlete_id=$1;
  DELETE FROM public.garmin_activity_ledger WHERE athlete_id=$1;
  DELETE FROM public.garmin_unofficial_run WHERE athlete_id=$1;
  DELETE FROM public.garmin_unofficial_connection WHERE athlete_id=$1;
  RETURN public.erase_account_before_garmin_unofficial($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
