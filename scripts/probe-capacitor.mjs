import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validOrientationObservation } from './fixtures/capacitor-spike/evidence.mjs';

const exec = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function run(command, args, cwd, timeout = 60000) {
  const { stdout } = await exec(command, args, {
    cwd,
    timeout,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, CI: 'true' },
  });
  return stdout.trim();
}
async function execute() {
  if (process.platform !== 'darwin') throw new Error('MACOS_REQUIRED');
  const reportPath = join(
    repository,
    'docs/implementation/research/capacitor-simulator-result.json',
  );
  let previousRuns = [];
  try {
    const previous = JSON.parse(await readFile(reportPath, 'utf8'));
    const { previousRuns: history = [], ...lastRun } = previous;
    if (!Array.isArray(history)) throw new Error('INVALID_PREVIOUS_RUN_HISTORY');
    previousRuns = [...history, lastRun];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), 'workout-capacitor-spike-'));
  const deviceSet = join(directory, 'devices');
  const project = join(directory, 'project');
  const derived = join(directory, 'derived');
  const fixture = join(repository, 'scripts/fixtures/capacitor-spike/SceneDelegate.swift');
  const bundleId = 'org.workoutmanager.syntheticcapacitorprobe';
  let deviceId;
  let bootAttempted = false;
  let stage = 'prepare';
  let result;
  let nativeFailure;
  let xcode;
  let runtimeVersion;
  let screenshot;
  const orientationObservations = [];
  const versions = {};
  const cleanupErrors = [];
  let sourceHash;
  let webIndexHash;
  const sim = (args) => run('xcrun', ['simctl', '--set', deviceSet, ...args], directory);
  const cleanup = async () => {
    if (deviceId) {
      try {
        if (bootAttempted) await sim(['shutdown', deviceId]);
      } catch {
        cleanupErrors.push('SIMULATOR_SHUTDOWN_FAILED');
      }
      try {
        await sim(['delete', deviceId]);
      } catch {
        cleanupErrors.push('SIMULATOR_DELETE_FAILED');
      }
      deviceId = undefined;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      cleanupErrors.push('TEMPORARY_FILES_REMOVAL_FAILED');
    }
  };
  const interrupt = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (const name of ['core', 'cli', 'ios']) {
      const metadata = JSON.parse(
        await readFile(join(repository, 'node_modules/@capacitor', name, 'package.json'), 'utf8'),
      );
      if (metadata.version !== '8.5.2') throw new Error('UNEXPECTED_CAPACITOR_VERSION');
      versions[name] = metadata.version;
    }
    sourceHash = hash(await readFile(fixture));
    const webDirectory = join(repository, 'apps/mobile-web/dist');
    webIndexHash = hash(await readFile(join(webDirectory, 'index.html')));
    await mkdir(project);
    await cp(webDirectory, join(project, 'www'), { recursive: true });
    await symlink(join(repository, 'node_modules'), join(project, 'node_modules'), 'dir');
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'workout-capacitor-feasibility',
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
        appName: 'WorkoutFeasibility',
        webDir: 'www',
        loggingBehavior: 'none',
        server: { hostname: 'localhost', iosScheme: 'capacitor' },
      }),
    );
    const cli = join(repository, 'node_modules/@capacitor/cli/bin/capacitor');
    stage = 'generate';
    console.log('Capacitor spike: generating temporary SPM project');
    await run(process.execPath, [cli, 'add', 'ios', '--packagemanager', 'SPM'], project);
    await run(process.execPath, [cli, 'sync', 'ios'], project);
    const spm = await readFile(join(project, 'ios/App/CapApp-SPM/Package.swift'), 'utf8');
    if (
      !spm.includes('https://github.com/ionic-team/capacitor-swift-pm.git') ||
      !spm.includes('exact: "8.5.2"')
    )
      throw new Error('SPM_EXACT_VERSION_NOT_PINNED');
    await copyFile(fixture, join(project, 'ios/App/App/SceneDelegate.swift'));
    xcode = await run('xcodebuild', ['-version'], project);
    stage = 'build';
    console.log('Capacitor spike: building Simulator app with personal signing disabled');
    await run(
      'xcodebuild',
      [
        '-project',
        join(project, 'ios/App/App.xcodeproj'),
        '-scheme',
        'App',
        '-configuration',
        'Debug',
        '-sdk',
        'iphonesimulator',
        '-destination',
        'generic/platform=iOS Simulator',
        '-derivedDataPath',
        derived,
        '-clonedSourcePackagesDirPath',
        join(directory, 'spm'),
        'CODE_SIGNING_ALLOWED=NO',
        'CODE_SIGNING_REQUIRED=NO',
        'CODE_SIGN_IDENTITY=',
        'build',
      ],
      project,
      240000,
    );
    stage = 'simulator';
    const runtimes = JSON.parse(
      await run('xcrun', ['simctl', 'list', 'runtimes', '-j'], directory),
    ).runtimes;
    const runtime = runtimes
      .filter((value) => value.isAvailable && value.platform === 'iOS')
      .sort((left, right) =>
        right.version.localeCompare(left.version, undefined, { numeric: true }),
      )
      .find((value) =>
        value.supportedDeviceTypes?.some((deviceType) => deviceType.productFamily === 'iPhone'),
      );
    const deviceType = runtime?.supportedDeviceTypes.find(
      (value) => value.productFamily === 'iPhone',
    );
    if (!runtime || !deviceType) throw new Error('SIMULATOR_UNAVAILABLE');
    runtimeVersion = runtime.version;
    await mkdir(deviceSet);
    deviceId = await sim([
      'create',
      'WorkoutCapacitorFeasibility',
      deviceType.identifier,
      runtime.identifier,
    ]);
    if (!/^[A-Fa-f0-9-]{36}$/.test(deviceId)) throw new Error('INVALID_OWNED_DEVICE');
    bootAttempted = true;
    await sim(['boot', deviceId]);
    await run(
      'xcrun',
      ['simctl', '--set', deviceSet, 'bootstatus', deviceId, '-b'],
      directory,
      120000,
    );
    const app = join(derived, 'Build/Products/Debug-iphonesimulator/App.app');
    await sim(['install', deviceId, app]);
    await sim(['launch', deviceId, bundleId]);
    stage = 'observe';
    console.log('Capacitor spike: waiting for shared Vite UI and native bridge evidence');
    const container = await sim(['get_app_container', deviceId, bundleId, 'data']);
    const documents = join(container, 'Documents');
    const readResult = async (filename) => {
      const deadline = Date.now() + 35000;
      while (Date.now() < deadline) {
        try {
          return JSON.parse(await readFile(join(documents, filename), 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (filename !== 'capacitor-probe.json') {
          try {
            const final = JSON.parse(
              await readFile(join(documents, 'capacitor-probe.json'), 'utf8'),
            );
            if (final.outcome !== 'passed') {
              nativeFailure = final;
              throw new Error('NATIVE_ORIENTATION_PROBE_FAILED');
            }
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('NATIVE_OBSERVATION_TIMEOUT');
    };
    const artifactDirectory = await mkdtemp(join(tmpdir(), 'workout-capacitor-evidence-'));
    for (const expectedStage of ['portrait', 'landscape', 'restored']) {
      stage = `observe_${expectedStage}`;
      const observation = await readResult(`capacitor-probe-${expectedStage}.json`);
      if (!validOrientationObservation(observation, expectedStage)) {
        nativeFailure = observation;
        throw new Error('INVALID_ORIENTATION_EVIDENCE');
      }
      const screenshotPath = join(artifactDirectory, `mobile-web-${expectedStage}.png`);
      await sim(['io', deviceId, 'screenshot', screenshotPath]);
      const capture = {
        path: screenshotPath,
        sha256: hash(await readFile(screenshotPath)),
        visualReview: 'pending',
      };
      orientationObservations.push({ ...observation, screenshot: capture });
      if (expectedStage === 'portrait') screenshot = capture;
      if (expectedStage !== 'restored')
        await writeFile(join(documents, `capacitor-probe-continue-${expectedStage}`), '');
      console.log(`Capacitor spike: ${expectedStage} measured and captured`);
    }
    result = await readResult('capacitor-probe.json');
    if (
      result.outcome === 'passed' &&
      (result.headingRendered !== true ||
        result.capacitorPlatform !== 'ios' ||
        result.nativePlatform !== true ||
        result.demoDisclaimerVisible !== true ||
        result.localOriginVerified !== true ||
        !Number.isSafeInteger(result.sharedWorkspaceButtonCount) ||
        result.sharedWorkspaceButtonCount < 1 ||
        JSON.stringify(result.orientationStages) !==
          JSON.stringify(['portrait', 'landscape', 'restored']))
    )
      throw new Error('INVALID_RENDER_RESULT');
    stage = 'completed';
  } catch (error) {
    result = {
      outcome: 'failed',
      failedStage: stage,
      nativeFailure: nativeFailure ?? null,
      errorCode:
        typeof error.code === 'string' && /^[A-Z_0-9]+$/.test(error.code)
          ? error.code
          : 'CAPACITOR_SPIKE_FAILED',
    };
    console.error(`Capacitor spike failed at ${stage}: ${error.message.slice(0, 1800)}`);
    if (typeof error.stdout === 'string') console.error(error.stdout.slice(-2500));
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await cleanup();
  }
  const report = {
    schemaVersion: 2,
    executedAt: new Date().toISOString(),
    nodeVersion: process.version,
    capacitorVersions: versions,
    xcode: xcode ?? null,
    runtimeVersion: runtimeVersion ?? null,
    instrumentationSha256: sourceHash ?? null,
    webIndexSha256: webIndexHash ?? null,
    result,
    buttonCountScope:
      'All document buttons; this is render evidence, not module interaction acceptance.',
    screenshot: screenshot ?? null,
    orientationObservations,
    cleanupCompleted: cleanupErrors.length === 0,
    cleanupErrors,
    scope:
      'Existing Vite mobile-web demo rendered inside a disposable Capacitor Simulator project; not a production native host.',
    unverified: [
      'Physical devices',
      'HealthKit authorization or queries',
      'Production native authentication and secure transport',
      'Minimum supported OS runtime',
      'App Store signing/provisioning',
      'Full IME, safe area, back and lifecycle acceptance',
    ],
    sources: [
      'https://capacitorjs.com/docs/ios',
      'https://capacitorjs.com/docs/ios/spm',
      'https://github.com/ionic-team/capacitor/releases/tag/8.5.2',
      'https://developer.apple.com/documentation/uikit/uiwindowscene/requestgeometryupdate(_:errorhandler:)',
    ],
    previousRuns,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      stage,
      outcome: result.outcome,
      cleanupCompleted: report.cleanupCompleted,
      screenshotPath: screenshot?.path ?? null,
    }),
  );
  if (result.outcome !== 'passed' || !report.cleanupCompleted) process.exitCode = 1;
}
if (process.argv.length === 3 && process.argv[2] === '--execute') await execute();
else
  console.log(
    'Opt-in only: node scripts/probe-capacitor.mjs --execute. Requires prebuilt mobile-web dist and exact Capacitor 8.5.2 root dependencies.',
  );
