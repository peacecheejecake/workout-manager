-- Explicit V2 proof storage lifecycle. Registration/grants/export/restore profiles are root-owned.
-- No source URL fetch, authenticity review, new actual revision or approval is performed.
CREATE TABLE public.race_result_proof_ref (
 athlete_id text NOT NULL, result_id uuid NOT NULL, result_revision integer NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 3),
 source_kind text NOT NULL CHECK(source_kind IN ('gallery-image','resource-pdf')),
 source_id uuid NOT NULL, version_id uuid, access_revision integer,
 PRIMARY KEY(athlete_id,result_id,result_revision,ordinal),
 UNIQUE(athlete_id,result_id,result_revision,source_kind,source_id),
 FOREIGN KEY(athlete_id,result_id,result_revision)
  REFERENCES public.race_result_revision(athlete_id,entity_id,revision) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED,
 CHECK((source_kind='gallery-image' AND version_id IS NULL)
    OR (source_kind='resource-pdf' AND version_id IS NOT NULL)),
 CHECK(access_revision IS NULL OR access_revision BETWEEN 1 AND 2147483647)
);
REVOKE ALL ON public.race_result_proof_ref FROM PUBLIC;
ALTER TABLE public.race_result_proof_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.race_result_proof_ref FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.race_result_proof_ref
 USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
CREATE INDEX race_result_proof_reverse ON public.race_result_proof_ref(athlete_id,source_kind,source_id,result_id,result_revision);

-- Only exact old media deletion events participate; manual-review event6 is not proof authority.
-- A bare deleted flag, caller GUC or owner identity without the source event is insufficient.
CREATE FUNCTION public.race_proof_source_removed(t text,k text,s uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.restore_suppression_event e
  WHERE e.athlete_id=t AND e.target_id=s AND e.record_version IN (1,2,3,4,5) AND (
   (k='gallery-image' AND e.kind='gallery_media_deleted' AND EXISTS(
    SELECT 1 FROM public.gallery_media_item g WHERE g.athlete_id=t AND g.id=s
     AND g.deleted_at=e.occurred_at AND g.access_revision=e.gallery_access_revision))
   OR (k='resource-pdf' AND e.kind='resource_deleted' AND EXISTS(
    SELECT 1 FROM public.resource r WHERE r.athlete_id=t AND r.id=s
     AND r.deleted_at=e.occurred_at AND r.access_revision=e.resource_access_revision))
   OR (k='gallery-image' AND e.kind='gallery_media_deleted'
    AND NOT EXISTS(SELECT 1 FROM public.gallery_media_item g WHERE g.athlete_id=t AND g.id=s)
    AND EXISTS(SELECT 1 FROM public.restore_gallery_media_replay_receipt r
     WHERE r.event_id=e.event_id AND r.athlete_id=t AND r.target_id=s
      AND r.occurred_at=e.occurred_at AND r.gallery_access_revision=e.gallery_access_revision))
   OR (k='resource-pdf' AND e.kind='resource_deleted'
    AND NOT EXISTS(SELECT 1 FROM public.resource r WHERE r.athlete_id=t AND r.id=s)
    AND EXISTS(SELECT 1 FROM public.restore_resource_replay_receipt r
     WHERE r.event_id=e.event_id AND r.athlete_id=t AND r.target_id=s
      AND r.occurred_at=e.occurred_at AND r.resource_access_revision=e.resource_access_revision))
  ));
$$;
REVOKE ALL ON FUNCTION public.race_proof_source_removed(text,text,uuid) FROM PUBLIC;

CREATE FUNCTION public.race_result_proof_redacted(t text,b jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN b->'schemaVersion'='2'::jsonb THEN jsonb_set(b,'{proofs,attachments}',
  coalesce((SELECT jsonb_agg(CASE WHEN public.race_proof_source_removed(t,a->>'kind',
   CASE WHEN a->>'kind'='gallery-image' THEN (a->>'mediaItemId')::uuid ELSE (a->>'resourceId')::uuid END)
   THEN (a-ARRAY['accessRevision','mediaType','byteSize','sha256','contentHash'])||'{"status":"unavailable"}'::jsonb
   ELSE a END ORDER BY n) FROM jsonb_array_elements(b->'proofs'->'attachments') WITH ORDINALITY x(a,n)),
  '[]'::jsonb),false) ELSE b END;
$$;
REVOKE ALL ON FUNCTION public.race_result_proof_redacted(text,jsonb) FROM PUBLIC;

-- Storage values exclude relational id/revision; consumers must reconstruct the exact historical tuple.
-- Runtime Zod remains the complete public DTO boundary. This SQL guard additionally
-- prevents direct descriptor forgery, unknown proof keys and unavailable initial writes.
CREATE FUNCTION public.assert_race_result_proofs(t text,b jsonb,initial boolean,allow_redacted boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE a jsonb; s uuid; v uuid; k text; expected jsonb; seen text[]:='{}'; key text; n text;
BEGIN
 IF NOT b ? 'schemaVersion' THEN
  IF b ? 'proofs' THEN RAISE EXCEPTION 'RACE_PROOF_VERSION_REQUIRED'; END IF;
  RETURN;
 END IF;
 IF b->'schemaVersion'<>'2'::jsonb OR jsonb_typeof(b) IS DISTINCT FROM 'object'
  OR octet_length(b::text)>16384
  OR NOT b ?& ARRAY['schemaVersion','kind','raceEventId','localDate','timezone','source','chipSeconds','gunSeconds','officialDistanceMeters','deviceDistanceMeters','linkedActivityId','weatherNote','proofs']
  OR b-ARRAY['schemaVersion','kind','raceEventId','localDate','timezone','source','chipSeconds','gunSeconds','officialDistanceMeters','deviceDistanceMeters','linkedActivityId','weatherNote','proofs']<>'{}'::jsonb
  OR b->>'kind' IS DISTINCT FROM 'race-result'
  OR jsonb_typeof(b->'proofs') IS DISTINCT FROM 'object'
  OR NOT (b->'proofs') ?& ARRAY['link','attachments']
  OR (b->'proofs')-ARRAY['link','attachments']<>'{}'::jsonb
  OR jsonb_typeof(b->'proofs'->'attachments') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'RACE_PROOF_BODY_INVALID'; END IF;
 IF jsonb_array_length(b->'proofs'->'attachments')>4 THEN RAISE EXCEPTION 'RACE_PROOF_LIMIT'; END IF;
 IF b->'proofs'->'link'<>'null'::jsonb AND (jsonb_typeof(b->'proofs'->'link')<>'string'
  OR length(b->'proofs'->>'link')>2048 OR (b->'proofs'->>'link') !~ '^https://[^/@[:space:]]+([/:?#]|$)'
  OR substring(b->'proofs'->>'link' from '^https://([^/?#]*)') ~ '@'
  OR (b->'proofs'->>'link')<>btrim(b->'proofs'->>'link'))
 THEN RAISE EXCEPTION 'RACE_PROOF_LINK_INVALID'; END IF;
 IF jsonb_typeof(b->'source') IS DISTINCT FROM 'object' OR coalesce(b->'source'->>'kind','') NOT IN ('manual','device','official') OR NOT (
  b->'source'='{"kind":"manual"}'::jsonb
  OR (b->'source'->>'kind'='device' AND b->'source' ? 'providerLabel'
   AND (b->'source')-ARRAY['kind','providerLabel']='{}'::jsonb AND jsonb_typeof(b->'source'->'providerLabel')='string')
  OR (b->'source'->>'kind'='official' AND b->'source' ?& ARRAY['authority','resultUrl']
   AND (b->'source')-ARRAY['kind','authority','resultUrl']='{}'::jsonb
   AND jsonb_typeof(b->'source'->'authority')='string' AND jsonb_typeof(b->'source'->'resultUrl')='string'))
 THEN RAISE EXCEPTION 'RACE_PROOF_SOURCE_INVALID'; END IF;
 FOR n IN SELECT unnest(ARRAY['chipSeconds','gunSeconds','officialDistanceMeters','deviceDistanceMeters']) LOOP
  IF b->n<>'null'::jsonb AND (jsonb_typeof(b->n)<>'number' OR (b->>n)::numeric<0
   OR (n IN ('chipSeconds','gunSeconds') AND (b->>n)::numeric>604800)
   OR (n IN ('officialDistanceMeters','deviceDistanceMeters') AND ((b->>n)::numeric=0 OR (b->>n)::numeric>10000000)))
  THEN RAISE EXCEPTION 'RACE_PROOF_ACTUAL_INVALID'; END IF;
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(b->'proofs'->'attachments') LOOP
  k:=a->>'kind';
  IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR coalesce(k,'') NOT IN ('gallery-image','resource-pdf')
   THEN RAISE EXCEPTION 'RACE_PROOF_REF_INVALID'; END IF;
  key:=CASE k WHEN 'gallery-image' THEN a->>'mediaItemId' ELSE a->>'resourceId' END;
  IF key IS NULL OR key !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR k||':'||key=ANY(seen) THEN RAISE EXCEPTION 'RACE_PROOF_REF_INVALID'; END IF;
  seen:=array_append(seen,k||':'||key); s:=key::uuid; v:=NULL;
  IF k='resource-pdf' THEN
   IF coalesce(a->>'versionId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    THEN RAISE EXCEPTION 'RACE_PROOF_VERSION_INVALID'; END IF;
   v:=(a->>'versionId')::uuid;
  END IF;
  IF a ? 'status' THEN
   IF NOT allow_redacted OR a->>'status'<>'unavailable'
    OR a-(CASE k WHEN 'gallery-image' THEN ARRAY['kind','mediaItemId','status'] ELSE ARRAY['kind','resourceId','versionId','status'] END)<>'{}'::jsonb
    OR NOT public.race_proof_source_removed(t,k,s)
   THEN RAISE EXCEPTION 'RACE_PROOF_REDACTION_AUTHORITY_REQUIRED'; END IF;
   CONTINUE;
  END IF;
  IF k='gallery-image' THEN
   SELECT jsonb_build_object('kind',k,'mediaItemId',g.id,'accessRevision',g.access_revision,
    'mediaType',g.media_type,'byteSize',g.size_bytes,'sha256',g.content_hash) INTO expected
    FROM public.gallery_media_item g JOIN public.gallery_media_object o
     ON o.athlete_id=g.athlete_id AND o.storage_ref=g.storage_ref
    WHERE g.athlete_id=t AND g.id=s AND g.deleted_at IS NULL
     AND g.media_kind='image' AND g.visibility='private' AND g.size_bytes<=15728640
     AND o.content_hash=g.content_hash AND o.media_type=g.media_type AND o.size_bytes=g.size_bytes
     AND NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e WHERE e.athlete_id=t
      AND e.kind='gallery_media_deleted' AND e.target_id=s) FOR SHARE OF g;
  ELSE
   SELECT jsonb_build_object('kind',k,'resourceId',r.id,'versionId',rv.version_id,'accessRevision',r.access_revision,
    'mediaType',rv.media_type,'byteSize',rv.size_bytes,'contentHash',rv.content_hash) INTO expected
    FROM public.resource r JOIN public.resource_version rv ON rv.athlete_id=r.athlete_id AND rv.resource_id=r.id
    JOIN public.resource_object o ON o.athlete_id=rv.athlete_id AND o.storage_ref=rv.storage_ref
    WHERE r.athlete_id=t AND r.id=s AND rv.version_id=v AND r.deleted_at IS NULL
     AND rv.media_type='application/pdf' AND rv.size_bytes BETWEEN 1 AND 10485760
     AND o.media_type=rv.media_type AND o.size_bytes=rv.size_bytes AND o.content_hash=rv.content_hash
     AND r.source_kind='file' AND rv.content_status='raw_stored' AND rv.content IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e WHERE e.athlete_id=t
      AND e.kind='resource_deleted' AND e.target_id=s)
    FOR SHARE OF r;
  END IF;
  IF expected IS NULL OR (initial AND a IS DISTINCT FROM expected)
   OR (NOT initial AND ((a-'accessRevision') IS DISTINCT FROM (expected-'accessRevision')
    OR jsonb_typeof(a->'accessRevision')<>'number' OR (a->>'accessRevision')::numeric<1
    OR (a->>'accessRevision')::numeric> (expected->>'accessRevision')::numeric
    OR (a->>'accessRevision')::numeric<>trunc((a->>'accessRevision')::numeric)))
  THEN RAISE EXCEPTION 'RACE_PROOF_DESCRIPTOR_NOT_OWNED'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.assert_race_result_proofs(text,jsonb,boolean,boolean) FROM PUBLIC;

CREATE FUNCTION public.assert_race_proof_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.race_result'::regclass,'public.race_result_revision'::regclass,
  'public.race_result_proof_ref'::regclass,'public.gallery_media_item'::regclass,'public.resource'::regclass,
  'public.restore_suppression_event'::regclass) AND pg_get_userbyid(relowner)<>current_user)
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='public.restore_suppression_event'::regclass
   AND p.polname='restore_suppression_event_definer'
   AND (SELECT oid FROM pg_roles WHERE rolname=current_user)=ANY(p.polroles)
   AND pg_get_expr(p.polqual,p.polrelid)='true')
 THEN RAISE EXCEPTION 'RACE_PROOF_PLAIN_COMMON_OWNER_REQUIRED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_race_proof_owner() FROM PUBLIC;

-- A privacy clone may retain frozen descriptors, but cannot introduce a new proof.
-- The final authenticated deletion event/audit is checked at COMMIT below: old
-- source handlers emit those facts after updating the dependent race head/history.
CREATE FUNCTION public.race_result_proof_source_clone(t text,old_body jsonb,new_body jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT old_body->'schemaVersion'='2'::jsonb
  AND (
   (old_body->'source'->>'kind' IN ('manual','official') AND new_body=jsonb_set(old_body,'{linkedActivityId}','null'::jsonb,false)
    AND old_body->>'linkedActivityId' IS NOT NULL AND EXISTS(
     SELECT 1 FROM public.activity_canonical c WHERE c.athlete_id=t
      AND c.id::text=old_body->>'linkedActivityId' AND c.deleted))
   OR (new_body=jsonb_set(old_body,'{raceEventId}','null'::jsonb,false)
    AND old_body->>'raceEventId' IS NOT NULL AND EXISTS(
     SELECT 1 FROM public.race_event e WHERE e.athlete_id=t
      AND e.id::text=old_body->>'raceEventId' AND e.deleted)));
$$;
REVOKE ALL ON FUNCTION public.race_result_proof_source_clone(text,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.guard_race_result_proof_body() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE is_redaction boolean:=false; is_clone boolean:=false; is_history_copy boolean:=false;
BEGIN
 PERFORM public.assert_race_proof_owner();
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RACE_PROOF_TENANT_MISMATCH'; END IF;
 IF NEW.values_json IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.athlete_id,0));
 IF TG_OP='UPDATE' THEN
  is_redaction:=NEW.values_json IS NOT DISTINCT FROM public.race_result_proof_redacted(NEW.athlete_id,OLD.values_json)
   AND NEW.values_json IS DISTINCT FROM OLD.values_json
   AND (to_jsonb(NEW)-'values_json') IS NOT DISTINCT FROM (to_jsonb(OLD)-'values_json');
  IF TG_TABLE_NAME='race_result' THEN
   is_clone:=public.race_result_proof_source_clone(NEW.athlete_id,OLD.values_json,NEW.values_json)
    AND NEW.revision=least(OLD.revision::bigint+1,2147483647)::integer
    AND NEW.updated_at>=greatest(OLD.updated_at,OLD.recorded_at)
    AND (to_jsonb(NEW)-ARRAY['values_json','revision','updated_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['values_json','revision','updated_at']);
  END IF;
 END IF;
 IF TG_TABLE_NAME='race_result_revision' AND TG_OP='INSERT' THEN
  -- This exact tuple already passed the head guard; it is not an initial descriptor.
  SELECT EXISTS(SELECT 1 FROM public.race_result h WHERE h.athlete_id=NEW.athlete_id
   AND h.id=NEW.entity_id AND h.revision=NEW.revision AND NOT h.deleted
   AND h.values_json=NEW.values_json) INTO is_history_copy;
 END IF;
 PERFORM public.assert_race_result_proofs(NEW.athlete_id,NEW.values_json,
  NOT (is_redaction OR is_clone OR is_history_copy),
  is_redaction OR is_clone OR is_history_copy);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_race_result_proof_body() FROM PUBLIC;
CREATE TRIGGER race_result_proof_body BEFORE INSERT OR UPDATE OF values_json ON public.race_result
 FOR EACH ROW EXECUTE FUNCTION public.guard_race_result_proof_body();
CREATE TRIGGER race_result_revision_proof_body BEFORE INSERT OR UPDATE OF values_json ON public.race_result_revision
 FOR EACH ROW EXECUTE FUNCTION public.guard_race_result_proof_body();

-- Only this ledger's history update exception changes; other history guards retain their original bodies.
CREATE FUNCTION public.guard_race_result_proof_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  THEN RAISE EXCEPTION 'IMMUTABLE_RACE_HISTORY'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF OLD.values_json->'schemaVersion' IS DISTINCT FROM '2'::jsonb THEN RAISE EXCEPTION 'IMMUTABLE_RACE_HISTORY'; END IF;
 IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  OR (to_jsonb(NEW)-'values_json') IS DISTINCT FROM (to_jsonb(OLD)-'values_json')
  OR NEW.values_json IS NOT DISTINCT FROM OLD.values_json
  OR NEW.values_json IS DISTINCT FROM public.race_result_proof_redacted(OLD.athlete_id,OLD.values_json)
 THEN RAISE EXCEPTION 'RACE_PROOF_HISTORY_REDACTION_NOT_EXACT'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_race_result_proof_history() FROM PUBLIC;
DROP TRIGGER race_history_append_only ON public.race_result_revision;
CREATE TRIGGER race_history_append_only BEFORE UPDATE OR DELETE ON public.race_result_revision
 FOR EACH ROW EXECUTE FUNCTION public.guard_race_result_proof_history();

CREATE FUNCTION public.sync_race_result_proof_refs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM public.assert_race_proof_owner();
 DELETE FROM public.race_result_proof_ref WHERE athlete_id=NEW.athlete_id AND result_id=NEW.entity_id AND result_revision=NEW.revision;
 IF NEW.values_json->'schemaVersion'='2'::jsonb THEN
  INSERT INTO public.race_result_proof_ref(athlete_id,result_id,result_revision,ordinal,source_kind,source_id,version_id,access_revision)
   SELECT NEW.athlete_id,NEW.entity_id,NEW.revision,(n-1)::integer,a->>'kind',
    CASE WHEN a->>'kind'='gallery-image' THEN (a->>'mediaItemId')::uuid ELSE (a->>'resourceId')::uuid END,
    CASE WHEN a->>'kind'='resource-pdf' THEN (a->>'versionId')::uuid ELSE NULL END,
    CASE WHEN a->>'status'='unavailable' THEN NULL ELSE (a->>'accessRevision')::integer END
   FROM jsonb_array_elements(NEW.values_json->'proofs'->'attachments') WITH ORDINALITY x(a,n);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.sync_race_result_proof_refs() FROM PUBLIC;
CREATE TRIGGER race_result_proof_sync AFTER INSERT OR UPDATE OF values_json ON public.race_result_revision
 FOR EACH ROW EXECUTE FUNCTION public.sync_race_result_proof_refs();

CREATE FUNCTION public.check_race_result_proof_refs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text; rid uuid; rev integer; b jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  t:=OLD.athlete_id; rid:=OLD.result_id; rev:=OLD.result_revision;
 ELSE
  t:=NEW.athlete_id;
  IF TG_TABLE_NAME='race_result_proof_ref' THEN rid:=NEW.result_id; rev:=NEW.result_revision;
  ELSE rid:=NEW.entity_id; rev:=NEW.revision; END IF;
 END IF;
 SELECT values_json INTO b FROM public.race_result_revision WHERE athlete_id=t AND entity_id=rid AND revision=rev;
 IF b IS NULL THEN RETURN NULL; END IF;
 IF EXISTS((SELECT (n-1)::integer,a->>'kind',CASE WHEN a->>'kind'='gallery-image' THEN (a->>'mediaItemId')::uuid ELSE (a->>'resourceId')::uuid END,
   CASE WHEN a->>'kind'='resource-pdf' THEN (a->>'versionId')::uuid ELSE NULL::uuid END,
   CASE WHEN a->>'status'='unavailable' THEN NULL::integer ELSE (a->>'accessRevision')::integer END
   FROM jsonb_array_elements(coalesce(b->'proofs'->'attachments','[]'::jsonb)) WITH ORDINALITY x(a,n))
  EXCEPT SELECT ordinal,source_kind,source_id,version_id,access_revision FROM public.race_result_proof_ref WHERE athlete_id=t AND result_id=rid AND result_revision=rev)
 OR EXISTS((SELECT ordinal,source_kind,source_id,version_id,access_revision FROM public.race_result_proof_ref WHERE athlete_id=t AND result_id=rid AND result_revision=rev)
  EXCEPT SELECT (n-1)::integer,a->>'kind',CASE WHEN a->>'kind'='gallery-image' THEN (a->>'mediaItemId')::uuid ELSE (a->>'resourceId')::uuid END,
   CASE WHEN a->>'kind'='resource-pdf' THEN (a->>'versionId')::uuid ELSE NULL::uuid END,
   CASE WHEN a->>'status'='unavailable' THEN NULL::integer ELSE (a->>'accessRevision')::integer END
   FROM jsonb_array_elements(coalesce(b->'proofs'->'attachments','[]'::jsonb)) WITH ORDINALITY x(a,n))
 THEN RAISE EXCEPTION 'RACE_PROOF_ROSTER_MISMATCH'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_race_result_proof_refs() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER race_result_proof_roster AFTER INSERT OR UPDATE OR DELETE ON public.race_result_proof_ref
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_race_result_proof_refs();
CREATE CONSTRAINT TRIGGER race_result_revision_proof_roster AFTER INSERT OR UPDATE ON public.race_result_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_race_result_proof_refs();
CREATE TRIGGER race_result_proof_no_truncate BEFORE TRUNCATE ON public.race_result_proof_ref
 FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

CREATE FUNCTION public.redact_race_result_proof_source(t text,k text,s uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r record; b jsonb; changed boolean:=false;
BEGIN
 PERFORM public.assert_race_proof_owner();
 IF t IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') OR s IS NULL
  OR coalesce(k,'') NOT IN ('gallery-image','resource-pdf') THEN RAISE EXCEPTION 'RACE_PROOF_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t,0));
 IF NOT EXISTS(SELECT 1 FROM public.race_result_proof_ref WHERE athlete_id=t AND source_kind=k AND source_id=s AND access_revision IS NOT NULL) THEN RETURN; END IF;
 IF NOT public.race_proof_source_removed(t,k,s) THEN RAISE EXCEPTION 'RACE_PROOF_SOURCE_EVENT_REQUIRED'; END IF;
 FOR r IN SELECT DISTINCT result_id FROM public.race_result_proof_ref WHERE athlete_id=t AND source_kind=k AND source_id=s ORDER BY result_id LOOP
  PERFORM 1 FROM public.race_result WHERE athlete_id=t AND id=r.result_id FOR UPDATE;
  UPDATE public.race_result SET values_json=public.race_result_proof_redacted(t,values_json)
   WHERE athlete_id=t AND id=r.result_id AND NOT deleted AND values_json IS DISTINCT FROM public.race_result_proof_redacted(t,values_json);
  IF FOUND THEN changed:=true; END IF;
  UPDATE public.race_result_revision SET values_json=public.race_result_proof_redacted(t,values_json)
   WHERE athlete_id=t AND entity_id=r.result_id AND values_json IS DISTINCT FROM public.race_result_proof_redacted(t,values_json);
  IF FOUND THEN changed:=true; END IF;
 END LOOP;
 IF changed THEN
  INSERT INTO public.race_collection_head(athlete_id,kind,revision,privacy_generation) VALUES(t,'race-result',1,1)
   ON CONFLICT(athlete_id,kind) DO UPDATE SET privacy_generation=race_collection_head.privacy_generation+1;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.redact_race_result_proof_source(text,text,uuid) FROM PUBLIC;

-- Deferred hooks run after ordinary event emission or authenticated replay's exact event insert.
-- A synthetic replay GUC cannot make a transaction commit without that source event.
CREATE FUNCTION public.redact_race_proofs_after_media_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM public.redact_race_result_proof_source(OLD.athlete_id,
   CASE TG_TABLE_NAME WHEN 'gallery_media_item' THEN 'gallery-image' ELSE 'resource-pdf' END,OLD.id);
 ELSE
  PERFORM public.redact_race_result_proof_source(NEW.athlete_id,
   CASE TG_TABLE_NAME WHEN 'gallery_media_item' THEN 'gallery-image' ELSE 'resource-pdf' END,NEW.id);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.redact_race_proofs_after_media_removal() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER race_proof_gallery_delete AFTER UPDATE ON public.gallery_media_item
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
 EXECUTE FUNCTION public.redact_race_proofs_after_media_removal();
CREATE CONSTRAINT TRIGGER race_proof_resource_delete AFTER UPDATE ON public.resource
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
 EXECUTE FUNCTION public.redact_race_proofs_after_media_removal();
CREATE CONSTRAINT TRIGGER race_proof_gallery_erase AFTER DELETE ON public.gallery_media_item
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.redact_race_proofs_after_media_removal();
CREATE CONSTRAINT TRIGGER race_proof_resource_erase AFTER DELETE ON public.resource
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.redact_race_proofs_after_media_removal();

-- Predecessors retain all chain/compound/receipt checks. Posthooks also run on already_applied.
ALTER FUNCTION public.replay_gallery_media_deletion_exact(text,uuid,uuid,timestamptz,integer) RENAME TO replay_gallery_media_deletion_exact_before_race_proofs;
REVOKE ALL ON FUNCTION public.replay_gallery_media_deletion_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer) FROM PUBLIC;
DO $migration$ DECLARE principal oid; BEGIN
 FOR principal IN SELECT DISTINCT a.grantee FROM pg_proc p,
  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.replay_gallery_media_deletion_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer)'::regprocedure
   AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.replay_gallery_media_deletion_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer) FROM %I',pg_get_userbyid(principal)); END LOOP;
END $migration$;
CREATE FUNCTION public.replay_gallery_media_deletion_exact(text,uuid,uuid,timestamptz,integer) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ DECLARE outcome text; BEGIN
 outcome:=public.replay_gallery_media_deletion_exact_before_race_proofs($1,$2,$3,$4,$5);
 IF outcome<>'already_applied_by_erasure' THEN
  PERFORM public.redact_race_result_proof_source($1,'gallery-image',$2);
 END IF;
 RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION public.replay_gallery_media_deletion_exact(text,uuid,uuid,timestamptz,integer) FROM PUBLIC;
ALTER FUNCTION public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer) RENAME TO replay_resource_deletion_exact_before_race_proofs;
REVOKE ALL ON FUNCTION public.replay_resource_deletion_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer) FROM PUBLIC;
DO $migration$ DECLARE principal oid; BEGIN
 FOR principal IN SELECT DISTINCT a.grantee FROM pg_proc p,
  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.replay_resource_deletion_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer)'::regprocedure
   AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.replay_resource_deletion_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer) FROM %I',pg_get_userbyid(principal)); END LOOP;
END $migration$;
CREATE FUNCTION public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ DECLARE outcome text; BEGIN
 outcome:=public.replay_resource_deletion_exact_before_race_proofs($1,$2,$3,$4,$5);
 IF outcome<>'already_applied_by_erasure' THEN
  PERFORM public.redact_race_result_proof_source($1,'resource-pdf',$2);
 END IF;
 RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION public.replay_resource_deletion_exact(text,uuid,uuid,timestamptz,integer) FROM PUBLIC;
ALTER FUNCTION public.replay_resource_deletion_compound_exact(text,uuid,uuid,timestamptz,integer,jsonb) RENAME TO replay_resource_deletion_compound_exact_before_race_proofs;
REVOKE ALL ON FUNCTION public.replay_resource_deletion_compound_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer,jsonb) FROM PUBLIC;
DO $migration$ DECLARE principal oid; BEGIN
 FOR principal IN SELECT DISTINCT a.grantee FROM pg_proc p,
  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.replay_resource_deletion_compound_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer,jsonb)'::regprocedure
   AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.replay_resource_deletion_compound_exact_before_race_proofs(text,uuid,uuid,timestamptz,integer,jsonb) FROM %I',pg_get_userbyid(principal)); END LOOP;
END $migration$;
CREATE FUNCTION public.replay_resource_deletion_compound_exact(text,uuid,uuid,timestamptz,integer,jsonb) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ DECLARE outcome text; BEGIN
 outcome:=public.replay_resource_deletion_compound_exact_before_race_proofs($1,$2,$3,$4,$5,$6);
 IF outcome<>'already_applied_by_erasure' THEN
  PERFORM public.redact_race_result_proof_source($1,'resource-pdf',$2);
 END IF;
 RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION public.replay_resource_deletion_compound_exact(text,uuid,uuid,timestamptz,integer,jsonb) FROM PUBLIC;

CREATE FUNCTION public.check_race_result_proof_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text; rid uuid; h public.race_result%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='race_result' THEN t:=NEW.athlete_id; rid:=NEW.id;
 ELSE t:=NEW.athlete_id; rid:=NEW.entity_id; END IF;
 IF TG_TABLE_NAME='race_result' AND TG_OP='UPDATE'
  AND public.race_result_proof_source_clone(t,OLD.values_json,NEW.values_json) THEN
  IF NEW.values_json=jsonb_set(OLD.values_json,'{linkedActivityId}','null'::jsonb,false) THEN
   IF NOT EXISTS(SELECT 1 FROM public.activity_canonical c
    JOIN public.activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id
    JOIN public.restore_suppression_event e ON e.athlete_id=c.athlete_id AND e.target_id=c.id
     AND e.kind='activity_deleted' AND e.record_version IN (1,2,3,4,5)
     AND e.activity_revision=c.revision AND e.source_kind=s.kind AND e.source_id=s.source_id
     AND e.source_revision=s.source_revision AND e.source_content_hash=s.content_hash
    WHERE c.athlete_id=t AND c.id::text=OLD.values_json->>'linkedActivityId' AND c.deleted)
    OR NOT EXISTS(SELECT 1 FROM public.outbox o WHERE o.athlete_id=t
     AND o.idempotency_key='race-source-deletion:'||(OLD.values_json->>'linkedActivityId')||':race-result:'||rid::text
     AND o.topic='race.source_dependency_redacted'
     AND o.payload=jsonb_build_object('kind','race-result','id',rid,'reason','activity-source-deleted'))
   THEN RAISE EXCEPTION 'RACE_PROOF_SOURCE_CLONE_NOT_AUTHENTICATED'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM public.race_event r JOIN public.restore_suppression_event e
    ON e.athlete_id=r.athlete_id AND e.target_id=r.id AND e.kind='race_event_deleted'
     AND e.record_version=4 AND e.race_deleted_revision=r.revision AND e.occurred_at=r.updated_at
    WHERE r.athlete_id=t AND r.id::text=OLD.values_json->>'raceEventId' AND r.deleted
     AND (EXISTS(SELECT 1 FROM public.outbox o WHERE o.athlete_id=t
      AND o.idempotency_key='race-delete:race-event:'||r.id::text AND o.topic='race.entity_deleted'
      AND o.payload=jsonb_build_object('kind','race-event','id',r.id,'revision',r.revision))
      OR EXISTS(SELECT 1 FROM public.restore_race_deletion_replay_receipt p
       WHERE p.athlete_id=t AND p.event_id=e.event_id AND p.target_id=r.id
        AND p.kind=e.kind AND p.occurred_at=e.occurred_at
        AND p.previous_revision=e.race_previous_revision AND p.deleted_revision=e.race_deleted_revision)))
   THEN RAISE EXCEPTION 'RACE_PROOF_SOURCE_CLONE_NOT_AUTHENTICATED'; END IF;
  END IF;
  IF NEW.revision=2147483647 AND OLD.revision=NEW.revision THEN RETURN NULL; END IF;
 END IF;
 SELECT * INTO h FROM public.race_result WHERE athlete_id=t AND id=rid;
 IF NOT h.deleted AND h.values_json->'schemaVersion'='2'::jsonb AND NOT EXISTS(
  SELECT 1 FROM public.race_result_revision r WHERE r.athlete_id=t AND r.entity_id=rid
   AND r.revision=h.revision AND r.values_json=h.values_json)
 THEN RAISE EXCEPTION 'RACE_PROOF_HEAD_HISTORY_MISMATCH'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_race_result_proof_head() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER race_result_proof_exact_head AFTER INSERT OR UPDATE ON public.race_result
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_race_result_proof_head();
CREATE CONSTRAINT TRIGGER race_result_proof_exact_history AFTER INSERT OR UPDATE ON public.race_result_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_race_result_proof_head();

-- Narrow read capability for the authenticated proof resolver. It reveals no
-- event IDs, revisions, timestamps, receipt facts or other tenant's existence.
CREATE FUNCTION public.race_result_proof_source_suppressed(t text,k text,s uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE stamp timestamptz; found_parent boolean; has_event boolean;
BEGIN
 PERFORM public.assert_race_proof_owner();
 IF t IS NULL OR t IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  OR s IS NULL OR coalesce(k,'') NOT IN ('gallery-image','resource-pdf')
 THEN RAISE EXCEPTION 'RACE_PROOF_SUPPRESSION_INPUT_INVALID'; END IF;
 IF k='gallery-image' THEN
  SELECT deleted_at INTO stamp FROM public.gallery_media_item WHERE athlete_id=t AND id=s FOR SHARE;
 ELSE
  SELECT deleted_at INTO stamp FROM public.resource WHERE athlete_id=t AND id=s FOR SHARE;
 END IF;
 found_parent:=FOUND;
 IF NOT found_parent THEN RAISE EXCEPTION 'RACE_PROOF_SOURCE_UNAVAILABLE'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.restore_suppression_event e WHERE e.athlete_id=t
  AND e.target_id=s AND e.record_version IN (1,2,3,4,5)
  AND e.kind=CASE k WHEN 'gallery-image' THEN 'gallery_media_deleted' ELSE 'resource_deleted' END)
 INTO has_event;
 IF NOT has_event AND stamp IS NULL THEN RETURN false; END IF;
 IF has_event AND stamp IS NOT NULL AND public.race_proof_source_removed(t,k,s) THEN RETURN true; END IF;
 RAISE EXCEPTION 'RACE_PROOF_SUPPRESSION_CONFLICT';
END $$;
REVOKE ALL ON FUNCTION public.race_result_proof_source_suppressed(text,text,uuid) FROM PUBLIC;
-- Root grantRaces capability probe for109: GRANT EXECUTE ON this exact function
-- to the authenticated runtime role. No restore_suppression_event SELECT/RLS expansion.
