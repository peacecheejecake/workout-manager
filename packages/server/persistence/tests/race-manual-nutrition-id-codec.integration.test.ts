import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { raceManualPublicPrepareSchema } from '@workout/contracts/race-manual-public';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import {
  migrate,
  grantNutritionCore,
  grantRaces,
  grantCorePlanning,
  grantOperations,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root executes actual PG. Normal107 plus explicit122 predecessors+127 only.
// Direct owner calls to command_v1 exercise structural SQL validation, not
// source ownership, permission, review creation or approval. Actual source IDs
// below are produced through plain runtime public repositories, with identity
// FK-only owner setup. No health body seed or new runtime private grants.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `manual_public_id_${suffix}`;
const ownerRole = `manual_public_id_owner_${suffix}`;
const runtimeRole = `manual_public_id_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false;
let db: Database;
let owner: Pool;
let beforeProc: unknown;
let afterProc: unknown;
let beforeWire: unknown;
let afterWire: unknown;
let command: ReturnType<typeof raceManualPublicPrepareSchema.parse> & { idempotencyKey: string };
const itemIds = [
  'x'.repeat(201),
  '식사-' + 'x'.repeat(201),
  '한'.repeat(1001),
  '식사-😀'.repeat(201),
];
function url(role: string) {
  const result = new URL(adminUrl);
  result.pathname = `/${name}`;
  result.username = role;
  result.password = 'isolated';
  return result.toString();
}
const procQuery =
  "SELECT to_jsonb(p)-'prosrc' AS metadata,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS source FROM pg_proc p WHERE p.oid='public.race_manual_public_wire_v1(text)'::regprocedure";
async function validate(raw: unknown, key = command.idempotencyKey) {
  await owner.query('SELECT public.race_manual_public_command_v1($1::text,$2::text,$3::jsonb)', [
    'review',
    key,
    JSON.stringify(raw),
  ]);
}
function withItemId(itemId: unknown) {
  return {
    ...command,
    intent: {
      ...command.intent,
      resolutions: {
        nutrition: [{ ...command.intent.resolutions.nutrition[0], itemId }],
        routines: [],
      },
    },
  };
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  owner = new Pool({ connectionString: url(ownerRole) });
  for (const file of [
    '108_nutrition_race_disconnection.sql',
    '109_race_result_proof_lifecycle.sql',
    '110_nutrition_disconnection_lineage.sql',
    '111_race_result_preserved_proof_updates.sql',
    '112_training_plan_aggregate_history.sql',
    '113_race_media_cleanup_source.sql',
    '114_manual_review_owned_source_bindings_v2.sql',
    '115_manual_review_full_owned_source_bindings_v2.sql',
    '116_manual_race_chain_v2.sql',
    '118_race_manual_atomic_approval.sql',
    '120_manual_race_multi_owned_sources.sql',
    '121_routine_versioned_occurrences.sql',
    '122_race_manual_public_receipts.sql',
  ])
    await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  beforeProc = (await owner.query(procQuery)).rows[0];
  beforeWire = (
    await owner.query(
      "SELECT public.race_manual_public_wire_v1('review') AS review,public.race_manual_public_wire_v1('approve') AS approve,public.race_manual_public_wire_v1('reference') AS reference",
    )
  ).rows[0];
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  await grantNutritionCore(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, athlete],
  );
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic codec race',
      localDate: '2080-01-06',
      localStartTime: null,
      timezone: 'UTC',
      locationName: null,
      distance: { kind: 'standard', class: '5k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
  });
  const nutrition = await createNutritionRepository(db).savePlan(athlete, {
    kind: 'create',
    idempotencyKey: randomUUID(),
    confirmed: true,
    draft: {
      period: { from: '2080-01-01', toInclusive: '2080-01-31' },
      timezone: 'UTC',
      purpose: 'Canonical long identity producer',
      linkedTrainingPlanVersionId: null,
      items: itemIds.map((itemId) => ({
        id: itemId,
        category: 'before',
        title: 'Synthetic item',
        anchor: { kind: 'absolute', date: '2080-01-06', localTime: null, timezone: 'UTC' },
        foods: [
          {
            foodVersionId: null,
            description: 'Zero retained portion',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
        ],
        targets: [],
        instructions: 'Synthetic',
        evidenceIds: [],
        source: 'user_confirmed',
      })),
    },
  });
  command = {
    ...raceManualPublicPrepareSchema.parse({
      schemaVersion: 1,
      intent: {
        expectedEvent: { id: race.id, revision: race.revision },
        newLocalDate: '2080-01-08',
        selection: { kind: 'keep_plan' },
        resolutions: {
          nutrition: [
            {
              planVersionId: nutrition.versionId,
              itemId: itemIds[0],
              action: 'replace_anchor',
              anchor: { kind: 'absolute', date: '2080-01-08', localTime: '08:30', timezone: 'UTC' },
            },
          ],
          routines: [],
        },
      },
    }),
    idempotencyKey: 'synthetic_codec_127',
  };
  // Standalone rejection query keeps an aborted transaction out of later setup.
  await expect(validate(command)).rejects.toThrow('RACE_MANUAL_INVALID_COMMAND');
  await owner.query(
    await readFile(
      new URL('../migrations/127_manual_race_nutrition_resolution_id.sql', import.meta.url),
      'utf8',
    ),
  );
  afterProc = (await owner.query(procQuery)).rows[0];
  afterWire = (
    await owner.query(
      "SELECT public.race_manual_public_wire_v1('review') AS review,public.race_manual_public_wire_v1('approve') AS approve,public.race_manual_public_wire_v1('reference') AS reference",
    )
  ).rows[0];
});
afterAll(async () => {
  await db?.close();
  await owner?.end();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
const procSchema = z.strictObject({
  metadata: z.record(z.string(), z.unknown()),
  source: z.string().regex(/^[a-f0-9]{64}$/),
});
const wireSchema = z.strictObject({
  review: z.record(z.string(), z.unknown()),
  approve: z.unknown(),
  reference: z.unknown(),
});
function reviewItemSchema(raw: unknown) {
  return z
    .object({
      properties: z.object({
        intent: z.object({
          properties: z.object({
            resolutions: z.object({
              properties: z.object({
                nutrition: z.object({
                  items: z.object({
                    properties: z.object({ itemId: z.record(z.string(), z.unknown()) }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    })
    .parse(raw).properties.intent.properties.resolutions.properties.nutrition.items.properties
    .itemId;
}
it('replaces only one review scalar maximum and preserves all function metadata/OID/owner/ACL/config/security', async () => {
  const before = procSchema.parse(beforeProc),
    after = procSchema.parse(afterProc);
  expect(after.metadata).toEqual(before.metadata);
  expect(before.source).toBe('a6873605f15766bd36cd90e94de42593c6e4c1a879753f342cac3bdf6c11fe26');
  expect(after.source).toBe('11ec66ee9058b5bb09fe47a440fd91803d580231edacae77206a7965948782f8');
  const original = wireSchema.parse(beforeWire),
    next = wireSchema.parse(afterWire);
  expect(reviewItemSchema(original.review)).toEqual({
    type: 'string',
    minLength: 1,
    maxLength: 200,
  });
  expect(reviewItemSchema(next.review)).toEqual({ type: 'string', minLength: 1 });
  const expectedReview = (
    await owner.query(
      "SELECT $1::jsonb #- '{properties,intent,properties,resolutions,properties,nutrition,items,properties,itemId,maxLength}' AS body",
      [JSON.stringify(original.review)],
    )
  ).rows[0]?.['body'];
  expect(next.review).toEqual(expectedReview);
  expect(next.approve).toEqual(original.approve);
  expect(next.reference).toEqual(original.reference);
  expect(
    (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
      'version'
    ],
  ).toBe(107);
});
it('accepts canonical actual public201/Korean1001/surrogate item IDs without inventing a1000 limit', async () => {
  for (const itemId of itemIds) {
    const actual = withItemId(itemId);
    expect(
      raceManualPublicPrepareSchema.safeParse({
        schemaVersion: actual.schemaVersion,
        intent: actual.intent,
      }).success,
    ).toBe(true);
    await validate(actual);
  }
  // This suite tests the command codec, not fresh source membership or approval.
});
it('rejects empty/null/number item ID and unknown fields without widening strict inputs', async () => {
  for (const id of ['', null, 17])
    await expect(validate(withItemId(id))).rejects.toThrow('RACE_MANUAL_INVALID_COMMAND');
  await expect(validate({ ...command, privateContext: {} })).rejects.toThrow(
    'RACE_MANUAL_INVALID_COMMAND',
  );
  const malformed = withItemId(itemIds[0]);
  await expect(
    validate({
      ...malformed,
      intent: {
        ...malformed.intent,
        resolutions: {
          nutrition: malformed.intent.resolutions.nutrition.map((r) => ({
            ...r,
            sourceDigest: 'a'.repeat(64),
          })),
          routines: [],
        },
      },
    }),
  ).rejects.toThrow('RACE_MANUAL_INVALID_COMMAND');
});
it('keeps whole4MiB/nutrition5000/key and unrelated periodID bounds', async () => {
  await expect(validate(withItemId('x'.repeat(4194304)))).rejects.toThrow(
    'RACE_MANUAL_INVALID_COMMAND',
  );
  await expect(validate(command, 'another_key_127')).rejects.toThrow('RACE_MANUAL_INVALID_COMMAND');
  await expect(
    validate({
      ...command,
      intent: {
        ...command.intent,
        selection: {
          kind: 'move_period',
          expectedCurrentPlanVersionId: randomUUID(),
          periodId: 'x'.repeat(201),
          newStartDate: '2080-01-03',
          scope: 'period_only',
        },
      },
    }),
  ).rejects.toThrow('RACE_MANUAL_INVALID_COMMAND');
  await expect(
    validate({
      ...command,
      intent: {
        ...command.intent,
        resolutions: {
          nutrition: Array.from({ length: 5001 }, () => command.intent.resolutions.nutrition[0]),
          routines: [],
        },
      },
    }),
  ).rejects.toThrow('RACE_MANUAL_INVALID_COMMAND');
});
it('preserves historical122 checksum and denies runtime direct table mutation', async () => {
  const source = await readFile(
    new URL('../migrations/122_race_manual_public_receipts.sql', import.meta.url),
    'utf8',
  );
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    '14d85313329b6d0d8ae4e209efc219e45046fb2cd760109841864a72013d9dda',
  );
  const facts = (
    await owner.query(
      'SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',
      [[ownerRole, runtimeRole]],
    )
  ).rows;
  expect(facts).toHaveLength(2);
  for (const row of facts)
    expect(row).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  expect(
    (
      await owner.query(
        "SELECT has_table_privilege($1,'public.race_manual_public_receipt_v1','INSERT,UPDATE,DELETE') AS allowed",
        [runtimeRole],
      )
    ).rows[0]?.['allowed'],
  ).toBe(false);
});
