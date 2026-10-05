-- Private scheduling index. Workers receive only token-fenced function access.
CREATE TABLE public.healthkit_deregistration_work (
 athlete_id text NOT NULL,
 operation_id uuid NOT NULL,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_owner uuid,
 lease_token uuid,
 lease_until timestamptz,
 failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 20),
 PRIMARY KEY(athlete_id,operation_id),
 FOREIGN KEY(athlete_id,operation_id) REFERENCES public.healthkit_workout_deregistration(athlete_id,operation_id) ON DELETE CASCADE,
 CHECK((lease_owner IS NULL)=(lease_token IS NULL) AND (lease_owner IS NULL)=(lease_until IS NULL))
);
CREATE INDEX healthkit_deregistration_work_due ON public.healthkit_deregistration_work(available_at,athlete_id,operation_id) WHERE failures<20;
CREATE INDEX healthkit_deregistration_work_failed ON public.healthkit_deregistration_work(athlete_id,operation_id) WHERE failures>=20;
ALTER TABLE public.healthkit_deregistration_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.healthkit_deregistration_work FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 EXECUTE format('CREATE POLICY healthkit_deregistration_work_definer ON public.healthkit_deregistration_work TO %I USING(true) WITH CHECK(true)',current_user);
END $$;
REVOKE ALL ON public.healthkit_deregistration_work FROM PUBLIC;
CREATE FUNCTION public.schedule_healthkit_deregistration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NEW.state='pending_cleanup' THEN
  INSERT INTO public.healthkit_deregistration_work(athlete_id,operation_id)
   VALUES(NEW.athlete_id,NEW.operation_id) ON CONFLICT DO NOTHING;
 ELSE
  DELETE FROM public.healthkit_deregistration_work WHERE athlete_id=NEW.athlete_id AND operation_id=NEW.operation_id;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.schedule_healthkit_deregistration() FROM PUBLIC;
CREATE TRIGGER healthkit_deregistration_schedule AFTER INSERT OR UPDATE OF state
 ON public.healthkit_workout_deregistration FOR EACH ROW EXECUTE FUNCTION public.schedule_healthkit_deregistration();
-- The migration owns the relation. FORCE is lifted inside this migration's transaction only.
ALTER TABLE public.healthkit_workout_deregistration NO FORCE ROW LEVEL SECURITY;
INSERT INTO public.healthkit_deregistration_work(athlete_id,operation_id)
 SELECT athlete_id,operation_id FROM public.healthkit_workout_deregistration WHERE state='pending_cleanup';
ALTER TABLE public.healthkit_workout_deregistration FORCE ROW LEVEL SECURITY;
CREATE FUNCTION public.lease_healthkit_deregistration(uuid,interval)
RETURNS TABLE(athlete_id text,operation_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE instant timestamptz:=clock_timestamp();
BEGIN
 IF $1 IS NULL OR $2 IS NULL OR $2<interval '1 second' OR $2>interval '5 minutes'
  THEN RAISE EXCEPTION 'INVALID_DEREGISTRATION_LEASE'; END IF;
 RETURN QUERY WITH candidate AS (
  SELECT q.athlete_id,q.operation_id FROM public.healthkit_deregistration_work q
  WHERE q.available_at<=instant AND q.failures<20 AND (q.lease_until IS NULL OR q.lease_until<=instant)
  ORDER BY q.available_at,q.athlete_id,q.operation_id FOR UPDATE SKIP LOCKED LIMIT 1
 ), changed AS (
  UPDATE public.healthkit_deregistration_work q SET lease_owner=$1,lease_token=gen_random_uuid(),
   lease_until=instant+$2, failures=q.failures+CASE WHEN q.lease_owner IS NULL THEN 0 ELSE 1 END
  FROM candidate c WHERE q.athlete_id=c.athlete_id AND q.operation_id=c.operation_id
  RETURNING q.athlete_id,q.operation_id,q.lease_token
 ) SELECT * FROM changed;
END $$;
REVOKE ALL ON FUNCTION public.lease_healthkit_deregistration(uuid,interval) FROM PUBLIC;
CREATE FUNCTION public.finish_healthkit_deregistration(uuid,text,uuid,uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE previous_tenant text:=current_setting('app.athlete_id',true);
DECLARE job public.healthkit_deregistration_work%ROWTYPE;
DECLARE result jsonb; outcome text;
BEGIN
 IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL THEN RETURN 'lease_lost'; END IF;
 -- Peek only. Never acquire a queue row lock before the tenant command lock.
 IF NOT EXISTS(SELECT 1 FROM public.healthkit_deregistration_work q
   WHERE q.athlete_id=$2 AND q.operation_id=$3 AND q.lease_owner=$1 AND q.lease_token=$4
    AND q.lease_until>clock_timestamp()) THEN RETURN 'lease_lost'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended($2,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($2,0));
 PERFORM set_config('app.athlete_id',$2,true);
 SELECT * INTO job FROM public.healthkit_deregistration_work q
  WHERE q.athlete_id=$2 AND q.operation_id=$3 FOR UPDATE;
 IF NOT FOUND OR job.lease_owner IS DISTINCT FROM $1 OR job.lease_token IS DISTINCT FROM $4
   OR job.lease_until<=clock_timestamp() THEN
  PERFORM set_config('app.athlete_id',coalesce(previous_tenant,''),true);
  RETURN 'lease_lost';
 END IF;
 BEGIN
  -- This function alone decides completion from the real database cleanup facts.
  result:=public.finalize_healthkit_deregistration($3);
  outcome:=CASE WHEN result->>'status'='released' THEN 'released' ELSE 'pending_cleanup' END;
 EXCEPTION WHEN OTHERS THEN
  outcome:='retry_scheduled';
 END;
 -- The released-state trigger already removed its work row. Pending is not a failed attempt.
 IF outcome<>'released' THEN
  UPDATE public.healthkit_deregistration_work q SET lease_owner=NULL,lease_token=NULL,lease_until=NULL,
   available_at=clock_timestamp()+interval '1 minute',
   failures=least(20,q.failures+CASE WHEN outcome='retry_scheduled' THEN 1 ELSE 0 END)
   WHERE q.athlete_id=$2 AND q.operation_id=$3;
 END IF;
 PERFORM set_config('app.athlete_id',coalesce(previous_tenant,''),true);
 RETURN outcome;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.athlete_id',coalesce(previous_tenant,''),true);
 RAISE;
END $$;
REVOKE ALL ON FUNCTION public.finish_healthkit_deregistration(uuid,text,uuid,uuid) FROM PUBLIC;

-- Restore/reassignment must retarget this owner-only index as well.
CREATE OR REPLACE FUNCTION public.retarget_definer_policies() RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE target record;
DECLARE touched integer:=0;
BEGIN
  IF EXISTS(
    SELECT 1 FROM (VALUES('activity_track_reconcile_state'),('course_deletion'),('course_share'),
      ('course_share_rate'),('course_thumbnail_reconcile_state'),('object_scope_purge'),
      ('resource_derived_cleanup'),('resource_object_cleanup'),('restore_suppression_event'),('restore_share_erasure_context'),
      ('routing_admission'),('tenant_object_purge'),('tenant_work_index'),('healthkit_deregistration_work')) AS t(table_name)
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
      ('tenant_work_index','tenant_work_index_definer'),
      ('healthkit_deregistration_work','healthkit_deregistration_work_definer')) AS t(table_name,policy_name)
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

CREATE FUNCTION public.healthkit_deregistration_work_failures() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT count(*)::integer FROM (SELECT 1 FROM public.healthkit_deregistration_work
 WHERE failures>=20 LIMIT 1000) failed
$$;
REVOKE ALL ON FUNCTION public.healthkit_deregistration_work_failures() FROM PUBLIC;
