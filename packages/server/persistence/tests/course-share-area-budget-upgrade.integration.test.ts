import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { courseSharingLimits } from '@workout/contracts/course-sharing';
import { courseLimits } from '@workout/contracts/courses';

import { grantCourses, grantOperations, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The lifetime link budget migration (M2-01as, 054) on a database every earlier migration
 * already built — with links made before it (sharing was off everywhere, but a database may
 * still hold some) and an account already erased. It adds one table, one trigger and five
 * functions, wraps `erase_account` once more, backfills a budget for every area an existing
 * link names, and must leave everything else alone.
 *
 * Found by name, not by number (054 after M2-01ap's 053 on this branch; the root orders it at
 * merge), so a renumbering does not move the starting point.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `budget_up_${suffix}`;
const runtimeRole = `budget_rt_${suffix}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;
let versionsBefore = 0;

const liveTenant = randomUUID();
const erasedTenant = randomUUID();
const unknownTenant = randomUUID();
const namedTwice = randomUUID();
const namedOnce = randomUUID();
const neverNamed = randomUUID();

const newFunctions = [
  'claim_course_share_budget(uuid[])',
  'course_share_area_budget_monotonic()',
  'course_share_cell_distance(integer,integer,double precision,double precision,double precision)',
  'erase_account_before_course_share_budget(text)',
  'replay_course_share_budget(text,uuid,integer,integer,integer,integer)',
];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(
    `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS`,
  );
  upgraded = new Pool({ connectionString: upgradeUrl() });
  const index = migrationFileNames.findIndex((file) =>
    /^\d+_course_share_area_budget\.sql$/.test(file),
  );
  expect(index).toBeGreaterThan(0);
  expect(
    migrationFileNames.slice(0, index).some((file) => /_course_sharing\.sql$/.test(file)),
  ).toBe(true);
  // Upgraded from whatever migration directly precedes it (M2-01au's 052 queue-state plain
  // owner at the time of writing; the order at merge decides).
  expect(migrationFileNames[index - 1]).toMatch(/^\d+_[a-z0-9_]+\.sql$/);
  versionsBefore = index;
  await migrate(upgradeUrl(), versionsBefore);
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  // Before 054: three areas of one account, two links naming the first two (each link names
  // every area of the account, as 050 stores it), and an erased account.
  for (const [zone, longitude, radius] of [
    [namedTwice, 127.02, 250],
    [namedOnce, 127.5, 5000],
    [neverNamed, 128, 50],
  ] as const)
    await upgraded.query(
      `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
         radius_meters,created_at,updated_at) VALUES($1,$2,'구역',$3,37.5,$4,now(),now())`,
      [liveTenant, zone, longitude, radius],
    );
  const client = await upgraded.connect();
  try {
    // Link rows only, without the course they would hang from: foreign keys and triggers off.
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    for (const zones of [[namedTwice, namedOnce], [namedTwice]])
      await client.query(
        `INSERT INTO course_share(athlete_id,share_id,course_id,course_revision,receipt_id,
           token_digest,epoch,state,include_names,zone_ids,snapshot,created_at,expires_at)
         VALUES($1,$2,$3,1,$4,$5,1,'active',false,$6::uuid[],'{"coordinates":[]}'::jsonb,
           now(),now()+interval '1 day')`,
        [
          liveTenant,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          'a'.repeat(63) + zones.length,
          zones,
        ],
      );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await upgraded.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [liveTenant, 'https://synthetic.invalid', `budget-${suffix}`],
  );
  await upgraded.query('INSERT INTO tenant_erasure(athlete_id) VALUES($1)', [erasedTenant]);
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await admin.end();
});

async function functionBodies(): Promise<Map<string, string>> {
  const rows = await upgraded.query<{ signature: string; body: string }>(
    `SELECT p.oid::regprocedure::text AS signature,p.prosrc AS body FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace`,
  );
  return new Map(rows.rows.map((row) => [row.signature, row.body]));
}

async function checksums(): Promise<Map<number, string>> {
  const rows = await upgraded.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

async function tableGrants(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT c.relname||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')||':'||a.privilege_type
       AS entry
     FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.grantee<>c.relowner
     ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

function expectInOrder(body: string, fragments: readonly string[]): void {
  let previous = -1;
  for (const fragment of fragments) {
    const at = body.indexOf(fragment);
    expect(at, fragment).toBeGreaterThan(previous);
    previous = at;
  }
}

async function asTenant<T>(tenant: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await upgraded.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('lifetime link budget migration upgrade of a database built by every earlier one', () => {
  it('adds its table and functions, backfills existing links, re-wraps erasure, nothing else', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const bodiesBefore = await functionBodies();
    const eraseBefore = bodiesBefore.get('erase_account(text)');
    expect(eraseBefore).toBeDefined();
    const grantsBefore = await tableGrants();

    await expect(migrate(upgradeUrl(), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);
    const bodiesAfter = await functionBodies();
    for (const [signature, body] of bodiesBefore) {
      if (signature === 'erase_account(text)') continue;
      expect(bodiesAfter.get(signature), `${signature} changed`).toBe(body);
    }
    expect(bodiesAfter.get('erase_account_before_course_share_budget(text)')).toBe(eraseBefore);
    expect(
      [...bodiesAfter.keys()].filter((signature) => !bodiesBefore.has(signature)).sort(),
    ).toEqual(newFunctions);
    // 054 → 050 → 049: each link takes the account lock, the command lock, then its rows.
    expectInOrder(bodiesAfter.get('erase_account(text)') ?? '', [
      'ERASURE_TENANT_MISMATCH',
      'hashtextextended($1,77206)',
      'hashtextextended($1,0)',
      'DELETE FROM public.course_share_area_budget',
      'public.erase_account_before_course_share_budget($1)',
    ]);
    expectInOrder(bodiesAfter.get('erase_account_before_course_share_budget(text)') ?? '', [
      'hashtextextended($1,77206)',
      'hashtextextended($1,0)',
      'DELETE FROM public.course_share_rate',
      'erase_account_before_course_sharing($1)',
    ]);
    const paths = await upgraded.query<{ signature: string; config: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS signature,p.proconfig AS config FROM pg_proc p
       WHERE p.pronamespace='public'::regnamespace AND p.oid::regprocedure::text = ANY($1)
       ORDER BY 1`,
      [[...newFunctions, 'erase_account(text)']],
    );
    expect(paths.rows).toEqual(
      [...newFunctions, 'erase_account(text)']
        .sort()
        .map((signature) => ({ signature, config: ['search_path=pg_catalog, pg_temp'] })),
    );
    const publicExecute = await upgraded.query(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p,
         LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.pronamespace='public'::regnamespace AND a.grantee=0
         AND p.oid::regprocedure::text = ANY($1)`,
      [[...newFunctions, 'erase_account(text)']],
    );
    expect(publicExecute.rows).toEqual([]);
    expect(await tableGrants()).toEqual(grantsBefore);
    const forced = await upgraded.query(
      `SELECT relrowsecurity AS on,relforcerowsecurity AS forced FROM pg_class
       WHERE relname='course_share_area_budget'`,
    );
    expect(forced.rows).toEqual([{ on: true, forced: true }]);

    // Backfill: every area an existing link names is counted for every link naming it — an
    // over-count, which errs toward refusing — and an area no link names gets no row.
    const budgets = await upgraded.query(
      `SELECT zone_id::text,cell_latitude,cell_longitude,reach_meters,links_cut
       FROM course_share_area_budget WHERE athlete_id=$1 ORDER BY links_cut DESC`,
      [liveTenant],
    );
    expect(budgets.rows).toEqual([
      {
        zone_id: namedTwice,
        cell_latitude: 3750,
        cell_longitude: 12702,
        reach_meters: 800,
        links_cut: 2,
      },
      {
        zone_id: namedOnce,
        cell_latitude: 3750,
        cell_longitude: 12750,
        reach_meters: 15000,
        links_cut: 1,
      },
    ]);
  });

  it('reaches the runtime role only through the grants written for it', async () => {
    await migrate(upgradeUrl());
    await grantOperations(upgradeUrl(), runtimeRole);
    await grantCourses(upgradeUrl(), runtimeRole);
    expect(
      (await tableGrants()).filter((entry) => entry.startsWith('course_share_area_budget:')),
    ).toEqual([`course_share_area_budget:${runtimeRole}:SELECT`]);
    const executable = await upgraded.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
       WHERE p.pronamespace='public'::regnamespace AND p.oid::regprocedure::text = ANY($1)
         AND has_function_privilege($2,p.oid,'EXECUTE') ORDER BY 1`,
      [newFunctions, runtimeRole],
    );
    expect(executable.rows.map((row) => row.signature)).toEqual([
      'claim_course_share_budget(uuid[])',
    ]);
  });

  it('inherits across an overlapping area, never across a distant one', async () => {
    await migrate(upgradeUrl());
    // `namedTwice` (250 m, 2 links) is deleted: its row stays as the place's tombstone.
    await upgraded.query('DELETE FROM course_privacy_zone WHERE athlete_id=$1 AND zone_id=$2', [
      liveTenant,
      namedTwice,
    ]);
    const near = randomUUID();
    const far = randomUUID();
    for (const [zone, longitude, radius] of [
      [near, 127.0235, 100],
      [far, 126.5, 100],
    ] as const)
      await upgraded.query(
        `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
           radius_meters,created_at,updated_at) VALUES($1,$2,'구역',$3,37.5,$4,now(),now())`,
        [liveTenant, zone, longitude, radius],
      );
    // Review r1 finding 5: an area ~670 m south of the tombstone's cell. Its own disc (100 m)
    // and the old one (250 m) do not overlap — the first match rule let it escape — but its
    // share circle reaches 3 · S = 600 m, over the old place.
    const gap = randomUUID();
    await upgraded.query(
      `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
         radius_meters,created_at,updated_at) VALUES($1,$2,'구역',127.025,37.494,100,now(),now())`,
      [liveTenant, gap],
    );
    const claim = (zones: string[]) =>
      asTenant(liveTenant, (client) =>
        client.query<{ claimed: boolean }>(
          'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
          [zones],
        ),
      );
    expect((await claim([gap])).rows[0]?.claimed).toBe(true);
    expect((await claim([near])).rows[0]?.claimed).toBe(true);
    expect((await claim([far])).rows[0]?.claimed).toBe(true);
    const counts = await upgraded.query(
      `SELECT zone_id::text,links_cut FROM course_share_area_budget
       WHERE athlete_id=$1 AND zone_id=ANY($2::uuid[]) ORDER BY links_cut,zone_id`,
      [liveTenant, [gap, near, far]],
    );
    // The gap area joins the tombstone's place (2) and the place takes 1 (3); the near area
    // (~300 m from the old centre) is in the same place, so its link moves the whole place to
    // 4 — the gap area included; the area 46 km away is a place of its own.
    expect(counts.rows).toEqual(
      [
        { zone_id: far, links_cut: 1 },
        { zone_id: gap, links_cut: 4 },
        { zone_id: near, links_cut: 4 },
      ].sort((left, right) =>
        left.links_cut !== right.links_cut
          ? left.links_cut - right.links_cut
          : left.zone_id < right.zone_id
            ? -1
            : 1,
      ),
    );
  });

  it('replays a captured budget only upward, only for a known and unerased tenant', async () => {
    await migrate(upgradeUrl());
    const replay = (tenant: string, entry: [string, number, number, number, number]) =>
      asTenant(tenant, (client) =>
        client.query<{ outcome: string }>(
          'SELECT public.replay_course_share_budget($1,$2,$3,$4,$5,$6) AS outcome',
          [tenant, ...entry],
        ),
      );
    const outcome = async (tenant: string, entry: [string, number, number, number, number]) =>
      (await replay(tenant, entry)).rows[0]?.outcome;
    expect(await outcome(liveTenant, [namedOnce, 3750, 12750, 15000, 7])).toBe('raised');
    expect(await outcome(liveTenant, [namedOnce, 3750, 12750, 15000, 5])).toBe('already_applied');
    const created = randomUUID();
    expect(await outcome(liveTenant, [created, 3750, 12702, 600, 4])).toBe('inserted');
    await expect(replay(liveTenant, [namedOnce, 3751, 12750, 15000, 9])).rejects.toThrow(
      'SHARE_BUDGET_REPLAY_PLACE_MISMATCH',
    );
    await expect(replay(erasedTenant, [randomUUID(), 0, 0, 600, 1])).rejects.toThrow(
      'SHARE_BUDGET_REPLAY_TENANT_ERASED',
    );
    await expect(replay(unknownTenant, [randomUUID(), 0, 0, 600, 1])).rejects.toThrow(
      'SHARE_BUDGET_REPLAY_TENANT_UNKNOWN',
    );
    await expect(
      asTenant(liveTenant, (client) =>
        client.query('SELECT public.replay_course_share_budget($1,$2,0,0,600,1)', [
          unknownTenant,
          randomUUID(),
        ]),
      ),
    ).rejects.toThrow('SHARE_BUDGET_REPLAY_TENANT_MISMATCH');
    const rows = await upgraded.query(
      `SELECT zone_id::text,links_cut FROM course_share_area_budget
       WHERE athlete_id=$1 AND zone_id=ANY($2::uuid[]) ORDER BY links_cut`,
      [liveTenant, [namedOnce, created]],
    );
    expect(rows.rows).toEqual([
      { zone_id: created, links_cut: 4 },
      { zone_id: namedOnce, links_cut: 7 },
    ]);
  });

  it('inherits in the mirror case: a large old area whose share reach meets the new one (r2)', async () => {
    await migrate(upgradeUrl());
    // An old 400 m area (share reach 1,200 m) with 5 links, deleted. A new 100 m area ~1.2 km
    // south of its cell: the new area's reach plus the OLD RADIUS (600 + 400 m, review r1's rule)
    // misses it; the new reach plus the OLD SHARE REACH (600 + 1,200 m) does not.
    const old = randomUUID();
    const mirror = randomUUID();
    await upgraded.query(
      `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
         radius_meters,created_at,updated_at) VALUES($1,$2,'큰 구역',128.505,36.005,400,now(),now())`,
      [liveTenant, old],
    );
    const claim = (zones: string[]) =>
      asTenant(liveTenant, (client) =>
        client.query<{ claimed: boolean }>(
          'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
          [zones],
        ),
      );
    expect((await claim([old])).rows[0]?.claimed).toBe(true);
    await upgraded.query(
      'UPDATE course_share_area_budget SET links_cut=5 WHERE athlete_id=$1 AND zone_id=$2',
      [liveTenant, old],
    );
    await upgraded.query('DELETE FROM course_privacy_zone WHERE athlete_id=$1 AND zone_id=$2', [
      liveTenant,
      old,
    ]);
    await upgraded.query(
      `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
         radius_meters,created_at,updated_at) VALUES($1,$2,'새 구역',128.505,35.9892,100,now(),now())`,
      [liveTenant, mirror],
    );
    const gap = await upgraded.query<{ meters: number }>(
      'SELECT public.course_share_cell_distance(3600,12850,35.9892,128.505,2000) AS meters',
    );
    expect(gap.rows[0]?.meters).toBeGreaterThan(600 + 400 + 1);
    expect(gap.rows[0]?.meters).toBeLessThan(600 + 1200);
    expect((await claim([mirror])).rows[0]?.claimed).toBe(true);
    const counts = await upgraded.query(
      'SELECT links_cut FROM course_share_area_budget WHERE athlete_id=$1 AND zone_id=$2',
      [liveTenant, mirror],
    );
    expect(counts.rows).toEqual([{ links_cut: 6 }]);
  });

  it('never overstates the distance to a cell, at 37.5°, 78° and 89° (review r2 peer finding 1)', async () => {
    await migrate(upgradeUrl());
    const radius = 6_371_008.8;
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      const a =
        Math.sin(toRadians(lat2 - lat1) / 2) ** 2 +
        Math.cos(toRadians(lat1)) *
          Math.cos(toRadians(lat2)) *
          Math.sin(toRadians(lon2 - lon1) / 2) ** 2;
      return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
    };
    let state = 12345;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 31;
    };
    // The largest reach the claim ever asks about: 3 · S_new + 3 · S_old, S up to 5 km.
    const slack = 15_000;
    let checked = 0;
    for (const latitude of [37.5, 78, 89]) {
      const span = latitude > 85 ? 8 : latitude > 70 ? 1 : 0.3;
      for (let trial = 0; trial < 60; trial += 1) {
        const lat = latitude + (random() - 0.5) * 0.02;
        const lon = 10 + random() * 0.5;
        // A cell up to ~13 km north or south and far east or west — where the first formula's
        // cosine, taken at the centre's latitude, overstated the distance.
        const cellLat = Math.floor((lat + (random() - 0.5) * 0.24) * 100);
        const cellLon = Math.floor((lon + (random() - 0.5) * span) * 100);
        // The nearest point lies on the cell's edge: sampled finely along all four (an upper
        // bound on the true minimum, within half a metre).
        let nearest = Infinity;
        for (let i = 0; i <= 2000; i += 1) {
          const t = i / 2000;
          for (const [edgeLat, edgeLon] of [
            [cellLat / 100, (cellLon + t) / 100],
            [(cellLat + 1) / 100, (cellLon + t) / 100],
            [(cellLat + t) / 100, cellLon / 100],
            [(cellLat + t) / 100, (cellLon + 1) / 100],
          ] as const)
            nearest = Math.min(nearest, haversine(lat, lon, edgeLat, edgeLon));
        }
        if (nearest > slack) continue;
        const estimate = await upgraded.query<{ meters: number }>(
          'SELECT public.course_share_cell_distance($1,$2,$3,$4,$5) AS meters',
          [cellLat, cellLon, lat, lon, slack],
        );
        expect(
          estimate.rows[0]?.meters,
          `${lat},${lon} → ${cellLat},${cellLon}`,
        ).toBeLessThanOrEqual(nearest + 1e-6);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("keeps the claim's constants in step with the contract", async () => {
    await migrate(upgradeUrl());
    const body = (await functionBodies()).get('claim_course_share_budget(uuid[])') ?? '';
    expect(body).toContain(
      `lifetime constant integer:=${courseSharingLimits.shareLinksPerAreaLifetime};`,
    );
    expect(body).toContain(
      `cardinality($1) NOT BETWEEN 1 AND ${courseLimits.privacyZonesPerTenant}`,
    );
  });

  it('serialises two first claims of one new area on its own lock (defense in depth)', async () => {
    await migrate(upgradeUrl());
    // `createShare` already holds the tenant's command lock; the claim takes it again, so a
    // caller that does not — two sessions making an area's first link at once — still counts
    // both links instead of one failing on the new row's key.
    const fresh = randomUUID();
    await upgraded.query(
      `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
         radius_meters,created_at,updated_at) VALUES($1,$2,'동시',100.0,10.0,200,now(),now())`,
      [liveTenant, fresh],
    );
    const first = await upgraded.connect();
    const second = await upgraded.connect();
    try {
      for (const client of [first, second]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [liveTenant]);
      }
      const one = await first.query<{ claimed: boolean }>(
        'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
        [[fresh]],
      );
      const pending = second.query<{ claimed: boolean }>(
        'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
        [[fresh]],
      );
      // Give the second claim time to reach the lock (or, without it, the row's key).
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query('COMMIT');
      const two = await pending;
      await second.query('COMMIT');
      expect([one.rows[0]?.claimed, two.rows[0]?.claimed]).toEqual([true, true]);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
    const counted = await upgraded.query(
      'SELECT links_cut FROM course_share_area_budget WHERE athlete_id=$1 AND zone_id=$2',
      [liveTenant, fresh],
    );
    expect(counted.rows).toEqual([{ links_cut: 2 }]);
  });

  it('shares one count across overlapping areas on every claim (phase review finding 2)', async () => {
    await migrate(upgradeUrl());
    // Two live 200 m areas ~800 m apart (reaches 600 m each: they overlap). Each link is cut
    // against one of them only. First-link inheritance let them reach 10 apiece (19 links in
    // one place); the place's one count stops the pair at 10 links in total.
    const areaA = randomUUID();
    const areaB = randomUUID();
    for (const [zone, longitude] of [
      [areaA, 110.0],
      [areaB, 110.0082],
    ] as const)
      await upgraded.query(
        `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
           radius_meters,created_at,updated_at) VALUES($1,$2,'겹침',$3,20.0,200,now(),now())`,
        [liveTenant, zone, longitude],
      );
    const claim = async (zones: string[]) =>
      (
        await asTenant(liveTenant, (client) =>
          client.query<{ claimed: boolean }>(
            'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
            [zones],
          ),
        )
      ).rows[0]?.claimed;
    let granted = 0;
    for (let round = 0; round < 15; round += 1)
      for (const zone of [areaA, areaB]) if (await claim([zone])) granted += 1;
    expect(granted).toBe(courseSharingLimits.shareLinksPerAreaLifetime);
    const rows = await upgraded.query(
      `SELECT links_cut FROM course_share_area_budget
       WHERE athlete_id=$1 AND zone_id=ANY($2::uuid[]) ORDER BY zone_id`,
      [liveTenant, [areaA, areaB]],
    );
    expect(rows.rows).toEqual([{ links_cut: 10 }, { links_cut: 10 }]);
  });

  it('counts both of two concurrent first claims of two new overlapping areas (M2-01ax)', async () => {
    await migrate(upgradeUrl());
    // Two new 200 m areas ~800 m apart (one place), neither ever cut. Each session's claim
    // writes its own area's row, and neither row is visible to the other until it commits:
    // without the claim's own advisory lock both would see a place of one row at 0, both would
    // write 1, and the place would then grant 9 more — 11 links. The lock makes the second
    // wait for the first and see its row.
    const areaE = randomUUID();
    const areaF = randomUUID();
    for (const [zone, longitude] of [
      [areaE, 114.0],
      [areaF, 114.0082],
    ] as const)
      await upgraded.query(
        `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
           radius_meters,created_at,updated_at) VALUES($1,$2,'새 겹침',$3,20.0,200,now(),now())`,
        [liveTenant, zone, longitude],
      );
    let secondReturned = false;
    let secondState: 'returned' | 'waiting' | null = null;
    const first = await upgraded.connect();
    const second = await upgraded.connect();
    try {
      const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid;
      if (secondPid === undefined) throw new Error('no backend pid');
      for (const client of [first, second]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [liveTenant]);
      }
      const one = await first.query<{ claimed: boolean }>(
        'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
        [[areaE]],
      );
      const pending = second
        .query<{ claimed: boolean }>(
          'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
          [[areaF]],
        )
        .then((result) => {
          secondReturned = true;
          return result;
        });
      // The first session stays open until the second is seen in PostgreSQL either waiting on
      // a lock inside its claim (the advisory lock: it will see E once the first commits) or
      // already returned (no lock held it back: it saw only its own row). Either is observed,
      // never assumed from a delay; neither within 10 s fails the test.
      const deadline = Date.now() + 10_000;
      while (secondState === null) {
        if (secondReturned) {
          secondState = 'returned';
          break;
        }
        const activity = await upgraded.query<{ waiting: boolean }>(
          `SELECT state='active' AND wait_event_type='Lock' AND query LIKE '%claim_course_share_budget%'
             AS waiting
           FROM pg_stat_activity WHERE pid=$1`,
          [secondPid],
        );
        if (activity.rows[0]?.waiting === true) secondState = 'waiting';
        else if (Date.now() > deadline)
          throw new Error('the second claim was never seen waiting or returned');
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await first.query('COMMIT');
      const two = await pending;
      await second.query('COMMIT');
      expect([one.rows[0]?.claimed, two.rows[0]?.claimed]).toEqual([true, true]);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
    const rows = await upgraded.query(
      `SELECT links_cut FROM course_share_area_budget
       WHERE athlete_id=$1 AND zone_id=ANY($2::uuid[]) ORDER BY zone_id`,
      [liveTenant, [areaE, areaF]],
    );
    expect(rows.rows).toEqual([{ links_cut: 2 }, { links_cut: 2 }]);
    // The place's total stays the bound: 2 granted at once, then only 8 more.
    let granted = 2;
    for (let round = 0; round < 12; round += 1) {
      const claimed = await asTenant(liveTenant, (client) =>
        client.query<{ claimed: boolean }>(
          'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
          [[round % 2 === 0 ? areaE : areaF]],
        ),
      );
      if (claimed.rows[0]?.claimed) granted += 1;
    }
    expect(granted).toBe(courseSharingLimits.shareLinksPerAreaLifetime);
    // And it was the lock that did it: the second claim waited for the first to commit.
    expect(secondState).toBe('waiting');
  });

  it('lets only one of two concurrent claims on overlapping areas take the last link', async () => {
    await migrate(upgradeUrl());
    const areaC = randomUUID();
    const areaD = randomUUID();
    for (const [zone, longitude] of [
      [areaC, 112.0],
      [areaD, 112.0082],
    ] as const)
      await upgraded.query(
        `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,center_latitude,
           radius_meters,created_at,updated_at) VALUES($1,$2,'동시 겹침',$3,20.0,200,now(),now())`,
        [liveTenant, zone, longitude],
      );
    for (let index = 0; index < 9; index += 1)
      await asTenant(liveTenant, (client) =>
        client.query('SELECT public.claim_course_share_budget($1::uuid[])', [
          [index % 2 === 0 ? areaC : areaD],
        ]),
      );
    const first = await upgraded.connect();
    const second = await upgraded.connect();
    try {
      for (const client of [first, second]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [liveTenant]);
      }
      const one = await first.query<{ claimed: boolean }>(
        'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
        [[areaC]],
      );
      const pending = second.query<{ claimed: boolean }>(
        'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
        [[areaD]],
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query('COMMIT');
      const two = await pending;
      await second.query('COMMIT');
      expect([one.rows[0]?.claimed, two.rows[0]?.claimed]).toEqual([true, false]);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });
});
