import { describe, it, expect, vi } from 'vitest';
import { currentRuntimeRpcSourcePins } from '../src/current-runtime-grants.js';
import {
  probeCurrentRuntimeSupportIn,
  validateCurrentRuntimeSupportEvidence,
  currentRuntimeSupportMissingClosure,
} from '../src/current-runtime-support.js';

function observed() {
  return {
    runtime_safe: true,
    owner_safe: true,
    private_ledger_access: false,
    public_schema_usage: true,
    relation_count: 23,
    versioned_occurrence_constraint: true,
    target_transform_present: false,
    roots: currentRuntimeRpcSourcePins.map((p, index) => ({
      ordinal: index + 1,
      signature: p.signature,
      present: true,
      owned: true,
      language: String(p.language),
      result_type: String(p.result_type),
      security_definer: p.security_definer,
      volatility: String(p.volatility),
      source_sha256: String(p.prosrcSha256),
      configuration: p.configuration.map(String),
      public_execute: false,
      executable: true,
    })),
  };
}
function absent() {
  return {
    ...observed(),
    relation_count: 0,
    versioned_occurrence_constraint: false,
    roots: currentRuntimeRpcSourcePins.map((p, index) => ({
      ordinal: index + 1,
      signature: p.signature,
      present: false,
      owned: false,
      language: null,
      result_type: null,
      security_definer: null,
      volatility: null,
      source_sha256: null,
      configuration: null,
      public_execute: false,
      executable: false,
    })),
  };
}
describe('cold root evidence remains closed until actual transitive closure', () => {
  it('exact26 metadata/grants never enables support or advertises full catalog/restore', () => {
    expect(validateCurrentRuntimeSupportEvidence(observed())).toEqual({
      state: 'incompatible',
      reason: 'required_closure_not_verified',
      supported: false,
      rootEvidence: 'verified',
      missingClosure: [...currentRuntimeSupportMissingClosure],
      catalogSecurity: 'not_verified',
      restore: 'not_verified',
      processingAuthority: 'none',
    });
  });
  it('all new objects absent is unsupported, not an installation107 checksum claim', () => {
    expect(validateCurrentRuntimeSupportEvidence(absent())).toMatchObject({
      state: 'unsupported',
      rootEvidence: 'absent',
      supported: false,
    });
  });
  it.each([
    'runtime_safe',
    'owner_safe',
    'private_ledger_access',
    'target_transform_present',
  ] as const)('fails closed on %s', (field) => {
    const row = observed();
    row[field] = field === 'private_ledger_access' || field === 'target_transform_present';
    expect(validateCurrentRuntimeSupportEvidence(row).state).toBe('incompatible');
  });
  it.each([0, 22])(
    'partial relation roster %i stays incompatible even when26 roots match',
    (count) => {
      expect(
        validateCurrentRuntimeSupportEvidence({ ...observed(), relation_count: count }).reason,
      ).toBe('partial_installation');
    },
  );
  it('121 absent or artifacts without roots are partial installation', () => {
    expect(
      validateCurrentRuntimeSupportEvidence({
        ...observed(),
        versioned_occurrence_constraint: false,
      }).reason,
    ).toBe('partial_installation');
    expect(validateCurrentRuntimeSupportEvidence({ ...absent(), relation_count: 1 }).reason).toBe(
      'partial_installation',
    );
  });
  it.each([
    'owned',
    'public_execute',
    'source_sha256',
    'configuration',
    'language',
    'security_definer',
    'result_type',
    'volatility',
  ] as const)('rejects root %s drift', (field) => {
    const row = observed(),
      r = row.roots[0];
    if (!r) throw new Error('fixture');
    switch (field) {
      case 'owned':
        r.owned = false;
        break;
      case 'public_execute':
        r.public_execute = true;
        break;
      case 'source_sha256':
        r.source_sha256 = '0'.repeat(64);
        break;
      case 'configuration':
        r.configuration = ['search_path=public'];
        break;
      case 'language':
        r.language = 'sql';
        break;
      case 'security_definer':
        r.security_definer = !r.security_definer;
        break;
      case 'result_type':
        r.result_type = 'text';
        break;
      case 'volatility':
        r.volatility = 'i';
        break;
    }
    expect(validateCurrentRuntimeSupportEvidence(row).reason).toBe('root_metadata_mismatch');
  });
  it('effective EXECUTE/schema USAGE cannot be replaced by deployment receipt', () => {
    const row = observed(),
      r = row.roots[0];
    if (!r) throw new Error('fixture');
    r.executable = false;
    expect(validateCurrentRuntimeSupportEvidence(row).reason).toBe('root_privilege_missing');
    expect(
      validateCurrentRuntimeSupportEvidence({ ...observed(), public_schema_usage: false }).reason,
    ).toBe('root_privilege_missing');
  });
  it('duplicate/reordered/missing root or extra authority field is invalid evidence', () => {
    const row = observed();
    row.roots.reverse();
    for (const input of [
      row,
      { ...observed(), roots: [] },
      { ...observed(), supported: true },
      { ...observed(), installation: { runtimeStep: 17 } },
      { ...observed(), closure: 'verified' },
    ])
      expect(validateCurrentRuntimeSupportEvidence(input).reason).toBe('catalog_evidence_invalid');
  });
  it('absence with claimed hash or EXECUTE is malformed, not baseline fallback', () => {
    const row = absent(),
      r = row.roots[0];
    if (!r) throw new Error('fixture');
    r.executable = true;
    expect(validateCurrentRuntimeSupportEvidence(row).reason).toBe('catalog_evidence_invalid');
  });
  it('rejects getters without executing, cycles, exotic prototypes, holes and oversized strings/keys', () => {
    const getter = vi.fn(),
      input = Object.defineProperty({}, 'roots', { enumerable: true, get: getter });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = observed();
    sparse.roots.length += 1;
    for (const raw of [
      input,
      cyclic,
      new Date(),
      sparse,
      { huge: 'x'.repeat(131073) },
      { ['k'.repeat(131073)]: null },
      { ...observed(), n: NaN },
    ])
      expect(validateCurrentRuntimeSupportEvidence(raw).state).toBe('unavailable');
    expect(getter).not.toHaveBeenCalled();
  });
  it('output diagnostics never copy raw catalog hashes or secrets', () => {
    const output = validateCurrentRuntimeSupportEvidence(observed());
    expect(JSON.stringify(output)).not.toContain(currentRuntimeRpcSourcePins[0]?.prosrcSha256);
    expect(Object.keys(output)).not.toContain('roots');
  });
  it('probe uses only one finite catalog observation and no ledger/source rows, RPC/install/role writes', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [observed()],
      rowCount: 1,
    }));
    const result = await probeCurrentRuntimeSupportIn({ query });
    expect(result.supported).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(sql).toContain('pg_catalog.pg_proc');
    expect(sql).not.toMatch(/FROM\s+(public\.|wm_runtime_installation\.)/i);
    expect(sql).not.toMatch(
      /\b(GRANT|SET ROLE|set_config|INSERT INTO|CREATE|pg_control_system)\b/i,
    );
    expect(values).toEqual([
      currentRuntimeRpcSourcePins.map((p) => p.signature),
      expect.any(Array),
    ]);
  });
  it('query failure is contentless unavailable, without fallback or raw error echo', async () => {
    const query = vi.fn(async () => {
      throw new Error('synthetic secret payload');
    });
    const output = await probeCurrentRuntimeSupportIn({ query });
    expect(output.reason).toBe('catalog_query_failed');
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output)).not.toContain('secret');
  });
  it('malformed scalar responses or multiple catalog rows never become support', async () => {
    for (const rows of [[], [observed(), observed()], [{ ...observed(), relation_count: '23' }]]) {
      const output = await probeCurrentRuntimeSupportIn({
        query: async () => ({ rows, rowCount: rows.length }),
      });
      expect(output.reason).toBe('catalog_evidence_invalid');
    }
  });
});
