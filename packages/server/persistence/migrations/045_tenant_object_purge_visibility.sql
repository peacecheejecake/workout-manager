-- M2-01z: the tenant object-prefix purge (044) leaves no silent stuck state.
--
-- M2-01x's independent review found two ways a purge row could stop moving without saying so.
-- Both are reproduced by `tenant-object-purge.integration.test.ts` against real PostgreSQL.
--
--   1. Refused, silently. The lease refuses a row whose tenant still has an identity account —
--      that is the over-deletion guard and it stays exactly as it is. But the refusal left no
--      trace: `attempts` 0, `last_error_code` NULL, the row due for ever. An operator looking
--      for stuck work saw nothing. Such a row is an inconsistent ledger (an erasure entry for
--      an id that still has an account), which needs a person, never a retry.
--   2. Lost, silently. `attempts` is charged when a run is leased. A run that outlives its
--      two-minute lease cannot finish (`finish` requires a live lease), so it records no code;
--      the next lease charges the next attempt. A run that is always too slow reached
--      `attempts=100` with `last_error_code` NULL and a stale lease — out of rotation with no
--      label, unlike every other dead letter (028's `DEAD_LETTER:` prefix).
--
-- What changes, all inside `lease_tenant_object_purge` (replaced in place, so its grant to the
-- worker role survives and no grant helper has to run again for this migration):
--
--   * A due, unleased row whose tenant still has an account is stamped once with
--     `INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT`. It is still not leased, `attempts` is not
--     charged (nothing was attempted) and nothing is deleted. The stamp stays until the row is
--     leased and finished — i.e. until the account is gone — or an erasure replay re-arms it.
--   * Taking over a row whose previous lease expired records `LEASE_EXPIRED` for the attempt
--     that was lost, so the lost attempt is visible while retries continue.
--   * A row whose LAST attempt (the 100th) lost its lease is dead-lettered as
--     `DEAD_LETTER:LEASE_EXPIRED` and its stale lease cleared. A CHECK makes "out of rotation
--     without a `DEAD_LETTER:` label" impossible from here on; rows already in that state are
--     labelled before the CHECK is added.
--
-- The same two prefixes the queue already uses (`DEAD_LETTER:`; the new
-- `INCONSISTENT_LEDGER:` for a state no retry can fix), so one query finds all stuck work.
--
-- Lock order. Every new statement locks tenant_object_purge rows only, through
-- `FOR UPDATE SKIP LOCKED`, and reads `identity_private.account` without a lock. So the lease
-- still never waits for anything while it holds a purge row, and erasure's order
-- (77206 → 0 → rows → the purge row last) gains no edge back. Each statement is bounded.

-- Rows already out of rotation without a label. Under 044 the only way there is a lost 100th
-- lease; any other unlabelled row keeps whatever code it had under the prefix.
UPDATE tenant_object_purge SET
  last_error_code=CASE WHEN lease_owner IS NOT NULL THEN 'DEAD_LETTER:LEASE_EXPIRED'
    ELSE 'DEAD_LETTER:'||left(coalesce(last_error_code,'TENANT_PURGE_FAILED'),88) END,
  lease_owner=NULL,lease_until=NULL
WHERE completed_at IS NULL AND attempts>=100
  AND (lease_owner IS NULL OR lease_until<=clock_timestamp())
  AND NOT coalesce(starts_with(last_error_code,'DEAD_LETTER:'),false);

-- `coalesce(…,false)`: a CHECK passes on NULL, so a bare `last_error_code LIKE …` would let
-- exactly the NULL code this is about through (the integration test measured that).
ALTER TABLE tenant_object_purge ADD CONSTRAINT tenant_object_purge_dead_letter_labelled
  CHECK (attempts<100 OR completed_at IS NOT NULL OR lease_owner IS NOT NULL
    OR coalesce(starts_with(last_error_code,'DEAD_LETTER:'),false));

-- The rows the dead-letter step looks for: out of attempts, still carrying a lease. Tiny —
-- a row is in it only between its 100th lease and the next worker run.
CREATE INDEX tenant_object_purge_final_lease ON tenant_object_purge(athlete_id)
  WHERE completed_at IS NULL AND attempts>=100 AND lease_owner IS NOT NULL;

CREATE OR REPLACE FUNCTION public.lease_tenant_object_purge(uuid,timestamptz,timestamptz)
RETURNS TABLE(athlete_id text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
DECLARE lease_duration interval:=$3-$2;
BEGIN
  IF lease_duration<=interval '0 seconds' OR lease_duration>interval '5 minutes'
  THEN RAISE EXCEPTION 'INVALID_PURGE_LEASE'; END IF;
  -- The last attempt's lease ran out before it finished: dead-letter it, labelled.
  UPDATE public.tenant_object_purge q SET last_error_code='DEAD_LETTER:LEASE_EXPIRED',
    lease_owner=NULL,lease_until=NULL
  WHERE q.athlete_id IN (
    SELECT p.athlete_id FROM public.tenant_object_purge p
    WHERE p.completed_at IS NULL AND p.attempts>=100 AND p.lease_owner IS NOT NULL
      AND p.lease_until<=database_now
    ORDER BY p.athlete_id FOR UPDATE SKIP LOCKED LIMIT 100);
  -- A row the lease below refuses because its tenant still has an account: say so, once.
  -- Not leased, not charged, nothing deleted.
  UPDATE public.tenant_object_purge q
    SET last_error_code='INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT'
  WHERE q.athlete_id IN (
    SELECT p.athlete_id FROM public.tenant_object_purge p
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND p.last_error_code IS DISTINCT FROM 'INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT'
      AND EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=p.athlete_id)
    ORDER BY p.available_at,p.athlete_id FOR UPDATE SKIP LOCKED LIMIT 100);
  RETURN QUERY WITH candidate AS (
    SELECT p.athlete_id FROM public.tenant_object_purge p
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=p.athlete_id)
      AND NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=p.athlete_id)
    ORDER BY p.available_at,p.athlete_id FOR UPDATE OF p SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE public.tenant_object_purge q SET lease_owner=$1,lease_until=database_now+lease_duration,
      attempts=q.attempts+1,
      -- Taking over an expired lease: the attempt that held it was lost, and says so.
      last_error_code=CASE WHEN q.lease_owner IS NOT NULL THEN 'LEASE_EXPIRED'
        ELSE q.last_error_code END
    FROM candidate c WHERE q.athlete_id=c.athlete_id RETURNING q.athlete_id,q.attempts
  ) SELECT * FROM changed;
END $$;
REVOKE ALL ON FUNCTION public.lease_tenant_object_purge(uuid,timestamptz,timestamptz) FROM PUBLIC;
