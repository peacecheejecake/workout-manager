import { z } from 'zod';
import {
  routineTemplateVersionSchema,
  supplementaryExerciseVersionSchema,
} from '@workout/contracts/supplementary-core';
import type { Transaction } from './database.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest as digest,
} from './race-plan-impact-dependencies.js';
const uuid = z.uuid().transform((v) => v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  version = z.number().int().min(1).max(2147483646);
const request = z.strictObject({
  kind: z.literal('workout_template'),
  ref: z.strictObject({ id: uuid, versionId: uuid }),
});
const head = z.strictObject({ aggregate_id: uuid, version_id: uuid, version });
const target = z.strictObject({
  routineVersionId: uuid,
  blockId: z.string().min(1).max(200),
  setId: z.string().min(1).max(200),
  exerciseVersionId: uuid,
});
const state = z.enum(['current', 'historical', 'unavailable']);
const reason = z.literal('owned_version_unavailable').nullable();
export const workoutTemplateSourceFactsSchema = z.strictObject({
  requests: z.array(request).max(5000),
  templates: z.array(routineTemplateVersionSchema).max(5000),
  templateFacts: z
    .array(
      z.strictObject({
        requested: request,
        state,
        reason,
        content: z.strictObject({ digest: hash }).nullable(),
        currentHead: head.nullable(),
      }),
    )
    .max(5000),
  exercises: z
    .array(z.strictObject({ record: supplementaryExerciseVersionSchema, version }))
    .max(5000),
  exerciseFacts: z
    .array(
      z.strictObject({
        requestedVersionId: uuid,
        state,
        reason,
        content: z.strictObject({ exerciseId: uuid, versionId: uuid, digest: hash }).nullable(),
        currentHead: head.nullable(),
      }),
    )
    .max(5000),
  targets: z.array(target).max(5000),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
export type WorkoutTemplateSourceFacts = z.infer<typeof workoutTemplateSourceFactsSchema>;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return r.data;
}
const decimal = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/);
const rowSchema = z.strictObject({
  aggregate_id: uuid,
  version_id: uuid,
  version,
  record_json: z.unknown(),
  head_aggregate_id: uuid.nullable(),
  head_version_id: uuid.nullable(),
  head_version: version.nullable(),
});
const sortKey = (v: unknown) => JSON.stringify(v);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const targetKey = (v: z.infer<typeof target>) =>
  sortKey([v.routineVersionId, v.blockId, v.setId, v.exerciseVersionId]);
/** Exact immutable owned catalog facts only. No deletion tombstone exists in
 * these catalog tables; absent/foreign/erased versions remain unavailable rather
 * than becoming a fabricated deleted:false permission or current replacement. */
export async function captureWorkoutTemplateSources(
  tx: Transaction,
  unknownRequests: unknown,
  budget: SourceBudget,
): Promise<WorkoutTemplateSourceFacts> {
  parse(
    z.strictObject({
      bytes: z.bigint().min(0n).max(4194304n),
      sources: z.number().int().min(0).max(5000),
    }),
    budget,
  );
  const requests = parse(z.array(request).max(5000), unknownRequests);
  // Count actual visits before deduplication; repeated bindings cannot hide caps.
  reserveSourceBudget(
    budget,
    BigInt(Buffer.byteLength(JSON.stringify(requests), 'utf8')),
    requests.length,
  );
  let visits = requests.length;
  const unique = [
    ...new Map(requests.map((r) => [sortKey([r.ref.id, r.ref.versionId]), r])).values(),
  ].sort((a, b) => order(sortKey(a), sortKey(b)));
  const output: WorkoutTemplateSourceFacts = {
    requests: unique,
    templates: [],
    templateFacts: [],
    exercises: [],
    exerciseFacts: [],
    targets: [],
    authority: 'none',
    freshness: 'not_checked',
  };
  const exerciseIds = new Set<string>();
  async function load(kind: 'routine' | 'exercise', id: string) {
    const table =
        kind === 'routine' ? 'supplementary_routine_version' : 'supplementary_exercise_version',
      heads = kind === 'routine' ? 'supplementary_routine_head' : 'supplementary_exercise_head',
      column = kind === 'routine' ? 'routine_id' : 'exercise_id';
    const pre = parse(
      z.strictObject({ count: decimal, bytes: decimal, target_count: decimal }),
      (
        await tx.query(
          `SELECT count(*)::text AS count,coalesce(sum(octet_length(record_json::text)),0)::text AS bytes,
   ${kind === 'routine' ? '(SELECT count(*)::text FROM supplementary_routine_target_ref t WHERE t.athlete_id=$1 AND t.routine_version_id=$2::uuid)' : "'0'::text"} AS target_count FROM ${table} WHERE athlete_id=$1 AND version_id=$2::uuid`,
          [tx.athleteId, id],
        )
      ).rows[0],
    );
    if (BigInt(pre.count) > 1n) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (BigInt(pre.bytes) > (kind === 'routine' ? 1048576n : 65536n))
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
    if (BigInt(pre.target_count) > 300n)
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
    reserveSourceBudget(budget, BigInt(pre.bytes) + 1024n + BigInt(pre.target_count) * 1024n);
    const rows = (
      await tx.query(
        `SELECT v.${column} AS aggregate_id,v.version_id,v.version,v.record_json,h.${column} AS head_aggregate_id,h.version_id AS head_version_id,h.version AS head_version FROM ${table} v LEFT JOIN ${heads} h ON h.athlete_id=v.athlete_id AND h.${column}=v.${column} WHERE v.athlete_id=$1 AND v.version_id=$2::uuid`,
        [tx.athleteId, id],
      )
    ).rows;
    if (rows.length !== Number(pre.count)) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (!rows[0]) return null;
    const row = parse(rowSchema, rows[0]);
    const currentHead =
      row.head_aggregate_id === null && row.head_version_id === null && row.head_version === null
        ? null
        : parse(head, {
            aggregate_id: row.head_aggregate_id,
            version_id: row.head_version_id,
            version: row.head_version,
          });
    if (
      row.version_id !== id ||
      (currentHead &&
        (currentHead.aggregate_id !== row.aggregate_id ||
          currentHead.version < row.version ||
          (currentHead.version_id === row.version_id) !== (currentHead.version === row.version)))
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    return { row, currentHead, targetCount: Number(pre.target_count) };
  }
  for (const requested of unique) {
    const loaded = await load('routine', requested.ref.versionId);
    if (!loaded) {
      output.templateFacts.push({
        requested,
        state: 'unavailable',
        reason: 'owned_version_unavailable',
        content: null,
        currentHead: null,
      });
      continue;
    }
    const body = parse(routineTemplateVersionSchema, loaded.row.record_json);
    if (
      body.routineId !== requested.ref.id ||
      body.versionId !== loaded.row.version_id ||
      body.routineId !== loaded.row.aggregate_id
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const expected = body.spec.blocks.flatMap((block) =>
      block.sets.map((set) => ({
        routineVersionId: body.versionId,
        blockId: block.id,
        setId: set.id,
        exerciseVersionId: set.exerciseVersionId,
      })),
    );
    visits += expected.length;
    if (visits > 5000) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
    reserveSourceBudget(budget, 0n, expected.length);
    const targets = parse(
      z.array(target).max(300),
      (
        await tx.query(
          `SELECT routine_version_id AS "routineVersionId",block_id AS "blockId",target_set_id AS "setId",exercise_version_id AS "exerciseVersionId" FROM supplementary_routine_target_ref WHERE athlete_id=$1 AND routine_version_id=$2::uuid ORDER BY target_set_id LIMIT 301`,
          [tx.athleteId, body.versionId],
        )
      ).rows,
    );
    if (
      targets.length !== loaded.targetCount ||
      digest(targets.map(targetKey).sort(order)) !== digest(expected.map(targetKey).sort(order))
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    for (const entry of expected) exerciseIds.add(entry.exerciseVersionId);
    output.templates.push(body);
    output.targets.push(...targets.sort((a, b) => order(targetKey(a), targetKey(b))));
    output.templateFacts.push({
      requested,
      state: loaded.currentHead?.version_id === body.versionId ? 'current' : 'historical',
      reason: null,
      content: { digest: digest(body) },
      currentHead: loaded.currentHead,
    });
  }
  for (const id of [...exerciseIds].sort(order)) {
    if (++visits > 5000)
      throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
    reserveSourceBudget(budget, 0n, 1);
    const loaded = await load('exercise', id);
    if (!loaded) {
      output.exerciseFacts.push({
        requestedVersionId: id,
        state: 'unavailable',
        reason: 'owned_version_unavailable',
        content: null,
        currentHead: null,
      });
      continue;
    }
    const body = parse(supplementaryExerciseVersionSchema, loaded.row.record_json);
    if (body.exerciseId !== loaded.row.aggregate_id || body.versionId !== loaded.row.version_id)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    output.exercises.push({ record: body, version: loaded.row.version });
    output.exerciseFacts.push({
      requestedVersionId: id,
      state: loaded.currentHead?.version_id === id ? 'current' : 'historical',
      reason: null,
      content: { exerciseId: body.exerciseId, versionId: id, digest: digest(body) },
      currentHead: loaded.currentHead,
    });
  }
  return parse(workoutTemplateSourceFactsSchema, output);
}
