CREATE TABLE coaching_thread (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 id uuid NOT NULL, plan_version_id uuid NOT NULL,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
 scope jsonb NOT NULL CHECK((jsonb_typeof(scope)='object'
   AND scope->>'kind' IN ('session','block','phase')
   AND jsonb_typeof(scope->'targetId')='string'
   AND length(btrim(scope->>'targetId')) BETWEEN 1 AND 200
   AND scope - 'kind' - 'targetId' = '{}'::jsonb) IS TRUE),
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,id),
 FOREIGN KEY(athlete_id,plan_version_id) REFERENCES plan_snapshot(athlete_id,id)
);
CREATE INDEX coaching_thread_page ON coaching_thread(athlete_id,created_at DESC,id);
CREATE TABLE coaching_message (
 athlete_id text NOT NULL, id uuid NOT NULL, thread_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 content text NOT NULL CHECK(length(content) BETWEEN 1 AND 8000 AND content ~ '[^[:space:]]'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,id), UNIQUE(athlete_id,thread_id,revision),
 FOREIGN KEY(athlete_id,thread_id) REFERENCES coaching_thread(athlete_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['coaching_thread','coaching_message'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'',true),''''))',t);
 END LOOP;
END $$;
CREATE TRIGGER coaching_message_immutable BEFORE UPDATE OR DELETE ON coaching_message
 FOR EACH ROW EXECUTE FUNCTION reject_plan_mutation();

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_coaching_threads;
REVOKE ALL ON FUNCTION public.erase_account_before_coaching_threads(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.erase_account_before_coaching_threads(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_coaching_threads(text) FROM %I',role_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 DELETE FROM public.coaching_message WHERE athlete_id=$1;
 DELETE FROM public.coaching_thread WHERE athlete_id=$1;
 RETURN public.erase_account_before_coaching_threads($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
