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
  const lookup = (runningProcesses) => ({
    ok: true,
    json: { info: { outcome: 'success' }, result: { runningProcesses } },
  });

  it('selects only the exact probe bundle, never another App.app process', () => {
    expect(
      probeProcessIds(
        lookup([
          {
            bundleIdentifier: 'org.workoutmanager.feasibility.deviceprobe',
            executable: '/private/Applications/App.app/App',
            processIdentifier: 101,
          },
          {
            bundleIdentifier: 'org.other.app',
            executable: '/private/Applications/App.app/App',
            processIdentifier: 202,
          },
        ]),
      ),
    ).toEqual([101]);
  });

  it('fails closed when process lookup fails or identity is unavailable', () => {
    const valid = lookup([
      { bundleID: 'org.workoutmanager.feasibility.deviceprobe', processIdentifier: 101 },
    ]);
    expect(probeProcessIds(valid)).toEqual([101]);
    expect(() => probeProcessIds({ ...valid, ok: false })).toThrow('PROBE_PROCESS_LOOKUP_FAILED');
    expect(() => probeProcessIds({ ...valid, json: null })).toThrow('PROBE_PROCESS_LOOKUP_FAILED');
    expect(() =>
      probeProcessIds(
        lookup([{ executable: '/private/Applications/App.app/App', processIdentifier: 202 }]),
      ),
    ).toThrow('PROBE_PROCESS_IDENTITY_UNAVAILABLE');
    expect(() =>
      probeProcessIds(
        lookup([
          { bundleIdentifier: 'org.other.app', processIdentifier: 202 },
          { executable: '/private/Applications/App.app/App', processIdentifier: 101 },
        ]),
      ),
    ).toThrow('PROBE_PROCESS_IDENTITY_UNAVAILABLE');
    expect(() =>
      probeProcessIds(
        lookup([
          {
            bundleIdentifier: 'org.other.app',
            bundleID: 'org.workoutmanager.feasibility.deviceprobe',
            processIdentifier: 101,
          },
        ]),
      ),
    ).toThrow('PROBE_PROCESS_IDENTITY_UNAVAILABLE');
    expect(() =>
      probeProcessIds(
        lookup([{ bundleID: 'org.workoutmanager.feasibility.deviceprobe', processIdentifier: 0 }]),
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
