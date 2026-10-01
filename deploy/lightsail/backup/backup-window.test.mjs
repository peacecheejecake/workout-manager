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
    policy: {
      app: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      graphhopper: { Name: 'on-failure', MaximumRetryCount: 3 },
    },
    statusOverride: {},
    corruptAfter: undefined,
    project: 'workout-manager',
    timerActive: false,
    lockStatus: 75,
    failStop: undefined,
    failStart: undefined,
    failStartAfterChange: false,
    failUpdate: undefined,
    failUpdateAfterChange: false,
    restartOnStop: false,
    replaceAfter: undefined,
    externalPolicyAfter: undefined,
    failFence: false,
    failFenceAt: undefined,
    fenceCount: 0,
    failCollector: false,
    collectorOutput: 'BACKUP_PUBLISHED backup-fixture\n',
    bundles: ['backup-existing'],
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
    HostConfig: { RestartPolicy: state.policy[service] },
    Mounts: mounts,
    NetworkSettings: { Networks: { [config.network]: {} } },
    State: {
      Running: state.running[service],
      Status: state.running[service] ? 'running' : 'exited',
      Restarting: false,
      Paused: false,
      Dead: false,
      Health: service === 'postgres' ? { Status: 'healthy' } : undefined,
      ...state.statusOverride[service],
    },
  };
}

function runnerFor(state) {
  function record(action) {
    state.actions.push(action);
    if (state.replaceAfter === action) state.replaced = true;
    if (state.corruptAfter?.action === action) {
      state.statusOverride[state.corruptAfter.service] = state.corruptAfter.override;
    }
    if (state.externalPolicyAfter === action) {
      state.policy.app = { Name: 'always', MaximumRetryCount: 0 };
    }
  }
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
      const inspected = container(state, service);
      if (state.replaced && service === 'app') inspected.Id = id('d');
      return { status: 0, stdout: JSON.stringify([inspected]) };
    }
    if (program === 'docker' && args[0] === 'update') {
      const service = serviceForId(args.at(-1));
      const value = args[1].slice('--restart='.length);
      record(`update:${service}:${value}`);
      const failed = state.failUpdate === service && value === 'no';
      if (!failed || state.failUpdateAfterChange) {
        const [name, count] = value.split(':');
        state.policy[service] = { Name: name, MaximumRetryCount: Number(count ?? 0) };
      }
      return { status: failed ? 1 : 0, stdout: '' };
    }
    if (program === 'docker' && args[0] === 'stop') {
      const service = serviceForId(args.at(-1));
      record(`stop:${service}`);
      state.running[service] = state.restartOnStop && state.policy[service].Name !== 'no';
      return { status: state.failStop === service ? 1 : 0, stdout: '' };
    }
    if (program === 'docker' && args[0] === 'start') {
      const service = serviceForId(args[1]);
      record(`start:${service}`);
      const failed = state.failStart === service;
      if (!failed || state.failStartAfterChange) state.running[service] = true;
      return { status: failed ? 1 : 0, stdout: '' };
    }
    if (program === paths.fence) {
      record('fence');
      state.fenceCount += 1;
      return {
        status: state.failFence || state.fenceCount === state.failFenceAt ? 1 : 0,
        stdout: '',
      };
    }
    if (args[0] === paths.collector && args[1] === 'collect') {
      record('collector');
      const match = /^BACKUP_PUBLISHED (backup-[a-zA-Z0-9-]+)\n$/.exec(state.collectorOutput);
      if (!state.failCollector && match && !state.bundles.includes(match[1]))
        state.bundles.push(match[1]);
      return { status: state.failCollector ? 1 : 0, stdout: state.collectorOutput };
    }
    throw new Error(`Unexpected command ${program} ${args.join(' ')}`);
  };
}

function execute(state, chosenConfig = config) {
  return runWindow({
    config: chosenConfig,
    paths,
    run: runnerFor(state),
    finalize: (bundle) => {
      state.finalized = bundle;
    },
    listBundles: () => [...state.bundles],
  });
}

test('stops only pinned Workout services, collects, and restores in network-safe order', () => {
  const state = fixture();
  assert.equal(execute(state), true);
  assert.deepEqual(state.actions, [
    'update:graphhopper:no',
    'update:app:no',
    'stop:graphhopper',
    'stop:app',
    'fence',
    'collector',
    'fence',
    'start:app',
    'update:app:unless-stopped',
    'start:graphhopper',
    'update:graphhopper:on-failure:3',
  ]);
  assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
  assert.equal(state.policy.app.Name, 'unless-stopped');
  assert.deepEqual(state.policy.graphhopper, { Name: 'on-failure', MaximumRetryCount: 3 });
  assert.equal(state.finalized, '/srv/workout-manager/backups/backup-fixture');
});

test('wrong or duplicate collector output leaves only the new bundle pending', () => {
  for (const collectorOutput of [
    '',
    'BACKUP_PUBLISHED backup-one\nBACKUP_PUBLISHED backup-two\n',
    'BACKUP_PUBLISHED ../backup-other\n',
    'BACKUP_PUBLISHED backup-one\nextra\n',
  ]) {
    const state = fixture();
    state.collectorOutput = collectorOutput;
    assert.throws(() => execute(state));
    assert.equal(state.finalized, undefined);
    assert.equal(state.running.app, true);
    assert.deepEqual(state.bundles, ['backup-existing']);
  }
  const previous = fixture();
  previous.collectorOutput = 'BACKUP_PUBLISHED backup-existing\n';
  assert.throws(() => execute(previous));
  assert.equal(previous.finalized, undefined);
  assert.deepEqual(previous.bundles, ['backup-existing']);
});

test('final fence and restored-service checks must pass before finalization', () => {
  const failedFence = fixture();
  failedFence.failFenceAt = 2;
  assert.throws(() => execute(failedFence));
  assert.equal(failedFence.finalized, undefined);

  const replaced = fixture();
  replaced.replaceAfter = 'update:graphhopper:on-failure:3';
  assert.throws(() => execute(replaced));
  assert.equal(replaced.finalized, undefined);

  const policyChanged = fixture();
  policyChanged.externalPolicyAfter = 'update:graphhopper:on-failure:3';
  assert.throws(() => execute(policyChanged));
  assert.equal(policyChanged.finalized, undefined);
});

test('leaves initially stopped services stopped', () => {
  const state = fixture();
  state.running.app = false;
  state.running.graphhopper = false;
  state.policy.app = { Name: 'no', MaximumRetryCount: 0 };
  state.policy.graphhopper = { Name: 'no', MaximumRetryCount: 0 };
  assert.equal(execute(state), true);
  assert.deepEqual(state.actions, ['fence', 'collector', 'fence']);
  assert.deepEqual(state.running, { app: false, graphhopper: false, postgres: true });
  assert.deepEqual(state.policy.graphhopper, { Name: 'no', MaximumRetryCount: 0 });
});

test('leaves an initially stopped GraphHopper untouched while cycling the app', () => {
  const state = fixture();
  state.running.graphhopper = false;
  state.policy.graphhopper = { Name: 'no', MaximumRetryCount: 0 };
  assert.equal(execute(state), true);
  assert.deepEqual(state.actions, [
    'update:app:no',
    'stop:app',
    'fence',
    'collector',
    'fence',
    'start:app',
    'update:app:unless-stopped',
  ]);
  assert.equal(state.running.graphhopper, false);
  assert.deepEqual(state.policy.graphhopper, { Name: 'no', MaximumRetryCount: 0 });
});

test('rejects initially stopped services whose restart policy can revive them', () => {
  for (const service of ['app', 'graphhopper']) {
    const state = fixture();
    state.running.app = false;
    state.running.graphhopper = false;
    state.policy.app = { Name: 'no', MaximumRetryCount: 0 };
    state.policy.graphhopper = { Name: 'no', MaximumRetryCount: 0 };
    state.policy[service] = { Name: 'always', MaximumRetryCount: 0 };
    assert.throws(() => execute(state));
    assert.deepEqual(state.actions, []);
  }
});

test('rejects restarting, paused, dead, and contradictory Docker states before mutation', () => {
  for (const [service, override] of [
    ['app', { Running: false, Status: 'restarting', Restarting: true }],
    ['graphhopper', { Status: 'exited' }],
    ['app', { Paused: true }],
    ['postgres', { Dead: true }],
  ]) {
    const state = fixture();
    state.statusOverride[service] = override;
    assert.throws(() => execute(state));
    assert.deepEqual(state.actions, []);
  }
});

test('a restart transition after stop aborts capture and leaves policy disabled', () => {
  const state = fixture();
  state.corruptAfter = {
    action: 'stop:graphhopper',
    service: 'graphhopper',
    override: { Status: 'restarting', Restarting: true },
  };
  assert.throws(() => execute(state));
  assert.equal(state.actions.includes('collector'), false);
  assert.equal(state.actions.includes('stop:app'), false);
  assert.equal(state.policy.graphhopper.Name, 'no');
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
  assert.deepEqual(state.actions, [
    'update:graphhopper:no',
    'update:app:no',
    'stop:graphhopper',
    'update:app:unless-stopped',
    'start:graphhopper',
    'update:graphhopper:on-failure:3',
  ]);
  assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
});

test('restores both stopped services after checker or collector failure', () => {
  for (const fail of ['failFence', 'failCollector']) {
    const state = fixture();
    state[fail] = true;
    assert.throws(() => execute(state));
    assert.deepEqual(state.actions.slice(-4), [
      'start:app',
      'update:app:unless-stopped',
      'start:graphhopper',
      'update:graphhopper:on-failure:3',
    ]);
    assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
  }
});

test('reports a restore failure without starting unrelated containers', () => {
  const state = fixture();
  state.failStart = 'graphhopper';
  assert.throws(() => execute(state));
  assert.deepEqual(state.actions.slice(-3), [
    'start:app',
    'update:app:unless-stopped',
    'start:graphhopper',
  ]);
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

test('restores policies when Docker update reports failure before or after changing state', () => {
  for (const service of ['graphhopper', 'app'])
    for (const changed of [false, true]) {
      const state = fixture();
      state.failUpdate = service;
      state.failUpdateAfterChange = changed;
      assert.throws(() => execute(state));
      assert.equal(state.actions.includes('collector'), false);
      assert.equal(
        state.actions.some((action) => action.startsWith('stop:')),
        false,
      );
      assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
      assert.deepEqual(state.policy.app, { Name: 'unless-stopped', MaximumRetryCount: 0 });
      assert.deepEqual(state.policy.graphhopper, { Name: 'on-failure', MaximumRetryCount: 3 });
      assert.equal(
        state.actions.some((action) => action.includes('postgres')),
        false,
      );
    }
});

test('a failed start after state change still restores the original policy', () => {
  const state = fixture();
  state.failStart = 'app';
  state.failStartAfterChange = true;
  assert.throws(() => execute(state));
  assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
  assert.deepEqual(state.policy.app, { Name: 'unless-stopped', MaximumRetryCount: 0 });
  assert.deepEqual(state.policy.graphhopper, { Name: 'on-failure', MaximumRetryCount: 3 });
});

test('restart policy prevents an automatic restart race during stop', () => {
  const state = fixture();
  state.restartOnStop = true;
  assert.equal(execute(state), true);
  assert.equal(state.actions.includes('collector'), true);
  assert.deepEqual(state.running, { app: true, graphhopper: true, postgres: true });
});

test('identity replacement after policy update aborts capture and does not touch replacement', () => {
  const state = fixture();
  state.replaceAfter = 'update:app:no';
  assert.throws(() => execute(state));
  assert.equal(state.actions.includes('collector'), false);
  assert.equal(
    state.actions.some((action) => action.startsWith('stop:')),
    false,
  );
  assert.equal(
    state.actions.some((action) => action.startsWith('start:')),
    false,
  );
  assert.equal(state.policy.app.Name, 'no');
  assert.equal(state.policy.graphhopper.Name, 'no');
});

test('unexpected policy change before capture fails closed', () => {
  const state = fixture();
  state.externalPolicyAfter = 'fence';
  assert.throws(() => execute(state));
  assert.equal(state.actions.includes('collector'), false);
  assert.equal(state.actions.includes('start:app'), false);
  assert.equal(state.policy.app.Name, 'always');
});

test('failed start leaves restart disabled when the original state cannot be recovered', () => {
  const state = fixture();
  state.failStart = 'graphhopper';
  assert.throws(() => execute(state));
  assert.equal(state.policy.graphhopper.Name, 'no');
  assert.equal(state.running.graphhopper, false);
});

test('failed app restoration does not restart dependent GraphHopper', () => {
  const state = fixture();
  state.failStart = 'app';
  assert.throws(() => execute(state));
  assert.equal(state.running.app, false);
  assert.equal(state.running.graphhopper, false);
  assert.equal(state.policy.app.Name, 'no');
  assert.equal(state.policy.graphhopper.Name, 'no');
  assert.equal(state.actions.includes('start:graphhopper'), false);
});
