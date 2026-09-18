-- Nutrition schedules, food definitions and actual intake are separate ledgers.
-- A plan item is never an IntakeEntry; only an explicit intake command writes an actual.
CREATE TABLE nutrition_plan_version (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  plan_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  previous_version_id uuid,
  previous_version integer,
  period_from date NOT NULL,
  period_to date NOT NULL,
  linked_training_plan_version_id uuid,
  approval_id uuid NOT NULL,
  approved_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (
    jsonb_typeof(record_json) = 'object' AND octet_length(record_json::text) <= 1048576
  ),
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, plan_id, version),
  UNIQUE (athlete_id, plan_id, version, version_id),
  UNIQUE (athlete_id, plan_id, version_id, approval_id),
  UNIQUE (athlete_id, approval_id),
  FOREIGN KEY (athlete_id, plan_id, previous_version, previous_version_id)
    REFERENCES nutrition_plan_version (athlete_id, plan_id, version, version_id),
  FOREIGN KEY (athlete_id, linked_training_plan_version_id)
    REFERENCES plan_snapshot (athlete_id, id),
  CHECK (period_from <= period_to AND period_to - period_from <= 3660),
  CHECK (
    (version = 1 AND previous_version IS NULL AND previous_version_id IS NULL) OR
    (version > 1 AND previous_version = version - 1 AND previous_version_id IS NOT NULL)
  ),
  CHECK ((record_json->>'planId' = plan_id::text
    AND record_json->>'versionId' = version_id::text
    AND record_json->>'version' = version::text
    AND record_json->>'approvalId' = approval_id::text
    AND record_json->'period'->>'from' = period_from::text
    AND record_json->'period'->>'toInclusive' = period_to::text
    AND (record_json->>'previousVersionId') IS NOT DISTINCT FROM previous_version_id::text
    AND (record_json->>'linkedTrainingPlanVersionId') IS NOT DISTINCT FROM
      linked_training_plan_version_id::text) IS TRUE)
);
CREATE INDEX nutrition_plan_period ON nutrition_plan_version
  (athlete_id, period_from, period_to, plan_id, version DESC);

CREATE TABLE nutrition_plan_head (
  athlete_id text NOT NULL,
  plan_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  version_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, plan_id),
  FOREIGN KEY (athlete_id, plan_id, version, version_id)
    REFERENCES nutrition_plan_version (athlete_id, plan_id, version, version_id)
);

CREATE TABLE nutrition_plan_history (
  athlete_id text NOT NULL,
  plan_id uuid NOT NULL,
  version_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('user_approved', 'candidate_approved')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, approval_id),
  FOREIGN KEY (athlete_id, plan_id, version_id, approval_id)
    REFERENCES nutrition_plan_version (athlete_id, plan_id, version_id, approval_id)
);

CREATE TABLE food_definition_version (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  food_id text NOT NULL CHECK (length(food_id) BETWEEN 1 AND 128),
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  previous_version_id uuid,
  previous_version integer,
  created_at timestamptz NOT NULL,
  record_json jsonb NOT NULL CHECK (
    jsonb_typeof(record_json) = 'object' AND octet_length(record_json::text) <= 65536
  ),
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, food_id, version),
  UNIQUE (athlete_id, food_id, version, version_id),
  FOREIGN KEY (athlete_id, food_id, previous_version, previous_version_id)
    REFERENCES food_definition_version (athlete_id, food_id, version, version_id),
  CHECK (
    (version = 1 AND previous_version IS NULL AND previous_version_id IS NULL) OR
    (version > 1 AND previous_version = version - 1 AND previous_version_id IS NOT NULL)
  ),
  CHECK ((record_json->>'foodId' = food_id::text
    AND record_json->>'versionId' = version_id::text
    AND record_json->>'version' = version::text
    AND (record_json->>'previousVersionId') IS NOT DISTINCT FROM previous_version_id::text) IS TRUE)
);

CREATE TABLE food_definition_head (
  athlete_id text NOT NULL,
  food_id text NOT NULL CHECK (length(food_id) BETWEEN 1 AND 128),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  version_id uuid NOT NULL,
  PRIMARY KEY (athlete_id, food_id),
  FOREIGN KEY (athlete_id, food_id, version, version_id)
    REFERENCES food_definition_version (athlete_id, food_id, version, version_id)
);

-- The current revision is a pointer, not another actual. Queries and aggregates must
-- join this head and include only status='active', so correction cannot double-count.
CREATE TABLE intake_entry (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  current_revision integer NOT NULL CHECK (current_revision BETWEEN 1 AND 2147483646),
  current_revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted')),
  PRIMARY KEY (athlete_id, id)
);

CREATE TABLE intake_entry_revision (
  athlete_id text NOT NULL,
  intake_id text NOT NULL CHECK (length(intake_id) BETWEEN 1 AND 128),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted')),
  occurred_at timestamptz,
  recorded_at timestamptz NOT NULL,
  deleted_at timestamptz,
  deletion_reason text,
  record_json jsonb,
  PRIMARY KEY (athlete_id, intake_id, revision),
  UNIQUE (athlete_id, revision_id),
  UNIQUE (athlete_id, intake_id, revision, revision_id, status),
  FOREIGN KEY (athlete_id, intake_id) REFERENCES intake_entry (athlete_id, id),
  CHECK (
    (status = 'active' AND occurred_at IS NOT NULL AND deleted_at IS NULL
      AND deletion_reason IS NULL AND record_json IS NOT NULL
      AND jsonb_typeof(record_json) = 'object'
      AND octet_length(record_json::text) <= 65536
      AND (record_json->>'intakeId' = intake_id::text
        AND record_json->>'revisionId' = revision_id::text
        AND record_json->>'revision' = revision::text
        AND record_json->>'status' = 'active'
        AND (record_json->>'occurredAt')::timestamptz = occurred_at
        AND (record_json->>'recordedAt')::timestamptz = recorded_at) IS TRUE)
    OR
    (status = 'deleted' AND occurred_at IS NULL AND deleted_at IS NOT NULL
      AND deletion_reason = 'user_requested' AND record_json IS NULL)
  )
);

-- Inserting a head and its first revision, or advancing to a new revision, is one
-- transaction. The deferred FK permits either insert order within that transaction.
ALTER TABLE intake_entry ADD CONSTRAINT intake_entry_current_revision_fk
  FOREIGN KEY (athlete_id, id, current_revision, current_revision_id, status)
  REFERENCES intake_entry_revision (athlete_id, intake_id, revision, revision_id, status)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX intake_entry_revision_time ON intake_entry_revision
  (athlete_id, occurred_at, intake_id, revision) WHERE status = 'active';

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'nutrition_plan_version', 'nutrition_plan_head', 'nutrition_plan_history',
    'food_definition_version', 'food_definition_head',
    'intake_entry', 'intake_entry_revision'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'', true), '''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'', true), ''''))',
      table_name
    );
  END LOOP;
END $$;

-- Only the migration-owner account erasure path may remove historical records.
CREATE FUNCTION reject_nutrition_record_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_NUTRITION_RECORD';
END $$;
REVOKE ALL ON FUNCTION reject_nutrition_record_mutation() FROM PUBLIC;
CREATE TRIGGER nutrition_plan_version_immutable BEFORE UPDATE OR DELETE ON nutrition_plan_version
  FOR EACH ROW EXECUTE FUNCTION reject_nutrition_record_mutation();
CREATE TRIGGER nutrition_plan_history_immutable BEFORE UPDATE OR DELETE ON nutrition_plan_history
  FOR EACH ROW EXECUTE FUNCTION reject_nutrition_record_mutation();
CREATE TRIGGER food_definition_version_immutable BEFORE UPDATE OR DELETE ON food_definition_version
  FOR EACH ROW EXECUTE FUNCTION reject_nutrition_record_mutation();
CREATE TRIGGER intake_entry_revision_immutable BEFORE UPDATE OR DELETE ON intake_entry_revision
  FOR EACH ROW EXECUTE FUNCTION reject_nutrition_record_mutation();

CREATE FUNCTION guard_nutrition_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_NUTRITION_HEAD';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR (to_jsonb(NEW) - 'version' - 'version_id') IS DISTINCT FROM
      (to_jsonb(OLD) - 'version' - 'version_id')
    OR NEW.version <> OLD.version + 1
  THEN RAISE EXCEPTION 'INVALID_NUTRITION_HEAD_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_nutrition_head() FROM PUBLIC;
CREATE TRIGGER nutrition_plan_head_guard BEFORE UPDATE OR DELETE ON nutrition_plan_head
  FOR EACH ROW EXECUTE FUNCTION guard_nutrition_head();
CREATE TRIGGER food_definition_head_guard BEFORE UPDATE OR DELETE ON food_definition_head
  FOR EACH ROW EXECUTE FUNCTION guard_nutrition_head();

CREATE FUNCTION guard_intake_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
      AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_INTAKE_IDENTITY';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.id IS DISTINCT FROM OLD.id
    OR OLD.status = 'deleted' OR NEW.current_revision <> OLD.current_revision + 1
  THEN RAISE EXCEPTION 'INVALID_INTAKE_REVISION_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_intake_entry() FROM PUBLIC;
CREATE TRIGGER intake_entry_guard BEFORE UPDATE OR DELETE ON intake_entry
  FOR EACH ROW EXECUTE FUNCTION guard_intake_entry();

-- A deleted intake remains a tombstone in the user ledger. Account erasure removes
-- all revisions, including prior health payloads, before the older eraser runs.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_nutrition_core;
REVOKE ALL ON FUNCTION public.erase_account_before_nutrition_core(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN
    SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.erase_account_before_nutrition_core(text)'::regprocedure
      AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.erase_account_before_nutrition_core(text) FROM %I',
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
  DELETE FROM public.intake_entry_revision WHERE athlete_id = $1;
  DELETE FROM public.intake_entry WHERE athlete_id = $1;
  DELETE FROM public.food_definition_head WHERE athlete_id = $1;
  DELETE FROM public.food_definition_version WHERE athlete_id = $1;
  DELETE FROM public.nutrition_plan_history WHERE athlete_id = $1;
  DELETE FROM public.nutrition_plan_head WHERE athlete_id = $1;
  DELETE FROM public.nutrition_plan_version WHERE athlete_id = $1;
  RETURN public.erase_account_before_nutrition_core($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
