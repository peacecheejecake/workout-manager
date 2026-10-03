import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertTree, assessCutover, validatePins } from './preflight-uid-cutover.mjs';

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
    { claimedUid: true },
    { activeTimer: true },
    { lockBusy: true },
    { wrongImageUser: true },
    { wal: 'logical\n' },
    { badTree: true },
    { container: { id: pins.postgresContainerId, value: { Id: id('9') } } },
  ]) {
    assert.throws(() => assessCutover(pins, fixture(change)));
  }
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
