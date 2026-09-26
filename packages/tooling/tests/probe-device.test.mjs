import { describe, expect, it } from 'vitest';
import {
  assertInstallableBuild,
  deviceCommandOutcome,
  probeProcessIds,
  sanitizeBuildOutput,
  signedBuildVerified,
} from '../../../scripts/probe-device.mjs';

describe('device build evidence', () => {
  it('stores bounded diagnostics without account, profile, path, or certificate text', () => {
    const diagnostics = sanitizeBuildOutput(
      "error: No Account for Team 'ABCDEF1234' at /Users/private/Library/profile.mobileprovision\n" +
        '** BUILD FAILED **\nAuthority=Apple Development: Private Person (ABCDEF1234)',
    );
    expect(diagnostics).toBe('BUILD FAILED\nerror lines: 1\n');
    expect(diagnostics).not.toMatch(/ABCDEF1234|private|mobileprovision|Authority/);
  });

  it('requires every signing check before recording success', () => {
    const team = 'ABCDEF1234';
    const valid = {
      verify: true,
      embeddedProfilePresent: true,
      signature: {
        teamIdentifier: team,
        authorityIsAppleDevelopment: true,
        identifier: 'org.workoutmanager.feasibility.deviceprobe',
      },
      signedEntitlements: {
        'com.apple.developer.healthkit': true,
        'com.apple.developer.healthkit.background-delivery': true,
      },
      builtInfo: {
        bundleId: 'org.workoutmanager.feasibility.deviceprobe',
        healthUsageKeys: ['NSHealthShareUsageDescription', 'NSHealthUpdateUsageDescription'],
      },
    };
    expect(signedBuildVerified(valid, team)).toBe(true);
    for (const invalid of [
      { ...valid, verify: false },
      { ...valid, embeddedProfilePresent: false },
      { ...valid, signature: { ...valid.signature, teamIdentifier: 'OTHERTEAM0' } },
      { ...valid, signedEntitlements: { 'com.apple.developer.healthkit': true } },
      { ...valid, builtInfo: { ...valid.builtInfo, bundleId: 'other.app' } },
    ])
      expect(signedBuildVerified(invalid, team)).toBe(false);
  });

  it('installs only the exact app from a verified signed build receipt', () => {
    const digest = 'a'.repeat(64);
    const receipt = {
      bundleId: 'org.workoutmanager.feasibility.deviceprobe',
      verified: true,
      appSha256: digest,
    };
    expect(() => assertInstallableBuild(receipt, digest)).not.toThrow();
    for (const invalid of [
      null,
      { ...receipt, verified: false },
      { ...receipt, appSha256: 'b'.repeat(64) },
      { ...receipt, bundleId: 'other.app' },
    ])
      expect(() => assertInstallableBuild(invalid, digest)).toThrow(
        'SIGNED_BUILD_RECEIPT_REQUIRED',
      );
  });
});

describe('device process termination scope', () => {
  const probeUrl = 'file:///private/var/containers/Bundle/Application/A1B2C3D4/App.app/';
  const lookup = (runningProcesses) => ({
    ok: true,
    json: { info: { outcome: 'success' }, result: { runningProcesses } },
  });
  const installed = (
    apps = [{ bundleIdentifier: 'org.workoutmanager.feasibility.deviceprobe', url: probeUrl }],
  ) => ({
    ok: true,
    json: { info: { outcome: 'success' }, result: { apps } },
  });

  it('matches only the exact installed probe executable URL, never another App.app process', () => {
    expect(
      probeProcessIds(
        lookup([
          {
            executable: `${probeUrl}App`,
            processIdentifier: 101,
          },
          {
            executable: 'file:///private/var/containers/Bundle/Application/OTHER/App.app/App',
            processIdentifier: 202,
          },
        ]),
        installed(),
      ),
    ).toEqual([101]);
  });

  it('fails closed when the installed app or process identity is unavailable', () => {
    const valid = lookup([{ executable: `${probeUrl}App`, processIdentifier: 101 }]);
    expect(probeProcessIds(valid, installed())).toEqual([101]);
    expect(probeProcessIds(lookup([]), installed())).toEqual([]);
    expect(() => probeProcessIds({ ...valid, ok: false }, installed())).toThrow(
      'PROBE_PROCESS_LOOKUP_FAILED',
    );
    expect(() => probeProcessIds({ ...valid, json: null }, installed())).toThrow(
      'PROBE_PROCESS_LOOKUP_FAILED',
    );
    for (const invalid of [
      installed([]),
      installed([{ bundleIdentifier: 'org.other.app', url: probeUrl }]),
      installed([
        {
          bundleIdentifier: 'org.workoutmanager.feasibility.deviceprobe',
          url: 'file:///private/Applications/App.app/',
        },
      ]),
      { ...installed(), ok: false },
    ])
      expect(() => probeProcessIds(valid, invalid)).toThrow('PROBE_APP_IDENTITY_UNAVAILABLE');
    expect(() =>
      probeProcessIds(
        lookup([
          {
            executable: 'file:///private/var/containers/Bundle/Application/OTHER/App.app/App',
            processIdentifier: 202,
          },
        ]),
        installed(),
      ),
    ).not.toThrow();
    expect(() =>
      probeProcessIds(
        lookup([
          {
            executable: `${probeUrl}App`,
            bundleIdentifier: 'org.other.app',
            processIdentifier: 101,
          },
        ]),
        installed(),
      ),
    ).toThrow('PROBE_PROCESS_IDENTITY_UNAVAILABLE');
    expect(() =>
      probeProcessIds(
        lookup([{ executable: `${probeUrl}App`, processIdentifier: 0 }]),
        installed(),
      ),
    ).toThrow('PROBE_PROCESS_IDENTITY_UNAVAILABLE');
  });
});

describe('device command journal privacy', () => {
  it('records only fixed outcomes when devicectl returns private errors', () => {
    const secret = 'PRIVATE /Users/athlete/Health.fit device-identifier';
    const failed = deviceCommandOutcome({
      ok: false,
      stderr: secret,
      json: {
        info: { outcome: secret },
        error: { userInfo: { NSLocalizedDescription: { string: secret } } },
      },
    });
    expect(failed).toEqual({
      ok: false,
      jsonOutcome: 'failure',
      error: 'DEVICECTL_COMMAND_FAILED',
    });
    expect(JSON.stringify(failed)).not.toContain(secret);

    expect(deviceCommandOutcome({ ok: true, json: { info: { outcome: secret } } })).toEqual({
      ok: false,
      jsonOutcome: 'failure',
      error: 'DEVICECTL_OUTCOME_FAILED',
    });
    expect(deviceCommandOutcome({ ok: true, json: { info: { outcome: 'success' } } })).toEqual({
      ok: true,
      jsonOutcome: 'success',
      error: null,
    });
  });
});
