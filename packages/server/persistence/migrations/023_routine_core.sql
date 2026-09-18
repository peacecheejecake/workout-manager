-- A generic routine composes frozen content references. The supplementary
-- workout template remains a separate aggregate and the run is never Activity.
CREATE TABLE routine_blueprint_version (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  routine_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  previous_version_id uuid,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'
    AND octet_length(record_json::text) <= 1048576),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, routine_id, version),
  UNIQUE (athlete_id, routine_id, version_id),
  FOREIGN KEY (athlete_id, previous_version_id)
    REFERENCES routine_blueprint_version (athlete_id, version_id),
  CHECK ((version = 1 AND previous_version_id IS NULL) OR
    (version > 1 AND previous_version_id IS NOT NULL)),
  CHECK ((record_json->>'schemaVersion' = '4'
    AND record_json->>'routineId' = routine_id::text
    AND record_json->>'versionId' = version_id::text) IS TRUE)
);
CREATE TABLE routine_blueprint_head (
  athlete_id text NOT NULL,
  routine_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  favorite boolean NOT NULL DEFAULT false,
  visibility text NOT NULL CHECK (visibility IN ('active','archived','deleted')),
  PRIMARY KEY (athlete_id, routine_id),
  FOREIGN KEY (athlete_id, routine_id, version_id)
    REFERENCES routine_blueprint_version (athlete_id, routine_id, version_id)
);

CREATE TABLE routine_schedule_version (
  athlete_id text NOT NULL,
  schedule_id uuid NOT NULL,
  version_id uuid NOT NULL,
  prior_version_id uuid,
  blueprint_routine_id uuid NOT NULL,
  blueprint_version_id uuid NOT NULL,
  source_plan_version_id uuid,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'
    AND octet_length(record_json::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, schedule_id, version_id),
  FOREIGN KEY (athlete_id, prior_version_id)
    REFERENCES routine_schedule_version (athlete_id, version_id),
  FOREIGN KEY (athlete_id, blueprint_routine_id, blueprint_version_id)
    REFERENCES routine_blueprint_version (athlete_id, routine_id, version_id),
  FOREIGN KEY (athlete_id, source_plan_version_id)
    REFERENCES plan_snapshot (athlete_id, id),
  CHECK ((record_json->>'schemaVersion' = '4'
    AND record_json->>'id' = schedule_id::text
    AND record_json->>'versionId' = version_id::text
    AND record_json->'blueprint'->>'id' = blueprint_routine_id::text
    AND record_json->'blueprint'->>'versionId' = blueprint_version_id::text) IS TRUE)
);
CREATE TABLE routine_schedule_head (
  athlete_id text NOT NULL,
  schedule_id uuid NOT NULL,
  version_id uuid NOT NULL,
  notification_muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (athlete_id, schedule_id),
  FOREIGN KEY (athlete_id, schedule_id, version_id)
    REFERENCES routine_schedule_version (athlete_id, schedule_id, version_id)
);
CREATE TABLE routine_occurrence (
  athlete_id text NOT NULL,
  id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  schedule_version_id uuid NOT NULL,
  blueprint_routine_id uuid NOT NULL,
  blueprint_version_id uuid NOT NULL,
  anchor_key text NOT NULL CHECK (length(anchor_key) BETWEEN 1 AND 200),
  scheduled_at timestamptz,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'
    AND octet_length(record_json::text) <= 65536),
  PRIMARY KEY (athlete_id, id),
  UNIQUE (athlete_id, schedule_id, anchor_key),
  FOREIGN KEY (athlete_id, schedule_id, schedule_version_id)
    REFERENCES routine_schedule_version (athlete_id, schedule_id, version_id),
  FOREIGN KEY (athlete_id, blueprint_routine_id, blueprint_version_id)
    REFERENCES routine_blueprint_version (athlete_id, routine_id, version_id),
  CHECK ((record_json->>'id' = id::text
    AND record_json->'schedule'->>'id' = schedule_id::text
    AND record_json->'schedule'->>'versionId' = schedule_version_id::text
    AND record_json->'blueprint'->>'id' = blueprint_routine_id::text
    AND record_json->'blueprint'->>'versionId' = blueprint_version_id::text) IS TRUE)
);
CREATE INDEX routine_occurrence_schedule ON routine_occurrence
  (athlete_id, schedule_id, scheduled_at, id);

CREATE TABLE routine_run (
  athlete_id text NOT NULL,
  id uuid NOT NULL,
  blueprint_routine_id uuid NOT NULL,
  blueprint_version_id uuid NOT NULL,
  occurrence_id uuid,
  revision integer NOT NULL CHECK (revision BETWEEN 0 AND 2147483646),
  state text NOT NULL CHECK (state IN ('in_progress','paused','ended','stopped')),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'
    AND octet_length(record_json::text) <= 1048576),
  PRIMARY KEY (athlete_id, id),
  UNIQUE (athlete_id, occurrence_id),
  FOREIGN KEY (athlete_id, blueprint_routine_id, blueprint_version_id)
    REFERENCES routine_blueprint_version (athlete_id, routine_id, version_id),
  FOREIGN KEY (athlete_id, occurrence_id)
    REFERENCES routine_occurrence (athlete_id, id),
  CHECK ((record_json->>'id' = id::text
    AND (record_json->>'revision')::integer = revision
    AND record_json->>'state' = state
    AND record_json->'blueprint'->>'id' = blueprint_routine_id::text
    AND record_json->'blueprint'->>'versionId' = blueprint_version_id::text) IS TRUE)
);
CREATE TABLE routine_run_revision (
  athlete_id text NOT NULL,
  run_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 0 AND 2147483646),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'
    AND octet_length(record_json::text) <= 1048576),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (athlete_id, run_id, revision),
  FOREIGN KEY (athlete_id, run_id) REFERENCES routine_run (athlete_id, id),
  CHECK ((record_json->>'id' = run_id::text
    AND (record_json->>'revision')::integer = revision) IS TRUE)
);
CREATE TABLE routine_checklist_confirmation (
  athlete_id text NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_id text NOT NULL CHECK (length(step_id) BETWEEN 1 AND 200),
  revision_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('performed','partial')),
  PRIMARY KEY (athlete_id, id),
  FOREIGN KEY (athlete_id, run_id) REFERENCES routine_run (athlete_id, id)
);
CREATE TABLE routine_step_timer (
  athlete_id text NOT NULL,
  run_id uuid NOT NULL,
  step_id text NOT NULL CHECK (length(step_id) BETWEEN 1 AND 200),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483646),
  state text NOT NULL CHECK (state IN ('running','paused','cleared')),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 86400),
  started_at timestamptz NOT NULL,
  paused_at timestamptz,
  paused_milliseconds bigint NOT NULL DEFAULT 0 CHECK (paused_milliseconds >= 0),
  PRIMARY KEY (athlete_id, run_id, step_id),
  FOREIGN KEY (athlete_id, run_id) REFERENCES routine_run (athlete_id, id),
  CHECK ((state = 'paused') = (paused_at IS NOT NULL))
);
CREATE TABLE routine_command_receipt (
  athlete_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_json jsonb NOT NULL CHECK (octet_length(result_json::text) <= 1048576),
  PRIMARY KEY (athlete_id, idempotency_key)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'routine_blueprint_version','routine_blueprint_head',
    'routine_schedule_version','routine_schedule_head','routine_occurrence',
    'routine_run','routine_run_revision','routine_checklist_confirmation',
    'routine_step_timer','routine_command_receipt'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'',true), '''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'',true), ''''))', t);
  END LOOP;
END $$;

CREATE FUNCTION routine_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user =
    (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_ROUTINE_RECORD';
END $$;
REVOKE ALL ON FUNCTION routine_immutable() FROM PUBLIC;
CREATE TRIGGER routine_blueprint_version_immutable BEFORE UPDATE OR DELETE ON routine_blueprint_version
  FOR EACH ROW EXECUTE FUNCTION routine_immutable();
CREATE TRIGGER routine_schedule_version_immutable BEFORE UPDATE OR DELETE ON routine_schedule_version
  FOR EACH ROW EXECUTE FUNCTION routine_immutable();
CREATE TRIGGER routine_occurrence_immutable BEFORE UPDATE OR DELETE ON routine_occurrence
  FOR EACH ROW EXECUTE FUNCTION routine_immutable();
CREATE TRIGGER routine_run_revision_immutable BEFORE UPDATE OR DELETE ON routine_run_revision
  FOR EACH ROW EXECUTE FUNCTION routine_immutable();
CREATE TRIGGER routine_checklist_immutable BEFORE UPDATE OR DELETE ON routine_checklist_confirmation
  FOR EACH ROW EXECUTE FUNCTION routine_immutable();

CREATE FUNCTION guard_routine_blueprint_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_ROUTINE_HEAD';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.routine_id IS DISTINCT FROM OLD.routine_id
    OR NEW.visibility = 'deleted'
  THEN RAISE EXCEPTION 'INVALID_ROUTINE_HEAD_ADVANCE'; END IF;
  IF NEW.version_id IS DISTINCT FROM OLD.version_id THEN
    IF NEW.version <> OLD.version+1 OR NEW.favorite IS DISTINCT FROM OLD.favorite
      OR NEW.visibility IS DISTINCT FROM OLD.visibility
      OR NOT EXISTS (
        SELECT 1 FROM public.routine_blueprint_version v
        WHERE v.athlete_id=NEW.athlete_id AND v.version_id=NEW.version_id
          AND v.previous_version_id=OLD.version_id
      )
    THEN RAISE EXCEPTION 'INVALID_ROUTINE_HEAD_ADVANCE'; END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'INVALID_ROUTINE_HEAD_ADVANCE';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_routine_blueprint_head() FROM PUBLIC;
CREATE TRIGGER routine_blueprint_head_guard BEFORE UPDATE OR DELETE ON routine_blueprint_head
  FOR EACH ROW EXECUTE FUNCTION guard_routine_blueprint_head();

CREATE FUNCTION guard_routine_schedule_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_ROUTINE_SCHEDULE_HEAD';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
  THEN RAISE EXCEPTION 'INVALID_ROUTINE_SCHEDULE_ADVANCE'; END IF;
  IF NEW.version_id IS DISTINCT FROM OLD.version_id
    AND (NEW.notification_muted IS DISTINCT FROM OLD.notification_muted OR NOT EXISTS (
      SELECT 1 FROM public.routine_schedule_version v
      WHERE v.athlete_id=NEW.athlete_id AND v.version_id=NEW.version_id
        AND v.prior_version_id=OLD.version_id
    ))
  THEN RAISE EXCEPTION 'INVALID_ROUTINE_SCHEDULE_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_routine_schedule_head() FROM PUBLIC;
CREATE TRIGGER routine_schedule_head_guard BEFORE UPDATE OR DELETE ON routine_schedule_head
  FOR EACH ROW EXECUTE FUNCTION guard_routine_schedule_head();

CREATE FUNCTION guard_routine_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_ROUTINE_RUN_IDENTITY';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.blueprint_routine_id IS DISTINCT FROM OLD.blueprint_routine_id
    OR NEW.blueprint_version_id IS DISTINCT FROM OLD.blueprint_version_id
    OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
    OR NEW.revision <> OLD.revision+1
    OR OLD.state IN ('ended','stopped')
  THEN RAISE EXCEPTION 'INVALID_ROUTINE_RUN_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_routine_run() FROM PUBLIC;
CREATE TRIGGER routine_run_guard BEFORE UPDATE OR DELETE ON routine_run
  FOR EACH ROW EXECUTE FUNCTION guard_routine_run();

CREATE FUNCTION guard_routine_timer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_ROUTINE_TIMER_IDENTITY';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.step_id IS DISTINCT FROM OLD.step_id
    OR NEW.revision <> OLD.revision+1
  THEN RAISE EXCEPTION 'INVALID_ROUTINE_TIMER_ADVANCE'; END IF;
  IF OLD.state='cleared' THEN
    IF NEW.state<>'running' OR NEW.paused_at IS NOT NULL
      OR NEW.paused_milliseconds<>0
    THEN RAISE EXCEPTION 'INVALID_ROUTINE_TIMER_RESTART'; END IF;
  ELSIF NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
    OR NEW.paused_milliseconds < OLD.paused_milliseconds
  THEN RAISE EXCEPTION 'INVALID_ROUTINE_TIMER_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_routine_timer() FROM PUBLIC;
CREATE TRIGGER routine_timer_guard BEFORE UPDATE OR DELETE ON routine_step_timer
  FOR EACH ROW EXECUTE FUNCTION guard_routine_timer();

-- The eraser removes routine links before the prior wrappers erase Activity,
-- nutrition, plans and supplementary workout content.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_routine_core;
REVOKE ALL ON FUNCTION public.erase_account_before_routine_core(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN
    SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_routine_core(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_routine_core(text) FROM %I',role_name);
  END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  DELETE FROM public.routine_command_receipt WHERE athlete_id=$1;
  DELETE FROM public.routine_step_timer WHERE athlete_id=$1;
  DELETE FROM public.routine_checklist_confirmation WHERE athlete_id=$1;
  DELETE FROM public.routine_run_revision WHERE athlete_id=$1;
  DELETE FROM public.routine_run WHERE athlete_id=$1;
  DELETE FROM public.routine_occurrence WHERE athlete_id=$1;
  DELETE FROM public.routine_schedule_head WHERE athlete_id=$1;
  DELETE FROM public.routine_schedule_version WHERE athlete_id=$1;
  DELETE FROM public.routine_blueprint_head WHERE athlete_id=$1;
  DELETE FROM public.routine_blueprint_version WHERE athlete_id=$1;
  RETURN public.erase_account_before_routine_core($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
