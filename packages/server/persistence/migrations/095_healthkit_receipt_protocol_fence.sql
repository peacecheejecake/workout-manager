-- Old binaries insert a receipt before touching raw data. Keep the v2 protocol
-- fence in the database when application releases change. Existing receipts are
-- historical v1 facts, never backfilled into proof of explicit registration.
ALTER TABLE public.healthkit_workout_batch_receipt
  ADD COLUMN protocol_version integer NOT NULL DEFAULT 1,
  ADD COLUMN pre_registration_historical boolean NOT NULL DEFAULT true;
ALTER TABLE public.healthkit_workout_batch_receipt
  ALTER COLUMN pre_registration_historical SET DEFAULT false;
ALTER TABLE public.healthkit_workout_batch_receipt
  ADD CONSTRAINT healthkit_receipt_protocol_supported
    CHECK (protocol_version IN (1,2)
      AND (pre_registration_historical OR protocol_version=2));

-- Ordinary runtimes cannot label new data as historical to bypass the fence.
-- The migration owner can restore authentic database backups with the original
-- marker. Portable account exports contain neither this marker nor commands.
CREATE FUNCTION public.guard_healthkit_receipt_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_name text:=pg_get_userbyid(
  (SELECT relowner FROM pg_catalog.pg_class
   WHERE oid='public.healthkit_workout_batch_receipt'::regclass));
BEGIN
  IF NEW.pre_registration_historical AND
    (TG_OP='INSERT' OR NOT OLD.pre_registration_historical)
    AND session_user IS DISTINCT FROM owner_name
  THEN RAISE EXCEPTION 'HEALTHKIT_HISTORICAL_RECEIPT_OWNER_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND
    (NEW.protocol_version IS DISTINCT FROM OLD.protocol_version OR
     NEW.pre_registration_historical IS DISTINCT FROM OLD.pre_registration_historical)
  THEN RAISE EXCEPTION 'HEALTHKIT_RECEIPT_PROTOCOL_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_healthkit_receipt_history() FROM PUBLIC;
CREATE TRIGGER healthkit_receipt_history_guard
  BEFORE INSERT OR UPDATE ON public.healthkit_workout_batch_receipt
  FOR EACH ROW EXECUTE FUNCTION public.guard_healthkit_receipt_history();
