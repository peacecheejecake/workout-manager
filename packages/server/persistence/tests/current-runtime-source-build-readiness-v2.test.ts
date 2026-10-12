import type * as SourceBuildProofModule from '../src/current-runtime-source-build-proof-v2.js';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CurrentRuntimeInstallationTransaction } from '../src/current-runtime-installation.js';
import {
  type CurrentRuntimeSourceBuildProofV2,
  verifyCurrentRuntimeSourceBuildProofV2,
  currentRuntimeSourceBuildProofV2CatalogDigest,
} from '../src/current-runtime-source-build-proof-v2.js';
import {
  probeCurrentRuntimeSourceBuildReadinessV2,
  currentRuntimeSourceBuildReadinessV2Schema,
} from '../src/current-runtime-source-build-readiness-v2.js';
// Lane-independent stand-in for the cold catalog v10 observer: the readiness
// probe only consumes its outward observation, which is mocked per test.
const cold = vi.hoisted(() => vi.fn());
vi.mock('../src/current-runtime-cold-catalog-v10.js', () => ({
  observeCurrentRuntimeColdCatalogV10In: cold,
}));
vi.mock('../src/current-runtime-source-build-proof-v2.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SourceBuildProofModule>()),
  verifyCurrentRuntimeSourceBuildProofV2: vi.fn(),
}));
vi.mock('../src/current-runtime-source-build-proof-v2-pin.js', () => ({
  currentRuntimeSourceBuildProofV2AssetSha256: null,
}));
// The single Root-pinned digest; tests never depend on its literal value.
const catalogDigest = currentRuntimeSourceBuildProofV2CatalogDigest;
const otherDigest = catalogDigest === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
const proof = vi.mocked(verifyCurrentRuntimeSourceBuildProofV2);
function catalog() {
  return {
    schemaVersion: 1 as const,
    catalog: 'verified' as const,
    reason: 'matched' as const,
    profileVersion: 10 as const,
    runtimeStep: 26 as const,
    sourceDdlTip: 146 as const,
    catalogSha256: catalogDigest,
    metadataBytes: '6505087',
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
    installationReceiptRows: 'not_observed_by_runtime' as const,
  };
}
function verified(): CurrentRuntimeSourceBuildProofV2 {
  return {
    state: 'verified' as const,
    reason: 'verified_build_evidence' as const,
    profileVersion: 10 as const,
    runtimeStep: 26 as const,
    sourceDdlTip: 146 as const,
    catalogDigest,
    sourceManifestSha256: 'a'.repeat(64),
    buildProofVersion: 2,
    sourceBuildRevision: 1,
    currentFunctionalExecution: 'not_executed',
    authority: 'none',
    approvalAllowed: false,
    restoreAuthority: 'none',
  };
}
function snapshot() {
  const events: string[] = [];
  const tx: CurrentRuntimeInstallationTransaction = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
  let failCommit = false;
  const database = {
    snapshotCatalog: async <T>(
      operation: (tx: CurrentRuntimeInstallationTransaction) => Promise<T>,
    ): Promise<T> => {
      events.push('snapshot');
      try {
        const result = await operation(tx);
        events.push('commit');
        if (failCommit) throw new Error('secret COMMIT failure');
        return result;
      } finally {
        events.push('cleanup');
      }
    },
  };
  return {
    database,
    events,
    tx,
    failCommit: () => {
      failCommit = true;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  cold.mockResolvedValue(catalog());
  proof.mockReturnValue(verified());
});
describe('named profile26 readiness', () => {
  it('becomes ready only after actual cold and closed own source proof after committed and closed catalog snapshot', async () => {
    const f = snapshot();
    proof.mockImplementation(() => {
      expect(f.events).toEqual(['snapshot', 'commit', 'cleanup']);
      return verified();
    });
    const r = await probeCurrentRuntimeSourceBuildReadinessV2(f.database);
    expect(r).toEqual({
      schemaVersion: 2,
      buildProofVersion: 2,
      sourceBuildRevision: 1,
      currentFunctionalExecution: 'not_executed',
      approvalAllowed: false,
      restoreAuthority: 'none',
      state: 'ready',
      reason: 'verified_catalog_and_source',
      profileVersion: 10,
      runtimeStep: 26,
      sourceDdlTip: 146,
      protocol: 'named-profile26-pooled-v2-v38',
      processingAuthority: 'none',
      restore: 'not_verified',
      installationReceiptRows: 'not_observed_by_runtime',
    });
    expect(f.events).toEqual(['snapshot', 'commit', 'cleanup']);
    expect(cold).toHaveBeenCalledWith(f.tx);
    expect(proof).toHaveBeenCalledExactlyOnceWith();
    expect(cold.mock.invocationCallOrder[0]).toBeLessThan(proof.mock.invocationCallOrder[0] ?? 0);
  });
  it('missing snapshot does not fall back to tenant or assume a current athlete', async () => {
    expect(await probeCurrentRuntimeSourceBuildReadinessV2({})).toMatchObject({
      state: 'unavailable',
      reason: 'snapshot_unavailable',
    });
    expect(cold).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
  });
  for (const [reason, expected] of [
    ['context_required', 'catalog_context_required'],
    ['catalog_mismatch', 'catalog_mismatch'],
    ['limit', 'catalog_limit'],
    ['invalid_response', 'catalog_invalid_response'],
  ] as const)
    it(`catalog ${reason} creates no source proof or ready ports`, async () => {
      cold.mockResolvedValue({ ...catalog(), catalog: 'incompatible', reason });
      expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
        state: 'unsupported',
        reason: expected,
      });
      expect(proof).not.toHaveBeenCalled();
    });
  for (const reason of ['query_unavailable', 'expected_asset_invalid'] as const)
    it(`catalog ${reason} is finite unavailable`, async () => {
      cold.mockResolvedValue({ ...catalog(), catalog: 'unavailable', reason });
      expect((await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).state).toBe(
        'unavailable',
      );
      expect(proof).not.toHaveBeenCalled();
    });
  for (const reason of [
    'compiled_asset_unavailable',
    'asset_invalid',
    'source_unavailable',
    'source_drift',
  ] as const)
    it(`source ${reason} never reports ready`, async () => {
      proof.mockReturnValue({
        ...verified(),
        state: 'unavailable',
        reason,
        sourceManifestSha256: null,
      });
      const r = await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database);
      expect(r.state).toBe(reason === 'source_drift' ? 'unsupported' : 'unavailable');
      expect(r.processingAuthority).toBe('none');
    });
  it('failed COMMIT prevents source proof verification and readiness', async () => {
    const f = snapshot();
    f.failCommit();
    expect(await probeCurrentRuntimeSourceBuildReadinessV2(f.database)).toMatchObject({
      state: 'unavailable',
      reason: 'transaction_failed',
    });
    expect(f.events.at(-1)).toBe('cleanup');
    expect(proof).not.toHaveBeenCalled();
  });
  it('snapshot errors sanitize SQL and never use legacy fallback', async () => {
    const r = await probeCurrentRuntimeSourceBuildReadinessV2({
      snapshotCatalog: vi.fn().mockRejectedValue(new Error('private SQL source')),
    });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'transaction_failed' });
    expect(JSON.stringify(r)).not.toContain('private SQL');
    expect(proof).not.toHaveBeenCalled();
  });
  it('source proof exception is closed by snapshot boundary', async () => {
    proof.mockImplementation(() => {
      throw new Error('private path');
    });
    const r = await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database);
    expect(r).toMatchObject({ reason: 'transaction_failed' });
    expect(JSON.stringify(r)).not.toContain('private path');
  });
  it('different catalog cannot match the closed source proof', async () => {
    cold.mockResolvedValue({ ...catalog(), catalogSha256: otherDigest });
    expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
      state: 'unsupported',
      reason: 'source_proof_invalid',
    });
    expect(proof).not.toHaveBeenCalled();
  });
  it('strict outward codec rejects caller authority, private fields and dirty profile tuples', () => {
    const base = {
      schemaVersion: 2,
      buildProofVersion: 2,
      sourceBuildRevision: 1,
      currentFunctionalExecution: 'not_executed',
      approvalAllowed: false,
      restoreAuthority: 'none',
      state: 'ready',
      reason: 'verified_catalog_and_source',
      profileVersion: 10,
      runtimeStep: 26,
      sourceDdlTip: 146,
      protocol: 'named-profile26-pooled-v2-v38',
      processingAuthority: 'none',
      restore: 'not_verified',
      installationReceiptRows: 'not_observed_by_runtime',
    };
    for (const changes of [
      { approved: true },
      { processingAuthority: 'approved' },
      { profileVersion: 9 },
      { runtimeStep: 25 },
      { sourceDdlTip: 142 },
      { schemaVersion: 1 },
      { buildProofVersion: 1 },
      { protocol: 'named-profile25-pooled-v2-v38' },
      { privateKey: 'secret' },
      { state: 'unsupported' },
    ])
      expect(
        currentRuntimeSourceBuildReadinessV2Schema.safeParse({ ...base, ...changes }).success,
      ).toBe(false);
  });
  it('rejects extra caller authority even if the typed module returned all expected facts', async () => {
    const injected = verified();
    Object.defineProperty(injected, 'approvalAllowed', { value: true, enumerable: true });
    proof.mockReturnValue(injected);
    expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
      state: 'unsupported',
      reason: 'source_proof_invalid',
    });
  });
  it('verified proof without a source-manifest digest cannot enable ports', async () => {
    proof.mockReturnValue({ ...verified(), sourceManifestSha256: null });
    expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
      reason: 'source_proof_invalid',
    });
  });
  it('checks the actual source proof profile/catalog tuple rather than trusting its state', async () => {
    for (const [field, value] of [
      ['catalogDigest', otherDigest],
      ['profileVersion', 9],
      ['runtimeStep', 25],
      ['sourceDdlTip', 142],
      ['buildProofVersion', 1],
    ] as const) {
      const changed = verified();
      Object.defineProperty(changed, field, { value, enumerable: true });
      proof.mockReturnValue(changed);
      expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
        state: 'unsupported',
        reason: 'source_proof_invalid',
      });
    }
  });
});

it('actual null registered pin remains unavailable even with a mocked catalog match', async () => {
  const actual = await vi.importActual<typeof SourceBuildProofModule>(
    '../src/current-runtime-source-build-proof-v2.js',
  );
  proof.mockImplementation(actual.verifyCurrentRuntimeSourceBuildProofV2);
  expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
    state: 'unavailable',
    reason: 'source_compiled_asset_unavailable',
    sourceBuildRevision: 1,
    currentFunctionalExecution: 'not_executed',
    approvalAllowed: false,
    restoreAuthority: 'none',
  });
});
it('rejects wrong build revision and forged current execution without port authority', async () => {
  for (const [field, value] of [
    ['buildProofVersion', 1],
    ['sourceBuildRevision', 2],
    ['currentFunctionalExecution', 'passed'],
    ['authority', 'processing'],
    ['restoreAuthority', 'verified'],
  ] as const) {
    const raw = verified();
    Object.defineProperty(raw, field, { value, enumerable: true });
    proof.mockReturnValue(raw);
    expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
      state: 'unsupported',
      reason: 'source_proof_invalid',
    });
  }
});
it('rejects a foreign cold SQL tuple and forged catalog authority before consulting source proof', async () => {
  for (const [field, value] of [
    ['profileVersion', 9],
    ['runtimeStep', 25],
    ['sourceDdlTip', 142],
    ['processingAuthority', 'approved'],
  ] as const) {
    const raw = catalog();
    Object.defineProperty(raw, field, { value, enumerable: true });
    cold.mockResolvedValue(raw);
    expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
      state: 'unsupported',
      reason: 'catalog_invalid_response',
    });
  }
  expect(proof).not.toHaveBeenCalled();
});

it('rejects getter-backed observations before executing either getter', async () => {
  let calls = 0;
  const observed = catalog();
  Object.defineProperty(observed, 'catalog', {
    enumerable: true,
    get() {
      calls++;
      return 'verified';
    },
  });
  cold.mockResolvedValue(observed);
  expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
    state: 'unsupported',
    reason: 'catalog_invalid_response',
  });
  expect(proof).not.toHaveBeenCalled();
  cold.mockResolvedValue(catalog());
  const raw = verified();
  Object.defineProperty(raw, 'state', {
    enumerable: true,
    get() {
      calls++;
      return 'verified';
    },
  });
  proof.mockReturnValue(raw);
  expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
    state: 'unsupported',
    reason: 'source_proof_invalid',
  });
  expect(calls).toBe(0);
});

it('waits for snapshot COMMIT resolution before checking source bytes', async () => {
  const f = snapshot();
  let finishCommit: () => void = () => {
    throw Error('COMMIT_NOT_PENDING');
  };
  const commit = new Promise<void>((resolve) => {
    finishCommit = resolve;
  });
  const database = {
    async snapshotCatalog<T>(
      operation: (tx: CurrentRuntimeInstallationTransaction) => Promise<T>,
    ): Promise<T> {
      const catalogResult = await operation(f.tx);
      await commit;
      return catalogResult;
    },
  };
  const pending = probeCurrentRuntimeSourceBuildReadinessV2(database);
  await vi.waitFor(() => expect(cold).toHaveBeenCalledOnce());
  expect(proof).not.toHaveBeenCalled();
  finishCommit();
  expect(await pending).toMatchObject({ state: 'ready' });
  expect(proof).toHaveBeenCalledExactlyOnceWith();
});

it('rejects inconsistent cold state and reason pairs without consulting source proof', async () => {
  for (const [catalogState, reason] of [
    ['incompatible', 'matched'],
    ['unavailable', 'catalog_mismatch'],
  ] as const) {
    cold.mockResolvedValue({ ...catalog(), catalog: catalogState, reason });
    expect(await probeCurrentRuntimeSourceBuildReadinessV2(snapshot().database)).toMatchObject({
      state: 'unsupported',
      reason: 'catalog_invalid_response',
    });
  }
  expect(proof).not.toHaveBeenCalled();
});
