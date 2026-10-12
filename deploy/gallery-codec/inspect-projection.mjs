import { types } from 'node:util';
import {
  createGalleryCodecSandboxSpecV2,
  normalizeGalleryCodecSandboxInspectV2,
} from './sandbox-policy.mjs';

export class GalleryCodecInspectProjectionError extends Error {
  constructor() {
    super('GALLERY_CODEC_INSPECT_PROJECTION_INVALID');
    this.name = 'GalleryCodecInspectProjectionError';
  }
}
const deny = () => {
  throw new GalleryCodecInspectProjectionError();
};
// Inspect extras are admitted only at these named structural locations, never copied out.
const ignored = {
  root: [
    'Created',
    'Path',
    'Args',
    'ResolvConfPath',
    'HostnamePath',
    'HostsPath',
    'LogPath',
    'Name',
    'RestartCount',
    'Driver',
    'Platform',
    'AppArmorProfile',
    'ExecIDs',
    'GraphDriver',
    'SizeRw',
    'SizeRootFs',
  ],
  config: [
    'Hostname',
    'Domainname',
    'AttachStdin',
    'AttachStdout',
    'AttachStderr',
    'ExposedPorts',
    'Volumes',
    'Healthcheck',
    'StopSignal',
    'StopTimeout',
    'OnBuild',
    'Shell',
    'NetworkDisabled',
    'MacAddress',
  ],
  state: ['Status', 'Pid', 'Error', 'StartedAt', 'FinishedAt', 'Health'],
  networkSettings: [
    'Bridge',
    'SandboxID',
    'SandboxKey',
    'HairpinMode',
    'LinkLocalIPv6Address',
    'LinkLocalIPv6PrefixLen',
    'SecondaryIPAddresses',
    'SecondaryIPv6Addresses',
    'EndpointID',
    'Gateway',
    'GlobalIPv6Address',
    'GlobalIPv6PrefixLen',
    'IPAddress',
    'IPPrefixLen',
    'IPv6Gateway',
    'MacAddress',
  ],
  none: [
    'IPAMConfig',
    'Links',
    'NetworkID',
    'EndpointID',
    'Gateway',
    'IPPrefixLen',
    'IPv6Gateway',
    'GlobalIPv6PrefixLen',
    'MacAddress',
    'DriverOpts',
    'DNSNames',
  ],
};
// These additional engine knobs must be defaults; projecting away unsafe overrides is forbidden.
const hostDefaults = {
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
};
const hostOptionalDefaults = {
  Init: null,
  MemorySwappiness: null,
  KernelMemory: 0,
  KernelMemoryTCP: 0,
  CpuCount: 0,
  CpuPercent: 0,
  BlkioWeight: 0,
  BlkioWeightDevice: [],
  BlkioDeviceReadBps: [],
  BlkioDeviceWriteBps: [],
  BlkioDeviceReadIOps: [],
  BlkioDeviceWriteIOps: [],
  ConsoleSize: [0, 0],
  Annotations: {},
};

function boundedPlain(value) {
  let nodes = 0,
    bytes = 0;
  const seen = new Set();
  function walk(v, depth) {
    if (++nodes > 262144 || depth > 24) deny();
    if (v === null || typeof v === 'boolean') {
      bytes += 5;
    } else if (typeof v === 'string') {
      if (v.length > 262144) deny();
      bytes += Buffer.byteLength(JSON.stringify(v));
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) deny();
      bytes += String(v).length;
    } else {
      if (typeof v !== 'object' || types.isProxy(v) || seen.has(v)) deny();
      const array = Array.isArray(v);
      if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)) deny();
      seen.add(v);
      const ds = Object.getOwnPropertyDescriptors(v),
        keys = Reflect.ownKeys(ds);
      if (keys.some((k) => typeof k !== 'string')) deny();
      bytes += 2;
      if (array) {
        const len = ds.length?.value;
        if (!Number.isSafeInteger(len) || len < 0 || len > 4096 || keys.length !== len + 1) deny();
        for (let i = 0; i < len; i++) {
          const d = ds[i];
          if (!d || !('value' in d) || !d.enumerable) deny();
          bytes++;
          walk(d.value, depth + 1);
        }
      } else {
        for (const k of keys) {
          const d = ds[k];
          if (!('value' in d) || !d.enumerable) deny();
          bytes += Buffer.byteLength(JSON.stringify(k)) + 2;
          walk(d.value, depth + 1);
        }
      }
      seen.delete(v);
    }
    if (bytes > 262144) deny();
  }
  walk(value, 0);
}
function record(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) deny();
  return v;
}
function project(v, required, extras = []) {
  record(v);
  const allowed = new Set([...required, ...extras]);
  for (const k of Object.keys(v)) if (!allowed.has(k)) deny();
  const out = {};
  for (const k of required) {
    if (!Object.hasOwn(v, k)) deny();
    out[k] = v[k];
  }
  return out;
}
function exact(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) deny();
}
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** Data mapping only. The host broker must authenticate the Engine and own registration. */
export function projectGalleryCodecDockerInspect(raw, ownIdentity) {
  boundedPlain(raw);
  boundedPlain(ownIdentity);
  const own = project(ownIdentity, ['runId', 'nonce', 'imageDigest', 'containerId']);
  if (typeof own.containerId !== 'string' || !/^[0-9a-f]{64}$/.test(own.containerId)) deny();
  let expected;
  try {
    expected = createGalleryCodecSandboxSpecV2(
      {
        ownerUid: 0,
        mode: 0o600,
        regularFile: true,
        imageDigest: own.imageDigest,
      },
      { runId: own.runId, nonce: own.nonce, imageDigest: own.imageDigest },
    );
  } catch {
    deny();
  }
  if (!Object.hasOwn(raw, 'Path') || !Object.hasOwn(raw, 'Args')) deny();
  exact(raw.Path, expected.Entrypoint[0]);
  exact(raw.Args, [...expected.Entrypoint.slice(1), ...expected.Cmd]);
  if (Object.hasOwn(raw, 'Platform')) exact(raw.Platform, 'linux');
  if (
    Object.hasOwn(raw, 'AppArmorProfile') &&
    raw.AppArmorProfile !== 'docker-default' &&
    raw.AppArmorProfile !== ''
  )
    deny();
  const out = project(
    raw,
    ['Id', 'Image', 'Config', 'HostConfig', 'State', 'Mounts', 'NetworkSettings'],
    ignored.root,
  );
  const rawConfig = record(out.Config);
  // Actual v7 Engine container config has present-null Volumes; never drop declarations.
  if (!Object.hasOwn(rawConfig, 'Volumes')) deny();
  exact(rawConfig.Volumes, null);
  for (const k of ['AttachStdin', 'AttachStdout', 'AttachStderr']) {
    if (!Object.hasOwn(rawConfig, k)) deny();
    exact(rawConfig[k], true);
  }
  for (const k of ['Healthcheck', 'OnBuild', 'Shell'])
    if (Object.hasOwn(rawConfig, k)) exact(rawConfig[k], null);
  out.Config = project(
    out.Config,
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
    ],
    ignored.config,
  );
  const rawHost = record(out.HostConfig);
  // Moby Mounts json omitempty; explicit null remains rejected.
  const host = Object.hasOwn(rawHost, 'Mounts') ? rawHost : { ...rawHost, Mounts: [] };
  out.HostConfig = project(host, Object.keys(expected.HostConfig), [
    ...Object.keys(hostDefaults),
    ...Object.keys(hostOptionalDefaults),
  ]);
  for (const [k, v] of Object.entries(hostDefaults)) {
    if (!Object.hasOwn(host, k)) deny();
    exact(host[k], v);
  }
  for (const [k, v] of Object.entries(hostOptionalDefaults))
    if (Object.hasOwn(host, k)) exact(host[k], v);
  out.State = project(
    out.State,
    ['Running', 'Paused', 'Restarting', 'Dead', 'ExitCode', 'OOMKilled'],
    ignored.state,
  );
  out.NetworkSettings = project(
    out.NetworkSettings,
    ['Networks', 'Ports'],
    ignored.networkSettings,
  );
  const networks = project(out.NetworkSettings.Networks, ['none']);
  const rawNone = record(networks.none);
  for (const [k, v] of Object.entries({
    Gateway: '',
    IPv6Gateway: '',
    MacAddress: '',
    IPPrefixLen: 0,
    GlobalIPv6PrefixLen: 0,
    IPAMConfig: null,
    Links: null,
    DriverOpts: null,
    DNSNames: null,
  }))
    if (Object.hasOwn(rawNone, k)) exact(rawNone[k], v);
  networks.none = project(
    networks.none,
    ['IPAddress', 'GlobalIPv6Address', 'Aliases'],
    ignored.none,
  );
  out.NetworkSettings.Networks = networks;
  const snapshot = clone(out);
  try {
    normalizeGalleryCodecSandboxInspectV2(snapshot, own);
  } catch {
    deny();
  }
  return snapshot;
}
export function normalizeGalleryCodecDockerInspect(raw, ownIdentity) {
  const result = normalizeGalleryCodecSandboxInspectV2(
    projectGalleryCodecDockerInspect(raw, ownIdentity),
    ownIdentity,
  );
  return Object.freeze({ ...result, processingAuthority: 'none' });
}
