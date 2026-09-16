CREATE TABLE check_in (
 athlete_id text NOT NULL, id uuid NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 values_json jsonb, local_date date, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(athlete_id,id), CHECK((deleted AND values_json IS NULL AND local_date IS NULL) OR (NOT deleted AND values_json IS NOT NULL AND local_date IS NOT NULL))
);
CREATE INDEX check_in_local_date ON check_in(athlete_id,local_date,id) WHERE NOT deleted;
CREATE TABLE check_in_revision (
 athlete_id text NOT NULL, check_in_id uuid NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646), values_json jsonb NOT NULL, reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(athlete_id,check_in_id,revision),
 FOREIGN KEY(athlete_id,check_in_id) REFERENCES check_in(athlete_id,id)
);
CREATE TABLE check_in_receipt (
 athlete_id text NOT NULL,idempotency_key text NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),result jsonb NOT NULL,
 PRIMARY KEY(athlete_id,idempotency_key)
);
CREATE TABLE check_in_collection_head (
 athlete_id text PRIMARY KEY,revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['check_in','check_in_revision','check_in_receipt','check_in_collection_head'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (athlete_id = current_setting(''app.athlete_id'',true)) WITH CHECK (athlete_id = current_setting(''app.athlete_id'',true))',t);
 END LOOP;
END $$;
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_checkins;
REVOKE ALL ON FUNCTION public.erase_account_before_checkins(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.erase_account_before_checkins(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_checkins(text) FROM %I',role_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 DELETE FROM public.check_in_revision WHERE athlete_id=$1;
 DELETE FROM public.check_in_receipt WHERE athlete_id=$1;
 DELETE FROM public.check_in WHERE athlete_id=$1;
 DELETE FROM public.check_in_collection_head WHERE athlete_id=$1;
 RETURN public.erase_account_before_checkins($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
