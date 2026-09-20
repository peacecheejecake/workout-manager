-- M2-03 adds the private gallery/media ledger. Bytes stay behind opaque server
-- storage references reused from the M2-04b object port; PostgreSQL owns only
-- metadata, permissions and lifecycle. Object cleanup deliberately reuses the
-- existing durable resource_object_cleanup manifest so one worker drains every
-- private object of a tenant.

CREATE TABLE gallery_media_item (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id uuid NOT NULL,
  media_kind text NOT NULL CHECK (media_kind IN ('image','video')),
  -- Only private ownership is implemented. Explicit sharing scopes are a later
  -- task and must not be introduced by widening this value silently.
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility='private'),
  -- Gallery viewing never implies consent to send user media to a model.
  include_for_coach boolean NOT NULL DEFAULT false CHECK (NOT include_for_coach),
  album text CHECK (album IS NULL OR (length(album) BETWEEN 1 AND 100 AND album=btrim(album))),
  caption text CHECK (caption IS NULL OR (length(caption) BETWEEN 1 AND 500 AND caption=btrim(caption))),
  activity_id uuid,
  captured_at timestamptz,
  captured_local_date date,
  storage_ref text NOT NULL CHECK (length(storage_ref) BETWEEN 1 AND 512),
  original_filename text NOT NULL
    CHECK (octet_length(convert_to(original_filename,'UTF8')) BETWEEN 1 AND 255
      AND original_filename=btrim(original_filename)),
  media_type text NOT NULL
    CHECK (media_type IN ('image/jpeg','image/png','image/webp','video/mp4','video/webm')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  access_revision integer NOT NULL CHECK (access_revision BETWEEN 1 AND 2147483646),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (athlete_id,id),
  FOREIGN KEY (athlete_id,activity_id) REFERENCES activity_canonical(athlete_id,id),
  CHECK (updated_at>=created_at AND (deleted_at IS NULL OR deleted_at=updated_at)),
  CHECK ((media_kind='image' AND media_type LIKE 'image/%' AND size_bytes<=15728640)
      OR (media_kind='video' AND media_type LIKE 'video/%' AND size_bytes<=67108864))
);
CREATE INDEX gallery_media_item_live ON gallery_media_item(athlete_id,created_at DESC,id)
  WHERE deleted_at IS NULL;
CREATE INDEX gallery_media_item_activity ON gallery_media_item(athlete_id,activity_id)
  WHERE deleted_at IS NULL AND activity_id IS NOT NULL;

-- Derived artifacts (client supplied previews). Deletion of the parent item must
-- queue these refs too, so a stale preview reference cannot outlive the raw item.
CREATE TABLE gallery_media_derivative (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  media_item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind='preview'),
  storage_ref text NOT NULL CHECK (length(storage_ref) BETWEEN 1 AND 512),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,media_item_id,kind),
  FOREIGN KEY (athlete_id,media_item_id) REFERENCES gallery_media_item(athlete_id,id) ON DELETE CASCADE
);

CREATE TABLE gallery_media_object (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  storage_ref text NOT NULL CHECK (length(storage_ref) BETWEEN 1 AND 512),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  media_type text NOT NULL
    CHECK (media_type IN ('image/jpeg','image/png','image/webp','video/mp4','video/webm')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,storage_ref),
  UNIQUE (storage_ref)
);

CREATE TABLE gallery_upload_intent (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  upload_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('create_item','attach_preview')),
  media_item_id uuid NOT NULL,
  temporary_ref text NOT NULL CHECK (length(temporary_ref) BETWEEN 1 AND 512),
  storage_ref text CHECK (storage_ref IS NULL OR length(storage_ref) BETWEEN 1 AND 512),
  media_kind text CHECK (media_kind IS NULL OR media_kind IN ('image','video')),
  -- A preview intent carries the item revision the caller observed. Finalize
  -- re-checks it inside its own transaction so a metadata write that lands
  -- between reservation and finalize cannot be overwritten by a stale preview.
  expected_access_revision integer
    CHECK (expected_access_revision IS NULL OR expected_access_revision BETWEEN 1 AND 2147483646),
  album text CHECK (album IS NULL OR (length(album) BETWEEN 1 AND 100 AND album=btrim(album))),
  caption text CHECK (caption IS NULL OR (length(caption) BETWEEN 1 AND 500 AND caption=btrim(caption))),
  activity_id uuid,
  captured_at timestamptz,
  captured_local_date date,
  original_filename text
    CHECK (original_filename IS NULL
      OR (octet_length(convert_to(original_filename,'UTF8')) BETWEEN 1 AND 255
        AND original_filename=btrim(original_filename))),
  media_type text CHECK (media_type IS NULL
    OR media_type IN ('image/jpeg','image/png','image/webp','video/mp4','video/webm')),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 67108864),
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
  CHECK ((operation='create_item' AND media_kind IS NOT NULL AND expected_access_revision IS NULL)
      OR (operation='attach_preview' AND media_kind IS NULL AND album IS NULL AND caption IS NULL
        AND activity_id IS NULL AND captured_at IS NULL AND captured_local_date IS NULL
        AND expected_access_revision IS NOT NULL)),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
  CHECK ((state='reserved' AND storage_ref IS NULL AND original_filename IS NULL AND media_type IS NULL
        AND size_bytes IS NULL AND content_hash IS NULL AND prepared_at IS NULL AND staged_at IS NULL
        AND finalized_at IS NULL AND failure_code IS NULL)
      OR (state='prepared' AND storage_ref IS NOT NULL AND original_filename IS NOT NULL
        AND media_type IS NOT NULL AND size_bytes IS NOT NULL AND content_hash IS NOT NULL
        AND prepared_at IS NOT NULL AND staged_at IS NULL AND finalized_at IS NULL AND failure_code IS NULL)
      OR (state='staged' AND storage_ref IS NOT NULL AND original_filename IS NOT NULL
        AND media_type IS NOT NULL AND size_bytes IS NOT NULL AND content_hash IS NOT NULL
        AND prepared_at IS NOT NULL AND staged_at IS NOT NULL AND finalized_at IS NULL AND failure_code IS NULL)
      OR (state='finalized' AND storage_ref IS NOT NULL AND original_filename IS NOT NULL
        AND media_type IS NOT NULL AND size_bytes IS NOT NULL AND content_hash IS NOT NULL
        AND prepared_at IS NOT NULL AND staged_at IS NOT NULL AND finalized_at IS NOT NULL
        AND failure_code IS NULL)
      OR (state='failed' AND finalized_at IS NULL AND failure_code IS NOT NULL)),
  -- Bounded per-format limits are enforced in SQL, not only at the HTTP edge.
  CHECK (media_type IS NULL
      OR (operation='attach_preview' AND media_type LIKE 'image/%' AND size_bytes<=2097152)
      OR (operation='create_item' AND media_kind='image' AND media_type LIKE 'image/%'
        AND size_bytes<=15728640)
      OR (operation='create_item' AND media_kind='video' AND media_type LIKE 'video/%'
        AND size_bytes<=67108864)),
  CHECK (updated_at>=created_at)
);
CREATE INDEX gallery_upload_intent_pending ON gallery_upload_intent(athlete_id,expires_at,upload_id)
  WHERE state IN ('reserved','prepared','staged');

ALTER TABLE gallery_media_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallery_media_item FORCE ROW LEVEL SECURITY;
CREATE POLICY gallery_media_item_tenant ON gallery_media_item
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE gallery_media_derivative ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallery_media_derivative FORCE ROW LEVEL SECURITY;
CREATE POLICY gallery_media_derivative_tenant ON gallery_media_derivative
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE gallery_media_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallery_media_object FORCE ROW LEVEL SECURITY;
CREATE POLICY gallery_media_object_tenant ON gallery_media_object
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE gallery_upload_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallery_upload_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY gallery_upload_intent_tenant ON gallery_upload_intent
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- Object metadata is immutable. Only account erasure, executed as the table
-- owner, may remove rows.
CREATE FUNCTION gallery_media_object_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_GALLERY_MEDIA_OBJECT';
END $$;
REVOKE ALL ON FUNCTION gallery_media_object_immutable() FROM PUBLIC;
CREATE TRIGGER gallery_media_object_immutable BEFORE UPDATE OR DELETE ON gallery_media_object
  FOR EACH ROW EXECUTE FUNCTION gallery_media_object_immutable();

-- A media item's bytes, owner and capture facts never change. Only the caption,
-- album, activity link and the deletion tombstone advance, each by revision.
CREATE FUNCTION gallery_media_item_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF OLD.deleted_at IS NOT NULL
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.media_kind IS DISTINCT FROM OLD.media_kind
    OR NEW.visibility IS DISTINCT FROM OLD.visibility
    OR NEW.include_for_coach IS DISTINCT FROM OLD.include_for_coach
    OR NEW.storage_ref IS DISTINCT FROM OLD.storage_ref
    OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
    OR NEW.captured_local_date IS DISTINCT FROM OLD.captured_local_date
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.access_revision<>OLD.access_revision+1 OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'INVALID_GALLERY_MEDIA_TRANSITION'; END IF;
  IF NEW.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM NEW.updated_at
  THEN RAISE EXCEPTION 'INVALID_GALLERY_MEDIA_TRANSITION'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gallery_media_item_transition_valid() FROM PUBLIC;
CREATE TRIGGER gallery_media_item_transition BEFORE UPDATE ON gallery_media_item
  FOR EACH ROW EXECUTE FUNCTION gallery_media_item_transition_valid();

CREATE FUNCTION gallery_upload_intent_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.media_item_id IS DISTINCT FROM OLD.media_item_id
    OR NEW.temporary_ref IS DISTINCT FROM OLD.temporary_ref
    OR NEW.media_kind IS DISTINCT FROM OLD.media_kind
    OR NEW.expected_access_revision IS DISTINCT FROM OLD.expected_access_revision
    OR NEW.album IS DISTINCT FROM OLD.album
    OR NEW.caption IS DISTINCT FROM OLD.caption OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
    OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
    OR NEW.captured_local_date IS DISTINCT FROM OLD.captured_local_date
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.updated_at<OLD.updated_at
    OR OLD.state='finalized' OR OLD.state='failed'
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
  THEN RAISE EXCEPTION 'INVALID_GALLERY_UPLOAD_TRANSITION'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gallery_upload_intent_transition_valid() FROM PUBLIC;
CREATE TRIGGER gallery_upload_intent_transition BEFORE UPDATE ON gallery_upload_intent
  FOR EACH ROW EXECUTE FUNCTION gallery_upload_intent_transition_valid();

CREATE FUNCTION public.tombstone_gallery_media_receipts(uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
DECLARE tombstone jsonb;
BEGIN
  SELECT jsonb_build_object('status','deleted','mediaItemId',id::text,
    'deletedAt',to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'accessRevision',access_revision) INTO tombstone
  FROM public.gallery_media_item WHERE athlete_id=tenant AND id=$1 AND deleted_at IS NOT NULL;
  IF tenant IS NULL OR tombstone IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_MEDIA_TOMBSTONE'; END IF;
  UPDATE public.command_receipt SET result=tombstone
    WHERE athlete_id=tenant AND idempotency_key LIKE 'gallery:%'
      AND result->>'mediaItemId'=$1::text;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.tombstone_gallery_media_receipts(uuid) FROM PUBLIC;

CREATE FUNCTION queue_gallery_upload_refs(text,uuid,text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,$3,clock_timestamp(),clock_timestamp()
    FROM public.gallery_upload_intent i
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
REVOKE ALL ON FUNCTION queue_gallery_upload_refs(text,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.fail_gallery_upload(uuid,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE changed boolean;
BEGIN
  IF tenant IS NULL OR length($2) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_GALLERY_UPLOAD_FAILURE'; END IF;
  UPDATE public.gallery_upload_intent SET state='failed',failure_code=$2,updated_at=clock_timestamp()
    WHERE athlete_id=tenant AND upload_id=$1 AND state IN ('reserved','prepared','staged')
    RETURNING true INTO changed;
  IF coalesce(changed,false)=false THEN RETURN false; END IF;
  PERFORM public.queue_gallery_upload_refs(tenant,$1,'upload_abandoned');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fail_gallery_upload(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.expire_gallery_uploads(timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE upload uuid;
DECLARE affected integer:=0;
DECLARE database_now timestamptz:=statement_timestamp();
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_UPLOAD_EXPIRY'; END IF;
  FOR upload IN
    UPDATE public.gallery_upload_intent SET state='failed',failure_code='UPLOAD_EXPIRED',
      updated_at=database_now
    WHERE athlete_id=tenant AND state IN ('reserved','prepared','staged') AND expires_at<=database_now
    RETURNING upload_id
  LOOP
    PERFORM public.queue_gallery_upload_refs(tenant,upload,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.expire_gallery_uploads(timestamptz) FROM PUBLIC;

-- Deletion suppression: every in-flight upload for a deleted item is closed and
-- its refs queued, so a late finalize or retry cannot resurrect the item.
CREATE FUNCTION public.cancel_gallery_uploads(uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE upload uuid;
DECLARE affected integer:=0;
BEGIN
  IF tenant IS NULL OR $2 NOT IN ('MEDIA_DELETED','ACCOUNT_ERASED') THEN
    RAISE EXCEPTION 'INVALID_GALLERY_UPLOAD_CANCELLATION';
  END IF;
  FOR upload IN
    UPDATE public.gallery_upload_intent SET state='failed',failure_code=$2,updated_at=clock_timestamp()
    WHERE athlete_id=tenant AND media_item_id=$1 AND state IN ('reserved','prepared','staged')
    RETURNING upload_id
  LOOP
    PERFORM public.queue_gallery_upload_refs(tenant,upload,
      CASE WHEN $2='ACCOUNT_ERASED' THEN 'account_erased' ELSE 'resource_deleted' END);
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.cancel_gallery_uploads(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.protect_gallery_upload_object(uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE object_ref text;
BEGIN
  SELECT storage_ref INTO object_ref FROM public.gallery_upload_intent
    WHERE athlete_id=tenant AND upload_id=$1 AND state IN ('prepared','staged');
  IF tenant IS NULL OR object_ref IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_UPLOAD_PROTECTION'; END IF;
  IF EXISTS(SELECT 1 FROM public.resource_object_cleanup
    WHERE storage_ref=object_ref AND completed_at IS NULL AND delete_authorized_at IS NOT NULL)
  THEN RAISE EXCEPTION 'OBJECT_DELETE_IN_PROGRESS'; END IF;
  UPDATE public.resource_object_cleanup SET completed_at=clock_timestamp(),lease_owner=NULL,
    lease_until=NULL,delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT'
    WHERE storage_ref=object_ref AND completed_at IS NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.protect_gallery_upload_object(uuid) FROM PUBLIC;

-- Deleting a media item queues the raw object and every derived artifact in the
-- same durable manifest, in one transaction with the tombstone.
CREATE FUNCTION public.enqueue_gallery_media_cleanup(uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
BEGIN
  IF tenant IS NULL OR $2<>'resource_deleted' OR NOT EXISTS(
    SELECT 1 FROM public.gallery_media_item WHERE athlete_id=tenant AND id=$1 AND deleted_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'INVALID_GALLERY_MEDIA_CLEANUP'; END IF;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,$2,clock_timestamp(),clock_timestamp() FROM (
      SELECT storage_ref FROM public.gallery_media_item WHERE athlete_id=tenant AND id=$1
      UNION SELECT storage_ref FROM public.gallery_media_derivative
        WHERE athlete_id=tenant AND media_item_id=$1
    ) refs
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_gallery_media_cleanup(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.compact_gallery_upload_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
BEGIN
  IF tenant IS NULL OR $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_COMPACT_LIMIT'; END IF;
  WITH candidates AS (
    SELECT i.upload_id FROM public.gallery_upload_intent i
    WHERE i.athlete_id=tenant AND i.state='failed'
      AND i.updated_at<statement_timestamp()-interval '7 days'
      AND NOT EXISTS(
        SELECT 1 FROM public.resource_object_cleanup q
        WHERE q.storage_ref IN (i.temporary_ref,i.storage_ref) AND q.completed_at IS NULL
      )
    ORDER BY i.updated_at,i.upload_id LIMIT $1
  )
  DELETE FROM public.gallery_upload_intent i USING candidates c
    WHERE i.athlete_id=tenant AND i.upload_id=c.upload_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.compact_gallery_upload_history(integer) FROM PUBLIC;

-- The existing cleanup worker calls these two entry points. Extending them here
-- keeps one queue and one worker for every private object of a tenant.
CREATE OR REPLACE FUNCTION public.reap_expired_resource_uploads(timestamptz,integer) RETURNS integer
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
  FOR expired IN
    WITH candidates AS (
      SELECT athlete_id,upload_id FROM public.gallery_upload_intent
      WHERE state IN ('reserved','prepared','staged') AND expires_at<=database_now
      ORDER BY expires_at,upload_id FOR UPDATE SKIP LOCKED LIMIT $2
    )
    UPDATE public.gallery_upload_intent i SET state='failed',failure_code='UPLOAD_EXPIRED',updated_at=database_now
    FROM candidates c WHERE i.athlete_id=c.athlete_id AND i.upload_id=c.upload_id
    RETURNING i.athlete_id,i.upload_id
  LOOP
    PERFORM public.queue_gallery_upload_refs(expired.athlete_id,expired.upload_id,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.reap_expired_resource_uploads(timestamptz,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.prune_resource_upload_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE gallery_affected integer;
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
  WITH candidates AS (
    SELECT i.athlete_id,i.upload_id FROM public.gallery_upload_intent i
    WHERE i.state='failed' AND i.updated_at<statement_timestamp()-interval '7 days'
      AND NOT EXISTS(
        SELECT 1 FROM public.resource_object_cleanup q
        WHERE q.storage_ref IN (i.temporary_ref,i.storage_ref) AND q.completed_at IS NULL
      )
    ORDER BY i.updated_at,i.upload_id LIMIT $1
  )
  DELETE FROM public.gallery_upload_intent i USING candidates c
    WHERE i.athlete_id=c.athlete_id AND i.upload_id=c.upload_id;
  GET DIAGNOSTICS gallery_affected=ROW_COUNT;
  RETURN affected+gallery_affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_resource_upload_history(integer) FROM PUBLIC;

-- Authorization must also refuse to delete an object a live gallery item or an
-- active gallery upload still references.
CREATE OR REPLACE FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz)
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
  ) OR EXISTS(
    SELECT 1 FROM public.resource_url_artifact a JOIN public.resource r
      ON r.athlete_id=a.athlete_id AND r.id=a.resource_id
      WHERE a.storage_ref=object_ref AND r.deleted_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.resource_url_ingestion u
      WHERE object_ref IN (u.raw_temporary_ref,u.raw_storage_ref,u.parsed_temporary_ref,u.parsed_storage_ref)
        AND u.state IN ('queued','fetching','parsing')
  ) OR EXISTS(
    SELECT 1 FROM public.gallery_media_item m
      WHERE m.storage_ref=object_ref AND m.deleted_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.gallery_media_derivative d JOIN public.gallery_media_item m
      ON m.athlete_id=d.athlete_id AND m.id=d.media_item_id
      WHERE d.storage_ref=object_ref AND m.deleted_at IS NULL
  ) OR EXISTS(
    SELECT 1 FROM public.gallery_upload_intent i
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

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_gallery_media;
REVOKE ALL ON FUNCTION public.erase_account_before_gallery_media(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_gallery_media(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_gallery_media(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE erased_at timestamptz;
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  UPDATE public.gallery_upload_intent SET state='failed',failure_code='ACCOUNT_ERASED',
    updated_at=clock_timestamp()
    WHERE athlete_id=$1 AND state IN ('reserved','prepared','staged');
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'account_erased',clock_timestamp(),clock_timestamp() FROM (
      SELECT storage_ref FROM public.gallery_media_object WHERE athlete_id=$1
      UNION SELECT storage_ref FROM public.gallery_media_item WHERE athlete_id=$1
      UNION SELECT storage_ref FROM public.gallery_media_derivative WHERE athlete_id=$1
      UNION SELECT x.storage_ref FROM public.gallery_upload_intent i
        CROSS JOIN LATERAL (VALUES(i.temporary_ref),(i.storage_ref)) x(storage_ref)
        WHERE i.athlete_id=$1 AND x.storage_ref IS NOT NULL
    ) refs ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,
      completed_at=NULL,delete_authorized_at=NULL,last_error_code=NULL;
  -- Gallery rows reference activity_canonical, so they are removed before the
  -- earlier erasure stages drop the activities they point at.
  DELETE FROM public.gallery_upload_intent WHERE athlete_id=$1;
  DELETE FROM public.gallery_media_derivative WHERE athlete_id=$1;
  DELETE FROM public.gallery_media_item WHERE athlete_id=$1;
  DELETE FROM public.gallery_media_object WHERE athlete_id=$1;
  erased_at:=public.erase_account_before_gallery_media($1);
  RETURN erased_at;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
