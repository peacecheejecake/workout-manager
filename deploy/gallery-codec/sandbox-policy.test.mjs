import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  createGalleryCodecSandboxSpec,
  galleryCodecSandboxRecipeV1,
  GalleryCodecSandboxPolicyError,
  normalizeGalleryCodecSandboxCgroup,
  normalizeGalleryCodecSandboxInspect,
  verifyGalleryCodecSandboxTermination,
} from './sandbox-policy.mjs';

const own = {
  runId: 'd4bb757b-7659-44da-b0ed-aa0563556e4c',
  nonce: 'a'.repeat(64),
  containerId: 'b'.repeat(64),
  imageDigest: `sha256:${'c'.repeat(64)}`,
};
const intent = {
  runId: own.runId,
  nonce: own.nonce,
  imageDigest: own.imageDigest,
};
const config = {
  ownerUid: 0,
  mode: 0o600,
  regularFile: true,
  imageDigest: own.imageDigest,
};
function observations() {
  const spec = createGalleryCodecSandboxSpec(config, intent);
  return {
    inspect: structuredClone({
      Id: own.containerId,
      Image: own.imageDigest,
      Config: Object.fromEntries(
        [
          'Image',
          'User',
          'Entrypoint',
          'Cmd',
          'Env',
          'WorkingDir',
          'Labels',
          'OpenStdin',
          'StdinOnce',
          'Tty',
        ].map((key) => [key, spec[key]]),
      ),
      HostConfig: spec.HostConfig,
      State: {
        Running: false,
        Paused: false,
        Restarting: false,
        Dead: false,
        ExitCode: 0,
        OOMKilled: false,
      },
      Mounts: [],
      NetworkSettings: {
        Networks: {
          none: { IPAddress: '', GlobalIPv6Address: '', Aliases: null },
        },
        Ports: {},
      },
    }),
    cgroup: {
      ...own,
      cgroupVersion: 2,
      memoryMax: 536870912,
      memorySwapMax: 0,
      cpuMax: '100000 100000',
      pidsMax: 64,
      populated: 0,
      procs: [],
      pidsCurrent: 0,
    },
  };
}
const reject = (operation) => assert.throws(operation, GalleryCodecSandboxPolicyError);

test('fixed recipe/create spec has no caller command, volume, network or limit options', () => {
  const spec = createGalleryCodecSandboxSpec(config, intent);
  assert.equal(galleryCodecSandboxRecipeV1.wallMs, 30000);
  assert.equal(spec.HostConfig.Memory, 536870912);
  assert.equal(spec.HostConfig.MemorySwap, 536870912);
  assert.deepEqual(spec.HostConfig.Tmpfs, {
    '/work': 'rw,noexec,nosuid,nodev,size=201326592,mode=0700,uid=20001,gid=20001',
  });
  assert.equal(spec.HostConfig.LogConfig.Type, 'none');
  assert.deepEqual(spec.HostConfig.Binds, []);
  assert.ok(Object.isFrozen(spec.HostConfig));
  for (const key of ['argv', 'env', 'path', 'mount', 'wallMs', 'memoryBytes'])
    reject(() => createGalleryCodecSandboxSpec({ ...config, [key]: 1 }, intent));
});

test('exact inspect and independent cgroup projection normalize without OS authority', () => {
  const { inspect, cgroup } = observations();
  assert.equal(normalizeGalleryCodecSandboxInspect(inspect, own).running, false);
  assert.equal(normalizeGalleryCodecSandboxCgroup(cgroup, own).processCount, 0);
  const proof = verifyGalleryCodecSandboxTermination(inspect, cgroup, own);
  assert.equal(proof.quiescence, 'observed_empty_cgroup_v2');
  assert.equal(proof.processingAuthority, 'none');
  inspect.State.OOMKilled = true;
  inspect.State.ExitCode = 137;
  assert.equal(verifyGalleryCodecSandboxTermination(inspect, cgroup, own).oomKilled, true);
});

test('Running=false is insufficient when any descendant evidence is absent or nonempty', () => {
  for (const patch of [
    { populated: 1 },
    { procs: [42] },
    { pidsCurrent: 1 },
    { cgroupVersion: 1 },
  ]) {
    const { inspect, cgroup } = observations();
    reject(() => verifyGalleryCodecSandboxTermination(inspect, { ...cgroup, ...patch }, own));
  }
  const { inspect, cgroup } = observations();
  delete cgroup.procs;
  reject(() => verifyGalleryCodecSandboxTermination(inspect, cgroup, own));
  inspect.State.Running = true;
  reject(() => verifyGalleryCodecSandboxTermination(inspect, observations().cgroup, own));
});

const hostChanges = {
  Memory: 536870913,
  MemorySwap: -1,
  CpuPeriod: 100001,
  CpuQuota: -1,
  PidsLimit: -1,
  ReadonlyRootfs: false,
  NetworkMode: 'host',
  PidMode: 'host',
  IpcMode: 'host',
  CgroupnsMode: 'host',
  CapAdd: ['SYS_ADMIN'],
  CapDrop: [],
  SecurityOpt: [],
  Privileged: true,
  Binds: ['/tmp:/work'],
  Mounts: [{ Type: 'bind' }],
  Devices: [{ PathOnHost: '/dev/null' }],
  DeviceRequests: [{}],
  PortBindings: { '80/tcp': [] },
  Tmpfs: { '/work': 'size=1g' },
  LogConfig: { Type: 'json-file', Config: {} },
  Ulimits: [],
  RestartPolicy: { Name: 'always', MaximumRetryCount: 0 },
  AutoRemove: true,
};
for (const [key, value] of Object.entries(hostChanges)) {
  test(`rejects actual inspect privilege/resource drift: ${key}`, () => {
    const { inspect } = observations();
    inspect.HostConfig[key] = value;
    reject(() => normalizeGalleryCodecSandboxInspect(inspect, own));
  });
}

test('identity and source binding reject foreign/malformed/substituted evidence', () => {
  for (const key of Object.keys(own)) {
    const { inspect, cgroup } = observations();
    cgroup[key] =
      key === 'runId'
        ? 'e4bb757b-7659-44da-b0ed-aa0563556e4c'
        : key === 'imageDigest'
          ? `sha256:${'d'.repeat(64)}`
          : 'd'.repeat(64);
    reject(() => verifyGalleryCodecSandboxTermination(inspect, cgroup, own));
  }
  for (const patch of [
    { ownerUid: 20001 },
    { mode: 0o644 },
    { regularFile: false },
    { imageDigest: 'latest' },
  ])
    reject(() => createGalleryCodecSandboxSpec({ ...config, ...patch }, intent));
  for (const patch of [
    { containerId: 'short' },
    { nonce: 'D'.repeat(64) },
    { runId: 0 },
    { imageDigest: 'repository:latest' },
    { extra: true },
  ])
    reject(() => createGalleryCodecSandboxSpec(config, { ...intent, ...patch }));
});

test('own plain descriptors only; getters/proxies are never evaluated', () => {
  let accessed = 0;
  const getter = { ...config };
  Object.defineProperty(getter, 'imageDigest', {
    enumerable: true,
    get() {
      accessed++;
      return own.imageDigest;
    },
  });
  reject(() => createGalleryCodecSandboxSpec(getter, intent));
  reject(() =>
    createGalleryCodecSandboxSpec(
      new Proxy(config, {
        get() {
          accessed++;
        },
      }),
      intent,
    ),
  );
  reject(() => createGalleryCodecSandboxSpec(Object.create(config), intent));
  const { inspect } = observations();
  Object.defineProperty(inspect.State, 'Running', {
    enumerable: true,
    get() {
      accessed++;
      return false;
    },
  });
  reject(() => normalizeGalleryCodecSandboxInspect(inspect, own));
  assert.equal(accessed, 0);
});

test('extras, symbols, sparse arrays, cycles, malformed values and byte/depth bounds fail closed', () => {
  const mutations = [
    (i) => {
      i.unexpected = true;
    },
    (i) => {
      i.Config[Symbol('secret')] = true;
    },
    (i) => {
      i.Config.Cmd = new Array(2);
    },
    (i) => {
      i.Config.Labels.loop = i;
    },
    (i) => {
      i.Config.Env = ['x'.repeat(65537)];
    },
    (i) => {
      i.Config.Labels.deep = Array.from({ length: 17 }).reduce((v) => [v], 0);
    },
    (i) => {
      i.State.ExitCode = NaN;
    },
    (i) => {
      i.State.Running = 0;
    },
    (i) => {
      i.Mounts = [{ Type: 'volume' }];
    },
    (i) => {
      i.NetworkSettings.Ports = { '1/tcp': [] };
    },
    (i) => {
      i.Config.User = '0:0';
    },
    (i) => {
      i.Id = 'd'.repeat(64);
    },
    (i) => {
      i.Image = `sha256:${'d'.repeat(64)}`;
    },
    (i) => {
      delete i.HostConfig.Memory;
    },
  ];
  for (const mutate of mutations) {
    const { inspect } = observations();
    mutate(inspect);
    reject(() => normalizeGalleryCodecSandboxInspect(inspect, own));
  }
  for (const patch of [
    { memoryMax: '536870912' },
    { memorySwapMax: 1 },
    { cpuMax: 'max 100000' },
    { pidsMax: 65 },
    { procs: [1, 1] },
    { pidsCurrent: null },
    { unexpected: 1 },
  ])
    reject(() => normalizeGalleryCodecSandboxCgroup({ ...observations().cgroup, ...patch }, own));
});

test('equivalent JSON object key order preserves all exact member checks', () => {
  const { inspect, cgroup } = observations();
  inspect.HostConfig.LogConfig = { Config: {}, Type: 'none' };
  inspect.HostConfig.RestartPolicy = { MaximumRetryCount: 0, Name: 'no' };
  assert.equal(
    verifyGalleryCodecSandboxTermination(inspect, cgroup, own).quiescence,
    'observed_empty_cgroup_v2',
  );
});

test('precreate intent has no container ID; postcreate observations require actual full identity', () => {
  assert.equal(createGalleryCodecSandboxSpec(config, intent).Image, own.imageDigest);
  reject(() => createGalleryCodecSandboxSpec(config, own));
  for (const key of Object.keys(intent)) {
    const missing = { ...intent };
    Reflect.deleteProperty(missing, key);
    reject(() => createGalleryCodecSandboxSpec(config, missing));
  }
  const { inspect, cgroup } = observations();
  reject(() => normalizeGalleryCodecSandboxInspect(inspect, intent));
  reject(() => normalizeGalleryCodecSandboxCgroup(cgroup, intent));
  reject(() => verifyGalleryCodecSandboxTermination(inspect, cgroup, intent));
  reject(() =>
    normalizeGalleryCodecSandboxInspect(inspect, {
      ...own,
      containerId: 'd'.repeat(64),
    }),
  );
  reject(() =>
    normalizeGalleryCodecSandboxCgroup(cgroup, {
      ...own,
      containerId: 'd'.repeat(64),
    }),
  );
});

test('V2 producer and unordered exact Env preserve legacy and cgroup termination', async () => {
  const {
    createGalleryCodecSandboxSpecV2,
    normalizeGalleryCodecSandboxInspectV2,
    verifyGalleryCodecSandboxTerminationV2,
  } = await import('./sandbox-policy.mjs');
  const spec = createGalleryCodecSandboxSpecV2(config, intent);
  const v = observations();
  v.inspect.Config.Env = [...spec.Env].reverse();
  v.inspect.Config.Labels = { ...spec.Labels };
  v.inspect.HostConfig = structuredClone(spec.HostConfig);
  assert.equal(createGalleryCodecSandboxSpec(config, intent).Env.length, 3);
  assert.equal(normalizeGalleryCodecSandboxInspectV2(v.inspect, own).recipeVersion, 2);
  reject(() => normalizeGalleryCodecSandboxInspect(v.inspect, own));
  assert.equal(
    verifyGalleryCodecSandboxTerminationV2(v.inspect, v.cgroup, own).quiescence,
    'observed_empty_cgroup_v2',
  );
  for (const patch of [{ populated: 1 }, { procs: [1] }, { pidsCurrent: 1 }, { memoryMax: 1 }])
    reject(() => verifyGalleryCodecSandboxTerminationV2(v.inspect, { ...v.cgroup, ...patch }, own));
  for (const env of [
    [...spec.Env.slice(0, 3), 'PATH=/tmp'],
    [...spec.Env.slice(0, 3), 'UNKNOWN=x'],
    [spec.Env[0], spec.Env[0], ...spec.Env.slice(2)],
    spec.Env.slice(1),
  ]) {
    v.inspect.Config.Env = env;
    reject(() => normalizeGalleryCodecSandboxInspectV2(v.inspect, own));
  }
});

test('V2 explicit protective arrays preserve V1 shape and exact observed digests', async () => {
  const { createGalleryCodecSandboxSpecV2, normalizeGalleryCodecSandboxInspectV2 } =
    await import('./sandbox-policy.mjs');
  const { createHash } = await import('node:crypto');
  const spec = createGalleryCodecSandboxSpecV2(config, intent);
  assert.equal(
    Object.hasOwn(createGalleryCodecSandboxSpec(config, intent).HostConfig, 'MaskedPaths'),
    false,
  );
  for (const [field, count, digest] of [
    ['MaskedPaths', 12, 'b12dbf92f5c83aaefbc03cd545c2cb7ca615a77edd286224b6964eebcd373818'],
    ['ReadonlyPaths', 5, '7c68ab4b24e1817dd9b25beda42f070065eafca9792ae1424a0880f0b3d766a9'],
  ]) {
    assert.equal(spec.HostConfig[field].length, count);
    assert.equal(
      createHash('sha256')
        .update(JSON.stringify([...spec.HostConfig[field]].sort()))
        .digest('hex'),
      digest,
    );
    const v = observations();
    v.inspect.Config.Env = [...spec.Env];
    v.inspect.Config.Labels = { ...spec.Labels };
    v.inspect.HostConfig = structuredClone(spec.HostConfig);
    assert.equal(normalizeGalleryCodecSandboxInspectV2(v.inspect, own).recipeVersion, 2);
    for (const value of [
      null,
      [],
      spec.HostConfig[field].slice(1),
      [...spec.HostConfig[field], '/synthetic'],
    ]) {
      v.inspect.HostConfig[field] = value;
      reject(() => normalizeGalleryCodecSandboxInspectV2(v.inspect, own));
    }
  }
});
