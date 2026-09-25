-- M2-01as: a lifetime budget of links per place (054, after M2-01ap's 053).
--
-- The re-identification review of M2-01k-o showed that links cut against one protected area
-- narrow its home down as they accumulate, whatever the share circle's secret offset: each
-- link's cut end and heading add a little, and the estimators that read headings do not stop
-- improving with N. M2-01as widens the share circle (offset ≤ 1 · S, radius 2 · S), cuts every
-- link a further 2.5 · S along its path (the domain) and bounds how many links may EVER be cut
-- against one place — 10 (this migration; user decision 2026-09-26). The attack suite passes
-- up to that bound and is not claimed past it.
--
-- "Ever" is the point. A revoked, expired or restored-away link was still seen, so nothing
-- that ends a link gives its place back, and a protected area deleted and made again over the
-- same place — with a fresh offset, which is worse, not better — starts where the old one
-- stopped. So the count is kept per place, not per link row and not per live area:
--
--   * `course_share_area_budget` — one row per protected area a link was ever cut against:
--     the area's id, a coarse cell of its centre (the 0.01° grid square it lies in, about a
--     kilometre), its share reach (3 · max(r, 200 m)) rounded UP to 100 m, and how many links
--     were cut against it. No
--     centre, no name, no time. The row is not tied to the area by a foreign key: deleting the
--     area leaves it behind as the place's tombstone, which is exactly what it is for.
--   * `claim_course_share_budget(zone_ids)` — the one writer. It takes one link's worth from
--     each area the link was cut against, all or nothing, and refuses (false) when any of them
--     has none left. An area's row is made on its first link, starting at the highest count of
--     every row of the account whose place the new area's links could describe (another live
--     area, or a deleted one's tombstone). Each area's share circles reach 3 · S from its
--     centre (offset 1 · S + radius 2 · S), so a new area inherits from every row whose reach
--     meets its own: the new centre within 3 · S_new + 3 · S_old of the old centre's cell.
--     (First written with the new area's own radius — review r1 finding 5 — then with the old
--     area's radius — review r2 finding 4; both missed areas made over the same home.) The
--     match is conservative — it may inherit from a neighbour that did not overlap, never miss
--     one that did. After that first link each area counts on its own.
--   * The bound (10) lives here as well as in the contract; the runtime role cannot pass
--     another one, cannot write a row, and cannot lower a count (a trigger refuses any UPDATE
--     that is not an increase of the count alone, and any DELETE but the owner's erasure).
--   * `replay_course_share_budget`, for the restore only (no grant): a restore brings back the
--     counts of the backup, while the links made after it were seen. The drill captures the
--     table outside the database like the other ledgers and replays it before runtime access;
--     a replayed count only ever raises a restored one, and a row whose area did not survive
--     the restore stays as a tombstone.
--   * Erasure removes the rows (the wrapper at the end): which places an account shared from
--     is the account's own history.
--
-- Backfill: links made before this migration (sharing is off by default and was off in every
-- deployment) are counted against every protected area the link names — `zone_ids` holds all
-- of the account's areas at the time, an over-count, which errs toward refusing. Links the
-- reaper already removed, and areas already deleted, cannot be counted; recorded in M2-01as.
--
-- Lock order is the repository's: account lock (77206) → per-tenant command lock (0) → rows.

CREATE TABLE course_share_area_budget (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  zone_id uuid NOT NULL,
  -- floor(latitude · 100) and floor(longitude · 100): the 0.01° grid square of the centre.
  cell_latitude integer NOT NULL CHECK (cell_latitude BETWEEN -9000 AND 9000),
  cell_longitude integer NOT NULL CHECK (cell_longitude BETWEEN -18000 AND 18000),
  -- The area's share reach, 3 · max(r, 200 m) rounded up to 100 m: how far from its centre its
  -- share circles (offset 1 · S + radius 2 · S) could reach, and so how far its links describe.
  reach_meters integer NOT NULL
    CHECK (reach_meters BETWEEN 600 AND 15000 AND reach_meters%100=0),
  links_cut integer NOT NULL CHECK (links_cut BETWEEN 0 AND 1000000),
  PRIMARY KEY (athlete_id,zone_id)
);
ALTER TABLE course_share_area_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_share_area_budget FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE course_share_area_budget FROM PUBLIC;
CREATE POLICY course_tenant ON course_share_area_budget
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));

-- A count only ever goes up, and nothing else about a row ever changes. Only the owner (the
-- erasure) removes one.
CREATE FUNCTION course_share_area_budget_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF TG_OP='DELETE' THEN
    IF current_user=(SELECT pg_catalog.pg_get_userbyid(c.relowner)
      FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'IMMUTABLE_SHARE_AREA_BUDGET';
  END IF;
  IF (NEW.athlete_id,NEW.zone_id,NEW.cell_latitude,NEW.cell_longitude,NEW.reach_meters)
    IS DISTINCT FROM (OLD.athlete_id,OLD.zone_id,OLD.cell_latitude,OLD.cell_longitude,
      OLD.reach_meters)
    OR NEW.links_cut<OLD.links_cut
  THEN RAISE EXCEPTION 'IMMUTABLE_SHARE_AREA_BUDGET'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION course_share_area_budget_monotonic() FROM PUBLIC;
CREATE TRIGGER course_share_area_budget_monotonic BEFORE UPDATE OR DELETE
  ON course_share_area_budget FOR EACH ROW EXECUTE FUNCTION course_share_area_budget_monotonic();

-- Metres from a centre to the nearest point of a 0.01° cell — a lower bound on the true
-- (great-circle) distance to any point of the cell whenever that distance is within $5 metres,
-- which is all the claim asks. The latitude gap alone never exceeds the true distance; the
-- longitude gap is scaled by the cosine at the most polar latitude any path of length ≤ $5
-- between them can reach (the more polar of the centre and the cell's edges, plus $5), and
-- measured the short way round the antimeridian. The review r2 of M2-01as found the first
-- version (cosine at the centre's latitude + 0.02°) overstated the distance by ~30 m at 78°
-- and ~485 m near 89°. No grant: used by the claim below.
CREATE FUNCTION public.course_share_cell_distance(integer,integer,double precision,
  double precision,double precision) RETURNS double precision
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH box AS (
    SELECT $1/100.0::double precision AS south,($1+1)/100.0::double precision AS north,
      $2/100.0::double precision AS west,($2+1)/100.0::double precision AS east
  ), gap AS (
    SELECT greatest(box.south-$3,0,$3-box.north) AS latitude_gap,
      CASE WHEN $4 BETWEEN box.west AND box.east THEN 0
        ELSE least(
          least(abs($4-box.west)-360*floor(abs($4-box.west)/360),
            360-(abs($4-box.west)-360*floor(abs($4-box.west)/360))),
          least(abs($4-box.east)-360*floor(abs($4-box.east)/360),
            360-(abs($4-box.east)-360*floor(abs($4-box.east)/360))))
      END AS longitude_gap
    FROM box
  )
  SELECT (6371008.8*pi()/180)*sqrt(latitude_gap^2
    +(cos(radians(least(90,greatest(abs($3),abs($1/100.0),abs(($1+1)/100.0))
      +greatest($5,0)/(6371008.8*pi()/180))))*longitude_gap)^2) FROM gap
$$;
REVOKE ALL ON FUNCTION public.course_share_cell_distance(integer,integer,double precision,
  double precision,double precision) FROM PUBLIC;

-- Take one link's worth from every protected area the link was cut against, all or nothing.
-- `true` when every area had budget left (each is now one lower), `false` when any had none
-- (nothing is taken; the caller refuses the link). The session's tenant is the only tenant.
CREATE FUNCTION public.claim_course_share_budget(uuid[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE lifetime constant integer:=10;
DECLARE wanted uuid;
DECLARE area record;
DECLARE used integer;
DECLARE exhausted boolean:=false;
BEGIN
  -- 20 is `courseLimits.privacyZonesPerTenant`: a link names at most every area of its
  -- account (the upgrade test checks the two stay equal).
  IF tenant IS NULL OR $1 IS NULL OR cardinality($1) NOT BETWEEN 1 AND 20
    OR array_position($1,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_SHARE_BUDGET_CLAIM';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
  FOR wanted IN SELECT DISTINCT u FROM unnest($1) AS u ORDER BY u LOOP
    SELECT z.center_longitude,z.center_latitude,z.radius_meters INTO area
      FROM public.course_privacy_zone z WHERE z.athlete_id=tenant AND z.zone_id=wanted;
    IF NOT FOUND THEN RAISE EXCEPTION 'COURSE_SHARE_AREA_UNKNOWN'; END IF;
    SELECT b.links_cut INTO used FROM public.course_share_area_budget b
      WHERE b.athlete_id=tenant AND b.zone_id=wanted FOR UPDATE;
    IF NOT FOUND THEN
      -- The area's first link: it starts where any place whose share reach meets its own
      -- stands — both reaches, 3 · S_new + 3 · S_old (offset 1 · S + radius 2 · S each, S =
      -- max(r, 200 m)). Matching only the new reach against the old radius (review r2
      -- finding 4) missed ~6 % of large old areas when a new one was made over the home.
      SELECT coalesce(max(b.links_cut),0) INTO used FROM public.course_share_area_budget b
        WHERE b.athlete_id=tenant AND b.zone_id<>wanted
          AND public.course_share_cell_distance(b.cell_latitude,b.cell_longitude,
            area.center_latitude,area.center_longitude,
            3*greatest(area.radius_meters,200)+b.reach_meters+1)
            <=3*greatest(area.radius_meters,200)+b.reach_meters+1;
      INSERT INTO public.course_share_area_budget(athlete_id,zone_id,cell_latitude,
          cell_longitude,reach_meters,links_cut)
        VALUES(tenant,wanted,floor(area.center_latitude*100)::integer,
          floor(area.center_longitude*100)::integer,
          (ceil(3*greatest(area.radius_meters,200)/100)*100)::integer,used);
    END IF;
    IF used>=lifetime THEN exhausted:=true; END IF;
  END LOOP;
  IF exhausted THEN RETURN false; END IF;
  UPDATE public.course_share_area_budget SET links_cut=links_cut+1
    WHERE athlete_id=tenant AND zone_id=ANY($1);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.claim_course_share_budget(uuid[]) FROM PUBLIC;

-- Restore only (no grant): replay one captured budget row onto a restored cluster, before any
-- runtime access. Returns
--   'inserted'         the restored cluster had no row for this area (its first link, or the
--                      area itself, came after the dump): the row is written as captured —
--                      a tombstone when the area did not survive;
--   'raised'           the restored count was lower (links made after the dump): raised;
--   'already_applied'  the restored count is as high already: nothing changes.
-- Refused, failing the replay transaction: a tenant that is not the session's, a malformed
-- entry, an erased tenant (its erasure replay satisfies the entry; the caller counts it), a
-- tenant this cluster does not know, and a row whose place differs from the captured one.
CREATE FUNCTION public.replay_course_share_budget(text,uuid,integer,integer,integer,integer)
RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE existing public.course_share_area_budget%ROWTYPE;
BEGIN
  IF $1 IS NULL OR $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'SHARE_BUDGET_REPLAY_TENANT_MISMATCH';
  END IF;
  IF $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR $6 IS NULL OR $6<0
  THEN RAISE EXCEPTION 'SHARE_BUDGET_REPLAY_INVALID_ENTRY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  IF EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=$1)
  THEN RAISE EXCEPTION 'SHARE_BUDGET_REPLAY_TENANT_ERASED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id::text=$1)
  THEN RAISE EXCEPTION 'SHARE_BUDGET_REPLAY_TENANT_UNKNOWN'; END IF;
  SELECT b.* INTO existing FROM public.course_share_area_budget b
    WHERE b.athlete_id=$1 AND b.zone_id=$2 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.course_share_area_budget(athlete_id,zone_id,cell_latitude,cell_longitude,
      reach_meters,links_cut) VALUES($1,$2,$3,$4,$5,$6);
    RETURN 'inserted';
  END IF;
  IF (existing.cell_latitude,existing.cell_longitude,existing.reach_meters)
    IS DISTINCT FROM ($3,$4,$5)
  THEN RAISE EXCEPTION 'SHARE_BUDGET_REPLAY_PLACE_MISMATCH'; END IF;
  IF existing.links_cut>=$6 THEN RETURN 'already_applied'; END IF;
  UPDATE public.course_share_area_budget SET links_cut=$6 WHERE athlete_id=$1 AND zone_id=$2;
  RETURN 'raised';
END $$;
REVOKE ALL ON FUNCTION public.replay_course_share_budget(text,uuid,integer,integer,integer,integer)
  FROM PUBLIC;

-- Backfill, one tenant at a time with that tenant named (the tables are FORCE RLS and the
-- migration owner need not be superuser or BYPASSRLS; 050's read does the same).
DO $backfill$
DECLARE tenant text;
DECLARE previous text:=current_setting('app.athlete_id',true);
BEGIN
  FOR tenant IN SELECT DISTINCT s.athlete_id FROM public.course_share s ORDER BY 1 LOOP
    PERFORM set_config('app.athlete_id',tenant,true);
    INSERT INTO public.course_share_area_budget(athlete_id,zone_id,cell_latitude,cell_longitude,
        reach_meters,links_cut)
      SELECT z.athlete_id,z.zone_id,floor(z.center_latitude*100)::integer,
        floor(z.center_longitude*100)::integer,
        (ceil(3*greatest(z.radius_meters,200)/100)*100)::integer,
        (SELECT count(*)::integer FROM public.course_share s
          WHERE s.athlete_id=z.athlete_id AND z.zone_id=ANY(s.zone_ids))
      FROM public.course_privacy_zone z
      WHERE z.athlete_id=tenant AND EXISTS(SELECT 1 FROM public.course_share s
        WHERE s.athlete_id=z.athlete_id AND z.zone_id=ANY(s.zone_ids));
  END LOOP;
  PERFORM set_config('app.athlete_id',coalesce(previous,''),true);
END
$backfill$;

-- Erasure removes the account's budget rows, after the account lock and the command lock
-- (77206 → 0 → rows, re-entrant in the chain below), then runs the chain unchanged.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_course_share_budget;
REVOKE ALL ON FUNCTION public.erase_account_before_course_share_budget(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_course_share_budget(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_course_share_budget(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
    RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  PERFORM pg_advisory_xact_lock(hashtextextended($1,0));
  DELETE FROM public.course_share_area_budget WHERE athlete_id=$1;
  RETURN public.erase_account_before_course_share_budget($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
