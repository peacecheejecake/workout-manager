import { expect, it } from 'vitest';
import {
  raceNutritionExportData35,
  raceNutritionExportFields35,
} from '../src/race-nutrition-export.js';
import { nutritionPlanVersionV4Schema } from '../src/nutrition-race-plan-v4.js';
import { raceResultStorageLifecycleV2Schema } from '../src/race-result-v2.js';
function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const at = '2026-10-07T00:00:00.123456Z';
function record(schemaVersion: 1 | 2 | 3 | 4) {
  const base = {
    planId: uuid(1),
    versionId: uuid(2),
    version: 1,
    previousVersionId: null,
    approvalId: uuid(3),
    approvedAt: at,
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Retained approved foods',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'meal',
        planVersionId: uuid(2),
        category: 'before',
        title: 'Meal',
        anchor:
          schemaVersion >= 3
            ? { kind: 'disconnected', entity: 'race' }
            : { kind: 'absolute', date: '2026-10-07', localTime: '00:00', timezone: 'UTC' },
        foods: [
          {
            foodVersionId: null,
            description: 'Zero portion',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
          {
            foodVersionId: null,
            description: 'Unknown portion',
            quantity: null,
            unit: 'unspecified',
            sourceBasis: 'unknown',
          },
        ],
        targets: [],
        instructions: 'Retained',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
  return schemaVersion === 1
    ? base
    : { ...base, schemaVersion, raceTimingPins: [], itemRaceTimingBindings: [] };
}
function fixture(schemaVersion: 1 | 2 | 3 | 4 = 4) {
  return {
    nutritionPlanVersions: [
      {
        plan_id: uuid(1),
        version_id: uuid(2),
        version: 1,
        previous_version_id: null,
        period_from: '2026-10-07',
        period_to: '2026-10-07',
        linked_training_plan_version_id: null,
        approval_id: uuid(3),
        approved_at: at,
        record_json: record(schemaVersion),
      },
    ],
    nutritionPlanHeads: [{ plan_id: uuid(1), version_id: uuid(2), version: 1 }],
    nutritionPlanHistory: [
      {
        plan_id: uuid(1),
        version_id: uuid(2),
        approval_id: uuid(3),
        action: 'user_approved',
        created_at: at,
      },
    ],
    raceResults: [
      {
        id: uuid(4),
        revision: 1,
        deleted: false,
        recorded_at: at,
        updated_at: at,
        values_json: raceBody(),
      },
    ],
    raceResultRevisions: [
      { entity_id: uuid(4), revision: 1, created_at: at, values_json: raceBody() },
    ],
  };
}
function raceBody() {
  return {
    schemaVersion: 2,
    kind: 'race-result',
    raceEventId: null,
    localDate: '2026-10-07',
    timezone: 'UTC',
    source: { kind: 'manual' },
    chipSeconds: 0,
    gunSeconds: null,
    officialDistanceMeters: 10000,
    deviceDistanceMeters: null,
    linkedActivityId: null,
    weatherNote: null,
    proofs: {
      link: 'https://example.test/result',
      attachments: [
        { kind: 'resource-pdf', resourceId: uuid(5), versionId: uuid(6), status: 'unavailable' },
      ],
    },
  };
}
it.each([1, 2, 3, 4] as const)(
  'retains original compatible nutrition V%i body and zero/null foods',
  (version) => {
    const input = fixture(version),
      bytes = JSON.stringify(input);
    expect(raceNutritionExportData35.parse(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(bytes);
  },
);
it('uses exact public producer column roster and grants no private marker or receipt fields', () => {
  expect(Object.keys(raceNutritionExportFields35)).toEqual([
    'nutritionPlanVersions',
    'nutritionPlanHeads',
    'nutritionPlanHistory',
    'raceResults',
    'raceResultRevisions',
  ]);
  for (const family of [
    'nutritionPlanVersions',
    'nutritionPlanHeads',
    'nutritionPlanHistory',
    'raceResults',
    'raceResultRevisions',
  ] as const) {
    const input = structuredClone(fixture());
    const row = input[family][0];
    if (!row) throw new Error('Missing fixture row');
    Reflect.set(row, 'athlete_id', uuid(99));
    expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
  }
  expect(raceNutritionExportData35.safeParse({ ...fixture(), privateMarkers: [] }).success).toBe(
    false,
  );
});
it('accepts timezone/fraction aliases but rejects approvedAt microsecond mismatch', () => {
  const input = fixture();
  first(input.nutritionPlanVersions).approved_at = '2026-10-07T09:00:00.123456000+09:00';
  expect(raceNutritionExportData35.safeParse(input).success).toBe(true);
  first(input.nutritionPlanVersions).approved_at = '2026-10-07T00:00:00.123457Z';
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
});
it.each([
  'plan_id',
  'version_id',
  'approval_id',
  'previous_version_id',
  'linked_training_plan_version_id',
  'period_from',
  'period_to',
  'version',
])('rejects mismatched nutrition scalar %s', (field) => {
  const input = fixture();
  Reflect.set(
    first(input.nutritionPlanVersions),
    field,
    field === 'version' ? 2 : field.startsWith('period_') ? '2026-10-08' : uuid(99),
  );
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
});
it('rejects missing/foreign head, approval and predecessor tuples', () => {
  for (const family of ['nutritionPlanHeads', 'nutritionPlanHistory'] as const) {
    const input = fixture();
    input[family] = [];
    expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
  }
  const input = fixture();
  first(input.nutritionPlanHistory).approval_id = uuid(88);
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
});
it('rejects UUID case-alias duplicates without treating item IDs as UUIDs', () => {
  const input = fixture();
  input.nutritionPlanHeads.push({
    ...first(input.nutritionPlanHeads),
    plan_id: uuid(1).toUpperCase(),
  });
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
});
it('preserves original V1 race source without inventing V2 proofs', () => {
  const input = fixture();
  const { schemaVersion, proofs, ...legacy } = raceBody();
  void schemaVersion;
  void proofs;
  const values = {
    ...legacy,
    source: {
      kind: 'official',
      authority: 'Original user record',
      resultUrl: 'https://example.test/result',
      verifiedAt: at,
    },
  };
  const legacyInput = {
    ...input,
    raceResults: [{ ...first(input.raceResults), values_json: values }],
    raceResultRevisions: [{ ...first(input.raceResultRevisions), values_json: values }],
  };
  expect(raceNutritionExportData35.parse(legacyInput)).toEqual(legacyInput);
});
it('reconstructs historical relational identity rather than accepting full wire identities in raw values', () => {
  for (const key of ['id', 'revision', 'athleteId', 'ownerId', 'unknown']) {
    const input = fixture();
    Reflect.set(
      first(input.raceResultRevisions).values_json,
      key,
      key === 'revision' ? 2 : uuid(8),
    );
    expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
  }
  const input = fixture();
  first(input.raceResultRevisions).entity_id = uuid(90);
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
});
it('allows a deleted NULL head with no history and rejects fabricated NULL history', () => {
  const input = fixture();
  const deleted = {
    ...input,
    raceResults: [{ ...first(input.raceResults), deleted: true, values_json: null }],
    raceResultRevisions: [],
  };
  expect(raceNutritionExportData35.safeParse(deleted).success).toBe(true);
  expect(
    raceNutritionExportData35.safeParse({
      ...deleted,
      raceResultRevisions: [{ ...first(input.raceResultRevisions), values_json: null }],
    }).success,
  ).toBe(false);
  expect(
    raceNutritionExportData35.safeParse({
      ...deleted,
      raceResults: [{ ...first(deleted.raceResults), deleted: false }],
    }).success,
  ).toBe(false);
});
it('bounds body bytes and row counts without changing original records', () => {
  const input = fixture();
  Reflect.set(first(input.raceResults).values_json, 'weatherNote', 'x'.repeat(17000));
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
  expect(
    raceNutritionExportData35.safeParse({
      ...fixture(),
      raceResults: Array.from({ length: 1001 }, () => first(fixture().raceResults)),
    }).success,
  ).toBe(false);
});
it('the typed export is structural rather than source/restore/approval authority', () => {
  const input = fixture();
  expect(
    nutritionPlanVersionV4Schema.safeParse(first(input.nutritionPlanVersions).record_json).success,
  ).toBe(true);
  expect(
    raceResultStorageLifecycleV2Schema.safeParse({
      ...first(input.raceResults).values_json,
      id: uuid(4),
      revision: 1,
    }).success,
  ).toBe(true);
  expect(raceNutritionExportData35.safeParse(input).success).toBe(true);
});

it('preserves legitimate terminal source-free heads without invented same-revision history', () => {
  const input = fixture();
  first(input.raceResults).revision = 2147483647;
  input.raceResultRevisions = [];
  expect(raceNutritionExportData35.safeParse(input).success).toBe(true);
});
it('rejects nonterminal missing/different current history and microsecond reversed timestamps', () => {
  const input = fixture();
  expect(raceNutritionExportData35.safeParse({ ...input, raceResultRevisions: [] }).success).toBe(
    false,
  );
  first(input.raceResultRevisions).values_json.chipSeconds = 1;
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
  const reversed = fixture();
  first(reversed.raceResults).updated_at = '2026-10-07T00:00:00.123455Z';
  expect(raceNutritionExportData35.safeParse(reversed).success).toBe(false);
});
it('compares race JSON facts without depending on object key insertion order', () => {
  const input = fixture();
  const reversed = {
    ...input,
    raceResultRevisions: [
      {
        ...first(input.raceResultRevisions),
        values_json: Object.fromEntries(
          Object.entries(first(input.raceResultRevisions).values_json).reverse(),
        ),
      },
    ],
  };
  expect(raceNutritionExportData35.safeParse(reversed).success).toBe(true);
});

it('requires each later nutrition predecessor to be the original same-plan prior version', () => {
  const input = fixture();
  const row = structuredClone(first(input.nutritionPlanVersions));
  row.version_id = uuid(7);
  row.version = 2;
  Reflect.set(row, 'previous_version_id', uuid(2));
  row.approval_id = uuid(8);
  row.record_json.versionId = uuid(7);
  row.record_json.version = 2;
  Reflect.set(row.record_json, 'previousVersionId', uuid(2));
  row.record_json.approvalId = uuid(8);
  first(row.record_json.items).planVersionId = uuid(7);
  input.nutritionPlanVersions.push(row);
  input.nutritionPlanHeads = [{ plan_id: uuid(1), version_id: uuid(7), version: 2 }];
  input.nutritionPlanHistory.push({
    plan_id: uuid(1),
    version_id: uuid(7),
    approval_id: uuid(8),
    action: 'user_approved',
    created_at: at,
  });
  expect(raceNutritionExportData35.safeParse(input).success).toBe(true);
  Reflect.set(row, 'previous_version_id', uuid(90));
  Reflect.set(row.record_json, 'previousVersionId', uuid(90));
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
});
it('enforces the nutrition UTF8 body cap independently of row collection counts', () => {
  const input = fixture();
  const row = first(input.nutritionPlanVersions);
  const item = first(row.record_json.items);
  row.record_json.items = Array.from({ length: 1000 }, (_, index) => ({
    ...item,
    id: `meal-${index}`,
    instructions: '식'.repeat(500),
  }));
  const result = raceNutritionExportData35.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success)
    expect(
      result.error.issues.some((issue) => issue.message === 'Export record byte limit exceeded'),
    ).toBe(true);
});

it('rejects retained private history under a deleted race head and future historical revisions', () => {
  const input = fixture();
  expect(
    raceNutritionExportData35.safeParse({
      ...input,
      raceResults: [{ ...first(input.raceResults), deleted: true, values_json: null }],
    }).success,
  ).toBe(false);
  first(input.raceResultRevisions).revision = 2;
  expect(raceNutritionExportData35.safeParse(input).success).toBe(false);
});
