-- A resource share has its own stable UUID and immutable grantee binding. Record
-- the active -> revoked transition without copying the grantee principal, content,
-- URL or object reference. Resource deletion and account erasure use the same
-- transition and are captured too. Older revoked rows are not backfilled.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_target_check,
  ADD COLUMN share_id uuid,
  ADD COLUMN share_granted_access_revision integer,
  ADD COLUMN share_revoked_access_revision integer,
  ADD CONSTRAINT restore_suppression_event_share_fields CHECK (
    (kind='resource_share_revoked') = (share_id IS NOT NULL)
    AND (kind='resource_share_revoked') = (share_granted_access_revision IS NOT NULL)
    AND (kind='resource_share_revoked') = (share_revoked_access_revision IS NOT NULL)
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
  );
CREATE UNIQUE INDEX restore_suppression_event_resource_share_once
  ON public.restore_suppression_event(athlete_id,share_id)
  WHERE kind='resource_share_revoked';

CREATE FUNCTION public.record_resource_share_revoke_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESOURCE_SHARE_EVENT_TENANT_MISMATCH'; END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,share_id,occurred_at,
    share_granted_access_revision,share_revoked_access_revision)
  VALUES(NEW.athlete_id,'resource_share_revoked',NEW.resource_id,NEW.share_id,
    NEW.revoked_at,NEW.granted_access_revision,NEW.revoked_access_revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_resource_share_revoke_suppression_event()
  FROM PUBLIC;
CREATE TRIGGER record_resource_share_revoke_suppression_event
  AFTER UPDATE OF state ON public.resource_share
  FOR EACH ROW WHEN (OLD.state='active' AND NEW.state='revoked')
  EXECUTE FUNCTION public.record_resource_share_revoke_suppression_event();
