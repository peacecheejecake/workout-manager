-- Owner-only replay of a future v2 course-share revocation. A v1 fact lacks
-- the original reason and audit identity, so it cannot authorize this path.
CREATE TABLE public.restore_course_share_replay_receipt (
  event_id uuid PRIMARY KEY,
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  share_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  epoch integer NOT NULL CHECK (epoch BETWEEN 1 AND 2147483646),
  course_revision integer NOT NULL CHECK (course_revision BETWEEN 1 AND 2147483646),
  reason text NOT NULL CHECK (reason IN ('owner','owner_all','zone_added','zone_removed')),
  audit_id uuid NOT NULL,
  audit_occurred_at timestamptz NOT NULL CHECK (audit_occurred_at>=occurred_at),
  UNIQUE (athlete_id,share_id),
  UNIQUE (athlete_id,audit_id)
);
REVOKE ALL ON TABLE public.restore_course_share_replay_receipt FROM PUBLIC;
ALTER TABLE public.restore_course_share_replay_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_course_share_replay_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_course_share_replay_receipt_owner
  ON public.restore_course_share_replay_receipt
  USING (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_course_share_replay_receipt'::regclass)))
  WITH CHECK (session_user=pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_course_share_replay_receipt'::regclass)));

CREATE FUNCTION public.verify_restore_course_share_replay_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_suppression_event e
    WHERE e.event_id=NEW.event_id AND e.record_version=2
      AND e.athlete_id=NEW.athlete_id AND e.kind='course_share_revoked'
      AND e.target_id=NEW.course_id AND e.course_share_id=NEW.share_id
      AND e.occurred_at=NEW.occurred_at AND e.course_share_epoch=NEW.epoch
      AND e.course_share_course_revision=NEW.course_revision
      AND e.course_share_revoke_reason=NEW.reason
      AND e.course_share_audit_id=NEW.audit_id
      AND e.course_share_audit_occurred_at=NEW.audit_occurred_at)
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_RECEIPT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_restore_course_share_replay_receipt() FROM PUBLIC;
CREATE TRIGGER restore_course_share_replay_receipt_verify
  BEFORE INSERT ON public.restore_course_share_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.verify_restore_course_share_replay_receipt();
CREATE TRIGGER restore_course_share_replay_receipt_immutable_rows
  BEFORE UPDATE OR DELETE ON public.restore_course_share_replay_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();
CREATE TRIGGER restore_course_share_replay_receipt_immutable_truncate
  BEFORE TRUNCATE ON public.restore_course_share_replay_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- The marker alone is never authority. Only this function's same-transaction
-- context allows either source trigger to skip its normal random event.
CREATE TABLE public.restore_course_share_replay_context (
  transaction_id bigint NOT NULL,
  athlete_id text NOT NULL,
  share_id uuid NOT NULL,
  event_id uuid NOT NULL,
  audit_id uuid NOT NULL,
  PRIMARY KEY (transaction_id,athlete_id,share_id)
);
REVOKE ALL ON TABLE public.restore_course_share_replay_context FROM PUBLIC;
ALTER TABLE public.restore_course_share_replay_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_course_share_replay_context FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY restore_course_share_replay_context_owner ON '
    'public.restore_course_share_replay_context TO %I '
    'USING (true) WITH CHECK (true)',current_user);
END $$;
CREATE FUNCTION public.require_course_share_replay_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.restore_course_share_replay_receipt r
    WHERE r.event_id=NEW.event_id AND r.athlete_id=NEW.athlete_id
      AND r.share_id=NEW.share_id AND r.audit_id=NEW.audit_id)
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_CONTEXT_INCOMPLETE'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.require_course_share_replay_context() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER restore_course_share_replay_context_complete
  AFTER INSERT ON public.restore_course_share_replay_context
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.require_course_share_replay_context();

-- These are SECURITY DEFINER triggers; session_user must still be the plain
-- migration owner before either skip, and the protected context must match.
CREATE OR REPLACE FUNCTION public.record_course_share_revoke_suppression_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE replay_id text:=nullif(current_setting('app.restore_course_share_event_id',true),'');
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT c.relowner FROM pg_catalog.pg_class c
   WHERE c.oid='public.restore_suppression_event'::regclass));
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'COURSE_SHARE_EVENT_TENANT_MISMATCH'; END IF;
  IF replay_id IS NOT NULL THEN
    IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
        AND (r.rolsuper OR r.rolbypassrls))
      OR NOT EXISTS(SELECT 1 FROM public.restore_course_share_replay_context c
        WHERE c.transaction_id=txid_current() AND c.athlete_id=NEW.athlete_id
          AND c.share_id=NEW.share_id AND c.event_id::text=replay_id)
    THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  INSERT INTO public.restore_course_share_revoke_pending(
    event_id,athlete_id,course_id,share_id,epoch,course_revision,occurred_at,reason,source_txid)
  VALUES(gen_random_uuid(),NEW.athlete_id,NEW.course_id,NEW.share_id,NEW.epoch,
    NEW.course_revision,NEW.revoked_at,NEW.revoke_reason,txid_current());
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_course_share_revoke_suppression_event() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.finish_course_share_revoke_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pending public.restore_course_share_revoke_pending%ROWTYPE;
DECLARE share public.course_share%ROWTYPE;
DECLARE replay_id text:=nullif(current_setting('app.restore_course_share_event_id',true),'');
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT c.relowner FROM pg_catalog.pg_class c
   WHERE c.oid='public.restore_suppression_event'::regclass));
BEGIN
  IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RAISE EXCEPTION 'COURSE_SHARE_AUDIT_TENANT_MISMATCH'; END IF;
  IF replay_id IS NOT NULL THEN
    IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
        AND (r.rolsuper OR r.rolbypassrls))
      OR NOT EXISTS(SELECT 1 FROM public.restore_course_share_replay_context c
        WHERE c.transaction_id=txid_current() AND c.athlete_id=NEW.athlete_id
          AND c.share_id=NEW.share_id AND c.audit_id=NEW.audit_id
          AND c.event_id::text=replay_id)
    THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_OWNER_REQUIRED'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO pending FROM public.restore_course_share_revoke_pending p
    WHERE p.athlete_id=NEW.athlete_id AND p.share_id=NEW.share_id
      AND p.source_txid=txid_current() FOR UPDATE;
  SELECT * INTO share FROM public.course_share s
    WHERE s.athlete_id=NEW.athlete_id AND s.share_id=NEW.share_id FOR UPDATE;
  IF pending.event_id IS NULL OR share.share_id IS NULL
    OR NEW.course_id IS DISTINCT FROM pending.course_id
    OR NEW.reason IS DISTINCT FROM pending.reason
    OR NEW.occurred_at<pending.occurred_at
    OR share.course_id IS DISTINCT FROM pending.course_id
    OR share.course_revision IS DISTINCT FROM pending.course_revision
    OR share.epoch IS DISTINCT FROM pending.epoch
    OR share.state IS DISTINCT FROM 'revoked'
    OR share.revoke_reason IS DISTINCT FROM pending.reason
    OR share.revoked_at IS DISTINCT FROM pending.occurred_at
  THEN RAISE EXCEPTION 'COURSE_SHARE_AUDIT_SOURCE_MISMATCH'; END IF;
  INSERT INTO public.restore_suppression_event(
    event_id,record_version,athlete_id,kind,target_id,course_share_id,course_share_epoch,
    course_share_course_revision,occurred_at,course_share_revoke_reason,
    course_share_audit_id,course_share_audit_occurred_at)
  VALUES(pending.event_id,2,pending.athlete_id,'course_share_revoked',pending.course_id,
    pending.share_id,pending.epoch,pending.course_revision,pending.occurred_at,
    pending.reason,NEW.audit_id,NEW.occurred_at);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.finish_course_share_revoke_provenance() FROM PUBLIC;

CREATE FUNCTION public.replay_course_share_revoke_exact(
  text,uuid,uuid,uuid,timestamptz,integer,integer,text,uuid,timestamptz)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT p.proowner FROM pg_catalog.pg_proc p
   WHERE p.oid='public.replay_course_share_revoke_exact(text,uuid,uuid,uuid,timestamptz,integer,integer,text,uuid,timestamptz)'::regprocedure));
DECLARE caller_tenant text:=current_setting('app.athlete_id',true);
DECLARE existing public.restore_suppression_event%ROWTYPE;
DECLARE receipt public.restore_course_share_replay_receipt%ROWTYPE;
DECLARE share public.course_share%ROWTYPE;
DECLARE head public.course%ROWTYPE;
DECLARE other_tenant text;
DECLARE had_event boolean;
BEGIN
  IF session_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM owner_name
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=owner_name
      AND (r.rolsuper OR r.rolbypassrls))
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_OWNER_REQUIRED'; END IF;
  IF $1 IS NULL OR $1 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL
    OR $5>clock_timestamp() OR $6 IS NULL OR $6 NOT BETWEEN 1 AND 2147483646
    OR $7 IS NULL OR $7 NOT BETWEEN 1 AND 2147483646
    OR $8 IS NULL OR $8 NOT IN ('owner','owner_all','zone_added','zone_removed')
    OR $9 IS NULL OR $10 IS NULL OR $10<$5 OR $10>clock_timestamp()
    OR $1 IS DISTINCT FROM nullif(caller_tenant,'')
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  SELECT * INTO existing FROM public.restore_suppression_event e
    WHERE e.event_id=$4 OR (e.athlete_id=$1 AND e.kind='course_share_revoked'
      AND e.course_share_id=$3) OR (e.athlete_id=$1 AND e.course_share_audit_id=$9)
    FOR UPDATE;
  had_event:=FOUND;
  IF had_event AND (existing.event_id IS DISTINCT FROM $4
    OR existing.record_version IS DISTINCT FROM 2
    OR existing.athlete_id IS DISTINCT FROM $1
    OR existing.kind IS DISTINCT FROM 'course_share_revoked'
    OR existing.target_id IS DISTINCT FROM $2
    OR existing.course_share_id IS DISTINCT FROM $3
    OR existing.occurred_at IS DISTINCT FROM $5
    OR existing.course_share_epoch IS DISTINCT FROM $6
    OR existing.course_share_course_revision IS DISTINCT FROM $7
    OR existing.course_share_revoke_reason IS DISTINCT FROM $8
    OR existing.course_share_audit_id IS DISTINCT FROM $9
    OR existing.course_share_audit_occurred_at IS DISTINCT FROM $10
    OR EXISTS(SELECT 1 FROM public.restore_suppression_event e
      WHERE (e.event_id=$4 OR (e.athlete_id=$1 AND e.kind='course_share_revoked'
        AND e.course_share_id=$3) OR (e.athlete_id=$1 AND e.course_share_audit_id=$9))
        AND e.event_id<>existing.event_id))
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_EVENT_CONFLICT'; END IF;
  IF had_event THEN
    SELECT * INTO receipt FROM public.restore_course_share_replay_receipt r
      WHERE r.event_id=$4;
    IF NOT FOUND OR receipt.athlete_id IS DISTINCT FROM $1
      OR receipt.course_id IS DISTINCT FROM $2 OR receipt.share_id IS DISTINCT FROM $3
      OR receipt.occurred_at IS DISTINCT FROM $5 OR receipt.epoch IS DISTINCT FROM $6
      OR receipt.course_revision IS DISTINCT FROM $7 OR receipt.reason IS DISTINCT FROM $8
      OR receipt.audit_id IS DISTINCT FROM $9
      OR receipt.audit_occurred_at IS DISTINCT FROM $10
    THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_RECEIPT_MISSING'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.restore_course_share_replay_receipt r
    WHERE r.event_id=$4 OR (r.athlete_id=$1 AND r.share_id=$3)
      OR (r.athlete_id=$1 AND r.audit_id=$9))
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_RECEIPT_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
  THEN
    IF had_event AND EXISTS(SELECT 1 FROM public.restore_exact_replay_receipt r
      JOIN public.restore_suppression_event e ON e.event_id=r.event_id
      WHERE r.athlete_id=$1 AND r.kind='tenant_erased'
        AND e.athlete_id=$1 AND e.kind='tenant_erased')
    THEN RETURN 'already_applied_by_erasure'; END IF;
    RAISE EXCEPTION 'RESTORE_COURSE_SHARE_TENANT_ERASED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_TENANT_UNKNOWN'; END IF;
  SELECT * INTO head FROM public.course c
    WHERE c.athlete_id=$1 AND c.course_id=$2 FOR UPDATE;
  SELECT * INTO share FROM public.course_share s
    WHERE s.athlete_id=$1 AND s.share_id=$3 FOR UPDATE;
  IF had_event THEN
    IF share.share_id IS NULL OR share.course_id IS DISTINCT FROM $2
      OR share.course_revision IS DISTINCT FROM $7 OR share.epoch IS DISTINCT FROM $6
      OR share.state IS DISTINCT FROM 'revoked'
      OR share.revoke_reason IS DISTINCT FROM $8 OR share.revoked_at IS DISTINCT FROM $5
      OR head.course_id IS NULL OR head.status IS DISTINCT FROM 'available'
      OR NOT EXISTS(SELECT 1 FROM public.course_share_audit a
        WHERE a.athlete_id=$1 AND a.audit_id=$9 AND a.share_id=$3
          AND a.course_id=$2 AND a.action='revoked' AND a.reason=$8
          AND a.occurred_at=$10)
    THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_STATE_CONFLICT'; END IF;
    RETURN 'already_applied';
  END IF;
  -- FORCE RLS on course and course_share requires the other tenant's GUC.
  FOR other_tenant IN SELECT a.athlete_id::text FROM identity_private.account a
    WHERE a.athlete_id::text<>$1 ORDER BY a.athlete_id
  LOOP
    PERFORM set_config('app.athlete_id',other_tenant,true);
    IF EXISTS(SELECT 1 FROM public.course c
      WHERE c.athlete_id=other_tenant AND c.course_id=$2)
      OR EXISTS(SELECT 1 FROM public.course_share s
        WHERE s.athlete_id=other_tenant AND s.share_id=$3)
    THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_FOREIGN_TARGET'; END IF;
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);
  IF head.course_id IS NULL OR share.share_id IS NULL
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_ABSENT_UNSUPPORTED'; END IF;
  IF head.status IS DISTINCT FROM 'available' OR share.course_id IS DISTINCT FROM $2
    OR share.course_revision IS DISTINCT FROM $7 OR share.epoch IS DISTINCT FROM $6
    OR share.state IS DISTINCT FROM 'active' OR share.revoke_reason IS NOT NULL
    OR share.revoked_at IS NOT NULL OR share.created_at>$5
    OR EXISTS(SELECT 1 FROM public.course_share_audit a
      WHERE a.athlete_id=$1 AND (a.audit_id=$9 OR (a.share_id=$3 AND a.action='revoked')))
  THEN RAISE EXCEPTION 'RESTORE_COURSE_SHARE_STATE_CONFLICT'; END IF;
  INSERT INTO public.restore_course_share_replay_context(
    transaction_id,athlete_id,share_id,event_id,audit_id)
    VALUES(txid_current(),$1,$3,$4,$9);
  PERFORM set_config('app.restore_course_share_event_id',$4::text,true);
  UPDATE public.course_share SET state='revoked',revoked_at=$5,revoke_reason=$8
    WHERE athlete_id=$1 AND share_id=$3;
  INSERT INTO public.course_share_audit(
    athlete_id,audit_id,share_id,course_id,action,reason,occurred_at)
    VALUES($1,$9,$3,$2,'revoked',$8,$10);
  PERFORM set_config('app.restore_course_share_event_id','',true);
  INSERT INTO public.restore_suppression_event(
    event_id,record_version,athlete_id,kind,target_id,course_share_id,
    course_share_epoch,course_share_course_revision,occurred_at,
    course_share_revoke_reason,course_share_audit_id,course_share_audit_occurred_at)
    VALUES($4,2,$1,'course_share_revoked',$2,$3,$6,$7,$5,$8,$9,$10);
  INSERT INTO public.restore_course_share_replay_receipt(
    event_id,athlete_id,course_id,share_id,occurred_at,epoch,course_revision,
    reason,audit_id,audit_occurred_at)
    VALUES($4,$1,$2,$3,$5,$6,$7,$8,$9,$10);
  DELETE FROM public.restore_course_share_replay_context c
    WHERE c.transaction_id=txid_current() AND c.athlete_id=$1
      AND c.share_id=$3 AND c.event_id=$4;
  RETURN 'revoked';
END $$;
REVOKE ALL ON FUNCTION public.replay_course_share_revoke_exact(
  text,uuid,uuid,uuid,timestamptz,integer,integer,text,uuid,timestamptz) FROM PUBLIC;
