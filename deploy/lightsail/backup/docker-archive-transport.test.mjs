import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureArchive } from './docker-archive-transport.mjs';

const containerId = 'b'.repeat(64);
const config = {
  schemaVersion: 1,
  project: 'workout-manager',
  network: 'workout-manager_workout_internal',
  composeFile: '/srv/workout-manager/source/deploy/lightsail/compose.yml',
  composeSha256: 'a'.repeat(64),
  privateDir: '/srv/workout-manager/data/private',
  postgresDir: '/srv/workout-manager/data/postgres',
  postgresSystemIdentifier: '7534718236249421545',
  postgresVersionNum: '170006',
  containers: { app: 'a'.repeat(64), postgres: containerId, graphhopper: 'c'.repeat(64) },
};
const complete = Buffer.from('PGDMPsynthetic archive body and table data');

function runnerFor(state) {
  return (program, args, options) => {
    if (program === '/root/check-fence') {
      state.fenceCalls += 1;
      return { status: state.failFenceAt === state.fenceCalls ? 1 : 0 };
    }
    if (program !== 'docker' || args[0] !== 'exec') {
      throw new Error('Unexpected transport command');
    }
    if (!args.includes(containerId)) return { status: 1 };
    assert.equal(args.includes('postgres'), true);
    if (args.includes('pg_dump')) {
      assert.equal(args.includes('--dbname=workout'), true);
      writeSync(options.stdio[1], state.archive);
      return { status: state.dumpStatus };
    }
    if (args.includes('pg_restore')) {
      const bytes = readFileSync(options.stdio[0]);
      state.restoreChecks.push(args.at(-1));
      return { status: bytes.equals(complete) ? 0 : 1 };
    }
    throw new Error('Unexpected Docker command');
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wm-archive-transport-'));
  const output = join(dir, 'database.dump');
  const state = {
    archive: complete,
    dumpStatus: 0,
    failFenceAt: 0,
    fenceCalls: 0,
    restoreChecks: [],
  };
  return { dir, output, state };
}

function run(fixtureState, replacementConfig = config) {
  return captureArchive({
    output: fixtureState.output,
    fenceCheck: '/root/check-fence',
    config: replacementConfig,
    runner: runnerFor(fixtureState.state),
  });
}

test('streams and validates the complete archive through the pinned container', () => {
  const current = fixture();
  try {
    const result = run(current);
    assert.deepEqual(result, {
      sha256: createHash('sha256').update(complete).digest('hex'),
      bytes: complete.length,
    });
    assert.deepEqual(readFileSync(current.output), complete);
    assert.deepEqual(current.state.restoreChecks, ['--list', '--file=/dev/null']);
    assert.equal(current.state.fenceCalls, 3);
    assert.equal(existsSync(`${current.output}.partial`), false);
  } finally {
    rmSync(current.dir, { recursive: true, force: true });
  }
});

test('rejects a partial successful transfer and deletes its partial archive', () => {
  const current = fixture();
  try {
    current.state.archive = Buffer.from('PGDMPshort');
    assert.throws(() => run(current), /BACKUP_TRANSPORT_FAILED/);
    assert.equal(existsSync(current.output), false);
    assert.equal(existsSync(`${current.output}.partial`), false);
  } finally {
    rmSync(current.dir, { recursive: true, force: true });
  }
});

test('rejects Docker failure and fence loss without publishing', () => {
  const docker = fixture();
  try {
    docker.state.dumpStatus = 1;
    assert.throws(() => run(docker), /BACKUP_TRANSPORT_FAILED/);
    assert.equal(existsSync(docker.output), false);
    assert.equal(existsSync(`${docker.output}.partial`), false);
  } finally {
    rmSync(docker.dir, { recursive: true, force: true });
  }

  const fence = fixture();
  try {
    fence.state.failFenceAt = 3;
    assert.throws(() => run(fence), /BACKUP_TRANSPORT_FAILED/);
    assert.equal(existsSync(fence.output), false);
    assert.equal(existsSync(`${fence.output}.partial`), false);
  } finally {
    rmSync(fence.dir, { recursive: true, force: true });
  }
});

test('rejects wrong project, stale container pin, and existing output', () => {
  const wrong = fixture();
  try {
    assert.throws(() => run(wrong, { ...config, project: 'infra' }), /BACKUP_FENCE_FAILED/);
    assert.throws(
      () =>
        run(wrong, {
          ...config,
          containers: { ...config.containers, postgres: 'd'.repeat(64) },
        }),
      /BACKUP_TRANSPORT_FAILED/,
    );
    assert.equal(wrong.state.fenceCalls, 1);
    assert.equal(existsSync(wrong.output), false);
    assert.equal(existsSync(`${wrong.output}.partial`), false);
    const result = run(wrong);
    assert.equal(result.bytes, complete.length);
    assert.throws(() => run(wrong), /BACKUP_TRANSPORT_FAILED/);
  } finally {
    rmSync(wrong.dir, { recursive: true, force: true });
  }
});
