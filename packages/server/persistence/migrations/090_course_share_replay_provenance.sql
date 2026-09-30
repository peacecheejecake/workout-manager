-- Future-only provenance for a course-share revocation. Migration 075's old events
-- remain version-1 facts without a reason or audit identity and are not backfilled.
-- The source update and its audit insertion must commit in the same transaction.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_record_version_check,
  DROP CONSTRAINT restore_suppression_event_share_cause_check,
  ADD COLUMN course_share_revoke_reason text,
  ADD COLUMN course_share_audit_id uuid,
  ADD COLUMN course_share_audit_occurred_at timestamptz,
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
  ),
  ADD CONSTRAINT restore_suppression_event_share_cause_check CHECK (
    (share_cause_kind IS NULL) = (share_cause_event_id IS NULL)
    AND (share_cause_kind IS NULL OR
      (kind='resource_share_revoked'
       AND share_cause_kind IN ('resource_deleted','tenant_erased')))
    AND (record_version=2 AND kind='resource_share_revoked')
      = (share_cause_event_id IS NOT NULL)
    AND (share_cause_event_id IS NULL OR share_cause_event_id<>event_id)
  );
CREATE UNIQUE INDEX restore_suppression_course_share_audit_once
  ON public.restore_suppression_event(athlete_id,course_share_audit_id)
  WHERE record_version=2;

CREATE TABLE public.restore_course_share_revoke_pending (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  share_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch BETWEEN 1 AND 2147483646),
  course_revision integer NOT NULL CHECK (course_revision BETWEEN 1 AND 2147483646),
  occurred_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('owner','owner_all','zone_added','zone_removed')),
  source_txid bigint NOT NULL,
  UNIQUE (athlete_id,share_id)
);
REVOKE ALL ON TABLE public.restore_course_share_revoke_pending FROM PUBLIC;
ALTER TABLE public.restore_course_share_revoke_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_course_share_revoke_pending FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY course_share_revoke_owner ON '
    'public.restore_course_share_revoke_pending TO %I '
    'USING (true) WITH CHECK (true)',current_user);
END $$;
CREATE TRIGGER course_share_revoke_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_course_share_revoke_pending
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER course_share_revoke_immutable_truncate
  BEFORE TRUNCATE ON public.restore_course_share_revoke_pending
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- Replaces only the future source capture. The same AFTER UPDATE trigger from 075
-- calls this definition, so one update cannot insert both an old and a new event.
CREATE OR REPLACE FUNCTION public.record_course_share_revoke_suppression_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'COURSE_SHARE_EVENT_TENANT_MISMATCH'; END IF;
  INSERT INTO public.restore_course_share_revoke_pending(
    event_id,athlete_id,course_id,share_id,epoch,course_revision,occurred_at,reason,source_txid)
  VALUES(gen_random_uuid(),NEW.athlete_id,NEW.course_id,NEW.share_id,NEW.epoch,
    NEW.course_revision,NEW.revoked_at,NEW.revoke_reason,txid_current());
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_course_share_revoke_suppression_event() FROM PUBLIC;

CREATE FUNCTION public.finish_course_share_revoke_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pending public.restore_course_share_revoke_pending%ROWTYPE;
DECLARE share public.course_share%ROWTYPE;
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'COURSE_SHARE_AUDIT_TENANT_MISMATCH'; END IF;
  SELECT * INTO pending FROM public.restore_course_share_revoke_pending p
    WHERE p.athlete_id=NEW.athlete_id AND p.share_id=NEW.share_id
      AND p.source_txid=txid_current() FOR UPDATE;
  SELECT * INTO share FROM public.course_share s
    WHERE s.athlete_id=NEW.athlete_id AND s.share_id=NEW.share_id FOR UPDATE;
  IF pending.event_id IS NULL OR share.share_id IS NULL
    OR NEW.course_id IS DISTINCT FROM pending.course_id
    OR NEW.reason IS DISTINCT FROM pending.reason
    OR NEW.occurred_at<pending.occurred_at
    OR share.course_id IS DISTINCT FROM pending.course_id
    OR share.course_revision IS DISTINCT FROM pending.course_revision
    OR share.epoch IS DISTINCT FROM pending.epoch
    OR share.state IS DISTINCT FROM 'revoked'
    OR share.revoke_reason IS DISTINCT FROM pending.reason
    OR share.revoked_at IS DISTINCT FROM pending.occurred_at
  THEN RAISE EXCEPTION 'COURSE_SHARE_AUDIT_SOURCE_MISMATCH'; END IF;
  INSERT INTO public.restore_suppression_event(
    event_id,record_version,athlete_id,kind,target_id,course_share_id,course_share_epoch,
    course_share_course_revision,occurred_at,course_share_revoke_reason,
    course_share_audit_id,course_share_audit_occurred_at)
  VALUES(pending.event_id,2,pending.athlete_id,'course_share_revoked',pending.course_id,
    pending.share_id,pending.epoch,pending.course_revision,pending.occurred_at,
    pending.reason,NEW.audit_id,NEW.occurred_at);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.finish_course_share_revoke_provenance() FROM PUBLIC;
CREATE TRIGGER course_share_revoke_provenance_audit
  AFTER INSERT ON public.course_share_audit
  FOR EACH ROW WHEN (NEW.action='revoked')
  EXECUTE FUNCTION public.finish_course_share_revoke_provenance();

-- Constraint triggers run at COMMIT even when a caller catches a prior statement
-- failure with a savepoint. No pending transition may survive without its event.
CREATE FUNCTION public.require_course_share_revoke_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.record_version=2 AND e.kind='course_share_revoked' AND e.target_id=NEW.course_id
      AND e.course_share_id=NEW.share_id AND e.course_share_epoch=NEW.epoch
      AND e.course_share_course_revision=NEW.course_revision
      AND e.occurred_at=NEW.occurred_at
      AND e.course_share_revoke_reason=NEW.reason
      AND EXISTS(SELECT 1 FROM public.course_share_audit a
        WHERE a.athlete_id=NEW.athlete_id AND a.audit_id=e.course_share_audit_id
          AND a.share_id=NEW.share_id AND a.course_id=NEW.course_id
          AND a.action='revoked' AND a.reason=NEW.reason
          AND a.occurred_at=e.course_share_audit_occurred_at))
  THEN RAISE EXCEPTION 'COURSE_SHARE_REVOKE_PROVENANCE_MISSING'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.require_course_share_revoke_provenance() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER course_share_revoke_provenance_complete
  AFTER INSERT ON public.restore_course_share_revoke_pending
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.require_course_share_revoke_provenance();
