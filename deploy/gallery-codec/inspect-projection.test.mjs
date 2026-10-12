import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createGalleryCodecSandboxSpecV2 } from './sandbox-policy.mjs';
import {
  projectGalleryCodecDockerInspect,
  normalizeGalleryCodecDockerInspect,
  GalleryCodecInspectProjectionError,
} from './inspect-projection.mjs';
const own = {
  runId: 'd4bb757b-7659-44da-b0ed-aa0563556e4c',
  nonce: 'a'.repeat(64),
  containerId: 'b'.repeat(64),
  imageDigest: 'sha256:' + 'c'.repeat(64),
};
function fixture() {
  const spec = createGalleryCodecSandboxSpecV2(
    {
      ownerUid: 0,
      mode: 0o600,
      regularFile: true,
      imageDigest: own.imageDigest,
    },
    { runId: own.runId, nonce: own.nonce, imageDigest: own.imageDigest },
  );
  return structuredClone({
    Id: own.containerId,
    Image: own.imageDigest,
    Path: '/usr/local/bin/node',
    Args: ['/codec/container-entry.mjs'],
    Created: '2026-10-09T00:00:00Z',
    Name: '/synthetic',
    GraphDriver: { Name: 'overlay2', Data: {} },
    Config: {
      Volumes: null,
      ...Object.fromEntries(
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
        ].map((k) => [k, spec[k]]),
      ),
      Hostname: 'synthetic',
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    },
    HostConfig: {
      ...spec.HostConfig,
      ContainerIDFile: '',
      PublishAllPorts: false,
      NanoCpus: 0,
      CpuShares: 0,
      CpuRealtimePeriod: 0,
      CpuRealtimeRuntime: 0,
      CpusetCpus: '',
      CpusetMems: '',
      MemoryReservation: 0,
      OomKillDisable: false,
      UsernsMode: '',
      CgroupParent: '',
      Runtime: 'runc',
      GroupAdd: null,
      Links: null,
      VolumesFrom: null,
      DeviceCgroupRules: null,
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      Sysctls: null,
      StorageOpt: null,
      Isolation: '',
    },
    State: {
      Running: false,
      Paused: false,
      Restarting: false,
      Dead: false,
      ExitCode: 0,
      OOMKilled: false,
      Pid: 0,
      Status: 'exited',
    },
    Mounts: [],
    NetworkSettings: {
      Networks: {
        none: {
          IPAddress: '',
          GlobalIPv6Address: '',
          Aliases: null,
          NetworkID: 'synthetic',
          IPPrefixLen: 0,
        },
      },
      Ports: {},
      SandboxID: 'synthetic',
    },
  });
}
const reject = (f) => assert.throws(f, GalleryCodecInspectProjectionError);
test('explicit Engine allowlisted extra fields are removed and strict policy reused', () => {
  const raw = fixture(),
    p = projectGalleryCodecDockerInspect(raw, own);
  assert.deepEqual(
    Object.keys(p).sort(),
    ['Config', 'HostConfig', 'Id', 'Image', 'Mounts', 'NetworkSettings', 'State'].sort(),
  );
  assert.equal(p.Created, undefined);
  assert.equal(p.HostConfig.Runtime, undefined);
  const n = normalizeGalleryCodecDockerInspect(raw, own);
  assert.equal(n.processingAuthority, 'none');
  assert.equal(n.running, false);
  assert.equal(n.containerId, own.containerId);
  assert.equal(n.recipeVersion, 2);
});
test('running/oom/exit are actual independent observations, not quiescence authority', () => {
  const raw = fixture();
  raw.State.Running = true;
  raw.State.OOMKilled = true;
  raw.State.ExitCode = 137;
  const n = normalizeGalleryCodecDockerInspect(raw, own);
  assert.equal(n.running, true);
  assert.equal(n.oomKilled, true);
  assert.equal(n.exitCode, 137);
  assert.equal(n.quiescence, undefined);
});
test('projection snapshot cannot be mutated by later raw input changes', () => {
  const raw = fixture(),
    p = projectGalleryCodecDockerInspect(raw, own);
  raw.Config.Env[0] = 'SECRET=x';
  raw.HostConfig.SecurityOpt.length = 0;
  assert.equal(p.Config.Env[0], 'LANG=C');
  assert.deepEqual(p.HostConfig.SecurityOpt, ['no-new-privileges:true']);
});
for (const [name, mutate] of [
  ['container', (r) => (r.Id = 'd'.repeat(64))],
  ['image', (r) => (r.Image = 'sha256:' + 'd'.repeat(64))],
  [
    'run',
    (r) => (r.Config.Labels['workout.gallery-codec.run'] = 'd4bb757b-7659-44da-b0ed-aa0563556e4d'),
  ],
  ['nonce', (r) => (r.Config.Labels['workout.gallery-codec.nonce'] = 'd'.repeat(64))],
  ['foreignmount', (r) => (r.Mounts = [{ Type: 'bind' }])],
  ['network', (r) => (r.NetworkSettings.Networks.bridge = {})],
  ['port', (r) => (r.NetworkSettings.Ports = { '80/tcp': [] })],
  ['privilege', (r) => (r.HostConfig.Privileged = true)],
  ['memory', (r) => (r.HostConfig.Memory = 0)],
  ['capability', (r) => (r.HostConfig.CapAdd = ['SYS_ADMIN'])],
  ['null-array', (r) => (r.HostConfig.Binds = null)],
  ['missing-array', (r) => delete r.HostConfig.Binds],
  ['null-boolean', (r) => (r.HostConfig.ReadonlyRootfs = null)],
  ['missing-default', (r) => delete r.HostConfig.UsernsMode],
  ['host-userns', (r) => (r.HostConfig.UsernsMode = 'host')],
  ['sysctl', (r) => (r.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' })],
  ['extra-host', (r) => (r.HostConfig.ExtraHosts = ['host:127.0.0.1'])],
  ['group', (r) => (r.HostConfig.GroupAdd = ['0'])],
  ['unknown-host', (r) => (r.HostConfig.FutureAuthority = true)],
  ['unknown-root', (r) => (r.FutureAuthority = true)],
  ['unknown-config', (r) => (r.Config.FutureAuthority = true)],
  ['label-extra', (r) => (r.Config.Labels.authority = 'true')],
  ['null-network', (r) => (r.NetworkSettings.Networks.none.Aliases = [])],
  ['negative-exit', (r) => (r.State.ExitCode = -1)],
  ['null-state', (r) => (r.State.Running = null)],
  ['oversize', (r) => (r.Name = 'x'.repeat(262144))],
  ['sparse', (r) => (r.Config.Env = new Array(3))],
  ['cycle', (r) => (r.GraphDriver.Data.loop = r)],
])
  test(`denies ${name} without falsey coercion`, () => {
    const r = fixture();
    mutate(r);
    reject(() => projectGalleryCodecDockerInspect(r, own));
  });
test('ignored fields getters are rejected before any read', () => {
  const r = fixture();
  let reads = 0;
  Object.defineProperty(r, 'Name', {
    enumerable: true,
    get() {
      reads++;
      return 'x';
    },
  });
  reject(() => projectGalleryCodecDockerInspect(r, own));
  assert.equal(reads, 0);
});
test('proxies are rejected before traps and inherited required fields rejected', () => {
  let reads = 0;
  const proxy = new Proxy(fixture(), {
    ownKeys() {
      reads++;
      return [];
    },
  });
  reject(() => projectGalleryCodecDockerInspect(proxy, own));
  assert.equal(reads, 0);
  const r = fixture();
  r.Config = Object.create(r.Config);
  reject(() => projectGalleryCodecDockerInspect(r, own));
});
test('own registration must be complete exact data including actual container ID', () => {
  for (const change of [
    { containerId: 'placeholder' },
    { containerId: null },
    { imageDigest: null },
    { nonce: 'z'.repeat(64) },
    { extra: true },
  ])
    reject(() => projectGalleryCodecDockerInspect(fixture(), { ...own, ...change }));
  const noId = { ...own };
  delete noId.containerId;
  reject(() => projectGalleryCodecDockerInspect(fixture(), noId));
});
test('state/config symbols and depth are rejected even in ignored subtree', () => {
  const r = fixture();
  r.Name = undefined;
  reject(() => projectGalleryCodecDockerInspect(r, own));
  const s = fixture();
  s.State[Symbol('extra')] = true;
  reject(() => projectGalleryCodecDockerInspect(s, own));
  const d = fixture();
  let node = d.GraphDriver.Data;
  for (let i = 0; i < 25; i++) {
    node.next = {};
    node = node.next;
  }
  reject(() => projectGalleryCodecDockerInspect(d, own));
});

for (const [name, change] of [
  ['actual-path', (r) => (r.Path = '/bin/sh')],
  ['actual-args', (r) => (r.Args = ['-e', '0'])],
  ['healthcheck', (r) => (r.Config.Healthcheck = { Test: ['CMD', 'other'] })],
  ['missing-attach', (r) => delete r.Config.AttachStdin],
  ['gateway', (r) => (r.NetworkSettings.Networks.none.Gateway = '1.1.1.1')],
  ['apparmor', (r) => (r.AppArmorProfile = 'unconfined')],
])
  test(`denies hidden engine ${name}`, () => {
    const r = fixture();
    change(r);
    reject(() => projectGalleryCodecDockerInspect(r, own));
  });

test('only named Engine Mounts omission projects empty', () => {
  const raw = fixture();
  delete raw.HostConfig.Mounts;
  assert.deepEqual(projectGalleryCodecDockerInspect(raw, own).HostConfig.Mounts, []);
});
for (const [name, value] of [
  ['null', null],
  ['object', {}],
  ['nonempty', [{}]],
])
  test('Mounts ' + name + ' denied', () => {
    const raw = fixture();
    raw.HostConfig.Mounts = value;
    assert.throws(
      () => projectGalleryCodecDockerInspect(raw, own),
      GalleryCodecInspectProjectionError,
    );
  });
test('missing Binds remains denied; unordered Env accepted; bad PATH denied', () => {
  const raw = fixture();
  raw.Config.Env.reverse();
  assert.equal(normalizeGalleryCodecDockerInspect(raw, own).recipeVersion, 2);
  delete raw.HostConfig.Binds;
  assert.throws(
    () => projectGalleryCodecDockerInspect(raw, own),
    GalleryCodecInspectProjectionError,
  );
  const bad = fixture();
  bad.Config.Env[3] = 'PATH=/tmp';
  assert.throws(
    () => projectGalleryCodecDockerInspect(bad, own),
    GalleryCodecInspectProjectionError,
  );
});

for (const [name, value] of [
  ['nonempty', { '/synthetic': {} }],
  ['emptyobject', {}],
  ['array', []],
  ['boolean', false],
])
  test('Volumes ' + name + ' rejected', () => {
    const raw = fixture();
    raw.Config.Volumes = value;
    assert.throws(
      () => projectGalleryCodecDockerInspect(raw, own),
      GalleryCodecInspectProjectionError,
    );
  });
test('Volumes absent rejected', () => {
  const raw = fixture();
  delete raw.Config.Volumes;
  assert.throws(
    () => projectGalleryCodecDockerInspect(raw, own),
    GalleryCodecInspectProjectionError,
  );
});
for (const field of ['MaskedPaths', 'ReadonlyPaths'])
  for (const variant of ['absent', 'null', 'empty', 'shortened', 'extra', 'replaced'])
    test(field + ' ' + variant + ' denied', () => {
      const raw = fixture();
      const list = raw.HostConfig[field];
      if (variant === 'absent') Reflect.deleteProperty(raw.HostConfig, field);
      else if (variant === 'null') raw.HostConfig[field] = null;
      else if (variant === 'empty') raw.HostConfig[field] = [];
      else if (variant === 'shortened') raw.HostConfig[field] = list.slice(1);
      else if (variant === 'extra') raw.HostConfig[field] = [...list, '/synthetic'];
      else raw.HostConfig[field] = list.map((p, i) => (i === 0 ? '/synthetic' : p));
      assert.throws(
        () => projectGalleryCodecDockerInspect(raw, own),
        GalleryCodecInspectProjectionError,
      );
    });
test('post actual none is required; empty and extra network denied', () => {
  for (const networks of [
    {},
    { none: { IPAddress: '', GlobalIPv6Address: '', Aliases: null }, bridge: {} },
  ]) {
    const raw = fixture();
    raw.NetworkSettings.Networks = networks;
    assert.throws(
      () => projectGalleryCodecDockerInspect(raw, own),
      GalleryCodecInspectProjectionError,
    );
  }
});
