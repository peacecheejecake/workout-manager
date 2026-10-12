import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createFullRestoreInventoryParserV1,
  FullRestoreInventoryError,
} from '../src/full-restore-inventory-v1.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const empty = digest('[]');
const identity = () => ({
  profileId: 'synthetic_profile',
  normalRegistrySha256: digest('normal'),
  namedProfileSha256: digest('named'),
  catalogSha256: digest('catalog'),
});
const facts = (relation: string) => ({
  schema: 'public',
  relation,
  physicalCodec: 'postgres-row-jsonb-utc-v1',
  columnsSha256: digest(relation),
  orderingKey: ['athlete_id', 'id'],
});
function registry() {
  return {
    schemaVersion: 1,
    identity: identity(),
    maxTotalRows: 3,
    maxTotalBytes: 100,
    targetLocalRelations: [
      'restore_generation',
      'restore_processing_admission',
      'restore_processing_close_receipt',
    ].map((relation) => ({ schema: 'public', relation })),
    relations: ['alpha', 'beta'].map((relation) => ({
      ...facts(relation),
      maxRows: 2,
      maxBytes: 90,
    })),
  };
}
function inventory() {
  return {
    schemaVersion: 1,
    identity: identity(),
    relations: [
      {
        ...facts('alpha'),
        state: 'present',
        rowCount: 1,
        byteLength: 30,
        rowsSha256: digest('[synthetic]'),
      },
      {
        ...facts('beta'),
        state: 'explicit_empty',
        rowCount: 0,
        byteLength: 2,
        rowsSha256: empty,
      },
    ],
  };
}
function fixtureAt<T>(rows: readonly T[], index: number): T {
  const value = rows[index];
  if (value === undefined) throw new Error('INVALID_SYNTHETIC_FIXTURE');
  return value;
}
function parse(value: unknown) {
  return createFullRestoreInventoryParserV1(registry()).parse(value);
}
function rejects(work: () => unknown, code: string) {
  expect(work).toThrow(FullRestoreInventoryError);
  try {
    work();
  } catch (error) {
    expect(error).toMatchObject({ code, message: code });
  }
}

describe('complete relation inventory V1 structural boundary', () => {
  it('validates every exact relation including explicit empty without issuing authority', () => {
    const result = parse(inventory());
    expect(result.kind).toBe('validated_full_restore_inventory_v1');
    expect(result.authority).toBe('none');
    expect(result.admissionAllowed).toBe(false);
    expect(result.totals).toEqual({ rowCount: 1, byteLength: 32 });
    expect(result.inventory.relations.map((row) => row.state)).toEqual([
      'present',
      'explicit_empty',
    ]);
  });
  it('accepts a complete explicitly empty inventory without interpreting zero as missing', () => {
    const raw = inventory(),
      trusted = registry();
    trusted.maxTotalRows = 0;
    raw.relations = raw.relations.map((row) => ({
      ...row,
      state: 'explicit_empty',
      rowCount: 0,
      byteLength: 2,
      rowsSha256: empty,
    }));
    const result = createFullRestoreInventoryParserV1(trusted).parse(raw);
    expect(result.totals).toEqual({ rowCount: 0, byteLength: 4 });
    expect(result.inventory.relations).toHaveLength(2);
    expect(result.admissionAllowed).toBe(false);
  });
  it('takes a detached registry copy and deeply freezes its returned values', () => {
    const trusted = registry(),
      parser = createFullRestoreInventoryParserV1(trusted),
      raw = inventory();
    trusted.identity.catalogSha256 = digest('changed');
    trusted.relations[0]?.orderingKey.push('injected');
    const result = parser.parse(raw);
    raw.identity.catalogSha256 = digest('raw-changed');
    raw.relations[0]?.orderingKey.push('changed');
    expect(result.inventory.identity.catalogSha256).toBe(identity().catalogSha256);
    expect(result.inventory.relations[0]?.orderingKey).toEqual(['athlete_id', 'id']);
    expect(
      [
        result,
        result.inventory,
        result.inventory.identity,
        result.inventory.relations,
        result.inventory.relations[0],
        result.inventory.relations[0]?.orderingKey,
        result.totals,
      ].every(Object.isFrozen),
    ).toBe(true);
  });
  it('rejects changed independent identity pins', () => {
    for (const key of [
      'profileId',
      'normalRegistrySha256',
      'namedProfileSha256',
      'catalogSha256',
    ] as const) {
      const raw = inventory();
      raw.identity[key] = key === 'profileId' ? 'foreign' : digest('foreign');
      rejects(() => parse(raw), 'INVENTORY_IDENTITY_MISMATCH');
    }
  });
  it('rejects missing, extra, duplicate and misordered relations', () => {
    for (const rows of [
      inventory().relations.slice(0, 1),
      [...inventory().relations, { ...inventory().relations[0], relation: 'gamma' }],
      [inventory().relations[0], inventory().relations[0]],
      [...inventory().relations].reverse(),
    ]) {
      rejects(() => parse({ ...inventory(), relations: rows }), 'INVENTORY_RELATION_MISMATCH');
    }
  });
  it('rejects foreign schema, column identity or ordered primary key', () => {
    for (const change of [
      { schema: 'foreign' },
      { columnsSha256: digest('other') },
      { orderingKey: ['id', 'athlete_id'] },
    ]) {
      const raw = inventory();
      raw.relations[0] = { ...fixtureAt(raw.relations, 0), ...change };
      rejects(() => parse(raw), 'INVENTORY_RELATION_MISMATCH');
    }
  });
  it('rejects unknown fields, unsupported codec and malformed digest before accepting inventory', () => {
    for (const change of [
      { physicalCodec: 'caller_codec' },
      { rowsSha256: 'not-a-digest' },
      { rowsSha256: 'A'.repeat(64) },
      { unknown: true },
    ]) {
      const raw = inventory();
      raw.relations[0] = { ...fixtureAt(raw.relations, 0), ...change };
      rejects(() => parse(raw), 'INVALID_FULL_RESTORE_INVENTORY');
    }
    rejects(
      () => parse({ ...inventory(), relationsRegistry: registry().relations }),
      'INVALID_FULL_RESTORE_INVENTORY',
    );
  });
  it('requires exact zero row/byte/digest facts for explicit empty', () => {
    for (const change of [
      { rowCount: 1 },
      { byteLength: 0 },
      { byteLength: 3 },
      { rowsSha256: digest('other') },
    ]) {
      const raw = inventory();
      raw.relations[1] = { ...fixtureAt(raw.relations, 1), ...change };
      rejects(() => parse(raw), 'INVALID_FULL_RESTORE_INVENTORY');
    }
  });
  it('rejects present zero rows or empty encoding facts', () => {
    for (const change of [{ rowCount: 0 }, { byteLength: 2 }, { rowsSha256: empty }]) {
      const raw = inventory();
      raw.relations[0] = { ...fixtureAt(raw.relations, 0), ...change };
      rejects(() => parse(raw), 'INVALID_FULL_RESTORE_INVENTORY');
    }
  });
  it('rejects unsafe integers, negative/fractional/null values and hard bound overflow', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, null, Infinity, 1000001]) {
      const raw = inventory();
      rejects(
        () =>
          parse({
            ...raw,
            relations: [{ ...fixtureAt(raw.relations, 0), rowCount: value }, raw.relations[1]],
          }),
        'INVALID_FULL_RESTORE_INVENTORY',
      );
    }
  });
  it('enforces per-relation and total bounds from the independent registry', () => {
    for (const change of [{ rowCount: 3 }, { byteLength: 91 }]) {
      const raw = inventory();
      raw.relations[0] = { ...fixtureAt(raw.relations, 0), ...change };
      rejects(() => parse(raw), 'INVENTORY_BOUNDS_EXCEEDED');
    }
    const trusted = registry();
    trusted.maxTotalRows = 0;
    rejects(
      () => createFullRestoreInventoryParserV1(trusted).parse(inventory()),
      'INVENTORY_BOUNDS_EXCEEDED',
    );
    trusted.maxTotalRows = 3;
    trusted.maxTotalBytes = 31;
    rejects(
      () => createFullRestoreInventoryParserV1(trusted).parse(inventory()),
      'INVENTORY_BOUNDS_EXCEEDED',
    );
  });
  it('rejects target-local control from both registry and artifact without caller allowlist overrides', () => {
    const trusted = registry();
    trusted.relations[0] = {
      ...fixtureAt(trusted.relations, 0),
      relation: 'restore_generation',
    };
    rejects(() => createFullRestoreInventoryParserV1(trusted), 'INVALID_FULL_RESTORE_REGISTRY');
    const raw = inventory();
    raw.relations[0] = {
      ...fixtureAt(raw.relations, 0),
      relation: 'restore_generation',
    };
    rejects(() => parse(raw), 'INVENTORY_RELATION_MISMATCH');
    rejects(
      () => parse({ ...inventory(), targetLocalRelations: [] }),
      'INVALID_FULL_RESTORE_INVENTORY',
    );
    const excluded = registry();
    excluded.targetLocalRelations.push({
      schema: 'public',
      relation: 'z_control',
    });
    excluded.relations[1] = {
      ...fixtureAt(excluded.relations, 1),
      relation: 'z_control',
    };
    rejects(() => createFullRestoreInventoryParserV1(excluded), 'INVALID_FULL_RESTORE_REGISTRY');
  });
  it('rejects invalid registry order, exclusions, codec, bounds and duplicate key identity', () => {
    for (const trusted of [
      { ...registry(), relations: [...registry().relations].reverse() },
      { ...registry(), targetLocalRelations: [] },
      { ...registry(), maxTotalRows: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...registry(),
        relations: [{ ...registry().relations[0], physicalCodec: 'unknown' }],
      },
      {
        ...registry(),
        relations: [{ ...registry().relations[0], orderingKey: ['id', 'id'] }],
      },
    ]) {
      rejects(() => createFullRestoreInventoryParserV1(trusted), 'INVALID_FULL_RESTORE_REGISTRY');
    }
  });
  it('rejects accessors, cycles, sparse arrays and oversized metadata without reading getters', () => {
    const raw = inventory(),
      getter = vi.fn(() => identity());
    Object.defineProperty(raw, 'identity', { enumerable: true, get: getter });
    rejects(() => parse(raw), 'INVALID_FULL_RESTORE_INVENTORY');
    expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    rejects(() => parse(cycle), 'INVALID_FULL_RESTORE_INVENTORY');
    const sparse = new Array(2);
    rejects(() => parse({ ...inventory(), relations: sparse }), 'INVALID_FULL_RESTORE_INVENTORY');
    rejects(
      () => parse({ ...inventory(), huge: 'x'.repeat(1048577) }),
      'INVALID_FULL_RESTORE_INVENTORY',
    );
  });
});
