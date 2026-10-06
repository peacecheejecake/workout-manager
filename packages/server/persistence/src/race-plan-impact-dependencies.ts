import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PlanSnapshot } from '@workout/contracts/planning';
import {
  supplementarySessionLinkSchema,
  supplementaryExerciseVersionSchema,
  routineTemplateVersionSchema,
  type SupplementarySpec,
} from '@workout/contracts/supplementary-core';
import type { Transaction } from './database.js';

const sourceCap = 5000;
const uuid = z.uuid();
const localId = z.string().min(1).max(200);
const revision = z.number().int().min(0).max(2147483647);
export const integratedDependencyKinds = [
  'intake_revision',
  'activity_revision',
  'execution_revision',
  'set_revision',
  'food_revision',
  'exercise_revision',
  'routine_revision',
  'routine_run_revision',
  'routine_occurrence_revision',
  'routine_blueprint_revision',
  'recovery_action_revision',
  'recovery_method_revision',
] as const;
const kind = z.enum(integratedDependencyKinds);
const fact = z.discriminatedUnion('state', [
  z.strictObject({ kind, state: z.literal('absent') }),
  z.strictObject({ kind, state: z.literal('present'), revision }),
]);
export class RaceImpactDependencyError extends Error {
  constructor(
    readonly code: 'INVALID_CONTEXT' | 'SOURCE_UNAVAILABLE' | 'CONTEXT_UNAVAILABLE',
    readonly bound?: 'decoded_bytes' | 'unique_sources',
  ) {
    super(code);
  }
}
function fail(code: RaceImpactDependencyError['code']): never {
  throw new RaceImpactDependencyError(code);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail('INVALID_CONTEXT');
}
/** Private decoder: unexpected, duplicate and missing kinds never become a complete inventory. */
export function decodeIntegratedDependencyInventory(value: unknown) {
  const facts = parse(z.array(fact).length(integratedDependencyKinds.length), value);
  const byKind = new Map(facts.map((item) => [item.kind, item]));
  if (byKind.size !== integratedDependencyKinds.length) fail('INVALID_CONTEXT');
  return integratedDependencyKinds.map((name) => byKind.get(name) ?? fail('INVALID_CONTEXT'));
}
export async function captureIntegratedDependencyInventory(tx: Transaction) {
  const rows = (
    await tx.query(
      `SELECT ${integratedDependencyKinds.join(',')} FROM integrated_dependency_head WHERE athlete_id=$1`,
      [tx.athleteId],
    )
  ).rows;
  if (rows.length > 1) fail('INVALID_CONTEXT');
  if (rows.length === 0)
    return decodeIntegratedDependencyInventory(
      integratedDependencyKinds.map((name) => ({ kind: name, state: 'absent' })),
    );
  const row = parse(
    z.strictObject(Object.fromEntries(integratedDependencyKinds.map((name) => [name, revision]))),
    rows[0],
  );
  return decodeIntegratedDependencyInventory(
    integratedDependencyKinds.map((name) => ({
      kind: name,
      state: 'present',
      revision: row[name],
    })),
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  return encoded ?? fail('INVALID_CONTEXT');
}
export const impactDependencyDigest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const digest = impactDependencyDigest;
const targetSchema = z.strictObject({
  block_id: localId,
  target_set_id: localId,
  exercise_version_id: uuid,
});
const sessionTargetSchema = targetSchema.extend({
  plan_version_id: uuid,
  planned_session_id: localId,
});
const routineTargetSchema = targetSchema.extend({ routine_version_id: uuid });
function targets(spec: SupplementarySpec) {
  return spec.blocks.flatMap((block) =>
    block.sets.map((set) => ({
      block_id: block.id,
      target_set_id: set.id,
      exercise_version_id: set.exerciseVersionId,
    })),
  );
}
function assertTargets(
  expected: z.infer<typeof targetSchema>[],
  actual: z.infer<typeof targetSchema>[],
) {
  const sort = (items: z.infer<typeof targetSchema>[]) =>
    [...items].sort((a, b) =>
      a.target_set_id < b.target_set_id ? -1 : a.target_set_id > b.target_set_id ? 1 : 0,
    );
  if (
    new Set(actual.map((item) => item.target_set_id)).size !== actual.length ||
    digest(sort(expected)) !== digest(sort(actual))
  )
    fail('SOURCE_UNAVAILABLE');
}
function bounded(rows: Record<string, unknown>[]) {
  if (rows.length > sourceCap) fail('CONTEXT_UNAVAILABLE');
  return rows;
}
/** Exact frozen source/copy references only. No latest-head substitution or permission decision.
 * Caller must hold lifecycle then tenant0 and run the global scalar byte preflight first. */
export async function captureSupplementaryReferenceManifest(
  tx: Transaction,
  plans: readonly PlanSnapshot[],
  existingSourceCount: number,
) {
  const planIds = plans.map((plan) => plan.id).sort();
  if (new Set(planIds).size !== planIds.length) fail('INVALID_CONTEXT');
  const raw = bounded(
    (
      await tx.query(
        'SELECT plan_version_id,planned_session_id,content_kind,routine_version_id,embedded_spec_json FROM supplementary_session_link WHERE athlete_id=$1 AND plan_version_id=ANY($2::uuid[]) ORDER BY plan_version_id,planned_session_id LIMIT 5001',
        [tx.athleteId, planIds],
      )
    ).rows,
  );
  const links = raw.map((value) => {
    const row = parse(
      z.strictObject({
        plan_version_id: uuid,
        planned_session_id: localId,
        content_kind: z.enum(['routine_version', 'embedded']),
        routine_version_id: uuid.nullable(),
        embedded_spec_json: z.unknown(),
      }),
      value,
    );
    if (
      row.content_kind === 'routine_version'
        ? row.routine_version_id === null || row.embedded_spec_json !== null
        : row.routine_version_id !== null || row.embedded_spec_json === null
    )
      fail('INVALID_CONTEXT');
    return parse(supplementarySessionLinkSchema, {
      schemaVersion: 2,
      planVersionId: row.plan_version_id,
      plannedSessionId: row.planned_session_id,
      content:
        row.content_kind === 'routine_version'
          ? { kind: 'routine_version', routineVersionId: row.routine_version_id }
          : { kind: 'embedded', spec: row.embedded_spec_json },
    });
  });
  const bySession = new Map(
    links.map((link) => [`${link.planVersionId}:${link.plannedSessionId}`, link]),
  );
  if (bySession.size !== links.length) fail('INVALID_CONTEXT');
  const strength = new Set(
    plans.flatMap((plan) =>
      plan.draft.sessions
        .filter((session) => session.sport === 'strength')
        .map((session) => `${plan.id}:${session.id}`),
    ),
  );
  if (links.some((link) => !strength.has(`${link.planVersionId}:${link.plannedSessionId}`)))
    fail('SOURCE_UNAVAILABLE');
  const routineIds = [
    ...new Set(
      links.flatMap((link) =>
        link.content.kind === 'routine_version' ? [link.content.routineVersionId] : [],
      ),
    ),
  ].sort();
  const routineRows = bounded(
    (
      await tx.query(
        'SELECT routine_id,version_id,version,record_json FROM supplementary_routine_version WHERE athlete_id=$1 AND version_id=ANY($2::uuid[]) ORDER BY version_id LIMIT 5001',
        [tx.athleteId, routineIds],
      )
    ).rows,
  );
  const routines = routineRows.map((value) => {
    const row = parse(
      z.strictObject({
        routine_id: uuid,
        version_id: uuid,
        version: revision.min(1),
        record_json: z.unknown(),
      }),
      value,
    );
    const record = parse(routineTemplateVersionSchema, row.record_json);
    if (record.routineId !== row.routine_id || record.versionId !== row.version_id)
      fail('INVALID_CONTEXT');
    return { record, version: row.version };
  });
  const byRoutine = new Map(routines.map((row) => [row.record.versionId, row]));
  if (
    byRoutine.size !== routineIds.length ||
    routines.length !== routineIds.length ||
    routineIds.some((id) => !byRoutine.has(id))
  )
    fail('SOURCE_UNAVAILABLE');
  const routineTargets = bounded(
    (
      await tx.query(
        'SELECT routine_version_id,block_id,target_set_id,exercise_version_id FROM supplementary_routine_target_ref WHERE athlete_id=$1 AND routine_version_id=ANY($2::uuid[]) ORDER BY routine_version_id,target_set_id LIMIT 5001',
        [tx.athleteId, routineIds],
      )
    ).rows,
  ).map((row) => parse(routineTargetSchema, row));
  for (const row of routines)
    assertTargets(
      targets(row.record.spec),
      routineTargets
        .filter((target) => target.routine_version_id === row.record.versionId)
        .map(({ routine_version_id: _id, ...target }) => target),
    );
  const sessionTargets = bounded(
    (
      await tx.query(
        'SELECT plan_version_id,planned_session_id,block_id,target_set_id,exercise_version_id FROM supplementary_session_target_ref WHERE athlete_id=$1 AND plan_version_id=ANY($2::uuid[]) ORDER BY plan_version_id,planned_session_id,target_set_id LIMIT 5001',
        [tx.athleteId, planIds],
      )
    ).rows,
  ).map((row) => parse(sessionTargetSchema, row));
  if (
    sessionTargets.some(
      (target) => !bySession.has(`${target.plan_version_id}:${target.planned_session_id}`),
    )
  )
    fail('SOURCE_UNAVAILABLE');
  const copies = links.map((link) => {
    const spec =
      link.content.kind === 'embedded'
        ? link.content.spec
        : (byRoutine.get(link.content.routineVersionId) ?? fail('SOURCE_UNAVAILABLE')).record.spec;
    const expected = targets(spec);
    assertTargets(
      // 021 stores target rows for embedded copies only; routine links resolve the
      // exact immutable routine target rows checked above, never a current head.
      link.content.kind === 'embedded' ? expected : [],
      sessionTargets
        .filter(
          (target) =>
            target.plan_version_id === link.planVersionId &&
            target.planned_session_id === link.plannedSessionId,
        )
        .map(({ plan_version_id: _plan, planned_session_id: _session, ...target }) => target),
    );
    return {
      link,
      targetSource:
        link.content.kind === 'embedded' ? ('session_copy' as const) : ('routine_version' as const),
      contentDigest: digest(spec),
      targets: expected,
    };
  });
  const exerciseIds = [
    ...new Set(copies.flatMap((copy) => copy.targets.map((target) => target.exercise_version_id))),
  ].sort();
  if (existingSourceCount + routineIds.length + exerciseIds.length > sourceCap)
    fail('CONTEXT_UNAVAILABLE');
  const exerciseRows = bounded(
    (
      await tx.query(
        'SELECT exercise_id,version_id,version,record_json FROM supplementary_exercise_version WHERE athlete_id=$1 AND version_id=ANY($2::uuid[]) ORDER BY version_id LIMIT 5001',
        [tx.athleteId, exerciseIds],
      )
    ).rows,
  );
  const exercises = exerciseRows.map((value) => {
    const row = parse(
      z.strictObject({
        exercise_id: uuid,
        version_id: uuid,
        version: revision.min(1),
        record_json: z.unknown(),
      }),
      value,
    );
    const record = parse(supplementaryExerciseVersionSchema, row.record_json);
    if (record.exerciseId !== row.exercise_id || record.versionId !== row.version_id)
      fail('INVALID_CONTEXT');
    return {
      exerciseId: record.exerciseId,
      versionId: record.versionId,
      version: row.version,
      contentDigest: digest(record),
      resourceVersionIds: record.resourceVersionIds,
      mediaAssetIds: record.mediaAssetIds,
    };
  });
  const fetched = new Set(exercises.map((row) => row.versionId));
  if (
    fetched.size !== exerciseIds.length ||
    exercises.length !== exerciseIds.length ||
    exerciseIds.some((id) => !fetched.has(id))
  )
    fail('SOURCE_UNAVAILABLE');
  return {
    sessions: plans
      .flatMap((plan) =>
        plan.draft.sessions
          .filter((session) => session.sport === 'strength')
          .map((session) => ({
            planVersionId: plan.id,
            plannedSessionId: session.id,
            state: bySession.has(`${plan.id}:${session.id}`)
              ? ('present' as const)
              : ('absent' as const),
          })),
      )
      .sort((a, b) =>
        `${a.planVersionId}:${a.plannedSessionId}` < `${b.planVersionId}:${b.plannedSessionId}`
          ? -1
          : `${a.planVersionId}:${a.plannedSessionId}` > `${b.planVersionId}:${b.plannedSessionId}`
            ? 1
            : 0,
      ),
    copies,
    routines: routines.map((row) => ({
      routineId: row.record.routineId,
      versionId: row.record.versionId,
      version: row.version,
      contentDigest: digest(row.record),
    })),
    exercises,
  };
}
