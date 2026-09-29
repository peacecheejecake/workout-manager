-- First transactional suppression-event foundation. This is deliberately limited to
-- tenant erasure; it is not an exportable, ordered or independently durable restore ledger.
-- No FK to an account or tenant row: the fact must survive erasure.
CREATE TABLE restore_suppression_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version = 1),
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'tenant_erased' CHECK (kind = 'tenant_erased'),
  occurred_at timestamptz NOT NULL,
  UNIQUE (athlete_id,kind)
);
REVOKE ALL ON TABLE restore_suppression_event FROM PUBLIC;
ALTER TABLE restore_suppression_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE restore_suppression_event FORCE ROW LEVEL SECURITY;
-- A SECURITY DEFINER trigger still obeys FORCE RLS when the migration owner is
-- neither superuser nor BYPASSRLS. No tenant/app role receives this policy.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY restore_suppression_event_definer ON restore_suppression_event TO %I '
    'USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE FUNCTION public.record_tenant_erasure_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public.restore_suppression_event(athlete_id,occurred_at)
    VALUES(NEW.athlete_id,NEW.erased_at);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.record_tenant_erasure_suppression_event() FROM PUBLIC;
CREATE TRIGGER tenant_erasure_suppression_event
  AFTER INSERT ON public.tenant_erasure
  FOR EACH ROW EXECUTE FUNCTION public.record_tenant_erasure_suppression_event();

CREATE FUNCTION public.reject_restore_suppression_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RESTORE_SUPPRESSION_EVENT';
END $$;
REVOKE ALL ON FUNCTION public.reject_restore_suppression_event_mutation() FROM PUBLIC;
CREATE TRIGGER restore_suppression_event_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_suppression_event
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_suppression_event_immutable_truncate
  BEFORE TRUNCATE ON public.restore_suppression_event
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- The policy is tied to the migration owner. Keep the established restore/REASSIGN
-- retarget operation complete: a new plain owner must recreate or retarget this policy
-- before the runtime resumes. This replaces only 055's current function definition.
CREATE OR REPLACE FUNCTION public.retarget_definer_policies() RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE target record;
DECLARE touched integer:=0;
BEGIN
  IF EXISTS(
    SELECT 1 FROM (VALUES('activity_track_reconcile_state'),('course_deletion'),('course_share'),
      ('course_share_rate'),('course_thumbnail_reconcile_state'),('object_scope_purge'),
      ('resource_derived_cleanup'),('resource_object_cleanup'),('restore_suppression_event'),
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
