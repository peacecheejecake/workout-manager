-- M2-04d separates access facts from content. Reviewed curation, explicit
-- sharing and coach use are independent transitions; every one of them bumps
-- the monotonic access revision and records a bounded audit fact. Access,
-- consent and policy withdrawal enqueue a durable derived-data cleanup
-- manifest that covers derived text, search index, cache and citations.
ALTER TABLE resource DROP CONSTRAINT IF EXISTS resource_include_for_coach_check;
ALTER TABLE resource DROP CONSTRAINT IF EXISTS resource_reviewed_state_check;
ALTER TABLE resource ADD CONSTRAINT resource_reviewed_state_valid
  CHECK (reviewed_state IN ('unreviewed','reviewed'));
ALTER TABLE resource ADD COLUMN reviewed_at timestamptz;
ALTER TABLE resource ADD COLUMN coach_use_enabled_at timestamptz;
ALTER TABLE resource ADD CONSTRAINT resource_reviewed_at_matches
  CHECK ((reviewed_state='reviewed')=(reviewed_at IS NOT NULL));
ALTER TABLE resource ADD CONSTRAINT resource_coach_use_requires_review
  CHECK (NOT include_for_coach OR reviewed_state='reviewed');
ALTER TABLE resource ADD CONSTRAINT resource_coach_use_at_matches
  CHECK (include_for_coach=(coach_use_enabled_at IS NOT NULL));
ALTER TABLE resource ADD CONSTRAINT resource_deleted_excludes_coach_use
  CHECK (deleted_at IS NULL OR NOT include_for_coach);

-- Explicit, tenant-owned grant to another principal. The owner is always the
-- authenticated tenant; the grantee is never allowed to be the owner itself.
CREATE TABLE resource_share (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  share_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  grantee_kind text NOT NULL CHECK (grantee_kind='coach'),
  grantee_principal_id text NOT NULL CHECK (length(grantee_principal_id) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('active','revoked')),
  granted_access_revision integer NOT NULL CHECK (granted_access_revision BETWEEN 1 AND 2147483646),
  revoked_access_revision integer CHECK (revoked_access_revision BETWEEN 1 AND 2147483646),
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,share_id),
  FOREIGN KEY (athlete_id,resource_id) REFERENCES resource (athlete_id,id) ON DELETE CASCADE,
  CHECK (grantee_principal_id <> athlete_id),
  CHECK (updated_at >= granted_at),
  CHECK (
    (state='active' AND revoked_at IS NULL AND revoked_access_revision IS NULL)
    OR (state='revoked' AND revoked_at IS NOT NULL AND revoked_access_revision IS NOT NULL
        AND revoked_access_revision > granted_access_revision AND revoked_at >= granted_at)
  )
);
-- At most one active grant per principal; revoked grants stay as audit history.
CREATE UNIQUE INDEX resource_share_active_grantee ON resource_share
  (athlete_id,resource_id,grantee_kind,grantee_principal_id) WHERE state='active';
CREATE INDEX resource_share_grantee ON resource_share (grantee_principal_id,athlete_id,resource_id)
  WHERE state='active';
CREATE INDEX resource_share_resource ON resource_share (athlete_id,resource_id,state);

-- Bounded audit facts, kept apart from operational logs. No content, no
-- storage reference and no credential ever enters this table.
CREATE TABLE resource_access_audit (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  event_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN (
    'share_granted','share_revoked','reviewed_marked','reviewed_cleared',
    'coach_use_enabled','coach_use_disabled','consent_withdrawn','resource_deleted')),
  access_revision integer NOT NULL CHECK (access_revision BETWEEN 1 AND 2147483646),
  share_id uuid,
  grantee_kind text CHECK (grantee_kind IS NULL OR grantee_kind='coach'),
  grantee_principal_id text CHECK (grantee_principal_id IS NULL
    OR length(grantee_principal_id) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,event_id),
  FOREIGN KEY (athlete_id,resource_id) REFERENCES resource (athlete_id,id) ON DELETE CASCADE,
  CHECK ((share_id IS NULL)=(grantee_principal_id IS NULL)),
  CHECK ((grantee_kind IS NULL)=(grantee_principal_id IS NULL)),
  CHECK (action IN ('share_granted','share_revoked') = (share_id IS NOT NULL))
);
CREATE INDEX resource_access_audit_resource ON resource_access_audit
  (athlete_id,resource_id,occurred_at DESC,event_id);

-- Durable derived-data cleanup manifest. It reuses the lease/attempt/
-- dead-letter discipline and the worker process of the M2-04b/c object
-- cleanup queue, and covers the targets object cleanup cannot express:
-- derived text, search index, retrieval cache and stored citations. Raw and
-- parsed objects keep flowing through resource_object_cleanup unchanged.
-- The table deliberately has no foreign key so it survives account erasure.
CREATE TABLE resource_derived_cleanup (
  id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  resource_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'resource_deleted','share_revoked','consent_withdrawn','review_withdrawn',
    'coach_use_withdrawn','account_erased')),
  access_revision integer NOT NULL CHECK (access_revision BETWEEN 1 AND 2147483646),
  targets jsonb NOT NULL CHECK (
    jsonb_typeof(targets)='object' AND octet_length(targets::text) <= 1024
    AND targets ? 'derivedData' AND targets ? 'searchIndex'
    AND targets ? 'cache' AND targets ? 'citations'
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  lease_owner uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 100),
  UNIQUE (athlete_id,resource_id,reason,access_revision),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (completed_at IS NULL OR lease_owner IS NULL)
);
CREATE INDEX resource_derived_cleanup_pending ON resource_derived_cleanup
  (available_at,created_at,id) WHERE completed_at IS NULL AND attempts<100;
CREATE INDEX resource_derived_cleanup_open ON resource_derived_cleanup
  (athlete_id,resource_id) WHERE completed_at IS NULL;

ALTER TABLE resource_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_share FORCE ROW LEVEL SECURITY;
-- The grantee sees only its own active grants and never any revoked history.
CREATE POLICY resource_share_tenant ON resource_share
  USING (
    athlete_id = nullif(current_setting('app.athlete_id',true),'')
    OR (state='active' AND grantee_principal_id = nullif(current_setting('app.athlete_id',true),''))
  )
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE resource_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_access_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_access_audit_tenant ON resource_access_audit
  USING (athlete_id = nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE resource_derived_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_derived_cleanup FORCE ROW LEVEL SECURITY;

-- Reading a shared resource is an SQL-enforced privilege: an active share row,
-- a live resource, and never a client-supplied owner identity. Revocation and
-- deletion remove the row from the policy immediately, on the next statement.
DROP POLICY resource_tenant ON resource;
CREATE POLICY resource_tenant ON resource
  USING (
    athlete_id = nullif(current_setting('app.athlete_id',true),'')
    OR (deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM public.resource_share s
      WHERE s.athlete_id=resource.athlete_id AND s.resource_id=resource.id AND s.state='active'
        AND s.grantee_principal_id = nullif(current_setting('app.athlete_id',true),'')
    ))
  )
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id',true),''));
DROP POLICY resource_version_tenant ON resource_version;
CREATE POLICY resource_version_tenant ON resource_version
  USING (
    athlete_id = nullif(current_setting('app.athlete_id',true),'')
    OR EXISTS (
      SELECT 1 FROM public.resource r JOIN public.resource_share s
        ON s.athlete_id=r.athlete_id AND s.resource_id=r.id
      WHERE r.athlete_id=resource_version.athlete_id AND r.id=resource_version.resource_id
        AND r.deleted_at IS NULL AND r.current_version_id=resource_version.version_id
        AND s.state='active'
        AND s.grantee_principal_id = nullif(current_setting('app.athlete_id',true),'')
    )
  )
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id',true),''));

DROP POLICY resource_url_provenance_tenant ON resource_url_provenance;
CREATE POLICY resource_url_provenance_tenant ON resource_url_provenance
  USING (
    athlete_id = nullif(current_setting('app.athlete_id',true),'')
    OR EXISTS (
      SELECT 1 FROM public.resource r JOIN public.resource_share s
        ON s.athlete_id=r.athlete_id AND s.resource_id=r.id
      WHERE r.athlete_id=resource_url_provenance.athlete_id
        AND r.id=resource_url_provenance.resource_id AND r.deleted_at IS NULL
        AND r.current_version_id=resource_url_provenance.version_id AND s.state='active'
        AND s.grantee_principal_id = nullif(current_setting('app.athlete_id',true),'')
    )
  )
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id',true),''));

CREATE FUNCTION resource_share_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.share_id IS DISTINCT FROM OLD.share_id
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.grantee_kind IS DISTINCT FROM OLD.grantee_kind
    OR NEW.grantee_principal_id IS DISTINCT FROM OLD.grantee_principal_id
    OR NEW.granted_access_revision IS DISTINCT FROM OLD.granted_access_revision
    OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
    OR OLD.state='revoked' OR NEW.state<>'revoked'
  THEN RAISE EXCEPTION 'INVALID_RESOURCE_SHARE_TRANSITION'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resource_share_transition_valid() FROM PUBLIC;
CREATE TRIGGER resource_share_transition BEFORE UPDATE ON resource_share
  FOR EACH ROW EXECUTE FUNCTION resource_share_transition_valid();

CREATE FUNCTION resource_access_audit_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RESOURCE_ACCESS_AUDIT';
END $$;
REVOKE ALL ON FUNCTION resource_access_audit_append_only() FROM PUBLIC;
CREATE TRIGGER resource_access_audit_append_only BEFORE UPDATE ON resource_access_audit
  FOR EACH ROW EXECUTE FUNCTION resource_access_audit_append_only();

-- Version append and access change are distinct head transitions. Both advance
-- the access revision so an evidence dependency manifest observes either one.
CREATE OR REPLACE FUNCTION resource_head_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.title IS DISTINCT FROM OLD.title OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.tags IS DISTINCT FROM OLD.tags
    OR NEW.favorite IS DISTINCT FROM OLD.favorite
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.access_revision<>OLD.access_revision+1 OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    IF NEW.deleted_at IS DISTINCT FROM NEW.updated_at
      OR NEW.current_version IS DISTINCT FROM OLD.current_version
      OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
      OR NEW.include_for_coach OR NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  ELSIF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    -- Appending a version never promotes review or coach use.
    IF NEW.current_version<>OLD.current_version+1
      OR NEW.include_for_coach IS DISTINCT FROM OLD.include_for_coach
      OR NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  ELSE
    IF NEW.current_version IS DISTINCT FROM OLD.current_version
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
    -- Review and coach use are separate explicit transitions. One statement may
    -- never enable coach use while also changing review, and review may not be
    -- withdrawn while coach use is still on: coach use is stopped first.
    IF NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
      AND NEW.include_for_coach IS DISTINCT FROM OLD.include_for_coach
      AND NEW.include_for_coach
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
    IF OLD.include_for_coach AND NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
    THEN RAISE EXCEPTION 'REVIEW_WITHDRAWAL_BLOCKED'; END IF;
    IF NEW.include_for_coach AND NOT EXISTS(
      SELECT 1 FROM public.consent c
      WHERE c.athlete_id=NEW.athlete_id AND c.kind='ai' AND c.granted
    ) THEN RAISE EXCEPTION 'COACH_USE_CONSENT_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.record_resource_access_audit(
  p_tenant text, p_resource uuid, p_action text, p_revision integer,
  p_share uuid, p_grantee_kind text, p_grantee text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  INSERT INTO public.resource_access_audit
    (athlete_id,event_id,resource_id,action,access_revision,share_id,grantee_kind,
     grantee_principal_id,occurred_at)
  VALUES (p_tenant,gen_random_uuid(),p_resource,p_action,p_revision,p_share,p_grantee_kind,
          p_grantee,clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION public.record_resource_access_audit(text,uuid,text,integer,uuid,text,text)
  FROM PUBLIC;

CREATE FUNCTION public.queue_resource_derived_cleanup(
  p_tenant text, p_resource uuid, p_reason text, p_revision integer) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  INSERT INTO public.resource_derived_cleanup
    (id,athlete_id,resource_id,reason,access_revision,targets,available_at,created_at)
  VALUES (gen_random_uuid(),p_tenant,p_resource,p_reason,p_revision,
    jsonb_build_object('derivedData',true,'searchIndex',true,'cache',true,'citations',true),
    clock_timestamp(),clock_timestamp())
  ON CONFLICT (athlete_id,resource_id,reason,access_revision) DO UPDATE SET
    attempts=0,lease_owner=NULL,lease_until=NULL,available_at=clock_timestamp(),
    completed_at=NULL,last_error_code=NULL
    WHERE public.resource_derived_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.queue_resource_derived_cleanup(text,uuid,text,integer) FROM PUBLIC;

-- Tenant entry point. It derives ownership from the session tenant, never from
-- a caller-supplied athlete identifier.
CREATE FUNCTION public.enqueue_resource_derived_cleanup(uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE revision integer;
BEGIN
  IF tenant IS NULL OR $2 NOT IN (
    'resource_deleted','share_revoked','consent_withdrawn','review_withdrawn','coach_use_withdrawn'
  ) THEN RAISE EXCEPTION 'INVALID_RESOURCE_DERIVED_CLEANUP'; END IF;
  SELECT access_revision INTO revision FROM public.resource
    WHERE athlete_id=tenant AND id=$1;
  IF revision IS NULL THEN RAISE EXCEPTION 'INVALID_RESOURCE_DERIVED_CLEANUP'; END IF;
  RETURN public.queue_resource_derived_cleanup(tenant,$1,$2::text,revision);
END $$;
REVOKE ALL ON FUNCTION public.enqueue_resource_derived_cleanup(uuid,text) FROM PUBLIC;

-- Query-time access gate. Retrieval, citation rendering and any retry must call
-- this instead of trusting a stored index, cache entry or manifest snapshot.
CREATE FUNCTION public.resource_coach_use_authorized(uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.resource r
    WHERE r.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND r.id=$1
      AND r.deleted_at IS NULL AND r.include_for_coach AND r.reviewed_state='reviewed'
      AND EXISTS(SELECT 1 FROM public.consent c
        WHERE c.athlete_id=r.athlete_id AND c.kind='ai' AND c.granted)
      AND NOT EXISTS(SELECT 1 FROM public.resource_derived_cleanup q
        WHERE q.athlete_id=r.athlete_id AND q.resource_id=r.id AND q.completed_at IS NULL)
  );
$$;
REVOKE ALL ON FUNCTION public.resource_coach_use_authorized(uuid) FROM PUBLIC;

CREATE FUNCTION public.resource_derived_cleanup_pending(uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM public.resource_derived_cleanup q
    WHERE q.athlete_id=nullif(current_setting('app.athlete_id',true),'')
      AND q.resource_id=$1 AND q.completed_at IS NULL);
$$;
REVOKE ALL ON FUNCTION public.resource_derived_cleanup_pending(uuid) FROM PUBLIC;

-- Withdrawing AI consent is a policy change: it disables coach use on every
-- resource, bumps each access revision, audits the fact and enqueues cleanup.
CREATE FUNCTION resource_ai_consent_withdrawn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed record;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF NEW.kind<>'ai' OR NEW.granted THEN RETURN NEW; END IF;
  FOR changed IN
    UPDATE public.resource SET include_for_coach=false,coach_use_enabled_at=NULL,
      access_revision=access_revision+1,updated_at=greatest(updated_at,database_now)
    WHERE athlete_id=NEW.athlete_id AND include_for_coach AND deleted_at IS NULL
    RETURNING id,access_revision
  LOOP
    PERFORM public.record_resource_access_audit(
      NEW.athlete_id,changed.id,'consent_withdrawn',changed.access_revision,NULL,NULL,NULL);
    PERFORM public.queue_resource_derived_cleanup(
      NEW.athlete_id,changed.id,'consent_withdrawn',changed.access_revision);
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resource_ai_consent_withdrawn() FROM PUBLIC;
CREATE TRIGGER resource_ai_consent_withdrawn AFTER INSERT OR UPDATE ON consent
  FOR EACH ROW EXECUTE FUNCTION resource_ai_consent_withdrawn();

CREATE FUNCTION public.lease_resource_derived_cleanup(uuid,timestamptz,timestamptz)
RETURNS TABLE(id uuid,athlete_id text,resource_id uuid,reason text,access_revision integer,
  targets jsonb,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE lease_duration interval:=$3-$2;
BEGIN
  IF lease_duration<=interval '0 seconds' OR lease_duration>interval '5 minutes'
  THEN RAISE EXCEPTION 'INVALID_CLEANUP_LEASE'; END IF;
  RETURN QUERY WITH candidate AS (
    SELECT q.id FROM public.resource_derived_cleanup q
    -- attempts=100 is a durable dead-letter state kept for operator inspection.
    WHERE q.completed_at IS NULL AND q.attempts<100 AND q.available_at<=database_now
      AND (q.lease_until IS NULL OR q.lease_until<=database_now)
    ORDER BY q.available_at,q.created_at,q.id FOR UPDATE SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE public.resource_derived_cleanup q
      SET lease_owner=$1,lease_until=database_now+lease_duration,attempts=q.attempts+1
    FROM candidate c WHERE q.id=c.id
    RETURNING q.id,q.athlete_id,q.resource_id,q.reason,q.access_revision,q.targets,q.attempts
  ) SELECT * FROM changed;
END $$;
REVOKE ALL ON FUNCTION public.lease_resource_derived_cleanup(uuid,timestamptz,timestamptz)
  FROM PUBLIC;

-- Releasing a lease returns the attempt budget. A manifest whose derived store
-- has no executor installed yet must never burn its way into the dead-letter
-- state: it has to survive until M2-05 registers a real deletion.
CREATE FUNCTION public.release_resource_derived_cleanup(uuid,uuid,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  UPDATE public.resource_derived_cleanup SET
    attempts=greatest(attempts-1,0),
    available_at=database_now+interval '5 minutes',
    last_error_code=left(coalesce($3,'DERIVED_TARGET_UNSUPPORTED'),100),
    lease_owner=NULL,lease_until=NULL
  WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL AND lease_until>database_now;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.release_resource_derived_cleanup(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.finish_resource_derived_cleanup(uuid,uuid,boolean,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  UPDATE public.resource_derived_cleanup SET
    completed_at=CASE WHEN $3 THEN database_now ELSE NULL END,
    available_at=CASE WHEN $3 THEN available_at
      ELSE database_now+least(attempts,10)*interval '30 seconds' END,
    last_error_code=CASE WHEN $3 THEN NULL
      WHEN attempts>=100 THEN 'DEAD_LETTER:'||left(coalesce($4,'DERIVED_CLEANUP_FAILED'),88)
      ELSE left(coalesce($4,'DERIVED_CLEANUP_FAILED'),100) END,
    lease_owner=NULL,lease_until=NULL
  WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL AND lease_until>database_now;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_resource_derived_cleanup(uuid,uuid,boolean,text) FROM PUBLIC;

-- Completed derived-cleanup receipts are operational evidence for thirty days.
CREATE FUNCTION public.prune_resource_derived_cleanup_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_PRUNE_LIMIT'; END IF;
  WITH candidates AS (
    SELECT id FROM public.resource_derived_cleanup
    WHERE completed_at<statement_timestamp()-interval '30 days'
    ORDER BY completed_at,id LIMIT $1
  )
  DELETE FROM public.resource_derived_cleanup q USING candidates c WHERE q.id=c.id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_resource_derived_cleanup_history(integer) FROM PUBLIC;

-- Soft deletion revokes every outstanding share and enqueues the derived
-- manifest in the same transaction as the object cleanup enqueue.
CREATE FUNCTION public.revoke_resource_shares(uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE revision integer;
DECLARE revoked record;
DECLARE affected integer:=0;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF tenant IS NULL OR $2 NOT IN ('RESOURCE_DELETED','ACCOUNT_ERASED')
  THEN RAISE EXCEPTION 'INVALID_RESOURCE_SHARE_REVOCATION'; END IF;
  SELECT access_revision INTO revision FROM public.resource WHERE athlete_id=tenant AND id=$1;
  IF revision IS NULL THEN RAISE EXCEPTION 'INVALID_RESOURCE_SHARE_REVOCATION'; END IF;
  FOR revoked IN
    UPDATE public.resource_share SET state='revoked',revoked_at=database_now,
      revoked_access_revision=revision,updated_at=database_now
    WHERE athlete_id=tenant AND resource_id=$1 AND state='active'
    RETURNING share_id,grantee_kind,grantee_principal_id
  LOOP
    PERFORM public.record_resource_access_audit(tenant,$1,'share_revoked',revision,
      revoked.share_id,revoked.grantee_kind,revoked.grantee_principal_id);
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.revoke_resource_shares(uuid,text) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_resource_access;
REVOKE ALL ON FUNCTION public.erase_account_before_resource_access(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_resource_access(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format(
    'REVOKE ALL ON FUNCTION public.erase_account_before_resource_access(text) FROM %I',role_name);
  END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate record;
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  -- Grants held by other principals stop resolving before any row is removed.
  UPDATE public.resource_share SET state='revoked',revoked_at=clock_timestamp(),
    revoked_access_revision=greatest(granted_access_revision+1,1),updated_at=clock_timestamp()
    WHERE athlete_id=$1 AND state='active';
  FOR candidate IN SELECT id,access_revision FROM public.resource WHERE athlete_id=$1 LOOP
    PERFORM public.queue_resource_derived_cleanup(
      $1,candidate.id,'account_erased',candidate.access_revision);
  END LOOP;
  RETURN public.erase_account_before_resource_access($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
