import assert from 'node:assert/strict';
import test from 'node:test';
import { assessFence } from './check-fence.mjs';

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

function container(service, options = {}) {
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
        'com.docker.compose.project': config.project,
        'com.docker.compose.service': service,
        'com.docker.compose.project.config_files': config.composeFile,
      },
    },
    Mounts: mounts,
    NetworkSettings: {
      Networks: service === 'graphhopper' ? {} : { [config.network]: {} },
    },
    State: {
      Running: service === 'postgres',
      Health: service === 'postgres' ? { Status: 'healthy' } : undefined,
    },
    ...options,
  };
}

function fixture() {
  return {
    config: structuredClone(config),
    containers: [container('app'), container('postgres'), container('graphhopper')],
    timerOutput: 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n',
    databaseOutput: `workout\t${config.postgresSystemIdentifier}\t170006\t0\n`,
    dockerFailure: false,
    databaseCommandFailure: false,
    lockStatus: 75,
  };
}

function runnerFor(state) {
  return (program, args) => {
    if (program === 'systemctl') return { status: 0, stdout: state.timerOutput };
    if (program === 'flock') return { status: state.lockStatus, stdout: '' };
    if (program === 'docker' && args[0] === 'ps') {
      if (state.dockerFailure) return { status: 1, stdout: '' };
      return { status: 0, stdout: `${state.containers.map((item) => item.Id).join('\n')}\n` };
    }
    if (program === 'docker' && args[0] === 'inspect') {
      return { status: 0, stdout: JSON.stringify(state.containers) };
    }
    if (program === 'docker' && args[0] === 'exec') {
      if (state.databaseCommandFailure) return { status: 1, stdout: '' };
      return { status: 0, stdout: state.databaseOutput };
    }
    throw new Error(`Unexpected command ${program} ${args.join(' ')}`);
  };
}

function rejected(state) {
  assert.throws(() => assessFence(state.config, runnerFor(state)), /BACKUP_FENCE_FAILED/);
}

test('accepts only a pinned, quiesced Workout project', () => {
  const state = fixture();
  assert.equal(assessFence(state.config, runnerFor(state)), true);
});

test('rejects a writer restart and an untracked Workout writer', () => {
  const restarted = fixture();
  restarted.containers[0].State.Running = true;
  rejected(restarted);

  const extra = fixture();
  extra.containers.push({
    ...container('app'),
    Id: id('d'),
    Config: {
      Labels: {
        'com.docker.compose.project': config.project,
        'com.docker.compose.service': 'resource_cleanup',
        'com.docker.compose.project.config_files': config.composeFile,
      },
    },
    State: { Running: true },
  });
  rejected(extra);
});

test('rejects a wrong project, Compose source, mount, and database identity', () => {
  const project = fixture();
  project.containers[0].Config.Labels['com.docker.compose.project'] = 'infra';
  rejected(project);

  const source = fixture();
  source.containers[0].Config.Labels['com.docker.compose.project.config_files'] = '/tmp/other.yml';
  rejected(source);

  const mount = fixture();
  mount.containers[0].Mounts[0].Source = '/srv/infra/private';
  rejected(mount);

  const expectedPath = fixture();
  expectedPath.config.privateDir = '/srv/infra/private';
  rejected(expectedPath);

  const database = fixture();
  database.databaseOutput = 'workout\t1234567890123456789\t170006\t0\n';
  rejected(database);

  const replacedContainer = fixture();
  replacedContainer.config.containers.postgres = id('d');
  rejected(replacedContainer);
});

test('rejects active database sessions, active timers, free locks, and Docker failures', () => {
  const session = fixture();
  session.databaseOutput = `workout\t${config.postgresSystemIdentifier}\t170006\t1\n`;
  rejected(session);

  const timer = fixture();
  timer.timerOutput = 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n';
  rejected(timer);

  const lock = fixture();
  lock.lockStatus = 0;
  rejected(lock);

  const docker = fixture();
  docker.dockerFailure = true;
  rejected(docker);

  const databaseCommand = fixture();
  databaseCommand.databaseCommandFailure = true;
  rejected(databaseCommand);
});

test('rejects a foreign container connected to the Workout network or private mount', () => {
  const network = fixture();
  network.containers.push({
    ...container('app'),
    Id: id('e'),
    Config: { Labels: { 'com.docker.compose.project': 'infra' } },
    Mounts: [],
  });
  rejected(network);

  const privateMount = fixture();
  privateMount.containers.push({
    ...container('app'),
    Id: id('f'),
    Config: { Labels: { 'com.docker.compose.project': 'infra' } },
    NetworkSettings: { Networks: { infra_default: {} } },
  });
  rejected(privateMount);
});
