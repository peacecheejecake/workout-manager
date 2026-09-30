-- A gallery item's live -> deleted head transition carries the stable item ID,
-- access revision and deletion time. Keep the local fact independent of the
-- media row so account erasure cannot remove it. No caption, filename, object
-- key, hash, capture time, or byte metadata enters this event.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_target_check,
  ADD COLUMN gallery_access_revision integer,
  ADD CONSTRAINT restore_suppression_event_kind_target_check CHECK (
    (kind='tenant_erased' AND target_id IS NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL)
    OR (kind='course_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL)
    OR (kind='activity_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NOT NULL AND activity_revision>0
      AND source_kind IS NOT NULL AND source_kind IN ('fit','fixture','manual','healthkit')
      AND source_id IS NOT NULL AND length(source_id) BETWEEN 1 AND 200
      AND source_revision IS NOT NULL AND source_revision>0
      AND source_content_hash IS NOT NULL AND source_content_hash ~ '^[a-f0-9]{64}$'
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL)
    OR (kind='resource_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NOT NULL
      AND resource_access_revision BETWEEN 1 AND 2147483646
      AND gallery_access_revision IS NULL)
    OR (kind='gallery_media_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NOT NULL
      AND gallery_access_revision BETWEEN 1 AND 2147483646)
  );
CREATE UNIQUE INDEX restore_suppression_event_gallery_media_once
  ON public.restore_suppression_event(athlete_id,target_id) WHERE kind='gallery_media_deleted';

-- The existing BEFORE guard permits one access-revision bump and rejects
-- resurrection. An AFTER row trigger records only an actual first deletion;
-- later receipt, cleanup, and outbox failures roll the event back with it.
CREATE FUNCTION public.record_gallery_media_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,gallery_access_revision)
  VALUES(NEW.athlete_id,'gallery_media_deleted',NEW.id,NEW.deleted_at,NEW.access_revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_gallery_media_deletion_suppression_event() FROM PUBLIC;
CREATE TRIGGER record_gallery_media_deletion_suppression_event
  AFTER UPDATE OF deleted_at ON public.gallery_media_item
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.record_gallery_media_deletion_suppression_event();
