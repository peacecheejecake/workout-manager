CREATE SCHEMA identity_private;
REVOKE ALL ON SCHEMA identity_private FROM PUBLIC;
CREATE TABLE identity_private.account (
  athlete_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  UNIQUE (issuer, subject)
);
CREATE TABLE identity_private.login_attempt (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 256),
  verifier text NOT NULL CHECK (length(verifier) BETWEEN 43 AND 128),
  expires_at timestamptz NOT NULL
);
CREATE INDEX login_attempt_expiry ON identity_private.login_attempt (expires_at);
CREATE TABLE identity_private.session (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  session_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  athlete_id uuid NOT NULL REFERENCES identity_private.account,
  csrf_token text NOT NULL CHECK (length(csrf_token) BETWEEN 32 AND 256),
  expires_at timestamptz NOT NULL
);
CREATE INDEX session_expiry ON identity_private.session (expires_at);

CREATE FUNCTION public.auth_create_attempt(text, text, text, text, timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF $5 <= clock_timestamp() OR $5 > clock_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'INVALID_ATTEMPT_EXPIRY';
  END IF;
  DELETE FROM identity_private.login_attempt WHERE expires_at <= clock_timestamp();
  INSERT INTO identity_private.login_attempt VALUES ($1, $2, $3, $4, $5);
END;
$$;
CREATE FUNCTION public.auth_consume_attempt(text, text, timestamptz)
RETURNS TABLE(nonce text, verifier text) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH consumed AS (
    DELETE FROM identity_private.login_attempt WHERE state_hash = $1 AND browser_hash = $2
    RETURNING login_attempt.nonce, login_attempt.verifier, expires_at
  ) SELECT nonce, verifier FROM consumed WHERE expires_at > $3;
$$;
CREATE FUNCTION public.auth_create_session(text, text, text, text, timestamptz, timestamptz, text)
RETURNS TABLE(athlete_id text, session_id text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE identity_id uuid;
BEGIN
  IF $5 <= $6 OR $5 > $6 + interval '24 hours' THEN RAISE EXCEPTION 'INVALID_SESSION_EXPIRY'; END IF;
  DELETE FROM identity_private.session WHERE expires_at <= $6;
  INSERT INTO identity_private.account (issuer, subject) VALUES ($3, $4)
    ON CONFLICT (issuer, subject) DO UPDATE SET subject = EXCLUDED.subject
    RETURNING account.athlete_id INTO identity_id;
  DELETE FROM identity_private.session WHERE token_hash = $7;
  RETURN QUERY INSERT INTO identity_private.session (token_hash, athlete_id, csrf_token, expires_at)
    VALUES ($1, identity_id, $2, $5) RETURNING session.athlete_id::text, session.session_id::text;
END;
$$;
CREATE FUNCTION public.auth_find_session(text, timestamptz)
RETURNS TABLE(athlete_id text, session_id text, csrf_token text, expires_at timestamptz) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT athlete_id::text, session_id::text, csrf_token, expires_at FROM identity_private.session
    WHERE token_hash = $1 AND expires_at > $2;
$$;
CREATE FUNCTION public.auth_revoke_session(text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  DELETE FROM identity_private.session WHERE token_hash = $1;
$$;
REVOKE ALL ON FUNCTION public.auth_create_attempt(text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_consume_attempt(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_create_session(text, text, text, text, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_find_session(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_revoke_session(text) FROM PUBLIC;
