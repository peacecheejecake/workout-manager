-- M2-02c proposal. Shared migration/role grants/export/erasure are root-owned.
DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['race_event','race_result','training_best'] LOOP
    EXECUTE format('CREATE TABLE public.%I (
      athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
      id uuid NOT NULL,revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
      values_json jsonb,deleted boolean NOT NULL DEFAULT false,
      recorded_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
      PRIMARY KEY(athlete_id,id),CHECK(updated_at>=recorded_at),
      CHECK((deleted AND values_json IS NULL) OR (NOT deleted AND values_json IS NOT NULL
        AND jsonb_typeof(values_json)=''object'' AND octet_length(values_json::text)<=16384
        AND NOT (values_json ?| ARRAY[''id'',''revision'',''athleteId'',''ownerId''])))
    )',table_name);
    EXECUTE format('CREATE TABLE public.%I (
      athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
      entity_id uuid NOT NULL,revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
      values_json jsonb NOT NULL CHECK(jsonb_typeof(values_json)=''object''
        AND octet_length(values_json::text)<=16384
        AND NOT (values_json ?| ARRAY[''id'',''revision'',''athleteId'',''ownerId''])),
      created_at timestamptz NOT NULL,PRIMARY KEY(athlete_id,entity_id,revision),
      FOREIGN KEY(athlete_id,entity_id) REFERENCES public.%I(athlete_id,id)
    )',table_name||'_revision',table_name);
  END LOOP;
END $migration$;
ALTER TABLE race_event ADD CONSTRAINT race_event_no_actual CHECK(values_json IS NULL OR NOT(values_json ? 'kind'));
ALTER TABLE race_result ADD CONSTRAINT race_result_kind CHECK(values_json IS NULL OR (values_json ? 'kind' AND values_json->>'kind'='race-result'));
ALTER TABLE training_best ADD CONSTRAINT training_best_kind CHECK(values_json IS NULL OR (values_json ? 'kind' AND values_json->>'kind'='training-best'));
CREATE TABLE race_command_receipt (
  athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128 AND idempotency_key ~ '^[a-zA-Z0-9_-]+$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND result ?& ARRAY['id','revision']
    AND result - ARRAY['id','revision'] = '{}'::jsonb AND jsonb_typeof(result->'id')='string'
    AND (result->>'id') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND jsonb_typeof(result->'revision')='number' AND (result->>'revision')::numeric BETWEEN 1 AND 2147483647
    AND (result->>'revision')::numeric=trunc((result->>'revision')::numeric)),
  PRIMARY KEY(athlete_id,idempotency_key)
);
CREATE TABLE race_collection_head (
  athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK(kind IN ('race-event','race-result','training-best')),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  PRIMARY KEY(athlete_id,kind)
);
DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['race_event','race_event_revision','race_result','race_result_revision','training_best','training_best_revision','race_command_receipt','race_collection_head'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY race_tenant ON %I USING(athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK(athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',table_name);
  END LOOP;
END $migration$;
CREATE FUNCTION race_history_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_RACE_HISTORY';
END $$;
DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['race_event_revision','race_result_revision','training_best_revision','race_command_receipt'] LOOP
    EXECUTE format('CREATE TRIGGER race_history_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION race_history_append_only()',table_name);
  END LOOP;
END $migration$;
-- Root grantRaces(adminUrl,runtimeRole) statements (role quoted by existing migrate helper):
-- GRANT SELECT,INSERT,UPDATE ON race_event,race_result,training_best,race_collection_head TO runtimeRole;
-- GRANT SELECT,INSERT ON race_event_revision,race_result_revision,training_best_revision,race_command_receipt TO runtimeRole;
-- GRANT SELECT ON course,course_revision,activity_canonical,plan_snapshot TO runtimeRole;
-- SELECT FOR SHARE also requires UPDATE privilege on referenced tables: existing app roles
-- already have UPDATE on course and activity_canonical; immutable plan_snapshot does not.
-- Root erasure wrapper deletes histories and receipts, then heads and collection heads;
-- delegates to prior erase_account under its existing 77206 exclusive fence.

-- Account erasure and exact restored erasure must also remove the new ledgers.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_races;
REVOKE ALL ON FUNCTION public.erase_account_before_races(text) FROM PUBLIC;
DO $migration$
DECLARE principal oid;
BEGIN
 FOR principal IN SELECT DISTINCT a.grantee FROM pg_proc p,
  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.erase_account_before_races(text)'::regprocedure
    AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_races(text) FROM %I',pg_get_userbyid(principal));
 END LOOP;
END $migration$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
  RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 DELETE FROM public.race_event_revision WHERE athlete_id=$1;
 DELETE FROM public.race_result_revision WHERE athlete_id=$1;
 DELETE FROM public.training_best_revision WHERE athlete_id=$1;
 DELETE FROM public.race_command_receipt WHERE athlete_id=$1;
 DELETE FROM public.race_event WHERE athlete_id=$1;
 DELETE FROM public.race_result WHERE athlete_id=$1;
 DELETE FROM public.training_best WHERE athlete_id=$1;
 DELETE FROM public.race_collection_head WHERE athlete_id=$1;
 RETURN public.erase_account_before_races($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;

-- M2-02c privacy proposal. Root owns migration integration and privilege grants.
-- Ordinary Activity deletion and owner-only exact replay both purge dependent race data.
-- This is an explicit privacy exception to historical retention: delete affected history,
-- never rewrite immutable historical values or fabricate a replacement at the same revision.
-- At int4 terminal revision 2147483647, current privacy redaction/tombstoning retains that
-- revision. Ordinary updates already cannot name terminal expectedRevision. A saturated
-- collection head remains terminal, but privacy_generation advances separately and must
-- join revision in future collection/ETag/evidence freshness checks. It uses PostgreSQL
-- numeric with scale zero and no declared precision, not an infinitely sized counter:
-- PostgreSQL numeric/resource limits can still cause a transaction to fail atomically.
-- Privacy erasure never fails merely because the int4 record/collection revision is exhausted.
ALTER TABLE public.race_collection_head ADD COLUMN privacy_generation numeric NOT NULL DEFAULT 0
 CHECK(privacy_generation::text ~ '^(0|[1-9][0-9]*)$');
CREATE FUNCTION public.race_collection_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.revision<OLD.revision OR NEW.privacy_generation<OLD.privacy_generation THEN
  RAISE EXCEPTION 'RACE_COLLECTION_RESET_FORBIDDEN';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.race_collection_monotonic() FROM PUBLIC;
CREATE TRIGGER race_collection_monotonic BEFORE UPDATE ON public.race_collection_head
 FOR EACH ROW EXECUTE FUNCTION public.race_collection_monotonic();
CREATE FUNCTION public.redact_race_activity_dependencies(text,uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE item record;
DECLARE prior record;
DECLARE table_name text;
DECLARE current_matches boolean;
DECLARE dependent_actual boolean;
DECLARE purged_count integer;
DECLARE next_revision integer;
DECLARE next_values jsonb;
DECLARE event_key text;
DECLARE event_payload jsonb;
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') OR $2 IS NULL THEN
  RAISE EXCEPTION 'RACE_SOURCE_REDACTION_TENANT_MISMATCH';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
 IF NOT EXISTS(SELECT 1 FROM public.activity_canonical WHERE athlete_id=$1 AND id=$2 AND deleted) THEN
  RAISE EXCEPTION 'RACE_SOURCE_NOT_DELETED';
 END IF;
 FOR item IN
  SELECT 'training-best'::text AS kind,h.id FROM public.training_best h
   WHERE h.athlete_id=$1 AND (
    (h.values_json->'source'->>'kind'='activity' AND h.values_json->'source'->>'activityId'=$2::text)
    OR EXISTS(SELECT 1 FROM public.training_best_revision r
      WHERE r.athlete_id=h.athlete_id AND r.entity_id=h.id
       AND r.values_json->'source'->>'kind'='activity'
       AND r.values_json->'source'->>'activityId'=$2::text))
  UNION ALL
  SELECT 'race-result'::text AS kind,h.id FROM public.race_result h
   WHERE h.athlete_id=$1 AND (
    h.values_json->>'linkedActivityId'=$2::text
    OR EXISTS(SELECT 1 FROM public.race_result_revision r
      WHERE r.athlete_id=h.athlete_id AND r.entity_id=h.id
       AND r.values_json->>'linkedActivityId'=$2::text))
  ORDER BY kind,id
 LOOP
  table_name:=CASE item.kind WHEN 'training-best' THEN 'training_best' ELSE 'race_result' END;
  EXECUTE format('SELECT revision,values_json,deleted,recorded_at,updated_at FROM public.%I WHERE athlete_id=$1 AND id=$2 FOR UPDATE',table_name)
    INTO prior USING $1,item.id;
  current_matches:=coalesce(CASE item.kind WHEN 'training-best'
   THEN prior.values_json->'source'->>'kind'='activity' AND prior.values_json->'source'->>'activityId'=$2::text
   ELSE prior.values_json->>'linkedActivityId'=$2::text END,false);
  dependent_actual:=current_matches AND (item.kind='training-best'
    OR prior.values_json->'source'->>'kind'='device');
  -- An actual dependent on the deleted source loses every private revision. For a
  -- currently independent actual, purge only revisions still naming the source.
  IF dependent_actual THEN
   EXECUTE format('DELETE FROM public.%I WHERE athlete_id=$1 AND entity_id=$2',table_name||'_revision') USING $1,item.id;
  ELSIF item.kind='training-best' THEN
   DELETE FROM public.training_best_revision WHERE athlete_id=$1 AND entity_id=item.id
     AND values_json->'source'->>'kind'='activity' AND values_json->'source'->>'activityId'=$2::text;
  ELSE
   DELETE FROM public.race_result_revision WHERE athlete_id=$1 AND entity_id=item.id
     AND values_json->>'linkedActivityId'=$2::text;
  END IF;
  GET DIAGNOSTICS purged_count=ROW_COUNT;
  IF current_matches THEN
   next_revision:=CASE WHEN prior.revision<2147483647 THEN prior.revision+1 ELSE prior.revision END;
   next_values:=CASE WHEN dependent_actual THEN NULL
     ELSE jsonb_set(prior.values_json,'{linkedActivityId}','null'::jsonb,false) END;
   EXECUTE format('UPDATE public.%I SET revision=$3,values_json=$4,deleted=$5,updated_at=greatest(updated_at,recorded_at,clock_timestamp()) WHERE athlete_id=$1 AND id=$2',table_name)
     USING $1,item.id,next_revision,next_values,dependent_actual OR prior.deleted;
   -- Only an advanced independent head receives a new, source-free revision. Terminal
   -- redaction removes its old linked revision without fabricating same-version history.
   IF NOT dependent_actual AND next_revision>prior.revision THEN
    EXECUTE format('INSERT INTO public.%I(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,$3,$4,clock_timestamp())',table_name||'_revision')
      USING $1,item.id,next_revision,next_values;
   END IF;
  END IF;
  IF current_matches OR purged_count>0 THEN
   INSERT INTO public.race_collection_head(athlete_id,kind,revision,privacy_generation) VALUES($1,item.kind,1,1)
    ON CONFLICT(athlete_id,kind) DO UPDATE SET privacy_generation=race_collection_head.privacy_generation+1,revision=
     CASE WHEN race_collection_head.revision<2147483647 THEN race_collection_head.revision+1
      ELSE race_collection_head.revision END;
   -- No health values, URLs, source body, replay secret or derived measurements. This
   -- stable payload also works for ordinary deletion and replays from different snapshots.
   event_key:='race-source-deletion:'||$2::text||':'||item.kind||':'||item.id::text;
   event_payload:=jsonb_build_object('kind',item.kind,'id',item.id,'reason','activity-source-deleted');
   INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES($1,gen_random_uuid(),event_key,'race.source_dependency_redacted',event_payload)
    ON CONFLICT(athlete_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
    WHERE outbox.topic=EXCLUDED.topic AND outbox.payload=EXCLUDED.payload;
   IF NOT FOUND THEN RAISE EXCEPTION 'RACE_SOURCE_OUTBOX_CONFLICT'; END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.redact_race_activity_dependencies(text,uuid) FROM PUBLIC;
CREATE FUNCTION public.redact_races_after_activity_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM public.redact_race_activity_dependencies(NEW.athlete_id,NEW.id);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.redact_races_after_activity_deletion() FROM PUBLIC;
CREATE TRIGGER redact_races_after_activity_deletion
 AFTER UPDATE OF deleted ON public.activity_canonical FOR EACH ROW
 WHEN (NEW.deleted AND NOT OLD.deleted)
 EXECUTE FUNCTION public.redact_races_after_activity_deletion();
CREATE TRIGGER redact_races_after_absent_activity_deletion
 AFTER INSERT ON public.activity_canonical FOR EACH ROW WHEN (NEW.deleted)
 EXECUTE FUNCTION public.redact_races_after_activity_deletion();
-- Exact replay can take an already-deleted/absent path without a deleted transition;
-- delegate all existing owner/provenance/state checks before touching race dependencies.
ALTER FUNCTION public.replay_activity_deletion_exact(text,uuid,uuid,timestamptz,integer,text,text,integer,text)
 RENAME TO replay_activity_deletion_exact_before_races;
REVOKE ALL ON FUNCTION public.replay_activity_deletion_exact_before_races(text,uuid,uuid,timestamptz,integer,text,text,integer,text) FROM PUBLIC;
DO $migration$
DECLARE principal oid;
BEGIN
 FOR principal IN SELECT DISTINCT a.grantee FROM pg_proc p,
  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.replay_activity_deletion_exact_before_races(text,uuid,uuid,timestamptz,integer,text,text,integer,text)'::regprocedure
   AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.replay_activity_deletion_exact_before_races(text,uuid,uuid,timestamptz,integer,text,text,integer,text) FROM %I',pg_get_userbyid(principal));
 END LOOP;
END $migration$;
CREATE FUNCTION public.replay_activity_deletion_exact(text,uuid,uuid,timestamptz,integer,text,text,integer,text) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE result text;
BEGIN
 result:=public.replay_activity_deletion_exact_before_races($1,$2,$3,$4,$5,$6,$7,$8,$9);
 -- Existing validated erasure replay already removes the complete race ledger.
 -- Preserve its result when the source canonical tombstone no longer exists.
 IF result='already_applied_by_erasure' THEN RETURN result; END IF;
 PERFORM public.redact_race_activity_dependencies($1,$2);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.replay_activity_deletion_exact(text,uuid,uuid,timestamptz,integer,text,text,integer,text) FROM PUBLIC;
-- No runtime grant to helper, trigger function, old replay or new replay. SECURITY DEFINER
-- Activity hooks perform the purge; offline exact replay remains owner-only. The existing
-- account-erasure wrapper already deletes all race tables and remains unchanged.

-- Root export: include privacy_generation::text AS "privacyGeneration" in
-- raceCollectionHeads. Future collection reads/ETags/evidence dependencies must use
-- (revision, privacyGeneration) and source Activity deletion/revision dependencies.
-- No current race Evidence/approval consumer exists; this migration is not that consumer.
