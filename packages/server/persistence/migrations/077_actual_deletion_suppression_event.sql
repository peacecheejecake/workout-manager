-- Local transaction facts for user-deleted manual actuals. The intake target is
-- its immutable first revision UUID, never its caller-selected text ID. The
-- recovery target is the server-generated action UUID. Neither event carries an
-- idempotency key, nutrition/health values, note, or an unkeyed payload hash.
-- This adds no backup-row replay, independent export, or restore completeness.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_target_check,
  ADD COLUMN actual_deletion_revision integer,
  ADD CONSTRAINT restore_suppression_event_actual_fields CHECK (
    (kind IN ('intake_entry_deleted','recovery_action_deleted')) =
      (actual_deletion_revision IS NOT NULL)
    AND (actual_deletion_revision IS NULL
      OR actual_deletion_revision BETWEEN 2 AND 2147483646)
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
    OR (kind IN ('intake_entry_deleted','recovery_action_deleted')
      AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL
      AND resource_access_revision IS NULL AND gallery_access_revision IS NULL
      AND consent_previous_revision IS NULL AND consent_previous_granted IS NULL
      AND consent_revision IS NULL AND consent_granted IS NULL
      AND check_in_revision IS NULL
      AND share_id IS NULL AND share_granted_access_revision IS NULL
      AND share_revoked_access_revision IS NULL
      AND course_share_id IS NULL AND course_share_epoch IS NULL
      AND course_share_course_revision IS NULL)
  );
CREATE UNIQUE INDEX restore_suppression_event_intake_entry_once
  ON public.restore_suppression_event(athlete_id,target_id)
  WHERE kind='intake_entry_deleted';
CREATE UNIQUE INDEX restore_suppression_event_recovery_action_once
  ON public.restore_suppression_event(athlete_id,target_id)
  WHERE kind='recovery_action_deleted';

-- The deleted revision already exists before the head changes. Requiring its
-- canonical tombstone and first revision prevents an ID alias or malformed
-- revision from becoming an exportable deletion fact. FORCE RLS still applies
-- to both tenant tables under the current transaction's tenant setting.
CREATE FUNCTION public.record_intake_entry_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE first_revision_id uuid;
DECLARE tombstone record;
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.current_revision IS DISTINCT FROM OLD.current_revision+1
  THEN RAISE EXCEPTION 'INTAKE_EVENT_INVALID_TRANSITION'; END IF;
  SELECT revision_id INTO first_revision_id
    FROM public.intake_entry_revision
    WHERE athlete_id=NEW.athlete_id AND intake_id=NEW.id
      AND revision=1 AND status='active';
  IF first_revision_id IS NULL THEN RAISE EXCEPTION 'INTAKE_EVENT_ORIGIN_MISSING'; END IF;
  SELECT revision_id,recorded_at,deleted_at,deletion_reason INTO tombstone
    FROM public.intake_entry_revision
    WHERE athlete_id=NEW.athlete_id AND intake_id=NEW.id
      AND revision=NEW.current_revision AND status='deleted';
  IF NOT FOUND OR tombstone.revision_id IS DISTINCT FROM NEW.current_revision_id
    OR tombstone.deleted_at IS NULL
    OR tombstone.recorded_at IS DISTINCT FROM tombstone.deleted_at
    OR tombstone.deletion_reason IS DISTINCT FROM 'user_requested'
  THEN RAISE EXCEPTION 'INTAKE_EVENT_TOMBSTONE_INVALID'; END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,actual_deletion_revision)
  VALUES(NEW.athlete_id,'intake_entry_deleted',first_revision_id,
    tombstone.deleted_at,NEW.current_revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_intake_entry_deletion_suppression_event() FROM PUBLIC;
CREATE TRIGGER record_intake_entry_deletion_suppression_event
  AFTER UPDATE OF status ON public.intake_entry
  FOR EACH ROW WHEN (OLD.status='active' AND NEW.status='deleted')
  EXECUTE FUNCTION public.record_intake_entry_deletion_suppression_event();

-- Recovery did not previously guard a head from being revived. Keep all valid
-- active corrections, but forbid a deleted head from advancing or changing
-- identity. Account erasure uses DELETE and is unaffected.
CREATE FUNCTION public.guard_recovery_action_log_advance() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.action_id IS DISTINCT FROM OLD.action_id
    OR NEW.revision IS DISTINCT FROM OLD.revision+1
    OR OLD.status='deleted'
    OR NEW.status NOT IN ('active','deleted')
  THEN RAISE EXCEPTION 'INVALID_RECOVERY_ACTION_ADVANCE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_recovery_action_log_advance() FROM PUBLIC;
CREATE TRIGGER recovery_action_log_advance
  BEFORE UPDATE ON public.recovery_action_log
  FOR EACH ROW EXECUTE FUNCTION public.guard_recovery_action_log_advance();

CREATE FUNCTION public.record_recovery_action_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tombstone record;
DECLARE deleted_at timestamptz;
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.action_id IS DISTINCT FROM OLD.action_id
    OR NEW.revision IS DISTINCT FROM OLD.revision+1
  THEN RAISE EXCEPTION 'RECOVERY_EVENT_INVALID_TRANSITION'; END IF;
  SELECT revision_id,record_json INTO tombstone
    FROM public.recovery_action_revision
    WHERE athlete_id=NEW.athlete_id AND action_id=NEW.action_id
      AND revision=NEW.revision AND status='deleted';
  IF NOT FOUND OR tombstone.revision_id IS DISTINCT FROM NEW.revision_id
    OR pg_catalog.jsonb_typeof(tombstone.record_json->'deletedAt') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'RECOVERY_EVENT_TOMBSTONE_INVALID'; END IF;
  deleted_at := (tombstone.record_json->>'deletedAt')::timestamptz;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,actual_deletion_revision)
  VALUES(NEW.athlete_id,'recovery_action_deleted',NEW.action_id,
    deleted_at,NEW.revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_recovery_action_deletion_suppression_event() FROM PUBLIC;
CREATE TRIGGER record_recovery_action_deletion_suppression_event
  AFTER UPDATE OF status ON public.recovery_action_log
  FOR EACH ROW WHEN (OLD.status='active' AND NEW.status='deleted')
  EXECUTE FUNCTION public.record_recovery_action_deletion_suppression_event();
