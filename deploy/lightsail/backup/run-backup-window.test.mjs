import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./run-backup-window.sh', import.meta.url)),
  'utf8',
);
const NODE = '/srv/workout-manager/backup-runtime/20261001-9babcea-node24/node';
const FENCE = '/srv/workout-manager/admin/backup/fence.json';

function fixture() {
  const release = mkdtempSync(join(realpathSync(tmpdir()), 'backup-launch-'));
  const id = join(release, 'id');
  const stat = join(release, 'stat');
  const launcher = join(release, 'run-backup-window.sh');
  const wrapper = join(release, 'backup-window.mjs');
  writeFileSync(id, '#!/bin/sh\nprintf "0\\n"\n');
  writeFileSync(stat, '#!/bin/sh\nprintf "0:700\\n"\n');
  chmodSync(id, 0o700);
  chmodSync(stat, 0o700);
  writeFileSync(
    launcher,
    source
      .replaceAll('/usr/bin/id', id)
      .replaceAll('/usr/bin/stat', stat)
      .replaceAll(NODE, realpathSync(process.execPath)),
  );
  writeFileSync(
    wrapper,
    'process.stdout.write(JSON.stringify({argv: process.argv, env: process.env}))',
  );
  chmodSync(launcher, 0o700);
  chmodSync(wrapper, 0o700);
  return { release, launcher, wrapper };
}

function launch(path, args = []) {
  return spawnSync('/bin/sh', [path, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/tmp/hostile',
      NODE_OPTIONS: '--require=/tmp/hostile.cjs',
      DOCKER_HOST: 'tcp://untrusted:2375',
      AWS_PROFILE: 'untrusted',
      WORKOUT_BACKUP_FENCE_CONFIG: '/tmp/untrusted.json',
    },
  });
}

test('launcher has fixed Node and fence paths and forwards only the adjacent wrapper', () => {
  assert.match(source, /^\[ "\$#" -eq 0 \] \|\| fail$/m);
  assert.match(source, /\[ "\$\(\/usr\/bin\/id -u\)" -eq 0 \] \|\| fail/);
  assert.match(source, /exec \/usr\/bin\/env -i \\/);
  assert.ok(source.includes(NODE));
  assert.ok(
    source.includes(
      'PATH=/srv/workout-manager/backup-runtime/20261001-9babcea-node24:/usr/bin:/bin',
    ),
  );
  assert.ok(source.includes(`WORKOUT_BACKUP_FENCE_CONFIG=${FENCE}`));
  assert.ok(source.includes('"$release/backup-window.mjs"'));
  const { release, launcher, wrapper } = fixture();
  try {
    const result = launch(launcher);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.argv[1], wrapper);
    // macOS injects this Cocoa key after exec; it is absent from the launcher env list.
    delete payload.env.__CF_USER_TEXT_ENCODING;
    assert.deepEqual(payload.env, {
      PATH: '/srv/workout-manager/backup-runtime/20261001-9babcea-node24:/usr/bin:/bin',
      HOME: '/root',
      LANG: 'C.UTF-8',
      TMPDIR: '/tmp',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      WORKOUT_BACKUP_FENCE_CONFIG: FENCE,
    });
    assert.equal(launch(launcher, ['--locks-held']).status, 1);
  } finally {
    rmSync(release, { recursive: true, force: true });
  }
});

test('launcher refuses symlinked entry and parent paths', () => {
  const { release, launcher, wrapper } = fixture();
  const entryAlias = `${launcher}.alias`;
  const parentAlias = `${release}.alias`;
  try {
    symlinkSync(launcher, entryAlias);
    symlinkSync(release, parentAlias);
    assert.equal(launch(entryAlias).status, 1);
    assert.equal(launch(join(parentAlias, 'run-backup-window.sh')).status, 1);
    rmSync(wrapper);
    symlinkSync(join(release, 'elsewhere.mjs'), wrapper);
    assert.equal(launch(launcher).status, 1);
  } finally {
    unlinkSync(entryAlias);
    unlinkSync(parentAlias);
    rmSync(release, { recursive: true, force: true });
  }
});
