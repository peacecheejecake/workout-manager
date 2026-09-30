-- Record only the user's check-in deletion tombstone transition. The health
-- values and local date have already been cleared by this UPDATE; no health
-- payload or old revision body enters the event. Account erasure uses DELETE.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_target_check,
  ADD COLUMN check_in_revision integer,
  ADD CONSTRAINT restore_suppression_event_kind_target_check CHECK (
    (kind='tenant_erased' AND target_id IS NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NULL)
    OR (kind='course_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NULL)
    OR (kind='activity_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NOT NULL AND activity_revision>0
      AND source_kind IS NOT NULL AND source_kind IN ('fit','fixture','manual','healthkit')
      AND source_id IS NOT NULL AND length(source_id) BETWEEN 1 AND 200
      AND source_revision IS NOT NULL AND source_revision>0
      AND source_content_hash IS NOT NULL AND source_content_hash ~ '^[a-f0-9]{64}$'
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NULL)
    OR (kind='resource_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NOT NULL
      AND resource_access_revision BETWEEN 1 AND 2147483646
      AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NULL)
    OR (kind='gallery_media_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NOT NULL
      AND gallery_access_revision BETWEEN 1 AND 2147483646
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NULL)
    OR (kind IN ('healthkit_consent_transition','ai_consent_transition')
      AND target_id IS NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_revision IS NOT NULL AND consent_revision BETWEEN 1 AND 2147483647
      AND consent_granted IS NOT NULL AND check_in_revision IS NULL
      AND (
        (consent_previous_revision IS NULL AND consent_previous_granted IS NULL
          AND consent_revision=1)
        OR (consent_previous_revision IS NOT NULL
          AND consent_previous_revision BETWEEN 1 AND 2147483646
          AND consent_previous_granted IS NOT NULL
          AND consent_revision=consent_previous_revision+1)
      ))
    OR (kind='check_in_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NOT NULL
      AND check_in_revision BETWEEN 2 AND 2147483646)
  );
CREATE UNIQUE INDEX restore_suppression_event_check_in_deleted_once
  ON public.restore_suppression_event(athlete_id,target_id)
  WHERE kind='check_in_deleted';

CREATE FUNCTION public.record_check_in_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF OLD.deleted AND NOT NEW.deleted THEN
    RAISE EXCEPTION 'CHECK_IN_DELETION_REVERSAL';
  END IF;
  IF OLD.deleted OR NOT NEW.deleted THEN RETURN NULL; END IF;
  IF OLD.athlete_id IS DISTINCT FROM NEW.athlete_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR NEW.revision IS DISTINCT FROM OLD.revision+1
    OR NEW.values_json IS NOT NULL OR NEW.local_date IS NOT NULL
    OR NEW.updated_at IS NULL
  THEN RAISE EXCEPTION 'CHECK_IN_DELETION_INVALID'; END IF;
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'CHECK_IN_DELETION_TENANT_MISMATCH'; END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,check_in_revision)
  VALUES(NEW.athlete_id,'check_in_deleted',NEW.id,NEW.updated_at,NEW.revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_check_in_deletion_suppression_event()
  FROM PUBLIC;
CREATE TRIGGER record_check_in_deletion_suppression_event
  AFTER UPDATE OF deleted ON public.check_in
  FOR EACH ROW EXECUTE FUNCTION public.record_check_in_deletion_suppression_event();
