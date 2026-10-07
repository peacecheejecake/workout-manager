import { expect, it } from 'vitest';
import {
  routineTemplateVersionSchema,
  supplementaryExerciseVersionSchema,
} from '@workout/contracts/supplementary-core';
import {
  captureWorkoutTemplateSources,
  workoutTemplateSourceFactsSchema,
} from '../src/race-plan-impact-workout-template-sources.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
import type { Transaction } from '../src/database.js';
import type { SourceBudget } from '../src/race-plan-impact-nested-sources.js';
const start = '2026-09-18T09:00:00+09:00';
const ids = {
  exercise: '11111111-1111-4111-8111-111111111111',
  exerciseVersion: '22222222-2222-4222-8222-222222222222',
  routine: '33333333-3333-4333-8333-333333333333',
  routineVersion: '44444444-4444-4444-8444-444444444444',
  planVersion: '55555555-5555-4555-8555-555555555555',
  activity: '66666666-6666-4666-8666-666666666666',
  execution: '77777777-7777-4777-8777-777777777777',
  log: '88888888-8888-4888-8888-888888888888',
  revision: '99999999-9999-4999-8999-999999999999',
  timer: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  nextVersion: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  otherActivity: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const target = {
  id: 'target-1',
  exerciseVersionId: ids.exerciseVersion,
  side: 'left',
  count: {
    target: { min: 8, max: 10, unit: 'count', basis: 'user_confirmed', evidenceIds: [] },
    definition: { kind: 'repetitions', basis: 'per_side', definitionId: 'rep-per-side-v1' },
  },
  durationSeconds: null,
  externalResistance: { kind: 'no_added_load' },
  restAfterSeconds: 60,
  tempo: null,
  effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
};
const spec = {
  schemaVersion: 2,
  kind: 'supplementary',
  routineVersionId: ids.routineVersion,
  blocks: [
    {
      id: 'block-1',
      mode: 'single',
      rounds: 2,
      sets: [target],
      restBetweenRoundsSeconds: null,
    },
  ],
};
const definition = {
  schemaVersion: 2,
  exerciseId: ids.exercise,
  versionId: ids.exerciseVersion,
  name: 'Single-leg balance',
  family: 'balance_stability',
  equipment: ['bodyweight'],
  tags: ['balance'],
  countDefinitions: [{ kind: 'repetitions', basis: 'per_side', definitionId: 'rep-per-side-v1' }],
  mediaAssetIds: [],
  resourceVersionIds: [],
  reviewState: 'unreviewed',
  description: 'User-defined movement',
  safetyNotes: '',
  supportedMetrics: ['count', 'duration', 'effort'],
  createdAt: start,
};
const template = {
  schemaVersion: 2,
  routineId: ids.routine,
  versionId: ids.routineVersion,
  title: 'Balance routine',
  purpose: 'User-defined practice',
  requiredEquipment: ['bodyweight'],
  spec,
  createdAt: start,
};

const body = routineTemplateVersionSchema.parse(template),
  exercise = supplementaryExerciseVersionSchema.parse(definition);
const req = { kind: 'workout_template', ref: { id: body.routineId, versionId: body.versionId } };
function harness() {
  const replies: Record<string, unknown>[][] = [
    [{ count: '1', bytes: '2000', target_count: '1' }],
    [
      {
        aggregate_id: body.routineId,
        version_id: body.versionId,
        version: 1,
        record_json: body,
        head_aggregate_id: body.routineId,
        head_version_id: body.versionId,
        head_version: 1,
      },
    ],
    [
      {
        routineVersionId: body.versionId,
        blockId: 'block-1',
        setId: 'target-1',
        exerciseVersionId: exercise.versionId,
      },
    ],
    [{ count: '1', bytes: '1000', target_count: '0' }],
    [
      {
        aggregate_id: exercise.exerciseId,
        version_id: exercise.versionId,
        version: 1,
        record_json: exercise,
        head_aggregate_id: exercise.exerciseId,
        head_version_id: exercise.versionId,
        head_version: 1,
      },
    ],
  ];
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'owner',
    async query(sql, values) {
      calls.push({ sql, values });
      const rows = replies.shift();
      if (!rows) throw Error('unexpected query');
      return { rows, rowCount: rows.length };
    },
  };
  const budget: SourceBudget = { bytes: 0n, sources: 0 };
  return { replies, calls, tx, budget };
}
it('collects only consumed full immutable template/exercise and exact target with readonly authority', async () => {
  const h = harness(),
    r = await captureWorkoutTemplateSources(h.tx, [req], h.budget);
  expect(r).toMatchObject({
    templates: [body],
    exercises: [{ record: exercise, version: 1 }],
    authority: 'none',
    freshness: 'not_checked',
  });
  expect(r.templateFacts[0]?.content?.digest).toBe(digest(body));
  expect(r.exerciseFacts[0]?.content?.digest).toBe(digest(exercise));
  expect(r.targets).toEqual([
    {
      routineVersionId: body.versionId,
      blockId: 'block-1',
      setId: 'target-1',
      exerciseVersionId: exercise.versionId,
    },
  ]);
  expect(h.calls.every((c) => c.values?.[0] === 'owner')).toBe(true);
  expect(h.budget.sources).toBe(3);
});
it('empty requested catalog performs no broad tenant SQL or unused catalog gathering', async () => {
  const h = harness();
  expect(await captureWorkoutTemplateSources(h.tx, [], h.budget)).toMatchObject({
    templates: [],
    exercises: [],
    requests: [],
  });
  expect(h.calls).toHaveLength(0);
});
it('dedups normalized exact requests while counting every binding visit', async () => {
  const h = harness(),
    r = await captureWorkoutTemplateSources(
      h.tx,
      [
        req,
        {
          ...req,
          ref: { id: body.routineId.toUpperCase(), versionId: body.versionId.toUpperCase() },
        },
      ],
      h.budget,
    );
  expect(r.requests).toHaveLength(1);
  expect(h.calls).toHaveLength(5);
  expect(h.budget.sources).toBe(4);
});
it('separates frozen historical body from actual later head for templates and exercises', async () => {
  const h = harness();
  for (const index of [1, 4]) {
    const row = h.replies[index]?.[0];
    if (!row) throw Error('row');
    row.head_version_id = ids.nextVersion;
    row.head_version = 2;
  }
  const r = await captureWorkoutTemplateSources(h.tx, [req], h.budget);
  expect(r.templateFacts[0]?.state).toBe('historical');
  expect(r.exerciseFacts[0]?.state).toBe('historical');
  expect(r.templates[0]).toEqual(body);
  expect(r.exercises[0]?.record).toEqual(exercise);
});
it('preserves head absence as historical owned row, never invents a current head', async () => {
  const h = harness();
  for (const index of [1, 4]) {
    const row = h.replies[index]?.[0];
    if (!row) throw Error('row');
    row.head_aggregate_id = null;
    row.head_version_id = null;
    row.head_version = null;
  }
  const r = await captureWorkoutTemplateSources(h.tx, [req], h.budget);
  expect(r.templateFacts[0]).toMatchObject({ state: 'historical', currentHead: null });
  expect(r.exerciseFacts[0]?.currentHead).toBeNull();
});
it('absent/foreign/erased requested template is unavailable with no substituted body', async () => {
  const h = harness();
  h.replies[0] = [{ count: '0', bytes: '0', target_count: '0' }];
  h.replies[1] = [];
  const r = await captureWorkoutTemplateSources(h.tx, [req], h.budget);
  expect(r.templates).toEqual([]);
  expect(r.exercises).toEqual([]);
  expect(r.templateFacts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'owned_version_unavailable',
    content: null,
    currentHead: null,
  });
  expect(h.calls).toHaveLength(2);
});
it('missing linked owned exercise retains exact template but marks unavailable, never invents exerciseId', async () => {
  const h = harness();
  h.replies[3] = [{ count: '0', bytes: '0', target_count: '0' }];
  h.replies[4] = [];
  const r = await captureWorkoutTemplateSources(h.tx, [req], h.budget);
  expect(r.exercises).toEqual([]);
  expect(r.exerciseFacts[0]).toEqual({
    requestedVersionId: exercise.versionId,
    state: 'unavailable',
    reason: 'owned_version_unavailable',
    content: null,
    currentHead: null,
  });
});
it.each(['aggregate_id', 'version_id', 'head_aggregate_id', 'head_version_id'] as const)(
  'rejects wrong template %s ownership tuple',
  async (field) => {
    const h = harness(),
      row = h.replies[1]?.[0];
    if (!row) throw Error('row');
    row[field] = ids.otherActivity;
    await expect(captureWorkoutTemplateSources(h.tx, [req], h.budget)).rejects.toMatchObject({
      code: 'INVALID_CONTEXT',
    });
  },
);
it.each(['routineVersionId', 'blockId', 'setId', 'exerciseVersionId'] as const)(
  'requires target multiset exact %s',
  async (field) => {
    const h = harness(),
      row = h.replies[2]?.[0];
    if (!row) throw Error('row');
    row[field] =
      field.endsWith('Id') && field !== 'blockId' && field !== 'setId'
        ? ids.otherActivity
        : 'foreign';
    await expect(captureWorkoutTemplateSources(h.tx, [req], h.budget)).rejects.toMatchObject({
      code: 'INVALID_CONTEXT',
    });
  },
);
it('rejects duplicate target transport or scalar/body count mismatch', async () => {
  const h = harness(),
    row = h.replies[2]?.[0];
  if (!row) throw Error('row');
  h.replies[2]?.push(row);
  await expect(captureWorkoutTemplateSources(h.tx, [req], h.budget)).rejects.toMatchObject({
    code: 'INVALID_CONTEXT',
  });
});
it.each([1048577, 4194304])('bounds routine scalar bytes=%s before body query', async (bytes) => {
  const h = harness();
  h.replies[0] = [{ count: '1', bytes: String(bytes), target_count: '1' }];
  await expect(captureWorkoutTemplateSources(h.tx, [req], h.budget)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(h.calls).toHaveLength(1);
});
it('bounds exercise scalar64KiB before exercise body query', async () => {
  const h = harness();
  h.replies[3] = [{ count: '1', bytes: '65537', target_count: '0' }];
  await expect(captureWorkoutTemplateSources(h.tx, [req], h.budget)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(h.calls).toHaveLength(4);
});
it('bounds target scalar count before template body transport', async () => {
  const h = harness();
  h.replies[0] = [{ count: '1', bytes: '2000', target_count: '301' }];
  await expect(captureWorkoutTemplateSources(h.tx, [req], h.budget)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(h.calls).toHaveLength(1);
});
it('counts repeated requested bindings before dedup for budget saturation', async () => {
  const h = harness();
  h.budget.sources = 4999;
  await expect(captureWorkoutTemplateSources(h.tx, [req, req], h.budget)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(h.calls).toHaveLength(0);
});
it('shared byte budget is reserved before raw template transport', async () => {
  const h = harness();
  h.budget.bytes = 4194000n;
  await expect(captureWorkoutTemplateSources(h.tx, [req], h.budget)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(h.calls).toHaveLength(1);
});
it('strictly rejects unknown body/ref keys and malformed head pairs', async () => {
  const h = harness();
  await expect(
    captureWorkoutTemplateSources(h.tx, [{ ...req, authorized: true }], h.budget),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(h.calls).toHaveLength(0);
  const t = harness(),
    row = t.replies[1]?.[0];
  if (!row) throw Error('row');
  row.record_json = { ...body, approved: true };
  await expect(captureWorkoutTemplateSources(t.tx, [req], t.budget)).rejects.toMatchObject({
    code: 'INVALID_CONTEXT',
  });
  const p = harness(),
    head = p.replies[1]?.[0];
  if (!head) throw Error('row');
  head.head_version = null;
  await expect(captureWorkoutTemplateSources(p.tx, [req], p.budget)).rejects.toMatchObject({
    code: 'INVALID_CONTEXT',
  });
});
it('preserves withdrawn content, zero RIR and null duration as facts, never eligibility', async () => {
  const h = harness(),
    row = h.replies[4]?.[0];
  if (!row) throw Error('row');
  row.record_json = { ...exercise, reviewState: 'withdrawn' };
  const r = await captureWorkoutTemplateSources(h.tx, [req], h.budget);
  expect(r.exercises[0]?.record.reviewState).toBe('withdrawn');
  expect(r.templates[0]?.spec.blocks[0]?.sets[0]?.effort?.rir).toBe(0);
  expect(r.templates[0]?.spec.blocks[0]?.sets[0]?.durationSeconds).toBeNull();
  expect(workoutTemplateSourceFactsSchema.safeParse(r).success).toBe(true);
});
it('propagates actual SQL failure to the caller transaction', async () => {
  const h = harness();
  h.tx.query = async () => {
    throw Object.assign(Error('permission'), { code: '42501' });
  };
  await expect(captureWorkoutTemplateSources(h.tx, [req], h.budget)).rejects.toMatchObject({
    code: '42501',
  });
});
