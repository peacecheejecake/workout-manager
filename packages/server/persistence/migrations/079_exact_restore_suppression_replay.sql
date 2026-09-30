-- Owner-only, offline restore primitives for two event kinds. The caller must
-- authenticate the complete backup-bound chain before entering this transaction.
-- These functions do not establish a tail fence or reopen runtime access.

-- A retry is accepted only for an event committed by this exact replay path.
-- An event that was already in a backup has no receipt and is deliberately
-- refused; the trusted snapshot/LSN fence should exclude it from the tail.
CREATE TABLE public.restore_exact_replay_receipt (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('tenant_erased','course_deleted')),
  target_id uuid,
  occurred_at timestamptz NOT NULL,
  CHECK ((kind='tenant_erased' AND target_id IS NULL)
    OR (kind='course_deleted' AND target_id IS NOT NULL))
);
REVOKE ALL ON TABLE public.restore_exact_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_exact_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_exact_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_exact_replay_receipt_owner ON public.restore_exact_replay_receipt
  USING (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
      WHERE oid='public.restore_exact_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
      WHERE oid='public.restore_exact_replay_receipt'::regclass)));
-- Do not use a foreign key to the immutable event table: PostgreSQL rejects
-- TRUNCATE on an FK target before its immutable TRUNCATE trigger can report the
-- established IMMUTABLE_RESTORE_SUPPRESSION_EVENT failure. Compare the complete
-- receipt identity at insertion instead; both rows are created in one transaction.
CREATE FUNCTION public.verify_restore_exact_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.athlete_id=NEW.athlete_id
      AND e.kind=NEW.kind AND e.target_id IS NOT DISTINCT FROM NEW.target_id
      AND e.occurred_at=NEW.occurred_at)
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_exact_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_exact_replay_receipt_verify
  BEFORE INSERT ON public.restore_exact_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_exact_replay_receipt();
CREATE TRIGGER restore_exact_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_exact_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_exact_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_exact_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- The normal erasure path inserts tenant_erasure without an explicit timestamp.
-- During exact owner replay only, copy the authenticated source time into that
-- row before the existing AFTER INSERT event trigger observes it. Session role
-- comparison is essential: a runtime role can set a custom GUC but cannot become
-- the table/function owner through a SECURITY DEFINER call.
CREATE FUNCTION public.restore_replay_erasure_time() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_replay_event_id',true),'');
DECLARE replay_time text:=nullif(current_setting('app.restore_replay_occurred_at',true),'');
BEGIN
  IF replay_id IS NULL AND replay_time IS NULL THEN RETURN NEW; END IF;
  IF replay_id IS NULL OR replay_time IS NULL
    OR session_user IS DISTINCT FROM pg_get_userbyid(
      (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID))
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_OWNER_REQUIRED'; END IF;
  NEW.erased_at:=replay_time::timestamptz;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.restore_replay_erasure_time() FROM PUBLIC;
CREATE TRIGGER restore_replay_erasure_time
  BEFORE INSERT ON public.tenant_erasure FOR EACH ROW
  EXECUTE FUNCTION public.restore_replay_erasure_time();

CREATE OR REPLACE FUNCTION public.record_tenant_erasure_suppression_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_replay_event_id',true),'');
DECLARE replay_time text:=nullif(current_setting('app.restore_replay_occurred_at',true),'');
BEGIN
  IF replay_id IS NOT NULL OR replay_time IS NOT NULL THEN
    IF replay_id IS NULL OR replay_time IS NULL
      OR session_user IS DISTINCT FROM pg_get_userbyid(
        (SELECT c.relowner FROM pg_catalog.pg_class c
          WHERE c.oid='public.restore_suppression_event'::regclass))
      OR NEW.erased_at IS DISTINCT FROM replay_time::timestamptz
    THEN RAISE EXCEPTION 'RESTORE_REPLAY_OWNER_REQUIRED'; END IF;
    INSERT INTO public.restore_suppression_event(event_id,athlete_id,occurred_at)
      VALUES(replay_id::uuid,NEW.athlete_id,NEW.erased_at);
  ELSE
    INSERT INTO public.restore_suppression_event(athlete_id,occurred_at)
      VALUES(NEW.athlete_id,NEW.erased_at);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.record_tenant_erasure_suppression_event() FROM PUBLIC;

CREATE FUNCTION public.replay_tenant_erasure_exact(text,uuid,timestamptz) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid='public.replay_tenant_erasure_exact(text,uuid,timestamptz)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_exact_replay_receipt%ROWTYPE;
DECLARE erased_at timestamptz;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $3 IS NULL OR $3>clock_timestamp()
    OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event
    WHERE event_id=$2 OR (athlete_id=$1 AND kind='tenant_erased') FOR UPDATE;
  IF FOUND THEN
    IF existing.event_id IS DISTINCT FROM $2 OR existing.kind IS DISTINCT FROM 'tenant_erased'
      OR existing.athlete_id IS DISTINCT FROM $1 OR existing.occurred_at IS DISTINCT FROM $3
      OR existing.target_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.restore_suppression_event
        WHERE (event_id=$2 OR (athlete_id=$1 AND kind='tenant_erased'))
          AND event_id<>existing.event_id)
    THEN RAISE EXCEPTION 'RESTORE_REPLAY_EVENT_CONFLICT'; END IF;
    SELECT * INTO receipt FROM public.restore_exact_replay_receipt r WHERE r.event_id=$2;
    IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.kind IS DISTINCT FROM 'tenant_erased'
      OR receipt.target_id IS NOT NULL OR receipt.occurred_at IS DISTINCT FROM $3
    THEN RAISE EXCEPTION 'RESTORE_REPLAY_RECEIPT_MISSING'; END IF;
    SELECT e.erased_at INTO erased_at FROM public.tenant_erasure e WHERE e.athlete_id=$1;
    IF erased_at IS DISTINCT FROM $3
      OR EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
      OR EXISTS(SELECT 1 FROM identity_private.session s WHERE s.athlete_id::text=$1)
    THEN RAISE EXCEPTION 'RESTORE_REPLAY_STATE_CONFLICT'; END IF;
    RETURN 'already_applied';
  END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_STATE_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r WHERE r.event_id=$2)
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_RECEIPT_CONFLICT'; END IF;
  PERFORM set_config('app.restore_replay_event_id',$2::text,true);
  PERFORM set_config('app.restore_replay_occurred_at',$3::text,true);
  SELECT public.erase_account($1) INTO erased_at;
  PERFORM set_config('app.restore_replay_event_id','',true);
  PERFORM set_config('app.restore_replay_occurred_at','',true);
  IF erased_at IS DISTINCT FROM $3 OR NOT EXISTS(
    SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=$2 AND e.athlete_id=$1 AND e.kind='tenant_erased'
      AND e.occurred_at=$3 AND e.target_id IS NULL)
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_STATE_CONFLICT'; END IF;
  INSERT INTO public.restore_exact_replay_receipt(event_id,athlete_id,kind,occurred_at)
    VALUES($2,$1,'tenant_erased',$3);
  RETURN 'erased';
END $$;
REVOKE ALL ON FUNCTION public.replay_tenant_erasure_exact(text,uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.replay_course_deletion_exact(text,uuid,uuid,timestamptz) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid='public.replay_course_deletion_exact(text,uuid,uuid,timestamptz)'::regprocedure));
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_exact_replay_receipt%ROWTYPE;
DECLARE state text;
DECLARE had_event boolean;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $4>clock_timestamp()
    OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event
    WHERE event_id=$3 OR (athlete_id=$1 AND kind='course_deleted' AND target_id=$2) FOR UPDATE;
  had_event:=FOUND;
  IF FOUND AND (existing.event_id IS DISTINCT FROM $3
    OR existing.kind IS DISTINCT FROM 'course_deleted'
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.target_id IS DISTINCT FROM $2
    OR existing.occurred_at IS DISTINCT FROM $4
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event
      WHERE (event_id=$3 OR (athlete_id=$1 AND kind='course_deleted' AND target_id=$2))
        AND event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_exact_replay_receipt r WHERE r.event_id=$3;
    IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.kind IS DISTINCT FROM 'course_deleted'
      OR receipt.target_id IS DISTINCT FROM $2 OR receipt.occurred_at IS DISTINCT FROM $4
    THEN RAISE EXCEPTION 'RESTORE_REPLAY_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r WHERE r.event_id=$3)
  THEN RAISE EXCEPTION 'RESTORE_REPLAY_RECEIPT_CONFLICT'; END IF;
  -- A later exact tenant erasure removed course_deletion as part of account
  -- purging. On whole-chain retry, the original course event and its receipt
  -- still prove the earlier replay; the erasure now subsumes its state.
  IF had_event AND EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1) THEN
    IF NOT EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.kind='tenant_erased' AND e.athlete_id=$1)
    THEN RAISE EXCEPTION 'RESTORE_REPLAY_STATE_CONFLICT'; END IF;
    RETURN 'already_applied_by_erasure';
  END IF;
  SELECT public.replay_course_deletion($1,$2,$4) INTO state;
  IF NOT had_event THEN
    INSERT INTO public.restore_suppression_event(event_id,athlete_id,kind,target_id,occurred_at)
      VALUES($3,$1,'course_deleted',$2,$4);
    INSERT INTO public.restore_exact_replay_receipt(event_id,athlete_id,kind,target_id,occurred_at)
      VALUES($3,$1,'course_deleted',$2,$4);
  END IF;
  RETURN state;
END $$;
REVOKE ALL ON FUNCTION public.replay_course_deletion_exact(text,uuid,uuid,timestamptz) FROM PUBLIC;
