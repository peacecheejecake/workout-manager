import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { privateTextResourceCreateSchema } from '@workout/contracts/resources';
import { createDatabase, type Database } from '../src/database.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createResourceAccessRepository } from '../src/resource-access.js';
import { createConsentRepository } from '../src/repositories.js';
import {
  captureResourceRetainedReadFacts,
  validateResourceRetainedReadFacts,
} from '../src/race-plan-impact-resource-read-facts.js';
import type { Transaction } from '../src/database.js';
import { RaceImpactDependencyError } from '../src/race-plan-impact-dependencies.js';
import {
  createResourceUrlIngestionRepository,
  createResourceUrlIngestionWorkerRepository,
} from '../src/resource-url-ingestions.js';
import { createResourceFileUploadRepository } from '../src/resource-file-uploads.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantResources,
  grantResourceUrlIngestionWorker,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Actual public producers on normal107. No DB execution by the preparing agent.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `resource_read_sources_${suffix}`;
const ownerRole = `resource_read_sources_owner_${suffix}`;
const runtimeRole = `resource_read_sources_app_${suffix}`;
const workerRole = `resource_read_sources_url_${suffix}`;
let worker: ReturnType<typeof createResourceUrlIngestionWorkerRepository>;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
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
  for (const role of [ownerRole, runtimeRole, workerRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole));
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
    expect(
      (
        await owner.query(
          'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0],
    ).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  } finally {
    await owner.end();
  }
  for (const grant of [grantCorePlanning, grantOperations, grantResources])
    await grant(url(ownerRole), runtimeRole);
  await grantResourceUrlIngestionWorker(url(ownerRole), workerRole);
  worker = createResourceUrlIngestionWorkerRepository({ connectionString: url(workerRole) });
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await worker?.close();
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
const freshBudget = () => ({ bytes: 0n, sources: 0 });
const text = '첫 문단입니다. 🏃\n\nSecond paragraph with zero and unknown retained.';
const command = (value = text) =>
  privateTextResourceCreateSchema.parse({
    sourceKind: 'text',
    title: 'Synthetic private text',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: value,
    idempotencyKey: randomUUID(),
  });
async function seed(athlete: string = randomUUID()) {
  const repo = createPrivateTextResourceRepository(db);
  const result = await repo.create(athlete, command());
  if (result.status !== 'available') throw Error('FIXTURE_RESOURCE_UNAVAILABLE');
  return { athlete, repo, result };
}

async function capture(athlete: string, ids: readonly string[], budget = freshBudget()) {
  const queries: string[] = [];
  const result = await db.tenant(athlete, (tx) => {
    const traced: Transaction = {
      athleteId: tx.athleteId,
      query: async (sql, values) => {
        queries.push(sql);
        return tx.query(sql, values);
      },
    };
    return captureResourceRetainedReadFacts(traced, ids, budget);
  });
  return { result, queries };
}
async function app(athlete: string, granted: boolean) {
  const repo = createConsentRepository(db),
    prior = await repo.getConsent(athlete, 'app');
  return repo.setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision: prior?.revision ?? 0,
    idempotencyKey: randomUUID(),
  });
}
it('reads exact public current text with complete UTF8 hash and pinned UTF16 paragraphs without coach/AI eligibility', async () => {
  const { athlete, result } = await seed();
  await app(athlete, true);
  expect(await createConsentRepository(db).getConsent(athlete, 'ai')).toMatchObject({
    granted: false,
  });
  expect(result.resource).toMatchObject({ includeForCoach: false, reviewedState: 'unreviewed' });
  const totals = () =>
    db.tenant(
      athlete,
      async (tx) =>
        (
          await tx.query(
            `SELECT (SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1) AS receipts,
      (SELECT count(*)::int FROM outbox WHERE athlete_id=$1) AS outbox`,
            [athlete],
          )
        ).rows,
    );
  const before = await totals();
  const { result: facts } = await capture(athlete, [result.version.id]);
  expect(await totals()).toEqual(before);
  expect(facts).toMatchObject({
    requestedVersionIds: [result.version.id],
    authority: 'none',
    freshness: 'not_checked',
    facts: [
      {
        state: 'current',
        reason: null,
        record: result.version,
        current: {
          resourceId: result.resource.id,
          versionId: result.version.id,
          version: 1,
          accessRevision: result.resource.accessRevision,
          deleted: false,
        },
      },
    ],
  });
  expect(facts.facts[0]?.record?.contentHash).toBe(
    createHash('sha256').update(text, 'utf8').digest('hex'),
  );
  expect(facts.facts[0]?.record?.paragraphs).toEqual(result.version.paragraphs);
  expect(validateResourceRetainedReadFacts(facts).status).toBe('validated_read_sources');
});
it('retains exact historic immutable version after public append instead of substituting current', async () => {
  const { athlete, repo, result: first } = await seed();
  const second = await repo.appendVersion(athlete, first.resource.id, {
    expectedCurrentVersionId: first.version.id,
    text: 'New paragraph.',
    idempotencyKey: randomUUID(),
  });
  if (second.status !== 'available') throw Error('FIXTURE_RESOURCE_UNAVAILABLE');
  const { result: facts } = await capture(athlete, [second.version.id, first.version.id]);
  expect(facts.facts.find((f) => f.requestedVersionId === first.version.id)).toMatchObject({
    state: 'historical',
    record: first.version,
    current: {
      versionId: second.version.id,
      version: 2,
      accessRevision: second.resource.accessRevision,
    },
  });
  expect(facts.facts.find((f) => f.requestedVersionId === second.version.id)).toMatchObject({
    state: 'current',
    record: second.version,
  });
  expect(validateResourceRetainedReadFacts(facts).status).toBe('validated_read_sources');
});
it('public permission and app withdrawal do not erase or deny retained own text', async () => {
  const { athlete, result } = await seed();
  await app(athlete, true);
  const access = createResourceAccessRepository(db);
  const reviewed = await access.setReviewed(athlete, result.resource.id, {
    reviewed: true,
    expectedAccessRevision: result.resource.accessRevision,
    expectedCurrentVersionId: result.version.id,
    idempotencyKey: randomUUID(),
  });
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const enabled = await access.setCoachUse(athlete, result.resource.id, {
    includeForCoach: true,
    expectedAccessRevision: reviewed.accessRevision,
    expectedCurrentVersionId: result.version.id,
    idempotencyKey: randomUUID(),
  });
  const disabled = await access.setCoachUse(athlete, result.resource.id, {
    includeForCoach: false,
    expectedAccessRevision: enabled.accessRevision,
    expectedCurrentVersionId: result.version.id,
    idempotencyKey: randomUUID(),
  });
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'ai',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await app(athlete, false);
  const { result: facts } = await capture(athlete, [result.version.id]);
  expect(facts.facts[0]).toMatchObject({
    state: 'current',
    record: result.version,
    current: { accessRevision: disabled.accessRevision },
  });
  expect(validateResourceRetainedReadFacts(facts).status).toBe('validated_read_sources');
  expect(await createConsentRepository(db).getConsent(athlete, 'ai')).toMatchObject({
    granted: false,
  });
});
it('public deletion returns only current tombstone metadata for every requested version', async () => {
  const { athlete, repo, result: first } = await seed();
  const second = await repo.appendVersion(athlete, first.resource.id, {
    expectedCurrentVersionId: first.version.id,
    text: 'Second private body.',
    idempotencyKey: randomUUID(),
  });
  if (second.status !== 'available') throw Error('FIXTURE_RESOURCE_UNAVAILABLE');
  const input = {
    expectedAccessRevision: second.resource.accessRevision,
    expectedCurrentVersionId: second.version.id,
    idempotencyKey: randomUUID(),
  };
  const deleted = await repo.softDelete(athlete, first.resource.id, input);
  expect(await repo.softDelete(athlete, first.resource.id, input)).toEqual(deleted);
  const { result: facts } = await capture(athlete, [first.version.id, second.version.id]);
  expect(facts.facts).toHaveLength(2);
  for (const fact of facts.facts)
    expect(fact).toMatchObject({
      state: 'deleted',
      reason: null,
      record: null,
      current: { resourceId: first.resource.id, deleted: true },
    });
  expect(JSON.stringify(facts)).not.toContain(text);
  expect(JSON.stringify(facts)).not.toContain('Second private body.');
  expect(validateResourceRetainedReadFacts(facts).status).toBe('blocked');
});
it('populated foreign and absent versions have identical contentless ownership facts and true RLS', async () => {
  const { athlete, result } = await seed(),
    other = randomUUID(),
    absent = randomUUID();
  const { result: facts } = await capture(other, [result.version.id, absent]);
  for (const fact of facts.facts)
    expect(fact).toMatchObject({
      state: 'unavailable',
      reason: 'owned_version_unavailable',
      record: null,
      current: null,
    });
  expect(validateResourceRetainedReadFacts(facts).status).toBe('blocked');
  expect(
    (await capture(other, [result.version.id])).queries.some((sql) =>
      sql.includes('v.content,v.content_hash'),
    ),
  ).toBe(false);
  await db.tenant(other, async (tx) => {
    expect(
      (
        await tx.query('SELECT version_id FROM resource_version WHERE version_id=$1', [
          result.version.id,
        ])
      ).rows,
    ).toEqual([]);
  });
  expect((await capture(athlete, [result.version.id])).result.facts[0]?.state).toBe('current');
});
it('normalizes UUID case and deduplicates requested versions while charging pre-dedup visits', async () => {
  const { athlete, result } = await seed(),
    budget = freshBudget();
  const { result: facts } = await capture(
    athlete,
    [result.version.id.toUpperCase(), result.version.id],
    budget,
  );
  expect(facts.requestedVersionIds).toEqual([result.version.id]);
  expect(facts.facts).toHaveLength(1);
  expect(budget.sources).toBeGreaterThanOrEqual(2);
});
it('opaque unknown version IDs remain contentless instead of guessed UUID or SQL casts', async () => {
  const { athlete } = await seed();
  const { result: facts } = await capture(athlete, ['opaque-version']);
  expect(facts.facts[0]).toMatchObject({
    requestedVersionId: 'opaque-version',
    state: 'unavailable',
    reason: 'owned_version_unavailable',
    record: null,
    current: null,
  });
});
it('file finalized through actual public DB producer is unsupported without copying file descriptors', async () => {
  const athlete = randomUUID(),
    uploads = createResourceFileUploadRepository(db);
  const reserved = await uploads.reserveCreate(
    athlete,
    {
      sourceKind: 'file',
      title: 'Synthetic PDF',
      category: 'note',
      metadata: {},
      tags: [],
      favorite: false,
    },
    randomUUID(),
  );
  const hash = 'a'.repeat(64),
    storageRef = `private/v1/tenants/${athlete}/resources/${reserved.resourceId}/objects/uploads/${reserved.uploadId}/sha256/${hash}.pdf`;
  // DB object lifecycle fixture only; no disk/provider upload or PDF truth claim.
  await uploads.prepareObject(athlete, reserved.uploadId, {
    storageRef,
    file: {
      originalFileName: 'synthetic.pdf',
      extension: 'pdf',
      mediaType: 'application/pdf',
      byteSize: 1024,
      sha256: hash,
    },
  });
  await uploads.markStaged(athlete, reserved.uploadId);
  const finalized = await uploads.finalize(athlete, reserved.uploadId);
  if (finalized.status !== 'available') throw Error('FIXTURE_FILE_UNAVAILABLE');
  const { result: facts } = await capture(athlete, [finalized.version.id]);
  expect(facts.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'unsupported_source_kind',
    record: null,
  });
  expect(JSON.stringify(facts)).not.toContain(storageRef);
  expect(JSON.stringify(facts)).not.toContain('synthetic.pdf');
});
it('rejects 5001 requested visits and source budget overflow before any body transport', async () => {
  const { athlete, result } = await seed();
  await expect(
    capture(
      athlete,
      Array.from({ length: 5001 }, () => result.version.id),
    ),
  ).rejects.toBeInstanceOf(RaceImpactDependencyError);
  await expect(
    capture(athlete, [result.version.id], { bytes: 0n, sources: 5000 }),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'unique_sources' });
});
it('shared byte budget rejects a real text version at scalar preflight before body transport', async () => {
  const value = Array.from({ length: 8 }, () => '한'.repeat(1800)).join('\n\n');
  const athlete = randomUUID(),
    repo = createPrivateTextResourceRepository(db),
    created = await repo.create(athlete, command(value));
  if (created.status !== 'available') throw Error('FIXTURE_RESOURCE_UNAVAILABLE');
  const queries: string[] = [];
  await expect(
    db.tenant(athlete, (tx) =>
      captureResourceRetainedReadFacts(
        {
          athleteId: tx.athleteId,
          query: async (sql, values) => {
            queries.push(sql);
            return tx.query(sql, values);
          },
        },
        [created.version.id],
        { bytes: 4194304n - 4096n, sources: 0 },
      ),
    ),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE', bound: 'decoded_bytes' });
  expect(queries.some((sql) => sql.includes('octet_length'))).toBe(true);
  expect(queries.some((sql) => sql.includes('v.content,v.content_hash'))).toBe(false);
});

it('URL bookmark finalized through existing bounded worker is unavailable without fetching or copying URL/raw object', async () => {
  const athlete = randomUUID(),
    urls = createResourceUrlIngestionRepository(db),
    input = {
      title: 'Synthetic bookmark',
      category: 'note',
      metadata: {},
      tags: [],
      favorite: false,
      url: 'https://example.com/synthetic-resource',
    };
  const reserved = await urls.reserveCreate(athlete, input, randomUUID());
  const fetch = await worker.lease();
  if (!fetch || fetch.requestId !== reserved.requestId || fetch.phase !== 'fetch')
    throw Error('FIXTURE_URL_FETCH_LEASE');
  // Synthetic DB metadata only. No HTTP/DNS request or stored object bytes.
  await worker.recordHop(fetch, {
    index: 0,
    displayUrl: input.url,
    urlDigest: createHash('sha256').update(input.url).digest('hex'),
    responseStatus: 200,
    resolvedAddresses: ['93.184.216.34'],
    policyVersion: 'ssrf-v1',
  });
  const hash = 'b'.repeat(64),
    storageRef = `private/v1/tenants/${athlete}/resources/${reserved.resourceId}/url-ingestions/${reserved.requestId}/raw/sha256/${hash}.html`;
  await worker.prepareRaw(fetch, {
    storageRef,
    sha256: hash,
    sizeBytes: 100,
    mediaType: 'text/html',
  });
  expect(await worker.markRawPublished(fetch)).toBe(true);
  const parse = await worker.lease();
  if (!parse || parse.requestId !== reserved.requestId || parse.phase !== 'parse')
    throw Error('FIXTURE_URL_PARSE_LEASE');
  expect(
    await worker.bookmarkOnly(parse, { name: 'synthetic-parser', version: 'bookmark-v1' }),
  ).toBe(true);
  const { result: facts, queries } = await capture(athlete, [reserved.versionId]);
  expect(facts.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'unsupported_source_kind',
    record: null,
  });
  expect(JSON.stringify(facts)).not.toContain(input.url);
  expect(JSON.stringify(facts)).not.toContain(storageRef);
  expect(queries.some((sql) => sql.includes('v.content,v.content_hash'))).toBe(false);
});
