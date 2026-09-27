-- An explicit decision turns one live HealthKit workout into one primary Activity.
-- The raw UUID remains the source identity. A deleted UUID is a permanent barrier.
ALTER TABLE activity_source_head DROP CONSTRAINT activity_source_head_kind_check;
ALTER TABLE activity_source_head ADD CONSTRAINT activity_source_head_kind_check
  CHECK (kind IN ('fit', 'fixture', 'manual', 'healthkit'));
ALTER TABLE healthkit_workout_lineage DROP CONSTRAINT healthkit_workout_lineage_state_check;
ALTER TABLE healthkit_workout_lineage ADD CONSTRAINT healthkit_workout_lineage_state_check
  CHECK (state IN ('pending_review', 'linked_existing', 'created_activity', 'suppressed', 'deleted'));

-- The runtime calls this function only after the product has received the
-- user's explicit choice. It cannot supply Activity values: every value comes
-- from the locked raw sample. No title, local timezone, heart rate or route is
-- inferred. HKWorkout.duration is retained with an unknown duration definition.
CREATE FUNCTION public.create_healthkit_canonical(uuid,text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE sample_row public.healthkit_workout_sample%ROWTYPE;
DECLARE lineage_state text;
DECLARE new_activity uuid:=gen_random_uuid();
DECLARE values_json jsonb;
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'HEALTHKIT_TENANT_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
  IF NOT coalesce(public.healthkit_ingestion_consent_locked(),false) THEN
    RAISE EXCEPTION 'HEALTHKIT_CONSENT_REQUIRED';
  END IF;
  SELECT * INTO sample_row FROM public.healthkit_workout_sample
    WHERE athlete_id=tenant AND sample_id=$1 FOR UPDATE;
  IF NOT FOUND OR sample_row.state<>'active' THEN
    RAISE EXCEPTION 'HEALTHKIT_SAMPLE_UNAVAILABLE';
  END IF;
  IF sample_row.payload_digest IS DISTINCT FROM $2 THEN
    RAISE EXCEPTION 'HEALTHKIT_DIGEST_CONFLICT';
  END IF;
  SELECT state INTO lineage_state FROM public.healthkit_workout_lineage
    WHERE athlete_id=tenant AND sample_id=$1 FOR UPDATE;
  IF NOT FOUND OR lineage_state<>'pending_review' THEN
    RAISE EXCEPTION 'HEALTHKIT_SAMPLE_UNAVAILABLE';
  END IF;
  IF EXISTS(SELECT 1 FROM public.activity_source_head
    WHERE athlete_id=tenant AND kind='healthkit' AND source_id=$1::text)
  THEN RAISE EXCEPTION 'HEALTHKIT_ALREADY_CREATED'; END IF;
  values_json:=jsonb_build_object(
    'title',NULL,
    'kind',CASE sample_row.activity_type
      WHEN 13 THEN 'cycling' WHEN 20 THEN 'strength'
      WHEN 37 THEN 'running' WHEN 50 THEN 'strength'
      WHEN 52 THEN 'walking' ELSE 'other' END,
    'startedAt',sample_row.observed_from,
    'durationSeconds',sample_row.duration_seconds,
    'durationKind','unknown',
    'timezone',NULL,
    'distanceMeters',sample_row.distance_meters);
  INSERT INTO public.activity_canonical(athlete_id,id,revision,original)
    VALUES(tenant,new_activity,1,values_json);
  INSERT INTO public.activity_source_head
    (athlete_id,kind,source_id,source_revision,content_hash,activity_id)
    VALUES(tenant,'healthkit',$1::text,1,sample_row.payload_digest,new_activity);
  INSERT INTO public.activity_source_revision
    (athlete_id,kind,source_id,source_revision,content_hash,normalized_raw)
    VALUES(tenant,'healthkit',$1::text,1,sample_row.payload_digest,values_json);
  UPDATE public.healthkit_workout_lineage SET state='created_activity'
    WHERE athlete_id=tenant AND sample_id=$1 AND state='pending_review';
  IF NOT FOUND THEN RAISE EXCEPTION 'HEALTHKIT_SAMPLE_UNAVAILABLE'; END IF;
  RETURN new_activity;
END $$;
REVOKE ALL ON FUNCTION public.create_healthkit_canonical(uuid,text) FROM PUBLIC;

-- A canonical tombstone already drives evidence/citation, course, track and
-- object-scope cleanup. Redact the HealthKit-owned row and its private history
-- before those AFTER UPDATE triggers fire. Keep only source identity and an
-- explicit suppression fact so delayed delivery cannot recreate the workout.
CREATE FUNCTION public.redact_healthkit_canonical_on_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE sample_uuid uuid;
BEGIN
  SELECT source_id::uuid INTO sample_uuid FROM public.activity_source_head
    WHERE athlete_id=NEW.athlete_id AND activity_id=NEW.id AND kind='healthkit';
  IF sample_uuid IS NULL THEN RETURN NEW; END IF;
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
    OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'HEALTHKIT_TENANT_MISMATCH';
  END IF;
  INSERT INTO public.activity_suppression(athlete_id,kind,source_id)
    VALUES(NEW.athlete_id,'healthkit',sample_uuid::text) ON CONFLICT DO NOTHING;
  DELETE FROM public.activity_overlay_revision
    WHERE athlete_id=NEW.athlete_id AND activity_id=NEW.id;
  DELETE FROM public.activity_overlay
    WHERE athlete_id=NEW.athlete_id AND activity_id=NEW.id;
  DELETE FROM public.activity_source_revision
    WHERE athlete_id=NEW.athlete_id AND kind='healthkit' AND source_id=sample_uuid::text;
  UPDATE public.activity_source_head SET content_hash=repeat('0',64)
    WHERE athlete_id=NEW.athlete_id AND kind='healthkit' AND source_id=sample_uuid::text;
  UPDATE public.command_receipt SET request='{"purged":true}'::jsonb,
    result='{"purged":true}'::jsonb
    WHERE athlete_id=NEW.athlete_id
      AND idempotency_key LIKE 'healthkit-create:%'
      AND result->>'activityId'=NEW.id::text;
  UPDATE public.healthkit_workout_lineage SET state='suppressed'
    WHERE athlete_id=NEW.athlete_id AND sample_id=sample_uuid
      AND state='created_activity';
  NEW.original:='{"title":null,"kind":"unknown","startedAt":null,"durationSeconds":null,"durationKind":"unknown","timezone":null,"distanceMeters":null}'::jsonb;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.redact_healthkit_canonical_on_delete() FROM PUBLIC;
CREATE TRIGGER redact_healthkit_canonical_on_delete
  BEFORE UPDATE OF deleted ON activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION public.redact_healthkit_canonical_on_delete();

-- A user can delete the Activity while the HealthKit sample still exists.
-- After the canonical tombstone is visible in this transaction, erase that
-- raw body too. The nested raw trigger sees c.deleted=true and does not update
-- this Activity again. The old batch format has no sample-to-batch index, so
-- all content-bearing receipt digests for this tenant are purged; opaque batch
-- IDs remain as replay barriers. The native client must reconcile after this.
CREATE FUNCTION public.purge_healthkit_raw_on_activity_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE sample_uuid uuid;
DECLARE removed integer;
BEGIN
  -- Raw DELETE/UPDATE triggers also tombstone this Activity. In that nested
  -- path the outer statement already owns the raw tuple; modifying it here
  -- would raise "tuple already modified by an operation triggered by the
  -- current command". Only a direct Activity deletion removes the raw body.
  IF pg_trigger_depth()>1 THEN RETURN NULL; END IF;
  SELECT source_id::uuid INTO sample_uuid FROM public.activity_source_head
    WHERE athlete_id=NEW.athlete_id AND activity_id=NEW.id AND kind='healthkit';
  IF sample_uuid IS NULL THEN RETURN NULL; END IF;
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'HEALTHKIT_TENANT_MISMATCH';
  END IF;
  UPDATE public.healthkit_workout_sample SET
    state='deleted',source_bundle_id=NULL,source_version=NULL,
    activity_type=NULL,observed_from=NULL,observed_to=NULL,
    duration_seconds=NULL,distance_meters=NULL,energy_kilocalories=NULL,
    payload_digest=NULL,deleted_at=clock_timestamp()
    WHERE athlete_id=NEW.athlete_id AND sample_id=sample_uuid AND state='active';
  GET DIAGNOSTICS removed=ROW_COUNT;
  IF removed>0 THEN
    UPDATE public.healthkit_workout_lineage SET state='suppressed'
      WHERE athlete_id=NEW.athlete_id AND sample_id=sample_uuid AND state='deleted';
    UPDATE public.healthkit_workout_batch_receipt
      SET request_digest=NULL,purged_at=clock_timestamp()
      WHERE athlete_id=NEW.athlete_id AND purged_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.purge_healthkit_raw_on_activity_delete() FROM PUBLIC;
CREATE TRIGGER purge_healthkit_raw_on_activity_delete
  AFTER UPDATE OF deleted ON activity_canonical
  FOR EACH ROW WHEN (NEW.deleted AND NOT OLD.deleted)
  EXECUTE FUNCTION public.purge_healthkit_raw_on_activity_delete();

-- Both HKDeletedObject and consent withdrawal reach this trigger. The latter
-- physically deletes raw rows; the former retains a raw tombstone. The update
-- is one transaction with the raw change and invokes all Activity delete hooks.
CREATE FUNCTION public.suppress_healthkit_canonical_on_raw_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text;
DECLARE sample_uuid uuid;
BEGIN
  tenant:=OLD.athlete_id;
  sample_uuid:=OLD.sample_id;
  IF tenant IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'HEALTHKIT_TENANT_MISMATCH';
  END IF;
  UPDATE public.activity_canonical c SET deleted=true,revision=revision+1
    FROM public.activity_source_head h
    WHERE h.athlete_id=tenant AND h.kind='healthkit'
      AND h.source_id=sample_uuid::text AND h.activity_id=c.id
      AND c.athlete_id=tenant AND NOT c.deleted;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.suppress_healthkit_canonical_on_raw_removal() FROM PUBLIC;
CREATE TRIGGER healthkit_canonical_on_raw_tombstone
  AFTER UPDATE OF state ON healthkit_workout_sample
  FOR EACH ROW WHEN (NEW.state='deleted' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION public.suppress_healthkit_canonical_on_raw_removal();
CREATE TRIGGER healthkit_canonical_on_raw_purge
  BEFORE DELETE ON healthkit_workout_sample
  FOR EACH ROW EXECUTE FUNCTION public.suppress_healthkit_canonical_on_raw_removal();

-- A restore can replay an Activity deletion from after the database dump while
-- a matching native upload arrives later. Its suppression fact must block the
-- raw body's resurrection, not merely the canonical Activity's creation.
CREATE FUNCTION public.suppress_replayed_healthkit_raw() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'HEALTHKIT_TENANT_MISMATCH';
  END IF;
  IF NEW.state='active' AND EXISTS(
    SELECT 1 FROM public.activity_suppression s
    WHERE s.athlete_id=NEW.athlete_id AND s.kind='healthkit'
      AND s.source_id=NEW.sample_id::text
  ) THEN
    NEW.state:='deleted';
    NEW.source_bundle_id:=NULL;
    NEW.source_version:=NULL;
    NEW.activity_type:=NULL;
    NEW.observed_from:=NULL;
    NEW.observed_to:=NULL;
    NEW.duration_seconds:=NULL;
    NEW.distance_meters:=NULL;
    NEW.energy_kilocalories:=NULL;
    NEW.payload_digest:=NULL;
    NEW.deleted_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.suppress_replayed_healthkit_raw() FROM PUBLIC;
CREATE TRIGGER healthkit_raw_replay_suppression
  BEFORE INSERT ON healthkit_workout_sample
  FOR EACH ROW EXECUTE FUNCTION public.suppress_replayed_healthkit_raw();

-- Migration 052's restore-only replay rejected all kinds beyond fit/fixture.
-- Extend its checked input for a HealthKit deletion ledger, while keeping the
-- same foreign-tenant refusal, source barrier and object-scope purge. A raw
-- sample captured by the older dump is redacted in this transaction too.
CREATE OR REPLACE FUNCTION public.replay_absent_activity_deletion(text,uuid,text,text,integer,integer,text)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF $1 IS NULL OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ACTIVITY_REPLAY_TENANT_MISMATCH';
  END IF;
  IF $2 IS NULL
    OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_INVALID_ID'; END IF;
  IF $3 IS NULL OR $3 NOT IN ('fit','fixture','healthkit')
    OR $4 IS NULL OR length($4) NOT BETWEEN 1 AND 200
    OR $5 IS NULL OR $5<1 OR $6 IS NULL OR $6<1
    OR $7 IS NULL OR $7 !~ '^[a-f0-9]{64}$'
    OR ($3='healthkit' AND
      ($4 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR $7<>repeat('0',64)))
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_TENANT_ERASED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_TENANT_UNKNOWN'; END IF;
  IF EXISTS(SELECT 1 FROM public.activity_canonical c WHERE c.athlete_id=$1 AND c.id=$2)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_ACTIVITY_PRESENT'; END IF;
  IF EXISTS(SELECT 1 FROM public.activity_canonical c WHERE c.athlete_id<>$1 AND c.id=$2)
    OR public.restore_foreign_scope_present($1,'activity',$2)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_FOREIGN_ACTIVITY'; END IF;
  IF EXISTS(SELECT 1 FROM public.activity_source_head h
    WHERE h.athlete_id=$1 AND h.kind=$3 AND h.source_id=$4)
  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_SOURCE_CONFLICT'; END IF;
  INSERT INTO public.activity_canonical(athlete_id,id,revision,original,deleted)
    VALUES($1,$2,$6,'{}'::jsonb,true);
  INSERT INTO public.activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,
      activity_id) VALUES($1,$3,$4,$5,$7,$2);
  INSERT INTO public.activity_suppression(athlete_id,kind,source_id)
    VALUES($1,$3,$4);
  IF $3='healthkit' THEN
    UPDATE public.healthkit_workout_sample SET state='deleted',
      source_bundle_id=NULL,source_version=NULL,activity_type=NULL,
      observed_from=NULL,observed_to=NULL,duration_seconds=NULL,
      distance_meters=NULL,energy_kilocalories=NULL,payload_digest=NULL,
      deleted_at=clock_timestamp()
      WHERE athlete_id=$1 AND sample_id=$4::uuid AND state='active';
    UPDATE public.healthkit_workout_lineage SET state='suppressed'
      WHERE athlete_id=$1 AND sample_id=$4::uuid AND state='deleted';
    UPDATE public.healthkit_workout_batch_receipt
      SET request_digest=NULL,purged_at=clock_timestamp()
      WHERE athlete_id=$1 AND purged_at IS NULL;
  END IF;
  IF NOT public.arm_object_scope_purge($1,'activity',$2) THEN
    RAISE EXCEPTION 'ACTIVITY_REPLAY_PURGE_NOT_ARMED';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.replay_absent_activity_deletion(text,uuid,text,text,integer,integer,text)
  FROM PUBLIC;
