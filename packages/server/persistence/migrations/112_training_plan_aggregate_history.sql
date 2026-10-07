-- Exact owned historical aggregate associations; NOT approval/source freshness.
-- Execute this whole migration in one transaction. Current heads alone are
-- backfilled; historical snapshot association is never inferred.
CREATE TABLE public.plan_snapshot_aggregate (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 version_id uuid NOT NULL,
 aggregate_id uuid NOT NULL,
 PRIMARY KEY(athlete_id,version_id),
 FOREIGN KEY(athlete_id,version_id) REFERENCES public.plan_snapshot(athlete_id,id) ON DELETE CASCADE,
 FOREIGN KEY(athlete_id,version_id) REFERENCES public.plan_history(athlete_id,version_id)
   DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON public.plan_snapshot_aggregate FROM PUBLIC;
ALTER TABLE public.plan_snapshot_aggregate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_snapshot_aggregate FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_snapshot_aggregate_tenant ON public.plan_snapshot_aggregate
 USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));

CREATE FUNCTION public.guard_training_plan_aggregate() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_TRAINING_PLAN_AGGREGATE'; END IF;
 IF TG_OP='DELETE' THEN
  -- Only the existing owner's snapshot-erasure FK cascade may remove lineage.
  IF pg_trigger_depth()>1
    AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND NOT EXISTS(SELECT 1 FROM public.plan_snapshot WHERE athlete_id=OLD.athlete_id AND id=OLD.version_id)
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_TRAINING_PLAN_AGGREGATE';
 END IF;
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
   OR NOT EXISTS(SELECT 1 FROM public.plan_head WHERE athlete_id=NEW.athlete_id AND version_id=NEW.version_id AND aggregate_id=NEW.aggregate_id)
   OR EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=NEW.athlete_id)
 THEN RAISE EXCEPTION 'TRAINING_PLAN_AGGREGATE_SOURCE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_training_plan_aggregate() FROM PUBLIC;
CREATE TRIGGER training_plan_aggregate_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.plan_snapshot_aggregate
 FOR EACH ROW EXECUTE FUNCTION public.guard_training_plan_aggregate();

-- FORCE RLS otherwise hides all tenants from a plain migration owner. This
-- SELECT-only policy is uncommitted and removed before migration completes.
DO $$
DECLARE owner_name name;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_class WHERE oid='public.plan_head'::regclass;
 IF current_user IS DISTINCT FROM owner_name OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
 THEN RAISE EXCEPTION 'TRAINING_PLAN_AGGREGATE_PLAIN_OWNER_REQUIRED'; END IF;
 EXECUTE format('CREATE POLICY training_plan_aggregate_migration_scan ON public.plan_head FOR SELECT TO %I USING(current_user=%L)',owner_name,owner_name);
END $$;
DO $$
DECLARE tenant text; previous_tenant text:=current_setting('app.athlete_id',true);
BEGIN
 FOR tenant IN SELECT athlete_id FROM public.plan_head ORDER BY athlete_id LOOP
  PERFORM set_config('app.athlete_id',tenant,true);
  INSERT INTO public.plan_snapshot_aggregate(athlete_id,version_id,aggregate_id)
   SELECT athlete_id,version_id,aggregate_id FROM public.plan_head WHERE athlete_id=tenant;
 END LOOP;
 PERFORM set_config('app.athlete_id',coalesce(previous_tenant,''),true);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.athlete_id',coalesce(previous_tenant,''),true);
 RAISE;
END $$;
DROP POLICY training_plan_aggregate_migration_scan ON public.plan_head;

CREATE FUNCTION public.mint_training_plan_aggregate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE old_ordinal integer; new_ordinal integer; latest_ordinal integer; existing uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
   OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.plan_head'::regclass,'public.plan_snapshot'::regclass,'public.plan_snapshot_aggregate'::regclass) AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
 THEN RAISE EXCEPTION 'TRAINING_PLAN_AGGREGATE_PLAIN_OWNER_REQUIRED'; END IF;
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 THEN RAISE EXCEPTION 'TRAINING_PLAN_AGGREGATE_TENANT_MISMATCH'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
  THEN RAISE EXCEPTION 'TRAINING_PLAN_AGGREGATE_MUTATION'; END IF;
  IF NEW.version_id IS DISTINCT FROM OLD.version_id THEN
   SELECT version INTO STRICT old_ordinal FROM public.plan_snapshot WHERE athlete_id=OLD.athlete_id AND id=OLD.version_id;
   SELECT version INTO STRICT new_ordinal FROM public.plan_snapshot WHERE athlete_id=NEW.athlete_id AND id=NEW.version_id;
   IF new_ordinal<=old_ordinal THEN RAISE EXCEPTION 'TRAINING_PLAN_HEAD_REPLAY_REJECTED'; END IF;
  END IF;
 END IF;
 SELECT aggregate_id INTO existing FROM public.plan_snapshot_aggregate WHERE athlete_id=NEW.athlete_id AND version_id=NEW.version_id;
 IF FOUND THEN
  IF existing IS DISTINCT FROM NEW.aggregate_id THEN RAISE EXCEPTION 'TRAINING_PLAN_AGGREGATE_MUTATION'; END IF;
 ELSE
  -- Unknown historical rows cannot become certified by deleting/reinserting a
  -- head, even under an offline owner/GUC. Fresh producers write head→history.
  IF EXISTS(SELECT 1 FROM public.plan_history WHERE athlete_id=NEW.athlete_id AND version_id=NEW.version_id)
  THEN RAISE EXCEPTION 'TRAINING_PLAN_HISTORICAL_IDENTITY_UNAVAILABLE'; END IF;
  SELECT version INTO STRICT new_ordinal FROM public.plan_snapshot WHERE athlete_id=NEW.athlete_id AND id=NEW.version_id;
  SELECT max(version) INTO latest_ordinal FROM public.plan_snapshot WHERE athlete_id=NEW.athlete_id;
  IF new_ordinal IS DISTINCT FROM latest_ordinal THEN RAISE EXCEPTION 'TRAINING_PLAN_HEAD_REPLAY_REJECTED'; END IF;
  -- The deferred history FK accommodates all existing head→history producers.
  INSERT INTO public.plan_snapshot_aggregate(athlete_id,version_id,aggregate_id) VALUES(NEW.athlete_id,NEW.version_id,NEW.aggregate_id);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mint_training_plan_aggregate() FROM PUBLIC;
CREATE TRIGGER training_plan_aggregate_mint AFTER INSERT OR UPDATE ON public.plan_head
 FOR EACH ROW EXECUTE FUNCTION public.mint_training_plan_aggregate();

CREATE FUNCTION public.read_training_plan_aggregate(uuid)
RETURNS TABLE(version_id uuid,aggregate_id uuid)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
 IF tenant IS NULL THEN RAISE EXCEPTION 'TRAINING_PLAN_AGGREGATE_TENANT_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
   OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.plan_snapshot'::regclass,'public.plan_snapshot_aggregate'::regclass) AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
 THEN RAISE EXCEPTION 'TRAINING_PLAN_AGGREGATE_PLAIN_OWNER_REQUIRED'; END IF;
 RETURN QUERY SELECT m.version_id,m.aggregate_id FROM public.plan_snapshot_aggregate m
  JOIN public.plan_snapshot s ON s.athlete_id=m.athlete_id AND s.id=m.version_id
  WHERE m.athlete_id=tenant AND m.version_id=$1;
END $$;
REVOKE ALL ON FUNCTION public.read_training_plan_aggregate(uuid) FROM PUBLIC;
-- Root registers narrow EXECUTE only. No private table SELECT/DML grant.
-- Export, backup family profiles, restore owner roster and registry remain
-- separate mandatory integrations; staging this file does not close those gates.
