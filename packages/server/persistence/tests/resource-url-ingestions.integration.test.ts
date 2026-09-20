import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import {
  grantOperations,
  grantResources,
  grantResourceUrlIngestionWorker,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import {
  createResourceUrlIngestionRepository,
  createResourceUrlIngestionWorkerRepository,
  type ResourceUrlIngestionLease,
} from '../src/resource-url-ingestions.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let worker: ReturnType<typeof createResourceUrlIngestionWorkerRepository>;
const workerRole = `url_worker_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantResources(adminUrl, 'workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  await grantResourceUrlIngestionWorker(adminUrl, workerRole);
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  const workerUrl = new URL(adminUrl);
  workerUrl.username = workerRole;
  worker = createResourceUrlIngestionWorkerRepository({ connectionString: workerUrl.toString() });
});

afterAll(async () => {
  await worker?.close();
  await database?.close();
  await admin.query(`DROP OWNED BY "${workerRole}"`);
  await admin.query(`DROP ROLE "${workerRole}"`);
  await admin.end();
});

const input = {
  title: 'Fetched training paper',
  category: 'paper' as const,
  metadata: { author: 'Public author' },
  tags: ['url'],
  favorite: false,
  url: 'https://example.com/paper?tracking=server-only',
};

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function rawKey(lease: ResourceUrlIngestionLease, hash: string) {
  return `private/v1/tenants/${lease.athleteId}/resources/${lease.resourceId}/url-ingestions/${lease.requestId}/raw/sha256/${hash}.html`;
}

function parsedKey(lease: ResourceUrlIngestionLease, hash: string) {
  return `private/v1/tenants/${lease.athleteId}/resources/${lease.resourceId}/url-ingestions/${lease.requestId}/parsed/sha256/${hash}.json`;
}

async function publishRaw(lease: ResourceUrlIngestionLease, mediaType = 'text/html') {
  const suffix =
    mediaType === 'application/xhtml+xml'
      ? 'xhtml'
      : mediaType === 'text/plain'
        ? 'txt'
        : mediaType === 'text/markdown'
          ? 'md'
          : 'html';
  await worker.recordHop(lease, {
    index: 0,
    displayUrl: 'https://example.com/paper',
    urlDigest: sha(input.url),
    responseStatus: 200,
    resolvedAddresses: ['93.184.216.34'],
    policyVersion: 'ssrf-v1',
  });
  const rawHash = sha(`raw:${lease.requestId}`);
  const storageRef = rawKey(lease, rawHash).replace(/\.html$/, `.${suffix}`);
  await worker.prepareRaw(lease, { storageRef, sha256: rawHash, sizeBytes: 100, mediaType });
  expect(await worker.markRawPublished(lease)).toBe(true);
  return { rawHash, storageRef };
}

async function finishNext(expectedResourceId?: string) {
  const fetchLease = await worker.lease();
  if (!fetchLease || fetchLease.phase !== 'fetch') throw new Error('Expected fetch lease');
  if (expectedResourceId) expect(fetchLease.resourceId).toBe(expectedResourceId);
  await publishRaw(fetchLease);

  const parseLease = await worker.lease();
  if (!parseLease || parseLease.phase !== 'parse') throw new Error('Expected parse lease');
  expect(parseLease.requestId).toBe(fetchLease.requestId);
  expect(parseLease.rawMediaType).toBe('text/html');
  const text = 'First paragraph.\n\nSecond paragraph.';
  const parsedHash = sha(text);
  await worker.prepareParsed(parseLease, {
    storageRef: parsedKey(parseLease, parsedHash),
    sha256: parsedHash,
    sizeBytes: 200,
    text,
    fragments: [
      {
        ordinal: 0,
        kind: 'html_block',
        headingPath: ['Introduction'],
        text: 'First paragraph.',
        startOffset: 0,
        endOffset: 16,
        pageNumber: 1,
      },
      {
        ordinal: 1,
        kind: 'html_block',
        headingPath: ['Introduction'],
        text: 'Second paragraph.',
        startOffset: 18,
        endOffset: 35,
        pageNumber: 1,
      },
    ],
    parserName: 'bounded-html',
    parserVersion: '1',
  });
  expect(await worker.markParsedPublished(parseLease)).toBe(true);
  const finalized = await worker.finalize(parseLease);
  if (!finalized) throw new Error('Expected finalized ingestion');
  return { fetchLease, parseLease, finalized };
}

describe('M2-04c URL ingestion ledger', () => {
  it('reserves idempotently without exposing exact URLs and enforces tenant RLS', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const key = randomUUID();
    const first = await repo.reserveCreate(athlete, input, key);
    expect(first).toMatchObject({
      operation: 'create',
      state: 'queued',
      displayUrl: 'https://example.com/paper',
      attemptCount: 0,
    });
    expect(JSON.stringify(first)).not.toContain('tracking');
    expect(await repo.reserveCreate(athlete, input, key)).toEqual(first);
    await database.tenant(athlete, async (tx) => {
      expect(
        (
          await tx.query(
            "SELECT count(*)::integer AS count FROM outbox WHERE topic='resource.url_ingestion_requested'",
          )
        ).rows[0]?.['count'],
      ).toBe(1);
    });
    await expect(
      repo.reserveCreate(athlete, { ...input, title: 'Collision' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(repo.get(randomUUID(), first.requestId)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(
      await admin.query(
        'SELECT requested_url,display_url FROM resource_url_ingestion WHERE athlete_id=$1',
        [athlete],
      ),
    ).toMatchObject({
      rows: [{ requested_url: input.url, display_url: 'https://example.com/paper' }],
    });
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          'SELECT requested_url,raw_storage_ref,lease_token FROM resource_url_ingestion WHERE request_id=$1',
          [first.requestId],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
    expect(await repo.cancel(athlete, first.requestId)).toBe(true);
    await expect(
      repo.reserveCreate(
        athlete,
        { ...input, url: `https://example.com/${'가'.repeat(700)}` },
        randomUUID(),
      ),
    ).rejects.toThrow('INVALID_RESOURCE_URL');
    const prefix = 'https://example.com/';
    const boundary = await repo.reserveCreate(
      athlete,
      { ...input, url: `${prefix}${'a'.repeat(2048 - Buffer.byteLength(prefix, 'utf8'))}` },
      randomUUID(),
    );
    expect(boundary.state).toBe('queued');
    expect(await repo.cancel(athlete, boundary.requestId)).toBe(true);
    for (const url of [
      'https://example.com/path#fragment',
      ' https://example.com/path',
      'https://example.com/line\nbreak',
      'https://example.com/\ud800',
      'not a URL',
    ])
      await expect(repo.reserveCreate(athlete, { ...input, url }, randomUUID())).rejects.toThrow(
        'INVALID_RESOURCE_URL',
      );
  });

  it('persists public failure phase and retry metadata and rejects disallowed raw media', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const failed = await repo.reserveCreate(athlete, input, randomUUID());
    const failedLease = await worker.lease();
    if (!failedLease || failedLease.requestId !== failed.requestId)
      throw new Error('Expected failed ingestion lease');
    expect(
      await worker.fail(failedLease, 'FETCH_TIMEOUT', {
        retryable: true,
        retryAfterSeconds: 60,
      }),
    ).toBe(true);
    expect(await repo.get(athlete, failed.requestId)).toMatchObject({
      state: 'failed',
      failureCode: 'FETCH_TIMEOUT',
      failurePhase: 'fetch',
      retryable: true,
      failedAt: expect.any(String),
      retryAt: expect.any(String),
    });

    const invalid = await repo.reserveCreate(athlete, input, randomUUID());
    const invalidLease = await worker.lease();
    if (!invalidLease || invalidLease.requestId !== invalid.requestId)
      throw new Error('Expected invalid-media lease');
    const invalidHash = sha('pdf-not-allowed');
    await expect(
      worker.prepareRaw(invalidLease, {
        storageRef: rawKey(invalidLease, invalidHash).replace(/\.html$/, '.pdf'),
        sha256: invalidHash,
        sizeBytes: 100,
        mediaType: 'application/pdf',
      }),
    ).rejects.toThrow();
    await worker.fail(invalidLease, 'UNSUPPORTED_MEDIA_TYPE');

    for (const mediaType of ['text/plain', 'text/markdown'] as const) {
      const allowed = await repo.reserveCreate(athlete, input, randomUUID());
      const fetchLease = await worker.lease();
      if (!fetchLease || fetchLease.requestId !== allowed.requestId)
        throw new Error('Expected allowlisted-media lease');
      await publishRaw(fetchLease, mediaType);
      const parseLease = await worker.lease();
      if (!parseLease || parseLease.requestId !== allowed.requestId)
        throw new Error('Expected allowlisted-media parse lease');
      expect(parseLease.rawMediaType).toBe(mediaType);
      expect(await worker.fail(parseLease, 'PARSE_TEST')).toBe(true);
    }
  });

  it('releases due retryable failures and closes retryability at the attempt limit', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const reserved = await repo.reserveCreate(athlete, input, randomUUID());
    let lease = await worker.lease();
    if (!lease || lease.requestId !== reserved.requestId) throw new Error('Expected retry lease');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(lease.attemptNo).toBe(attempt);
      expect(
        await worker.fail(lease, 'FETCH_TIMEOUT', {
          retryable: true,
          retryAfterSeconds: 0,
        }),
      ).toBe(true);
      if (attempt < 5) {
        const retried = await worker.lease();
        if (!retried || retried.requestId !== reserved.requestId)
          throw new Error('Expected due retry lease');
        lease = retried;
      }
    }
    expect(await repo.get(athlete, reserved.requestId)).toMatchObject({
      state: 'failed',
      attemptCount: 5,
      retryable: false,
      retryAt: null,
    });
  });

  it('preserves published raw input across retryable parse failures and reclaims parse work', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const reserved = await repo.reserveCreate(athlete, input, randomUUID());
    const fetchLease = await worker.lease();
    if (!fetchLease || fetchLease.requestId !== reserved.requestId)
      throw new Error('Expected parse-retry fetch lease');
    const raw = await publishRaw(fetchLease);
    const parseLease = await worker.lease();
    if (!parseLease || parseLease.requestId !== reserved.requestId || parseLease.phase !== 'parse')
      throw new Error('Expected parse-retry parse lease');
    expect(
      await worker.fail(parseLease, 'PARSER_TRANSIENT', {
        retryable: true,
        retryAfterSeconds: 0,
      }),
    ).toBe(true);
    expect(
      await admin.query(
        'SELECT count(*)::integer AS count FROM resource_object_cleanup WHERE storage_ref=$1',
        [raw.storageRef],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });
    const retry = await worker.lease();
    expect(retry).toMatchObject({
      requestId: reserved.requestId,
      phase: 'parse',
      rawStorageRef: raw.storageRef,
    });
    if (!retry) throw new Error('Expected reclaimed parse lease');
    await worker.fail(retry, 'PARSER_PERMANENT');
  });

  it('routes a late publisher through durable cleanup without deleting an adopted object', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const reserved = await repo.reserveCreate(athlete, input, randomUUID());
    const firstLease = await worker.lease(1);
    if (!firstLease || firstLease.requestId !== reserved.requestId)
      throw new Error('Expected first shared-object lease');
    await worker.recordHop(firstLease, {
      index: 0,
      displayUrl: 'https://example.com/paper',
      urlDigest: sha(input.url),
      responseStatus: 200,
      resolvedAddresses: ['93.184.216.34'],
      policyVersion: 'ssrf-v1',
    });
    const rawHash = sha(`shared:${firstLease.requestId}`);
    const storageRef = rawKey(firstLease, rawHash);
    expect(
      await worker.prepareRaw(firstLease, {
        storageRef,
        sha256: rawHash,
        sizeBytes: 100,
        mediaType: 'text/html',
      }),
    ).toBe(true);
    await admin.query(
      `UPDATE resource_url_ingestion SET lease_until=clock_timestamp()-interval '1 second'
       WHERE request_id=$1`,
      [firstLease.requestId],
    );
    const adoptingLease = await worker.lease();
    if (!adoptingLease || adoptingLease.requestId !== reserved.requestId)
      throw new Error('Expected adopting shared-object lease');
    expect(adoptingLease.leaseToken).not.toBe(firstLease.leaseToken);
    expect(
      await worker.prepareRaw(adoptingLease, {
        storageRef,
        sha256: rawHash,
        sizeBytes: 100,
        mediaType: 'text/html',
      }),
    ).toBe(true);
    expect(await worker.markRawPublished(adoptingLease)).toBe(true);
    expect(await worker.abandonPublishedObject(firstLease, storageRef)).toBe(true);

    const cleanup = await admin.query(
      'SELECT id FROM resource_object_cleanup WHERE storage_ref=$1 AND completed_at IS NULL',
      [storageRef],
    );
    const cleanupId = String(cleanup.rows[0]?.['id']);
    const cleanupWorker = randomUUID();
    await admin.query(
      `UPDATE resource_object_cleanup SET attempts=1,lease_owner=$2,
       lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1`,
      [cleanupId, cleanupWorker],
    );
    expect(
      (
        await admin.query('SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)', [
          cleanupId,
          cleanupWorker,
          '2999-01-01T00:00:00.000Z',
        ])
      ).rows,
    ).toEqual([]);
    expect(
      await admin.query(
        'SELECT completed_at,last_error_code FROM resource_object_cleanup WHERE id=$1',
        [cleanupId],
      ),
    ).toMatchObject({
      rows: [{ completed_at: expect.any(Date), last_error_code: 'REFERENCE_PRESENT' }],
    });
    const parseLease = await worker.lease();
    if (!parseLease || parseLease.requestId !== reserved.requestId)
      throw new Error('Expected terminal cleanup parse lease');
    await worker.fail(parseLease, 'PARSER_PERMANENT');
  });

  it('keeps an account-erasure deletion fence active across late publication', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const reserved = await repo.reserveCreate(athlete, input, randomUUID());
    const lease = await worker.lease();
    if (!lease || lease.requestId !== reserved.requestId)
      throw new Error('Expected erased-account publication lease');
    const rawHash = sha(`erased:${lease.requestId}`);
    const storageRef = rawKey(lease, rawHash);
    expect(
      await worker.prepareRaw(lease, {
        storageRef,
        sha256: rawHash,
        sizeBytes: 100,
        mediaType: 'text/html',
      }),
    ).toBe(true);
    const previousCleanupId = randomUUID();
    const previousCleanupWorker = randomUUID();
    const fileResourceId = randomUUID();
    const fileVersionId = randomUUID();
    const fileUploadId = randomUUID();
    const fileTemporaryRef = `private/v1/tenants/${athlete}/resources/${fileResourceId}/uploads/${fileUploadId}/temporary`;
    const fileStorageRef = `private/v1/tenants/${athlete}/resources/${fileResourceId}/versions/${fileVersionId}/sha256/${'f'.repeat(64)}.pdf`;
    await admin.query(
      `INSERT INTO resource_upload_intent
       (athlete_id,upload_id,idempotency_key,request_digest,operation,resource_id,version_id,
        temporary_ref,storage_ref,source_kind,title,category,metadata,tags,favorite,
        original_filename,media_type,size_bytes,content_hash,state,failure_code,
        created_at,updated_at,expires_at,prepared_at)
       VALUES($1,$2,$3,$4,'create',$5,$6,$7,$8,'file','Erased upload','paper','{}','[]',false,
        'erased.pdf','application/pdf',100,$9,'failed','UPLOAD_EXPIRED',
        clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp())`,
      [
        athlete,
        fileUploadId,
        `erase-${fileUploadId}`,
        'e'.repeat(64),
        fileResourceId,
        fileVersionId,
        fileTemporaryRef,
        fileStorageRef,
        'f'.repeat(64),
      ],
    );
    const previousFileCleanupId = randomUUID();
    const previousFileCleanupWorker = randomUUID();
    await admin.query(
      `INSERT INTO resource_object_cleanup
       (id,storage_ref,reason,attempts,lease_owner,lease_until,delete_authorized_at,available_at,created_at)
       VALUES($1,$2,'upload_abandoned',1,$3,clock_timestamp()+interval '1 minute',
          clock_timestamp(),clock_timestamp(),clock_timestamp()),
        ($4,$5,'upload_abandoned',100,$6,clock_timestamp()+interval '1 minute',
          clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [
        previousCleanupId,
        storageRef,
        previousCleanupWorker,
        previousFileCleanupId,
        fileStorageRef,
        previousFileCleanupWorker,
      ],
    );
    await createOperationsRepository(database).eraseAccount(athlete);
    expect(
      await admin.query(
        'SELECT count(*)::integer AS count FROM resource_url_ingestion WHERE request_id=$1',
        [lease.requestId],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });
    expect(
      (
        await admin.query(
          'SELECT public.finish_resource_object_cleanup($1,$2,true,NULL,$3) AS finished',
          [previousCleanupId, previousCleanupWorker, '2999-01-01T00:00:00.000Z'],
        )
      ).rows[0]?.['finished'],
    ).toBe(false);
    expect(
      (
        await admin.query(
          'SELECT public.finish_resource_object_cleanup($1,$2,true,NULL,$3) AS finished',
          [previousFileCleanupId, previousFileCleanupWorker, '2999-01-01T00:00:00.000Z'],
        )
      ).rows[0]?.['finished'],
    ).toBe(false);
    expect(
      await admin.query(
        `SELECT storage_ref,reason,attempts,lease_owner,completed_at
         FROM resource_object_cleanup WHERE storage_ref=ANY($1::text[])
         ORDER BY storage_ref`,
        [[fileStorageRef, fileTemporaryRef]],
      ),
    ).toMatchObject({
      rows: [
        {
          storage_ref: fileStorageRef,
          reason: 'account_erased',
          attempts: 0,
          lease_owner: null,
          completed_at: null,
        },
        {
          storage_ref: fileTemporaryRef,
          reason: 'account_erased',
          attempts: 0,
          lease_owner: null,
          completed_at: null,
        },
      ].sort((left, right) => left.storage_ref.localeCompare(right.storage_ref)),
    });
    const cleanup = await admin.query(
      `SELECT id,reason FROM resource_object_cleanup
       WHERE storage_ref=$1 AND completed_at IS NULL`,
      [storageRef],
    );
    expect(cleanup.rows[0]).toMatchObject({ reason: 'account_erased' });
    expect(cleanup.rows[0]?.['id']).not.toBe(previousCleanupId);
    const cleanupId = String(cleanup.rows[0]?.['id']);
    const cleanupWorker = randomUUID();
    await admin.query(
      `UPDATE resource_object_cleanup SET attempts=1,lease_owner=$2,
       lease_until=clock_timestamp()+interval '1 minute',delete_authorized_at=clock_timestamp()
       WHERE id=$1`,
      [cleanupId, cleanupWorker],
    );
    expect(await worker.abandonPublishedObject(lease, rawKey(lease, sha('unreserved')))).toBe(
      false,
    );
    expect(await worker.abandonPublishedObject(lease, storageRef)).toBe(true);
    expect(
      (
        await admin.query(
          'SELECT public.finish_resource_object_cleanup($1,$2,true,NULL,$3) AS finished',
          [cleanupId, cleanupWorker, '2999-01-01T00:00:00.000Z'],
        )
      ).rows[0]?.['finished'],
    ).toBe(true);
    expect(
      await admin.query(
        `SELECT completed_at,reason,attempts,last_error_code,available_at>clock_timestamp() AS scheduled
         FROM resource_object_cleanup WHERE storage_ref=$1`,
        [storageRef],
      ),
    ).toMatchObject({
      rows: [
        {
          completed_at: null,
          reason: 'account_erased',
          attempts: 0,
          last_error_code: 'ERASURE_FENCE_ACTIVE',
          scheduled: true,
        },
      ],
    });
  });

  it('cancels retryable failures and closes active attempts on cancel and reap', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const retryable = await repo.reserveCreate(athlete, input, randomUUID());
    const retryableLease = await worker.lease();
    if (!retryableLease || retryableLease.requestId !== retryable.requestId)
      throw new Error('Expected retryable cancellation lease');
    await worker.fail(retryableLease, 'FETCH_TIMEOUT', {
      retryable: true,
      retryAfterSeconds: 60,
    });
    expect(await repo.cancel(athlete, retryable.requestId)).toBe(true);
    expect(await repo.get(athlete, retryable.requestId)).toMatchObject({
      state: 'cancelled',
      retryable: false,
      retryAt: null,
    });

    const active = await repo.reserveCreate(athlete, input, randomUUID());
    const activeLease = await worker.lease();
    if (!activeLease || activeLease.requestId !== active.requestId)
      throw new Error('Expected active cancellation lease');
    expect(await repo.cancel(athlete, active.requestId)).toBe(true);
    expect(
      await admin.query(
        `SELECT status,failure_code,completed_at FROM resource_url_ingestion_attempt
         WHERE athlete_id=$1 AND request_id=$2`,
        [athlete, active.requestId],
      ),
    ).toMatchObject({
      rows: [{ status: 'failed', failure_code: 'USER_CANCELLED', completed_at: expect.any(Date) }],
    });

    const expired = await repo.reserveCreate(athlete, input, randomUUID());
    const expiredLease = await worker.lease();
    if (!expiredLease || expiredLease.requestId !== expired.requestId)
      throw new Error('Expected reap lease');
    await admin.query(
      `UPDATE resource_url_ingestion SET created_at=clock_timestamp()-interval '10 minutes',
       expires_at=clock_timestamp()-interval '1 second'
       WHERE athlete_id=$1 AND request_id=$2`,
      [athlete, expired.requestId],
    );
    expect(await worker.reap(100)).toBe(1);
    expect(
      await admin.query(
        `SELECT status,failure_code,completed_at FROM resource_url_ingestion_attempt
         WHERE athlete_id=$1 AND request_id=$2`,
        [athlete, expired.requestId],
      ),
    ).toMatchObject({
      rows: [
        { status: 'failed', failure_code: 'INGESTION_EXPIRED', completed_at: expect.any(Date) },
      ],
    });
  });

  it('finalizes bookmark-only snapshots and reuses requested URL for omitted append URLs', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const created = await repo.reserveCreate(athlete, input, randomUUID());
    const fetchLease = await worker.lease();
    if (!fetchLease || fetchLease.requestId !== created.requestId)
      throw new Error('Expected bookmark fetch lease');
    const raw = await publishRaw(fetchLease, 'application/xhtml+xml');
    const parseLease = await worker.lease();
    if (!parseLease || parseLease.requestId !== created.requestId)
      throw new Error('Expected bookmark parse lease');
    expect(
      await worker.bookmarkOnly(parseLease, { name: 'bounded-html', version: 'bookmark-v1' }),
    ).toBe(true);
    expect(await repo.get(athlete, created.requestId)).toMatchObject({ state: 'bookmark_only' });
    expect(
      await admin.query(
        `SELECT v.content,v.content_hash,v.paragraphs,v.content_status,v.index_status,i.parser_name,i.parser_version,
          (SELECT count(*)::integer FROM resource_url_artifact a WHERE a.version_id=v.version_id) AS artifacts
         FROM resource_version v JOIN resource_url_ingestion i
           ON i.athlete_id=v.athlete_id AND i.version_id=v.version_id
         WHERE v.athlete_id=$1 AND v.version_id=$2`,
        [athlete, created.versionId],
      ),
    ).toMatchObject({
      rows: [
        {
          content: null,
          content_hash: raw.rawHash,
          paragraphs: [],
          content_status: 'bookmark_only',
          index_status: 'not_indexed',
          parser_name: 'bounded-html',
          parser_version: 'bookmark-v1',
          artifacts: 1,
        },
      ],
    });
    const appended = await repo.reserveAppend(
      athlete,
      created.resourceId,
      { expectedCurrentVersionId: created.versionId },
      randomUUID(),
    );
    expect(appended.operation).toBe('append');
    expect(
      await admin.query(
        'SELECT requested_url FROM resource_url_ingestion WHERE athlete_id=$1 AND request_id=$2',
        [athlete, appended.requestId],
      ),
    ).toMatchObject({ rows: [{ requested_url: input.url }] });
    expect(await repo.cancel(athlete, appended.requestId)).toBe(true);
  });

  it('leases through the minimal role, bounds hops and atomically finalizes immutable artifacts', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const reserved = await repo.reserveCreate(athlete, input, randomUUID());
    const result = await finishNext(reserved.resourceId);
    expect(result.finalized).toEqual({
      resource_id: reserved.resourceId,
      version_id: reserved.versionId,
    });
    expect(await repo.get(athlete, reserved.requestId)).toMatchObject({ state: 'finalized' });
    expect(
      await admin.query(
        `SELECT r.source_kind,r.reviewed_state,r.include_for_coach,v.content_status,v.index_status,
          (SELECT count(*)::integer FROM resource_url_artifact a WHERE a.version_id=v.version_id) AS artifacts,
          (SELECT count(*)::integer FROM resource_url_locator l WHERE l.version_id=v.version_id) AS locators
         FROM resource r JOIN resource_version v ON v.athlete_id=r.athlete_id AND v.version_id=r.current_version_id
         WHERE r.athlete_id=$1 AND r.id=$2`,
        [athlete, reserved.resourceId],
      ),
    ).toMatchObject({
      rows: [
        {
          source_kind: 'url',
          reviewed_state: 'unreviewed',
          include_for_coach: false,
          content_status: 'parsed',
          index_status: 'not_indexed',
          artifacts: 2,
          locators: 2,
        },
      ],
    });
    expect(
      (
        await admin.query(
          `SELECT ordinal,kind,heading_path,paragraph_index,page_number
           FROM resource_url_locator WHERE athlete_id=$1 AND version_id=$2 ORDER BY ordinal`,
          [athlete, reserved.versionId],
        )
      ).rows,
    ).toEqual([
      {
        ordinal: 0,
        kind: 'html_block',
        heading_path: ['Introduction'],
        paragraph_index: null,
        page_number: 1,
      },
      {
        ordinal: 1,
        kind: 'html_block',
        heading_path: ['Introduction'],
        paragraph_index: null,
        page_number: 1,
      },
    ]);
    const privileges = await admin.query(
      `SELECT has_table_privilege($1,'resource_url_ingestion','SELECT') AS can_read,
       has_column_privilege($1,'resource_url_ingestion','requested_url','SELECT') AS can_read_url,
       has_column_privilege($1,'resource_url_ingestion','display_url','SELECT') AS can_read_display,
       has_function_privilege($1,'public.lease_resource_url_ingestion(uuid,interval)','EXECUTE') AS can_lease,
       has_function_privilege('workout_runtime','public.erase_account_before_url_resources(text)',
         'EXECUTE') AS runtime_can_bypass_erasure_wrapper`,
      [workerRole],
    );
    expect(privileges.rows[0]).toEqual({
      can_read: false,
      can_read_url: false,
      can_read_display: false,
      can_lease: true,
      runtime_can_bypass_erasure_wrapper: false,
    });
    const liveArtifact = String(
      (
        await admin.query(
          `SELECT storage_ref FROM resource_url_artifact
           WHERE athlete_id=$1 AND version_id=$2 AND kind='raw'`,
          [athlete, reserved.versionId],
        )
      ).rows[0]?.['storage_ref'],
    );
    const cleanupId = randomUUID();
    const cleanupWorker = randomUUID();
    await admin.query(
      `INSERT INTO resource_object_cleanup
       (id,storage_ref,reason,attempts,lease_owner,lease_until,available_at,created_at)
       VALUES($1,$2,'upload_abandoned',1,$3,clock_timestamp()+interval '1 minute',
        clock_timestamp(),clock_timestamp())`,
      [cleanupId, liveArtifact, cleanupWorker],
    );
    expect(
      (
        await admin.query('SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)', [
          cleanupId,
          cleanupWorker,
          '2999-01-01T00:00:00.000Z',
        ])
      ).rows,
    ).toEqual([]);
    expect(
      await admin.query(
        'SELECT completed_at,last_error_code FROM resource_object_cleanup WHERE id=$1',
        [cleanupId],
      ),
    ).toMatchObject({
      rows: [{ completed_at: expect.any(Date), last_error_code: 'REFERENCE_PRESENT' }],
    });
    expect(() =>
      worker.recordHop(result.fetchLease, {
        index: 6,
        displayUrl: 'https://example.com/too-many',
        urlDigest: sha('too-many'),
        resolvedAddresses: ['93.184.216.34'],
        policyVersion: 'ssrf-v1',
      }),
    ).toThrow();
    await expect(
      admin.query('UPDATE resource_url_artifact SET size_bytes=size_bytes+1 WHERE version_id=$1', [
        reserved.versionId,
      ]),
    ).rejects.toThrow('IMMUTABLE_RESOURCE_URL_RECORD');
  });

  it('validates locator offsets as UTF-16 code units across non-BMP characters', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const accepted = await repo.reserveCreate(athlete, input, randomUUID());
    const acceptedFetch = await worker.lease();
    if (!acceptedFetch || acceptedFetch.requestId !== accepted.requestId)
      throw new Error('Expected UTF-16 fetch lease');
    await publishRaw(acceptedFetch);
    const acceptedParse = await worker.lease();
    if (!acceptedParse || acceptedParse.requestId !== accepted.requestId)
      throw new Error('Expected UTF-16 parse lease');
    const text = 'A😀B';
    const acceptedHash = sha(text);
    await worker.prepareParsed(acceptedParse, {
      storageRef: parsedKey(acceptedParse, acceptedHash),
      sha256: acceptedHash,
      sizeBytes: 20,
      text,
      fragments: [
        {
          ordinal: 0,
          kind: 'html_block',
          headingPath: [],
          text: '😀',
          startOffset: 1,
          endOffset: 3,
        },
      ],
      parserName: 'bounded-html',
      parserVersion: '1',
    });
    await worker.markParsedPublished(acceptedParse);
    await expect(worker.finalize(acceptedParse)).resolves.toMatchObject({
      resource_id: accepted.resourceId,
    });

    const rejected = await repo.reserveCreate(athlete, input, randomUUID());
    const rejectedFetch = await worker.lease();
    if (!rejectedFetch || rejectedFetch.requestId !== rejected.requestId)
      throw new Error('Expected split-surrogate fetch lease');
    await publishRaw(rejectedFetch);
    const rejectedParse = await worker.lease();
    if (!rejectedParse || rejectedParse.requestId !== rejected.requestId)
      throw new Error('Expected split-surrogate parse lease');
    const rejectedHash = sha(`split:${text}`);
    await worker.prepareParsed(rejectedParse, {
      storageRef: parsedKey(rejectedParse, rejectedHash),
      sha256: rejectedHash,
      sizeBytes: 20,
      text,
      fragments: [
        {
          ordinal: 0,
          kind: 'html_block',
          headingPath: [],
          text: '😀',
          startOffset: 1,
          endOffset: 2,
        },
      ],
      parserName: 'bounded-html',
      parserVersion: '1',
    });
    await worker.markParsedPublished(rejectedParse);
    await expect(worker.finalize(rejectedParse)).rejects.toThrow('INVALID_URL_LOCATOR');
    await worker.fail(rejectedParse, 'INVALID_URL_LOCATOR');
  });

  it('serializes quota checks and finalization with the tenant resource lock', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const reserved = await repo.reserveCreate(athlete, input, randomUUID());
    const fetchLease = await worker.lease();
    if (!fetchLease || fetchLease.requestId !== reserved.requestId)
      throw new Error('Expected quota-lock fetch lease');
    await publishRaw(fetchLease);
    const parseLease = await worker.lease();
    if (!parseLease || parseLease.requestId !== reserved.requestId)
      throw new Error('Expected quota-lock parse lease');
    const text = 'Serialized finalization';
    const parsedHash = sha(text);
    await worker.prepareParsed(parseLease, {
      storageRef: parsedKey(parseLease, parsedHash),
      sha256: parsedHash,
      sizeBytes: 40,
      text,
      fragments: [
        {
          ordinal: 0,
          kind: 'html_block',
          headingPath: [],
          text,
          startOffset: 0,
          endOffset: text.length,
        },
      ],
      parserName: 'bounded-html',
      parserVersion: '1',
    });
    await worker.markParsedPublished(parseLease);

    const locker = await admin.connect();
    let finalizePromise: ReturnType<typeof worker.finalize> | undefined;
    let committed = false;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      finalizePromise = worker.finalize(parseLease);
      let waitEventType: string | null = null;
      for (let poll = 0; poll < 50 && waitEventType === null; poll += 1) {
        const activity = await admin.query(
          `SELECT wait_event_type FROM pg_stat_activity
           WHERE usename=$1 AND query LIKE 'SELECT * FROM public.finalize_resource_url_ingestion%'
             AND state='active'`,
          [workerRole],
        );
        waitEventType =
          (activity.rows[0]?.['wait_event_type'] as string | null | undefined) ?? null;
        if (waitEventType === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitEventType).toBe('Lock');
      await locker.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await locker.query('ROLLBACK');
      locker.release();
    }
    if (!finalizePromise) throw new Error('Expected blocked finalization');
    await expect(finalizePromise).resolves.toMatchObject({ resource_id: reserved.resourceId });
  });

  it('rechecks append CAS and queues all raw, parsed and temporary refs on soft delete', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const base = await repo.reserveCreate(athlete, input, randomUUID());
    await finishNext(base.resourceId);
    const appendA = await repo.reserveAppend(
      athlete,
      base.resourceId,
      { expectedCurrentVersionId: base.versionId },
      randomUUID(),
    );
    const appendB = await repo.reserveAppend(
      athlete,
      base.resourceId,
      { expectedCurrentVersionId: base.versionId, url: input.url },
      randomUUID(),
    );
    await finishNext(base.resourceId);
    const fetchB = await worker.lease();
    if (!fetchB) throw new Error('Expected competing fetch');
    await worker.recordHop(fetchB, {
      index: 0,
      displayUrl: 'https://example.com/paper',
      urlDigest: sha(input.url),
      responseStatus: 200,
      resolvedAddresses: ['93.184.216.34'],
      policyVersion: 'ssrf-v1',
    });
    const rawHash = sha(`raw:${fetchB.requestId}`);
    await worker.prepareRaw(fetchB, {
      storageRef: rawKey(fetchB, rawHash),
      sha256: rawHash,
      sizeBytes: 100,
      mediaType: 'text/html',
    });
    await worker.markRawPublished(fetchB);
    const parseB = await worker.lease();
    if (!parseB) throw new Error('Expected competing parse');
    const parsedHash = sha('Competing text');
    await worker.prepareParsed(parseB, {
      storageRef: parsedKey(parseB, parsedHash),
      sha256: parsedHash,
      sizeBytes: 20,
      text: 'Competing text',
      fragments: [
        {
          ordinal: 0,
          kind: 'html_block',
          headingPath: [],
          text: 'Competing text',
          startOffset: 0,
          endOffset: 14,
        },
      ],
      parserName: 'bounded-html',
      parserVersion: '1',
    });
    await worker.markParsedPublished(parseB);
    await expect(worker.finalize(parseB)).rejects.toThrow('REVISION_CONFLICT');
    expect(
      await worker.fail(parseB, 'REVISION_CONFLICT', {
        retryable: true,
        retryAfterSeconds: 60,
      }),
    ).toBe(true);
    expect(new Set([appendA.requestId, appendB.requestId])).toContain(parseB.requestId);

    const current = await admin.query(
      'SELECT current_version_id,access_revision FROM resource WHERE athlete_id=$1 AND id=$2',
      [athlete, base.resourceId],
    );
    const currentVersion = String(current.rows[0]?.['current_version_id']);
    await createPrivateTextResourceRepository(database).softDelete(athlete, base.resourceId, {
      expectedAccessRevision: Number(current.rows[0]?.['access_revision']),
      expectedCurrentVersionId: currentVersion,
      idempotencyKey: randomUUID(),
    });
    expect(
      Number(
        (
          await admin.query(
            `SELECT count(*)::integer AS count FROM resource_object_cleanup
             WHERE storage_ref LIKE $1 AND completed_at IS NULL`,
            [`private/v1/tenants/${athlete}/resources/${base.resourceId}/url-ingestions/%`],
          )
        ).rows[0]?.['count'],
      ),
    ).toBeGreaterThanOrEqual(8);
    expect(await repo.get(athlete, parseB.requestId)).toMatchObject({
      state: 'cancelled',
      failureCode: 'RESOURCE_DELETED',
    });
  });

  it('keeps cleanup manifests after account erasure and ignores caller wall clock', async () => {
    const athlete = randomUUID();
    const repo = createResourceUrlIngestionRepository(database);
    const pending = await repo.reserveCreate(athlete, input, randomUUID());
    const pendingLease = await worker.lease();
    if (!pendingLease || pendingLease.requestId !== pending.requestId)
      throw new Error('Expected account-erasure retry lease');
    await worker.fail(pendingLease, 'FETCH_TIMEOUT', {
      retryable: true,
      retryAfterSeconds: 60,
    });
    expect(await worker.reap(100)).toBe(0);
    await createOperationsRepository(database).eraseAccount(athlete);
    expect(
      await admin.query(
        `SELECT count(*)::integer AS count FROM resource_object_cleanup
         WHERE storage_ref LIKE $1 AND completed_at IS NULL`,
        [`private/v1/tenants/${athlete}/resources/${pending.resourceId}/url-ingestions/%`],
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
    expect(
      await admin.query(
        'SELECT count(*)::integer AS count FROM resource_url_ingestion WHERE athlete_id=$1',
        [athlete],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });

    const finalizedAthlete = randomUUID();
    const finalizedRepo = createResourceUrlIngestionRepository(database);
    const finalized = await finalizedRepo.reserveCreate(finalizedAthlete, input, randomUUID());
    await finishNext(finalized.resourceId);
    await createOperationsRepository(database).eraseAccount(finalizedAthlete);
    expect(
      await admin.query(
        `SELECT count(*)::integer AS count FROM resource_object_cleanup
         WHERE storage_ref LIKE $1 AND completed_at IS NULL`,
        [
          `private/v1/tenants/${finalizedAthlete}/resources/${finalized.resourceId}/url-ingestions/%`,
        ],
      ),
    ).toMatchObject({ rows: [{ count: 4 }] });
    expect(
      await admin.query(
        `SELECT
          (SELECT count(*)::integer FROM resource_url_ingestion WHERE athlete_id=$1) AS ingestions,
          (SELECT count(*)::integer FROM resource_url_artifact WHERE athlete_id=$1) AS artifacts,
          (SELECT count(*)::integer FROM resource_url_provenance WHERE athlete_id=$1) AS provenance`,
        [finalizedAthlete],
      ),
    ).toMatchObject({ rows: [{ ingestions: 0, artifacts: 0, provenance: 0 }] });
  });

  it('keeps legacy text and file version shapes fenced by their parent source kind', async () => {
    const insertInvalid = async (sourceKind: 'text' | 'file', contentStatus: string) => {
      const athlete = randomUUID();
      const resourceId = randomUUID();
      const versionId = randomUUID();
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO resource
           (athlete_id,id,source_kind,title,category,metadata,tags,favorite,include_for_coach,
            reviewed_state,access_revision,current_version,current_version_id,created_at,updated_at)
           VALUES($1,$2,$3,'Legacy shape','note','{}','[]',false,false,'unreviewed',1,1,$4,
            clock_timestamp(),clock_timestamp())`,
          [athlete, resourceId, sourceKind, versionId],
        );
        await expect(
          client.query(
            `INSERT INTO resource_version
             (athlete_id,resource_id,version_id,version,content,content_hash,paragraphs,
              content_status,index_status,created_at)
             VALUES($1,$2,$3,1,$4,repeat('a',64),$5::jsonb,$6,'not_indexed',clock_timestamp())`,
            [
              athlete,
              resourceId,
              versionId,
              sourceKind === 'file' ? 'parsed file mismatch' : null,
              sourceKind === 'file'
                ? JSON.stringify([
                    {
                      text: 'parsed file mismatch',
                      locator: {
                        kind: 'paragraph',
                        resourceVersionId: versionId,
                        index: 0,
                        startOffset: 0,
                        endOffset: 20,
                        offsetUnit: 'utf16_code_unit',
                      },
                    },
                  ])
                : '[]',
              contentStatus,
            ],
          ),
        ).rejects.toThrow(
          sourceKind === 'text' ? 'INVALID_TEXT_RESOURCE_VERSION' : 'INVALID_FILE_RESOURCE_VERSION',
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    await insertInvalid('text', 'bookmark_only');
    await insertInvalid('file', 'parsed');
  });

  it('counts projected URL artifacts against private resource quotas', async () => {
    const athlete = randomUUID();
    await expect(
      admin.query('SELECT public.assert_resource_url_quota($1,true,0,$2)', [
        athlete,
        100 * 1024 * 1024 + 1,
      ]),
    ).rejects.toThrow('RESOURCE_QUOTA_EXCEEDED');
  });
});
