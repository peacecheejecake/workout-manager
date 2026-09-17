CREATE TABLE core_evidence_snapshot (
 athlete_id text NOT NULL, id uuid NOT NULL, thread_id uuid NOT NULL,
 created_at timestamptz NOT NULL, body jsonb, purged_reason text,
 PRIMARY KEY(athlete_id,id), FOREIGN KEY(athlete_id,thread_id) REFERENCES coaching_thread(athlete_id,id),
 CHECK (
   (body IS NOT NULL AND jsonb_typeof(body)='object' AND purged_reason IS NULL
    OR body IS NULL AND purged_reason IN ('source_deleted','consent_withdrawn')) IS TRUE
 ),
 -- jsonb text adds formatting whitespace; the repository enforces the 2 MiB compact JSON limit.
 CHECK (body IS NULL OR octet_length(body::text)<=4194304)
);
CREATE INDEX core_evidence_snapshot_thread ON core_evidence_snapshot(athlete_id,thread_id,created_at DESC,id);
ALTER TABLE core_evidence_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_evidence_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON core_evidence_snapshot
 USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

CREATE FUNCTION core_evidence_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
 AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   IF TG_OP='UPDATE' AND OLD.body IS NOT NULL AND NEW.body IS NULL
     AND NEW.purged_reason IN ('source_deleted','consent_withdrawn')
     AND (to_jsonb(OLD)-'body'-'purged_reason')=(to_jsonb(NEW)-'body'-'purged_reason') THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'IMMUTABLE_EVIDENCE_SNAPSHOT';
END $$;
CREATE TRIGGER core_evidence_immutable BEFORE UPDATE OR DELETE ON core_evidence_snapshot
 FOR EACH ROW EXECUTE FUNCTION core_evidence_immutable();
REVOKE ALL ON FUNCTION core_evidence_immutable() FROM PUBLIC;

CREATE FUNCTION purge_core_evidence_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'EVIDENCE_TENANT_MISMATCH'; END IF;
 IF TG_OP='DELETE' OR (NOT OLD.deleted AND NEW.deleted) THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(OLD.athlete_id, CASE WHEN TG_TABLE_NAME='check_in' THEN 77209 ELSE 0 END));
   UPDATE public.core_evidence_snapshot SET body=NULL,purged_reason='source_deleted'
   WHERE athlete_id=OLD.athlete_id AND body IS NOT NULL AND (
     (TG_TABLE_NAME='activity_canonical' AND EXISTS(SELECT 1 FROM jsonb_array_elements(body->'activities') item WHERE item->'record'->>'id'=OLD.id::text)) OR
     (TG_TABLE_NAME='check_in' AND EXISTS(SELECT 1 FROM jsonb_array_elements(body->'checkIns') item WHERE item->'record'->>'id'=OLD.id::text))
   );
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION purge_core_evidence_source() FROM PUBLIC;
CREATE TRIGGER purge_core_evidence_activity AFTER UPDATE OF deleted OR DELETE ON activity_canonical FOR EACH ROW EXECUTE FUNCTION purge_core_evidence_source();
CREATE TRIGGER purge_core_evidence_checkin AFTER UPDATE OF deleted OR DELETE ON check_in FOR EACH ROW EXECUTE FUNCTION purge_core_evidence_source();

CREATE FUNCTION purge_core_evidence_consent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text; consent_kind text; withdrawn boolean;
BEGIN
 IF TG_OP='DELETE' THEN owner_id:=OLD.athlete_id; consent_kind:=OLD.kind; withdrawn:=true;
 ELSE owner_id:=NEW.athlete_id; consent_kind:=NEW.kind; withdrawn:=NOT NEW.granted;
 END IF;
 IF owner_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'EVIDENCE_TENANT_MISMATCH'; END IF;
 IF consent_kind='ai' AND withdrawn THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,0));
   UPDATE public.core_evidence_snapshot SET body=NULL,purged_reason='consent_withdrawn' WHERE athlete_id=owner_id AND body IS NOT NULL;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION purge_core_evidence_consent() FROM PUBLIC;
CREATE TRIGGER purge_core_evidence_ai_consent AFTER INSERT OR UPDATE OF granted OR DELETE ON consent FOR EACH ROW EXECUTE FUNCTION purge_core_evidence_consent();

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_core_evidence;
REVOKE ALL ON FUNCTION public.erase_account_before_core_evidence(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.erase_account_before_core_evidence(text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_core_evidence(text) FROM %I',role_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 DELETE FROM public.core_evidence_snapshot WHERE athlete_id=$1;
 RETURN public.erase_account_before_core_evidence($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
