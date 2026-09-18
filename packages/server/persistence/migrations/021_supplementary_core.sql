-- Supplementary prescriptions and set details extend the training ledger. They are
-- never another Activity: every execution resolves one existing canonical row.
CREATE TABLE supplementary_exercise_version (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  exercise_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  previous_version_id uuid,
  previous_version integer,
  created_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (
    jsonb_typeof(record_json) = 'object' AND octet_length(record_json::text) <= 65536
  ),
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, exercise_id, version),
  UNIQUE (athlete_id, exercise_id, version, version_id),
  FOREIGN KEY (athlete_id, exercise_id, previous_version, previous_version_id)
    REFERENCES supplementary_exercise_version (athlete_id, exercise_id, version, version_id),
  CHECK (
    (version = 1 AND previous_version IS NULL AND previous_version_id IS NULL) OR
    (version > 1 AND previous_version = version - 1 AND previous_version_id IS NOT NULL)
  ),
  CHECK ((record_json->>'schemaVersion' = '2'
    AND record_json->>'exerciseId' = exercise_id::text
    AND record_json->>'versionId' = version_id::text) IS TRUE)
);
CREATE TABLE supplementary_exercise_head (
  athlete_id text NOT NULL,
  exercise_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  version_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, exercise_id),
  FOREIGN KEY (athlete_id, exercise_id, version, version_id)
    REFERENCES supplementary_exercise_version (athlete_id, exercise_id, version, version_id)
);

CREATE TABLE supplementary_routine_version (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  routine_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  previous_version_id uuid,
  previous_version integer,
  created_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (
    jsonb_typeof(record_json) = 'object' AND octet_length(record_json::text) <= 1048576
  ),
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, routine_id, version),
  UNIQUE (athlete_id, routine_id, version, version_id),
  FOREIGN KEY (athlete_id, routine_id, previous_version, previous_version_id)
    REFERENCES supplementary_routine_version (athlete_id, routine_id, version, version_id),
  CHECK (
    (version = 1 AND previous_version IS NULL AND previous_version_id IS NULL) OR
    (version > 1 AND previous_version = version - 1 AND previous_version_id IS NOT NULL)
  ),
  CHECK ((record_json->>'schemaVersion' = '2'
    AND record_json->>'routineId' = routine_id::text
    AND record_json->>'versionId' = version_id::text
    AND record_json->'spec'->>'routineVersionId' = version_id::text
    AND jsonb_typeof(record_json->'spec'->'blocks') = 'array') IS TRUE)
);
CREATE TABLE supplementary_routine_head (
  athlete_id text NOT NULL,
  routine_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  version_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, routine_id),
  FOREIGN KEY (athlete_id, routine_id, version, version_id)
    REFERENCES supplementary_routine_version (athlete_id, routine_id, version, version_id)
);

-- Generated from frozen routine content by the insert trigger below. The FK
-- prevents a routine from referring to another tenant's or missing exercise.
CREATE TABLE supplementary_routine_target_ref (
  athlete_id text NOT NULL,
  routine_version_id uuid NOT NULL,
  block_id text NOT NULL CHECK (length(block_id) BETWEEN 1 AND 200),
  target_set_id text NOT NULL CHECK (length(target_set_id) BETWEEN 1 AND 200),
  exercise_version_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, routine_version_id, target_set_id),
  FOREIGN KEY (athlete_id, routine_version_id)
    REFERENCES supplementary_routine_version (athlete_id, version_id),
  FOREIGN KEY (athlete_id, exercise_version_id)
    REFERENCES supplementary_exercise_version (athlete_id, version_id)
);
CREATE FUNCTION populate_supplementary_routine_targets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '') THEN
    RAISE EXCEPTION 'SUPPLEMENTARY_TENANT_MISMATCH';
  END IF;
  IF jsonb_array_length(NEW.record_json->'spec'->'blocks') NOT BETWEEN 1 AND 30
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.record_json->'spec'->'blocks') AS blocks(block_json)
      WHERE jsonb_typeof(block_json->'sets') IS DISTINCT FROM 'array'
        OR jsonb_array_length(block_json->'sets') NOT BETWEEN 1 AND 30
    )
  THEN RAISE EXCEPTION 'INVALID_SUPPLEMENTARY_ROUTINE_TARGETS'; END IF;
  INSERT INTO public.supplementary_routine_target_ref
    (athlete_id, routine_version_id, block_id, target_set_id, exercise_version_id)
  SELECT NEW.athlete_id, NEW.version_id, block_json->>'id', target_json->>'id',
    (target_json->>'exerciseVersionId')::uuid
  FROM jsonb_array_elements(NEW.record_json->'spec'->'blocks') AS blocks(block_json)
  CROSS JOIN LATERAL jsonb_array_elements(block_json->'sets') AS targets(target_json);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION populate_supplementary_routine_targets() FROM PUBLIC;
CREATE TRIGGER supplementary_routine_targets AFTER INSERT ON supplementary_routine_version
  FOR EACH ROW EXECUTE FUNCTION populate_supplementary_routine_targets();

-- A separate link keeps the current endurance PlannedSession schema unchanged.
-- plan_snapshot is immutable; the link never follows a newer plan/template head.
CREATE TABLE supplementary_session_link (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  plan_version_id uuid NOT NULL,
  planned_session_id text NOT NULL CHECK (length(planned_session_id) BETWEEN 1 AND 200),
  content_kind text NOT NULL CHECK (content_kind IN ('routine_version', 'embedded')),
  routine_version_id uuid,
  embedded_spec_json jsonb,
  PRIMARY KEY (athlete_id, plan_version_id, planned_session_id),
  FOREIGN KEY (athlete_id, plan_version_id)
    REFERENCES plan_snapshot (athlete_id, id),
  FOREIGN KEY (athlete_id, routine_version_id)
    REFERENCES supplementary_routine_version (athlete_id, version_id),
  CHECK (
    (content_kind = 'routine_version' AND routine_version_id IS NOT NULL
      AND embedded_spec_json IS NULL) OR
    (content_kind = 'embedded' AND routine_version_id IS NULL
      AND embedded_spec_json IS NOT NULL
      AND jsonb_typeof(embedded_spec_json) = 'object'
      AND octet_length(embedded_spec_json::text) <= 1048576
      AND (embedded_spec_json->>'schemaVersion' = '2'
        AND embedded_spec_json->>'kind' = 'supplementary'
        AND embedded_spec_json->'routineVersionId' = 'null'::jsonb
        AND jsonb_typeof(embedded_spec_json->'blocks') = 'array') IS TRUE)
  )
);
CREATE TABLE supplementary_session_target_ref (
  athlete_id text NOT NULL,
  plan_version_id uuid NOT NULL,
  planned_session_id text NOT NULL,
  block_id text NOT NULL CHECK (length(block_id) BETWEEN 1 AND 200),
  target_set_id text NOT NULL CHECK (length(target_set_id) BETWEEN 1 AND 200),
  exercise_version_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, plan_version_id, planned_session_id, target_set_id),
  FOREIGN KEY (athlete_id, plan_version_id, planned_session_id)
    REFERENCES supplementary_session_link (athlete_id, plan_version_id, planned_session_id),
  FOREIGN KEY (athlete_id, exercise_version_id)
    REFERENCES supplementary_exercise_version (athlete_id, version_id)
);
CREATE FUNCTION validate_supplementary_session_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '') THEN
    RAISE EXCEPTION 'SUPPLEMENTARY_TENANT_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.plan_snapshot p
    CROSS JOIN LATERAL jsonb_array_elements(p.draft->'sessions') AS sessions(session_json)
    WHERE p.athlete_id = NEW.athlete_id AND p.id = NEW.plan_version_id
      AND session_json->>'id' = NEW.planned_session_id AND session_json->>'sport' = 'strength'
  ) THEN RAISE EXCEPTION 'SUPPLEMENTARY_SESSION_NOT_IN_PLAN'; END IF;
  IF NEW.content_kind = 'embedded' THEN
    IF jsonb_array_length(NEW.embedded_spec_json->'blocks') NOT BETWEEN 1 AND 30
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.embedded_spec_json->'blocks') AS blocks(block_json)
        WHERE jsonb_typeof(block_json->'sets') IS DISTINCT FROM 'array'
          OR jsonb_array_length(block_json->'sets') NOT BETWEEN 1 AND 30
      )
    THEN RAISE EXCEPTION 'INVALID_SUPPLEMENTARY_SESSION_TARGETS'; END IF;
    INSERT INTO public.supplementary_session_target_ref
      (athlete_id, plan_version_id, planned_session_id, block_id, target_set_id, exercise_version_id)
    SELECT NEW.athlete_id, NEW.plan_version_id, NEW.planned_session_id,
      block_json->>'id', target_json->>'id', (target_json->>'exerciseVersionId')::uuid
    FROM jsonb_array_elements(NEW.embedded_spec_json->'blocks') AS blocks(block_json)
    CROSS JOIN LATERAL jsonb_array_elements(block_json->'sets') AS targets(target_json);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_supplementary_session_link() FROM PUBLIC;
CREATE TRIGGER supplementary_session_validate AFTER INSERT ON supplementary_session_link
  FOR EACH ROW EXECUTE FUNCTION validate_supplementary_session_link();

CREATE TABLE supplementary_execution (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id uuid NOT NULL,
  activity_id uuid NOT NULL,
  plan_version_id uuid,
  planned_session_id text,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483646),
  status text NOT NULL CHECK (status IN ('active', 'finished', 'stopped')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (athlete_id, id),
  UNIQUE (athlete_id, id, activity_id),
  UNIQUE (athlete_id, activity_id),
  FOREIGN KEY (athlete_id, activity_id)
    REFERENCES activity_canonical (athlete_id, id),
  FOREIGN KEY (athlete_id, plan_version_id, planned_session_id)
    REFERENCES supplementary_session_link (athlete_id, plan_version_id, planned_session_id),
  CHECK ((plan_version_id IS NULL) = (planned_session_id IS NULL)),
  CHECK (((status = 'active') = (ended_at IS NULL)) AND
    (ended_at IS NULL OR ended_at >= started_at))
);
CREATE INDEX supplementary_execution_session ON supplementary_execution
  (athlete_id, plan_version_id, planned_session_id, started_at DESC, id);
CREATE FUNCTION validate_supplementary_execution_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '') THEN
    RAISE EXCEPTION 'SUPPLEMENTARY_TENANT_MISMATCH';
  END IF;
  -- Lock the canonical row so a concurrent local deletion either wins first or
  -- follows this insert and purges its details in the same deletion transaction.
  PERFORM 1 FROM public.activity_canonical
    WHERE athlete_id = NEW.athlete_id AND id = NEW.activity_id AND NOT deleted FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUPPLEMENTARY_ACTIVITY_UNAVAILABLE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_supplementary_execution_activity() FROM PUBLIC;
CREATE TRIGGER supplementary_execution_activity BEFORE INSERT ON supplementary_execution
  FOR EACH ROW EXECUTE FUNCTION validate_supplementary_execution_activity();

-- The head is an identity and current pointer, not another completed set.
-- Aggregates join the pointed-to revision and only count confirmed states.
CREATE TABLE supplementary_set_log (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id uuid NOT NULL,
  execution_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision BETWEEN 1 AND 2147483646),
  current_revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted')),
  PRIMARY KEY (athlete_id, id),
  UNIQUE (athlete_id, id, execution_id, activity_id),
  FOREIGN KEY (athlete_id, execution_id, activity_id)
    REFERENCES supplementary_execution (athlete_id, id, activity_id)
);
CREATE INDEX supplementary_set_log_execution ON supplementary_set_log
  (athlete_id, execution_id, id) WHERE status = 'active';
CREATE TABLE supplementary_set_log_revision (
  athlete_id text NOT NULL,
  log_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted')),
  state text CHECK (state IN ('unconfirmed', 'performed', 'partial', 'confirmed_skipped', 'stopped')),
  occurred_at timestamptz,
  recorded_at timestamptz NOT NULL,
  deleted_at timestamptz,
  deletion_reason text CHECK (deletion_reason IS NULL OR length(deletion_reason) BETWEEN 1 AND 500),
  record_json jsonb,
  PRIMARY KEY (athlete_id, log_id, revision),
  UNIQUE (athlete_id, revision_id),
  UNIQUE (athlete_id, log_id, revision, revision_id, status),
  FOREIGN KEY (athlete_id, log_id, execution_id, activity_id)
    REFERENCES supplementary_set_log (athlete_id, id, execution_id, activity_id),
  CHECK (
    (status = 'active' AND state IS NOT NULL AND occurred_at IS NOT NULL
      AND occurred_at <= recorded_at AND deleted_at IS NULL AND deletion_reason IS NULL
      AND record_json IS NOT NULL AND jsonb_typeof(record_json) = 'object'
      AND octet_length(record_json::text) <= 65536
      AND (record_json->>'logId' = log_id::text
        AND record_json->>'executionId' = execution_id::text
        AND record_json->>'activityId' = activity_id::text
        AND record_json->>'revisionId' = revision_id::text
        AND record_json->>'revision' = revision::text
        AND record_json->>'state' = state) IS TRUE)
    OR
    (status = 'deleted' AND state IS NULL AND occurred_at IS NULL
      AND deleted_at = recorded_at AND deletion_reason IS NOT NULL AND record_json IS NULL)
  )
);
ALTER TABLE supplementary_set_log ADD CONSTRAINT supplementary_set_log_current_revision_fk
  FOREIGN KEY (athlete_id, id, current_revision, current_revision_id, status)
  REFERENCES supplementary_set_log_revision (athlete_id, log_id, revision, revision_id, status)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX supplementary_set_log_revision_time ON supplementary_set_log_revision
  (athlete_id, occurred_at, log_id, revision) WHERE status = 'active';

-- Presentation-only rest timing is independent of the actual set ledger.
CREATE TABLE supplementary_rest_timer (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id uuid NOT NULL,
  execution_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483646),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 86400),
  status text NOT NULL CHECK (status IN ('running', 'paused', 'finished')),
  started_at timestamptz NOT NULL,
  deadline_at timestamptz,
  paused_at timestamptz,
  remaining_when_paused_seconds integer CHECK (
    remaining_when_paused_seconds IS NULL OR remaining_when_paused_seconds BETWEEN 0 AND 86400
  ),
  PRIMARY KEY (athlete_id, id),
  FOREIGN KEY (athlete_id, execution_id)
    REFERENCES supplementary_execution (athlete_id, id),
  CHECK (
    (status = 'running' AND deadline_at IS NOT NULL AND deadline_at > started_at
      AND paused_at IS NULL AND remaining_when_paused_seconds IS NULL) OR
    (status = 'paused' AND deadline_at IS NULL AND paused_at IS NOT NULL
      AND paused_at >= started_at
      AND remaining_when_paused_seconds IS NOT NULL
      AND remaining_when_paused_seconds <= duration_seconds) OR
    (status = 'finished' AND paused_at IS NULL AND remaining_when_paused_seconds IS NULL)
  )
);
CREATE INDEX supplementary_rest_timer_execution ON supplementary_rest_timer
  (athlete_id, execution_id, id);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'supplementary_exercise_version', 'supplementary_exercise_head',
    'supplementary_routine_version', 'supplementary_routine_head',
    'supplementary_routine_target_ref', 'supplementary_session_link',
    'supplementary_session_target_ref', 'supplementary_execution',
    'supplementary_set_log', 'supplementary_set_log_revision',
    'supplementary_rest_timer'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'', true), '''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'', true), ''''))',
      table_name
    );
  END LOOP;
END $$;

-- Immutable versions, frozen links, target manifests and historical revisions
-- can only be removed by the migration-owner account/activity erasure path.
CREATE FUNCTION reject_supplementary_record_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_SUPPLEMENTARY_RECORD';
END $$;
REVOKE ALL ON FUNCTION reject_supplementary_record_mutation() FROM PUBLIC;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'supplementary_exercise_version', 'supplementary_routine_version',
    'supplementary_routine_target_ref', 'supplementary_session_link',
    'supplementary_session_target_ref', 'supplementary_set_log_revision'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_supplementary_record_mutation()',
      table_name || '_immutable', table_name);
  END LOOP;
END $$;

CREATE FUNCTION guard_supplementary_version_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_SUPPLEMENTARY_HEAD';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR (to_jsonb(NEW) - 'version' - 'version_id') IS DISTINCT FROM
      (to_jsonb(OLD) - 'version' - 'version_id')
    OR NEW.version <> OLD.version + 1
  THEN RAISE EXCEPTION 'INVALID_SUPPLEMENTARY_HEAD_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_supplementary_version_head() FROM PUBLIC;
CREATE TRIGGER supplementary_exercise_head_guard BEFORE UPDATE OR DELETE ON supplementary_exercise_head
  FOR EACH ROW EXECUTE FUNCTION guard_supplementary_version_head();
CREATE TRIGGER supplementary_routine_head_guard BEFORE UPDATE OR DELETE ON supplementary_routine_head
  FOR EACH ROW EXECUTE FUNCTION guard_supplementary_version_head();

CREATE FUNCTION guard_supplementary_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_SUPPLEMENTARY_EXECUTION_IDENTITY';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
    OR NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id
    OR NEW.planned_session_id IS DISTINCT FROM OLD.planned_session_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.revision <> OLD.revision + 1
    OR (OLD.status <> 'active' AND NEW.status <> OLD.status)
    OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at)
  THEN RAISE EXCEPTION 'INVALID_SUPPLEMENTARY_EXECUTION_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_supplementary_execution() FROM PUBLIC;
CREATE TRIGGER supplementary_execution_guard BEFORE UPDATE OR DELETE ON supplementary_execution
  FOR EACH ROW EXECUTE FUNCTION guard_supplementary_execution();

CREATE FUNCTION guard_supplementary_set_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_SUPPLEMENTARY_LOG_IDENTITY';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
    OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
    OR NEW.current_revision <> OLD.current_revision + 1
    OR OLD.status = 'deleted'
  THEN RAISE EXCEPTION 'INVALID_SUPPLEMENTARY_LOG_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_supplementary_set_log() FROM PUBLIC;
CREATE TRIGGER supplementary_set_log_guard BEFORE UPDATE OR DELETE ON supplementary_set_log
  FOR EACH ROW EXECUTE FUNCTION guard_supplementary_set_log();

CREATE FUNCTION guard_supplementary_timer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_SUPPLEMENTARY_TIMER_IDENTITY';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
    OR NEW.revision <> OLD.revision + 1 OR OLD.status = 'finished'
    OR (OLD.status = 'paused' AND NEW.status NOT IN ('running', 'finished'))
  THEN RAISE EXCEPTION 'INVALID_SUPPLEMENTARY_TIMER_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_supplementary_timer() FROM PUBLIC;
CREATE TRIGGER supplementary_rest_timer_guard BEFORE UPDATE OR DELETE ON supplementary_rest_timer
  FOR EACH ROW EXECUTE FUNCTION guard_supplementary_timer();

-- Local Activity deletion suppresses its supplementary detail immediately.
CREATE FUNCTION purge_supplementary_deleted_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '') THEN
    RAISE EXCEPTION 'SUPPLEMENTARY_TENANT_MISMATCH';
  END IF;
  IF NOT OLD.deleted AND NEW.deleted THEN
    -- Receipts contain the original command and response, including set values.
    -- Keep the key reserved while removing both private payloads so an old
    -- create command cannot recreate a deleted manual Activity on retry.
    UPDATE public.command_receipt r
      SET request = '{"purged":"activity_deleted"}'::jsonb,
          result = '{"purged":true}'::jsonb
      WHERE r.athlete_id = OLD.athlete_id
        AND r.idempotency_key LIKE 'supplementary-%'
        AND r.request->>'executionId' IN (
          SELECT id::text FROM public.supplementary_execution
          WHERE athlete_id = OLD.athlete_id AND activity_id = OLD.id
        );
    DELETE FROM public.supplementary_set_log_revision r
      USING public.supplementary_set_log l
      WHERE r.athlete_id = OLD.athlete_id AND l.athlete_id = r.athlete_id
        AND l.id = r.log_id AND l.activity_id = OLD.id;
    DELETE FROM public.supplementary_set_log
      WHERE athlete_id = OLD.athlete_id AND activity_id = OLD.id;
    DELETE FROM public.supplementary_rest_timer
      WHERE athlete_id = OLD.athlete_id AND execution_id IN (
        SELECT id FROM public.supplementary_execution
        WHERE athlete_id = OLD.athlete_id AND activity_id = OLD.id
      );
    DELETE FROM public.supplementary_execution
      WHERE athlete_id = OLD.athlete_id AND activity_id = OLD.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION purge_supplementary_deleted_activity() FROM PUBLIC;
CREATE TRIGGER purge_supplementary_on_activity_delete AFTER UPDATE OF deleted ON activity_canonical
  FOR EACH ROW EXECUTE FUNCTION purge_supplementary_deleted_activity();

-- Remove child details before the previous eraser deletes Activity and plan rows.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_supplementary_core;
REVOKE ALL ON FUNCTION public.erase_account_before_supplementary_core(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN
    SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.erase_account_before_supplementary_core(text)'::regprocedure
      AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.erase_account_before_supplementary_core(text) FROM %I',
      role_name
    );
  END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1, 77206));
  DELETE FROM public.supplementary_set_log_revision WHERE athlete_id = $1;
  DELETE FROM public.supplementary_set_log WHERE athlete_id = $1;
  DELETE FROM public.supplementary_rest_timer WHERE athlete_id = $1;
  DELETE FROM public.supplementary_execution WHERE athlete_id = $1;
  DELETE FROM public.supplementary_session_target_ref WHERE athlete_id = $1;
  DELETE FROM public.supplementary_session_link WHERE athlete_id = $1;
  DELETE FROM public.supplementary_routine_target_ref WHERE athlete_id = $1;
  DELETE FROM public.supplementary_routine_head WHERE athlete_id = $1;
  DELETE FROM public.supplementary_routine_version WHERE athlete_id = $1;
  DELETE FROM public.supplementary_exercise_head WHERE athlete_id = $1;
  DELETE FROM public.supplementary_exercise_version WHERE athlete_id = $1;
  RETURN public.erase_account_before_supplementary_core($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
