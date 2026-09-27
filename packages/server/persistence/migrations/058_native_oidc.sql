-- Native authorization codes are not browser cookies or API bearer tokens. The fixed app
-- redirect receives a short-lived code; only its SHA-256 digest is persisted.
CREATE TABLE identity_private.native_login_attempt (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 256),
  verifier text NOT NULL CHECK (verifier ~ '^[A-Za-z0-9_-]{43,128}$'),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX native_login_attempt_expiry ON identity_private.native_login_attempt (expires_at);

CREATE TABLE identity_private.native_exchange_code (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  provider_session_id text CHECK (length(provider_session_id) BETWEEN 1 AND 255),
  login_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX native_exchange_code_expiry ON identity_private.native_exchange_code (expires_at);

ALTER TABLE identity_private.session
  ADD COLUMN kind text NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser', 'native'));

-- Retire the untyped lookup: a mixed-version API must fail closed instead of accepting a
-- native bearer token placed in a browser cookie (or the reverse).
DROP FUNCTION public.auth_find_session(text, timestamptz);
CREATE FUNCTION public.auth_find_session_v2(text, timestamptz, text)
RETURNS TABLE(athlete_id text, session_id text, csrf_token text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.athlete_id::text, s.session_id::text, s.csrf_token, s.expires_at
  FROM identity_private.session s
  WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.kind = $3
    AND $3 IN ('browser', 'native');
$$;

CREATE FUNCTION public.auth_create_native_attempt(text, text, text, text, timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF $1 !~ '^[a-f0-9]{64}$' OR length($2) NOT BETWEEN 16 AND 256
     OR $3 !~ '^[A-Za-z0-9_-]{43,128}$' OR $4 !~ '^[A-Za-z0-9_-]{43}$'
     OR $5 <= clock_timestamp() OR $5 > clock_timestamp() + interval '10 minutes'
  THEN RAISE EXCEPTION 'INVALID_NATIVE_ATTEMPT'; END IF;
  DELETE FROM identity_private.native_login_attempt WHERE expires_at <= clock_timestamp();
  INSERT INTO identity_private.native_login_attempt
    (state_hash, nonce, verifier, code_challenge, expires_at)
  VALUES ($1, $2, $3, $4, $5);
END;
$$;

CREATE FUNCTION public.auth_consume_native_attempt(text, timestamptz)
RETURNS TABLE(nonce text, verifier text, code_challenge text, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH consumed AS (
    DELETE FROM identity_private.native_login_attempt
    WHERE state_hash = $1 AND expires_at > $2
    RETURNING native_login_attempt.nonce, native_login_attempt.verifier,
      native_login_attempt.code_challenge, native_login_attempt.created_at
  ) SELECT consumed.nonce, consumed.verifier, consumed.code_challenge,
      consumed.created_at FROM consumed;
$$;

CREATE FUNCTION public.auth_create_native_code(text, text, text, text, text, timestamptz, timestamptz, timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF $1 !~ '^[a-f0-9]{64}$' OR $2 !~ '^[A-Za-z0-9_-]{43}$'
     OR length($3) NOT BETWEEN 1 AND 2048 OR length($4) NOT BETWEEN 1 AND 255
     OR ($5 IS NOT NULL AND length($5) NOT BETWEEN 1 AND 255)
     OR $6 < clock_timestamp() - interval '15 minutes'
     OR $6 > clock_timestamp() + interval '1 minute'
     OR $8 < clock_timestamp() - interval '1 minute'
     OR $8 > clock_timestamp() + interval '1 minute'
     OR $7 <= clock_timestamp() OR $7 > clock_timestamp() + interval '2 minutes'
  THEN RAISE EXCEPTION 'INVALID_NATIVE_CODE'; END IF;
  DELETE FROM identity_private.native_exchange_code WHERE expires_at <= clock_timestamp();
  INSERT INTO identity_private.native_exchange_code
    (code_hash, code_challenge, issuer, subject, provider_session_id, login_started_at, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7);
END;
$$;

-- The code is consumed and the bearer session is issued in one transaction. The existing
-- auth_create_session enforces account erasure and OIDC back-channel revocation barriers.
CREATE FUNCTION public.auth_exchange_native_code(text, text, text, text, timestamptz, timestamptz)
RETURNS TABLE(athlete_id text, session_id text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE consumed record; issued record;
BEGIN
  IF $1 !~ '^[a-f0-9]{64}$' OR $2 !~ '^[A-Za-z0-9_-]{43}$'
     OR $3 !~ '^[a-f0-9]{64}$' OR length($4) NOT BETWEEN 32 AND 256
     OR $6 < clock_timestamp() - interval '1 minute'
     OR $6 > clock_timestamp() + interval '1 minute'
     OR $5 <= clock_timestamp() OR $5 > clock_timestamp() + interval '24 hours'
  THEN RAISE EXCEPTION 'INVALID_NATIVE_EXCHANGE'; END IF;
  DELETE FROM identity_private.native_exchange_code AS c
    WHERE c.code_hash = $1 AND c.code_challenge = $2 AND c.expires_at > clock_timestamp()
    RETURNING c.* INTO consumed;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO issued FROM public.auth_create_session(
    $3, $4, consumed.issuer, consumed.subject, $5, $6, NULL,
    consumed.provider_session_id, consumed.login_started_at
  );
  UPDATE identity_private.session AS s SET kind = 'native'
    WHERE s.token_hash = $3 AND s.session_id = issued.session_id::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_SESSION_MISSING'; END IF;
  RETURN QUERY SELECT issued.athlete_id::text, issued.session_id::text, $5;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_find_session_v2(text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_create_native_attempt(text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_consume_native_attempt(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_create_native_code(text, text, text, text, text, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_exchange_native_code(text, text, text, text, timestamptz, timestamptz) FROM PUBLIC;
