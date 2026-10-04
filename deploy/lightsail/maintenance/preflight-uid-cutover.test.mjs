import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertProtectedParents,
  assertTree,
  assessCutover,
  securePath,
  validatePins,
  validateWriterPin,
} from './preflight-uid-cutover.mjs';

const id = (letter) => letter.repeat(64);
const pins = {
  schemaVersion: 1,
  composeSha256: id('a'),
  writerSha256: id('b'),
  postgresContainerId: id('c'),
  oldAppImageId: id('d'),
  oldGraphhopperImageId: id('e'),
  candidateAppImageId: id('f'),
  candidateGraphhopperImageId: id('1'),
  snapshotId: 'wm-pre-recovery-20261003',
};

function fixture(changes = {}) {
  const containers = {
    [id('2')]: {
      Id: id('2'),
      Image: `sha256:${pins.oldAppImageId}`,
      State: { Running: true },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
      Config: {
        Labels: {
          'com.docker.compose.project': 'workout-manager',
          'com.docker.compose.service': 'app',
        },
      },
    },
    [id('3')]: {
      Id: id('3'),
      Image: `sha256:${pins.oldGraphhopperImageId}`,
      State: { Running: true },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
      Config: {
        Labels: {
          'com.docker.compose.project': 'workout-manager',
          'com.docker.compose.service': 'graphhopper',
        },
      },
    },
    [pins.postgresContainerId]: {
      Id: pins.postgresContainerId,
      State: { Running: true, Health: { Status: 'healthy' } },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
      Config: {
        Labels: {
          'com.docker.compose.project': 'workout-manager',
          'com.docker.compose.service': 'postgres',
        },
      },
    },
  };
  if (changes.container) Object.assign(containers[changes.container.id], changes.container.value);
  const calls = [];
  const runner = (program, args) => {
    calls.push([program, args]);
    if (program.endsWith('getent'))
      return { status: changes.claimedUid ? 0 : 2, stdout: changes.claimedUid ? 'taken' : '' };
    if (program.endsWith('systemctl'))
      return args[0] === 'is-active'
        ? {
            status: changes.activeTimer ? 0 : 3,
            stdout: changes.activeTimer ? 'active' : 'inactive',
          }
        : {
            status: changes.maskedTimer ? 0 : 1,
            stdout: changes.maskedTimer ? 'masked' : 'disabled',
          };
    if (program.endsWith('flock')) return { status: changes.lockBusy ? 75 : 0, stdout: '' };
    if (args.includes('ps')) return { status: 0, stdout: Object.keys(containers).join('\n') };
    if (args.includes('inspect') && args.includes('image')) {
      const imageId = args.at(-1);
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Id: `sha256:${imageId}`,
            Config: {
              User: changes.wrongImageUser
                ? '1000:1000'
                : imageId === pins.candidateAppImageId
                  ? 'workout:workout'
                  : 'graphhopper:graphhopper',
            },
          },
        ]),
      };
    }
    if (args.includes('inspect'))
      return { status: 0, stdout: JSON.stringify([containers[args.at(-1)]]) };
    if (args.includes('exec')) return { status: 0, stdout: changes.wal || 'replica\n' };
    return { status: 1, stdout: '' };
  };
  const files = {
    hash: (path) =>
      path.endsWith('compose.yml')
        ? changes.changedCompose
          ? id('0')
          : pins.composeSha256
        : pins.writerSha256,
    assertTree: (path, owner) => {
      if (changes.badTree && owner === 1000) throw Error('bad tree');
    },
    assertProtectedParents: () => {
      if (changes.unsafeParent) throw Error('unsafe parent');
    },
    readWriterPin: () => ({
      schemaVersion: 1,
      composeSha256: changes.staleWriterPin ? id('0') : pins.composeSha256,
    }),
  };
  return { runner, files, mountpoints: [], calls };
}

test('accepts only complete immutable pin schema', () => {
  assert.equal(validatePins(pins), pins);
  for (const altered of [
    { ...pins, postgresContainerId: 'short' },
    { ...pins, extra: true },
    { ...pins, candidateAppImageId: pins.oldAppImageId },
  ]) {
    assert.throws(() => validatePins(altered), /UID_CUTOVER_PREFLIGHT_FAILED/);
  }
});

test('read-only preflight checks identities, ownership, timers, WAL and candidate users', () => {
  const fixtureValue = fixture();
  assert.equal(assessCutover(pins, fixtureValue).status, 'local_checks_passed');
  assert.deepEqual(
    new Set(
      fixtureValue.calls
        .filter(([program]) => program.endsWith('getent'))
        .map(([, args]) => args[1]),
    ),
    new Set(['20001', '20002']),
  );
  assert.equal(fixtureValue.calls.filter(([, args]) => args.includes('exec')).length, 1);
  assert.equal(assessCutover(pins, fixture({ maskedTimer: true })).status, 'local_checks_passed');
});

test('fails closed on competing UID, timer, image user, WAL, changed PostgreSQL or tree', () => {
  for (const change of [
    { changedCompose: true },
    { staleWriterPin: true },
    { unsafeParent: true },
    { claimedUid: true },
    { activeTimer: true },
    { lockBusy: true },
    { wrongImageUser: true },
    { wal: 'logical\n' },
    {
      container: {
        id: pins.postgresContainerId,
        value: { HostConfig: { RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } } },
      },
    },
    {
      container: {
        id: id('2'),
        value: { HostConfig: { RestartPolicy: { Name: 'always', MaximumRetryCount: 0 } } },
      },
    },
    { badTree: true },
    { container: { id: pins.postgresContainerId, value: { Id: id('9') } } },
  ]) {
    assert.throws(() => assessCutover(pins, fixture(change)));
  }
});

test('writer pin must have the writer schema and candidate Compose hash', () => {
  assert.equal(
    validateWriterPin({ schemaVersion: 1, composeSha256: pins.composeSha256 }, pins.composeSha256),
    true,
  );
  for (const value of [
    { schemaVersion: 1, composeSha256: id('0') },
    { schemaVersion: 1, composeSha256: pins.composeSha256, extra: true },
  ]) {
    assert.throws(() => validateWriterPin(value, pins.composeSha256));
  }
});

test('data ancestors cannot be renamed or recreated by UID 1000', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'uid-cutover-parent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data, { mode: 0o755 });
  chmodSync(root, 0o755);
  chmodSync(data, 0o755);
  assert.doesNotThrow(() =>
    assertProtectedParents(join(data, 'private'), root, process.getuid(), process.getgid()),
  );
  assert.throws(() =>
    assertProtectedParents(join(data, 'private'), root, process.getuid() + 1, process.getgid()),
  );
  chmodSync(data, 0o775);
  assert.throws(() =>
    assertProtectedParents(join(data, 'private'), root, process.getuid(), process.getgid()),
  );
});

const lockPaths = [
  '/run/lock/workout-manager/backup.lock',
  '/run/lock/workout-manager/maintenance.lock',
];

function lockFilesystem(changes = {}) {
  const entries = {
    '/': { uid: 0, gid: 0, mode: 0o755, kind: 'directory' },
    '/run': { uid: 0, gid: 0, mode: 0o755, kind: 'directory' },
    '/run/lock': { uid: 0, gid: 0, mode: 0o1777, kind: 'directory' },
    '/run/lock/workout-manager': { uid: 0, gid: 0, mode: 0o700, kind: 'directory' },
    ...Object.fromEntries(
      lockPaths.map((path) => [path, { uid: 0, gid: 0, mode: 0o600, kind: 'file' }]),
    ),
  };
  for (const [path, change] of Object.entries(changes)) {
    entries[path] = { ...entries[path], ...change };
  }
  return {
    lstatSync(path) {
      const entry = entries[path];
      if (!entry) throw Error(`Missing fixture entry: ${path}`);
      return {
        ...entry,
        isSymbolicLink: () => entry.kind === 'symlink',
        isDirectory: () => entry.kind === 'directory',
        isFile: () => entry.kind === 'file',
      };
    },
    realpathSync: (path) => path,
  };
}

test('only the two fixed locks accept a root-owned sticky /run/lock ancestor', () => {
  const filesystem = lockFilesystem();
  for (const path of lockPaths) {
    assert.doesNotThrow(() => securePath(path, 0o600, 'file', filesystem));
  }
  assert.throws(() =>
    securePath('/run/lock/workout-manager/other.lock', 0o600, 'file', {
      ...filesystem,
      lstatSync(path) {
        return filesystem.lstatSync(
          path === '/run/lock/workout-manager/other.lock' ? lockPaths[0] : path,
        );
      },
    }),
  );
});

test('lock path rejects wrong owner, mode, symlink, and other writable ancestors', () => {
  const backup = lockPaths[0];
  for (const [path, change] of [
    ['/run/lock', { uid: 1000 }],
    ['/run/lock', { gid: 1000 }],
    ['/run/lock', { mode: 0o777 }],
    ['/run/lock', { mode: 0o3777 }],
    ['/run/lock', { kind: 'symlink' }],
    ['/run/lock/workout-manager', { uid: 1000 }],
    ['/run/lock/workout-manager', { gid: 1000 }],
    ['/run/lock/workout-manager', { mode: 0o770 }],
    ['/run/lock/workout-manager', { kind: 'symlink' }],
    [backup, { uid: 1000 }],
    [backup, { gid: 1000 }],
    [backup, { mode: 0o660 }],
    [backup, { mode: 0o1600 }],
    [backup, { kind: 'symlink' }],
    ['/run', { kind: 'symlink' }],
    ['/run', { mode: 0o775 }],
  ]) {
    assert.throws(() => securePath(backup, 0o600, 'file', lockFilesystem({ [path]: change })));
  }
  assert.throws(() =>
    securePath(backup, 0o600, 'file', {
      ...lockFilesystem(),
      realpathSync: () => '/somewhere-else/backup.lock',
    }),
  );
});

test('tree walk rejects symlinks, nested mounts and excess entries without following them', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'uid-cutover-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'file'), 'safe');
  const uid = process.getuid();
  const gid = process.getgid();
  assert.equal(assertTree(root, uid, [], 10, gid), 3);
  assert.throws(() => assertTree(root, uid, [join(root, 'nested')], 10, gid));
  assert.throws(() => assertTree(root, uid, [], 2, gid));
  symlinkSync('/etc/passwd', join(root, 'nested', 'link'));
  assert.throws(() => assertTree(root, uid, [], 10, gid));
});
