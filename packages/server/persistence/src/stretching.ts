import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { activityValuesSchema } from '@workout/contracts/activity';
import { activityDetailsV3Schema } from '@workout/contracts/activity-details';
import {
  supplementaryExerciseVersionSchema,
  supplementarySpecSchema,
  routineTemplateVersionSchema,
} from '@workout/contracts/supplementary-core';
import {
  stretchProfileSchema,
  stretchPlannedTargetSchema,
  stretchingExerciseReadSchema,
  stretchingExerciseSaveSchema,
  stretchLogCreateSchema,
  stretchLogCorrectSchema,
  stretchLogDeleteSchema,
  stretchLogReadSchema,
  stretchLogRevisionSchema,
  type StretchLogCreate,
  type StretchLogCorrect,
  type StretchLogDelete,
  type StretchLogRead,
  type StretchLogValues,
  type StretchPlannedTarget,
  type StretchingExerciseRead,
  type StretchingExerciseSave,
} from '@workout/contracts/stretching';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const limit = 100;
const maximumRevision = 2_147_483_646;
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

export class StretchingReferenceError extends Error {
  constructor(
    readonly code:
      | 'ACTIVITY_NOT_FOUND'
      | 'EXERCISE_NOT_FOUND'
      | 'EXERCISE_WITHDRAWN'
      | 'STRETCH_LOG_NOT_FOUND'
      | 'STRETCH_LOG_INVALID',
  ) {
    super(code);
  }
}
export interface StretchingRepository {
  listExercises(athleteId: string): Promise<{ items: StretchingExerciseRead[]; hasMore: boolean }>;
  readExercise(athleteId: string, exerciseId: string): Promise<StretchingExerciseRead | null>;
  saveExercise(athleteId: string, input: StretchingExerciseSave): Promise<StretchingExerciseRead>;
  listTargets(
    athleteId: string,
    activityId: string,
  ): Promise<{ items: StretchPlannedTarget[]; hasMore: boolean }>;
  listLogs(
    athleteId: string,
    activityId: string | null,
  ): Promise<{ items: StretchLogRead[]; hasMore: boolean }>;
  readLog(athleteId: string, logId: string): Promise<StretchLogRead | null>;
  createLog(athleteId: string, input: StretchLogCreate): Promise<StretchLogRead>;
  correctLog(athleteId: string, input: StretchLogCorrect): Promise<StretchLogRead>;
  deleteLog(athleteId: string, input: StretchLogDelete): Promise<StretchLogRead>;
}

async function lock(tx: Transaction, key: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77211))', [
    `${tx.athleteId}:${key}`,
  ]);
}
async function replay(
  tx: Transaction,
  key: string,
  request: unknown,
): Promise<StretchLogRead | null> {
  const result = await tx.query(
    'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (!result.rows[0]) return null;
  if (result.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return stretchLogReadSchema.parse(result.rows[0]['result']);
}
async function replayExercise(
  tx: Transaction,
  key: string,
  request: unknown,
): Promise<StretchingExerciseRead | null> {
  const result = await tx.query(
    'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (!result.rows[0]) return null;
  if (result.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return stretchingExerciseReadSchema.parse(result.rows[0]['result']);
}
async function receipt(
  tx: Transaction,
  key: string,
  request: unknown,
  result: StretchLogRead,
  action: string,
) {
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: key,
    topic: 'stretching.log_changed',
    payload: {
      logId: result.status === 'active' ? result.current.logId : result.logId,
      activityId: result.status === 'active' ? result.current.activityId : result.activityId,
      revision: result.status === 'active' ? result.current.revision : result.revision,
      action,
    },
  });
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify(request), JSON.stringify(result)],
  );
  return result;
}
async function liveActivity(tx: Transaction, activityId: string) {
  const result = await tx.query(
    'SELECT original FROM activity_canonical WHERE athlete_id=$1 AND id=$2 AND NOT deleted FOR UPDATE',
    [tx.athleteId, activityId],
  );
  if (!result.rowCount) throw new StretchingReferenceError('ACTIVITY_NOT_FOUND');
}
async function exercise(tx: Transaction, versionId: string, newExecution: boolean) {
  const result = await tx.query(
    `SELECT v.record_json AS definition, p.profile_json AS profile, latest.record_json AS latest
     FROM stretch_profile p
     JOIN supplementary_exercise_version v ON v.athlete_id=p.athlete_id AND v.version_id=p.exercise_version_id
     JOIN supplementary_exercise_head h ON h.athlete_id=v.athlete_id AND h.exercise_id=v.exercise_id
     JOIN supplementary_exercise_version latest ON latest.athlete_id=h.athlete_id AND latest.version_id=h.version_id
     WHERE v.athlete_id=$1 AND v.version_id=$2`,
    [tx.athleteId, versionId],
  );
  if (!result.rowCount) throw new StretchingReferenceError('EXERCISE_NOT_FOUND');
  const definition = supplementaryExerciseVersionSchema.parse(result.rows[0]?.['definition']);
  const latest = supplementaryExerciseVersionSchema.parse(result.rows[0]?.['latest']);
  if (definition.family !== 'stretching') throw new StretchingReferenceError('STRETCH_LOG_INVALID');
  if (
    newExecution &&
    (definition.reviewState === 'withdrawn' ||
      latest.reviewState === 'withdrawn' ||
      latest.family !== 'stretching')
  )
    throw new StretchingReferenceError('EXERCISE_WITHDRAWN');
  return stretchProfileSchema.parse(result.rows[0]?.['profile']);
}
async function plannedTargets(
  tx: Transaction,
  activityId: string,
): Promise<StretchPlannedTarget[]> {
  const linked = await tx.query(
    `SELECT e.id AS execution_id,l.content_kind,l.embedded_spec_json,r.record_json AS routine
     FROM supplementary_execution e
     JOIN supplementary_session_link l ON l.athlete_id=e.athlete_id
       AND l.plan_version_id=e.plan_version_id AND l.planned_session_id=e.planned_session_id
     LEFT JOIN supplementary_routine_version r ON r.athlete_id=l.athlete_id
       AND r.version_id=l.routine_version_id
     WHERE e.athlete_id=$1 AND e.activity_id=$2`,
    [tx.athleteId, activityId],
  );
  const row = linked.rows[0];
  if (!row) return [];
  const spec =
    row['content_kind'] === 'embedded'
      ? supplementarySpecSchema.parse(row['embedded_spec_json'])
      : routineTemplateVersionSchema.parse(row['routine']).spec;
  const all = spec.blocks.flatMap((block) => block.sets);
  const versions = [...new Set(all.map((target) => target.exerciseVersionId))];
  const available = await tx.query(
    `SELECT exercise_version_id FROM stretch_profile
     WHERE athlete_id=$1 AND exercise_version_id=ANY($2::uuid[])`,
    [tx.athleteId, versions],
  );
  const stretching = new Set(available.rows.map((item) => uuid.parse(item['exercise_version_id'])));
  return all
    .filter((target) => stretching.has(target.exerciseVersionId))
    .map((target) =>
      stretchPlannedTargetSchema.parse({
        executionId: row['execution_id'],
        targetSetId: target.id,
        exerciseVersionId: target.exerciseVersionId,
        side: target.side,
        plannedHoldSeconds:
          target.durationSeconds === null
            ? null
            : {
                min: target.durationSeconds.min,
                max: target.durationSeconds.max,
              },
        plannedRepetitions:
          target.count === null
            ? null
            : {
                min: target.count.target.min,
                max: target.count.target.max,
              },
        restAfterSeconds: target.restAfterSeconds,
      }),
    );
}
async function validateValues(tx: Transaction, values: StretchLogValues, newExecution: boolean) {
  await liveActivity(tx, values.activityId);
  const profile = await exercise(tx, values.exerciseVersionId, newExecution);
  if (
    (profile.method === 'static_hold' && values.repetitions !== null) ||
    (profile.method === 'dynamic_repetitions' && values.holdSeconds !== null)
  )
    throw new StretchingReferenceError('STRETCH_LOG_INVALID');
  if (profile.sideBasis === 'per_side' && !['left', 'right', 'unknown'].includes(values.side))
    throw new StretchingReferenceError('STRETCH_LOG_INVALID');
  if (profile.sideBasis === 'total' && !['total', 'unknown'].includes(values.side))
    throw new StretchingReferenceError('STRETCH_LOG_INVALID');
  if (values.plannedTarget !== null) {
    const target = (await plannedTargets(tx, values.activityId)).find(
      (item) =>
        item.executionId === values.plannedTarget?.executionId &&
        item.targetSetId === values.plannedTarget?.targetSetId &&
        item.exerciseVersionId === values.exerciseVersionId,
    );
    if (
      !target ||
      (target.side === 'left' && values.side !== 'left' && values.side !== 'unknown') ||
      (target.side === 'right' && values.side !== 'right' && values.side !== 'unknown') ||
      (target.side === 'bilateral' && !['both', 'total', 'unknown'].includes(values.side)) ||
      (profile.method === 'static_hold' && target.plannedHoldSeconds === null) ||
      (profile.method === 'dynamic_repetitions' && target.plannedRepetitions === null)
    )
      throw new StretchingReferenceError('STRETCH_LOG_INVALID');
  }
  if (
    values.allocation.kind === 'activity_block' &&
    values.allocation.startedAt !== null &&
    values.allocation.endedAtExclusive !== null
  ) {
    const source = await tx.query(
      `SELECT c.original,r.details_json FROM activity_canonical c
       LEFT JOIN activity_source_head h ON h.athlete_id=c.athlete_id AND h.activity_id=c.id
       LEFT JOIN activity_source_revision r ON r.athlete_id=h.athlete_id
         AND r.kind=h.kind AND r.source_id=h.source_id AND r.source_revision=h.source_revision
       WHERE c.athlete_id=$1 AND c.id=$2`,
      [tx.athleteId, values.activityId],
    );
    const row = source.rows[0];
    const original = activityValuesSchema.safeParse(row?.['original']);
    const details = activityDetailsV3Schema.safeParse(row?.['details_json']);
    let activityStart: number;
    let activityEnd: number;
    if (details.success) {
      activityStart = Date.parse(details.data.allocation.parent.startedAt);
      activityEnd = Date.parse(details.data.allocation.parent.endedAtExclusive);
    } else if (
      original.success &&
      original.data.durationKind === 'elapsed' &&
      original.data.startedAt !== null &&
      original.data.durationSeconds !== null
    ) {
      activityStart = Date.parse(original.data.startedAt);
      activityEnd = activityStart + original.data.durationSeconds * 1000;
    } else throw new StretchingReferenceError('STRETCH_LOG_INVALID');
    if (
      Date.parse(values.allocation.startedAt) < activityStart ||
      Date.parse(values.allocation.endedAtExclusive) > activityEnd
    )
      throw new StretchingReferenceError('STRETCH_LOG_INVALID');
  }
}
async function current(
  tx: Transaction,
  logId: string,
  forUpdate = false,
): Promise<StretchLogRead | null> {
  const result = await tx.query(
    `SELECT r.*,l.status AS head_status FROM stretching_log l JOIN stretching_log_revision r
       ON r.athlete_id=l.athlete_id AND r.log_id=l.id AND r.revision=l.current_revision
     JOIN activity_canonical c ON c.athlete_id=l.athlete_id AND c.id=l.activity_id AND NOT c.deleted
     WHERE l.athlete_id=$1 AND l.id=$2${forUpdate ? ' FOR UPDATE OF l' : ''}`,
    [tx.athleteId, logId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row['status'] === 'deleted')
    return stretchLogReadSchema.parse({
      status: 'deleted',
      logId: row['log_id'],
      activityId: row['activity_id'],
      revision: row['revision'],
      deletedAt: iso(row['deleted_at']),
    });
  return stretchLogReadSchema.parse({ status: 'active', current: row['record_json'] });
}
async function insertRevision(tx: Transaction, revision: z.infer<typeof stretchLogRevisionSchema>) {
  await tx.query(
    `INSERT INTO stretching_log_revision
     (athlete_id,log_id,activity_id,exercise_version_id,revision,revision_id,status,recorded_at,record_json)
     VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8::jsonb)`,
    [
      tx.athleteId,
      revision.logId,
      revision.activityId,
      revision.exerciseVersionId,
      revision.revision,
      revision.revisionId,
      revision.recordedAt,
      JSON.stringify(revision),
    ],
  );
}
export function createStretchingRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): StretchingRepository {
  return {
    listExercises(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT v.version,v.record_json,p.profile_json FROM supplementary_exercise_head h
           JOIN supplementary_exercise_version v ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           JOIN stretch_profile p ON p.athlete_id=v.athlete_id AND p.exercise_version_id=v.version_id
           WHERE h.athlete_id=$1 AND v.record_json->>'family'='stretching'
           ORDER BY v.created_at DESC,h.exercise_id LIMIT $2`,
          [athleteId, limit + 1],
        );
        return {
          items: result.rows.slice(0, limit).map((row) =>
            stretchingExerciseReadSchema.parse({
              version: row['version'],
              definition: row['record_json'],
              profile: row['profile_json'],
            }),
          ),
          hasMore: result.rows.length > limit,
        };
      });
    },
    readExercise(athleteId, exerciseId) {
      const id = uuid.parse(exerciseId);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT v.version,v.record_json,p.profile_json FROM supplementary_exercise_head h
           JOIN supplementary_exercise_version v ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           JOIN stretch_profile p ON p.athlete_id=v.athlete_id AND p.exercise_version_id=v.version_id
           WHERE h.athlete_id=$1 AND h.exercise_id=$2`,
          [athleteId, id],
        );
        return result.rows[0]
          ? stretchingExerciseReadSchema.parse({
              version: result.rows[0]['version'],
              definition: result.rows[0]['record_json'],
              profile: result.rows[0]['profile_json'],
            })
          : null;
      });
    },
    saveExercise(athleteId, input) {
      const command = stretchingExerciseSaveSchema.parse(input);
      const key = `stretching-exercise:${command.idempotencyKey}`;
      const request = { operation: 'save_exercise', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replayExercise(tx, key, request);
        if (prior) return prior;
        const existing = await tx.query(
          `SELECT h.version,h.version_id,v.record_json->>'family' AS family
           FROM supplementary_exercise_head h JOIN supplementary_exercise_version v
             ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 AND h.exercise_id=$2 FOR UPDATE OF h`,
          [athleteId, command.definition.exerciseId],
        );
        const current = existing.rows[0];
        if (current && current['family'] !== 'stretching')
          throw new StretchingReferenceError('STRETCH_LOG_INVALID');
        if (
          (current?.['version_id'] ?? null) !== command.expectedVersionId ||
          (current && Number(current['version']) >= maximumRevision)
        )
          throw new PersistenceConflict('REVISION_CONFLICT');
        const version = Number(current?.['version'] ?? 0) + 1;
        await tx.query(
          `INSERT INTO supplementary_exercise_version
           (athlete_id,exercise_id,version_id,version,previous_version_id,previous_version,created_at,record_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            athleteId,
            command.definition.exerciseId,
            command.definition.versionId,
            version,
            current?.['version_id'] ?? null,
            current?.['version'] ?? null,
            command.definition.createdAt,
            JSON.stringify(command.definition),
          ],
        );
        await tx.query(
          `INSERT INTO stretch_profile(athlete_id,exercise_version_id,profile_json)
           VALUES($1,$2,$3::jsonb)`,
          [athleteId, command.definition.versionId, JSON.stringify(command.profile)],
        );
        if (current)
          await tx.query(
            `UPDATE supplementary_exercise_head SET version=$3,version_id=$4
           WHERE athlete_id=$1 AND exercise_id=$2`,
            [athleteId, command.definition.exerciseId, version, command.definition.versionId],
          );
        else
          await tx.query(
            `INSERT INTO supplementary_exercise_head(athlete_id,exercise_id,version,version_id)
           VALUES($1,$2,$3,$4)`,
            [athleteId, command.definition.exerciseId, version, command.definition.versionId],
          );
        const saved = stretchingExerciseReadSchema.parse({
          definition: command.definition,
          profile: command.profile,
          version,
        });
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: key,
          topic: 'supplementary.exercise_changed',
          payload: {
            exerciseId: command.definition.exerciseId,
            versionId: command.definition.versionId,
            version,
          },
        });
        await tx.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [athleteId, key, JSON.stringify(request), JSON.stringify(saved)],
        );
        return saved;
      });
    },
    listTargets(athleteId, activityId) {
      const id = uuid.parse(activityId);
      return database.tenant(athleteId, async (tx) => {
        await liveActivity(tx, id);
        const targets = await plannedTargets(tx, id);
        return { items: targets.slice(0, limit), hasMore: targets.length > limit };
      });
    },
    listLogs(athleteId, activityId) {
      const id = activityId === null ? null : uuid.parse(activityId);
      return database.tenant(athleteId, async (tx) => {
        if (id !== null) await liveActivity(tx, id);
        const result = await tx.query(
          `SELECT r.* FROM stretching_log l JOIN stretching_log_revision r
             ON r.athlete_id=l.athlete_id AND r.log_id=l.id AND r.revision=l.current_revision
           JOIN activity_canonical c ON c.athlete_id=l.athlete_id AND c.id=l.activity_id AND NOT c.deleted
           WHERE l.athlete_id=$1 AND l.status='active' AND ($2::uuid IS NULL OR l.activity_id=$2)
           ORDER BY r.recorded_at DESC,l.id LIMIT $3`,
          [athleteId, id, limit + 1],
        );
        return {
          items: result.rows
            .slice(0, limit)
            .map((row) =>
              stretchLogReadSchema.parse({ status: 'active', current: row['record_json'] }),
            ),
          hasMore: result.rows.length > limit,
        };
      });
    },
    readLog(athleteId, logId) {
      return database.tenant(athleteId, (tx) => current(tx, uuid.parse(logId)));
    },
    createLog(athleteId, input) {
      const command = stretchLogCreateSchema.parse(input);
      const key = `stretching-log:${command.idempotencyKey}`;
      const request = { operation: 'create', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replay(tx, key, request);
        if (prior) {
          const state = await current(tx, command.logId);
          if (!state) throw new StretchingReferenceError('STRETCH_LOG_NOT_FOUND');
          if (state.status === 'deleted') throw new PersistenceConflict('REVISION_CONFLICT');
          return prior;
        }
        if (await current(tx, command.logId)) throw new PersistenceConflict('REVISION_CONFLICT');
        await validateValues(tx, command.values, true);
        const savedRevision = stretchLogRevisionSchema.parse({
          ...command.values,
          schemaVersion: 1,
          logId: command.logId,
          revisionId: randomUUID(),
          revision: 1,
          source: 'user',
          confirmation: command.confirmation,
          recordedAt: now().toISOString(),
        });
        await tx.query(
          `INSERT INTO stretching_log
           (athlete_id,id,activity_id,exercise_version_id,current_revision,current_revision_id,status)
           VALUES($1,$2,$3,$4,1,$5,'active')`,
          [
            athleteId,
            command.logId,
            command.values.activityId,
            command.values.exerciseVersionId,
            savedRevision.revisionId,
          ],
        );
        await insertRevision(tx, savedRevision);
        return receipt(tx, key, request, { status: 'active', current: savedRevision }, 'created');
      });
    },
    correctLog(athleteId, input) {
      const command = stretchLogCorrectSchema.parse(input);
      const key = `stretching-log:${command.idempotencyKey}`;
      const request = { operation: 'correct', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replay(tx, key, request);
        if (prior) {
          const state = await current(tx, command.logId);
          if (!state) throw new StretchingReferenceError('STRETCH_LOG_NOT_FOUND');
          if (state.status === 'deleted') throw new PersistenceConflict('REVISION_CONFLICT');
          return prior;
        }
        const existing = await current(tx, command.logId, true);
        if (!existing) throw new StretchingReferenceError('STRETCH_LOG_NOT_FOUND');
        if (
          existing.status !== 'active' ||
          existing.current.revision !== command.expectedRevision ||
          existing.current.revision === maximumRevision
        )
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (
          command.values.activityId !== existing.current.activityId ||
          command.values.exerciseVersionId !== existing.current.exerciseVersionId
        )
          throw new StretchingReferenceError('STRETCH_LOG_INVALID');
        await validateValues(tx, command.values, false);
        const savedRevision = stretchLogRevisionSchema.parse({
          ...command.values,
          schemaVersion: 1,
          logId: command.logId,
          revisionId: randomUUID(),
          revision: existing.current.revision + 1,
          source: 'user',
          confirmation: command.confirmation,
          recordedAt: now().toISOString(),
        });
        await insertRevision(tx, savedRevision);
        await tx.query(
          'UPDATE stretching_log SET current_revision=$3,current_revision_id=$4 WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.logId, savedRevision.revision, savedRevision.revisionId],
        );
        return receipt(tx, key, request, { status: 'active', current: savedRevision }, 'corrected');
      });
    },
    deleteLog(athleteId, input) {
      const command = stretchLogDeleteSchema.parse(input);
      const key = `stretching-log:${command.idempotencyKey}`;
      const request = { operation: 'delete', ...command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx, key);
        const prior = await replay(tx, key, request);
        if (prior) {
          if (!(await current(tx, command.logId)))
            throw new StretchingReferenceError('STRETCH_LOG_NOT_FOUND');
          return prior;
        }
        const existing = await current(tx, command.logId, true);
        if (!existing) throw new StretchingReferenceError('STRETCH_LOG_NOT_FOUND');
        if (
          existing.status !== 'active' ||
          existing.current.revision !== command.expectedRevision ||
          existing.current.revision === maximumRevision
        )
          throw new PersistenceConflict('REVISION_CONFLICT');
        const revision = existing.current.revision + 1;
        const revisionId = randomUUID(),
          deletedAt = now().toISOString();
        await tx.query(
          `INSERT INTO stretching_log_revision
           (athlete_id,log_id,activity_id,exercise_version_id,revision,revision_id,status,
             recorded_at,deleted_at,deletion_reason)
           VALUES($1,$2,$3,$4,$5,$6,'deleted',$7,$7,$8)`,
          [
            athleteId,
            command.logId,
            existing.current.activityId,
            existing.current.exerciseVersionId,
            revision,
            revisionId,
            deletedAt,
            command.reason,
          ],
        );
        await tx.query(
          `UPDATE stretching_log SET current_revision=$3,current_revision_id=$4,status='deleted'
           WHERE athlete_id=$1 AND id=$2`,
          [athleteId, command.logId, revision, revisionId],
        );
        return receipt(
          tx,
          key,
          request,
          {
            status: 'deleted',
            logId: command.logId,
            activityId: existing.current.activityId,
            revision,
            deletedAt,
          },
          'deleted',
        );
      });
    },
  };
}
