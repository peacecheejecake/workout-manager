-- One opaque identity for the restored database generation. This is a local
-- storage primitive only; no create command or external ledger consumes it yet.
CREATE TABLE public.restore_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid()
);
REVOKE ALL ON TABLE public.restore_generation FROM PUBLIC;
ALTER TABLE public.restore_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_generation FORCE ROW LEVEL SECURITY;
-- Unlike a policy pinned to the installing role, this follows REASSIGN OWNED
-- and a --no-owner restore. Only the current table owner passes FORCE RLS.
CREATE POLICY restore_generation_owner ON public.restore_generation
  USING (current_user = pg_catalog.pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_generation'::pg_catalog.regclass)))
  WITH CHECK (current_user = pg_catalog.pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_generation'::pg_catalog.regclass)));
INSERT INTO public.restore_generation(singleton) VALUES(true);

CREATE FUNCTION public.current_restore_generation() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT generation_id FROM public.restore_generation WHERE singleton=true
$$;
REVOKE ALL ON FUNCTION public.current_restore_generation() FROM PUBLIC;

-- The migration owner invokes this explicitly during a fenced restore. A
-- runtime role cannot execute it, even if it can read the current generation.
CREATE FUNCTION public.rotate_restore_generation() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE next_generation uuid;
BEGIN
  IF session_user <> pg_catalog.pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid='public.restore_generation'::pg_catalog.regclass)) THEN
    RAISE EXCEPTION 'RESTORE_GENERATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
  UPDATE public.restore_generation
     SET generation_id=pg_catalog.gen_random_uuid()
   WHERE singleton=true
   RETURNING generation_id INTO STRICT next_generation;
  RETURN next_generation;
END $$;
REVOKE ALL ON FUNCTION public.rotate_restore_generation() FROM PUBLIC;
