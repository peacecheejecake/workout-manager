-- M2-01k-o: what may leave the account from a course, and how it is taken back.
-- Requirement: docs/implementation/research/m2-01k-o-sharing-requirement.md (approved
-- 2026-09-25), with the independent re-identification review's blocking items A-1, B-1–B-8.
--
-- Four stores and one unauthenticated read, each keeping a boundary the course ledger keeps:
--
--   * `course_privacy_zone_share_offset` — each protected area's secret offset δ (B-1), a
--     point of the unit disc drawn once. It is the wider share circle's secret: it appears in
--     no sharing or disclosure response and no log, and leaves only in the owner's own
--     account export (an input nothing can rebuild, like the area's centre). It is erased
--     with its area (a cascade) and with the account, and is written once: nobody, not even
--     the owner role, may UPDATE it.
--   * `course_disclosure_receipt` — what the owner confirmed (§5): the revision, the
--     protected-area set, the purpose, what is disclosed and whether names are in. No
--     coordinate. It dies with its revision (a cascade) and expires after an hour.
--   * `course_share` — a view-only link (B). The server holds the SHA-256 of the token, never
--     the token. The line it shows is an immutable snapshot, cut against the share circles
--     and rounded, tied to the confirmed revision by a cascading foreign key, so deleting the
--     course or reclaiming it with its recording deletes the link in the same transaction.
--     A link only ever moves active → revoked, and never back.
--   * `course_share_audit` — the created/revoked facts, apart from operational logs, with no
--     token, digest or coordinate (030's precedent). Erased with the account.
--   * `course_share_rate` — the unauthenticated read's shared counters (D7, B-4). A bucket is
--     a keyed HMAC of the client address or a share id, never an address; rows older than two
--     hours are deleted by the read itself. No tenant owns them and the runtime role has no
--     grant on them at all: only `read_course_share` touches them.
--
-- `read_course_share` is the one unauthenticated data read in the product. It answers every
-- failure — unknown, malformed, expired, revoked, restored away, rate-limited — with the same
-- empty answer, which the API turns into one 404 body. It finds a link by one index lookup
-- on the digest, so an unknown and a malformed token cost the same.
--
-- Restore (B-5): a link stores the share epoch it was made under. The API is configured with
-- the current epoch outside the database and every restore raises it before runtime access, so
-- every link that was in the backup is dead after a restore — revoked, expired, deleted or
-- erased after the backup included. A link whose epoch is ABOVE the configured one means the
-- configuration went backwards; then no link is served at all.
--
-- Lock order is the repository's: account lock (77206) → per-tenant command lock (0) → rows.
-- The read takes no advisory lock and never waits on a share row (SKIP LOCKED housekeeping).

CREATE TABLE course_privacy_zone_share_offset (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  zone_id uuid NOT NULL,
  offset_x double precision NOT NULL CHECK (offset_x>=-1 AND offset_x<=1),
  offset_y double precision NOT NULL CHECK (offset_y>=-1 AND offset_y<=1),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,zone_id),
  CHECK (offset_x*offset_x+offset_y*offset_y<=1),
  FOREIGN KEY (athlete_id,zone_id) REFERENCES course_privacy_zone(athlete_id,zone_id)
    ON DELETE CASCADE
);

CREATE TABLE course_disclosure_receipt (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  receipt_id uuid NOT NULL,
  course_id uuid NOT NULL,
  course_revision integer NOT NULL CHECK (course_revision BETWEEN 1 AND 2147483646),
  purpose text NOT NULL CHECK (purpose IN ('export','share')),
  exposure text NOT NULL
    CHECK (exposure IN ('trimmed','no-zone-intersection','no-zones-exact','owner-exact')),
  zone_set_digest text NOT NULL CHECK (zone_set_digest ~ '^[a-f0-9]{64}$'),
  include_names boolean NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  confirmed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,receipt_id),
  UNIQUE (athlete_id,idempotency_key),
  -- A link can never be confirmed on an exact line (D3b, D3c).
  CHECK (purpose='export' OR exposure IN ('trimmed','no-zone-intersection')),
  CHECK (expires_at>confirmed_at AND expires_at<=confirmed_at+interval '1 hour'),
  FOREIGN KEY (athlete_id,course_id,course_revision)
    REFERENCES course_revision(athlete_id,course_id,course_revision) ON DELETE CASCADE
);

CREATE TABLE course_share (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  share_id uuid NOT NULL,
  course_id uuid NOT NULL,
  course_revision integer NOT NULL CHECK (course_revision BETWEEN 1 AND 2147483646),
  receipt_id uuid NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  epoch integer NOT NULL CHECK (epoch BETWEEN 1 AND 2147483646),
  state text NOT NULL CHECK (state IN ('active','revoked')),
  revoke_reason text
    CHECK (revoke_reason IS NULL OR revoke_reason IN ('owner','owner_all','zone_added','zone_removed')),
  include_names boolean NOT NULL,
  -- The protected areas the snapshot was cut against. Removing one of them revokes the link.
  zone_ids uuid[] NOT NULL CHECK (cardinality(zone_ids) BETWEEN 1 AND 20),
  snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=1048576),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (athlete_id,share_id),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 days'),
  CHECK ((state='active' AND revoked_at IS NULL AND revoke_reason IS NULL)
      OR (state='revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  FOREIGN KEY (athlete_id,course_id,course_revision)
    REFERENCES course_revision(athlete_id,course_id,course_revision) ON DELETE CASCADE
);
CREATE INDEX course_share_course ON course_share(athlete_id,course_id);
CREATE INDEX course_share_expiry ON course_share(expires_at);
CREATE INDEX course_share_epoch ON course_share(epoch);

CREATE TABLE course_share_audit (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  audit_id uuid NOT NULL,
  share_id uuid NOT NULL,
  course_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('created','revoked')),
  reason text
    CHECK (reason IS NULL OR reason IN ('owner','owner_all','zone_added','zone_removed')),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,audit_id),
  CHECK ((action='created' AND reason IS NULL) OR (action='revoked' AND reason IS NOT NULL))
);

CREATE TABLE course_share_rate (
  bucket text NOT NULL CHECK (bucket ~ '^[cfs]:[a-f0-9]{32,64}$'),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits>=0),
  PRIMARY KEY (bucket,window_start)
);
CREATE INDEX course_share_rate_window ON course_share_rate(window_start);

DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['course_privacy_zone_share_offset','course_disclosure_receipt',
    'course_share','course_share_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY course_tenant ON %I USING (athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',table_name);
  END LOOP;
END
$migration$;
ALTER TABLE course_share_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_share_rate FORCE ROW LEVEL SECURITY;
-- The read and the housekeeping run as the owner, across tenants, with no tenant set. Under
-- FORCE an owner that is neither superuser nor BYPASSRLS would otherwise see nothing (047's
-- precedent): these policies are for the owner role only, and only on this migration's own
-- two tables. No policy is added to any earlier table: an owner-wide policy there would
-- widen what every definer function of that owner sees (044/045's purge lease reads
-- `tenant_erasure` too). The read's erasure check sees `tenant_erasure` through 005's own
-- tenant policy instead, by naming the link's tenant for that one statement.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY course_share_definer ON course_share TO %I '
    'USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY course_share_rate_definer ON course_share_rate TO %I '
    'USING (true) WITH CHECK (true)', current_user);
END $$;

-- An offset is drawn once and never redrawn (B-1: V19b is exactly a redraw).
CREATE FUNCTION course_share_offset_write_once() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_catalog.pg_get_userbyid(c.relowner)
    FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_SHARE_OFFSET';
END $$;
REVOKE ALL ON FUNCTION course_share_offset_write_once() FROM PUBLIC;
CREATE TRIGGER course_share_offset_write_once BEFORE UPDATE OR DELETE
  ON course_privacy_zone_share_offset FOR EACH ROW EXECUTE FUNCTION course_share_offset_write_once();

-- A receipt is a record of a decision; it is never edited. It leaves with its revision, with
-- the account, or when expired (the owner's runtime DELETE of its own expired rows).
CREATE FUNCTION course_disclosure_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  RAISE EXCEPTION 'IMMUTABLE_DISCLOSURE_RECEIPT';
END $$;
REVOKE ALL ON FUNCTION course_disclosure_receipt_immutable() FROM PUBLIC;
CREATE TRIGGER course_disclosure_receipt_immutable BEFORE UPDATE ON course_disclosure_receipt
  FOR EACH ROW EXECUTE FUNCTION course_disclosure_receipt_immutable();

-- A link moves active → revoked and nothing else changes, ever. Only the owner (the cascade,
-- erasure, the reaper) removes one.
CREATE FUNCTION course_share_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE table_owner text:=(SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
  WHERE c.oid=TG_RELID);
BEGIN
  IF TG_OP='DELETE' THEN
    IF current_user=table_owner THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_COURSE_SHARE';
  END IF;
  IF (NEW.athlete_id,NEW.share_id,NEW.course_id,NEW.course_revision,NEW.receipt_id,
      NEW.token_digest,NEW.epoch,NEW.include_names,NEW.zone_ids,NEW.snapshot,NEW.created_at,
      NEW.expires_at)
    IS DISTINCT FROM
     (OLD.athlete_id,OLD.share_id,OLD.course_id,OLD.course_revision,OLD.receipt_id,
      OLD.token_digest,OLD.epoch,OLD.include_names,OLD.zone_ids,OLD.snapshot,OLD.created_at,
      OLD.expires_at)
    OR OLD.state<>'active' OR NEW.state<>'revoked'
  THEN RAISE EXCEPTION 'INVALID_COURSE_SHARE_TRANSITION'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_share_transition_valid() FROM PUBLIC;
CREATE TRIGGER course_share_transition BEFORE UPDATE OR DELETE ON course_share
  FOR EACH ROW EXECUTE FUNCTION course_share_transition_valid();

CREATE FUNCTION course_share_audit_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_catalog.pg_get_userbyid(c.relowner)
    FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_COURSE_SHARE_AUDIT';
END $$;
REVOKE ALL ON FUNCTION course_share_audit_append_only() FROM PUBLIC;
CREATE TRIGGER course_share_audit_append_only BEFORE UPDATE OR DELETE ON course_share_audit
  FOR EACH ROW EXECUTE FUNCTION course_share_audit_append_only();

-- Remove expired links, bounded, never waiting on a row another transaction holds. A link
-- that has expired is already refused by every read; this only stops the rows accumulating.
CREATE FUNCTION public.reap_course_shares(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE removed integer;
BEGIN
  IF $1 IS NULL OR $1 NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'INVALID_REAP_LIMIT'; END IF;
  DELETE FROM public.course_share s WHERE (s.athlete_id,s.share_id) IN (
    SELECT g.athlete_id,g.share_id FROM public.course_share g
    WHERE g.expires_at<=clock_timestamp()
    ORDER BY g.expires_at LIMIT $1 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.reap_course_shares(integer) FROM PUBLIC;

-- The one unauthenticated read.
--   $1 token digest (hex SHA-256 of what the caller sent — of anything, even a malformed
--      token, so an unknown and a malformed token take the same path)
--   $2 the configured share epoch
--   $3 the client key: a keyed HMAC of the client address, hex; never the address
--   $4 reads per client per minute   $5 matched reads per link per minute
--   $6 failed reads per client per hour
-- `outcome` is 'ok' with the snapshot, or 'not_found'/'limited' with nothing. The API gives
-- all of the latter the same 404; the distinction exists for tests and never leaves.
CREATE FUNCTION public.read_course_share(text,integer,text,integer,integer,integer)
RETURNS TABLE(outcome text,snapshot jsonb,include_names boolean,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE minute_start timestamptz:=date_trunc('minute',clock_timestamp());
DECLARE hour_start timestamptz:=date_trunc('hour',clock_timestamp());
DECLARE client_hits integer;
DECLARE failures integer;
DECLARE share_hits integer;
DECLARE found_share public.course_share%ROWTYPE;
DECLARE caller_tenant text;
DECLARE tenant_erased boolean:=false;
BEGIN
  IF $2 IS NULL OR $2 NOT BETWEEN 1 AND 2147483646
    OR $3 IS NULL OR $3 !~ '^[a-f0-9]{64}$'
    OR $4 IS NULL OR $4 NOT BETWEEN 1 AND 10000
    OR $5 IS NULL OR $5 NOT BETWEEN 1 AND 10000
    OR $6 IS NULL OR $6 NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'INVALID_SHARE_READ';
  END IF;
  -- Housekeeping, bounded: counters older than two hours (B-4) and expired links.
  DELETE FROM public.course_share_rate r WHERE (r.bucket,r.window_start) IN (
    SELECT g.bucket,g.window_start FROM public.course_share_rate g
    WHERE g.window_start<database_now-interval '2 hours'
    ORDER BY g.window_start LIMIT 200 FOR UPDATE SKIP LOCKED);
  PERFORM public.reap_course_shares(50);
  -- Every read counts against its client, found or not.
  INSERT INTO public.course_share_rate(bucket,window_start,hits) VALUES ('c:'||$3,minute_start,1)
    ON CONFLICT (bucket,window_start) DO UPDATE SET hits=public.course_share_rate.hits+1
    RETURNING hits INTO client_hits;
  SELECT r.hits INTO failures FROM public.course_share_rate r
    WHERE r.bucket='f:'||$3 AND r.window_start=hour_start;
  IF client_hits>$4 OR coalesce(failures,0)>=$6 THEN
    INSERT INTO public.course_share_rate(bucket,window_start,hits) VALUES ('f:'||$3,hour_start,1)
      ON CONFLICT (bucket,window_start) DO UPDATE SET hits=public.course_share_rate.hits+1;
    RETURN QUERY SELECT 'limited'::text,NULL::jsonb,NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;
  -- One index lookup on the digest. Every condition below is checked on the row it found.
  SELECT s.* INTO found_share FROM public.course_share s WHERE s.token_digest=$1;
  IF FOUND THEN
    -- Erased? Asked through 005's tenant policy on `tenant_erasure`, with the link's own tenant
    -- named for this one statement and the caller's setting put back at once, so the answer
    -- does not depend on the owner being superuser or BYPASSRLS and no wider policy exists.
    caller_tenant:=current_setting('app.athlete_id',true);
    PERFORM set_config('app.athlete_id',found_share.athlete_id,true);
    tenant_erased:=EXISTS(SELECT 1 FROM public.tenant_erasure e
      WHERE e.athlete_id=found_share.athlete_id);
    PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  END IF;
  IF found_share.share_id IS NULL
    OR found_share.state<>'active'
    OR found_share.expires_at<=database_now
    OR found_share.epoch<>$2
    -- The configuration went backwards (a restore without an epoch increase, then a new link
    -- under the higher epoch, then a rollback): serve nothing at all.
    OR EXISTS(SELECT 1 FROM public.course_share h WHERE h.epoch>$2)
    OR tenant_erased
  THEN
    INSERT INTO public.course_share_rate(bucket,window_start,hits) VALUES ('f:'||$3,hour_start,1)
      ON CONFLICT (bucket,window_start) DO UPDATE SET hits=public.course_share_rate.hits+1;
    RETURN QUERY SELECT 'not_found'::text,NULL::jsonb,NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;
  -- Counted only for a read that matched a link, and keyed by the link (R-5): an unknown
  -- digest creates no row here.
  INSERT INTO public.course_share_rate(bucket,window_start,hits)
    VALUES ('s:'||replace(found_share.share_id::text,'-',''),minute_start,1)
    ON CONFLICT (bucket,window_start) DO UPDATE SET hits=public.course_share_rate.hits+1
    RETURNING hits INTO share_hits;
  IF share_hits>$5 THEN
    RETURN QUERY SELECT 'limited'::text,NULL::jsonb,NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text,found_share.snapshot,found_share.include_names,
    found_share.expires_at;
END $$;
REVOKE ALL ON FUNCTION public.read_course_share(text,integer,text,integer,integer,integer)
  FROM PUBLIC;

-- Account export v23 carries M2-01ao's course-deletion ledger: course id and time, nothing
-- else. 049 deliberately gives the runtime role no SELECT on `course_deletion`, and that stays
-- so; the export reads the session tenant's own rows through this function instead. It takes
-- no argument: the tenant is the one the transaction was opened for, never a caller's choice.
CREATE FUNCTION public.export_course_deletions()
RETURNS TABLE(athlete_id text,course_id uuid,deleted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT d.athlete_id,d.course_id,d.deleted_at FROM public.course_deletion d
  WHERE d.athlete_id=nullif(current_setting('app.athlete_id',true),'')
$$;
REVOKE ALL ON FUNCTION public.export_course_deletions() FROM PUBLIC;

-- Erasure takes every share, receipt, audit fact, share counter and offset of the account. The
-- cascade from the revisions would take the shares and receipts anyway; the audit facts and
-- the counters have no foreign key and would not be reached by it.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_course_sharing;
REVOKE ALL ON FUNCTION public.erase_account_before_course_sharing(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_course_sharing(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_course_sharing(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  DELETE FROM public.course_share_rate r WHERE r.bucket IN (
    SELECT 's:'||replace(s.share_id::text,'-','') FROM public.course_share s WHERE s.athlete_id=$1);
  DELETE FROM public.course_share WHERE athlete_id=$1;
  DELETE FROM public.course_share_audit WHERE athlete_id=$1;
  DELETE FROM public.course_disclosure_receipt WHERE athlete_id=$1;
  DELETE FROM public.course_privacy_zone_share_offset WHERE athlete_id=$1;
  RETURN public.erase_account_before_course_sharing($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
