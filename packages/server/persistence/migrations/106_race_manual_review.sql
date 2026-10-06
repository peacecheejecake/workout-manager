-- Immutable race manual-review storage and derived-copy suppression protocol.
-- Admission remains authoritative CLOSED under101; no runtime store/replay/helper
-- privileges or owner loader are activated by this migration.
-- Repository semantic source/DTO validation, export34, full authenticated archive,
-- complete suppression tail and independent witnesses remain separate requirements.

-- Version6 adds derived-copy suppression only; never claims source-domain deletion.
ALTER TABLE public.restore_suppression_event
 ADD COLUMN manual_review_source_kind text,
 ADD COLUMN manual_review_source_id text,
 ADD COLUMN manual_review_version_scope text,
 ADD COLUMN manual_review_version_key text;

CREATE FUNCTION public.manual_review_source_key_valid(k text,s text,scope text,v text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE tuple jsonb;
BEGIN
 IF k IS NULL OR k NOT IN ('race-event','plan-snapshot','nutrition-plan-version','recovery-strategy-version','routine-schedule-version','routine-blueprint-version','routine-occurrence','routine-run','session-completion')
  OR s IS NULL OR length(s) NOT BETWEEN 1 AND 200 OR s ~ '[[:cntrl:]]' OR scope IS NULL OR scope NOT IN ('exact_version','all_versions') THEN RETURN false; END IF;
 IF k<>'session-completion' AND s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
 IF scope='all_versions' THEN RETURN v IS NULL; END IF;
 IF v IS NULL OR length(v) NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
 CASE k
 WHEN 'race-event','plan-snapshot' THEN RETURN v ~ '^[1-9][0-9]{0,9}$' AND v::numeric<=2147483647;
 WHEN 'routine-run' THEN RETURN v ~ '^(0|[1-9][0-9]{0,9})$' AND v::numeric<=2147483647;
 WHEN 'routine-occurrence' THEN RETURN v='immutable';
 WHEN 'session-completion' THEN
  tuple:=v::jsonb;
  RETURN (jsonb_typeof(tuple)='array' AND jsonb_array_length(tuple)=2 AND jsonb_typeof(tuple->0)='string'
   AND tuple->>0 ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND jsonb_typeof(tuple->1)='number' AND tuple->>1 ~ '^[1-9][0-9]{0,9}$' AND (tuple->>1)::numeric<=2147483647
   AND v='['||to_jsonb(tuple->>0)::text||','||(tuple->>1)||']') IS TRUE;
 ELSE RETURN v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 END CASE;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.manual_review_source_key_valid(text,text,text,text) FROM PUBLIC;

-- Preserve the authoritative old1..5 expressions exactly, with new columns NULL.
-- All previous payload columns, including target_id, must be NULL in v6.
DO $$ DECLARE cname text; old_expr text; old_nulls text; new_branch text; BEGIN
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO old_nulls FROM pg_attribute
 WHERE attrelid='public.restore_suppression_event'::regclass AND attnum>0 AND NOT attisdropped
 AND attname<>ALL(ARRAY['event_id','record_version','athlete_id','kind','occurred_at','manual_review_source_kind','manual_review_source_id','manual_review_version_scope','manual_review_version_key']);
 new_branch:=format('(record_version=6 AND kind=''manual_review_source_suppressed'' AND isfinite(occurred_at)
  AND public.manual_review_source_key_valid(manual_review_source_kind,manual_review_source_id,manual_review_version_scope,manual_review_version_key) IS TRUE AND %s) IS TRUE',old_nulls);
 FOREACH cname IN ARRAY ARRAY['restore_suppression_event_kind_target_check','restore_suppression_event_record_version_check'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO old_expr FROM pg_constraint WHERE conrelid='public.restore_suppression_event'::regclass AND conname=cname;
  IF old_expr IS NULL THEN RAISE EXCEPTION 'MANUAL_REVIEW_EVENT_SCHEMA_MISSING'; END IF;
  EXECUTE format('ALTER TABLE public.restore_suppression_event DROP CONSTRAINT %I',cname);
  EXECUTE format('ALTER TABLE public.restore_suppression_event ADD CONSTRAINT %I CHECK (
   ((record_version<>6 AND kind<>''manual_review_source_suppressed'' AND manual_review_source_kind IS NULL AND manual_review_source_id IS NULL AND manual_review_version_scope IS NULL AND manual_review_version_key IS NULL) AND (%s)) OR (%s))',cname,old_expr,new_branch);
 END LOOP;
END $$;
CREATE UNIQUE INDEX restore_manual_review_source_exact_once ON public.restore_suppression_event
 (athlete_id,manual_review_source_kind,manual_review_source_id,manual_review_version_key)
 WHERE record_version=6 AND manual_review_version_scope='exact_version';
CREATE UNIQUE INDEX restore_manual_review_source_all_once ON public.restore_suppression_event
 (athlete_id,manual_review_source_kind,manual_review_source_id)
 WHERE record_version=6 AND manual_review_version_scope='all_versions';

CREATE FUNCTION public.verify_manual_review_source_event_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NEW.record_version=6 OR NEW.kind='manual_review_source_suppressed' THEN
  IF NEW.record_version IS DISTINCT FROM 6 OR NEW.kind IS DISTINCT FROM 'manual_review_source_suppressed'
   OR public.manual_review_source_key_valid(NEW.manual_review_source_kind,NEW.manual_review_source_id,NEW.manual_review_version_scope,NEW.manual_review_version_key) IS NOT TRUE
   OR EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(NEW)) e WHERE e.key<>ALL(ARRAY['event_id','record_version','athlete_id','kind','occurred_at','manual_review_source_kind','manual_review_source_id','manual_review_version_scope','manual_review_version_key']) AND e.value<>'null'::jsonb)
  THEN RAISE EXCEPTION 'MANUAL_REVIEW_EVENT_FIELDS_INVALID'; END IF;
 ELSIF num_nonnulls(NEW.manual_review_source_kind,NEW.manual_review_source_id,NEW.manual_review_version_scope,NEW.manual_review_version_key)<>0
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_EVENT_FIELDS_INVALID'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_manual_review_source_event_fields() FROM PUBLIC;
CREATE TRIGGER verify_manual_review_source_event_fields BEFORE INSERT ON public.restore_suppression_event
 FOR EACH ROW EXECUTE FUNCTION public.verify_manual_review_source_event_fields();

CREATE TABLE public.race_manual_review (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200 AND btrim(athlete_id)=athlete_id),
 id uuid NOT NULL, schema_version integer NOT NULL CHECK(schema_version=1),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)), event_id uuid NOT NULL,
 event_revision integer NOT NULL CHECK(event_revision BETWEEN 1 AND 2147483647),
 app_revision integer NOT NULL CHECK(app_revision BETWEEN 1 AND 2147483647),
 generation_id uuid NOT NULL, policy_id text NOT NULL CHECK(policy_id='manual-race-date-impact'),
 policy_version integer NOT NULL CHECK(policy_version=1),
 policy_digest text NOT NULL CHECK(policy_digest ~ '^[0-9a-f]{64}$'),
 read_set_digest text NOT NULL CHECK(read_set_digest ~ '^[0-9a-f]{64}$'),
 candidate_digest text NOT NULL CHECK(candidate_digest ~ '^[0-9a-f]{64}$'),
 payload_sql_digest text NOT NULL CHECK(payload_sql_digest ~ '^[0-9a-f]{64}$'),
 receipt_key text NOT NULL CHECK(receipt_key ~ '^race-manual-review:store:[0-9a-f]{64}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 payload jsonb, purged_at timestamptz, purged_reason text,
 PRIMARY KEY(athlete_id,id), UNIQUE(athlete_id,receipt_key),
 FOREIGN KEY(athlete_id,receipt_key) REFERENCES public.command_receipt(athlete_id,idempotency_key) DEFERRABLE INITIALLY DEFERRED,
 CHECK(((payload IS NOT NULL AND jsonb_typeof(payload)='object' AND octet_length(payload::text)<=4194304
   AND payload_sql_digest=encode(sha256(convert_to(payload::text,'UTF8')),'hex') AND purged_at IS NULL AND purged_reason IS NULL)
  OR (payload IS NULL AND purged_at IS NOT NULL AND purged_reason='source_deleted')) IS TRUE)
);
CREATE TABLE public.race_manual_review_source_ref (
 athlete_id text NOT NULL, review_id uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('race-event','plan-snapshot','nutrition-plan-version',
 'recovery-strategy-version','routine-schedule-version','routine-blueprint-version','routine-occurrence','routine-run','session-completion')),
 source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
 version_key text NOT NULL CHECK(length(version_key) BETWEEN 1 AND 128),
 source_row_digest text NOT NULL CHECK(source_row_digest ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(athlete_id,review_id,source_kind,source_id,version_key),
 FOREIGN KEY(athlete_id,review_id) REFERENCES public.race_manual_review(athlete_id,id)
);
CREATE INDEX race_manual_review_ref_reverse ON public.race_manual_review_source_ref(athlete_id,source_kind,source_id);
-- Private markers link to authoritative v6 OR exact matching old4 race / old tenant events.
-- Original occurrence time/event identity survives replay; no new signed event is fabricated.
CREATE TABLE public.race_manual_review_source_suppression (
 athlete_id text NOT NULL, review_id uuid NOT NULL,
 source_kind text NOT NULL, source_id text NOT NULL, version_key text NOT NULL,
 source_row_digest text NOT NULL CHECK(source_row_digest ~ '^[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
 event_id uuid NOT NULL REFERENCES public.restore_suppression_event(event_id),
 PRIMARY KEY(athlete_id,review_id,source_kind,source_id,version_key),
 FOREIGN KEY(athlete_id,review_id,source_kind,source_id,version_key)
 REFERENCES public.race_manual_review_source_ref(athlete_id,review_id,source_kind,source_id,version_key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['race_manual_review','race_manual_review_source_ref','race_manual_review_source_suppression'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY manual_review_tenant ON public.%I USING(athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK(athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',t);
 END LOOP;
END $$;

-- Owner check uses LIVE relation owner, not a stale migration role name.
-- Definer-policy-retarget remains a required REASSIGN OWNED step (existing066 rules).
CREATE FUNCTION public.manual_review_owner() RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.race_manual_review'::regclass))
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.manual_review_owner() FROM PUBLIC;

-- Strict finite source resolver. No dynamic relation name, current-head substitution,
-- UUID synthesis, historical aggregate identity or inferred actual/content mapping.
-- Source SQL fingerprint algorithm: postgres-row-jsonb-utc-v1, schema-bound.
-- UTC applies BEFORE to_jsonb encodes actual timestamptz columns. Converting a
-- previously encoded JSON string afterwards would not normalize this hash.
-- Function-local proconfig restores the caller's TimeZone when this call exits.
-- JSON body strings remain original bytes/values; do not reinterpret their zones.
-- This SQL row encoding is NOT the DTO/candidate canonical digest algorithm.
CREATE FUNCTION public.manual_review_source_row(k text,s text,v text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE r jsonb; tuple jsonb; tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
 IF tenant IS NULL OR k IS NULL OR s IS NULL OR v IS NULL THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
 IF k<>'session-completion' AND s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
 CASE k
 WHEN 'race-event' THEN
  IF v !~ '^[1-9][0-9]{0,9}$' OR v::numeric>2147483647 THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
  SELECT to_jsonb(x) INTO r FROM public.race_event x WHERE athlete_id=tenant AND id=s::uuid AND revision=v::integer AND NOT deleted;
 WHEN 'plan-snapshot' THEN
  IF v !~ '^[1-9][0-9]{0,9}$' OR v::numeric>2147483647 THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
  SELECT to_jsonb(x) INTO r FROM public.plan_snapshot x WHERE athlete_id=tenant AND id=s::uuid AND version=v::integer;
 WHEN 'nutrition-plan-version' THEN
  SELECT to_jsonb(x) INTO r FROM public.nutrition_plan_version x WHERE athlete_id=tenant AND plan_id=s::uuid AND version_id=v::uuid AND version_id::text=v;
 WHEN 'recovery-strategy-version' THEN
  SELECT to_jsonb(x) INTO r FROM public.recovery_strategy_version x WHERE athlete_id=tenant AND strategy_id=s::uuid AND version_id=v::uuid AND version_id::text=v;
 WHEN 'routine-schedule-version' THEN
  SELECT to_jsonb(x) INTO r FROM public.routine_schedule_version x WHERE athlete_id=tenant AND schedule_id=s::uuid AND version_id=v::uuid AND version_id::text=v;
 WHEN 'routine-blueprint-version' THEN
  SELECT to_jsonb(x) INTO r FROM public.routine_blueprint_version x WHERE athlete_id=tenant AND routine_id=s::uuid AND version_id=v::uuid AND version_id::text=v;
 WHEN 'routine-occurrence' THEN
  IF v<>'immutable' THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
  SELECT to_jsonb(x) INTO r FROM public.routine_occurrence x WHERE athlete_id=tenant AND id=s::uuid;
 WHEN 'routine-run' THEN
  IF v !~ '^(0|[1-9][0-9]{0,9})$' OR v::numeric>2147483647 THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
  SELECT to_jsonb(x) INTO r FROM public.routine_run x WHERE athlete_id=tenant AND id=s::uuid AND revision=v::integer;
 WHEN 'session-completion' THEN
  tuple:=v::jsonb;
  IF jsonb_typeof(tuple)<>'array' OR jsonb_array_length(tuple)<>2
   OR jsonb_typeof(tuple->0)<>'string' OR (tuple->>0) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(tuple->1)<>'number' OR (tuple->>1) !~ '^[1-9][0-9]{0,9}$' OR (tuple->>1)::numeric>2147483647
   OR v IS DISTINCT FROM '['||to_jsonb(tuple->>0)::text||','||(tuple->>1)||']'
  THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
  SELECT to_jsonb(x) INTO r FROM public.session_completion x WHERE athlete_id=tenant AND session_id=s
   AND revision=(tuple->>1)::integer AND record_json->>'planVersionId'=tuple->>0;
 ELSE RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_UNSUPPORTED';
 END CASE;
 IF r IS NULL THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_UNAVAILABLE'; END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.manual_review_source_row(text,text,text) FROM PUBLIC;

CREATE FUNCTION public.manual_review_mutation_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE previous jsonb; proposed jsonb; pinned integer; parent public.race_manual_review%ROWTYPE; ref public.race_manual_review_source_ref%ROWTYPE; parent_xmin text;
BEGIN
 PERFORM public.manual_review_owner();
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'IMMUTABLE_MANUAL_REVIEW'; END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'MANUAL_REVIEW_TENANT_REQUIRED'; END IF;
  IF TG_TABLE_NAME='race_manual_review_source_suppression' THEN
   -- Privacy maintenance remains allowed while CLOSED or app withdrawn. It still
   -- requires the live plain owner, existing exact ref, original digest and global-first.
   IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
    AND l.classid=77210::oid AND l.objid=1::oid AND l.objsubid=2 AND l.granted AND l.mode IN ('ShareLock','ExclusiveLock'))
   THEN RAISE EXCEPTION 'MANUAL_REVIEW_GLOBAL_LOCK_REQUIRED'; END IF;
   PERFORM public.assert_manual_review_lifecycle_lock(NEW.athlete_id);
   SELECT * INTO ref FROM public.race_manual_review_source_ref x
    WHERE x.athlete_id=NEW.athlete_id AND x.review_id=NEW.review_id
     AND x.source_kind=NEW.source_kind AND x.source_id=NEW.source_id AND x.version_key=NEW.version_key;
   IF ref.review_id IS NULL OR ref.source_row_digest IS DISTINCT FROM NEW.source_row_digest
    OR NEW.occurred_at IS NULL OR NOT isfinite(NEW.occurred_at)
    OR public.manual_review_marker_provenance_valid(NEW.athlete_id,NEW.event_id,NEW.source_kind,NEW.source_id,NEW.version_key,NEW.occurred_at) IS NOT TRUE
   THEN RAISE EXCEPTION 'MANUAL_REVIEW_SUPPRESSION_INVALID'; END IF;
  ELSE
   -- Direct INSERT cannot bypass the positive health processing fence.
   IF TG_TABLE_NAME='race_manual_review' THEN
    pinned:=(to_jsonb(NEW)->>'app_revision')::integer;
   ELSIF TG_TABLE_NAME='race_manual_review_source_ref' THEN
    SELECT * INTO parent FROM public.race_manual_review x WHERE x.athlete_id=NEW.athlete_id AND x.id=NEW.review_id;
    SELECT x.xmin::text INTO parent_xmin FROM public.race_manual_review x WHERE x.athlete_id=NEW.athlete_id AND x.id=NEW.review_id;
    IF parent.id IS NULL OR parent.payload IS NULL OR parent.app_revision IS NULL
     OR parent_xmin IS DISTINCT FROM (txid_current()%4294967296)::text
    THEN RAISE EXCEPTION 'MANUAL_REVIEW_PARENT_INVALID'; END IF;
    pinned:=parent.app_revision;
    IF NEW.source_row_digest IS DISTINCT FROM encode(sha256(convert_to(public.manual_review_source_row(NEW.source_kind,NEW.source_id,NEW.version_key)::text,'UTF8')),'hex')
    THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_CHANGED'; END IF;
   ELSE RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
   IF pinned IS NULL OR pinned NOT BETWEEN 1 AND 2147483647 THEN RAISE EXCEPTION 'MANUAL_REVIEW_PARENT_INVALID'; END IF;
   PERFORM public.require_restore_processing_admission();
   PERFORM public.require_app_admission_revision(pinned);
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='race_manual_review' THEN
  previous:=to_jsonb(OLD)-ARRAY['payload','purged_at','purged_reason'];
  proposed:=to_jsonb(NEW)-ARRAY['payload','purged_at','purged_reason'];
  IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory' AND l.classid=77210::oid AND l.objid=1::oid AND l.objsubid=2 AND l.granted AND l.mode IN ('ShareLock','ExclusiveLock')) THEN RAISE EXCEPTION 'MANUAL_REVIEW_GLOBAL_LOCK_REQUIRED'; END IF;
  PERFORM public.assert_manual_review_lifecycle_lock(OLD.athlete_id);
  IF previous=proposed AND OLD.payload IS NOT NULL AND NEW.payload IS NULL
   AND NEW.purged_reason='source_deleted' AND NEW.purged_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.race_manual_review_source_suppression s WHERE s.athlete_id=OLD.athlete_id AND s.review_id=OLD.id)
  THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'IMMUTABLE_MANUAL_REVIEW';
END $$;
REVOKE ALL ON FUNCTION public.manual_review_mutation_guard() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['race_manual_review','race_manual_review_source_ref','race_manual_review_source_suppression'] LOOP
  EXECUTE format('CREATE TRIGGER manual_review_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.manual_review_mutation_guard()',t);
  EXECUTE format('CREATE TRIGGER manual_review_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.manual_review_mutation_guard()',t);
 END LOOP;
END $$;

-- The event permits DERIVED-copy suppression only. Never touches source domain rows.
CREATE FUNCTION public.manual_review_marker_provenance_valid(athlete text,event uuid,k text,s text,v text,stamp timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.restore_suppression_event e WHERE e.event_id=$2 AND e.athlete_id=$1 AND e.occurred_at=$6 AND (
  (e.record_version=6 AND e.kind='manual_review_source_suppressed' AND e.manual_review_source_kind=$3 AND e.manual_review_source_id=$4
   AND (e.manual_review_version_scope='all_versions' OR (e.manual_review_version_scope='exact_version' AND e.manual_review_version_key=$5)))
  OR (e.record_version=4 AND e.kind='race_event_deleted' AND $3='race-event' AND e.target_id::text=$4)
  OR (e.kind='tenant_erased' AND e.record_version IN (1,2,3,4,5))))
$$;
REVOKE ALL ON FUNCTION public.manual_review_marker_provenance_valid(text,uuid,text,text,text,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.assert_manual_review_global_lock() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.classid=77210::oid AND l.objid=1::oid AND l.objsubid=2 AND l.granted AND l.mode IN ('ShareLock','ExclusiveLock'))
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_GLOBAL_LOCK_REQUIRED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_manual_review_global_lock() FROM PUBLIC;

-- Owner replay requires the coordinator's global EXCLUSIVE lock already held.
-- Never acquire global after lifecycle/tenant locks; this is a precondition only.
CREATE FUNCTION public.assert_manual_review_lifecycle_lock(tenant text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE lock_key bigint:=hashtextextended(tenant,77206);
BEGIN
 IF tenant IS NULL OR tenant IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
 OR NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.classid=((lock_key >> 32) & 4294967295)::oid
  AND l.objid=(lock_key & 4294967295)::oid AND l.objsubid=1
  AND l.granted AND l.mode IN ('ShareLock','ExclusiveLock'))
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_LIFECYCLE_LOCK_REQUIRED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_manual_review_lifecycle_lock(text) FROM PUBLIC;

CREATE FUNCTION public.assert_manual_review_replay_global_lock() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.classid=77210::oid AND l.objid=1::oid AND l.objsubid=2 AND l.granted AND l.mode='ExclusiveLock')
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_GLOBAL_EXCLUSIVE_REQUIRED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_manual_review_replay_global_lock() FROM PUBLIC;


-- Existing authoritative event posthook, including already-deleted/receipted old4.
-- No emission and no source-domain mutation. Caller must authenticate exact old replay.
CREATE FUNCTION public.suppress_manual_reviews_from_event(event uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.restore_suppression_event%ROWTYPE; ref public.race_manual_review_source_ref%ROWTYPE;
 prior public.race_manual_review_source_suppression%ROWTYPE; tenant text:=nullif(current_setting('app.athlete_id',true),'');
BEGIN
 PERFORM public.manual_review_owner();
 PERFORM public.assert_manual_review_global_lock();
 PERFORM public.assert_manual_review_lifecycle_lock(tenant);
 SELECT * INTO e FROM public.restore_suppression_event x WHERE x.event_id=$1;
 IF e.event_id IS NULL OR e.athlete_id IS DISTINCT FROM tenant
  OR NOT (e.kind='tenant_erased' OR (e.record_version=4 AND e.kind='race_event_deleted') OR (e.record_version=6 AND e.kind='manual_review_source_suppressed'))
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_EVENT_UNAVAILABLE'; END IF;
 -- Owner replay entry must hold lifecycle exclusive; live entry lifecycle shared.
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 FOR ref IN SELECT * FROM public.race_manual_review_source_ref r WHERE r.athlete_id=tenant AND
  (e.kind='tenant_erased' OR (e.record_version=4 AND r.source_kind='race-event' AND r.source_id=e.target_id::text)
   OR (e.record_version=6 AND r.source_kind=e.manual_review_source_kind AND r.source_id=e.manual_review_source_id
    AND (e.manual_review_version_scope='all_versions' OR r.version_key=e.manual_review_version_key)))
 ORDER BY r.review_id,r.source_kind,r.source_id,r.version_key LOOP
  SELECT * INTO prior FROM public.race_manual_review_source_suppression s WHERE s.athlete_id=ref.athlete_id AND s.review_id=ref.review_id AND s.source_kind=ref.source_kind AND s.source_id=ref.source_id AND s.version_key=ref.version_key;
  IF NOT FOUND THEN
   INSERT INTO public.race_manual_review_source_suppression VALUES(ref.athlete_id,ref.review_id,ref.source_kind,ref.source_id,ref.version_key,ref.source_row_digest,e.occurred_at,e.event_id);
  ELSE
   -- A different matching earlier event may already have suppressed this exact copy.
   -- Preserve its original provenance/time, verify it remains authoritative, no overwrite.
   IF prior.source_row_digest IS DISTINCT FROM ref.source_row_digest OR public.manual_review_marker_provenance_valid(prior.athlete_id,prior.event_id,prior.source_kind,prior.source_id,prior.version_key,prior.occurred_at) IS NOT TRUE
   THEN RAISE EXCEPTION 'MANUAL_REVIEW_MARKER_CONFLICT'; END IF;
  END IF;
  UPDATE public.race_manual_review SET payload=NULL,purged_at=e.occurred_at,purged_reason='source_deleted' WHERE athlete_id=tenant AND id=ref.review_id AND payload IS NOT NULL;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.suppress_manual_reviews_from_event(uuid) FROM PUBLIC;

-- Live source-delete hook: event6+markers+scrub in the SAME source transaction.
-- The source identity is a finite static trigger mapping; this is not a runtime API.
CREATE FUNCTION public.suppress_manual_review_source(k text,s text,v text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); e public.restore_suppression_event%ROWTYPE;
 scope text:=CASE WHEN v IS NULL THEN 'all_versions' ELSE 'exact_version' END;
BEGIN
 IF public.manual_review_source_key_valid(k,s,scope,v) IS NOT TRUE OR tenant IS NULL THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.race_manual_review_source_ref r WHERE r.athlete_id=tenant AND r.source_kind=k AND r.source_id=s AND (v IS NULL OR r.version_key=v)) THEN RETURN; END IF;
 PERFORM public.manual_review_owner();
 PERFORM public.assert_manual_review_global_lock();
 PERFORM public.assert_manual_review_lifecycle_lock(tenant);
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 IF session_user=current_user THEN
  -- Owner maintenance/restoration cannot mint a new live v6 fact. Only an
  -- already authoritative old4/tenant/v6 event may authorize matching copies.
  SELECT * INTO e FROM public.restore_suppression_event x WHERE x.athlete_id=tenant AND (
   (x.record_version=4 AND x.kind='race_event_deleted' AND k='race-event' AND x.target_id::text=s)
   OR x.kind='tenant_erased' OR (x.record_version=6 AND x.kind='manual_review_source_suppressed'
    AND x.manual_review_source_kind=k AND x.manual_review_source_id=s AND x.manual_review_version_scope=scope AND x.manual_review_version_key IS NOT DISTINCT FROM v))
  ORDER BY CASE WHEN x.record_version=4 THEN 0 WHEN x.kind='tenant_erased' THEN 1 ELSE 2 END,x.occurred_at,x.event_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANUAL_REVIEW_OWNER_EVENT_REQUIRED'; END IF;
  PERFORM public.suppress_manual_reviews_from_event(e.event_id);
  RETURN;
 END IF;
 SELECT * INTO e FROM public.restore_suppression_event x WHERE x.athlete_id=tenant AND x.record_version=6 AND x.kind='manual_review_source_suppressed'
  AND x.manual_review_source_kind=k AND x.manual_review_source_id=s AND x.manual_review_version_scope=scope AND x.manual_review_version_key IS NOT DISTINCT FROM v;
 IF NOT FOUND THEN
  INSERT INTO public.restore_suppression_event(record_version,athlete_id,kind,occurred_at,manual_review_source_kind,manual_review_source_id,manual_review_version_scope,manual_review_version_key)
   VALUES(6,tenant,'manual_review_source_suppressed',clock_timestamp(),k,s,scope,v) RETURNING * INTO e;
 END IF;
 PERFORM public.suppress_manual_reviews_from_event(e.event_id);
END $$;
REVOKE ALL ON FUNCTION public.suppress_manual_review_source(text,text,text) FROM PUBLIC;

-- Static row→source mappings. session deletion affects all exact plan namespaces;
-- reading/storing still requires the exact [planVersionId,revision] tuple.
CREATE FUNCTION public.manual_review_source_delete_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text; s text; v text;
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'race_event' THEN k:='race-event'; s:=OLD.id::text;
 WHEN 'plan_snapshot' THEN k:='plan-snapshot'; s:=OLD.id::text; v:=OLD.version::text;
 WHEN 'nutrition_plan_version' THEN k:='nutrition-plan-version'; s:=OLD.plan_id::text; v:=OLD.version_id::text;
 WHEN 'recovery_strategy_version' THEN k:='recovery-strategy-version'; s:=OLD.strategy_id::text; v:=OLD.version_id::text;
 WHEN 'routine_schedule_version' THEN k:='routine-schedule-version'; s:=OLD.schedule_id::text; v:=OLD.version_id::text;
 WHEN 'routine_blueprint_version' THEN k:='routine-blueprint-version'; s:=OLD.routine_id::text; v:=OLD.version_id::text;
 WHEN 'routine_occurrence' THEN k:='routine-occurrence'; s:=OLD.id::text;
 WHEN 'routine_run' THEN k:='routine-run'; s:=OLD.id::text;
 WHEN 'session_completion' THEN k:='session-completion'; s:=OLD.session_id;
 ELSE RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_UNSUPPORTED'; END CASE;
 IF NOT EXISTS(SELECT 1 FROM public.race_manual_review_source_ref x WHERE x.athlete_id=OLD.athlete_id AND x.source_kind=k AND x.source_id=s AND (v IS NULL OR x.version_key=v)) THEN RETURN OLD; END IF;
 IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM public.suppress_manual_review_source(k,s,v);
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.manual_review_source_delete_trigger() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['race_event','plan_snapshot','nutrition_plan_version','recovery_strategy_version','routine_schedule_version','routine_blueprint_version','routine_occurrence','routine_run','session_completion'] LOOP
  EXECUTE format('CREATE TRIGGER manual_review_source_delete AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.manual_review_source_delete_trigger()',t);
 END LOOP;
END $$;
CREATE FUNCTION public.manual_review_race_soft_delete_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NEW.deleted AND NOT OLD.deleted AND EXISTS(SELECT 1 FROM public.race_manual_review_source_ref x WHERE x.athlete_id=OLD.athlete_id AND x.source_kind='race-event' AND x.source_id=OLD.id::text) THEN
  IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
  PERFORM public.suppress_manual_review_source('race-event',OLD.id::text);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.manual_review_race_soft_delete_trigger() FROM PUBLIC;
CREATE TRIGGER manual_review_race_soft_delete AFTER UPDATE OF deleted ON public.race_event FOR EACH ROW EXECUTE FUNCTION public.manual_review_race_soft_delete_trigger();

-- Root repository must strictly decode sourceInput + reproduce the pure candidate,
-- check mapper coverage/lineage and supply only verified refs. SQL structural checks
-- below DO NOT authenticate capture completeness or semantically reconstruct body.
CREATE FUNCTION public.store_race_manual_review(review_id uuid,receipt_key text,request_digest text,
 event_id uuid,event_revision integer,app_revision integer,generation_id uuid,
 policy_digest text,read_set_digest text,candidate_digest text,payload jsonb,refs jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); prior public.command_receipt%ROWTYPE;
 existing public.race_manual_review%ROWTYPE; r jsonb; source jsonb; stamp timestamptz:=clock_timestamp(); result jsonb;
BEGIN
 PERFORM public.manual_review_owner();
 IF tenant IS NULL THEN RAISE EXCEPTION 'MANUAL_REVIEW_TENANT_REQUIRED'; END IF;
 -- Global first even for replay. Positive gate only after exact committed receipt.
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 SELECT * INTO prior FROM public.command_receipt q WHERE q.athlete_id=tenant AND q.idempotency_key=$2;
 IF FOUND THEN
  SELECT * INTO existing FROM public.race_manual_review q WHERE q.athlete_id=tenant AND q.receipt_key=$2;
  IF existing.id IS NULL OR existing.request_digest IS DISTINCT FROM $3 OR prior.request IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'requestDigest',$3)
   OR prior.result IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'reviewId',existing.id,'candidateDigest',existing.candidate_digest,'createdAt',to_char(existing.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'approvalAllowed',false,'sourceCompleteness','unverified')
  THEN RAISE EXCEPTION 'MANUAL_REVIEW_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN prior.result;
 END IF;
 PERFORM public.require_restore_processing_admission(); -- CURRENT101: ALWAYS DENY.
 PERFORM public.require_app_admission_revision($6);
 IF $7 IS DISTINCT FROM public.current_restore_generation() THEN RAISE EXCEPTION 'STALE_MANUAL_REVIEW_GENERATION'; END IF;
 IF $1 IS NULL OR $2 IS NULL OR $2 !~ '^race-manual-review:store:[0-9a-f]{64}$' OR $3 IS NULL OR $3 !~ '^[0-9a-f]{64}$'
  OR $4 IS NULL OR $5 IS NULL OR $5 NOT BETWEEN 1 AND 2147483647
  OR $9 IS NULL OR $9 !~ '^[0-9a-f]{64}$' OR $10 IS NULL OR $10 !~ '^[0-9a-f]{64}$'
  OR $8 IS DISTINCT FROM encode(sha256(convert_to('{"id":"manual-race-date-impact","version":1,"existingUnresolved":"preserve_with_notice","affectedUnresolved":"resolve_before_approval","actualRecords":"preserve","application":"explicit_user_approval","calendarMovement":"civil_date","unknownRaceEnd":"remain_unresolved"}','UTF8')),'hex')
 THEN RAISE EXCEPTION 'INVALID_MANUAL_REVIEW'; END IF;
 IF (jsonb_typeof($11)='object' AND octet_length($11::text)<=4194304
  AND $11->'candidate'->>'kind'='manual-race-review-draft' AND $11->'candidate'->>'status'='assembled'
  AND $11->'candidate'->>'storage'='not_persisted' AND $11->'candidate'->>'digest'=$10
  AND $11->'candidate'->'approval'->>'status'='blocked'
  AND $11->'candidate'->'body'->>'sourceCompleteness'='unverified'
  AND $11->'candidate'->'body'->>'storage'='not_persisted'
  AND $11->'candidate'->'body'->>'athleteId'=tenant
  AND $11->'capturedBinding'->>'athleteId'=tenant AND $11->'capturedBinding'->>'readSetDigest'=$9
  AND $11->'capturedBinding'->'event'->>'id'=$4::text AND $11->'capturedBinding'->'event'->>'revision'=$5::text) IS NOT TRUE
 THEN RAISE EXCEPTION 'INVALID_MANUAL_REVIEW'; END IF;
 IF jsonb_typeof($12) IS DISTINCT FROM 'array' OR jsonb_array_length($12) NOT BETWEEN 1 AND 5000 OR octet_length($12::text)>1048576 OR octet_length($11::text)+octet_length($12::text)>4194304 THEN RAISE EXCEPTION 'MANUAL_REVIEW_REF_LIMIT'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements($12))<>(SELECT count(DISTINCT (x->>'kind',x->>'sourceId',x->>'versionKey')) FROM jsonb_array_elements($12) x) THEN RAISE EXCEPTION 'MANUAL_REVIEW_DUPLICATE_REF'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements($12) x WHERE x->>'kind'='race-event' AND x->>'sourceId'=$4::text AND x->>'versionKey'=$5::text) THEN RAISE EXCEPTION 'MANUAL_REVIEW_EVENT_REF_MISSING'; END IF;
 FOR r IN SELECT x FROM jsonb_array_elements($12) x LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['kind','sourceId','versionKey','sourceRowDigest']<>'{}'::jsonb OR NOT(r ?& ARRAY['kind','sourceId','versionKey','sourceRowDigest']) THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_INVALID'; END IF;
  source:=public.manual_review_source_row(r->>'kind',r->>'sourceId',r->>'versionKey');
  IF (r->>'sourceRowDigest') IS DISTINCT FROM encode(sha256(convert_to(source::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'MANUAL_REVIEW_SOURCE_CHANGED'; END IF;
 END LOOP;
 result:=jsonb_build_object('schemaVersion',1,'reviewId',$1,'candidateDigest',$10,'createdAt',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'approvalAllowed',false,'sourceCompleteness','unverified');
 INSERT INTO public.command_receipt VALUES(tenant,$2,jsonb_build_object('schemaVersion',1,'requestDigest',$3),result);
 INSERT INTO public.race_manual_review VALUES(tenant,$1,1,stamp,$4,$5,$6,$7,'manual-race-date-impact',1,$8,$9,$10,encode(sha256(convert_to($11::text,'UTF8')),'hex'),$2,$3,$11,NULL,NULL);
 INSERT INTO public.race_manual_review_source_ref SELECT tenant,$1,x->>'kind',x->>'sourceId',x->>'versionKey',x->>'sourceRowDigest' FROM jsonb_array_elements($12) x;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.store_race_manual_review(uuid,text,text,uuid,integer,integer,uuid,text,text,text,jsonb,jsonb) FROM PUBLIC;

-- Additional owner-only replay ledger, separate from the3 private review tables.
-- Suppression receipts survive account erasure; no health payload or source-domain write.
CREATE TABLE public.restore_manual_review_source_replay_receipt (
 event_id uuid PRIMARY KEY REFERENCES public.restore_suppression_event(event_id),
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
 source_kind text NOT NULL, source_id text NOT NULL, version_scope text NOT NULL, version_key text,
 CHECK(public.manual_review_source_key_valid(source_kind,source_id,version_scope,version_key) IS TRUE)
);
REVOKE ALL ON public.restore_manual_review_source_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_manual_review_source_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_manual_review_source_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_manual_review_source_receipt_owner ON public.restore_manual_review_source_replay_receipt
 USING(session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_manual_review_source_replay_receipt'::regclass)))
 WITH CHECK(session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_manual_review_source_replay_receipt'::regclass)));
CREATE FUNCTION public.verify_manual_review_source_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e WHERE e.event_id=NEW.event_id AND e.record_version=6 AND e.kind='manual_review_source_suppressed'
  AND e.athlete_id=NEW.athlete_id AND e.occurred_at=NEW.occurred_at AND e.manual_review_source_kind=NEW.source_kind AND e.manual_review_source_id=NEW.source_id
  AND e.manual_review_version_scope=NEW.version_scope AND e.manual_review_version_key IS NOT DISTINCT FROM NEW.version_key)
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_RECEIPT_INVALID'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_manual_review_source_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_manual_review_source_receipt_verify BEFORE INSERT ON public.restore_manual_review_source_replay_receipt
 FOR EACH ROW EXECUTE FUNCTION public.verify_manual_review_source_replay_receipt();
CREATE TRIGGER restore_manual_review_source_receipt_immutable BEFORE UPDATE OR DELETE ON public.restore_manual_review_source_replay_receipt
 FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_manual_review_source_receipt_no_truncate BEFORE TRUNCATE ON public.restore_manual_review_source_replay_receipt
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

CREATE FUNCTION public.replay_manual_review_source_suppression_exact(athlete text,event uuid,stamp timestamptz,k text,s text,scope text,v text) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE existing public.restore_suppression_event%ROWTYPE; receipt public.restore_manual_review_source_replay_receipt%ROWTYPE;
 owner_name text:=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.race_manual_review'::regclass)); had_receipt boolean;
BEGIN
 IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF $1 IS NULL OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') OR $2 IS NULL OR $3 IS NULL OR NOT isfinite($3) OR $3>clock_timestamp()
  OR public.manual_review_source_key_valid($4,$5,$6,$7) IS NOT TRUE THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_INVALID'; END IF;
 -- Reject lock inversion: coordinator must assert global CLOSED/exclusive first.
 PERFORM public.assert_manual_review_replay_global_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 IF (SELECT count(*) FROM public.restore_suppression_event e WHERE e.event_id=$2 OR (e.athlete_id=$1 AND e.record_version=6 AND e.kind='manual_review_source_suppressed'
  AND e.manual_review_source_kind=$4 AND e.manual_review_source_id=$5 AND e.manual_review_version_scope=$6 AND e.manual_review_version_key IS NOT DISTINCT FROM $7))>1
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_EVENT_CONFLICT'; END IF;
 SELECT * INTO existing FROM public.restore_suppression_event e WHERE e.event_id=$2 OR (e.athlete_id=$1 AND e.record_version=6 AND e.kind='manual_review_source_suppressed'
  AND e.manual_review_source_kind=$4 AND e.manual_review_source_id=$5 AND e.manual_review_version_scope=$6 AND e.manual_review_version_key IS NOT DISTINCT FROM $7);
 IF FOUND AND (existing.event_id IS DISTINCT FROM $2 OR existing.athlete_id IS DISTINCT FROM $1 OR existing.record_version IS DISTINCT FROM 6
  OR existing.kind IS DISTINCT FROM 'manual_review_source_suppressed' OR existing.occurred_at IS DISTINCT FROM $3
  OR existing.manual_review_source_kind IS DISTINCT FROM $4 OR existing.manual_review_source_id IS DISTINCT FROM $5
  OR existing.manual_review_version_scope IS DISTINCT FROM $6 OR existing.manual_review_version_key IS DISTINCT FROM $7)
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_EVENT_CONFLICT'; END IF;
 SELECT * INTO receipt FROM public.restore_manual_review_source_replay_receipt r WHERE r.event_id=$2;
 had_receipt:=FOUND;
 IF had_receipt AND (existing.event_id IS NULL OR receipt.athlete_id IS DISTINCT FROM $1 OR receipt.occurred_at IS DISTINCT FROM $3
  OR receipt.source_kind IS DISTINCT FROM $4 OR receipt.source_id IS DISTINCT FROM $5 OR receipt.version_scope IS DISTINCT FROM $6 OR receipt.version_key IS DISTINCT FROM $7)
 THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_RECEIPT_CONFLICT'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=$1) THEN
  IF NOT EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r JOIN public.restore_suppression_event e ON e.event_id=r.event_id
   WHERE r.athlete_id=$1 AND r.kind='tenant_erased' AND e.athlete_id=$1 AND e.kind='tenant_erased') THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_TENANT_ERASED'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id::text=$1) THEN RAISE EXCEPTION 'MANUAL_REVIEW_REPLAY_TENANT_UNKNOWN'; END IF;
 IF existing.event_id IS NULL THEN
  INSERT INTO public.restore_suppression_event(event_id,record_version,athlete_id,kind,occurred_at,manual_review_source_kind,manual_review_source_id,manual_review_version_scope,manual_review_version_key)
   VALUES($2,6,$1,'manual_review_source_suppressed',$3,$4,$5,$6,$7);
 END IF;
 -- Even an exact existing success receipt does NOT skip re-suppression: an owner
 -- restore may have loaded matching copies since the first replay. No new event.
 PERFORM public.suppress_manual_reviews_from_event($2);
 IF NOT had_receipt THEN
  INSERT INTO public.restore_manual_review_source_replay_receipt VALUES($2,$1,$3,$4,$5,$6,$7);
 END IF;
 RETURN CASE WHEN had_receipt THEN 'already_applied' ELSE 'applied' END;
END $$;
REVOKE ALL ON FUNCTION public.replay_manual_review_source_suppression_exact(text,uuid,timestamptz,text,text,text,text) FROM PUBLIC;

-- Preserve old99 semantics and validation. For matching copied race reviews only,
-- the original authenticated4 event must exist before its source purge trigger.
-- No GUC/externalflag bypass and no new v6 emission in this owner replay path.
ALTER FUNCTION public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer)
 RENAME TO replay_race_deletion_exact_before_manual_review;
REVOKE ALL ON FUNCTION public.replay_race_deletion_exact_before_manual_review(text,text,uuid,uuid,timestamptz,integer,integer) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid='public.replay_race_deletion_exact_before_manual_review(text,text,uuid,uuid,timestamptz,integer,integer)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.replay_race_deletion_exact_before_manual_review(text,text,uuid,uuid,timestamptz,integer,integer) FROM %I',r); END LOOP;
END $$;
CREATE FUNCTION public.replay_race_deletion_exact(athlete text,kind text,target uuid,event uuid,stamp timestamptz,prior_revision integer,deleted_revision integer) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE existing public.restore_suppression_event%ROWTYPE; result text; owner_name text:=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.race_manual_review'::regclass));
BEGIN
 IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=owner_name AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'RESTORE_RACE_OWNER_REQUIRED'; END IF;
 -- No matching copied reviews: preserve the entire previous historical call path.
 IF $2 IS DISTINCT FROM 'race_event_deleted' OR NOT EXISTS(SELECT 1 FROM public.race_manual_review_source_ref r WHERE r.athlete_id=$1 AND r.source_kind='race-event' AND r.source_id=$3::text) THEN
  RETURN public.replay_race_deletion_exact_before_manual_review($1,$2,$3,$4,$5,$6,$7);
 END IF;
 IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR NOT isfinite($5) OR $5>clock_timestamp()
  OR $6 IS NULL OR $6 NOT BETWEEN 1 AND 2147483647 OR $7 IS NULL OR $7 IS DISTINCT FROM least($6::bigint+1,2147483647)::integer
 THEN RAISE EXCEPTION 'RESTORE_RACE_INVALID_ENTRY'; END IF;
 PERFORM public.assert_manual_review_replay_global_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 IF (SELECT count(*) FROM public.restore_suppression_event e WHERE e.event_id=$4 OR (e.athlete_id=$1 AND e.kind=$2 AND e.target_id=$3))>1
 THEN RAISE EXCEPTION 'RESTORE_RACE_EVENT_CONFLICT'; END IF;
 SELECT * INTO existing FROM public.restore_suppression_event e WHERE e.event_id=$4 OR (e.athlete_id=$1 AND e.kind=$2 AND e.target_id=$3);
 IF FOUND THEN
  IF existing.event_id IS DISTINCT FROM $4 OR existing.record_version IS DISTINCT FROM 4 OR existing.athlete_id IS DISTINCT FROM $1
   OR existing.kind IS DISTINCT FROM $2 OR existing.target_id IS DISTINCT FROM $3 OR existing.occurred_at IS DISTINCT FROM $5
   OR existing.race_previous_revision IS DISTINCT FROM $6 OR existing.race_deleted_revision IS DISTINCT FROM $7
  THEN RAISE EXCEPTION 'RESTORE_RACE_EVENT_CONFLICT'; END IF;
 ELSE
  -- Only supplied ORIGINAL exact event fields; all other old/new columns default NULL.
  -- Previous oldguards/checkconstraints validate this complete4 shape immediately.
  INSERT INTO public.restore_suppression_event(event_id,record_version,athlete_id,kind,target_id,occurred_at,race_previous_revision,race_deleted_revision)
   VALUES($4,4,$1,$2,$3,$5,$6,$7);
 END IF;
 -- Original body still verifies existing exact event/receipt, tenant erasure/account,
 -- source revisions and sideeffects. Any failure rolls back preinsert in SAME statement.
 result:=public.replay_race_deletion_exact_before_manual_review($1,$2,$3,$4,$5,$6,$7);
 PERFORM public.suppress_manual_reviews_from_event($4); -- even already_deleted/receipted.
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer) FROM PUBLIC;

-- Account erasure remains permitted CLOSED/withdrawn; receipts removed by previous104
-- after private review/ref/marker rows. Budget103 durable spend is NOT refunded.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_manual_review;
REVOKE ALL ON FUNCTION public.erase_account_before_manual_review(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid='public.erase_account_before_manual_review(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_manual_review(text) FROM %I',r); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM public.manual_review_owner();
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 DELETE FROM public.race_manual_review_source_suppression WHERE athlete_id=$1;
 DELETE FROM public.race_manual_review_source_ref WHERE athlete_id=$1;
 DELETE FROM public.race_manual_review WHERE athlete_id=$1;
 RETURN public.erase_account_before_manual_review($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
-- Root grant helper: SELECT on these3 private tables, EXECUTE store function ONLY.
-- No INSERT/UPDATE/DELETE/TRUNCATE, no helper/purge/admission-open EXECUTE grants.
-- Root grantOperations must regrant only NEW erase_account, not renamed prior body.
