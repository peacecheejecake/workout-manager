-- M2-04b adds bounded private PDF/Markdown objects. Bytes remain behind an
-- opaque server storage reference; PostgreSQL owns metadata and lifecycle only.
ALTER TABLE resource ADD COLUMN source_kind text NOT NULL DEFAULT 'text';
ALTER TABLE resource ADD CONSTRAINT resource_source_kind_valid
  CHECK (source_kind IN ('text','file'));

ALTER TABLE resource_version ALTER COLUMN content DROP NOT NULL;
ALTER TABLE resource_version ADD COLUMN storage_ref text;
ALTER TABLE resource_version ADD COLUMN original_filename text;
ALTER TABLE resource_version ADD COLUMN media_type text;
ALTER TABLE resource_version ADD COLUMN size_bytes bigint;
ALTER TABLE resource_version DROP CONSTRAINT resource_version_content_check;
ALTER TABLE resource_version DROP CONSTRAINT resource_version_content_status_check;
ALTER TABLE resource_version DROP CONSTRAINT resource_version_paragraphs_check;
ALTER TABLE resource_version ADD CONSTRAINT resource_version_paragraphs_shape CHECK (
  jsonb_typeof(paragraphs)='array' AND jsonb_array_length(paragraphs)<=1000
  AND octet_length(paragraphs::text)<=524288
);
ALTER TABLE resource_version ADD CONSTRAINT resource_version_source_xor CHECK (
  (content IS NOT NULL AND storage_ref IS NULL AND original_filename IS NULL
    AND media_type IS NULL AND size_bytes IS NULL
    AND octet_length(convert_to(content,'UTF8')) BETWEEN 1 AND 65536
    AND jsonb_array_length(paragraphs) BETWEEN 1 AND 1000
    AND content_status='parsed')
  OR
  (content IS NULL AND storage_ref IS NOT NULL AND original_filename IS NOT NULL
    AND octet_length(convert_to(original_filename,'UTF8')) BETWEEN 1 AND 255 AND original_filename=btrim(original_filename)
    AND media_type IN ('application/pdf','text/markdown')
    AND size_bytes BETWEEN 1 AND 10485760
    AND paragraphs='[]'::jsonb AND content_status='raw_stored')
);
ALTER TABLE resource_version ADD CONSTRAINT resource_version_file_kind_matches CHECK (
  content IS NOT NULL OR
  (media_type='application/pdf' AND size_bytes<=10485760) OR
  (media_type='text/markdown' AND size_bytes<=1048576)
);

CREATE TABLE resource_object (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  storage_ref text NOT NULL CHECK (length(storage_ref) BETWEEN 1 AND 512),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  media_type text NOT NULL CHECK (media_type IN ('application/pdf','text/markdown')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,storage_ref),
  UNIQUE (storage_ref)
);
ALTER TABLE resource_version ADD CONSTRAINT resource_version_object_fk
  FOREIGN KEY (athlete_id,storage_ref) REFERENCES resource_object(athlete_id,storage_ref)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE resource_upload_intent (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  upload_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('create','append')),
  resource_id uuid NOT NULL,
  version_id uuid NOT NULL,
  expected_current_version_id uuid,
  temporary_ref text NOT NULL CHECK (length(temporary_ref) BETWEEN 1 AND 512),
  storage_ref text,
  source_kind text NOT NULL CHECK (source_kind='file'),
  title text CHECK (title IS NULL OR (length(title) BETWEEN 1 AND 200 AND title=btrim(title))),
  category text CHECK (category IS NULL OR category IN ('paper','guide','note','race_material')),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=16384),
  tags jsonb NOT NULL CHECK (jsonb_typeof(tags)='array' AND jsonb_array_length(tags)<=20 AND octet_length(tags::text)<=4096),
  favorite boolean NOT NULL,
  original_filename text CHECK (original_filename IS NULL OR (octet_length(convert_to(original_filename,'UTF8')) BETWEEN 1 AND 255 AND original_filename=btrim(original_filename))),
  media_type text CHECK (media_type IS NULL OR media_type IN ('application/pdf','text/markdown')),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 10485760),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('reserved','prepared','staged','finalized','failed')),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  prepared_at timestamptz,
  staged_at timestamptz,
  finalized_at timestamptz,
  PRIMARY KEY (athlete_id,upload_id),
  UNIQUE (athlete_id,idempotency_key),
  UNIQUE (athlete_id,resource_id,version_id),
  CHECK ((operation='create' AND expected_current_version_id IS NULL AND title IS NOT NULL AND category IS NOT NULL)
      OR (operation='append' AND expected_current_version_id IS NOT NULL AND title IS NULL AND category IS NULL)),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
  CHECK ((state='reserved' AND storage_ref IS NULL AND original_filename IS NULL AND media_type IS NULL
        AND size_bytes IS NULL AND content_hash IS NULL AND prepared_at IS NULL AND staged_at IS NULL AND finalized_at IS NULL AND failure_code IS NULL)
      OR (state='prepared' AND storage_ref IS NOT NULL AND original_filename IS NOT NULL AND media_type IS NOT NULL
        AND size_bytes IS NOT NULL AND content_hash IS NOT NULL AND prepared_at IS NOT NULL AND staged_at IS NULL AND finalized_at IS NULL AND failure_code IS NULL)
      OR (state='staged' AND storage_ref IS NOT NULL AND original_filename IS NOT NULL AND media_type IS NOT NULL
        AND size_bytes IS NOT NULL AND content_hash IS NOT NULL AND prepared_at IS NOT NULL AND staged_at IS NOT NULL AND finalized_at IS NULL AND failure_code IS NULL)
      OR (state='finalized' AND storage_ref IS NOT NULL AND original_filename IS NOT NULL AND media_type IS NOT NULL
        AND size_bytes IS NOT NULL AND content_hash IS NOT NULL AND prepared_at IS NOT NULL AND staged_at IS NOT NULL AND finalized_at IS NOT NULL AND failure_code IS NULL)
      OR (state='failed' AND finalized_at IS NULL AND failure_code IS NOT NULL)),
  CHECK (media_type IS NULL OR (media_type='application/pdf' AND size_bytes<=10485760)
      OR (media_type='text/markdown' AND size_bytes<=1048576)),
  CHECK (updated_at>=created_at)
);

-- This queue deliberately has no athlete id or tenant foreign key. It must
-- survive account erasure, while exposing only an opaque storage reference.
CREATE TABLE resource_object_cleanup (
  id uuid PRIMARY KEY,
  storage_ref text NOT NULL UNIQUE CHECK (length(storage_ref) BETWEEN 1 AND 512),
  reason text NOT NULL CHECK (reason IN ('resource_deleted','account_erased','upload_abandoned')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  lease_owner uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  delete_authorized_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code)<=100),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (completed_at IS NULL OR (lease_owner IS NULL AND delete_authorized_at IS NULL)),
  CHECK (delete_authorized_at IS NULL OR lease_owner IS NOT NULL)
);
CREATE INDEX resource_object_cleanup_pending ON resource_object_cleanup(available_at,created_at,id)
  WHERE completed_at IS NULL AND attempts<100;

ALTER TABLE resource_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_object FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_object_tenant ON resource_object
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE resource_upload_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_upload_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_upload_intent_tenant ON resource_upload_intent
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE resource_object_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_object_cleanup FORCE ROW LEVEL SECURITY;

CREATE FUNCTION resource_object_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_RESOURCE_OBJECT';
END $$;
REVOKE ALL ON FUNCTION resource_object_immutable() FROM PUBLIC;
CREATE TRIGGER resource_object_immutable BEFORE UPDATE OR DELETE ON resource_object
  FOR EACH ROW EXECUTE FUNCTION resource_object_immutable();

CREATE FUNCTION resource_upload_intent_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.operation IS DISTINCT FROM OLD.operation OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.expected_current_version_id IS DISTINCT FROM OLD.expected_current_version_id
    OR NEW.temporary_ref IS DISTINCT FROM OLD.temporary_ref
    OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.category IS DISTINCT FROM OLD.category OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.tags IS DISTINCT FROM OLD.tags OR NEW.favorite IS DISTINCT FROM OLD.favorite
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.updated_at<OLD.updated_at
    OR OLD.state='finalized'
    OR (OLD.state='reserved' AND NEW.state NOT IN ('prepared','failed'))
    OR (OLD.state='prepared' AND NEW.state NOT IN ('staged','failed'))
    OR (OLD.state='staged' AND NEW.state NOT IN ('finalized','failed'))
    OR (OLD.state='reserved' AND NEW.state='failed' AND (
      NEW.storage_ref IS NOT NULL OR NEW.original_filename IS NOT NULL OR NEW.media_type IS NOT NULL
      OR NEW.size_bytes IS NOT NULL OR NEW.content_hash IS NOT NULL OR NEW.prepared_at IS NOT NULL
      OR NEW.staged_at IS NOT NULL))
    OR (OLD.state IN ('prepared','staged') AND (
      NEW.storage_ref IS DISTINCT FROM OLD.storage_ref
      OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
      OR NEW.media_type IS DISTINCT FROM OLD.media_type
      OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
      OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
      OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at))
    OR (OLD.state='staged' AND NEW.staged_at IS DISTINCT FROM OLD.staged_at)
    OR OLD.state='failed'
  THEN RAISE EXCEPTION 'INVALID_RESOURCE_UPLOAD_TRANSITION'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resource_upload_intent_transition_valid() FROM PUBLIC;
CREATE TRIGGER resource_upload_intent_transition BEFORE UPDATE ON resource_upload_intent
  FOR EACH ROW EXECUTE FUNCTION resource_upload_intent_transition_valid();

CREATE OR REPLACE FUNCTION resource_head_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.title IS DISTINCT FROM OLD.title OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.tags IS DISTINCT FROM OLD.tags
    OR NEW.favorite IS DISTINCT FROM OLD.favorite OR NEW.include_for_coach IS DISTINCT FROM OLD.include_for_coach
    OR NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.access_revision<>OLD.access_revision+1 OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  IF NEW.deleted_at IS NULL THEN
    IF NEW.current_version<>OLD.current_version+1 OR NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  ELSE
    IF NEW.deleted_at IS DISTINCT FROM NEW.updated_at OR NEW.current_version IS DISTINCT FROM OLD.current_version
      OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.enqueue_resource_object_cleanup(uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
BEGIN
  IF tenant IS NULL OR $2<>'resource_deleted' OR NOT EXISTS(
    SELECT 1 FROM public.resource WHERE athlete_id=tenant AND id=$1 AND deleted_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'INVALID_RESOURCE_CLEANUP'; END IF;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),v.storage_ref,$2,clock_timestamp(),clock_timestamp()
    FROM public.resource_version v WHERE v.athlete_id=tenant AND v.resource_id=$1 AND v.storage_ref IS NOT NULL
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_resource_object_cleanup(uuid,text) FROM PUBLIC;

CREATE FUNCTION queue_resource_upload_refs(text,uuid,text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,$3,clock_timestamp(),clock_timestamp()
    FROM public.resource_upload_intent i
    CROSS JOIN LATERAL (VALUES(i.temporary_ref),(i.storage_ref)) refs(storage_ref)
    WHERE i.athlete_id=$1 AND i.upload_id=$2 AND refs.storage_ref IS NOT NULL
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION queue_resource_upload_refs(text,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.fail_resource_upload(uuid,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE changed boolean;
BEGIN
  IF tenant IS NULL OR length($2) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_UPLOAD_FAILURE'; END IF;
  UPDATE public.resource_upload_intent SET state='failed',failure_code=$2,updated_at=clock_timestamp()
    WHERE athlete_id=tenant AND upload_id=$1 AND state IN ('reserved','prepared','staged')
    RETURNING true INTO changed;
  IF coalesce(changed,false)=false THEN RETURN false; END IF;
  PERFORM public.queue_resource_upload_refs(tenant,$1,'upload_abandoned');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fail_resource_upload(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.expire_resource_uploads(timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE upload uuid;
DECLARE affected integer:=0;
DECLARE database_now timestamptz:=statement_timestamp();
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_UPLOAD_EXPIRY'; END IF;
  FOR upload IN
    UPDATE public.resource_upload_intent SET state='failed',failure_code='UPLOAD_EXPIRED',updated_at=database_now
    WHERE athlete_id=tenant AND state IN ('reserved','prepared','staged') AND expires_at<=database_now
    RETURNING upload_id
  LOOP
    PERFORM public.queue_resource_upload_refs(tenant,upload,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.expire_resource_uploads(timestamptz) FROM PUBLIC;

CREATE FUNCTION public.cancel_resource_uploads(uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE upload uuid;
DECLARE affected integer:=0;
BEGIN
  IF tenant IS NULL OR $2 NOT IN ('RESOURCE_DELETED','ACCOUNT_ERASED') THEN
    RAISE EXCEPTION 'INVALID_UPLOAD_CANCELLATION';
  END IF;
  FOR upload IN
    UPDATE public.resource_upload_intent SET state='failed',failure_code=$2,updated_at=clock_timestamp()
    WHERE athlete_id=tenant AND resource_id=$1 AND state IN ('reserved','prepared','staged')
    RETURNING upload_id
  LOOP
    PERFORM public.queue_resource_upload_refs(tenant,upload,
      CASE WHEN $2='ACCOUNT_ERASED' THEN 'account_erased' ELSE 'resource_deleted' END);
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.cancel_resource_uploads(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.protect_resource_upload_object(uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE object_ref text;
BEGIN
  SELECT storage_ref INTO object_ref FROM public.resource_upload_intent
    WHERE athlete_id=tenant AND upload_id=$1 AND state IN ('prepared','staged');
  IF tenant IS NULL OR object_ref IS NULL THEN RAISE EXCEPTION 'INVALID_UPLOAD_PROTECTION'; END IF;
  IF EXISTS(SELECT 1 FROM public.resource_object_cleanup
    WHERE storage_ref=object_ref AND completed_at IS NULL AND delete_authorized_at IS NOT NULL)
  THEN RAISE EXCEPTION 'OBJECT_DELETE_IN_PROGRESS'; END IF;
  UPDATE public.resource_object_cleanup SET completed_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,
    delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT'
    WHERE storage_ref=object_ref AND completed_at IS NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.protect_resource_upload_object(uuid) FROM PUBLIC;

CREATE FUNCTION public.lease_resource_object_cleanup(uuid,timestamptz,timestamptz)
RETURNS TABLE(id uuid,storage_ref text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE lease_duration interval:=$3-$2;
BEGIN
  IF lease_duration<=interval '0 seconds' OR lease_duration>interval '5 minutes'
  THEN RAISE EXCEPTION 'INVALID_CLEANUP_LEASE'; END IF;
  RETURN QUERY WITH candidate AS (
    SELECT q.id FROM public.resource_object_cleanup q
    -- attempts=100 is a durable dead-letter state. It remains incomplete for
    -- operator inspection and cannot block later queue entries.
    WHERE q.completed_at IS NULL AND q.attempts<100 AND q.available_at<=database_now
      AND (q.lease_until IS NULL OR q.lease_until<=database_now)
    ORDER BY q.available_at,q.created_at,q.id FOR UPDATE SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE public.resource_object_cleanup q SET lease_owner=$1,lease_until=database_now+lease_duration,
      delete_authorized_at=NULL,attempts=q.attempts+1
    FROM candidate c WHERE q.id=c.id RETURNING q.id,q.storage_ref,q.attempts
  ) SELECT * FROM changed;
END $$;
REVOKE ALL ON FUNCTION public.lease_resource_object_cleanup(uuid,timestamptz,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz)
RETURNS TABLE(id uuid,storage_ref text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE object_ref text;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  SELECT q.storage_ref INTO object_ref FROM public.resource_object_cleanup q
    WHERE q.id=$1 AND q.lease_owner=$2 AND q.completed_at IS NULL AND q.lease_until>database_now FOR UPDATE;
  IF object_ref IS NULL THEN RETURN; END IF;
  IF EXISTS(
    SELECT 1 FROM public.resource_version v JOIN public.resource r
      ON r.athlete_id=v.athlete_id AND r.id=v.resource_id
      WHERE v.storage_ref=object_ref AND r.deleted_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.resource_upload_intent i
      WHERE (i.storage_ref=object_ref OR i.temporary_ref=object_ref)
        AND i.state IN ('reserved','prepared','staged') AND i.expires_at>database_now
  ) THEN
    UPDATE public.resource_object_cleanup q SET completed_at=database_now,lease_owner=NULL,lease_until=NULL,
      delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT' WHERE q.id=$1;
    RETURN;
  END IF;
  RETURN QUERY UPDATE public.resource_object_cleanup q SET delete_authorized_at=database_now
    WHERE q.id=$1 RETURNING q.id,q.storage_ref,q.attempts;
END $$;
REVOKE ALL ON FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.reap_expired_resource_uploads(timestamptz,integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expired record;
DECLARE affected integer:=0;
DECLARE database_now timestamptz:=statement_timestamp();
BEGIN
  IF $2<1 OR $2>100 THEN RAISE EXCEPTION 'INVALID_REAP_LIMIT'; END IF;
  FOR expired IN
    WITH candidates AS (
      SELECT athlete_id,upload_id FROM public.resource_upload_intent
      WHERE state IN ('reserved','prepared','staged') AND expires_at<=database_now
      ORDER BY expires_at,upload_id FOR UPDATE SKIP LOCKED LIMIT $2
    )
    UPDATE public.resource_upload_intent i SET state='failed',failure_code='UPLOAD_EXPIRED',updated_at=database_now
    FROM candidates c WHERE i.athlete_id=c.athlete_id AND i.upload_id=c.upload_id
    RETURNING i.athlete_id,i.upload_id
  LOOP
    PERFORM public.queue_resource_upload_refs(expired.athlete_id,expired.upload_id,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.reap_expired_resource_uploads(timestamptz,integer) FROM PUBLIC;

-- Failed upload receipts are retained for seven days. A row is only compacted
-- after every known object reference has either completed cleanup or never had
-- a cleanup row. Each call is bounded so reservation latency remains bounded.
CREATE FUNCTION public.compact_resource_upload_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
BEGIN
  IF tenant IS NULL OR $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_COMPACT_LIMIT'; END IF;
  WITH candidates AS (
    SELECT i.upload_id FROM public.resource_upload_intent i
    WHERE i.athlete_id=tenant AND i.state='failed'
      AND i.updated_at<statement_timestamp()-interval '7 days'
      AND NOT EXISTS(
        SELECT 1 FROM public.resource_object_cleanup q
        WHERE q.storage_ref IN (i.temporary_ref,i.storage_ref) AND q.completed_at IS NULL
      )
    ORDER BY i.updated_at,i.upload_id LIMIT $1
  )
  DELETE FROM public.resource_upload_intent i USING candidates c
    WHERE i.athlete_id=tenant AND i.upload_id=c.upload_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.compact_resource_upload_history(integer) FROM PUBLIC;

CREATE FUNCTION public.prune_resource_upload_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_PRUNE_LIMIT'; END IF;
  WITH candidates AS (
    SELECT i.athlete_id,i.upload_id FROM public.resource_upload_intent i
    WHERE i.state='failed' AND i.updated_at<statement_timestamp()-interval '7 days'
      AND NOT EXISTS(
        SELECT 1 FROM public.resource_object_cleanup q
        WHERE q.storage_ref IN (i.temporary_ref,i.storage_ref) AND q.completed_at IS NULL
      )
    ORDER BY i.updated_at,i.upload_id LIMIT $1
  )
  DELETE FROM public.resource_upload_intent i USING candidates c
    WHERE i.athlete_id=c.athlete_id AND i.upload_id=c.upload_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_resource_upload_history(integer) FROM PUBLIC;

-- Completed cleanup receipts are operational evidence for thirty days. The
-- worker prunes them in bounded batches after upload history pruning.
CREATE FUNCTION public.prune_resource_cleanup_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_PRUNE_LIMIT'; END IF;
  WITH candidates AS (
    SELECT id FROM public.resource_object_cleanup
    WHERE completed_at<statement_timestamp()-interval '30 days'
    ORDER BY completed_at,id LIMIT $1
  )
  DELETE FROM public.resource_object_cleanup q USING candidates c WHERE q.id=c.id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_resource_cleanup_history(integer) FROM PUBLIC;

CREATE FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  UPDATE public.resource_object_cleanup SET
    completed_at=CASE WHEN $3 THEN database_now ELSE NULL END,
    available_at=CASE WHEN $3 THEN available_at ELSE database_now+least(attempts,10)*interval '30 seconds' END,
    last_error_code=CASE WHEN $3 THEN NULL
      WHEN attempts>=100 THEN 'DEAD_LETTER:'||left(coalesce($4,'OBJECT_DELETE_FAILED'),88)
      ELSE left(coalesce($4,'OBJECT_DELETE_FAILED'),100) END,
    lease_owner=NULL,lease_until=NULL,delete_authorized_at=NULL
  WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL AND lease_until>database_now
    AND delete_authorized_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_resource_objects;
REVOKE ALL ON FUNCTION public.erase_account_before_resource_objects(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_resource_objects(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_resource_objects(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM public.cancel_resource_uploads(resource_id,'ACCOUNT_ERASED')
    FROM public.resource_upload_intent WHERE athlete_id=$1 AND state IN ('reserved','prepared','staged');
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),storage_ref,'account_erased',clock_timestamp(),clock_timestamp()
    FROM public.resource_object WHERE athlete_id=$1
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  DELETE FROM public.resource_upload_intent WHERE athlete_id=$1;
  DELETE FROM public.resource_object WHERE athlete_id=$1;
  RETURN public.erase_account_before_resource_objects($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
