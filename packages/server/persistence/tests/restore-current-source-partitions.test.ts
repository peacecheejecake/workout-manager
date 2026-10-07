import { expect, it } from 'vitest';
import {
  currentSourceExtraPhysicalRoster,
  currentSourceExtraRelations,
  parseCurrentSourceExtraPhysicalRows,
  parseCurrentSourcePhysicalPartitions,
  currentSourceExtraDisposition,
  currentSourceExtraPhysicalRowsSha256,
  type CurrentSourceExtraRelation,
} from '../src/restore-current-source-partitions.js';
import { encodeRestoreSuppressionPhysicalRowV7 } from '../src/restore-suppression-physical-row-v7.js';
const id = 'abcdefab-abcd-7abc-8abc-000000000001',
  other = 'abcdefab-abcd-7abc-8abc-000000000002';
const at = '2026-10-08T01:02:03.123456Z';
// Synthetic physical type fixtures, NOT SQL CHECK/FK/trigger/domain/source evidence.
function fixture(relation: CurrentSourceExtraRelation) {
  const def = currentSourceExtraPhysicalRoster[relation];
  const row: Record<string, unknown> = {};
  const layouts: Record<string, unknown> = {};
  for (const c of def.columns) {
    if (c.nullable) row[c.name] = null;
    else
      switch (c.type) {
        case 'text':
          row[c.name] = 'opaque 한글\\"';
          break;
        case 'uuid':
          row[c.name] = id;
          break;
        case 'timestamp with time zone':
          row[c.name] = at;
          break;
        case 'integer':
          row[c.name] = 1;
          break;
        case 'jsonb':
          row[c.name] = { unknown: null, zero: 0, ordered: ['b', 'a'] };
          break;
        case 'boolean':
          row[c.name] = false;
          break;
        case 'bigint':
          row[c.name] = '9223372036854775807';
          break;
        case 'double precision':
          row[c.name] = 1.25;
          break;
        case 'date':
          row[c.name] = '2026-10-08';
          break;
        case 'uuid[]':
          row[c.name] = [id];
          break;
        case 'inet[]':
          row[c.name] = ['192.0.2.1'];
          break;
      }
  }
  for (const name of def.arrayColumns)
    layouts[name] =
      row[name] === null
        ? { isNull: true, dimensions: [] }
        : { isNull: false, dimensions: [{ lowerBound: 1, upperBound: 1 }] };
  if (relation === 'restore_suppression_event')
    Object.assign(
      row,
      encodeRestoreSuppressionPhysicalRowV7({
        schemaVersion: 1,
        eventId: id,
        athleteId: 'opaque tenant',
        kind: 'tenant_erased',
        occurredAt: '2026-10-08 01:02:03.123456+00',
      }),
    );
  return { ordinal: 1, relation, row, arrayLayouts: layouts };
}
it('covers exact113 additional relations/1064 columns and all explicit target dispositions without source exclusion', () => {
  expect(currentSourceExtraRelations).toHaveLength(113);
  expect(
    Object.values(currentSourceExtraPhysicalRoster).reduce((sum, r) => sum + r.columns.length, 0),
  ).toBe(1064);
  const kinds = new Set<string>();
  for (const relation of currentSourceExtraRelations) {
    const definition = currentSourceExtraPhysicalRoster[relation];
    const input = fixture(relation);
    expect(parseCurrentSourceExtraPhysicalRows([input])).toEqual([input]);
    const action = currentSourceExtraDisposition(relation);
    expect(action).toMatchObject({
      sourceDisposition: 'EXACT_PHYSICAL_CAPTURE',
      transport: 'encrypted_only',
      targetTransform: 'not_implemented',
      authority: 'none',
    });
    kinds.add(definition.targetDisposition);
  }
  expect(kinds.size).toBe(13);
});
it.each(currentSourceExtraRelations)(
  'rejects missing/extra/nonnullable NULL columns for static %s',
  (relation) => {
    const input = fixture(relation);
    const def = currentSourceExtraPhysicalRoster[relation];
    const first = def.columns.find((c) => !c.nullable);
    expect(first).toBeDefined();
    if (!first) throw new Error('missing physical primary key');
    for (const row of [
      { ...input.row, extraAuthority: true },
      { ...input.row, [first.name]: null },
      Object.fromEntries(Object.entries(input.row).filter(([k]) => k !== first.name)),
    ])
      expect(() => parseCurrentSourceExtraPhysicalRows([{ ...input, row }])).toThrow();
  },
);
it('preserves original1 typed physical exact46 fields and rejects inactive-field fabrication', () => {
  const original = fixture('restore_suppression_event');
  expect(parseCurrentSourceExtraPhysicalRows([original])[0]?.row).toEqual(original.row);
  expect(() =>
    parseCurrentSourceExtraPhysicalRows([{ ...original, row: { ...original.row, target_id: id } }]),
  ).toThrow();
});
it('preserves explicit non-1-based multidimensional UUID/inet ordering and NULL elements', () => {
  for (const [relation, column, values] of [
    [
      'course_share',
      'zone_ids',
      [
        [id, null],
        [other, id],
      ],
    ],
    [
      'resource_url_fetch_hop',
      'resolved_addresses',
      [
        ['2001:db8::1', '192.0.2.2/24'],
        [null, '192.0.2.1'],
      ],
    ],
  ] satisfies [CurrentSourceExtraRelation, string, unknown][]) {
    const input = fixture(relation);
    input.row[column] = values;
    input.arrayLayouts[column] = {
      isNull: false,
      dimensions: [
        { lowerBound: -2, upperBound: -1 },
        { lowerBound: 7, upperBound: 8 },
      ],
    };
    expect(parseCurrentSourceExtraPhysicalRows([input])).toEqual([input]);
  }
});
it('distinguishes nullable NULL from empty arrays without inferring lower bounds', () => {
  const input = fixture('healthkit_workout_batch_receipt');
  expect(input.row['sample_ids']).toBeNull();
  expect(parseCurrentSourceExtraPhysicalRows([input])).toEqual([input]);
  const empty = {
    ...input,
    row: { ...input.row, sample_ids: [] },
    arrayLayouts: { sample_ids: { isNull: false, dimensions: [] } },
  };
  expect(parseCurrentSourceExtraPhysicalRows([empty])).toEqual([empty]);
  expect(currentSourceExtraPhysicalRowsSha256([input])).not.toBe(
    currentSourceExtraPhysicalRowsSha256([empty]),
  );
  expect(() =>
    parseCurrentSourceExtraPhysicalRows([
      { ...empty, arrayLayouts: { sample_ids: { isNull: true, dimensions: [] } } },
    ]),
  ).toThrow();
  expect(() => parseCurrentSourceExtraPhysicalRows([{ ...input, arrayLayouts: {} }])).toThrow();
});
it('rejects absent/ragged/cardinality/extra/six-dimension-overflow array evidence', () => {
  const input = fixture('course_share');
  for (const candidate of [
    { ...input, arrayLayouts: {} },
    {
      ...input,
      arrayLayouts: { zone_ids: { isNull: false, dimensions: [{ lowerBound: 4, upperBound: 5 }] } },
    },
    {
      ...input,
      arrayLayouts: {
        zone_ids: {
          isNull: false,
          dimensions: Array.from({ length: 7 }, () => ({ lowerBound: 1, upperBound: 1 })),
        },
      },
    },
    {
      ...input,
      row: { ...input.row, zone_ids: [[id], [id, other]] },
      arrayLayouts: {
        zone_ids: {
          isNull: false,
          dimensions: [
            { lowerBound: 1, upperBound: 2 },
            { lowerBound: 1, upperBound: 2 },
          ],
        },
      },
    },
    {
      ...input,
      arrayLayouts: {
        zone_ids: {
          isNull: false,
          dimensions: [{ lowerBound: 1, upperBound: 1 }],
          authority: true,
        },
      },
    },
  ])
    expect(() => parseCurrentSourceExtraPhysicalRows([candidate])).toThrow();
});
it('rejects deep array values before recursive SQL array parsing and never throws a stack overflow', () => {
  const input = fixture('course_share');
  let values: unknown = '11111111-1111-4111-8111-111111111111';
  for (let depth = 0; depth < 40; depth++) values = [values];
  const raw = [
    {
      ...input,
      row: { ...input.row, zone_ids: values },
      arrayLayouts: { zone_ids: { isNull: false, dimensions: [{ lowerBound: 1, upperBound: 1 }] } },
    },
  ];
  expect(() => parseCurrentSourceExtraPhysicalRows(raw)).toThrow('INVALID_ARRAY_LAYOUT');
});
it('rejects number int8 coercion/unsafe bounds and preserves ±int8 values exactly', () => {
  const input = fixture('openai_budget_month');
  for (const value of ['-9223372036854775808', '9223372036854775807', '9007199254740993', '0']) {
    const row = { ...input.row, revision: value };
    expect(parseCurrentSourceExtraPhysicalRows([{ ...input, row }])[0]?.row).toEqual(row);
  }
  for (const value of [9007199254740992, '9223372036854775808', '-9223372036854775809', '01', '+1'])
    expect(() =>
      parseCurrentSourceExtraPhysicalRows([{ ...input, row: { ...input.row, revision: value } }]),
    ).toThrow();
});
it('preserves SQL float special strings, fraction and zero without nonfinite/negative-zero coercion', () => {
  const input = fixture('course_privacy_zone');
  for (const v of [0, 1.2345678901234567, 'NaN', 'Infinity', '-Infinity', '-0'])
    expect(
      parseCurrentSourceExtraPhysicalRows([
        { ...input, row: { ...input.row, center_longitude: v } },
      ])[0]?.row,
    ).toEqual({ ...input.row, center_longitude: v });
  for (const v of [NaN, Infinity, -Infinity, -0, '1.25'])
    expect(() =>
      parseCurrentSourceExtraPhysicalRows([
        { ...input, row: { ...input.row, center_longitude: v } },
      ]),
    ).toThrow();
});
it('keeps UTC6us/date/opaque JSON order and rejects Date/ISO milliseconds/unknown UUID aliases', () => {
  const input = fixture('course_share_rate');
  expect(parseCurrentSourceExtraPhysicalRows([input])[0]?.row).toEqual(input.row);
  for (const at of ['2026-10-08T01:02:03.123Z', '2026-10-08T01:02:03.123456+00:00', new Date()])
    expect(() =>
      parseCurrentSourceExtraPhysicalRows([{ ...input, row: { ...input.row, window_start: at } }]),
    ).toThrow();
  const row = fixture('course_share');
  expect(() =>
    parseCurrentSourceExtraPhysicalRows([
      { ...row, row: { ...row.row, share_id: id.toUpperCase() } },
    ]),
  ).toThrow();
});
it('rejects duplicate/same-key altered body/ordinal/order instead of selecting latest', () => {
  const one = fixture('schema_migrations');
  one.row['version'] = 1;
  const two = { ...one, ordinal: 2, row: { ...one.row, version: 2 } };
  expect(parseCurrentSourceExtraPhysicalRows([one, two])).toEqual([one, two]);
  expect(() =>
    parseCurrentSourceExtraPhysicalRows([
      one,
      { ...one, ordinal: 2, row: { ...one.row, checksum: 'altered' } },
    ]),
  ).toThrow();
  expect(() =>
    parseCurrentSourceExtraPhysicalRows([
      { ...two, ordinal: 1 },
      { ...one, ordinal: 2 },
    ]),
  ).toThrow();
  expect(() => parseCurrentSourceExtraPhysicalRows([{ ...one, ordinal: 2 }])).toThrow();
});
it('preflights plain/UTF8/depth/row visits before parsing with no silent truncation', () => {
  const input = fixture('activity_import_receipt');
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  let invoked = false;
  const getter = { ...input.row };
  Object.defineProperty(getter, 'result', {
    enumerable: true,
    get() {
      invoked = true;
      return {};
    },
  });
  for (const row of [
    getter,
    { ...input.row, result: cycle },
    { ...input.row, result: '한'.repeat(2 * 1024 * 1024) },
  ])
    expect(() => parseCurrentSourceExtraPhysicalRows([{ ...input, row }])).toThrow();
  expect(invoked).toBe(false);
  expect(() => parseCurrentSourceExtraPhysicalRows(new Array(5001).fill(input))).toThrow();
});
it('composes unchanged old94 parser and marks empty child as independent census required, not whole source proof', () => {
  const parent = {
    ordinal: 1,
    relation: 'identity_private.account',
    row: { athlete_id: id, issuer: 'https://synthetic.test', subject: 'opaque' },
  };
  const result = parseCurrentSourcePhysicalPartitions({
    profile: 'normal107-explicit108-116',
    parentRows: [parent],
    extraRows: [fixture('schema_migrations')],
    childRows: [],
  });
  expect(result).toMatchObject({
    status: 'independent_actual_child_census_required',
    childRows: null,
    census: 'not_authenticated',
    authentication: 'none',
    authority: 'none',
    admissionAllowed: false,
  });
  expect(result.parentRows).toEqual([parent]);
  expect(() =>
    parseCurrentSourcePhysicalPartitions({
      profile: 'normal107-explicit108-118',
      parentRows: [parent],
      extraRows: [],
      childRows: [],
    }),
  ).toThrow();
  expect(() =>
    parseCurrentSourcePhysicalPartitions({
      profile: 'normal107-explicit108-116',
      parentRows: [{ ...parent, row: { ...parent.row, sourceAuthority: true } }],
      extraRows: [],
      childRows: [],
    }),
  ).toThrow();
});
