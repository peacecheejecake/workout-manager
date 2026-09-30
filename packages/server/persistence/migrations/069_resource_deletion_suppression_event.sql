-- A resource's live -> deleted head transition already carries the stable ID,
-- deletion access revision and time. Record those facts in the same transaction
-- without copying content, object keys, URLs, metadata, or sharing principals.
-- Existing tombstones are not inferred or backfilled.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_target_check,
  ADD COLUMN resource_access_revision integer,
  ADD CONSTRAINT restore_suppression_event_kind_target_check CHECK (
    (kind='tenant_erased' AND target_id IS NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL)
    OR (kind='course_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL)
    OR (kind='activity_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NOT NULL AND activity_revision>0
      AND source_kind IS NOT NULL AND source_kind IN ('fit','fixture','manual','healthkit')
      AND source_id IS NOT NULL AND length(source_id) BETWEEN 1 AND 200
      AND source_revision IS NOT NULL AND source_revision>0
      AND source_content_hash IS NOT NULL
      AND source_content_hash ~ '^[a-f0-9]{64}$'
      AND resource_access_revision IS NULL)
    OR (kind='resource_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NOT NULL
      AND resource_access_revision BETWEEN 1 AND 2147483646)
  );
CREATE UNIQUE INDEX restore_suppression_event_resource_once
  ON public.restore_suppression_event(athlete_id,target_id) WHERE kind='resource_deleted';

-- The existing resource transition guard rejects resurrection and requires a
-- one-step access revision bump. The AFTER trigger sees the committed head
-- values even when a later cleanup/outbox operation aborts the transaction.
CREATE FUNCTION public.record_resource_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,resource_access_revision)
  VALUES(NEW.athlete_id,'resource_deleted',NEW.id,NEW.deleted_at,NEW.access_revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_resource_deletion_suppression_event() FROM PUBLIC;
CREATE TRIGGER record_resource_deletion_suppression_event
  AFTER UPDATE OF deleted_at ON public.resource
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.record_resource_deletion_suppression_event();
