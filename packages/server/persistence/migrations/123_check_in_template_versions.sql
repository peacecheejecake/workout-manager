-- Explicit raw staging; normal registry107 is not changed by this file.
-- Templates define reusable user self-report prompts. They do not create a
-- dated CheckIn, observation, approval, physiological evidence or RoutineRun.
CREATE SCHEMA wm_check_in_templates_v1;
REVOKE ALL ON SCHEMA wm_check_in_templates_v1 FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
 THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_PLAIN_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION wm_check_in_templates_v1.utf16_length(value text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(sum(CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END),0)::integer
 FROM regexp_split_to_table(value,'') c
$$;
CREATE FUNCTION wm_check_in_templates_v1.trimmed(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
 SELECT value=btrim(value,E'\t\n\v\f\r '||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
$$;
CREATE FUNCTION wm_check_in_templates_v1.content_valid(content jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE keys text[]; field jsonb; seen text[]:='{}'; BEGIN
 IF content IS NULL OR jsonb_typeof(content) IS DISTINCT FROM 'object' OR octet_length(content::text)>16384 THEN RETURN false; END IF;
 SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(content) key;
 IF keys IS DISTINCT FROM ARRAY['definitionVersion','fields','instructions','method','source','title']
  OR content->>'definitionVersion' IS DISTINCT FROM 'checkin-v1'
  OR content->>'source' IS DISTINCT FROM 'user' OR content->>'method' IS DISTINCT FROM 'self_report'
  OR jsonb_typeof(content->'title') IS DISTINCT FROM 'string'
  OR wm_check_in_templates_v1.utf16_length(content->>'title') NOT BETWEEN 1 AND 200
  OR NOT wm_check_in_templates_v1.trimmed(content->>'title')
  OR jsonb_typeof(content->'fields') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF content->'instructions'<>'null'::jsonb THEN
  IF jsonb_typeof(content->'instructions') IS DISTINCT FROM 'string'
   OR wm_check_in_templates_v1.utf16_length(content->>'instructions') NOT BETWEEN 1 AND 2000
   OR NOT wm_check_in_templates_v1.trimmed(content->>'instructions') THEN RETURN false; END IF;
 END IF;
 IF jsonb_array_length(content->'fields') NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
 FOR field IN SELECT value FROM jsonb_array_elements(content->'fields') LOOP
  IF jsonb_typeof(field) IS DISTINCT FROM 'string' OR (field#>>'{}') NOT IN ('fatigue','discomfort','bodyLocation','note')
   OR (field#>>'{}')=ANY(seen) THEN RETURN false; END IF;
  seen:=array_append(seen,field#>>'{}');
 END LOOP;
 RETURN true;
END $$;

CREATE TABLE public.check_in_template_version (
 athlete_id text NOT NULL,template_id uuid NOT NULL,version_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483646),
 previous_version_id uuid,previous_version integer,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 record_json jsonb NOT NULL CHECK(octet_length(record_json::text)<=16384),
 PRIMARY KEY(athlete_id,template_id,version_id),UNIQUE(athlete_id,template_id,version),UNIQUE(athlete_id,version_id),
 CHECK((version=1 AND previous_version_id IS NULL AND previous_version IS NULL)
  OR (version>1 AND previous_version=version-1 AND previous_version_id IS NOT NULL AND previous_version_id<>version_id)),
 UNIQUE(athlete_id,template_id,version_id,version),
 FOREIGN KEY(athlete_id,template_id,previous_version_id,previous_version)
  REFERENCES public.check_in_template_version(athlete_id,template_id,version_id,version) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.check_in_template_head (
 athlete_id text NOT NULL,template_id uuid NOT NULL,version_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483646),
 PRIMARY KEY(athlete_id,template_id),
 FOREIGN KEY(athlete_id,template_id,version_id,version)
 REFERENCES public.check_in_template_version(athlete_id,template_id,version_id,version) DEFERRABLE INITIALLY DEFERRED
);
-- Minimal immutable receipt. Content is stored once, in the original version;
-- replay joins that exact immutable row, never the current head.
CREATE TABLE public.check_in_template_receipt (
 athlete_id text NOT NULL,idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128 AND idempotency_key~'^[A-Za-z0-9_-]+$'),
 request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
 template_id uuid NOT NULL,version_id uuid NOT NULL,
 PRIMARY KEY(athlete_id,idempotency_key),UNIQUE(athlete_id,version_id),
 FOREIGN KEY(athlete_id,template_id,version_id)
 REFERENCES public.check_in_template_version(athlete_id,template_id,version_id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['check_in_template_version','check_in_template_head','check_in_template_receipt'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON public.%I USING(athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK(athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',t);
 END LOOP;
END $$;
CREATE FUNCTION wm_check_in_templates_v1.caller() RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); r record; owner name; BEGIN
 SELECT pg_get_userbyid(relowner) INTO STRICT owner FROM pg_class WHERE oid='public.check_in_template_version'::regclass;
 SELECT rolsuper,rolbypassrls INTO STRICT r FROM pg_roles WHERE rolname=session_user;
 IF session_user=current_user OR r.rolsuper OR r.rolbypassrls OR pg_has_role(session_user,owner,'MEMBER')
  OR current_user<>owner OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR current_setting('role') NOT IN ('none',session_user)
  OR EXISTS(SELECT 1 FROM pg_class WHERE relkind IN ('r','p') AND relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user))
  OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.check_in_template_head'::regclass,'public.check_in_template_receipt'::regclass) AND pg_get_userbyid(relowner)<>owner)
 THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF t IS NULL OR NOT EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id::text=t)
  OR EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=t) THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_TENANT_UNAVAILABLE'; END IF;
 RETURN t;
END $$;
CREATE FUNCTION wm_check_in_templates_v1.command(command jsonb,server_fields boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE keys text[]; expected text[]; id_pattern constant text:='^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'; BEGIN
 IF command IS NULL OR jsonb_typeof(command) IS DISTINCT FROM 'object' OR octet_length(command::text)>16384 THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_INPUT'; END IF;
 expected:=CASE WHEN server_fields THEN ARRAY['content','createdAt','expectedVersion','idempotencyKey','templateId','versionId'] ELSE ARRAY['content','expectedVersion','idempotencyKey','templateId'] END;
 SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(command) key;
 IF keys IS DISTINCT FROM expected OR jsonb_typeof(command->'idempotencyKey') IS DISTINCT FROM 'string'
  OR length(command->>'idempotencyKey') NOT BETWEEN 8 AND 128 OR command->>'idempotencyKey'!~'^[A-Za-z0-9_-]+$'
  OR jsonb_typeof(command->'templateId') IS DISTINCT FROM 'string' OR lower(command->>'templateId')!~id_pattern
  OR jsonb_typeof(command->'expectedVersion') IS DISTINCT FROM 'number'
  OR (command->>'expectedVersion')::numeric<>trunc((command->>'expectedVersion')::numeric)
  OR (command->>'expectedVersion')::numeric NOT BETWEEN 0 AND 2147483645
  OR NOT wm_check_in_templates_v1.content_valid(command->'content')
 THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_INPUT'; END IF;
 command:=jsonb_set(command,ARRAY['templateId'],to_jsonb(lower(command->>'templateId')));
 IF server_fields THEN
  IF jsonb_typeof(command->'versionId') IS DISTINCT FROM 'string' OR lower(command->>'versionId')!~id_pattern
   OR jsonb_typeof(command->'createdAt') IS DISTINCT FROM 'string' OR length(command->>'createdAt')>40
   OR command->>'createdAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_INPUT'; END IF;
  command:=jsonb_set(command,ARRAY['versionId'],to_jsonb(lower(command->>'versionId')));
 END IF;
 RETURN command;
END $$;


-- No broad runtime DML grant is needed. Immutable version/receipt rows can
-- change only through this fixed definer protocol; deletion requires the
-- genuine tenant erasure row and the original event already emitted by it.
CREATE FUNCTION wm_check_in_templates_v1.erasure_matches(tenant text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.tenant_erasure t
 JOIN public.restore_suppression_event e ON e.athlete_id=t.athlete_id
  AND e.kind='tenant_erased' AND e.occurred_at=t.erased_at
 WHERE t.athlete_id=$1)
$$;
CREATE FUNCTION wm_check_in_templates_v1.guard_rows() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text; keys text[]; body jsonb; prior public.check_in_template_head; BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
   OR NOT wm_check_in_templates_v1.erasure_matches(OLD.athlete_id)
  THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_IMMUTABLE'; END IF;
  RETURN OLD;
 END IF;
 t:=wm_check_in_templates_v1.caller();
 IF NEW.athlete_id IS DISTINCT FROM t THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_TENANT_UNAVAILABLE'; END IF;
 IF TG_TABLE_NAME IN ('check_in_template_version','check_in_template_receipt') AND TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_IMMUTABLE'; END IF;
 PERFORM public.require_app_admission_revision(NULL);
 IF TG_TABLE_NAME='check_in_template_version' THEN
  body:=NEW.record_json;
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_RECORD'; END IF;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(body) key;
  IF keys IS DISTINCT FROM ARRAY['content','createdAt','previousVersion','previousVersionId','templateId','version','versionId']
   OR body->'templateId' IS DISTINCT FROM to_jsonb(NEW.template_id::text)
   OR body->'versionId' IS DISTINCT FROM to_jsonb(NEW.version_id::text)
   OR body->'version' IS DISTINCT FROM to_jsonb(NEW.version)
   OR body->'previousVersionId' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_version_id::text),'null'::jsonb)
   OR body->'previousVersion' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_version),'null'::jsonb)
   OR jsonb_typeof(body->'createdAt') IS DISTINCT FROM 'string'
   OR body->>'createdAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
   OR (body->>'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at
   OR NOT wm_check_in_templates_v1.content_valid(body->'content')
  THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_RECORD'; END IF;
  SELECT * INTO prior FROM public.check_in_template_head h WHERE h.athlete_id=t AND h.template_id=NEW.template_id;
  IF (NEW.version=1 AND FOUND) OR (NEW.version>1 AND (NOT FOUND OR prior.version_id IS DISTINCT FROM NEW.previous_version_id OR prior.version IS DISTINCT FROM NEW.previous_version))
  THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_STALE_VERSION'; END IF;
 ELSIF TG_TABLE_NAME='check_in_template_head' THEN
  IF TG_OP='INSERT' THEN
   SELECT * INTO prior FROM public.check_in_template_head h WHERE h.athlete_id=t AND h.template_id=NEW.template_id;
   IF (NOT FOUND AND NEW.version<>1) OR (FOUND AND NEW.version<>prior.version+1)
   THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_STALE_VERSION'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.athlete_id IS DISTINCT FROM OLD.athlete_id OR NEW.template_id IS DISTINCT FROM OLD.template_id
   OR NEW.version<>OLD.version+1 OR NEW.version_id=OLD.version_id)
  THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_STALE_VERSION'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.check_in_template_version v WHERE v.athlete_id=t AND v.template_id=NEW.template_id AND v.version_id=NEW.version_id AND v.version=NEW.version
   AND (TG_OP='INSERT' OR (v.previous_version_id=OLD.version_id AND v.previous_version=OLD.version)))
  THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_RECORD'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.check_in_template_head h WHERE h.athlete_id=t AND h.template_id=NEW.template_id AND h.version_id=NEW.version_id)
  THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_RECORD'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['check_in_template_version','check_in_template_head','check_in_template_receipt'] LOOP
  EXECUTE format('CREATE TRIGGER check_in_template_rows BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION wm_check_in_templates_v1.guard_rows()',t);
  EXECUTE format('CREATE TRIGGER check_in_template_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION public.save_check_in_template_v1(command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE t text; c jsonb; request jsonb; request_digest bytea; receipt public.check_in_template_receipt; head public.check_in_template_head;
 id uuid; v_id uuid; expected integer; stamp timestamptz; result jsonb; next_version integer; BEGIN
 t:=wm_check_in_templates_v1.caller();c:=wm_check_in_templates_v1.command($1,true);
 -- RC is required so the statement after a contested lock sees the committed
 -- head/consent. RR/serializable snapshots are not silently weakened or reset.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_WRITE_ISOLATION_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(t,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(t,0));
 -- Recheck tenant after the fence; an account erase that won cannot reenter.
 t:=wm_check_in_templates_v1.caller();
 request:=c-ARRAY['versionId','createdAt'];request_digest:=sha256(convert_to(request::text,'UTF8'));
 SELECT * INTO receipt FROM public.check_in_template_receipt r WHERE r.athlete_id=t AND r.idempotency_key=c->>'idempotencyKey';
 IF FOUND THEN
  IF receipt.request_digest<>request_digest THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_IDEMPOTENCY_CONFLICT'; END IF;
  SELECT record_json INTO STRICT result FROM public.check_in_template_version v WHERE v.athlete_id=t AND v.template_id=receipt.template_id AND v.version_id=receipt.version_id;
  RETURN result;
 END IF;
 PERFORM public.require_app_admission_revision(NULL);
 id:=(c->>'templateId')::uuid;v_id:=(c->>'versionId')::uuid;expected:=(c->>'expectedVersion')::integer;stamp:=(c->>'createdAt')::timestamptz;
 IF NOT isfinite(stamp) THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_TIME'; END IF;
 SELECT * INTO head FROM public.check_in_template_head h WHERE h.athlete_id=t AND h.template_id=id FOR UPDATE;
 IF (NOT FOUND AND expected<>0) OR (FOUND AND head.version<>expected) THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_STALE_VERSION'; END IF;
 IF EXISTS(SELECT 1 FROM public.check_in_template_version v WHERE v.athlete_id=t AND v.version_id=v_id) THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_VERSION_CONFLICT'; END IF;
 next_version:=expected+1;
 result:=jsonb_build_object('templateId',id::text,'versionId',v_id::text,'version',next_version,'previousVersionId',head.version_id,'previousVersion',CASE WHEN expected=0 THEN NULL ELSE expected END,'createdAt',c->>'createdAt','content',c->'content');
 INSERT INTO public.check_in_template_version VALUES(t,id,v_id,next_version,head.version_id,CASE WHEN expected=0 THEN NULL ELSE expected END,stamp,result);
 INSERT INTO public.check_in_template_head VALUES(t,id,v_id,next_version) ON CONFLICT(athlete_id,template_id) DO UPDATE SET version_id=EXCLUDED.version_id,version=EXCLUDED.version;
 INSERT INTO public.check_in_template_receipt VALUES(t,c->>'idempotencyKey',request_digest,id,v_id);
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload,created_at,available_at)
 VALUES(t,gen_random_uuid(),'checkin-template:'||v_id::text,'checkin-template.changed',jsonb_build_object('templateId',id::text,'versionId',v_id::text,'version',next_version),stamp,stamp);
 RETURN result;
END $$;

CREATE FUNCTION public.read_check_in_template_version_v1(template uuid,version uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text; result jsonb; BEGIN
 t:=wm_check_in_templates_v1.caller();
 IF $1 IS NULL OR $2 IS NULL THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_INPUT'; END IF;
 SELECT v.record_json INTO result FROM public.check_in_template_version v WHERE v.athlete_id=t AND v.template_id=$1 AND v.version_id=$2;
 RETURN result;
END $$;
CREATE FUNCTION public.read_check_in_template_head_v1(template uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text; result jsonb; BEGIN
 t:=wm_check_in_templates_v1.caller();IF $1 IS NULL THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_INPUT'; END IF;
 SELECT v.record_json INTO result FROM public.check_in_template_head h JOIN public.check_in_template_version v ON v.athlete_id=h.athlete_id AND v.template_id=h.template_id AND v.version_id=h.version_id AND v.version=h.version WHERE h.athlete_id=t AND h.template_id=$1;
 RETURN result;
END $$;
CREATE FUNCTION public.list_check_in_template_heads_v1(page_limit integer,page_offset integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text; result jsonb; BEGIN
 t:=wm_check_in_templates_v1.caller();IF $1 IS NULL OR $2 IS NULL OR $1 NOT BETWEEN 1 AND 100 OR $2 NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_INVALID_INPUT'; END IF;
 SELECT coalesce(jsonb_agg(s.record_json ORDER BY s.template_id),'[]'::jsonb) INTO result FROM (
  SELECT h.template_id,v.record_json FROM public.check_in_template_head h JOIN public.check_in_template_version v ON v.athlete_id=h.athlete_id AND v.template_id=h.template_id AND v.version_id=h.version_id AND v.version=h.version WHERE h.athlete_id=t ORDER BY h.template_id LIMIT $1 OFFSET $2
 ) s;
 RETURN result;
END $$;
-- Deferred cleanup runs after the established source-event trigger has emitted
-- its genuine tenant_erased original, including authenticated existing replay
-- branches. No original is inserted/replaced here and no caller GUC authorizes
-- deletion. The existing protected tenant_erasure transition is the producer.
CREATE FUNCTION wm_check_in_templates_v1.erase_templates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner name; BEGIN
 SELECT pg_get_userbyid(relowner) INTO STRICT owner FROM pg_class WHERE oid='public.check_in_template_version'::regclass;
 IF current_user<>owner OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  OR NOT EXISTS(SELECT 1 FROM public.tenant_erasure t JOIN public.restore_suppression_event e
   ON e.athlete_id=t.athlete_id AND e.kind='tenant_erased' AND e.occurred_at=t.erased_at
   WHERE t.athlete_id=NEW.athlete_id AND t.erased_at=NEW.erased_at)
 THEN RAISE EXCEPTION 'CHECKIN_TEMPLATE_ERASURE_ORIGINAL_REQUIRED' USING ERRCODE='42501'; END IF;
 DELETE FROM public.check_in_template_receipt WHERE athlete_id=NEW.athlete_id;
 DELETE FROM public.check_in_template_head WHERE athlete_id=NEW.athlete_id;
 DELETE FROM public.check_in_template_version WHERE athlete_id=NEW.athlete_id;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER zzz_check_in_template_erasure
 AFTER INSERT ON public.tenant_erasure DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION wm_check_in_templates_v1.erase_templates();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wm_check_in_templates_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_check_in_template_v1(jsonb),public.read_check_in_template_version_v1(uuid,uuid),public.read_check_in_template_head_v1(uuid),public.list_check_in_template_heads_v1(integer,integer) FROM PUBLIC;
