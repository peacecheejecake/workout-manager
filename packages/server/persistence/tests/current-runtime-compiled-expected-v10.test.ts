import { describe, expect, it } from 'vitest';
import { currentRuntimeCompiledExpectedV10 as v10 } from '../src/current-runtime-compiled-expected-v10.js';
import { currentRuntimeCompiledExpectedV9 as v9 } from '../src/current-runtime-compiled-expected-v9.js';

// Root's profile26 owner observations differ from profile25 only by the 146 guard
// function, the race_event trigger, the profile_extension_v10 ledger (table, three
// indexes, two row types) and their dependency edges.
const changed = [
  'functions',
  'relations',
  'types',
  'dependencies',
  'typeDetails',
  'functionDetails',
  'relationDetails',
  'additionalDependencies',
  'sharedDependencies',
];
describe('compiled profile26 expected asset', () => {
  it('pins exact profile26 literals with the normalized-v3 encoding and seven namespaces', () => {
    expect(v10).toMatchObject({
      assetVersion: 1,
      metadataEncoding: 'pg-catalog-runtime-security-normalized-v3',
      profileVersion: 10,
      runtimeStep: 26,
      sourceDdlTip: 146,
      catalogSha256: 'eb61b2d63191eb10e802fbf155a7e1b48f550c6b66bca93d5372d2992f62ee17',
      sqlJsonbSha256: '15de83920213bf1b8292a87b9959ce6b5d880e7600a0e8bab05b812e723f591d',
    });
    expect(v10.recognizedNamespaces).toEqual(v9.recognizedNamespaces);
    expect(v10.provenance).toMatchObject({
      ownerObservations: 2,
      databasesPerObservation: { fresh: 2, upgradedFromProfile25: 1 },
      profile25ControlCatalogSha256: v9.catalogSha256,
      runtimeObservation: 'not_executed',
      dynamicClosure: 'not_verified',
      strictCallerWireClosure: 'not_verified',
    });
    expect(Object.isFrozen(v10)).toBe(true);
    expect(Object.isFrozen(v10.sections)).toBe(true);
    expect(v10.sections.every((s) => Object.isFrozen(s))).toBe(true);
  });
  it('differs from profile25 only in the guard/trigger/ledger sections, all growing', () => {
    expect(v10.catalogSha256).not.toBe(v9.catalogSha256);
    expect(v10.sections.map((s) => s.section)).toEqual(v9.sections.map((s) => s.section));
    const diff = v10.sections.filter(
      (s, i) => JSON.stringify(s) !== JSON.stringify(v9.sections[i]),
    );
    expect(diff.map((s) => s.section)).toEqual(changed);
    const delta = Object.fromEntries(
      diff.map((s) => [
        s.section,
        s.rowCount - (v9.sections.find((p) => p.section === s.section)?.rowCount ?? 0),
      ]),
    );
    expect(delta).toEqual({
      functions: 1,
      functionDetails: 1,
      relations: 4,
      relationDetails: 4,
      types: 2,
      typeDetails: 2,
      dependencies: 26,
      additionalDependencies: 2,
      sharedDependencies: 2,
    });
  });
});
