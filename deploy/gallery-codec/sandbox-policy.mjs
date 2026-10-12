import { types } from 'node:util';

export class GalleryCodecSandboxPolicyError extends Error {
  constructor() {
    super('GALLERY_CODEC_SANDBOX_POLICY_INVALID');
    this.name = 'GalleryCodecSandboxPolicyError';
  }
}

function deny() {
  throw new GalleryCodecSandboxPolicyError();
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const image = /^sha256:[0-9a-f]{64}$/;
const maxBytes = 65536;

// Descriptor traversal happens before any property reads. This validates data, not its origin.
function plain(value) {
  let visits = 0;
  let bytes = 0;
  const seen = new Set();
  function charge(amount) {
    bytes += amount;
    if (bytes > maxBytes) deny();
  }
  function walk(item, depth) {
    if (++visits > maxBytes || depth > 16) deny();
    if (item === null || typeof item === 'boolean') {
      charge(item === null ? 4 : item ? 4 : 5);
      return;
    }
    if (typeof item === 'string') {
      if (item.length > maxBytes) deny();
      charge(Buffer.byteLength(JSON.stringify(item)));
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) deny();
      charge(String(item).length);
      return;
    }
    if (typeof item !== 'object' || types.isProxy(item) || seen.has(item)) deny();
    seen.add(item);
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) deny();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) deny();
    charge(2);
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length > maxBytes || keys.length !== length + 1) deny();
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) deny();
        if (index) charge(1);
        walk(descriptor.value, depth + 1);
      }
    } else {
      for (const [index, key] of keys.entries()) {
        const descriptor = descriptors[key];
        if (!('value' in descriptor) || !descriptor.enumerable) deny();
        if (index) charge(1);
        charge(Buffer.byteLength(JSON.stringify(key)) + 1);
        walk(descriptor.value, depth + 1);
      }
    }
    seen.delete(item);
  }
  walk(value, 0);
  return value;
}

function fields(value, names) {
  if (!value || Array.isArray(value) || typeof value !== 'object') deny();
  if (Object.keys(value).sort().join('\0') !== [...names].sort().join('\0')) deny();
  return value;
}
function equal(value, expected) {
  if (value !== expected) deny();
}
function list(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length) deny();
  value.forEach((entry, index) => equal(entry, expected[index]));
}
function equivalent(value, expected) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(value) || value.length !== expected.length) deny();
    value.forEach((entry, index) => equivalent(entry, expected[index]));
  } else if (expected !== null && typeof expected === 'object') {
    fields(value, Object.keys(expected));
    for (const key of Object.keys(expected)) equivalent(value[key], expected[key]);
  } else equal(value, expected);
}
function intent(value) {
  const data = fields(plain(value), ['runId', 'nonce', 'imageDigest']);
  if (
    typeof data.runId !== 'string' ||
    !uuid.test(data.runId) ||
    typeof data.nonce !== 'string' ||
    !hex.test(data.nonce) ||
    typeof data.imageDigest !== 'string' ||
    !image.test(data.imageDigest)
  )
    deny();
  return Object.freeze({ ...data });
}
function identity(value) {
  const data = fields(plain(value), ['runId', 'nonce', 'containerId', 'imageDigest']);
  if (
    !uuid.test(data.runId) ||
    !hex.test(data.nonce) ||
    !hex.test(data.containerId) ||
    !image.test(data.imageDigest)
  )
    deny();
  return Object.freeze({ ...data });
}

export const galleryCodecSandboxRecipeV1 = Object.freeze({
  recipeVersion: 1,
  memoryBytes: 536870912,
  swapBytes: 0,
  cpuMax: '100000 100000',
  pidsMax: 64,
  workTmpfsBytes: 201326592,
  wallMs: 30000,
  uid: 20001,
  gid: 20001,
});
export const galleryCodecSandboxRecipeV2 = Object.freeze({
  ...galleryCodecSandboxRecipeV1,
  recipeVersion: 2,
});
export const galleryCodecSandboxMaskedPathsV2 = Object.freeze([
  '/proc/asound',
  '/proc/acpi',
  '/proc/interrupts',
  '/proc/kcore',
  '/proc/keys',
  '/proc/latency_stats',
  '/proc/timer_list',
  '/proc/timer_stats',
  '/proc/sched_debug',
  '/proc/scsi',
  '/sys/firmware',
  '/sys/devices/virtual/powercap',
]);
export const galleryCodecSandboxReadonlyPathsV2 = Object.freeze([
  '/proc/bus',
  '/proc/fs',
  '/proc/irq',
  '/proc/sys',
  '/proc/sysrq-trigger',
]);
const labels = (own, version) => ({
  'workout.gallery-codec.recipe': String(version),
  'workout.gallery-codec.run': own.runId,
  'workout.gallery-codec.nonce': own.nonce,
});
const tmpfs = 'rw,noexec,nosuid,nodev,size=201326592,mode=0700,uid=20001,gid=20001';

/** Trusted broker configuration only. Never accept this object from an HTTP command. */
export function createGalleryCodecSandboxSpec(config, ownIntent) {
  return createSpec(config, ownIntent, 1);
}
export function createGalleryCodecSandboxSpecV2(config, ownIntent) {
  return createSpec(config, ownIntent, 2);
}
function createSpec(config, ownIntent, version) {
  const data = fields(plain(config), ['ownerUid', 'mode', 'regularFile', 'imageDigest']);
  equal(data.ownerUid, 0);
  equal(data.mode, 0o600);
  equal(data.regularFile, true);
  const own = intent(ownIntent);
  equal(data.imageDigest, own.imageDigest);
  // imageDigest is a pinned local Docker content ID, not an unverified mutable tag.
  return Object.freeze({
    Image: own.imageDigest,
    User: '20001:20001',
    Entrypoint: Object.freeze(['/usr/local/bin/node', '/codec/container-entry.mjs']),
    Cmd: Object.freeze([]),
    Env: Object.freeze(
      version === 1
        ? ['LANG=C', 'LC_ALL=C', 'TMPDIR=/work/tmp']
        : [
            'LANG=C',
            'LC_ALL=C',
            'TMPDIR=/work/tmp',
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          ],
    ),
    WorkingDir: '/work',
    Labels: Object.freeze(labels(own, version)),
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    HostConfig: Object.freeze({
      ...(version === 2
        ? {
            MaskedPaths: galleryCodecSandboxMaskedPathsV2,
            ReadonlyPaths: galleryCodecSandboxReadonlyPathsV2,
          }
        : {}),
      Memory: 536870912,
      MemorySwap: 536870912,
      CpuPeriod: 100000,
      CpuQuota: 100000,
      PidsLimit: 64,
      ReadonlyRootfs: true,
      NetworkMode: 'none',
      PidMode: '',
      IpcMode: 'private',
      CgroupnsMode: 'private',
      CapAdd: Object.freeze([]),
      CapDrop: Object.freeze(['ALL']),
      SecurityOpt: Object.freeze(['no-new-privileges:true']),
      Privileged: false,
      Binds: Object.freeze([]),
      Mounts: Object.freeze([]),
      Devices: Object.freeze([]),
      DeviceRequests: Object.freeze([]),
      PortBindings: Object.freeze({}),
      Tmpfs: Object.freeze({ '/work': tmpfs }),
      LogConfig: Object.freeze({ Type: 'none', Config: Object.freeze({}) }),
      Ulimits: Object.freeze([Object.freeze({ Name: 'core', Soft: 0, Hard: 0 })]),
      RestartPolicy: Object.freeze({ Name: 'no', MaximumRetryCount: 0 }),
      AutoRemove: false,
    }),
  });
}

/**
 * Strict projection of Docker inspect made by a trusted broker. Extra raw Docker fields
 * are projected by that adapter; this function neither calls Docker nor authenticates it.
 */
export function normalizeGalleryCodecSandboxInspect(value, ownIdentity) {
  return normalizeInspect(value, ownIdentity, 1);
}
export function normalizeGalleryCodecSandboxInspectV2(value, ownIdentity) {
  return normalizeInspect(value, ownIdentity, 2);
}
function normalizeInspect(value, ownIdentity, version) {
  const own = identity(ownIdentity);
  const observed = fields(plain(value), [
    'Id',
    'Image',
    'Config',
    'HostConfig',
    'State',
    'Mounts',
    'NetworkSettings',
  ]);
  equal(observed.Id, own.containerId);
  equal(observed.Image, own.imageDigest);
  const expected = createSpec(
    {
      ownerUid: 0,
      mode: 0o600,
      regularFile: true,
      imageDigest: own.imageDigest,
    },
    { runId: own.runId, nonce: own.nonce, imageDigest: own.imageDigest },
    version,
  );
  const config = fields(observed.Config, [
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
  ]);
  for (const key of ['Image', 'User', 'WorkingDir', 'OpenStdin', 'StdinOnce', 'Tty'])
    equal(config[key], expected[key]);
  for (const key of ['Entrypoint', 'Cmd']) list(config[key], expected[key]);
  if (version === 1) list(config.Env, expected.Env);
  else {
    if (!Array.isArray(config.Env) || config.Env.length !== 4 || new Set(config.Env).size !== 4)
      deny();
    for (const entry of expected.Env) if (!config.Env.includes(entry)) deny();
  }
  fields(config.Labels, Object.keys(expected.Labels));
  for (const key of Object.keys(expected.Labels)) equal(config.Labels[key], expected.Labels[key]);
  const host = fields(observed.HostConfig, Object.keys(expected.HostConfig));
  for (const key of Object.keys(expected.HostConfig)) {
    // Object member order is irrelevant; array order and every member remain exact.
    equivalent(host[key], expected.HostConfig[key]);
  }
  list(observed.Mounts, []);
  const networks = fields(observed.NetworkSettings, ['Networks', 'Ports']);
  fields(networks.Ports, []);
  const none = fields(networks.Networks, ['none']);
  const network = fields(none.none, ['IPAddress', 'GlobalIPv6Address', 'Aliases']);
  equal(network.IPAddress, '');
  equal(network.GlobalIPv6Address, '');
  equal(network.Aliases, null);
  const state = fields(observed.State, [
    'Running',
    'Paused',
    'Restarting',
    'Dead',
    'ExitCode',
    'OOMKilled',
  ]);
  for (const key of ['Running', 'Paused', 'Restarting', 'Dead', 'OOMKilled'])
    if (typeof state[key] !== 'boolean') deny();
  equal(state.Paused, false);
  equal(state.Restarting, false);
  equal(state.Dead, false);
  if (!Number.isInteger(state.ExitCode) || state.ExitCode < 0 || state.ExitCode > 255) deny();
  return Object.freeze({
    ...own,
    recipeVersion: version,
    running: state.Running,
    exitCode: state.ExitCode,
    oomKilled: state.OOMKilled,
  });
}

/** Trusted host observation of the exact owned cgroup subtree, not container-authored JSON. */
export function normalizeGalleryCodecSandboxCgroup(value, ownIdentity) {
  const own = identity(ownIdentity);
  const data = fields(plain(value), [
    'runId',
    'nonce',
    'containerId',
    'imageDigest',
    'cgroupVersion',
    'memoryMax',
    'memorySwapMax',
    'cpuMax',
    'pidsMax',
    'populated',
    'procs',
    'pidsCurrent',
  ]);
  for (const key of Object.keys(own)) equal(data[key], own[key]);
  equal(data.cgroupVersion, 2);
  equal(data.memoryMax, 536870912);
  equal(data.memorySwapMax, 0);
  equal(data.cpuMax, '100000 100000');
  equal(data.pidsMax, 64);
  if (data.populated !== 0 && data.populated !== 1) deny();
  if (
    !Array.isArray(data.procs) ||
    data.procs.length > 64 ||
    data.procs.some((pid) => !Number.isSafeInteger(pid) || pid <= 0) ||
    new Set(data.procs).size !== data.procs.length
  )
    deny();
  if (!Number.isSafeInteger(data.pidsCurrent) || data.pidsCurrent < 0 || data.pidsCurrent > 64)
    deny();
  return Object.freeze({
    ...own,
    cgroupVersion: 2,
    populated: data.populated,
    processCount: data.procs.length,
    pidsCurrent: data.pidsCurrent,
  });
}

export function verifyGalleryCodecSandboxTermination(inspect, cgroup, ownIdentity) {
  return verifyTermination(inspect, cgroup, ownIdentity, 1);
}
export function verifyGalleryCodecSandboxTerminationV2(inspect, cgroup, ownIdentity) {
  return verifyTermination(inspect, cgroup, ownIdentity, 2);
}
function verifyTermination(inspect, cgroup, ownIdentity, version) {
  const container = normalizeInspect(inspect, ownIdentity, version);
  const group = normalizeGalleryCodecSandboxCgroup(cgroup, ownIdentity);
  equal(container.running, false);
  equal(group.populated, 0);
  equal(group.processCount, 0);
  equal(group.pidsCurrent, 0);
  return Object.freeze({
    ...container,
    quiescence: 'observed_empty_cgroup_v2',
    processingAuthority: 'none',
  });
}
