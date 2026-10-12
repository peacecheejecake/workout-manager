-- Gallery navigation restore suppression successor (profile27, after SQL143 and SQL144).
-- Unregistered extension: applied only as a pinned member of the profile27 current-runtime
-- installer; normal107 migrate() never applies it. Adds no runtime or worker grant.
--
--  * restore_suppression_event gains record_version 8, kind 'gallery_album_deleted':
--    target_id = album id, gallery_access_revision = the album's deleted revision. The
--    successor CHECKs keep every earlier branch byte-for-byte (116 pattern) and admit the new
--    branch only with every other event column NULL. No column is added, so the event wire
--    column roster is unchanged; older exporters reject the unknown record version.
--  * The event is minted by the album's actual live -> deleted transition (070 pattern on the
--    head row), never by inserting a gallery_album_deletion row, so a restore load of
--    already-deleted albums and their ledger mints no fresh events.
--  * Owner-only exact album deletion replay with an immutable receipt (082 pattern). A missing
--    album head records its terminal deletion ledger so a later load cannot resurrect it.
--  * A media live -> deleted transition removes that item's album membership and saved course
--    link and redacts its navigation receipts in the deleting transaction, so the exact media
--    deletion replay (082) and every other deleting path leave no navigation relation behind.
--    When the item has none, nothing is touched and no SQL143 lock is required.
-- No historical function, grant, erase wrapper or restore registry is replaced.

DO $migration$
DECLARE c text; expression text; other_nulls text; branch text;
BEGIN
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO other_nulls
 FROM pg_attribute WHERE attrelid='public.restore_suppression_event'::regclass AND attnum>0 AND NOT attisdropped
  AND attname<>ALL(ARRAY['event_id','record_version','athlete_id','kind','occurred_at','target_id','gallery_access_revision']);
 IF other_nulls IS NULL THEN RAISE EXCEPTION 'GALLERY_ALBUM_EVENT_SCHEMA_MISSING'; END IF;
 branch:=format('(record_version=8 AND kind=''gallery_album_deleted'' AND target_id IS NOT NULL AND isfinite(occurred_at) AND gallery_access_revision IS NOT NULL AND gallery_access_revision BETWEEN 2 AND 2147483646 AND %s) IS TRUE',other_nulls);
 FOREACH c IN ARRAY ARRAY['restore_suppression_event_kind_target_check','restore_suppression_event_record_version_check'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
   WHERE conrelid='public.restore_suppression_event'::regclass AND conname=c;
  IF expression IS NULL THEN RAISE EXCEPTION 'GALLERY_ALBUM_EVENT_SCHEMA_MISSING'; END IF;
  EXECUTE format('ALTER TABLE public.restore_suppression_event DROP CONSTRAINT %I',c);
  EXECUTE format('ALTER TABLE public.restore_suppression_event ADD CONSTRAINT %I CHECK (((record_version<>8 AND kind<>''gallery_album_deleted'') AND (%s)) OR (%s))',c,expression,branch);
 END LOOP;
END $migration$;
CREATE UNIQUE INDEX restore_suppression_event_gallery_album_once
 ON public.restore_suppression_event(athlete_id,target_id) WHERE record_version=8;

-- The album's first live -> deleted transition records one event. Later receipt, ledger,
-- outbox or deferred terminal-check failures roll the event back with it.
CREATE FUNCTION public.record_gallery_album_deletion_suppression_event_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_gallery_album_event_id',true),'');
BEGIN
 IF replay_id IS NOT NULL THEN
  IF session_user IS DISTINCT FROM pg_get_userbyid(
   (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.restore_suppression_event'::regclass))
  THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_OWNER_REQUIRED'; END IF;
  RETURN NULL;
 END IF;
 INSERT INTO public.restore_suppression_event(record_version,athlete_id,kind,target_id,occurred_at,
  gallery_access_revision)
 VALUES(8,NEW.athlete_id,'gallery_album_deleted',NEW.id,NEW.deleted_at,NEW.revision);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_gallery_album_deletion_suppression_event_v1() FROM PUBLIC;
CREATE TRIGGER record_gallery_album_deletion_suppression_event
 AFTER UPDATE OF deleted_at ON public.gallery_album
 FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
 EXECUTE FUNCTION public.record_gallery_album_deletion_suppression_event_v1();

-- A deleted media item keeps no album membership, saved course link or navigation receipt
-- descriptor. Same effect as remove_gallery_navigation_deleted_media_v1, which stays an
-- idempotent no-op after this trigger. Relations, when present, are removed under the
-- SQL143 guards (owner, tenant, global/lifecycle/command locks); none present, none needed.
CREATE FUNCTION public.remove_gallery_navigation_on_media_deletion_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.gallery_media_album_membership l
   WHERE l.athlete_id=NEW.athlete_id AND l.media_item_id=NEW.id)
  AND NOT EXISTS(SELECT 1 FROM public.gallery_media_course_association c
   WHERE c.athlete_id=NEW.athlete_id AND c.media_item_id=NEW.id)
  AND NOT EXISTS(SELECT 1 FROM public.gallery_navigation_command_receipt r
   WHERE r.athlete_id=NEW.athlete_id AND r.target_media_item_id=NEW.id AND r.state='committed')
 THEN RETURN NULL; END IF;
 tenant:=public.assert_gallery_album_context_v1();
 IF NEW.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'GALLERY_ALBUM_TENANT_MISMATCH'; END IF;
 DELETE FROM public.gallery_media_album_membership WHERE athlete_id=tenant AND media_item_id=NEW.id;
 DELETE FROM public.gallery_media_course_association WHERE athlete_id=tenant AND media_item_id=NEW.id;
 UPDATE public.gallery_navigation_command_receipt SET state='redacted',result=NULL
  WHERE athlete_id=tenant AND target_media_item_id=NEW.id AND state='committed';
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.remove_gallery_navigation_on_media_deletion_v1() FROM PUBLIC;
CREATE TRIGGER gallery_navigation_media_deleted
 AFTER UPDATE OF deleted_at ON public.gallery_media_item
 FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
 EXECUTE FUNCTION public.remove_gallery_navigation_on_media_deletion_v1();

-- Owner-only offline replay receipt of a backup-authenticated album deletion.
CREATE TABLE public.restore_gallery_album_replay_receipt (
 event_id uuid PRIMARY KEY,
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 album_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
 deleted_revision integer NOT NULL CHECK(deleted_revision BETWEEN 2 AND 2147483646),
 outcome text NOT NULL CHECK(outcome IN ('deleted','recorded_absent'))
);
REVOKE ALL ON TABLE public.restore_gallery_album_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_gallery_album_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_gallery_album_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_gallery_album_replay_receipt_owner ON public.restore_gallery_album_replay_receipt
 USING(session_user=pg_get_userbyid(
  (SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.restore_gallery_album_replay_receipt'::regclass)))
 WITH CHECK(session_user=pg_get_userbyid(
  (SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.restore_gallery_album_replay_receipt'::regclass)));
CREATE FUNCTION public.verify_restore_gallery_album_replay_receipt_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
  WHERE e.event_id=NEW.event_id AND e.record_version=8 AND e.athlete_id=NEW.athlete_id
   AND e.kind='gallery_album_deleted' AND e.target_id=NEW.album_id
   AND e.occurred_at=NEW.occurred_at AND e.gallery_access_revision=NEW.deleted_revision)
 THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_RECEIPT_CONFLICT'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_gallery_album_replay_receipt_v1() FROM PUBLIC;
CREATE TRIGGER restore_gallery_album_replay_receipt_verify
 BEFORE INSERT ON public.restore_gallery_album_replay_receipt
 FOR EACH ROW EXECUTE FUNCTION public.verify_restore_gallery_album_replay_receipt_v1();
CREATE TRIGGER restore_gallery_album_replay_receipt_immutable_rows
 BEFORE UPDATE OR DELETE ON public.restore_gallery_album_replay_receipt
 FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_gallery_album_replay_receipt_immutable_truncate
 BEFORE TRUNCATE ON public.restore_gallery_album_replay_receipt
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- Owner-only exact replay: (tenant, album, event, deleted_at, deleted_revision). Caller is the
-- plain migration owner with app.athlete_id = tenant. Lock order: global restore fence, then
-- tenant lifecycle, then tenant command (never global after tenant).
CREATE FUNCTION public.replay_gallery_album_deletion_exact_v1(text,uuid,uuid,timestamptz,integer)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
 (SELECT p.proowner FROM pg_catalog.pg_proc p
  WHERE p.oid='public.replay_gallery_album_deletion_exact_v1(text,uuid,uuid,timestamptz,integer)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_gallery_album_replay_receipt%ROWTYPE;
DECLARE head public.gallery_album%ROWTYPE;
DECLARE terminal public.gallery_album_deletion%ROWTYPE;
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE other_tenant text;
DECLARE had_event boolean;
DECLARE detached integer;
DECLARE outcome text;
BEGIN
 IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name AND (r.rolsuper OR r.rolbypassrls))
 THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_OWNER_REQUIRED'; END IF;
 IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR NOT isfinite($4) OR $4>clock_timestamp()
  OR $5 IS NULL OR $5 NOT BETWEEN 2 AND 2147483646
  OR $1 IS DISTINCT FROM nullif(caller_tenant,'')
 THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_INVALID_ENTRY'; END IF;
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 SELECT * INTO existing FROM public.restore_suppression_event
  WHERE event_id=$3 OR (athlete_id=$1 AND record_version=8 AND target_id=$2)
  FOR UPDATE;
 had_event:=FOUND;
 IF had_event AND (existing.event_id IS DISTINCT FROM $3
  OR existing.record_version IS DISTINCT FROM 8
  OR existing.athlete_id IS DISTINCT FROM $1
  OR existing.kind IS DISTINCT FROM 'gallery_album_deleted'
  OR existing.target_id IS DISTINCT FROM $2 OR existing.occurred_at IS DISTINCT FROM $4
  OR existing.gallery_access_revision IS DISTINCT FROM $5
  OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
   WHERE (e.event_id=$3 OR (e.athlete_id=$1 AND e.record_version=8 AND e.target_id=$2))
    AND e.event_id<>existing.event_id))
 THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_EVENT_CONFLICT'; END IF;
 IF had_event THEN
  SELECT * INTO receipt FROM public.restore_gallery_album_replay_receipt r WHERE r.event_id=$3;
  IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1 OR receipt.album_id IS DISTINCT FROM $2
   OR receipt.occurred_at IS DISTINCT FROM $4 OR receipt.deleted_revision IS DISTINCT FROM $5
  THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_RECEIPT_MISSING'; END IF;
 ELSIF EXISTS(SELECT 1 FROM public.restore_gallery_album_replay_receipt r WHERE r.event_id=$3)
 THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_RECEIPT_CONFLICT'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
  IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
   JOIN public.restore_suppression_event e ON e.event_id=r.event_id
   WHERE r.athlete_id=$1 AND r.kind='tenant_erased' AND e.athlete_id=$1 AND e.kind='tenant_erased')
  THEN RETURN 'already_applied_by_erasure'; END IF;
  RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_TENANT_ERASED';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
 THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_TENANT_UNKNOWN'; END IF;
 SELECT * INTO head FROM public.gallery_album a WHERE a.athlete_id=$1 AND a.id=$2 FOR UPDATE;
 SELECT * INTO terminal FROM public.gallery_album_deletion d WHERE d.athlete_id=$1 AND d.album_id=$2;
 IF had_event THEN
  IF terminal.album_id IS NULL OR terminal.deleted_at IS DISTINCT FROM $4
   OR terminal.deleted_revision IS DISTINCT FROM $5
   OR (head.id IS NOT NULL AND (head.deleted_at IS DISTINCT FROM $4 OR head.revision IS DISTINCT FROM $5))
  THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_STATE_CONFLICT'; END IF;
  RETURN 'already_applied';
 END IF;
 -- A deletion ledger without its event, or a head that is not exactly one revision behind,
 -- is not this event's pre-state.
 IF terminal.album_id IS NOT NULL THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_STATE_CONFLICT'; END IF;
 IF head.id IS NULL THEN
  -- A foreign head is hidden by FORCE RLS. Probe each account under its own tenant setting
  -- before recording a terminal ledger for an absent album.
  FOR other_tenant IN SELECT a.athlete_id::text FROM identity_private.account a
   WHERE a.athlete_id::text<>$1 ORDER BY a.athlete_id
  LOOP
   PERFORM set_config('app.athlete_id',other_tenant,true);
   IF EXISTS(SELECT 1 FROM public.gallery_album g WHERE g.athlete_id=other_tenant AND g.id=$2)
    OR EXISTS(SELECT 1 FROM public.gallery_album_deletion g WHERE g.athlete_id=other_tenant AND g.album_id=$2)
   THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_FOREIGN_ALBUM'; END IF;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  INSERT INTO public.gallery_album_deletion(athlete_id,album_id,deleted_revision,deleted_at)
  VALUES($1,$2,$5,$4);
  outcome:='recorded_absent';
 ELSE
  IF head.deleted_at IS NOT NULL OR head.revision<>$5-1 OR head.updated_at>$4
  THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_STATE_CONFLICT'; END IF;
  detached:=public.detach_gallery_album_memberships_v1($2,$4);
  PERFORM set_config('app.restore_gallery_album_event_id',$3::text,true);
  UPDATE public.gallery_album SET revision=$5,updated_at=$4,deleted_at=$4
   WHERE athlete_id=$1 AND id=$2 AND revision=$5-1 AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_GALLERY_ALBUM_STATE_CONFLICT'; END IF;
  PERFORM set_config('app.restore_gallery_album_event_id','',true);
  INSERT INTO public.gallery_album_deletion(athlete_id,album_id,deleted_revision,deleted_at)
  VALUES($1,$2,$5,$4);
  PERFORM public.redact_gallery_album_receipts_v1($2);
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
  VALUES($1,$3,'restore:gallery_album_deleted:'||$3::text,'gallery.album_deleted',
   jsonb_build_object('albumId',$2,'revision',$5,'detachedMediaCount',detached));
  outcome:='deleted';
 END IF;
 INSERT INTO public.restore_suppression_event(event_id,record_version,athlete_id,kind,target_id,
  occurred_at,gallery_access_revision)
 VALUES($3,8,$1,'gallery_album_deleted',$2,$4,$5);
 INSERT INTO public.restore_gallery_album_replay_receipt(event_id,athlete_id,album_id,occurred_at,
  deleted_revision,outcome)
 VALUES($3,$1,$2,$4,$5,outcome);
 RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION public.replay_gallery_album_deletion_exact_v1(text,uuid,uuid,timestamptz,integer)
 FROM PUBLIC;
