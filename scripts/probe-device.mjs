import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// M0-06c physical-device feasibility driver. Opt-in; every command touches only the probe
// app (bundle id below) on the device named by WM_DEVICE_UDID. The generated Xcode project,
// build products and pulled evidence stay under the git-ignored verification-logs/ folder.

const exec = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = join(repository, 'verification-logs/m0-06c-device');
const project = join(workspace, 'project');
const derived = join(workspace, 'derived');
const fixtures = join(repository, 'scripts/fixtures/device-probe');
const bundleId = 'org.workoutmanager.feasibility.deviceprobe';
const appPath = join(derived, 'Build/Products/Debug-iphoneos/App.app');
const signedBuildReceipt = join(workspace, 'signed-build-receipt.json');
const steps = new Set([
  'none',
  'status',
  'authorize',
  'empty',
  'add',
  'collect',
  'send',
  'delete',
  'enableBackground',
  'disableBackground',
  'state',
]);
const crashes = new Set(['none', 'collectBeforePersist', 'sendBeforeAck']);
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function run(command, args, { cwd = workspace, timeout = 120000 } = {}) {
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? null,
      stdout: String(error.stdout ?? '').trim(),
      stderr: String(error.stderr ?? '').trim(),
    };
  }
}
async function journal(entry) {
  await mkdir(workspace, { recursive: true });
  const line = { at: new Date().toISOString(), ...entry };
  await appendFile(join(workspace, 'runs.jsonl'), JSON.stringify(line) + '\n');
  console.log(JSON.stringify(line, null, 2));
  if (entry.ok === false) process.exitCode = 1;
}
function device() {
  const udid = process.env.WM_DEVICE_UDID;
  if (!udid || !/^[0-9A-Fa-f-]{20,40}$/.test(udid)) throw new Error('WM_DEVICE_UDID_REQUIRED');
  return udid;
}
async function hashTree(directory) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .sort();
  const manifest = await Promise.all(
    files.map(async (path) => [path, hash(await readFile(join(directory, path)))]),
  );
  return hash(JSON.stringify(manifest));
}
/** Store bounded diagnostic facts only. Xcode output can contain account and profile data. */
export function sanitizeBuildOutput(output) {
  const lines = output.split('\n');
  const status = lines.filter((line) => /\*\* BUILD (SUCCEEDED|FAILED) \*\*/.test(line));
  const errorCount = lines.filter((line) => /error:/i.test(line)).length;
  return (
    [
      ...status.map((line) => line.match(/BUILD (SUCCEEDED|FAILED)/)?.[0] ?? 'BUILD STATUS'),
      `error lines: ${errorCount}`,
    ].join('\n') + '\n'
  );
}

export function signedBuildVerified(entry, team) {
  const entitlements = entry.signedEntitlements;
  return Boolean(
    entry.verify === true &&
    entry.embeddedProfilePresent === true &&
    entry.signature?.teamIdentifier === team &&
    entry.signature?.authorityIsAppleDevelopment === true &&
    entry.signature?.identifier === bundleId &&
    entitlements?.['com.apple.developer.healthkit'] === true &&
    entitlements?.['com.apple.developer.healthkit.background-delivery'] === true &&
    entry.builtInfo?.bundleId === bundleId &&
    entry.builtInfo?.healthUsageKeys?.includes('NSHealthShareUsageDescription') &&
    entry.builtInfo?.healthUsageKeys?.includes('NSHealthUpdateUsageDescription'),
  );
}

export function assertInstallableBuild(receipt, appSha256) {
  if (
    receipt?.bundleId !== bundleId ||
    receipt?.verified !== true ||
    !/^[0-9a-f]{64}$/.test(receipt?.appSha256 ?? '') ||
    receipt.appSha256 !== appSha256
  )
    throw new Error('SIGNED_BUILD_RECEIPT_REQUIRED');
}

async function prepare() {
  await rm(signedBuildReceipt, { force: true });
  await rm(derived, { recursive: true, force: true });
  for (const name of ['core', 'cli', 'ios']) {
    const metadata = JSON.parse(
      await readFile(join(repository, 'node_modules/@capacitor', name, 'package.json'), 'utf8'),
    );
    if (metadata.version !== '8.5.2') throw new Error('UNEXPECTED_CAPACITOR_VERSION');
  }
  const web = join(repository, 'apps/mobile-web/dist');
  const webBundleSha256 = await hashTree(web);
  await rm(project, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  await cp(web, join(project, 'www'), { recursive: true });
  if ((await hashTree(join(project, 'www'))) !== webBundleSha256)
    throw new Error('WEB_DIST_CHANGED_DURING_COPY');
  await symlink(join(repository, 'node_modules'), join(project, 'node_modules'), 'dir');
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'workout-device-feasibility',
      version: '0.0.0',
      private: true,
      dependencies: { '@capacitor/core': '8.5.2', '@capacitor/ios': '8.5.2' },
      devDependencies: { '@capacitor/cli': '8.5.2' },
    }),
  );
  await writeFile(
    join(project, 'capacitor.config.json'),
    JSON.stringify({
      appId: bundleId,
      appName: 'WM Device Probe',
      webDir: 'www',
      loggingBehavior: 'none',
      server: { hostname: 'localhost', iosScheme: 'capacitor' },
    }),
  );
  const cli = join(repository, 'node_modules/@capacitor/cli/bin/capacitor');
  for (const args of [
    ['add', 'ios', '--packagemanager', 'SPM'],
    ['sync', 'ios'],
  ]) {
    const result = await run(process.execPath, [cli, ...args], { cwd: project });
    if (!result.ok) throw new Error(`CAPACITOR_${args[0].toUpperCase()}_FAILED`);
  }
  const app = join(project, 'ios/App/App');
  const spm = await readFile(join(project, 'ios/App/CapApp-SPM/Package.swift'), 'utf8');
  if (!spm.includes('exact: "8.5.2"')) throw new Error('SPM_EXACT_VERSION_NOT_PINNED');
  const sources = {};
  for (const name of ['AppDelegate.swift', 'SceneDelegate.swift', 'App.entitlements']) {
    await copyFile(join(fixtures, name), join(app, name));
    sources[name] = hash(await readFile(join(fixtures, name)));
  }
  const plist = join(app, 'Info.plist');
  for (const [key, value] of [
    [
      'NSHealthShareUsageDescription',
      '실기기 검증용 앱이 스스로 기록한 합성 심박수·운동 표본만 다시 읽어 조회·삭제·변경 추적을 확인합니다. 다른 건강 기록은 읽거나 내보내지 않습니다.',
    ],
    [
      'NSHealthUpdateUsageDescription',
      '실기기 검증용 합성 심박수 1건과 합성 운동 1건(2001-01-01 날짜, 검증 표식 포함)을 기록한 뒤 삭제합니다.',
    ],
  ]) {
    const result = await run('plutil', ['-replace', key, '-string', value, plist]);
    if (!result.ok) throw new Error('INFO_PLIST_UPDATE_FAILED');
  }
  await run('plutil', [
    '-replace',
    'UIRequiredDeviceCapabilities',
    '-json',
    '["arm64","healthkit"]',
    plist,
  ]);
  const info = await run('plutil', ['-convert', 'json', '-o', '-', plist]);
  const parsed = JSON.parse(info.stdout);
  await journal({
    command: 'prepare',
    ok: true,
    bundleId,
    webBundleSha256,
    sources,
    healthUsageKeys: Object.keys(parsed).filter((key) => key.startsWith('NSHealth')),
    requiredCapabilities: parsed.UIRequiredDeviceCapabilities,
  });
}

async function build(signed) {
  await rm(signedBuildReceipt, { force: true });
  await rm(appPath, { recursive: true, force: true });
  const team = process.env.WM_DEVICE_TEAM;
  if (signed && !/^[A-Z0-9]{10}$/.test(team ?? '')) throw new Error('WM_DEVICE_TEAM_REQUIRED');
  const common = [
    '-project',
    join(project, 'ios/App/App.xcodeproj'),
    '-scheme',
    'App',
    '-configuration',
    'Debug',
    '-destination',
    // A signed build targets the connected device so automatic signing can register it.
    signed ? `id=${device()}` : 'generic/platform=iOS',
    '-derivedDataPath',
    derived,
    '-clonedSourcePackagesDirPath',
    join(workspace, 'spm'),
    'CODE_SIGN_ENTITLEMENTS=App/App.entitlements',
  ];
  const signing = signed
    ? [
        '-allowProvisioningUpdates',
        '-allowProvisioningDeviceRegistration',
        `DEVELOPMENT_TEAM=${team}`,
        'CODE_SIGN_STYLE=Automatic',
      ]
    : ['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY='];
  const result = await run('xcodebuild', [...common, ...signing, 'build'], {
    cwd: project,
    timeout: 600000,
  });
  const diagnostics = sanitizeBuildOutput(result.stdout + '\n' + result.stderr);
  await writeFile(join(workspace, `build-${signed ? 'signed' : 'unsigned'}.log`), diagnostics);
  const entry = {
    command: signed ? 'build-signed' : 'build-unsigned',
    ok: result.ok,
    xcode: (await run('xcodebuild', ['-version'])).stdout,
    errors: diagnostics.trim().split('\n'),
  };
  if (result.ok && signed) {
    const entitlements = await run('codesign', ['-d', '--entitlements', '-', '--xml', appPath]);
    entry.signedEntitlements = await convertPlist(entitlements.stdout);
    const details = await run('codesign', ['-dvv', appPath]);
    const text = details.stderr;
    entry.signature = {
      teamIdentifier: text.match(/TeamIdentifier=(\S+)/)?.[1] ?? null,
      authorityIsAppleDevelopment: /Authority=Apple Development/.test(text),
      identifier: text.match(/Identifier=(\S+)/)?.[1] ?? null,
    };
    entry.verify = (await run('codesign', ['--verify', '--deep', '--strict', appPath])).ok;
    entry.embeddedProfilePresent = (
      await run('test', ['-f', join(appPath, 'embedded.mobileprovision')])
    ).ok;
    const info = await convertPlist(await readFile(join(appPath, 'Info.plist')));
    entry.builtInfo = {
      bundleId: info.CFBundleIdentifier,
      healthUsageKeys: Object.keys(info).filter((key) => key.startsWith('NSHealth')),
      requiredCapabilities: info.UIRequiredDeviceCapabilities,
    };
  }
  if (signed) entry.ok = result.ok && signedBuildVerified(entry, team);
  if (signed && entry.ok) {
    const appSha256 = await hashTree(appPath);
    await writeFile(signedBuildReceipt, JSON.stringify({ bundleId, verified: true, appSha256 }));
    entry.appSha256 = appSha256;
  }
  await journal(entry);
}
async function convertPlist(input) {
  const temporary = join(workspace, `plist-${process.pid}.tmp`);
  await writeFile(temporary, input);
  const result = await run('plutil', ['-convert', 'json', '-o', '-', temporary]);
  await rm(temporary, { force: true });
  return result.ok ? JSON.parse(result.stdout) : null;
}

async function devicectl(command, args, timeout = 120000) {
  const output = join(workspace, `devicectl-${process.pid}.json`);
  const result = await run('xcrun', ['devicectl', '--json-output', output, ...args], { timeout });
  let json = null;
  try {
    json = JSON.parse(await readFile(output, 'utf8'));
  } catch {
    json = null;
  }
  await rm(output, { force: true });
  return { ...result, json, command };
}
const outcome = (result) => ({
  ok: result.ok,
  jsonOutcome: result.json?.info?.outcome ?? null,
  error: result.ok
    ? null
    : (result.json?.error?.userInfo?.NSLocalizedDescription?.string ??
      result.stderr.split('\n').slice(-3).join(' ').slice(0, 400)),
});

/** A process name or generic App.app path does not establish app ownership. */
export function probeProcessIds(lookup) {
  const processes = lookup?.json?.result?.runningProcesses;
  if (lookup?.ok !== true || lookup.json?.info?.outcome !== 'success' || !Array.isArray(processes))
    throw new Error('PROBE_PROCESS_LOOKUP_FAILED');

  const identified = processes.filter(
    (value) => typeof value?.bundleIdentifier === 'string' || typeof value?.bundleID === 'string',
  );
  if (identified.length !== processes.length) throw new Error('PROBE_PROCESS_IDENTITY_UNAVAILABLE');

  const matches = identified.filter(
    (value) => value.bundleIdentifier === bundleId || value.bundleID === bundleId,
  );
  if (
    matches.some(
      (value) =>
        value.bundleIdentifier !== undefined &&
        value.bundleID !== undefined &&
        value.bundleIdentifier !== value.bundleID,
    )
  )
    throw new Error('PROBE_PROCESS_IDENTITY_UNAVAILABLE');
  if (
    matches.some(
      (value) => !Number.isSafeInteger(value.processIdentifier) || value.processIdentifier <= 0,
    )
  )
    throw new Error('PROBE_PROCESS_IDENTITY_UNAVAILABLE');
  return [...new Set(matches.map((value) => value.processIdentifier))];
}

async function main([command, ...rest]) {
  await mkdir(workspace, { recursive: true });
  switch (command) {
    case 'prepare':
      return prepare();
    case 'build-unsigned':
      return build(false);
    case 'build-signed':
      return build(true);
    case 'install': {
      let receipt;
      try {
        receipt = JSON.parse(await readFile(signedBuildReceipt, 'utf8'));
      } catch {
        throw new Error('SIGNED_BUILD_RECEIPT_REQUIRED');
      }
      assertInstallableBuild(receipt, await hashTree(appPath));
      if (!(await run('codesign', ['--verify', '--deep', '--strict', appPath])).ok)
        throw new Error('SIGNED_BUILD_RECEIPT_REQUIRED');
      const result = await devicectl(
        'install',
        ['device', 'install', 'app', '--device', device(), appPath],
        300000,
      );
      return journal({
        command,
        ...outcome(result),
        installedBundle: result.json?.result?.installedApplications?.[0]?.bundleID ?? null,
      });
    }
    case 'uninstall': {
      const result = await devicectl('uninstall', [
        'device',
        'uninstall',
        'app',
        '--device',
        device(),
        bundleId,
      ]);
      return journal({ command, ...outcome(result) });
    }
    case 'launch': {
      const [step = 'none', crash = 'none'] = rest;
      if (!steps.has(step) || !crashes.has(crash)) throw new Error('UNKNOWN_STEP_OR_CRASH');
      const args = [
        'device',
        'process',
        'launch',
        '--device',
        device(),
        '--terminate-existing',
        bundleId,
      ];
      // `--` stops devicectl option parsing so the app receives its own arguments.
      if (step !== 'none' || crash !== 'none') args.push('--');
      if (step !== 'none') args.push('-wmProbeStep', step);
      if (crash !== 'none') args.push('-wmProbeCrash', crash);
      const result = await devicectl('launch', args);
      return journal({
        command,
        step,
        crash,
        ...outcome(result),
        pidReported: Number.isInteger(result.json?.result?.process?.processIdentifier),
      });
    }
    case 'terminate': {
      const list = await devicectl('processes', [
        'device',
        'info',
        'processes',
        '--device',
        device(),
      ]);
      let processIds;
      try {
        processIds = probeProcessIds(list);
      } catch (error) {
        return journal({
          command,
          ok: false,
          reason: error.message,
          matchedProcesses: 0,
          results: [],
        });
      }
      const results = [];
      for (const processId of processIds) {
        const result = await devicectl('terminate', [
          'device',
          'process',
          'terminate',
          '--device',
          device(),
          '--pid',
          String(processId),
        ]);
        results.push({ ok: result.ok && result.json?.info?.outcome === 'success' });
      }
      const ok = results.every((result) => result.ok);
      return journal({
        command,
        ok,
        reason: ok ? null : 'PROBE_PROCESS_TERMINATE_FAILED',
        matchedProcesses: processIds.length,
        results,
      });
    }
    case 'pull': {
      const destination = join(workspace, 'pulled', new Date().toISOString().replace(/[:.]/g, '-'));
      await mkdir(destination, { recursive: true });
      const result = await devicectl('pull', [
        'device',
        'copy',
        'from',
        '--device',
        device(),
        '--domain-type',
        'appDataContainer',
        '--domain-identifier',
        bundleId,
        '--source',
        'Documents/wm-device-probe',
        '--destination',
        destination,
      ]);
      return journal({
        command,
        ...outcome(result),
        destination: destination.slice(repository.length + 1),
      });
    }
    case 'apps': {
      const result = await devicectl('apps', [
        'device',
        'info',
        'apps',
        '--device',
        device(),
        '--bundle-id',
        bundleId,
      ]);
      const apps = result.json?.result?.apps ?? [];
      return journal({
        command,
        ...outcome(result),
        installed: apps.some((app) => app.bundleIdentifier === bundleId),
      });
    }
    default:
      console.log(
        'Opt-in only: WM_DEVICE_UDID=<udid> [WM_DEVICE_TEAM=<team>] node scripts/probe-device.mjs ' +
          '<prepare|build-unsigned|build-signed|install|uninstall|apps|launch <step> [crash]|terminate|pull>',
      );
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
