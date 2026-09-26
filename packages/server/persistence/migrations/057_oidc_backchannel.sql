ALTER TABLE identity_private.login_attempt
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE identity_private.session
  ADD COLUMN provider_session_id text CHECK (length(provider_session_id) BETWEEN 1 AND 255);
-- A mixed-version API must fail closed at login. This removes every previously granted
-- EXECUTE privilege together with the old signature, rather than leaving a barrier bypass.
-- Retire it before deleting legacy rows so calls resolved after this migration commit fail;
-- deployment must drain old API instances before the migration to cover in-flight calls.
DROP FUNCTION public.auth_create_session(text, text, text, text, timestamptz, timestamptz, text);
-- No pre-upgrade app session has a verified OP sid. Invalidate them before a sid-only
-- Logout Token can arrive; browsers retain their cookie and request reauthentication.
DELETE FROM identity_private.session WHERE provider_session_id IS NULL;
CREATE INDEX identity_session_provider_sid ON identity_private.session (provider_session_id)
  WHERE provider_session_id IS NOT NULL;

CREATE TABLE identity_private.logout_token_replay (
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  jti_hash text NOT NULL CHECK (jti_hash ~ '^[a-f0-9]{64}$'),
  subject text CHECK (length(subject) BETWEEN 1 AND 255),
  provider_session_id text CHECK (length(provider_session_id) BETWEEN 1 AND 255),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (subject IS NOT NULL OR provider_session_id IS NOT NULL),
  PRIMARY KEY (issuer, jti_hash)
);
CREATE INDEX logout_token_replay_expiry ON identity_private.logout_token_replay (received_at);

CREATE FUNCTION public.auth_consume_attempt_v2(text, text, timestamptz)
RETURNS TABLE(nonce text, verifier text, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH consumed AS (
    DELETE FROM identity_private.login_attempt WHERE state_hash = $1 AND browser_hash = $2
    RETURNING login_attempt.nonce, login_attempt.verifier, login_attempt.created_at, expires_at
  ) SELECT nonce, verifier, created_at FROM consumed WHERE expires_at > $3;
$$;

CREATE FUNCTION public.auth_create_session(text, text, text, text, timestamptz, timestamptz, text, text, timestamptz)
RETURNS TABLE(athlete_id text, session_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE identity_id uuid; attempt integer; retired boolean; previous_tenant text := current_setting('app.athlete_id', true);
BEGIN
  IF $5 <= $6 OR $5 > $6 + interval '24 hours' THEN RAISE EXCEPTION 'INVALID_SESSION_EXPIRY'; END IF;
  IF $8 IS NOT NULL AND length($8) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'INVALID_PROVIDER_SID'; END IF;
  IF $9 < clock_timestamp() - interval '15 minutes' OR $9 > clock_timestamp() + interval '1 minute'
  THEN RAISE EXCEPTION 'INVALID_LOGIN_START'; END IF;
  -- Both paths lock subject before sid. If login wins, logout waits then deletes it;
  -- if logout wins, login sees its committed barrier and cannot recreate the session.
  PERFORM pg_advisory_xact_lock(hashtextextended('oidc-sub:' || $3 || ':' || $4, 77207));
  IF $8 IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('oidc-sid:' || $3 || ':' || $8, 77207));
  END IF;
  IF EXISTS (
    SELECT 1 FROM identity_private.logout_token_replay r
    WHERE r.issuer = $3 AND (
      (r.subject = $4 AND r.provider_session_id IS NULL AND r.received_at >= $9)
      OR (r.subject IS NULL AND $8 IS NOT NULL AND r.provider_session_id = $8)
      OR (r.subject = $4 AND $8 IS NOT NULL AND r.provider_session_id = $8)
    )
  ) THEN RAISE EXCEPTION 'LOGIN_REVOKED'; END IF;
  FOR attempt IN 1..3 LOOP
    identity_id := NULL;
    SELECT account.athlete_id INTO identity_id FROM identity_private.account WHERE issuer=$3 AND subject=$4;
    IF identity_id IS NULL THEN
      INSERT INTO identity_private.account(issuer,subject) VALUES($3,$4)
      ON CONFLICT(issuer,subject) DO NOTHING RETURNING account.athlete_id INTO identity_id;
      IF identity_id IS NULL THEN CONTINUE; END IF;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(identity_id::text,77206));
    PERFORM set_config('app.athlete_id',identity_id::text,true);
    SELECT EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=identity_id::text) INTO retired;
    PERFORM set_config('app.athlete_id',coalesce(previous_tenant,''),true);
    IF retired OR NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id=identity_id AND a.issuer=$3 AND a.subject=$4) THEN
      CONTINUE;
    END IF;
    DELETE FROM identity_private.session WHERE expires_at <= $6 OR token_hash=$7;
    RETURN QUERY INSERT INTO identity_private.session
      (token_hash, athlete_id, csrf_token, expires_at, provider_session_id)
      VALUES ($1, identity_id, $2, $5, $8)
      RETURNING session.athlete_id::text, session.session_id::text;
    RETURN;
  END LOOP;
  RAISE EXCEPTION 'IDENTITY_RETRY_REQUIRED';
END;
$$;

CREATE FUNCTION public.auth_revoke_provider_sessions(text, text, timestamptz, text, text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE inserted integer;
BEGIN
  IF length($1) NOT BETWEEN 1 AND 2048 OR $2 !~ '^[a-f0-9]{64}$'
    OR ($4 IS NULL AND $5 IS NULL)
    OR ($4 IS NOT NULL AND length($4) NOT BETWEEN 1 AND 255)
    OR ($5 IS NOT NULL AND length($5) NOT BETWEEN 1 AND 255)
    OR $3 < clock_timestamp() - interval '5 minutes'
    OR $3 > clock_timestamp() + interval '1 minute'
  THEN RAISE EXCEPTION 'INVALID_LOGOUT_CLAIMS'; END IF;

  IF $4 IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('oidc-sub:' || $1 || ':' || $4, 77207));
  END IF;
  IF $5 IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('oidc-sid:' || $1 || ':' || $5, 77207));
  END IF;

  DELETE FROM identity_private.logout_token_replay
    WHERE received_at < clock_timestamp() - interval '1 day';
  INSERT INTO identity_private.logout_token_replay (issuer, jti_hash, subject, provider_session_id)
    VALUES ($1, $2, $4, $5)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN false; END IF;

  DELETE FROM identity_private.session AS s
  USING identity_private.account AS a
  WHERE a.athlete_id = s.athlete_id AND a.issuer = $1
    AND ($4 IS NULL OR a.subject = $4)
    AND ($5 IS NULL OR s.provider_session_id = $5);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_consume_attempt_v2(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_create_session(text, text, text, text, timestamptz, timestamptz, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_revoke_provider_sessions(text, text, timestamptz, text, text) FROM PUBLIC;
