import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { activityOverlaySchema, activityReportSchema } from '@workout/contracts/activity';
import { activityDetailsV3Schema } from '@workout/contracts/activity-details';
import {
  executionCreateCommandSchema,
  executionStatusCommandSchema,
  exerciseVersionReadSchema,
  exerciseVersionSaveCommandSchema,
  restTimerCommandSchema,
  restTimerStateSchema,
  routineTemplateReadSchema,
  routineTemplateSaveCommandSchema,
  setLogCorrectCommandSchema,
  setLogCreateCommandSchema,
  setLogDeleteCommandSchema,
  setLogReadSchema,
  supplementaryExecutionSchema,
  supplementaryExerciseVersionSchema,
  supplementarySessionLinkSchema,
  supplementarySetLogRevisionSchema,
  type ExecutionCreateCommand,
  type ExecutionStatusCommand,
  type ExerciseVersionRead,
  type ExerciseVersionSaveCommand,
  type RestTimerCommand,
  type RestTimerState,
  type RoutineTemplateRead,
  type RoutineTemplateSaveCommand,
  type SetLogCorrectCommand,
  type SetLogCreateCommand,
  type SetLogDeleteCommand,
  type SetLogRead,
  type SupplementaryExecution,
  type SupplementarySessionLink,
} from '@workout/contracts/supplementary-core';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const localId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const ordinal = z.number().int().min(1).max(2147483646);
const maxOrdinal = 2147483646;

export class SupplementaryReferenceError extends Error {
  constructor(
    readonly code:
      | 'EXERCISE_NOT_FOUND'
      | 'ROUTINE_NOT_FOUND'
      | 'SESSION_LINK_INVALID'
      | 'ACTIVITY_NOT_FOUND'
      | 'ACTIVITY_INVALID'
      | 'EXECUTION_NOT_FOUND'
      | 'SET_LOG_NOT_FOUND'
      | 'TIMER_NOT_FOUND'
      | 'TARGET_LINK_INVALID',
  ) {
    super(code);
  }
}

export interface SupplementaryList<T> {
  items: T[];
  hasMore: boolean;
}

export interface SupplementaryRepository {
  saveExercise(athleteId: string, input: ExerciseVersionSaveCommand): Promise<ExerciseVersionRead>;
  readExercise(athleteId: string, exerciseId: string): Promise<ExerciseVersionRead | null>;
  listExercises(athleteId: string): Promise<SupplementaryList<ExerciseVersionRead>>;
  saveRoutine(athleteId: string, input: RoutineTemplateSaveCommand): Promise<RoutineTemplateRead>;
  readRoutine(athleteId: string, routineId: string): Promise<RoutineTemplateRead | null>;
  readRoutineVersion(athleteId: string, versionId: string): Promise<RoutineTemplateRead | null>;
  listRoutines(athleteId: string): Promise<SupplementaryList<RoutineTemplateRead>>;
  readSessionLink(
    athleteId: string,
    planVersionId: string,
    sessionId: string,
  ): Promise<SupplementarySessionLink | null>;
  createExecution(
    athleteId: string,
    input: ExecutionCreateCommand,
  ): Promise<SupplementaryExecution>;
  completeExecution(
    athleteId: string,
    input: ExecutionStatusCommand,
  ): Promise<SupplementaryExecution>;
  readExecution(athleteId: string, executionId: string): Promise<SupplementaryExecution | null>;
  listExecutions(athleteId: string): Promise<SupplementaryList<SupplementaryExecution>>;
  createSetLog(athleteId: string, input: SetLogCreateCommand): Promise<SetLogRead>;
  correctSetLog(athleteId: string, input: SetLogCorrectCommand): Promise<SetLogRead>;
  deleteSetLog(athleteId: string, input: SetLogDeleteCommand): Promise<SetLogRead>;
  readSetLog(athleteId: string, logId: string): Promise<SetLogRead | null>;
  listSetLogs(athleteId: string, executionId: string): Promise<SupplementaryList<SetLogRead>>;
  commandRestTimer(athleteId: string, input: RestTimerCommand): Promise<RestTimerState>;
  readRestTimer(athleteId: string, timerId: string): Promise<RestTimerState | null>;
  listRestTimers(
    athleteId: string,
    executionId: string,
  ): Promise<SupplementaryList<RestTimerState>>;
}

const listLimit = 100;
function page<T>(items: T[]): SupplementaryList<T> {
  return { items: items.slice(0, listLimit), hasMore: items.length > listLimit };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(z.string().parse(value)).toISOString();
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function lock(tx: Transaction, key: string) {
  // Joint approvals compare set/catalog heads under the same athlete lock.
  // Take it before the command lock to preserve one ordering across writers.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77211))', [
    `${tx.athleteId}:${key}`,
  ]);
}
async function replay<T>(
  tx: Transaction,
  key: string,
  request: unknown,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const result = await tx.query(
    'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (!result.rows[0]) return null;
  if (result.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return schema.parse(result.rows[0]['result']);
}
async function finish<T>(
  tx: Transaction,
  key: string,
  request: unknown,
  result: T,
  topic: string,
  payload: Record<string, string | number>,
): Promise<T> {
  await enqueue(tx, { id: randomUUID(), idempotencyKey: key, topic, payload });
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify(request), JSON.stringify(result)],
  );
  return result;
}

async function currentVersion(
  tx: Transaction,
  table: 'supplementary_exercise_head' | 'supplementary_routine_head',
  idColumn: 'exercise_id' | 'routine_id',
  id: string,
) {
  const result = await tx.query(
    `SELECT version,version_id FROM ${table} WHERE athlete_id=$1 AND ${idColumn}=$2 FOR UPDATE`,
    [tx.athleteId, id],
  );
  const row = result.rows[0];
  return row
    ? { version: ordinal.parse(row['version']), versionId: uuid.parse(row['version_id']) }
    : null;
}
async function ownedExerciseVersions(tx: Transaction, ids: readonly string[]) {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return;
  const result = await tx.query(
    'SELECT version_id,record_json FROM supplementary_exercise_version WHERE athlete_id=$1 AND version_id=ANY($2::uuid[])',
    [tx.athleteId, uniqueIds],
  );
  if (result.rowCount !== uniqueIds.length)
    throw new SupplementaryReferenceError('TARGET_LINK_INVALID');
  for (const row of result.rows) {
    const exercise = supplementaryExerciseVersionSchema.parse(row['record_json']);
    if (exercise.reviewState === 'withdrawn')
      throw new SupplementaryReferenceError('TARGET_LINK_INVALID');
  }
}
function specExerciseIds(link: SupplementarySessionLink) {
  return link.content.kind === 'embedded'
    ? link.content.spec.blocks.flatMap((block) => block.sets.map((set) => set.exerciseVersionId))
    : [];
}

/** Call only inside the transaction that creates and explicitly approves a new PlanVersion.
 * A late standalone link would change the effective content of an immutable plan. */
export async function insertSupplementarySessionLink(
  tx: Transaction,
  input: SupplementarySessionLink,
): Promise<void> {
  const link = supplementarySessionLinkSchema.parse(input);
  const plan = await tx.query(
    `SELECT 1 FROM plan_snapshot WHERE athlete_id=$1 AND id=$2 AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(draft->'sessions') session
       WHERE session->>'id'=$3 AND session->>'sport'='strength')`,
    [tx.athleteId, link.planVersionId, link.plannedSessionId],
  );
  if (!plan.rowCount) throw new SupplementaryReferenceError('SESSION_LINK_INVALID');
  if (link.content.kind === 'routine_version') {
    const routine = await tx.query(
      'SELECT 1 FROM supplementary_routine_version WHERE athlete_id=$1 AND version_id=$2',
      [tx.athleteId, link.content.routineVersionId],
    );
    if (!routine.rowCount) throw new SupplementaryReferenceError('ROUTINE_NOT_FOUND');
  } else {
    await ownedExerciseVersions(tx, specExerciseIds(link));
  }
  await tx.query(
    `INSERT INTO supplementary_session_link
      (athlete_id,plan_version_id,planned_session_id,content_kind,routine_version_id,embedded_spec_json)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      tx.athleteId,
      link.planVersionId,
      link.plannedSessionId,
      link.content.kind,
      link.content.kind === 'routine_version' ? link.content.routineVersionId : null,
      link.content.kind === 'embedded' ? JSON.stringify(link.content.spec) : null,
    ],
  );
}

async function sessionLink(
  tx: Transaction,
  planVersionId: string,
  sessionId: string,
): Promise<SupplementarySessionLink | null> {
  const result = await tx.query(
    `SELECT content_kind,routine_version_id,embedded_spec_json FROM supplementary_session_link
     WHERE athlete_id=$1 AND plan_version_id=$2 AND planned_session_id=$3`,
    [tx.athleteId, planVersionId, sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return supplementarySessionLinkSchema.parse({
    schemaVersion: 2,
    planVersionId,
    plannedSessionId: sessionId,
    content:
      row['content_kind'] === 'routine_version'
        ? { kind: 'routine_version', routineVersionId: row['routine_version_id'] }
        : { kind: 'embedded', spec: row['embedded_spec_json'] },
  });
}
async function assertMatchingSession(tx: Transaction, link: SupplementarySessionLink | null) {
  if (!link) return;
  const result =
    link.content.kind === 'routine_version'
      ? await tx.query(
          `SELECT 1 FROM supplementary_session_link WHERE athlete_id=$1 AND plan_version_id=$2
           AND planned_session_id=$3 AND content_kind='routine_version' AND routine_version_id=$4`,
          [tx.athleteId, link.planVersionId, link.plannedSessionId, link.content.routineVersionId],
        )
      : await tx.query(
          `SELECT 1 FROM supplementary_session_link WHERE athlete_id=$1 AND plan_version_id=$2
           AND planned_session_id=$3 AND content_kind='embedded' AND embedded_spec_json=$4::jsonb`,
          [
            tx.athleteId,
            link.planVersionId,
            link.plannedSessionId,
            JSON.stringify(link.content.spec),
          ],
        );
  if (!result.rowCount) throw new SupplementaryReferenceError('SESSION_LINK_INVALID');
}
async function execution(tx: Transaction, id: string, forUpdate = false) {
  const result = await tx.query(
    `SELECT e.*,l.content_kind,l.routine_version_id,l.embedded_spec_json
     FROM supplementary_execution e LEFT JOIN supplementary_session_link l
       ON l.athlete_id=e.athlete_id AND l.plan_version_id=e.plan_version_id
       AND l.planned_session_id=e.planned_session_id
     WHERE e.athlete_id=$1 AND e.id=$2${forUpdate ? ' FOR UPDATE OF e' : ''}`,
    [tx.athleteId, id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return executionFromRow(row);
}
function executionFromRow(row: Record<string, unknown>): SupplementaryExecution {
  const linked =
    row['plan_version_id'] === null
      ? null
      : supplementarySessionLinkSchema.parse({
          schemaVersion: 2,
          planVersionId: row['plan_version_id'],
          plannedSessionId: row['planned_session_id'],
          content:
            row['content_kind'] === 'routine_version'
              ? { kind: 'routine_version', routineVersionId: row['routine_version_id'] }
              : { kind: 'embedded', spec: row['embedded_spec_json'] },
        });
  return supplementaryExecutionSchema.parse({
    schemaVersion: 2,
    executionId: row['id'],
    activityId: row['activity_id'],
    plannedSession: linked,
    revision: row['revision'],
    status: row['status'],
    startedAt: iso(row['started_at']),
    endedAt: row['ended_at'] === null ? null : iso(row['ended_at']),
  });
}
async function setLog(tx: Transaction, id: string, forUpdate = false): Promise<SetLogRead | null> {
  const result = await tx.query(
    `SELECT r.* FROM supplementary_set_log h JOIN supplementary_set_log_revision r
       ON r.athlete_id=h.athlete_id AND r.log_id=h.id AND r.revision=h.current_revision
     WHERE h.athlete_id=$1 AND h.id=$2${forUpdate ? ' FOR UPDATE OF h' : ''}`,
    [tx.athleteId, id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return setLogFromRow(row);
}
function setLogFromRow(row: Record<string, unknown>): SetLogRead {
  return row['status'] === 'deleted'
    ? setLogReadSchema.parse({
        status: 'deleted',
        executionId: row['execution_id'],
        logId: row['log_id'],
        revision: row['revision'],
        deletedAt: iso(row['deleted_at']),
      })
    : setLogReadSchema.parse({
        status: 'active',
        current: supplementarySetLogRevisionSchema.parse(row['record_json']),
      });
}
/** A receipt cannot reveal details after the owning Activity or set was deleted. */
async function replayLiveExecution<T extends { status: string }>(
  tx: Transaction,
  key: string,
  request: unknown,
  schema: z.ZodType<T>,
  executionId: string,
  logId?: string,
): Promise<T | null> {
  const prior = await replay(tx, key, request, schema);
  if (prior === null) return null;
  if (!(await execution(tx, executionId, true)))
    throw new SupplementaryReferenceError('EXECUTION_NOT_FOUND');
  if (logId) {
    const current = await setLog(tx, logId, true);
    if (!current || (prior.status === 'active' && current.status === 'deleted'))
      throw new SupplementaryReferenceError('SET_LOG_NOT_FOUND');
  }
  return prior;
}
async function timer(
  tx: Transaction,
  id: string,
  forUpdate = false,
): Promise<RestTimerState | null> {
  const result = await tx.query(
    `SELECT * FROM supplementary_rest_timer WHERE athlete_id=$1 AND id=$2${forUpdate ? ' FOR UPDATE' : ''}`,
    [tx.athleteId, id],
  );
  const row = result.rows[0];
  return row ? timerFromRow(row) : null;
}
function timerFromRow(row: Record<string, unknown>): RestTimerState {
  return restTimerStateSchema.parse({
    timerId: row['id'],
    executionId: row['execution_id'],
    revision: row['revision'],
    durationSeconds: row['duration_seconds'],
    status: row['status'],
    startedAt: iso(row['started_at']),
    deadlineAt: row['deadline_at'] === null ? null : iso(row['deadline_at']),
    pausedAt: row['paused_at'] === null ? null : iso(row['paused_at']),
    remainingWhenPausedSeconds: row['remaining_when_paused_seconds'],
  });
}

export function createSupplementaryRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): SupplementaryRepository {
  return {
    saveExercise(athleteId, input) {
      const command = exerciseVersionSaveCommandSchema.parse(input);
      const key = `supplementary-exercise:${command.idempotencyKey}`;
      const request = { operation: 'save_exercise', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replay(tx, key, request, exerciseVersionReadSchema);
        if (prior) return prior;
        await lock(tx, `exercise:${command.definition.exerciseId}`);
        const current = await currentVersion(
          tx,
          'supplementary_exercise_head',
          'exercise_id',
          command.definition.exerciseId,
        );
        if ((current?.versionId ?? null) !== command.expectedVersionId)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (current?.version === maxOrdinal) throw new PersistenceConflict('REVISION_CONFLICT');
        const version = (current?.version ?? 0) + 1;
        const saved = exerciseVersionReadSchema.parse({ definition: command.definition, version });
        await tx.query(
          `INSERT INTO supplementary_exercise_version
           (athlete_id,exercise_id,version_id,version,previous_version_id,previous_version,created_at,record_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            athleteId,
            saved.definition.exerciseId,
            saved.definition.versionId,
            version,
            current?.versionId ?? null,
            current?.version ?? null,
            saved.definition.createdAt,
            JSON.stringify(saved.definition),
          ],
        );
        if (current) {
          await tx.query(
            'UPDATE supplementary_exercise_head SET version=$3,version_id=$4 WHERE athlete_id=$1 AND exercise_id=$2',
            [athleteId, saved.definition.exerciseId, version, saved.definition.versionId],
          );
        } else {
          await tx.query(
            'INSERT INTO supplementary_exercise_head(athlete_id,exercise_id,version,version_id) VALUES($1,$2,$3,$4)',
            [athleteId, saved.definition.exerciseId, version, saved.definition.versionId],
          );
        }
        return finish(tx, key, request, saved, 'supplementary.exercise_changed', {
          exerciseId: saved.definition.exerciseId,
          versionId: saved.definition.versionId,
          version,
        });
      });
    },
    readExercise(athleteId, exerciseId) {
      const id = uuid.parse(exerciseId);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT v.version,v.record_json FROM supplementary_exercise_head h
           JOIN supplementary_exercise_version v ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 AND h.exercise_id=$2`,
          [athleteId, id],
        );
        return result.rows[0]
          ? exerciseVersionReadSchema.parse({
              definition: result.rows[0]['record_json'],
              version: result.rows[0]['version'],
            })
          : null;
      });
    },
    listExercises(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT v.version,v.record_json FROM supplementary_exercise_head h
           JOIN supplementary_exercise_version v ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 ORDER BY v.created_at DESC,h.exercise_id LIMIT $2`,
          [athleteId, listLimit + 1],
        );
        return page(
          result.rows.map((row) =>
            exerciseVersionReadSchema.parse({
              definition: row['record_json'],
              version: row['version'],
            }),
          ),
        );
      });
    },
    saveRoutine(athleteId, input) {
      const command = routineTemplateSaveCommandSchema.parse(input);
      const key = `supplementary-routine:${command.idempotencyKey}`;
      const request = { operation: 'save_routine', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replay(tx, key, request, routineTemplateReadSchema);
        if (prior) return prior;
        await lock(tx, `routine:${command.template.routineId}`);
        const current = await currentVersion(
          tx,
          'supplementary_routine_head',
          'routine_id',
          command.template.routineId,
        );
        if ((current?.versionId ?? null) !== command.expectedVersionId)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (current?.version === maxOrdinal) throw new PersistenceConflict('REVISION_CONFLICT');
        await ownedExerciseVersions(
          tx,
          command.template.spec.blocks.flatMap((block) =>
            block.sets.map((set) => set.exerciseVersionId),
          ),
        );
        const version = (current?.version ?? 0) + 1;
        const saved = routineTemplateReadSchema.parse({ template: command.template, version });
        await tx.query(
          `INSERT INTO supplementary_routine_version
           (athlete_id,routine_id,version_id,version,previous_version_id,previous_version,created_at,record_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            athleteId,
            saved.template.routineId,
            saved.template.versionId,
            version,
            current?.versionId ?? null,
            current?.version ?? null,
            saved.template.createdAt,
            JSON.stringify(saved.template),
          ],
        );
        if (current) {
          await tx.query(
            'UPDATE supplementary_routine_head SET version=$3,version_id=$4 WHERE athlete_id=$1 AND routine_id=$2',
            [athleteId, saved.template.routineId, version, saved.template.versionId],
          );
        } else {
          await tx.query(
            'INSERT INTO supplementary_routine_head(athlete_id,routine_id,version,version_id) VALUES($1,$2,$3,$4)',
            [athleteId, saved.template.routineId, version, saved.template.versionId],
          );
        }
        return finish(tx, key, request, saved, 'supplementary.routine_changed', {
          routineId: saved.template.routineId,
          versionId: saved.template.versionId,
          version,
        });
      });
    },
    readRoutine(athleteId, routineId) {
      const id = uuid.parse(routineId);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT v.version,v.record_json FROM supplementary_routine_head h
           JOIN supplementary_routine_version v ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 AND h.routine_id=$2`,
          [athleteId, id],
        );
        return result.rows[0]
          ? routineTemplateReadSchema.parse({
              template: result.rows[0]['record_json'],
              version: result.rows[0]['version'],
            })
          : null;
      });
    },
    readRoutineVersion(athleteId, versionId) {
      const id = uuid.parse(versionId);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT version,record_json FROM supplementary_routine_version
           WHERE athlete_id=$1 AND version_id=$2`,
          [athleteId, id],
        );
        return result.rows[0]
          ? routineTemplateReadSchema.parse({
              template: result.rows[0]['record_json'],
              version: result.rows[0]['version'],
            })
          : null;
      });
    },
    listRoutines(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT v.version,v.record_json FROM supplementary_routine_head h
           JOIN supplementary_routine_version v ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 ORDER BY v.created_at DESC,h.routine_id LIMIT $2`,
          [athleteId, listLimit + 1],
        );
        return page(
          result.rows.map((row) =>
            routineTemplateReadSchema.parse({
              template: row['record_json'],
              version: row['version'],
            }),
          ),
        );
      });
    },
    readSessionLink(athleteId, planVersionId, sessionId) {
      const plan = uuid.parse(planVersionId),
        session = localId.parse(sessionId);
      return database.tenant(athleteId, (tx) => sessionLink(tx, plan, session));
    },
    createExecution(athleteId, input) {
      const command = executionCreateCommandSchema.parse(input);
      const key = `supplementary-execution:${command.idempotencyKey}`;
      const request = { operation: 'create_execution', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replayLiveExecution(
          tx,
          key,
          request,
          supplementaryExecutionSchema,
          command.executionId,
        );
        if (prior) return prior;
        await assertMatchingSession(tx, command.plannedSession);
        let activityId: string;
        if (command.activity.kind === 'match_existing') {
          activityId = command.activity.activityId;
          const found = await tx.query(
            `SELECT c.original->>'kind' AS kind,
               o.values_json#>>'{userReport,planLink,planVersionId}' AS plan_version_id,
               o.values_json#>>'{userReport,planLink,sessionId}' AS planned_session_id
             FROM activity_canonical c LEFT JOIN activity_overlay o
               ON o.athlete_id=c.athlete_id AND o.activity_id=c.id
             WHERE c.athlete_id=$1 AND c.id=$2 AND NOT c.deleted FOR UPDATE OF c`,
            [athleteId, activityId],
          );
          if (!found.rowCount) throw new SupplementaryReferenceError('ACTIVITY_NOT_FOUND');
          const matched = found.rows[0];
          if (!matched) throw new SupplementaryReferenceError('ACTIVITY_NOT_FOUND');
          if (matched['kind'] !== 'strength') {
            const currentDetail = await tx.query(
              `SELECT r.details_json AS details
               FROM activity_source_head s JOIN activity_source_revision r
                 ON r.athlete_id=s.athlete_id AND r.kind=s.kind
                 AND r.source_id=s.source_id AND r.source_revision=s.source_revision
               WHERE s.athlete_id=$1 AND s.activity_id=$2 AND s.kind='fit'`,
              [athleteId, activityId],
            );
            const parsed = activityDetailsV3Schema.safeParse(currentDetail.rows[0]?.['details']);
            if (
              !parsed.success ||
              !parsed.data.allocation.bouts.some(
                (bout) => bout.kind === 'strength' && bout.sourceLapIndex !== null,
              )
            )
              throw new SupplementaryReferenceError('ACTIVITY_INVALID');
          }
          if (
            matched['plan_version_id'] !== null &&
            (matched['plan_version_id'] !== command.plannedSession?.planVersionId ||
              matched['planned_session_id'] !== command.plannedSession?.plannedSessionId)
          )
            throw new SupplementaryReferenceError('ACTIVITY_INVALID');
          const alreadyLinked = await tx.query(
            'SELECT 1 FROM supplementary_execution WHERE athlete_id=$1 AND activity_id=$2',
            [athleteId, activityId],
          );
          if (alreadyLinked.rowCount) throw new PersistenceConflict('REVISION_CONFLICT');
        } else {
          if (Date.parse(command.activity.values.startedAt) > now().getTime() + 300000)
            throw new SupplementaryReferenceError('ACTIVITY_INVALID');
          activityId = randomUUID();
          const sourceId = randomUUID();
          const raw = JSON.stringify(command.activity.values);
          const report = activityReportSchema.parse({
            ...command.activity.report,
            definitionVersion: 'activity-report-v1',
            source: 'user',
            method: 'self_report',
            rpeReportedAt: command.activity.report.sessionRpe === null ? null : now().toISOString(),
          });
          const overlay = activityOverlaySchema.parse({ userReport: report });
          await tx.query(
            'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
            [athleteId, activityId, raw],
          );
          await tx.query(
            `INSERT INTO activity_source_head
             (athlete_id,kind,source_id,source_revision,content_hash,activity_id)
             VALUES($1,'manual',$2,1,$3,$4)`,
            [athleteId, sourceId, hash(command.activity.values), activityId],
          );
          await tx.query(
            `INSERT INTO activity_source_revision
             (athlete_id,kind,source_id,source_revision,content_hash,normalized_raw)
             VALUES($1,'manual',$2,1,$3,$4::jsonb)`,
            [athleteId, sourceId, hash(command.activity.values), raw],
          );
          await tx.query(
            'INSERT INTO activity_overlay(athlete_id,activity_id,values_json) VALUES($1,$2,$3::jsonb)',
            [athleteId, activityId, JSON.stringify(overlay)],
          );
          await tx.query(
            'INSERT INTO activity_overlay_revision(athlete_id,activity_id,revision,values_json) VALUES($1,$2,1,$3::jsonb)',
            [athleteId, activityId, JSON.stringify(overlay)],
          );
          await enqueue(tx, {
            id: randomUUID(),
            idempotencyKey: `activity:${activityId}:1`,
            topic: 'activity.changed',
            payload: { activityId, revision: 1, action: 'manual' },
          });
        }
        const startedAt =
          command.activity.kind === 'create_manual'
            ? command.activity.values.startedAt
            : now().toISOString();
        await tx.query(
          `INSERT INTO supplementary_execution
           (athlete_id,id,activity_id,plan_version_id,planned_session_id,revision,status,started_at)
           VALUES($1,$2,$3,$4,$5,1,'active',$6)`,
          [
            athleteId,
            command.executionId,
            activityId,
            command.plannedSession?.planVersionId ?? null,
            command.plannedSession?.plannedSessionId ?? null,
            startedAt,
          ],
        );
        const saved = supplementaryExecutionSchema.parse({
          schemaVersion: 2,
          executionId: command.executionId,
          activityId,
          plannedSession: command.plannedSession,
          revision: 1,
          status: 'active',
          startedAt: iso(startedAt),
          endedAt: null,
        });
        return finish(tx, key, request, saved, 'supplementary.execution_changed', {
          executionId: saved.executionId,
          activityId,
          revision: 1,
        });
      });
    },
    completeExecution(athleteId, input) {
      const command = executionStatusCommandSchema.parse(input);
      const key = `supplementary-execution:${command.idempotencyKey}`;
      const request = { operation: 'complete_execution', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replayLiveExecution(
          tx,
          key,
          request,
          supplementaryExecutionSchema,
          command.executionId,
        );
        if (prior) return prior;
        const current = await execution(tx, command.executionId, true);
        if (!current) throw new SupplementaryReferenceError('EXECUTION_NOT_FOUND');
        if (
          current.status !== 'active' ||
          current.revision !== command.expectedRevision ||
          current.revision === maxOrdinal
        )
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (
          Date.parse(command.endedAt) < Date.parse(current.startedAt) ||
          Date.parse(command.endedAt) > now().getTime() + 300000
        )
          throw new SupplementaryReferenceError('ACTIVITY_INVALID');
        const saved = supplementaryExecutionSchema.parse({
          ...current,
          revision: current.revision + 1,
          status: command.status,
          endedAt: command.endedAt,
        });
        await tx.query(
          `UPDATE supplementary_execution SET revision=$3,status=$4,ended_at=$5
           WHERE athlete_id=$1 AND id=$2`,
          [athleteId, command.executionId, saved.revision, saved.status, saved.endedAt],
        );
        return finish(tx, key, request, saved, 'supplementary.execution_changed', {
          executionId: command.executionId,
          activityId: saved.activityId,
          revision: saved.revision,
          status: saved.status,
        });
      });
    },
    readExecution(athleteId, executionId) {
      const id = uuid.parse(executionId);
      return database.tenant(athleteId, (tx) => execution(tx, id));
    },
    listExecutions(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT e.*,l.content_kind,l.routine_version_id,l.embedded_spec_json
           FROM supplementary_execution e
           JOIN activity_canonical c ON c.athlete_id=e.athlete_id AND c.id=e.activity_id
           LEFT JOIN supplementary_session_link l ON l.athlete_id=e.athlete_id
             AND l.plan_version_id=e.plan_version_id AND l.planned_session_id=e.planned_session_id
           WHERE e.athlete_id=$1 AND NOT c.deleted ORDER BY e.started_at DESC,e.id LIMIT $2`,
          [athleteId, listLimit + 1],
        );
        return page(result.rows.map(executionFromRow));
      });
    },
    createSetLog(athleteId, input) {
      const command = setLogCreateCommandSchema.parse(input);
      const key = `supplementary-set:${command.idempotencyKey}`;
      const request = { operation: 'create_set', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replayLiveExecution(
          tx,
          key,
          request,
          setLogReadSchema,
          command.executionId,
          command.logId,
        );
        if (prior) return prior;
        const currentExecution = await execution(tx, command.executionId, true);
        if (!currentExecution) throw new SupplementaryReferenceError('EXECUTION_NOT_FOUND');
        if (currentExecution.revision !== command.expectedExecutionRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (currentExecution.revision === maxOrdinal)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (await setLog(tx, command.logId)) throw new PersistenceConflict('REVISION_CONFLICT');
        await validateSetLink(tx, currentExecution, command.values);
        const revisionId = randomUUID(),
          revision = 1,
          recordedAt = now().toISOString();
        const savedRevision = supplementarySetLogRevisionSchema.parse({
          ...command.values,
          logId: command.logId,
          revisionId,
          activityId: currentExecution.activityId,
          executionId: command.executionId,
          revision,
          source: 'user',
          recordedAt,
        });
        await tx.query(
          `INSERT INTO supplementary_set_log
           (athlete_id,id,execution_id,activity_id,current_revision,current_revision_id,status)
           VALUES($1,$2,$3,$4,1,$5,'active')`,
          [athleteId, command.logId, command.executionId, currentExecution.activityId, revisionId],
        );
        await insertSetRevision(tx, savedRevision);
        await tx.query(
          'UPDATE supplementary_execution SET revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.executionId],
        );
        const saved = setLogReadSchema.parse({ status: 'active', current: savedRevision });
        return finish(tx, key, request, saved, 'supplementary.set_changed', {
          executionId: command.executionId,
          logId: command.logId,
          revision,
          action: 'created',
        });
      });
    },
    correctSetLog(athleteId, input) {
      const command = setLogCorrectCommandSchema.parse(input);
      const key = `supplementary-set:${command.idempotencyKey}`;
      const request = { operation: 'correct_set', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replayLiveExecution(
          tx,
          key,
          request,
          setLogReadSchema,
          command.executionId,
          command.logId,
        );
        if (prior) return prior;
        const currentExecution = await execution(tx, command.executionId, true);
        if (!currentExecution) throw new SupplementaryReferenceError('EXECUTION_NOT_FOUND');
        const current = await setLog(tx, command.logId, true);
        if (
          !current ||
          (current.status === 'active' && current.current.executionId !== command.executionId) ||
          (current.status === 'deleted' && current.executionId !== command.executionId)
        )
          throw new SupplementaryReferenceError('SET_LOG_NOT_FOUND');
        if (current.status !== 'active' || current.current.revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (current.current.revision === maxOrdinal || currentExecution.revision === maxOrdinal)
          throw new PersistenceConflict('REVISION_CONFLICT');
        await validateSetLink(tx, currentExecution, command.values);
        const revision = current.current.revision + 1;
        const savedRevision = supplementarySetLogRevisionSchema.parse({
          ...command.values,
          logId: command.logId,
          revisionId: randomUUID(),
          activityId: currentExecution.activityId,
          executionId: command.executionId,
          revision,
          source: 'user',
          recordedAt: now().toISOString(),
        });
        await insertSetRevision(tx, savedRevision);
        await tx.query(
          'UPDATE supplementary_set_log SET current_revision=$3,current_revision_id=$4 WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.logId, revision, savedRevision.revisionId],
        );
        await tx.query(
          'UPDATE supplementary_execution SET revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.executionId],
        );
        const saved = setLogReadSchema.parse({ status: 'active', current: savedRevision });
        return finish(tx, key, request, saved, 'supplementary.set_changed', {
          executionId: command.executionId,
          logId: command.logId,
          revision,
          action: 'corrected',
        });
      });
    },
    deleteSetLog(athleteId, input) {
      const command = setLogDeleteCommandSchema.parse(input);
      const key = `supplementary-set:${command.idempotencyKey}`;
      const request = { operation: 'delete_set', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replayLiveExecution(
          tx,
          key,
          request,
          setLogReadSchema,
          command.executionId,
          command.logId,
        );
        if (prior) return prior;
        const currentExecution = await execution(tx, command.executionId, true);
        if (!currentExecution) throw new SupplementaryReferenceError('EXECUTION_NOT_FOUND');
        const current = await setLog(tx, command.logId, true);
        if (
          !current ||
          (current.status === 'active' && current.current.executionId !== command.executionId) ||
          (current.status === 'deleted' && current.executionId !== command.executionId)
        )
          throw new SupplementaryReferenceError('SET_LOG_NOT_FOUND');
        if (current.status !== 'active' || current.current.revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (current.current.revision === maxOrdinal || currentExecution.revision === maxOrdinal)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const revision = current.current.revision + 1,
          deletedAt = now().toISOString(),
          revisionId = randomUUID();
        await tx.query(
          `INSERT INTO supplementary_set_log_revision
           (athlete_id,log_id,execution_id,activity_id,revision,revision_id,status,recorded_at,deleted_at,deletion_reason)
           VALUES($1,$2,$3,$4,$5,$6,'deleted',$7,$7,$8)`,
          [
            athleteId,
            command.logId,
            command.executionId,
            currentExecution.activityId,
            revision,
            revisionId,
            deletedAt,
            command.reason,
          ],
        );
        await tx.query(
          `UPDATE supplementary_set_log SET current_revision=$3,current_revision_id=$4,status='deleted'
           WHERE athlete_id=$1 AND id=$2`,
          [athleteId, command.logId, revision, revisionId],
        );
        await tx.query(
          'UPDATE supplementary_execution SET revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.executionId],
        );
        const saved = setLogReadSchema.parse({
          status: 'deleted',
          executionId: command.executionId,
          logId: command.logId,
          revision,
          deletedAt,
        });
        return finish(tx, key, request, saved, 'supplementary.set_changed', {
          executionId: command.executionId,
          logId: command.logId,
          revision,
          action: 'deleted',
        });
      });
    },
    readSetLog(athleteId, logId) {
      const id = uuid.parse(logId);
      return database.tenant(athleteId, (tx) => setLog(tx, id));
    },
    listSetLogs(athleteId, executionId) {
      const id = uuid.parse(executionId);
      return database.tenant(athleteId, async (tx) => {
        if (!(await execution(tx, id)))
          throw new SupplementaryReferenceError('EXECUTION_NOT_FOUND');
        const result = await tx.query(
          `SELECT r.* FROM supplementary_set_log h JOIN supplementary_set_log_revision r
             ON r.athlete_id=h.athlete_id AND r.log_id=h.id AND r.revision=h.current_revision
           WHERE h.athlete_id=$1 AND h.execution_id=$2 ORDER BY r.recorded_at DESC,h.id LIMIT $3`,
          [athleteId, id, listLimit + 1],
        );
        return page(result.rows.map(setLogFromRow));
      });
    },
    commandRestTimer(athleteId, input) {
      const command = restTimerCommandSchema.parse(input);
      const key = `supplementary-timer:${command.idempotencyKey}`;
      const request = { operation: 'timer_command', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replayLiveExecution(
          tx,
          key,
          request,
          restTimerStateSchema,
          command.executionId,
        );
        if (prior) return prior;
        const currentExecution = await execution(tx, command.executionId, true);
        if (!currentExecution) throw new SupplementaryReferenceError('EXECUTION_NOT_FOUND');
        if (currentExecution.status !== 'active')
          throw new PersistenceConflict('REVISION_CONFLICT');
        const current = await timer(tx, command.timerId, true);
        let saved: RestTimerState;
        if (command.action === 'start') {
          if (current) throw new PersistenceConflict('REVISION_CONFLICT');
          saved = restTimerStateSchema.parse({
            timerId: command.timerId,
            executionId: command.executionId,
            revision: 1,
            durationSeconds: command.durationSeconds,
            status: 'running',
            startedAt: iso(command.at),
            deadlineAt: new Date(
              Date.parse(command.at) + command.durationSeconds * 1000,
            ).toISOString(),
            pausedAt: null,
            remainingWhenPausedSeconds: null,
          });
          await tx.query(
            `INSERT INTO supplementary_rest_timer
             (athlete_id,id,execution_id,revision,duration_seconds,status,started_at,deadline_at)
             VALUES($1,$2,$3,1,$4,'running',$5,$6)`,
            [
              athleteId,
              command.timerId,
              command.executionId,
              saved.durationSeconds,
              saved.startedAt,
              saved.deadlineAt,
            ],
          );
        } else {
          if (!current || current.executionId !== command.executionId)
            throw new SupplementaryReferenceError('TIMER_NOT_FOUND');
          if (current.revision !== command.expectedRevision || current.revision === maxOrdinal)
            throw new PersistenceConflict('REVISION_CONFLICT');
          const at = Date.parse(command.at);
          if (
            at < Date.parse(current.startedAt) ||
            (current.pausedAt !== null && at < Date.parse(current.pausedAt))
          )
            throw new PersistenceConflict('REVISION_CONFLICT');
          if (command.action === 'pause') {
            if (current.status !== 'running' || current.deadlineAt === null)
              throw new PersistenceConflict('REVISION_CONFLICT');
            saved = restTimerStateSchema.parse({
              ...current,
              revision: current.revision + 1,
              status: 'paused',
              deadlineAt: null,
              pausedAt: iso(command.at),
              remainingWhenPausedSeconds: Math.min(
                current.durationSeconds,
                Math.max(0, Math.ceil((Date.parse(current.deadlineAt) - at) / 1000)),
              ),
            });
          } else if (command.action === 'resume') {
            if (current.status !== 'paused' || current.remainingWhenPausedSeconds === null)
              throw new PersistenceConflict('REVISION_CONFLICT');
            saved = restTimerStateSchema.parse({
              ...current,
              revision: current.revision + 1,
              status: 'running',
              deadlineAt: new Date(at + current.remainingWhenPausedSeconds * 1000).toISOString(),
              pausedAt: null,
              remainingWhenPausedSeconds: null,
            });
          } else {
            if (current.status === 'finished') throw new PersistenceConflict('REVISION_CONFLICT');
            saved = restTimerStateSchema.parse({
              ...current,
              revision: current.revision + 1,
              status: 'finished',
              pausedAt: null,
              remainingWhenPausedSeconds: null,
            });
          }
          await tx.query(
            `UPDATE supplementary_rest_timer SET revision=$3,status=$4,deadline_at=$5,
             paused_at=$6,remaining_when_paused_seconds=$7 WHERE athlete_id=$1 AND id=$2`,
            [
              athleteId,
              command.timerId,
              saved.revision,
              saved.status,
              saved.deadlineAt,
              saved.pausedAt,
              saved.remainingWhenPausedSeconds,
            ],
          );
        }
        return finish(tx, key, request, saved, 'supplementary.timer_changed', {
          executionId: command.executionId,
          timerId: command.timerId,
          revision: saved.revision,
          action: command.action,
        });
      });
    },
    readRestTimer(athleteId, timerId) {
      const id = uuid.parse(timerId);
      return database.tenant(athleteId, (tx) => timer(tx, id));
    },
    listRestTimers(athleteId, executionId) {
      const id = uuid.parse(executionId);
      return database.tenant(athleteId, async (tx) => {
        if (!(await execution(tx, id)))
          throw new SupplementaryReferenceError('EXECUTION_NOT_FOUND');
        const result = await tx.query(
          `SELECT * FROM supplementary_rest_timer WHERE athlete_id=$1 AND execution_id=$2
           ORDER BY started_at DESC,id LIMIT $3`,
          [athleteId, id, listLimit + 1],
        );
        return page(result.rows.map(timerFromRow));
      });
    },
  };
}

async function insertSetRevision(
  tx: Transaction,
  revision: z.infer<typeof supplementarySetLogRevisionSchema>,
) {
  await tx.query(
    `INSERT INTO supplementary_set_log_revision
     (athlete_id,log_id,execution_id,activity_id,revision,revision_id,status,state,
      occurred_at,recorded_at,record_json)
     VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10::jsonb)`,
    [
      tx.athleteId,
      revision.logId,
      revision.executionId,
      revision.activityId,
      revision.revision,
      revision.revisionId,
      revision.state,
      revision.occurredAt,
      revision.recordedAt,
      JSON.stringify(revision),
    ],
  );
}

async function validateSetLink(
  tx: Transaction,
  current: SupplementaryExecution,
  values: SetLogCreateCommand['values'],
) {
  await ownedExerciseVersions(tx, [values.exerciseVersionId]);
  if (values.targetSetId === null && values.blockId === null && values.roundIndex === null) return;
  const linked = current.plannedSession;
  if (
    !linked ||
    values.targetSetId === null ||
    values.blockId === null ||
    values.roundIndex === null
  )
    throw new SupplementaryReferenceError('TARGET_LINK_INVALID');
  let blocks;
  if (linked.content.kind === 'embedded') {
    blocks = linked.content.spec.blocks;
  } else {
    const result = await tx.query(
      'SELECT record_json FROM supplementary_routine_version WHERE athlete_id=$1 AND version_id=$2',
      [tx.athleteId, linked.content.routineVersionId],
    );
    const stored = result.rows[0];
    if (!stored) throw new SupplementaryReferenceError('TARGET_LINK_INVALID');
    blocks = routineTemplateReadSchema.shape.template.parse(stored['record_json']).spec.blocks;
  }
  const block = blocks.find((entry) => entry.id === values.blockId);
  const target = block?.sets.find((entry) => entry.id === values.targetSetId);
  if (
    !block ||
    !target ||
    target.exerciseVersionId !== values.exerciseVersionId ||
    values.roundIndex >= block.rounds
  )
    throw new SupplementaryReferenceError('TARGET_LINK_INVALID');
}
