-- M2-05a (migrated 1:1 from M2-01k-w-b): immutable AI execution-selection job store.
-- Storage only. No provider call, key, price, budget hold/debit, lease, dispatch,
-- consent grant or processing admission is created here. A stored job is never an
-- outbound permission; M2-05b/c must re-validate everything in their own transaction.
-- Profile27 extension member: no historical function, trigger, grant, erase wrapper,
-- outbox/command_receipt/coaching_run/ai_settings object or restore registry is
-- replaced or altered. Erasure cascades from the unchanged public.erase_account chain
-- (ai_settings_revision and coaching_run deletes), so any later erase successor composes.
-- No automatic binding: a job binds only a provider-sourced queued coaching_run inserted
-- by the same top-level transaction. Historical/fixture runs are never adopted and no
-- backfill is performed. The bound model is the one saved in the referenced immutable
-- settings revision for the purpose; no substitution and no newer-head lookup.
-- Lock order: global shared(77210,1) -> lifecycle shared77206 -> tenant exclusive0 ->
-- coaching77209 -> catalog shared77212. Outbox topic: coaching.execution_job_queued.

CREATE TABLE public.ai_execution_job (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200 AND btrim(athlete_id)=athlete_id),
 job_id uuid NOT NULL,
 run_id uuid NOT NULL,
 thread_id uuid NOT NULL,
 evidence_snapshot_id uuid NOT NULL,
 command_version smallint NOT NULL CHECK(command_version=1),
 selection_version smallint NOT NULL CHECK(selection_version=1),
 purpose text NOT NULL CHECK(purpose IN ('coaching','synthetic_comparison')),
 payload_classification text NOT NULL CHECK(payload_classification IN ('health','synthetic_only')),
 settings_revision integer NOT NULL CHECK(settings_revision>0),
 catalog_revision integer NOT NULL REFERENCES public.ai_settings_catalog_definition(catalog_revision),
 catalog_digest text NOT NULL CHECK(catalog_digest ~ '^[0-9a-f]{64}$'),
 policy_version text NOT NULL CHECK(policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 disclosure_version text NOT NULL CHECK(disclosure_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 recipient_id text NOT NULL CHECK(recipient_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 recipient_disclosure_version text NOT NULL CHECK(recipient_disclosure_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 provider_id text NOT NULL CHECK(provider_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
 model_id text NOT NULL CHECK(model_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
 adapter_binding_version text NOT NULL CHECK(adapter_binding_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 vendor_model_ref text NOT NULL CHECK(vendor_model_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 price_model_ref text NOT NULL CHECK(price_model_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 price_version text NOT NULL CHECK(price_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 tokenizer_version text NOT NULL CHECK(tokenizer_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 app_consent_revision integer NOT NULL CHECK(app_consent_revision>0),
 app_consent_digest text NOT NULL CHECK(app_consent_digest ~ '^[0-9a-f]{64}$'),
 ai_consent_revision integer NOT NULL CHECK(ai_consent_revision>0),
 ai_consent_digest text NOT NULL CHECK(ai_consent_digest ~ '^[0-9a-f]{64}$'),
 selection_digest text NOT NULL CHECK(selection_digest ~ '^[0-9a-f]{64}$'),
 restore_generation_id uuid NOT NULL,
 receipt_key text NOT NULL CHECK(receipt_key ~ '^ai-execution:run:v1:[0-9a-f]{64}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,job_id),
 UNIQUE(athlete_id,run_id),
 UNIQUE(athlete_id,receipt_key),
 CHECK(price_model_ref=model_id),
 CHECK(purpose<>'synthetic_comparison' OR payload_classification='synthetic_only'),
 FOREIGN KEY(athlete_id,run_id) REFERENCES public.coaching_run(athlete_id,id) ON DELETE CASCADE,
 FOREIGN KEY(athlete_id,settings_revision) REFERENCES public.ai_settings_revision(athlete_id,revision) ON DELETE CASCADE
);
CREATE INDEX ai_execution_job_settings ON public.ai_execution_job(athlete_id,settings_revision);
CREATE INDEX ai_execution_job_created ON public.ai_execution_job(athlete_id,created_at,job_id);
REVOKE ALL ON public.ai_execution_job FROM PUBLIC;
ALTER TABLE public.ai_execution_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_execution_job FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_execution_job_tenant ON public.ai_execution_job
 USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- Invoker trigger (no SECURITY DEFINER): runs with the writer's tenant RLS. It reads
-- only rows the writer already reads. The selection digest is the exact canonical
-- encoding of @workout/server-coaching execution-selection-v1 (sorted keys); string
-- members are restricted by the column CHECKs above so to_json matches JSON.stringify.
CREATE FUNCTION public.guard_ai_execution_job_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE control jsonb; run record; settings record; app record; ai record;
DECLARE live_revision integer; definition jsonb; canonical text;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN
  -- Only the owner (account erasure cascade or owner purge) for the bound tenant.
  IF current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   AND OLD.athlete_id IS NOT DISTINCT FROM tenant THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'AI_EXECUTION_JOB_IMMUTABLE';
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_IMMUTABLE'; END IF;
 IF tenant IS NULL OR NEW.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_TENANT_MISMATCH'; END IF;
 -- New authoring only on a CLOSED control without a pending restore target and in
 -- the current restore generation. This is not processing/dispatch admission.
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 control:=public.read_restore_processing_admission();
 IF control IS NULL OR control->>'state' IS DISTINCT FROM 'CLOSED'
  OR control->'targetNonce' IS DISTINCT FROM 'null'::jsonb
  OR control->'targetIncarnation' IS DISTINCT FROM 'null'::jsonb
  OR control->>'generationId' IS DISTINCT FROM public.current_restore_generation()::text
 THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CLOSED'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,77209));
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=tenant) THEN RAISE EXCEPTION 'ACCOUNT_ERASED'; END IF;
 IF NEW.restore_generation_id IS DISTINCT FROM public.current_restore_generation() THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_GENERATION_MISMATCH'; END IF;
 NEW.created_at:=clock_timestamp();
 -- The run must be a provider-sourced queued run of the same thread/evidence created
 -- by this top-level transaction (a savepoint-inserted run fails closed).
 SELECT r.thread_id,r.evidence_snapshot_id,r.status,r.source,
  r.xmin=(((pg_current_xact_id()::text)::numeric % 4294967296)::bigint)::text::xid AS same_transaction
  INTO run FROM public.coaching_run r WHERE r.athlete_id=tenant AND r.id=NEW.run_id;
 IF NOT FOUND OR run.thread_id IS DISTINCT FROM NEW.thread_id
  OR run.evidence_snapshot_id IS DISTINCT FROM NEW.evidence_snapshot_id
  OR run.status IS DISTINCT FROM '{"kind":"queued"}'::jsonb
  OR run.source IS DISTINCT FROM jsonb_build_object('kind','provider','providerId',NEW.provider_id,'modelId',NEW.model_id)
  OR run.same_transaction IS NOT TRUE
 THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_RUN_NOT_BINDABLE'; END IF;
 SELECT granted,revision INTO app FROM public.consent WHERE athlete_id=tenant AND kind='app';
 SELECT granted,revision INTO ai FROM public.consent WHERE athlete_id=tenant AND kind='ai';
 IF app.granted IS NOT TRUE OR ai.granted IS NOT TRUE
  OR app.revision IS DISTINCT FROM NEW.app_consent_revision OR ai.revision IS DISTINCT FROM NEW.ai_consent_revision
  OR NEW.app_consent_digest IS DISTINCT FROM encode(sha256(convert_to(format(
    '{"version":"coaching-execution-consent-v1","athleteId":%s,"kind":"app","granted":true,"revision":%s}',
    to_json(tenant)::text,app.revision),'UTF8')),'hex')
  OR NEW.ai_consent_digest IS DISTINCT FROM encode(sha256(convert_to(format(
    '{"version":"coaching-execution-consent-v1","athleteId":%s,"kind":"ai","granted":true,"revision":%s}',
    to_json(tenant)::text,ai.revision),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_CONSENT_MISMATCH'; END IF;
 SELECT s.catalog_revision,s.policy_version,s.disclosure_version,s.default_provider_id,s.default_model_id,
  s.comparison_kind,s.comparison_provider_id,s.comparison_model_id
  INTO settings FROM public.ai_settings_revision s WHERE s.athlete_id=tenant AND s.revision=NEW.settings_revision;
 IF NOT FOUND OR settings.catalog_revision IS DISTINCT FROM NEW.catalog_revision
  OR settings.policy_version IS DISTINCT FROM NEW.policy_version
  OR settings.disclosure_version IS DISTINCT FROM NEW.disclosure_version
  OR (NEW.purpose='coaching' AND (settings.default_provider_id IS DISTINCT FROM NEW.provider_id
   OR settings.default_model_id IS DISTINCT FROM NEW.model_id))
  OR (NEW.purpose='synthetic_comparison' AND (settings.comparison_kind IS DISTINCT FROM 'selected'
   OR settings.comparison_provider_id IS DISTINCT FROM NEW.provider_id
   OR settings.comparison_model_id IS DISTINCT FROM NEW.model_id))
 THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_SELECTION_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ai-settings-catalog',77212));
 SELECT h.catalog_revision,d.definition INTO live_revision,definition
  FROM public.ai_settings_catalog_head h JOIN public.ai_settings_catalog_definition d USING(catalog_revision)
  WHERE h.singleton=true;
 IF live_revision IS DISTINCT FROM NEW.catalog_revision
  OR definition->>'policyVersion' IS DISTINCT FROM NEW.policy_version
  OR definition->>'disclosureVersion' IS DISTINCT FROM NEW.disclosure_version
  OR public.ai_settings_catalog_selection_allowed(definition,NEW.provider_id,NEW.model_id,NEW.purpose) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'providers') p,
    LATERAL jsonb_array_elements(p->'models') m
   WHERE p->>'providerId'=NEW.provider_id AND m->>'modelId'=NEW.model_id
    AND p->'availability'='{"kind":"available"}'::jsonb AND m->'availability'='{"kind":"available"}'::jsonb
    AND p->'recipient'->>'recipientId'=NEW.recipient_id
    AND p->'recipient'->>'disclosureVersion'=NEW.recipient_disclosure_version)
 THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_CATALOG_STALE'; END IF;
 canonical:=format('{"definitionVersion":"execution-selection-v1","draft":{"binding":{"adapterBindingVersion":%s,"priceModelRef":%s,"priceVersion":%s,"purpose":%s,"selection":{"modelId":%s,"providerId":%s},"tokenizerVersion":%s,"vendorModelRef":%s},"catalogDigest":%s,"catalogRevision":%s,"disclosureVersion":%s,"payloadClassification":%s,"permissions":{"ai":{"digest":%s,"enabled":true,"revision":%s},"app":{"digest":%s,"enabled":true,"revision":%s}},"policyVersion":%s,"recipientDisclosureVersion":%s,"recipientId":%s,"schemaVersion":1,"settingsRevision":%s}}',
  to_json(NEW.adapter_binding_version)::text,to_json(NEW.price_model_ref)::text,to_json(NEW.price_version)::text,
  to_json(NEW.purpose)::text,to_json(NEW.model_id)::text,to_json(NEW.provider_id)::text,
  to_json(NEW.tokenizer_version)::text,to_json(NEW.vendor_model_ref)::text,to_json(NEW.catalog_digest)::text,
  NEW.catalog_revision,to_json(NEW.disclosure_version)::text,to_json(NEW.payload_classification)::text,
  to_json(NEW.ai_consent_digest)::text,NEW.ai_consent_revision,to_json(NEW.app_consent_digest)::text,NEW.app_consent_revision,
  to_json(NEW.policy_version)::text,to_json(NEW.recipient_disclosure_version)::text,to_json(NEW.recipient_id)::text,
  NEW.settings_revision);
 IF NEW.selection_digest IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_SELECTION_DIGEST_INVALID'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_ai_execution_job_v1() FROM PUBLIC;
CREATE TRIGGER ai_execution_job_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_execution_job
 FOR EACH ROW EXECUTE FUNCTION public.guard_ai_execution_job_v1();
CREATE TRIGGER ai_execution_job_no_truncate BEFORE TRUNCATE ON public.ai_execution_job
 FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ai_execution_job_v1();

-- Commit-time atomicity: the job, its exact versioned command receipt and its
-- unclaimed durable outbox event exist together, or the transaction fails.
CREATE FUNCTION public.check_ai_execution_job_commit_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE receipt record;
BEGIN
 SELECT request,result INTO receipt FROM public.command_receipt
  WHERE athlete_id=NEW.athlete_id AND idempotency_key=NEW.receipt_key;
 IF NOT FOUND OR receipt.request IS DISTINCT FROM jsonb_build_object('version',1,'sha256',NEW.request_digest)
  OR receipt.result IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'commandVersion',1,
   'jobId',NEW.job_id::text,'runId',NEW.run_id::text,'selectionDigest',NEW.selection_digest)
 THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_RECEIPT_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.outbox o WHERE o.athlete_id=NEW.athlete_id AND o.idempotency_key=NEW.receipt_key
   AND o.topic='coaching.execution_job_queued'
   AND o.payload=jsonb_build_object('schemaVersion',1,'jobId',NEW.job_id::text,'runId',NEW.run_id::text)
   AND o.attempts=0 AND o.lease_token IS NULL AND o.completed_at IS NULL)
 THEN RAISE EXCEPTION 'AI_EXECUTION_JOB_OUTBOX_MISSING'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_ai_execution_job_commit_v1() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ai_execution_job_commit_atomic AFTER INSERT ON public.ai_execution_job
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_ai_execution_job_commit_v1();
-- Root V11 runtime grants ONLY (not applied here):
-- GRANT SELECT,INSERT ON public.ai_execution_job TO <approved_api_role>;
-- Existing coaching_run SELECT/INSERT, consent/ai_settings/catalog/command_receipt/outbox/
-- tenant_erasure SELECT, command_receipt/outbox INSERT and EXECUTE on
-- read_restore_processing_admission()/current_restore_generation() remain required.
-- NO UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, no worker grant, no function EXECUTE.
