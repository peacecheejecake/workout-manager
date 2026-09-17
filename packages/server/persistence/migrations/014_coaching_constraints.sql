CREATE TABLE coaching_constraint_head (
 athlete_id text PRIMARY KEY CHECK(length(athlete_id) BETWEEN 1 AND 200),
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE coaching_constraint (
 athlete_id text NOT NULL, id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 text text, confirmed_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 deleted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(athlete_id,id),
 FOREIGN KEY(athlete_id) REFERENCES coaching_constraint_head(athlete_id),
 CHECK (((deleted AND text IS NULL) OR (NOT deleted AND text IS NOT NULL AND length(text) BETWEEN 1 AND 2000 AND text ~ '[^[:space:]]')) IS TRUE)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['coaching_constraint_head','coaching_constraint'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (athlete_id = nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id = nullif(current_setting(''app.athlete_id'',true),''''))',t);
 END LOOP;
END $$;
CREATE FUNCTION guard_coaching_constraint() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_CONSTRAINT_IDENTITY';
 END IF;
 IF OLD.deleted OR NEW.id<>OLD.id OR NEW.athlete_id<>OLD.athlete_id OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'IMMUTABLE_CONSTRAINT_IDENTITY';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_coaching_constraint() FROM PUBLIC;
CREATE TRIGGER guard_coaching_constraint BEFORE UPDATE OR DELETE ON coaching_constraint FOR EACH ROW EXECUTE FUNCTION guard_coaching_constraint();

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_coaching_constraints;
REVOKE ALL ON FUNCTION public.erase_account_before_coaching_constraints(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.erase_account_before_coaching_constraints(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_coaching_constraints(text) FROM %I',role_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 DELETE FROM public.coaching_constraint WHERE athlete_id=$1;
 DELETE FROM public.coaching_constraint_head WHERE athlete_id=$1;
 RETURN public.erase_account_before_coaching_constraints($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
