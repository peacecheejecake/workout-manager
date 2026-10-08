import { beforeEach, expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import { createOperationsV38BatchRepository } from '../src/operations.js';
import type * as RetainedExport from '../src/retained-personal-export.js';
import { RetainedPersonalExportError } from '../src/retained-personal-export.js';

// Composer boundary tests. Real SQL ownership/tuple/census acceptance is separate PG evidence.
const readers = vi.hoisted(() => ({
  templates: vi.fn(),
  public: vi.fn(),
  batch: vi.fn(),
  internal: vi.fn(),
  source: vi.fn(),
}));
vi.mock('../src/retained-personal-export.js', async (original) => ({
  ...(await original<typeof RetainedExport>()),
  readCheckInTemplatePersonalExportV1In: readers.templates,
  readRaceManualPersonalExportV1In: readers.public,
}));
vi.mock('../src/manual-retained-source-export-batch-reader.js', () => ({
  readManualRetainedSourceExportBatchV1In: readers.batch,
}));
vi.mock('../src/race-manual-internal-personal-export-reader.js', () => ({
  readRaceManualInternalPersonalExportV1In: readers.internal,
}));
vi.mock('../src/manual-source-personal-export.js', () => ({
  readManualSourcePersonalExportV1In: readers.source,
}));
const athlete = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const maximum = 8388608;
function emptyBatch() {
  return {
    internal: {
      schemaVersion: 1,
      sourceProvenanceCoverage: 'not_exported_policy_unresolved',
      manualInternalChains: [],
      manualInternalCandidates: [],
      manualInternalApprovalResults: [],
      manualInternalApprovalHistory: [],
    },
    sources: {
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
    },
  };
}
function fixture(baseBytes = '2', data: Record<string, Record<string, string>[]> = {}) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('WITH base AS MATERIALIZED') ? [{ ok: true, bytes: baseBytes, data }] : [],
    rowCount: null,
  }));
  const tx: Transaction = { athleteId: athlete, query };
  const tenant = vi.fn(() => {
    throw Error('RC_FORBIDDEN');
  });
  const snapshotTenant = vi.fn();
  const outcome = vi.fn();
  const db: Database = {
    tenant,
    exclusiveTenant: tenant,
    snapshotTenant: async (id, operation) => {
      snapshotTenant(id);
      try {
        const result = await operation(tx);
        outcome('commit');
        return result;
      } catch (error) {
        outcome('rollback');
        throw error;
      }
    },
    close: async () => {},
  };
  const audits = () =>
    query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO operations_audit'));
  return { db, tx, query, tenant, snapshotTenant, outcome, audits };
}
beforeEach(() => {
  vi.resetAllMocks();
  readers.internal.mockImplementation(() => {
    throw Error('LEGACY_INTERNAL_FORBIDDEN');
  });
  readers.source.mockImplementation(() => {
    throw Error('LEGACY_SOURCE_FORBIDDEN');
  });
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
  readers.batch.mockImplementation(async (_tx, _limit, debit) => {
    // One measured batch wrapper and the separate nutrition response, both same callback.
    debit(300);
    debit(400);
    return emptyBatch();
  });
});
it('selects batch once in one fenced snapshot, reuses one debit callback and audits the strict V38 result once', async () => {
  const f = fixture();
  const result = await createOperationsV38BatchRepository(f.db).exportAccount(athlete);
  expect(result.schemaVersion).toBe(38);
  expect(result.data.sourceProvenanceCoverage).toBe('saved_safe_dependency_facts');
  expect(result.data.manualInternalChains).toEqual([]);
  expect(result.data.manualSavedSourceRefs).toEqual([]);
  expect(f.snapshotTenant).toHaveBeenCalledExactlyOnceWith(athlete);
  expect(f.tenant).not.toHaveBeenCalled();
  const calls = [readers.templates, readers.public, readers.batch].map(
    (reader) => reader.mock.calls[0],
  );
  expect(calls.map((call) => call?.[0])).toEqual([f.tx, f.tx, f.tx]);
  expect(calls.map((call) => call?.[1])).toEqual([maximum - 1026, maximum - 1126, maximum - 1326]);
  expect(calls[0]?.[2]).toBe(calls[1]?.[2]);
  expect(calls[1]?.[2]).toBe(calls[2]?.[2]);
  expect(readers.internal).not.toHaveBeenCalled();
  expect(readers.source).not.toHaveBeenCalled();
  expect(f.query.mock.calls[0]?.[0]).toContain('hashtextextended($1,0)');
  expect(f.query.mock.calls[1]?.[0]).toContain('hashtextextended($1,77209)');
  expect(f.audits()).toHaveLength(1);
  expect(f.query.mock.calls.at(-1)?.[0]).toContain('INSERT INTO operations_audit');
  expect(f.outcome).toHaveBeenCalledExactlyOnceWith('commit');
});
it('requires the actual snapshot port before any queries or readers', () => {
  const f = fixture();
  const { snapshotTenant: _snapshot, ...db } = f.db;
  expect(() => createOperationsV38BatchRepository(db).exportAccount(athlete)).toThrow(
    'OPERATIONS_SNAPSHOT_REQUIRED',
  );
  expect(f.query).not.toHaveBeenCalled();
  expect(readers.batch).not.toHaveBeenCalled();
});
it.each(['UNSUPPORTED', 'CORRUPT', 'TOO_LARGE'] as const)(
  'rejects batch %s with no legacy fallback or audit and propagates callback rollback',
  async (code) => {
    const f = fixture();
    readers.batch.mockRejectedValue(new RetainedPersonalExportError(code));
    await expect(createOperationsV38BatchRepository(f.db).exportAccount(athlete)).rejects.toThrow(
      code === 'TOO_LARGE' ? 'EXPORT_TOO_LARGE' : code,
    );
    expect(readers.internal).not.toHaveBeenCalled();
    expect(readers.source).not.toHaveBeenCalled();
    expect(f.audits()).toHaveLength(0);
    expect(f.outcome).toHaveBeenCalledExactlyOnceWith('rollback');
  },
);
it('propagates an unrelated batch SQL failure without fallback or a success audit', async () => {
  const f = fixture();
  const failure = Error('SYNTHETIC_SQL_FAILURE');
  readers.batch.mockRejectedValue(failure);
  await expect(createOperationsV38BatchRepository(f.db).exportAccount(athlete)).rejects.toBe(
    failure,
  );
  expect(readers.internal).not.toHaveBeenCalled();
  expect(readers.source).not.toHaveBeenCalled();
  expect(f.audits()).toHaveLength(0);
});
it('charges both batch response measurements monotonically and stops on the second debit before parsing or audit', async () => {
  const f = fixture();
  const afterDebit = vi.fn();
  readers.batch.mockImplementation(async (_tx, remaining, debit) => {
    expect(remaining).toBe(maximum - 1326);
    debit(remaining - 1);
    debit(1);
    afterDebit();
    return emptyBatch();
  });
  await expect(createOperationsV38BatchRepository(f.db).exportAccount(athlete)).rejects.toThrow(
    'EXPORT_TOO_LARGE',
  );
  expect(afterDebit).not.toHaveBeenCalled();
  expect(f.audits()).toHaveLength(0);
});
it('never dispatches batch when earlier raw responses exhaust the shared budget', async () => {
  const f = fixture('8387400');
  readers.templates.mockImplementation(async (_tx, _limit, debit) => {
    debit(1000);
    return {};
  });
  await expect(createOperationsV38BatchRepository(f.db).exportAccount(athlete)).rejects.toThrow(
    'EXPORT_TOO_LARGE',
  );
  expect(readers.public).not.toHaveBeenCalled();
  expect(readers.batch).not.toHaveBeenCalled();
  expect(f.audits()).toHaveLength(0);
});
it('rejects missing required batch families without manufacturing empty collections', async () => {
  const f = fixture();
  readers.batch.mockResolvedValue({ internal: {}, sources: {} });
  await expect(createOperationsV38BatchRepository(f.db).exportAccount(athlete)).rejects.toThrow();
  expect(readers.internal).not.toHaveBeenCalled();
  expect(readers.source).not.toHaveBeenCalled();
  expect(f.audits()).toHaveLength(0);
});
it('rejects an invented saved-source census for an absent internal chain before audit', async () => {
  const f = fixture();
  const batch = emptyBatch();
  readers.batch.mockResolvedValue({
    ...batch,
    sources: {
      ...batch.sources,
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
    },
  });
  await expect(createOperationsV38BatchRepository(f.db).exportAccount(athlete)).rejects.toThrow();
  expect(f.audits()).toHaveLength(0);
});
it('rejects a final UTF8 oversized artifact before success audit even if a dishonest base driver reports small bytes', async () => {
  const text = '한'.repeat(3 * 1024 * 1024);
  expect(text.length).toBeLessThan(maximum);
  expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(maximum);
  const f = fixture('2', { activities: [{ note: text }] });
  await expect(createOperationsV38BatchRepository(f.db).exportAccount(athlete)).rejects.toThrow();
  expect(readers.batch).toHaveBeenCalledTimes(1);
  expect(f.audits()).toHaveLength(0);
  expect(f.outcome).toHaveBeenCalledExactlyOnceWith('rollback');
});
it('never returns success when the audit write fails inside the snapshot operation', async () => {
  const f = fixture();
  const original = f.query.getMockImplementation();
  if (!original) throw Error('QUERY_REQUIRED');
  f.query.mockImplementation(async (sql) => {
    if (sql.includes('INSERT INTO operations_audit')) throw Error('AUDIT_WRITE_FAILED');
    return original(sql);
  });
  await expect(createOperationsV38BatchRepository(f.db).exportAccount(athlete)).rejects.toThrow(
    'AUDIT_WRITE_FAILED',
  );
  expect(f.audits()).toHaveLength(1);
  expect(f.outcome).toHaveBeenCalledExactlyOnceWith('rollback');
});
