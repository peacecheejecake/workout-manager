-- Extend the local transactional event foundation to live owner course deletion.
-- The restore replay writes course_deletion too, but is not a new user decision;
-- only delete_course records a new event. This is still not an exportable ledger.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_kind_check,
  DROP CONSTRAINT restore_suppression_event_athlete_id_kind_key,
  ADD COLUMN target_id uuid,
  ADD CONSTRAINT restore_suppression_event_kind_target_check CHECK (
    (kind='tenant_erased' AND target_id IS NULL)
    OR (kind='course_deleted' AND target_id IS NOT NULL)
  );
CREATE UNIQUE INDEX restore_suppression_event_tenant_once
  ON public.restore_suppression_event(athlete_id) WHERE kind='tenant_erased';
CREATE UNIQUE INDEX restore_suppression_event_course_once
  ON public.restore_suppression_event(athlete_id,target_id) WHERE kind='course_deleted';

-- 049's live deletion, with one post-deletion insert added. CREATE OR REPLACE keeps
-- the runtime EXECUTE grant and the existing row-lock and deletion order. The event
-- insert and apply_course_deletion are in the same transaction: a failure rolls both back.
CREATE OR REPLACE FUNCTION public.delete_course(uuid,integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE current_head integer;
DECLARE current_status text;
DECLARE deleted_at timestamptz;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'INVALID_COURSE_DELETE'; END IF;
  SELECT c.head_revision,c.status INTO current_head,current_status FROM public.course c
    WHERE c.athlete_id=tenant AND c.course_id=$1 FOR UPDATE;
  IF current_status IS NULL THEN RETURN false; END IF;
  -- A reclaimed course has no revision left to expect; its reference is removed as it is.
  IF current_status='available' AND current_head IS DISTINCT FROM $2 THEN
    RAISE EXCEPTION 'COURSE_REVISION_CONFLICT';
  END IF;
  deleted_at:=clock_timestamp();
  PERFORM public.apply_course_deletion(tenant,$1,deleted_at);
  INSERT INTO public.restore_suppression_event(athlete_id,kind,target_id,occurred_at)
    VALUES(tenant,'course_deleted',$1,deleted_at);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.delete_course(uuid,integer) FROM PUBLIC;
