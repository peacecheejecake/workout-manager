import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  raceEventUpdateCommandSchema,
  type RaceEventValues,
} from '@workout/contracts/race-commands';
import { createRaceRepository } from '../src/races.js';
import type { Database, Transaction } from '../src/database.js';

const athlete = '10000000-0000-4000-8000-000000000001';
const id = '10000000-0000-4000-8000-000000000002';
const plan = '10000000-0000-4000-8000-000000000003';
const values: RaceEventValues = {
  title: 'Synthetic race',
  localDate: '2026-10-04',
  localStartTime: null,
  timezone: 'UTC',
  locationName: null,
  distance: { kind: 'standard', class: '5k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: 0,
  planVersionId: null,
};
function fixture(
  options: {
    priorPlan?: string | null;
    granted?: boolean;
    receipt?: { request_hash: string; result: unknown };
    revision?: number;
  } = {},
) {
  const query = vi.fn<Transaction['query']>(async (sql) => {
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM race_command_receipt'))
      return { rows: options.receipt ? [options.receipt] : [], rowCount: options.receipt ? 1 : 0 };
    if (sql.includes('FROM consent'))
      return {
        rows: [{ kind: 'app', granted: options.granted ?? true, revision: 1 }],
        rowCount: 1,
      };
    if (sql.startsWith('SELECT revision,values_json FROM race_event'))
      return {
        rows: [
          {
            revision: options.revision ?? 1,
            values_json: { ...values, planVersionId: options.priorPlan ?? null },
          },
        ],
        rowCount: 1,
      };
    throw Error(`UNEXPECTED_SQL:${sql}`);
  });
  const tx: Transaction = { athleteId: athlete, query };
  const tenant: Database['tenant'] = async (_athlete, operation) => operation(tx);
  const database: Database = { tenant, exclusiveTenant: tenant, close: async () => {} };
  return { query, repository: createRaceRepository(database) };
}
function command(nextPlan: string | null = null) {
  return raceEventUpdateCommandSchema.parse({
    idempotencyKey: 'original-date-command',
    expectedRevision: 1,
    values: { ...values, localDate: '2026-10-05', planVersionId: nextPlan },
  });
}
function requestHash(input: ReturnType<typeof command>) {
  const { idempotencyKey: _key, ...body } = input;
  return createHash('sha256')
    .update(JSON.stringify({ kind: 'race-event', action: 'update', id, body }))
    .digest('hex');
}

describe('public date command admission and original receipt ordering', () => {
  it.each([
    [null, null],
    [plan, plan],
    [plan, null],
    [null, plan],
  ] as const)(
    'rejects date changes prior=%s next=%s before any ledger writes',
    async (priorPlan, nextPlan) => {
      const { query, repository } = fixture({ priorPlan });
      await expect(
        repository.updateRaceEvent(athlete, id, command(nextPlan)),
      ).rejects.toMatchObject({ code: 'RACE_PLAN_IMPACT_REQUIRED' });
      expect(
        query.mock.calls.some(([sql]) =>
          /INSERT|UPDATE race_event|FROM race_collection_head/.test(sql),
        ),
      ).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('FROM consent'))).toBe(true);
    },
  );
  it('returns a historical successful date receipt before consent and current row/date validation', async () => {
    const input = command();
    const original = { id, revision: 2 };
    const { query, repository } = fixture({
      granted: false,
      revision: 9,
      receipt: { request_hash: requestHash(input), result: original },
    });
    await expect(repository.updateRaceEvent(athlete, id, input)).resolves.toEqual(original);
    expect(query.mock.calls).toHaveLength(2);
    expect(
      query.mock.calls.some(
        ([sql]) => sql.includes('FROM consent') || sql.includes('FROM race_event '),
      ),
    ).toBe(false);
  });
  it('rejects same-key changed body before consulting app or current event', async () => {
    const input = command();
    const { query, repository } = fixture({
      granted: false,
      receipt: { request_hash: requestHash(input), result: { id, revision: 2 } },
    });
    await expect(
      repository.updateRaceEvent(athlete, id, {
        ...input,
        values: { ...input.values, title: 'Changed' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(query.mock.calls).toHaveLength(2);
  });
  it('preserves fresh app withdrawal precedence before date guard', async () => {
    const { query, repository } = fixture({ granted: false });
    await expect(repository.updateRaceEvent(athlete, id, command())).rejects.toMatchObject({
      code: 'APP_CONSENT_REQUIRED',
    });
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM race_event '))).toBe(false);
  });
  it('preserves current revision CAS precedence before date guard', async () => {
    const { repository } = fixture({ revision: 2 });
    await expect(repository.updateRaceEvent(athlete, id, command())).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
  });
});
