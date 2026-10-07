import { createGarminUnofficialStore } from '../src/garmin-unofficial.js';
import { createActivityRepository } from '../src/activities.js';
import { createActivityTrackRepository } from '../src/activity-tracks.js';
import { createCourseRepository, type PreparedCourseContent } from '../src/courses.js';
import { courseContentDigest } from '@workout/server-courses/digest';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { raceProjectionIntentSchema } from '../src/race-plan-impact-projection-input.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { captureRaceManualReviewLifecycleInventoryV2In } from '../src/race-manual-review-lifecycle-inventory-v2.js';
import {
  migrate,
  grantCorePlanning,
  grantActivityTracks,
  grantSupplementaryCore,
  grantOperations,
  grantRaces,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
  grantNutritionCore,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
  grantSessionCompletions,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `retained_store_v2_${suffix}`;
const ownerRole = `retained_store_owner_${suffix}`;
const runtimeRole = `retained_store_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    for (const file of [
      '115_manual_review_full_owned_source_bindings_v2.sql',
      '116_manual_race_chain_v2.sql',
    ])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    for (const signature of [
      'observe_manual_review_full_owned_source_bindings_v2(jsonb)',
      'store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'read_manual_race_chain_receipt_v2(text,jsonb)',
      'read_manual_race_chain_v2(uuid)',
    ])
      await owner.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${runtimeRole}"`);
    expect(
      (await owner.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]?.['v'],
    ).toBe(107);
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantCorePlanning,
    grantActivityTracks,
    grantSupplementaryCore,
    grantOperations,
    grantRaces,
    grantRoutineCore,
    grantRecoveryCore,
    grantCheckIns,
    grantCourses,
    grantNutritionCore,
    grantResources,
    grantResourceRetrieval,
    grantGalleryMedia,
    grantGarminUnofficial,
    grantSessionCompletions,
  ])
    await grant(url(ownerRole), runtimeRole);
  // Existing Activity API producer composition, not private chain-table privileges.
  const activityOwner = new Pool({ connectionString: url(ownerRole) });
  try {
    await activityOwner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
    );
  } finally {
    await activityOwner.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
const resultSchema = z.strictObject({
  schemaVersion: z.literal(2),
  evidenceId: z.uuid(),
  decisionId: z.uuid(),
  proposalId: z.uuid(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  applicable: z.literal(false),
  approvalAllowed: z.literal(false),
});
async function snapshot<T>(athlete: string, run: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(athlete, run);
}
async function seed() {
  const athlete = randomUUID();
  // Synthetic identity FK prerequisite only; all health/source rows use public producers.
  const identityOwner = new Pool({ connectionString: url(ownerRole) });
  try {
    await identityOwner.query(
      'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
      [athlete, 'https://synthetic.invalid', athlete],
    );
  } finally {
    await identityOwner.end();
  }
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic original',
      localDate: '2026-10-06',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
  });
  return {
    athlete,
    race,
    intent: {
      expectedEvent: { id: race.id, revision: 1 },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' },
    },
  };
}
async function prepared(tx: Transaction, unknownIntent: unknown) {
  const intent = raceProjectionIntentSchema.parse(unknownIntent);
  const budget = { bytes: 0n, sources: 0 };
  const actual = await prepareRaceManualSemanticBasisV2In(tx, intent, null, budget);
  if (actual.status !== 'current_dependencies_captured' || !('prepared' in actual))
    throw Error('ACTUAL_BASIS_BLOCKED');
  const lifecycle = await captureRaceManualReviewLifecycleInventoryV2In(
    tx,
    actual.prepared.retained,
    budget,
  );
  if (lifecycle.status !== 'dependency_correspondence') throw Error('ACTUAL_LIFECYCLE_BLOCKED');
  expect(intent).toEqual(actual.basis.intent);
  const key = randomUUID();
  return {
    key,
    payload: actual.prepared.retained,
    basis: actual.basis,
    lifecycle,
    request: { schemaVersion: 2, idempotencyKey: key, intent, expectedBasis: actual.basis },
    ids: [randomUUID(), randomUUID(), randomUUID()],
  };
}
type Prepared = Awaited<ReturnType<typeof prepared>>;
async function store(tx: Transaction, p: Prepared) {
  const rows = await tx.query(
    'SELECT public.store_manual_race_chain_v2($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) AS result',
    [
      ...p.ids,
      p.key,
      JSON.stringify(p.request),
      JSON.stringify(p.payload),
      JSON.stringify(p.basis),
      JSON.stringify(p.lifecycle),
    ],
  );
  return resultSchema.parse(rows.rows[0]?.['result']);
}
async function read(tx: Transaction, id: string) {
  return (await tx.query('SELECT public.read_manual_race_chain_v2($1::uuid) AS value', [id]))
    .rows[0]?.['value'];
}
async function count(athlete: string) {
  const owner = new Pool({ connectionString: url(ownerRole) });
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await client.query(
      'SELECT (SELECT count(*)::int FROM public.manual_race_evidence_v2 WHERE athlete_id=$1) AS evidence,(SELECT count(*)::int FROM public.manual_race_decision_v2 WHERE athlete_id=$1) AS decision,(SELECT count(*)::int FROM public.manual_race_proposal_v2 WHERE athlete_id=$1) AS proposal',
      [athlete],
    );
    await client.query('ROLLBACK');
    return result.rows[0];
  } finally {
    client.release();
    await owner.end();
  }
}
it('stores canonical evidence once with exact decision/proposal FKs and no approval', async () => {
  const f = await seed();
  const result = await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, f.intent);
    const r = await store(tx, p);
    const value = await read(tx, r.evidenceId);
    expect(value).toEqual({ schemaVersion: 2, result: r, payload: p.payload });
    return r;
  });
  expect(result.applicable).toBe(false);
  expect(await count(f.athlete)).toEqual({ evidence: 1, decision: 1, proposal: 1 });
});
it('replays original minimal result after app withdrawal without another chain', async () => {
  const f = await seed();
  const saved = await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, f.intent);
    return { p, result: await store(tx, p) };
  });
  await createConsentRepository(db).setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const value = await snapshot(f.athlete, (tx) => store(tx, saved.p));
  expect(value).toEqual(saved.result);
  expect(await count(f.athlete)).toEqual({ evidence: 1, decision: 1, proposal: 1 });
});
it('rejects conflicting idempotency request and preserves original result', async () => {
  const f = await seed();
  const saved = await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, f.intent);
    return { p, result: await store(tx, p) };
  });
  await expect(
    snapshot(f.athlete, (tx) =>
      store(tx, {
        ...saved.p,
        request: {
          ...saved.p.request,
          intent: { ...saved.p.request.intent, newLocalDate: '2026-10-09' },
        },
      }),
    ),
  ).rejects.toThrow('MANUAL_CHAIN_IDEMPOTENCY_CONFLICT');
  expect(await snapshot(f.athlete, (tx) => store(tx, saved.p))).toEqual(saved.result);
});
it('public original race deletion redacts whole canonical payload; replay does not reconstitute it', async () => {
  const f = await seed();
  const saved = await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, f.intent);
    return { p, result: await store(tx, p) };
  });
  await createRaceRepository(db).deleteRaceEvent(f.athlete, f.race.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await snapshot(f.athlete, (tx) => read(tx, saved.result.evidenceId))).toEqual({
    schemaVersion: 2,
    result: saved.result,
    payload: null,
  });
  expect(await snapshot(f.athlete, (tx) => store(tx, saved.p))).toEqual(saved.result);
  const inspector = new Pool({ connectionString: url(ownerRole) });
  try {
    const client = await inspector.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [f.athlete]);
      const audit = z
        .strictObject({
          receiptColumns: z.array(z.string()),
          rawCopyAbsent: z.boolean(),
          requestDigestBytes: z.number().int(),
          receiptResult: resultSchema,
          outboxPayload: resultSchema,
        })
        .parse(
          (
            await client.query(
              `SELECT
        (SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='manual_race_chain_receipt_v2') AS "receiptColumns",
        NOT EXISTS(SELECT 1 FROM (
          SELECT to_jsonb(x) AS row FROM manual_race_decision_v2 x WHERE athlete_id=$1
          UNION ALL SELECT to_jsonb(x) FROM manual_race_proposal_v2 x WHERE athlete_id=$1
          UNION ALL SELECT to_jsonb(x) FROM manual_race_chain_source_ref_v2 x WHERE athlete_id=$1
          UNION ALL SELECT to_jsonb(x) FROM manual_race_chain_lifecycle_edge_v2 x WHERE athlete_id=$1
          UNION ALL SELECT to_jsonb(x) FROM manual_race_chain_receipt_v2 x WHERE athlete_id=$1
          UNION ALL SELECT to_jsonb(x) FROM outbox x WHERE athlete_id=$1 AND topic='manual.race_chain_prepared'
        ) auxiliary WHERE row::text LIKE '%Synthetic original%' OR row::text LIKE '%2026-10-06%' OR row::text LIKE '%expectedBasis%' OR row::text LIKE '%raceTimingPins%') AS "rawCopyAbsent",
        octet_length(r.request_digest) AS "requestDigestBytes",r.result AS "receiptResult",o.payload AS "outboxPayload"
        FROM manual_race_chain_receipt_v2 r JOIN outbox o ON o.athlete_id=r.athlete_id AND o.id=(r.result->>'proposalId')::uuid WHERE r.athlete_id=$1 AND r.receipt_key=$2`,
              [f.athlete, saved.p.key],
            )
          ).rows[0],
        );
      expect(audit.receiptColumns).not.toContain('request');
      expect(audit.receiptColumns).toContain('request_digest');
      expect(audit.rawCopyAbsent).toBe(true);
      expect(audit.requestDigestBytes).toBe(32);
      expect(audit.receiptResult).toEqual(saved.result);
      expect(audit.outboxPayload).toEqual(saved.result);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await inspector.end();
  }
});
it('callback rollback removes every chain artifact', async () => {
  const f = await seed();
  await expect(
    snapshot(f.athlete, async (tx) => {
      await store(tx, await prepared(tx, f.intent));
      throw Error('ROLLBACK_AFTER_STORE');
    }),
  ).rejects.toThrow('ROLLBACK_AFTER_STORE');
  expect(await count(f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});
it('a missing lifecycle edge fails before writes', async () => {
  const f = await seed();
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await prepared(tx, f.intent);
      return store(tx, {
        ...p,
        lifecycle: { ...p.lifecycle, facts: p.lifecycle.facts.map((x) => ({ ...x, edges: [] })) },
      });
    }),
  ).rejects.toThrow('MANUAL_CHAIN_PARENT_MISMATCH');
  expect(await count(f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});
it('JSON authority claims and fabricated source body cannot establish correspondence', async () => {
  const f = await seed();
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await prepared(tx, f.intent);
      const payload = structuredClone(p.payload);
      payload.payload.preparation.context.event.title = 'Fabricated';
      return store(tx, { ...p, payload });
    }),
  ).rejects.toThrow();
  expect(await count(f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});
it('foreign captured tuples fail the actual tenant predicate', async () => {
  const a = await seed(),
    b = await seed();
  const p = await snapshot(a.athlete, (tx) => prepared(tx, a.intent));
  await expect(snapshot(b.athlete, (tx) => store(tx, p))).rejects.toThrow(
    'MANUAL_CHAIN_STALE_BASIS',
  );
  expect(await count(b.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});
it('tableowner cannot insert a commit context or mint a v7 original with a GUC', async () => {
  const f = await seed();
  const owner = new Pool({ connectionString: url(ownerRole) });
  async function ownerRun(run: (tx: Transaction) => Promise<unknown>) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [f.athlete]);
      return await run({
        athleteId: f.athlete,
        query: async (sql, values) => client.query(sql, values),
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  try {
    await expect(
      ownerRun((tx) =>
        tx.query(
          "INSERT INTO public.manual_race_chain_commit_v2 VALUES($1,$2,current_user,txid_current(),sha256(convert_to('{}','UTF8')))",
          [f.athlete, randomUUID()],
        ),
      ),
    ).rejects.toThrow('MANUAL_CHAIN_CALLER_REQUIRED');
    await expect(
      ownerRun(async (tx) => {
        await tx.query("SELECT set_config('app.manual_verified','true',true)");
        return tx.query(
          "INSERT INTO public.restore_suppression_event(record_version,athlete_id,kind,occurred_at,manual_review_v2_source_identity,manual_review_v2_version_scope) VALUES(7,$1,'manual_review_source_suppressed_v2',statement_timestamp(),$2::jsonb,'exact_identity')",
          [f.athlete, JSON.stringify({ kind: 'race-event', sourceId: f.race.id, revision: 1 })],
        );
      }),
    ).rejects.toThrow('MANUAL_CHAIN_ACTUAL_TRANSITION_REQUIRED');
  } finally {
    await owner.end();
  }
});
it('runtime has no private table DML and PUBLIC has no narrow function execution', async () => {
  const f = await seed();
  await expect(
    db.tenant(f.athlete, (tx) =>
      tx.query('INSERT INTO public.manual_race_decision_v2 VALUES($1,$2,$3)', [
        f.athlete,
        randomUUID(),
        randomUUID(),
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    const rows = await owner.query(
      "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed",
    );
    expect(rows.rows[0]?.['allowed']).toBe(false);
  } finally {
    await owner.end();
  }
});
it('same key concurrent transactions return a single original chain', async () => {
  const f = await seed();
  const p = await snapshot(f.athlete, (tx) => prepared(tx, f.intent));
  const results = await Promise.all([
    snapshot(f.athlete, (tx) => store(tx, p)),
    snapshot(f.athlete, (tx) => store(tx, p)),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(await count(f.athlete)).toEqual({ evidence: 1, decision: 1, proposal: 1 });
});
it('oversized/deep payload is rejected without persisted artifacts', async () => {
  const f = await seed();
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await prepared(tx, f.intent);
      return tx.query(
        'SELECT public.store_manual_race_chain_v2($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
        [
          ...p.ids,
          p.key,
          JSON.stringify(p.request),
          JSON.stringify({ text: 'x'.repeat(4194305) }),
          JSON.stringify(p.basis),
          JSON.stringify(p.lifecycle),
        ],
      );
    }),
  ).rejects.toThrow('MANUAL_CHAIN_INPUT_BOUND');
  expect(await count(f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});

function gate() {
  let signal: () => void = () => {
    throw Error('GATE_UNINITIALIZED');
  };
  const promise = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { promise, signal };
}
async function ownLockWait() {
  const deadline = Date.now() + 2000;
  do {
    const rows = await admin.query(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock'",
      [name, runtimeRole],
    );
    if (z.number().parse(rows.rows[0]?.['waiting']) > 0) return;
  } while (Date.now() < deadline);
  throw Error('OWN_LOCK_WAIT_NOT_OBSERVED');
}
type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}
function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}
async function waitStarted<T>(started: ReturnType<typeof gate>, held: Promise<Outcome<T>>) {
  const first = await Promise.race([
    started.promise.then(() => ({ status: 'started' as const })),
    held,
  ]);
  if (first.status === 'rejected') throw first.reason;
  if (first.status === 'fulfilled') throw Error('TRANSACTION_ENDED_BEFORE_GATE');
}
it('store-first source deletion waits on real tenant fence then redacts committed payload', async () => {
  const f = await seed(),
    started = gate(),
    release = gate();
  const held = observe(
    snapshot(f.athlete, async (tx) => {
      const p = await prepared(tx, f.intent);
      const result = await store(tx, p);
      started.signal();
      await release.promise;
      return result;
    }),
  );
  let deletion: Promise<Outcome<unknown>> | null = null;
  try {
    await waitStarted(started, held);
    deletion = observe(
      createRaceRepository(db).deleteRaceEvent(f.athlete, f.race.id, {
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    );
    await ownLockWait();
  } finally {
    release.signal();
    await held;
    if (deletion !== null) await deletion;
  }
  const result = unwrap(await held);
  if (deletion === null) throw Error('DELETE_NOT_STARTED');
  unwrap(await deletion);
  expect(await snapshot(f.athlete, (tx) => read(tx, result.evidenceId))).toEqual({
    schemaVersion: 2,
    result,
    payload: null,
  });
});
it('delete-first source transaction serializes a pre-captured store and refuses source resurrection', async () => {
  const f = await seed(),
    p = await snapshot(f.athlete, (tx) => prepared(tx, f.intent)),
    started = gate(),
    release = gate();
  const held = observe(
    snapshot(f.athlete, async (tx) => {
      const scoped: Database = {
        ...db,
        tenant: async (id, operation) => {
          if (id !== tx.athleteId) throw Error('FOREIGN_TRANSACTION');
          return operation(tx);
        },
      };
      await createRaceRepository(scoped).deleteRaceEvent(f.athlete, f.race.id, {
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      started.signal();
      await release.promise;
    }),
  );
  let writing: Promise<Outcome<z.infer<typeof resultSchema>>> | null = null;
  try {
    await waitStarted(started, held);
    writing = observe(snapshot(f.athlete, (tx) => store(tx, p)));
    await ownLockWait();
  } finally {
    release.signal();
    await held;
    if (writing !== null) await writing;
  }
  unwrap(await held);
  if (writing === null) throw Error('STORE_NOT_STARTED');
  expect((await writing).status).toBe('rejected');
  expect(await count(f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});
it('v7 all-version matching preserves composite source namespaces and opaque Unicode identity', async () => {
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    const run = randomUUID();
    const a = { kind: 'routine-timer', sourceId: run, stepId: '𐀀한글', revision: 0 };
    const b = { ...a, revision: 7 },
      other = { ...a, stepId: '다른-단계' };
    const q = 'SELECT public.manual_race_v2_event_match($1::jsonb,$2::jsonb,$3) AS matches';
    expect(
      (await owner.query(q, [JSON.stringify(a), JSON.stringify(b), 'all_versions'])).rows[0]?.[
        'matches'
      ],
    ).toBe(true);
    expect(
      (await owner.query(q, [JSON.stringify(a), JSON.stringify(other), 'all_versions'])).rows[0]?.[
        'matches'
      ],
    ).toBe(false);
    expect(
      (await owner.query(q, [JSON.stringify(a), JSON.stringify(b), 'exact_identity'])).rows[0]?.[
        'matches'
      ],
    ).toBe(false);
    await expect(
      owner.query('SELECT public.manual_race_v2_normalize_refs($1::jsonb)', [
        JSON.stringify([{ ...a, unknown: true }]),
      ]),
    ).rejects.toThrow('MANUAL_FULL_BINDING_INVALID_KEYS');
  } finally {
    await owner.end();
  }
});

async function catalogFixture(athlete: string) {
  const resources = createPrivateTextResourceRepository(db),
    catalog = createSupplementaryRepository(db),
    routines = createRoutineRepository(db);
  const resource = await resources.create(athlete, {
    sourceKind: 'text',
    title: 'Synthetic source',
    category: 'guide',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic plain text only.',
    idempotencyKey: randomUUID(),
  });
  if (resource.status !== 'available') throw Error('FIXTURE_RESOURCE_UNAVAILABLE');
  const exercise = await catalog.saveExercise(athlete, {
    definition: {
      schemaVersion: 2,
      exerciseId: randomUUID(),
      versionId: randomUUID(),
      name: 'Synthetic balance',
      family: 'balance_stability',
      equipment: ['bodyweight'],
      tags: [],
      countDefinitions: [],
      mediaAssetIds: [],
      resourceVersionIds: [resource.version.id],
      reviewState: 'unreviewed',
      description: 'User defined synthetic movement',
      safetyNotes: '',
      supportedMetrics: ['duration'],
      createdAt: '2026-01-01T00:00:00Z',
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const versionId = randomUUID();
  const saved = await catalog.saveRoutine(athlete, {
    template: {
      schemaVersion: 2,
      routineId: randomUUID(),
      versionId,
      title: 'Synthetic workout template',
      purpose: 'User selected practice',
      requiredEquipment: ['bodyweight'],
      spec: {
        schemaVersion: 2,
        kind: 'supplementary',
        routineVersionId: versionId,
        blocks: [
          {
            id: 'block',
            mode: 'single',
            rounds: 1,
            sets: [
              {
                id: 'set',
                exerciseVersionId: exercise.definition.versionId,
                side: 'unspecified',
                count: null,
                durationSeconds: {
                  min: 30,
                  max: 30,
                  unit: 's',
                  basis: 'user_confirmed',
                  evidenceIds: [],
                },
                externalResistance: { kind: 'no_added_load' },
                restAfterSeconds: 0,
                tempo: null,
                effort: null,
              },
            ],
            restBetweenRoundsSeconds: null,
          },
        ],
      },
      createdAt: '2026-01-01T00:00:00Z',
    },
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic source blueprint',
    intent: 'Retained source read',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Named source',
        content: {
          kind: 'workout_template',
          ref: { id: saved.template.routineId, versionId: saved.template.versionId },
        },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
  const savedBlueprint = await routines.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });

  return { routines, blueprint: savedBlueprint.blueprint };
}

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');
function finalRef(input: {
  athleteId: string;
  activityId: string;
  trackId: string;
  uploadId: string;
  artifactKind: 'raw' | 'normalized' | 'map_path';
  sha256: string;
  extension: 'fit' | 'gpx' | 'json';
}) {
  return `private/v1/tenants/${input.athleteId}/activities/${input.activityId}/tracks/${input.trackId}/${input.artifactKind}/uploads/${input.uploadId}/sha256/${input.sha256}.${input.extension}`;
}

/** Store one recording, as the API's upload lifecycle does. */
async function storeTrack(athleteId: string, activityId: string, expectedActivityRevision: number) {
  const tracks = createActivityTrackRepository(db);
  const reservation = await tracks.reserve(
    athleteId,
    activityId,
    { expectedActivityRevision, recordedTrackIndex: 0 },
    `track-${randomUUID()}`,
  );
  const shared = {
    athleteId,
    activityId,
    trackId: reservation.trackId,
    uploadId: reservation.uploadId,
  };
  const rawSha = hashOf(`raw-${reservation.uploadId}`);
  const normalizedSha = hashOf(`normalized-${reservation.uploadId}`);
  const mapPathSha = hashOf(`map-${reservation.uploadId}`);
  await tracks.prepareObjects(athleteId, reservation.uploadId, {
    raw: {
      storageRef: finalRef({ ...shared, artifactKind: 'raw', sha256: rawSha, extension: 'gpx' }),
      sizeBytes: 2048,
      sha256: rawSha,
      format: 'gpx',
      originalFileName: 'run.gpx',
    },
    normalized: {
      storageRef: finalRef({
        ...shared,
        artifactKind: 'normalized',
        sha256: normalizedSha,
        extension: 'json',
      }),
      sizeBytes: 4096,
      sha256: normalizedSha,
    },
    mapPath: {
      storageRef: finalRef({
        ...shared,
        artifactKind: 'map_path',
        sha256: mapPathSha,
        extension: 'json',
      }),
      sizeBytes: 1024,
      sha256: mapPathSha,
    },
    parse: {
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      recordedSourceKind: 'gpx-trk',
      correspondenceDigest: hashOf(`correspondence-${reservation.uploadId}`),
      sampleCount: 5,
      positionedSampleCount: 4,
      segmentCount: 1,
      segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
      distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
    },
  });
  await tracks.markStaged(athleteId, reservation.uploadId);
  await tracks.finalize(athleteId, reservation.uploadId);
  return { trackId: reservation.trackId, mapPathSha };
}

const coordinates: [number, number][] = [
  [126.9779, 37.5665],
  [126.9789, 37.5668],
  [126.9799, 37.5671],
];

function content(input: {
  activityId: string;
  trackId: string;
  name?: string;
  trackRevision?: number;
  mapPathSha?: string;
  endSampleId?: string;
  coordinates?: [number, number][];
}): PreparedCourseContent {
  const line = input.coordinates ?? coordinates;
  const [startPosition] = line;
  const endPosition = line[line.length - 1];
  if (startPosition === undefined || endPosition === undefined)
    throw new Error('a course needs at least two vertices');
  const generation = {
    kind: 'recorded-segment',
    activityId: input.activityId,
    trackId: input.trackId,
    trackRevision: input.trackRevision ?? 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: input.endSampleId ?? '0:2',
    vertexCount: line.length,
    mapPathContentSha256: input.mapPathSha ?? 'a'.repeat(64),
    simplificationVersion: 1,
    toleranceMeters: 2.5,
  } as const;
  const lineage = [
    {
      activityId: input.activityId,
      trackId: input.trackId,
      trackRevision: input.trackRevision ?? 1,
    },
  ];
  const name = input.name ?? 'Seoul loop';
  const result: PreparedCourseContent = {
    name,
    coordinates: line,
    waypoints: [
      { role: 'start', position: startPosition, name: null, sourceSampleId: '0:0', locked: false },
      {
        role: 'finish',
        position: endPosition,
        name: null,
        sourceSampleId: generation.endSampleId,
        locked: false,
      },
    ],
    generation,
    edit: { kind: 'created' },
    lineage,
    distanceMeters: 180.25,
    contentDigest: '',
  };
  return { ...result, contentDigest: courseContentDigest(result) };
}

async function importedActual(kind: 'fit' | 'fixture') {
  const f = await seed();
  const activities = createActivityRepository(db);
  const catalog = await catalogFixture(f.athlete);
  const source = {
    kind,
    sourceId: `Local-식-${randomUUID()}`,
    revision: 1,
    contentHash: 'a'.repeat(64),
  };
  const imported = await activities.importActivity(f.athlete, {
    idempotencyKey: randomUUID(),
    source,
    activity: {
      title: 'Synthetic local retained recording',
      kind: 'strength',
      startedAt: '2026-10-06T00:00:00Z',
      timezone: 'Asia/Seoul',
      durationSeconds: 0,
      durationKind: 'unknown',
      distanceMeters: null,
    },
  });
  const current = await activities.updateOverlay(f.athlete, imported.activityId, {
    expectedRevision: imported.revision,
    idempotencyKey: randomUUID(),
    reason: 'Explicit synthetic user overlay',
    title: 'Retained overlay',
    distanceMeters: 0,
  });
  let run = await catalog.routines.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: catalog.blueprint.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  run = await catalog.routines.recordStep(f.athlete, {
    runId: run.run.id,
    stepId: 'step',
    state: 'performed',
    actualRefs: [
      {
        kind: 'activity',
        id: current.id,
        revisionId: String(current.revision),
        detailId: null,
        allocationId: null,
      },
    ],
    occurredAt: '2026-10-06T00:00:00Z',
    reason: null,
    expectedRevision: run.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  expect(run.run.origin).toEqual({ kind: 'unplanned' });
  return { f, activities, current, source };
}
for (const kind of ['fit', 'fixture'] as const) {
  it(`stores own local ${kind} current original and overlay; actual source deletion purges the sole payload`, async () => {
    const x = await importedActual(kind);
    const { p, result } = await snapshot(x.f.athlete, async (tx) => {
      const p = await prepared(tx, x.f.intent);
      const facts = p.basis.consumedUses.facts.filter(
        (f) =>
          f.identity.kind === 'activity-canonical-values' || f.identity.kind === 'activity-overlay',
      );
      expect(facts).toHaveLength(2);
      for (const fact of facts)
        expect(fact.sourcePurpose).toMatchObject({
          kind: 'own_imported_activity',
          sources: [
            {
              activityId: x.current.id,
              canonicalRevision: x.current.revision,
              source: { kind },
              overlayRevision: x.current.revision,
            },
          ],
        });
      return { p, result: await store(tx, p) };
    });
    expect(await snapshot(x.f.athlete, (tx) => read(tx, result.evidenceId))).toMatchObject({
      payload: p.payload,
    });
    await x.activities.deleteActivity(x.f.athlete, x.current.id, {
      expectedRevision: x.current.revision,
    });
    expect(await snapshot(x.f.athlete, (tx) => read(tx, result.evidenceId))).toMatchObject({
      payload: null,
      result,
    });
    expect(await snapshot(x.f.athlete, (tx) => store(tx, p))).toEqual(result);
    expect(await count(x.f.athlete)).toEqual({ evidence: 1, decision: 1, proposal: 1 });
  });
}

it('rejects forged local source-purpose tuples although original copied bodies remain intact', async () => {
  const x = await importedActual('fit');
  const p = await snapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent));
  const basis = {
    ...p.basis,
    consumedUses: {
      ...p.basis.consumedUses,
      facts: p.basis.consumedUses.facts.map((f) => ({
        ...f,
        sourcePurpose:
          f.sourcePurpose === null || f.sourcePurpose.kind === 'own_media_descriptor'
            ? f.sourcePurpose
            : {
                ...f.sourcePurpose,
                sources: f.sourcePurpose.sources.map((s) => ({
                  ...s,
                  source: { ...s.source, sourceId: 'FOREIGN-opaque-source' },
                })),
              },
      })),
    },
  };
  await expect(
    snapshot(x.f.athlete, (tx) =>
      store(tx, { ...p, basis, request: { ...p.request, expectedBasis: basis } }),
    ),
  ).rejects.toThrow('MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE');
  expect(await count(x.f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
  expect(await snapshot(x.f.athlete, (tx) => store(tx, p))).toMatchObject({
    applicable: false,
    approvalAllowed: false,
  });
});

it('stores manual recorded course and track metadata; original activity deletion purges through sealed lineage parents', async () => {
  const f = await seed(),
    activities = createActivityRepository(db),
    courses = createCourseRepository(db);
  const actual = await activities.createManualActivity(f.athlete, {
    idempotencyKey: randomUUID(),
    confirmed: true,
    activity: {
      title: 'Synthetic manual route',
      kind: 'running',
      startedAt: '2026-10-06T00:00:00Z',
      timezone: 'Asia/Seoul',
      durationSeconds: 600,
      durationKind: 'timer',
      distanceMeters: 1000,
    },
    report: { sessionRpe: null, note: null, planLink: null },
  });
  // Public upload lifecycle records synthetic descriptors only: no external binary bytes are verified.
  const track = await storeTrack(f.athlete, actual.activityId, actual.revision);
  const course = await courses.create(
    f.athlete,
    content({
      activityId: actual.activityId,
      trackId: track.trackId,
      mapPathSha: track.mapPathSha,
    }),
    randomUUID(),
  );
  if (course.status !== 'available') throw Error('FIXTURE_COURSE_UNAVAILABLE');
  const races = createRaceRepository(db);
  const original = await races.getRaceEvent(f.athlete, f.race.id);
  if (!original) throw Error('FIXTURE_EVENT_UNAVAILABLE');
  const { id: _id, revision: _revision, ...values } = original;
  const event = await races.updateRaceEvent(f.athlete, f.race.id, {
    expectedRevision: f.race.revision,
    idempotencyKey: randomUUID(),
    values: {
      ...values,
      course: {
        courseId: course.course.courseId,
        courseRevision: course.revision.courseRevision,
        revisionId: course.revision.revisionId,
      },
    },
  });
  const intent = { ...f.intent, expectedEvent: { id: event.id, revision: event.revision } };
  const otherCourse = await courses.create(
    f.athlete,
    content({
      activityId: actual.activityId,
      trackId: track.trackId,
      mapPathSha: track.mapPathSha,
      name: 'Second shared manual recording',
    }),
    randomUUID(),
  );
  if (otherCourse.status !== 'available') throw Error('FIXTURE_SECOND_COURSE_UNAVAILABLE');
  const secondEvent = await races.createRaceEvent(f.athlete, {
    idempotencyKey: randomUUID(),
    values: {
      ...values,
      title: 'Second same-lineage event',
      course: {
        courseId: otherCourse.course.courseId,
        courseRevision: otherCourse.revision.courseRevision,
        revisionId: otherCourse.revision.revisionId,
      },
    },
  });
  const second = await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, {
      ...intent,
      expectedEvent: { id: secondEvent.id, revision: secondEvent.revision },
    });
    return { p, result: await store(tx, p) };
  });
  const unrelatedEvent = await races.createRaceEvent(f.athlete, {
    idempotencyKey: randomUUID(),
    values: { ...values, title: 'Unrelated event', course: null },
  });
  const unrelated = await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, {
      ...intent,
      expectedEvent: { id: unrelatedEvent.id, revision: unrelatedEvent.revision },
    });
    return { p, result: await store(tx, p) };
  });
  const { p, result } = await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, intent);
    const facts = p.basis.consumedUses.facts.filter((f) =>
      ['course-revision', 'course-head-descriptor', 'activity-track-descriptor'].includes(
        f.identity.kind,
      ),
    );
    expect(facts).toHaveLength(3);
    for (const fact of facts)
      expect(fact.sourcePurpose).toMatchObject({
        kind: 'own_manual_lineage',
        sources: [{ activityId: actual.activityId, source: { kind: 'manual' } }],
      });
    return { p, result: await store(tx, p) };
  });
  await activities.deleteActivity(f.athlete, actual.activityId, {
    expectedRevision: actual.revision,
  });
  expect(await snapshot(f.athlete, (tx) => read(tx, result.evidenceId))).toMatchObject({
    payload: null,
    result,
  });
  expect(await snapshot(f.athlete, (tx) => store(tx, p))).toEqual(result);
  expect(await snapshot(f.athlete, (tx) => read(tx, second.result.evidenceId))).toMatchObject({
    payload: null,
    result: second.result,
  });
  expect(await snapshot(f.athlete, (tx) => store(tx, second.p))).toEqual(second.result);
  expect(await snapshot(f.athlete, (tx) => read(tx, unrelated.result.evidenceId))).toMatchObject({
    payload: unrelated.p.payload,
    result: unrelated.result,
  });
  // Owner inspection of synthetic audit metadata proves reuse of the actual source event,
  // rather than a newly minted self-claimed course suppression.
  const owner = new Pool({ connectionString: url(ownerRole) }),
    client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [f.athlete]);
    const rows = await client.query(
      'SELECT s.kind FROM manual_race_chain_suppression_v2 m JOIN restore_suppression_event s ON s.athlete_id=m.athlete_id AND s.event_id=m.event_id WHERE m.athlete_id=$1 AND m.evidence_id=$2',
      [f.athlete, result.evidenceId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((row) => row['kind'] === 'activity_deleted')).toBe(true);
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await owner.end();
  }
});

it('public collected Garmin attribution refuses a previously local FIT payload at the final SQL source predicate', async () => {
  const x = await importedActual('fit');
  const p = await snapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent));
  const collector = createGarminUnofficialStore(db);
  // Normal DB collector ledger port with synthetic attribution; no provider call or owner seed.
  await collector.recordCollected({
    athleteId: x.f.athlete,
    garminActivityId: '987654321',
    provider: 'garmin-connect-unofficial',
    outcome: 'imported',
    sources: [{ kind: x.source.kind, sourceId: x.source.sourceId }],
    now: new Date('2026-10-07T00:00:00Z'),
    appRevision: 1,
  });
  expect(await collector.provenance(x.f.athlete, x.current.id)).toMatchObject({
    provider: 'garmin-connect-unofficial',
    official: false,
  });
  await expect(snapshot(x.f.athlete, (tx) => store(tx, p))).rejects.toThrow(
    'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE',
  );
  expect(await count(x.f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});

it('public FIT recorded-course lineage is unavailable for manual-purpose storage, despite owned valid course and track descriptors', async () => {
  const f = await seed(),
    activities = createActivityRepository(db),
    courses = createCourseRepository(db);
  const imported = await activities.importActivity(f.athlete, {
    idempotencyKey: randomUUID(),
    source: {
      kind: 'fit',
      sourceId: `Imported-course-${randomUUID()}`,
      revision: 1,
      contentHash: 'b'.repeat(64),
    },
    activity: {
      title: 'Synthetic imported course source',
      kind: 'running',
      startedAt: '2026-10-06T00:00:00Z',
      timezone: 'Asia/Seoul',
      durationSeconds: 600,
      durationKind: 'timer',
      distanceMeters: 1000,
    },
  });
  const track = await storeTrack(f.athlete, imported.activityId, imported.revision);
  const course = await courses.create(
    f.athlete,
    content({
      activityId: imported.activityId,
      trackId: track.trackId,
      mapPathSha: track.mapPathSha,
    }),
    randomUUID(),
  );
  if (course.status !== 'available') throw Error('FIXTURE_IMPORTED_COURSE_UNAVAILABLE');
  const races = createRaceRepository(db),
    original = await races.getRaceEvent(f.athlete, f.race.id);
  if (!original) throw Error('FIXTURE_EVENT_UNAVAILABLE');
  const { id: _id, revision: _revision, ...values } = original;
  const event = await races.updateRaceEvent(f.athlete, original.id, {
    expectedRevision: original.revision,
    idempotencyKey: randomUUID(),
    values: {
      ...values,
      course: {
        courseId: course.course.courseId,
        courseRevision: course.revision.courseRevision,
        revisionId: course.revision.revisionId,
      },
    },
  });
  const actual = await snapshot(f.athlete, (tx) =>
    prepareRaceManualSemanticBasisV2In(
      tx,
      { ...f.intent, expectedEvent: { id: event.id, revision: event.revision } },
      null,
      { bytes: 0n, sources: 0 },
    ),
  );
  expect(actual.status).toBe('blocked');
  if (actual.status !== 'blocked' || !('prepared' in actual) || !('uses' in actual.prepared))
    throw Error('FIXTURE_EXPECTED_COURSE_USE_BLOCK');
  expect(
    actual.prepared.uses.facts.filter((f) =>
      ['course-revision', 'course-head-descriptor', 'activity-track-descriptor'].includes(
        f.identity.kind,
      ),
    ),
  ).toHaveLength(3);
  for (const fact of actual.prepared.uses.facts.filter((f) =>
    ['course-revision', 'course-head-descriptor', 'activity-track-descriptor'].includes(
      f.identity.kind,
    ),
  ))
    expect(fact).toMatchObject({
      use: 'blocked',
      reason: 'course_lineage_use_unavailable',
      sourcePurpose: null,
    });
  expect(await count(f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});
