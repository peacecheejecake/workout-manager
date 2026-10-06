-- CLOSED-only restore processing control preparation; no admission or reopen authority.
-- Global advisory namespace (77210,1) is reserved for this control.
-- Existing runtime writers are not connected by this migration.
CREATE TABLE public.restore_processing_admission (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 state text NOT NULL DEFAULT 'CLOSED' CHECK(state='CLOSED'),
 local_revision bigint NOT NULL DEFAULT 1 CHECK(local_revision>=1),
 generation_id uuid NOT NULL,
 target_nonce uuid,
 target_incarnation uuid,
 CHECK((target_nonce IS NULL)=(target_incarnation IS NULL))
);
REVOKE ALL ON public.restore_processing_admission FROM PUBLIC;
ALTER TABLE public.restore_processing_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_processing_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_processing_owner_read ON public.restore_processing_admission FOR SELECT
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass)));
CREATE POLICY restore_processing_owner_insert ON public.restore_processing_admission FOR INSERT
 WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass))
 AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass)));
CREATE POLICY restore_processing_owner_update ON public.restore_processing_admission FOR UPDATE
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass))
 AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass)))
 WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass))
 AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass)));
CREATE POLICY restore_processing_owner_delete ON public.restore_processing_admission FOR DELETE
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass))
 AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass)));
INSERT INTO public.restore_processing_admission(singleton,generation_id)
 SELECT true,generation_id FROM public.restore_generation WHERE singleton;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.restore_processing_admission)<>1
 THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CONTROL_MISSING'; END IF;
END $$;

CREATE TABLE public.restore_processing_close_receipt (
 command_id uuid PRIMARY KEY,
 expected_revision bigint NOT NULL CHECK(expected_revision>=1),
 result_revision bigint NOT NULL CHECK(result_revision=expected_revision+1),
 generation_id uuid NOT NULL,
 target_nonce uuid,
 target_incarnation uuid,
 CHECK((target_nonce IS NULL)=(target_incarnation IS NULL))
);
REVOKE ALL ON public.restore_processing_close_receipt FROM PUBLIC;
ALTER TABLE public.restore_processing_close_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_processing_close_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_processing_close_receipt_owner ON public.restore_processing_close_receipt
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_close_receipt'::regclass))
 AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_close_receipt'::regclass)))
 WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_close_receipt'::regclass))
 AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_close_receipt'::regclass)));
CREATE FUNCTION public.guard_restore_processing_close_receipt() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 RAISE EXCEPTION 'IMMUTABLE_RESTORE_PROCESSING_CLOSE_RECEIPT'; END $$;
REVOKE ALL ON FUNCTION public.guard_restore_processing_close_receipt() FROM PUBLIC;
CREATE TRIGGER restore_processing_close_receipt_immutable BEFORE UPDATE OR DELETE ON public.restore_processing_close_receipt
 FOR EACH ROW EXECUTE FUNCTION public.guard_restore_processing_close_receipt();
CREATE TRIGGER restore_processing_close_receipt_no_truncate BEFORE TRUNCATE ON public.restore_processing_close_receipt
 FOR EACH STATEMENT EXECUTE FUNCTION public.guard_restore_processing_close_receipt();

CREATE FUNCTION public.lock_restore_processing_shared() RETURNS void
 LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
 SELECT pg_advisory_xact_lock_shared(77210,1)
$$;
REVOKE ALL ON FUNCTION public.lock_restore_processing_shared() FROM PUBLIC;

CREATE FUNCTION public.read_restore_processing_admission() RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.restore_processing_admission%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 SELECT * INTO r FROM public.restore_processing_admission WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CONTROL_MISSING'; END IF;
 RETURN jsonb_build_object('state',r.state,'localRevision',r.local_revision::text,
  'generationId',r.generation_id,'targetNonce',r.target_nonce,'targetIncarnation',r.target_incarnation,
  'admissionAllowed',false,'targetAttested',false);
END $$;
REVOKE ALL ON FUNCTION public.read_restore_processing_admission() FROM PUBLIC;

CREATE FUNCTION public.require_restore_processing_admission() RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r jsonb;
BEGIN
 r:=public.read_restore_processing_admission();
 -- State can only be CLOSED in this primitive; GUCs/client flags cannot create admission.
 RAISE EXCEPTION 'RESTORE_PROCESSING_CLOSED';
END $$;
REVOKE ALL ON FUNCTION public.require_restore_processing_admission() FROM PUBLIC;

CREATE FUNCTION public.assert_restore_processing_closed(expected_revision bigint,
 expected_nonce uuid DEFAULT NULL,expected_incarnation uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.restore_processing_admission%ROWTYPE;
BEGIN
 IF session_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass))
 THEN RAISE EXCEPTION 'RESTORE_PROCESSING_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(77210,1);
 SELECT * INTO r FROM public.restore_processing_admission WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CONTROL_MISSING'; END IF;
 IF expected_revision IS NULL OR expected_revision<1
  OR r.local_revision IS DISTINCT FROM expected_revision OR r.target_nonce IS DISTINCT FROM expected_nonce
  OR r.target_incarnation IS DISTINCT FROM expected_incarnation
 THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CONTROL_CONFLICT'; END IF;
 RETURN public.read_restore_processing_admission();
END $$;
REVOKE ALL ON FUNCTION public.assert_restore_processing_closed(bigint,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.close_restore_processing_exact(expected_revision bigint,command_id uuid,
 target_nonce uuid DEFAULT NULL,target_incarnation uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.restore_processing_admission%ROWTYPE; prior public.restore_processing_close_receipt%ROWTYPE;
BEGIN
 IF session_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass))
 THEN RAISE EXCEPTION 'RESTORE_PROCESSING_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF command_id IS NULL OR expected_revision IS NULL OR expected_revision<1
  OR (target_nonce IS NULL)<>(target_incarnation IS NULL)
 THEN RAISE EXCEPTION 'INVALID_RESTORE_PROCESSING_CLOSE'; END IF;
 PERFORM pg_advisory_xact_lock(77210,1);
 SELECT * INTO r FROM public.restore_processing_admission WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CONTROL_MISSING'; END IF;
 SELECT * INTO prior FROM public.restore_processing_close_receipt q WHERE q.command_id=$2;
 IF FOUND THEN
  IF prior.expected_revision IS DISTINCT FROM $1 OR prior.target_nonce IS DISTINCT FROM $3
   OR prior.target_incarnation IS DISTINCT FROM $4
  THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CLOSE_CONFLICT'; END IF;
  RETURN jsonb_build_object('state','CLOSED','localRevision',prior.result_revision::text,
   'generationId',prior.generation_id,'targetNonce',prior.target_nonce,'targetIncarnation',prior.target_incarnation,
   'admissionAllowed',false,'targetAttested',false);
 END IF;
 IF r.local_revision IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'RESTORE_PROCESSING_CONTROL_CONFLICT'; END IF;
 IF r.local_revision=9223372036854775807 THEN RAISE EXCEPTION 'RESTORE_PROCESSING_REVISION_EXHAUSTED'; END IF;
 UPDATE public.restore_processing_admission SET local_revision=r.local_revision+1,
  generation_id=public.current_restore_generation(),target_nonce=$3,target_incarnation=$4 WHERE singleton
  RETURNING * INTO r;
 INSERT INTO public.restore_processing_close_receipt VALUES($2,$1,r.local_revision,r.generation_id,$3,$4);
 RETURN public.read_restore_processing_admission();
END $$;
REVOKE ALL ON FUNCTION public.close_restore_processing_exact(bigint,uuid,uuid,uuid) FROM PUBLIC;
