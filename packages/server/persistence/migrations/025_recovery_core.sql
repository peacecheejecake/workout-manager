-- Recovery strategies select a reviewed course of action, but do not write
-- training, nutrition or routine schedules. Non-exercise actions alone have a
-- recovery ledger; activity, intake and check-in references stay in theirs.
CREATE TABLE recovery_method_version (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  method_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  record_json jsonb NOT NULL CHECK (
    jsonb_typeof(record_json) = 'object' AND octet_length(record_json::text) <= 65536
    AND (record_json->>'schemaVersion' = '1'
      AND record_json->>'methodId' = method_id::text
      AND record_json->>'versionId' = version_id::text
      AND record_json->>'reviewState' = 'unreviewed'
      AND record_json->'reviewedAt' = 'null'::jsonb
      AND record_json->>'source' = 'user_recorded') IS TRUE
  ),
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, method_id, version),
  UNIQUE (athlete_id, method_id, version, version_id)
);
CREATE TABLE recovery_method_head (
  athlete_id text NOT NULL,
  method_id uuid NOT NULL,
  version integer NOT NULL,
  version_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, method_id),
  FOREIGN KEY (athlete_id, method_id, version, version_id)
    REFERENCES recovery_method_version (athlete_id, method_id, version, version_id)
);
CREATE TABLE recovery_strategy_version (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  strategy_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  previous_version_id uuid,
  previous_version integer,
  record_json jsonb NOT NULL CHECK (
    jsonb_typeof(record_json) = 'object' AND octet_length(record_json::text) <= 262144
    AND (record_json->>'schemaVersion' = '1'
      AND record_json->>'strategyId' = strategy_id::text
      AND record_json->>'versionId' = version_id::text
      AND record_json->>'version' = version::text
      AND (record_json->>'previousVersionId') IS NOT DISTINCT FROM previous_version_id::text) IS TRUE
  ),
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, strategy_id, version),
  UNIQUE (athlete_id, strategy_id, version, version_id),
  FOREIGN KEY (athlete_id, strategy_id, previous_version, previous_version_id)
    REFERENCES recovery_strategy_version (athlete_id, strategy_id, version, version_id),
  CHECK ((version = 1 AND previous_version IS NULL AND previous_version_id IS NULL)
    OR (version > 1 AND previous_version = version - 1 AND previous_version_id IS NOT NULL))
);
CREATE TABLE recovery_strategy_head (
  athlete_id text NOT NULL,
  strategy_id uuid NOT NULL,
  version integer NOT NULL,
  version_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, strategy_id),
  FOREIGN KEY (athlete_id, strategy_id, version, version_id)
    REFERENCES recovery_strategy_version (athlete_id, strategy_id, version, version_id)
);
CREATE TABLE recovery_action_log (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  action_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted')),
  PRIMARY KEY (athlete_id, action_id)
);
CREATE TABLE recovery_action_revision (
  athlete_id text NOT NULL,
  action_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted')),
  record_json jsonb,
  PRIMARY KEY (athlete_id, action_id, revision),
  UNIQUE (athlete_id, revision_id),
  UNIQUE (athlete_id, action_id, revision, revision_id, status),
  FOREIGN KEY (athlete_id, action_id)
    REFERENCES recovery_action_log (athlete_id, action_id),
  CHECK (
    (status = 'active' AND record_json IS NOT NULL
      AND jsonb_typeof(record_json) = 'object'
      AND octet_length(record_json::text) <= 65536
      AND (record_json->>'schemaVersion' = '1'
        AND record_json->>'actionId' = action_id::text
        AND record_json->>'revisionId' = revision_id::text
        AND record_json->>'revision' = revision::text
        AND record_json->>'status' = 'active') IS TRUE)
    OR
    (status = 'deleted' AND record_json IS NOT NULL
      AND jsonb_typeof(record_json) = 'object'
      AND (record_json->>'actionId' = action_id::text
        AND record_json->>'revisionId' = revision_id::text
        AND record_json->>'revision' = revision::text
        AND record_json->>'status' = 'deleted') IS TRUE)
  )
);
ALTER TABLE recovery_action_log ADD CONSTRAINT recovery_action_current_fk
  FOREIGN KEY (athlete_id, action_id, revision, revision_id, status)
  REFERENCES recovery_action_revision (athlete_id, action_id, revision, revision_id, status)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX recovery_action_current ON recovery_action_log (athlete_id, action_id) WHERE status='active';

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'recovery_method_version', 'recovery_method_head',
    'recovery_strategy_version', 'recovery_strategy_head',
    'recovery_action_log', 'recovery_action_revision'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'', true), '''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'', true), ''''))',
      table_name
    );
  END LOOP;
END $$;

-- Account erasure discards historical health payloads and method text before
-- invoking the previous eraser. Runtime users have no direct DELETE grant.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_recovery_core;
REVOKE ALL ON FUNCTION public.erase_account_before_recovery_core(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN
    SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid = 'public.erase_account_before_recovery_core(text)'::regprocedure
      AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_recovery_core(text) FROM %I', role_name);
  END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  DELETE FROM public.recovery_action_revision WHERE athlete_id=$1;
  DELETE FROM public.recovery_action_log WHERE athlete_id=$1;
  DELETE FROM public.recovery_strategy_head WHERE athlete_id=$1;
  DELETE FROM public.recovery_strategy_version WHERE athlete_id=$1;
  DELETE FROM public.recovery_method_head WHERE athlete_id=$1;
  DELETE FROM public.recovery_method_version WHERE athlete_id=$1;
  RETURN public.erase_account_before_recovery_core($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
