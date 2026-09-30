-- Capture the user consent command's HealthKit epoch transitions locally.
-- An initial INSERT records absent -> revision 1. Each UPDATE records the
-- previous and new granted/revision pair, so withdrawal then re-consent cannot
-- be mistaken for continuous permission. No workout, batch, device or token.
-- Consent DELETE (outside account erasure) is not a supported user command.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_target_check,
  ADD COLUMN consent_previous_revision integer,
  ADD COLUMN consent_previous_granted boolean,
  ADD COLUMN consent_revision integer,
  ADD COLUMN consent_granted boolean,
  ADD CONSTRAINT restore_suppression_event_kind_target_check CHECK (
    (kind='tenant_erased' AND target_id IS NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL)
    OR (kind='course_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL)
    OR (kind='activity_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NOT NULL AND activity_revision>0
      AND source_kind IS NOT NULL AND source_kind IN ('fit','fixture','manual','healthkit')
      AND source_id IS NOT NULL AND length(source_id) BETWEEN 1 AND 200
      AND source_revision IS NOT NULL AND source_revision>0
      AND source_content_hash IS NOT NULL AND source_content_hash ~ '^[a-f0-9]{64}$'
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL)
    OR (kind='resource_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NOT NULL
      AND resource_access_revision BETWEEN 1 AND 2147483646
      AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL)
    OR (kind='gallery_media_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NOT NULL
      AND gallery_access_revision BETWEEN 1 AND 2147483646
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL)
    OR (kind='healthkit_consent_transition' AND target_id IS NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_revision IS NOT NULL AND consent_revision BETWEEN 1 AND 2147483647
      AND consent_granted IS NOT NULL
      AND (
        (consent_previous_revision IS NULL AND consent_previous_granted IS NULL
          AND consent_revision=1)
        OR (consent_previous_revision IS NOT NULL
          AND consent_previous_revision BETWEEN 1 AND 2147483646
          AND consent_previous_granted IS NOT NULL
          AND consent_revision=consent_previous_revision+1)
      ))
  );
CREATE UNIQUE INDEX restore_suppression_event_healthkit_consent_revision_once
  ON public.restore_suppression_event(athlete_id,consent_revision)
  WHERE kind='healthkit_consent_transition';

CREATE FUNCTION public.record_healthkit_consent_transition_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.kind<>'healthkit' AND NEW.kind<>'healthkit' THEN RETURN NULL; END IF;
    IF OLD.kind<>'healthkit' OR NEW.kind<>'healthkit'
      OR OLD.athlete_id IS DISTINCT FROM NEW.athlete_id
      OR NEW.revision IS DISTINCT FROM OLD.revision+1
    THEN RAISE EXCEPTION 'HEALTHKIT_CONSENT_EPOCH_INVALID'; END IF;
  ELSIF NEW.kind<>'healthkit' THEN RETURN NULL;
  ELSIF NEW.revision<>1 THEN RAISE EXCEPTION 'HEALTHKIT_CONSENT_EPOCH_INVALID';
  END IF;
  tenant:=NEW.athlete_id;
  IF tenant IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'HEALTHKIT_CONSENT_TENANT_MISMATCH'; END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,occurred_at,consent_previous_revision,
    consent_previous_granted,consent_revision,consent_granted)
  VALUES(tenant,'healthkit_consent_transition',clock_timestamp(),
    CASE WHEN TG_OP='UPDATE' THEN OLD.revision ELSE NULL END,
    CASE WHEN TG_OP='UPDATE' THEN OLD.granted ELSE NULL END,
    NEW.revision,NEW.granted);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_healthkit_consent_transition_suppression_event()
  FROM PUBLIC;
CREATE TRIGGER record_healthkit_consent_transition_suppression_event
  AFTER INSERT OR UPDATE ON public.consent
  FOR EACH ROW EXECUTE FUNCTION public.record_healthkit_consent_transition_suppression_event();
