-- Stretching actuals are details of one canonical Activity. They never add an
-- Activity or contribute another duration to parent/bout time.
CREATE TABLE stretch_profile (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  exercise_version_id uuid NOT NULL,
  profile_json jsonb NOT NULL CHECK (
    jsonb_typeof(profile_json)='object' AND octet_length(profile_json::text) <= 65536
  ),
  PRIMARY KEY (athlete_id,exercise_version_id),
  FOREIGN KEY (athlete_id,exercise_version_id)
    REFERENCES supplementary_exercise_version(athlete_id,version_id)
);
ALTER TABLE stretch_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE stretch_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON stretch_profile
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
CREATE FUNCTION validate_stretch_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'STRETCHING_TENANT_MISMATCH';
  END IF;
  PERFORM 1 FROM public.supplementary_exercise_version
    WHERE athlete_id=NEW.athlete_id AND version_id=NEW.exercise_version_id
      AND record_json->>'family'='stretching' AND record_json->>'schemaVersion'='2';
  IF NOT FOUND THEN RAISE EXCEPTION 'STRETCHING_EXERCISE_INVALID'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_stretch_profile() FROM PUBLIC;
CREATE TRIGGER stretch_profile_validate BEFORE INSERT ON stretch_profile
  FOR EACH ROW EXECUTE FUNCTION validate_stretch_profile();
CREATE TRIGGER stretch_profile_immutable BEFORE UPDATE OR DELETE ON stretch_profile
  FOR EACH ROW EXECUTE FUNCTION reject_supplementary_record_mutation();

CREATE TABLE stretching_log (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  id uuid NOT NULL,
  activity_id uuid NOT NULL,
  exercise_version_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision BETWEEN 1 AND 2147483646),
  current_revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted')),
  PRIMARY KEY (athlete_id,id),
  UNIQUE (athlete_id,id,activity_id,exercise_version_id),
  FOREIGN KEY (athlete_id,activity_id) REFERENCES activity_canonical(athlete_id,id),
  FOREIGN KEY (athlete_id,exercise_version_id)
    REFERENCES stretch_profile(athlete_id,exercise_version_id)
);
CREATE INDEX stretching_log_activity ON stretching_log (athlete_id,activity_id,id)
  WHERE status='active';
CREATE TABLE stretching_log_revision (
  athlete_id text NOT NULL,
  log_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  exercise_version_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483646),
  revision_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active','deleted')),
  recorded_at timestamptz NOT NULL,
  deleted_at timestamptz,
  deletion_reason text CHECK (deletion_reason IS NULL OR length(deletion_reason) BETWEEN 1 AND 500),
  record_json jsonb,
  PRIMARY KEY (athlete_id,log_id,revision),
  UNIQUE (athlete_id,revision_id),
  UNIQUE (athlete_id,log_id,revision,revision_id,status),
  FOREIGN KEY (athlete_id,log_id,activity_id,exercise_version_id)
    REFERENCES stretching_log(athlete_id,id,activity_id,exercise_version_id),
  CHECK (
    (status='active' AND deleted_at IS NULL AND deletion_reason IS NULL
      AND record_json IS NOT NULL AND jsonb_typeof(record_json)='object'
      AND octet_length(record_json::text) <= 65536
      AND (record_json->>'logId'=log_id::text
        AND record_json->>'activityId'=activity_id::text
        AND record_json->>'exerciseVersionId'=exercise_version_id::text
        AND record_json->>'revisionId'=revision_id::text
        AND record_json->>'revision'=revision::text) IS TRUE)
    OR
    (status='deleted' AND deleted_at=recorded_at AND deletion_reason IS NOT NULL
      AND record_json IS NULL)
  )
);
ALTER TABLE stretching_log ADD CONSTRAINT stretching_log_current_revision_fk
  FOREIGN KEY (athlete_id,id,current_revision,current_revision_id,status)
  REFERENCES stretching_log_revision(athlete_id,log_id,revision,revision_id,status)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX stretching_revision_time ON stretching_log_revision
  (athlete_id,recorded_at,log_id,revision) WHERE status='active';

ALTER TABLE stretching_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE stretching_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON stretching_log
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
ALTER TABLE stretching_log_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE stretching_log_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON stretching_log_revision
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

CREATE FUNCTION validate_stretching_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'STRETCHING_TENANT_MISMATCH';
  END IF;
  PERFORM 1 FROM public.activity_canonical
    WHERE athlete_id=NEW.athlete_id AND id=NEW.activity_id AND NOT deleted FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STRETCHING_ACTIVITY_UNAVAILABLE'; END IF;
  PERFORM 1 FROM public.stretch_profile p
    JOIN public.supplementary_exercise_version v
      ON v.athlete_id=p.athlete_id AND v.version_id=p.exercise_version_id
    JOIN public.supplementary_exercise_head h
      ON h.athlete_id=v.athlete_id AND h.exercise_id=v.exercise_id
    JOIN public.supplementary_exercise_version latest
      ON latest.athlete_id=h.athlete_id AND latest.version_id=h.version_id
    WHERE p.athlete_id=NEW.athlete_id AND p.exercise_version_id=NEW.exercise_version_id
      AND v.record_json->>'family'='stretching'
      AND v.record_json->>'reviewState'<>'withdrawn'
      AND latest.record_json->>'family'='stretching'
      AND latest.record_json->>'reviewState'<>'withdrawn';
  IF NOT FOUND THEN RAISE EXCEPTION 'STRETCHING_EXERCISE_UNAVAILABLE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION validate_stretching_log() FROM PUBLIC;
CREATE TRIGGER stretching_log_validate BEFORE INSERT ON stretching_log
  FOR EACH ROW EXECUTE FUNCTION validate_stretching_log();

CREATE FUNCTION guard_stretching_log() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'STRETCHING_TENANT_MISMATCH';
  END IF;
  IF TG_OP='DELETE' THEN
    IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'STRETCHING_LOG_DELETE_FORBIDDEN';
  END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
    OR NEW.exercise_version_id IS DISTINCT FROM OLD.exercise_version_id
    OR NEW.current_revision IS DISTINCT FROM OLD.current_revision + 1
    OR NEW.status NOT IN ('active','deleted')
  THEN RAISE EXCEPTION 'STRETCHING_LOG_MUTATION_INVALID'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_stretching_log() FROM PUBLIC;
CREATE TRIGGER stretching_log_guard BEFORE UPDATE OR DELETE ON stretching_log
  FOR EACH ROW EXECUTE FUNCTION guard_stretching_log();
CREATE TRIGGER stretching_revision_immutable BEFORE UPDATE OR DELETE ON stretching_log_revision
  FOR EACH ROW EXECUTE FUNCTION reject_supplementary_record_mutation();

-- A stretch correction/tombstone invalidates joint proposals that read actuals.
CREATE FUNCTION bump_stretching_dependency_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO public.integrated_dependency_head (athlete_id,set_revision)
  VALUES (NEW.athlete_id,1)
  ON CONFLICT (athlete_id) DO UPDATE
    SET set_revision=public.integrated_dependency_head.set_revision+1;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION bump_stretching_dependency_head() FROM PUBLIC;
CREATE TRIGGER stretching_log_dependency AFTER INSERT OR UPDATE ON stretching_log
  FOR EACH ROW EXECUTE FUNCTION bump_stretching_dependency_head();

CREATE FUNCTION purge_stretching_deleted_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'STRETCHING_TENANT_MISMATCH';
  END IF;
  IF NOT OLD.deleted AND NEW.deleted THEN
    UPDATE public.command_receipt r SET request='{"purged":"activity_deleted"}'::jsonb,
      result='{"purged":true}'::jsonb
    WHERE r.athlete_id=OLD.athlete_id AND r.idempotency_key LIKE 'stretching-log:%'
      AND (r.request#>>'{values,activityId}'=OLD.id::text
        OR r.request->>'logId' IN (
          SELECT id::text FROM public.stretching_log
          WHERE athlete_id=OLD.athlete_id AND activity_id=OLD.id
        ));
    DELETE FROM public.stretching_log_revision r
      USING public.stretching_log l
      WHERE r.athlete_id=OLD.athlete_id AND l.athlete_id=r.athlete_id
        AND l.id=r.log_id AND l.activity_id=OLD.id;
    DELETE FROM public.stretching_log WHERE athlete_id=OLD.athlete_id AND activity_id=OLD.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION purge_stretching_deleted_activity() FROM PUBLIC;
CREATE TRIGGER purge_stretching_on_activity_delete AFTER UPDATE OF deleted ON activity_canonical
  FOR EACH ROW EXECUTE FUNCTION purge_stretching_deleted_activity();

-- Erase child detail before the existing account eraser removes Activities.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_stretching;
REVOKE ALL ON FUNCTION public.erase_account_before_stretching(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN
    SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_stretching(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format(
    'REVOKE ALL ON FUNCTION public.erase_account_before_stretching(text) FROM %I',role_name);
  END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  DELETE FROM public.stretching_log_revision WHERE athlete_id=$1;
  DELETE FROM public.stretching_log WHERE athlete_id=$1;
  DELETE FROM public.stretch_profile WHERE athlete_id=$1;
  RETURN public.erase_account_before_stretching($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
