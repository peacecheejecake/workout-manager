import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectPinnedPostgres,
  probeDatabase,
  readPostgresPassword,
  runNamespaceChild,
  runNamespaceParent,
} from './namespace-db-preflight.mjs';

const id = (digit) => digit.repeat(64);
const secret = 'never-display-this-postgres-password';
const config = {
  schemaVersion: 1,
  project: 'workout-manager',
  network: 'workout-manager_workout_internal',
  composeFile: '/srv/workout-manager/source/deploy/lightsail/compose.yml',
  composeSha256: id('a'),
  privateDir: '/srv/workout-manager/data/private',
  postgresDir: '/srv/workout-manager/data/postgres',
  postgresSystemIdentifier: '7534718236249421545',
  postgresVersionNum: '170006',
  containers: { app: id('a'), postgres: id('b'), graphhopper: id('c') },
};
const postgresEnvPath = '/srv/workout-manager/secrets/postgres.env';
const scriptPath = '/srv/workout-manager/backup/namespace-db-preflight.mjs';
const configPath = '/srv/workout-manager/backup/fence.json';
const nodePath = '/usr/bin/node';

function dockerInspect(overrides = {}) {
  return {
    Id: config.containers.postgres,
    Config: {
      Labels: {
        'com.docker.compose.project': config.project,
        'com.docker.compose.service': 'postgres',
        'com.docker.compose.project.config_files': config.composeFile,
      },
    },
    State: { Running: true, Status: 'running', Pid: 2456 },
    HostConfig: { NetworkMode: config.network },
    NetworkSettings: { Networks: { [config.network]: {} } },
    ...overrides,
  };
}

function mockIo(contents = `POSTGRES_DB=workout\nPOSTGRES_PASSWORD=${secret}\n`, options = {}) {
  const fileInfo = (path) => ({
    isSymbolicLink: () => path === options.symlink,
    isFile: () => path === postgresEnvPath || path === scriptPath,
    uid: options.uid ?? 0,
    mode: path === scriptPath ? (options.scriptMode ?? 0o700) : (options.mode ?? 0o600),
    size: contents.length,
  });
  return {
    existsSync: () => true,
    lstatSync: fileInfo,
    openSync: () => 7,
    fstatSync: () => fileInfo(postgresEnvPath),
    closeSync: () => {},
    readlinkSync: () => 'net:[4026532999]',
    readFileSync: () => contents,
  };
}

function commandRunner(container = dockerInspect()) {
  const calls = [];
  const runner = (program, args, options) => {
    calls.push({ program, args, options });
    if (program === '/usr/bin/docker') return { status: 0, stdout: JSON.stringify([container]) };
    if (program === '/usr/bin/nsenter') {
      return { status: 0, stdout: 'BACKUP_NAMESPACE_DB_PREFLIGHT_CHECKED\n' };
    }
    throw new Error('unexpected executable');
  };
  return { runner, calls };
}

test('uses exact pinned container ID, PID namespace, and a host-mounted child without shell or secret argv/env', () => {
  const { runner, calls } = commandRunner();
  assert.equal(
    runNamespaceParent({
      configPath,
      postgresEnvPath,
      scriptPath,
      loadConfig: () => config,
      runner,
      platform: 'linux',
      uid: 0,
      nodePath,
      io: mockIo(),
    }),
    true,
  );
  assert.deepEqual(calls[0].args, ['inspect', '--type=container', config.containers.postgres]);
  assert.deepEqual(calls[1].args, [
    '--net=/proc/2456/ns/net',
    '--',
    nodePath,
    scriptPath,
    '--child',
    configPath,
    postgresEnvPath,
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[1].options.shell, false);
  assert.deepEqual(calls[1].options.env, { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' });
  assert.equal(JSON.stringify(calls).includes(secret), false);
  assert.equal(
    calls[1].args.some((part) => part.startsWith('--mount')),
    false,
  );
});

test('child rechecks the pinned container and its own network namespace before any query', async () => {
  const { runner } = commandRunner();
  let queries = 0;
  const probe = async () => {
    queries += 1;
    return true;
  };
  assert.equal(
    await runNamespaceChild({
      configPath,
      postgresEnvPath,
      scriptPath,
      loadConfig: () => config,
      io: mockIo(),
      runner,
      probe,
      platform: 'linux',
      uid: 0,
    }),
    true,
  );
  assert.equal(queries, 1);
  const io = {
    ...mockIo(),
    readlinkSync: (path) => (path === '/proc/self/ns/net' ? 'net:[1]' : 'net:[2]'),
  };
  assert.throws(
    () =>
      runNamespaceChild({
        configPath,
        postgresEnvPath,
        scriptPath,
        loadConfig: () => config,
        io,
        runner,
        probe,
        platform: 'linux',
        uid: 0,
      }),
    /BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED/,
  );
  assert.equal(queries, 1);
});

test('rejects a replaced/stopped container, wrong network, forged PID, and Docker process errors', () => {
  for (const change of [
    { Id: id('d') },
    { State: { Running: false, Status: 'exited', Pid: 0 } },
    { State: { Running: true, Status: 'running', Pid: '2456; echo bad' } },
    { NetworkSettings: { Networks: { other: {} } } },
    { NetworkSettings: { Networks: { [config.network]: {}, other: {} } } },
    { HostConfig: { NetworkMode: 'other' } },
    { Config: { Labels: { 'com.docker.compose.project': 'other' } } },
  ]) {
    const { runner } = commandRunner(dockerInspect(change));
    assert.throws(
      () => inspectPinnedPostgres(config, runner),
      /BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED/,
    );
  }
  for (const result of [{ error: new Error(secret) }, { status: 1, stdout: secret }]) {
    assert.throws(
      () => inspectPinnedPostgres(config, () => result),
      (error) => error.message === 'BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED',
    );
  }
  assert.throws(
    () =>
      inspectPinnedPostgres(config, () => {
        throw new Error(secret);
      }),
    (error) => error.message === 'BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED',
  );
  for (const changed of [
    { containers: { ...config.containers, postgres: '$(echo malicious)' } },
    { network: 'other' },
    { postgresSystemIdentifier: '0; DROP DATABASE workout' },
  ]) {
    assert.throws(
      () => inspectPinnedPostgres({ ...config, ...changed }, commandRunner().runner),
      /BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED/,
    );
  }
});

test('does not accept a failed namespace process or untrusted child output', () => {
  for (const result of [
    { status: 1, stdout: '' },
    { status: 0, stdout: `${secret}\n` },
    { error: new Error(secret) },
  ]) {
    const runner = (program, args, options) => {
      if (program === '/usr/bin/docker')
        return { status: 0, stdout: JSON.stringify([dockerInspect()]) };
      assert.equal(program, '/usr/bin/nsenter');
      assert.equal(options.shell, false);
      assert.equal(args.includes(secret), false);
      return result;
    };
    assert.throws(
      () =>
        runNamespaceParent({
          configPath,
          postgresEnvPath,
          scriptPath,
          loadConfig: () => config,
          runner,
          platform: 'linux',
          uid: 0,
          nodePath,
          io: mockIo(),
        }),
      (error) => error.message === 'BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED',
    );
  }
});

test('requires root on Linux and root-owned 0600 password / 0700 runner without symlinks', () => {
  for (const changed of [
    { platform: 'darwin' },
    { uid: 501 },
    { io: mockIo(undefined, { uid: 501 }) },
    { io: mockIo(undefined, { mode: 0o644 }) },
    { io: mockIo(undefined, { scriptMode: 0o755 }) },
    { io: mockIo(undefined, { symlink: '/srv/workout-manager/secrets' }) },
  ]) {
    const { runner, calls } = commandRunner();
    assert.throws(
      () =>
        runNamespaceParent({
          configPath,
          postgresEnvPath,
          scriptPath,
          loadConfig: () => config,
          runner,
          platform: 'linux',
          uid: 0,
          nodePath,
          io: mockIo(),
          ...changed,
        }),
      /BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED/,
    );
    assert.equal(calls.length, 0);
  }
});

test('accepts only the fixed database and password fields; rejects custom host/port and malicious env syntax', () => {
  assert.equal(readPostgresPassword(postgresEnvPath, mockIo()), secret);
  for (const contents of [
    `POSTGRES_DB=other\nPOSTGRES_PASSWORD=${secret}\n`,
    `POSTGRES_DB=workout\nPOSTGRES_PASSWORD=${secret}\nPGHOST=other\n`,
    `POSTGRES_DB=workout\nPOSTGRES_PASSWORD=${secret}\nPGPORT=1234\n`,
    `POSTGRES_DB=workout\nPOSTGRES_PASSWORD=${secret}\nPOSTGRES_PASSWORD=duplicate\n`,
    `POSTGRES_DB=workout\nPOSTGRES_PASSWORD=${secret}\nBAD=$(touch /tmp/pwn)\n`,
    `POSTGRES_DB=workout\nPOSTGRES_PASSWORD=short\n`,
  ]) {
    assert.throws(
      () => readPostgresPassword(postgresEnvPath, mockIo(contents)),
      (error) => error.message === 'BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED',
    );
  }
  assert.throws(
    () => readPostgresPassword(postgresEnvPath, mockIo(undefined, { symlink: postgresEnvPath })),
    /BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED/,
  );
});

test('queries only localhost with a read-only statement and rejects wrong identity, WAL level, or version', async () => {
  const options = [];
  const queries = [];
  const row = {
    database: 'workout',
    system_identifier: config.postgresSystemIdentifier,
    wal_level: 'logical',
    server_version_num: config.postgresVersionNum,
  };
  class FakeClient {
    constructor(value) {
      options.push(value);
    }
    async connect() {}
    async query(statement) {
      queries.push(statement);
      return { rows: [row] };
    }
    async end() {}
  }
  assert.equal(
    await probeDatabase({
      config,
      postgresEnvPath,
      ClientClass: FakeClient,
      readPassword: () => secret,
    }),
    true,
  );
  assert.equal(options[0].host, '127.0.0.1');
  assert.equal(options[0].port, 5432);
  assert.equal(options[0].database, 'workout');
  assert.equal(options[0].password, secret);
  assert.match(queries[0], /^SELECT /);
  assert.doesNotMatch(
    queries[0],
    /INSERT|UPDATE|DELETE|CREATE|pg_create_logical_replication_slot/i,
  );
  for (const changed of [
    { database: 'other' },
    { system_identifier: '1234567890123456789' },
    { wal_level: 'replica' },
    { server_version_num: '160001' },
  ]) {
    class WrongClient extends FakeClient {
      async query() {
        return { rows: [{ ...row, ...changed }] };
      }
    }
    await assert.rejects(
      probeDatabase({
        config,
        postgresEnvPath,
        ClientClass: WrongClient,
        readPassword: () => secret,
      }),
      /BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED/,
    );
  }
  class LeakingClient extends FakeClient {
    async connect() {
      throw new Error(secret);
    }
  }
  await assert.rejects(
    probeDatabase({
      config,
      postgresEnvPath,
      ClientClass: LeakingClient,
      readPassword: () => secret,
    }),
    (error) => error.message === 'BACKUP_NAMESPACE_DB_PREFLIGHT_FAILED',
  );
});
