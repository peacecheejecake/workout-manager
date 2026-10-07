import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, Client, type PoolClient } from 'pg';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  createCurrentSourceCaptureService,
  type CurrentSourceEncryptedStore,
  type CurrentSourceEncryptedObject,
  type CurrentSourceSnapshotProvider,
} from '../src/restore-current-source-capture.js';
import { createCurrentIdentityTargetPreparation } from '../src/restore-current-identity-target.js';
import { createCurrentSourceReceiver } from '../src/restore-current-source-receiver.js';
import { z } from 'zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  migrate,
  grantCorePlanning,
  grantIdentityFunctions,
  grantOperations,
  grantRaces,
} from '../src/migrate.js';
import { createDatabase, type Database } from '../src/database.js';
import { createIdentityRepository, type IdentityRepository } from '../src/identity.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createOperationsRepository } from '../src/operations.js';
import {
  readCurrentSourceCatalogFingerprintIn,
  captureCurrentSourceCatalogIn,
  type CurrentSourceCatalogMetadata,
  currentSourceCatalogExpectedSchema,
  type CurrentSourceCatalogExpected,
  type CurrentSourceCatalogProfile,
} from '../src/restore-current-source-catalog.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root executes PostgreSQL. Fixed116222 source only; target SQL/admission absent.
// Credential rows come exclusively from public configured auth repository functions.
// The replication/pg_dump adapter is reused from the existing receiver PG fixture;
// these are real capture factories, not hand-constructed ciphertext source positives.
// Root executes PostgreSQL. Runtime producers are plain roles; the existing offline
// admin reads only catalog, COUNT and pg_column_size. No privileged body seed/read.
const enabled = Boolean(process.env['TEST_DATABASE_ADMIN_URL']);
const adminUrl = enabled ? z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']) : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `identity_target_${suffix}`,
  ownerRole = `identity_target_owner_${suffix}`,
  runtimeRole = `identity_target_app_${suffix}`;
const stages = [
  '108_nutrition_race_disconnection.sql',
  '109_race_result_proof_lifecycle.sql',
  '110_nutrition_disconnection_lineage.sql',
  '111_race_result_preserved_proof_updates.sql',
  '112_training_plan_aggregate_history.sql',
  '113_race_media_cleanup_source.sql',
  '114_manual_review_owned_source_bindings_v2.sql',
  '115_manual_review_full_owned_source_bindings_v2.sql',
  '116_manual_race_chain_v2.sql',
];
const roles: string[] = [];
let created = false;
let admin: Pool,
  owner: Pool,
  backup: Pool,
  runtime: Pool,
  db: Database,
  identity: IdentityRepository,
  expected: CurrentSourceCatalogExpected,
  expectedCatalog: CurrentSourceCatalogMetadata,
  athlete: string,
  erased: string;
// Matches C's signed source canonical namespace, not PostgreSQL row digests.
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  throw Error('INVALID_TAMPER_FIXTURE');
}
function endpoint(role?: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  if (role) {
    u.username = role;
    u.password = 'isolated';
  }
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD -c statement_timeout=10000');
  return u.toString();
}
async function snapshot<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
  begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(begin);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
async function pin() {
  // Separate provisioning transaction. Pin actual metadata before public census calls;
  // expected operator is the existing admin, never a freshly privileged role.
  return snapshot(backup, async (c) => {
    const source = z
      .strictObject({
        databaseName: z.string(),
        databaseOid: z.string(),
        systemIdentifier: z.string(),
        roleName: z.string(),
        roleOid: z.string(),
        superuser: z.boolean(),
        bypassRls: z.boolean(),
      })
      .parse(
        (
          await c.query(
            `SELECT current_database() AS "databaseName",d.oid::text AS "databaseOid",(SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",current_user AS "roleName",r.oid::text AS "roleOid",r.rolsuper AS superuser,r.rolbypassrls AS "bypassRls" FROM pg_database d,pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`,
          )
        ).rows[0],
      );
    const schemas = z
      .array(z.strictObject({ name: z.string() }))
      .parse(
        (
          await c.query(
            `SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' ORDER BY nspname COLLATE "C"`,
          )
        ).rows,
      )
      .map((r) => r.name);
    const relations = z
      .array(z.strictObject({ schema: z.string(), name: z.string() }))
      .parse(
        (
          await c.query(
            `SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`,
            [schemas],
          )
        ).rows,
      );
    const normalRegistry = z
      .array(z.strictObject({ version: z.number(), checksum: z.string() }))
      .parse(
        (await c.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows,
      );
    const explicitPins = await Promise.all(
      stages.map(async (file, i) => ({
        version: 108 + i,
        checksum: createHash('sha256')
          .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
          .digest('hex'),
      })),
    );
    const profile: CurrentSourceCatalogProfile = {
      profileVersion: 1,
      normalSchemaVersion: 107,
      explicitPins,
      normalRegistry,
      schemas,
      relations,
      roles: [
        { tag: 'backup', name: source.roleName },
        { tag: 'database_owner', name: 'pg_database_owner' },
        { tag: 'owner', name: ownerRole },
        { tag: 'runtime', name: runtimeRole },
      ],
      source: {
        databaseName: source.databaseName,
        databaseOid: source.databaseOid,
        systemIdentifier: source.systemIdentifier,
      },
      operator: {
        roleName: source.roleName,
        roleOid: source.roleOid,
        superuser: source.superuser,
        bypassRls: source.bypassRls,
      },
    };
    const fingerprint = await readCurrentSourceCatalogFingerprintIn(c, profile);
    return currentSourceCatalogExpectedSchema.parse({
      ...profile,
      catalogSha256: fingerprint.catalogSha256,
    });
  });
}
function raceValues(title: string) {
  return {
    title,
    localDate: '2026-10-08',
    localStartTime: null,
    timezone: 'Asia/Seoul',
    locationName: null,
    distance: { kind: 'standard' as const, class: '10k' as const },
    priority: null,
    participation: 'registered' as const,
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: null,
  };
}
describe
  .skipIf(!enabled)
  .sequential(
    'source116 authenticated identity target preparation only / no target SQL materialization',
    () => {
      beforeAll(async () => {
        admin = new Pool({ connectionString: adminUrl });
        for (const role of [ownerRole, runtimeRole]) {
          await admin.query(
            `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
          );
          roles.push(role);
        }
        await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
        created = true;
        await migrate(endpoint(ownerRole), 107);
        owner = new Pool({ connectionString: endpoint(ownerRole) });
        for (const file of stages)
          await owner.query(
            await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
          );
        for (const grant of [
          grantCorePlanning,
          grantIdentityFunctions,
          grantOperations,
          grantRaces,
        ])
          await grant(endpoint(ownerRole), runtimeRole);
        backup = new Pool({ connectionString: endpoint(), max: 2 });
        runtime = new Pool({ connectionString: endpoint(runtimeRole) });
        db = createDatabase({ connectionString: endpoint(runtimeRole) });
        identity = createIdentityRepository({ connectionString: endpoint(runtimeRole) });
        for (const index of [0, 1]) {
          const now = new Date();
          const result = await identity.createSession({
            tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            csrfToken: 'x'.repeat(32),
            issuer: 'https://synthetic.test',
            subject: randomUUID(),
            now,
            loginStartedAt: now,
            expiresAt: new Date(now.getTime() + 60000),
          });
          if (index === 0) athlete = result.athleteId;
          else erased = result.athleteId;
          await createConsentRepository(db).setConsent(result.athleteId, {
            kind: 'app',
            granted: true,
            expectedRevision: 0,
            idempotencyKey: randomUUID(),
          });
          await createRaceRepository(db).createRaceEvent(result.athleteId, {
            values: raceValues('Synthetic source census'),
            idempotencyKey: randomUUID(),
          });
        }
        await createOperationsRepository(db).eraseAccount(erased);
        // Only genuine configured runtime auth functions produce credentials.
        const now = new Date(),
          expiresAt = new Date(now.getTime() + 600000);
        const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
        await identity.createAttempt({
          stateHash: hash(),
          browserHash: hash(),
          nonce: randomUUID(),
          verifier: 'a'.repeat(43),
          expiresAt,
        });
        await identity.createNativeAttempt({
          stateHash: hash(),
          nonce: randomUUID(),
          verifier: 'a'.repeat(43),
          codeChallenge: 'b'.repeat(43),
          expiresAt,
        });
        await identity.createNativeCode({
          codeHash: hash(),
          codeChallenge: 'b'.repeat(43),
          issuer: 'https://synthetic.test',
          subject: randomUUID(),
          loginStartedAt: now,
          now,
          // Native exchange codes are capped at two minutes (SQL058),
          // independently from browser/native login-attempt lifetimes.
          expiresAt: new Date(now.getTime() + 60000),
        });
        const logoutSubject = randomUUID();
        await identity.createSession({
          tokenHash: hash(),
          csrfToken: 'x'.repeat(32),
          issuer: 'https://synthetic.test',
          subject: logoutSubject,
          now,
          loginStartedAt: now,
          expiresAt,
        });
        expect(
          await identity.revokeProviderSessions({
            issuer: 'https://synthetic.test',
            subject: logoutSubject,
            jtiHash: hash(),
            issuedAt: now,
          }),
        ).toBe(true);
        expected = await pin();
        // Independent configured catalogue pin from A, before C constructs the
        // encrypted manifest. It is not accepted from the signed payload itself.
        expectedCatalog = await snapshot(
          backup,
          async (c) => (await captureCurrentSourceCatalogIn(c, expected)).catalog,
        );
      }, 120000);
      afterAll(async () => {
        await identity?.close();
        await db?.close();
        await runtime?.end();
        await backup?.end();
        await owner?.end();
        if (created) await dropIsolatedDatabase(admin, name);
        for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
        await admin?.end();
      }, 30000);

      it('transforms genuine five-family identity producers after actual encrypted capture, retaining deny audit and refusing changed authentication or census', async () => {
        const captureId = randomUUID(),
          generationId = z
            .uuid()
            .parse(
              (await backup.query('SELECT public.current_restore_generation() AS id')).rows[0]?.[
                'id'
              ],
            ),
          slot = `identity_target_slot_${suffix}`;
        await createRaceRepository(db).createRaceEvent(athlete, {
          values: raceValues('Before snapshot synthetic'),
          idempotencyKey: randomUUID(),
        });
        const objects = new Map<
          string,
          { descriptor: CurrentSourceEncryptedObject; bytes: Uint8Array }
        >();
        let tamper: 'none' | 'ciphertext' | 'version' | 'owner' = 'none';
        let expectedCapture:
          | {
              captureId: string;
              generationId: string;
              snapshotId: string;
              transactionSnapshot: string;
              baselineLsn: string;
            }
          | undefined;
        const store: CurrentSourceEncryptedStore = {
          async put(input) {
            if (objects.has(input.objectId)) throw new Error('OWNED_OBJECT_COLLISION');
            const descriptor = {
              objectId: input.objectId,
              owner: input.owner,
              versionId: randomUUID(),
              sha256: createHash('sha256').update(input.bytes).digest('hex'),
              byteLength: input.bytes.length,
            };
            objects.set(input.objectId, { descriptor, bytes: Buffer.from(input.bytes) });
            return descriptor;
          },
          async read(id, version) {
            const stored = objects.get(id);
            if (!stored || stored.descriptor.versionId !== version)
              throw new Error('OWNED_OBJECT_MISSING');
            const bytes = Buffer.from(stored.bytes);
            if (tamper === 'ciphertext' && id.endsWith('_extra')) {
              const last = bytes[bytes.length - 1];
              if (last === undefined) throw Error('EMPTY_OBJECT');
              bytes[bytes.length - 1] = last ^ 1;
            }
            return {
              descriptor: {
                ...stored.descriptor,
                ...(tamper === 'version' ? { versionId: 'changed-immutable-version' } : {}),
                ...(tamper === 'owner' ? { owner: generationId } : {}),
              },
              bytes,
            };
          },
          async removeOwned(d) {
            const stored = objects.get(d.objectId);
            if (stored?.descriptor.owner !== d.owner || stored.descriptor.versionId !== d.versionId)
              throw new Error('FOREIGN_OBJECT');
            objects.delete(d.objectId);
          },
        };
        const archiveKey = Buffer.alloc(32, 9);
        const archiveCounts = new Map<string, bigint>();
        let exporterOpen = false;
        async function program(name: 'pg_dump' | 'pg_restore', args: string[], input?: Uint8Array) {
          const u = new URL(endpoint());
          const docker = process.env['TEST_SOURCE_CAPTURE_DOCKER_CONTAINER'];
          if (docker && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(docker))
            throw new Error('INVALID_CAPTURE_DOCKER');
          const bin = docker
            ? 'docker'
            : join(z.string().min(1).parse(process.env['PG_BIN']), name);
          const argv = docker
            ? [
                'exec',
                '-i',
                '-e',
                'PGUSER',
                '-e',
                'PGPASSWORD',
                '-e',
                'PGDATABASE',
                '-e',
                'PGHOST',
                '-e',
                'PGPORT',
                docker,
                name,
                ...args,
              ]
            : args;
          const env = {
            ...process.env,
            PGUSER: decodeURIComponent(u.username),
            PGPASSWORD: decodeURIComponent(u.password),
            PGDATABASE: u.pathname.slice(1),
            PGHOST: docker ? '127.0.0.1' : (u.searchParams.get('host') ?? u.hostname),
            PGPORT: docker ? '5432' : u.port || '5432',
            PGOPTIONS: u.searchParams.get('options') ?? '-c statement_timeout=10000',
          };
          return new Promise<Buffer>((resolve, reject) => {
            const child = spawn(bin, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
            const chunks: Buffer[] = [];
            let size = 0;
            const timeout = setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error('ARCHIVE_PROGRAM_TIMEOUT'));
            }, 30000);
            child.stdout.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 16 * 1024 * 1024) {
                child.kill('SIGTERM');
                reject(new Error('ARCHIVE_PROGRAM_BOUND'));
              } else chunks.push(chunk);
            });
            child.stderr.resume();
            child.on('error', () => {
              clearTimeout(timeout);
              reject(new Error('ARCHIVE_PROGRAM_START_FAILED'));
            });
            child.on('close', (code) => {
              clearTimeout(timeout);
              if (code !== 0) reject(new Error('ARCHIVE_PROGRAM_FAILED'));
              else resolve(Buffer.concat(chunks));
            });
            child.stdin.on('error', () => {});
            child.stdin.end(input);
          });
        }
        const provider: CurrentSourceSnapshotProvider = {
          async withSnapshot(callback) {
            const replicationUrl = new URL(endpoint());
            replicationUrl.searchParams.set('replication', 'database');
            const replication = new Client({ connectionString: replicationUrl.toString() }),
              c = await backup.connect();
            try {
              await replication.connect();
              const exported = z
                .strictObject({
                  slot_name: z.string(),
                  consistent_point: z.string(),
                  snapshot_name: z.string().regex(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{8}-[0-9]+$/),
                  output_plugin: z.literal('pgoutput'),
                })
                .parse(
                  (
                    await replication.query(
                      `CREATE_REPLICATION_SLOT ${slot} TEMPORARY LOGICAL pgoutput EXPORT_SNAPSHOT`,
                    )
                  ).rows[0],
                );
              exporterOpen = true;
              await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
              await c.query(`SET TRANSACTION SNAPSHOT '${exported.snapshot_name}'`);
              const anchor = z
                .strictObject({ snapshot: z.string() })
                .parse((await c.query('SELECT txid_current_snapshot()::text AS snapshot')).rows[0]);
              await createRaceRepository(db).createRaceEvent(athlete, {
                values: raceValues('After snapshot synthetic'),
                idempotencyKey: randomUUID(),
              });
              expectedCapture = {
                captureId,
                generationId,
                snapshotId: exported.snapshot_name,
                transactionSnapshot: anchor.snapshot,
                baselineLsn: exported.consistent_point,
              };
              const result = await callback({
                tx: c,
                snapshotId: exported.snapshot_name,
                transactionSnapshot: anchor.snapshot,
                baselineLsn: exported.consistent_point,
                captureId,
                generationId,
                source: expected.source,
                async archive(request) {
                  expect(exporterOpen).toBe(true);
                  const plain = await program('pg_dump', [
                    '--format=custom',
                    `--snapshot=${request.snapshotId}`,
                  ]);
                  const restored = await program('pg_restore', ['--data-only', '--file=-'], plain);
                  let current: string | null = null;
                  for (const line of restored.toString().split('\n')) {
                    if (line.startsWith('COPY ')) {
                      const match = /^COPY ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) \(/.exec(line);
                      if (!match) throw new Error('UNKNOWN_ARCHIVE_COPY');
                      current =
                        match[1] === 'public' ? (match[2] ?? null) : `${match[1]}.${match[2]}`;
                      if (!current) throw new Error('UNKNOWN_ARCHIVE_COPY');
                      archiveCounts.set(current, 0n);
                    } else if (line === '\\.') current = null;
                    else if (current)
                      archiveCounts.set(current, (archiveCounts.get(current) ?? 0n) + 1n);
                  }
                  const nonce = randomBytes(12),
                    cipher = createCipheriv('aes-256-gcm', archiveKey, nonce);
                  cipher.setAAD(Buffer.from(`${captureId}:${request.snapshotId}`));
                  const encrypted = Buffer.concat([
                    nonce,
                    cipher.update(plain),
                    cipher.final(),
                    cipher.getAuthTag(),
                  ]);
                  const archiveDecoder = createDecipheriv('aes-256-gcm', archiveKey, nonce);
                  archiveDecoder.setAAD(Buffer.from(`${captureId}:${request.snapshotId}`));
                  archiveDecoder.setAuthTag(encrypted.subarray(encrypted.length - 16));
                  const decodedArchive = Buffer.concat([
                    archiveDecoder.update(encrypted.subarray(12, encrypted.length - 16)),
                    archiveDecoder.final(),
                  ]);
                  expect(decodedArchive.equals(plain)).toBe(true);
                  decodedArchive.fill(0);
                  plain.fill(0);
                  restored.fill(0);
                  const descriptor = z
                    .strictObject({
                      objectId: z.string(),
                      owner: z.string(),
                      versionId: z.string(),
                      sha256: z.string(),
                      byteLength: z.number(),
                    })
                    .parse(
                      await store.put({
                        objectId: `${captureId}_archive`,
                        owner: captureId,
                        bytes: encrypted,
                      }),
                    );
                  return {
                    descriptor,
                    snapshotId: request.snapshotId,
                    baselineLsn: exported.consistent_point,
                    source: expected.source,
                  };
                },
              });
              await c.query('COMMIT');
              return result;
            } catch (error) {
              await c.query('ROLLBACK');
              throw error;
            } finally {
              exporterOpen = false;
              c.release();
              await replication.end();
            }
          },
        };
        const result = await createCurrentSourceCaptureService({
          expected,
          encryptionKey: Buffer.alloc(32, 1),
          encryptionKeyId: 'capture',
          sourceAuthenticationKey: Buffer.alloc(32, 2),
          sourceKeyId: 'source',
          store,
          snapshots: provider,
        }).capture();
        expect(result.status).toBe('baseline_captured');
        expect(result.limits).toMatchObject({
          admissionAllowed: false,
          wholeWalTail: 'not_captured',
          sequenceFence: 'not_captured_non_mvcc',
          archiveRowCorrespondence: 'not_verified',
        });
        expect(archiveCounts.get('race_event')).toBe(2n);
        expect((await backup.query('SELECT count(*)::int AS count FROM race_event')).rows).toEqual([
          { count: 3 },
        ]);
        if (!expectedCapture) throw Error('ACTUAL_EXPORTED_SNAPSHOT_MISSING');
        const receiver = createCurrentSourceReceiver({
          expected,
          expectedCatalog,
          expectedCapture,
          expectedManifest: result.manifest,
          encryptionKey: Buffer.alloc(32, 1),
          encryptionKeyId: 'capture',
          sourceAuthenticationKey: Buffer.alloc(32, 2),
          sourceKeyId: 'source',
          store,
        });
        const source = {
          expected,
          expectedCatalog,
          expectedCapture,
          expectedManifest: result.manifest,
          encryptionKeyId: 'capture',
          sourceKeyId: 'source',
          store,
        };
        let activeKeys = true;
        const resolveKeys = async () =>
          activeKeys
            ? { encryptionKey: Buffer.alloc(32, 1), sourceAuthenticationKey: Buffer.alloc(32, 2) }
            : null;
        const target = createCurrentIdentityTargetPreparation({ source, resolveKeys });
        const prepared = await target.prepare();
        expect(prepared.census).toHaveLength(5);
        expect(prepared.census.every((r) => BigInt(r.sourceCount) > 0n)).toBe(true);
        expect(prepared.census.map((r) => r.targetCount)).toEqual([
          '0',
          prepared.census[1]?.sourceCount,
          '0',
          '0',
          '0',
        ]);
        let sourceReplayRows: unknown[] = [];
        const handle = await receiver.receive(result.manifest);
        receiver.withVerifiedCurrentSource(handle, (received) => {
          expect(received.manifest.catalogSha256).toBe(expected.catalogSha256);
          expect(received.manifest.source).toEqual(expected.source);
          expect(received.manifest.snapshotId).toBe(expectedCapture?.snapshotId);
          expect(received.packets.map((p) => p.partition.kind)).toEqual([
            'parent',
            'extra',
            'child',
          ]);
          expect(received.packets.flatMap((p) => p.partition.census)).toHaveLength(222);
          for (const r of received.manifest.census) {
            const relation = r.schema === 'public' ? r.relation : `${r.schema}.${r.relation}`;
            expect(archiveCounts.has(relation)).toBe(true);
            expect(archiveCounts.get(relation)).toBe(BigInt(r.rows));
          }
          sourceReplayRows = received.packets
            .flatMap((p) => p.partition.rows)
            .filter((r) => r.relation === 'identity_private.logout_token_replay');
          const races = received.packets
            .flatMap((p) => p.partition.rows)
            .filter((r) => r.relation === 'race_event');
          expect(races).toHaveLength(2);
          expect(received.manifest.census).toHaveLength(222);
          expect(
            received.packets.every(
              (p) => p.partition.physicalEvidence.length === p.partition.census.length,
            ),
          ).toBe(true);
          expect(received.limits).toMatchObject({
            authority: 'none',
            admissionAllowed: false,
            archiveRowCorrespondence: 'not_verified',
            latestTail: 'not_checked',
            sequenceFence: 'not_captured_non_mvcc',
            targetTransforms: 'not_implemented',
          });
        });
        await target.withPreparedIdentityTarget(prepared.handle, (actual) => {
          expect(actual.rows).toEqual(sourceReplayRows); // exact physical source ordinals/UTCµs preserved
          expect(actual.limits).toMatchObject({
            authority: 'none',
            admissionAllowed: false,
            sqlApply: 'not_executed',
            sourceFreshness: 'fixed_manifest_bytes_only',
            latestTail: 'not_checked',
          });
        });
        await expect(
          createCurrentIdentityTargetPreparation({
            source,
            resolveKeys: async () => ({
              encryptionKey: Buffer.alloc(32, 8),
              sourceAuthenticationKey: Buffer.alloc(32, 2),
            }),
          }).prepare(),
        ).rejects.toThrow();
        await expect(
          createCurrentIdentityTargetPreparation({
            source: {
              ...source,
              expected: {
                ...expected,
                source: { ...expected.source, databaseName: 'different_source' },
              },
            },
            resolveKeys,
          }).prepare(),
        ).rejects.toThrow();
        activeKeys = false;
        await expect(
          target.withPreparedIdentityTarget(prepared.handle, () => 'never'),
        ).rejects.toMatchObject({ code: 'KEY_UNAVAILABLE' });
        activeKeys = true;
        await expect(runtime.query('SELECT * FROM identity_private.session')).rejects.toMatchObject(
          { code: '42501' },
        );
        for (const mode of ['ciphertext', 'version', 'owner'] as const) {
          tamper = mode;
          await expect(
            target.withPreparedIdentityTarget(prepared.handle, () => 'never'),
          ).rejects.toThrow();
        }
        tamper = 'none';
        const originalManifest = objects.get(result.manifest.objectId);
        if (!originalManifest) throw Error('MISSING_MANIFEST');
        const raw = Buffer.from(originalManifest.bytes),
          headerLength = raw.readUInt32BE(8),
          header = raw.subarray(12, 12 + headerLength);
        const decoder = createDecipheriv(
          'aes-256-gcm',
          Buffer.alloc(32, 1),
          raw.subarray(12 + headerLength, 24 + headerLength),
        );
        decoder.setAAD(header);
        decoder.setAuthTag(raw.subarray(24 + headerLength, 40 + headerLength));
        const signed = z
          .strictObject({
            body: z.record(z.string(), z.unknown()),
            bodyDigest: z.string(),
            sourceKeyId: z.string(),
            signature: z.string(),
          })
          .parse(
            JSON.parse(
              Buffer.concat([
                decoder.update(raw.subarray(40 + headerLength)),
                decoder.final(),
              ]).toString(),
            ),
          );
        const census = z
          .array(
            z.strictObject({
              schema: z.string(),
              relation: z.string(),
              rows: z.string(),
              rowStorageBytes: z.string(),
            }),
          )
          .parse(signed.body['census']);
        const first = census[0];
        if (!first) throw Error('CENSUS_MISSING');
        first.rows = '999';
        signed.body['census'] = census;
        signed.bodyDigest = createHash('sha256').update(canonical(signed.body)).digest('hex');
        signed.signature = createHmac('sha256', Buffer.alloc(32, 2))
          .update('wm-current-whole-source-baseline-v1\0')
          .update(canonical(signed.body))
          .digest('hex');
        const nonce = randomBytes(12),
          encoder = createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), nonce);
        encoder.setAAD(header);
        const encrypted = Buffer.concat([encoder.update(canonical(signed)), encoder.final()]);
        const tampered = Buffer.concat([
          raw.subarray(0, 12),
          header,
          nonce,
          encoder.getAuthTag(),
          encrypted,
        ]);
        const badDescriptor = {
          ...result.manifest,
          versionId: randomUUID(),
          byteLength: tampered.length,
          sha256: createHash('sha256').update(tampered).digest('hex'),
        };
        // Negative crypto fixture only: deliberately signed wrong census from the
        // actual baseline. It is not passed off as genuine source observation.
        objects.set(badDescriptor.objectId, { descriptor: badDescriptor, bytes: tampered });
        try {
          await expect(
            createCurrentIdentityTargetPreparation({
              source: { ...source, expectedManifest: badDescriptor },
              resolveKeys,
            }).prepare(),
          ).rejects.toMatchObject({
            code: 'PHYSICAL_CORRESPONDENCE_FAILED',
          });
        } finally {
          objects.set(originalManifest.descriptor.objectId, originalManifest);
        }
        expect(
          receiver.withVerifiedCurrentSource(
            handle,
            (received) => received.manifest.census[0]?.rows,
          ),
        ).not.toBe('999');
        // Real source row-cap boundary: use the same granted public producer,
        // never INSERT credential bodies or fabricate a SQL scalar result.
        const stressPrefix = randomUUID();
        expect(
          (
            await runtime.query(
              `WITH attempts AS MATERIALIZED (
          SELECT public.auth_create_attempt(repeat(md5($1||i::text),2),repeat(md5('browser'||$1||i::text),2),$1,repeat('a',43),clock_timestamp()+interval '10 minutes')
          FROM generate_series(1,5001) i)
          SELECT count(*)::int AS count FROM attempts`,
              [stressPrefix],
            )
          ).rows,
        ).toEqual([{ count: 5001 }]);
        expect(
          BigInt(
            z
              .string()
              .parse(
                (
                  await backup.query(
                    'SELECT count(*)::text AS count FROM identity_private.login_attempt',
                  )
                ).rows[0]?.['count'],
              ),
          ),
        ).toBeGreaterThan(5000n);
        let credentialBodyReads = 0,
          archiveCalls = 0,
          scalarReads = 0,
          censusReads = 0;
        const loginQueryKinds: ('census_metadata' | 'encoded_scalar' | 'body_or_unknown')[] = [];
        const boundedProvider: CurrentSourceSnapshotProvider = {
          async withSnapshot(callback, signal) {
            return provider.withSnapshot(
              async (actual) =>
                callback({
                  ...actual,
                  tx: {
                    async query(sql, values) {
                      if (sql.includes('FROM ONLY "identity_private"."login_attempt"')) {
                        // A first reads count/pg_column_size only; C then
                        // computes encoded byte scalars before selecting bodies.
                        // Unknown same-relation SQL remains counted as body.
                        if (
                          sql ===
                          'SELECT count(*)::text AS rows,COALESCE(sum(pg_column_size(t)),0)::text AS "rowStorageBytes" FROM ONLY "identity_private"."login_attempt" t'
                        ) {
                          censusReads++;
                          loginQueryKinds.push('census_metadata');
                        } else if (
                          sql.startsWith('WITH encoded AS(SELECT ') &&
                          sql.includes(
                            'SELECT count(*)::text AS count,COALESCE(sum(octet_length(to_jsonb(encoded)::text)),0)::text AS bytes,COALESCE(max(octet_length(to_jsonb(encoded)::text)),0)::text AS maximum FROM encoded',
                          )
                        ) {
                          scalarReads++;
                          loginQueryKinds.push('encoded_scalar');
                        } else {
                          credentialBodyReads++;
                          loginQueryKinds.push('body_or_unknown');
                        }
                      }
                      return actual.tx.query(sql, values);
                    },
                  },
                  async archive(request) {
                    archiveCalls++;
                    return actual.archive(request);
                  },
                }),
              signal,
            );
          },
        };
        await expect(
          createCurrentSourceCaptureService({
            expected,
            encryptionKey: Buffer.alloc(32, 1),
            encryptionKeyId: 'capture',
            sourceAuthenticationKey: Buffer.alloc(32, 2),
            sourceKeyId: 'source',
            store,
            snapshots: boundedProvider,
          }).capture(),
        ).rejects.toMatchObject({ code: 'PHYSICAL_CAPTURE_LIMIT' });
        expect(loginQueryKinds).toEqual(['census_metadata', 'encoded_scalar']);
        expect(censusReads).toBe(1);
        expect(scalarReads).toBe(1);
        expect(credentialBodyReads).toBe(0);
        expect(archiveCalls).toBe(0);
        // This real pg_dump COPY-count crosscheck is a fixture observation; the
        // receiver does not itself establish dump row-hash/latest-tail equivalence.
        expect(
          (
            await backup.query(
              'SELECT count(*)::int AS count FROM pg_replication_slots WHERE slot_name=$1',
              [slot],
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      }, 120000);
    },
  );
