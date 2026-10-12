-- M202-P1-03. An existing race event's localDate changes only through the atomic approval.
-- The date lives in values_json, which the runtime race writer must keep updating for
-- ordinary metadata edits, so no column privilege can express this; the guard is a trigger.
-- A non-deleted event may change values_json->'localDate' only when the caller is the table
-- owner (inside 118's SECURITY DEFINER apply_race_manual_event_v1) and an open approval
-- context of this transaction targets this event at its expected revision with the same new
-- date. Inside that approval only localDate and planVersionId may change (118 rewrites only
-- these two keys). Deletion and tombstones stay with 099's guards; inserts are unaffected.
-- SECURITY INVOKER keeps current_user equal to the real caller, as in 099 and 107.
CREATE FUNCTION public.guard_race_event_local_date_approval_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  table_owner name;
BEGIN
  IF NEW.deleted OR OLD.deleted
    OR NEW.values_json -> 'localDate' IS NOT DISTINCT FROM OLD.values_json -> 'localDate' THEN
    RETURN NEW;
  END IF;
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT table_owner
    FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
  IF current_user IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION 'RACE_DATE_APPROVAL_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF (NEW.values_json - 'localDate' - 'planVersionId')
       IS DISTINCT FROM (OLD.values_json - 'localDate' - 'planVersionId')
    OR NOT EXISTS (
      SELECT 1
        FROM public.race_manual_application_context_v1 x
        JOIN public.race_manual_application_candidate_v1 c
          ON c.athlete_id = x.athlete_id AND c.id = x.candidate_id
       WHERE x.athlete_id = NEW.athlete_id
         AND x.athlete_id = nullif(pg_catalog.current_setting('app.athlete_id', true), '')
         AND x.owner_xid = pg_catalog.txid_current()
         AND x.creator_role = session_user
         AND x.result IS NULL
         AND x.expected_event ->> 'id' = NEW.id::text
         AND (x.expected_event ->> 'revision')::integer = OLD.revision
         AND NEW.revision = OLD.revision + 1
         AND c.candidate_json IS NOT NULL
         AND NEW.values_json -> 'localDate' = c.candidate_json -> 'raceChange' -> 'newLocalDate'
    ) THEN
    RAISE EXCEPTION 'RACE_DATE_APPROVAL_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION public.guard_race_event_local_date_approval_v1() FROM PUBLIC;

-- Fires after race_head_deletion_guard and before race_suppressed_reentry_guard.
CREATE TRIGGER race_local_date_approval_guard
  BEFORE UPDATE OF values_json ON public.race_event
  FOR EACH ROW EXECUTE FUNCTION public.guard_race_event_local_date_approval_v1();
