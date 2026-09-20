import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import {
  grantOperations,
  grantResourceObjectCleanupWorker,
  grantResources,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createResourceFileUploadRepository } from '../src/resource-file-uploads.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantResources(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

const metadata = {
  sourceKind: 'file' as const,
  title: 'Private race document',
  category: 'race_material' as const,
  metadata: { author: 'Owner', year: 2026 },
  tags: ['private'],
  favorite: false,
};

function descriptor(
  overrides: Partial<{
    originalFileName: string;
    extension: 'pdf' | 'md' | 'markdown';
    mediaType: 'application/pdf' | 'text/markdown';
    byteSize: number;
    sha256: string;
  }> = {},
) {
  return {
    originalFileName: 'race.pdf',
    extension: 'pdf' as const,
    mediaType: 'application/pdf' as const,
    byteSize: 1024,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

function objectKey(
  athleteId: string,
  resourceId: string,
  uploadId: string,
  sha256: string,
  extension = 'pdf',
) {
  return `private/v1/tenants/${athleteId}/resources/${resourceId}/objects/uploads/${uploadId}/sha256/${sha256}.${extension}`;
}

async function prepareAndStage(
  uploads: ReturnType<typeof createResourceFileUploadRepository>,
  athleteId: string,
  reserved: { uploadId: string; resourceId: string },
  file = descriptor(),
) {
  const storageRef = objectKey(
    athleteId,
    reserved.resourceId,
    reserved.uploadId,
    file.sha256,
    file.mediaType === 'application/pdf' ? 'pdf' : 'md',
  );
  await uploads.prepareObject(athleteId, reserved.uploadId, { storageRef, file });
  await uploads.markStaged(athleteId, reserved.uploadId);
  return storageRef;
}

async function createFile(athleteId: string, file = descriptor(), key = randomUUID()) {
  const uploads = createResourceFileUploadRepository(database);
  const reserved = await uploads.reserveCreate(athleteId, metadata, key);
  const storageRef = objectKey(
    athleteId,
    reserved.resourceId,
    reserved.uploadId,
    file.sha256,
    file.mediaType === 'application/pdf' ? 'pdf' : 'md',
  );
  await uploads.prepareObject(athleteId, reserved.uploadId, { storageRef, file });
  await uploads.markStaged(athleteId, reserved.uploadId);
  return {
    uploads,
    reserved,
    storageRef,
    result: await uploads.finalize(athleteId, reserved.uploadId),
  };
}

describe('M2-04b private file resource persistence', () => {
  it('reserves idempotently, validates the object namespace and reads .markdown exactly', async () => {
    const athlete = randomUUID();
    const uploads = createResourceFileUploadRepository(database);
    const key = randomUUID();
    const reserved = await uploads.reserveCreate(athlete, metadata, key);
    expect(await uploads.reserveCreate(athlete, metadata, key)).toEqual(reserved);
    expect(await uploads.get(athlete, reserved.uploadId)).toEqual(reserved);
    await expect(
      uploads.reserveCreate(athlete, { ...metadata, title: 'Collision' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const file = descriptor({
      originalFileName: 'notes.markdown',
      extension: 'markdown',
      mediaType: 'text/markdown',
      sha256: 'b'.repeat(64),
      byteSize: 1024 * 1024,
    });
    const storageRef = objectKey(
      athlete,
      reserved.resourceId,
      reserved.uploadId,
      file.sha256,
      'md',
    );
    await expect(
      uploads.prepareObject(athlete, reserved.uploadId, {
        storageRef: objectKey(
          randomUUID(),
          reserved.resourceId,
          reserved.uploadId,
          file.sha256,
          'md',
        ),
        file,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await uploads.prepareObject(athlete, reserved.uploadId, { storageRef, file });
    await uploads.markStaged(athlete, reserved.uploadId);
    const result = await uploads.finalize(athlete, reserved.uploadId);
    expect(result).toMatchObject({
      status: 'available',
      resource: { sourceKind: 'file', lifecycle: { contentStatus: 'raw_stored' } },
      version: { source: { kind: 'file', file: { extension: 'markdown' } } },
      reader: { sourceKind: 'file', file: { originalFileName: 'notes.markdown' } },
    });
    expect(await uploads.reserveCreate(athlete, metadata, key)).toMatchObject({
      uploadId: reserved.uploadId,
      state: 'finalized',
    });
    expect(await uploads.resolveObject(athlete, reserved.resourceId)).toEqual({ storageRef, file });
    expect(await uploads.resolveObject(randomUUID(), reserved.resourceId)).toBeNull();
    await expect(
      createPrivateTextResourceRepository(database).appendVersion(athlete, reserved.resourceId, {
        expectedCurrentVersionId: reserved.versionId,
        text: 'Must not cross source kinds.',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeTruthy();

    const exported = await createOperationsRepository(database).exportAccount(athlete);
    expect(exported.schemaVersion).toBe(14);
    const serialized = JSON.stringify(exported);
    expect(serialized).toContain('notes.markdown');
    expect(serialized).not.toContain(storageRef);
  });

  it('accepts the 10 MiB PDF boundary and rejects larger descriptors', async () => {
    const athlete = randomUUID();
    const uploads = createResourceFileUploadRepository(database);
    const reserved = await uploads.reserveCreate(athlete, metadata, randomUUID());
    const boundary = descriptor({ byteSize: 10 * 1024 * 1024, sha256: 'c'.repeat(64) });
    await uploads.prepareObject(athlete, reserved.uploadId, {
      storageRef: objectKey(athlete, reserved.resourceId, reserved.uploadId, boundary.sha256),
      file: boundary,
    });
    await uploads.markStaged(athlete, reserved.uploadId);
    expect(() =>
      uploads.prepareObject(athlete, reserved.uploadId, {
        storageRef: objectKey(athlete, reserved.resourceId, reserved.uploadId, 'd'.repeat(64)),
        file: descriptor({ byteSize: 10 * 1024 * 1024 + 1, sha256: 'd'.repeat(64) }),
      }),
    ).toThrow();
    expect((await uploads.finalize(athlete, reserved.uploadId)).status).toBe('available');
  });

  it('serializes append CAS with per-upload keys and leaves failed finalize staged', async () => {
    const athlete = randomUUID();
    const first = await createFile(athlete);
    if (first.result.status !== 'available') throw new Error('Expected available file');
    const uploads = first.uploads;
    const appendA = await uploads.reserveAppend(
      athlete,
      first.reserved.resourceId,
      { expectedCurrentVersionId: first.result.version.id },
      randomUUID(),
    );
    const appendB = await uploads.reserveAppend(
      athlete,
      first.reserved.resourceId,
      { expectedCurrentVersionId: first.result.version.id },
      randomUUID(),
    );
    await prepareAndStage(uploads, athlete, appendA, descriptor());
    await prepareAndStage(uploads, athlete, appendB, descriptor({ sha256: 'e'.repeat(64) }));
    const second = await uploads.finalize(athlete, appendA.uploadId);
    expect(second.status).toBe('available');
    await expect(uploads.finalize(athlete, appendB.uploadId)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(
      await database.tenant(athlete, (tx) =>
        tx.query('SELECT count(*)::integer AS count FROM resource_object'),
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
    if (second.status !== 'available') throw new Error('Expected appended file');
    const competing = await Promise.all(
      ['1', '2'].map(async (marker) => {
        const reserved = await uploads.reserveAppend(
          athlete,
          first.reserved.resourceId,
          { expectedCurrentVersionId: second.version.id },
          randomUUID(),
        );
        const file = descriptor({ sha256: marker.repeat(64) });
        await prepareAndStage(uploads, athlete, reserved, file);
        return reserved;
      }),
    );
    const concurrent = await Promise.allSettled(
      competing.map((reserved) => uploads.finalize(athlete, reserved.uploadId)),
    );
    expect(concurrent.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((item) => item.status === 'rejected')).toHaveLength(1);

    const failureAthlete = randomUUID();
    const staged = await uploads.reserveCreate(failureAthlete, metadata, randomUUID());
    const file = descriptor({ sha256: 'f'.repeat(64) });
    const failedStorageRef = await prepareAndStage(uploads, failureAthlete, staged, file);
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, values) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('injected finalize failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await expect(
      createResourceFileUploadRepository(broken).finalize(failureAthlete, staged.uploadId),
    ).rejects.toThrow('injected finalize failure');
    expect(await uploads.get(failureAthlete, staged.uploadId)).toMatchObject({ state: 'staged' });
    expect(await uploads.resolveObject(failureAthlete, staged.resourceId)).toBeNull();
    await uploads.fail(failureAthlete, staged.uploadId, 'FINALIZE_ABORTED');
    expect(await uploads.get(failureAthlete, staged.uploadId)).toMatchObject({ state: 'failed' });
    expect(
      await admin.query('SELECT reason FROM resource_object_cleanup WHERE storage_ref=$1', [
        failedStorageRef,
      ]),
    ).toMatchObject({ rows: [{ reason: 'upload_abandoned' }] });
  });

  it('rolls back the version that would exceed the tenant file quota', async () => {
    const athlete = randomUUID();
    const uploads = createResourceFileUploadRepository(database);
    const makeFile = (version: number) =>
      descriptor({
        byteSize: 10 * 1024 * 1024,
        sha256: version.toString(16).padStart(64, '0'),
      });
    const first = await createFile(athlete, makeFile(1));
    if (first.result.status !== 'available') throw new Error('Expected available file');
    let head = first.result.version.id;
    for (let version = 2; version <= 10; version += 1) {
      const reserved = await uploads.reserveAppend(
        athlete,
        first.reserved.resourceId,
        { expectedCurrentVersionId: head },
        randomUUID(),
      );
      const file = makeFile(version);
      await prepareAndStage(uploads, athlete, reserved, file);
      const appended = await uploads.finalize(athlete, reserved.uploadId);
      if (appended.status !== 'available') throw new Error('Expected appended file');
      head = appended.version.id;
    }
    const overflow = await uploads.reserveAppend(
      athlete,
      first.reserved.resourceId,
      { expectedCurrentVersionId: head },
      randomUUID(),
    );
    const overflowFile = makeFile(11);
    await prepareAndStage(uploads, athlete, overflow, overflowFile);
    await expect(uploads.finalize(athlete, overflow.uploadId)).rejects.toMatchObject({
      code: 'RESOURCE_QUOTA_EXCEEDED',
    });
    expect(await uploads.get(athlete, overflow.uploadId)).toMatchObject({ state: 'staged' });
  });

  it('bounds pending intents and bytes, preserves replay, and durably reaps expiry refs', async () => {
    const athlete = randomUUID();
    const uploads = createResourceFileUploadRepository(database);
    const reservations = [];
    for (let index = 0; index < 20; index += 1) {
      reservations.push(
        await uploads.reserveCreate(
          athlete,
          metadata,
          `pending-${index.toString().padStart(2, '0')}`,
        ),
      );
    }
    expect(await uploads.reserveCreate(athlete, metadata, 'pending-00')).toEqual(reservations[0]);
    await expect(
      uploads.reserveCreate(athlete, metadata, 'pending-overflow'),
    ).rejects.toMatchObject({ code: 'UPLOAD_QUOTA_EXCEEDED' });

    const byteAthlete = randomUUID();
    const byteUploads = createResourceFileUploadRepository(database);
    for (let index = 0; index < 5; index += 1) {
      const reserved = await byteUploads.reserveCreate(
        byteAthlete,
        metadata,
        `bytes-${index.toString().padStart(2, '0')}`,
      );
      const file = descriptor({
        byteSize: 10 * 1024 * 1024,
        sha256: (index + 10).toString(16).padStart(64, '0'),
      });
      await byteUploads.prepareObject(byteAthlete, reserved.uploadId, {
        storageRef: objectKey(byteAthlete, reserved.resourceId, reserved.uploadId, file.sha256),
        file,
      });
    }
    const overflow = await byteUploads.reserveCreate(byteAthlete, metadata, 'bytes-overflow');
    const overflowFile = descriptor({ sha256: '7'.repeat(64) });
    await expect(
      byteUploads.prepareObject(byteAthlete, overflow.uploadId, {
        storageRef: objectKey(
          byteAthlete,
          overflow.resourceId,
          overflow.uploadId,
          overflowFile.sha256,
        ),
        file: overflowFile,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_QUOTA_EXCEEDED' });

    const expiredAthlete = randomUUID();
    const expiredUpload = randomUUID();
    const expiredResource = randomUUID();
    const expiredVersion = randomUUID();
    const expiredTemp = `private/v1/tenants/${expiredAthlete}/resources/${expiredResource}/temporary/${expiredUpload}`;
    await admin.query(
      `INSERT INTO resource_upload_intent
       (athlete_id,upload_id,idempotency_key,request_digest,operation,resource_id,version_id,
        expected_current_version_id,temporary_ref,source_kind,title,category,metadata,tags,favorite,
        state,failure_code,created_at,updated_at,expires_at)
       VALUES($1,$2,'expired-upload',repeat('a',64),'create',$3,$4,NULL,$5,'file','Expired',
        'note','{}','[]',false,'reserved',NULL,clock_timestamp()-interval '2 hours',
        clock_timestamp()-interval '2 hours',clock_timestamp()-interval '90 minutes')`,
      [expiredAthlete, expiredUpload, expiredResource, expiredVersion, expiredTemp],
    );
    const reaped = await admin.query(
      'SELECT public.reap_expired_resource_uploads($1,100) AS affected',
      [new Date(0).toISOString()],
    );
    expect(Number(reaped.rows[0]?.['affected'])).toBe(1);
    expect(
      await admin.query(
        `SELECT reason FROM resource_object_cleanup WHERE storage_ref=$1 AND completed_at IS NULL`,
        [expiredTemp],
      ),
    ).toMatchObject({ rows: [{ reason: 'upload_abandoned' }] });
  });

  it('uses database time for limited cleanup workers and fences active uploads', async () => {
    await admin.query(
      `UPDATE resource_object_cleanup SET completed_at=clock_timestamp(),lease_owner=NULL,
       lease_until=NULL,delete_authorized_at=NULL WHERE completed_at IS NULL`,
    );
    const athlete = randomUUID();
    const uploads = createResourceFileUploadRepository(database);
    const active = await uploads.reserveCreate(athlete, metadata, randomUUID());
    const activeFile = descriptor({ sha256: '0'.repeat(64) });
    const activeRef = await prepareAndStage(uploads, athlete, active, activeFile);
    const cleanupId = randomUUID();
    const finishId = randomUUID();
    const exhaustingId = randomUUID();
    const followingId = randomUUID();
    const delayedId = randomUUID();
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,attempts,available_at,created_at)
       VALUES($1,$2,'upload_abandoned',0,$3,$3),
       ($4,'test/database-time/finish','upload_abandoned',0,$5,$5),
       ($6,'test/dead-letter/exhausting','upload_abandoned',99,$7,$7),
       ($8,'test/dead-letter/following','upload_abandoned',0,$9,$9),
       ($10,'test/database-time/delayed','upload_abandoned',0,clock_timestamp()+interval '1 hour',clock_timestamp())`,
      [
        cleanupId,
        activeRef,
        new Date(0),
        finishId,
        new Date(1000),
        exhaustingId,
        new Date(2000),
        followingId,
        new Date(3000),
        delayedId,
      ],
    );

    const workerRole = `resource_cleanup_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const workerId = randomUUID();
    await admin.query(`CREATE ROLE "${workerRole}" NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
    await grantResourceObjectCleanupWorker(adminUrl, workerRole);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE "${workerRole}"`);
      expect(
        Number(
          (
            await client.query('SELECT public.reap_expired_resource_uploads($1,100) AS affected', [
              '2999-01-01T00:00:00.000Z',
            ])
          ).rows[0]?.['affected'],
        ),
      ).toBe(0);
      const leased = await client.query(
        'SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)',
        [workerId, '2999-01-01T00:00:00.000Z', '2999-01-01T00:01:00.000Z'],
      );
      expect(leased.rows).toMatchObject([{ id: cleanupId, storage_ref: activeRef }]);
      expect(
        (
          await client.query('SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)', [
            cleanupId,
            workerId,
            '2999-01-01T00:00:59.000Z',
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await client.query(
            'SELECT public.finish_resource_object_cleanup($1,$2,true,NULL,$3) AS finished',
            [cleanupId, workerId, '2999-01-01T00:00:59.000Z'],
          )
        ).rows[0]?.['finished'],
      ).toBe(false);
      const finishLease = await client.query(
        'SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)',
        [workerId, '2999-01-01T00:00:00.000Z', '2999-01-01T00:01:00.000Z'],
      );
      expect(finishLease.rows).toMatchObject([
        { id: finishId, storage_ref: 'test/database-time/finish' },
      ]);
      expect(
        (
          await client.query('SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)', [
            finishId,
            workerId,
            '2999-01-01T00:00:59.000Z',
          ])
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await client.query(
            'SELECT public.finish_resource_object_cleanup($1,$2,true,NULL,$3) AS finished',
            [finishId, workerId, '2999-01-01T00:00:59.000Z'],
          )
        ).rows[0]?.['finished'],
      ).toBe(true);
      const exhaustingLease = await client.query(
        'SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)',
        [workerId, '2999-01-01T00:00:00.000Z', '2999-01-01T00:01:00.000Z'],
      );
      expect(exhaustingLease.rows).toMatchObject([
        { id: exhaustingId, storage_ref: 'test/dead-letter/exhausting', attempts: 100 },
      ]);
      expect(
        (
          await client.query('SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)', [
            exhaustingId,
            workerId,
            '2999-01-01T00:00:59.000Z',
          ])
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await client.query(
            `SELECT public.finish_resource_object_cleanup(
              $1,$2,false,'OBJECT_DELETE_FAILED',$3
            ) AS finished`,
            [exhaustingId, workerId, '2999-01-01T00:00:59.000Z'],
          )
        ).rows[0]?.['finished'],
      ).toBe(true);
      const followingLease = await client.query(
        'SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)',
        [workerId, '2999-01-01T00:00:00.000Z', '2999-01-01T00:01:00.000Z'],
      );
      expect(followingLease.rows).toMatchObject([
        { id: followingId, storage_ref: 'test/dead-letter/following', attempts: 1 },
      ]);
      expect(
        (
          await client.query('SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)', [
            followingId,
            workerId,
            '2999-01-01T00:00:59.000Z',
          ])
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await client.query(
            'SELECT public.finish_resource_object_cleanup($1,$2,true,NULL,$3) AS finished',
            [followingId, workerId, '2999-01-01T00:00:59.000Z'],
          )
        ).rows[0]?.['finished'],
      ).toBe(true);
      expect(
        (
          await client.query('SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)', [
            workerId,
            '2999-01-01T00:00:00.000Z',
            '2999-01-01T00:01:00.000Z',
          ])
        ).rows,
      ).toEqual([]);
      await client.query('COMMIT');
    } finally {
      client.release();
      expect(await uploads.get(athlete, active.uploadId)).toMatchObject({ state: 'staged' });
      expect(
        await admin.query(
          'SELECT completed_at,last_error_code FROM resource_object_cleanup WHERE id=$1',
          [cleanupId],
        ),
      ).toMatchObject({
        rows: [{ completed_at: expect.any(Date), last_error_code: 'REFERENCE_PRESENT' }],
      });
      const finishedCleanup = await admin.query(
        'SELECT completed_at FROM resource_object_cleanup WHERE id=$1',
        [finishId],
      );
      expect(finishedCleanup.rows[0]?.['completed_at']).toBeInstanceOf(Date);
      expect((finishedCleanup.rows[0]?.['completed_at'] as Date).getUTCFullYear()).toBeLessThan(
        2999,
      );
      expect(
        await admin.query(
          `SELECT attempts,completed_at,lease_owner,lease_until,delete_authorized_at,last_error_code
           FROM resource_object_cleanup WHERE id=$1`,
          [exhaustingId],
        ),
      ).toMatchObject({
        rows: [
          {
            attempts: 100,
            completed_at: null,
            lease_owner: null,
            lease_until: null,
            delete_authorized_at: null,
            last_error_code: 'DEAD_LETTER:OBJECT_DELETE_FAILED',
          },
        ],
      });
      await admin.query(`DROP OWNED BY "${workerRole}"`);
      await admin.query(`DROP ROLE "${workerRole}"`);
    }
  });

  it('caps failed intent history immediately and preserves idempotent failed replay', async () => {
    const athlete = randomUUID();
    const uploads = createResourceFileUploadRepository(database);
    let first: Awaited<ReturnType<typeof uploads.reserveCreate>> | undefined;
    for (let index = 0; index < 100; index += 1) {
      const key = `failure-${index.toString().padStart(3, '0')}`;
      const reserved = await uploads.reserveCreate(athlete, metadata, key);
      if (index === 0) first = reserved;
      await uploads.fail(athlete, reserved.uploadId, 'UPLOAD_REJECTED');
    }
    if (!first) throw new Error('Expected failed reservation');
    expect(await uploads.reserveCreate(athlete, metadata, 'failure-000')).toMatchObject({
      uploadId: first.uploadId,
      state: 'failed',
    });
    await expect(
      uploads.reserveCreate(athlete, metadata, 'failure-overflow'),
    ).rejects.toMatchObject({ code: 'UPLOAD_HISTORY_QUOTA_EXCEEDED' });
  });

  it('prunes only cleanup-safe failed history and bounds completed cleanup pruning', async () => {
    const safeAthlete = randomUUID();
    const blockedAthlete = randomUUID();
    const safeUpload = randomUUID();
    const blockedUpload = randomUUID();
    const safeTemp = `test/prune/safe/${safeUpload}`;
    const blockedTemp = `test/prune/blocked/${blockedUpload}`;
    const insertFailed = async (athleteId: string, uploadId: string, temporaryRef: string) => {
      await admin.query(
        `INSERT INTO resource_upload_intent
         (athlete_id,upload_id,idempotency_key,request_digest,operation,resource_id,version_id,
          expected_current_version_id,temporary_ref,source_kind,title,category,metadata,tags,favorite,
          state,failure_code,created_at,updated_at,expires_at)
         VALUES($1,$2,$3,repeat('b',64),'create',$4,$5,NULL,$6,'file','Old failed','note',
          '{}','[]',false,'failed','UPLOAD_REJECTED',clock_timestamp()-interval '9 days',
          clock_timestamp()-interval '8 days',clock_timestamp()-interval '8 days 23 hours')`,
        [athleteId, uploadId, `old-${uploadId}`, randomUUID(), randomUUID(), temporaryRef],
      );
    };
    await insertFailed(safeAthlete, safeUpload, safeTemp);
    await insertFailed(blockedAthlete, blockedUpload, blockedTemp);
    await admin.query(
      `INSERT INTO resource_object_cleanup
       (id,storage_ref,reason,available_at,created_at,completed_at)
       VALUES($1,$2,'upload_abandoned',clock_timestamp()-interval '29 days',
        clock_timestamp()-interval '29 days',clock_timestamp()-interval '29 days'),
       ($3,$4,'upload_abandoned',clock_timestamp(),clock_timestamp(),NULL)`,
      [randomUUID(), safeTemp, randomUUID(), blockedTemp],
    );
    const prunedUploads = await admin.query(
      'SELECT public.prune_resource_upload_history(100) AS affected',
    );
    expect(Number(prunedUploads.rows[0]?.['affected'])).toBe(1);
    expect(
      await admin.query(
        `SELECT athlete_id FROM resource_upload_intent
         WHERE upload_id=ANY($1::uuid[]) ORDER BY athlete_id`,
        [[safeUpload, blockedUpload]],
      ),
    ).toMatchObject({ rows: [{ athlete_id: blockedAthlete }] });

    await admin.query(
      `INSERT INTO resource_object_cleanup
       (id,storage_ref,reason,available_at,created_at,completed_at)
       SELECT gen_random_uuid(),'test/prune/completed/'||value,'upload_abandoned',
        clock_timestamp()-interval '31 days',clock_timestamp()-interval '31 days',
        clock_timestamp()-interval '31 days' FROM generate_series(1,101) value`,
    );
    const prunedCleanup = await admin.query(
      'SELECT public.prune_resource_cleanup_history(100) AS affected',
    );
    expect(Number(prunedCleanup.rows[0]?.['affected'])).toBe(100);
    expect(
      await admin.query(
        `SELECT count(*)::integer AS count FROM resource_object_cleanup
         WHERE storage_ref LIKE 'test/prune/completed/%'`,
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
    expect(
      await admin.query('SELECT completed_at FROM resource_object_cleanup WHERE storage_ref=$1', [
        blockedTemp,
      ]),
    ).toMatchObject({ rows: [{ completed_at: null }] });
  });

  it('fences cleanup against active staged refs and rejects prepare after delete authorization', async () => {
    await admin.query(
      `UPDATE resource_object_cleanup SET completed_at=clock_timestamp(),lease_owner=NULL,
       lease_until=NULL,delete_authorized_at=NULL WHERE completed_at IS NULL`,
    );
    const athlete = randomUUID();
    const uploads = createResourceFileUploadRepository(database);
    const active = await uploads.reserveCreate(athlete, metadata, randomUUID());
    const activeFile = descriptor({ sha256: '6'.repeat(64) });
    const activeRef = await prepareAndStage(uploads, athlete, active, activeFile);
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
       VALUES($1,$2,'upload_abandoned',$3,$3)`,
      [randomUUID(), activeRef, new Date(0).toISOString()],
    );
    const worker = randomUUID();
    const now = new Date();
    const until = new Date(now.getTime() + 60_000);
    const leased = await admin.query(
      'SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)',
      [worker, now.toISOString(), until.toISOString()],
    );
    const activeCleanupId = String(leased.rows[0]?.['id']);
    const skipped = await admin.query(
      'SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)',
      [activeCleanupId, worker, now.toISOString()],
    );
    expect(skipped.rows).toEqual([]);
    expect(
      await admin.query(
        'SELECT completed_at,last_error_code FROM resource_object_cleanup WHERE id=$1',
        [activeCleanupId],
      ),
    ).toMatchObject({
      rows: [{ completed_at: expect.any(Date), last_error_code: 'REFERENCE_PRESENT' }],
    });

    const losing = await uploads.reserveCreate(athlete, metadata, randomUUID());
    const losingFile = descriptor({ sha256: '5'.repeat(64) });
    const losingRef = objectKey(athlete, losing.resourceId, losing.uploadId, losingFile.sha256);
    const cleanupId = randomUUID();
    await admin.query(
      `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
       VALUES($1,$2,'upload_abandoned',$3,$3)`,
      [cleanupId, losingRef, new Date(0).toISOString()],
    );
    await admin.query('SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)', [
      worker,
      now.toISOString(),
      until.toISOString(),
    ]);
    expect(
      (
        await admin.query('SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)', [
          cleanupId,
          worker,
          now.toISOString(),
        ])
      ).rows,
    ).toHaveLength(1);
    await expect(
      uploads.prepareObject(athlete, losing.uploadId, {
        storageRef: losingRef,
        file: losingFile,
      }),
    ).rejects.toThrow('OBJECT_DELETE_IN_PROGRESS');
    expect(await uploads.get(athlete, losing.uploadId)).toMatchObject({ state: 'reserved' });
  });

  it('blocks deleted access and retains opaque cleanup work through account erasure', async () => {
    const athlete = randomUUID();
    const created = await createFile(athlete);
    if (created.result.status !== 'available') throw new Error('Expected available file');
    const appendedReservation = await created.uploads.reserveAppend(
      athlete,
      created.reserved.resourceId,
      { expectedCurrentVersionId: created.result.version.id },
      randomUUID(),
    );
    const appendedFile = descriptor({ sha256: '8'.repeat(64) });
    const appendedStorageRef = await prepareAndStage(
      created.uploads,
      athlete,
      appendedReservation,
      appendedFile,
    );
    const appended = await created.uploads.finalize(athlete, appendedReservation.uploadId);
    if (appended.status !== 'available') throw new Error('Expected appended file');
    const stagedAppend = await created.uploads.reserveAppend(
      athlete,
      created.reserved.resourceId,
      { expectedCurrentVersionId: appended.version.id },
      randomUUID(),
    );
    const stagedAppendFile = descriptor({ sha256: '4'.repeat(64) });
    const stagedAppendRef = await prepareAndStage(
      created.uploads,
      athlete,
      stagedAppend,
      stagedAppendFile,
    );
    const stagedAppendTemp = String(
      (
        await admin.query(
          'SELECT temporary_ref FROM resource_upload_intent WHERE athlete_id=$1 AND upload_id=$2',
          [athlete, stagedAppend.uploadId],
        )
      ).rows[0]?.['temporary_ref'],
    );
    await createPrivateTextResourceRepository(database).softDelete(
      athlete,
      created.reserved.resourceId,
      {
        expectedAccessRevision: appended.resource.accessRevision,
        expectedCurrentVersionId: appended.version.id,
        idempotencyKey: randomUUID(),
      },
    );
    expect(await created.uploads.resolveObject(athlete, created.reserved.resourceId)).toBeNull();
    expect(await created.uploads.get(athlete, stagedAppend.uploadId)).toMatchObject({
      state: 'failed',
    });
    expect(
      await admin.query(
        `SELECT storage_ref,reason FROM resource_object_cleanup
         WHERE storage_ref=ANY($1::text[]) ORDER BY array_position($1::text[],storage_ref)`,
        [[stagedAppendRef, stagedAppendTemp]],
      ),
    ).toMatchObject({
      rows: [
        { storage_ref: stagedAppendRef, reason: 'resource_deleted' },
        { storage_ref: stagedAppendTemp, reason: 'resource_deleted' },
      ],
    });
    expect(
      await admin.query(
        `SELECT storage_ref,reason FROM resource_object_cleanup
         WHERE storage_ref=ANY($1::text[]) ORDER BY array_position($1::text[],storage_ref)`,
        [[appendedStorageRef, created.storageRef]],
      ),
    ).toMatchObject({
      rows: [
        { storage_ref: appendedStorageRef, reason: 'resource_deleted' },
        { storage_ref: created.storageRef, reason: 'resource_deleted' },
      ],
    });

    const firstCycle = await admin.query(
      `SELECT id,storage_ref FROM resource_object_cleanup
       WHERE storage_ref=ANY($1::text[]) ORDER BY array_position($1::text[],storage_ref)`,
      [[appendedStorageRef, created.storageRef]],
    );
    await admin.query(
      `UPDATE resource_object_cleanup SET completed_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,
       delete_authorized_at=NULL
       WHERE completed_at IS NULL`,
    );
    const erasureRefs = (
      await admin.query(
        `SELECT temporary_ref,storage_ref FROM resource_upload_intent
         WHERE athlete_id=$1 ORDER BY upload_id`,
        [athlete],
      )
    ).rows.flatMap((row) => [String(row['temporary_ref']), String(row['storage_ref'])]);
    // A later deletion event must open a fresh cleanup cycle for these refs.
    await createOperationsRepository(database).eraseAccount(athlete);
    const secondCycle = await admin.query(
      `SELECT id,storage_ref,reason,attempts,lease_owner,lease_until,completed_at,last_error_code
       FROM resource_object_cleanup WHERE storage_ref=ANY($1::text[])
       ORDER BY array_position($1::text[],storage_ref)`,
      [[appendedStorageRef, created.storageRef]],
    );
    expect(secondCycle.rows).toMatchObject([
      {
        storage_ref: appendedStorageRef,
        reason: 'account_erased',
        attempts: 0,
        lease_owner: null,
        lease_until: null,
        completed_at: null,
        last_error_code: null,
      },
      {
        storage_ref: created.storageRef,
        reason: 'account_erased',
        attempts: 0,
        lease_owner: null,
        lease_until: null,
        completed_at: null,
        last_error_code: null,
      },
    ]);
    expect(secondCycle.rows.map((row) => row['id'])).not.toEqual(
      firstCycle.rows.map((row) => row['id']),
    );
    const cleanupWorker = randomUUID();
    const leaseNow = new Date();
    const leaseUntil = new Date(leaseNow.getTime() + 60_000);
    const leasedRefs = [] as string[];
    for (let index = 0; index < erasureRefs.length; index += 1) {
      const leased = await admin.query(
        'SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)',
        [cleanupWorker, leaseNow.toISOString(), leaseUntil.toISOString()],
      );
      leasedRefs.push(String(leased.rows[0]?.['storage_ref']));
    }
    expect(new Set(leasedRefs)).toEqual(new Set(erasureRefs));

    const erasedAthlete = randomUUID();
    const erased = await createFile(erasedAthlete, descriptor({ sha256: '9'.repeat(64) }));
    if (erased.result.status !== 'available') throw new Error('Expected erased file');
    const erasedAppend = await erased.uploads.reserveAppend(
      erasedAthlete,
      erased.reserved.resourceId,
      { expectedCurrentVersionId: erased.result.version.id },
      randomUUID(),
    );
    const erasedAppendRef = await prepareAndStage(
      erased.uploads,
      erasedAthlete,
      erasedAppend,
      descriptor({ sha256: '3'.repeat(64) }),
    );
    await createOperationsRepository(database).eraseAccount(erasedAthlete);
    expect(
      await admin.query('SELECT reason FROM resource_object_cleanup WHERE storage_ref=$1', [
        erased.storageRef,
      ]),
    ).toMatchObject({ rows: [{ reason: 'account_erased' }] });
    expect(
      await admin.query('SELECT reason FROM resource_object_cleanup WHERE storage_ref=$1', [
        erasedAppendRef,
      ]),
    ).toMatchObject({ rows: [{ reason: 'account_erased' }] });
    const remaining = await admin.query(
      `SELECT
        (SELECT count(*)::integer FROM resource_object WHERE athlete_id=$1) AS objects,
        (SELECT count(*)::integer FROM resource_upload_intent WHERE athlete_id=$1) AS intents`,
      [erasedAthlete],
    );
    expect(remaining.rows[0]).toEqual({ objects: 0, intents: 0 });

    const workerRole = `resource_cleanup_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
    await grantResourceObjectCleanupWorker(adminUrl, workerRole);
    const privileges = await admin.query(
      `SELECT has_table_privilege($1,'resource_object_cleanup','SELECT') AS can_select,
       has_function_privilege($1,'public.lease_resource_object_cleanup(uuid,timestamptz,timestamptz)','EXECUTE') AS can_lease`,
      [workerRole],
    );
    expect(privileges.rows[0]).toEqual({ can_select: false, can_lease: true });
    const runtimePrivileges = await admin.query(
      `SELECT has_table_privilege('workout_runtime','resource_object','UPDATE') AS object_update,
       has_table_privilege('workout_runtime','resource_object','DELETE') AS object_delete,
       has_table_privilege('workout_runtime','resource_object_cleanup','SELECT') AS cleanup_select`,
    );
    expect(runtimePrivileges.rows[0]).toEqual({
      object_update: false,
      object_delete: false,
      cleanup_select: false,
    });
    await admin.query(`DROP OWNED BY "${workerRole}"`);
    await admin.query(`DROP ROLE "${workerRole}"`);
  });
});
