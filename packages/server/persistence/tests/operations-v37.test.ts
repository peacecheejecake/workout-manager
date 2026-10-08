import { beforeEach, expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import { createOperationsV36Repository, createOperationsV37Repository } from '../src/operations.js';
import type * as RetainedExport from '../src/retained-personal-export.js';
import { RetainedPersonalExportError } from '../src/retained-personal-export.js';

const readers = vi.hoisted(() => ({ templates: vi.fn(), public: vi.fn(), internal: vi.fn() }));
vi.mock('../src/retained-personal-export.js', async (original) => ({
  ...(await original<typeof RetainedExport>()),
  readCheckInTemplatePersonalExportV1In: readers.templates,
  readRaceManualPersonalExportV1In: readers.public,
}));
vi.mock('../src/race-manual-internal-personal-export-reader.js', () => ({
  readRaceManualInternalPersonalExportV1In: readers.internal,
}));
const athlete = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(baseBytes = '2') {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('WITH base AS MATERIALIZED')
      ? [{ ok: true, bytes: baseBytes, data: {} }]
      : [],
    rowCount: null,
  }));
  const tx: Transaction = { athleteId: athlete, query };
  const tenant = vi.fn(() => {
    throw Error('RC_FORBIDDEN');
  });
  const snapshotTenant = vi.fn();
  const db: Database = {
    tenant,
    exclusiveTenant: tenant,
    snapshotTenant: async (_id, operation) => {
      snapshotTenant(_id);
      return operation(tx);
    },
    close: async () => {},
  };
  return { db, tx, query, tenant, snapshotTenant };
}
beforeEach(() => {
  vi.clearAllMocks();
  readers.templates.mockImplementation(async (_tx, _limit, debit) => {
    debit(100);
    return { checkInTemplateVersions: [], checkInTemplateHeads: [] };
  });
  readers.public.mockImplementation(async (_tx, _limit, debit) => {
    debit(200);
    return {
      manualRaceReviews: [],
      manualRaceApprovalHistory: [],
      manualRaceCommandResults: [],
      trainingPlanAggregates: [],
    };
  });
  readers.internal.mockImplementation(async (_tx, _limit, debit) => {
    debit(300);
    return {
      schemaVersion: 1,
      sourceProvenanceCoverage: 'not_exported_policy_unresolved',
      manualInternalChains: [],
      manualInternalCandidates: [],
      manualInternalApprovalResults: [],
      manualInternalApprovalHistory: [],
    };
  });
});
it('uses one snapshot transaction and decreasing raw response budgets, auditing only validated output', async () => {
  const f = fixture();
  const value = await createOperationsV37Repository(f.db).exportAccount(athlete);
  expect(value.schemaVersion).toBe(37);
  expect(value.data.sourceProvenanceCoverage).toBe('not_exported_policy_unresolved');
  expect(f.snapshotTenant).toHaveBeenCalledTimes(1);
  expect(f.tenant).not.toHaveBeenCalled();
  const calls = [readers.templates, readers.public, readers.internal].map(
    (reader) => reader.mock.calls[0],
  );
  expect(calls.map((call) => call?.[0])).toEqual([f.tx, f.tx, f.tx]);
  expect(calls.map((call) => call?.[1])).toEqual([8388608 - 1026, 8388608 - 1126, 8388608 - 1326]);
  expect(f.query.mock.calls.at(-1)?.[0]).toContain('INSERT INTO operations_audit');
});
it('preserves V36 and never invokes the internal reader for it', async () => {
  const value = await createOperationsV36Repository(fixture().db).exportAccount(athlete);
  expect(value.schemaVersion).toBe(36);
  expect(value.data).not.toHaveProperty('manualInternalChains');
  expect(readers.internal).not.toHaveBeenCalled();
});
it('refuses a missing snapshot port before queries or reader calls', () => {
  const f = fixture();
  const { snapshotTenant: _snapshot, ...db } = f.db;
  expect(() => createOperationsV37Repository(db).exportAccount(athlete)).toThrow(
    'OPERATIONS_SNAPSHOT_REQUIRED',
  );
  expect(f.query).not.toHaveBeenCalled();
  expect(readers.templates).not.toHaveBeenCalled();
});
it('stops before the next family when measured raw bytes exhaust the shared budget', async () => {
  const f = fixture('8387400');
  readers.templates.mockImplementation(async (_tx, _limit, debit) => {
    debit(1000);
    return {};
  });
  await expect(createOperationsV37Repository(f.db).exportAccount(athlete)).rejects.toThrow(
    'EXPORT_TOO_LARGE',
  );
  expect(readers.public).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
it('does not fabricate empty internal data or audit an unavailable reader', async () => {
  const f = fixture();
  readers.internal.mockRejectedValue(new RetainedPersonalExportError('UNSUPPORTED'));
  await expect(createOperationsV37Repository(f.db).exportAccount(athlete)).rejects.toThrow(
    'UNSUPPORTED',
  );
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
it('rejects corrupt final overlap before audit', async () => {
  const f = fixture();
  readers.internal.mockResolvedValue({ manualInternalChains: [] });
  await expect(createOperationsV37Repository(f.db).exportAccount(athlete)).rejects.toThrow();
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
it('maps internal measured-response exhaustion to EXPORT_TOO_LARGE without a success audit', async () => {
  const f = fixture();
  readers.internal.mockImplementation(async (_tx, _limit, debit) => {
    debit(8388608);
    return {};
  });
  await expect(createOperationsV37Repository(f.db).exportAccount(athlete)).rejects.toThrow(
    'EXPORT_TOO_LARGE',
  );
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
it('propagates audit failure inside the snapshot operation rather than returning success', async () => {
  const f = fixture();
  const original = f.query.getMockImplementation();
  if (!original) throw Error('QUERY_REQUIRED');
  f.query.mockImplementation(async (sql) => {
    if (sql.includes('INSERT INTO operations_audit')) throw Error('AUDIT_WRITE_FAILED');
    return original(sql);
  });
  await expect(createOperationsV37Repository(f.db).exportAccount(athlete)).rejects.toThrow(
    'AUDIT_WRITE_FAILED',
  );
  expect(readers.internal).toHaveBeenCalledTimes(1);
});
