-- Version-scoped materialization preserves immutable occurrence history and run FKs.
-- This successor never updates/deletes existing occurrence, blueprint or run rows.
DO $$
DECLARE actual_owner text; prior_definition text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO actual_owner
 FROM pg_class WHERE oid='public.routine_occurrence'::regclass;
 IF current_user IS DISTINCT FROM actual_owner THEN
  RAISE EXCEPTION 'ROUTINE_OCCURRENCE_MIGRATION_OWNER_REQUIRED';
 END IF;
 SELECT pg_get_constraintdef(oid) INTO prior_definition
 FROM pg_constraint
 WHERE conrelid='public.routine_occurrence'::regclass
   AND conname='routine_occurrence_athlete_id_schedule_id_anchor_key_key'
   AND contype='u';
 IF prior_definition IS DISTINCT FROM 'UNIQUE (athlete_id, schedule_id, anchor_key)'
 OR EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.routine_occurrence'::regclass
     AND conname='routine_occurrence_version_anchor_unique') THEN
  RAISE EXCEPTION 'ROUTINE_OCCURRENCE_MIGRATION_PREDECESSOR_REQUIRED';
 END IF;
 ALTER TABLE public.routine_occurrence
  ADD CONSTRAINT routine_occurrence_version_anchor_unique
  UNIQUE (athlete_id,schedule_id,schedule_version_id,anchor_key);
 ALTER TABLE public.routine_occurrence
  DROP CONSTRAINT routine_occurrence_athlete_id_schedule_id_anchor_key_key;
END $$;
