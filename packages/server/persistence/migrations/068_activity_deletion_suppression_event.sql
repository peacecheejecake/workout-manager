-- Existing live canonicals need a source identity before a deletion can be recorded.
-- The migration runs as a plain table owner too, so FORCE RLS would otherwise hide
-- other tenants' rows and let a broken upgrade appear to pass. Keep both tables
-- locked while lifting FORCE, check every live canonical, then restore FORCE before
-- committing. A failed check rolls back both ALTERs with this migration.
LOCK TABLE public.activity_canonical, public.activity_source_head IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.activity_canonical NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.activity_source_head NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.activity_canonical c
    WHERE NOT c.deleted AND NOT EXISTS (
      SELECT 1 FROM public.activity_source_head h
      WHERE h.athlete_id=c.athlete_id AND h.activity_id=c.id
    )
  ) THEN RAISE EXCEPTION 'ACTIVITY_EVENT_SOURCE_PREFLIGHT'; END IF;
END $$;
ALTER TABLE public.activity_source_head FORCE ROW LEVEL SECURITY;
ALTER TABLE public.activity_canonical FORCE ROW LEVEL SECURITY;

-- One local event for a canonical Activity's live transition to deleted. The source
-- head identifies the upstream source, while target_id and activity_revision name
-- the canonical tombstone. No activity body, coordinates or raw provider payload.
-- A restore's absent-activity replay INSERT is not a new deletion transition.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_target_check,
  ADD COLUMN activity_revision integer,
  ADD COLUMN source_kind text,
  ADD COLUMN source_id text,
  ADD COLUMN source_revision integer,
  ADD COLUMN source_content_hash text,
  ADD CONSTRAINT restore_suppression_event_kind_target_check CHECK (
    (kind='tenant_erased' AND target_id IS NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL)
    OR (kind='course_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NULL AND source_kind IS NULL AND source_id IS NULL
      AND source_revision IS NULL AND source_content_hash IS NULL)
    OR (kind='activity_deleted' AND target_id IS NOT NULL
      AND activity_revision IS NOT NULL AND activity_revision>0
      AND source_kind IS NOT NULL AND source_kind IN ('fit','fixture','manual','healthkit')
      AND source_id IS NOT NULL AND length(source_id) BETWEEN 1 AND 200
      AND source_revision IS NOT NULL AND source_revision>0
      AND source_content_hash IS NOT NULL
      AND source_content_hash ~ '^[a-f0-9]{64}$')
  );
CREATE UNIQUE INDEX restore_suppression_event_activity_once
  ON public.restore_suppression_event(athlete_id,target_id) WHERE kind='activity_deleted';

-- The user repository and HealthKit raw-removal path both UPDATE the canonical row.
-- Its BEFORE trigger has already redacted HealthKit content before this AFTER trigger
-- reads the source head, so a HealthKit event carries only the retained zero hash.
-- Fail closed if the source head is absent: a replayable deletion cannot be described.
CREATE FUNCTION public.record_activity_deletion_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE source_row record;
BEGIN
  SELECT kind,source_id,source_revision,content_hash INTO source_row
    FROM public.activity_source_head
    WHERE athlete_id=NEW.athlete_id AND activity_id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVITY_EVENT_SOURCE_MISSING'; END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,target_id,occurred_at,activity_revision,source_kind,source_id,
    source_revision,source_content_hash)
  VALUES(NEW.athlete_id,'activity_deleted',NEW.id,clock_timestamp(),NEW.revision,
    source_row.kind,source_row.source_id,source_row.source_revision,source_row.content_hash);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_activity_deletion_suppression_event() FROM PUBLIC;
CREATE TRIGGER record_activity_deletion_suppression_event
  AFTER UPDATE OF deleted ON public.activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION public.record_activity_deletion_suppression_event();
