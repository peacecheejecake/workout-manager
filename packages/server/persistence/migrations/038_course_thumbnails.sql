-- M2-01l stores the map thumbnail of a course as a private derived object.
--
-- M2-01j drew this picture in the browser and stored nothing, which is exactly why it grew
-- no permission, deletion or export surface. Storing it grows all three at once, so every
-- rule that governs the course governs the picture: the owner is derived from the session,
-- the bytes sit behind an authenticated download, deleting the course or the recording it
-- came from reclaims the object, account erasure removes it, and the export carries facts
-- about it rather than the picture itself.
--
-- Three decisions are enforced here rather than in the application in front of them.
--
-- **A thumbnail belongs to a revision, not to a course.** A `course_revision` is immutable,
-- so a picture drawn from one is immutable too: it can never become a stale view of a line
-- that has since been edited or privacy-trimmed. Editing a course appends a revision, which
-- supersedes the previous picture in the same transaction as the edit.
--
-- **Only the newest picture is kept.** Superseding queues the old object for reclamation, so
-- a privacy trim needs no special rule: the pre-trim picture — a drawing of coordinates
-- inside a protected area — is reclaimed by the same path that reclaims a renamed course's,
-- and the download route only ever serves the head. There is at most one live thumbnail per
-- course, which is also what bounds the quota.
--
-- **Rendering cannot fail a course save.** The work is enqueued by a trigger on the revision
-- insert, so no write path can forget it and none can be delayed by it. A render that never
-- happens, cannot happen or keeps failing is a different answer in the read model, never an
-- error on the save.
--
-- Object cleanup reuses the durable `resource_object_cleanup` manifest of M2-04b, extended by
-- M2-01c, so one worker still drains every private object of a tenant under one lease
-- discipline and one dead-letter path.

-- Superseding a picture and deleting a course are new reasons for the existing queue.
ALTER TABLE resource_object_cleanup DROP CONSTRAINT resource_object_cleanup_reason_check;
ALTER TABLE resource_object_cleanup ADD CONSTRAINT resource_object_cleanup_reason_check
  CHECK (reason IN ('resource_deleted','account_erased','upload_abandoned',
    'activity_deleted','track_superseded','course_thumbnail_superseded','course_deleted'));

-- One row per course revision: the render job and its result are the same record.
--
-- Two ledgers would be one ledger too many here. A thumbnail object is never shared: its key
-- names the revision it depicts, and two revisions are two different keys even when their
-- geometry is identical. So the row that owns the job is also the only thing that can
-- reference the object, and "is this object still referenced" is a question about this table
-- alone.
CREATE TABLE course_thumbnail (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  course_revision integer NOT NULL CHECK (course_revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  job_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','rendering','prepared','ready','unavailable',
    'failed','superseded')),
  -- Recorded before the object exists, so an interrupted render always leaves a ref the
  -- manifest can reclaim by exact key.
  temporary_ref text NOT NULL CHECK (length(temporary_ref) BETWEEN 1 AND 512),
  storage_ref text CHECK (storage_ref IS NULL OR length(storage_ref) BETWEEN 1 AND 512),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 65536),
  media_type text CHECK (media_type IS NULL OR media_type='image/svg+xml'),
  viewport integer CHECK (viewport IS NULL OR viewport=100),
  vertex_count integer CHECK (vertex_count IS NULL OR vertex_count BETWEEN 2 AND 400),
  renderer_id text CHECK (renderer_id IS NULL OR renderer_id='course-thumbnail-svg-v1'),
  renderer_version integer CHECK (renderer_version IS NULL OR renderer_version=1),
  -- A permanent refusal, not a failure: a line of fewer than two vertices is a point, and a
  -- picture of a point would be a shape nobody recorded.
  unavailable_reason text
    CHECK (unavailable_reason IS NULL OR unavailable_reason='line_too_short_to_draw'),
  failure_code text CHECK (failure_code IS NULL
    OR (length(failure_code) BETWEEN 1 AND 100 AND failure_code ~ '^[A-Z0-9_:-]+$')),
  failure_retryable boolean NOT NULL DEFAULT false,
  failed_at timestamptz,
  retry_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  lease_owner uuid,
  lease_token uuid,
  lease_until timestamptz,
  -- Writer fence. Preparation hands one render the right to publish its object for a bounded
  -- window. Object cleanup defers while the window is open, because a writer that is still
  -- publishing may not have created its object yet: deleting "nothing" now would leave it
  -- behind with its queue row already completed.
  publication_lease_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ready_at timestamptz,
  superseded_at timestamptz,
  PRIMARY KEY (athlete_id,course_id,course_revision),
  UNIQUE (athlete_id,job_id),
  UNIQUE (temporary_ref),
  UNIQUE (storage_ref),
  FOREIGN KEY (athlete_id,course_id,course_revision)
    REFERENCES course_revision(athlete_id,course_id,course_revision) ON DELETE CASCADE,
  CHECK (updated_at>=created_at),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
  CHECK ((state='ready')=(ready_at IS NOT NULL)),
  CHECK ((state='superseded')=(superseded_at IS NOT NULL)),
  CHECK ((state='unavailable')=(unavailable_reason IS NOT NULL)),
  CHECK ((state='failed')=(failure_code IS NOT NULL)),
  CHECK ((state='failed')=(failed_at IS NOT NULL)),
  CHECK (retry_at IS NULL OR (state='failed' AND failure_retryable AND retry_at>=failed_at)),
  CHECK (state='failed' OR (NOT failure_retryable AND retry_at IS NULL)),
  -- The published facts travel together or not at all.
  CHECK ((storage_ref IS NULL)=(content_hash IS NULL)
    AND (storage_ref IS NULL)=(size_bytes IS NULL)
    AND (storage_ref IS NULL)=(media_type IS NULL)
    AND (storage_ref IS NULL)=(viewport IS NULL)
    AND (storage_ref IS NULL)=(vertex_count IS NULL)
    AND (storage_ref IS NULL)=(renderer_id IS NULL)
    AND (storage_ref IS NULL)=(renderer_version IS NULL)),
  CHECK (state NOT IN ('prepared','ready') OR storage_ref IS NOT NULL),
  CHECK (state<>'queued' OR (storage_ref IS NULL AND lease_owner IS NULL
    AND publication_lease_until IS NULL)),
  CHECK (state<>'unavailable' OR storage_ref IS NULL),
  CHECK ((lease_owner IS NULL)=(lease_token IS NULL)
    AND (lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (publication_lease_until IS NULL
    OR publication_lease_until<=created_at+interval '24 hours'),
  CHECK (temporary_ref<>storage_ref)
);
-- One bounded, ordered window for the render worker.
CREATE INDEX course_thumbnail_claim ON course_thumbnail(updated_at,created_at,job_id)
  WHERE (state IN ('queued','rendering') OR (state='failed' AND failure_retryable))
    AND attempt_count<5;
-- The read path asks one question: what is the head revision's picture.
CREATE INDEX course_thumbnail_course ON course_thumbnail(athlete_id,course_id,course_revision);

ALTER TABLE course_thumbnail ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_thumbnail FORCE ROW LEVEL SECURITY;
CREATE POLICY course_thumbnail_tenant ON course_thumbnail
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- The runtime role reads this table and never writes it: every transition below runs in a
-- bounded SECURITY DEFINER function or in the enqueue trigger. This trigger is what stops a
-- row from being written by anything else, including a future grant mistake.
CREATE FUNCTION course_thumbnail_writer_is_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'COURSE_THUMBNAIL_NOT_WRITABLE';
END $$;
REVOKE ALL ON FUNCTION course_thumbnail_writer_is_owner() FROM PUBLIC;
CREATE TRIGGER course_thumbnail_writer BEFORE INSERT OR UPDATE OR DELETE ON course_thumbnail
  FOR EACH ROW EXECUTE FUNCTION course_thumbnail_writer_is_owner();

-- Queue every known ref of one render by exact key.
--
-- The queued row carries the render's publication fence in its `available_at`. That matters
-- because the row this reads can be gone a moment later: deleting a course or the recording
-- behind it removes the revision, and `course_thumbnail` cascades from it — so the fence
-- that `authorize` and `finish` consult would disappear together with the row, and a writer
-- still inside its publish would leave an object behind a closed receipt. Holding the
-- receipt back until the fence has passed by the same grace M2-01c uses means cleanup never
-- looks at the key until no writer could still be creating it.
--
-- The LEASE is held back the same way, for the state before publication: a render that has
-- not prepared yet has no fence, but it may already have written its temporary object, and
-- its row can cascade away just as easily. Whichever of the two deadlines is later wins.
CREATE FUNCTION queue_course_thumbnail_refs(text,uuid,text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,$3,
      greatest(clock_timestamp(),t.publication_lease_until+interval '1 hour',
        t.lease_until+interval '1 hour'),clock_timestamp()
    FROM public.course_thumbnail t
    CROSS JOIN LATERAL (VALUES(t.temporary_ref),(t.storage_ref)) refs(storage_ref)
    WHERE t.athlete_id=$1 AND t.job_id=$2 AND refs.storage_ref IS NOT NULL
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION queue_course_thumbnail_refs(text,uuid,text) FROM PUBLIC;

-- Every revision of a course whose picture is no longer the head's. Called when a revision is
-- appended and when a course or its recording is reclaimed.
CREATE FUNCTION supersede_course_thumbnails(text,uuid,integer,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job uuid;
DECLARE affected integer:=0;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  FOR job IN
    UPDATE public.course_thumbnail t SET state='superseded',superseded_at=database_now,
      updated_at=greatest(t.updated_at,database_now),failure_retryable=false,retry_at=NULL,
      -- The lease columns are deliberately left alone: a render that is still running must
      -- be able to find its own row here and learn that its course moved on, rather than
      -- being told only that its lease vanished.
      -- Every state CHECK on this table ties a column to exactly one state, so a row that
      -- becomes superseded gives up the facts of the state it left.
      ready_at=NULL,failure_code=NULL,failed_at=NULL,unavailable_reason=NULL
    WHERE t.athlete_id=$1 AND t.course_id=$2 AND t.state<>'superseded'
      AND ($3 IS NULL OR t.course_revision<>$3)
    RETURNING t.job_id
  LOOP
    PERFORM public.queue_course_thumbnail_refs($1,job,$4);
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION supersede_course_thumbnails(text,uuid,integer,text) FROM PUBLIC;

-- Appending a revision asks for its picture, in the same transaction as the revision.
--
-- This is a trigger and not a call in the repository on purpose: a write path cannot forget
-- it, and it cannot be applied to some edits and not others. It must also never be able to
-- fail a course save, so it does exactly two bounded things — supersede the previous picture
-- and insert one queued row — and neither can raise for any input the revision itself
-- accepted.
CREATE FUNCTION enqueue_course_thumbnail_render() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job uuid:=gen_random_uuid();
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  -- Object keys name their tenant by UUID. A tenant identified some other way gets no
  -- stored picture at all, which the read model reports as "none" — an honest absence
  -- rather than a render that is queued forever and fails on every attempt.
  IF NEW.athlete_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RETURN NULL; END IF;
  PERFORM public.supersede_course_thumbnails(NEW.athlete_id,NEW.course_id,NEW.course_revision,
    'course_thumbnail_superseded');
  INSERT INTO public.course_thumbnail(athlete_id,course_id,course_revision,revision_id,job_id,
    state,temporary_ref,created_at,updated_at,expires_at)
  VALUES(NEW.athlete_id,NEW.course_id,NEW.course_revision,NEW.revision_id,job,'queued',
    'private/v1/tenants/'||NEW.athlete_id||'/courses/'||NEW.course_id||'/thumbnails/temporary/'||job,
    database_now,database_now,database_now+interval '1 hour')
  ON CONFLICT(athlete_id,course_id,course_revision) DO NOTHING;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION enqueue_course_thumbnail_render() FROM PUBLIC;
CREATE TRIGGER enqueue_course_thumbnail_render AFTER INSERT ON course_revision
  FOR EACH ROW EXECUTE FUNCTION enqueue_course_thumbnail_render();

-- Stored thumbnail bytes this tenant holds. Only a live picture counts: a superseded or
-- abandoned one is already queued for reclamation.
CREATE FUNCTION public.assert_course_thumbnail_quota(text,bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE held bigint;
BEGIN
  SELECT coalesce(sum(t.size_bytes),0) INTO held FROM public.course_thumbnail t
    WHERE t.athlete_id=$1 AND t.state IN ('prepared','ready');
  IF held+$2>16777216 THEN RAISE EXCEPTION 'COURSE_THUMBNAIL_QUOTA_EXCEEDED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_course_thumbnail_quota(text,bigint) FROM PUBLIC;

-- Claim one render. The geometry travels with the lease because the worker has no table
-- access of its own: it sees exactly the line it is about to draw and nothing else about the
-- tenant.
CREATE FUNCTION public.lease_course_thumbnail_render(uuid,interval)
RETURNS TABLE(athlete_id text,course_id uuid,course_revision integer,revision_id uuid,
  job_id uuid,lease_token uuid,temporary_ref text,geometry jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $2<=interval '0 seconds' OR $2>interval '5 minutes' THEN
    RAISE EXCEPTION 'INVALID_COURSE_THUMBNAIL_LEASE';
  END IF;
  RETURN QUERY WITH candidate AS (
    SELECT t.athlete_id,t.course_id,t.course_revision FROM public.course_thumbnail t
    JOIN public.course c ON c.athlete_id=t.athlete_id AND c.course_id=t.course_id
    WHERE (t.state IN ('queued','rendering')
        OR (t.state='failed' AND t.failure_retryable AND t.retry_at<=database_now))
      AND t.expires_at>database_now AND t.attempt_count<5
      AND (t.lease_until IS NULL OR t.lease_until<=database_now)
      -- Only the head is worth drawing. A revision the course has already moved past is
      -- superseded, not rendered.
      AND c.status='available' AND c.head_revision=t.course_revision
    ORDER BY t.updated_at,t.created_at,t.job_id
    FOR UPDATE OF t SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE public.course_thumbnail t SET state='rendering',
      storage_ref=NULL,content_hash=NULL,size_bytes=NULL,media_type=NULL,viewport=NULL,
      vertex_count=NULL,renderer_id=NULL,renderer_version=NULL,
      failure_code=NULL,failure_retryable=false,failed_at=NULL,retry_at=NULL,
      publication_lease_until=NULL,
      attempt_count=t.attempt_count+1,lease_owner=$1,lease_token=gen_random_uuid(),
      lease_until=database_now+$2,updated_at=database_now
    FROM candidate d WHERE t.athlete_id=d.athlete_id AND t.course_id=d.course_id
      AND t.course_revision=d.course_revision
    RETURNING t.*
  )
  SELECT c.athlete_id,c.course_id,c.course_revision,c.revision_id,c.job_id,c.lease_token,
    c.temporary_ref,r.geometry
  FROM changed c JOIN public.course_revision r ON r.athlete_id=c.athlete_id
    AND r.course_id=c.course_id AND r.course_revision=c.course_revision;
END $$;
REVOKE ALL ON FUNCTION public.lease_course_thumbnail_render(uuid,interval) FROM PUBLIC;

-- Record the object reference BEFORE the object exists, and claim it against cleanup.
--
-- The reference is not taken on trust: it must be exactly the key this tenant, this course,
-- this revision id and this content hash produce, so a leased render cannot name an object
-- belonging to another course or another revision.
CREATE FUNCTION public.prepare_course_thumbnail(uuid,uuid,text,text,bigint,integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row_record public.course_thumbnail%ROWTYPE;
DECLARE expected_ref text;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  SELECT t.* INTO row_record FROM public.course_thumbnail t
    WHERE t.job_id=$1 AND t.lease_token=$2 AND t.state='rendering'
      AND t.lease_until>database_now FOR UPDATE;
  IF row_record.job_id IS NULL THEN RETURN false; END IF;
  IF $4 !~ '^[a-f0-9]{64}$' OR $5 NOT BETWEEN 1 AND 65536 OR $6 NOT BETWEEN 2 AND 400 THEN
    RAISE EXCEPTION 'INVALID_COURSE_THUMBNAIL_PREPARATION';
  END IF;
  expected_ref:='private/v1/tenants/'||row_record.athlete_id||'/courses/'||row_record.course_id
    ||'/thumbnails/revisions/'||row_record.revision_id||'/sha256/'||$4||'.svg';
  IF $3 IS DISTINCT FROM expected_ref THEN
    RAISE EXCEPTION 'INVALID_COURSE_THUMBNAIL_REFERENCE';
  END IF;
  PERFORM public.assert_course_thumbnail_quota(row_record.athlete_id,$5);
  -- A queued deletion that has not been authorized yet is closed as REFERENCE_PRESENT; one
  -- already authorized makes the caller retry rather than racing the delete.
  IF EXISTS(SELECT 1 FROM public.resource_object_cleanup q
    WHERE q.storage_ref=$3 AND q.completed_at IS NULL AND q.delete_authorized_at IS NOT NULL)
  THEN RAISE EXCEPTION 'OBJECT_DELETE_IN_PROGRESS'; END IF;
  UPDATE public.resource_object_cleanup q SET completed_at=database_now,lease_owner=NULL,
    lease_until=NULL,delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT'
    WHERE q.storage_ref=$3 AND q.completed_at IS NULL;
  UPDATE public.course_thumbnail t SET state='prepared',storage_ref=$3,content_hash=$4,
    size_bytes=$5,media_type='image/svg+xml',viewport=100,vertex_count=$6,
    renderer_id='course-thumbnail-svg-v1',renderer_version=1,
    publication_lease_until=database_now+interval '2 minutes',updated_at=database_now
    WHERE t.job_id=$1 AND t.lease_token=$2 AND t.state='rendering';
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.prepare_course_thumbnail(uuid,uuid,text,text,bigint,integer)
  FROM PUBLIC;

-- A writer asks this immediately before it makes the object visible. It answers true only
-- while this render is still live and still inside the window preparation granted it, so a
-- request that stalled past its fence stops before publishing rather than creating an object
-- the manifest has already accounted for.
CREATE FUNCTION public.course_thumbnail_publication_fence_open(uuid,uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM public.course_thumbnail t
    WHERE t.job_id=$1 AND t.lease_token=$2 AND t.state='prepared'
      AND t.publication_lease_until>clock_timestamp() AND t.expires_at>clock_timestamp()
      AND t.lease_until>clock_timestamp());
$$;
REVOKE ALL ON FUNCTION public.course_thumbnail_publication_fence_open(uuid,uuid) FROM PUBLIC;

-- Publish the picture — unless the course moved on while it was being drawn.
--
-- The ownership binding here is structural rather than a check bolted on: appending a
-- revision supersedes every other revision's row in the SAME transaction as the append, so
-- by the time a late render reaches this function its own row already says `superseded`.
-- There is no separate "is this still the head" test, because there is no way for the head
-- to move without this row moving with it — and a redundant second test would be a guard no
-- test could ever make fail.
--
-- The row is found by its job id AND its lease token, so only the writer that drew this
-- picture can conclude anything about it — and because superseding leaves the lease alone,
-- that writer learns WHY it lost rather than only that its lease is gone.
CREATE FUNCTION public.finalize_course_thumbnail(uuid,uuid)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row_record public.course_thumbnail%ROWTYPE;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  SELECT t.* INTO row_record FROM public.course_thumbnail t
    WHERE t.job_id=$1 AND t.lease_token=$2 FOR UPDATE;
  IF row_record.job_id IS NULL THEN RETURN QUERY SELECT 'lease_lost'::text; RETURN; END IF;
  -- Superseding deliberately leaves the lease columns alone, so the writer that was drawing
  -- this revision can still identify its own row and learn WHY it lost.
  IF row_record.state='superseded' THEN RETURN QUERY SELECT 'superseded'::text; RETURN; END IF;
  IF row_record.state<>'prepared' OR row_record.lease_until<=database_now
  THEN RETURN QUERY SELECT 'lease_lost'::text; RETURN; END IF;
  UPDATE public.course_thumbnail t SET state='ready',ready_at=database_now,
    updated_at=database_now,lease_owner=NULL,lease_token=NULL,lease_until=NULL,
    publication_lease_until=NULL
    WHERE t.job_id=$1;
  RETURN QUERY SELECT 'ready'::text;
END $$;
REVOKE ALL ON FUNCTION public.finalize_course_thumbnail(uuid,uuid) FROM PUBLIC;

-- Give a lease back without spending an attempt.
--
-- A worker that is being shut down has not failed: nothing it was asked to do turned out to
-- be impossible, and charging it one of five attempts would let a few restarts abandon a
-- picture that was never tried. So the render goes back to `queued` and its attempt is
-- returned, exactly as M2-04b's derived-cleanup `release` does for the same reason.
--
-- Only a render that has not prepared yet qualifies. Once a final reference is recorded the
-- row owns an object name, and unwinding that is the reaper's job, not a shutdown's.
CREATE FUNCTION public.release_course_thumbnail_render(uuid,uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  UPDATE public.course_thumbnail t SET state='queued',
    lease_owner=NULL,lease_token=NULL,lease_until=NULL,
    attempt_count=greatest(t.attempt_count-1,0),updated_at=clock_timestamp()
    WHERE t.job_id=$1 AND t.lease_token=$2 AND t.state='rendering';
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.release_course_thumbnail_render(uuid,uuid) FROM PUBLIC;

-- A permanent answer. No further attempt is scheduled and nothing was published.
CREATE FUNCTION public.mark_course_thumbnail_unavailable(uuid,uuid,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text;
DECLARE job uuid;
DECLARE affected integer;
BEGIN
  IF $3<>'line_too_short_to_draw' THEN
    RAISE EXCEPTION 'INVALID_COURSE_THUMBNAIL_REFUSAL';
  END IF;
  UPDATE public.course_thumbnail t SET state='unavailable',unavailable_reason=$3,
    storage_ref=NULL,content_hash=NULL,size_bytes=NULL,media_type=NULL,viewport=NULL,
    vertex_count=NULL,renderer_id=NULL,renderer_version=NULL,
    lease_owner=NULL,lease_token=NULL,lease_until=NULL,publication_lease_until=NULL,
    failure_retryable=false,retry_at=NULL,updated_at=clock_timestamp()
    WHERE t.job_id=$1 AND t.lease_token=$2 AND t.state IN ('rendering','prepared')
      AND t.lease_until>clock_timestamp()
    RETURNING t.athlete_id,t.job_id INTO tenant,job;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=0 THEN RETURN false; END IF;
  PERFORM public.queue_course_thumbnail_refs(tenant,job,'upload_abandoned');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.mark_course_thumbnail_unavailable(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.fail_course_thumbnail(uuid,uuid,text,boolean,interval) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text;
DECLARE job uuid;
DECLARE attempts integer;
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $5<interval '0 seconds' OR $5>interval '24 hours' OR (NOT $4 AND $5<>interval '0 seconds')
    OR $3 !~ '^[A-Z0-9_:-]+$' OR length($3) NOT BETWEEN 1 AND 100
  THEN RAISE EXCEPTION 'INVALID_COURSE_THUMBNAIL_FAILURE'; END IF;
  UPDATE public.course_thumbnail t SET state='failed',failure_code=$3,
    failure_retryable=($4 AND t.attempt_count<5),failed_at=database_now,
    retry_at=CASE WHEN $4 AND t.attempt_count<5 THEN database_now+$5 ELSE NULL END,
    lease_owner=NULL,lease_token=NULL,lease_until=NULL,publication_lease_until=NULL,
    updated_at=database_now
    WHERE t.job_id=$1 AND t.lease_token=$2 AND t.state IN ('rendering','prepared')
      AND t.lease_until>database_now
    RETURNING t.athlete_id,t.job_id,t.attempt_count INTO tenant,job,attempts;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=0 THEN RETURN false; END IF;
  -- A retry will build the same object from the same geometry, so its refs stay claimed
  -- until the render gives up for good.
  IF NOT ($4 AND attempts<5) THEN
    PERFORM public.queue_course_thumbnail_refs(tenant,job,'upload_abandoned');
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fail_course_thumbnail(uuid,uuid,text,boolean,interval) FROM PUBLIC;

-- Compensation for a writer that published an object and then found its render closed under
-- it. Only a closed render qualifies, so a still-live preparation cannot queue its own
-- object, and completed queue rows are reopened because the object they covered exists now.
CREATE FUNCTION public.requeue_course_thumbnail_refs(uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  -- The writer is done publishing, so its fence is given up first: cleanup no longer has to
  -- wait the window out before reclaiming what it published.
  UPDATE public.course_thumbnail t SET publication_lease_until=NULL,
    updated_at=greatest(t.updated_at,clock_timestamp())
    WHERE t.job_id=$1 AND t.state IN ('failed','superseded','unavailable')
      AND t.publication_lease_until IS NOT NULL;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'upload_abandoned',clock_timestamp(),
      clock_timestamp()
    FROM public.course_thumbnail t
    CROSS JOIN LATERAL (VALUES(t.temporary_ref),(t.storage_ref)) refs(storage_ref)
    WHERE t.job_id=$1 AND t.state IN ('failed','superseded','unavailable')
      AND refs.storage_ref IS NOT NULL
    ON CONFLICT(storage_ref) DO UPDATE SET
      id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
      available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
      delete_authorized_at=NULL,last_error_code=NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.requeue_course_thumbnail_refs(uuid) FROM PUBLIC;

-- Deleting a course reclaims its picture in the same transaction as the deletion.
--
-- The body below is migration 036's, unchanged — including the order it removes rows in,
-- which is the fix for a reproduced `40P01` and must not be re-derived here. The only
-- addition is the supersede call, and it goes BEFORE the revisions are deleted: the
-- thumbnail rows hang off `course_revision` by a cascading foreign key, so after that
-- delete there is nothing left to read the object references from.
CREATE OR REPLACE FUNCTION public.delete_course(uuid,integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE current_head integer;
DECLARE current_status text;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_COURSE_DELETE'; END IF;
  SELECT c.head_revision,c.status INTO current_head,current_status FROM public.course c
    WHERE c.athlete_id=tenant AND c.course_id=$1 FOR UPDATE;
  IF current_status IS NULL THEN RETURN false; END IF;
  -- A reclaimed course has no revision left to expect; its reference is removed as it is.
  IF current_status='available' AND current_head IS DISTINCT FROM $2 THEN
    RAISE EXCEPTION 'COURSE_REVISION_CONFLICT';
  END IF;
  PERFORM public.supersede_course_thumbnails(tenant,$1,NULL,'course_deleted');
  DELETE FROM public.course_route_candidate_set
    WHERE athlete_id=tenant AND course_id=$1;
  DELETE FROM public.course_route_proposal
    WHERE athlete_id=tenant AND course_id=$1;
  DELETE FROM public.course_revision WHERE athlete_id=tenant AND course_id=$1;
  DELETE FROM public.course WHERE athlete_id=tenant AND course_id=$1;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.delete_course(uuid,integer) FROM PUBLIC;

-- Deleting an activity reclaims the picture of every course derived from its coordinates,
-- in the same transaction as the tombstone. The existing trigger already removes those
-- revisions; the thumbnail rows would go with them through the foreign key, so the objects
-- must be queued first or they would be orphaned on the store.
CREATE OR REPLACE FUNCTION course_reclaim_on_activity_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE affected_course uuid;
BEGIN
  FOR affected_course IN
    SELECT DISTINCT s.course_id FROM public.course_revision_source s
    WHERE s.athlete_id=NEW.athlete_id AND s.activity_id=NEW.id
  LOOP
    PERFORM public.supersede_course_thumbnails(NEW.athlete_id,affected_course,NULL,
      'activity_deleted');
  END LOOP;
  UPDATE public.course c SET status='unavailable',head_revision=NULL,revision_id=NULL,
    unavailable_reason='source_activity_deleted',reclaimed_at=database_now,
    updated_at=greatest(c.updated_at,database_now)
    WHERE c.athlete_id=NEW.athlete_id AND c.status='available'
      AND EXISTS(SELECT 1 FROM public.course_revision_source s
        WHERE s.athlete_id=c.athlete_id AND s.course_id=c.course_id AND s.activity_id=NEW.id);
  DELETE FROM public.course_revision r
    WHERE r.athlete_id=NEW.athlete_id
      AND EXISTS(SELECT 1 FROM public.course_revision_source s
        WHERE s.athlete_id=r.athlete_id AND s.course_id=r.course_id AND s.activity_id=NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION course_reclaim_on_activity_delete() FROM PUBLIC;

-- Authorization must also refuse to delete an object a live thumbnail or an in-flight render
-- still references. This is the re-verification immediately before deletion, and the
-- publication fence is honoured here exactly as M2-01c's is.
CREATE OR REPLACE FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz)
RETURNS TABLE(id uuid,storage_ref text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE object_ref text;
DECLARE publication_fence timestamptz;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  SELECT q.storage_ref INTO object_ref FROM public.resource_object_cleanup q
    WHERE q.id=$1 AND q.lease_owner=$2 AND q.completed_at IS NULL AND q.lease_until>database_now
    FOR UPDATE;
  IF object_ref IS NULL THEN RETURN; END IF;
  -- A writer holding an open publication fence may still create this object. Deletion is
  -- deferred to the end of that window instead of being recorded as done: completing the
  -- row now would strand whatever the writer publishes afterwards. The attempt is given
  -- back so waiting never consumes the dead-letter budget.
  -- Only work that could still publish is worth waiting for: an upload that prepared and
  -- has not finished, or one that was cancelled while its writer was mid-publication. A
  -- finalized upload has published everything it ever will, and its objects are protected by
  -- the live revision that references them instead, so a deletion must not wait on its fence.
  SELECT max(fence) INTO publication_fence FROM (
    SELECT max(i.publication_lease_until) AS fence
      FROM public.activity_track_upload_intent i
      WHERE i.publication_lease_until>database_now
        AND i.state IN ('prepared','staged','failed')
        AND object_ref IN (i.raw_temporary_ref,
        i.normalized_temporary_ref,i.map_path_temporary_ref,i.raw_storage_ref,
        i.normalized_storage_ref,i.map_path_storage_ref)
    UNION ALL
    -- A render mid-publication, or one closed under a writer that was still publishing.
    SELECT max(t.publication_lease_until) AS fence
      FROM public.course_thumbnail t
      WHERE t.publication_lease_until>database_now
        AND t.state IN ('prepared','failed','superseded','unavailable')
        AND object_ref IN (t.temporary_ref,t.storage_ref)
  ) fences;
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
  ) OR EXISTS(
    -- A picture a live course still shows, or one a render can still publish.
    SELECT 1 FROM public.course_thumbnail t
      WHERE (t.storage_ref=object_ref AND t.state IN ('prepared','ready'))
         OR (t.temporary_ref=object_ref AND t.state IN ('queued','rendering','prepared')
           AND t.expires_at>database_now)
  ) THEN
    UPDATE public.resource_object_cleanup q SET completed_at=database_now,lease_owner=NULL,
      lease_until=NULL,delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT'
      WHERE q.id=$1;
    RETURN;
  END IF;
  RETURN QUERY UPDATE public.resource_object_cleanup q SET delete_authorized_at=database_now
    WHERE q.id=$1 RETURNING q.id,q.storage_ref,q.attempts;
END $$;
REVOKE ALL ON FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz) FROM PUBLIC;

-- A cleanup receipt must not close while a render could still create the object it just
-- failed to find. The same reasoning as M2-01c's: the fence gates entry to publication and
-- cannot reach a storage call already in flight, so a successful delete re-arms the receipt
-- while the reference belongs to a render whose fence passed less than an hour ago.
CREATE OR REPLACE FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE object_ref text;
DECLARE publication_window boolean;
BEGIN
  SELECT q.storage_ref INTO object_ref FROM public.resource_object_cleanup q WHERE q.id=$1;
  publication_window:=EXISTS(
    SELECT 1 FROM public.activity_track_upload_intent i
    WHERE i.state IN ('prepared','staged','failed')
      AND database_now<coalesce(i.publication_lease_until+interval '1 hour',i.expires_at)
      AND object_ref IN (i.raw_temporary_ref,
      i.normalized_temporary_ref,i.map_path_temporary_ref,i.raw_storage_ref,
      i.normalized_storage_ref,i.map_path_storage_ref))
    OR EXISTS(
    -- Only a render that was GRANTED publication can have a call in flight. One that never
    -- prepared has no final name to publish, so its receipt closes on the first pass instead
    -- of re-arming for the rest of its hour.
    SELECT 1 FROM public.course_thumbnail t
    WHERE t.state IN ('prepared','failed','superseded','unavailable')
      AND t.publication_lease_until IS NOT NULL
      AND database_now<t.publication_lease_until+interval '1 hour'
      AND object_ref IN (t.temporary_ref,t.storage_ref));
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

-- Renders that stopped being drained, in one bounded pass. Two different things happen to
-- go wrong here and they are answered differently.
--
-- A render whose LEASE expired is a worker that died mid-attempt. It gets another attempt,
-- and its references are queued because a `prepared` render may already have published its
-- object; a retry rebuilds the same content-addressed key and `prepare` claims the receipt
-- back, which is the designed exchange rather than a leak.
--
-- A render whose own deadline passed is over. It fails permanently, its references are
-- queued, and the read model says so — `abandoned`, not `still coming`.
CREATE FUNCTION public.reap_course_thumbnail_renders(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item record;
DECLARE affected integer:=0;
DECLARE database_now timestamptz:=statement_timestamp();
BEGIN
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_REAP_LIMIT'; END IF;
  FOR item IN
    WITH candidates AS (
      SELECT t.athlete_id,t.course_id,t.course_revision FROM public.course_thumbnail t
      WHERE t.state IN ('rendering','prepared') AND t.lease_until<=database_now
        AND t.expires_at>database_now
      ORDER BY t.lease_until,t.job_id FOR UPDATE SKIP LOCKED LIMIT $1
    )
    UPDATE public.course_thumbnail t SET state='failed',failure_code='RENDER_LEASE_EXPIRED',
      failure_retryable=(t.attempt_count<5),
      retry_at=CASE WHEN t.attempt_count<5 THEN database_now ELSE NULL END,
      failed_at=database_now,ready_at=NULL,
      lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=database_now
    FROM candidates c WHERE t.athlete_id=c.athlete_id AND t.course_id=c.course_id
      AND t.course_revision=c.course_revision
    RETURNING t.athlete_id,t.job_id
  LOOP
    PERFORM public.queue_course_thumbnail_refs(item.athlete_id,item.job_id,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  FOR item IN
    WITH candidates AS (
      SELECT t.athlete_id,t.course_id,t.course_revision FROM public.course_thumbnail t
      WHERE (t.state IN ('queued','rendering','prepared')
          OR (t.state='failed' AND t.failure_retryable))
        AND t.expires_at<=database_now
      ORDER BY t.expires_at,t.job_id FOR UPDATE SKIP LOCKED LIMIT $1
    )
    UPDATE public.course_thumbnail t SET state='failed',failure_code='RENDER_EXPIRED',
      failure_retryable=false,retry_at=NULL,failed_at=database_now,ready_at=NULL,
      lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=database_now
    FROM candidates c WHERE t.athlete_id=c.athlete_id AND t.course_id=c.course_id
      AND t.course_revision=c.course_revision
    RETURNING t.athlete_id,t.job_id
  LOOP
    PERFORM public.queue_course_thumbnail_refs(item.athlete_id,item.job_id,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.reap_course_thumbnail_renders(integer) FROM PUBLIC;

-- Housekeeping. A closed render whose objects are already reclaimed stops being interesting.
-- A live picture is never pruned, because it is the picture.
CREATE FUNCTION public.prune_course_thumbnail_history(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_PRUNE_LIMIT'; END IF;
  WITH candidates AS (
    SELECT t.athlete_id,t.course_id,t.course_revision FROM public.course_thumbnail t
    WHERE t.state IN ('superseded','failed') AND NOT t.failure_retryable
      AND t.updated_at<statement_timestamp()-interval '7 days'
      AND NOT EXISTS(
        SELECT 1 FROM public.resource_object_cleanup q
        WHERE q.storage_ref IN (t.temporary_ref,t.storage_ref) AND q.completed_at IS NULL
      )
    ORDER BY t.updated_at,t.job_id LIMIT $1
  )
  DELETE FROM public.course_thumbnail t USING candidates c
    WHERE t.athlete_id=c.athlete_id AND t.course_id=c.course_id
      AND t.course_revision=c.course_revision;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_course_thumbnail_history(integer) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_course_thumbnails;
REVOKE ALL ON FUNCTION public.erase_account_before_course_thumbnails(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_course_thumbnails(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_course_thumbnails(text) FROM %I',role_name); END LOOP;
END $$;
-- Erasure queues every thumbnail ref this tenant ever recorded — live, superseded, abandoned
-- and mid-render alike — and removes the rows before the stage that deletes the revisions
-- they hang from. The lock order is the repository's: the account lock (77206) first, then
-- the per-tenant command lock (0), which is what every ordinary writer holds when it reaches
-- this table. Taking them in the other order is the deadlock M2-01j reproduced.
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'account_erased',
      greatest(clock_timestamp(),t.publication_lease_until+interval '1 hour',
        t.lease_until+interval '1 hour'),clock_timestamp()
    FROM public.course_thumbnail t
    CROSS JOIN LATERAL (VALUES(t.temporary_ref),(t.storage_ref)) refs(storage_ref)
    WHERE t.athlete_id=$1 AND refs.storage_ref IS NOT NULL
    ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,
      created_at=EXCLUDED.created_at,completed_at=NULL,delete_authorized_at=NULL,
      last_error_code=NULL;
  DELETE FROM public.course_thumbnail WHERE athlete_id=$1;
  RETURN public.erase_account_before_course_thumbnails($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
