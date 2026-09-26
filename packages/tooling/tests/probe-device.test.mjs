import { describe, expect, it } from 'vitest';
import { sanitizeBuildOutput, signedBuildVerified } from '../../../scripts/probe-device.mjs';

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
});
