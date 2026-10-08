import { beforeEach, expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import {
  createOperationsV36Repository,
  createOperationsV37Repository,
  createOperationsV38Repository,
} from '../src/operations.js';
import type * as RetainedExport from '../src/retained-personal-export.js';
import { RetainedPersonalExportError } from '../src/retained-personal-export.js';

const readers = vi.hoisted(() => ({
  templates: vi.fn(),
  public: vi.fn(),
  internal: vi.fn(),
  source: vi.fn(),
}));
vi.mock('../src/retained-personal-export.js', async (original) => ({
  ...(await original<typeof RetainedExport>()),
  readCheckInTemplatePersonalExportV1In: readers.templates,
  readRaceManualPersonalExportV1In: readers.public,
}));
vi.mock('../src/race-manual-internal-personal-export-reader.js', () => ({
  readRaceManualInternalPersonalExportV1In: readers.internal,
}));
vi.mock('../src/manual-source-personal-export.js', () => ({
  readManualSourcePersonalExportV1In: readers.source,
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
  readers.source.mockImplementation(async (_tx, _limit, debit) => {
    debit(400);
    debit(500);
    return {
      schemaVersion: 1,
      sourceProvenanceCoverage: 'saved_safe_dependency_facts',
      sourceAuthentication: 'not_authenticated',
      originalEventAuthentication: 'not_authenticated',
      manualSourceChains: [],
      manualSavedSourceRefs: [],
      manualSavedSourceParents: [],
      manualSavedSourceSuppressions: [],
      nutritionDisconnectionOrigins: [],
      nutritionDisconnectionLineage: [],
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
  const value = await createOperationsV38Repository(f.db).exportAccount(athlete);
  expect(value.schemaVersion).toBe(38);
  expect(value.data.sourceProvenanceCoverage).toBe('saved_safe_dependency_facts');
  expect(f.snapshotTenant).toHaveBeenCalledTimes(1);
  expect(f.tenant).not.toHaveBeenCalled();
  const calls = [readers.templates, readers.public, readers.internal, readers.source].map(
    (reader) => reader.mock.calls[0],
  );
  expect(calls.map((call) => call?.[0])).toEqual([f.tx, f.tx, f.tx, f.tx]);
  expect(calls.map((call) => call?.[1])).toEqual([
    8388608 - 1026,
    8388608 - 1126,
    8388608 - 1326,
    8388608 - 1626,
  ]);
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
  expect(() => createOperationsV38Repository(db).exportAccount(athlete)).toThrow(
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
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow(
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
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow(
    'UNSUPPORTED',
  );
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
it('rejects corrupt final overlap before audit', async () => {
  const f = fixture();
  readers.internal.mockResolvedValue({ manualInternalChains: [] });
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow();
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
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow(
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
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow(
    'AUDIT_WRITE_FAILED',
  );
  expect(readers.internal).toHaveBeenCalledTimes(1);
});

it('preserves V37 without invoking the provenance reader', async () => {
  const result = await createOperationsV37Repository(fixture().db).exportAccount(athlete);
  expect(result.schemaVersion).toBe(37);
  expect(result.data.sourceProvenanceCoverage).toBe('not_exported_policy_unresolved');
  expect(readers.source).not.toHaveBeenCalled();
});
it('rejects unsupported provenance and never audits partial output', async () => {
  const f = fixture();
  readers.source.mockRejectedValue(new RetainedPersonalExportError('UNSUPPORTED'));
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow(
    'UNSUPPORTED',
  );
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
it('charges both source RPC responses before output validation and rejects exhaustion', async () => {
  const f = fixture();
  readers.source.mockImplementation(async (_tx, limit, debit) => {
    debit(limit - 1);
    debit(2);
    throw Error('UNREACHABLE');
  });
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow(
    'EXPORT_TOO_LARGE',
  );
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
it('rejects an invented source census for an absent internal chain before audit', async () => {
  const f = fixture();
  const source = await readers.source(f.tx, 8388608, () => {});
  readers.source.mockResolvedValue({
    ...source,
    manualSourceChains: [
      {
        evidenceId: athlete,
        decisionId: athlete,
        proposalId: athlete,
        savedRefCount: 1,
        savedParentCount: 0,
        savedSuppressionCount: 0,
        body: { state: 'present' },
      },
    ],
  });
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow();
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
it('never accepts a missing required provenance collection as an empty roster', async () => {
  const f = fixture();
  readers.source.mockResolvedValue({
    sourceProvenanceCoverage: 'saved_safe_dependency_facts',
    sourceAuthentication: 'not_authenticated',
    originalEventAuthentication: 'not_authenticated',
  });
  await expect(createOperationsV38Repository(f.db).exportAccount(athlete)).rejects.toThrow();
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO operations_audit'))).toBe(
    false,
  );
});
