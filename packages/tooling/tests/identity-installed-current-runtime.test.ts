import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installCurrentRuntimeV5,
  currentRuntimeV5ExtensionMember,
  currentRuntimeV5ParentManifestSha256,
} from '@workout/server-persistence/current-runtime-installation-v5';
import { currentRuntimeTargetTransforms } from '@workout/server-persistence/current-runtime-installation';
import {
  grantCurrentRuntimeV5Profile,
  currentRuntimeV5RpcSignatures,
} from '@workout/server-persistence/current-runtime-grants-v5';
import {
  grantCurrentRuntimeAppBaselineV1,
  currentRuntimeAppGrantRecipeV1,
} from '@workout/server-persistence/current-runtime-app-grants-v1';
import type * as InstallationModule from '@workout/server-persistence/current-runtime-installation-v5';
import type * as GrantsModule from '@workout/server-persistence/current-runtime-grants-v5';
import type * as BaselineModule from '@workout/server-persistence/current-runtime-app-grants-v1';
import type { Database } from '@workout/server-persistence/database';
import {
  setupIdentityInstalledCurrentRuntime,
  composeIdentityInstalledCurrentRuntimePorts,
} from '../../../scripts/identity-installed-current-runtime.mjs';
vi.mock('@workout/server-persistence/current-runtime-installation-v5', async (original) => ({
  ...(await original<typeof InstallationModule>()),
  installCurrentRuntimeV5: vi.fn(),
}));
vi.mock('@workout/server-persistence/current-runtime-grants-v5', async (original) => ({
  ...(await original<typeof GrantsModule>()),
  grantCurrentRuntimeV5Profile: vi.fn(),
}));
vi.mock('@workout/server-persistence/current-runtime-app-grants-v1', async (original) => ({
  ...(await original<typeof BaselineModule>()),
  grantCurrentRuntimeAppBaselineV1: vi.fn(),
}));
const input = {
  ownerConnectionString: 'postgresql://fixture_owner@127.0.0.1:5432/identity_fixture',
  runtimeRole: 'identity_fixture_app',
};
function installed(): Awaited<ReturnType<typeof installCurrentRuntimeV5>> {
  return {
    profileVersion: 5,
    baselineSchemaVersion: 107,
    parentRuntimeStep: 20,
    extensionStep: 1,
    runtimeStep: 21,
    sourceDdlTip: 131,
    parentManifestSha256: currentRuntimeV5ParentManifestSha256,
    extensionReceipt: {
      ...currentRuntimeV5ExtensionMember,
      parentManifestSha256: currentRuntimeV5ParentManifestSha256,
    },
    parentAppliedMembers: [],
    extensionMember: currentRuntimeV5ExtensionMember,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  };
}
function granted() {
  return {
    installation: installed(),
    runtimeRole: input.runtimeRole,
    grantedFunctions: currentRuntimeV5RpcSignatures,
    supported: false as const,
    processingAuthority: 'none' as const,
    catalogSecurity: 'not_verified' as const,
    restore: 'not_verified' as const,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(installCurrentRuntimeV5).mockResolvedValue(installed());
  vi.mocked(grantCurrentRuntimeV5Profile).mockResolvedValue(granted());
  vi.mocked(grantCurrentRuntimeAppBaselineV1).mockResolvedValue({
    recipeVersion: 1,
    recipe: currentRuntimeAppGrantRecipeV1.name,
    deployment: 'core',
    runtimeRole: input.runtimeRole,
    atomicity: 'separate_existing_grant_transactions',
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
});
describe('explicit installed profile21 fixture setup', () => {
  it('derives exact profile and fixed32 RPCs after install then named baseline then grant', async () => {
    const value = await setupIdentityInstalledCurrentRuntime(input);
    expect(value).toMatchObject({
      fixtureMode: 'installed-current-profile21',
      runtimeStep: 21,
      sourceDdlTip: 131,
      rpcCount: 32,
      supported: false,
      productionActivation: false,
      restore: 'not_verified',
      analysisFixtureGrants: 'not_applied',
      sourceExportBatch: 'not_installed_in_profile21',
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(grantCurrentRuntimeAppBaselineV1).toHaveBeenCalledWith(
      input.ownerConnectionString,
      input.runtimeRole,
      'core',
    );
    const installOrder = vi.mocked(installCurrentRuntimeV5).mock.invocationCallOrder[0];
    const baselineOrder = vi.mocked(grantCurrentRuntimeAppBaselineV1).mock.invocationCallOrder[0];
    const grantOrder = vi.mocked(grantCurrentRuntimeV5Profile).mock.invocationCallOrder[0];
    expect(installOrder).toBeLessThan(baselineOrder ?? 0);
    expect(baselineOrder).toBeLessThan(grantOrder ?? 0);
  });
  it.each([
    null,
    {},
    { ...input, supported: true },
    { ...input, runtimeRole: 'app;GRANT' },
    { ...input, ownerConnectionString: 'postgres://owner@remote.invalid/db' },
    { ...input, ownerConnectionString: input.ownerConnectionString + '?options=unsafe' },
    { ...input, runtimeRole: 'x'.repeat(8193) },
  ])('rejects unknown unsafe setup before any I/O (%#)', async (raw) => {
    await expect(setupIdentityInstalledCurrentRuntime(raw)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_INPUT_INVALID',
    });
    expect(installCurrentRuntimeV5).not.toHaveBeenCalled();
    expect(grantCurrentRuntimeV5Profile).not.toHaveBeenCalled();
  });
  it('does not invoke input getters or leak connection strings', async () => {
    const getter = vi.fn(() => input.ownerConnectionString);
    const raw = { runtimeRole: input.runtimeRole };
    Object.defineProperty(raw, 'ownerConnectionString', { enumerable: true, get: getter });
    await expect(setupIdentityInstalledCurrentRuntime(raw)).rejects.toThrow(
      'IDENTITY_CURRENT_INPUT_INVALID',
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['runtimeStep', 'supported', 'sourceDdlTip'])(
    'rejects changed actual installed %s before grants',
    async (field) => {
      const value = installed();
      Object.defineProperty(value, field, { value: field === 'supported' ? true : 132 });
      vi.mocked(installCurrentRuntimeV5).mockResolvedValue(value);
      await expect(setupIdentityInstalledCurrentRuntime(input)).rejects.toMatchObject({
        code: 'IDENTITY_CURRENT_PROFILE_INVALID',
      });
      expect(grantCurrentRuntimeAppBaselineV1).not.toHaveBeenCalled();
    },
  );
  it.each(['role', 'count', 'order'])(
    'rejects actual grant correspondence drift %s',
    async (fault) => {
      const value = granted();
      if (fault === 'role') value.runtimeRole = 'different_app';
      if (fault === 'count')
        Object.defineProperty(value, 'grantedFunctions', {
          value: currentRuntimeV5RpcSignatures.slice(0, 31),
        });
      if (fault === 'order')
        Object.defineProperty(value, 'grantedFunctions', {
          value: [...currentRuntimeV5RpcSignatures].reverse(),
        });
      vi.mocked(grantCurrentRuntimeV5Profile).mockResolvedValue(value);
      await expect(setupIdentityInstalledCurrentRuntime(input)).rejects.toMatchObject({
        code: 'IDENTITY_CURRENT_PROFILE_INVALID',
      });
    },
  );
  it('rejects a mismatched named baseline before granting RPCs', async () => {
    const baseline = {
      recipeVersion: 1 as const,
      recipe: currentRuntimeAppGrantRecipeV1.name,
      deployment: 'core' as const,
      runtimeRole: 'wrong_app',
      atomicity: 'separate_existing_grant_transactions' as const,
      supported: false as const,
      processingAuthority: 'none' as const,
      catalogSecurity: 'not_verified' as const,
      restore: 'not_verified' as const,
    };
    vi.mocked(grantCurrentRuntimeAppBaselineV1).mockResolvedValue(baseline);
    await expect(setupIdentityInstalledCurrentRuntime(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
    expect(grantCurrentRuntimeV5Profile).not.toHaveBeenCalled();
  });
  it('propagates actual final grant failure instead of manufacturing metadata success', async () => {
    const failure = new Error('FIXTURE_GRANT_FAILURE');
    vi.mocked(grantCurrentRuntimeV5Profile).mockRejectedValue(failure);
    await expect(setupIdentityInstalledCurrentRuntime(input)).rejects.toBe(failure);
  });
  it('propagates baseline failure without claiming whole setup atomicity or running final grant', async () => {
    const failure = new Error('FIXTURE_BASELINE_FAILURE');
    vi.mocked(grantCurrentRuntimeAppBaselineV1).mockRejectedValue(failure);
    await expect(setupIdentityInstalledCurrentRuntime(input)).rejects.toBe(failure);
    expect(grantCurrentRuntimeV5Profile).not.toHaveBeenCalled();
  });
  it('constructs real optional repositories without executing database I/O or granting authority', () => {
    const io = vi.fn(async () => {
      throw new Error('NO_IO_AT_COMPOSITION');
    });
    const database: Database = {
      tenant: io,
      exclusiveTenant: io,
      snapshotTenant: io,
      close: vi.fn(async () => undefined),
    };
    const ports = composeIdentityInstalledCurrentRuntimePorts(database);
    expect(Object.keys(ports)).toEqual([
      'nutritionV4Writer',
      'nutritionV4Preview',
      'raceResultsV2',
      'operations',
      'raceManualPublic',
    ]);
    expect(ports.raceManualPublic.review).toBeTypeOf('function');
    expect(ports.operations.exportAccount).toBeTypeOf('function');
    expect(io).not.toHaveBeenCalled();
  });
});
