-- Monotone collection heads let joint approvals reject an actual/catalog change,
-- including corrections, tombstones, and replacements with the same row count.
-- All participating writers take the athlete advisory lock before mutation.
CREATE TABLE integrated_dependency_head (
  athlete_id text PRIMARY KEY CHECK (length(athlete_id) BETWEEN 1 AND 200),
  intake_revision integer NOT NULL DEFAULT 0 CHECK (intake_revision >= 0),
  activity_revision integer NOT NULL DEFAULT 0 CHECK (activity_revision >= 0),
  execution_revision integer NOT NULL DEFAULT 0 CHECK (execution_revision >= 0),
  set_revision integer NOT NULL DEFAULT 0 CHECK (set_revision >= 0),
  food_revision integer NOT NULL DEFAULT 0 CHECK (food_revision >= 0),
  exercise_revision integer NOT NULL DEFAULT 0 CHECK (exercise_revision >= 0),
  routine_revision integer NOT NULL DEFAULT 0 CHECK (routine_revision >= 0)
);
ALTER TABLE integrated_dependency_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrated_dependency_head FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON integrated_dependency_head
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

CREATE FUNCTION bump_integrated_dependency_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id text;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.athlete_id ELSE NEW.athlete_id END;
  INSERT INTO public.integrated_dependency_head AS h
    (athlete_id, intake_revision, activity_revision, execution_revision, set_revision, food_revision, exercise_revision, routine_revision)
  VALUES (
    owner_id,
    CASE WHEN TG_TABLE_NAME = 'intake_entry' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'activity_canonical' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'supplementary_execution' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'supplementary_set_log' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'food_definition_head' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'supplementary_exercise_head' THEN 1 ELSE 0 END,
    CASE WHEN TG_TABLE_NAME = 'supplementary_routine_head' THEN 1 ELSE 0 END
  )
  ON CONFLICT (athlete_id) DO UPDATE SET
    intake_revision = h.intake_revision + EXCLUDED.intake_revision,
    activity_revision = h.activity_revision + EXCLUDED.activity_revision,
    execution_revision = h.execution_revision + EXCLUDED.execution_revision,
    set_revision = h.set_revision + EXCLUDED.set_revision,
    food_revision = h.food_revision + EXCLUDED.food_revision,
    exercise_revision = h.exercise_revision + EXCLUDED.exercise_revision,
    routine_revision = h.routine_revision + EXCLUDED.routine_revision;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION bump_integrated_dependency_head() FROM PUBLIC;
CREATE TRIGGER integrated_intake_head AFTER INSERT OR UPDATE OR DELETE ON intake_entry
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_head();
CREATE TRIGGER integrated_activity_head AFTER INSERT OR UPDATE OR DELETE ON activity_canonical
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_head();
CREATE TRIGGER integrated_execution_head AFTER INSERT OR UPDATE OR DELETE ON supplementary_execution
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_head();
CREATE TRIGGER integrated_set_head AFTER INSERT OR UPDATE OR DELETE ON supplementary_set_log
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_head();
CREATE TRIGGER integrated_food_head AFTER INSERT OR UPDATE OR DELETE ON food_definition_head
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_head();
CREATE TRIGGER integrated_exercise_head AFTER INSERT OR UPDATE OR DELETE ON supplementary_exercise_head
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_head();
CREATE TRIGGER integrated_routine_head AFTER INSERT OR UPDATE OR DELETE ON supplementary_routine_head
  FOR EACH ROW EXECUTE FUNCTION bump_integrated_dependency_head();

-- Erasure must remove the revision heads after prior wrappers delete their ledgers.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_integrated_heads;
REVOKE ALL ON FUNCTION public.erase_account_before_integrated_heads(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN
    SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.erase_account_before_integrated_heads(text)'::regprocedure
      AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.erase_account_before_integrated_heads(text) FROM %I',
      role_name
    );
  END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  result timestamptz;
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  result := public.erase_account_before_integrated_heads($1);
  DELETE FROM public.integrated_dependency_head WHERE athlete_id = $1;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
