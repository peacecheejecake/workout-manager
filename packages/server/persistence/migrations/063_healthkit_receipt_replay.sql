-- A local Activity deletion keeps HealthKit ingestion consent in force. The stored
-- batch digest is an ACK fingerprint, not a raw workout body. Retain it so a
-- native uploader can replay the same batch after an ACK is lost; raw sample
-- tombstones and suppression still block recreation. Consent withdrawal and
-- account erasure continue to purge receipts under migration 059.
-- Receipts purged by a previously applied migration 062 cannot be reconstructed.
CREATE OR REPLACE FUNCTION public.purge_healthkit_raw_on_activity_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE sample_uuid uuid;
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
  IF FOUND THEN
    UPDATE public.healthkit_workout_lineage SET state='suppressed'
      WHERE athlete_id=NEW.athlete_id AND sample_id=sample_uuid AND state='deleted';
  END IF;
  RETURN NULL;
END $$;

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
  END IF;
  IF NOT public.arm_object_scope_purge($1,'activity',$2) THEN
    RAISE EXCEPTION 'ACTIVITY_REPLAY_PURGE_NOT_ARMED';
  END IF;
  RETURN true;
END $$;
