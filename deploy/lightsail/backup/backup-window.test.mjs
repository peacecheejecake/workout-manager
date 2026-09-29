import assert from 'node:assert/strict';
import test from 'node:test';
import { runWindow } from './backup-window.mjs';

const id = (digit) => digit.repeat(64);
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
  containers: { app: id('a'), postgres: id('b'), graphhopper: id('c') },
};
const paths = {
  fence: '/root/backup/check-fence.mjs',
  collector: '/root/backup/collect.mjs',
  transport: '/root/backup/docker-archive-transport.mjs',
  outputDir: '/srv/workout-manager/backups',
};

function serviceForId(containerId) {
  return Object.entries(config.containers).find(([, value]) => value === containerId)?.[0];
}

function fixture() {
  return {
    running: { app: true, graphhopper: true, postgres: true },
    project: 'workout-manager',
    timerActive: false,
    lockStatus: 75,
    failStop: undefined,
    failStart: undefined,
    failFence: false,
    failCollector: false,
    failInspect: false,
    actions: [],
  };
}

function container(state, service) {
  const mounts =
    service === 'app'
      ? [{ Type: 'bind', Source: config.privateDir, Destination: '/var/lib/workout/private' }]
      : service === 'postgres'
        ? [{ Type: 'bind', Source: config.postgresDir, Destination: '/var/lib/postgresql/data' }]
        : [];
  return {
    Id: config.containers[service],
    Config: {
      Labels: {
        'com.docker.compose.project': state.project,
        'com.docker.compose.service': service,
        'com.docker.compose.project.config_files': config.composeFile,
      },
    },
    Mounts: mounts,
    NetworkSettings: { Networks: { [config.network]: {} } },
    State: {
      Running: state.running[service],
      Health: service === 'postgres' ? { Status: 'healthy' } : undefined,
    },
  };
}

function runnerFor(state) {
  return (program, args) => {
    if (program === 'flock') return { status: state.lockStatus, stdout: '' };
    if (program === 'systemctl') {
      return {
        status: 0,
        stdout: state.timerActive
          ? 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n'
          : 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n',
      };
    }
    if (program === 'docker' && args[0] === 'inspect') {
      if (state.failInspect) return { status: 1, stdout: '' };
      const service = serviceForId(args[1]);
      if (!service) return { status: 1, stdout: '' };
      return { status: 0, stdout: JSON.stringify([container(state, service)]) };
    }
    if (program === 'docker' && args[0] === 'stop') {
      const service = serviceForId(args.at(-1));
      state.actions.push(`stop:${service}`);
      state.running[service] = false;
      return { status: state.failStop === service ? 1 : 0, stdout: '' };
    }
    if (program === 'docker' && args[0] === 'start') {
      const service = serviceForId(args[1]);
      state.actions.push(`start:${service}`);
      if (state.failStart === service) return { status: 1, stdout: '' };
      state.running[service] = true;
      return { status: 0, stdout: '' };
    }
    if (program === paths.fence) {
      state.actions.push('fence');
      return { status: state.failFence ? 1 : 0, stdout: '' };
    }
    if (args[0] === paths.collector && args[1] === 'collect') {
      state.actions.push('collector');
      return { status: state.failCollector ? 1 : 0, stdout: '' };
    }
    throw new Error(`Unexpected command ${program} ${args.join(' ')}`);
  };
}

function execute(state, chosenConfig = config) {
  return runWindow({ config: chosenConfig, paths, run: runnerFor(state) });
}

test('stops only pinned Workout services, collects, and restores in network-safe order', () => {
  const state = fixture();
  assert.equal(execute(state), true);
  assert.deepEqual(state.actions, [
    'stop:graphhopper',
    'stop:app',
    'fence',
    'collector',
    'fence',
    'start:app',
    'start:graphhopper',
  ]);
  assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
});

test('leaves initially stopped services stopped', () => {
  const state = fixture();
  state.running.app = false;
  state.running.graphhopper = false;
  assert.equal(execute(state), true);
  assert.deepEqual(state.actions, ['fence', 'collector', 'fence']);
  assert.deepEqual(state.running, { app: false, graphhopper: false, postgres: true });
});

test('refuses free locks, active timers, and wrong project before touching services', () => {
  for (const mutate of [
    (state) => (state.lockStatus = 0),
    (state) => (state.timerActive = true),
    (state) => (state.project = 'infra'),
    (state) => (state.failInspect = true),
  ]) {
    const state = fixture();
    mutate(state);
    assert.throws(() => execute(state));
    assert.deepEqual(state.actions, []);
  }
});

test('restores a service that stopped despite a failed Docker stop command', () => {
  const state = fixture();
  state.failStop = 'graphhopper';
  assert.throws(() => execute(state));
  assert.deepEqual(state.actions, ['stop:graphhopper', 'start:graphhopper']);
  assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
});

test('restores both stopped services after checker or collector failure', () => {
  for (const fail of ['failFence', 'failCollector']) {
    const state = fixture();
    state[fail] = true;
    assert.throws(() => execute(state));
    assert.deepEqual(state.actions.slice(-2), ['start:app', 'start:graphhopper']);
    assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
  }
});

test('reports a restore failure without starting unrelated containers', () => {
  const state = fixture();
  state.failStart = 'graphhopper';
  assert.throws(() => execute(state));
  assert.deepEqual(state.actions.slice(-2), ['start:app', 'start:graphhopper']);
  assert.deepEqual(state.running, { app: true, graphhopper: false, postgres: true });
});

test('rejects an unpinned output destination and inconsistent initial app state', () => {
  const state = fixture();
  assert.throws(() =>
    runWindow({ config, paths: { ...paths, outputDir: '/srv/infra' }, run: runnerFor(state) }),
  );
  assert.deepEqual(state.actions, []);

  const inconsistent = fixture();
  inconsistent.running.app = false;
  assert.throws(() => execute(inconsistent));
  assert.deepEqual(inconsistent.actions, []);
});
