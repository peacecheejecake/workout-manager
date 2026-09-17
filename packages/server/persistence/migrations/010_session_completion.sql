CREATE TABLE session_completion (
 athlete_id text NOT NULL, session_id text NOT NULL CHECK(length(session_id) BETWEEN 1 AND 200),
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646), record_json jsonb NOT NULL,
 PRIMARY KEY(athlete_id,session_id),
 CHECK(jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=16384),
 CHECK((record_json->>'sessionId'=session_id AND record_json->>'revision'=revision::text) IS TRUE)
);
CREATE TABLE session_completion_revision (
 athlete_id text NOT NULL, session_id text NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646), record_json jsonb NOT NULL,
 PRIMARY KEY(athlete_id,session_id,revision),
 FOREIGN KEY(athlete_id,session_id) REFERENCES session_completion(athlete_id,session_id),
 CHECK(jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=16384),
 CHECK((record_json->>'sessionId'=session_id AND record_json->>'revision'=revision::text) IS TRUE)
);
CREATE TABLE session_completion_receipt (
 athlete_id text NOT NULL, idempotency_key text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL,
 PRIMARY KEY(athlete_id,idempotency_key)
);
CREATE TABLE session_completion_collection_head (
 athlete_id text PRIMARY KEY, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['session_completion','session_completion_revision','session_completion_receipt','session_completion_collection_head'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'',true),''''))',t);
 END LOOP;
END $$;
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_session_completion;
REVOKE ALL ON FUNCTION public.erase_account_before_session_completion(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.erase_account_before_session_completion(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_session_completion(text) FROM %I',role_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 DELETE FROM public.session_completion_revision WHERE athlete_id=$1;
 DELETE FROM public.session_completion_receipt WHERE athlete_id=$1;
 DELETE FROM public.session_completion WHERE athlete_id=$1;
 DELETE FROM public.session_completion_collection_head WHERE athlete_id=$1;
 RETURN public.erase_account_before_session_completion($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
