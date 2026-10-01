#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSnapshotContract } from './docker-archive-transport.mjs';

const MAX_OUTPUT_BYTES = 4096;
const MIN_HEADROOM_BYTES = 64 * 1024 * 1024;
const ALLOWED_COMMANDS = new Set(['collect', 'verify']);

function fail(code) {
  throw new Error(code);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!ALLOWED_COMMANDS.has(command)) fail('BACKUP_INVALID_COMMAND');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || key in options) {
      fail('BACKUP_INVALID_ARGUMENT');
    }
    options[key] = value;
  }
  const required =
    command === 'collect'
      ? ['--private-dir', '--output-dir', '--fence-check']
      : ['--bundle', '--post-backup-ledger-dir'];
  if (required.some((key) => !options[key])) fail('BACKUP_MISSING_ARGUMENT');
  if (
    command === 'collect' &&
    Boolean(options['--database-url-file']) === Boolean(options['--database-transport'])
  ) {
    fail('BACKUP_DATABASE_SOURCE_REQUIRED');
  }
  const allowed = new Set(
    command === 'collect'
      ? [
          ...required,
          '--database-url-file',
          '--database-transport',
          '--synthetic-test',
          '--min-free-bytes',
          '--synthetic-snapshot-v2',
          '--snapshot-name',
          '--consistent-point-lsn',
          '--postgres-system-identifier',
          '--replication-slot',
          '--publication',
          '--local-exported-slot-proof',
          '--local-expected-system-identifier',
          '--synthetic-persistent-slot-proof',
          '--persistent-expected-system-identifier',
          '--persistent-publication-tables',
          '--persistent-publication-operations',
          '--persistent-slot-owner',
        ]
      : [...required, '--synthetic-test', '--min-free-bytes'],
  );
  if (Object.keys(options).some((key) => !allowed.has(key))) fail('BACKUP_INVALID_ARGUMENT');
  return { command, options };
}

function assertSecureFile(path, mode) {
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o777) !== mode) fail('BACKUP_UNSAFE_FILE');
  return info;
}

function assertSecureDir(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) fail('BACKUP_UNSAFE_DIRECTORY');
  return info;
}

function assertNoSymlinkParents(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('BACKUP_SYMLINK_PATH');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function syntheticPath(path) {
  const resolved = resolve(path);
  const root = realpathSync(tmpdir()) + sep;
  return resolved.startsWith(root) && !resolved.includes(`${sep}..${sep}`);
}

function assertPrivilege(options, paths) {
  if (options['--synthetic-test'] === 'yes' && paths.every(syntheticPath)) return;
  if (process.getuid?.() !== 0) fail('BACKUP_ROOT_REQUIRED');
  if (options['--synthetic-test']) fail('BACKUP_INVALID_SYNTHETIC_MODE');
}

function assertRootOwned(paths, options) {
  if (options['--synthetic-test'] === 'yes') return;
  for (const path of paths) {
    if (lstatSync(path).uid !== 0) fail('BACKUP_ROOT_OWNER_REQUIRED');
  }
}

function run(command, args, env = process.env, timeout = 120_000) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result.error || result.status !== 0) fail('BACKUP_SUBPROCESS_FAILED');
}

function digest(path) {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function syncFile(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectoryTree(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) syncDirectoryTree(child);
    else if (entry.isFile()) syncFile(child);
    else fail('BACKUP_UNSAFE_STAGING_ENTRY');
  }
  syncFile(path);
}

function privateFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        fail('BACKUP_UNSAFE_PRIVATE_ENTRY');
      if (info.isDirectory()) walk(path);
      else {
        if (info.nlink !== 1) fail('BACKUP_PRIVATE_HARDLINK');
        const name = relative(root, path);
        if (!name || name.startsWith('..') || isAbsolute(name)) fail('BACKUP_UNSAFE_PRIVATE_PATH');
        files.push({ name, path, size: info.size });
      }
    }
  }
  walk(root);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function databaseEnv(file, connectionString) {
  assertSecureFile(file, 0o600);
  const url = new URL(connectionString ?? readFileSync(file, 'utf8').trim());
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    fail('BACKUP_INVALID_DATABASE_URL');
  if (
    !url.hostname ||
    !url.username ||
    !url.password ||
    !url.pathname ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== 'host')
  ) {
    fail('BACKUP_INVALID_DATABASE_URL');
  }
  return {
    ...process.env,
    PGHOST: url.searchParams.get('host') || url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: '10',
  };
}

function checkFence(path, timeout = 120_000) {
  const info = assertSecureFile(path, 0o700);
  if (process.getuid?.() === 0 && info.uid !== 0) fail('BACKUP_FENCE_OWNER');
  run(path, [], process.env, timeout);
}

function snapshotContract(options) {
  const keys = [
    '--synthetic-snapshot-v2',
    '--snapshot-name',
    '--consistent-point-lsn',
    '--postgres-system-identifier',
    '--replication-slot',
    '--publication',
  ];
  if (!keys.some((key) => key in options)) return undefined;
  if (
    options['--synthetic-snapshot-v2'] !== 'yes' ||
    options['--synthetic-test'] !== 'yes' ||
    keys.some((key) => !options[key])
  ) {
    fail('BACKUP_SNAPSHOT_V2_INACTIVE');
  }
  try {
    return validateSnapshotContract({
      snapshotName: options['--snapshot-name'],
      consistentPointLsn: options['--consistent-point-lsn'],
      postgresSystemIdentifier: options['--postgres-system-identifier'],
      replicationSlot: options['--replication-slot'],
      publication: options['--publication'],
    });
  } catch {
    fail('BACKUP_INVALID_SNAPSHOT_CONTRACT');
  }
}

function localSlotProof(options) {
  if (
    !['--local-exported-slot-proof', '--local-expected-system-identifier'].some(
      (key) => key in options,
    )
  )
    return undefined;
  if (
    options['--local-exported-slot-proof'] !== 'yes' ||
    options['--synthetic-test'] !== 'yes' ||
    !options['--database-url-file'] ||
    options['--database-transport'] ||
    !options['--local-expected-system-identifier'] ||
    !options['--replication-slot'] ||
    !options['--publication'] ||
    [
      '--synthetic-snapshot-v2',
      '--snapshot-name',
      '--consistent-point-lsn',
      '--postgres-system-identifier',
    ].some((key) => key in options)
  ) {
    fail('BACKUP_LOCAL_SLOT_PROOF_INACTIVE');
  }
  return {
    expectedSystemIdentifier: options['--local-expected-system-identifier'],
    slotName: options['--replication-slot'],
    publication: options['--publication'],
  };
}

function persistentSlotProof(options) {
  const keys = [
    '--synthetic-persistent-slot-proof',
    '--persistent-expected-system-identifier',
    '--persistent-publication-tables',
    '--persistent-publication-operations',
    '--persistent-slot-owner',
  ];
  if (!keys.some((key) => key in options)) return undefined;
  if (
    options['--synthetic-persistent-slot-proof'] !== 'yes' ||
    options['--synthetic-test'] !== 'yes' ||
    !options['--database-url-file'] ||
    options['--database-transport'] ||
    keys.some((key) => !options[key]) ||
    !options['--replication-slot'] ||
    !options['--publication'] ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(options['--persistent-slot-owner']) ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(options['--replication-slot']) ||
    [
      '--local-exported-slot-proof',
      '--local-expected-system-identifier',
      '--synthetic-snapshot-v2',
      '--snapshot-name',
      '--consistent-point-lsn',
      '--postgres-system-identifier',
    ].some((key) => key in options)
  )
    fail('BACKUP_PERSISTENT_SLOT_PROOF_INACTIVE');
  return {
    expectedSystemIdentifier: options['--persistent-expected-system-identifier'],
    slotName: options['--replication-slot'],
    expectedPublication: options['--publication'],
    expectedPublicationTables: options['--persistent-publication-tables'].split(','),
    expectedPublicationOperations: options['--persistent-publication-operations'].split(','),
    owner: options['--persistent-slot-owner'],
  };
}

function syncOwnership(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.partial`;
  // The exclusive reservation survives crashes and prohibits automatic retries.
  if (exclusive) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    syncFile(path);
    syncFile(dirname(path));
    return;
  }
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    syncFile(temporary);
    renameSync(temporary, path);
    syncFile(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function collect(options) {
  const persistentProof = persistentSlotProof(options);
  const localProof = localSlotProof(options);
  let snapshot = localProof || persistentProof ? undefined : snapshotContract(options);
  const dbFile = options['--database-url-file']
    ? resolve(options['--database-url-file'])
    : undefined;
  const databaseTransport = options['--database-transport']
    ? resolve(options['--database-transport'])
    : undefined;
  const privateDir = resolve(options['--private-dir']);
  const outputDir = resolve(options['--output-dir']);
  const fence = resolve(options['--fence-check']);
  const assertFence = () => checkFence(fence, persistentProof ? 5_000 : 120_000);
  if (
    outputDir === privateDir ||
    outputDir.startsWith(`${privateDir}${sep}`) ||
    privateDir.startsWith(`${outputDir}${sep}`)
  )
    fail('BACKUP_OVERLAPPING_PATHS');
  const source = dbFile ?? databaseTransport;
  assertPrivilege(options, [source, privateDir, outputDir, fence]);
  for (const path of [source, privateDir, outputDir, fence]) assertNoSymlinkParents(path);
  assertSecureDir(privateDir);
  assertSecureDir(outputDir);
  assertRootOwned([source, outputDir, fence], options);
  if (databaseTransport) assertSecureFile(databaseTransport, 0o700);
  assertFence();
  const files = privateFiles(privateDir).map((file) => ({ ...file, ...digest(file.path) }));
  const estimatedBytes = files.reduce((total, file) => total + file.size, 0);
  if (persistentProof && (files.length > 16 || estimatedBytes > 32 * 1024 * 1024))
    fail('BACKUP_PERSISTENT_CAPTURE_LIMIT');
  const free = statfsSync(outputDir).bavail * statfsSync(outputDir).bsize;
  const minimum = Number(options['--min-free-bytes'] ?? MIN_HEADROOM_BYTES);
  if (!Number.isSafeInteger(minimum) || minimum < MIN_HEADROOM_BYTES)
    fail('BACKUP_INVALID_MINIMUM');
  if (free < estimatedBytes * 2 + minimum) fail('BACKUP_DISK_LOW');
  const env = dbFile ? databaseEnv(dbFile) : process.env;
  assertFence();
  const id = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const staging = join(outputDir, `.${id}.partial`);
  const published = join(outputDir, id);
  mkdirSync(staging, { mode: 0o700 });
  let renamed = false;
  let ownershipPath;
  let ownership;
  let ownsReservation = false;
  let capturedPrivateFiles;
  const publish = () => {
    syncDirectoryTree(staging);
    assertFence();
    const finalFiles = privateFiles(privateDir).map((file) => ({ ...file, ...digest(file.path) }));
    if (
      !capturedPrivateFiles ||
      JSON.stringify(finalFiles) !== JSON.stringify(files) ||
      finalFiles.some(
        (file, index) =>
          file.sha256 !== capturedPrivateFiles[index].sha256 ||
          file.bytes !== capturedPrivateFiles[index].bytes,
      )
    )
      fail('BACKUP_PRIVATE_CHANGED');
    assertFence();
    renameSync(staging, published);
    renamed = true;
    syncFile(outputDir);
  };
  try {
    mkdirSync(join(staging, 'private'), { mode: 0o700 });
    const dump = join(staging, 'database.dump');
    const finishStaging = (capturedSnapshot, consistency) => {
      const copied = [];
      for (const file of files) {
        assertFence();
        let sourceDigest;
        try {
          sourceDigest = digest(file.path);
        } catch {
          fail('BACKUP_PRIVATE_CHANGED');
        }
        if (sourceDigest.sha256 !== file.sha256 || sourceDigest.bytes !== file.bytes)
          fail('BACKUP_PRIVATE_CHANGED');
        const target = join(staging, 'private', file.name);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        copyFileSync(file.path, target);
        chmodSync(target, 0o600);
        try {
          sourceDigest = digest(file.path);
        } catch {
          fail('BACKUP_PRIVATE_CHANGED');
        }
        const targetDigest = digest(target);
        if (
          sourceDigest.sha256 !== file.sha256 ||
          sourceDigest.bytes !== file.bytes ||
          JSON.stringify(sourceDigest) !== JSON.stringify(targetDigest)
        ) {
          fail('BACKUP_PRIVATE_CHANGED');
        }
        copied.push({ path: file.name, ...targetDigest });
      }
      assertFence();
      const manifest = {
        schemaVersion: capturedSnapshot ? 2 : 1,
        capturedAt: new Date().toISOString(),
        consistency,
        independentPostBackupErasureLedgerRequired: true,
        ...(capturedSnapshot ? { snapshot: capturedSnapshot } : {}),
        database: digest(dump),
        privateFiles: copied,
      };
      writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      capturedPrivateFiles = copied;
    };
    if (persistentProof) {
      const connectionString = readFileSync(dbFile, 'utf8').trim();
      const sourceEnv = databaseEnv(dbFile, connectionString);
      // Ambient libpq service, hostaddr and option variables must not redirect the dump.
      const allowedPg = new Set([
        'PGHOST',
        'PGPORT',
        'PGUSER',
        'PGPASSWORD',
        'PGDATABASE',
        'PGCONNECT_TIMEOUT',
      ]);
      const persistentEnv = Object.fromEntries(
        Object.entries(sourceEnv).filter(([key]) => !key.startsWith('PG') || allowedPg.has(key)),
      );
      const { assertSyntheticPersistentTarget } = await import('./synthetic-persistent-guard.mjs');
      await assertSyntheticPersistentTarget(
        connectionString,
        persistentProof.expectedSystemIdentifier,
      );
      for (const program of ['pg_dump', 'pg_restore']) {
        const version = spawnSync(program, ['--version'], {
          encoding: 'utf8',
          timeout: 5_000,
          maxBuffer: MAX_OUTPUT_BYTES,
        });
        if (
          version.error ||
          version.status !== 0 ||
          !version.stdout.trim().startsWith(`${program} (PostgreSQL) 17.6`) ||
          !/^.* 17\.6(?:\s.*)?$/.test(version.stdout.trim())
        )
          fail('BACKUP_PERSISTENT_PG17_TOOLS_REQUIRED');
      }
      ownershipPath = join(outputDir, `.persistent-slot-${persistentProof.slotName}.json`);
      ownership = {
        schemaVersion: 1,
        syntheticOnly: true,
        restoreAccessAllowed: false,
        owner: persistentProof.owner,
        database: 'workout_pg17_proof',
        postgresSystemIdentifier: persistentProof.expectedSystemIdentifier,
        replicationSlot: persistentProof.slotName,
        publication: persistentProof.expectedPublication,
        bundleId: id,
        state: 'reserved-investigate-before-retry',
        slotCreationProven: false,
        cleanup:
          'Do not drop a slot when slotCreationProven is false. After proven creation, the exclusive owner must inspect cluster identity, exact snapshot/LSN, inactivity and absence of reuse before manual drop. Never delete this record to retry without investigation.',
      };
      syncOwnership(ownershipPath, ownership, true);
      ownsReservation = true;
      const { withPersistentExportedSlotSnapshot } = await import('./persistent-slot-snapshot.mjs');
      const expectedCompletionMarker = createHash('sha256').update(randomUUID()).digest('hex');
      const result = await withPersistentExportedSlotSnapshot({
        ...persistentProof,
        connectionString,
        expectedDatabase: ownership.database,
        expectedCompletionMarker,
        capture: async (contract) => {
          const actual = validateSnapshotContract({
            ...contract,
            publication: persistentProof.expectedPublication,
          });
          ownership = { ...ownership, slotCreationProven: true, snapshot: actual };
          syncOwnership(ownershipPath, ownership);
          assertFence();
          run(
            'pg_dump',
            ['-Fc', '--no-owner', '--no-acl', `--snapshot=${actual.snapshotName}`, '-f', dump],
            persistentEnv,
          );
          chmodSync(dump, 0o600);
          run('pg_restore', ['--list', dump]);
          run('pg_restore', ['--file=/dev/null', dump]);
          finishStaging(actual, 'caller-supplied-exported-snapshot-local-integrity-only');
          // Retention is permitted only after durable local publication and final fence.
          publish();
          return { completionMarker: expectedCompletionMarker };
        },
      });
      snapshot = validateSnapshotContract({
        ...result.snapshot,
        publication: persistentProof.expectedPublication,
      });
      ownership = { ...ownership, state: 'retained-owner-cleanup-required', snapshot };
      syncOwnership(ownershipPath, ownership);
    } else if (localProof) {
      // Keep the operational v1 collector free of the disposable proof's pg dependency.
      const { withLocalExportedSlotSnapshot } = await import('./slot-snapshot.mjs');
      const connectionString = readFileSync(dbFile, 'utf8').trim();
      const url = new URL(connectionString);
      const socketDir = url.searchParams.get('host');
      const { snapshot: exported } = await withLocalExportedSlotSnapshot({
        connectionString,
        socketDir,
        expectedDatabase: decodeURIComponent(url.pathname.slice(1)),
        expectedSystemIdentifier: localProof.expectedSystemIdentifier,
        slotName: localProof.slotName,
        disposableTest: true,
        capture: async (contract) => {
          const actual = validateSnapshotContract({
            ...contract,
            publication: localProof.publication,
          });
          const { default: pg } = await import('pg');
          const sql = new pg.Client({ connectionString });
          try {
            await sql.connect();
            const publication = await sql.query(
              'SELECT pubname FROM pg_publication WHERE pubname = $1',
              [actual.publication],
            );
            if (publication.rows.length !== 1) fail('BACKUP_LOCAL_PUBLICATION_MISSING');
          } finally {
            await sql.end();
          }
          run(
            'pg_dump',
            ['-Fc', '--no-owner', '--no-acl', `--snapshot=${actual.snapshotName}`, '-f', dump],
            env,
          );
          chmodSync(dump, 0o600);
          run('pg_restore', ['--list', dump]);
          finishStaging(actual, 'replication-slot-exported-snapshot-disposable-local-proof-only');
        },
      });
      snapshot = validateSnapshotContract({ ...exported, publication: localProof.publication });
    } else if (databaseTransport) {
      run(
        databaseTransport,
        [
          '--output',
          dump,
          '--fence-check',
          fence,
          ...(snapshot
            ? [
                '--synthetic-snapshot-v2',
                'yes',
                '--snapshot-name',
                snapshot.snapshotName,
                '--consistent-point-lsn',
                snapshot.consistentPointLsn,
                '--postgres-system-identifier',
                snapshot.postgresSystemIdentifier,
                '--replication-slot',
                snapshot.replicationSlot,
                '--publication',
                snapshot.publication,
              ]
            : []),
        ],
        env,
        30 * 60_000,
      );
      if (!existsSync(dump)) fail('BACKUP_TRANSPORT_OUTPUT_MISSING');
      assertSecureFile(dump, 0o600);
    } else {
      run(
        'pg_dump',
        [
          '-Fc',
          '--no-owner',
          '--no-acl',
          ...(snapshot ? [`--snapshot=${snapshot.snapshotName}`] : []),
          '-f',
          dump,
        ],
        env,
      );
      chmodSync(dump, 0o600);
      run('pg_restore', ['--list', dump]);
    }
    if (!localProof && !persistentProof) {
      finishStaging(
        snapshot,
        snapshot
          ? 'caller-supplied-exported-snapshot-local-integrity-only'
          : 'operator-enforced-quiesced-write-fence',
      );
    }
    if (!persistentProof) publish();
    process.stdout.write(`BACKUP_PUBLISHED ${basename(published)}\n`);
  } catch (error) {
    if (ownsReservation) {
      try {
        syncOwnership(ownershipPath, { ...ownership, state: 'failed-investigation-required' });
      } catch {
        // The durable reservation still requires investigation; never infer slot absence.
      }
    }
    rmSync(renamed ? published : staging, { recursive: true, force: true });
    syncFile(outputDir);
    throw error;
  }
}

function verify(options) {
  const bundle = resolve(options['--bundle']);
  const ledger = resolve(options['--post-backup-ledger-dir']);
  assertPrivilege(options, [bundle, ledger]);
  assertNoSymlinkParents(bundle);
  assertNoSymlinkParents(ledger);
  assertSecureDir(bundle);
  assertSecureDir(ledger);
  assertRootOwned([bundle, ledger], options);
  const manifestPath = join(bundle, 'manifest.json');
  assertSecureFile(manifestPath, 0o600);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) ||
    !(manifest.schemaVersion === 2
      ? [
          'caller-supplied-exported-snapshot-local-integrity-only',
          'replication-slot-exported-snapshot-disposable-local-proof-only',
        ].includes(manifest.consistency)
      : manifest.consistency === 'operator-enforced-quiesced-write-fence') ||
    manifest.independentPostBackupErasureLedgerRequired !== true ||
    !Number.isFinite(Date.parse(manifest.capturedAt))
  ) {
    fail('BACKUP_INVALID_MANIFEST');
  }
  if (manifest.schemaVersion === 2) {
    if (options['--synthetic-test'] !== 'yes') fail('BACKUP_SNAPSHOT_V2_INACTIVE');
    try {
      if (
        JSON.stringify(validateSnapshotContract(manifest.snapshot)) !==
        JSON.stringify(manifest.snapshot)
      ) {
        fail('BACKUP_INVALID_MANIFEST');
      }
    } catch {
      fail('BACKUP_INVALID_MANIFEST');
    }
  } else if ('snapshot' in manifest) {
    fail('BACKUP_INVALID_MANIFEST');
  }
  const dump = join(bundle, 'database.dump');
  assertSecureFile(dump, 0o600);
  if (JSON.stringify(digest(dump)) !== JSON.stringify(manifest.database))
    fail('BACKUP_DATABASE_MISMATCH');
  run('pg_restore', ['--list', dump]);
  assertSecureDir(join(bundle, 'private'));
  const actualFiles = privateFiles(join(bundle, 'private')).map(({ name }) => name);
  const expectedFiles = manifest.privateFiles.map((entry) => entry.path);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
    fail('BACKUP_PRIVATE_SET_MISMATCH');
  for (const entry of manifest.privateFiles) {
    const path = join(bundle, 'private', entry.path);
    assertSecureFile(path, 0o600);
    if (
      JSON.stringify(digest(path)) !== JSON.stringify({ sha256: entry.sha256, bytes: entry.bytes })
    ) {
      fail('BACKUP_PRIVATE_MISMATCH');
    }
  }
  // A v2 dump/manifest pair is locally checkable, but no independently proven
  // replication boundary or remote tail exists to authorize restore.
  if (manifest.schemaVersion === 2) fail('BACKUP_SNAPSHOT_V2_RESTORE_NOT_READY');
  // This is an external, independently captured replay input. Its completeness
  // cannot be inferred from a backup, so verification checks presence only.
  const ledgerManifestPath = join(ledger, 'ledger-manifest.json');
  if (!existsSync(ledgerManifestPath)) fail('BACKUP_LEDGER_REQUIRED');
  assertSecureFile(ledgerManifestPath, 0o600);
  const ledgerManifest = JSON.parse(readFileSync(ledgerManifestPath, 'utf8'));
  if (
    ledgerManifest.schemaVersion !== 1 ||
    ledgerManifest.source !== 'independent-post-backup-deletion-ledger' ||
    ledgerManifest.backupCapturedAt !== manifest.capturedAt ||
    !Number.isFinite(Date.parse(ledgerManifest.replayThrough)) ||
    Date.parse(ledgerManifest.replayThrough) < Date.parse(manifest.capturedAt) ||
    !Array.isArray(ledgerManifest.files) ||
    ledgerManifest.files.length === 0
  ) {
    fail('BACKUP_INVALID_LEDGER_MANIFEST');
  }
  const ledgerFiles = privateFiles(ledger).filter((file) => file.name !== 'ledger-manifest.json');
  if (
    JSON.stringify(ledgerFiles.map((file) => file.name)) !==
    JSON.stringify(ledgerManifest.files.map((file) => file.path))
  )
    fail('BACKUP_LEDGER_SET_MISMATCH');
  for (const entry of ledgerManifest.files) {
    const path = join(ledger, entry.path);
    assertSecureFile(path, 0o600);
    if (
      JSON.stringify(digest(path)) !== JSON.stringify({ sha256: entry.sha256, bytes: entry.bytes })
    ) {
      fail('BACKUP_LEDGER_MISMATCH');
    }
  }
  process.stdout.write('BACKUP_BYTES_VERIFIED_LEDGER_PRESENT_REPLAY_NOT_VERIFIED\n');
}

try {
  process.umask(0o077);
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'collect') await collect(options);
  else verify(options);
} catch (error) {
  const code =
    error instanceof Error && /^BACKUP_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'BACKUP_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
