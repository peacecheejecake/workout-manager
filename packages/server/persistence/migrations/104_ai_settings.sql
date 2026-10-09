
-- This is a nonhealth write fence, not the health processing admission function.
-- Neither a saved choice nor NULL target creates provider/consent permission.
CREATE FUNCTION public.assert_ai_settings_write_target() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; BEGIN
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 c:=public.read_restore_processing_admission();
 IF c->>'targetNonce' IS NOT NULL OR c->>'targetIncarnation' IS NOT NULL
 THEN RAISE EXCEPTION 'AI_SETTINGS_RESTORE_TARGET_CLOSED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_ai_settings_write_target() FROM PUBLIC;

-- Registered104 AI selection preferences. No provider activation or transmission permission.
-- Fresh control target NULL permits nonhealth preferences; restore targets reject new writes.
-- Global catalog lock: hashtextextended('ai-settings-catalog',77212).
-- Runtime order: global shared(77210,1) -> lifecycle shared77206 -> tenant exclusive0 -> catalog shared77212.
-- Catalog publisher: global shared(77210,1) -> catalog exclusive77212; no tenant/lifecycle afterwards.

CREATE FUNCTION public.ai_settings_exact_keys(value jsonb, keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(value)='object' THEN
   (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(value) k)=
   (SELECT array_agg(k ORDER BY k) FROM unnest(keys) k)
 ELSE false END
$$;
CREATE FUNCTION public.ai_settings_catalog_availability(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(CASE WHEN value->>'kind'='available' THEN public.ai_settings_exact_keys(value,ARRAY['kind'])
 WHEN value->>'kind'='unavailable' THEN public.ai_settings_exact_keys(value,ARRAY['kind','reasonCode'])
   AND value->>'reasonCode' IN ('unconfigured','temporarily_unavailable','disabled','revoked','model_unavailable')
 ELSE false END,false)
$$;
CREATE FUNCTION public.ai_settings_catalog_selection_allowed(definition jsonb, provider_id text, model_id text, purpose text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'providers') p,
   LATERAL jsonb_array_elements(p->'models') m
 WHERE p->>'providerId'=provider_id AND m->>'modelId'=model_id
 AND p->'selectable'='true'::jsonb AND m->'selectable'='true'::jsonb AND m->'purposes' ? purpose)
$$;
CREATE FUNCTION public.ai_settings_catalog_valid(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; m jsonb; a jsonb; s jsonb; name text;
BEGIN
 IF NOT public.ai_settings_exact_keys(d,ARRAY['schemaVersion','catalogRevision','policyVersion','disclosureVersion','approvedScopes','providers','recommendedDefault','recommendedSyntheticComparison'])
 OR d->'schemaVersion'<>'1'::jsonb OR jsonb_typeof(d->'catalogRevision')<>'number'
 OR NOT (d->>'catalogRevision' ~ '^[1-9][0-9]{0,9}$') THEN RETURN false; END IF;
 IF (d->>'catalogRevision')::numeric>2147483647 THEN RETURN false; END IF;
 FOREACH name IN ARRAY ARRAY['policyVersion','disclosureVersion'] LOOP
  IF jsonb_typeof(d->name)<>'string' OR length(d->>name) NOT BETWEEN 1 AND 100
   OR d->>name !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(d->'approvedScopes')<>'array' THEN RETURN false; END IF;
 IF jsonb_array_length(d->'approvedScopes')<>4 OR
  (SELECT array_agg(x ORDER BY x) FROM jsonb_array_elements_text(d->'approvedScopes') x)
  <>ARRAY['actual_summary','check_in','plan_summary','resource_excerpt']::text[] THEN RETURN false; END IF;
 IF jsonb_typeof(d->'providers')<>'array' THEN RETURN false; END IF;
 IF jsonb_array_length(d->'providers')>1 THEN RETURN false; END IF;
 FOR p IN SELECT * FROM jsonb_array_elements(d->'providers') LOOP
  IF NOT public.ai_settings_exact_keys(p,ARRAY['providerId','displayName','selectable','availability','recipient','models'])
   OR p->>'providerId' IS DISTINCT FROM 'openai' OR jsonb_typeof(p->'selectable')<>'boolean'
   OR NOT public.ai_settings_catalog_availability(p->'availability') THEN RETURN false; END IF;
  IF p->'availability'->>'reasonCode' IN ('disabled','revoked') AND p->'selectable'<>'false'::jsonb THEN RETURN false; END IF;
  IF NOT public.ai_settings_exact_keys(p->'recipient',ARRAY['recipientId','displayName','disclosureVersion'])
   OR p->'recipient'->>'recipientId' IS DISTINCT FROM 'openai' OR p->'recipient'->>'disclosureVersion' IS DISTINCT FROM d->>'disclosureVersion' THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['displayName'] LOOP
   IF jsonb_typeof(p->name)<>'string' OR length(p->>name) NOT BETWEEN 1 AND 120 OR btrim(p->>name)<>p->>name
    OR p->>name ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(p->'recipient'->'displayName')<>'string' OR length(p->'recipient'->>'displayName') NOT BETWEEN 1 AND 120
   OR btrim(p->'recipient'->>'displayName')<>p->'recipient'->>'displayName' OR p->'recipient'->>'displayName' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  IF jsonb_typeof(p->'models')<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p->'models')>2 OR (SELECT count(DISTINCT x->>'modelId') FROM jsonb_array_elements(p->'models') x)<>jsonb_array_length(p->'models') THEN RETURN false; END IF;
  FOR m IN SELECT * FROM jsonb_array_elements(p->'models') LOOP
   IF NOT public.ai_settings_exact_keys(m,ARRAY['modelId','displayName','selectable','availability','purposes'])
    OR (m->>'modelId' IN ('gpt-6.1-sol','gpt-6-luna')) IS NOT TRUE OR jsonb_typeof(m->'selectable')<>'boolean'
    OR NOT public.ai_settings_catalog_availability(m->'availability') THEN RETURN false; END IF;
   IF m->'availability'->>'reasonCode' IN ('disabled','revoked') AND m->'selectable'<>'false'::jsonb THEN RETURN false; END IF;
   IF jsonb_typeof(m->'displayName')<>'string' OR length(m->>'displayName') NOT BETWEEN 1 AND 120 OR btrim(m->>'displayName')<>m->>'displayName'
    OR m->>'displayName' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
   IF (m->>'modelId'='gpt-6.1-sol' AND m->'purposes'<>'["coaching"]'::jsonb)
    OR (m->>'modelId'='gpt-6-luna' AND m->'purposes'<>'["synthetic_comparison"]'::jsonb) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 s:=d->'recommendedDefault';
 IF s<>'null'::jsonb THEN
  IF NOT public.ai_settings_exact_keys(s,ARRAY['providerId','modelId']) OR NOT public.ai_settings_catalog_selection_allowed(d,s->>'providerId',s->>'modelId','coaching') THEN RETURN false; END IF;
 END IF;
 a:=d->'recommendedSyntheticComparison';
 IF a->>'kind'='off' THEN
  IF NOT public.ai_settings_exact_keys(a,ARRAY['kind']) THEN RETURN false; END IF;
 ELSIF a->>'kind'='selected' THEN
  s:=a->'selection';
  IF NOT public.ai_settings_exact_keys(a,ARRAY['kind','selection']) OR NOT public.ai_settings_exact_keys(s,ARRAY['providerId','modelId'])
   OR NOT public.ai_settings_catalog_selection_allowed(d,s->>'providerId',s->>'modelId','synthetic_comparison') THEN RETURN false; END IF;
 ELSE RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE TABLE public.ai_settings_catalog_definition (
 catalog_revision integer PRIMARY KEY CHECK(catalog_revision>0),
 definition jsonb NOT NULL CHECK(octet_length(definition::text)<=65536) CHECK(public.ai_settings_catalog_valid(definition) IS TRUE),
 definition_digest text NOT NULL CHECK(definition_digest ~ '^[0-9a-f]{64}$'),
 CHECK((definition->>'catalogRevision')::numeric=catalog_revision),
 CHECK(definition_digest=encode(sha256(convert_to(definition::text,'UTF8')),'hex'))
);
CREATE TABLE public.ai_settings_catalog_head (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton IS TRUE),
 catalog_revision integer NOT NULL REFERENCES public.ai_settings_catalog_definition(catalog_revision)
);
CREATE FUNCTION public.ai_settings_catalog_owner_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) OR session_user<>current_user
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'AI_SETTINGS_CATALOG_OWNER_ONLY'; END IF;
 PERFORM public.assert_ai_settings_write_target();
 PERFORM pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212));
 IF TG_TABLE_NAME='ai_settings_catalog_definition' AND TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_SETTINGS_CATALOG_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='ai_settings_catalog_head' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI_SETTINGS_CATALOG_HEAD_DELETE_DENIED'; END IF;
  IF TG_OP='INSERT' AND NEW.catalog_revision<>1 THEN RAISE EXCEPTION 'AI_SETTINGS_CATALOG_REVISION_CONFLICT'; END IF;
  IF TG_OP='UPDATE' AND (NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.catalog_revision::bigint<>OLD.catalog_revision::bigint+1) THEN RAISE EXCEPTION 'AI_SETTINGS_CATALOG_REVISION_CONFLICT'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_settings_catalog_definition_owner BEFORE INSERT OR UPDATE OR DELETE ON public.ai_settings_catalog_definition FOR EACH ROW EXECUTE FUNCTION public.ai_settings_catalog_owner_guard();
CREATE TRIGGER ai_settings_catalog_head_owner BEFORE INSERT OR UPDATE OR DELETE ON public.ai_settings_catalog_head FOR EACH ROW EXECUTE FUNCTION public.ai_settings_catalog_owner_guard();
REVOKE ALL ON FUNCTION public.ai_settings_catalog_owner_guard() FROM PUBLIC;
-- Owner publisher: BEGIN; exclusive77212; INSERT immutable definition revision N with SQL-computed digest;
-- INSERT head1 or UPDATE head WHERE catalog_revision=N-1; assert rowCount1; COMMIT.
-- NOT SECURITY DEFINER / runtime publisher not provided. Trigger protects even direct owner DML.
-- Empty registry/head intentionally fails closed; NO catalog seed or provider activation here.

CREATE TABLE public.ai_settings_revision (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200 AND btrim(athlete_id)=athlete_id),
 revision integer NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL,
 catalog_revision integer NOT NULL REFERENCES public.ai_settings_catalog_definition(catalog_revision),
 policy_version text NOT NULL CHECK(policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 disclosure_version text NOT NULL CHECK(disclosure_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 default_provider_id text CHECK(default_provider_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
 default_model_id text CHECK(default_model_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
 comparison_kind text NOT NULL CHECK(comparison_kind IN ('off','selected')),
 comparison_provider_id text CHECK(comparison_provider_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
 comparison_model_id text CHECK(comparison_model_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
 receipt_key text NOT NULL CHECK(receipt_key ~ '^ai-settings:write:[0-9a-f]{64}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(athlete_id,revision), UNIQUE(athlete_id,receipt_key),
 FOREIGN KEY(athlete_id,receipt_key) REFERENCES public.command_receipt(athlete_id,idempotency_key) DEFERRABLE INITIALLY DEFERRED,
 CHECK(num_nonnulls(default_provider_id,default_model_id) IN (0,2)),
 CHECK(((comparison_kind='off' AND num_nonnulls(comparison_provider_id,comparison_model_id)=0)
   OR (comparison_kind='selected' AND num_nonnulls(comparison_provider_id,comparison_model_id)=2)) IS TRUE)
);
CREATE TABLE public.ai_settings_head (
 athlete_id text PRIMARY KEY CHECK(length(athlete_id) BETWEEN 1 AND 200 AND btrim(athlete_id)=athlete_id),
 revision integer NOT NULL CHECK(revision>0),
 FOREIGN KEY(athlete_id,revision) REFERENCES public.ai_settings_revision(athlete_id,revision) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.ai_settings_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings_head FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_settings_head_tenant ON public.ai_settings_head USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
CREATE POLICY ai_settings_revision_tenant ON public.ai_settings_revision USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
CREATE FUNCTION public.ai_settings_private_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d jsonb; live_revision integer; prior_revision integer;
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN RAISE EXCEPTION 'AI_SETTINGS_PURGE_OWNER_ONLY'; END IF;
  RETURN OLD;
 END IF;
 PERFORM public.assert_ai_settings_write_target();
 IF TG_TABLE_NAME='ai_settings_revision' AND TG_OP='UPDATE' THEN RAISE EXCEPTION 'AI_SETTINGS_REVISION_IMMUTABLE'; END IF;
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'AI_SETTINGS_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.athlete_id,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.athlete_id,0));
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=NEW.athlete_id) THEN RAISE EXCEPTION 'ACCOUNT_ERASED'; END IF;
 IF TG_TABLE_NAME='ai_settings_head' THEN
  IF TG_OP='INSERT' AND NEW.revision<>1 THEN RAISE EXCEPTION 'AI_SETTINGS_REVISION_CONFLICT'; END IF;
  IF TG_OP='UPDATE' AND (NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.revision::bigint<>OLD.revision::bigint+1) THEN RAISE EXCEPTION 'AI_SETTINGS_REVISION_CONFLICT'; END IF;
 ELSE
  SELECT revision INTO prior_revision FROM public.ai_settings_head WHERE athlete_id=NEW.athlete_id;
  IF NEW.revision::bigint<>coalesce(prior_revision,0)::bigint+1 THEN RAISE EXCEPTION 'AI_SETTINGS_REVISION_CONFLICT'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ai-settings-catalog',77212));
  SELECT c.catalog_revision,v.definition INTO live_revision,d FROM public.ai_settings_catalog_head c JOIN public.ai_settings_catalog_definition v USING(catalog_revision) WHERE singleton=true;
  IF live_revision IS DISTINCT FROM NEW.catalog_revision OR d->>'policyVersion' IS DISTINCT FROM NEW.policy_version OR d->>'disclosureVersion' IS DISTINCT FROM NEW.disclosure_version THEN RAISE EXCEPTION 'AI_SETTINGS_CATALOG_STALE'; END IF;
  IF NEW.default_provider_id IS NOT NULL AND NOT public.ai_settings_catalog_selection_allowed(d,NEW.default_provider_id,NEW.default_model_id,'coaching') THEN RAISE EXCEPTION 'AI_SETTINGS_DEFAULT_NOT_SELECTABLE'; END IF;
  IF NEW.comparison_kind='selected' AND NOT public.ai_settings_catalog_selection_allowed(d,NEW.comparison_provider_id,NEW.comparison_model_id,'synthetic_comparison') THEN RAISE EXCEPTION 'AI_SETTINGS_COMPARISON_NOT_SELECTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_settings_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_settings_revision FOR EACH ROW EXECUTE FUNCTION public.ai_settings_private_guard();
CREATE TRIGGER ai_settings_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_settings_head FOR EACH ROW EXECUTE FUNCTION public.ai_settings_private_guard();
REVOKE ALL ON FUNCTION public.ai_settings_private_guard() FROM PUBLIC;
REVOKE ALL ON public.ai_settings_catalog_definition,public.ai_settings_catalog_head,public.ai_settings_revision,public.ai_settings_head FROM PUBLIC;
-- Root explicit non-owner API role grants ONLY:
-- GRANT SELECT ON ai_settings_catalog_definition,ai_settings_catalog_head,ai_settings_revision,ai_settings_head TO <approved_api_role>;
-- GRANT INSERT ON ai_settings_revision,ai_settings_head TO <approved_api_role>;
-- GRANT UPDATE(revision) ON ai_settings_head TO <approved_api_role>;
-- Existing command_receipt SELECT/INSERT and tenant_erasure SELECT remain required.
-- NO runtime catalog INSERT/UPDATE/DELETE; no private revision UPDATE/DELETE; no worker grants.

-- Deferred semantic receipt/revision consistency: the FK alone would only prove existence.
CREATE FUNCTION public.ai_settings_receipt_revision_check() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE receipt record; expected_result jsonb; comparison jsonb;
BEGIN
 SELECT request,result INTO receipt FROM public.command_receipt
  WHERE athlete_id=NEW.athlete_id AND idempotency_key=NEW.receipt_key;
 IF NOT FOUND OR receipt.request IS DISTINCT FROM jsonb_build_object('version',1,'sha256',NEW.request_digest)
  OR jsonb_typeof(receipt.result->'updatedAt') IS DISTINCT FROM 'string'
  OR (receipt.result->>'updatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') IS NOT TRUE THEN RAISE EXCEPTION 'AI_SETTINGS_RECEIPT_INVALID'; END IF;
 IF (receipt.result->>'updatedAt')::timestamptz IS DISTINCT FROM NEW.updated_at THEN RAISE EXCEPTION 'AI_SETTINGS_RECEIPT_INVALID'; END IF;
 comparison:=CASE WHEN NEW.comparison_kind='off' THEN jsonb_build_object('kind','off')
  ELSE jsonb_build_object('kind','selected','selection',jsonb_build_object('providerId',NEW.comparison_provider_id,'modelId',NEW.comparison_model_id)) END;
 expected_result:=jsonb_build_object('schemaVersion',1,'revision',NEW.revision,'updatedAt',receipt.result->'updatedAt',
  'defaultSelection',CASE WHEN NEW.default_provider_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('providerId',NEW.default_provider_id,'modelId',NEW.default_model_id) END,
  'syntheticComparison',comparison);
 IF receipt.result IS DISTINCT FROM expected_result THEN RAISE EXCEPTION 'AI_SETTINGS_RECEIPT_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ai_settings_revision_receipt_consistent AFTER INSERT ON public.ai_settings_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ai_settings_receipt_revision_check();
REVOKE ALL ON FUNCTION public.ai_settings_receipt_revision_check() FROM PUBLIC;

-- Shared nonsecret catalog is readable; publication is restricted to its live owner.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_settings_catalog_definition','ai_settings_catalog_head'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY catalog_read ON public.%I FOR SELECT USING(true)',t);
  EXECUTE format('CREATE POLICY catalog_owner_write ON public.%I FOR ALL USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass))) WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass)))',t,'public.'||t,'public.'||t);
  EXECUTE format('CREATE TRIGGER ai_settings_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ai_settings_revision','ai_settings_head'] LOOP
  EXECUTE format('CREATE TRIGGER ai_settings_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation()',t);
 END LOOP;
END $$;

-- Wrap the actual latest103 erasure; remove retained direct ACLs on the old name.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_ai_settings;
REVOKE ALL ON FUNCTION public.erase_account_before_ai_settings(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc p,
  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.erase_account_before_ai_settings(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_ai_settings(text) FROM %I',r); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 DELETE FROM public.ai_settings_head WHERE athlete_id=$1;
 DELETE FROM public.ai_settings_revision WHERE athlete_id=$1;
 RETURN public.erase_account_before_ai_settings($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
