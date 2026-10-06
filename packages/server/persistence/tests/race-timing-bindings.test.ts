import { describe, expect, it } from 'vitest';
import {
  captureRaceTimingPins,
  requireFreshRaceTimingPins,
  type RaceTimingQueryPort,
} from '../src/race-timing-bindings.js';

const athleteId = 'synthetic-athlete';
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const expected = [{ namespace: 'race-event', eventId: id, revision: 1 }];
const values = {
  title: 'Synthetic race',
  localDate: '2026-10-07',
  localStartTime: '09:00',
  timezone: 'Asia/Seoul',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: null,
  planVersionId: null,
};
function fixture(
  options: {
    scope?: string | null;
    totals?: Record<string, unknown>;
    rows?: Record<string, unknown>[];
    body?: Record<string, unknown>;
  } = {},
) {
  const calls: { sql: string; parameters: unknown[] | undefined }[] = [];
  const body = options.body ?? values;
  const tx: RaceTimingQueryPort = {
    athleteId,
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      let rows: Record<string, unknown>[];
      if (sql.includes('current_setting'))
        rows = [{ athlete_id: options.scope === undefined ? athleteId : options.scope }];
      else if (sql.includes('WITH requested'))
        rows = [
          options.totals ?? {
            heads: '1',
            matching_heads: '1',
            histories: '1',
            bytes: '2048',
          },
        ];
      else
        rows = options.rows ?? [
          { id, revision: 1, values_json: body, history_revision: 1, history_values: body },
        ];
      return { rows, rowCount: rows.length };
    },
  };
  return { tx, calls };
}

describe('race timing QueryPort preparation, not actual PG or admission', () => {
  it('captures only authenticated tenant parameterized exact head/history reads with explicit source domain', async () => {
    const f = fixture();
    const [pin] = await captureRaceTimingPins(f.tx, expected);
    expect(pin).toMatchObject({
      eventId: id,
      eventRevision: 1,
      namespace: 'race-event-revision',
      sourceDigestVersion: 'race-event-values-canonical-v1',
      start: { state: 'known', instant: '2026-10-07T00:00:00.000Z' },
      end: { state: 'unknown', reason: 'race_end_not_recorded' },
    });
    expect(pin?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(pin)).toBe(true);
    expect(Object.isFrozen(pin?.start)).toBe(true);
    expect(Object.isFrozen(pin?.end)).toBe(true);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[1]?.parameters).toEqual([athleteId, [id], [1]]);
    expect(f.calls[2]?.parameters).toEqual([athleteId, [id]]);
    for (const call of f.calls)
      expect(call.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|set_config|advisory)\b/i);
  });
  it('retains literal empty and still checks tenant context without fetching any body', async () => {
    const f = fixture();
    expect(await captureRaceTimingPins(f.tx, [])).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });
  it.each([null, 'foreign-athlete'])(
    'rejects mismatched or missing tenant setting %s',
    async (scope) => {
      const f = fixture({ scope });
      await expect(captureRaceTimingPins(f.tx, expected)).rejects.toMatchObject({
        code: 'RACE_TIMING_TENANT_MISMATCH',
      });
      expect(f.calls).toHaveLength(1);
    },
  );
  it('rejects unknown intent fields, duplicate/same-ID revisions and over-cap before reads', async () => {
    const f = fixture();
    for (const input of [
      [{ ...expected[0], sourceDigest: 'a'.repeat(64) }],
      [expected[0], { ...expected[0], revision: 2 }],
      Array.from({ length: 5001 }, () => expected[0]),
      [{ namespace: 'session', eventId: id, revision: 1 }],
    ])
      await expect(captureRaceTimingPins(f.tx, input)).rejects.toMatchObject({
        code: 'RACE_TIMING_INVALID_INPUT',
      });
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    [{ heads: '0', matching_heads: '0', histories: '0', bytes: '0' }, 'RACE_TIMING_UNAVAILABLE'],
    [{ heads: '1', matching_heads: '0', histories: '1', bytes: '2048' }, 'RACE_TIMING_STALE'],
    [
      { heads: '1', matching_heads: '1', histories: '0', bytes: '2048' },
      'RACE_TIMING_INVALID_SOURCE',
    ],
    [{ heads: '1', matching_heads: '1', histories: '1', bytes: '4194305' }, 'RACE_TIMING_LIMIT'],
  ])('preflight fails closed without decoding a body: %s', async (totals, code) => {
    const f = fixture({ totals });
    await expect(captureRaceTimingPins(f.tx, expected)).rejects.toMatchObject({ code });
    expect(f.calls).toHaveLength(2);
  });
  it.each(
    [
      [],
      [
        {
          id: otherId,
          revision: 1,
          values_json: values,
          history_revision: 1,
          history_values: values,
        },
      ],
      [{ id, revision: 2, values_json: values, history_revision: 2, history_values: values }],
      [{ id, revision: 1, values_json: values, history_revision: 2, history_values: values }],
      [
        {
          id,
          revision: 1,
          values_json: values,
          history_revision: 1,
          history_values: { ...values, title: 'changed' },
        },
      ],
      [
        {
          id,
          revision: 1,
          values_json: { ...values, forged: true },
          history_revision: 1,
          history_values: values,
        },
      ],
    ].map((rows) => ({ rows })),
  )('rejects absent, mismatched, stale or malformed head/history rows %j', async ({ rows }) => {
    await expect(captureRaceTimingPins(fixture({ rows }).tx, expected)).rejects.toMatchObject({
      code: rows[0]?.revision === 2 ? 'RACE_TIMING_STALE' : 'RACE_TIMING_INVALID_SOURCE',
    });
  });
  it('canonicalizes keys for the digest but binds the complete strict event values', async () => {
    const [original] = await captureRaceTimingPins(fixture().tx, expected);
    const reverse = Object.fromEntries(Object.entries(values).reverse());
    const [reordered] = await captureRaceTimingPins(fixture({ body: reverse }).tx, expected);
    expect(reordered?.sourceDigest).toBe(original?.sourceDigest);
    for (const patch of [
      { title: 'different' },
      { locationName: 'synthetic place' },
      { targetSeconds: 0 },
      { priority: 'A' },
      { participation: 'withdrawn' },
    ]) {
      const [changed] = await captureRaceTimingPins(
        fixture({ body: { ...values, ...patch } }).tx,
        expected,
      );
      expect(changed?.sourceDigest).not.toBe(original?.sourceDigest);
    }
  });
  it('rejects transformed nested UUID wire values instead of signing a normalized source', async () => {
    const body = {
      ...values,
      course: {
        courseId: 'ABCDEFAB-1111-4111-8111-111111111111',
        courseRevision: 1,
        revisionId: otherId,
      },
    };
    await expect(captureRaceTimingPins(fixture({ body }).tx, expected)).rejects.toMatchObject({
      code: 'RACE_TIMING_INVALID_SOURCE',
    });
  });
  it.each([
    { localStartTime: null, reason: 'start_time_not_recorded' },
    {
      localDate: '2026-03-08',
      localStartTime: '02:30',
      timezone: 'America/New_York',
      reason: 'ambiguous_local_time',
    },
    {
      localDate: '2026-11-01',
      localStartTime: '01:30',
      timezone: 'America/New_York',
      reason: 'ambiguous_local_time',
    },
  ])(
    'uses the existing actual civil resolver for unknown/null/DST %j',
    async ({ reason, ...patch }) => {
      const [pin] = await captureRaceTimingPins(
        fixture({ body: { ...values, ...patch } }).tx,
        expected,
      );
      expect(pin?.start).toEqual({ state: 'unknown', reason });
      expect(pin?.end).toEqual({ state: 'unknown', reason: 'race_end_not_recorded' });
    },
  );
  it('preserves second precision and timezone date crossing without inventing race end from a goal', async () => {
    const [pin] = await captureRaceTimingPins(
      fixture({ body: { ...values, localStartTime: '00:00:17', targetSeconds: 3600 } }).tx,
      expected,
    );
    expect(pin?.start).toEqual({ state: 'known', instant: '2026-10-06T15:00:17.000Z' });
    expect(pin?.end.state).toBe('unknown');
  });
  it('fresh comparison preserves frozen requested revision and rejects changed source/body instead of repinning', async () => {
    const frozen = await captureRaceTimingPins(fixture().tx, expected);
    await expect(requireFreshRaceTimingPins(fixture().tx, frozen)).resolves.toBeUndefined();
    await expect(
      requireFreshRaceTimingPins(fixture({ body: { ...values, title: 'changed' } }).tx, frozen),
    ).rejects.toMatchObject({ code: 'RACE_TIMING_STALE' });
    const changed = fixture({
      totals: { heads: '1', matching_heads: '0', histories: '1', bytes: '2048' },
    });
    await expect(requireFreshRaceTimingPins(changed.tx, frozen)).rejects.toMatchObject({
      code: 'RACE_TIMING_STALE',
    });
    expect(changed.calls).toHaveLength(2);
    expect(frozen[0]?.eventRevision).toBe(1);
  });
  it('sanitizes database failures without leaking query error detail', async () => {
    const tx: RaceTimingQueryPort = {
      athleteId,
      query: async () => {
        throw new Error('synthetic private SQL details');
      },
    };
    await expect(captureRaceTimingPins(tx, expected)).rejects.toMatchObject({
      code: 'RACE_TIMING_UNAVAILABLE',
      message: 'RACE_TIMING_UNAVAILABLE',
    });
  });
});
