-- Owner-only replay of a backup-authenticated HealthKit consent transition.
-- The caller verifies the complete backup chain before entering this transaction.
CREATE TABLE public.restore_healthkit_consent_replay_receipt (
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
REVOKE ALL ON TABLE public.restore_healthkit_consent_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_healthkit_consent_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_healthkit_consent_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_healthkit_consent_replay_receipt_owner
  ON public.restore_healthkit_consent_replay_receipt
  USING (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_healthkit_consent_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_healthkit_consent_replay_receipt'::regclass)));

CREATE FUNCTION public.verify_restore_healthkit_consent_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.kind='healthkit_consent_transition' AND e.target_id IS NULL
      AND e.occurred_at=NEW.occurred_at
      AND e.consent_previous_revision IS NOT DISTINCT FROM NEW.previous_revision
      AND e.consent_previous_granted IS NOT DISTINCT FROM NEW.previous_granted
      AND e.consent_revision=NEW.consent_revision
      AND e.consent_granted=NEW.consent_granted)
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_healthkit_consent_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_healthkit_consent_replay_receipt_verify
  BEFORE INSERT ON public.restore_healthkit_consent_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_healthkit_consent_replay_receipt();
CREATE TRIGGER restore_healthkit_consent_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_healthkit_consent_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_healthkit_consent_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_healthkit_consent_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- The ordinary consent write still fires the HealthKit withdrawal cleanup.
-- Suppress only its generated event under the plain migration owner's session.
CREATE OR REPLACE FUNCTION public.record_healthkit_consent_transition_suppression_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text;
DECLARE replay_id text:=nullif(current_setting('app.restore_healthkit_consent_event_id',true),'');
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.kind<>'healthkit' AND NEW.kind<>'healthkit' THEN RETURN NULL; END IF;
    IF OLD.kind<>'healthkit' OR NEW.kind<>'healthkit'
      OR OLD.athlete_id IS DISTINCT FROM NEW.athlete_id
      OR NEW.revision IS DISTINCT FROM OLD.revision+1
    THEN RAISE EXCEPTION 'HEALTHKIT_CONSENT_EPOCH_INVALID'; END IF;
  ELSIF NEW.kind<>'healthkit' THEN RETURN NULL;
  ELSIF NEW.revision<>1 THEN RAISE EXCEPTION 'HEALTHKIT_CONSENT_EPOCH_INVALID';
  END IF;
  tenant:=NEW.athlete_id;
  IF tenant IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'HEALTHKIT_CONSENT_TENANT_MISMATCH'; END IF;
  IF replay_id IS NOT NULL THEN
    IF session_user IS DISTINCT FROM pg_get_userbyid(
      (SELECT c.relowner FROM pg_catalog.pg_class c
       WHERE c.oid='public.restore_suppression_event'::regclass))
    THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  INSERT INTO public.restore_suppression_event(
    athlete_id,kind,occurred_at,consent_previous_revision,
    consent_previous_granted,consent_revision,consent_granted)
  VALUES(tenant,'healthkit_consent_transition',clock_timestamp(),
    CASE WHEN TG_OP='UPDATE' THEN OLD.revision ELSE NULL END,
    CASE WHEN TG_OP='UPDATE' THEN OLD.granted ELSE NULL END,
    NEW.revision,NEW.granted);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_healthkit_consent_transition_suppression_event()
  FROM PUBLIC;

CREATE FUNCTION public.replay_healthkit_consent_transition_exact(
  text,uuid,timestamptz,integer,boolean,integer,boolean)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
   WHERE p.oid='public.replay_healthkit_consent_transition_exact(text,uuid,timestamptz,integer,boolean,integer,boolean)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_healthkit_consent_replay_receipt%ROWTYPE;
DECLARE head public.consent%ROWTYPE;
DECLARE later public.restore_suppression_event%ROWTYPE;
DECLARE expected_granted boolean;
DECLARE expected_revision integer;
DECLARE had_event boolean;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $3 IS NULL OR $3>clock_timestamp()
    OR $6 IS NULL OR $6 NOT BETWEEN 1 AND 2147483647 OR $7 IS NULL
    OR (($4 IS NULL AND $5 IS NULL AND $6=1)
      OR ($4 BETWEEN 1 AND 2147483646 AND $5 IS NOT NULL AND $6=$4+1)) IS NOT TRUE
    OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event
    WHERE event_id=$2 OR (athlete_id=$1 AND kind='healthkit_consent_transition'
      AND consent_revision=$6) FOR UPDATE;
  had_event:=FOUND;
  IF had_event AND (existing.event_id IS DISTINCT FROM $2
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.kind IS DISTINCT FROM 'healthkit_consent_transition'
    OR existing.target_id IS NOT NULL OR existing.occurred_at IS DISTINCT FROM $3
    OR existing.consent_previous_revision IS DISTINCT FROM $4
    OR existing.consent_previous_granted IS DISTINCT FROM $5
    OR existing.consent_revision IS DISTINCT FROM $6
    OR existing.consent_granted IS DISTINCT FROM $7
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$2 OR (e.athlete_id=$1
        AND e.kind='healthkit_consent_transition' AND e.consent_revision=$6))
        AND e.event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_healthkit_consent_replay_receipt r
      WHERE r.event_id=$2;
    IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.occurred_at IS DISTINCT FROM $3
      OR receipt.previous_revision IS DISTINCT FROM $4
      OR receipt.previous_granted IS DISTINCT FROM $5
      OR receipt.consent_revision IS DISTINCT FROM $6
      OR receipt.consent_granted IS DISTINCT FROM $7
    THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_healthkit_consent_replay_receipt r
    WHERE r.event_id=$2)
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_RECEIPT_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.athlete_id=$1 AND e.kind='tenant_erased')
    THEN RETURN 'already_applied_by_erasure'; END IF;
    RAISE EXCEPTION 'RESTORE_HEALTHKIT_TENANT_ERASED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_TENANT_UNKNOWN'; END IF;
  SELECT * INTO head FROM public.consent c
    WHERE c.athlete_id=$1 AND c.kind='healthkit' FOR UPDATE;
  IF had_event THEN
    IF head.revision IS NULL OR head.revision<$6
    THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_STATE_CONFLICT'; END IF;
    expected_granted:=$7;
    expected_revision:=$6;
    FOR later IN SELECT e.* FROM public.restore_suppression_event e
      WHERE e.athlete_id=$1 AND e.kind='healthkit_consent_transition'
        AND e.consent_revision>$6 AND e.consent_revision<=head.revision
      ORDER BY e.consent_revision
    LOOP
      IF later.consent_previous_revision IS DISTINCT FROM expected_revision
        OR later.consent_previous_granted IS DISTINCT FROM expected_granted
        OR NOT EXISTS(SELECT 1 FROM public.restore_healthkit_consent_replay_receipt r
          WHERE r.event_id=later.event_id AND r.athlete_id=$1
            AND r.consent_revision=later.consent_revision
            AND r.consent_granted=later.consent_granted)
      THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_STATE_CONFLICT'; END IF;
      expected_revision:=later.consent_revision;
      expected_granted:=later.consent_granted;
    END LOOP;
    IF expected_revision IS DISTINCT FROM head.revision
      OR expected_granted IS DISTINCT FROM head.granted
    THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_STATE_CONFLICT'; END IF;
    RETURN 'already_applied';
  END IF;
  IF $4 IS NULL THEN
    IF head.revision IS NOT NULL THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_STATE_CONFLICT'; END IF;
  ELSIF head.revision IS DISTINCT FROM $4 OR head.granted IS DISTINCT FROM $5
  THEN RAISE EXCEPTION 'RESTORE_HEALTHKIT_STATE_CONFLICT'; END IF;
  PERFORM set_config('app.restore_healthkit_consent_event_id',$2::text,true);
  IF $4 IS NULL THEN
    INSERT INTO public.consent(athlete_id,kind,granted,revision)
      VALUES($1,'healthkit',$7,$6);
  ELSE
    UPDATE public.consent SET granted=$7,revision=$6
      WHERE athlete_id=$1 AND kind='healthkit';
  END IF;
  PERFORM set_config('app.restore_healthkit_consent_event_id','',true);
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES($1,$2,'restore:healthkit_consent:'||$2::text,'consent.changed',
      jsonb_build_object('kind','healthkit','granted',$7,'revision',$6));
  INSERT INTO public.restore_suppression_event(
    event_id,athlete_id,kind,occurred_at,consent_previous_revision,
    consent_previous_granted,consent_revision,consent_granted)
    VALUES($2,$1,'healthkit_consent_transition',$3,$4,$5,$6,$7);
  INSERT INTO public.restore_healthkit_consent_replay_receipt(
    event_id,athlete_id,occurred_at,previous_revision,previous_granted,
    consent_revision,consent_granted)
    VALUES($2,$1,$3,$4,$5,$6,$7);
  RETURN 'transitioned';
END $$;
REVOKE ALL ON FUNCTION public.replay_healthkit_consent_transition_exact(
  text,uuid,timestamptz,integer,boolean,integer,boolean) FROM PUBLIC;
