-- M2-03c: S17 derived gallery renditions (EXIF-oriented preview/thumbnail, H.264 playback).
-- Unregistered extension over the named profile26 parent (source DDL tip 146), applied only
-- as a pinned member of the profile27 current-runtime installer after SQL143. It references
-- no SQL143 object; this file adds no runtime or worker grant.
--
-- Invariants
--  * The original row/bytes stay immutable (031 trigger); a job pins the original's exact
--    SHA-256/size and the item revision observed at enqueue. Settle re-checks both.
--  * A ready output's storage_ref is the exact rendition key of its own tenant, media, kind,
--    job and producing lease (CHECK), so a receipt cannot point at another lineage.
--  * Deletion and account erasure retire every job in the deleting transaction (triggers on
--    gallery_media_item), queue ready outputs for object cleanup and arm a delayed prefix
--    sweep for unreferenced stage objects. Retired jobs are never re-created for a deleted
--    item; a late settle of a retired job is rejected.
--  * Finite cost: at most 3 leased attempts per job; deterministic codec failures and
--    unsupported inputs are terminal and never retried; consent absence postpones.
--  * Original EXIF/GPS is not read or rewritten here; derived outputs never carry metadata
--    (codec recipe). User decision 2026-10-10: originals keep GPS privately on the account,
--    byte-identical; every derived preview/thumbnail/video carries no metadata.
--  * Restore admission: new jobs and every worker RPC require the same CLOSED/no-target/
--    current-generation predicate as SQL143 authoring. A media row inserted while a restore
--    target is pending (restore load) mints no job; jobs are derived and regenerated after
--    admission through enqueue_gallery_renditions_v1. Worker RPCs refuse with
--    RESTORE_PROCESSING_CLOSED instead of leasing, settling or sweeping during a restore.

CREATE TABLE public.gallery_rendition_job (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 job_id uuid NOT NULL,
 media_item_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('image_preview','image_thumbnail','video_playback')),
 recipe_version integer NOT NULL CHECK(recipe_version=1),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 source_byte_size bigint NOT NULL,
 parent_access_revision integer NOT NULL CHECK(parent_access_revision BETWEEN 1 AND 2147483646),
 idempotency_key text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','ready','failed','unsupported')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 available_at timestamptz NOT NULL CHECK(isfinite(available_at)),
 lease_token uuid,
 lease_owner uuid,
 lease_until timestamptz CHECK(lease_until IS NULL OR isfinite(lease_until)),
 output_storage_ref text CHECK(output_storage_ref IS NULL OR length(output_storage_ref) BETWEEN 1 AND 512),
 output_sha256 text CHECK(output_sha256 IS NULL OR output_sha256 ~ '^[a-f0-9]{64}$'),
 output_byte_size bigint,
 output_media_type text,
 output_width integer,
 output_height integer,
 output_duration_seconds double precision,
 failure_code text,
 retry_eligibility text,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK(isfinite(updated_at)),
 PRIMARY KEY(athlete_id,job_id),
 UNIQUE(athlete_id,media_item_id,kind,recipe_version),
 UNIQUE(athlete_id,idempotency_key),
 UNIQUE(output_storage_ref),
 FOREIGN KEY(athlete_id,media_item_id) REFERENCES public.gallery_media_item(athlete_id,id) ON DELETE CASCADE,
 CHECK(idempotency_key='gallery-rendition:v1:'||media_item_id::text||':'||kind),
 CHECK(source_byte_size BETWEEN 1 AND CASE WHEN kind='video_playback' THEN 67108864 ELSE 15728640 END),
 CHECK(updated_at>=created_at),
 CHECK(num_nonnulls(output_storage_ref,output_sha256,output_byte_size,output_media_type,
   output_width,output_height) IN (0,6)),
 CHECK(output_media_type IS NOT NULL OR output_duration_seconds IS NULL),
 CHECK(output_media_type IS NULL
  OR (kind='video_playback' AND output_media_type='video/mp4'
   AND output_byte_size BETWEEN 1 AND 67108864 AND output_width BETWEEN 1 AND 1280
   AND output_height BETWEEN 1 AND 1280 AND output_duration_seconds>0 AND output_duration_seconds<=3600)
  OR (kind='image_preview' AND output_media_type='image/webp'
   AND output_byte_size BETWEEN 1 AND 2097152 AND output_width BETWEEN 1 AND 1600
   AND output_height BETWEEN 1 AND 1600 AND output_duration_seconds IS NULL)
  OR (kind='image_thumbnail' AND output_media_type='image/webp'
   AND output_byte_size BETWEEN 1 AND 2097152 AND output_width BETWEEN 1 AND 320
   AND output_height BETWEEN 1 AND 320 AND output_duration_seconds IS NULL)),
 -- Exact lineage: the receipt names only this tenant/media/kind/job/producing lease.
 CHECK(output_storage_ref IS NULL OR output_storage_ref='private/v1/tenants/'||athlete_id
  ||'/gallery/'||media_item_id::text||'/renditions/v1/'||kind||'/'||job_id::text||'/'
  ||lease_token::text||'/sha256/'||output_sha256
  ||CASE WHEN kind='video_playback' THEN '.mp4' ELSE '.webp' END),
 CHECK((state='queued' AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL
   AND output_storage_ref IS NULL AND failure_code IS NULL AND retry_eligibility IS NULL)
  OR (state='running' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL
   AND lease_until IS NOT NULL AND attempts>=1 AND output_storage_ref IS NULL
   AND failure_code IS NULL AND retry_eligibility IS NULL)
  OR (state='ready' AND lease_token IS NOT NULL AND lease_owner IS NULL AND lease_until IS NULL
   AND attempts>=1 AND output_storage_ref IS NOT NULL AND failure_code IS NULL
   AND retry_eligibility IS NULL)
  OR (state='failed' AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL
   AND output_storage_ref IS NULL AND retry_eligibility='ineligible' AND failure_code IN
   ('input_invalid','input_budget','pixel_budget','invalid_media','decode_failed',
    'output_budget','aborted','timeout','codec_unavailable'))
  OR (state='unsupported' AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL
   AND output_storage_ref IS NULL AND retry_eligibility IS NULL
   AND failure_code IN ('unsupported_format','unsupported_pages')))
);
CREATE INDEX gallery_rendition_job_media ON public.gallery_rendition_job(athlete_id,media_item_id);

-- Cross-tenant due work index (055's tenant_work_index precedent): owner-only, no grant.
CREATE TABLE public.gallery_rendition_due (
 athlete_id text NOT NULL,
 job_id uuid NOT NULL,
 due_at timestamptz NOT NULL CHECK(isfinite(due_at)),
 PRIMARY KEY(athlete_id,job_id),
 FOREIGN KEY(athlete_id,job_id) REFERENCES public.gallery_rendition_job(athlete_id,job_id) ON DELETE CASCADE
);
CREATE INDEX gallery_rendition_due_order ON public.gallery_rendition_due(due_at,athlete_id,job_id);

-- Delayed storage sweeps. A media sweep removes every rendition key of a retired item; an
-- attempt sweep removes only one abandoned lease's stage keys. Rows outlive the media row
-- on purpose (no FK) and are deleted once the sweep completes.
CREATE TABLE public.gallery_rendition_sweep (
 sweep_id uuid PRIMARY KEY,
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 media_item_id uuid NOT NULL,
 job_id uuid,
 attempt_id uuid,
 cause text NOT NULL CHECK(cause IN ('media_deleted','account_erased','attempt_abandoned')),
 available_at timestamptz NOT NULL CHECK(isfinite(available_at)),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 100),
 lease_owner uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL,
 CHECK((cause='attempt_abandoned')=(job_id IS NOT NULL AND attempt_id IS NOT NULL)),
 CHECK(job_id IS NOT NULL OR attempt_id IS NULL),
 CHECK((lease_owner IS NULL)=(lease_until IS NULL))
);
CREATE UNIQUE INDEX gallery_rendition_sweep_media ON public.gallery_rendition_sweep(athlete_id,media_item_id)
 WHERE job_id IS NULL;
CREATE UNIQUE INDEX gallery_rendition_sweep_attempt
 ON public.gallery_rendition_sweep(athlete_id,media_item_id,job_id,attempt_id) WHERE job_id IS NOT NULL;
CREATE INDEX gallery_rendition_sweep_order ON public.gallery_rendition_sweep(available_at,sweep_id);

REVOKE ALL ON public.gallery_rendition_job,public.gallery_rendition_due,public.gallery_rendition_sweep FROM PUBLIC;
ALTER TABLE public.gallery_rendition_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gallery_rendition_job FORCE ROW LEVEL SECURITY;
CREATE POLICY gallery_rendition_job_tenant ON public.gallery_rendition_job
 USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE public.gallery_rendition_due ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gallery_rendition_due FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gallery_rendition_sweep ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gallery_rendition_sweep FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 EXECUTE format('CREATE POLICY gallery_rendition_due_definer ON public.gallery_rendition_due '
  'TO %I USING (true) WITH CHECK (true)', current_user);
 EXECUTE format('CREATE POLICY gallery_rendition_sweep_definer ON public.gallery_rendition_sweep '
  'TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- Lineage is immutable; only the lifecycle advances. Terminal states never change again.
CREATE FUNCTION public.gallery_rendition_job_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'GALLERY_RENDITION_TRUNCATE_FORBIDDEN'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'queued' OR NEW.attempts<>0 THEN RAISE EXCEPTION 'GALLERY_RENDITION_TRANSITION_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
  OR NEW.media_item_id IS DISTINCT FROM OLD.media_item_id OR NEW.kind IS DISTINCT FROM OLD.kind
  OR NEW.recipe_version IS DISTINCT FROM OLD.recipe_version
  OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
  OR NEW.source_byte_size IS DISTINCT FROM OLD.source_byte_size
  OR NEW.parent_access_revision IS DISTINCT FROM OLD.parent_access_revision
  OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.updated_at<OLD.updated_at
  OR NEW.attempts<OLD.attempts
  OR OLD.state IN ('ready','failed','unsupported')
  OR (OLD.state='queued' AND NEW.state NOT IN ('queued','running','failed'))
  OR (OLD.state='running' AND NEW.state NOT IN ('running','queued','ready','failed','unsupported'))
  OR (NEW.state='running' AND (NEW.attempts<>OLD.attempts+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token))
  OR (NEW.state='ready' AND NEW.lease_token IS DISTINCT FROM OLD.lease_token)
 THEN RAISE EXCEPTION 'GALLERY_RENDITION_TRANSITION_INVALID'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.gallery_rendition_job_guard_v1() FROM PUBLIC;
CREATE TRIGGER gallery_rendition_job_guard BEFORE INSERT OR UPDATE ON public.gallery_rendition_job
 FOR EACH ROW EXECUTE FUNCTION public.gallery_rendition_job_guard_v1();
CREATE TRIGGER gallery_rendition_job_no_truncate BEFORE TRUNCATE ON public.gallery_rendition_job
 FOR EACH STATEMENT EXECUTE FUNCTION public.gallery_rendition_job_guard_v1();

-- The due index follows the job in the same transaction.
CREATE FUNCTION public.gallery_rendition_job_due_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NEW.state='queued' OR NEW.state='running' THEN
  INSERT INTO public.gallery_rendition_due(athlete_id,job_id,due_at)
   VALUES(NEW.athlete_id,NEW.job_id,CASE WHEN NEW.state='queued' THEN NEW.available_at ELSE NEW.lease_until END)
   ON CONFLICT(athlete_id,job_id) DO UPDATE SET due_at=EXCLUDED.due_at;
 ELSE
  DELETE FROM public.gallery_rendition_due WHERE athlete_id=NEW.athlete_id AND job_id=NEW.job_id;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.gallery_rendition_job_due_v1() FROM PUBLIC;
CREATE TRIGGER gallery_rendition_job_due AFTER INSERT OR UPDATE ON public.gallery_rendition_job
 FOR EACH ROW EXECUTE FUNCTION public.gallery_rendition_job_due_v1();

-- Same predicate as SQL143 require_gallery_navigation_authoring_v1: the CLOSED control has
-- no pending restore target and belongs to the current restore generation. Holding the
-- global fence alone is never admission.
CREATE FUNCTION public.gallery_rendition_processing_admitted_v1() RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r jsonb;
BEGIN
 r:=public.read_restore_processing_admission();
 IF r IS NULL OR r->>'state' IS DISTINCT FROM 'CLOSED'
  OR r->'targetNonce' IS DISTINCT FROM 'null'::jsonb
  OR r->'targetIncarnation' IS DISTINCT FROM 'null'::jsonb
  OR r->>'generationId' IS DISTINCT FROM public.current_restore_generation()::text
 THEN RETURN false; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.gallery_rendition_processing_admitted_v1() FROM PUBLIC;
CREATE FUNCTION public.require_gallery_rendition_processing_v1() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NOT public.gallery_rendition_processing_admitted_v1() THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CLOSED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.require_gallery_rendition_processing_v1() FROM PUBLIC;

-- Internal: create this item's recipe-v1 jobs. Caller has set the tenant.
CREATE FUNCTION public.gallery_rendition_insert_jobs_v1(tenant text,media uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE item public.gallery_media_item%ROWTYPE; affected integer; stamp timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO item FROM public.gallery_media_item WHERE athlete_id=tenant AND id=media;
 IF NOT FOUND OR item.deleted_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=tenant) THEN RETURN 0; END IF;
 INSERT INTO public.gallery_rendition_job(athlete_id,job_id,media_item_id,kind,recipe_version,
  source_sha256,source_byte_size,parent_access_revision,idempotency_key,state,attempts,
  available_at,created_at,updated_at)
 SELECT tenant,gen_random_uuid(),item.id,k.kind,1,item.content_hash,item.size_bytes,
  item.access_revision,'gallery-rendition:v1:'||item.id::text||':'||k.kind,'queued',0,stamp,stamp,stamp
 FROM (VALUES('image_preview',1),('image_thumbnail',2),('video_playback',3)) k(kind,ord)
 WHERE (item.media_kind='image' AND k.kind<>'video_playback')
  OR (item.media_kind='video' AND k.kind='video_playback')
 ORDER BY k.ord
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.gallery_rendition_insert_jobs_v1(text,uuid) FROM PUBLIC;

-- Every new live original queues its derivatives in the creating transaction. Without
-- restore admission (a restore load) the insert proceeds and no job is minted; admission
-- backfills through enqueue_gallery_renditions_v1.
CREATE FUNCTION public.gallery_rendition_enqueue_item_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller text:=current_setting('app.athlete_id',true);
BEGIN
 IF NEW.deleted_at IS NULL AND public.gallery_rendition_processing_admitted_v1() THEN
  PERFORM set_config('app.athlete_id',NEW.athlete_id,true);
  PERFORM public.gallery_rendition_insert_jobs_v1(NEW.athlete_id,NEW.id);
  PERFORM set_config('app.athlete_id',coalesce(caller,''),true);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.gallery_rendition_enqueue_item_v1() FROM PUBLIC;
CREATE TRIGGER gallery_rendition_enqueue_item AFTER INSERT ON public.gallery_media_item
 FOR EACH ROW EXECUTE FUNCTION public.gallery_rendition_enqueue_item_v1();

-- Deletion suppression: soft delete (incl. exact restore replay) and account erasure retire
-- every job of the item in the same transaction as the tombstone/row removal.
CREATE FUNCTION public.gallery_rendition_retire_item_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller text:=current_setting('app.athlete_id',true);
DECLARE item public.gallery_media_item%ROWTYPE;
DECLARE erased boolean:=TG_OP='DELETE';
DECLARE stamp timestamptz:=clock_timestamp();
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NOT (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN RETURN NEW; END IF;
  item:=NEW;
 ELSE
  item:=OLD;
 END IF;
 PERFORM set_config('app.athlete_id',item.athlete_id,true);
 INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
  SELECT gen_random_uuid(),j.output_storage_ref,
   CASE WHEN erased THEN 'account_erased' ELSE 'resource_deleted' END,stamp,stamp
  FROM public.gallery_rendition_job j
  WHERE j.athlete_id=item.athlete_id AND j.media_item_id=item.id AND j.output_storage_ref IS NOT NULL
  ON CONFLICT(storage_ref) DO UPDATE SET
   id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,lease_owner=NULL,lease_until=NULL,
   available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,completed_at=NULL,
   delete_authorized_at=NULL,last_error_code=NULL
  WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
 -- Any lease may still be staging; sweep after every lease of this item can have expired.
 INSERT INTO public.gallery_rendition_sweep(sweep_id,athlete_id,media_item_id,cause,available_at,created_at)
  VALUES(gen_random_uuid(),item.athlete_id,item.id,
   CASE WHEN erased THEN 'account_erased' ELSE 'media_deleted' END,stamp+interval '10 minutes',stamp)
  ON CONFLICT(athlete_id,media_item_id) WHERE job_id IS NULL DO UPDATE SET
   available_at=EXCLUDED.available_at,lease_owner=NULL,lease_until=NULL;
 DELETE FROM public.gallery_rendition_sweep
  WHERE athlete_id=item.athlete_id AND media_item_id=item.id AND job_id IS NOT NULL;
 DELETE FROM public.gallery_rendition_job WHERE athlete_id=item.athlete_id AND media_item_id=item.id;
 PERFORM set_config('app.athlete_id',coalesce(caller,''),true);
 IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.gallery_rendition_retire_item_v1() FROM PUBLIC;
CREATE TRIGGER gallery_rendition_retire_deleted AFTER UPDATE OF deleted_at ON public.gallery_media_item
 FOR EACH ROW EXECUTE FUNCTION public.gallery_rendition_retire_item_v1();
CREATE TRIGGER gallery_rendition_retire_erased BEFORE DELETE ON public.gallery_media_item
 FOR EACH ROW EXECUTE FUNCTION public.gallery_rendition_retire_item_v1();

CREATE FUNCTION public.gallery_rendition_app_consent_v1(tenant text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.consent c WHERE c.athlete_id=tenant AND c.kind='app' AND c.granted)
$$;
REVOKE ALL ON FUNCTION public.gallery_rendition_app_consent_v1(text) FROM PUBLIC;

-- Worker: lease one due job across tenants. Never blocks on a row or lifecycle lock that a
-- deleting/erasing transaction holds (SKIP LOCKED / try-lock), so it adds no deadlock edge.
CREATE FUNCTION public.claim_gallery_rendition_v1(worker uuid,lease_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller text:=current_setting('app.athlete_id',true);
DECLARE due record; job public.gallery_rendition_job%ROWTYPE; item public.gallery_media_item%ROWTYPE;
DECLARE stamp timestamptz:=clock_timestamp(); token uuid; result jsonb;
BEGIN
 IF worker IS NULL OR lease_seconds IS NULL OR lease_seconds NOT BETWEEN 5 AND 300
 THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_CLAIM'; END IF;
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM public.require_gallery_rendition_processing_v1();
 FOR due IN SELECT d.athlete_id,d.job_id FROM public.gallery_rendition_due d WHERE d.due_at<=stamp
  ORDER BY d.due_at,d.athlete_id,d.job_id LIMIT 50 FOR UPDATE SKIP LOCKED
 LOOP
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(due.athlete_id,77206)) THEN CONTINUE; END IF;
  PERFORM set_config('app.athlete_id',due.athlete_id,true);
  IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=due.athlete_id) THEN CONTINUE; END IF;
  SELECT j.* INTO job FROM public.gallery_rendition_job j
   WHERE j.athlete_id=due.athlete_id AND j.job_id=due.job_id;
  IF NOT FOUND THEN CONTINUE; END IF;
  SELECT m.* INTO item FROM public.gallery_media_item m
   WHERE m.athlete_id=due.athlete_id AND m.id=job.media_item_id FOR SHARE SKIP LOCKED;
  IF NOT FOUND OR item.deleted_at IS NOT NULL THEN CONTINUE; END IF;
  SELECT j.* INTO job FROM public.gallery_rendition_job j
   WHERE j.athlete_id=due.athlete_id AND j.job_id=due.job_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR job.state NOT IN ('queued','running')
   OR (job.state='queued' AND job.available_at>stamp)
   OR (job.state='running' AND job.lease_until>stamp) THEN CONTINUE; END IF;
  IF job.state='running' THEN
   -- An expired lease is abandoned: its stage keys are swept after any writer has stopped.
   INSERT INTO public.gallery_rendition_sweep(sweep_id,athlete_id,media_item_id,job_id,attempt_id,
    cause,available_at,created_at)
   VALUES(gen_random_uuid(),job.athlete_id,job.media_item_id,job.job_id,job.lease_token,
    'attempt_abandoned',stamp+interval '10 minutes',stamp)
   ON CONFLICT DO NOTHING;
  END IF;
  IF item.content_hash<>job.source_sha256 OR item.size_bytes<>job.source_byte_size THEN
   UPDATE public.gallery_rendition_job SET state='failed',failure_code='input_invalid',
    retry_eligibility='ineligible',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=stamp
   WHERE athlete_id=job.athlete_id AND job_id=job.job_id;
   CONTINUE;
  END IF;
  IF job.state='running' AND job.attempts>=3 THEN
   UPDATE public.gallery_rendition_job SET state='failed',failure_code='timeout',
    retry_eligibility='ineligible',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=stamp
   WHERE athlete_id=job.athlete_id AND job_id=job.job_id;
   CONTINUE;
  END IF;
  IF NOT public.gallery_rendition_app_consent_v1(job.athlete_id) THEN
   -- Withdrawn/absent consent postpones processing; it is not a codec failure.
   UPDATE public.gallery_rendition_job SET state='queued',available_at=stamp+interval '1 hour',
    lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=stamp
   WHERE athlete_id=job.athlete_id AND job_id=job.job_id;
   CONTINUE;
  END IF;
  IF job.attempts>=3 THEN
   UPDATE public.gallery_rendition_job SET state='failed',failure_code='codec_unavailable',
    retry_eligibility='ineligible',updated_at=stamp
   WHERE athlete_id=job.athlete_id AND job_id=job.job_id;
   CONTINUE;
  END IF;
  token:=gen_random_uuid();
  UPDATE public.gallery_rendition_job SET state='running',attempts=job.attempts+1,lease_token=token,
   lease_owner=worker,lease_until=stamp+make_interval(secs=>lease_seconds),updated_at=stamp
  WHERE athlete_id=job.athlete_id AND job_id=job.job_id;
  result:=jsonb_build_object('athleteId',job.athlete_id,'jobId',job.job_id,'leaseToken',token,
   'leaseUntil',to_char((stamp+make_interval(secs=>lease_seconds)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'mediaItemId',job.media_item_id,'kind',job.kind,'recipeVersion',job.recipe_version,
   'sourceSha256',job.source_sha256,'sourceByteSize',job.source_byte_size,
   'parentAccessRevision',job.parent_access_revision,'idempotencyKey',job.idempotency_key,
   'attempt',job.attempts+1,'originalStorageRef',item.storage_ref,'originalMediaType',item.media_type);
  PERFORM set_config('app.athlete_id',coalesce(caller,''),true);
  RETURN result;
 END LOOP;
 PERFORM set_config('app.athlete_id',coalesce(caller,''),true);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.claim_gallery_rendition_v1(uuid,integer) FROM PUBLIC;

CREATE FUNCTION public.gallery_rendition_worker_context_v1(tenant text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF tenant IS NULL OR length(tenant) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_TENANT'; END IF;
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,77206));
 PERFORM set_config('app.athlete_id',tenant,true);
END $$;
REVOKE ALL ON FUNCTION public.gallery_rendition_worker_context_v1(text) FROM PUBLIC;

-- Worker: publish the staged output as the job's receipt in one transaction. Rejections are
-- finite; a replay of the committed receipt by the same lease answers ready again.
CREATE FUNCTION public.settle_gallery_rendition_v1(tenant text,job uuid,lease uuid,output jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller text:=current_setting('app.athlete_id',true);
DECLARE row_value public.gallery_rendition_job%ROWTYPE; item public.gallery_media_item%ROWTYPE;
DECLARE stamp timestamptz:=clock_timestamp(); answer jsonb;
BEGIN
 IF job IS NULL OR lease IS NULL OR output IS NULL OR jsonb_typeof(output)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(output))<>7
  OR NOT (output ?& ARRAY['storageRef','sha256','byteSize','mediaType','width','height','durationSeconds'])
 THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_SETTLE'; END IF;
 PERFORM public.gallery_rendition_worker_context_v1(tenant);
 PERFORM public.require_gallery_rendition_processing_v1();
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=tenant) THEN
  answer:=jsonb_build_object('state','rejected','reason','deleted');
 ELSE
  SELECT j.* INTO row_value FROM public.gallery_rendition_job j WHERE j.athlete_id=tenant AND j.job_id=job;
  IF NOT FOUND THEN
   answer:=jsonb_build_object('state','rejected','reason','deleted');
  ELSE
   SELECT m.* INTO item FROM public.gallery_media_item m
    WHERE m.athlete_id=tenant AND m.id=row_value.media_item_id FOR SHARE;
   SELECT j.* INTO row_value FROM public.gallery_rendition_job j
    WHERE j.athlete_id=tenant AND j.job_id=job FOR UPDATE;
   IF NOT FOUND OR item.id IS NULL OR item.deleted_at IS NOT NULL THEN
    answer:=jsonb_build_object('state','rejected','reason','deleted');
   ELSIF row_value.state='ready' AND row_value.lease_token=lease
    AND row_value.output_storage_ref=output->>'storageRef' AND row_value.output_sha256=output->>'sha256'
   THEN
    answer:=jsonb_build_object('state','ready');
   ELSIF row_value.state<>'running' OR row_value.lease_token<>lease OR row_value.lease_until<=stamp THEN
    answer:=jsonb_build_object('state','rejected','reason','lease_lost');
   ELSIF item.content_hash<>row_value.source_sha256 OR item.size_bytes<>row_value.source_byte_size THEN
    answer:=jsonb_build_object('state','rejected','reason','stale');
   ELSIF NOT public.gallery_rendition_app_consent_v1(tenant) THEN
    answer:=jsonb_build_object('state','rejected','reason','consent_withdrawn');
   ELSE
    UPDATE public.gallery_rendition_job SET state='ready',lease_owner=NULL,lease_until=NULL,
     output_storage_ref=output->>'storageRef',output_sha256=output->>'sha256',
     output_byte_size=(output->>'byteSize')::bigint,output_media_type=output->>'mediaType',
     output_width=(output->>'width')::integer,output_height=(output->>'height')::integer,
     output_duration_seconds=CASE WHEN jsonb_typeof(output->'durationSeconds')='number'
      THEN (output->>'durationSeconds')::double precision END,
     updated_at=stamp
    WHERE athlete_id=tenant AND job_id=job;
    answer:=jsonb_build_object('state','ready');
   END IF;
  END IF;
 END IF;
 PERFORM set_config('app.athlete_id',coalesce(caller,''),true);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.settle_gallery_rendition_v1(text,uuid,uuid,jsonb) FROM PUBLIC;

-- Worker: end a lease without a receipt. Deterministic codec outcomes are terminal (no retry);
-- transient outcomes requeue with backoff until the 3-attempt budget is spent.
CREATE FUNCTION public.release_gallery_rendition_v1(tenant text,job uuid,lease uuid,code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller text:=current_setting('app.athlete_id',true);
DECLARE row_value public.gallery_rendition_job%ROWTYPE; stamp timestamptz:=clock_timestamp();
DECLARE outcome text:='released'; present boolean;
BEGIN
 IF job IS NULL OR lease IS NULL OR code IS NULL OR code NOT IN ('unsupported_format','unsupported_pages',
  'input_invalid','input_budget','pixel_budget','invalid_media','decode_failed','output_budget',
  'aborted','timeout','codec_unavailable','transient')
 THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_RELEASE'; END IF;
 PERFORM public.gallery_rendition_worker_context_v1(tenant);
 PERFORM public.require_gallery_rendition_processing_v1();
 SELECT j.* INTO row_value FROM public.gallery_rendition_job j
  WHERE j.athlete_id=tenant AND j.job_id=job FOR UPDATE;
 present:=FOUND;
 IF present AND NOT (row_value.state='ready' AND row_value.lease_token=lease) THEN
  INSERT INTO public.gallery_rendition_sweep(sweep_id,athlete_id,media_item_id,job_id,attempt_id,
   cause,available_at,created_at)
  VALUES(gen_random_uuid(),tenant,row_value.media_item_id,job,lease,'attempt_abandoned',stamp,stamp)
  ON CONFLICT DO NOTHING;
 END IF;
 IF present AND row_value.state='running' AND row_value.lease_token=lease THEN
  IF code IN ('unsupported_format','unsupported_pages') THEN
   UPDATE public.gallery_rendition_job SET state='unsupported',failure_code=code,
    lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=stamp
   WHERE athlete_id=tenant AND job_id=job;
   outcome:='unsupported';
  ELSIF code IN ('input_invalid','input_budget','pixel_budget','invalid_media','decode_failed','output_budget')
   OR row_value.attempts>=3 THEN
   UPDATE public.gallery_rendition_job SET state='failed',
    failure_code=CASE WHEN code='transient' THEN 'codec_unavailable' ELSE code END,
    retry_eligibility='ineligible',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=stamp
   WHERE athlete_id=tenant AND job_id=job;
   outcome:='failed';
  ELSE
   UPDATE public.gallery_rendition_job SET state='queued',
    available_at=stamp+make_interval(mins=>row_value.attempts*row_value.attempts),
    lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=stamp
   WHERE athlete_id=tenant AND job_id=job;
   outcome:='requeued';
  END IF;
 END IF;
 PERFORM set_config('app.athlete_id',coalesce(caller,''),true);
 RETURN jsonb_build_object('state','released','outcome',outcome);
END $$;
REVOKE ALL ON FUNCTION public.release_gallery_rendition_v1(text,uuid,uuid,text) FROM PUBLIC;

-- Worker: lease one due storage sweep. A media sweep only runs for an item that is deleted
-- or gone; an attempt sweep never targets the lease that produced a ready receipt.
CREATE FUNCTION public.claim_gallery_rendition_sweep_v1(worker uuid,lease_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller text:=current_setting('app.athlete_id',true);
DECLARE s public.gallery_rendition_sweep%ROWTYPE; stamp timestamptz:=clock_timestamp(); live boolean;
BEGIN
 IF worker IS NULL OR lease_seconds IS NULL OR lease_seconds NOT BETWEEN 5 AND 300
 THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_SWEEP_CLAIM'; END IF;
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM public.require_gallery_rendition_processing_v1();
 FOR s IN SELECT * FROM public.gallery_rendition_sweep x
  WHERE x.available_at<=stamp AND (x.lease_until IS NULL OR x.lease_until<=stamp) AND x.attempts<100
  ORDER BY x.available_at,x.sweep_id LIMIT 20 FOR UPDATE SKIP LOCKED
 LOOP
  PERFORM set_config('app.athlete_id',s.athlete_id,true);
  IF s.job_id IS NULL THEN
   SELECT EXISTS(SELECT 1 FROM public.gallery_media_item m WHERE m.athlete_id=s.athlete_id
    AND m.id=s.media_item_id AND m.deleted_at IS NULL) INTO live;
  ELSE
   SELECT EXISTS(SELECT 1 FROM public.gallery_rendition_job j WHERE j.athlete_id=s.athlete_id
    AND j.job_id=s.job_id AND ((j.state='ready' AND j.lease_token=s.attempt_id)
     OR (j.state='running' AND j.lease_token=s.attempt_id))) INTO live;
  END IF;
  IF live THEN
   DELETE FROM public.gallery_rendition_sweep WHERE sweep_id=s.sweep_id;
   CONTINUE;
  END IF;
  UPDATE public.gallery_rendition_sweep SET lease_owner=worker,
   lease_until=stamp+make_interval(secs=>lease_seconds),attempts=attempts+1
  WHERE sweep_id=s.sweep_id;
  PERFORM set_config('app.athlete_id',coalesce(caller,''),true);
  RETURN jsonb_build_object('sweepId',s.sweep_id,'athleteId',s.athlete_id,
   'mediaItemId',s.media_item_id,'jobId',s.job_id,'attemptId',s.attempt_id);
 END LOOP;
 PERFORM set_config('app.athlete_id',coalesce(caller,''),true);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.claim_gallery_rendition_sweep_v1(uuid,integer) FROM PUBLIC;

CREATE FUNCTION public.finish_gallery_rendition_sweep_v1(sweep uuid,worker uuid,complete boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE affected integer;
BEGIN
 IF sweep IS NULL OR worker IS NULL OR complete IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_SWEEP_FINISH'; END IF;
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM public.require_gallery_rendition_processing_v1();
 IF complete THEN
  DELETE FROM public.gallery_rendition_sweep WHERE sweep_id=sweep AND lease_owner=worker;
 ELSE
  UPDATE public.gallery_rendition_sweep SET lease_owner=NULL,lease_until=NULL,
   available_at=clock_timestamp()+interval '5 minutes' WHERE sweep_id=sweep AND lease_owner=worker;
 END IF;
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_gallery_rendition_sweep_v1(uuid,uuid,boolean) FROM PUBLIC;

CREATE FUNCTION public.gallery_rendition_dto_v1(item public.gallery_media_item,kind text,
 job public.gallery_rendition_job) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE lineage jsonb;
BEGIN
 IF job.job_id IS NULL OR item.deleted_at IS NOT NULL THEN
  RETURN jsonb_build_object('schemaVersion',1,'mediaItemId',item.id,'kind',kind,
   'originalSha256',item.content_hash,'parentAccessRevision',item.access_revision,'recipeVersion',1,
   'state','unavailable','reason',CASE WHEN item.deleted_at IS NOT NULL THEN 'media_deleted' ELSE 'not_available' END);
 END IF;
 lineage:=jsonb_build_object('schemaVersion',1,'mediaItemId',job.media_item_id,'kind',job.kind,
  'originalSha256',job.source_sha256,'parentAccessRevision',job.parent_access_revision,
  'recipeVersion',job.recipe_version);
 RETURN lineage||CASE job.state
  WHEN 'queued' THEN jsonb_build_object('state','queued')
  WHEN 'running' THEN jsonb_build_object('state','running')
  WHEN 'failed' THEN jsonb_build_object('state','failed','code',job.failure_code,
   'retryEligibility',job.retry_eligibility)
  WHEN 'unsupported' THEN jsonb_build_object('state','unsupported','code',job.failure_code)
  ELSE jsonb_build_object('state','ready','output',
   jsonb_build_object('mediaType',job.output_media_type,'sha256',job.output_sha256,
    'byteSize',job.output_byte_size,'widthPixels',job.output_width,'heightPixels',job.output_height)
   ||CASE WHEN job.kind='video_playback'
    THEN jsonb_build_object('durationSeconds',job.output_duration_seconds) ELSE '{}'::jsonb END)
 END;
END $$;
REVOKE ALL ON FUNCTION public.gallery_rendition_dto_v1(public.gallery_media_item,text,public.gallery_rendition_job) FROM PUBLIC;

-- Runtime (tenant transaction): presentation state only. No job, lease or storage key.
CREATE FUNCTION public.read_gallery_renditions_v1(media uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE item public.gallery_media_item%ROWTYPE; job public.gallery_rendition_job%ROWTYPE;
DECLARE k text; items jsonb:='[]'::jsonb;
BEGIN
 IF tenant IS NULL OR media IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_READ'; END IF;
 SELECT m.* INTO item FROM public.gallery_media_item m WHERE m.athlete_id=tenant AND m.id=media;
 IF NOT FOUND THEN RETURN NULL; END IF;
 FOREACH k IN ARRAY CASE WHEN item.media_kind='video' THEN ARRAY['video_playback']
  ELSE ARRAY['image_preview','image_thumbnail'] END
 LOOP
  job:=NULL;
  SELECT j.* INTO job FROM public.gallery_rendition_job j
   WHERE j.athlete_id=tenant AND j.media_item_id=media AND j.kind=k AND j.recipe_version=1;
  items:=items||jsonb_build_array(public.gallery_rendition_dto_v1(item,k,job));
 END LOOP;
 RETURN jsonb_build_object('schemaVersion',1,'mediaItemId',media,'renditions',items);
END $$;
REVOKE ALL ON FUNCTION public.read_gallery_renditions_v1(uuid) FROM PUBLIC;

CREATE FUNCTION public.resolve_gallery_rendition_object_v1(media uuid,rendition_kind text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE job public.gallery_rendition_job%ROWTYPE;
BEGIN
 IF tenant IS NULL OR media IS NULL
  OR rendition_kind NOT IN ('image_preview','image_thumbnail','video_playback')
 THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_READ'; END IF;
 SELECT j.* INTO job FROM public.gallery_rendition_job j
  JOIN public.gallery_media_item m ON m.athlete_id=j.athlete_id AND m.id=j.media_item_id
  WHERE j.athlete_id=tenant AND j.media_item_id=media AND j.kind=rendition_kind
   AND j.recipe_version=1 AND j.state='ready' AND m.deleted_at IS NULL
   AND m.content_hash=j.source_sha256;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('storageRef',job.output_storage_ref,'sha256',job.output_sha256,
  'byteSize',job.output_byte_size,'mediaType',job.output_media_type);
END $$;
REVOKE ALL ON FUNCTION public.resolve_gallery_rendition_object_v1(uuid,text) FROM PUBLIC;

-- Runtime and owner: idempotent backfill for items created before this extension or loaded
-- by a restore. Requires restore admission, so the post-admission backfill is the only path
-- that regenerates jobs for restored media.
CREATE FUNCTION public.enqueue_gallery_renditions_v1(media uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
 IF tenant IS NULL OR media IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_RENDITION_ENQUEUE'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=tenant) THEN RAISE EXCEPTION 'ACCOUNT_ERASED'; END IF;
 PERFORM public.require_gallery_rendition_processing_v1();
 IF NOT EXISTS(SELECT 1 FROM public.gallery_media_item m WHERE m.athlete_id=tenant AND m.id=media
  AND m.deleted_at IS NULL FOR SHARE) THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND'; END IF;
 RETURN public.gallery_rendition_insert_jobs_v1(tenant,media);
END $$;
REVOKE ALL ON FUNCTION public.enqueue_gallery_renditions_v1(uuid) FROM PUBLIC;
