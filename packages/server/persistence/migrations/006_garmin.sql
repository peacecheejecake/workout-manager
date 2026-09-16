CREATE SCHEMA garmin_private;
REVOKE ALL ON SCHEMA garmin_private FROM PUBLIC;
CREATE FUNCTION garmin_private.valid_cipher(jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_typeof($1)='object' AND $1 ?& ARRAY['keyId','iv','ciphertext','tag']
 AND ($1 - ARRAY['keyId','iv','ciphertext','tag'])='{}'::jsonb
 AND jsonb_typeof($1->'keyId')='string' AND length($1->>'keyId') BETWEEN 1 AND 100
 AND jsonb_typeof($1->'iv')='string' AND length($1->>'iv') BETWEEN 16 AND 64
 AND jsonb_typeof($1->'tag')='string' AND length($1->>'tag') BETWEEN 22 AND 64
 AND jsonb_typeof($1->'ciphertext')='string' AND length($1->>'ciphertext') BETWEEN 1 AND 60000
$$;
CREATE TABLE garmin_connection (
 athlete_id text PRIMARY KEY,
 generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
 state text NOT NULL DEFAULT 'disconnected' CHECK(state IN('disconnected','connecting','connected','reconnect_required')),
 user_id text UNIQUE CHECK(length(user_id) BETWEEN 1 AND 200),
 permissions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(permissions)='array' AND jsonb_array_length(permissions)<=32),
 encrypted_tokens jsonb CHECK(garmin_private.valid_cipher(encrypted_tokens)),
 connected_at timestamptz,
 access_expires_at timestamptz,
 refresh_expires_at timestamptz,
 lease_id uuid,
 lease_until timestamptz,
 attempt_expires_at timestamptz,
 attempt_session_id text,
 CHECK((encrypted_tokens IS NULL)=(user_id IS NULL)),
 CHECK(encrypted_tokens IS NULL OR (access_expires_at IS NOT NULL AND refresh_expires_at IS NOT NULL))
);
CREATE TABLE garmin_attempt (
 athlete_id text NOT NULL REFERENCES garmin_connection ON DELETE CASCADE,
 state_hash text NOT NULL CHECK(state_hash~'^[a-f0-9]{64}$'),
 session_id text NOT NULL,
 generation integer NOT NULL,
 encrypted_verifier jsonb NOT NULL CHECK(garmin_private.valid_cipher(encrypted_verifier)),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
 PRIMARY KEY(athlete_id,state_hash)
);
ALTER TABLE garmin_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY garmin_connection_scope ON garmin_connection USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE garmin_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE garmin_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY garmin_attempt_scope ON garmin_attempt USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- No runtime SELECT on these global coordination/cleanup tables.
CREATE TABLE garmin_private.ownership (
 user_hash text PRIMARY KEY,
 athlete_id text NOT NULL,
 active boolean NOT NULL
);
CREATE TABLE garmin_private.revocation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 athlete_id text NOT NULL,
 user_hash text,
 encrypted_tokens jsonb NOT NULL CHECK(garmin_private.valid_cipher(encrypted_tokens)),
 fingerprint text NOT NULL,
 access_expires_at timestamptz NOT NULL,
 refresh_expires_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 available_at timestamptz NOT NULL,
 lease_id uuid,
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 prepared boolean NOT NULL DEFAULT false,
 CHECK(expires_at<=created_at+interval '24 hours'),
 UNIQUE(athlete_id,fingerprint)
);
CREATE INDEX garmin_revocation_available ON garmin_private.revocation(available_at,expires_at);

CREATE FUNCTION public.garmin_session_active(text,text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RETURN false; END IF;
 PERFORM 1 FROM identity_private.session WHERE athlete_id::text=$1 AND session_id::text=$2 AND expires_at>$3 FOR SHARE;
 RETURN FOUND;
END;
$$;
CREATE FUNCTION public.garmin_pending(timestamptz) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM garmin_private.revocation WHERE athlete_id=nullif(current_setting('app.athlete_id',true),'') AND (expires_at>$1 OR lease_until>$1))
$$;
CREATE FUNCTION public.garmin_claim_user(text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text; target text:=nullif(current_setting('app.athlete_id',true),''); h text:=encode(sha256(convert_to($1,'UTF8')),'hex');
BEGIN
 IF target IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(h,77208));
 IF EXISTS(SELECT 1 FROM garmin_private.revocation WHERE user_hash=h AND (expires_at>$2 OR lease_until>$2)) THEN RETURN false; END IF;
 DELETE FROM garmin_private.ownership WHERE user_hash=h AND NOT active;
 INSERT INTO garmin_private.ownership(user_hash,athlete_id,active) VALUES(h,target,true) ON CONFLICT DO NOTHING;
 SELECT athlete_id INTO owner_id FROM garmin_private.ownership WHERE user_hash=h;
 RETURN owner_id=target;
END;
$$;
-- Registration revocation is global at the provider: never revoke a live newer/other owner.
CREATE FUNCTION public.garmin_queue_revoke(jsonb,text,timestamptz,timestamptz,timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target text:=nullif(current_setting('app.athlete_id',true),''); h text; owner_id text; is_active boolean;
BEGIN
 IF target IS NULL OR NOT garmin_private.valid_cipher($1) THEN RAISE EXCEPTION 'INVALID_GARMIN_CLEANUP'; END IF;
 IF $2 IS NOT NULL THEN
  h:=encode(sha256(convert_to($2,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(h,77208));
  SELECT athlete_id,active INTO owner_id,is_active FROM garmin_private.ownership WHERE user_hash=h;
  IF is_active THEN RETURN false; END IF;
 END IF;
 IF greatest($3,$4)<=$5 THEN RETURN false; END IF;
 INSERT INTO garmin_private.revocation(athlete_id,user_hash,encrypted_tokens,fingerprint,access_expires_at,refresh_expires_at,expires_at,created_at,available_at)
 VALUES(target,h,$1,encode(sha256(convert_to($1::text,'UTF8')),'hex'),$3,$4,least(greatest($3,$4),$5+interval '24 hours'),$5,$5) ON CONFLICT DO NOTHING;
 RETURN true;
END;
$$;
CREATE FUNCTION public.garmin_disconnect(timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target text:=nullif(current_setting('app.athlete_id',true),''); old public.garmin_connection%ROWTYPE; h text;
BEGIN
 IF target IS NULL THEN RAISE EXCEPTION 'INVALID_TENANT'; END IF;
 SELECT * INTO old FROM public.garmin_connection WHERE athlete_id=target FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF old.user_id IS NOT NULL THEN
  h:=encode(sha256(convert_to(old.user_id,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(h,77208));
  UPDATE garmin_private.ownership SET active=false WHERE user_hash=h AND athlete_id=target;
 END IF;
 UPDATE public.garmin_connection SET generation=generation+1,state='disconnected',user_id=NULL,permissions='[]',encrypted_tokens=NULL,connected_at=NULL,access_expires_at=NULL,refresh_expires_at=NULL,lease_id=NULL,lease_until=NULL WHERE athlete_id=target;
 DELETE FROM public.garmin_attempt WHERE athlete_id=target;
 IF old.encrypted_tokens IS NOT NULL THEN
  PERFORM public.garmin_queue_revoke(old.encrypted_tokens,old.user_id,old.access_expires_at,old.refresh_expires_at,$1);
 END IF;
END;
$$;

CREATE FUNCTION public.garmin_lease_revocation(uuid,timestamptz,timestamptz)
RETURNS TABLE(id uuid,athlete_id text,encrypted_tokens jsonb,access_expires_at timestamptz,refresh_expires_at timestamptz,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate garmin_private.revocation%ROWTYPE;
BEGIN
 IF $3<=$2 OR $3>$2+interval '2 minutes' THEN RAISE EXCEPTION 'INVALID_LEASE'; END IF;
 DELETE FROM garmin_private.revocation r WHERE r.expires_at<=$2 AND (r.lease_until IS NULL OR r.lease_until<=$2);
 DELETE FROM garmin_private.ownership o WHERE NOT o.active AND NOT EXISTS(SELECT 1 FROM garmin_private.revocation r WHERE r.user_hash=o.user_hash);
 SELECT * INTO candidate FROM garmin_private.revocation r WHERE r.expires_at>$2 AND r.available_at<=$2 AND (r.lease_until IS NULL OR r.lease_until<=$2)
 AND NOT EXISTS(SELECT 1 FROM garmin_private.revocation other WHERE r.user_hash IS NOT NULL AND other.user_hash=r.user_hash AND other.lease_until>$2)
 ORDER BY r.available_at,r.id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 IF candidate.user_hash IS NOT NULL THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(candidate.user_hash,77208)) THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM garmin_private.revocation r WHERE r.user_hash=candidate.user_hash AND r.lease_until>$2) THEN RETURN; END IF;
 END IF;
 RETURN QUERY UPDATE garmin_private.revocation r SET lease_id=$1,lease_until=$3,attempts=r.attempts+1,prepared=false WHERE r.id=candidate.id RETURNING r.id,r.athlete_id,r.encrypted_tokens,r.access_expires_at,r.refresh_expires_at,r.expires_at;
END;
$$;
-- Resolve even unknown OAuth orphans before calling registration-level DELETE.
CREATE FUNCTION public.garmin_prepare_revocation(uuid,uuid,text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h text:=encode(sha256(convert_to($3,'UTF8')),'hex'); job garmin_private.revocation%ROWTYPE;
BEGIN
 IF length($3) NOT BETWEEN 1 AND 200 THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(h,77208));
 SELECT * INTO job FROM garmin_private.revocation WHERE id=$1 AND lease_id=$2 AND lease_until>$4+interval '15 seconds' AND expires_at>$4 FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM garmin_private.ownership WHERE user_hash=h AND active) THEN
  DELETE FROM garmin_private.revocation WHERE id=$1;
  RETURN false;
 END IF;
 IF job.user_hash IS NOT NULL AND job.user_hash<>h THEN RETURN false; END IF;
 UPDATE garmin_private.revocation SET user_hash=h WHERE id=$1;
 IF EXISTS(SELECT 1 FROM garmin_private.revocation WHERE user_hash=h AND id<>$1 AND lease_until>$4) THEN RETURN false; END IF;
 UPDATE garmin_private.revocation SET prepared=true WHERE id=$1;
 RETURN true;
END;
$$;
CREATE FUNCTION public.garmin_update_revocation(uuid,uuid,jsonb,timestamptz,timestamptz,timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE garmin_private.revocation SET encrypted_tokens=$3,access_expires_at=$4,refresh_expires_at=$5 WHERE id=$1 AND lease_id=$2 AND lease_until>$6 AND expires_at>$6;
 RETURN FOUND;
END;
$$;
CREATE FUNCTION public.garmin_finish_revocation(uuid,uuid,boolean,timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h text; valid boolean;
BEGIN
 SELECT user_hash INTO h FROM garmin_private.revocation WHERE id=$1 AND lease_id=$2 AND lease_until>$4;
 IF $3 THEN
  IF h IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(h,77208));
  SELECT prepared INTO valid FROM garmin_private.revocation WHERE id=$1 AND lease_id=$2 AND lease_until>$4 FOR UPDATE;
  IF NOT coalesce(valid,false) THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM garmin_private.ownership WHERE user_hash=h AND active) THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM garmin_private.revocation WHERE user_hash=h AND id<>$1 AND prepared AND lease_until>$4) THEN RETURN; END IF;
  DELETE FROM garmin_private.revocation WHERE user_hash=h;
 ELSE
  UPDATE garmin_private.revocation SET lease_id=NULL,lease_until=NULL,prepared=false,available_at=$4+interval '1 minute' WHERE id=$1 AND lease_id=$2 AND lease_until>$4;
 END IF;
 DELETE FROM garmin_private.revocation WHERE expires_at<=$4 AND (lease_until IS NULL OR lease_until<=$4);
 DELETE FROM garmin_private.ownership o WHERE NOT o.active AND NOT EXISTS(SELECT 1 FROM garmin_private.revocation r WHERE r.user_hash=o.user_hash);
END;
$$;
REVOKE ALL ON FUNCTION public.garmin_session_active(text,text,timestamptz),public.garmin_pending(timestamptz),public.garmin_claim_user(text,timestamptz),public.garmin_queue_revoke(jsonb,text,timestamptz,timestamptz,timestamptz),public.garmin_disconnect(timestamptz),public.garmin_lease_revocation(uuid,timestamptz,timestamptz),public.garmin_prepare_revocation(uuid,uuid,text,timestamptz),public.garmin_update_revocation(uuid,uuid,jsonb,timestamptz,timestamptz,timestamptz),public.garmin_finish_revocation(uuid,uuid,boolean,timestamptz) FROM PUBLIC;

-- Preserve all prior erasure behavior, adding Garmin fencing/cleanup in the same transaction.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_garmin;
REVOKE ALL ON FUNCTION public.erase_account_before_garmin(text) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.erase_account_before_garmin(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_garmin(text) FROM %I',role_name);
 END LOOP;
END;
$$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result timestamptz;
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM public.garmin_disconnect(clock_timestamp());
 DELETE FROM public.garmin_connection WHERE athlete_id=$1;
 result:=public.erase_account_before_garmin($1);
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
