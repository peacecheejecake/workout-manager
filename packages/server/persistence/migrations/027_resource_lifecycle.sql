-- M2-04a stores bounded private text directly in PostgreSQL. It does not claim
-- object upload, parsing, indexing, retrieval, sharing, or citation support.
CREATE TABLE resource (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  category text NOT NULL CHECK (category IN ('paper','guide','note','race_material')),
  metadata jsonb NOT NULL CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384
  ),
  tags jsonb NOT NULL CHECK (
    jsonb_typeof(tags) = 'array' AND jsonb_array_length(tags) <= 20
    AND octet_length(tags::text) <= 4096
  ),
  favorite boolean NOT NULL DEFAULT false,
  include_for_coach boolean NOT NULL DEFAULT false CHECK (NOT include_for_coach),
  reviewed_state text NOT NULL DEFAULT 'unreviewed' CHECK (reviewed_state = 'unreviewed'),
  access_revision integer NOT NULL CHECK (access_revision BETWEEN 1 AND 2147483646),
  current_version integer NOT NULL CHECK (current_version BETWEEN 1 AND 2147483646),
  current_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (athlete_id, id),
  UNIQUE (athlete_id, id, current_version, current_version_id),
  CHECK (updated_at >= created_at AND (deleted_at IS NULL OR deleted_at = updated_at))
);

CREATE TABLE resource_version (
  athlete_id text NOT NULL,
  resource_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  previous_version integer,
  previous_version_id uuid,
  content text NOT NULL CHECK (
    octet_length(convert_to(content, 'UTF8')) BETWEEN 1 AND 65536
  ),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  paragraphs jsonb NOT NULL CHECK (
    jsonb_typeof(paragraphs) = 'array'
    AND jsonb_array_length(paragraphs) BETWEEN 1 AND 1000
    AND octet_length(paragraphs::text) <= 524288
  ),
  content_status text NOT NULL CHECK (content_status = 'parsed'),
  index_status text NOT NULL CHECK (index_status = 'not_indexed'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id, version_id),
  UNIQUE (athlete_id, resource_id, version),
  UNIQUE (athlete_id, resource_id, version, version_id),
  FOREIGN KEY (athlete_id, resource_id) REFERENCES resource (athlete_id, id) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id, resource_id, previous_version, previous_version_id)
    REFERENCES resource_version (athlete_id, resource_id, version, version_id),
  CHECK (
    (version = 1 AND previous_version IS NULL AND previous_version_id IS NULL)
    OR (version > 1 AND previous_version = version - 1 AND previous_version_id IS NOT NULL)
  )
);

ALTER TABLE resource ADD CONSTRAINT resource_current_version_fk
  FOREIGN KEY (athlete_id, id, current_version, current_version_id)
  REFERENCES resource_version (athlete_id, resource_id, version, version_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX resource_list_active ON resource
  (athlete_id, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX resource_version_history ON resource_version
  (athlete_id, resource_id, version DESC);

ALTER TABLE resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_tenant ON resource
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE resource_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_version FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_version_tenant ON resource_version
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

CREATE FUNCTION resource_head_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.tags IS DISTINCT FROM OLD.tags
    OR NEW.favorite IS DISTINCT FROM OLD.favorite
    OR NEW.include_for_coach IS DISTINCT FROM OLD.include_for_coach
    OR NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.access_revision <> OLD.access_revision + 1
    OR NEW.updated_at < OLD.updated_at
  THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  IF NEW.deleted_at IS NULL THEN
    IF NEW.current_version <> OLD.current_version + 1
      OR NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  ELSE
    IF NEW.deleted_at IS DISTINCT FROM NEW.updated_at
      OR NEW.current_version IS DISTINCT FROM OLD.current_version
      OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resource_head_transition_valid() FROM PUBLIC;
CREATE TRIGGER resource_head_transition
  BEFORE UPDATE ON resource FOR EACH ROW EXECUTE FUNCTION resource_head_transition_valid();

CREATE FUNCTION resource_version_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_RESOURCE_VERSION';
END $$;
REVOKE ALL ON FUNCTION resource_version_immutable() FROM PUBLIC;
CREATE TRIGGER resource_version_immutable
  BEFORE UPDATE OR DELETE ON resource_version
  FOR EACH ROW EXECUTE FUNCTION resource_version_immutable();

CREATE FUNCTION public.tombstone_resource_receipts(uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE tenant text := nullif(current_setting('app.athlete_id', true), '');
DECLARE affected integer;
DECLARE tombstone jsonb;
BEGIN
  SELECT jsonb_build_object(
    'status','deleted',
    'resourceId',id::text,
    'deletedAt',to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'accessRevision',access_revision
  ) INTO tombstone
  FROM public.resource WHERE athlete_id=tenant AND id=$1 AND deleted_at IS NOT NULL;
  IF tenant IS NULL OR tombstone IS NULL THEN RAISE EXCEPTION 'INVALID_RESOURCE_TOMBSTONE'; END IF;
  UPDATE public.command_receipt SET result=tombstone
  WHERE athlete_id=tenant AND idempotency_key LIKE 'resource:%'
    AND result->>'resourceId'=$1::text;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.tombstone_resource_receipts(uuid) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_resources;
REVOKE ALL ON FUNCTION public.erase_account_before_resources(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN
    SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_resources(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.erase_account_before_resources(text) FROM %I', role_name);
  END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  DELETE FROM public.resource WHERE athlete_id=$1;
  RETURN public.erase_account_before_resources($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
