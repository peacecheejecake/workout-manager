CREATE TABLE tenant_erasure (
  athlete_id text PRIMARY KEY CHECK (length(athlete_id) BETWEEN 1 AND 200),
  erased_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE tenant_erasure ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_erasure FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_erasure_scope ON tenant_erasure
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
CREATE TABLE operations_audit (
  athlete_id text NOT NULL,
  id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('export_requested', 'account_erased')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (athlete_id, id)
);
ALTER TABLE operations_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_audit_scope ON operations_audit
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- Runtime DML still cannot mutate immutable versions. Only the migration-owner
-- SECURITY DEFINER erasure path can DELETE; UPDATE remains prohibited for all roles.
CREATE OR REPLACE FUNCTION reject_plan_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_PLAN_RECORD';
END;
$$;

CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE erased timestamptz;
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1, 77206));
  SELECT erased_at INTO erased FROM public.tenant_erasure WHERE athlete_id = $1;
  IF FOUND THEN RETURN erased; END IF;
  DELETE FROM public.activity_overlay_revision WHERE athlete_id = $1;
  DELETE FROM public.activity_overlay WHERE athlete_id = $1;
  DELETE FROM public.activity_suppression WHERE athlete_id = $1;
  DELETE FROM public.activity_source_revision WHERE athlete_id = $1;
  DELETE FROM public.activity_source_head WHERE athlete_id = $1;
  DELETE FROM public.activity_canonical WHERE athlete_id = $1;
  DELETE FROM public.activity_import_receipt WHERE athlete_id = $1;
  DELETE FROM public.plan_head WHERE athlete_id = $1;
  DELETE FROM public.plan_history WHERE athlete_id = $1;
  DELETE FROM public.plan_snapshot WHERE athlete_id = $1;
  DELETE FROM public.command_receipt WHERE athlete_id = $1;
  DELETE FROM public.outbox WHERE athlete_id = $1;
  DELETE FROM public.consent WHERE athlete_id = $1;
  DELETE FROM public.operations_audit WHERE athlete_id = $1;
  DELETE FROM identity_private.session WHERE athlete_id::text = $1;
  DELETE FROM identity_private.account WHERE athlete_id::text = $1;
  INSERT INTO public.tenant_erasure(athlete_id) VALUES ($1) RETURNING erased_at INTO erased;
  INSERT INTO public.operations_audit(athlete_id,id,action) VALUES ($1,gen_random_uuid(),'account_erased');
  RETURN erased;
END;
$$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;

-- Take the erasure gate before locking an existing identity row. The eraser takes
-- the same gate before deleting account/session rows, avoiding row/advisory inversion.
CREATE OR REPLACE FUNCTION public.auth_create_session(text, text, text, text, timestamptz, timestamptz, text)
RETURNS TABLE(athlete_id text, session_id text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE identity_id uuid; attempt integer; retired boolean; previous_tenant text := current_setting('app.athlete_id', true);
BEGIN
  IF $5 <= $6 OR $5 > $6 + interval '24 hours' THEN RAISE EXCEPTION 'INVALID_SESSION_EXPIRY'; END IF;
  FOR attempt IN 1..3 LOOP
    identity_id := NULL;
    SELECT account.athlete_id INTO identity_id FROM identity_private.account WHERE issuer=$3 AND subject=$4;
    IF identity_id IS NULL THEN
      INSERT INTO identity_private.account(issuer,subject) VALUES($3,$4)
      ON CONFLICT(issuer,subject) DO NOTHING RETURNING account.athlete_id INTO identity_id;
      IF identity_id IS NULL THEN CONTINUE; END IF;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(identity_id::text,77206));
    -- A deletion between lookup and lock acquisition must never restore the retired ID.
    PERFORM set_config('app.athlete_id',identity_id::text,true);
    SELECT EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=identity_id::text) INTO retired;
    PERFORM set_config('app.athlete_id',coalesce(previous_tenant,''),true);
    IF retired OR NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id=identity_id AND a.issuer=$3 AND a.subject=$4) THEN
      CONTINUE;
    END IF;
    DELETE FROM identity_private.session WHERE expires_at <= $6 OR token_hash=$7;
    RETURN QUERY INSERT INTO identity_private.session(token_hash,athlete_id,csrf_token,expires_at)
      VALUES($1,identity_id,$2,$5) RETURNING session.athlete_id::text,session.session_id::text;
    RETURN;
  END LOOP;
  RAISE EXCEPTION 'IDENTITY_RETRY_REQUIRED';
END;
$$;
