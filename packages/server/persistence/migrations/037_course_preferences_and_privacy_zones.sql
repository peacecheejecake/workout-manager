-- M2-01j keeps two per-owner things next to the course ledger: what the owner thinks of a
-- course, and where the owner does not want a course to say they have been.
--
-- Neither is course content. A favourite mark and a last-used moment never produce a
-- revision, never enter the content digest and never change what a course is; a protected
-- area is not part of any course at all. They are kept in their own tables so that is
-- structurally true rather than a rule someone has to remember.
--
-- The protected-area centre is the most sensitive coordinate this product stores — it is
-- usually where the owner lives. It never appears in a course revision's conditions, never
-- in the account export, never in a log line, and it leaves the server only in an
-- authenticated response to the owner who entered it.

-- What the owner thinks of a course. Exactly two facts, which is the whole allowlist.
CREATE TABLE course_preference (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  favourite boolean NOT NULL DEFAULT false,
  -- When the owner last opened this course. Written from the server's clock; a client
  -- cannot backdate or forward-date what it did.
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,course_id),
  -- A preference cannot outlive the course it is about. Deleting a course takes the row
  -- with it, so a deleted course leaves no trace of having been a favourite.
  FOREIGN KEY (athlete_id,course_id) REFERENCES course(athlete_id,course_id) ON DELETE CASCADE
);
CREATE INDEX course_preference_favourite
  ON course_preference(athlete_id,course_id) WHERE favourite;

ALTER TABLE course_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY course_tenant ON course_preference
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- A protected area: a circle the owner does not want their courses to describe.
CREATE TABLE course_privacy_zone (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  zone_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  center_longitude double precision NOT NULL
    CHECK (center_longitude>=-180 AND center_longitude<=180),
  center_latitude double precision NOT NULL
    CHECK (center_latitude>=-90 AND center_latitude<=90),
  -- A pin-point area protects nothing and an unbounded one removes everything, so both
  -- ends are bounded here as well as in the contract.
  radius_meters double precision NOT NULL CHECK (radius_meters>=50 AND radius_meters<=5000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,zone_id)
);

ALTER TABLE course_privacy_zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_privacy_zone FORCE ROW LEVEL SECURITY;
CREATE POLICY course_tenant ON course_privacy_zone
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- Erasure removes both before the courses they sit beside, so no protected-area centre and
-- no favourite mark outlives the account. The cascade from `course` would take the
-- preferences; the protected areas belong to no course and would not be reached by it.
--
-- The account lock is taken FIRST, before any row of this account is touched.
--
-- Every ordinary writer enters through `database.tenant`, which takes the account lock
-- SHARED (namespace 77206) as its first act and only then takes the per-tenant command lock
-- (namespace 0) and the rows. Erasure ends up at the same account lock — several links
-- further down this chain take it EXCLUSIVE, the first of them being the one migration 033
-- renamed to `erase_account_before_track_object_refs` — but it used to get there only after
-- the later links had already deleted rows, this one included. That is the opposite
-- order, and it deadlocks: erasure deletes a protected area and then waits for the account
-- lock a concurrent transaction holds shared, while that transaction takes the command lock
-- and waits for the row erasure is sitting on. Reproduced as `40P01 deadlock detected` with
-- the runtime role calling `erase_account` directly, which `migrate.ts` grants it and the
-- integration tests use.
--
-- `operations.eraseAccount` happens to take the exclusive lock in the application before it
-- calls this, which hides the problem on that one path. That is not a defence: the granted
-- function surface is the thing that has to be safe. So the order is established here, in
-- the outermost link, where it also covers every delete the inner links do afterwards:
-- account lock exclusive, then the per-tenant command lock, then rows — the same sequence
-- every other writer of these tables follows. Advisory locks are re-entrant within a
-- transaction, so the caller that already holds either of them is unaffected.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_course_preferences;
REVOKE ALL ON FUNCTION public.erase_account_before_course_preferences(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_course_preferences(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_course_preferences(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  DELETE FROM public.course_preference WHERE athlete_id=$1;
  DELETE FROM public.course_privacy_zone WHERE athlete_id=$1;
  RETURN public.erase_account_before_course_preferences($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
