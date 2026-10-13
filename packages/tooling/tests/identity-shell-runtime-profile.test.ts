import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  identityShellRuntimeProfile,
  identityShellRuntimeProfileEnv,
  parseIdentityMobileBuildProfile,
} from '../../../scripts/fixtures/identity-shell-runtime-profile.js';
import { buildIdentityMobileDist } from '../../../scripts/fixtures/identity-mobile-preview.mjs';

const profile27 = 'installed-current-profile27';
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it('mirrors only the profile27 fixture into both shells and leaves everything else unset', () => {
  expect(identityShellRuntimeProfileEnv(profile27)).toEqual({
    web: { WORKOUT_RUNTIME_PROFILE: profile27 },
    mobile: { VITE_WORKOUT_RUNTIME_PROFILE: profile27 },
  });
  for (const other of [
    undefined,
    '',
    'installed-current-profile26',
    'staged-manual',
    'INSTALLED-CURRENT-PROFILE27',
    ` ${profile27}`,
  ]) {
    expect(identityShellRuntimeProfile(other)).toBeUndefined();
    const env = identityShellRuntimeProfileEnv(other);
    // Present-with-undefined: the webServer merge overrides (unsets) an inherited value.
    expect(Object.keys(env.web)).toEqual(['WORKOUT_RUNTIME_PROFILE']);
    expect(env.web['WORKOUT_RUNTIME_PROFILE']).toBeUndefined();
    expect(env.mobile['VITE_WORKOUT_RUNTIME_PROFILE']).toBeUndefined();
  }
  expect(parseIdentityMobileBuildProfile(undefined)).toBeUndefined();
  expect(parseIdentityMobileBuildProfile(profile27)).toBe(profile27);
  for (const invalid of ['', 'installed-current-profile26', 'baseline107'])
    expect(() => parseIdentityMobileBuildProfile(invalid)).toThrow(
      'IDENTITY_MOBILE_RUNTIME_PROFILE_INVALID',
    );
});

it.each([
  [profile27, profile27],
  ['installed-current-profile26', undefined],
  [undefined, undefined],
])('identity config: fixture %s gives Next/Vite shells profile %s', async (fixture, expected) => {
  vi.stubEnv('IDENTITY_E2E_SUITE', 'current-manual');
  vi.stubEnv('IDENTITY_E2E_RACE_MANUAL_PUBLIC', fixture);
  // An inherited caller value must never leak into a non-profile27 run.
  vi.stubEnv('WORKOUT_RUNTIME_PROFILE', profile27);
  vi.stubEnv('VITE_WORKOUT_RUNTIME_PROFILE', profile27);
  const config = (await import('../../../playwright.identity.config.js')).default;
  const servers = Array.isArray(config.webServer) ? config.webServer : [];
  const web = servers.find((s) => s.command.includes('next start'));
  const mobile = servers.find((s) => s.command.includes('identity-mobile-preview'));
  const api = servers.find((s) => s.command.includes('identity-e2e'));
  expect(web?.env?.['WORKOUT_RUNTIME_PROFILE']).toBe(expected);
  expect(web?.env).toHaveProperty('WORKOUT_RUNTIME_PROFILE');
  expect(web?.env).not.toHaveProperty('VITE_WORKOUT_RUNTIME_PROFILE');
  expect(mobile?.env?.['VITE_WORKOUT_RUNTIME_PROFILE']).toBe(expected);
  expect(mobile?.env).toHaveProperty('VITE_WORKOUT_RUNTIME_PROFILE');
  expect(mobile?.env).not.toHaveProperty('WORKOUT_RUNTIME_PROFILE');
  expect(api?.env ?? {}).not.toHaveProperty('WORKOUT_RUNTIME_PROFILE');
});

async function mobileDirectory(withAssets = true) {
  const directory = await mkdtemp(join(tmpdir(), 'wm-identity-mobile-test-'));
  directories.push(directory);
  if (withAssets) {
    await mkdir(join(directory, 'public/dist/maplibre'), { recursive: true });
    await mkdir(join(directory, 'public/dist/notices'), { recursive: true });
    await writeFile(join(directory, 'public/dist/maplibre/maplibre-gl-worker.mjs'), '');
    await writeFile(join(directory, 'public/dist/notices/THIRD_PARTY_NOTICES.txt'), '');
  }
  return directory;
}
async function ownedTemps() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('wm-identity-mobile-'));
}

it('builds a run-owned dist with exactly the selected profile and restores the environment', async () => {
  const directory = await mobileDirectory();
  vi.stubEnv('VITE_WORKOUT_RUNTIME_PROFILE', 'caller-value');
  const seen: unknown[] = [];
  const build = vi.fn(async (options: Record<string, unknown>) => {
    seen.push(process.env['VITE_WORKOUT_RUNTIME_PROFILE']);
    expect(options).toMatchObject({ root: directory, mode: 'production' });
  });
  const { outDir: set, remove: removeSet } = await buildIdentityMobileDist(
    directory,
    profile27,
    build,
  );
  directories.push(set);
  const { outDir: unset, remove: removeUnset } = await buildIdentityMobileDist(
    directory,
    undefined,
    build,
  );
  directories.push(unset);
  expect(seen).toEqual([profile27, undefined]);
  expect(process.env['VITE_WORKOUT_RUNTIME_PROFILE']).toBe('caller-value');
  expect(
    build.mock.calls.map(([options]) => (options['build'] as { outDir: string }).outDir),
  ).toEqual([set, unset]);
  expect(set).not.toBe(unset);
  expect(basename(set)).toMatch(/^wm-identity-mobile-/);
  await Promise.all([removeSet(), removeUnset()]);
});

it('arms synchronous exit removal before the build and disarms it only after async removal', async () => {
  const directory = await mobileDirectory();
  const exitHooks = () => process.listeners('exit');
  const before = exitHooks();
  let armed: (() => void) | undefined;
  let duringBuild: string | undefined;
  const build = vi.fn(async (options: Record<string, unknown>) => {
    duringBuild = (options['build'] as { outDir: string }).outDir;
    await stat(duringBuild);
    // A SIGTERM -> process.exit() or a normal exit here must not leak the dist.
    const added = exitHooks().filter((hook) => !before.includes(hook));
    expect(added).toHaveLength(1);
    armed = added[0] as () => void;
  });
  const dist = await buildIdentityMobileDist(directory, profile27, build);
  directories.push(dist.outDir);
  expect(dist.outDir).toBe(duringBuild);
  // Ownership transfers to the caller with the hook still armed (preview's process.exit path).
  expect(exitHooks()).toContain(armed);
  armed?.();
  await expect(stat(dist.outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await dist.remove();
  expect(exitHooks()).toEqual(before);

  // An interrupted build: the exit hook alone removes the directory synchronously.
  let interrupted: string | undefined;
  const pending = buildIdentityMobileDist(directory, undefined, async (options) => {
    interrupted = (options['build'] as { outDir: string }).outDir;
    const hook = exitHooks().find((candidate) => !before.includes(candidate)) as () => void;
    hook();
    throw new Error('synthetic interruption');
  });
  await expect(pending).rejects.toThrow('synthetic interruption');
  expect(interrupted).toBeDefined();
  await expect(stat(interrupted ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(exitHooks()).toEqual(before);
});

it('fails closed without generated assets and removes a failed build output', async () => {
  const bare = await mobileDirectory(false);
  const build = vi.fn(async () => undefined);
  await expect(buildIdentityMobileDist(bare, undefined, build)).rejects.toThrow(
    'IDENTITY_MOBILE_BUILD_PREREQUISITE_MISSING',
  );
  expect(build).not.toHaveBeenCalled();
  const directory = await mobileDirectory();
  const before = await ownedTemps();
  const exitBefore = process.listeners('exit');
  await expect(
    buildIdentityMobileDist(directory, profile27, async () => {
      throw new Error('synthetic build failure');
    }),
  ).rejects.toThrow('synthetic build failure');
  expect(await ownedTemps()).toEqual(before);
  expect(process.listeners('exit')).toEqual(exitBefore);
  expect(process.env['VITE_WORKOUT_RUNTIME_PROFILE']).toBeUndefined();
});
