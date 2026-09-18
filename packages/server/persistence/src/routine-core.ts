import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  routineBlueprintReadSchema,
  routineBlueprintSaveCommandSchema,
  routineLibraryCommandSchema,
  routineRunChoiceCommandSchema,
  routineRunLifecycleCommandSchema,
  routineRunReadSchema,
  routineRunStartCommandSchema,
  routineRunStepCommandSchema,
  routineScheduleApproveCommandSchema,
  routineSchedulePreviewCommandSchema,
  routineSchedulePreviewSchema,
  routineScheduleReadSchema,
  routineScheduleStateCommandSchema,
  routineTimerCommandSchema,
  routineTimerSchema,
  type RoutineBlueprintRead,
  type RoutineBlueprintSaveCommand,
  type RoutineLibraryCommand,
  type RoutineRunChoiceCommand,
  type RoutineRunLifecycleCommand,
  type RoutineRunRead,
  type RoutineRunStartCommand,
  type RoutineRunStepCommand,
  type RoutineScheduleApproveCommand,
  type RoutineSchedulePreview,
  type RoutineSchedulePreviewCommand,
  type RoutineScheduleRead,
  type RoutineScheduleStateCommand,
  type RoutineTimer,
  type RoutineTimerCommand,
} from '@workout/contracts/routine-commands';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  routineScheduleVersionSchema,
  type ActualRef,
  type RoutineBlueprintVersion,
  type RoutineRun,
} from '@workout/contracts/routines';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { expandRoutineSchedule, localDateOf, parsePlanDraft } from './routine-expansion.js';

export { RoutineExpansionError } from './routine-expansion.js';
export class RoutineReferenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class RoutineConflict extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const uuid = z.uuid().transform((value) => value.toLowerCase());
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();
const maxList = 100;
type Page<T> = { items: T[]; hasMore: boolean };
const page = <T>(items: T[]): Page<T> => ({
  items: items.slice(0, maxList),
  hasMore: items.length > maxList,
});
function required<T>(value: T | null | undefined, code: string): T {
  if (value === null || value === undefined) throw new RoutineReferenceError(code);
  return value;
}

export interface RoutineRepository {
  saveBlueprint(
    athleteId: string,
    command: RoutineBlueprintSaveCommand,
  ): Promise<RoutineBlueprintRead>;
  readBlueprint(athleteId: string, routineId: string): Promise<RoutineBlueprintRead | null>;
  readBlueprintVersion(
    athleteId: string,
    versionId: string,
  ): Promise<RoutineBlueprintVersion | null>;
  listBlueprints(
    athleteId: string,
    query: {
      search?: string | undefined;
      favorite?: boolean | undefined;
      archived?: boolean | undefined;
    },
  ): Promise<Page<RoutineBlueprintRead>>;
  changeLibrary(athleteId: string, command: RoutineLibraryCommand): Promise<RoutineBlueprintRead>;
  previewSchedule(
    athleteId: string,
    command: RoutineSchedulePreviewCommand,
  ): Promise<RoutineSchedulePreview>;
  approveSchedule(
    athleteId: string,
    command: RoutineScheduleApproveCommand,
  ): Promise<RoutineScheduleRead>;
  readSchedule(athleteId: string, scheduleId: string): Promise<RoutineScheduleRead | null>;
  listSchedules(athleteId: string): Promise<Page<RoutineScheduleRead>>;
  changeSchedule(
    athleteId: string,
    command: RoutineScheduleStateCommand,
  ): Promise<RoutineScheduleRead>;
  startRun(athleteId: string, command: RoutineRunStartCommand): Promise<RoutineRunRead>;
  readRun(athleteId: string, runId: string): Promise<RoutineRunRead | null>;
  listRuns(athleteId: string): Promise<Page<RoutineRunRead>>;
  chooseStep(athleteId: string, command: RoutineRunChoiceCommand): Promise<RoutineRunRead>;
  recordStep(athleteId: string, command: RoutineRunStepCommand): Promise<RoutineRunRead>;
  changeRun(athleteId: string, command: RoutineRunLifecycleCommand): Promise<RoutineRunRead>;
  commandTimer(athleteId: string, command: RoutineTimerCommand): Promise<RoutineTimer>;
}

async function lock(tx: Transaction) {
  // Same athlete lock as supplementary content and joint approval.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
}
async function replay<T>(tx: Transaction, key: string, request: unknown, schema: z.ZodType<T>) {
  const result = await tx.query(
    'SELECT request_hash,result_json FROM routine_command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row['request_hash'] !== hash(request)) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return schema.parse(row['result_json']);
}
async function finish<T>(tx: Transaction, key: string, request: unknown, result: T, topic: string) {
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: `routine:${key}`,
    topic,
    payload: { athleteId: tx.athleteId },
  });
  await tx.query(
    'INSERT INTO routine_command_receipt(athlete_id,idempotency_key,request_hash,result_json) VALUES($1,$2,$3,$4::jsonb)',
    [tx.athleteId, key, hash(request), JSON.stringify(result)],
  );
  return result;
}
async function command<T>(
  db: Database,
  athleteId: string,
  key: string,
  request: unknown,
  schema: z.ZodType<T>,
  topic: string,
  apply: (tx: Transaction) => Promise<T>,
) {
  return db.tenant(athleteId, async (tx) => {
    await lock(tx);
    const found = await replay(tx, key, request, schema);
    if (found !== null) return found;
    const result = schema.parse(await apply(tx));
    return finish(tx, key, request, result, topic);
  });
}
async function blueprintVersion(tx: Transaction, versionId: string) {
  const row = (
    await tx.query(
      'SELECT record_json FROM routine_blueprint_version WHERE athlete_id=$1 AND version_id=$2',
      [tx.athleteId, versionId],
    )
  ).rows[0];
  return row ? routineBlueprintVersionSchema.parse(row['record_json']) : null;
}
async function blueprintHead(tx: Transaction, routineId: string, forUpdate = false) {
  const row = (
    await tx.query(
      `SELECT h.version,h.version_id,h.favorite,h.visibility,v.record_json
       FROM routine_blueprint_head h JOIN routine_blueprint_version v
       ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
       WHERE h.athlete_id=$1 AND h.routine_id=$2 ${forUpdate ? 'FOR UPDATE OF h' : ''}`,
      [tx.athleteId, routineId],
    )
  ).rows[0];
  return row
    ? routineBlueprintReadSchema.parse({
        blueprint: row['record_json'],
        version: row['version'],
        favorite: row['favorite'],
        visibility: row['visibility'],
      })
    : null;
}
async function validateContentRefs(tx: Transaction, blueprint: RoutineBlueprintVersion) {
  for (const step of blueprint.steps) {
    const { content } = step;
    if (content.kind === 'checklist') continue;
    if (content.kind === 'workout_template') {
      const result = await tx.query(
        `SELECT 1 FROM supplementary_routine_version v
         WHERE v.athlete_id=$1 AND v.routine_id=$2 AND v.version_id=$3`,
        [tx.athleteId, uuid.parse(content.ref.id), uuid.parse(content.ref.versionId)],
      );
      if (!result.rowCount) throw new RoutineReferenceError('WORKOUT_TEMPLATE_NOT_FOUND');
    } else if (content.kind === 'nutrition_template') {
      const result = await tx.query(
        `SELECT 1 FROM nutrition_plan_version v
         WHERE v.athlete_id=$1 AND v.plan_id=$2 AND v.version_id=$3`,
        [tx.athleteId, uuid.parse(content.ref.id), uuid.parse(content.ref.versionId)],
      );
      if (!result.rowCount) throw new RoutineReferenceError('NUTRITION_PLAN_NOT_FOUND');
    } else {
      // A reference without an owned, versioned catalog is never accepted.
      throw new RoutineReferenceError('CONTENT_REFERENCE_UNAVAILABLE');
    }
  }
}

async function planForSchedule(tx: Transaction, planVersionId: string | null) {
  if (planVersionId === null) return { plan: null, head: null };
  const row = (
    await tx.query(
      `SELECT p.draft,h.version_id AS head FROM plan_snapshot p
       LEFT JOIN plan_head h ON h.athlete_id=p.athlete_id
       WHERE p.athlete_id=$1 AND p.id=$2`,
      [tx.athleteId, planVersionId],
    )
  ).rows[0];
  if (!row) throw new RoutineReferenceError('SOURCE_PLAN_NOT_FOUND');
  if (row['head'] !== planVersionId) throw new RoutineConflict('STALE_SOURCE_PLAN');
  return { plan: parsePlanDraft(row['draft']), head: planVersionId };
}
async function preview(tx: Transaction, input: RoutineSchedulePreviewCommand) {
  const schedule = routineScheduleVersionSchema.parse(input.schedule);
  uuid.parse(schedule.id);
  uuid.parse(schedule.versionId);
  if (schedule.state !== 'draft') throw new RoutineReferenceError('SCHEDULE_MUST_BE_DRAFT');
  const blueprint = await blueprintVersion(tx, uuid.parse(schedule.blueprint.versionId));
  if (!blueprint || blueprint.routineId !== schedule.blueprint.id)
    throw new RoutineReferenceError('BLUEPRINT_NOT_FOUND');
  const head = await blueprintHead(tx, blueprint.routineId);
  if (!head || head.visibility !== 'active')
    throw new RoutineReferenceError('BLUEPRINT_UNAVAILABLE');
  await validateContentRefs(tx, blueprint);
  const { plan, head: planHead } = await planForSchedule(tx, input.sourcePlanVersionId);
  const occurrences = expandRoutineSchedule(schedule, plan);
  const conflicts: RoutineSchedulePreview['conflicts'] = [];
  for (const occurrence of occurrences) {
    if (occurrence.timingStatus === 'unresolved')
      conflicts.push({
        anchorKey: occurrence.anchorKey,
        kind: 'unresolved_anchor',
        description: '시각 기준이 확인되지 않았습니다.',
      });
  }
  if (plan) {
    for (const occurrence of occurrences) {
      if (occurrence.scheduledAt === null) continue;
      const date = localDateOf(occurrence.scheduledAt, schedule.window.timezone);
      for (const session of plan.sessions.filter((item) => item.date === date)) {
        conflicts.push({
          anchorKey: occurrence.anchorKey,
          kind: session.locks.date || session.locks.time ? 'locked_session' : 'session_overlap',
          description: `훈련 세션 ${session.id}과 같은 날짜입니다.`,
        });
      }
    }
  }
  const existing = await tx.query(
    `SELECT scheduled_at FROM routine_occurrence
     WHERE athlete_id=$1 AND scheduled_at=ANY($2::timestamptz[])`,
    [tx.athleteId, occurrences.flatMap((item) => (item.scheduledAt ? [item.scheduledAt] : []))],
  );
  if (existing.rowCount) {
    const occupied = new Set(existing.rows.map((row) => iso(row['scheduled_at'])));
    for (const occurrence of occurrences) {
      if (occurrence.scheduledAt !== null && occupied.has(occurrence.scheduledAt))
        conflicts.push({
          anchorKey: occurrence.anchorKey,
          kind: 'routine_overlap',
          description: '다른 루틴이 같은 시각에 배치돼 있을 수 있습니다.',
        });
    }
  }
  const previewDigest = hash({
    schedule,
    sourcePlanVersionId: input.sourcePlanVersionId,
    planHead,
    occurrences,
    conflicts,
  });
  return routineSchedulePreviewSchema.parse({
    schedule,
    sourcePlanVersionId: input.sourcePlanVersionId,
    occurrences,
    conflicts,
    previewDigest,
  });
}

async function scheduleRead(
  tx: Transaction,
  scheduleId: string,
): Promise<RoutineScheduleRead | null> {
  const row = (
    await tx.query(
      `SELECT v.record_json,v.source_plan_version_id,h.notification_muted
     FROM routine_schedule_head h JOIN routine_schedule_version v
       ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
     WHERE h.athlete_id=$1 AND h.schedule_id=$2`,
      [tx.athleteId, scheduleId],
    )
  ).rows[0];
  if (!row) return null;
  const rows = (
    await tx.query(
      `SELECT record_json FROM routine_occurrence WHERE athlete_id=$1 AND schedule_id=$2
     ORDER BY scheduled_at NULLS LAST,anchor_key,id LIMIT 101`,
      [tx.athleteId, scheduleId],
    )
  ).rows;
  return routineScheduleReadSchema.parse({
    schedule: row['record_json'],
    sourcePlanVersionId: row['source_plan_version_id'],
    occurrences: rows.map((item) => item['record_json']),
    notificationMuted: row['notification_muted'],
    impactDigest: hash({
      schedule: row['record_json'],
      occurrences: rows.map((item) => item['record_json']),
    }),
  });
}
async function runRead(tx: Transaction, runId: string): Promise<RoutineRunRead | null> {
  const row = (
    await tx.query('SELECT record_json FROM routine_run WHERE athlete_id=$1 AND id=$2', [
      tx.athleteId,
      runId,
    ])
  ).rows[0];
  if (!row) return null;
  const timers = (
    await tx.query(
      `SELECT run_id,step_id,revision,state,duration_seconds,started_at,paused_at,paused_milliseconds
       FROM routine_step_timer WHERE athlete_id=$1 AND run_id=$2 ORDER BY step_id`,
      [tx.athleteId, runId],
    )
  ).rows.map((item) =>
    routineTimerSchema.parse({
      runId: item['run_id'],
      stepId: item['step_id'],
      revision: item['revision'],
      state: item['state'],
      durationSeconds: item['duration_seconds'],
      startedAt: iso(item['started_at']),
      pausedAt: item['paused_at'] === null ? null : iso(item['paused_at']),
      pausedMilliseconds: Number(item['paused_milliseconds']),
    }),
  );
  return routineRunReadSchema.parse({ run: row['record_json'], timers });
}
async function lockedRun(tx: Transaction, runId: string) {
  const row = (
    await tx.query('SELECT record_json FROM routine_run WHERE athlete_id=$1 AND id=$2 FOR UPDATE', [
      tx.athleteId,
      runId,
    ])
  ).rows[0];
  if (!row) throw new RoutineReferenceError('RUN_NOT_FOUND');
  return routineRunSchema.parse(row['record_json']);
}
async function writeRun(tx: Transaction, run: RoutineRun) {
  const parsed = routineRunSchema.parse(run);
  await tx.query(
    `UPDATE routine_run SET revision=$3,state=$4,record_json=$5::jsonb
       WHERE athlete_id=$1 AND id=$2 AND revision=$6`,
    [
      tx.athleteId,
      parsed.id,
      parsed.revision,
      parsed.state,
      JSON.stringify(parsed),
      parsed.revision - 1,
    ],
  );
  await tx.query(
    'INSERT INTO routine_run_revision(athlete_id,run_id,revision,record_json) VALUES($1,$2,$3,$4::jsonb)',
    [tx.athleteId, parsed.id, parsed.revision, JSON.stringify(parsed)],
  );
  return required(await runRead(tx, parsed.id), 'RUN_WRITE_FAILED');
}
async function validateActual(tx: Transaction, ref: ActualRef, stepKind: string): Promise<string> {
  if (ref.kind === 'activity') {
    if (stepKind !== 'workout_template') throw new RoutineReferenceError('ACTUAL_KIND_MISMATCH');
    if (ref.allocationId !== null) throw new RoutineReferenceError('ALLOCATION_UNSUPPORTED');
    const row = (
      await tx.query(
        `SELECT c.revision,
        CASE WHEN o.values_json ? 'startedAt' THEN o.values_json->>'startedAt'
          ELSE c.original->>'startedAt' END AS occurred_at
       FROM activity_canonical c LEFT JOIN activity_overlay o
         ON o.athlete_id=c.athlete_id AND o.activity_id=c.id
       WHERE c.athlete_id=$1 AND c.id=$2 AND NOT c.deleted FOR SHARE OF c`,
        [tx.athleteId, uuid.parse(ref.id)],
      )
    ).rows[0];
    if (!row || String(row['revision']) !== ref.revisionId)
      throw new RoutineReferenceError('ACTUAL_NOT_FOUND');
    if (ref.detailId !== null) {
      const detail = await tx.query(
        `SELECT 1 FROM supplementary_set_log WHERE athlete_id=$1 AND id=$2
           AND activity_id=$3 AND status='active'`,
        [tx.athleteId, uuid.parse(ref.detailId), ref.id],
      );
      if (!detail.rowCount) throw new RoutineReferenceError('ACTUAL_DETAIL_NOT_FOUND');
    }
    if (row['occurred_at'] === null) throw new RoutineReferenceError('ACTUAL_TIME_UNKNOWN');
    return iso(row['occurred_at']);
  } else if (ref.kind === 'intake') {
    if (stepKind !== 'nutrition_template') throw new RoutineReferenceError('ACTUAL_KIND_MISMATCH');
    const row = await tx.query(
      `SELECT r.occurred_at FROM intake_entry e JOIN intake_entry_revision r
       ON r.athlete_id=e.athlete_id AND r.intake_id=e.id
          AND r.revision=e.current_revision
       WHERE e.athlete_id=$1 AND e.id=$2 AND
         e.current_revision_id=$3 AND e.status='active' FOR SHARE OF e`,
      [tx.athleteId, ref.id, uuid.parse(ref.revisionId)],
    );
    if (!row.rowCount) throw new RoutineReferenceError('ACTUAL_NOT_FOUND');
    return iso(row.rows[0]?.['occurred_at']);
  } else if (ref.kind === 'checkin') {
    if (stepKind !== 'checkin_template') throw new RoutineReferenceError('ACTUAL_KIND_MISMATCH');
    const row = await tx.query(
      'SELECT recorded_at FROM check_in WHERE athlete_id=$1 AND id=$2 AND revision=$3 AND NOT deleted FOR SHARE',
      [tx.athleteId, uuid.parse(ref.id), Number(ref.revisionId)],
    );
    if (!row.rowCount) throw new RoutineReferenceError('ACTUAL_NOT_FOUND');
    return iso(row.rows[0]?.['recorded_at']);
  } else {
    throw new RoutineReferenceError('ACTUAL_KIND_UNAVAILABLE');
  }
}

export function createRoutineRepository(db: Database): RoutineRepository {
  return {
    async saveBlueprint(athleteId, raw) {
      const input = routineBlueprintSaveCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'saveBlueprint', input },
        routineBlueprintReadSchema,
        'routine.blueprint.saved',
        async (tx) => {
          const blueprint = input.blueprint;
          uuid.parse(blueprint.routineId);
          uuid.parse(blueprint.versionId);
          if (
            blueprint.status === 'archived' ||
            blueprint.steps.length > 30 ||
            blueprint.title.length > 200
          )
            throw new RoutineReferenceError('INVALID_BLUEPRINT');
          await validateContentRefs(tx, blueprint);
          const head = await blueprintHead(tx, blueprint.routineId, true);
          if (head?.visibility === 'deleted') throw new RoutineReferenceError('BLUEPRINT_DELETED');
          if ((head?.blueprint.versionId ?? null) !== input.expectedVersionId)
            throw new RoutineConflict('STALE_BLUEPRINT');
          const version = (head?.version ?? 0) + 1;
          await tx.query(
            `INSERT INTO routine_blueprint_version
             (athlete_id,routine_id,version_id,version,previous_version_id,record_json,created_at)
             VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
            [
              athleteId,
              blueprint.routineId,
              blueprint.versionId,
              version,
              head?.blueprint.versionId ?? null,
              JSON.stringify(blueprint),
              blueprint.createdAt,
            ],
          );
          if (head) {
            await tx.query(
              `UPDATE routine_blueprint_head SET version_id=$3,version=$4
               WHERE athlete_id=$1 AND routine_id=$2`,
              [athleteId, blueprint.routineId, blueprint.versionId, version],
            );
          } else {
            await tx.query(
              `INSERT INTO routine_blueprint_head
               (athlete_id,routine_id,version_id,version,visibility)
               VALUES($1,$2,$3,$4,'active')`,
              [athleteId, blueprint.routineId, blueprint.versionId, version],
            );
          }
          return required(await blueprintHead(tx, blueprint.routineId), 'BLUEPRINT_WRITE_FAILED');
        },
      );
    },
    readBlueprint: (athleteId, routineId) =>
      db.tenant(athleteId, async (tx) => {
        const record = await blueprintHead(tx, uuid.parse(routineId));
        return record?.visibility === 'deleted' ? null : record;
      }),
    readBlueprintVersion: (athleteId, versionId) =>
      db.tenant(athleteId, async (tx) => blueprintVersion(tx, uuid.parse(versionId))),
    listBlueprints: (athleteId, query) =>
      db.tenant(athleteId, async (tx) => {
        const rows = (
          await tx.query(
            `SELECT v.record_json,h.version,h.favorite,h.visibility
         FROM routine_blueprint_head h JOIN routine_blueprint_version v
           ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
         WHERE h.athlete_id=$1 AND h.visibility <> 'deleted'
           AND ($2::boolean IS NULL OR h.favorite=$2)
           AND ($3::boolean IS NULL OR (h.visibility='archived')=$3)
           AND ($4::text IS NULL OR v.record_json->>'title' ILIKE '%' || $4 || '%')
         ORDER BY v.created_at DESC,h.routine_id LIMIT 101`,
            [athleteId, query.favorite ?? null, query.archived ?? false, query.search ?? null],
          )
        ).rows;
        return page(
          rows.map((row) =>
            routineBlueprintReadSchema.parse({
              blueprint: row['record_json'],
              version: row['version'],
              favorite: row['favorite'],
              visibility: row['visibility'],
            }),
          ),
        );
      }),
    async changeLibrary(athleteId, raw) {
      const input = routineLibraryCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'changeLibrary', input },
        routineBlueprintReadSchema,
        'routine.library.changed',
        async (tx) => {
          const head = await blueprintHead(tx, input.routineId, true);
          if (!head || head.visibility === 'deleted')
            throw new RoutineReferenceError('BLUEPRINT_NOT_FOUND');
          if (head.blueprint.versionId !== input.expectedVersionId)
            throw new RoutineConflict('STALE_BLUEPRINT');
          if (input.action === 'delete') {
            const inUse = await tx.query(
              `SELECT 1 FROM routine_schedule_version WHERE athlete_id=$1 AND blueprint_routine_id=$2 LIMIT 1`,
              [athleteId, input.routineId],
            );
            if (inUse.rowCount)
              throw new RoutineReferenceError('DELETE_REQUIRES_SCHEDULE_RESOLUTION');
            throw new RoutineReferenceError('DELETE_REQUIRES_DATA_ERASURE');
          }
          const visibility =
            input.action === 'archive'
              ? 'archived'
              : input.action === 'restore'
                ? 'active'
                : head.visibility;
          const favorite =
            input.action === 'favorite'
              ? true
              : input.action === 'unfavorite'
                ? false
                : head.favorite;
          await tx.query(
            `UPDATE routine_blueprint_head SET visibility=$3,favorite=$4
             WHERE athlete_id=$1 AND routine_id=$2`,
            [athleteId, input.routineId, visibility, favorite],
          );
          return required(await blueprintHead(tx, input.routineId), 'BLUEPRINT_WRITE_FAILED');
        },
      );
    },
    previewSchedule: (athleteId, input) =>
      db.tenant(athleteId, (tx) => preview(tx, routineSchedulePreviewCommandSchema.parse(input))),
    async approveSchedule(athleteId, raw) {
      const input = routineScheduleApproveCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'approveSchedule', input },
        routineScheduleReadSchema,
        'routine.schedule.approved',
        async (tx) => {
          const current = await preview(tx, input);
          if (current.previewDigest !== input.previewDigest)
            throw new RoutineConflict('STALE_SCHEDULE_PREVIEW');
          const exists = await scheduleRead(tx, input.schedule.id);
          if (exists) throw new RoutineConflict('SCHEDULE_EXISTS');
          const schedule = routineScheduleVersionSchema.parse({
            ...input.schedule,
            state: 'active',
          });
          await tx.query(
            `INSERT INTO routine_schedule_version
             (athlete_id,schedule_id,version_id,blueprint_routine_id,
              blueprint_version_id,source_plan_version_id,record_json)
             VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [
              athleteId,
              schedule.id,
              schedule.versionId,
              schedule.blueprint.id,
              schedule.blueprint.versionId,
              input.sourcePlanVersionId,
              JSON.stringify(schedule),
            ],
          );
          await tx.query(
            `INSERT INTO routine_schedule_head(athlete_id,schedule_id,version_id)
             VALUES($1,$2,$3)`,
            [athleteId, schedule.id, schedule.versionId],
          );
          for (const occurrence of current.occurrences) {
            await tx.query(
              `INSERT INTO routine_occurrence
               (athlete_id,id,schedule_id,schedule_version_id,blueprint_routine_id,
                blueprint_version_id,anchor_key,scheduled_at,record_json)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
              [
                athleteId,
                occurrence.id,
                schedule.id,
                schedule.versionId,
                schedule.blueprint.id,
                schedule.blueprint.versionId,
                occurrence.anchorKey,
                occurrence.scheduledAt,
                JSON.stringify(occurrence),
              ],
            );
          }
          return required(await scheduleRead(tx, schedule.id), 'SCHEDULE_WRITE_FAILED');
        },
      );
    },
    readSchedule: (athleteId, scheduleId) =>
      db.tenant(athleteId, (tx) => scheduleRead(tx, uuid.parse(scheduleId))),
    listSchedules: (athleteId) =>
      db.tenant(athleteId, async (tx) => {
        const rows = (
          await tx.query(
            'SELECT schedule_id FROM routine_schedule_head WHERE athlete_id=$1 ORDER BY schedule_id LIMIT 101',
            [athleteId],
          )
        ).rows;
        const records: RoutineScheduleRead[] = [];
        for (const row of rows) {
          const record = await scheduleRead(tx, uuid.parse(row['schedule_id']));
          if (record) records.push(record);
        }
        return page(records);
      }),
    async changeSchedule(athleteId, raw) {
      const input = routineScheduleStateCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'changeSchedule', input },
        routineScheduleReadSchema,
        'routine.schedule.changed',
        async (tx) => {
          const prior = await scheduleRead(tx, input.scheduleId);
          if (!prior) throw new RoutineReferenceError('SCHEDULE_NOT_FOUND');
          if (prior.schedule.versionId !== input.expectedVersionId)
            throw new RoutineConflict('STALE_SCHEDULE');
          if (input.action === 'mute' || input.action === 'unmute') {
            await tx.query(
              `UPDATE routine_schedule_head SET notification_muted=$3
               WHERE athlete_id=$1 AND schedule_id=$2`,
              [athleteId, input.scheduleId, input.action === 'mute'],
            );
          } else {
            if (prior.impactDigest !== input.previewDigest)
              throw new RoutineConflict('STALE_SCHEDULE_PREVIEW');
            const state =
              input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : 'ended';
            if (prior.schedule.state === 'ended' || prior.schedule.state === state)
              throw new RoutineReferenceError('INVALID_SCHEDULE_TRANSITION');
            const next = routineScheduleVersionSchema.parse({
              ...prior.schedule,
              versionId: randomUUID(),
              state,
            });
            await tx.query(
              `INSERT INTO routine_schedule_version
               (athlete_id,schedule_id,version_id,prior_version_id,blueprint_routine_id,
                blueprint_version_id,source_plan_version_id,record_json)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
              [
                athleteId,
                next.id,
                next.versionId,
                prior.schedule.versionId,
                next.blueprint.id,
                next.blueprint.versionId,
                prior.sourcePlanVersionId,
                JSON.stringify(next),
              ],
            );
            await tx.query(
              `UPDATE routine_schedule_head SET version_id=$3
               WHERE athlete_id=$1 AND schedule_id=$2`,
              [athleteId, next.id, next.versionId],
            );
          }
          return required(await scheduleRead(tx, input.scheduleId), 'SCHEDULE_WRITE_FAILED');
        },
      );
    },
    async startRun(athleteId, raw) {
      const input = routineRunStartCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'startRun', input },
        routineRunReadSchema,
        'routine.run.started',
        async (tx) => {
          const blueprint = await blueprintVersion(tx, input.blueprintVersionId);
          if (!blueprint) throw new RoutineReferenceError('BLUEPRINT_NOT_FOUND');
          const head = await blueprintHead(tx, blueprint.routineId);
          if (!head || head.visibility !== 'active')
            throw new RoutineReferenceError('BLUEPRINT_UNAVAILABLE');
          await validateContentRefs(tx, blueprint);
          if (input.occurrenceId !== null) {
            const existingRun = await tx.query(
              'SELECT 1 FROM routine_run WHERE athlete_id=$1 AND occurrence_id=$2',
              [athleteId, input.occurrenceId],
            );
            if (existingRun.rowCount) throw new RoutineConflict('OCCURRENCE_ALREADY_STARTED');
            const row = (
              await tx.query(
                `SELECT o.record_json,h.version_id,v.record_json AS schedule
               FROM routine_occurrence o JOIN routine_schedule_head h
                 ON h.athlete_id=o.athlete_id AND h.schedule_id=o.schedule_id
               JOIN routine_schedule_version v ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
               WHERE o.athlete_id=$1 AND o.id=$2`,
                [athleteId, input.occurrenceId],
              )
            ).rows[0];
            if (!row) throw new RoutineReferenceError('OCCURRENCE_NOT_FOUND');
            const occurrence = routineOccurrenceSchema.parse(row['record_json']);
            const activeSchedule = routineScheduleVersionSchema.parse(row['schedule']);
            if (
              occurrence.blueprint.versionId !== blueprint.versionId ||
              activeSchedule.state !== 'active'
            )
              throw new RoutineReferenceError('OCCURRENCE_UNAVAILABLE');
          }
          const now = new Date().toISOString();
          const run = routineRunSchema.parse({
            id: input.runId,
            revision: 0,
            blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
            origin:
              input.occurrenceId === null
                ? { kind: 'unplanned' }
                : { kind: 'planned', occurrenceId: input.occurrenceId },
            state: 'in_progress',
            progress: [],
            selectedChoices: {},
            startedAt: now,
            endedAt: null,
          });
          await tx.query(
            `INSERT INTO routine_run
             (athlete_id,id,blueprint_routine_id,blueprint_version_id,occurrence_id,revision,state,record_json)
             VALUES($1,$2,$3,$4,$5,0,'in_progress',$6::jsonb)`,
            [
              athleteId,
              run.id,
              blueprint.routineId,
              blueprint.versionId,
              input.occurrenceId,
              JSON.stringify(run),
            ],
          );
          await tx.query(
            `INSERT INTO routine_run_revision(athlete_id,run_id,revision,record_json)
             VALUES($1,$2,0,$3::jsonb)`,
            [athleteId, run.id, JSON.stringify(run)],
          );
          return required(await runRead(tx, run.id), 'RUN_WRITE_FAILED');
        },
      );
    },
    readRun: (athleteId, runId) => db.tenant(athleteId, (tx) => runRead(tx, uuid.parse(runId))),
    listRuns: (athleteId) =>
      db.tenant(athleteId, async (tx) => {
        const rows = (
          await tx.query(
            'SELECT id FROM routine_run WHERE athlete_id=$1 ORDER BY id DESC LIMIT 101',
            [athleteId],
          )
        ).rows;
        const records: RoutineRunRead[] = [];
        for (const row of rows) {
          const record = await runRead(tx, uuid.parse(row['id']));
          if (record) records.push(record);
        }
        return page(records);
      }),
    async chooseStep(athleteId, raw) {
      const input = routineRunChoiceCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'chooseStep', input },
        routineRunReadSchema,
        'routine.run.choice',
        async (tx) => {
          const run = await lockedRun(tx, input.runId);
          if (run.revision !== input.expectedRevision) throw new RoutineConflict('STALE_RUN');
          if (run.state !== 'in_progress') throw new RoutineReferenceError('RUN_NOT_ACTIVE');
          const blueprint = required(
            await blueprintVersion(tx, run.blueprint.versionId),
            'BLUEPRINT_NOT_FOUND',
          );
          const group = blueprint.choiceGroups.find((item) => item.id === input.groupId);
          if (!group?.stepIds.includes(input.stepId))
            throw new RoutineReferenceError('CHOICE_NOT_FOUND');
          if (
            run.progress.some(
              (item) => group.stepIds.includes(item.stepId) && item.state !== 'pending',
            )
          )
            throw new RoutineReferenceError('CHOICE_LOCKED');
          return writeRun(
            tx,
            routineRunSchema.parse({
              ...run,
              revision: run.revision + 1,
              selectedChoices: { ...run.selectedChoices, [input.groupId]: input.stepId },
            }),
          );
        },
      );
    },
    async recordStep(athleteId, raw) {
      const input = routineRunStepCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'recordStep', input },
        routineRunReadSchema,
        'routine.run.step',
        async (tx) => {
          const run = await lockedRun(tx, input.runId);
          if (run.revision !== input.expectedRevision) throw new RoutineConflict('STALE_RUN');
          if (run.state !== 'in_progress') throw new RoutineReferenceError('RUN_NOT_ACTIVE');
          const blueprint = required(
            await blueprintVersion(tx, run.blueprint.versionId),
            'BLUEPRINT_NOT_FOUND',
          );
          const step = blueprint.steps.find((item) => item.id === input.stepId);
          if (!step) throw new RoutineReferenceError('STEP_NOT_FOUND');
          if (step.choiceGroupId !== null && run.selectedChoices[step.choiceGroupId] !== step.id)
            throw new RoutineReferenceError('STEP_NOT_SELECTED');
          const prior = run.progress.find((item) => item.stepId === step.id);
          if (prior && ['performed', 'confirmed_skipped', 'not_applicable'].includes(prior.state))
            throw new RoutineReferenceError('STEP_ALREADY_CONFIRMED');
          let actualRefs = input.actualRefs;
          let occurredAt = input.occurredAt;
          if (step.content.kind === 'checklist' && ['performed', 'partial'].includes(input.state)) {
            if (actualRefs.length || input.occurredAt === null)
              throw new RoutineReferenceError('CHECKLIST_ACTUAL_INVALID');
            if (Date.parse(input.occurredAt) > Date.now())
              throw new RoutineReferenceError('ACTUAL_IN_FUTURE');
            const id = randomUUID();
            const revisionId = randomUUID();
            await tx.query(
              `INSERT INTO routine_checklist_confirmation
               (athlete_id,id,run_id,step_id,revision_id,occurred_at,state)
               VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [athleteId, id, run.id, step.id, revisionId, input.occurredAt, input.state],
            );
            actualRefs = [{ kind: 'checklist_confirmation', id, revisionId }];
          } else {
            if (actualRefs.length > 1)
              throw new RoutineReferenceError('MULTIPLE_ACTUALS_UNSUPPORTED');
            if (['performed', 'partial'].includes(input.state) && actualRefs.length !== 1)
              throw new RoutineReferenceError('ACTUAL_REQUIRED');
            if (input.state === 'confirmed_skipped' && actualRefs.length)
              throw new RoutineReferenceError('SKIPPED_WITH_ACTUAL');
            for (const ref of actualRefs) {
              const sourceTime = await validateActual(tx, ref, step.content.kind);
              if (occurredAt !== null && occurredAt !== sourceTime)
                throw new RoutineReferenceError('ACTUAL_TIME_MISMATCH');
              occurredAt = sourceTime;
            }
          }
          const now = new Date().toISOString();
          const progress = {
            stepId: step.id,
            revision: (prior?.revision ?? 0) + 1,
            state: input.state,
            actualRefs,
            occurredAt,
            recordedAt: now,
            reason: input.reason,
          };
          const next = routineRunSchema.parse({
            ...run,
            revision: run.revision + 1,
            progress: [...run.progress.filter((item) => item.stepId !== step.id), progress],
          });
          return writeRun(tx, next);
        },
      );
    },
    async changeRun(athleteId, raw) {
      const input = routineRunLifecycleCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'changeRun', input },
        routineRunReadSchema,
        'routine.run.changed',
        async (tx) => {
          const run = await lockedRun(tx, input.runId);
          if (run.revision !== input.expectedRevision) throw new RoutineConflict('STALE_RUN');
          const state =
            input.action === 'pause'
              ? 'paused'
              : input.action === 'resume'
                ? 'in_progress'
                : input.action === 'end'
                  ? 'ended'
                  : 'stopped';
          if (
            (run.state !== 'in_progress' || state !== 'paused') &&
            (run.state !== 'paused' || state !== 'in_progress') &&
            !(run.state === 'in_progress' && ['ended', 'stopped'].includes(state)) &&
            !(run.state === 'paused' && state === 'stopped')
          )
            throw new RoutineReferenceError('INVALID_RUN_TRANSITION');
          if (state === 'ended' && run.progress.some((item) => item.state === 'in_progress'))
            throw new RoutineReferenceError('STEP_IN_PROGRESS');
          return writeRun(
            tx,
            routineRunSchema.parse({
              ...run,
              revision: run.revision + 1,
              state,
              endedAt: ['ended', 'stopped'].includes(state) ? new Date().toISOString() : null,
            }),
          );
        },
      );
    },
    async commandTimer(athleteId, raw) {
      const input = routineTimerCommandSchema.parse(raw);
      return command(
        db,
        athleteId,
        input.idempotencyKey,
        { type: 'timer', input },
        routineTimerSchema,
        'routine.timer.changed',
        async (tx) => {
          const run = await lockedRun(tx, input.runId);
          if (run.state !== 'in_progress') throw new RoutineReferenceError('RUN_NOT_ACTIVE');
          const blueprint = required(
            await blueprintVersion(tx, run.blueprint.versionId),
            'BLUEPRINT_NOT_FOUND',
          );
          if (!blueprint.steps.some((item) => item.id === input.stepId))
            throw new RoutineReferenceError('STEP_NOT_FOUND');
          const row = (
            await tx.query(
              `SELECT revision,state,duration_seconds,started_at,paused_at,paused_milliseconds
             FROM routine_step_timer WHERE athlete_id=$1 AND run_id=$2 AND step_id=$3 FOR UPDATE`,
              [athleteId, input.runId, input.stepId],
            )
          ).rows[0];
          if ((row?.['revision'] ?? null) !== input.expectedRevision)
            throw new RoutineConflict('STALE_TIMER');
          const now = new Date();
          if (input.action === 'start') {
            if ((row && row['state'] !== 'cleared') || input.durationSeconds === null)
              throw new RoutineReferenceError('INVALID_TIMER_TRANSITION');
            if (row) {
              await tx.query(
                `UPDATE routine_step_timer SET revision=revision+1,state='running',
                 duration_seconds=$4,started_at=$5,paused_at=NULL,paused_milliseconds=0
                 WHERE athlete_id=$1 AND run_id=$2 AND step_id=$3`,
                [athleteId, input.runId, input.stepId, input.durationSeconds, now],
              );
            } else {
              await tx.query(
                `INSERT INTO routine_step_timer
                 (athlete_id,run_id,step_id,revision,state,duration_seconds,started_at)
                 VALUES($1,$2,$3,1,'running',$4,$5)`,
                [athleteId, input.runId, input.stepId, input.durationSeconds, now],
              );
            }
          } else {
            if (!row) throw new RoutineReferenceError('TIMER_NOT_FOUND');
            if (input.action === 'pause' && row['state'] !== 'running')
              throw new RoutineReferenceError('INVALID_TIMER_TRANSITION');
            if (input.action === 'resume' && row['state'] !== 'paused')
              throw new RoutineReferenceError('INVALID_TIMER_TRANSITION');
            if (input.action === 'clear' && row['state'] === 'cleared')
              throw new RoutineReferenceError('INVALID_TIMER_TRANSITION');
            const extra =
              input.action === 'resume' && row['paused_at'] instanceof Date
                ? now.getTime() - row['paused_at'].getTime()
                : 0;
            await tx.query(
              `UPDATE routine_step_timer SET revision=revision+1,state=$4,
               paused_at=$5,paused_milliseconds=paused_milliseconds+$6
               WHERE athlete_id=$1 AND run_id=$2 AND step_id=$3`,
              [
                athleteId,
                input.runId,
                input.stepId,
                input.action === 'pause'
                  ? 'paused'
                  : input.action === 'clear'
                    ? 'cleared'
                    : 'running',
                input.action === 'pause' ? now : null,
                extra,
              ],
            );
          }
          const result = required(await runRead(tx, input.runId), 'RUN_NOT_FOUND');
          const timer = result.timers.find((item) => item.stepId === input.stepId);
          if (!timer) throw new Error('TIMER_WRITE_FAILED');
          return timer;
        },
      );
    },
  };
}
