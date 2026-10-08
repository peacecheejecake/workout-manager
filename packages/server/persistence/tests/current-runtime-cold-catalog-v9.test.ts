import { describe, expect, it, vi } from 'vitest';
import type { CurrentRuntimeCatalogMetadataV3 } from '../src/current-runtime-catalog-witness-v3.js';
import { currentRuntimeCatalogMetadataQueryV3 } from '../src/current-runtime-catalog-witness-v3.js';
import { buildCurrentRuntimeCatalogWitnessV9 } from '../src/current-runtime-catalog-witness-v9.js';
import {
  observeCurrentRuntimeColdCatalogV9In,
  currentRuntimeColdCatalogQueryV9,
} from '../src/current-runtime-cold-catalog-v9.js';
const control = vi.hoisted(() => ({ expected: undefined as unknown }));
vi.mock('../src/current-runtime-compiled-expected-v9.js', () => ({
  get currentRuntimeCompiledExpectedV9() {
    return control.expected;
  },
}));
const namespaces = [
  'garmin_private',
  'identity_private',
  'public',
  'wm_app_load',
  'wm_check_in_templates_v1',
  'wm_manual_pooled',
  'wm_runtime_installation',
];
function metadata(): CurrentRuntimeCatalogMetadataV3 {
  const role = (tag: string) => ({
    tag,
    superuser: false,
    bypassRls: false,
    createRole: false,
    createDb: false,
    inherit: true,
    login: true,
    replication: false,
    configurationSha256: null,
  });
  return {
    serverVersion: '170006',
    schemas: namespaces.map((name) => ({
      name,
      owner: 'owner',
      acl: [],
      runtimeUsage: name === 'public',
      runtimeCreate: false,
    })),
    functions: [],
    relations: [],
    defaultPrivileges: [],
    roles: [role('owner'), role('runtime')],
    memberships: [],
    extensions: [],
    types: [],
    collations: [],
    dependencies: [],
    typeDetails: [],
    functionDetails: [],
    relationDetails: [],
    operators: [],
    casts: [],
    languages: [],
    accessMethods: [],
    eventTriggers: [],
    foreignWrappers: [],
    foreignServers: [],
    foreignTables: [],
    userMappings: [],
    operatorClasses: [],
    operatorFamilies: [],
    aggregates: [],
    transforms: [],
    additionalDependencies: [],
    sharedDependencies: [],
  };
}
function fixture() {
  const body = metadata();
  const witness = buildCurrentRuntimeCatalogWitnessV9(body);
  control.expected = {
    recognizedNamespaces: namespaces,
    metadataEncoding: witness.metadataEncoding,
    profileVersion: 9,
    runtimeStep: 25,
    sourceDdlTip: 142,
    catalogSha256: witness.catalogSha256,
    sections: witness.sections,
  };
  const context: Record<string, unknown> = {
    runtimeRole: 'cold_runtime',
    safe: true,
    ownerSafe: true,
    ownerBound: true,
    privateDenied: true,
    readOnly: true,
    pathSafe: true,
    locksHeld: true,
    isolation: 'repeatable read',
    roleCount: 20,
  };
  const counts: Record<string, unknown> = {
    functions: 664,
    relations: 704,
    types: 478,
    maxSourceBytes: 10000,
  };
  const observed: Record<string, unknown> = {
    bytes: String(Buffer.byteLength(JSON.stringify(body))),
    sha256: 'a'.repeat(64),
    metadata: body,
  };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith('WITH owner AS')
      ? [context]
      : sql.startsWith('SELECT\n')
        ? [counts]
        : sql.startsWith('SET LOCAL')
          ? []
          : [observed],
    rowCount: 1,
  }));
  return { body, context, counts, observed, query };
}
describe('actual runtime whole catalog observer', () => {
  it('changes exactly two compiled owner anchors, preserving every other query byte', () => {
    const original = currentRuntimeColdCatalogQueryV9
      .replace(
        'SELECT (SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database()) AS oid UNION SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1',
        'SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(session_user,$1)',
      )
      .replace(
        "CASE WHEN r.oid=(SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database()) THEN 'owner'",
        "CASE WHEN rolname=session_user THEN 'owner'",
      );
    expect(original).toBe(currentRuntimeCatalogMetadataQueryV3);
  });
  it('uses its actual runtime identity and full typed metadata without private receipt reads', async () => {
    const f = fixture();
    const r = await observeCurrentRuntimeColdCatalogV9In(f);
    expect(r).toMatchObject({
      catalog: 'verified',
      reason: 'matched',
      supported: false,
      processingAuthority: 'none',
      installationReceiptRows: 'not_observed_by_runtime',
      restore: 'not_verified',
    });
    expect(f.query.mock.calls).toHaveLength(4);
    expect(f.query.mock.calls.flat().join(' ')).not.toMatch(
      /SELECT .*FROM wm_runtime_installation|verifyCurrentRuntime/,
    );
  });
  for (const field of [
    'safe',
    'ownerSafe',
    'ownerBound',
    'privateDenied',
    'readOnly',
    'pathSafe',
    'locksHeld',
  ])
    it(`rejects ${field} before catalog read`, async () => {
      const f = fixture();
      f.context[field] = false;
      expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
        catalog: 'incompatible',
        reason: 'context_required',
      });
      expect(f.query).toHaveBeenCalledTimes(1);
    });
  it('rejects RC and foreign context fields', async () => {
    const f = fixture();
    f.context['isolation'] = 'read committed';
    f.context['callerExpected'] = true;
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      reason: 'context_required',
    });
  });
  it('rejects scalar/body underreport without authenticating supplied SQL hash', async () => {
    const f = fixture();
    f.observed['bytes'] = '1';
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      reason: 'invalid_response',
    });
  });
  it('rejects oversized withheld catalog', async () => {
    const f = fixture();
    f.observed['bytes'] = '16777217';
    f.observed['metadata'] = null;
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({ reason: 'limit' });
  });
  it('rejects changed whole metadata with preserved SQL hash', async () => {
    const f = fixture();
    const schema = f.body.schemas[0];
    if (!schema) throw new Error('fixture schema absent');
    schema.runtimeCreate = true;
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      reason: 'catalog_mismatch',
    });
  });
  it('checks section facts even when whole hash matches', async () => {
    const f = fixture();
    const w = buildCurrentRuntimeCatalogWitnessV9(f.body);
    control.expected = {
      recognizedNamespaces: namespaces,
      metadataEncoding: w.metadataEncoding,
      profileVersion: 9,
      runtimeStep: 25,
      sourceDdlTip: 142,
      catalogSha256: w.catalogSha256,
      sections: w.sections.map((v) => ({ ...v, rowCount: v.rowCount + 1 })),
    };
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      reason: 'catalog_mismatch',
    });
  });
  it('closes malformed metadata and scalar bounds', async () => {
    const f = fixture();
    f.observed['metadata'] = { privateCredential: 'sentinel' };
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      catalog: 'incompatible',
      reason: 'invalid_response',
    });
  });
  it('sanitizes SQL errors and performs no fallback', async () => {
    fixture();
    const query = vi.fn().mockRejectedValue({ code: '42501', message: 'secret SQL body' });
    const r = await observeCurrentRuntimeColdCatalogV9In({ query });
    expect(r).toMatchObject({ catalog: 'unavailable', reason: 'query_unavailable' });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('missing compiled asset closes before any SQL', async () => {
    const f = fixture();
    control.expected = null;
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      reason: 'expected_asset_invalid',
    });
    expect(f.query).not.toHaveBeenCalled();
  });
  it('bounds actual source/catalog census before body query', async () => {
    const f = fixture();
    f.counts['functions'] = 5001;
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({ reason: 'limit' });
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('missing scalar and unknown envelope fields are closed', async () => {
    const f = fixture();
    f.observed['privateSource'] = 'not outward';
    delete f.observed['bytes'];
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      reason: 'invalid_response',
    });
  });
  it('getter is never evaluated by untrusted metadata guard', async () => {
    const f = fixture();
    let accessed = false;
    Object.defineProperty(f.observed, 'metadata', {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error('sentinel');
      },
    });
    const r = await observeCurrentRuntimeColdCatalogV9In(f);
    expect(r.catalog).not.toBe('verified');
    expect(accessed).toBe(false);
  });
  it('malformed typed body cannot turn context booleans into catalog verification', async () => {
    const f = fixture();
    f.observed['metadata'] = { supported: true, metadata: f.body };
    expect((await observeCurrentRuntimeColdCatalogV9In(f)).catalog).not.toBe('verified');
  });
  it('recognizes exact compiled pooled namespace while preserving historical classifier', async () => {
    const f = fixture();
    expect(buildCurrentRuntimeCatalogWitnessV9(f.body).unknownNamespaces).toEqual([
      'wm_manual_pooled',
    ]);
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({ catalog: 'verified' });
  });
  it('rejects future unknown namespace even with forged mock matching whole hash and sections', async () => {
    const f = fixture();
    f.body.schemas.push({
      name: 'wm_future_unapproved',
      owner: 'owner',
      acl: [],
      runtimeUsage: false,
      runtimeCreate: false,
    });
    const w = buildCurrentRuntimeCatalogWitnessV9(f.body);
    control.expected = {
      recognizedNamespaces: namespaces,
      metadataEncoding: w.metadataEncoding,
      profileVersion: 9,
      runtimeStep: 25,
      sourceDdlTip: 142,
      catalogSha256: w.catalogSha256,
      sections: w.sections,
    };
    f.observed['bytes'] = String(Buffer.byteLength(JSON.stringify(f.body)));
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      catalog: 'incompatible',
      reason: 'catalog_mismatch',
    });
  });
  it('rejects missing known namespace even with forged mock hashes', async () => {
    const f = fixture();
    f.body.schemas = f.body.schemas.filter((v) => v.name !== 'wm_manual_pooled');
    const w = buildCurrentRuntimeCatalogWitnessV9(f.body);
    control.expected = {
      recognizedNamespaces: namespaces,
      metadataEncoding: w.metadataEncoding,
      profileVersion: 9,
      runtimeStep: 25,
      sourceDdlTip: 142,
      catalogSha256: w.catalogSha256,
      sections: w.sections,
    };
    expect(await observeCurrentRuntimeColdCatalogV9In(f)).toMatchObject({
      reason: 'catalog_mismatch',
    });
  });
});
