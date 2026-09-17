CREATE TABLE plan_scenario (
 athlete_id text NOT NULL, id uuid NOT NULL,
 base_plan_version_id uuid NOT NULL, label text NOT NULL CHECK(label IN ('A','B','C')),
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object' AND octet_length(draft::text)<=1048576),
 PRIMARY KEY(athlete_id,id), UNIQUE(athlete_id,base_plan_version_id,label),
 FOREIGN KEY(athlete_id,base_plan_version_id) REFERENCES plan_snapshot(athlete_id,id)
);
CREATE TABLE plan_scenario_revision (
 athlete_id text NOT NULL, scenario_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 record_json jsonb NOT NULL CHECK(jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=1048576),
 PRIMARY KEY(athlete_id,scenario_id,revision),
 FOREIGN KEY(athlete_id,scenario_id) REFERENCES plan_scenario(athlete_id,id),
 CHECK((record_json->>'id'=scenario_id::text AND record_json->>'revision'=revision::text) IS TRUE)
);
CREATE TABLE plan_scenario_application (
 athlete_id text NOT NULL, version_id uuid NOT NULL,
 scenario_id uuid NOT NULL, scenario_revision integer NOT NULL,
 previous_version_id uuid NOT NULL,
 completion_revision integer NOT NULL CHECK(completion_revision BETWEEN 0 AND 2147483646),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,version_id),
 FOREIGN KEY(athlete_id,version_id) REFERENCES plan_snapshot(athlete_id,id),
 FOREIGN KEY(athlete_id,previous_version_id) REFERENCES plan_snapshot(athlete_id,id),
 FOREIGN KEY(athlete_id,scenario_id,scenario_revision) REFERENCES plan_scenario_revision(athlete_id,scenario_id,revision)
);
ALTER TABLE plan_history DROP CONSTRAINT plan_history_action_check;
ALTER TABLE plan_history ADD CONSTRAINT plan_history_action_check CHECK(action IN ('manual_saved','scenario_applied'));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['plan_scenario','plan_scenario_revision','plan_scenario_application'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'',true),''''))',t);
 END LOOP;
END $$;
CREATE TRIGGER plan_scenario_revision_immutable BEFORE UPDATE OR DELETE ON plan_scenario_revision
 FOR EACH ROW EXECUTE FUNCTION reject_plan_mutation();
CREATE TRIGGER plan_scenario_application_immutable BEFORE UPDATE OR DELETE ON plan_scenario_application
 FOR EACH ROW EXECUTE FUNCTION reject_plan_mutation();
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_plan_scenarios;
REVOKE ALL ON FUNCTION public.erase_account_before_plan_scenarios(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.erase_account_before_plan_scenarios(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_plan_scenarios(text) FROM %I',role_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 DELETE FROM public.plan_scenario_application WHERE athlete_id=$1;
 DELETE FROM public.plan_scenario_revision WHERE athlete_id=$1;
 DELETE FROM public.plan_scenario WHERE athlete_id=$1;
 RETURN public.erase_account_before_plan_scenarios($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
