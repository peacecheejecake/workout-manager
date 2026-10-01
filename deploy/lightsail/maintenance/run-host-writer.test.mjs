import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnvironment, commandFor, runWriter } from './run-host-writer.mjs';

function fixture(t, script = '#!/bin/sh\nexit 0\n') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'workout-host-writer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(join(source, 'deploy/lightsail'), { recursive: true });
  const compose = 'name: workout-manager\n';
  writeFileSync(join(source, 'deploy/lightsail/compose.yml'), compose);
  const envFile = join(root, 'compose.env');
  writeFileSync(envFile, 'SECRET=never-print-this\n', { mode: 0o600 });
  const configFile = join(root, 'host-writer.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      schemaVersion: 1,
      composeSha256: createHash('sha256').update(compose).digest('hex'),
    }),
    { mode: 0o600 },
  );
  const dockerProgram = join(root, 'fake-docker');
  writeFileSync(dockerProgram, script, { mode: 0o700 });
  chmodSync(dockerProgram, 0o700);
  const flock = join(root, 'flock');
  writeFileSync(
    flock,
    `#!/usr/bin/env python3
import fcntl, os, sys
args = sys.argv[1:]
nonblock = False
conflict = 1
while args[0].startswith('--'):
    option = args.pop(0)
    if option == '--nonblock': nonblock = True
    elif option == '--no-fork': pass
    elif option == '--conflict-exit-code': conflict = int(args.pop(0))
    else: sys.exit(2)
fd = os.open(args.pop(0), os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblock else 0))
except BlockingIOError:
    sys.exit(conflict)
os.set_inheritable(fd, True)
os.execvpe(args[0], args, os.environ)
`,
    { mode: 0o700 },
  );
  chmodSync(flock, 0o700);
  return {
    root,
    source,
    envFile,
    configFile,
    dockerProgram,
    lockDirectory: join(root, 'locks'),
    uid: process.getuid(),
    program: flock,
  };
}

function waitForLine(stream, line) {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('synthetic lock holder did not start within five seconds'));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    const onData = (chunk) => {
      data += chunk;
      if (data.includes(line)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

test('accepts only fixed Workout writer categories', () => {
  const cases = [
    ['build'],
    ['up', 'postgres'],
    ['up', 'app'],
    ['start', 'graphhopper'],
    ['setup'],
    ['exec', 'postgres-ready'],
  ];
  for (const args of cases) assert.equal(commandFor(args)[0], '/usr/bin/docker');
  assert.deepEqual(commandFor(['setup'])[1].slice(-6), [
    'run',
    '--rm',
    '--no-deps',
    '--name',
    'wm-db-setup-one-shot',
    'db_setup',
  ]);
  for (const args of [
    ['down'],
    ['up', 'infra'],
    ['maintenance', 'db_setup'],
    ['maintenance', 'resource_cleanup'],
    ['maintenance', 'url_ingestion'],
    ['exec', 'postgres', 'sh'],
    ['start', 'wm-postgres'],
    ['build', '--no-cache'],
    [],
  ])
    assert.throws(() => commandFor(args), /WORKOUT_HOST_WRITER_FAILED/);
});

test('fails closed on missing config and preserves child failure', async (t) => {
  const options = fixture(t, '#!/bin/sh\nexit 42\n');
  assert.equal(await runWriter(['setup'], options), 42);
  rmSync(options.envFile);
  await assert.rejects(runWriter(['setup'], options));
});

test('rejects changed Compose bytes or a missing root-only pin', async (t) => {
  const options = fixture(t);
  assert.equal(await runWriter(['build'], options), 0);
  writeFileSync(join(options.source, 'deploy/lightsail/compose.yml'), 'name: other\n');
  await assert.rejects(runWriter(['build'], options));
  rmSync(options.configFile);
  await assert.rejects(runWriter(['build'], options));
});

test('drops inherited Docker and Compose overrides and pins the target', async (t) => {
  const marker = join(realpathSync(tmpdir()), `workout-writer-env-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(marker, { force: true }));
  const options = fixture(
    t,
    `#!/bin/sh\nprintf '%s|%s|%s|%s' "\${DOCKER_HOST-unset}" "\${DOCKER_CONTEXT-unset}" "\${COMPOSE_PROJECT_NAME-unset}" "$*" > '${marker}'\n`,
  );
  const overrides = {
    DOCKER_HOST: 'tcp://wrong-daemon:2375',
    DOCKER_CONTEXT: 'wrong-context',
    COMPOSE_PROJECT_NAME: 'other-project',
    COMPOSE_FILE: '/tmp/other-compose.yml',
    WORKOUT_RELEASE: 'wrong-release',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    assert.equal(await runWriter(['up', 'app'], options), 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
  const output = readFileSync(marker, 'utf8');
  assert.match(
    output,
    /^unset\|unset\|unset\|--host unix:\/\/\/var\/run\/docker\.sock compose --project-name workout-manager /,
  );
  for (const key of Object.keys(overrides)) assert.equal(childEnvironment()[key], undefined);
});

test('backup-window lock blocks writer, and writer blocks backup-window lock', async (t) => {
  const options = fixture(t, '#!/bin/sh\nprintf "RUNNING\\n" >&2\nsleep 30\n');
  // Create the root-only lock files through the first bounded invocation.
  assert.equal(await runWriter(['build'], { ...options, dockerProgram: '/usr/bin/true' }), 0);
  const backup = join(options.lockDirectory, 'backup.lock');
  const holder = spawn(options.program, ['--no-fork', backup, 'sh', '-c', 'echo HELD; sleep 30'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
    env: process.env,
  });
  await waitForLine(holder.stdout, 'HELD');
  assert.equal(await runWriter(['setup'], options), 75);
  process.kill(-holder.pid, 'SIGTERM');
  await new Promise((resolve) => holder.once('exit', resolve));

  let childPid;
  const running = runWriter(['setup'], {
    ...options,
    onSpawn(child) {
      childPid = child.pid;
    },
  });
  // Give flock time to acquire, then prove the backup entry cannot acquire it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const contender = spawn(options.program, [
    '--nonblock',
    '--conflict-exit-code',
    '75',
    backup,
    '/usr/bin/true',
  ]);
  assert.equal(await new Promise((resolve) => contender.once('exit', resolve)), 75);
  // The child group is stopped; the lock must become available again.
  process.kill(-childPid, 'SIGTERM');
  const status = await running;
  assert.equal(status, 143);
  const after = spawn(options.program, ['--nonblock', backup, '/usr/bin/true']);
  assert.equal(await new Promise((resolve) => after.once('exit', resolve)), 0);
});

test('concurrent invocation fails and signal is forwarded through lock holders', async (t) => {
  const marker = join(tmpdir(), `workout-writer-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(marker, { force: true }));
  const options = fixture(t, `#!/bin/sh\nprintf 'STARTED' > '${marker}'\nsleep 30\n`);
  let childPid;
  const first = runWriter(['up', 'app'], {
    ...options,
    onSpawn(child) {
      childPid = child.pid;
    },
  });
  await waitForMarker(marker);
  assert.equal(await runWriter(['up', 'app'], options), 75);
  process.kill(-childPid, 'SIGTERM');
  assert.equal(await first, 143);
  assert.equal(await runWriter(['build'], { ...options, dockerProgram: '/usr/bin/true' }), 0);
});

test('TERM to the wrapper forwards to the child and releases both locks', async (t) => {
  const marker = join(realpathSync(tmpdir()), `workout-wrapper-term-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(marker, { force: true }));
  const options = fixture(t, `#!/bin/sh\nprintf 'STARTED' > '${marker}'\nsleep 30\n`);
  const modulePath = fileURLToPath(new URL('./run-host-writer.mjs', import.meta.url));
  const harness = join(options.root, 'wrapper-harness.mjs');
  writeFileSync(
    harness,
    `import { runWriter } from ${JSON.stringify(`file://${modulePath}`)};\nprocess.exitCode = await runWriter(['setup'], JSON.parse(process.env.TEST_OPTIONS));\n`,
  );
  const wrapper = spawn(process.execPath, [harness], {
    env: { ...process.env, TEST_OPTIONS: JSON.stringify(options) },
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      wrapper.kill('SIGKILL');
    } catch {
      // The harness already exited.
    }
  });
  await waitForMarker(marker);
  wrapper.kill('SIGTERM');
  assert.equal(await new Promise((resolve) => wrapper.once('exit', resolve)), 143);
  assert.equal(await runWriter(['build'], { ...options, dockerProgram: '/usr/bin/true' }), 0);
});

function readFileExists(path) {
  try {
    return readFileSync(path, 'utf8') === 'STARTED';
  } catch {
    return false;
  }
}

async function waitForMarker(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (readFileExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('synthetic child did not start within five seconds');
}
