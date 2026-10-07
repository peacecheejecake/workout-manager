import { expect, it } from 'vitest';
import {
  parseCurrentParentPhysicalRows,
  parseCurrentParentPhysicalRowsV2,
  currentParentRowsSha256,
} from '../src/restore-current-parent-artifact.js';
const id = 'abcdefab-abcd-7abc-8abc-000000000001';
function rows(distance: number | string) {
  return [
    {
      ordinal: 1,
      relation: 'course_revision',
      row: {
        athlete_id: id,
        course_id: id,
        course_revision: 1,
        revision_id: id,
        name: 'Synthetic',
        geometry: {},
        waypoints: [],
        generation: {},
        edit: {},
        vertex_count: 1,
        distance_meters: distance,
        content_digest: 'synthetic',
        created_at: '2026-10-08T01:02:03.123456Z',
      },
    },
  ];
}
it.each(['-0', 'NaN', 'Infinity', '-Infinity'])(
  'retains SQL physical %s without reinterpreting historical signed parent bytes',
  (value) => {
    const raw = rows(value);
    expect(parseCurrentParentPhysicalRowsV2(raw)).toEqual(raw);
    expect(() => parseCurrentParentPhysicalRows(raw)).toThrow('INVALID_CURRENT_PARENT_ARTIFACT');
    expect(() => currentParentRowsSha256(raw)).toThrow('INVALID_CURRENT_PARENT_ARTIFACT');
  },
);
it('retains finite V1-compatible row bodies and distinguishes positive zero from SQL negative zero', () => {
  expect(parseCurrentParentPhysicalRowsV2(rows(12.5))).toEqual(
    parseCurrentParentPhysicalRows(rows(12.5)),
  );
  expect(parseCurrentParentPhysicalRowsV2(rows(0))).not.toEqual(
    parseCurrentParentPhysicalRowsV2(rows('-0')),
  );
  expect(() => parseCurrentParentPhysicalRowsV2(rows(-0))).toThrow(
    'INVALID_CURRENT_PARENT_ARTIFACT',
  );
});
it('rejects JS special numbers, undocumented spellings and unknown physical columns', () => {
  for (const value of [NaN, Infinity, -Infinity, 'nan', '+Infinity', '12.5']) {
    expect(() => parseCurrentParentPhysicalRowsV2(rows(value))).toThrow(
      'INVALID_CURRENT_PARENT_ARTIFACT',
    );
  }
  const raw = rows('NaN');
  expect(() =>
    parseCurrentParentPhysicalRowsV2([{ ...raw[0], row: { ...raw[0]?.row, unknown: true } }]),
  ).toThrow('INVALID_CURRENT_PARENT_ARTIFACT');
});
it('keeps exact physical PK and ordinal checks for successor course rows', () => {
  const raw = rows('-0');
  expect(() => parseCurrentParentPhysicalRowsV2([raw[0], { ...raw[0], ordinal: 2 }])).toThrow(
    'INVALID_CURRENT_PARENT_ARTIFACT',
  );
  expect(() => parseCurrentParentPhysicalRowsV2([{ ...raw[0], ordinal: 2 }])).toThrow(
    'INVALID_CURRENT_PARENT_ARTIFACT',
  );
});
