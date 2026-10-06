-- Registered103 accounting preparation. Full restore/activation NOT IMPLEMENTED.
-- Native global CLOSED control blocks every new reserve/dispatch; retained accounting is allowed.
-- Synthetic fixtures are not vendor prices, FX or actual usage. No provider call.
-- No key, numeric vendor price or FX is seeded. No network operation.
-- Fresh activation and restore reopening are owner actions after verified config/
-- snapshot+FULL independent global-budget journal tail; old copied spend is unsafe.
CREATE TABLE public.openai_budget_fx_definition (
 version text PRIMARY KEY CHECK(version ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,99}$'),
 numerator bigint NOT NULL CHECK(numerator BETWEEN 1 AND 9007199254740991),
 denominator bigint NOT NULL CHECK(denominator BETWEEN 1 AND 9007199254740991),
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
 approved boolean NOT NULL CHECK(approved IS TRUE)
);
CREATE TABLE public.openai_budget_price_definition (
 version text PRIMARY KEY CHECK(version ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,99}$'),model_id text NOT NULL CHECK(model_id IN ('gpt-6.1-sol','gpt-6-luna')),
 fx_version text NOT NULL REFERENCES public.openai_budget_fx_definition(version), tokenizer_version text NOT NULL CHECK(length(tokenizer_version) BETWEEN 1 AND 100),
 source_input_minor_per_million bigint NOT NULL CHECK(source_input_minor_per_million BETWEEN 0 AND 9007199254740991),
 source_output_minor_per_million bigint NOT NULL CHECK(source_output_minor_per_million BETWEEN 0 AND 9007199254740991),
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
 input_krw_per_million bigint NOT NULL CHECK(input_krw_per_million BETWEEN 0 AND 9007199254740991),
 output_krw_per_million bigint NOT NULL CHECK(output_krw_per_million BETWEEN 0 AND 9007199254740991),
 valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL,CHECK(valid_until>valid_from),
 approved boolean NOT NULL DEFAULT false
);
CREATE TABLE public.openai_budget_activation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 generation_id uuid NOT NULL, pricing_bundle_digest text,
 verified_tail_digest text, CHECK((NOT enabled OR
  (pricing_bundle_digest ~ '^[a-f0-9]{64}$' AND verified_tail_digest ~ '^[a-f0-9]{64}$')) IS TRUE)
);
INSERT INTO public.openai_budget_activation(singleton,generation_id)
 SELECT true,public.current_restore_generation();
CREATE TABLE public.openai_budget_month (
 period_key date PRIMARY KEY CHECK(extract(day FROM period_key)=1),
 timezone text NOT NULL DEFAULT 'Asia/Seoul' CHECK(timezone='Asia/Seoul'),
 limit_krw integer NOT NULL DEFAULT 50000 CHECK(limit_krw=50000),
 held_krw integer NOT NULL DEFAULT 0 CHECK(held_krw>=0),
 debited_krw integer NOT NULL DEFAULT 0 CHECK(debited_krw>=0),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 CHECK(held_krw+debited_krw<=limit_krw)
);
CREATE TABLE public.openai_budget_reservation (
 reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_key text UNIQUE NOT NULL CHECK(request_key ~ '^[a-f0-9]{64}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 athlete_id text,run_id uuid,
 subject_digest text NOT NULL CHECK(subject_digest ~ '^[a-f0-9]{64}$'),
 CHECK((athlete_id IS NULL)=(run_id IS NULL)),
 period_key date NOT NULL REFERENCES public.openai_budget_month(period_key),
 price_version text NOT NULL REFERENCES public.openai_budget_price_definition(version),
 input_bound integer NOT NULL CHECK(input_bound BETWEEN 0 AND 1000000),
 output_bound integer NOT NULL CHECK(output_bound BETWEEN 1 AND 1000000),
 reserved_krw integer NOT NULL CHECK(reserved_krw BETWEEN 0 AND 50000),
 owner_token_digest text NOT NULL CHECK(owner_token_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatching','completed','charged_unknown','released')),
 debit_krw integer,output_digest text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 dispatch_committed_at timestamptz,settled_at timestamptz,
 CHECK(((state IN ('reserved','dispatching') AND debit_krw IS NULL AND settled_at IS NULL)
  OR (state IN ('completed','charged_unknown','released') AND debit_krw BETWEEN 0 AND reserved_krw AND settled_at IS NOT NULL)) IS TRUE),
 CHECK((state='completed')=(output_digest IS NOT NULL)),
 CHECK(output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
 CHECK(state<>'released' OR (debit_krw=0 AND dispatch_committed_at IS NULL)),
 CHECK(state NOT IN ('dispatching','completed','charged_unknown') OR dispatch_committed_at IS NOT NULL)
);
-- Global append journal survives user erasure; no health content, key or keyhash.
-- Atomic budget mutations and journal entries share one DB transaction. Sequence
-- gap by itself is not a complete independent WAL/ACK or remote ledger proof.
CREATE TABLE public.openai_budget_journal (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sequence_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 definition_version text NOT NULL DEFAULT 'openai-global-budget-event-v1' CHECK(definition_version='openai-global-budget-event-v1'),
 reservation_id uuid NOT NULL REFERENCES public.openai_budget_reservation(reservation_id),
 period_key date NOT NULL,event_kind text NOT NULL CHECK(event_kind IN ('reserved','dispatching','completed','charged_unknown','released')),
 held_delta integer NOT NULL,debit_delta integer NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(reservation_id,event_kind)
);
-- Global tables are owner-only. All runtime access uses narrow SECURITY DEFINER
-- functions; runtime cannot select global tenant/spend rows or edit prices/fence.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['openai_budget_fx_definition','openai_budget_price_definition','openai_budget_activation','openai_budget_month','openai_budget_reservation','openai_budget_journal'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY owner_only ON public.%I USING (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass))) WITH CHECK (current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass)))',t,'public.'||t,'public.'||t);
 END LOOP;
END $$;
CREATE FUNCTION public.guard_budget_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE fx public.openai_budget_fx_definition%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BUDGET_DEFINITION_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='openai_budget_price_definition' THEN
  SELECT * INTO fx FROM public.openai_budget_fx_definition WHERE version=NEW.fx_version AND approved;
  IF NOT FOUND OR NEW.input_krw_per_million IS DISTINCT FROM ceil(NEW.source_input_minor_per_million::numeric*fx.numerator/fx.denominator)::bigint
   OR NEW.output_krw_per_million IS DISTINCT FROM ceil(NEW.source_output_minor_per_million::numeric*fx.numerator/fx.denominator)::bigint
  THEN RAISE EXCEPTION 'BUDGET_FX_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER budget_fx_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.openai_budget_fx_definition FOR EACH ROW EXECUTE FUNCTION public.guard_budget_definition();
CREATE TRIGGER budget_price_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.openai_budget_price_definition FOR EACH ROW EXECUTE FUNCTION public.guard_budget_definition();
CREATE TRIGGER budget_fx_no_truncate BEFORE TRUNCATE ON public.openai_budget_fx_definition FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER budget_price_no_truncate BEFORE TRUNCATE ON public.openai_budget_price_definition FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
REVOKE ALL ON FUNCTION public.guard_budget_definition() FROM PUBLIC;
CREATE TRIGGER budget_journal_immutable BEFORE UPDATE OR DELETE ON public.openai_budget_journal
 FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER budget_journal_immutable_truncate BEFORE TRUNCATE ON public.openai_budget_journal
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

CREATE FUNCTION public.assert_openai_budget_function_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN (
  'public.openai_budget_fx_definition'::regclass,'public.openai_budget_price_definition'::regclass,
  'public.openai_budget_activation'::regclass,'public.openai_budget_month'::regclass,
  'public.openai_budget_reservation'::regclass,'public.openai_budget_journal'::regclass)
  AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
 THEN RAISE EXCEPTION 'OPENAI_BUDGET_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_openai_budget_function_owner() FROM PUBLIC;

CREATE FUNCTION public.require_openai_budget_activation() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM 1 FROM public.openai_budget_activation WHERE singleton AND enabled
  AND generation_id=public.current_restore_generation() FOR SHARE;
 IF NOT FOUND
 THEN RAISE EXCEPTION 'OPENAI_BUDGET_CLOSED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.require_openai_budget_activation() FROM PUBLIC;

-- Bound parameters come from trusted final-wire projection/counting. SQL computes
-- the debit; it does not trust a caller-supplied money amount or monthly scope.
-- Global request key is stable across models/users/month rollover and binds request
-- digest. A matching prior request NEVER acquires a second outbound permission.
CREATE FUNCTION public.reserve_openai_budget(p_run_id uuid,p_key text,p_digest text,
 p_price_version text,p_input_bound integer,p_output_bound integer,p_owner_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); period date;
DECLARE price public.openai_budget_price_definition%ROWTYPE; prior public.openai_budget_reservation%ROWTYPE;
DECLARE debit numeric; new_id uuid; BEGIN
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM public.assert_openai_budget_function_owner();
 IF tenant IS NULL OR p_run_id IS NULL OR p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$' OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
  OR p_owner_token IS NULL OR p_input_bound IS NULL OR p_input_bound NOT BETWEEN 0 AND 1000000
  OR p_output_bound IS NULL OR p_output_bound NOT BETWEEN 1 AND 1000000
 THEN RAISE EXCEPTION 'OPENAI_BUDGET_INVALID_REQUEST'; END IF;
 SELECT * INTO prior FROM public.openai_budget_reservation WHERE request_key=p_key;
 IF FOUND THEN
  IF prior.subject_digest IS DISTINCT FROM encode(sha256(convert_to(tenant,'UTF8')),'hex') OR (prior.run_id IS NOT NULL AND prior.run_id IS DISTINCT FROM p_run_id)
   OR prior.request_digest IS DISTINCT FROM p_digest OR prior.price_version IS DISTINCT FROM p_price_version
   OR prior.input_bound IS DISTINCT FROM p_input_bound OR prior.output_bound IS DISTINCT FROM p_output_bound
  THEN RETURN jsonb_build_object('kind','denied'); END IF;
  IF prior.state IN ('reserved','dispatching') THEN RETURN jsonb_build_object('kind','busy'); END IF;
  RETURN jsonb_build_object('kind','replayed','reservationId',prior.reservation_id,'outcome',prior.state,'debitMinor',prior.debit_krw,'outputDigest',prior.output_digest);
 END IF;
 PERFORM public.require_restore_processing_admission();
 PERFORM public.require_run_app_binding(p_run_id);
 PERFORM public.require_openai_budget_activation();
 PERFORM pg_advisory_xact_lock(hashtextextended('openai-global-budget-v1',77221));
 SELECT * INTO prior FROM public.openai_budget_reservation WHERE request_key=p_key;
 IF FOUND THEN
  IF prior.subject_digest=encode(sha256(convert_to(tenant,'UTF8')),'hex') AND prior.run_id=p_run_id AND prior.request_digest=p_digest
   AND prior.price_version=p_price_version AND prior.input_bound=p_input_bound AND prior.output_bound=p_output_bound THEN RETURN jsonb_build_object('kind','busy'); END IF;
  RETURN jsonb_build_object('kind','denied');
 END IF;
 SELECT * INTO price FROM public.openai_budget_price_definition WHERE version=p_price_version AND approved
  AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'OPENAI_BUDGET_UNPRICED'; END IF;
 debit:=ceil(p_input_bound::numeric*price.input_krw_per_million/1000000)
  +ceil(p_output_bound::numeric*price.output_krw_per_million/1000000);
 IF debit>50000 THEN RETURN jsonb_build_object('kind','denied'); END IF;
 period:=date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date;
 INSERT INTO public.openai_budget_month(period_key) VALUES(period) ON CONFLICT DO NOTHING;
 UPDATE public.openai_budget_month SET held_krw=held_krw+debit::integer,revision=revision+1
  WHERE period_key=period AND held_krw+debited_krw+debit<=limit_krw;
 IF NOT FOUND THEN RETURN jsonb_build_object('kind','denied'); END IF;
 INSERT INTO public.openai_budget_reservation(request_key,request_digest,athlete_id,run_id,subject_digest,period_key,price_version,input_bound,output_bound,reserved_krw,owner_token_digest)
 VALUES(p_key,p_digest,tenant,p_run_id,encode(sha256(convert_to(tenant,'UTF8')),'hex'),period,p_price_version,p_input_bound,p_output_bound,debit::integer,encode(sha256(convert_to(p_owner_token::text,'UTF8')),'hex'))
 RETURNING reservation_id INTO new_id;
 INSERT INTO public.openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta)
 VALUES(new_id,period,'reserved',debit::integer,0);
 RETURN jsonb_build_object('kind','acquired','reservationId',new_id,'requestDigest',p_digest,'maxDebitMinor',debit::integer);
END $$;
REVOKE ALL ON FUNCTION public.reserve_openai_budget(uuid,text,text,text,integer,integer,uuid) FROM PUBLIC;

-- Root repository MUST run full existing evidence/policy/ACL manifest and outbox
-- lease/CAS checks in this SAME transaction immediately before calling this fn.
-- App revision alone is not the complete authorizeDelivery check.
-- Commit dispatch marker BEFORE allowing HTTP.send, outside any DB transaction.
CREATE FUNCTION public.begin_openai_budget_dispatch(p_reservation_id uuid,p_owner_token uuid,p_event_id uuid,p_lease_token uuid,p_attempt integer,p_run_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.openai_budget_reservation%ROWTYPE; BEGIN
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM public.assert_openai_budget_function_owner();
 -- Preliminary identity lookup only; append-only request identity cannot change.
 SELECT * INTO r FROM public.openai_budget_reservation WHERE reservation_id=p_reservation_id;
 IF NOT FOUND OR r.run_id IS DISTINCT FROM p_run_id OR r.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RETURN false; END IF;
 PERFORM public.require_restore_processing_admission();
 PERFORM public.require_run_app_binding(r.run_id);
 PERFORM public.require_openai_budget_activation();
 PERFORM 1 FROM public.outbox WHERE athlete_id=r.athlete_id AND id=p_event_id AND topic='coaching.run_queued'
  AND lease_token=p_lease_token AND attempts=p_attempt AND lease_until>clock_timestamp() AND completed_at IS NULL
  AND payload=jsonb_build_object('runId',r.run_id::text) FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('openai-global-budget-v1',77221));
 SELECT * INTO r FROM public.openai_budget_reservation WHERE reservation_id=p_reservation_id FOR UPDATE;
 IF r.state<>'reserved' OR p_owner_token IS NULL
  OR r.owner_token_digest<>encode(sha256(convert_to(p_owner_token::text,'UTF8')),'hex')
  OR r.period_key<>date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date
  OR NOT EXISTS(SELECT 1 FROM public.openai_budget_price_definition WHERE version=r.price_version AND approved AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp())
 THEN RETURN false; END IF;
 UPDATE public.openai_budget_reservation SET state='dispatching',dispatch_committed_at=clock_timestamp() WHERE reservation_id=r.reservation_id;
 INSERT INTO public.openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta) VALUES(r.reservation_id,r.period_key,'dispatching',0,0);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.begin_openai_budget_dispatch(uuid,uuid,uuid,uuid,integer,uuid) FROM PUBLIC;

-- Conservative v2 settlement: completed or ambiguous charged_unknown debits full
-- maximum. Invoice/verified usage recorded separately; never silently refunds.
-- Release is accepted ONLY before durable dispatch marker, same owner token.
-- Accounting remains possible after app withdrawal; it authorizes no delivery.
CREATE FUNCTION public.settle_openai_budget(p_reservation_id uuid,p_owner_token uuid,p_digest text,p_outcome text,p_output_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.openai_budget_reservation%ROWTYPE; debit integer; BEGIN
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM public.assert_openai_budget_function_owner();
 IF nullif(current_setting('app.athlete_id',true),'') IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('completed','charged_unknown','released')
  OR p_owner_token IS NULL OR p_digest IS NULL OR (p_outcome='completed') IS DISTINCT FROM (p_output_digest IS NOT NULL)
  OR (p_output_digest IS NOT NULL AND p_output_digest !~ '^[a-f0-9]{64}$')
 THEN RAISE EXCEPTION 'OPENAI_BUDGET_SETTLEMENT_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('openai-global-budget-v1',77221));
 SELECT * INTO r FROM public.openai_budget_reservation WHERE reservation_id=p_reservation_id FOR UPDATE;
 IF NOT FOUND OR r.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  OR r.request_digest IS DISTINCT FROM p_digest
  OR r.owner_token_digest<>encode(sha256(convert_to(p_owner_token::text,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'OPENAI_BUDGET_SETTLEMENT_INVALID'; END IF;
 IF r.state IN ('completed','charged_unknown','released') THEN
  IF r.state IS DISTINCT FROM p_outcome OR r.output_digest IS DISTINCT FROM p_output_digest
  THEN RAISE EXCEPTION 'OPENAI_BUDGET_SETTLEMENT_CONFLICT'; END IF;
  RETURN jsonb_build_object('outcome',r.state,'debitMinor',r.debit_krw,'outputDigest',r.output_digest);
 END IF;
 IF (p_outcome='released' AND r.state<>'reserved') OR (p_outcome<>'released' AND r.state<>'dispatching')
 THEN RAISE EXCEPTION 'OPENAI_BUDGET_SETTLEMENT_INVALID'; END IF;
 debit:=CASE WHEN p_outcome='released' THEN 0 ELSE r.reserved_krw END;
 UPDATE public.openai_budget_month SET held_krw=held_krw-r.reserved_krw,debited_krw=debited_krw+debit,revision=revision+1 WHERE period_key=r.period_key;
 UPDATE public.openai_budget_reservation SET state=p_outcome,debit_krw=debit,output_digest=p_output_digest,settled_at=clock_timestamp() WHERE reservation_id=r.reservation_id;
 INSERT INTO public.openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta) VALUES(r.reservation_id,r.period_key,p_outcome,-r.reserved_krw,debit);
 RETURN jsonb_build_object('outcome',p_outcome,'debitMinor',debit,'outputDigest',p_output_digest);
END $$;
REVOKE ALL ON FUNCTION public.settle_openai_budget(uuid,uuid,text,text,text) FROM PUBLIC;
-- No automatic expiration/refund. An orphan reserved/dispatched hold remains fully
-- held until trusted recovery; no safe HTTP retry using the same request key.
-- Root grants ONLY reserve/begin/settle EXECUTE to trusted worker budget adapter.
-- Root adds plain-owner checks, table/function ownership/retarget integration,
-- owner journal snapshot/tail exporter+exact recovery, erasure scrubbing policy,
-- and controlled activation validation before permitting processing.

-- Guard transitions even against accidental owner DML; no hidden refund or identity rewrite.
CREATE FUNCTION public.guard_budget_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BUDGET_RESERVATION_APPEND_ONLY'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','debit_krw','output_digest','dispatch_committed_at','settled_at','athlete_id','run_id'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','debit_krw','output_digest','dispatch_committed_at','settled_at','athlete_id','run_id']) THEN RAISE EXCEPTION 'BUDGET_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
   IF NEW.athlete_id IS NOT NULL OR NEW.run_id IS NOT NULL OR (to_jsonb(NEW)-ARRAY['athlete_id','run_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['athlete_id','run_id'])
   OR NOT EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=OLD.athlete_id) THEN RAISE EXCEPTION 'BUDGET_SCRUB_INVALID'; END IF;
   RETURN NEW;
  END IF;
  IF NOT ((OLD.state='reserved' AND NEW.state IN ('dispatching','released')) OR (OLD.state='dispatching' AND NEW.state IN ('completed','charged_unknown'))) THEN RAISE EXCEPTION 'BUDGET_TRANSITION_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER budget_reservation_guard BEFORE UPDATE OR DELETE ON public.openai_budget_reservation FOR EACH ROW EXECUTE FUNCTION public.guard_budget_reservation();
CREATE TRIGGER budget_reservation_no_truncate BEFORE TRUNCATE ON public.openai_budget_reservation FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
REVOKE ALL ON FUNCTION public.guard_budget_reservation() FROM PUBLIC;
-- Extend the latest100 erasure in-place via a rename wrapper; no budget amount is refunded.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_global_budget;
REVOKE ALL ON FUNCTION public.erase_account_before_global_budget(text) FROM PUBLIC;
-- RENAME retains explicit ACLs. Remove every previous direct grantee so callers
-- cannot bypass the new liability scrub wrapper using the historical name.
DO $$ DECLARE grantee_name text; BEGIN
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
  WHERE p.oid='public.erase_account_before_global_budget(text)'::regprocedure
   AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_global_budget(text) FROM %I',grantee_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE erased timestamptz; BEGIN
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM public.assert_openai_budget_function_owner();
 erased:=public.erase_account_before_global_budget($1);
 PERFORM pg_advisory_xact_lock(hashtextextended('openai-global-budget-v1',77221));
 UPDATE public.openai_budget_reservation SET athlete_id=NULL,run_id=NULL WHERE athlete_id=$1;
 RETURN erased;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
-- No erased-tenant runtime accounting or processing reopen implemented. Pending holds persist.
-- Restore requires independent global journal snapshot+full tail plus generation ACK; no owner enable helper is provided.
