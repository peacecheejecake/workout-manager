import { expect, it } from 'vitest';
import { prepareNutritionRaceTimingIn } from '../src/nutrition-race-timing-preparation.js';
import type { RaceTimingQueryPort } from '../src/race-timing-bindings.js';
const athlete = 'synthetic-owner';
const event = '11111111-1111-4111-8111-111111111111';
const plan = '22222222-2222-4222-8222-222222222222';
const version = '33333333-3333-4333-8333-333333333333';
const approval = '44444444-4444-4444-8444-444444444444';
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
const item = {
  id: 'meal-1',
  category: 'before',
  title: 'Synthetic meal',
  anchor: { kind: 'relative', entity: 'race', entityId: event, point: 'start', offsetMinutes: 0 },
  foods: [],
  targets: [],
  instructions: 'Synthetic action',
  evidenceIds: [],
  source: 'user_confirmed',
};
const draft = {
  period: { from: '2026-10-07', toInclusive: '2026-10-07' },
  timezone: 'Asia/Seoul',
  purpose: 'Synthetic',
  linkedTrainingPlanVersionId: null,
  items: [item],
};
const intent = {
  schemaVersion: 2,
  command: { kind: 'create', confirmed: true, idempotencyKey: 'synthetic-key', draft },
  expectedRaceHeads: [{ namespace: 'race-event', eventId: event, revision: 1 }],
};
const prior = {
  ...draft,
  planId: plan,
  versionId: version,
  version: 1,
  previousVersionId: null,
  approvedAt: '2026-10-07T00:00:00Z',
  approvalId: approval,
  items: [{ ...item, planVersionId: version }],
};
const update = {
  ...intent,
  command: { ...intent.command, kind: 'update', planId: plan, expectedHeadVersionId: version },
};
function fixture(
  options: {
    prior?: unknown;
    scope?: string;
    body?: Record<string, unknown>;
    missing?: boolean;
    stale?: boolean;
    bytes?: string;
    raceUnavailable?: boolean;
    training?: unknown;
    raceBytes?: string;
  } = {},
) {
  const calls: string[] = [];
  const tx: RaceTimingQueryPort = {
    athleteId: athlete,
    async query(sql) {
      calls.push(sql);
      let rows: Record<string, unknown>[];
      if (sql.includes('current_setting')) rows = [{ athlete_id: options.scope ?? athlete }];
      else if (sql.includes('FROM nutrition_plan_head'))
        rows = options.missing
          ? []
          : [
              {
                version: 1,
                version_id: options.stale ? approval : version,
                exact_version_id: options.stale ? approval : version,
                bytes: options.bytes ?? '2048',
              },
            ];
      else if (sql.includes('FROM nutrition_plan_version'))
        rows = [{ record_json: options.prior ?? prior }];
      else if (sql.startsWith('SELECT coalesce(sum(octet_length(h.values_json'))
        rows = [{ bytes: options.raceBytes ?? '2048' }];
      else if (sql.includes('octet_length(draft::text)')) rows = [{ bytes: '2048' }];
      else if (sql.includes('FROM plan_snapshot')) rows = [{ draft: options.training }];
      else if (sql.includes('WITH requested'))
        rows = [
          {
            heads: options.raceUnavailable ? '0' : '1',
            matching_heads: '1',
            histories: '1',
            bytes: '2048',
          },
        ];
      else
        rows = [
          {
            id: event,
            revision: 1,
            values_json: options.body ?? values,
            history_revision: 1,
            history_values: options.body ?? values,
          },
        ];
      return { rows, rowCount: rows.length };
    },
  };
  return { tx, calls };
}
it('new owned race captures server roster but never stores or approves', async () => {
  const f = fixture();
  const result = await prepareNutritionRaceTimingIn(f.tx, intent, []);
  expect(result).toMatchObject({
    status: 'prepared',
    storage: 'not_persisted',
    approvalAllowed: false,
    fullApproval: false,
  });
  if (result.status !== 'prepared') throw Error('expected preparation');
  expect(result.timingRoster.raceTimingPins[0]).toMatchObject({ eventId: event, eventRevision: 1 });
  expect(Object.isFrozen(result.timingRoster)).toBe(true);
  for (const sql of f.calls)
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|set_config|advisory)\b/i);
});
it('unaffected unchanged owned legacy preserves unpinned marker without auto-pin', async () => {
  const result = await prepareNutritionRaceTimingIn(fixture().tx, update, []);
  expect(result).toMatchObject({
    status: 'prepared',
    notices: [{ itemId: item.id, code: 'LEGACY_UNPINNED_PRESERVED' }],
  });
  if (result.status !== 'prepared') throw Error('expected');
  expect(result.timingRoster.raceTimingPins).toEqual([]);
  expect(result.timingRoster.itemRaceTimingBindings[0]?.binding).toMatchObject({
    state: 'legacy_unpinned',
    priorNutritionVersionId: version,
    priorItemId: item.id,
  });
});
it('affected unchanged legacy captures new binding and blocks unknown end', async () => {
  const command = {
    ...update.command,
    draft: { ...draft, items: [{ ...item, anchor: { ...item.anchor, point: 'end' } }] },
  };
  const result = await prepareNutritionRaceTimingIn(
    fixture({
      prior: { ...prior, items: [{ ...prior.items[0], anchor: { ...item.anchor, point: 'end' } }] },
    }).tx,
    { ...update, command },
    [item.id],
  );
  expect(result).toMatchObject({
    status: 'blocked',
    blocks: [{ itemId: item.id, code: 'TIMING_UNRESOLVED' }],
  });
});
it.each([
  { localStartTime: null },
  { localDate: '2026-03-08', localStartTime: '02:30', timezone: 'America/New_York' },
  { localDate: '2026-11-01', localStartTime: '01:30', timezone: 'America/New_York' },
])('new source unknown start stays blocked %j', async (patch) => {
  expect(
    await prepareNutritionRaceTimingIn(fixture({ body: { ...values, ...patch } }).tx, intent, []),
  ).toMatchObject({ status: 'blocked', blocks: [{ code: 'TIMING_UNRESOLVED' }] });
});
it('unaffected legacy unresolved remains preserved with notice; source unavailable is not invented', async () => {
  expect(
    await prepareNutritionRaceTimingIn(
      fixture({ body: { ...values, localStartTime: null } }).tx,
      update,
      [],
    ),
  ).toMatchObject({
    status: 'prepared',
    notices: [{ code: 'LEGACY_UNPINNED_PRESERVED' }, { code: 'UNRESOLVED_PRESERVED' }],
  });
  expect(
    await prepareNutritionRaceTimingIn(fixture({ raceUnavailable: true }).tx, update, []),
  ).toMatchObject({ status: 'blocked', blocks: [{ code: 'RACE_TIMING_UNAVAILABLE' }] });
});
it('changed legacy item is captured instead of preserved', async () => {
  const result = await prepareNutritionRaceTimingIn(
    fixture().tx,
    {
      ...update,
      command: {
        ...update.command,
        draft: { ...draft, items: [{ ...item, instructions: 'New explicit action' }] },
      },
    },
    [],
  );
  expect(result).toMatchObject({ status: 'prepared', notices: [] });
  if (result.status === 'prepared')
    expect(result.timingRoster.itemRaceTimingBindings[0]?.binding.state).toBe('captured');
});
it.each([{ missing: true }, { stale: true }])(
  'owned prior head absence/CAS fails closed %j',
  async (option) => {
    expect(await prepareNutritionRaceTimingIn(fixture(option).tx, update, [])).toMatchObject({
      status: 'blocked',
      blocks: [{ code: option.missing ? 'PRIOR_UNAVAILABLE' : 'PRIOR_HEAD_STALE' }],
    });
  },
);
it('strict prior metadata mismatch/malformed source and byte preflight reject', async () => {
  await expect(
    prepareNutritionRaceTimingIn(fixture({ prior: { ...prior, planId: approval } }).tx, update, []),
  ).rejects.toMatchObject({ code: 'NUTRITION_TIMING_INVALID_SOURCE' });
  await expect(
    prepareNutritionRaceTimingIn(fixture({ prior: { ...prior, unknown: true } }).tx, update, []),
  ).rejects.toMatchObject({ code: 'NUTRITION_TIMING_INVALID_SOURCE' });
  const f = fixture({ bytes: '524289' });
  await expect(prepareNutritionRaceTimingIn(f.tx, update, [])).rejects.toMatchObject({
    code: 'NUTRITION_TIMING_LIMIT',
  });
  expect(f.calls.some((sql) => sql.includes('SELECT record_json'))).toBe(false);
});
it('foreign scope/unknown intent/client preservation claims and affected IDs reject', async () => {
  await expect(
    prepareNutritionRaceTimingIn(fixture({ scope: 'foreign' }).tx, intent, []),
  ).rejects.toMatchObject({ code: 'NUTRITION_TIMING_TENANT_MISMATCH' });
  for (const input of [
    { ...intent, legacy: true },
    { ...intent, raceTimingPins: [] },
  ])
    await expect(prepareNutritionRaceTimingIn(fixture().tx, input, [])).rejects.toMatchObject({
      code: 'NUTRITION_TIMING_INVALID_INPUT',
    });
  await expect(
    prepareNutritionRaceTimingIn(fixture().tx, intent, ['unknown-item']),
  ).rejects.toMatchObject({ code: 'NUTRITION_TIMING_INVALID_INPUT' });
});
it('same UUID session never borrows race ownership and requires owned linked plan', async () => {
  const session = { ...item, anchor: { ...item.anchor, entity: 'session' } };
  expect(
    await prepareNutritionRaceTimingIn(
      fixture().tx,
      {
        ...intent,
        command: { ...intent.command, draft: { ...draft, items: [session] } },
        expectedRaceHeads: [],
      },
      [],
    ),
  ).toMatchObject({ status: 'blocked', blocks: [{ code: 'SESSION_REFERENCE_INVALID' }] });
});
it('existing captured timing is retained and newer basis never silently repins', async () => {
  const first = await prepareNutritionRaceTimingIn(fixture().tx, intent, []);
  if (first.status !== 'prepared') throw Error('fixture');
  const priorV2 = {
    ...prior,
    schemaVersion: 2,
    raceTimingPins: first.timingRoster.raceTimingPins,
    itemRaceTimingBindings: first.timingRoster.itemRaceTimingBindings,
  };
  const original = await prepareNutritionRaceTimingIn(fixture({ prior: priorV2 }).tx, update, []);
  expect(original).toMatchObject({ status: 'prepared' });
  expect(
    await prepareNutritionRaceTimingIn(
      fixture({ prior: priorV2, body: { ...values, localStartTime: '10:00' } }).tx,
      update,
      [],
    ),
  ).toMatchObject({
    status: 'prepared',
    timingRoster: original.status === 'prepared' ? original.timingRoster : {},
  });
});

it('aggregate decoded byte preflight fails before race body fetch', async () => {
  const f = fixture({ raceBytes: '4194305' });
  await expect(prepareNutritionRaceTimingIn(f.tx, intent, [])).rejects.toMatchObject({
    code: 'NUTRITION_TIMING_LIMIT',
  });
  expect(f.calls.some((sql) => sql.includes('WITH requested'))).toBe(false);
});
it('exact owned historical training session resolves without borrowing same-ID race', async () => {
  const training = {
    title: 'Synthetic',
    timezone: 'Asia/Seoul',
    periods: ['season', 'wave', 'phase', 'block'].map((level, i, all) => ({
      id: level,
      parentId: i === 0 ? null : all[i - 1],
      level,
      title: level,
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: event,
        blockId: 'block',
        date: '2026-10-07',
        localStartTime: '09:00',
        title: 'Synthetic',
        sport: 'running',
        durationSeconds: 0,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  const input = {
    ...intent,
    command: {
      ...intent.command,
      draft: {
        ...draft,
        linkedTrainingPlanVersionId: version,
        items: [{ ...item, anchor: { ...item.anchor, entity: 'session', point: 'end' } }],
      },
    },
    expectedRaceHeads: [],
  };
  expect(await prepareNutritionRaceTimingIn(fixture({ training }).tx, input, [])).toMatchObject({
    status: 'prepared',
  });
  const unknown = {
    ...training,
    sessions: training.sessions.map((s) => ({ ...s, durationSeconds: null })),
  };
  expect(
    await prepareNutritionRaceTimingIn(fixture({ training: unknown }).tx, input, []),
  ).toMatchObject({ status: 'blocked', blocks: [{ code: 'TIMING_UNRESOLVED' }] });
});

it('changed plan timing context cannot claim unchanged legacy preservation', async () => {
  const result = await prepareNutritionRaceTimingIn(
    fixture().tx,
    { ...update, command: { ...update.command, draft: { ...draft, timezone: 'UTC' } } },
    [],
  );
  expect(result).toMatchObject({ status: 'prepared', notices: [] });
  if (result.status === 'prepared')
    expect(result.timingRoster.itemRaceTimingBindings[0]?.binding.state).toBe('captured');
});

it.each(['x'.repeat(201), '영양"\\'.repeat(101)])(
  'accepts actual draft item ID %s within complete metadata bounds',
  async (itemId) => {
    const f = fixture();
    const result = await prepareNutritionRaceTimingIn(
      f.tx,
      {
        ...intent,
        command: { ...intent.command, draft: { ...draft, items: [{ ...item, id: itemId }] } },
      },
      [itemId],
    );
    expect(result).toMatchObject({
      status: 'prepared',
      storage: 'not_persisted',
      approvalAllowed: false,
    });
    if (result.status !== 'prepared') throw Error('expected preparation');
    expect(result.timingRoster.itemRaceTimingBindings[0]?.itemId).toBe(itemId);
  },
);
it.each([[item.id, item.id], [123], [''], [item.id, 'a']])(
  'rejects malformed, duplicate or unsorted affected metadata before query %#',
  async (...ids) => {
    const f = fixture();
    await expect(prepareNutritionRaceTimingIn(f.tx, intent, ids)).rejects.toMatchObject({
      code: 'NUTRITION_TIMING_INVALID_INPUT',
    });
    expect(f.calls).toEqual([]);
  },
);
it('rejects oversized complete UTF8 metadata before schema decoding or query', async () => {
  const f = fixture();
  await expect(
    prepareNutritionRaceTimingIn(f.tx, intent, ['영'.repeat(1400000)]),
  ).rejects.toMatchObject({ code: 'NUTRITION_TIMING_LIMIT' });
  expect(f.calls).toEqual([]);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await expect(prepareNutritionRaceTimingIn(f.tx, circular, [])).rejects.toMatchObject({
    code: 'NUTRITION_TIMING_INVALID_INPUT',
  });
  expect(f.calls).toEqual([]);
});
it('retains 5000 affected-ID count cap and includes metadata in aggregate source budget', async () => {
  const many = fixture();
  await expect(
    prepareNutritionRaceTimingIn(
      many.tx,
      intent,
      Array.from({ length: 5001 }, (_, i) => `item-${String(i).padStart(5, '0')}`),
    ),
  ).rejects.toMatchObject({ code: 'NUTRITION_TIMING_INVALID_INPUT' });
  expect(many.calls).toEqual([]);
  const bounded = fixture({ raceBytes: String(4 * 1024 * 1024) });
  await expect(prepareNutritionRaceTimingIn(bounded.tx, intent, [])).rejects.toMatchObject({
    code: 'NUTRITION_TIMING_LIMIT',
  });
  expect(bounded.calls.some((sql) => sql.includes('WITH requested'))).toBe(false);
});
it('includes caller-decoded own source bytes in the same 4MiB preparation budget', async () => {
  const f = fixture();
  await expect(prepareNutritionRaceTimingIn(f.tx, intent, [], 4194304)).rejects.toMatchObject({
    code: 'NUTRITION_TIMING_LIMIT',
  });
  expect(f.calls).toEqual([]);
  await expect(prepareNutritionRaceTimingIn(f.tx, intent, [], -1)).rejects.toMatchObject({
    code: 'NUTRITION_TIMING_LIMIT',
  });
});
