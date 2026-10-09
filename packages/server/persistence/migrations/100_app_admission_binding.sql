-- DRAFT v2: NOT EXECUTED. Root integrates after reserved 098/099 and consumer readiness.
-- Version 100 / suppression record v5 requires independently authenticated COMPLETE
-- app epoch tail replay before processing is enabled. A copied consent+binding is NOT proof.
-- No historical app binding backfill. No app withdrawal body purge (reads stay allowed).

-- Preserve existing historical discriminator branches, including future 099/v4.
-- Gate the historical expression to exclude the new kind/version. An unqualified
-- OR would permit v1 app events through the historical consent branch.
DO $$ DECLARE cname text; old_expr text; null_fields text; app_branch text; BEGIN
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO null_fields
 FROM pg_attribute WHERE attrelid='public.restore_suppression_event'::regclass
  AND attnum>0 AND NOT attisdropped AND attname<>ALL(ARRAY['event_id','record_version','athlete_id','kind','occurred_at',
   'target_id','consent_previous_revision','consent_previous_granted','consent_revision','consent_granted']);
 app_branch:=format('(record_version=5 AND kind=''app_consent_transition'' AND target_id IS NULL
  AND consent_revision BETWEEN 1 AND 2147483647 AND consent_granted IS NOT NULL
  AND ((consent_previous_revision IS NULL AND consent_previous_granted IS NULL AND consent_revision=1)
   OR (consent_previous_revision BETWEEN 1 AND 2147483646 AND consent_previous_granted IS NOT NULL
    AND consent_revision=consent_previous_revision+1)) AND %s) IS TRUE',coalesce(null_fields,'true'));
 FOREACH cname IN ARRAY ARRAY['restore_suppression_event_kind_target_check',
  'restore_suppression_event_record_version_check'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO old_expr FROM pg_constraint
   WHERE conrelid='public.restore_suppression_event'::regclass AND conname=cname;
  IF old_expr IS NULL THEN RAISE EXCEPTION 'APP_EVENT_SCHEMA_MISSING'; END IF;
  EXECUTE format('ALTER TABLE public.restore_suppression_event DROP CONSTRAINT %I',cname);
  EXECUTE format('ALTER TABLE public.restore_suppression_event ADD CONSTRAINT %I CHECK (
   ((record_version<>5 AND kind<>''app_consent_transition'') AND (%s))
   OR (%s))',cname,old_expr,app_branch);
 END LOOP;
END $$;
-- A universal app payload allowlist preserves present/future legacy columns:
-- every field other than the exact allowed identifiers/epoch fields must be null.
CREATE FUNCTION public.app_consent_event_fields_valid(event jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_each(event) e
  WHERE e.key<>ALL(ARRAY['event_id','record_version','athlete_id','kind','occurred_at',
   'target_id','consent_previous_revision','consent_previous_granted','consent_revision','consent_granted'])
   AND e.value<>'null'::jsonb);
$$;
REVOKE ALL ON FUNCTION public.app_consent_event_fields_valid(jsonb) FROM PUBLIC;
-- Whole-row check expressions are deliberately avoided; add a trigger for the
-- closed field set, and CHECK the nullable one-step epoch with IS TRUE.
CREATE FUNCTION public.verify_app_consent_event_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NEW.kind='app_consent_transition' AND (NEW.record_version<>5 OR NEW.target_id IS NOT NULL
  OR NOT public.app_consent_event_fields_valid(to_jsonb(NEW))
  OR ((NEW.consent_previous_revision IS NULL AND NEW.consent_previous_granted IS NULL AND NEW.consent_revision=1)
   OR (NEW.consent_previous_revision BETWEEN 1 AND 2147483646
    AND NEW.consent_previous_granted IS NOT NULL AND NEW.consent_revision=NEW.consent_previous_revision+1)) IS NOT TRUE
  OR NEW.consent_revision IS NULL OR NEW.consent_revision NOT BETWEEN 1 AND 2147483647
  OR NEW.consent_granted IS NULL)
 THEN RAISE EXCEPTION 'APP_EVENT_FIELDS_INVALID'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_app_consent_event_fields() FROM PUBLIC;
CREATE TRIGGER verify_app_consent_event_fields BEFORE INSERT ON public.restore_suppression_event
 FOR EACH ROW EXECUTE FUNCTION public.verify_app_consent_event_fields();
CREATE UNIQUE INDEX restore_suppression_event_app_revision_once
 ON public.restore_suppression_event(athlete_id,consent_revision) WHERE kind='app_consent_transition';

-- The normal generic setConsent transaction writes its consent head, audit event,
-- original receipt and outbox atomically. No inferred initial consent or old backfill.
CREATE FUNCTION public.record_app_consent_transition_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_app_consent_event_id',true),'');
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.kind<>'app' AND NEW.kind<>'app' THEN RETURN NULL; END IF;
  IF OLD.kind<>'app' OR NEW.kind<>'app' OR OLD.athlete_id IS DISTINCT FROM NEW.athlete_id
   OR NEW.revision IS DISTINCT FROM OLD.revision+1
  THEN RAISE EXCEPTION 'APP_CONSENT_EPOCH_INVALID'; END IF;
 ELSIF NEW.kind<>'app' THEN RETURN NULL;
 ELSIF NEW.revision<>1 THEN RAISE EXCEPTION 'APP_CONSENT_EPOCH_INVALID'; END IF;
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 THEN RAISE EXCEPTION 'APP_CONSENT_TENANT_MISMATCH'; END IF;
 -- Runtime setConsent must obtain lifecycle shared then lock0 before its write.
 -- Trigger takes those same locks defensively; direct SQL consumers must follow
 -- the pre-write order too to avoid row-lock-first deadlocks.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.athlete_id,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.athlete_id,0));
 IF replay_id IS NOT NULL THEN
  IF session_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class
   WHERE oid='public.restore_suppression_event'::regclass))
  THEN RAISE EXCEPTION 'RESTORE_APP_OWNER_REQUIRED'; END IF;
  RETURN NULL;
 END IF;
 INSERT INTO public.restore_suppression_event(record_version,athlete_id,kind,occurred_at,
  consent_previous_revision,consent_previous_granted,consent_revision,consent_granted)
 VALUES(5,NEW.athlete_id,'app_consent_transition',clock_timestamp(),
  CASE WHEN TG_OP='UPDATE' THEN OLD.revision ELSE NULL END,
  CASE WHEN TG_OP='UPDATE' THEN OLD.granted ELSE NULL END,NEW.revision,NEW.granted);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_app_consent_transition_suppression_event() FROM PUBLIC;
CREATE TRIGGER record_app_consent_transition_suppression_event AFTER INSERT OR UPDATE ON public.consent
 FOR EACH ROW EXECUTE FUNCTION public.record_app_consent_transition_suppression_event();

-- Current app admission by exact pinned epoch; invoker must hold tenant-scoped
-- consent SELECT. Restored runtime readiness additionally depends on full tail.
CREATE FUNCTION public.require_app_admission_revision(pinned integer DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); current_revision integer;
BEGIN
 IF tenant IS NULL THEN RAISE EXCEPTION 'APP_CONSENT_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=tenant)
 THEN RAISE EXCEPTION 'ACCOUNT_ERASED'; END IF;
 SELECT revision INTO current_revision FROM public.consent
  WHERE athlete_id=tenant AND kind='app' AND granted AND revision BETWEEN 1 AND 2147483647;
 IF current_revision IS NULL THEN RAISE EXCEPTION 'APP_CONSENT_REQUIRED'; END IF;
 IF pinned IS NOT NULL AND pinned IS DISTINCT FROM current_revision
 THEN RAISE EXCEPTION 'STALE_APP_ADMISSION'; END IF;
 RETURN current_revision;
END $$;
REVOKE ALL ON FUNCTION public.require_app_admission_revision(integer) FROM PUBLIC;

CREATE TABLE public.evidence_app_admission_binding (
 athlete_id text NOT NULL,evidence_snapshot_id uuid NOT NULL,
 binding_version integer NOT NULL DEFAULT 1 CHECK(binding_version=1),
 app_revision integer NOT NULL CHECK(app_revision BETWEEN 1 AND 2147483647),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,evidence_snapshot_id),
 FOREIGN KEY(athlete_id,evidence_snapshot_id) REFERENCES public.core_evidence_snapshot(athlete_id,id)
);
CREATE TABLE public.run_app_admission_binding (
 athlete_id text NOT NULL,run_id uuid NOT NULL,evidence_snapshot_id uuid NOT NULL,
 binding_version integer NOT NULL DEFAULT 1 CHECK(binding_version=1),
 PRIMARY KEY(athlete_id,run_id),
 FOREIGN KEY(athlete_id,run_id) REFERENCES public.coaching_run(athlete_id,id),
 FOREIGN KEY(athlete_id,evidence_snapshot_id) REFERENCES public.evidence_app_admission_binding(athlete_id,evidence_snapshot_id)
);
CREATE TABLE public.candidate_app_admission_binding (
 athlete_id text NOT NULL,candidate_id uuid NOT NULL,run_id uuid NOT NULL,
 binding_version integer NOT NULL DEFAULT 1 CHECK(binding_version=1),
 PRIMARY KEY(athlete_id,candidate_id),
 FOREIGN KEY(athlete_id,candidate_id) REFERENCES public.coaching_candidate(athlete_id,id),
 FOREIGN KEY(athlete_id,run_id) REFERENCES public.run_app_admission_binding(athlete_id,run_id)
);
CREATE TABLE public.integrated_candidate_app_admission_binding (
 athlete_id text NOT NULL,candidate_id uuid NOT NULL,evidence_snapshot_id uuid NOT NULL,
 binding_version integer NOT NULL DEFAULT 1 CHECK(binding_version=1),
 PRIMARY KEY(athlete_id,candidate_id),
 FOREIGN KEY(athlete_id,candidate_id) REFERENCES public.integrated_candidate_v4(athlete_id,id),
 FOREIGN KEY(athlete_id,evidence_snapshot_id) REFERENCES public.evidence_app_admission_binding(athlete_id,evidence_snapshot_id)
);
CREATE TABLE public.approval_app_admission_binding (
 athlete_id text NOT NULL,receipt_key text NOT NULL, candidate_id uuid, integrated_candidate_id uuid,
 integrated_approval_id uuid, binding_version integer NOT NULL DEFAULT 1 CHECK(binding_version=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,receipt_key),CHECK(num_nonnulls(candidate_id,integrated_candidate_id)=1),
 CHECK(integrated_approval_id IS NULL OR integrated_candidate_id IS NOT NULL),
 FOREIGN KEY(athlete_id,receipt_key) REFERENCES public.command_receipt(athlete_id,idempotency_key),
 FOREIGN KEY(athlete_id,candidate_id) REFERENCES public.candidate_app_admission_binding(athlete_id,candidate_id),
 FOREIGN KEY(athlete_id,integrated_candidate_id) REFERENCES public.integrated_candidate_app_admission_binding(athlete_id,candidate_id),
 FOREIGN KEY(athlete_id,integrated_approval_id) REFERENCES public.integrated_approval_v4(athlete_id,approval_id)
);
CREATE FUNCTION public.guard_app_binding_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'IMMUTABLE_APP_ADMISSION_BINDING';
END $$;
REVOKE ALL ON FUNCTION public.guard_app_binding_mutation() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['evidence_app_admission_binding','run_app_admission_binding',
  'candidate_app_admission_binding','integrated_candidate_app_admission_binding','approval_app_admission_binding'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON public.%I USING (athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',t);
  EXECUTE format('CREATE TRIGGER immutable_app_binding BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_app_binding_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION public.require_evidence_app_binding(snapshot_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); pinned integer;
BEGIN
 PERFORM public.require_app_admission_revision(NULL);
 SELECT app_revision INTO pinned FROM public.evidence_app_admission_binding
  WHERE athlete_id=tenant AND evidence_snapshot_id=snapshot_id AND binding_version=1;
 IF pinned IS NULL THEN RAISE EXCEPTION 'APP_BINDING_UNAVAILABLE'; END IF;
 RETURN public.require_app_admission_revision(pinned);
END $$;
REVOKE ALL ON FUNCTION public.require_evidence_app_binding(uuid) FROM PUBLIC;

-- Only original INSERT triggers can bind an artifact; there is no runtime later
-- attach/backfill function that could reauthorize legacy artifacts after regrant.
CREATE FUNCTION public.capture_app_admission_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); pinned integer;
DECLARE evidence_id uuid; origin_run_id uuid;
BEGIN
 IF tenant IS DISTINCT FROM NEW.athlete_id THEN RAISE EXCEPTION 'APP_BINDING_TENANT_MISMATCH'; END IF;
 IF TG_TABLE_NAME='core_evidence_snapshot' THEN
  pinned:=public.require_app_admission_revision(NULL);
  INSERT INTO public.evidence_app_admission_binding(athlete_id,evidence_snapshot_id,app_revision)
   VALUES(tenant,NEW.id,pinned);
 ELSIF TG_TABLE_NAME='coaching_run' THEN
  PERFORM public.require_evidence_app_binding(NEW.evidence_snapshot_id);
  INSERT INTO public.run_app_admission_binding(athlete_id,run_id,evidence_snapshot_id)
   VALUES(tenant,NEW.id,NEW.evidence_snapshot_id);
 ELSIF TG_TABLE_NAME='coaching_candidate' THEN
  SELECT run_id INTO origin_run_id FROM public.coaching_decision WHERE athlete_id=tenant AND id=NEW.decision_id;
  SELECT evidence_snapshot_id INTO evidence_id FROM public.run_app_admission_binding WHERE athlete_id=tenant AND run_id=origin_run_id;
  IF evidence_id IS NULL THEN RAISE EXCEPTION 'APP_BINDING_UNAVAILABLE'; END IF;
  PERFORM public.require_evidence_app_binding(evidence_id);
  INSERT INTO public.candidate_app_admission_binding(athlete_id,candidate_id,run_id) VALUES(tenant,NEW.id,origin_run_id);
 ELSIF TG_TABLE_NAME='integrated_candidate_v4' THEN
  evidence_id:=(NEW.body->'basis'->>'evidenceSnapshotId')::uuid;
  IF evidence_id IS NULL THEN RAISE EXCEPTION 'APP_BINDING_UNAVAILABLE'; END IF;
  PERFORM public.require_evidence_app_binding(evidence_id);
  INSERT INTO public.integrated_candidate_app_admission_binding(athlete_id,candidate_id,evidence_snapshot_id)
   VALUES(tenant,NEW.id,evidence_id);
 ELSE RAISE EXCEPTION 'APP_BINDING_SUBJECT_INVALID'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_app_admission_binding() FROM PUBLIC;
CREATE TRIGGER capture_app_binding AFTER INSERT ON public.core_evidence_snapshot FOR EACH ROW EXECUTE FUNCTION public.capture_app_admission_binding();
CREATE TRIGGER capture_app_binding AFTER INSERT ON public.coaching_run FOR EACH ROW EXECUTE FUNCTION public.capture_app_admission_binding();
CREATE TRIGGER capture_app_binding AFTER INSERT ON public.coaching_candidate FOR EACH ROW EXECUTE FUNCTION public.capture_app_admission_binding();
CREATE TRIGGER capture_app_binding AFTER INSERT ON public.integrated_candidate_v4 FOR EACH ROW EXECUTE FUNCTION public.capture_app_admission_binding();

-- Root TS checks run/candidate lineage + binding before each processing stage.
-- It reads these append-only tables; execution helpers MUST NOT be used by legacy
-- historical read/export or successful-receipt return paths.
-- The narrow approval recording function appended below runs after receipt INSERT
-- in the same transaction. No runtime INSERT/UPDATE/DELETE grants on binding tables.

-- Account erasure wrapper removes children before parent deletion; ledger/replay
-- receipts survive erasure for authenticated restore convergence like AI history.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_app_binding;
REVOKE ALL ON FUNCTION public.erase_account_before_app_binding(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.erase_account_before_app_binding(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_app_binding(text) FROM %I',r); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 DELETE FROM public.approval_app_admission_binding WHERE athlete_id=$1;
 DELETE FROM public.integrated_candidate_app_admission_binding WHERE athlete_id=$1;
 DELETE FROM public.candidate_app_admission_binding WHERE athlete_id=$1;
 DELETE FROM public.run_app_admission_binding WHERE athlete_id=$1;
 DELETE FROM public.evidence_app_admission_binding WHERE athlete_id=$1;
 RETURN public.erase_account_before_app_binding($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;

-- Owner-only exact app epoch replay; source pattern 085, unchanged AI path.
-- Owner-only replay of a backup-authenticated APP consent transition.
-- The caller verifies the complete backup chain before entering this transaction.
CREATE TABLE public.restore_app_consent_replay_receipt (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  previous_revision integer,
  previous_granted boolean,
  consent_revision integer NOT NULL CHECK (consent_revision BETWEEN 1 AND 2147483647),
  consent_granted boolean NOT NULL,
  CHECK (((previous_revision IS NULL AND previous_granted IS NULL AND consent_revision=1)
    OR (previous_revision BETWEEN 1 AND 2147483646 AND previous_granted IS NOT NULL
      AND consent_revision=previous_revision+1)) IS TRUE)
);
REVOKE ALL ON TABLE public.restore_app_consent_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_app_consent_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_app_consent_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_app_consent_replay_receipt_owner
  ON public.restore_app_consent_replay_receipt
  USING (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_app_consent_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_app_consent_replay_receipt'::regclass)));

CREATE FUNCTION public.verify_restore_app_consent_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.kind='app_consent_transition' AND e.record_version=5 AND e.target_id IS NULL
      AND e.occurred_at=NEW.occurred_at
      AND e.consent_previous_revision IS NOT DISTINCT FROM NEW.previous_revision
      AND e.consent_previous_granted IS NOT DISTINCT FROM NEW.previous_granted
      AND e.consent_revision=NEW.consent_revision
      AND e.consent_granted=NEW.consent_granted)
  THEN RAISE EXCEPTION 'RESTORE_APP_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_app_consent_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_app_consent_replay_receipt_verify
  BEFORE INSERT ON public.restore_app_consent_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_app_consent_replay_receipt();
CREATE TRIGGER restore_app_consent_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_app_consent_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_app_consent_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_app_consent_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

CREATE FUNCTION public.replay_app_consent_transition_exact(
  text,uuid,timestamptz,integer,boolean,integer,boolean)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
   WHERE p.oid='public.replay_app_consent_transition_exact(text,uuid,timestamptz,integer,boolean,integer,boolean)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_app_consent_replay_receipt%ROWTYPE;
DECLARE head public.consent%ROWTYPE;
DECLARE later public.restore_suppression_event%ROWTYPE;
DECLARE expected_granted boolean;
DECLARE expected_revision integer;
DECLARE had_event boolean; had_receipt boolean:=false;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_APP_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $3 IS NULL OR $3>clock_timestamp()
    OR $6 IS NULL OR $6 NOT BETWEEN 1 AND 2147483647 OR $7 IS NULL
    OR (($4 IS NULL AND $5 IS NULL AND $6=1)
      OR ($4 BETWEEN 1 AND 2147483646 AND $5 IS NOT NULL AND $6=$4+1)) IS NOT TRUE
    OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESTORE_APP_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event
    WHERE event_id=$2 OR (athlete_id=$1 AND kind='app_consent_transition'
      AND consent_revision=$6) FOR UPDATE;
  had_event:=FOUND;
  IF had_event AND (existing.event_id IS DISTINCT FROM $2
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.kind IS DISTINCT FROM 'app_consent_transition' OR existing.record_version IS DISTINCT FROM 5
    OR existing.target_id IS NOT NULL OR existing.occurred_at IS DISTINCT FROM $3
    OR existing.consent_previous_revision IS DISTINCT FROM $4
    OR existing.consent_previous_granted IS DISTINCT FROM $5
    OR existing.consent_revision IS DISTINCT FROM $6
    OR existing.consent_granted IS DISTINCT FROM $7
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$2 OR (e.athlete_id=$1
        AND e.kind='app_consent_transition' AND e.consent_revision=$6))
        AND e.event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_APP_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_app_consent_replay_receipt r WHERE r.event_id=$2;
    had_receipt:=FOUND;
    IF had_receipt AND (receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.occurred_at IS DISTINCT FROM $3
      OR receipt.previous_revision IS DISTINCT FROM $4
      OR receipt.previous_granted IS DISTINCT FROM $5
      OR receipt.consent_revision IS DISTINCT FROM $6
      OR receipt.consent_granted IS DISTINCT FROM $7)
    THEN RAISE EXCEPTION 'RESTORE_APP_RECEIPT_CONFLICT'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_app_consent_replay_receipt r
    WHERE r.event_id=$2)
  THEN RAISE EXCEPTION 'RESTORE_APP_RECEIPT_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.athlete_id=$1 AND e.kind='tenant_erased')
    THEN
      IF NOT had_receipt THEN
        INSERT INTO public.restore_app_consent_replay_receipt(event_id,athlete_id,occurred_at,
          previous_revision,previous_granted,consent_revision,consent_granted)
          VALUES($2,$1,$3,$4,$5,$6,$7);
      END IF;
      RETURN 'already_applied_by_erasure';
    END IF;
    RAISE EXCEPTION 'RESTORE_APP_TENANT_ERASED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_APP_TENANT_UNKNOWN'; END IF;
  SELECT * INTO head FROM public.consent c
    WHERE c.athlete_id=$1 AND c.kind='app' FOR UPDATE;
  IF had_event THEN
    IF head.revision IS NULL OR head.revision<$6
    THEN RAISE EXCEPTION 'RESTORE_APP_STATE_CONFLICT'; END IF;
    expected_granted:=$7;
    expected_revision:=$6;
    FOR later IN SELECT e.* FROM public.restore_suppression_event e
      WHERE e.athlete_id=$1 AND e.kind='app_consent_transition'
        AND e.consent_revision>$6 AND e.consent_revision<=head.revision
      ORDER BY e.consent_revision
    LOOP
      IF later.consent_previous_revision IS DISTINCT FROM expected_revision
        OR later.consent_previous_granted IS DISTINCT FROM expected_granted
        OR later.occurred_at<$3 OR later.occurred_at>clock_timestamp()
        OR EXISTS(SELECT 1 FROM public.restore_app_consent_replay_receipt r
          WHERE r.event_id=later.event_id AND (r.athlete_id IS DISTINCT FROM $1
            OR r.occurred_at IS DISTINCT FROM later.occurred_at
            OR r.previous_revision IS DISTINCT FROM later.consent_previous_revision
            OR r.previous_granted IS DISTINCT FROM later.consent_previous_granted
            OR r.consent_revision IS DISTINCT FROM later.consent_revision
            OR r.consent_granted IS DISTINCT FROM later.consent_granted))
      THEN RAISE EXCEPTION 'RESTORE_APP_STATE_CONFLICT'; END IF;
      expected_revision:=later.consent_revision;
      expected_granted:=later.consent_granted;
    END LOOP;
    IF expected_revision IS DISTINCT FROM head.revision
      OR expected_granted IS DISTINCT FROM head.granted
    THEN RAISE EXCEPTION 'RESTORE_APP_STATE_CONFLICT'; END IF;
    -- A production event can be in the baseline without a restore receipt.
    -- Exact event identity and the complete contiguous head chain were verified above.
    IF NOT had_receipt THEN
      INSERT INTO public.restore_app_consent_replay_receipt(event_id,athlete_id,occurred_at,
        previous_revision,previous_granted,consent_revision,consent_granted)
        VALUES($2,$1,$3,$4,$5,$6,$7);
    END IF;
    RETURN 'already_applied';
  END IF;
  IF $4 IS NULL THEN
    IF head.revision IS NOT NULL THEN RAISE EXCEPTION 'RESTORE_APP_STATE_CONFLICT'; END IF;
  ELSIF head.revision IS DISTINCT FROM $4 OR head.granted IS DISTINCT FROM $5
  THEN RAISE EXCEPTION 'RESTORE_APP_STATE_CONFLICT'; END IF;
  PERFORM set_config('app.restore_app_consent_event_id',$2::text,true);
  IF $4 IS NULL THEN
    INSERT INTO public.consent(athlete_id,kind,granted,revision)
      VALUES($1,'app',$7,$6);
  ELSE
    UPDATE public.consent SET granted=$7,revision=$6
      WHERE athlete_id=$1 AND kind='app';
  END IF;
  PERFORM set_config('app.restore_app_consent_event_id','',true);
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES($1,$2,'restore:app_consent:'||$2::text,'consent.changed',
      jsonb_build_object('kind','app','granted',$7,'revision',$6));
  INSERT INTO public.restore_suppression_event(
    event_id,record_version,athlete_id,kind,occurred_at,consent_previous_revision,
    consent_previous_granted,consent_revision,consent_granted)
    VALUES($2,5,$1,'app_consent_transition',$3,$4,$5,$6,$7);
  INSERT INTO public.restore_app_consent_replay_receipt(
    event_id,athlete_id,occurred_at,previous_revision,previous_granted,
    consent_revision,consent_granted)
    VALUES($2,$1,$3,$4,$5,$6,$7);
  RETURN 'transitioned';
END $$;
REVOKE ALL ON FUNCTION public.replay_app_consent_transition_exact(
  text,uuid,timestamptz,integer,boolean,integer,boolean) FROM PUBLIC;

CREATE FUNCTION public.require_run_app_binding(subject_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE evidence_id uuid; BEGIN
 PERFORM public.require_app_admission_revision(NULL);
 SELECT b.evidence_snapshot_id INTO evidence_id FROM public.run_app_admission_binding b
 JOIN public.coaching_run r ON r.athlete_id=b.athlete_id AND r.id=b.run_id
  AND r.evidence_snapshot_id=b.evidence_snapshot_id
 WHERE b.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND b.run_id=subject_id AND b.binding_version=1;
 IF evidence_id IS NULL THEN RAISE EXCEPTION 'APP_BINDING_UNAVAILABLE'; END IF;
 RETURN public.require_evidence_app_binding(evidence_id);
END $$;
CREATE FUNCTION public.require_candidate_app_binding(subject_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE origin_run_id uuid; BEGIN
 PERFORM public.require_app_admission_revision(NULL);
 SELECT b.run_id INTO origin_run_id FROM public.candidate_app_admission_binding b
 JOIN public.coaching_candidate c ON c.athlete_id=b.athlete_id AND c.id=b.candidate_id
 JOIN public.coaching_decision d ON d.athlete_id=c.athlete_id AND d.id=c.decision_id AND d.run_id=b.run_id
 WHERE b.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND b.candidate_id=subject_id AND b.binding_version=1;
 IF origin_run_id IS NULL THEN RAISE EXCEPTION 'APP_BINDING_UNAVAILABLE'; END IF;
 RETURN public.require_run_app_binding(origin_run_id);
END $$;
CREATE FUNCTION public.require_integrated_candidate_app_binding(subject_id uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE evidence_id uuid; BEGIN
 PERFORM public.require_app_admission_revision(NULL);
 SELECT b.evidence_snapshot_id INTO evidence_id FROM public.integrated_candidate_app_admission_binding b
 JOIN public.integrated_candidate_v4 c ON c.athlete_id=b.athlete_id AND c.id=b.candidate_id
  AND c.body->'basis'->>'evidenceSnapshotId'=b.evidence_snapshot_id::text
 WHERE b.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND b.candidate_id=subject_id AND b.binding_version=1;
 IF evidence_id IS NULL THEN RAISE EXCEPTION 'APP_BINDING_UNAVAILABLE'; END IF;
 RETURN public.require_evidence_app_binding(evidence_id);
END $$;
REVOKE ALL ON FUNCTION public.require_run_app_binding(uuid),public.require_candidate_app_binding(uuid),
 public.require_integrated_candidate_app_binding(uuid) FROM PUBLIC;

CREATE FUNCTION public.guard_app_binding_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  OR NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 THEN RAISE EXCEPTION 'APP_BINDING_OWNER_REQUIRED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_app_binding_insert() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['evidence_app_admission_binding','run_app_admission_binding',
  'candidate_app_admission_binding','integrated_candidate_app_admission_binding','approval_app_admission_binding'] LOOP
  EXECUTE format('CREATE TRIGGER app_binding_insert_owner BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_app_binding_insert()',t);
 END LOOP;
END $$;

-- training carries a SHA256-only request. Caller supplies the EXACT canonical
-- request text used to make the stored hash (bounded; never stored by this fn).
-- SQL verifies its digest AND candidateId/operation before accepting its mapping.
-- joint/v4 identify the candidate directly in the stored request.
CREATE FUNCTION public.record_approval_app_binding(receipt_key text,subject_id uuid,
 canonical_training_request text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); saved record;
DECLARE parsed jsonb; approval_id uuid; is_integrated boolean:=false;
BEGIN
 PERFORM public.require_app_admission_revision(NULL);
 SELECT request,result,xmin::text::bigint AS transaction_id INTO saved FROM public.command_receipt
  WHERE athlete_id=tenant AND idempotency_key=receipt_key;
 -- modulo matches xid xmin across 32-bit wraparound; transaction identity only,
 -- not a backup chain or an authorization substitute.
 IF NOT FOUND OR saved.transaction_id<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
 THEN RAISE EXCEPTION 'APP_APPROVAL_RECEIPT_NOT_CURRENT'; END IF;
 IF receipt_key ~ '^coaching:candidate:approve:[a-f0-9]{64}$' THEN
  IF canonical_training_request IS NULL OR octet_length(canonical_training_request)>131072
  THEN RAISE EXCEPTION 'APP_APPROVAL_REQUEST_INVALID'; END IF;
  parsed:=canonical_training_request::jsonb;
  IF saved.request IS DISTINCT FROM jsonb_build_object('requestHash',encode(sha256(convert_to(canonical_training_request,'UTF8')),'hex'))
   OR parsed->>'operation' IS DISTINCT FROM 'training_candidate_approve'
   OR parsed->>'candidateId' IS DISTINCT FROM subject_id::text
   OR parsed->>'confirmed' IS DISTINCT FROM 'true'
  THEN RAISE EXCEPTION 'APP_APPROVAL_REQUEST_INVALID'; END IF;
  PERFORM public.require_candidate_app_binding(subject_id);
  IF NOT EXISTS(SELECT 1 FROM public.plan_snapshot WHERE athlete_id=tenant AND id::text=saved.result->>'versionId')
  THEN RAISE EXCEPTION 'APP_APPROVAL_RESULT_INVALID'; END IF;
 ELSIF receipt_key ~ '^joint:approve:[a-f0-9]{64}$' THEN
  IF saved.request->>'kind' IS DISTINCT FROM 'joint_approve_v3'
   OR saved.request->>'candidateId' IS DISTINCT FROM subject_id::text
  THEN RAISE EXCEPTION 'APP_APPROVAL_REQUEST_INVALID'; END IF;
  PERFORM public.require_candidate_app_binding(subject_id);
 ELSIF receipt_key ~ '^integrated-v4:approve:[a-f0-9]{64}$' THEN
  IF saved.request->>'kind' IS DISTINCT FROM 'integrated_approve_v4'
   OR saved.request->>'candidateId' IS DISTINCT FROM subject_id::text
  THEN RAISE EXCEPTION 'APP_APPROVAL_REQUEST_INVALID'; END IF;
  PERFORM public.require_integrated_candidate_app_binding(subject_id);
  SELECT a.approval_id INTO approval_id FROM public.integrated_approval_v4 a
   WHERE a.athlete_id=tenant AND a.candidate_id=subject_id
    AND a.approval_id::text=saved.result->>'approvalId' AND a.result_json=saved.result;
  IF approval_id IS NULL THEN RAISE EXCEPTION 'APP_APPROVAL_RESULT_INVALID'; END IF;
  is_integrated:=true;
 ELSE RAISE EXCEPTION 'APP_APPROVAL_REQUEST_INVALID'; END IF;
 INSERT INTO public.approval_app_admission_binding(athlete_id,receipt_key,candidate_id,integrated_candidate_id,integrated_approval_id)
 VALUES(tenant,receipt_key,CASE WHEN NOT is_integrated THEN subject_id END,
  CASE WHEN is_integrated THEN subject_id END,approval_id);
END $$;
REVOKE ALL ON FUNCTION public.record_approval_app_binding(text,uuid,text) FROM PUBLIC;

-- Suggested explicit root grant helper additions (not a grant-all block):
-- API evidence role: SELECT evidence_app_admission_binding; EXECUTE require_app_admission_revision,require_evidence_app_binding.
-- API run role: additionally SELECT run_app_admission_binding; EXECUTE require_run_app_binding.
-- Candidate/joint role: additionally SELECT candidate_app_admission_binding; EXECUTE require_candidate_app_binding,record_approval_app_binding.
-- v4 role: additionally SELECT integrated_candidate_app_admission_binding; EXECUTE require_integrated_candidate_app_binding,record_approval_app_binding.
-- Export role: SELECT all five binding tables (bounded projection only).
-- Worker role: SELECT evidence/run bindings + EXECUTE evidence/run current checks; NO approval recorder.
-- Owner-only exact replay function/table: NO runtime grants, NO execute PUBLIC.
-- Root regrant erase_account only to its existing bounded erasure role.
-- These tables use existing tenant policy even for owner trigger execution; no new
-- definer policy retarget list entry needed. restore_app replay receipt uses owner
-- predicate evaluated from live relowner, mirroring AI 085; REASSIGN must move both
-- function/table owners before runtime/restore access, never grant owner role to API.
