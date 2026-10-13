import { describe, expect, it } from 'vitest';
import { currentRuntimeCompiledExpectedV11 as v11 } from '../src/current-runtime-compiled-expected-v11.js';
import { currentRuntimeCompiledExpectedV10 as v10 } from '../src/current-runtime-compiled-expected-v10.js';

// Root's profile27 owner observations differ from profile26 by the 143..148 objects (66
// functions incl. the four SQL101 restore functions 147 replaces in place, 48 relations,
// the v11 ledger), the two fixed principals (worker, dispatcher) and their dependency edges.
const changed = [
  'functions',
  'relations',
  'roles',
  'types',
  'dependencies',
  'typeDetails',
  'functionDetails',
  'relationDetails',
  'additionalDependencies',
  'sharedDependencies',
];
describe('compiled profile27 expected asset', () => {
  it('pins exact profile27 literals with the V11 principal encoding and seven namespaces', () => {
    expect(v11).toMatchObject({
      assetVersion: 1,
      metadataEncoding: 'pg-catalog-runtime-security-normalized-v3-principals-v11',
      profileVersion: 11,
      runtimeStep: 27,
      sourceDdlTip: 148,
      catalogSha256: 'd1234cc891e1bf3bba1a439ce5c169f4ec990caee2df2c8446539f8f06e0e133',
      sqlJsonbSha256: 'e2b701eaebb12fef199e7eabcc81e70c548a731f779f6160db2d87695efba7d3',
    });
    expect(v11.recognizedNamespaces).toEqual(v10.recognizedNamespaces);
    expect(v11.principalRoleTags).toEqual(['ai_dispatcher', 'gallery_rendition_worker']);
    expect(v11.provenance).toMatchObject({
      ownerObservations: 2,
      databasesPerObservation: { fresh: 2, upgradedFromProfile26: 1 },
      profile26ControlCatalogSha256: v10.catalogSha256,
      runtimeObservation: 'not_executed',
      dynamicClosure: 'not_verified',
      strictCallerWireClosure: 'not_verified',
    });
    expect(Object.isFrozen(v11)).toBe(true);
    expect(Object.isFrozen(v11.sections)).toBe(true);
    expect(v11.sections.every((s) => Object.isFrozen(s))).toBe(true);
  });
  it('differs from profile26 only in the 143..148/principal sections, all growing', () => {
    expect(v11.catalogSha256).not.toBe(v10.catalogSha256);
    expect(v11.sections.map((s) => s.section)).toEqual(v10.sections.map((s) => s.section));
    const diff = v11.sections.filter(
      (s, i) => JSON.stringify(s) !== JSON.stringify(v10.sections[i]),
    );
    expect(diff.map((s) => s.section)).toEqual(changed);
    const delta = Object.fromEntries(
      diff.map((s) => [
        s.section,
        s.rowCount - (v10.sections.find((p) => p.section === s.section)?.rowCount ?? 0),
      ]),
    );
    expect(delta).toEqual({
      functions: 66,
      functionDetails: 66,
      relations: 48,
      relationDetails: 48,
      roles: 2,
      types: 28,
      typeDetails: 28,
      dependencies: 753,
      additionalDependencies: 28,
      sharedDependencies: 101,
    });
  });
});
