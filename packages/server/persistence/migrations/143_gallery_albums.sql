-- Gallery S17 navigation successor on the named source142 profile (M2-03b).
-- Installed only by the gallery navigation extension installer over a verified
-- profile25; normal107 migrate() never applies it. Owned albums, one album
-- membership and one saved exact course-revision association per media item.
-- The legacy gallery_media_item.album text is never read, rewritten or derived
-- here. Course associations are only explicit user commands: nothing derives a
-- course relation from GPS, captured position or activity geometry.
-- Original/derivative media semantics and private visibility are unchanged.
-- No historical function, grant, erase wrapper or restore registry is replaced.

CREATE FUNCTION public.gallery_album_title_valid_v1(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE trim_chars text:=chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)
 ||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)
 ||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)
 ||chr(8239)||chr(8287)||chr(12288)||chr(65279);
 point integer; units integer:=0; i integer;
BEGIN
 IF value IS NULL OR value='' OR value IS DISTINCT FROM btrim(value,trim_chars)
 OR octet_length(value)>400 THEN RETURN false; END IF;
 FOR i IN 1..char_length(value) LOOP
  point:=ascii(substr(value,i,1));
  IF point<=8 OR point BETWEEN 11 AND 31 OR point=127 THEN RETURN false; END IF;
  units:=units+CASE WHEN point>65535 THEN 2 ELSE 1 END;
 END LOOP;
 RETURN units BETWEEN 1 AND 100;
END $$;
REVOKE ALL ON FUNCTION public.gallery_album_title_valid_v1(text) FROM PUBLIC;

CREATE TABLE public.gallery_album (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200 AND athlete_id=btrim(athlete_id)),
 id uuid NOT NULL,
 title text NOT NULL CHECK(public.gallery_album_title_valid_v1(title)),
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK(isfinite(updated_at)),
 deleted_at timestamptz,
 PRIMARY KEY(athlete_id,id),
 CHECK(updated_at>=created_at AND (deleted_at IS NULL OR deleted_at=updated_at))
);
CREATE INDEX gallery_album_live_navigation ON public.gallery_album(athlete_id,created_at DESC,id)
 WHERE deleted_at IS NULL;

CREATE TABLE public.gallery_media_album_membership (
 athlete_id text NOT NULL,
 media_item_id uuid NOT NULL,
 album_id uuid NOT NULL,
 PRIMARY KEY(athlete_id,media_item_id),
 FOREIGN KEY(athlete_id,media_item_id) REFERENCES public.gallery_media_item(athlete_id,id),
 FOREIGN KEY(athlete_id,album_id) REFERENCES public.gallery_album(athlete_id,id)
);
CREATE INDEX gallery_media_album_membership_album ON public.gallery_media_album_membership
 (athlete_id,album_id,media_item_id);

-- Saved exact tuple only. No FK to course/course_revision: reclamation or
-- deletion of the course must not erase the user's saved association; reads
-- report availability instead of choosing a newer head.
CREATE TABLE public.gallery_media_course_association (
 athlete_id text NOT NULL,
 media_item_id uuid NOT NULL,
 course_id uuid NOT NULL,
 course_revision integer NOT NULL CHECK(course_revision BETWEEN 1 AND 2147483646),
 revision_id uuid NOT NULL,
 PRIMARY KEY(athlete_id,media_item_id),
 FOREIGN KEY(athlete_id,media_item_id) REFERENCES public.gallery_media_item(athlete_id,id)
);
CREATE INDEX gallery_media_course_association_course ON public.gallery_media_course_association
 (athlete_id,course_id,course_revision,revision_id,media_item_id);

-- Original validated response, not a live-head lookup. Typed targets permit
-- lifecycle redaction without searching nested DTO JSON or exposing request text.
CREATE TABLE public.gallery_navigation_command_receipt (
 athlete_id text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('create_album','rename_album','delete_album','set_media_navigation')),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128
  AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 target_album_id uuid,
 target_media_item_id uuid,
 expected_revision integer,
 result_revision integer NOT NULL CHECK(result_revision BETWEEN 1 AND 2147483646),
 state text NOT NULL CHECK(state IN ('committed','redacted')),
 result jsonb,
 committed_at timestamptz NOT NULL CHECK(isfinite(committed_at)),
 PRIMARY KEY(athlete_id,operation,idempotency_key),
 FOREIGN KEY(athlete_id,target_album_id) REFERENCES public.gallery_album(athlete_id,id),
 FOREIGN KEY(athlete_id,target_media_item_id) REFERENCES public.gallery_media_item(athlete_id,id),
 CHECK(((operation='set_media_navigation' AND target_media_item_id IS NOT NULL AND target_album_id IS NULL)
  OR (operation<>'set_media_navigation' AND target_album_id IS NOT NULL AND target_media_item_id IS NULL)) IS TRUE),
 CHECK(((operation='create_album' AND expected_revision IS NULL AND result_revision=1)
  OR (operation IN ('rename_album','delete_album','set_media_navigation') AND expected_revision BETWEEN 1 AND 2147483645
   AND result_revision=expected_revision+1)) IS TRUE),
 CHECK((state='committed' AND result IS NOT NULL AND jsonb_typeof(result)='object'
   AND octet_length(result::text)<=1048576)
  OR (state='redacted' AND result IS NULL))
);
CREATE INDEX gallery_navigation_receipt_album ON public.gallery_navigation_command_receipt
 (athlete_id,target_album_id) WHERE target_album_id IS NOT NULL;
CREATE INDEX gallery_navigation_receipt_media ON public.gallery_navigation_command_receipt
 (athlete_id,target_media_item_id) WHERE target_media_item_id IS NOT NULL;

-- Restore suppression survives an absent album row. No title or byte references.
CREATE TABLE public.gallery_album_deletion (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 album_id uuid NOT NULL,
 deleted_revision integer NOT NULL CHECK(deleted_revision BETWEEN 2 AND 2147483646),
 deleted_at timestamptz NOT NULL CHECK(isfinite(deleted_at)),
 PRIMARY KEY(athlete_id,album_id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['gallery_album','gallery_media_album_membership','gallery_media_course_association',
  'gallery_navigation_command_receipt','gallery_album_deletion'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',name);
  EXECUTE format('CREATE POLICY gallery_album_tenant ON public.%I '
   'USING(athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) '
   'WITH CHECK(athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',name);
 END LOOP;
END $$;

CREATE FUNCTION public.assert_gallery_album_owner_v1() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM (VALUES('gallery_album'),('gallery_media_album_membership'),
  ('gallery_media_course_association'),('gallery_navigation_command_receipt'),('gallery_album_deletion')) t(name)
  JOIN pg_class c ON c.oid=('public.'||t.name)::regclass
  WHERE c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
 THEN RAISE EXCEPTION 'GALLERY_ALBUM_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_gallery_album_owner_v1() FROM PUBLIC;

-- Existing Database.tenant acquires the global fence before lifecycle/command.
-- A standalone RPC caller must do likewise; never acquire global after tenant.
CREATE FUNCTION public.assert_gallery_album_context_v1() RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); lock_key bigint;
BEGIN
 PERFORM public.assert_gallery_album_owner_v1();
 IF tenant IS NULL OR length(tenant) NOT BETWEEN 1 AND 200 OR tenant<>btrim(tenant)
 THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.classid=77210::oid AND l.objid=1::oid AND l.objsubid=2 AND l.granted
  AND l.mode IN ('ShareLock','ExclusiveLock'))
 THEN RAISE EXCEPTION 'GALLERY_ALBUM_GLOBAL_LOCK_REQUIRED'; END IF;
 lock_key:=hashtextextended(tenant,77206);
 IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.classid=((lock_key >> 32)&4294967295)::oid AND l.objid=(lock_key&4294967295)::oid
  AND l.objsubid=1 AND l.granted AND l.mode IN ('ShareLock','ExclusiveLock'))
 THEN RAISE EXCEPTION 'GALLERY_ALBUM_LIFECYCLE_LOCK_REQUIRED'; END IF;
 lock_key:=hashtextextended(tenant,0);
 IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.classid=((lock_key >> 32)&4294967295)::oid AND l.objid=(lock_key&4294967295)::oid
  AND l.objsubid=1 AND l.granted AND l.mode='ExclusiveLock')
 THEN RAISE EXCEPTION 'GALLERY_ALBUM_COMMAND_LOCK_REQUIRED'; END IF;
 RETURN tenant;
END $$;
REVOKE ALL ON FUNCTION public.assert_gallery_album_context_v1() FROM PUBLIC;

CREATE FUNCTION public.lock_gallery_album_command_v1() RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
 PERFORM public.assert_gallery_album_owner_v1();
 IF tenant IS NULL OR length(tenant) NOT BETWEEN 1 AND 200 OR tenant<>btrim(tenant)
 THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.classid=77210::oid AND l.objid=1::oid AND l.objsubid=2 AND l.granted
  AND l.mode IN ('ShareLock','ExclusiveLock'))
 THEN RAISE EXCEPTION 'GALLERY_ALBUM_GLOBAL_LOCK_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 PERFORM public.assert_gallery_album_context_v1();
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=tenant)
 THEN RAISE EXCEPTION 'ACCOUNT_ERASED'; END IF;
 RETURN tenant;
END $$;
REVOKE ALL ON FUNCTION public.lock_gallery_album_command_v1() FROM PUBLIC;

-- New authoring (create/rename/membership) is rejected while a committed restore
-- target is pending on the CLOSED control, or the control belongs to another
-- restore generation. Holding the global fence alone is never admission.
-- Original receipt replay and deletion/detach remain available for privacy.
CREATE FUNCTION public.require_gallery_navigation_authoring_v1() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r jsonb;
BEGIN
 r:=public.read_restore_processing_admission();
 IF r IS NULL OR r->>'state' IS DISTINCT FROM 'CLOSED'
  OR r->'targetNonce' IS DISTINCT FROM 'null'::jsonb
  OR r->'targetIncarnation' IS DISTINCT FROM 'null'::jsonb
  OR r->>'generationId' IS DISTINCT FROM public.current_restore_generation()::text
 THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CLOSED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.require_gallery_navigation_authoring_v1() FROM PUBLIC;

CREATE FUNCTION public.assert_gallery_album_erasure_context_v1() RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1(); lock_key bigint:=hashtextextended(tenant,77206);
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.classid=((lock_key >> 32)&4294967295)::oid AND l.objid=(lock_key&4294967295)::oid
  AND l.objsubid=1 AND l.granted AND l.mode='ExclusiveLock')
 THEN RAISE EXCEPTION 'GALLERY_ALBUM_ERASURE_LOCK_REQUIRED'; END IF;
 RETURN tenant;
END $$;
REVOKE ALL ON FUNCTION public.assert_gallery_album_erasure_context_v1() FROM PUBLIC;

CREATE FUNCTION public.guard_gallery_album_row_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1();
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'GALLERY_ALBUM_TRUNCATE_FORBIDDEN'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM public.assert_gallery_album_erasure_context_v1();
  IF OLD.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
  RETURN OLD; -- owner-only erasure helper; no runtime table DELETE grant.
 END IF;
 IF NEW.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM public.gallery_album_deletion WHERE athlete_id=tenant AND album_id=NEW.id)
  THEN RAISE EXCEPTION 'GALLERY_ALBUM_DELETION_TERMINAL'; END IF;
 ELSE
  IF OLD.deleted_at IS NOT NULL OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
   OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at
   OR NEW.revision::bigint<>OLD.revision::bigint+1 OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_TRANSITION'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_gallery_album_row_v1() FROM PUBLIC;
CREATE TRIGGER gallery_album_row_guard BEFORE INSERT OR UPDATE OR DELETE ON public.gallery_album
 FOR EACH ROW EXECUTE FUNCTION public.guard_gallery_album_row_v1();
CREATE TRIGGER gallery_album_no_truncate BEFORE TRUNCATE ON public.gallery_album
 FOR EACH STATEMENT EXECUTE FUNCTION public.guard_gallery_album_row_v1();

CREATE FUNCTION public.guard_gallery_album_membership_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1();
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'GALLERY_ALBUM_TRUNCATE_FORBIDDEN'; END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
 IF TG_OP='UPDATE' AND (NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
  OR NEW.media_item_id IS DISTINCT FROM OLD.media_item_id)
 THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_MEMBERSHIP'; END IF;
 PERFORM 1 FROM public.gallery_album WHERE athlete_id=tenant AND id=NEW.album_id
  AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ALBUM_NOT_FOUND'; END IF;
 PERFORM 1 FROM public.gallery_media_item WHERE athlete_id=tenant AND id=NEW.media_item_id
  AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_gallery_album_membership_v1() FROM PUBLIC;
CREATE TRIGGER gallery_album_membership_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.gallery_media_album_membership FOR EACH ROW EXECUTE FUNCTION public.guard_gallery_album_membership_v1();
CREATE TRIGGER gallery_album_membership_no_truncate BEFORE TRUNCATE ON public.gallery_media_album_membership
 FOR EACH STATEMENT EXECUTE FUNCTION public.guard_gallery_album_membership_v1();

-- A changed tuple must name an existing revision of the caller's currently
-- available course. An unchanged saved tuple is preserved even when unavailable.
CREATE FUNCTION public.guard_gallery_media_course_association_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1();
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'GALLERY_ALBUM_TRUNCATE_FORBIDDEN'; END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
 IF TG_OP='UPDATE' AND (NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
  OR NEW.media_item_id IS DISTINCT FROM OLD.media_item_id)
 THEN RAISE EXCEPTION 'INVALID_GALLERY_COURSE_ASSOCIATION'; END IF;
 PERFORM 1 FROM public.gallery_media_item WHERE athlete_id=tenant AND id=NEW.media_item_id
  AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND'; END IF;
 IF TG_OP='INSERT' OR (NEW.course_id,NEW.course_revision,NEW.revision_id)
  IS DISTINCT FROM (OLD.course_id,OLD.course_revision,OLD.revision_id) THEN
  PERFORM 1 FROM public.course h JOIN public.course_revision r
   ON r.athlete_id=h.athlete_id AND r.course_id=h.course_id
   WHERE h.athlete_id=tenant AND h.course_id=NEW.course_id AND h.status='available'
    AND r.course_revision=NEW.course_revision AND r.revision_id=NEW.revision_id
   FOR SHARE OF h;
  IF NOT FOUND THEN RAISE EXCEPTION 'COURSE_NOT_FOUND'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_gallery_media_course_association_v1() FROM PUBLIC;
CREATE TRIGGER gallery_media_course_association_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.gallery_media_course_association FOR EACH ROW EXECUTE FUNCTION public.guard_gallery_media_course_association_v1();
CREATE TRIGGER gallery_media_course_association_no_truncate BEFORE TRUNCATE ON public.gallery_media_course_association
 FOR EACH STATEMENT EXECUTE FUNCTION public.guard_gallery_media_course_association_v1();

-- A deleted album must have its exact ledger and no remaining memberships at
-- transaction end; the ledger remains meaningful when no album row was restored.
CREATE FUNCTION public.check_gallery_album_terminal_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text; target uuid; a public.gallery_album%ROWTYPE; d public.gallery_album_deletion%ROWTYPE;
BEGIN
 PERFORM public.assert_gallery_album_context_v1();
 IF TG_TABLE_NAME='gallery_album' THEN
  tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.athlete_id ELSE NEW.athlete_id END;
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSE
  tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.athlete_id ELSE NEW.athlete_id END;
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.album_id ELSE NEW.album_id END;
 END IF;
 SELECT * INTO a FROM public.gallery_album WHERE athlete_id=tenant AND id=target;
 SELECT * INTO d FROM public.gallery_album_deletion WHERE athlete_id=tenant AND album_id=target;
 IF a.id IS NOT NULL THEN
  IF (a.deleted_at IS NULL AND d.album_id IS NOT NULL)
   OR (a.deleted_at IS NOT NULL AND (d.album_id IS NULL OR d.deleted_revision<>a.revision
    OR d.deleted_at IS DISTINCT FROM a.deleted_at))
   OR (a.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.gallery_media_album_membership
    WHERE athlete_id=tenant AND album_id=target))
  THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_TERMINAL_STATE'; END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_gallery_album_terminal_v1() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER gallery_album_terminal_check AFTER INSERT OR UPDATE OR DELETE ON public.gallery_album
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_gallery_album_terminal_v1();
CREATE CONSTRAINT TRIGGER gallery_album_deletion_terminal_check AFTER INSERT OR UPDATE OR DELETE
 ON public.gallery_album_deletion DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.check_gallery_album_terminal_v1();

CREATE FUNCTION public.guard_gallery_album_deletion_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1();
BEGIN
 IF TG_OP IN ('TRUNCATE','UPDATE') THEN RAISE EXCEPTION 'IMMUTABLE_GALLERY_ALBUM_DELETION'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM public.assert_gallery_album_erasure_context_v1();
  IF OLD.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
  RETURN OLD; -- account erasure only, owner-only helper and lifecycle exclusive.
 END IF;
 IF NEW.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_gallery_album_deletion_v1() FROM PUBLIC;
CREATE TRIGGER gallery_album_deletion_guard BEFORE INSERT OR UPDATE OR DELETE ON public.gallery_album_deletion
 FOR EACH ROW EXECUTE FUNCTION public.guard_gallery_album_deletion_v1();
CREATE TRIGGER gallery_album_deletion_no_truncate BEFORE TRUNCATE ON public.gallery_album_deletion
 FOR EACH STATEMENT EXECUTE FUNCTION public.guard_gallery_album_deletion_v1();

CREATE FUNCTION public.gallery_navigation_uuid_text_valid_v1(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_typeof(value)='string' AND lower(value#>>'{}') ~
  '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
$$;
REVOKE ALL ON FUNCTION public.gallery_navigation_uuid_text_valid_v1(jsonb) FROM PUBLIC;
CREATE FUNCTION public.gallery_navigation_revision_valid_v1(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_typeof(value)='number' AND (value#>>'{}') ~ '^[1-9][0-9]{0,9}$'
  AND (value#>>'{}')::bigint<=2147483646
$$;
REVOKE ALL ON FUNCTION public.gallery_navigation_revision_valid_v1(jsonb) FROM PUBLIC;

CREATE FUNCTION public.normalize_gallery_album_command_v1(operation text,command jsonb,key text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE keys text[]; expected_keys text[]; normalized jsonb; title text; expected integer; target uuid;
 nested text[]; album jsonb; course jsonb;
 trim_chars text:=chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)
 ||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)
 ||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)
 ||chr(8239)||chr(8287)||chr(12288)||chr(65279);
BEGIN
 IF key IS NULL OR length(key) NOT BETWEEN 8 AND 128 OR key !~ '^[A-Za-z0-9._:-]+$'
 OR command IS NULL OR jsonb_typeof(command)<>'object' OR octet_length(command::text)>2048
 OR operation IS NULL OR operation NOT IN ('create_album','rename_album','delete_album','set_media_navigation')
 THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO keys FROM jsonb_object_keys(command) AS names(k);
 expected_keys:=(CASE operation WHEN 'create_album' THEN ARRAY['title']
  WHEN 'rename_album' THEN ARRAY['albumId','expectedRevision','title']
  WHEN 'delete_album' THEN ARRAY['albumId','expectedRevision']
  ELSE ARRAY['albumMembership','courseLink','expectedAccessRevision','mediaItemId'] END);
 IF keys IS DISTINCT FROM expected_keys THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
 IF operation='set_media_navigation' THEN
  IF NOT public.gallery_navigation_uuid_text_valid_v1(command->'mediaItemId')
   OR NOT public.gallery_navigation_revision_valid_v1(command->'expectedAccessRevision')
  THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
  album:=command->'albumMembership'; course:=command->'courseLink';
  IF jsonb_typeof(album)='object' THEN
   SELECT array_agg(k ORDER BY k COLLATE "C") INTO nested FROM jsonb_object_keys(album) AS names(k);
   IF nested IS DISTINCT FROM ARRAY['albumId'] OR NOT public.gallery_navigation_uuid_text_valid_v1(album->'albumId')
   THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
   album:=jsonb_build_object('albumId',(album->>'albumId')::uuid);
  ELSIF jsonb_typeof(album) IS DISTINCT FROM 'null' THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
  IF jsonb_typeof(course)='object' THEN
   SELECT array_agg(k ORDER BY k COLLATE "C") INTO nested FROM jsonb_object_keys(course) AS names(k);
   IF nested IS DISTINCT FROM ARRAY['courseId','courseRevision','revisionId']
    OR NOT public.gallery_navigation_uuid_text_valid_v1(course->'courseId')
    OR NOT public.gallery_navigation_revision_valid_v1(course->'courseRevision')
    OR NOT public.gallery_navigation_uuid_text_valid_v1(course->'revisionId')
   THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
   course:=jsonb_build_object('courseId',(course->>'courseId')::uuid,
    'courseRevision',(course->>'courseRevision')::integer,'revisionId',(course->>'revisionId')::uuid);
  ELSIF jsonb_typeof(course) IS DISTINCT FROM 'null' THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
  normalized:=jsonb_build_object('mediaItemId',(command->>'mediaItemId')::uuid,
   'expectedAccessRevision',(command->>'expectedAccessRevision')::integer,
   'albumMembership',album,'courseLink',course);
  RETURN jsonb_build_object('schemaVersion',1,'operation',operation,'command',normalized);
 END IF;
 IF operation<>'delete_album' THEN
  IF jsonb_typeof(command->'title') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
  title:=btrim(command->>'title',trim_chars);
  IF NOT public.gallery_album_title_valid_v1(title) THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
 END IF;
 IF operation<>'create_album' THEN
  IF NOT public.gallery_navigation_uuid_text_valid_v1(command->'albumId')
   OR NOT public.gallery_navigation_revision_valid_v1(command->'expectedRevision')
  THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
  target:=(command->>'albumId')::uuid;
  expected:=(command->>'expectedRevision')::integer;
 END IF;
 normalized:=CASE operation WHEN 'create_album' THEN jsonb_build_object('title',title)
  WHEN 'rename_album' THEN jsonb_build_object('albumId',target,'expectedRevision',expected,'title',title)
  ELSE jsonb_build_object('albumId',target,'expectedRevision',expected) END;
 RETURN jsonb_build_object('schemaVersion',1,'operation',operation,'command',normalized);
END $$;
REVOKE ALL ON FUNCTION public.normalize_gallery_album_command_v1(text,jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.gallery_album_dto_v1(row_value public.gallery_album) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schemaVersion',1,'id',row_value.id,'title',row_value.title,
  'revision',row_value.revision,
  'createdAt',to_char(row_value.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'updatedAt',to_char(row_value.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$$;
REVOKE ALL ON FUNCTION public.gallery_album_dto_v1(public.gallery_album) FROM PUBLIC;

-- Flat projection consumed by the server row mapper. Stored local capture date
-- is projected as stored text; no timezone conversion or GPS-derived field.
-- course_available is a read fact of the saved tuple, never a newer head.
CREATE FUNCTION public.gallery_media_navigation_projection_v1(target uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
  'athlete_id',m.athlete_id,'id',m.id,'media_kind',m.media_kind,'visibility',m.visibility,
  'include_for_coach',m.include_for_coach,'album',m.album,'caption',m.caption,'activity_id',m.activity_id,
  'captured_at',to_char(m.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'captured_local_date',to_char(m.captured_local_date,'YYYY-MM-DD'),
  'original_filename',m.original_filename,'media_type',m.media_type,'size_bytes',m.size_bytes,
  'content_hash',m.content_hash,'access_revision',m.access_revision,
  'created_at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'updated_at',to_char(m.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'deleted_at',NULL,
  'preview_media_type',d.media_type,'preview_size_bytes',d.size_bytes,'preview_content_hash',d.content_hash,
  'album_id',l.album_id,'album_athlete_id',l.athlete_id,
  'course_id',c.course_id,'course_revision',c.course_revision,'course_revision_id',c.revision_id,
  'course_athlete_id',c.athlete_id,
  'course_available',CASE WHEN c.media_item_id IS NULL THEN NULL ELSE EXISTS(
   SELECT 1 FROM public.course h JOIN public.course_revision r
    ON r.athlete_id=h.athlete_id AND r.course_id=h.course_id
   WHERE h.athlete_id=c.athlete_id AND h.course_id=c.course_id AND h.status='available'
    AND r.course_revision=c.course_revision AND r.revision_id=c.revision_id) END)
 FROM public.gallery_media_item m
 LEFT JOIN public.gallery_media_derivative d ON d.athlete_id=m.athlete_id AND d.media_item_id=m.id AND d.kind='preview'
 LEFT JOIN public.gallery_media_album_membership l ON l.athlete_id=m.athlete_id AND l.media_item_id=m.id
 LEFT JOIN public.gallery_media_course_association c ON c.athlete_id=m.athlete_id AND c.media_item_id=m.id
 WHERE m.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND m.id=target AND m.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.gallery_media_navigation_projection_v1(uuid) FROM PUBLIC;

CREATE FUNCTION public.gallery_album_result_valid_v1(operation text,target uuid,revision integer,result jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE keys text[]; stamp text; created timestamptz; updated timestamptz;
BEGIN
 IF result IS NULL OR jsonb_typeof(result)<>'object' OR octet_length(result::text)>1048576 THEN RETURN false; END IF;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO keys FROM jsonb_object_keys(result) AS names(k);
 IF operation='set_media_navigation' THEN
  -- Exact flat projection key set; the server mapper validates every value.
  RETURN keys=ARRAY['access_revision','activity_id','album','album_athlete_id','album_id','athlete_id',
   'caption','captured_at','captured_local_date','content_hash','course_athlete_id','course_available',
   'course_id','course_revision','course_revision_id','created_at','deleted_at','id','include_for_coach',
   'media_kind','media_type','original_filename','preview_content_hash','preview_media_type',
   'preview_size_bytes','size_bytes','updated_at','visibility']
   AND result->'id'=to_jsonb(target) AND result->'access_revision'=to_jsonb(revision)
   AND result->'deleted_at'='null'::jsonb;
 END IF;
 IF result->'schemaVersion' IS DISTINCT FROM '1'::jsonb
  OR result->'revision' IS DISTINCT FROM to_jsonb(revision) THEN RETURN false; END IF;
 IF operation='delete_album' THEN
  RETURN keys=ARRAY['albumId','detachedMediaCount','revision','schemaVersion','status']
   AND result->'status'='"deleted"'::jsonb AND result->'albumId'=to_jsonb(target)
   AND jsonb_typeof(result->'detachedMediaCount')='number'
   AND (result->>'detachedMediaCount') ~ '^(0|[1-9][0-9]{0,3})$'
   AND (result->>'detachedMediaCount')::integer BETWEEN 0 AND 1000;
 END IF;
 IF operation NOT IN ('create_album','rename_album') OR keys IS DISTINCT FROM
  ARRAY['createdAt','id','revision','schemaVersion','title','updatedAt']
  OR result->'id' IS DISTINCT FROM to_jsonb(target) OR jsonb_typeof(result->'title') IS DISTINCT FROM 'string'
  OR NOT public.gallery_album_title_valid_v1(result->>'title')
 THEN RETURN false; END IF;
 FOREACH stamp IN ARRAY ARRAY[result->>'createdAt',result->>'updatedAt'] LOOP
  IF stamp IS NULL OR stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
  THEN RETURN false; END IF;
 END LOOP;
 created:=(result->>'createdAt')::timestamptz; updated:=(result->>'updatedAt')::timestamptz;
 RETURN isfinite(created) AND isfinite(updated) AND updated>=created
  AND to_char(created AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=result->>'createdAt'
  AND to_char(updated AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=result->>'updatedAt';
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.gallery_album_result_valid_v1(text,uuid,integer,jsonb) FROM PUBLIC;
ALTER TABLE public.gallery_navigation_command_receipt ADD CONSTRAINT gallery_album_original_dto_check
 CHECK(state='redacted' OR public.gallery_album_result_valid_v1(operation,
  coalesce(target_album_id,target_media_item_id),result_revision,result) IS TRUE);

CREATE FUNCTION public.guard_gallery_album_receipt_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1();
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'GALLERY_ALBUM_TRUNCATE_FORBIDDEN'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM public.assert_gallery_album_erasure_context_v1();
  IF OLD.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
 IF TG_OP='UPDATE' AND (OLD.state<>'committed' OR NEW.state<>'redacted' OR NEW.result IS NOT NULL
  OR (to_jsonb(NEW)-ARRAY['state','result']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','result']))
 THEN RAISE EXCEPTION 'IMMUTABLE_GALLERY_ALBUM_RECEIPT'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_gallery_album_receipt_v1() FROM PUBLIC;
CREATE TRIGGER gallery_album_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.gallery_navigation_command_receipt
 FOR EACH ROW EXECUTE FUNCTION public.guard_gallery_album_receipt_v1();
CREATE TRIGGER gallery_album_receipt_no_truncate BEFORE TRUNCATE ON public.gallery_navigation_command_receipt
 FOR EACH STATEMENT EXECUTE FUNCTION public.guard_gallery_album_receipt_v1();

CREATE FUNCTION public.replay_gallery_album_command_v1(operation text,key text,normalized jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1(); prior public.gallery_navigation_command_receipt%ROWTYPE;
 digest text:=encode(sha256(convert_to(normalized::text,'UTF8')),'hex');
BEGIN
 SELECT * INTO prior FROM public.gallery_navigation_command_receipt r
  WHERE r.athlete_id=tenant AND r.operation=$1 AND r.idempotency_key=$2;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF prior.request_digest IS DISTINCT FROM digest THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
 IF prior.state='redacted' THEN
  RAISE EXCEPTION '%',CASE WHEN prior.operation='set_media_navigation' THEN 'MEDIA_NOT_FOUND' ELSE 'ALBUM_NOT_FOUND' END;
 END IF;
 IF NOT public.gallery_album_result_valid_v1(prior.operation,coalesce(prior.target_album_id,prior.target_media_item_id),
  prior.result_revision,prior.result)
 THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_RECEIPT'; END IF;
 RETURN prior.result;
END $$;
REVOKE ALL ON FUNCTION public.replay_gallery_album_command_v1(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.finish_gallery_album_command_v1(operation text,key text,normalized jsonb,
 target uuid,expected integer,result jsonb,stamp timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1(); result_revision integer;
 event_key text:='gallery.nav:'||operation||':'||key; topic text; payload jsonb;
BEGIN
 result_revision:=CASE WHEN operation='create_album' THEN 1 ELSE expected+1 END;
 IF NOT public.gallery_album_result_valid_v1(operation,target,result_revision,result)
 THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_REPLY'; END IF;
 topic:=CASE operation WHEN 'create_album' THEN 'gallery.album_created'
  WHEN 'rename_album' THEN 'gallery.album_renamed' WHEN 'delete_album' THEN 'gallery.album_deleted'
  WHEN 'set_media_navigation' THEN 'gallery.media_navigation_updated' END;
 IF topic IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
 IF operation='set_media_navigation' THEN
  payload:=jsonb_build_object('mediaItemId',target,'accessRevision',result_revision);
 ELSE
  payload:=jsonb_build_object('albumId',target,'revision',result_revision);
 END IF;
 IF operation='delete_album' THEN payload:=payload||jsonb_build_object('detachedMediaCount',result->'detachedMediaCount'); END IF;
 INSERT INTO public.gallery_navigation_command_receipt
  (athlete_id,operation,idempotency_key,request_digest,target_album_id,target_media_item_id,
   expected_revision,result_revision,state,result,committed_at)
 VALUES(tenant,operation,key,encode(sha256(convert_to(normalized::text,'UTF8')),'hex'),
  CASE WHEN operation='set_media_navigation' THEN NULL ELSE target END,
  CASE WHEN operation='set_media_navigation' THEN target ELSE NULL END,
  expected,result_revision,'committed',result,stamp);
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
 VALUES(tenant,gen_random_uuid(),event_key,topic,payload);
 -- Any receipt/outbox constraint failure rolls back the entire caller transaction.
END $$;
REVOKE ALL ON FUNCTION public.finish_gallery_album_command_v1(text,text,jsonb,uuid,integer,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.redact_gallery_album_receipts_v1(target uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1(); affected integer;
BEGIN
 IF target IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
 UPDATE public.gallery_navigation_command_receipt SET state='redacted',result=NULL
  WHERE athlete_id=tenant AND target_album_id=target AND operation IN ('create_album','rename_album') AND state='committed';
 GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.redact_gallery_album_receipts_v1(uuid) FROM PUBLIC;

-- Owner-only lifecycle helper. Caller locks the album first; media are then
-- locked in UUID order. Validate the complete live set BEFORE any detach/write.
CREATE FUNCTION public.detach_gallery_album_memberships_v1(target uuid,stamp timestamptz) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1(); item record; affected integer:=0; updated integer;
BEGIN
 IF target IS NULL OR stamp IS NULL OR NOT isfinite(stamp) THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
 PERFORM 1 FROM public.gallery_album WHERE athlete_id=tenant AND id=target FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ALBUM_NOT_FOUND'; END IF;
 FOR item IN SELECT m.id,m.access_revision FROM public.gallery_media_album_membership l
  JOIN public.gallery_media_item m ON m.athlete_id=l.athlete_id AND m.id=l.media_item_id
  WHERE l.athlete_id=tenant AND l.album_id=target AND m.deleted_at IS NULL
  ORDER BY m.id FOR UPDATE OF m LOOP
  affected:=affected+1;
  IF affected>1000 THEN RAISE EXCEPTION 'GALLERY_ALBUM_DETACH_LIMIT'; END IF;
  IF item.access_revision>=2147483646 THEN RAISE EXCEPTION 'MEDIA_ACCESS_CONFLICT'; END IF;
 END LOOP;
 UPDATE public.gallery_media_item m SET access_revision=m.access_revision+1,updated_at=greatest(m.updated_at,stamp)
  WHERE m.athlete_id=tenant AND m.deleted_at IS NULL AND EXISTS(
   SELECT 1 FROM public.gallery_media_album_membership l WHERE l.athlete_id=tenant
    AND l.album_id=target AND l.media_item_id=m.id);
 GET DIAGNOSTICS updated=ROW_COUNT;
 IF updated<>affected THEN RAISE EXCEPTION 'MEDIA_ACCESS_CONFLICT'; END IF;
 DELETE FROM public.gallery_media_album_membership WHERE athlete_id=tenant AND album_id=target;
 RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.detach_gallery_album_memberships_v1(uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.create_gallery_album_v1(command jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.lock_gallery_album_command_v1(); normalized jsonb; result jsonb;
 row_value public.gallery_album%ROWTYPE; stamp timestamptz;
BEGIN
 normalized:=public.normalize_gallery_album_command_v1('create_album',command,key);
 result:=public.replay_gallery_album_command_v1('create_album',key,normalized);
 IF result IS NOT NULL THEN RETURN result; END IF;
 -- Pure album authoring is outside core app-consent processing; actual attachment
 -- and coaching retrieval retain their own admission at those boundaries.
 PERFORM public.require_gallery_navigation_authoring_v1();
 stamp:=clock_timestamp();
 INSERT INTO public.gallery_album(athlete_id,id,title,revision,created_at,updated_at)
 VALUES(tenant,gen_random_uuid(),normalized->'command'->>'title',1,stamp,stamp) RETURNING * INTO row_value;
 result:=public.gallery_album_dto_v1(row_value);
 PERFORM public.finish_gallery_album_command_v1('create_album',key,normalized,row_value.id,NULL,result,stamp);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_gallery_album_v1(jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.rename_gallery_album_v1(command jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.lock_gallery_album_command_v1(); normalized jsonb; result jsonb;
 row_value public.gallery_album%ROWTYPE; target uuid; expected integer; stamp timestamptz;
BEGIN
 normalized:=public.normalize_gallery_album_command_v1('rename_album',command,key);
 result:=public.replay_gallery_album_command_v1('rename_album',key,normalized);
 IF result IS NOT NULL THEN RETURN result; END IF;
 PERFORM public.require_gallery_navigation_authoring_v1();
 target:=(normalized->'command'->>'albumId')::uuid; expected:=(normalized->'command'->>'expectedRevision')::integer;
 SELECT * INTO row_value FROM public.gallery_album WHERE athlete_id=tenant AND id=target AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ALBUM_NOT_FOUND'; END IF;
 IF row_value.revision<>expected OR expected>=2147483646 THEN RAISE EXCEPTION 'ALBUM_CONFLICT'; END IF;
 stamp:=greatest(row_value.updated_at,clock_timestamp());
 UPDATE public.gallery_album SET title=normalized->'command'->>'title',revision=revision+1,updated_at=stamp
  WHERE athlete_id=tenant AND id=target AND revision=expected AND deleted_at IS NULL RETURNING * INTO row_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'ALBUM_CONFLICT'; END IF;
 result:=public.gallery_album_dto_v1(row_value);
 PERFORM public.finish_gallery_album_command_v1('rename_album',key,normalized,target,expected,result,stamp);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.rename_gallery_album_v1(jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.delete_gallery_album_v1(command jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.lock_gallery_album_command_v1(); normalized jsonb; result jsonb;
 row_value public.gallery_album%ROWTYPE; target uuid; expected integer; stamp timestamptz; detached integer;
BEGIN
 normalized:=public.normalize_gallery_album_command_v1('delete_album',command,key);
 result:=public.replay_gallery_album_command_v1('delete_album',key,normalized);
 IF result IS NOT NULL THEN RETURN result; END IF;
 -- Deletion is allowed after app consent withdrawal and under CLOSED restore
 -- control; it creates no new processing and only removes/detaches.
 target:=(normalized->'command'->>'albumId')::uuid; expected:=(normalized->'command'->>'expectedRevision')::integer;
 SELECT * INTO row_value FROM public.gallery_album WHERE athlete_id=tenant AND id=target AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ALBUM_NOT_FOUND'; END IF;
 IF row_value.revision<>expected OR expected>=2147483646 THEN RAISE EXCEPTION 'ALBUM_CONFLICT'; END IF;
 stamp:=greatest(row_value.updated_at,clock_timestamp());
 detached:=public.detach_gallery_album_memberships_v1(target,stamp);
 UPDATE public.gallery_album SET revision=revision+1,updated_at=stamp,deleted_at=stamp
  WHERE athlete_id=tenant AND id=target AND revision=expected AND deleted_at IS NULL RETURNING * INTO row_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'ALBUM_CONFLICT'; END IF;
 INSERT INTO public.gallery_album_deletion(athlete_id,album_id,deleted_revision,deleted_at)
 VALUES(tenant,target,row_value.revision,stamp);
 PERFORM public.redact_gallery_album_receipts_v1(target);
 result:=jsonb_build_object('schemaVersion',1,'status','deleted','albumId',target,
  'revision',row_value.revision,'detachedMediaCount',detached);
 PERFORM public.finish_gallery_album_command_v1('delete_album',key,normalized,target,expected,result,stamp);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.delete_gallery_album_v1(jsonb,text) FROM PUBLIC;

-- Explicit user command only: sets or clears one album membership and one saved
-- exact course tuple under media access-revision CAS. Never derives either.
CREATE FUNCTION public.set_gallery_media_navigation_v1(command jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.lock_gallery_album_command_v1(); normalized jsonb; result jsonb;
 target uuid; expected integer; stamp timestamptz; head public.gallery_media_item%ROWTYPE;
 album jsonb; course jsonb; existing public.gallery_media_course_association%ROWTYPE;
BEGIN
 normalized:=public.normalize_gallery_album_command_v1('set_media_navigation',command,key);
 result:=public.replay_gallery_album_command_v1('set_media_navigation',key,normalized);
 IF result IS NOT NULL THEN RETURN result; END IF;
 PERFORM public.require_gallery_navigation_authoring_v1();
 target:=(normalized->'command'->>'mediaItemId')::uuid;
 expected:=(normalized->'command'->>'expectedAccessRevision')::integer;
 album:=normalized->'command'->'albumMembership'; course:=normalized->'command'->'courseLink';
 SELECT * INTO head FROM public.gallery_media_item WHERE athlete_id=tenant AND id=target AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND'; END IF;
 IF head.access_revision<>expected OR expected>=2147483646 THEN RAISE EXCEPTION 'MEDIA_ACCESS_CONFLICT'; END IF;
 IF jsonb_typeof(album)='object' THEN
  INSERT INTO public.gallery_media_album_membership(athlete_id,media_item_id,album_id)
  VALUES(tenant,target,(album->>'albumId')::uuid)
  ON CONFLICT(athlete_id,media_item_id) DO UPDATE SET album_id=EXCLUDED.album_id;
 ELSE
  DELETE FROM public.gallery_media_album_membership WHERE athlete_id=tenant AND media_item_id=target;
 END IF;
 IF jsonb_typeof(course)='object' THEN
  SELECT * INTO existing FROM public.gallery_media_course_association
   WHERE athlete_id=tenant AND media_item_id=target FOR UPDATE;
  IF NOT FOUND THEN
   INSERT INTO public.gallery_media_course_association(athlete_id,media_item_id,course_id,course_revision,revision_id)
   VALUES(tenant,target,(course->>'courseId')::uuid,(course->>'courseRevision')::integer,(course->>'revisionId')::uuid);
  ELSIF (existing.course_id,existing.course_revision,existing.revision_id) IS DISTINCT FROM
   ((course->>'courseId')::uuid,(course->>'courseRevision')::integer,(course->>'revisionId')::uuid) THEN
   UPDATE public.gallery_media_course_association SET course_id=(course->>'courseId')::uuid,
    course_revision=(course->>'courseRevision')::integer,revision_id=(course->>'revisionId')::uuid
    WHERE athlete_id=tenant AND media_item_id=target;
  END IF;
 ELSE
  DELETE FROM public.gallery_media_course_association WHERE athlete_id=tenant AND media_item_id=target;
 END IF;
 stamp:=greatest(head.updated_at,clock_timestamp());
 UPDATE public.gallery_media_item SET access_revision=access_revision+1,updated_at=stamp
  WHERE athlete_id=tenant AND id=target AND access_revision=expected AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_ACCESS_CONFLICT'; END IF;
 result:=public.gallery_media_navigation_projection_v1(target);
 IF result IS NULL THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND'; END IF;
 PERFORM public.finish_gallery_album_command_v1('set_media_navigation',key,normalized,target,expected,result,stamp);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.set_gallery_media_navigation_v1(jsonb,text) FROM PUBLIC;

-- Called by the extension media-delete path in the same transaction as the
-- tombstone. Removes navigation relations and redacts membership receipts that
-- carry media descriptors. The media tombstone itself is not changed here.
CREATE FUNCTION public.remove_gallery_navigation_deleted_media_v1(target uuid,revision integer,stamp timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_context_v1();
BEGIN
 IF target IS NULL OR revision IS NULL OR stamp IS NULL THEN RAISE EXCEPTION 'INVALID_GALLERY_ALBUM_COMMAND'; END IF;
 PERFORM 1 FROM public.gallery_media_item WHERE athlete_id=tenant AND id=target
  AND access_revision=revision AND deleted_at=stamp FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND'; END IF;
 DELETE FROM public.gallery_media_album_membership WHERE athlete_id=tenant AND media_item_id=target;
 DELETE FROM public.gallery_media_course_association WHERE athlete_id=tenant AND media_item_id=target;
 UPDATE public.gallery_navigation_command_receipt SET state='redacted',result=NULL
  WHERE athlete_id=tenant AND target_media_item_id=target AND state='committed';
END $$;
REVOKE ALL ON FUNCTION public.remove_gallery_navigation_deleted_media_v1(uuid,integer,timestamptz) FROM PUBLIC;

-- Owner-only helper; erase_gallery_navigation_extension_account_v1 calls it
-- BEFORE the historical media/activity erase chain.
CREATE FUNCTION public.erase_gallery_album_rows_v1() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_erasure_context_v1();
BEGIN
 DELETE FROM public.gallery_media_album_membership WHERE athlete_id=tenant;
 DELETE FROM public.gallery_media_course_association WHERE athlete_id=tenant;
 DELETE FROM public.gallery_navigation_command_receipt WHERE athlete_id=tenant;
 DELETE FROM public.gallery_album WHERE athlete_id=tenant;
 DELETE FROM public.gallery_album_deletion WHERE athlete_id=tenant;
END $$;
REVOKE ALL ON FUNCTION public.erase_gallery_album_rows_v1() FROM PUBLIC;

-- Account erasure successor: extension rows first, then the unchanged
-- historical public.erase_account chain in the same transaction.
CREATE FUNCTION public.erase_gallery_navigation_extension_account_v1(athlete text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=public.assert_gallery_album_erasure_context_v1();
BEGIN
 IF athlete IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
 PERFORM public.erase_gallery_album_rows_v1();
 RETURN public.erase_account(athlete);
END $$;
REVOKE ALL ON FUNCTION public.erase_gallery_navigation_extension_account_v1(text) FROM PUBLIC;
