-- Future compound share revocations carry an authenticated parent identity. Old
-- version-1 events remain immutable and are deliberately not inferred/backfilled.
ALTER TABLE public.restore_suppression_event
  DROP CONSTRAINT restore_suppression_event_record_version_check,
  ADD COLUMN share_cause_kind text,
  ADD COLUMN share_cause_event_id uuid,
  ADD CONSTRAINT restore_suppression_event_record_version_check CHECK (record_version IN (1,2)),
  ADD CONSTRAINT restore_suppression_event_share_cause_check CHECK (
    (share_cause_kind IS NULL) = (share_cause_event_id IS NULL)
    AND (share_cause_kind IS NULL OR
      (kind='resource_share_revoked'
       AND share_cause_kind IN ('resource_deleted','tenant_erased')))
    AND (record_version=2) = (share_cause_event_id IS NOT NULL)
    AND (share_cause_event_id IS NULL OR share_cause_event_id<>event_id));

-- This row exists only inside erase_account's transaction. A caller-settable
-- app.* setting cannot authorize a cause; runtime has no table privilege.
CREATE TABLE public.restore_share_erasure_context (
  transaction_id bigint NOT NULL,
  athlete_id text NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (transaction_id,athlete_id)
);
REVOKE ALL ON public.restore_share_erasure_context FROM PUBLIC;
ALTER TABLE public.restore_share_erasure_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_share_erasure_context FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY restore_share_erasure_context_definer ON public.restore_share_erasure_context TO %I USING (true) WITH CHECK (true)',current_user);
END $$;

-- A deferred check accommodates erasure, whose child rows precede the parent.
-- Both parent and child must have been inserted by this same transaction.
CREATE FUNCTION public.verify_restore_share_cause() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.share_cause_event_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.restore_suppression_event child
    JOIN public.restore_suppression_event parent
      ON parent.event_id=child.share_cause_event_id
    WHERE child.event_id=NEW.event_id AND child.xmin=parent.xmin
      AND child.athlete_id=parent.athlete_id
      AND parent.kind=child.share_cause_kind
      AND ((parent.kind='resource_deleted'
        AND child.target_id=parent.target_id
        AND child.share_revoked_access_revision=parent.resource_access_revision)
        OR (parent.kind='tenant_erased' AND parent.target_id IS NULL
          AND child.share_revoked_access_revision=child.share_granted_access_revision+1))
  ) THEN RAISE EXCEPTION 'RESTORE_SHARE_CAUSE_CONFLICT'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_share_cause() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER restore_share_cause_verify
  AFTER INSERT ON public.restore_suppression_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.share_cause_event_id IS NOT NULL)
  EXECUTE FUNCTION public.verify_restore_share_cause();

CREATE OR REPLACE FUNCTION public.record_resource_share_revoke_suppression_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_resource_share_event_id',true),'');
DECLARE parent_id uuid;
DECLARE parent_kind text;
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESOURCE_SHARE_EVENT_TENANT_MISMATCH'; END IF;
  IF replay_id IS NOT NULL THEN
    IF session_user IS DISTINCT FROM pg_get_userbyid(
      (SELECT c.relowner FROM pg_catalog.pg_class c
       WHERE c.oid='public.restore_suppression_event'::regclass))
    THEN RAISE EXCEPTION 'RESTORE_SHARE_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  SELECT c.event_id,'tenant_erased' INTO parent_id,parent_kind
    FROM public.restore_share_erasure_context c
    WHERE c.transaction_id=txid_current() AND c.athlete_id=NEW.athlete_id;
  IF parent_id IS NULL THEN
    SELECT e.event_id,'resource_deleted' INTO parent_id,parent_kind
      FROM public.restore_suppression_event e
      JOIN public.resource_share s ON s.athlete_id=NEW.athlete_id
        AND s.share_id=NEW.share_id AND s.xmin=e.xmin
      WHERE e.athlete_id=NEW.athlete_id AND e.kind='resource_deleted'
        AND e.target_id=NEW.resource_id
        AND e.resource_access_revision=NEW.revoked_access_revision;
  END IF;
  INSERT INTO public.restore_suppression_event(
    record_version,athlete_id,kind,target_id,share_id,occurred_at,
    share_granted_access_revision,share_revoked_access_revision,
    share_cause_kind,share_cause_event_id)
  VALUES(CASE WHEN parent_id IS NULL THEN 1 ELSE 2 END,
    NEW.athlete_id,'resource_share_revoked',NEW.resource_id,NEW.share_id,
    NEW.revoked_at,NEW.granted_access_revision,NEW.revoked_access_revision,
    parent_kind,parent_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_resource_share_revoke_suppression_event() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.record_tenant_erasure_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_replay_event_id',true),'');
DECLARE replay_time text:=nullif(current_setting('app.restore_replay_occurred_at',true),'');
DECLARE parent_id uuid;
BEGIN
  SELECT c.event_id INTO parent_id FROM public.restore_share_erasure_context c
    WHERE c.transaction_id=txid_current() AND c.athlete_id=NEW.athlete_id;
  IF replay_id IS NOT NULL OR replay_time IS NOT NULL THEN
    IF replay_id IS NULL OR replay_time IS NULL
      OR session_user IS DISTINCT FROM pg_get_userbyid(
        (SELECT c.relowner FROM pg_catalog.pg_class c
         WHERE c.oid='public.restore_suppression_event'::regclass))
      OR NEW.erased_at IS DISTINCT FROM replay_time::timestamptz
      OR (parent_id IS NOT NULL AND parent_id IS DISTINCT FROM replay_id::uuid)
    THEN RAISE EXCEPTION 'RESTORE_REPLAY_OWNER_REQUIRED'; END IF;
    INSERT INTO public.restore_suppression_event(event_id,athlete_id,occurred_at)
      VALUES(replay_id::uuid,NEW.athlete_id,NEW.erased_at);
  ELSE
    INSERT INTO public.restore_suppression_event(event_id,athlete_id,occurred_at)
      VALUES(coalesce(parent_id,gen_random_uuid()),NEW.athlete_id,NEW.erased_at);
  END IF;
  DELETE FROM public.restore_share_erasure_context c
    WHERE c.transaction_id=txid_current() AND c.athlete_id=NEW.athlete_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.record_tenant_erasure_suppression_event() FROM PUBLIC;

-- Keep the 059 outer function and its stable nested chain identity. The
-- transaction-local context is consumed by the tenant-erasure event trigger.
CREATE OR REPLACE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE parent_id uuid;
DECLARE replay_id text:=nullif(current_setting('app.restore_replay_event_id',true),'');
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  IF NOT EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF replay_id IS NOT NULL THEN
      IF session_user IS DISTINCT FROM pg_get_userbyid(
        (SELECT c.relowner FROM pg_catalog.pg_class c
         WHERE c.oid='public.restore_suppression_event'::regclass))
      THEN RAISE EXCEPTION 'RESTORE_REPLAY_OWNER_REQUIRED'; END IF;
      parent_id:=replay_id::uuid;
    ELSE parent_id:=gen_random_uuid(); END IF;
    INSERT INTO public.restore_share_erasure_context(transaction_id,athlete_id,event_id)
      VALUES(txid_current(),$1,parent_id);
  END IF;
  DELETE FROM public.healthkit_workout_sample WHERE athlete_id=$1;
  DELETE FROM public.healthkit_workout_batch_receipt WHERE athlete_id=$1;
  RETURN public.erase_account_before_healthkit_ingestion($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;

-- A successful erasure must consume its context before commit. This also
-- prevents a missing tenant event from leaving a stale transaction marker.
CREATE FUNCTION public.verify_restore_share_erasure_context_consumed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.restore_share_erasure_context c
    WHERE c.transaction_id=NEW.transaction_id AND c.athlete_id=NEW.athlete_id)
  THEN RAISE EXCEPTION 'RESTORE_SHARE_ERASURE_CONTEXT_UNCONSUMED'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_share_erasure_context_consumed() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER restore_share_erasure_context_consumed
  AFTER INSERT ON public.restore_share_erasure_context
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.verify_restore_share_erasure_context_consumed();

-- Retarget the new FORCE-RLS context policy with the existing definer policies.
CREATE OR REPLACE FUNCTION public.retarget_definer_policies() RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE target record;
DECLARE touched integer:=0;
BEGIN
  IF EXISTS(
    SELECT 1 FROM (VALUES('activity_track_reconcile_state'),('course_deletion'),('course_share'),
      ('course_share_rate'),('course_thumbnail_reconcile_state'),('object_scope_purge'),
      ('resource_derived_cleanup'),('resource_object_cleanup'),('restore_suppression_event'),('restore_share_erasure_context'),
      ('routing_admission'),('tenant_object_purge'),('tenant_work_index')) AS t(table_name)
    JOIN pg_catalog.pg_class c ON c.oid=('public.'||t.table_name)::regclass
    WHERE c.relowner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r
      WHERE r.rolname=current_user)
  ) THEN RAISE EXCEPTION 'DEFINER_POLICY_OWNER_MISMATCH'; END IF;
  FOR target IN
    SELECT t.table_name,t.policy_name FROM (VALUES
      ('activity_track_reconcile_state','activity_track_reconcile_state_definer'),
      ('course_deletion','course_deletion_definer'),
      ('course_share','course_share_definer'),
      ('course_share_rate','course_share_rate_definer'),
      ('course_thumbnail_reconcile_state','course_thumbnail_reconcile_state_definer'),
      ('object_scope_purge','object_scope_purge_definer'),
      ('resource_derived_cleanup','resource_derived_cleanup_definer'),
      ('resource_object_cleanup','resource_object_cleanup_definer'),
      ('restore_suppression_event','restore_suppression_event_definer'),
      ('restore_share_erasure_context','restore_share_erasure_context_definer'),
      ('routing_admission','routing_admission_definer'),
      ('tenant_object_purge','tenant_object_purge_definer'),
      ('tenant_work_index','tenant_work_index_definer')) AS t(table_name,policy_name)
    ORDER BY t.table_name
  LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_policy p
      WHERE p.polrelid=('public.'||target.table_name)::regclass AND p.polname=target.policy_name)
    THEN
      EXECUTE format('ALTER POLICY %I ON public.%I TO %I',
        target.policy_name,target.table_name,current_user);
    ELSE
      EXECUTE format('CREATE POLICY %I ON public.%I TO %I USING (true) WITH CHECK (true)',
        target.policy_name,target.table_name,current_user);
    END IF;
    touched:=touched+1;
  END LOOP;
  RETURN touched;
END $$;
REVOKE ALL ON FUNCTION public.retarget_definer_policies() FROM PUBLIC;
