-- Future actual deletions carry their source predecessor and tombstone revision
-- identities. Historical v1 facts remain immutable and are not inferred.
-- This identifies a one-step transition; it does not reconstruct missing
-- corrections, private payloads, command receipts, or original outbox entries.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_record_version_check,
  ADD COLUMN actual_previous_revision_id uuid,
  ADD COLUMN actual_deleted_revision_id uuid,
  ADD CONSTRAINT restore_suppression_event_record_version_check CHECK (
    (record_version=1 AND course_share_revoke_reason IS NULL
      AND course_share_audit_id IS NULL AND course_share_audit_occurred_at IS NULL)
    OR (record_version=2 AND kind='resource_share_revoked'
      AND share_cause_event_id IS NOT NULL
      AND course_share_revoke_reason IS NULL AND course_share_audit_id IS NULL
      AND course_share_audit_occurred_at IS NULL)
    OR (record_version=2 AND kind='course_share_revoked'
      AND share_cause_event_id IS NULL
      AND course_share_revoke_reason IN
        ('owner','owner_all','zone_added','zone_removed')
      AND course_share_audit_id IS NOT NULL
      AND course_share_audit_occurred_at IS NOT NULL
      AND course_share_audit_occurred_at>=occurred_at)
    OR (record_version=2
      AND kind IN ('intake_entry_deleted','recovery_action_deleted')
      AND share_cause_event_id IS NULL
      AND course_share_revoke_reason IS NULL AND course_share_audit_id IS NULL
      AND course_share_audit_occurred_at IS NULL)
  ),
  ADD CONSTRAINT restore_suppression_event_actual_revision_provenance_check CHECK (
    (actual_previous_revision_id IS NULL) = (actual_deleted_revision_id IS NULL)
    AND (record_version=2
      AND kind IN ('intake_entry_deleted','recovery_action_deleted'))
      = (actual_previous_revision_id IS NOT NULL)
    AND (actual_deleted_revision_id IS NULL
      OR actual_deleted_revision_id<>actual_previous_revision_id)
  );

-- The application inserts the deleted revision immediately before advancing
-- the head in the same transaction. xmin checks that local source relationship,
-- not completeness of any exported WAL or remote ledger.
CREATE OR REPLACE FUNCTION public.record_intake_entry_deletion_suppression_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE first_revision_id uuid;
DECLARE predecessor record;
DECLARE tombstone record;
DECLARE head_xmin xid;
BEGIN
  IF OLD.status IS DISTINCT FROM 'active' OR NEW.status IS DISTINCT FROM 'deleted'
    OR NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.current_revision IS DISTINCT FROM OLD.current_revision+1
    OR OLD.current_revision_id IS NULL OR NEW.current_revision_id IS NULL
  THEN RAISE EXCEPTION 'INTAKE_EVENT_INVALID_TRANSITION'; END IF;
  SELECT revision_id INTO first_revision_id
    FROM public.intake_entry_revision
    WHERE athlete_id=NEW.athlete_id AND intake_id=NEW.id
      AND revision=1 AND status='active';
  IF first_revision_id IS NULL THEN RAISE EXCEPTION 'INTAKE_EVENT_ORIGIN_MISSING'; END IF;
  SELECT revision_id,status INTO predecessor FROM public.intake_entry_revision
    WHERE athlete_id=OLD.athlete_id AND intake_id=OLD.id
      AND revision=OLD.current_revision;
  IF NOT FOUND OR predecessor.revision_id IS DISTINCT FROM OLD.current_revision_id
    OR predecessor.status IS DISTINCT FROM 'active'
  THEN RAISE EXCEPTION 'INTAKE_EVENT_PREDECESSOR_INVALID'; END IF;
  SELECT revision_id,recorded_at,deleted_at,deletion_reason,xmin INTO tombstone
    FROM public.intake_entry_revision
    WHERE athlete_id=NEW.athlete_id AND intake_id=NEW.id
      AND revision=NEW.current_revision AND status='deleted';
  IF NOT FOUND THEN RAISE EXCEPTION 'INTAKE_EVENT_TOMBSTONE_INVALID'; END IF;
  SELECT xmin INTO head_xmin FROM public.intake_entry
    WHERE athlete_id=NEW.athlete_id AND id=NEW.id;
  IF tombstone.revision_id IS DISTINCT FROM NEW.current_revision_id
    OR tombstone.deleted_at IS NULL
    OR tombstone.recorded_at IS DISTINCT FROM tombstone.deleted_at
    OR tombstone.deletion_reason IS DISTINCT FROM 'user_requested'
    OR tombstone.xmin IS DISTINCT FROM head_xmin
  THEN RAISE EXCEPTION 'INTAKE_EVENT_TOMBSTONE_INVALID'; END IF;
  INSERT INTO public.restore_suppression_event(
    record_version,athlete_id,kind,target_id,occurred_at,
    actual_deletion_revision,actual_previous_revision_id,actual_deleted_revision_id)
  VALUES(2,NEW.athlete_id,'intake_entry_deleted',first_revision_id,
    tombstone.deleted_at,NEW.current_revision,
    OLD.current_revision_id,NEW.current_revision_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_intake_entry_deletion_suppression_event() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.record_recovery_action_deletion_suppression_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE predecessor record;
DECLARE tombstone record;
DECLARE deleted_at timestamptz;
DECLARE head_xmin xid;
BEGIN
  IF OLD.status IS DISTINCT FROM 'active' OR NEW.status IS DISTINCT FROM 'deleted'
    OR NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.action_id IS DISTINCT FROM OLD.action_id
    OR NEW.revision IS DISTINCT FROM OLD.revision+1
    OR OLD.revision_id IS NULL OR NEW.revision_id IS NULL
  THEN RAISE EXCEPTION 'RECOVERY_EVENT_INVALID_TRANSITION'; END IF;
  SELECT revision_id,status INTO predecessor FROM public.recovery_action_revision
    WHERE athlete_id=OLD.athlete_id AND action_id=OLD.action_id
      AND revision=OLD.revision;
  IF NOT FOUND OR predecessor.revision_id IS DISTINCT FROM OLD.revision_id
    OR predecessor.status IS DISTINCT FROM 'active'
  THEN RAISE EXCEPTION 'RECOVERY_EVENT_PREDECESSOR_INVALID'; END IF;
  SELECT revision_id,record_json,xmin INTO tombstone
    FROM public.recovery_action_revision
    WHERE athlete_id=NEW.athlete_id AND action_id=NEW.action_id
      AND revision=NEW.revision AND status='deleted';
  IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_EVENT_TOMBSTONE_INVALID'; END IF;
  SELECT xmin INTO head_xmin FROM public.recovery_action_log
    WHERE athlete_id=NEW.athlete_id AND action_id=NEW.action_id;
  IF tombstone.revision_id IS DISTINCT FROM NEW.revision_id
    OR tombstone.xmin IS DISTINCT FROM head_xmin
    OR pg_catalog.jsonb_typeof(tombstone.record_json->'deletedAt') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'RECOVERY_EVENT_TOMBSTONE_INVALID'; END IF;
  deleted_at := (tombstone.record_json->>'deletedAt')::timestamptz;
  INSERT INTO public.restore_suppression_event(
    record_version,athlete_id,kind,target_id,occurred_at,
    actual_deletion_revision,actual_previous_revision_id,actual_deleted_revision_id)
  VALUES(2,NEW.athlete_id,'recovery_action_deleted',NEW.action_id,
    deleted_at,NEW.revision,OLD.revision_id,NEW.revision_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_recovery_action_deletion_suppression_event() FROM PUBLIC;
