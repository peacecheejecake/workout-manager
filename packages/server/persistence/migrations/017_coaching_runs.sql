-- A run is one evidence-bound attempt. Its model output is not a validated decision.
CREATE FUNCTION coaching_run_status_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE value->>'kind'
  WHEN 'queued' THEN value='{"kind":"queued"}'::jsonb
  WHEN 'running' THEN value-'kind'-'stage'='{}'::jsonb
   AND jsonb_typeof(value->'stage')='string'
   AND value->>'stage' IN ('preparing_evidence','evaluating','validating_candidates')
  WHEN 'analysis_ready' THEN value-'kind'-'outputId'='{}'::jsonb
   AND jsonb_typeof(value->'outputId')='string'
   AND value->>'outputId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  WHEN 'needs_question' THEN value-'kind'-'question'='{}'::jsonb
   AND jsonb_typeof(value->'question')='string'
   AND length(value->>'question') BETWEEN 1 AND 2000
   AND value->>'question'=btrim(value->>'question')
  WHEN 'validated_final' THEN value-'kind'-'decisionId'='{}'::jsonb
   AND jsonb_typeof(value->'decisionId')='string'
   AND value->>'decisionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  WHEN 'unable_to_evaluate' THEN value-'kind'-'code'-'reason'='{}'::jsonb
   AND jsonb_typeof(value->'code')='string' AND value->>'code' IN
    ('provider_unavailable','provider_rejected','invalid_output','stale_basis','budget_exceeded','internal_error')
   AND jsonb_typeof(value->'reason')='string'
   AND length(value->>'reason') BETWEEN 1 AND 500
   AND value->>'reason'=btrim(value->>'reason')
  WHEN 'cancelled' THEN value-'kind'-'reason'='{}'::jsonb
   AND jsonb_typeof(value->'reason')='string'
   AND value->>'reason' IN ('user_requested','consent_withdrawn','source_deleted','stale_basis')
  ELSE false END IS TRUE;
$$;
REVOKE ALL ON FUNCTION coaching_run_status_valid(jsonb) FROM PUBLIC;
CREATE TABLE coaching_run (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 id uuid NOT NULL, thread_id uuid NOT NULL, evidence_snapshot_id uuid NOT NULL,
 conversation_revision integer NOT NULL CHECK(conversation_revision BETWEEN 1 AND 2147483646),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),
 basis jsonb NOT NULL CHECK(jsonb_typeof(basis)='object' AND octet_length(basis::text)<=16384),
 status jsonb NOT NULL DEFAULT '{"kind":"queued"}'::jsonb
  CHECK(coaching_run_status_valid(status)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,id),
 FOREIGN KEY(athlete_id,thread_id) REFERENCES coaching_thread(athlete_id,id),
 FOREIGN KEY(athlete_id,evidence_snapshot_id) REFERENCES core_evidence_snapshot(athlete_id,id)
);
CREATE INDEX coaching_run_thread_page ON coaching_run(athlete_id,thread_id,created_at DESC,id);
ALTER TABLE coaching_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON coaching_run
 USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));

CREATE FUNCTION guard_coaching_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old_kind text; new_kind text; old_stage text; new_stage text; allowed boolean := false;
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
   AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_COACHING_RUN';
 END IF;
 IF (to_jsonb(NEW)-'status'-'updated_at')<>(to_jsonb(OLD)-'status'-'updated_at')
  OR NEW.updated_at<OLD.updated_at OR NEW.status=OLD.status THEN
  RAISE EXCEPTION 'IMMUTABLE_COACHING_RUN';
 END IF;
 old_kind:=OLD.status->>'kind'; new_kind:=NEW.status->>'kind';
 old_stage:=OLD.status->>'stage'; new_stage:=NEW.status->>'stage';
 -- Evidence deletion may redact terminal free text without changing the outcome.
 -- Only the owner-run purge path can make this narrow terminal update.
 IF current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  AND old_kind=new_kind AND old_kind IN ('needs_question','unable_to_evaluate')
  AND EXISTS(SELECT 1 FROM public.core_evidence_snapshot e
   WHERE e.athlete_id=OLD.athlete_id AND e.id=OLD.evidence_snapshot_id
    AND e.body IS NULL AND e.purged_reason IN ('source_deleted','consent_withdrawn'))
  AND ((old_kind='needs_question' AND NEW.status=jsonb_build_object(
       'kind','needs_question','question','Question removed after evidence withdrawal'))
    OR (old_kind='unable_to_evaluate' AND NEW.status=jsonb_build_object(
       'kind','unable_to_evaluate','code',OLD.status->>'code',
       'reason','Reason removed after evidence withdrawal'))) THEN
  RETURN NEW;
 END IF;
 IF old_kind='queued' THEN
  allowed := (new_kind='running' AND new_stage='preparing_evidence')
   OR new_kind IN ('unable_to_evaluate','cancelled');
 ELSIF old_kind='running' THEN
  allowed := (new_kind='running' AND old_stage='preparing_evidence' AND new_stage='evaluating')
   OR (new_kind='analysis_ready' AND old_stage='evaluating')
   OR (new_kind='validated_final' AND old_stage='validating_candidates')
   OR new_kind IN ('needs_question','unable_to_evaluate','cancelled');
 ELSIF old_kind='analysis_ready' THEN
  allowed := (new_kind='running' AND new_stage='validating_candidates')
   OR new_kind IN ('unable_to_evaluate','cancelled');
 END IF;
 IF NOT allowed THEN RAISE EXCEPTION 'INVALID_COACHING_RUN_TRANSITION'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coaching_run_guard BEFORE UPDATE OR DELETE ON coaching_run
 FOR EACH ROW EXECUTE FUNCTION guard_coaching_run();
REVOKE ALL ON FUNCTION guard_coaching_run() FROM PUBLIC;

-- Internal untrusted output is stored separately from the public run metadata.
CREATE TABLE coaching_analysis_output (
 athlete_id text NOT NULL, id uuid NOT NULL, run_id uuid NOT NULL,
 body jsonb, purged_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,id), UNIQUE(athlete_id,run_id),
 FOREIGN KEY(athlete_id,run_id) REFERENCES coaching_run(athlete_id,id),
 CHECK((body IS NOT NULL AND jsonb_typeof(body)='object' AND octet_length(body::text)<=1048576
   AND purged_reason IS NULL OR body IS NULL AND purged_reason IN ('source_deleted','consent_withdrawn')) IS TRUE)
);
ALTER TABLE coaching_analysis_output ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_analysis_output FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON coaching_analysis_output
 USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
CREATE FUNCTION guard_coaching_analysis_output() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
   AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_COACHING_OUTPUT';
 END IF;
 IF current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  AND OLD.body IS NOT NULL AND NEW.body IS NULL
  AND NEW.purged_reason IN ('source_deleted','consent_withdrawn')
  AND (to_jsonb(NEW)-'body'-'purged_reason')=(to_jsonb(OLD)-'body'-'purged_reason') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'IMMUTABLE_COACHING_OUTPUT';
END $$;
CREATE TRIGGER coaching_output_guard BEFORE UPDATE OR DELETE ON coaching_analysis_output
 FOR EACH ROW EXECUTE FUNCTION guard_coaching_analysis_output();
REVOKE ALL ON FUNCTION guard_coaching_analysis_output() FROM PUBLIC;

-- Scrub model output in the same transaction as evidence source deletion or consent withdrawal.
CREATE FUNCTION purge_coaching_output_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
  RAISE EXCEPTION 'COACHING_OUTPUT_TENANT_MISMATCH';
 END IF;
 IF OLD.body IS NOT NULL AND NEW.body IS NULL THEN
  UPDATE public.coaching_analysis_output o SET body=NULL,purged_reason=NEW.purged_reason
  FROM public.coaching_run r WHERE o.athlete_id=OLD.athlete_id AND o.body IS NOT NULL
   AND r.athlete_id=o.athlete_id AND r.id=o.run_id AND r.evidence_snapshot_id=OLD.id;
  UPDATE public.coaching_run SET status=jsonb_build_object('kind','cancelled','reason',NEW.purged_reason),
   updated_at=clock_timestamp()
  WHERE athlete_id=OLD.athlete_id AND evidence_snapshot_id=OLD.id
   AND status->>'kind' IN ('queued','running','analysis_ready');
  UPDATE public.coaching_run SET
   status=CASE status->>'kind'
    WHEN 'needs_question' THEN jsonb_build_object('kind','needs_question',
     'question','Question removed after evidence withdrawal')
    ELSE jsonb_build_object('kind','unable_to_evaluate','code',status->>'code',
     'reason','Reason removed after evidence withdrawal') END,
   updated_at=clock_timestamp()
  WHERE athlete_id=OLD.athlete_id AND evidence_snapshot_id=OLD.id
   AND ((status->>'kind'='needs_question' AND status->>'question'<>'Question removed after evidence withdrawal')
    OR (status->>'kind'='unable_to_evaluate' AND status->>'reason'<>'Reason removed after evidence withdrawal'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purge_coaching_output_after_evidence AFTER UPDATE OF body ON core_evidence_snapshot
 FOR EACH ROW EXECUTE FUNCTION purge_coaching_output_evidence();
REVOKE ALL ON FUNCTION purge_coaching_output_evidence() FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_coaching_runs;
REVOKE ALL ON FUNCTION public.erase_account_before_coaching_runs(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid='public.erase_account_before_coaching_runs(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_coaching_runs(text) FROM %I',role_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 DELETE FROM public.coaching_analysis_output WHERE athlete_id=$1;
 DELETE FROM public.coaching_run WHERE athlete_id=$1;
 RETURN public.erase_account_before_coaching_runs($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
