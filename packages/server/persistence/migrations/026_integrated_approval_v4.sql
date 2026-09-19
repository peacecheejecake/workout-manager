-- Schema v4 approvals track every read dependency and every committed plan version.
ALTER TABLE plan_head ADD COLUMN aggregate_id uuid;
UPDATE plan_head SET aggregate_id = version_id;
ALTER TABLE plan_head ALTER COLUMN aggregate_id SET DEFAULT gen_random_uuid();
ALTER TABLE plan_head ALTER COLUMN aggregate_id SET NOT NULL;
ALTER TABLE plan_head ADD CONSTRAINT plan_head_aggregate_unique UNIQUE (athlete_id, aggregate_id);

ALTER TABLE integrated_dependency_head
  ADD COLUMN routine_run_revision integer NOT NULL DEFAULT 0 CHECK (routine_run_revision >= 0),
  ADD COLUMN routine_occurrence_revision integer NOT NULL DEFAULT 0 CHECK (routine_occurrence_revision >= 0),
  ADD COLUMN routine_blueprint_revision integer NOT NULL DEFAULT 0 CHECK (routine_blueprint_revision >= 0),
  ADD COLUMN recovery_action_revision integer NOT NULL DEFAULT 0 CHECK (recovery_action_revision >= 0),
  ADD COLUMN recovery_method_revision integer NOT NULL DEFAULT 0 CHECK (recovery_method_revision >= 0);

CREATE FUNCTION bump_integrated_dependency_v4() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.athlete_id ELSE NEW.athlete_id END;
  INSERT INTO public.integrated_dependency_head AS h
    (athlete_id,routine_run_revision,routine_occurrence_revision,routine_blueprint_revision,
     recovery_action_revision,recovery_method_revision)
  VALUES (
    owner_id,
    CASE WHEN TG_TABLE_NAME = 'routine_run' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'routine_occurrence' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'routine_blueprint_head' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'recovery_action_log' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'recovery_method_head' THEN 1 ELSE 0 END)
  ON CONFLICT (athlete_id) DO UPDATE SET
    routine_run_revision = h.routine_run_revision + EXCLUDED.routine_run_revision,
    routine_occurrence_revision = h.routine_occurrence_revision + EXCLUDED.routine_occurrence_revision,
    routine_blueprint_revision = h.routine_blueprint_revision + EXCLUDED.routine_blueprint_revision,
    recovery_action_revision = h.recovery_action_revision + EXCLUDED.recovery_action_revision,
    recovery_method_revision = h.recovery_method_revision + EXCLUDED.recovery_method_revision;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION bump_integrated_dependency_v4() FROM PUBLIC;

CREATE TRIGGER integrated_v4_routine_run AFTER INSERT OR UPDATE OR DELETE ON routine_run
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_v4();
CREATE TRIGGER integrated_v4_routine_occurrence AFTER INSERT OR UPDATE OR DELETE ON routine_occurrence
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_v4();
CREATE TRIGGER integrated_v4_routine_blueprint AFTER INSERT OR UPDATE OR DELETE ON routine_blueprint_head
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_v4();
CREATE TRIGGER integrated_v4_recovery_action AFTER INSERT OR UPDATE OR DELETE ON recovery_action_log
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_v4();
CREATE TRIGGER integrated_v4_recovery_method AFTER INSERT OR UPDATE OR DELETE ON recovery_method_head
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_v4();

CREATE TABLE integrated_candidate_v4 (
  athlete_id text NOT NULL,
  id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,id),
  UNIQUE (athlete_id,proposal_id,id)
);
CREATE TABLE integrated_approval_v4 (
  athlete_id text NOT NULL,
  approval_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^[a-f0-9]{64}$'),
  write_domains jsonb NOT NULL,
  result_json jsonb NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (athlete_id, approval_id),
  UNIQUE (athlete_id, candidate_id),
  FOREIGN KEY (athlete_id, candidate_id) REFERENCES integrated_candidate_v4 (athlete_id, id)
);
CREATE TABLE recovery_strategy_history (
  athlete_id text NOT NULL,
  version_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  action text NOT NULL CHECK (action = 'candidate_approved'),
  PRIMARY KEY (athlete_id, version_id),
  FOREIGN KEY (athlete_id, version_id) REFERENCES recovery_strategy_version (athlete_id, version_id),
  FOREIGN KEY (athlete_id, approval_id) REFERENCES integrated_approval_v4 (athlete_id, approval_id)
);
CREATE TABLE routine_schedule_history (
  athlete_id text NOT NULL,
  version_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  action text NOT NULL CHECK (action = 'candidate_approved'),
  PRIMARY KEY (athlete_id, version_id),
  FOREIGN KEY (athlete_id, version_id) REFERENCES routine_schedule_version (athlete_id, version_id),
  FOREIGN KEY (athlete_id, approval_id) REFERENCES integrated_approval_v4 (athlete_id, approval_id)
);

CREATE FUNCTION integrated_approval_v4_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE'
    AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_INTEGRATED_APPROVAL_RECORD';
END $$;
REVOKE ALL ON FUNCTION integrated_approval_v4_immutable() FROM PUBLIC;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'integrated_candidate_v4','integrated_approval_v4','recovery_strategy_history','routine_schedule_history'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'',true),''''))',
      table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION integrated_approval_v4_immutable()',
      table_name, table_name);
  END LOOP;
END $$;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_integrated_approval_v4;
REVOKE ALL ON FUNCTION public.erase_account_before_integrated_approval_v4(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN
    SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_integrated_approval_v4(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.erase_account_before_integrated_approval_v4(text) FROM %I',
      role_name);
  END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result timestamptz;
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  DELETE FROM public.recovery_strategy_history WHERE athlete_id=$1;
  DELETE FROM public.routine_schedule_history WHERE athlete_id=$1;
  DELETE FROM public.integrated_approval_v4 WHERE athlete_id=$1;
  DELETE FROM public.integrated_candidate_v4 WHERE athlete_id=$1;
  result := public.erase_account_before_integrated_approval_v4($1);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
