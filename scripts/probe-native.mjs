import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = join(repository, 'scripts/fixtures/native-spike');
async function run(command, args, timeout = 60000) {
  const { stdout } = await executeFile(command, args, { timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
async function execute() {
  if (process.platform !== 'darwin') throw new Error('MACOS_XCODE_REQUIRED');
  const directory = await mkdtemp(join(tmpdir(), 'workout-native-spike-'));
  const app = join(directory, 'NativeProbe.app');
  const deviceSet = join(directory, 'devices');
  let deviceId;
  let booted = false;
  let result;
  let stage = 'discover';
  let runtimeVersion;
  let buildVersion;
  let sourceSha256;
  const cleanupErrors = [];
  const cleanup = async () => {
    if (deviceId) {
      try {
        if (booted) await run('xcrun', ['simctl', '--set', deviceSet, 'shutdown', deviceId]);
      } catch {
        cleanupErrors.push('OWNED_SIMULATOR_SHUTDOWN_FAILED');
      }
      try {
        await run('xcrun', ['simctl', '--set', deviceSet, 'delete', deviceId]);
      } catch {
        cleanupErrors.push('OWNED_SIMULATOR_DELETE_FAILED');
      }
      deviceId = undefined;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      cleanupErrors.push('TEMPORARY_FILES_REMOVAL_FAILED');
    }
  };
  const interrupted = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const runtimes = JSON.parse(await run('xcrun', ['simctl', 'list', 'runtimes', '-j'])).runtimes;
    const runtime = runtimes.find((value) => value.isAvailable && value.name.startsWith('iOS'));
    if (!runtime) throw new Error('NO_INSTALLED_IOS_RUNTIME');
    runtimeVersion = runtime.version;
    const deviceTypes = JSON.parse(
      await run('xcrun', ['simctl', 'list', 'devicetypes', '-j']),
    ).devicetypes;
    const deviceType = deviceTypes.find((value) => value.productFamily === 'iPhone');
    if (!deviceType) throw new Error('NO_IPHONE_DEVICE_TYPE');
    buildVersion = await run('xcodebuild', ['-version']);
    const sdk = await run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    stage = 'compile';
    sourceSha256 = createHash('sha256')
      .update(await readFile(join(fixture, 'Probe.swift')))
      .digest('hex');
    await mkdir(app);
    await run('xcrun', [
      '--sdk',
      'iphonesimulator',
      'swiftc',
      '-parse-as-library',
      '-sdk',
      sdk,
      '-target',
      `${architecture}-apple-ios15.0-simulator`,
      '-module-cache-path',
      join(directory, 'module-cache'),
      '-framework',
      'UIKit',
      '-framework',
      'WebKit',
      '-framework',
      'HealthKit',
      join(fixture, 'Probe.swift'),
      '-o',
      join(app, 'NativeProbe'),
    ]);
    await copyFile(join(fixture, 'Info.plist'), join(app, 'Info.plist'));
    await run('plutil', ['-lint', join(app, 'Info.plist')]);
    await run('codesign', ['--force', '--sign', '-', app]);
    stage = 'create_simulator';
    await mkdir(deviceSet);
    deviceId = await run('xcrun', [
      'simctl',
      '--set',
      deviceSet,
      'create',
      'WorkoutSyntheticProbe',
      deviceType.identifier,
      runtime.identifier,
    ]);
    if (!/^[A-Fa-f0-9-]{36}$/.test(deviceId)) throw new Error('INVALID_CREATED_DEVICE_ID');
    stage = 'boot_simulator';
    await run('xcrun', ['simctl', '--set', deviceSet, 'boot', deviceId]);
    booted = true;
    await run('xcrun', ['simctl', '--set', deviceSet, 'bootstatus', deviceId, '-b'], 120000);
    stage = 'launch';
    await run('xcrun', ['simctl', '--set', deviceSet, 'install', deviceId, app]);
    const bundleId = 'org.workoutmanager.synthetic-native-probe';
    await run('xcrun', ['simctl', '--set', deviceSet, 'launch', deviceId, bundleId]);
    const container = await run('xcrun', [
      'simctl',
      '--set',
      deviceSet,
      'get_app_container',
      deviceId,
      bundleId,
      'data',
    ]);
    stage = 'observe_result';
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      try {
        result = JSON.parse(await readFile(join(container, 'Documents/probe-result.json'), 'utf8'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!result) throw new Error('RESULT_TIMEOUT');
    const expectedChecks = [
      'allowlisted_status_roundtrip_acknowledged',
      'boolean_version_rejected',
      'external_navigation_cancelled',
      'foreign_frame_rejected',
      'foreign_main_origin_rejected',
      'invalid_message_rejected',
      'valid_local_message_received',
    ];
    if (
      typeof result.healthKitAvailable !== 'boolean' ||
      result.healthAuthorizationRequested !== false ||
      result.healthQueriesExecuted !== false ||
      (result.outcome === 'passed' &&
        JSON.stringify(result.checks) !== JSON.stringify(expectedChecks))
    )
      throw new Error('INVALID_PROBE_RESULT');
    stage = 'completed';
  } catch (error) {
    result = {
      outcome: 'failed',
      failedStage: stage,
      errorCode:
        typeof error.code === 'string' && /^[A-Z_0-9]+$/.test(error.code)
          ? error.code
          : 'SPIKE_EXECUTION_FAILED',
    };
    // Diagnostics stay local and are bounded. Do not save device identifiers or raw subprocess logs.
    console.error(`Native spike failed at ${stage}: ${error.message.slice(0, 400)}`);
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    await cleanup();
  }
  const report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    xcode: buildVersion ?? null,
    runtimeVersion: runtimeVersion ?? null,
    deploymentTarget: '15.0',
    sourceSha256: sourceSha256 ?? null,
    result,
    signing: 'Simulator-only ad-hoc; no personal signing identity or provisioning used',
    isolation: 'New device in a private temporary simulator device set; only owned device deleted',
    cleanupCompleted: cleanupErrors.length === 0,
    cleanupErrors,
    unverified: [
      'Physical device signing and entitlements',
      'HealthKit authorization, sample queries, anchors, deletion and background delivery',
      'Capacitor integration',
      'Minimum supported OS runtime',
      'Real-device safe area, IME, back navigation and lifecycle',
    ],
    sources: [
      'https://developer.apple.com/documentation/healthkit/hkhealthstore/ishealthdataavailable()',
      'https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices',
    ],
  };
  await writeFile(
    join(repository, 'docs/implementation/research/native-simulator-result.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ stage, outcome: result.outcome, cleanupCompleted: report.cleanupCompleted }),
  );
  if (result.outcome !== 'passed' || !report.cleanupCompleted) process.exitCode = 1;
}
if (process.argv.length === 3 && process.argv[2] === '--execute') await execute();
else
  console.log(
    'Opt-in only: node scripts/probe-native.mjs --execute. Creates a disposable Simulator app/device; no health authorization or queries.',
  );
