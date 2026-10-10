import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  raceResultV2Schema,
  raceResultStorageLifecycleV2Schema,
  type RaceResultAttachmentStored,
} from '@workout/contracts/race-result-v2';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository } from '../src/races.js';
import { createActivityRepository } from '../src/activities.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createResourceFileUploadRepository } from '../src/resource-file-uploads.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import {
  migrate,
  grantRaces,
  grantResources,
  grantGalleryMedia,
  grantOperations,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import { prepareRaceResultProofs, projectRaceResultProofsIn } from '../src/race-result-proofs.js';

// Root executes this prepared file. Public media repository finalization is real
// SQL behavior; staged descriptor fixtures are not external object-byte or authenticity evidence.
// Race V2 storage writes below exercise guards directly, not a public V2 API/approval.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `race_proof_${suffix}`;
const ownerRole = `race_proof_owner_${suffix}`;
const runtimeRole = `race_proof_app_${suffix}`;
const transferredRole = `race_proof_next_${suffix}`;
let owner: Pool, database: Database;
function urlFor(role: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
function logSqlDiagnostic(label: string, error: unknown) {
  const field = z
    .string()
    .transform((value) => value.slice(0, 32768))
    .optional();
  const diagnostic = z
    .object({
      position: field,
      internalPosition: field,
      internalQuery: field,
      where: field,
      code: field,
      // A PostgreSQL constraint detail may include an entire health row. Retain
      // presence, never that row, even for these synthetic local fixtures.
      detail: z
        .string()
        .transform(() => '[detail omitted]')
        .optional(),
    })
    .safeParse(error);
  if (diagnostic.success) console.error(label, diagnostic.data);
}
async function owned<T>(athlete: string, fn: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77206))', [athlete]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    const value = await fn(client);
    const result = await client.query('COMMIT');
    if (result.command !== 'COMMIT') throw new Error('TRANSACTION_NOT_COMMITTED');
    return value;
  } catch (error: unknown) {
    logSqlDiagnostic('RACE_PROOF_OWNED_SQL_DIAGNOSTIC', error);
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function account() {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  await owned(athlete, (client) =>
    client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  return athlete;
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, transferredRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`GRANT "${transferredRole}" TO "${ownerRole}"`);
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  await migrate(urlFor(ownerRole), 107);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  for (const file of [
    '108_nutrition_race_disconnection.sql',
    '109_race_result_proof_lifecycle.sql',
  ]) {
    try {
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    } catch (error: unknown) {
      logSqlDiagnostic(`RACE_PROOF_MIGRATION_DIAGNOSTIC:${file}`, error);
      throw error;
    }
  }
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  for (const grant of [grantRaces, grantResources, grantGalleryMedia, grantOperations])
    await grant(urlFor(ownerRole), runtimeRole);
  // Existing manual Activity service DML only, for the cross-domain public deletion
  // fixture. No event-ledger DML, owner role, definer bypass or proof authority grant.
  await owner.query(`GRANT SELECT,INSERT ON activity_source_head,activity_source_revision,
    activity_overlay,activity_overlay_revision,activity_suppression,command_receipt TO "${runtimeRole}"`);
  await owner.query(`GRANT INSERT,UPDATE ON activity_canonical TO "${runtimeRole}"`);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 4 });
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole, transferredRole])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
async function sources(athlete: string) {
  const gallery = createGalleryMediaRepository(database);
  const reservation = await gallery.reserveCreate(
    athlete,
    {
      mediaKind: 'image',
      album: null,
      caption: null,
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    `gallery-${randomUUID()}`,
  );
  const sha256 = 'a'.repeat(64);
  await gallery.prepareObject(athlete, reservation.uploadId, {
    storageRef: `private/v1/tenants/${athlete}/gallery/${reservation.mediaItemId}/objects/uploads/${reservation.uploadId}/sha256/${sha256}.png`,
    file: { originalFileName: 'proof.png', mediaType: 'image/png', byteSize: 2048, sha256 },
  });
  await gallery.markStaged(athlete, reservation.uploadId);
  const image = await gallery.finalize(athlete, reservation.uploadId);
  if (image.status !== 'available') throw new Error('MISSING_IMAGE');
  const uploads = createResourceFileUploadRepository(database);
  const pdf = await uploads.reserveCreate(
    athlete,
    {
      sourceKind: 'file',
      title: 'Private race document',
      category: 'race_material',
      metadata: {},
      tags: [],
      favorite: false,
    },
    randomUUID(),
  );
  const contentHash = 'b'.repeat(64);
  await uploads.prepareObject(athlete, pdf.uploadId, {
    storageRef: `private/v1/tenants/${athlete}/resources/${pdf.resourceId}/objects/uploads/${pdf.uploadId}/sha256/${contentHash}.pdf`,
    file: {
      originalFileName: 'proof.pdf',
      extension: 'pdf',
      mediaType: 'application/pdf',
      byteSize: 1024,
      sha256: contentHash,
    },
  });
  await uploads.markStaged(athlete, pdf.uploadId);
  await uploads.finalize(athlete, pdf.uploadId);
  const attachments: RaceResultAttachmentStored[] = [
    {
      kind: 'gallery-image',
      mediaItemId: image.item.id,
      accessRevision: image.item.accessRevision,
      mediaType: 'image/png',
      byteSize: 2048,
      sha256,
    },
    {
      kind: 'resource-pdf',
      resourceId: pdf.resourceId,
      versionId: pdf.versionId,
      accessRevision: 1,
      mediaType: 'application/pdf',
      byteSize: 1024,
      contentHash,
    },
  ];
  return { gallery, image, pdf, attachments };
}
function body(attachments: readonly RaceResultAttachmentStored[]) {
  const full = raceResultV2Schema.parse({
    schemaVersion: 2,
    kind: 'race-result',
    id: randomUUID(),
    revision: 1,
    raceEventId: null,
    localDate: '2026-10-07',
    timezone: 'Asia/Seoul',
    source: { kind: 'manual' },
    chipSeconds: 0,
    gunSeconds: null,
    officialDistanceMeters: 10000,
    deviceDistanceMeters: null,
    linkedActivityId: null,
    weatherNote: null,
    proofs: { link: 'https://example.test/result', attachments },
  });
  const { id, revision, ...values } = full;
  return { id, revision, values };
}
async function write(athlete: string, input: ReturnType<typeof body>) {
  try {
    await database.tenant(athlete, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
      await tx.query(
        `INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at)
      VALUES($1,$2,$3,$4::jsonb,clock_timestamp(),clock_timestamp())`,
        [athlete, input.id, input.revision, JSON.stringify(input.values)],
      );
      await tx.query(
        `INSERT INTO race_result_revision(athlete_id,entity_id,revision,values_json,created_at)
      VALUES($1,$2,$3,$4::jsonb,clock_timestamp())`,
        [athlete, input.id, input.revision, JSON.stringify(input.values)],
      );
    });
  } catch (error: unknown) {
    logSqlDiagnostic('RACE_PROOF_WRITE_SQL_DIAGNOSTIC', error);
    throw error;
  }
}
async function read(athlete: string, id: string) {
  return owned(athlete, async (client) => {
    const head = await client.query(
      'SELECT id,revision,values_json,recorded_at,updated_at FROM race_result WHERE athlete_id=$1 AND id=$2',
      [athlete, id],
    );
    const history = await client.query(
      'SELECT entity_id,revision,values_json,created_at FROM race_result_revision WHERE athlete_id=$1 AND entity_id=$2 ORDER BY revision',
      [athlete, id],
    );
    const refs = await client.query(
      'SELECT ordinal,source_kind,source_id,version_id,access_revision FROM race_result_proof_ref WHERE athlete_id=$1 AND result_id=$2 ORDER BY result_revision,ordinal',
      [athlete, id],
    );
    return { head: head.rows[0], history: history.rows, refs: refs.rows };
  });
}
async function deleteImage(athlete: string, source: Awaited<ReturnType<typeof sources>>) {
  return source.gallery.softDelete(athlete, source.image.item.id, {
    expectedAccessRevision: 1,
    idempotencyKey: `gallery-${randomUUID()}`,
  });
}
async function deletePdf(athlete: string, source: Awaited<ReturnType<typeof sources>>) {
  return createPrivateTextResourceRepository(database).softDelete(athlete, source.pdf.resourceId, {
    expectedAccessRevision: 1,
    expectedCurrentVersionId: source.pdf.versionId,
    idempotencyKey: randomUUID(),
  });
}
it('stores both public-finalized source descriptors and exact reverse roster; relational identity remains outside values', async () => {
  const athlete = await account(),
    source = await sources(athlete),
    input = body(source.attachments);
  await write(athlete, input);
  const result = await read(athlete, input.id);
  expect(
    raceResultV2Schema.parse({
      ...result.head?.['values_json'],
      id: result.head?.['id'],
      revision: result.head?.['revision'],
    }),
  ).toMatchObject({
    chipSeconds: 0,
    gunSeconds: null,
    proofs: { attachments: source.attachments },
  });
  expect(result.head?.['values_json']).not.toHaveProperty('id');
  expect(result.head?.['values_json']).not.toHaveProperty('revision');
  expect(result.refs).toHaveLength(2);
  expect(result.refs[1]).toMatchObject({
    source_kind: 'resource-pdf',
    source_id: source.pdf.resourceId,
    version_id: source.pdf.versionId,
    access_revision: 1,
  });
});
it('rejects foreign, mismatched, stale and unavailable direct SQL descriptors atomically', async () => {
  const athlete = await account(),
    foreign = await account(),
    source = await sources(athlete),
    foreignSource = await sources(foreign);
  const variants: unknown[] = [
    body(foreignSource.attachments).values,
    {
      ...body(source.attachments).values,
      proofs: { link: null, attachments: [{ ...source.attachments[0], sha256: 'c'.repeat(64) }] },
    },
    {
      ...body(source.attachments).values,
      proofs: { link: null, attachments: [{ ...source.attachments[0], accessRevision: 2 }] },
    },
    {
      ...body(source.attachments).values,
      proofs: {
        link: null,
        attachments: [
          { kind: 'gallery-image', mediaItemId: source.image.item.id, status: 'unavailable' },
        ],
      },
    },
    { ...body(source.attachments).values, id: randomUUID() },
    {
      ...body(source.attachments).values,
      proofs: {
        link: null,
        attachments: [{ ...source.attachments[0], storageRef: 'private/fake' }],
      },
    },
  ];
  for (const values of variants) {
    const id = randomUUID();
    await expect(
      database.tenant(athlete, async (tx) => {
        await tx.query(
          `INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,clock_timestamp(),clock_timestamp())`,
          [athlete, id, JSON.stringify(values)],
        );
      }),
    ).rejects.toThrow();
    expect((await read(athlete, id)).head).toBeUndefined();
  }
});
it('rejects head-only writes, omitted/extra reverse refs and unrelated historical updates', async () => {
  const athlete = await account(),
    source = await sources(athlete),
    input = body(source.attachments);
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query(
        `INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,clock_timestamp(),clock_timestamp())`,
        [athlete, input.id, JSON.stringify(input.values)],
      ),
    ),
  ).rejects.toThrow('RACE_PROOF_HEAD_HISTORY_MISMATCH');
  await write(athlete, input);
  await expect(
    owned(athlete, (client) =>
      client.query('DELETE FROM race_result_proof_ref WHERE athlete_id=$1 AND result_id=$2', [
        athlete,
        input.id,
      ]),
    ),
  ).rejects.toThrow('RACE_PROOF_ROSTER_MISMATCH');
  await expect(
    owned(athlete, (client) =>
      client.query(
        `INSERT INTO race_result_proof_ref(athlete_id,result_id,result_revision,ordinal,source_kind,source_id,access_revision) VALUES($1,$2,1,2,'gallery-image',$3,1)`,
        [athlete, input.id, randomUUID()],
      ),
    ),
  ).rejects.toThrow('RACE_PROOF_ROSTER_MISMATCH');
  await expect(
    owned(athlete, (client) =>
      client.query(
        `UPDATE race_result_revision SET values_json=jsonb_set(values_json,'{chipSeconds}','1') WHERE athlete_id=$1 AND entity_id=$2`,
        [athlete, input.id],
      ),
    ),
  ).rejects.toThrow('RACE_PROOF_HISTORY_REDACTION_NOT_EXACT');
});
it('physically removes descriptors from current and every historical revision without changing actual facts or source timestamps', async () => {
  const athlete = await account(),
    source = await sources(athlete),
    input = body(source.attachments);
  await write(athlete, input);
  await database.tenant(athlete, async (tx) => {
    const values = { ...input.values, weatherNote: 'Second actual note' };
    await tx.query(
      `UPDATE race_result SET revision=2,values_json=$3::jsonb,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2`,
      [athlete, input.id, JSON.stringify(values)],
    );
    await tx.query(
      `INSERT INTO race_result_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,2,$3::jsonb,clock_timestamp())`,
      [athlete, input.id, JSON.stringify(values)],
    );
  });
  const before = await read(athlete, input.id);
  await deleteImage(athlete, source);
  const imageDeleted = await read(athlete, input.id);
  expect(imageDeleted.history).toHaveLength(2);
  for (const row of imageDeleted.history) {
    const full = raceResultStorageLifecycleV2Schema.parse({
      ...row['values_json'],
      id: row['entity_id'],
      revision: row['revision'],
    });
    expect(full.proofs.attachments[0]).toEqual({
      kind: 'gallery-image',
      mediaItemId: source.image.item.id,
      status: 'unavailable',
    });
    expect(full.proofs.attachments[1]).toEqual(source.attachments[1]);
    expect(full.chipSeconds).toBe(0);
    expect(full.gunSeconds).toBeNull();
  }
  await deletePdf(athlete, source);
  const after = await read(athlete, input.id);
  expect(after.head?.['revision']).toBe(2);
  expect(after.head?.['recorded_at']).toEqual(before.head?.['recorded_at']);
  expect(after.head?.['updated_at']).toEqual(before.head?.['updated_at']);
  expect(after.history.map((row) => row['created_at'])).toEqual(
    before.history.map((row) => row['created_at']),
  );
  expect(after.refs.map((row) => row['access_revision'])).toEqual([null, null, null, null]);
  for (const row of after.history) {
    const value = raceResultStorageLifecycleV2Schema.parse({
      ...row['values_json'],
      id: row['entity_id'],
      revision: row['revision'],
    });
    expect(value.proofs.attachments[1]).toEqual({
      kind: 'resource-pdf',
      resourceId: source.pdf.resourceId,
      versionId: source.pdf.versionId,
      status: 'unavailable',
    });
    expect(JSON.stringify(value.proofs)).not.toMatch(
      /mediaType|byteSize|sha256|contentHash|accessRevision/,
    );
  }
  const generation = await owned(athlete, (client) =>
    client.query(
      "SELECT privacy_generation::text AS generation FROM race_collection_head WHERE athlete_id=$1 AND kind='race-result'",
      [athlete],
    ),
  );
  expect(generation.rows[0]?.['generation']).toBe('2');
  await owned(athlete, (client) =>
    client.query("SELECT public.redact_race_result_proof_source($1,'gallery-image',$2)", [
      athlete,
      source.image.item.id,
    ]),
  );
  const repeated = await owned(athlete, (client) =>
    client.query(
      "SELECT privacy_generation::text AS generation FROM race_collection_head WHERE athlete_id=$1 AND kind='race-result'",
      [athlete],
    ),
  );
  expect(repeated.rows).toEqual(generation.rows);
});
it('rejects manufactured unavailable owner INSERT and synthetic suppression without an exact source deletion event', async () => {
  const athlete = await account(),
    source = await sources(athlete),
    input = body(source.attachments);
  const values = {
    ...input.values,
    proofs: {
      link: null,
      attachments: [
        { kind: 'gallery-image', mediaItemId: source.image.item.id, status: 'unavailable' },
      ],
    },
  };
  await expect(
    owned(athlete, async (client) => {
      await client.query("SELECT set_config('app.restore_gallery_media_event_id',$1,true)", [
        randomUUID(),
      ]);
      await client.query(
        `INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,clock_timestamp(),clock_timestamp())`,
        [athlete, input.id, JSON.stringify(values)],
      );
    }),
  ).rejects.toThrow('RACE_PROOF_REDACTION_AUTHORITY_REQUIRED');
  expect((await read(athlete, input.id)).head).toBeUndefined();
  await deleteImage(athlete, source);
  // An actual media deletion event still does not authorize a new owner's claim.
  await expect(
    owned(athlete, (client) =>
      client.query(
        `INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,clock_timestamp(),clock_timestamp())`,
        [athlete, input.id, JSON.stringify(values)],
      ),
    ),
  ).rejects.toThrow('RACE_PROOF_REDACTION_AUTHORITY_REQUIRED');
});
it('runs exact authenticated source replay posthook on already-applied results and preserves idempotent privacy generation', async () => {
  const athlete = await account(),
    source = await sources(athlete),
    input = body(source.attachments);
  await write(athlete, input);
  // An existing live-deletion event without a restore receipt is not an
  // already-applied restore. Use the established plain-owner exact-replay
  // fixture: first execution itself creates the immutable event and receipt.
  // This synthetic tuple is not an authenticated external backup/restore drill.
  const stamp = await owned(athlete, (client) =>
    client.query('SELECT clock_timestamp()::text AS stamp'),
  );
  const event = {
    event_id: randomUUID(),
    occurred_at: z.string().parse(stamp.rows[0]?.['stamp']),
    gallery_access_revision: 2,
  };
  const invoke = () =>
    owned(athlete, (client) =>
      client.query('SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5) AS outcome', [
        athlete,
        source.image.item.id,
        event['event_id'],
        event['occurred_at'],
        event['gallery_access_revision'],
      ]),
    );
  expect((await invoke()).rows[0]?.['outcome']).toBe('deleted');
  const receipts = await owned(athlete, (client) =>
    client.query(
      'SELECT count(*)::int AS count FROM restore_gallery_media_replay_receipt WHERE athlete_id=$1 AND event_id=$2',
      [athlete, event.event_id],
    ),
  );
  expect(receipts.rows[0]).toEqual({ count: 1 });
  const before = await read(athlete, input.id);
  const replay = await invoke();
  expect(replay.rows[0]?.['outcome']).toBe('already_applied');
  expect(await read(athlete, input.id)).toEqual(before);
  await expect(
    owned(athlete, (client) =>
      client.query('SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5)', [
        athlete,
        source.image.item.id,
        randomUUID(),
        event['occurred_at'],
        event['gallery_access_revision'],
      ]),
    ),
  ).rejects.toThrow();
});

it('binds PDF proof to its exact historical version after a new public file version is appended', async () => {
  const athlete = await account(),
    source = await sources(athlete),
    uploads = createResourceFileUploadRepository(database);
  const next = await uploads.reserveAppend(
    athlete,
    source.pdf.resourceId,
    { expectedCurrentVersionId: source.pdf.versionId },
    randomUUID(),
  );
  const hash = 'c'.repeat(64);
  await uploads.prepareObject(athlete, next.uploadId, {
    storageRef: `private/v1/tenants/${athlete}/resources/${next.resourceId}/objects/uploads/${next.uploadId}/sha256/${hash}.pdf`,
    file: {
      originalFileName: 'second.pdf',
      extension: 'pdf',
      mediaType: 'application/pdf',
      byteSize: 4096,
      sha256: hash,
    },
  });
  await uploads.markStaged(athlete, next.uploadId);
  await uploads.finalize(athlete, next.uploadId);
  const oldPdf = source.attachments.find((a) => a.kind === 'resource-pdf');
  if (!oldPdf) throw new Error('MISSING_PDF');
  const input = body([{ ...oldPdf, accessRevision: 2 }]);
  await write(athlete, input);
  expect((await read(athlete, input.id)).refs[0]).toMatchObject({
    version_id: source.pdf.versionId,
    access_revision: 2,
  });
  const forged = body([{ ...oldPdf, accessRevision: 2, versionId: next.versionId }]);
  await expect(write(athlete, forged)).rejects.toThrow('RACE_PROOF_DESCRIPTOR_NOT_OWNED');
});
it('rejects hard source deletion without suppression and removes proof refs through normal authenticated account erasure', async () => {
  const athlete = await account(),
    foreign = await account(),
    source = await sources(athlete),
    other = await sources(foreign);
  const input = body(source.attachments),
    otherInput = body(other.attachments);
  await write(athlete, input);
  await write(foreign, otherInput);
  await expect(
    owned(athlete, (client) =>
      client.query('DELETE FROM gallery_media_item WHERE athlete_id=$1 AND id=$2', [
        athlete,
        source.image.item.id,
      ]),
    ),
  ).rejects.toThrow();
  await expect(
    owned(athlete, async (client) => {
      await client.query("SELECT set_config('app.restore_gallery_media_event_id',$1,true)", [
        randomUUID(),
      ]);
      await client.query(
        'UPDATE gallery_media_item SET deleted_at=statement_timestamp(),updated_at=statement_timestamp(),access_revision=2 WHERE athlete_id=$1 AND id=$2',
        [athlete, source.image.item.id],
      );
    }),
  ).rejects.toThrow('RACE_PROOF_SOURCE_EVENT_REQUIRED');
  expect((await read(athlete, input.id)).refs).toHaveLength(2);
  const before = await read(foreign, otherInput.id);
  await owned(athlete, (client) => client.query('SELECT public.erase_account($1)', [athlete]));
  expect((await read(athlete, input.id)).head).toBeUndefined();
  expect((await read(athlete, input.id)).refs).toEqual([]);
  expect(await read(foreign, otherInput.id)).toEqual(before);
});
it('runs the PDF exact replay posthook without replacing its historical attachment version', async () => {
  const athlete = await account(),
    source = await sources(athlete),
    input = body(source.attachments);
  await write(athlete, input);
  // An existing live-deletion event without a restore receipt is not an
  // already-applied restore. Use the established plain-owner exact-replay
  // fixture: first execution itself creates the immutable event and receipt.
  // This synthetic tuple is not an authenticated external backup/restore drill.
  const stamp = await owned(athlete, (client) =>
    client.query('SELECT clock_timestamp()::text AS stamp'),
  );
  const event = {
    event_id: randomUUID(),
    occurred_at: z.string().parse(stamp.rows[0]?.['stamp']),
    resource_access_revision: 2,
  };
  const invoke = () =>
    owned(athlete, (client) =>
      client.query('SELECT public.replay_resource_deletion_exact($1,$2,$3,$4,$5) AS outcome', [
        athlete,
        source.pdf.resourceId,
        event['event_id'],
        event['occurred_at'],
        event['resource_access_revision'],
      ]),
    );
  expect((await invoke()).rows[0]?.['outcome']).toBe('deleted');
  const receipts = await owned(athlete, (client) =>
    client.query(
      'SELECT count(*)::int AS count FROM restore_resource_replay_receipt WHERE athlete_id=$1 AND event_id=$2',
      [athlete, event.event_id],
    ),
  );
  expect(receipts.rows[0]).toEqual({ count: 1 });
  const before = await read(athlete, input.id);
  expect((await invoke()).rows[0]?.['outcome']).toBe('already_applied');
  expect(await read(athlete, input.id)).toEqual(before);
});

it('fails closed on mixed plain table/function ownership instead of granting a positive owner bypass', async () => {
  const athlete = await account(),
    source = await sources(athlete),
    input = body(source.attachments);
  await owner.query(`GRANT USAGE,CREATE ON SCHEMA public TO "${transferredRole}"`);
  await owner.query(`ALTER TABLE public.race_result_proof_ref OWNER TO "${transferredRole}"`);
  try {
    await expect(write(athlete, input)).rejects.toThrow('RACE_PROOF_PLAIN_COMMON_OWNER_REQUIRED');
  } finally {
    await owner.query(`ALTER TABLE public.race_result_proof_ref OWNER TO "${ownerRole}"`);
  }
  expect((await read(athlete, input.id)).head).toBeUndefined();
});

it('resolves real finalized image/PDF through the actual helper under normal grants and reads metadata-free after source removal', async () => {
  const athlete = await account(),
    source = await sources(athlete);
  // Preserve the real old-query permission failure; no private-ledger SELECT grant is added.
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query(
        "SELECT 1 FROM public.restore_suppression_event WHERE athlete_id=$1 AND kind='gallery_media_deleted' AND target_id=$2",
        [athlete, source.image.item.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });

  const prepared = await database.tenant(athlete, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    return prepareRaceResultProofs(tx, {
      link: null,
      attachments: [
        { kind: 'gallery-image', mediaItemId: source.image.item.id, expectedAccessRevision: 1 },
        {
          kind: 'resource-pdf',
          resourceId: source.pdf.resourceId,
          versionId: source.pdf.versionId,
          expectedAccessRevision: 1,
        },
      ],
    });
  });
  expect(prepared.attachments).toEqual(source.attachments);
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query("SELECT public.race_result_proof_source_suppressed($1,'unknown',$2)", [
        athlete,
        source.image.item.id,
      ]),
    ),
  ).rejects.toThrow('RACE_PROOF_SUPPRESSION_INPUT_INVALID');
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query("SELECT public.race_result_proof_source_suppressed($1,'gallery-image',$2)", [
        randomUUID(),
        source.image.item.id,
      ]),
    ),
  ).rejects.toThrow('RACE_PROOF_SUPPRESSION_INPUT_INVALID');
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query("SELECT public.race_result_proof_source_suppressed($1,'gallery-image',$2)", [
        athlete,
        randomUUID(),
      ]),
    ),
  ).rejects.toThrow('RACE_PROOF_SOURCE_UNAVAILABLE');

  const input = body(prepared.attachments);
  await write(athlete, input);
  await deleteImage(athlete, source);
  await deletePdf(athlete, source);
  const stored = await read(athlete, input.id);
  const decoded = raceResultStorageLifecycleV2Schema.parse({
    ...stored.head?.['values_json'],
    id: stored.head?.['id'],
    revision: stored.head?.['revision'],
  });
  const projected = await database.tenant(athlete, (tx) =>
    projectRaceResultProofsIn(tx, decoded.proofs),
  );
  expect(projected.attachments).toEqual([
    { kind: 'gallery-image', mediaItemId: source.image.item.id, status: 'unavailable' },
    {
      kind: 'resource-pdf',
      resourceId: source.pdf.resourceId,
      versionId: source.pdf.versionId,
      status: 'unavailable',
    },
  ]);
  expect(JSON.stringify(projected)).not.toMatch(
    /mediaType|byteSize|sha256|contentHash|accessRevision/,
  );
});

it('preserves the normal public V1 result wire and append-only historical behavior', async () => {
  const athlete = await account(),
    repo = createRaceRepository(database);
  const { schemaVersion: _schemaVersion, proofs: _proofs, ...values } = body([]).values;
  const created = await repo.createRaceResult(athlete, { idempotencyKey: randomUUID(), values });
  expect(await repo.getRaceResult(athlete, created.id)).toEqual({ ...values, ...created });
  expect((await read(athlete, created.id)).refs).toEqual([]);
  await expect(
    owned(athlete, (client) =>
      client.query(
        "UPDATE race_result_revision SET values_json=jsonb_set(values_json,'{chipSeconds}','1') WHERE athlete_id=$1 AND entity_id=$2",
        [athlete, created.id],
      ),
    ),
  ).rejects.toThrow('IMMUTABLE_RACE_HISTORY');
});

it('retains exact frozen and unavailable proofs when public Activity deletion unlinks independent manual and official results', async () => {
  const athlete = await account(),
    foreign = await account(),
    source = await sources(athlete);
  const activities = createActivityRepository(database);
  const activity = await activities.createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      title: 'Synthetic actual',
      kind: 'running',
      startedAt: '2026-01-01T10:00:00Z',
      durationSeconds: null,
      durationKind: 'unknown',
      timezone: 'UTC',
      distanceMeters: 0,
    },
    report: { sessionRpe: null, note: null, planLink: null },
  });
  const manual = body(source.attachments);
  manual.values.linkedActivityId = activity.activityId;
  const official = body(source.attachments);
  const parsed = raceResultV2Schema.parse({
    id: official.id,
    revision: 1,
    ...official.values,
    linkedActivityId: activity.activityId,
    source: {
      kind: 'official',
      authority: 'User supplied result page',
      resultUrl: 'https://example.test/results',
    },
  });
  const { id, revision, ...values } = parsed;
  const inputs = [manual, { id, revision, values }];
  for (const input of inputs) await write(athlete, input);
  await source.gallery.update(athlete, source.image.item.id, {
    album: null,
    caption: 'Caption changed; frozen descriptor stays at revision 1',
    activityId: null,
    expectedAccessRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await deletePdf(athlete, source);
  const before = await Promise.all(inputs.map((input) => read(athlete, input.id)));
  // No source deletion yet: an owner/GUC cannot authorize a clone, a repin or changed actual.
  for (const input of inputs) {
    for (const changed of [
      { ...input.values, linkedActivityId: null, chipSeconds: 1 },
      {
        ...input.values,
        linkedActivityId: null,
        proofs: { link: null, attachments: source.attachments },
      },
      { ...input.values, linkedActivityId: foreign },
      { ...input.values, source: { kind: 'official', authority: null } },
    ])
      await expect(
        owned(athlete, async (client) => {
          await client.query("SELECT set_config('app.race_proof_replay','true',true)");
          await client.query(
            'UPDATE race_result SET values_json=$3::jsonb,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
            [athlete, input.id, JSON.stringify(changed)],
          );
        }),
      ).rejects.toThrow();
  }
  await expect(
    activities.deleteActivity(foreign, activity.activityId, { expectedRevision: 1 }),
  ).rejects.toThrow();
  await activities.deleteActivity(athlete, activity.activityId, { expectedRevision: 1 });
  for (const [index, input] of inputs.entries()) {
    const previous = before[index];
    if (!previous) throw new Error('MISSING_BEFORE');
    const retained = await read(athlete, input.id);
    expect(retained.head).toMatchObject({
      revision: 2,
      recorded_at: previous.head?.['recorded_at'],
      values_json: {
        ...z.record(z.string(), z.unknown()).parse(previous.head?.['values_json']),
        linkedActivityId: null,
      },
    });
    expect(retained.history).toHaveLength(1);
    expect(retained.history[0]).toMatchObject({
      revision: 2,
      values_json: retained.head?.['values_json'],
    });
    const current = raceResultStorageLifecycleV2Schema.parse({
      id: input.id,
      revision: 2,
      ...z.record(z.string(), z.unknown()).parse(retained.head?.['values_json']),
    });
    expect(current.chipSeconds).toBe(0);
    expect(current.gunSeconds).toBeNull();
    expect(current.proofs.attachments[0]).toMatchObject({
      kind: 'gallery-image',
      accessRevision: 1,
    });
    expect(current.proofs.attachments[1]).toEqual({
      kind: 'resource-pdf',
      resourceId: source.pdf.resourceId,
      versionId: source.pdf.versionId,
      status: 'unavailable',
    });
    const facts = await owned(athlete, (client) =>
      client.query(
        `SELECT (SELECT count(*)::int FROM race_command_receipt WHERE athlete_id=$1) AS receipts,
        (SELECT count(*)::int FROM outbox WHERE athlete_id=$1 AND idempotency_key=$2
         AND topic='race.source_dependency_redacted') AS audits`,
        [athlete, `race-source-deletion:${activity.activityId}:race-result:${input.id}`],
      ),
    );
    expect(facts.rows[0]).toEqual({ receipts: 0, audits: 1 });
  }
});
