import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CurrentRuntimeInstallationTransaction } from '../src/current-runtime-installation.js';
import { observeCurrentRuntimeColdCatalogV9In } from '../src/current-runtime-cold-catalog-v9.js';
import {
  type CurrentRuntimeSourceProofV9,
  verifyCurrentRuntimeSourceProofV9,
} from '../src/current-runtime-source-proof-v9.js';
import {
  probeCurrentRuntimeReadinessV9,
  currentRuntimeReadinessV9Schema,
} from '../src/current-runtime-readiness-v9.js';
vi.mock('../src/current-runtime-cold-catalog-v9.js', () => ({
  observeCurrentRuntimeColdCatalogV9In: vi.fn(),
}));
vi.mock('../src/current-runtime-source-proof-v9.js', () => ({
  verifyCurrentRuntimeSourceProofV9: vi.fn(),
}));
const catalogDigest = '91da4f0ec82152975eeee569a9c7d81ca06d67710264da8ff392980a99f4b4b2';
const cold = vi.mocked(observeCurrentRuntimeColdCatalogV9In);
const proof = vi.mocked(verifyCurrentRuntimeSourceProofV9);
function catalog() {
  return {
    schemaVersion: 1 as const,
    catalog: 'verified' as const,
    reason: 'matched' as const,
    profileVersion: 9 as const,
    runtimeStep: 25 as const,
    sourceDdlTip: 142 as const,
    catalogSha256: catalogDigest,
    metadataBytes: '6505087',
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
    installationReceiptRows: 'not_observed_by_runtime' as const,
  };
}
function verified(): CurrentRuntimeSourceProofV9 {
  return {
    state: 'verified' as const,
    reason: 'verified_build_evidence' as const,
    profileVersion: 9 as const,
    runtimeStep: 25 as const,
    sourceDdlTip: 142 as const,
    catalogDigest,
    sourceManifestSha256: 'a'.repeat(64),
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
describe('named profile25 readiness', () => {
  it('becomes ready only after actual cold and closed own source proof inside completed snapshot', async () => {
    const f = snapshot();
    const r = await probeCurrentRuntimeReadinessV9(f.database);
    expect(r).toEqual({
      schemaVersion: 1,
      state: 'ready',
      reason: 'verified_catalog_and_source',
      profileVersion: 9,
      runtimeStep: 25,
      sourceDdlTip: 142,
      protocol: 'named-profile25-pooled-v2-v38',
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
    expect(await probeCurrentRuntimeReadinessV9({})).toMatchObject({
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
      expect(await probeCurrentRuntimeReadinessV9(snapshot().database)).toMatchObject({
        state: 'unsupported',
        reason: expected,
      });
      expect(proof).not.toHaveBeenCalled();
    });
  for (const reason of ['query_unavailable', 'expected_asset_invalid'] as const)
    it(`catalog ${reason} is finite unavailable`, async () => {
      cold.mockResolvedValue({ ...catalog(), catalog: 'unavailable', reason });
      expect((await probeCurrentRuntimeReadinessV9(snapshot().database)).state).toBe('unavailable');
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
      const r = await probeCurrentRuntimeReadinessV9(snapshot().database);
      expect(r.state).toBe(reason === 'source_drift' ? 'unsupported' : 'unavailable');
      expect(r.processingAuthority).toBe('none');
    });
  it('failed COMMIT discards a previously calculated ready outcome', async () => {
    const f = snapshot();
    f.failCommit();
    expect(await probeCurrentRuntimeReadinessV9(f.database)).toMatchObject({
      state: 'unavailable',
      reason: 'transaction_failed',
    });
    expect(f.events.at(-1)).toBe('cleanup');
  });
  it('snapshot errors sanitize SQL and never use legacy fallback', async () => {
    const r = await probeCurrentRuntimeReadinessV9({
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
    const r = await probeCurrentRuntimeReadinessV9(snapshot().database);
    expect(r).toMatchObject({ reason: 'transaction_failed' });
    expect(JSON.stringify(r)).not.toContain('private path');
  });
  it('different catalog cannot match the closed source proof', async () => {
    cold.mockResolvedValue({ ...catalog(), catalogSha256: 'b'.repeat(64) });
    expect(await probeCurrentRuntimeReadinessV9(snapshot().database)).toMatchObject({
      state: 'unsupported',
      reason: 'source_proof_invalid',
    });
  });
  it('strict outward codec rejects caller authority, private fields and dirty profile tuples', () => {
    const base = {
      schemaVersion: 1,
      state: 'ready',
      reason: 'verified_catalog_and_source',
      profileVersion: 9,
      runtimeStep: 25,
      sourceDdlTip: 142,
      protocol: 'named-profile25-pooled-v2-v38',
      processingAuthority: 'none',
      restore: 'not_verified',
      installationReceiptRows: 'not_observed_by_runtime',
    };
    for (const changes of [
      { approved: true },
      { processingAuthority: 'approved' },
      { profileVersion: 8 },
      { runtimeStep: 24 },
      { privateKey: 'secret' },
      { state: 'unsupported' },
    ])
      expect(currentRuntimeReadinessV9Schema.safeParse({ ...base, ...changes }).success).toBe(
        false,
      );
  });
  it('rejects extra caller authority even if the typed module returned all expected facts', async () => {
    const injected = { ...verified(), approvalAllowed: true };
    proof.mockReturnValue(injected);
    expect(await probeCurrentRuntimeReadinessV9(snapshot().database)).toMatchObject({
      state: 'unsupported',
      reason: 'source_proof_invalid',
    });
  });
  it('verified proof without a source-manifest digest cannot enable ports', async () => {
    proof.mockReturnValue({ ...verified(), sourceManifestSha256: null });
    expect(await probeCurrentRuntimeReadinessV9(snapshot().database)).toMatchObject({
      reason: 'source_proof_invalid',
    });
  });
  it('checks the actual source proof profile/catalog tuple rather than trusting its state', async () => {
    for (const [field, value] of [
      ['catalogDigest', 'b'.repeat(64)],
      ['profileVersion', 8],
      ['runtimeStep', 24],
      ['sourceDdlTip', 141],
    ] as const) {
      const changed = verified();
      Object.defineProperty(changed, field, { value, enumerable: true });
      proof.mockReturnValue(changed);
      expect(await probeCurrentRuntimeReadinessV9(snapshot().database)).toMatchObject({
        state: 'unsupported',
        reason: 'source_proof_invalid',
      });
    }
  });
});
