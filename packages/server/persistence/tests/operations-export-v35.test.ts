import { expect, it } from 'vitest';
import { accountExportV35Schema } from '@workout/contracts/operations';
import { createOperationsRepository, createOperationsV35Repository } from '../src/operations.js';
import type { Database, Transaction } from '../src/database.js';
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const at = '2026-10-07T00:00:00.123456Z';
function data(version: 1 | 2 | 3 | 4) {
  const base = {
    planId: uuid(1),
    versionId: uuid(2),
    version: 1,
    previousVersionId: null,
    approvalId: uuid(3),
    approvedAt: at,
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Retained foods',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'meal',
        planVersionId: uuid(2),
        category: 'before',
        title: 'Meal',
        anchor:
          version >= 3
            ? { kind: 'disconnected', entity: 'race' }
            : { kind: 'absolute', date: '2026-10-07', localTime: '00:00', timezone: 'UTC' },
        foods: [
          {
            foodVersionId: null,
            description: 'Zero',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
          {
            foodVersionId: null,
            description: 'Unknown',
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
  const record =
    version === 1
      ? base
      : { ...base, schemaVersion: version, raceTimingPins: [], itemRaceTimingBindings: [] };
  const race = {
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
        record_json: record,
      },
    ],
    nutritionPlanHeads: [{ plan_id: uuid(1), version: 1, version_id: uuid(2) }],
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
        values_json: race,
        deleted: false,
        recorded_at: at,
        updated_at: at,
      },
    ],
    raceResultRevisions: [{ entity_id: uuid(4), revision: 1, values_json: race, created_at: at }],
  };
}
function fixture(payload: unknown, ok = true) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const query: Transaction['query'] = async (sql, values) => {
    calls.push({ sql, values });
    return { rows: sql.startsWith('WITH rows') ? [{ ok, data: payload }] : [], rowCount: 1 };
  };
  const db: Database = {
    tenant: async (athleteId, fn) => fn({ athleteId, query }),
    exclusiveTenant: async (athleteId, fn) => fn({ athleteId, query }),
    close: async () => {},
  };
  return { db, calls };
}
it.each([1, 2, 3, 4] as const)(
  'explicit V35 retains original nutrition V%i facts and metadata-free historical race proof',
  async (version) => {
    const input = data(version),
      test = fixture(input);
    const exported = await createOperationsV35Repository(test.db).exportAccount('synthetic');
    expect(exported.schemaVersion).toBe(35);
    expect(accountExportV35Schema.parse(exported)).toEqual(exported);
    for (const name of Object.keys(input))
      expect(Reflect.get(exported.data, name)).toEqual(Reflect.get(input, name));
    expect(
      test.calls.map((c) =>
        c.sql.startsWith('SELECT pg_advisory')
          ? 'lock'
          : c.sql.startsWith('WITH rows')
            ? 'snapshot'
            : 'audit',
      ),
    ).toEqual(['lock', 'lock', 'snapshot', 'audit']);
    const snapshot = test.calls.find((c) => c.sql.startsWith('WITH rows'));
    expect(snapshot?.values).toEqual(['synthetic']);
    expect(snapshot?.sql).toContain('AS MATERIALIZED');
    expect(snapshot?.sql).toContain('LIMIT 1001');
    expect(snapshot?.sql).toContain('<=1000');
    expect(snapshot?.sql).not.toMatch(
      /nutrition_disconnection_origin|race_result_proof_ref|command_receipt|restore_suppression_event/,
    );
  },
);
it('default historical producer remains V34 with exactly shared SQL and audit path', async () => {
  const old = fixture(data(4)),
    current = fixture(data(4));
  expect((await createOperationsRepository(old.db).exportAccount('synthetic')).schemaVersion).toBe(
    34,
  );
  await createOperationsV35Repository(current.db).exportAccount('synthetic');
  expect(old.calls.map((c) => c.sql)).toEqual(current.calls.map((c) => c.sql));
});
it('V35 rejects relational/body mismatch before recording export audit, V34 remains historical generic wire', async () => {
  const input = data(4);
  const first = input.nutritionPlanVersions[0];
  if (!first) throw Error('FIXTURE');
  first.version_id = uuid(99);
  const test = fixture(input);
  await expect(createOperationsV35Repository(test.db).exportAccount('synthetic')).rejects.toThrow();
  expect(test.calls.some((c) => c.sql.includes('INSERT INTO operations_audit'))).toBe(false);
  expect(
    (await createOperationsRepository(fixture(input).db).exportAccount('synthetic')).schemaVersion,
  ).toBe(34);
});
it('scalar MVCC overflow rejects before audit and never accepts incomplete data as a successful artifact', async () => {
  const test = fixture({}, false);
  await expect(createOperationsV35Repository(test.db).exportAccount('synthetic')).rejects.toThrow(
    'EXPORT_TOO_LARGE',
  );
  expect(test.calls).toHaveLength(3);
});
it('V35 rejects private ownership columns or deleted historical NULL before audit', async () => {
  for (const alter of ['athlete_id', 'null-history']) {
    const input = data(3),
      row = input.raceResultRevisions[0];
    if (!row) throw Error('FIXTURE');
    if (alter === 'athlete_id') Reflect.set(row, 'athlete_id', 'foreign');
    else Reflect.set(row, 'values_json', null);
    const test = fixture(input);
    await expect(
      createOperationsV35Repository(test.db).exportAccount('synthetic'),
    ).rejects.toThrow();
    expect(test.calls).toHaveLength(3);
  }
});
