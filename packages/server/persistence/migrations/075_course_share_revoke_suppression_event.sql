-- Only an active -> revoked course link transition is captured here. The external
-- sharing epoch and per-place lifetime issuance budget are separate restore gates.
-- No token, digest, URL, recipient, snapshot, area or route leaves with this fact.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_target_check,
  ADD COLUMN course_share_id uuid,
  ADD COLUMN course_share_epoch integer,
  ADD COLUMN course_share_course_revision integer,
  ADD CONSTRAINT restore_suppression_event_course_share_fields CHECK (
    (kind='course_share_revoked') = (course_share_id IS NOT NULL)
    AND (kind='course_share_revoked') = (course_share_epoch IS NOT NULL)
    AND (kind='course_share_revoked') = (course_share_course_revision IS NOT NULL)
    AND (course_share_epoch IS NULL OR course_share_epoch BETWEEN 1 AND 2147483646)
    AND (course_share_course_revision IS NULL
      OR course_share_course_revision BETWEEN 1 AND 2147483646)
  ),
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
    OR (kind='resource_share_revoked' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL
      AND share_granted_access_revision IS NOT NULL
      AND share_granted_access_revision BETWEEN 1 AND 2147483645
      AND share_revoked_access_revision IS NOT NULL
      AND share_revoked_access_revision BETWEEN 2 AND 2147483646
      AND share_revoked_access_revision > share_granted_access_revision
      AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NULL)
    OR (kind='course_share_revoked' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NULL
      AND share_id IS NULL AND share_granted_access_revision IS NULL
      AND share_revoked_access_revision IS NULL)
  );
CREATE UNIQUE INDEX restore_suppression_event_course_share_once
  ON public.restore_suppression_event(athlete_id,course_share_id)
  WHERE kind='course_share_revoked';

CREATE FUNCTION public.record_course_share_revoke_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'COURSE_SHARE_EVENT_TENANT_MISMATCH'; END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,course_share_id,course_share_epoch,
    course_share_course_revision,occurred_at)
  VALUES(NEW.athlete_id,'course_share_revoked',NEW.course_id,NEW.share_id,NEW.epoch,
    NEW.course_revision,NEW.revoked_at);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_course_share_revoke_suppression_event()
  FROM PUBLIC;
CREATE TRIGGER record_course_share_revoke_suppression_event
  AFTER UPDATE OF state ON public.course_share
  FOR EACH ROW WHEN (OLD.state='active' AND NEW.state='revoked')
  EXECUTE FUNCTION public.record_course_share_revoke_suppression_event();
