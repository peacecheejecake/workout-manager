import { createHash } from 'node:crypto';
import { z } from 'zod';
import { raceEventSchema, type RaceEvent } from '@workout/contracts/races';
import { planSnapshotSchema, type PlanSnapshot } from '@workout/contracts/planning';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import { routineScheduleVersionSchema } from '@workout/contracts/routines';
import {
  sessionCompletionSchema,
  preservesSessionCompletions,
} from '@workout/contracts/session-completion';
import type { Transaction } from './database.js';
import { captureCoreEvidenceDependencies } from './evidence-dependencies.js';
import {
  captureIntegratedDependencyInventory,
  captureSupplementaryReferenceManifest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';

const cap = 1000;
const decodedBytesCap = 4 * 1024 * 1024;
const sourceCap = 5000;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2147483647);
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(100);
const ids = z
  .array(z.string().min(1).max(200))
  .max(cap)
  .refine((value) => new Set(value).size === value.length);
const inputSchema = z.strictObject({
  eventId: uuid,
  expectedRevision: revision,
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('keep_plan') }),
    z.strictObject({
      kind: z.literal('move_period'),
      expectedCurrentPlanVersionId: uuid,
      changedSessionIds: ids,
      movedPeriodIds: ids.max(100),
    }),
  ]),
});
export type RacePlanImpactContextInput = z.infer<typeof inputSchema>;
export class RacePlanImpactContextError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CONTEXT'
      | 'EVENT_UNAVAILABLE'
      | 'REVISION_CONFLICT'
      | 'SOURCE_UNAVAILABLE'
      | 'CONTEXT_LIMIT'
      | 'CONTEXT_UNAVAILABLE',
    readonly bound?: 'decoded_bytes' | 'relative_anchors' | 'unique_sources',
  ) {
    super(code);
    this.name = 'RacePlanImpactContextError';
  }
}
function fail(code: RacePlanImpactContextError['code']): never {
  throw new RacePlanImpactContextError(code);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fail('INVALID_CONTEXT');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('INVALID_CONTEXT');
  return encoded;
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const head = z.strictObject({ aggregate_id: uuid, version_id: uuid, record_json: z.unknown() });
const snapshotRow = z.strictObject({
  id: uuid,
  version: revision,
  created_at: z.string(),
  draft: z.unknown(),
});
function snapshot(value: unknown): PlanSnapshot {
  const row = parse(snapshotRow, value);
  return parse(planSnapshotSchema, {
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    draft: row.draft,
  });
}
async function ownedSnapshot(tx: Transaction, id: string): Promise<PlanSnapshot> {
  const row = (
    await tx.query(
      `SELECT id,version,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2`,
      [tx.athleteId, id],
    )
  ).rows[0];
  return row ? snapshot(row) : fail('SOURCE_UNAVAILABLE');
}
async function roster(tx: Transaction, domain: 'nutrition' | 'recovery' | 'routine') {
  const table =
    domain === 'nutrition'
      ? ['nutrition_plan_head', 'nutrition_plan_version', 'plan_id']
      : domain === 'recovery'
        ? ['recovery_strategy_head', 'recovery_strategy_version', 'strategy_id']
        : ['routine_schedule_head', 'routine_schedule_version', 'schedule_id'];
  // LEFT JOIN preserves orphan heads; strict decoding refuses them rather than hiding them.
  const rows = (
    await tx.query(
      `SELECT h.${table[2]} AS aggregate_id,h.version_id,v.record_json FROM ${table[0]} h LEFT JOIN ${table[1]} v ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id AND v.${table[2]}=h.${table[2]} WHERE h.athlete_id=$1 ORDER BY h.${table[2]} LIMIT 1001`,
      [tx.athleteId],
    )
  ).rows;
  if (rows.length > cap) fail('CONTEXT_LIMIT');
  return rows.map((row) => parse(head, row));
}
async function preflight(tx: Transaction, eventId: string) {
  // Counts first: no head DTO is transported when a roster exceeds the root bound.
  const counts = parse(
    z.strictObject({
      nutrition: decimal,
      recovery: decimal,
      routine: decimal,
      completions: decimal,
    }),
    (
      await tx.query(
        `SELECT
    (SELECT count(*)::text FROM (SELECT 1 FROM nutrition_plan_head WHERE athlete_id=$1 LIMIT 1001) n) AS nutrition,
    (SELECT count(*)::text FROM (SELECT 1 FROM recovery_strategy_head WHERE athlete_id=$1 LIMIT 1001) r) AS recovery,
    (SELECT count(*)::text FROM (SELECT 1 FROM routine_schedule_head WHERE athlete_id=$1 LIMIT 1001) r) AS routine,
    (SELECT count(*)::text FROM (SELECT 1 FROM session_completion WHERE athlete_id=$1 LIMIT 1001) c) AS completions`,
        [tx.athleteId],
      )
    ).rows[0],
  );
  if (Object.values(counts).some((count) => BigInt(count) > BigInt(cap))) fail('CONTEXT_LIMIT');
  const limits = parse(
    z.strictObject({
      bytes: decimal,
      anchors: decimal,
      sources: decimal,
      links: decimal,
      targets: decimal,
      routine_targets: decimal,
      strength_sessions: decimal,
    }),
    (
      await tx.query(
        `WITH
    nutrition AS MATERIALIZED (SELECT v.record_json,v.linked_training_plan_version_id FROM nutrition_plan_head h
      LEFT JOIN nutrition_plan_version v ON v.athlete_id=h.athlete_id AND v.plan_id=h.plan_id AND v.version_id=h.version_id WHERE h.athlete_id=$1),
    recovery AS MATERIALIZED (SELECT v.record_json FROM recovery_strategy_head h LEFT JOIN recovery_strategy_version v
      ON v.athlete_id=h.athlete_id AND v.strategy_id=h.strategy_id AND v.version_id=h.version_id WHERE h.athlete_id=$1),
    routine AS MATERIALIZED (SELECT v.record_json,v.source_plan_version_id FROM routine_schedule_head h LEFT JOIN routine_schedule_version v
      ON v.athlete_id=h.athlete_id AND v.schedule_id=h.schedule_id AND v.version_id=h.version_id WHERE h.athlete_id=$1),
    anchors AS MATERIALIZED (SELECT item->'anchor' AS anchor FROM nutrition n CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(n.record_json->'items')='array' THEN n.record_json->'items' ELSE '[]'::jsonb END) item WHERE item->'anchor'->>'kind'='relative' LIMIT 5001),
    plan_refs AS MATERIALIZED (
      SELECT version_id::text AS id FROM plan_head WHERE athlete_id=$1
      UNION SELECT values_json->>'planVersionId' FROM race_event WHERE athlete_id=$1 AND id=$2 AND NOT deleted
      UNION SELECT linked_training_plan_version_id::text FROM nutrition
      UNION SELECT source_plan_version_id::text FROM routine
      UNION SELECT ref->>'headVersionId' FROM recovery r CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(r.record_json->'draft'->'planRefs')='array' THEN r.record_json->'draft'->'planRefs' ELSE '[]'::jsonb END) ref WHERE ref->>'kind'='training' LIMIT 5001),
    race_refs AS MATERIALIZED (SELECT $2::text AS id UNION SELECT anchor->>'entityId' FROM anchors WHERE anchor->>'entity'='race'),
    races AS MATERIALIZED (SELECT e.id,e.revision,e.values_json FROM race_event e JOIN race_refs ref ON e.id::text=ref.id WHERE e.athlete_id=$1 AND NOT e.deleted),
    supplementary_links AS MATERIALIZED (SELECT l.* FROM supplementary_session_link l JOIN plan_refs ref ON l.plan_version_id::text=ref.id WHERE l.athlete_id=$1),
    supplementary_targets AS MATERIALIZED (SELECT t.* FROM supplementary_session_target_ref t JOIN plan_refs ref ON t.plan_version_id::text=ref.id WHERE t.athlete_id=$1),
    supplementary_routine_refs AS MATERIALIZED (SELECT DISTINCT routine_version_id AS id FROM supplementary_links WHERE routine_version_id IS NOT NULL),
    supplementary_routines AS MATERIALIZED (SELECT v.record_json FROM supplementary_routine_version v JOIN supplementary_routine_refs ref ON v.version_id=ref.id WHERE v.athlete_id=$1),
    supplementary_routine_targets AS MATERIALIZED (SELECT t.* FROM supplementary_routine_target_ref t JOIN supplementary_routine_refs ref ON t.routine_version_id=ref.id WHERE t.athlete_id=$1),
    supplementary_exercise_refs AS MATERIALIZED (SELECT exercise_version_id AS id FROM supplementary_targets UNION SELECT exercise_version_id FROM supplementary_routine_targets),
    supplementary_exercises AS MATERIALIZED (SELECT v.record_json FROM supplementary_exercise_version v JOIN supplementary_exercise_refs ref ON v.version_id=ref.id WHERE v.athlete_id=$1),
    strength_sessions AS MATERIALIZED (SELECT 1 FROM plan_snapshot p JOIN plan_refs ref ON p.id::text=ref.id CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.draft->'sessions')='array' THEN p.draft->'sessions' ELSE '[]'::jsonb END) session WHERE p.athlete_id=$1 AND session->>'sport'='strength' LIMIT 5001),
    bodies AS (
      SELECT record_json AS body FROM nutrition UNION ALL SELECT record_json FROM recovery UNION ALL SELECT record_json FROM routine
      UNION ALL SELECT record_json FROM session_completion WHERE athlete_id=$1
      UNION ALL SELECT p.draft FROM plan_snapshot p JOIN plan_refs ref ON p.id::text=ref.id WHERE p.athlete_id=$1
      UNION ALL SELECT to_jsonb(t) FROM supplementary_targets t
      UNION ALL SELECT to_jsonb(t) FROM supplementary_routine_targets t
      UNION ALL SELECT embedded_spec_json FROM supplementary_links
      UNION ALL SELECT record_json FROM supplementary_routines
      UNION ALL SELECT record_json FROM supplementary_exercises
      UNION ALL SELECT values_json FROM races
      UNION ALL SELECT h.values_json FROM race_event_revision h JOIN races e ON h.entity_id=e.id AND h.revision=e.revision WHERE h.athlete_id=$1)
    SELECT coalesce(sum(octet_length(body::text)+1024),0)::text AS bytes,
      (SELECT count(*)::text FROM anchors) AS anchors,
      ((SELECT count(*) FROM plan_refs WHERE id IS NOT NULL)+(SELECT count(*) FROM race_refs WHERE id IS NOT NULL)+(SELECT count(*) FROM supplementary_routine_refs)+(SELECT count(*) FROM supplementary_exercise_refs))::text AS sources,
      (SELECT count(*)::text FROM supplementary_links) AS links,
      (SELECT count(*)::text FROM supplementary_targets) AS targets,
      (SELECT count(*)::text FROM supplementary_routine_targets) AS routine_targets,
      (SELECT count(*)::text FROM strength_sessions) AS strength_sessions FROM bodies`,
        [tx.athleteId, eventId],
      )
    ).rows[0],
  );
  // Reference cap+1 is checked before byte accounting: oversized scalar rosters never
  // enter the DTO transport, even when both bounds would be exceeded.
  if (
    [limits.links, limits.targets, limits.routine_targets, limits.strength_sessions].some(
      (value) => BigInt(value) > BigInt(sourceCap),
    )
  )
    throw new RacePlanImpactContextError('CONTEXT_UNAVAILABLE', 'unique_sources');
  // The +1024 per transported body reserves bounded UTF-8 row metadata, not decoded JSON payload.
  if (BigInt(limits.bytes) > BigInt(decodedBytesCap))
    throw new RacePlanImpactContextError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  if (BigInt(limits.anchors) > BigInt(sourceCap))
    throw new RacePlanImpactContextError('CONTEXT_UNAVAILABLE', 'relative_anchors');
  if (BigInt(limits.sources) > BigInt(sourceCap))
    throw new RacePlanImpactContextError('CONTEXT_UNAVAILABLE', 'unique_sources');
}
function sourceCache(tx: Transaction) {
  const plans = new Map<string, Promise<PlanSnapshot>>();
  const races = new Map<string, Promise<RaceEvent>>();
  function checkLimit() {
    if (plans.size + races.size >= sourceCap)
      throw new RacePlanImpactContextError('CONTEXT_UNAVAILABLE', 'unique_sources');
  }
  return {
    consumedPlans: () => Promise.all(plans.values()),
    sourceCount: () => plans.size + races.size,
    seedPlan(record: PlanSnapshot) {
      if (!plans.has(record.id)) {
        checkLimit();
        plans.set(record.id, Promise.resolve(record));
      }
    },
    seedRace(record: RaceEvent) {
      if (!races.has(record.id)) {
        checkLimit();
        races.set(record.id, Promise.resolve(record));
      }
    },
    plan(id: string) {
      const cached = plans.get(id);
      if (cached) return cached;
      checkLimit();
      const pending = ownedSnapshot(tx, id);
      plans.set(id, pending);
      return pending;
    },
    race(id: string) {
      const cached = races.get(id);
      if (cached) return cached;
      checkLimit();
      const pending = (async () => {
        const row = (
          await tx.query(
            'SELECT revision,values_json FROM race_event WHERE athlete_id=$1 AND id::text=$2 AND NOT deleted',
            [tx.athleteId, id],
          )
        ).rows[0];
        if (!row) fail('SOURCE_UNAVAILABLE');
        const race = parse(raceEventSchema, {
          ...parse(z.record(z.string(), z.unknown()), row['values_json']),
          id,
          revision: row['revision'],
        });
        const history = (
          await tx.query(
            'SELECT values_json FROM race_event_revision WHERE athlete_id=$1 AND entity_id=$2 AND revision=$3',
            [tx.athleteId, race.id, race.revision],
          )
        ).rows[0];
        if (!history || digest(history['values_json']) !== digest(row['values_json']))
          fail('SOURCE_UNAVAILABLE');
        return race;
      })();
      races.set(id, pending);
      return pending;
    },
  };
}
const missingDependencies = [
  'complete_catalog_and_actual_manifest',
  'supplementary_reference_manifest',
  'routine_occurrences_and_started_runs',
  'complete_source_permission_manifest',
  'manual_purpose_app_and_policy_binding',
] as const;

/** Partial, tenant-owned read context only. Caller supplies an existing lifecycle-fenced
 * transaction. Changed IDs must be derived from the pure projection, never client claims.
 * Coverage is always blocked until the listed remaining dependencies are implemented. */
export async function captureRacePlanImpactContext(tx: Transaction, input: unknown) {
  const command = parse(inputSchema, input);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
  await preflight(tx, command.eventId);
  const sources = sourceCache(tx);
  const core = await captureCoreEvidenceDependencies(tx);
  const eventRow = (
    await tx.query(
      'SELECT id,revision,values_json FROM race_event WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
      [tx.athleteId, command.eventId],
    )
  ).rows[0];
  if (!eventRow) fail('EVENT_UNAVAILABLE');
  const event = parse(raceEventSchema, {
    ...parse(z.record(z.string(), z.unknown()), eventRow['values_json']),
    id: eventRow['id'],
    revision: eventRow['revision'],
  });
  if (event.revision !== command.expectedRevision) fail('REVISION_CONFLICT');
  const history = (
    await tx.query(
      'SELECT values_json FROM race_event_revision WHERE athlete_id=$1 AND entity_id=$2 AND revision=$3',
      [tx.athleteId, event.id, event.revision],
    )
  ).rows[0];
  if (!history || digest(history['values_json']) !== digest(eventRow['values_json']))
    fail('INVALID_CONTEXT');
  sources.seedRace(event);
  const currentRows = (
    await tx.query(
      `SELECT h.aggregate_id,p.id,p.version,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,p.draft FROM plan_head h LEFT JOIN plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id WHERE h.athlete_id=$1`,
      [tx.athleteId],
    )
  ).rows;
  if (currentRows.length > 1) fail('INVALID_CONTEXT');
  const currentRow = currentRows[0];
  const current = currentRow
    ? {
        aggregateId: parse(uuid, currentRow['aggregate_id']),
        snapshot: snapshot({
          id: currentRow['id'],
          version: currentRow['version'],
          created_at: currentRow['created_at'],
          draft: currentRow['draft'],
        }),
      }
    : null;
  if (current) sources.seedPlan(current.snapshot);
  const linked = event.planVersionId === null ? null : await sources.plan(event.planVersionId);
  if (command.selection.kind === 'move_period') {
    if (current?.snapshot.id !== command.selection.expectedCurrentPlanVersionId)
      fail('REVISION_CONFLICT');
    const sessions = new Set(current.snapshot.draft.sessions.map((item) => item.id)),
      periods = new Set(current.snapshot.draft.periods.map((item) => item.id));
    if (
      command.selection.changedSessionIds.some((id) => !sessions.has(id)) ||
      command.selection.movedPeriodIds.some((id) => !periods.has(id))
    )
      fail('INVALID_CONTEXT');
  }
  const course = await captureCourse(tx, event);
  const collections = (
    await tx.query(
      'SELECT kind,revision,privacy_generation::text AS privacy_generation FROM race_collection_head WHERE athlete_id=$1 ORDER BY kind',
      [tx.athleteId],
    )
  ).rows.map((row) =>
    parse(
      z.strictObject({
        kind: z.enum(['race-event', 'race-result', 'training-best']),
        revision,
        privacy_generation: decimal,
      }),
      row,
    ),
  );
  const completionRows = (
    await tx.query(
      'SELECT session_id,revision,record_json FROM session_completion WHERE athlete_id=$1 ORDER BY session_id LIMIT 1001',
      [tx.athleteId],
    )
  ).rows;
  if (completionRows.length > cap) fail('CONTEXT_LIMIT');
  const completions = completionRows.map((row) => {
    const parsed = parse(
      z.strictObject({
        session_id: z.string().min(1).max(200),
        revision,
        record_json: sessionCompletionSchema,
      }),
      row,
    );
    if (
      parsed.record_json.sessionId !== parsed.session_id ||
      parsed.record_json.revision !== parsed.revision
    )
      fail('INVALID_CONTEXT');
    if (
      parsed.record_json.status === 'completed' &&
      (!current ||
        !current.snapshot.draft.sessions.some((session) => session.id === parsed.session_id))
    )
      fail('INVALID_CONTEXT');
    return parsed.record_json;
  });
  if (current && !preservesSessionCompletions(current.snapshot.draft, completions))
    fail('INVALID_CONTEXT');
  const nutrients = await roster(tx, 'nutrition'),
    recoveries = await roster(tx, 'recovery'),
    schedules = await roster(tx, 'routine');
  const nutrition = [];
  for (const row of nutrients) {
    const record = parse(nutritionPlanVersionSchema, row.record_json);
    if (record.planId !== row.aggregate_id || record.versionId !== row.version_id)
      fail('INVALID_CONTEXT');
    const source =
      record.linkedTrainingPlanVersionId === null
        ? null
        : await sources.plan(record.linkedTrainingPlanVersionId);
    const items = await Promise.all(
      record.items
        .filter((item) => item.anchor.kind === 'relative')
        .map(async (item) => {
          const anchor = item.anchor;
          if (anchor.kind !== 'relative') return fail('INVALID_CONTEXT');
          if (anchor.entity === 'race') {
            const race = await sources.race(anchor.entityId);
            return {
              itemId: item.id,
              entity: 'race' as const,
              entityId: race.id,
              sourceVersionId: null,
              affected: race.id === event.id,
              point: anchor.point,
              sourceRaceRevision: race.revision,
              sourceRaceDigest: digest(race),
              timing: 'not_resolved' as const,
            };
          }
          if (!source?.draft.sessions.some((session) => session.id === anchor.entityId))
            fail('SOURCE_UNAVAILABLE');
          return {
            itemId: item.id,
            entity: 'session' as const,
            entityId: anchor.entityId,
            sourceVersionId: source.id,
            affected:
              command.selection.kind === 'move_period' &&
              source.id === current?.snapshot.id &&
              command.selection.changedSessionIds.includes(anchor.entityId),
            point: anchor.point,
            timing: 'not_resolved' as const,
          };
        }),
    );
    nutrition.push({
      aggregateId: row.aggregate_id,
      versionId: row.version_id,
      record,
      sourceRelation:
        source === null
          ? ('absent' as const)
          : source.id === current?.snapshot.id
            ? ('current' as const)
            : ('historical' as const),
      relativeItems: items,
    });
  }
  const recovery = [];
  for (const row of recoveries) {
    const record = parse(recoveryStrategyVersionSchema, row.record_json);
    if (record.strategyId !== row.aggregate_id || record.versionId !== row.version_id)
      fail('INVALID_CONTEXT');
    for (const ref of record.draft.planRefs) {
      if (ref.kind === 'training') {
        await sources.plan(ref.headVersionId);
        const ownedAggregate = await tx.query(
          'SELECT aggregate_id FROM plan_head WHERE athlete_id=$1 AND aggregate_id=$2',
          [tx.athleteId, ref.aggregateId],
        );
        if (!ownedAggregate.rows[0] && ref.aggregateId !== ref.headVersionId)
          fail('SOURCE_UNAVAILABLE');
      } else {
        const found = await tx.query(
          'SELECT version_id FROM nutrition_plan_version WHERE athlete_id=$1 AND plan_id=$2 AND version_id=$3',
          [tx.athleteId, ref.aggregateId, ref.headVersionId],
        );
        if (!found.rows[0]) fail('SOURCE_UNAVAILABLE');
      }
    }
    recovery.push({ aggregateId: row.aggregate_id, versionId: row.version_id, record });
  }
  const routines = [];
  for (const row of schedules) {
    const record = parse(routineScheduleVersionSchema, row.record_json);
    if (record.id !== row.aggregate_id || record.versionId !== row.version_id)
      fail('INVALID_CONTEXT');
    const sourceRow = (
      await tx.query(
        'SELECT source_plan_version_id,blueprint_routine_id,blueprint_version_id FROM routine_schedule_version WHERE athlete_id=$1 AND version_id=$2',
        [tx.athleteId, row.version_id],
      )
    ).rows[0];
    const ref = parse(
      z.strictObject({
        source_plan_version_id: uuid.nullable(),
        blueprint_routine_id: uuid,
        blueprint_version_id: uuid,
      }),
      sourceRow,
    );
    if (
      ref.blueprint_routine_id !== record.blueprint.id ||
      ref.blueprint_version_id !== record.blueprint.versionId
    )
      fail('INVALID_CONTEXT');
    const blueprint = await tx.query(
      'SELECT version_id FROM routine_blueprint_version WHERE athlete_id=$1 AND routine_id=$2 AND version_id=$3',
      [tx.athleteId, record.blueprint.id, record.blueprint.versionId],
    );
    if (!blueprint.rows[0]) fail('SOURCE_UNAVAILABLE');
    const source =
      ref.source_plan_version_id === null ? null : await sources.plan(ref.source_plan_version_id);
    if (
      (record.rule.kind === 'period_days' || record.rule.kind === 'session_links') &&
      source === null
    )
      fail('SOURCE_UNAVAILABLE');
    if (record.rule.kind === 'period_days') {
      const rule = record.rule;
      if (!source?.draft.periods.some((period) => period.id === rule.periodId))
        fail('SOURCE_UNAVAILABLE');
    }
    if (record.rule.kind === 'session_links') {
      const rule = record.rule;
      if (
        rule.sessionIds.some((id) => !source?.draft.sessions.some((session) => session.id === id))
      )
        fail('SOURCE_UNAVAILABLE');
    }
    const rule = record.rule;
    const affected =
      command.selection.kind === 'move_period' &&
      source?.id === current?.snapshot.id &&
      ((rule.kind === 'period_days' && command.selection.movedPeriodIds.includes(rule.periodId)) ||
        (rule.kind === 'session_links' &&
          rule.sessionIds.some(
            (id) =>
              command.selection.kind === 'move_period' &&
              command.selection.changedSessionIds.includes(id),
          )));
    routines.push({
      aggregateId: row.aggregate_id,
      versionId: row.version_id,
      record,
      sourceVersionId: source?.id ?? null,
      sourceRelation:
        source === null
          ? ('absent' as const)
          : source.id === current?.snapshot.id
            ? ('current' as const)
            : ('historical' as const),
      affected,
    });
  }
  let dependencyInventory: Awaited<ReturnType<typeof captureIntegratedDependencyInventory>>;
  let supplementaryManifest: Awaited<ReturnType<typeof captureSupplementaryReferenceManifest>>;
  try {
    dependencyInventory = await captureIntegratedDependencyInventory(tx);
    supplementaryManifest = await captureSupplementaryReferenceManifest(
      tx,
      await sources.consumedPlans(),
      sources.sourceCount(),
    );
  } catch (error) {
    if (error instanceof RaceImpactDependencyError)
      throw new RacePlanImpactContextError(
        error.code,
        error.code === 'CONTEXT_UNAVAILABLE' ? 'unique_sources' : undefined,
      );
    throw error;
  }
  const rosters = {
    nutrition: nutrition.map((row) => ({ aggregateId: row.aggregateId, versionId: row.versionId })),
    recovery: recovery.map((row) => ({ aggregateId: row.aggregateId, versionId: row.versionId })),
    routine: routines.map((row) => ({ aggregateId: row.aggregateId, versionId: row.versionId })),
  };
  const readSet = {
    athleteId: tx.athleteId,
    event,
    collections,
    linkedPlan: linked,
    currentTraining: current,
    completions,
    course,
    rosters,
    nutrition,
    recovery,
    routines,
    coreDependencies: core,
    dependencyInventory,
    supplementaryManifest,
  };
  // capturedAt is metadata, never a changing freshness value.
  const readSetDigest = digest({ ...readSet, coreDependencies: { ...core, capturedAt: null } });
  return {
    status: 'blocked' as const,
    coverage: {
      complete: false as const,
      missing: missingDependencies,
      captured: [
        'integrated_dependency_inventory',
        'immutable_supplementary_copy_references',
      ] as const,
    },
    ...readSet,
    readSetDigest,
    affected: {
      nutrition: nutrition
        .filter((row) => row.relativeItems.some((item) => item.affected))
        .map((row) => row.aggregateId),
      routine: routines.filter((row) => row.affected).map((row) => row.aggregateId),
    },
  };
}
async function captureCourse(tx: Transaction, event: RaceEvent) {
  if (event.course === null) return null;
  const ref = event.course;
  const row = (
    await tx.query(
      `SELECT c.status,r.revision_id,r.content_digest FROM course c JOIN course_revision r ON r.athlete_id=c.athlete_id AND r.course_id=c.course_id WHERE c.athlete_id=$1 AND c.course_id=$2 AND r.course_revision=$3 AND r.revision_id=$4`,
      [tx.athleteId, ref.courseId, ref.courseRevision, ref.revisionId],
    )
  ).rows[0];
  if (!row) fail('SOURCE_UNAVAILABLE');
  const course = parse(
    z.strictObject({
      status: z.literal('available'),
      revision_id: uuid,
      content_digest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    row,
  );
  return { ref, digest: course.content_digest };
}
export type RacePlanImpactContext = Awaited<ReturnType<typeof captureRacePlanImpactContext>>;
