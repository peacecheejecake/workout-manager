-- M2-01c stores the private recorded track of an activity: the original FIT/GPX file as
-- received, the normalized recording and the display geometry the server derived from it.
-- Bytes stay behind opaque server-generated storage references; PostgreSQL owns identity,
-- revisions, quotas and lifecycle only. Object cleanup deliberately reuses the durable
-- resource_object_cleanup manifest of M2-04b so one worker still drains every private
-- object of a tenant, with one lease discipline and one dead-letter path.

-- Deleting an activity and superseding a track are new reasons for the existing queue.
ALTER TABLE resource_object_cleanup DROP CONSTRAINT resource_object_cleanup_reason_check;
ALTER TABLE resource_object_cleanup ADD CONSTRAINT resource_object_cleanup_reason_check
  CHECK (reason IN ('resource_deleted','account_erased','upload_abandoned',
    'activity_deleted','track_superseded'));

CREATE TABLE activity_track_object (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  storage_ref text NOT NULL CHECK (length(storage_ref) BETWEEN 1 AND 512),
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('raw','normalized','map_path')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 33554432),
  media_type text NOT NULL
    CHECK (media_type IN ('application/octet-stream','application/gpx+xml','application/json')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,storage_ref),
  UNIQUE (storage_ref),
  CHECK ((artifact_kind='raw' AND media_type<>'application/json')
      OR (artifact_kind<>'raw' AND media_type='application/json' AND size_bytes<=8388608))
);

-- One stored track per activity. The head names the current revision; it never carries
-- the revision's own facts, so advancing the head cannot rewrite history.
CREATE TABLE activity_track (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  activity_id uuid NOT NULL,
  track_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('fit','fixture','manual')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  track_revision integer NOT NULL CHECK (track_revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,activity_id),
  UNIQUE (athlete_id,track_id),
  FOREIGN KEY (athlete_id,activity_id) REFERENCES activity_canonical(athlete_id,id),
  FOREIGN KEY (athlete_id,source_kind,source_id)
    REFERENCES activity_source_head(athlete_id,kind,source_id),
  CHECK (updated_at>=created_at)
);

-- Immutable revisions. A re-parse that changes sample correspondence appends one of these;
-- it never edits an existing row, which is what the append-only trigger below enforces.
CREATE TABLE activity_track_revision (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  activity_id uuid NOT NULL,
  track_id uuid NOT NULL,
  track_revision integer NOT NULL CHECK (track_revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('fit','fixture','manual')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  source_revision integer NOT NULL CHECK (source_revision BETWEEN 1 AND 2147483646),
  recorded_source_kind text NOT NULL CHECK (recorded_source_kind IN ('fit-session','gpx-trk')),
  parser_id text NOT NULL
    CHECK (parser_id IN ('fit-track-v1','gpx-track-v1','fit-python-export-v1')),
  parser_version integer NOT NULL CHECK (parser_version=1),
  -- SHA-256 over parser identity, every sample id/index/instant/position/detail link and
  -- the segment split. Equal digests mean the same correspondence; a different digest is
  -- a different revision.
  correspondence_digest text NOT NULL CHECK (correspondence_digest ~ '^[a-f0-9]{64}$'),
  format text NOT NULL CHECK (format IN ('fit','gpx')),
  original_filename text CHECK (original_filename IS NULL
    OR (octet_length(convert_to(original_filename,'UTF8')) BETWEEN 1 AND 1024
      AND original_filename=btrim(original_filename))),
  raw_storage_ref text NOT NULL CHECK (length(raw_storage_ref) BETWEEN 1 AND 512),
  raw_size_bytes bigint NOT NULL CHECK (raw_size_bytes BETWEEN 1 AND 33554432),
  raw_content_hash text NOT NULL CHECK (raw_content_hash ~ '^[a-f0-9]{64}$'),
  normalized_storage_ref text NOT NULL CHECK (length(normalized_storage_ref) BETWEEN 1 AND 512),
  normalized_size_bytes bigint NOT NULL CHECK (normalized_size_bytes BETWEEN 1 AND 8388608),
  normalized_content_hash text NOT NULL CHECK (normalized_content_hash ~ '^[a-f0-9]{64}$'),
  map_path_storage_ref text NOT NULL CHECK (length(map_path_storage_ref) BETWEEN 1 AND 512),
  map_path_size_bytes bigint NOT NULL CHECK (map_path_size_bytes BETWEEN 1 AND 8388608),
  map_path_content_hash text NOT NULL CHECK (map_path_content_hash ~ '^[a-f0-9]{64}$'),
  sample_count integer NOT NULL CHECK (sample_count BETWEEN 1 AND 200000),
  positioned_sample_count integer NOT NULL CHECK (positioned_sample_count BETWEEN 0 AND 200000),
  segment_count integer NOT NULL CHECK (segment_count BETWEEN 1 AND 2000),
  segment_policy jsonb NOT NULL
    CHECK (jsonb_typeof(segment_policy)='object' AND octet_length(segment_policy::text)<=1024),
  distances jsonb NOT NULL
    CHECK (jsonb_typeof(distances)='object' AND octet_length(distances::text)<=1024),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,activity_id,track_revision),
  UNIQUE (athlete_id,revision_id),
  UNIQUE (athlete_id,upload_id),
  FOREIGN KEY (athlete_id,activity_id) REFERENCES activity_track(athlete_id,activity_id),
  FOREIGN KEY (athlete_id,raw_storage_ref) REFERENCES activity_track_object(athlete_id,storage_ref)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (athlete_id,normalized_storage_ref)
    REFERENCES activity_track_object(athlete_id,storage_ref) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (athlete_id,map_path_storage_ref)
    REFERENCES activity_track_object(athlete_id,storage_ref) DEFERRABLE INITIALLY DEFERRED,
  CHECK (positioned_sample_count<=sample_count),
  CHECK (raw_storage_ref<>normalized_storage_ref AND raw_storage_ref<>map_path_storage_ref
    AND normalized_storage_ref<>map_path_storage_ref)
);
ALTER TABLE activity_track ADD CONSTRAINT activity_track_revision_fk
  FOREIGN KEY (athlete_id,activity_id,track_revision)
  REFERENCES activity_track_revision(athlete_id,activity_id,track_revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX activity_track_revision_track ON activity_track_revision(athlete_id,track_id,track_revision);

-- Reserve → prepared → staged → finalized. Every object reference is recorded before the
-- object exists, so an interrupted upload always leaves refs the manifest can reclaim by
-- exact key. The track revision is fixed at reservation and re-checked at finalize, so two
-- concurrent uploads for one activity cannot both claim the same revision.
CREATE TABLE activity_track_upload_intent (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  upload_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  activity_id uuid NOT NULL,
  track_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('fit','fixture','manual')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  source_revision integer NOT NULL CHECK (source_revision BETWEEN 1 AND 2147483646),
  expected_activity_revision integer NOT NULL
    CHECK (expected_activity_revision BETWEEN 1 AND 2147483646),
  recorded_track_index integer NOT NULL CHECK (recorded_track_index BETWEEN 0 AND 63),
  track_revision integer NOT NULL CHECK (track_revision BETWEEN 1 AND 2147483646),
  raw_temporary_ref text NOT NULL CHECK (length(raw_temporary_ref) BETWEEN 1 AND 512),
  normalized_temporary_ref text NOT NULL CHECK (length(normalized_temporary_ref) BETWEEN 1 AND 512),
  map_path_temporary_ref text NOT NULL CHECK (length(map_path_temporary_ref) BETWEEN 1 AND 512),
  raw_storage_ref text CHECK (raw_storage_ref IS NULL OR length(raw_storage_ref) BETWEEN 1 AND 512),
  normalized_storage_ref text
    CHECK (normalized_storage_ref IS NULL OR length(normalized_storage_ref) BETWEEN 1 AND 512),
  map_path_storage_ref text
    CHECK (map_path_storage_ref IS NULL OR length(map_path_storage_ref) BETWEEN 1 AND 512),
  format text CHECK (format IS NULL OR format IN ('fit','gpx')),
  recorded_source_kind text
    CHECK (recorded_source_kind IS NULL OR recorded_source_kind IN ('fit-session','gpx-trk')),
  parser_id text CHECK (parser_id IS NULL
    OR parser_id IN ('fit-track-v1','gpx-track-v1','fit-python-export-v1')),
  parser_version integer CHECK (parser_version IS NULL OR parser_version=1),
  correspondence_digest text
    CHECK (correspondence_digest IS NULL OR correspondence_digest ~ '^[a-f0-9]{64}$'),
  original_filename text CHECK (original_filename IS NULL
    OR (octet_length(convert_to(original_filename,'UTF8')) BETWEEN 1 AND 1024
      AND original_filename=btrim(original_filename))),
  raw_size_bytes bigint CHECK (raw_size_bytes IS NULL OR raw_size_bytes BETWEEN 1 AND 33554432),
  raw_content_hash text CHECK (raw_content_hash IS NULL OR raw_content_hash ~ '^[a-f0-9]{64}$'),
  normalized_size_bytes bigint
    CHECK (normalized_size_bytes IS NULL OR normalized_size_bytes BETWEEN 1 AND 8388608),
  normalized_content_hash text
    CHECK (normalized_content_hash IS NULL OR normalized_content_hash ~ '^[a-f0-9]{64}$'),
  map_path_size_bytes bigint
    CHECK (map_path_size_bytes IS NULL OR map_path_size_bytes BETWEEN 1 AND 8388608),
  map_path_content_hash text
    CHECK (map_path_content_hash IS NULL OR map_path_content_hash ~ '^[a-f0-9]{64}$'),
  sample_count integer CHECK (sample_count IS NULL OR sample_count BETWEEN 1 AND 200000),
  positioned_sample_count integer
    CHECK (positioned_sample_count IS NULL OR positioned_sample_count BETWEEN 0 AND 200000),
  segment_count integer CHECK (segment_count IS NULL OR segment_count BETWEEN 1 AND 2000),
  segment_policy jsonb CHECK (segment_policy IS NULL
    OR (jsonb_typeof(segment_policy)='object' AND octet_length(segment_policy::text)<=1024)),
  distances jsonb CHECK (distances IS NULL
    OR (jsonb_typeof(distances)='object' AND octet_length(distances::text)<=1024)),
  state text NOT NULL CHECK (state IN ('reserved','prepared','staged','finalized','failed')),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 100),
  -- Writer fence. Preparation hands a request the right to publish the three final objects
  -- for a bounded window. Object cleanup defers while this window is open, because a writer
  -- that is still publishing may not have created its objects yet: deleting "nothing" now
  -- would leave them behind with their queue rows already completed.
  publication_lease_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  prepared_at timestamptz,
  staged_at timestamptz,
  finalized_at timestamptz,
  PRIMARY KEY (athlete_id,upload_id),
  UNIQUE (athlete_id,idempotency_key),
  CHECK (publication_lease_until IS NULL
    OR (state<>'reserved' AND publication_lease_until<=prepared_at+interval '10 minutes')),
  FOREIGN KEY (athlete_id,activity_id) REFERENCES activity_canonical(athlete_id,id),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
  CHECK (updated_at>=created_at),
  CHECK (raw_temporary_ref<>normalized_temporary_ref
    AND raw_temporary_ref<>map_path_temporary_ref
    AND normalized_temporary_ref<>map_path_temporary_ref),
  CHECK ((state='reserved' AND raw_storage_ref IS NULL AND normalized_storage_ref IS NULL
        AND map_path_storage_ref IS NULL AND format IS NULL AND recorded_source_kind IS NULL
        AND parser_id IS NULL AND parser_version IS NULL AND correspondence_digest IS NULL
        AND original_filename IS NULL AND raw_size_bytes IS NULL AND raw_content_hash IS NULL
        AND normalized_size_bytes IS NULL AND normalized_content_hash IS NULL
        AND map_path_size_bytes IS NULL AND map_path_content_hash IS NULL
        AND sample_count IS NULL AND positioned_sample_count IS NULL AND segment_count IS NULL
        AND segment_policy IS NULL AND distances IS NULL
        AND prepared_at IS NULL AND staged_at IS NULL AND finalized_at IS NULL
        AND failure_code IS NULL)
      OR (state IN ('prepared','staged','finalized') AND raw_storage_ref IS NOT NULL
        AND normalized_storage_ref IS NOT NULL AND map_path_storage_ref IS NOT NULL
        AND format IS NOT NULL AND recorded_source_kind IS NOT NULL AND parser_id IS NOT NULL
        AND parser_version IS NOT NULL AND correspondence_digest IS NOT NULL
        AND raw_size_bytes IS NOT NULL AND raw_content_hash IS NOT NULL
        AND normalized_size_bytes IS NOT NULL AND normalized_content_hash IS NOT NULL
        AND map_path_size_bytes IS NOT NULL AND map_path_content_hash IS NOT NULL
        AND sample_count IS NOT NULL AND positioned_sample_count IS NOT NULL
        AND segment_count IS NOT NULL AND segment_policy IS NOT NULL AND distances IS NOT NULL
        AND prepared_at IS NOT NULL AND failure_code IS NULL
        AND (state<>'prepared' OR (staged_at IS NULL AND finalized_at IS NULL))
        AND (state<>'staged' OR (staged_at IS NOT NULL AND finalized_at IS NULL))
        AND (state<>'finalized' OR (staged_at IS NOT NULL AND finalized_at IS NOT NULL)))
      OR (state='failed' AND finalized_at IS NULL AND failure_code IS NOT NULL))
);
CREATE INDEX activity_track_upload_intent_pending
  ON activity_track_upload_intent(expires_at,upload_id)
  WHERE state IN ('reserved','prepared','staged');

DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['activity_track','activity_track_revision',
    'activity_track_object','activity_track_upload_intent'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY activity_track_tenant ON %I USING (athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',table_name);
  END LOOP;
END
$migration$;

-- Object metadata is written once. Only the owner may delete it, and only for its own
-- tenant, which is what account erasure does.
CREATE FUNCTION activity_track_object_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_ACTIVITY_TRACK_OBJECT';
END $$;
REVOKE ALL ON FUNCTION activity_track_object_immutable() FROM PUBLIC;
CREATE TRIGGER activity_track_object_immutable BEFORE UPDATE OR DELETE ON activity_track_object
  FOR EACH ROW EXECUTE FUNCTION activity_track_object_immutable();

-- A stored revision is never edited. This is the enforcement of M2-01a's carried-forward
-- rule: a re-parse whose sample correspondence differs appends the next revision, and no
-- statement can turn an existing revision into a different recording.
CREATE FUNCTION activity_track_revision_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_ACTIVITY_TRACK_REVISION';
END $$;
REVOKE ALL ON FUNCTION activity_track_revision_append_only() FROM PUBLIC;
CREATE TRIGGER activity_track_revision_append_only
  BEFORE UPDATE OR DELETE ON activity_track_revision
  FOR EACH ROW EXECUTE FUNCTION activity_track_revision_append_only();

-- Ingestion must not bypass deletion suppression, whatever calls it. A deleted activity
-- and a suppressed source are refused here, in the database, rather than only in the
-- application path that happens to be in front of it today.
CREATE FUNCTION activity_track_ingestion_allowed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.activity_canonical c
    WHERE c.athlete_id=NEW.athlete_id AND c.id=NEW.activity_id AND c.deleted)
  THEN RAISE EXCEPTION 'ACTIVITY_DELETED'; END IF;
  IF EXISTS(SELECT 1 FROM public.activity_suppression s
    WHERE s.athlete_id=NEW.athlete_id AND s.kind=NEW.source_kind AND s.source_id=NEW.source_id)
  THEN RAISE EXCEPTION 'ACTIVITY_SOURCE_SUPPRESSED'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION activity_track_ingestion_allowed() FROM PUBLIC;
CREATE TRIGGER activity_track_ingestion_allowed BEFORE INSERT ON activity_track
  FOR EACH ROW EXECUTE FUNCTION activity_track_ingestion_allowed();
CREATE TRIGGER activity_track_revision_ingestion_allowed
  BEFORE INSERT ON activity_track_revision
  FOR EACH ROW EXECUTE FUNCTION activity_track_ingestion_allowed();
CREATE TRIGGER activity_track_upload_ingestion_allowed
  BEFORE INSERT ON activity_track_upload_intent
  FOR EACH ROW EXECUTE FUNCTION activity_track_ingestion_allowed();

-- The head only ever advances by one revision, and only onto a revision of its own track.
CREATE FUNCTION activity_track_head_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
    OR NEW.track_id IS DISTINCT FROM OLD.track_id OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.track_revision<>OLD.track_revision+1 OR NEW.revision_id IS NOT DISTINCT FROM OLD.revision_id
    OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'INVALID_ACTIVITY_TRACK_TRANSITION'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION activity_track_head_transition_valid() FROM PUBLIC;
CREATE TRIGGER activity_track_head_transition BEFORE UPDATE ON activity_track
  FOR EACH ROW EXECUTE FUNCTION activity_track_head_transition_valid();

CREATE FUNCTION activity_track_upload_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  -- One delta is allowed on a closed upload: dropping its publication fence. A writer that
  -- has finished publishing and found itself cancelled relinquishes the fence so the
  -- manifest can reclaim its objects immediately instead of waiting the window out. The
  -- json comparison keeps this to exactly that change — the fence can be given up, never
  -- extended, and nothing else can ride along with it.
  IF OLD.state='failed' AND NEW.state='failed'
    AND OLD.publication_lease_until IS NOT NULL AND NEW.publication_lease_until IS NULL
    AND NEW.updated_at>=OLD.updated_at
    AND (to_jsonb(NEW)-'publication_lease_until'-'updated_at')
      =(to_jsonb(OLD)-'publication_lease_until'-'updated_at')
  THEN RETURN NEW; END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.activity_id IS DISTINCT FROM OLD.activity_id OR NEW.track_id IS DISTINCT FROM OLD.track_id
    OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
    OR NEW.expected_activity_revision IS DISTINCT FROM OLD.expected_activity_revision
    OR NEW.recorded_track_index IS DISTINCT FROM OLD.recorded_track_index
    OR NEW.track_revision IS DISTINCT FROM OLD.track_revision
    OR NEW.raw_temporary_ref IS DISTINCT FROM OLD.raw_temporary_ref
    OR NEW.normalized_temporary_ref IS DISTINCT FROM OLD.normalized_temporary_ref
    OR NEW.map_path_temporary_ref IS DISTINCT FROM OLD.map_path_temporary_ref
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.updated_at<OLD.updated_at
    OR OLD.state='finalized' OR OLD.state='failed'
    OR (OLD.state='reserved' AND NEW.state NOT IN ('prepared','failed'))
    OR (OLD.state='prepared' AND NEW.state NOT IN ('staged','failed'))
    OR (OLD.state='staged' AND NEW.state NOT IN ('finalized','failed'))
    OR (OLD.state='reserved' AND NEW.state='failed' AND (
      NEW.raw_storage_ref IS NOT NULL OR NEW.normalized_storage_ref IS NOT NULL
      OR NEW.map_path_storage_ref IS NOT NULL OR NEW.prepared_at IS NOT NULL
      OR NEW.staged_at IS NOT NULL))
    -- Once prepared, every published fact is frozen: a later statement may change the
    -- state and the timestamps, never the object references or the parse result.
    OR (OLD.state IN ('prepared','staged') AND (
      NEW.raw_storage_ref IS DISTINCT FROM OLD.raw_storage_ref
      OR NEW.normalized_storage_ref IS DISTINCT FROM OLD.normalized_storage_ref
      OR NEW.map_path_storage_ref IS DISTINCT FROM OLD.map_path_storage_ref
      OR NEW.format IS DISTINCT FROM OLD.format
      OR NEW.recorded_source_kind IS DISTINCT FROM OLD.recorded_source_kind
      OR NEW.parser_id IS DISTINCT FROM OLD.parser_id
      OR NEW.parser_version IS DISTINCT FROM OLD.parser_version
      OR NEW.correspondence_digest IS DISTINCT FROM OLD.correspondence_digest
      OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
      OR NEW.raw_size_bytes IS DISTINCT FROM OLD.raw_size_bytes
      OR NEW.raw_content_hash IS DISTINCT FROM OLD.raw_content_hash
      OR NEW.normalized_size_bytes IS DISTINCT FROM OLD.normalized_size_bytes
      OR NEW.normalized_content_hash IS DISTINCT FROM OLD.normalized_content_hash
      OR NEW.map_path_size_bytes IS DISTINCT FROM OLD.map_path_size_bytes
      OR NEW.map_path_content_hash IS DISTINCT FROM OLD.map_path_content_hash
      OR NEW.sample_count IS DISTINCT FROM OLD.sample_count
      OR NEW.positioned_sample_count IS DISTINCT FROM OLD.positioned_sample_count
      OR NEW.segment_count IS DISTINCT FROM OLD.segment_count
      OR NEW.segment_policy IS DISTINCT FROM OLD.segment_policy
      OR NEW.distances IS DISTINCT FROM OLD.distances
      OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at))
    OR (OLD.state='staged' AND NEW.staged_at IS DISTINCT FROM OLD.staged_at)
    -- The publication fence is granted once, by the statement that prepares the upload. No
    -- later statement may extend it, and a cancelled writer cannot renew its own right to
    -- publish.
    OR (OLD.state<>'reserved'
      AND NEW.publication_lease_until IS DISTINCT FROM OLD.publication_lease_until)
  THEN RAISE EXCEPTION 'INVALID_ACTIVITY_TRACK_UPLOAD_TRANSITION'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION activity_track_upload_transition_valid() FROM PUBLIC;
CREATE TRIGGER activity_track_upload_transition BEFORE UPDATE ON activity_track_upload_intent
  FOR EACH ROW EXECUTE FUNCTION activity_track_upload_transition_valid();

-- Every known ref of one upload, queued by exact key. Temporary and final refs are both
-- recorded before their objects exist, so an interrupted publish is still reclaimable.
CREATE FUNCTION queue_activity_track_upload_refs(text,uuid,text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,$3,clock_timestamp(),clock_timestamp()
    FROM public.activity_track_upload_intent i
    CROSS JOIN LATERAL (VALUES(i.raw_temporary_ref),(i.normalized_temporary_ref),
      (i.map_path_temporary_ref),(i.raw_storage_ref),(i.normalized_storage_ref),
      (i.map_path_storage_ref)) refs(storage_ref)
    WHERE i.athlete_id=$1 AND i.upload_id=$2 AND refs.storage_ref IS NOT NULL
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION queue_activity_track_upload_refs(text,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.fail_activity_track_upload(uuid,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE changed boolean;
BEGIN
  IF tenant IS NULL OR length($2) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_ACTIVITY_TRACK_UPLOAD_FAILURE';
  END IF;
  UPDATE public.activity_track_upload_intent SET state='failed',failure_code=$2,
    updated_at=clock_timestamp()
    WHERE athlete_id=tenant AND upload_id=$1 AND state IN ('reserved','prepared','staged')
    RETURNING true INTO changed;
  IF coalesce(changed,false)=false THEN RETURN false; END IF;
  PERFORM public.queue_activity_track_upload_refs(tenant,$1,'upload_abandoned');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fail_activity_track_upload(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.expire_activity_track_uploads(timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE upload uuid;
DECLARE affected integer:=0;
-- Expiry is judged by the database clock, never by a caller-supplied instant.
DECLARE database_now timestamptz:=statement_timestamp();
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ACTIVITY_TRACK_UPLOAD_EXPIRY'; END IF;
  FOR upload IN
    UPDATE public.activity_track_upload_intent SET state='failed',failure_code='UPLOAD_EXPIRED',
      updated_at=database_now
    WHERE athlete_id=tenant AND state IN ('reserved','prepared','staged')
      AND expires_at<=database_now
    RETURNING upload_id
  LOOP
    PERFORM public.queue_activity_track_upload_refs(tenant,upload,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.expire_activity_track_uploads(timestamptz) FROM PUBLIC;

CREATE FUNCTION public.cancel_activity_track_uploads(text,uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE upload uuid;
DECLARE affected integer:=0;
BEGIN
  -- The tenant is an argument so a trigger can pass the row it is closing, but it must
  -- still be the session's own tenant: this function never reaches across tenants.
  IF $1 IS NULL OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    OR $3 NOT IN ('ACTIVITY_DELETED','ACCOUNT_ERASED') THEN
    RAISE EXCEPTION 'INVALID_ACTIVITY_TRACK_UPLOAD_CANCELLATION';
  END IF;
  FOR upload IN
    UPDATE public.activity_track_upload_intent SET state='failed',failure_code=$3,
      updated_at=clock_timestamp()
    WHERE athlete_id=$1 AND ($2 IS NULL OR activity_id=$2)
      AND state IN ('reserved','prepared','staged')
    RETURNING upload_id
  LOOP
    PERFORM public.queue_activity_track_upload_refs($1,upload,
      CASE WHEN $3='ACCOUNT_ERASED' THEN 'account_erased' ELSE 'activity_deleted' END);
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.cancel_activity_track_uploads(text,uuid,text) FROM PUBLIC;

-- Claim the objects of an upload that is about to become a live revision. A queued
-- deletion that has not been authorized yet is closed as REFERENCE_PRESENT; one that is
-- already authorized makes the caller retry rather than racing the delete.
CREATE FUNCTION public.protect_activity_track_upload_objects(uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE refs text[];
BEGIN
  SELECT ARRAY[i.raw_storage_ref,i.normalized_storage_ref,i.map_path_storage_ref] INTO refs
    FROM public.activity_track_upload_intent i
    WHERE i.athlete_id=tenant AND i.upload_id=$1 AND i.state IN ('prepared','staged');
  IF tenant IS NULL OR refs IS NULL OR array_position(refs,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_ACTIVITY_TRACK_UPLOAD_PROTECTION';
  END IF;
  IF EXISTS(SELECT 1 FROM public.resource_object_cleanup
    WHERE storage_ref=ANY(refs) AND completed_at IS NULL AND delete_authorized_at IS NOT NULL)
  THEN RAISE EXCEPTION 'OBJECT_DELETE_IN_PROGRESS'; END IF;
  UPDATE public.resource_object_cleanup SET completed_at=clock_timestamp(),lease_owner=NULL,
    lease_until=NULL,delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT'
    WHERE storage_ref=ANY(refs) AND completed_at IS NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.protect_activity_track_upload_objects(uuid) FROM PUBLIC;

-- A duplicate upload of a recording the head already holds keeps the existing revision and
-- reclaims the objects it published, instead of appending a second identical revision.
CREATE FUNCTION public.supersede_activity_track_upload_objects(uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ACTIVITY_TRACK_SUPERSEDE'; END IF;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'track_superseded',clock_timestamp(),clock_timestamp()
    FROM public.activity_track_upload_intent i
    CROSS JOIN LATERAL (VALUES(i.raw_temporary_ref),(i.normalized_temporary_ref),
      (i.map_path_temporary_ref),(i.raw_storage_ref),(i.normalized_storage_ref),
      (i.map_path_storage_ref)) refs(storage_ref)
    WHERE i.athlete_id=tenant AND i.upload_id=$1 AND refs.storage_ref IS NOT NULL
      -- Never queue an object a live revision still references: a duplicate upload of the
      -- very same bytes can produce the very same content-addressed key.
      AND NOT EXISTS(SELECT 1 FROM public.activity_track_revision r
        WHERE r.athlete_id=tenant AND refs.storage_ref
          IN (r.raw_storage_ref,r.normalized_storage_ref,r.map_path_storage_ref))
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.supersede_activity_track_upload_objects(uuid) FROM PUBLIC;

-- Bytes this tenant has scheduled for reclamation but that are still on the object store:
-- every track object of theirs with an open cleanup row. Deleting an activity schedules
-- reclamation, it does not perform it, so this is what stands between "the tombstone was
-- written" and "the bytes are gone". The queue itself carries no tenant, so attribution
-- comes from the tenant's own object ledger.
CREATE FUNCTION public.activity_track_pending_cleanup_bytes() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  -- Two ledgers know the size of an object. The object table records anything a revision
  -- ever referenced; the upload intent records what a request published, which is the only
  -- record for objects no revision references — a duplicate upload, an abandoned one, a
  -- publication that lost its race. Both are counted, deduplicated by the final reference,
  -- so an object known to both is counted once.
  --
  -- The temporary and the final reference of one artifact are the same bytes: publication
  -- hard-links the final name and unlinks the temporary one, so at most one exists. They
  -- are therefore one entry, counted when either name is still queued for reclamation.
  WITH artifact AS (
    SELECT x.final_ref,x.temporary_ref,x.size_bytes
    FROM public.activity_track_upload_intent i
    CROSS JOIN LATERAL (VALUES
      (i.raw_storage_ref,i.raw_temporary_ref,i.raw_size_bytes),
      (i.normalized_storage_ref,i.normalized_temporary_ref,i.normalized_size_bytes),
      (i.map_path_storage_ref,i.map_path_temporary_ref,i.map_path_size_bytes))
      x(final_ref,temporary_ref,size_bytes)
    WHERE i.athlete_id=nullif(current_setting('app.athlete_id',true),'')
      AND x.size_bytes IS NOT NULL
  ), unreclaimed AS (
    SELECT coalesce(a.final_ref,a.temporary_ref) AS storage_ref,a.size_bytes FROM artifact a
    WHERE EXISTS(SELECT 1 FROM public.resource_object_cleanup q
      WHERE q.completed_at IS NULL
        AND q.storage_ref IN (a.final_ref,a.temporary_ref))
    UNION ALL
    SELECT o.storage_ref,o.size_bytes FROM public.activity_track_object o
    WHERE o.athlete_id=nullif(current_setting('app.athlete_id',true),'')
      AND EXISTS(SELECT 1 FROM public.resource_object_cleanup q
        WHERE q.storage_ref=o.storage_ref AND q.completed_at IS NULL)
  )
  SELECT coalesce(sum(size_bytes),0)::bigint FROM (
    SELECT storage_ref,max(size_bytes) AS size_bytes FROM unreclaimed GROUP BY storage_ref
  ) deduplicated;
$$;
REVOKE ALL ON FUNCTION public.activity_track_pending_cleanup_bytes() FROM PUBLIC;

-- A writer asks this immediately before it makes any object visible. It answers true only
-- while this upload is still live and still inside the window preparation granted it, so a
-- request that stalled past its fence — or whose upload was cancelled or erased — stops
-- before publishing rather than creating objects the manifest has already accounted for.
CREATE FUNCTION public.activity_track_publication_fence_open(uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.activity_track_upload_intent i
    WHERE i.athlete_id=nullif(current_setting('app.athlete_id',true),'')
      AND i.upload_id=$1 AND i.state IN ('prepared','staged')
      AND i.publication_lease_until>clock_timestamp() AND i.expires_at>clock_timestamp());
$$;
REVOKE ALL ON FUNCTION public.activity_track_publication_fence_open(uuid) FROM PUBLIC;

-- Compensation for a writer that published objects and then found its upload cancelled.
-- Only a closed upload qualifies, so a still-live preparation cannot queue its own objects,
-- and completed queue rows are reopened because the objects they covered exist now.
CREATE FUNCTION public.requeue_activity_track_upload_refs(uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_ACTIVITY_TRACK_REQUEUE'; END IF;
  -- The writer is done publishing, so its fence is given up first: cleanup no longer has
  -- to wait the window out before reclaiming what it published.
  UPDATE public.activity_track_upload_intent SET publication_lease_until=NULL,
    updated_at=greatest(updated_at,clock_timestamp())
    WHERE athlete_id=tenant AND upload_id=$1 AND state='failed'
      AND publication_lease_until IS NOT NULL;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'upload_abandoned',clock_timestamp(),clock_timestamp()
    FROM public.activity_track_upload_intent i
    CROSS JOIN LATERAL (VALUES(i.raw_temporary_ref),(i.normalized_temporary_ref),
      (i.map_path_temporary_ref),(i.raw_storage_ref),(i.normalized_storage_ref),
      (i.map_path_storage_ref)) refs(storage_ref)
    WHERE i.athlete_id=tenant AND i.upload_id=$1 AND i.state='failed'
      AND refs.storage_ref IS NOT NULL
      -- Never queue an object a live revision still references.
      AND NOT EXISTS(SELECT 1 FROM public.activity_track_revision r
        JOIN public.activity_canonical c ON c.athlete_id=r.athlete_id AND c.id=r.activity_id
        WHERE r.athlete_id=tenant AND NOT c.deleted AND refs.storage_ref
          IN (r.raw_storage_ref,r.normalized_storage_ref,r.map_path_storage_ref))
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.requeue_activity_track_upload_refs(uuid) FROM PUBLIC;

-- Deleting an activity reclaims its raw track, normalized data and map derivative in the
-- same transaction as the tombstone, and closes every in-flight upload for it. This runs
-- as a trigger on the tombstone itself so no deletion path can skip it.
CREATE FUNCTION activity_track_cleanup_on_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE upload uuid;
BEGIN
  -- The cancellation is inlined rather than delegated, so this trigger holds whatever
  -- session context the deletion happens in and cannot be disabled by a missing setting.
  FOR upload IN
    UPDATE public.activity_track_upload_intent SET state='failed',failure_code='ACTIVITY_DELETED',
      updated_at=clock_timestamp()
    WHERE athlete_id=NEW.athlete_id AND activity_id=NEW.id
      AND state IN ('reserved','prepared','staged')
    RETURNING upload_id
  LOOP
    PERFORM public.queue_activity_track_upload_refs(NEW.athlete_id,upload,'activity_deleted');
  END LOOP;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'activity_deleted',clock_timestamp(),clock_timestamp()
    FROM public.activity_track_revision r
    CROSS JOIN LATERAL (VALUES(r.raw_storage_ref),(r.normalized_storage_ref),
      (r.map_path_storage_ref)) refs(storage_ref)
    WHERE r.athlete_id=NEW.athlete_id AND r.activity_id=NEW.id
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION activity_track_cleanup_on_delete() FROM PUBLIC;
CREATE TRIGGER activity_track_cleanup_on_delete AFTER UPDATE ON activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION activity_track_cleanup_on_delete();

CREATE FUNCTION public.compact_activity_track_upload_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE affected integer;
BEGIN
  IF tenant IS NULL OR $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_COMPACT_LIMIT'; END IF;
  WITH candidates AS (
    SELECT i.upload_id FROM public.activity_track_upload_intent i
    WHERE i.athlete_id=tenant AND i.state='failed'
      AND i.updated_at<statement_timestamp()-interval '7 days'
      AND NOT EXISTS(
        SELECT 1 FROM public.resource_object_cleanup q
        WHERE q.storage_ref IN (i.raw_temporary_ref,i.normalized_temporary_ref,
          i.map_path_temporary_ref,i.raw_storage_ref,i.normalized_storage_ref,
          i.map_path_storage_ref) AND q.completed_at IS NULL
      )
    ORDER BY i.updated_at,i.upload_id LIMIT $1
  )
  DELETE FROM public.activity_track_upload_intent i USING candidates c
    WHERE i.athlete_id=tenant AND i.upload_id=c.upload_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.compact_activity_track_upload_history(integer) FROM PUBLIC;

-- The existing cleanup worker calls these three entry points. Extending them keeps one
-- queue, one lease discipline and one dead-letter path for every private object.
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
  FOR expired IN
    WITH candidates AS (
      SELECT athlete_id,upload_id FROM public.activity_track_upload_intent
      WHERE state IN ('reserved','prepared','staged') AND expires_at<=database_now
      ORDER BY expires_at,upload_id FOR UPDATE SKIP LOCKED LIMIT $2
    )
    UPDATE public.activity_track_upload_intent i SET state='failed',failure_code='UPLOAD_EXPIRED',
      updated_at=database_now
    FROM candidates c WHERE i.athlete_id=c.athlete_id AND i.upload_id=c.upload_id
    RETURNING i.athlete_id,i.upload_id
  LOOP
    PERFORM public.queue_activity_track_upload_refs(expired.athlete_id,expired.upload_id,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.reap_expired_resource_uploads(timestamptz,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.prune_resource_upload_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE gallery_affected integer;
DECLARE track_affected integer;
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
  WITH candidates AS (
    SELECT i.athlete_id,i.upload_id FROM public.activity_track_upload_intent i
    WHERE i.state='failed' AND i.updated_at<statement_timestamp()-interval '7 days'
      AND NOT EXISTS(
        SELECT 1 FROM public.resource_object_cleanup q
        WHERE q.storage_ref IN (i.raw_temporary_ref,i.normalized_temporary_ref,
          i.map_path_temporary_ref,i.raw_storage_ref,i.normalized_storage_ref,
          i.map_path_storage_ref) AND q.completed_at IS NULL
      )
    ORDER BY i.updated_at,i.upload_id LIMIT $1
  )
  DELETE FROM public.activity_track_upload_intent i USING candidates c
    WHERE i.athlete_id=c.athlete_id AND i.upload_id=c.upload_id;
  GET DIAGNOSTICS track_affected=ROW_COUNT;
  RETURN affected+gallery_affected+track_affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_resource_upload_history(integer) FROM PUBLIC;

-- Authorization must also refuse to delete an object a live track revision or an active
-- track upload still references. This is the re-verification immediately before deletion.
CREATE OR REPLACE FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz)
RETURNS TABLE(id uuid,storage_ref text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE object_ref text;
DECLARE publication_fence timestamptz;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  SELECT q.storage_ref INTO object_ref FROM public.resource_object_cleanup q
    WHERE q.id=$1 AND q.lease_owner=$2 AND q.completed_at IS NULL AND q.lease_until>database_now FOR UPDATE;
  IF object_ref IS NULL THEN RETURN; END IF;
  -- A writer holding an open publication fence may still create this object. Deletion is
  -- deferred to the end of that window instead of being recorded as done: completing the
  -- row now would strand whatever the writer publishes afterwards. The attempt is given
  -- back so waiting never consumes the dead-letter budget.
  -- Only an upload that could still publish is worth waiting for: one that prepared and has
  -- not finished, or one that was cancelled while its writer was mid-publication. A
  -- finalized upload has published everything it ever will, and its objects are protected by
  -- the live revision that references them instead, so a deletion must not wait on its fence.
  SELECT max(i.publication_lease_until) INTO publication_fence
    FROM public.activity_track_upload_intent i
    WHERE i.publication_lease_until>database_now
      AND i.state IN ('prepared','staged','failed')
      AND object_ref IN (i.raw_temporary_ref,
      i.normalized_temporary_ref,i.map_path_temporary_ref,i.raw_storage_ref,
      i.normalized_storage_ref,i.map_path_storage_ref);
  IF publication_fence IS NOT NULL THEN
    UPDATE public.resource_object_cleanup q SET lease_owner=NULL,lease_until=NULL,
      delete_authorized_at=NULL,attempts=greatest(q.attempts-1,0),available_at=publication_fence,
      last_error_code='PUBLICATION_IN_PROGRESS' WHERE q.id=$1;
    RETURN;
  END IF;
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
  ) OR EXISTS(
    SELECT 1 FROM public.activity_track_revision r JOIN public.activity_canonical c
      ON c.athlete_id=r.athlete_id AND c.id=r.activity_id
      WHERE object_ref IN (r.raw_storage_ref,r.normalized_storage_ref,r.map_path_storage_ref)
        AND NOT c.deleted
  ) OR EXISTS(
    SELECT 1 FROM public.activity_track_upload_intent i
      WHERE object_ref IN (i.raw_temporary_ref,i.normalized_temporary_ref,i.map_path_temporary_ref,
        i.raw_storage_ref,i.normalized_storage_ref,i.map_path_storage_ref)
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

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_activity_tracks;
REVOKE ALL ON FUNCTION public.erase_account_before_activity_tracks(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_activity_tracks(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_activity_tracks(text) FROM %I',role_name); END LOOP;
END $$;
-- Erasure removes every track row and queues every object, including the refs of uploads
-- that failed or were abandoned, so no retry can republish or resurrect them afterwards.
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM public.cancel_activity_track_uploads($1,NULL,'ACCOUNT_ERASED');
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'account_erased',clock_timestamp(),clock_timestamp() FROM (
      SELECT storage_ref FROM public.activity_track_object WHERE athlete_id=$1
      UNION SELECT x.storage_ref FROM public.activity_track_revision r
        CROSS JOIN LATERAL (VALUES(r.raw_storage_ref),(r.normalized_storage_ref),
          (r.map_path_storage_ref)) x(storage_ref) WHERE r.athlete_id=$1
      UNION SELECT x.storage_ref FROM public.activity_track_upload_intent i
        CROSS JOIN LATERAL (VALUES(i.raw_temporary_ref),(i.normalized_temporary_ref),
          (i.map_path_temporary_ref),(i.raw_storage_ref),(i.normalized_storage_ref),
          (i.map_path_storage_ref)) x(storage_ref)
        WHERE i.athlete_id=$1 AND x.storage_ref IS NOT NULL
    ) refs ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,
      completed_at=NULL,delete_authorized_at=NULL,last_error_code=NULL;
  -- Track rows reference activity_canonical, so they go before the earlier erasure stages
  -- drop the activities they point at.
  DELETE FROM public.activity_track_upload_intent WHERE athlete_id=$1;
  DELETE FROM public.activity_track_revision WHERE athlete_id=$1;
  DELETE FROM public.activity_track WHERE athlete_id=$1;
  DELETE FROM public.activity_track_object WHERE athlete_id=$1;
  RETURN public.erase_account_before_activity_tracks($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;

-- A cleanup receipt must not close while a request could still create the object it just
-- failed to find. The publication fence gates *entry* to publication; it cannot reach a
-- storage call already in flight, and the object port has no conditional write to make it
-- authoritative. So a stalled request can still make one object visible after its fence —
-- and, as a reproduced case showed, after the upload's own expiry — and a closed receipt
-- would never look at it again.
--
-- The window therefore outlives any possible in-flight publish instead of ending at the
-- upload's expiry: a successful delete re-arms the receipt while the reference belongs to an
-- upload whose publication fence passed less than `publication reclaim grace` ago. The grace
-- is measured against the writer's own deadlines — a 30 s parse timeout inside a 2 minute
-- fence — so an hour is roughly thirty times the longest publish this server will attempt,
-- while still terminating. Account erasure keeps its own thirty-day window unchanged.
CREATE OR REPLACE FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE object_ref text;
DECLARE publication_window boolean;
BEGIN
  SELECT q.storage_ref INTO object_ref FROM public.resource_object_cleanup q WHERE q.id=$1;
  -- Only an upload that could still publish keeps its receipt open: one mid-flight, or one
  -- closed under it while a request was still running. A finalized upload has published
  -- everything it ever will, so its reclaimed objects complete normally. An upload that
  -- never prepared has no final reference to publish, so its own expiry is enough.
  publication_window:=EXISTS(
    SELECT 1 FROM public.activity_track_upload_intent i
    WHERE i.state IN ('prepared','staged','failed')
      AND database_now<coalesce(i.publication_lease_until+interval '1 hour',i.expires_at)
      AND object_ref IN (i.raw_temporary_ref,
      i.normalized_temporary_ref,i.map_path_temporary_ref,i.raw_storage_ref,
      i.normalized_storage_ref,i.map_path_storage_ref));
  UPDATE public.resource_object_cleanup SET
    completed_at=CASE
      WHEN $3 AND NOT publication_window
        AND NOT (reason='account_erased' AND created_at>database_now-interval '30 days')
      THEN database_now ELSE NULL END,
    available_at=CASE
      WHEN $3 AND publication_window THEN database_now+interval '1 minute'
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days'
      THEN database_now+interval '1 hour'
      WHEN $3 THEN available_at
      ELSE database_now+least(attempts,10)*interval '30 seconds' END,
    attempts=CASE
      WHEN $3 AND publication_window THEN 0
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days' THEN 0
      ELSE attempts END,
    last_error_code=CASE
      WHEN $3 AND publication_window THEN 'PUBLICATION_WINDOW_OPEN'
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days'
      THEN 'ERASURE_FENCE_ACTIVE'
      WHEN $3 THEN NULL
      WHEN attempts>=100 THEN 'DEAD_LETTER:'||left(coalesce($4,'OBJECT_DELETE_FAILED'),88)
      ELSE left(coalesce($4,'OBJECT_DELETE_FAILED'),100) END,
    lease_owner=NULL,lease_until=NULL,delete_authorized_at=NULL
  WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL AND lease_until>database_now
    AND delete_authorized_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz) FROM PUBLIC;

-- Reconciliation. A receipt-based guarantee only holds while some receipt is open, and a
-- resumed writer can outlive any window we are willing to keep open. So the object store is
-- also compared against the ledger directly: anything in a tenant's track namespace that no
-- live revision and no still-publishable upload references is queued for reclamation. The
-- sweep is bounded per run and resumable, so it covers the namespace over time without an
-- unbounded scan.
CREATE TABLE activity_track_reconcile_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cursor_key text NOT NULL DEFAULT '' CHECK (length(cursor_key)<=512),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO activity_track_reconcile_state(id) VALUES(true);
ALTER TABLE activity_track_reconcile_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_track_reconcile_state FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.activity_track_reconcile_cursor() RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT cursor_key FROM public.activity_track_reconcile_state WHERE id;
$$;
REVOKE ALL ON FUNCTION public.activity_track_reconcile_cursor() FROM PUBLIC;

CREATE FUNCTION public.advance_activity_track_reconcile_cursor(text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS NULL OR length($1)>512 THEN RAISE EXCEPTION 'INVALID_RECONCILE_CURSOR'; END IF;
  UPDATE public.activity_track_reconcile_state SET cursor_key=$1,updated_at=clock_timestamp()
    WHERE id;
  RETURN $1;
END $$;
REVOKE ALL ON FUNCTION public.advance_activity_track_reconcile_cursor(text) FROM PUBLIC;

-- Queue one object the ledger does not account for. Referenced means: a revision of a live
-- activity points at it, or an upload that can still publish or finalize names it. Anything
-- else is unreferenced, whatever the state of any earlier receipt — and `authorize` still
-- re-verifies live references before a byte is deleted, so this cannot over-delete.
CREATE FUNCTION public.reclaim_unreferenced_activity_track_object(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_RECONCILE_REF';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.activity_track_revision r JOIN public.activity_canonical c
      ON c.athlete_id=r.athlete_id AND c.id=r.activity_id
    WHERE NOT c.deleted
      AND $1 IN (r.raw_storage_ref,r.normalized_storage_ref,r.map_path_storage_ref)
  ) OR EXISTS(
    SELECT 1 FROM public.activity_track_upload_intent i
    WHERE i.state IN ('reserved','prepared','staged') AND i.expires_at>database_now
      AND $1 IN (i.raw_temporary_ref,i.normalized_temporary_ref,i.map_path_temporary_ref,
        i.raw_storage_ref,i.normalized_storage_ref,i.map_path_storage_ref)
  ) OR EXISTS(
    SELECT 1 FROM public.resource_object_cleanup q
    WHERE q.storage_ref=$1 AND q.completed_at IS NULL
  ) THEN RETURN false; END IF;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    VALUES(gen_random_uuid(),$1,'upload_abandoned',database_now,database_now)
    ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,
      created_at=EXCLUDED.created_at,completed_at=NULL,delete_authorized_at=NULL,
      last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.reclaim_unreferenced_activity_track_object(text) FROM PUBLIC;

-- Candidates for reconciliation, taken from the ledger rather than from the object store.
--
-- A directory walk cannot be bounded honestly here: empty directories and non-object files
-- cost work without consuming any budget that counts returned keys, and a namespace that has
-- had objects deleted from it is mostly empty directories. Every reference this server can
-- ever publish is recorded in one of these two tables *before* the object exists, so the
-- ledger is the index to scan: one bounded, ordered, keyset-paginated window per run, and one
-- `stat` per row. What the ledger never recorded is out of scope, and no code path in this
-- milestone can produce such a key.
CREATE FUNCTION public.activity_track_reconcile_candidates(text,integer)
RETURNS TABLE(storage_ref text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT c.storage_ref FROM (
    SELECT o.storage_ref FROM public.activity_track_object o WHERE o.storage_ref>$1
    UNION
    SELECT x.storage_ref FROM public.activity_track_upload_intent i
    CROSS JOIN LATERAL (VALUES(i.raw_storage_ref),(i.normalized_storage_ref),
      (i.map_path_storage_ref),(i.raw_temporary_ref),(i.normalized_temporary_ref),
      (i.map_path_temporary_ref)) x(storage_ref)
    WHERE x.storage_ref IS NOT NULL AND x.storage_ref>$1
  ) c ORDER BY c.storage_ref LIMIT least(greatest($2,1),1000);
$$;
REVOKE ALL ON FUNCTION public.activity_track_reconcile_candidates(text,integer) FROM PUBLIC;

-- A persistent index of every object reference this server has ever recorded.
--
-- Two problems make this table necessary. First, scanning the ledger tables themselves cannot
-- be bounded: measured on real PostgreSQL, one window of a single candidate read 498 rows
-- (381 after deduplication) because the LIMIT can only be applied after the union. Second, an
-- upload row does not live forever — a failed intent is compacted seven days after its
-- receipts close, and an upload that never finalized was never registered anywhere else — so a
-- reference could stop being discoverable while its object could still be created by a writer
-- that has not given up yet.
--
-- This table is the keyset index the sweep reads: one row per reference, primary-keyed by it,
-- with a partial index over the rows still being watched. A window of N candidates reads
-- exactly N rows.
CREATE TABLE activity_track_object_ref (
  storage_ref text PRIMARY KEY CHECK (length(storage_ref) BETWEEN 1 AND 512),
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL,
  -- Set once the object has been observed absent and no writer could still create it. A
  -- settled reference leaves the sweep's window.
  settled_at timestamptz,
  CHECK (settled_at IS NULL OR settled_at>=recorded_at)
);
CREATE INDEX activity_track_object_ref_watched ON activity_track_object_ref(storage_ref)
  WHERE settled_at IS NULL;
ALTER TABLE activity_track_object_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_track_object_ref FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_track_object_ref_tenant ON activity_track_object_ref
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- Existing rows, so the index covers references recorded before this table existed.
INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at)
  SELECT DISTINCT x.storage_ref,i.athlete_id,i.created_at
  FROM activity_track_upload_intent i
  CROSS JOIN LATERAL (VALUES(i.raw_temporary_ref),(i.normalized_temporary_ref),
    (i.map_path_temporary_ref),(i.raw_storage_ref),(i.normalized_storage_ref),
    (i.map_path_storage_ref)) x(storage_ref)
  WHERE x.storage_ref IS NOT NULL
  ON CONFLICT(storage_ref) DO NOTHING;
INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at)
  SELECT o.storage_ref,o.athlete_id,o.created_at FROM activity_track_object o
  ON CONFLICT(storage_ref) DO NOTHING;

-- One bounded, ordered window straight out of the index. The plan is an index range scan
-- reading exactly as many rows as the window asks for.
CREATE OR REPLACE FUNCTION public.activity_track_reconcile_candidates(text,integer)
RETURNS TABLE(storage_ref text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT r.storage_ref FROM public.activity_track_object_ref r
  WHERE r.settled_at IS NULL AND r.storage_ref>$1
  ORDER BY r.storage_ref LIMIT least(greatest($2,1),1000);
$$;
REVOKE ALL ON FUNCTION public.activity_track_reconcile_candidates(text,integer) FROM PUBLIC;

-- Stop watching a reference, but only once every way it could still become an object is
-- closed: the object was observed absent, no cleanup receipt is open for it, no live revision
-- names it, no upload can still publish it, and it has been watched for at least seven days.
-- The seven days are the stated floor — a writer that resumes later than that is outside what
-- this reclaims.
CREATE FUNCTION public.settle_activity_track_object_ref(text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE affected integer;
BEGIN
  IF $1 IS NULL OR length($1) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'INVALID_SETTLE_REF';
  END IF;
  UPDATE public.activity_track_object_ref r SET settled_at=database_now
  WHERE r.storage_ref=$1 AND r.settled_at IS NULL
    AND r.recorded_at<database_now-interval '7 days'
    AND NOT EXISTS(SELECT 1 FROM public.resource_object_cleanup q
      WHERE q.storage_ref=$1 AND q.completed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.activity_track_revision v JOIN public.activity_canonical c
      ON c.athlete_id=v.athlete_id AND c.id=v.activity_id
      WHERE NOT c.deleted
        AND $1 IN (v.raw_storage_ref,v.normalized_storage_ref,v.map_path_storage_ref))
    AND NOT EXISTS(SELECT 1 FROM public.activity_track_upload_intent i
      WHERE database_now<coalesce(i.publication_lease_until+interval '1 hour',i.expires_at)
        AND $1 IN (i.raw_temporary_ref,i.normalized_temporary_ref,i.map_path_temporary_ref,
          i.raw_storage_ref,i.normalized_storage_ref,i.map_path_storage_ref));
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.settle_activity_track_object_ref(text) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_track_object_refs;
REVOKE ALL ON FUNCTION public.erase_account_before_track_object_refs(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_track_object_refs(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_track_object_refs(text) FROM %I',role_name); END LOOP;
END $$;
-- Erasure removes the tenant's reference index with the rest of its rows. Late writes after
-- erasure are covered by the thirty-day account_erased receipt fence instead.
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  DELETE FROM public.activity_track_object_ref WHERE athlete_id=$1;
  RETURN public.erase_account_before_track_object_refs($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
