import { z } from 'zod';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  routineScheduleVersionSchema,
  type ActualRef,
  type RoutineRun,
} from '@workout/contracts/routines';
import type { PlanSnapshot } from '@workout/contracts/planning';
import { activityValuesSchema, activityOverlaySchema } from '@workout/contracts/activity';
import { intakeEntryRecordSchema } from '@workout/contracts/nutrition-core';
import { recoveryActionRecordSchema } from '@workout/contracts/recovery-core';
import { checkInValuesSchema } from '@workout/contracts/check-ins';
import type { Transaction } from './database.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest as digest,
} from './race-plan-impact-dependencies.js';

const uuid = z.uuid();
const id = z.string().min(1).max(200);
const revision = z.number().int().min(0).max(2147483646);
const actualRevision = z.number().int().min(1).max(2147483647);
const status = z.enum(['active', 'deleted']);
function fail(code: RaceImpactDependencyError['code']): never {
  throw new RaceImpactDependencyError(code);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail('INVALID_CONTEXT');
}
async function rows(tx: Transaction, sql: string, parameters: unknown[], limit = 1000) {
  const result = (await tx.query(sql, parameters)).rows;
  if (result.length > limit) fail('CONTEXT_UNAVAILABLE');
  return result;
}
const occurrenceRow = z.strictObject({
  id: uuid,
  schedule_id: uuid,
  schedule_version_id: uuid,
  blueprint_routine_id: uuid,
  blueprint_version_id: uuid,
  anchor_key: id,
  scheduled_at: z.iso.datetime().nullable(),
  record_json: z.unknown(),
});
const runRow = z.strictObject({
  id: uuid,
  blueprint_routine_id: uuid,
  blueprint_version_id: uuid,
  occurrence_id: uuid.nullable(),
  revision,
  state: z.enum(['in_progress', 'paused', 'ended', 'stopped']),
  record_json: z.unknown(),
  history: z.unknown(),
});
const activityRow = z.strictObject({
  id: uuid,
  revision: actualRevision,
  deleted: z.boolean(),
  original: z.record(z.string(), z.unknown()),
  overlay: z.unknown(),
  source_kind: z.string().nullable(),
  source_id: z.string().nullable(),
  source_revision: actualRevision.nullable(),
  content_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
const ledgerRow = z.strictObject({
  id,
  revision: revision.min(1),
  revision_id: uuid,
  status,
  record_json: z.unknown(),
});
const blueprintRow = z.strictObject({
  routine_id: uuid,
  version_id: uuid,
  version: revision.min(1),
  record_json: z.unknown(),
  head_version_id: uuid.nullable(),
  head_version: revision.min(1).nullable(),
  visibility: z.enum(['active', 'archived', 'deleted']).nullable(),
  favorite: z.boolean().nullable(),
});
const scheduleRow = z.strictObject({
  schedule_id: uuid,
  version_id: uuid,
  source_plan_version_id: uuid.nullable(),
  record_json: z.unknown(),
  head_version_id: uuid.nullable(),
  notification_muted: z.boolean().nullable(),
});
export interface RoutineActualSources {
  plan(id: string): Promise<PlanSnapshot>;
  sourceCount(): number;
}
interface ActualFact {
  requested: ActualRef;
  state: 'current' | 'historical' | 'deleted' | 'unavailable';
  reason: string | null;
  current: unknown;
  content: unknown;
}
function numericRevision(value: string) {
  if (!/^[1-9][0-9]*$/.test(value)) fail('INVALID_CONTEXT');
  return parse(actualRevision, Number(value));
}
/** A read manifest, not an approval or performance inference. Caller runs the combined
 * scalar preflight under lifecycle→tenant0. Historical references are never repinned. */
export async function captureRoutineActualManifest(tx: Transaction, sources: RoutineActualSources) {
  const occurrences = (
    await rows(
      tx,
      `SELECT id,schedule_id,schedule_version_id,blueprint_routine_id,blueprint_version_id,anchor_key,to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_at,record_json FROM routine_occurrence WHERE athlete_id=$1 ORDER BY id LIMIT 1001`,
      [tx.athleteId],
    )
  ).map((value) => {
    const row = parse(occurrenceRow, value),
      record = parse(routineOccurrenceSchema, row.record_json);
    if (
      record.id !== row.id ||
      record.schedule.id !== row.schedule_id ||
      record.schedule.versionId !== row.schedule_version_id ||
      record.blueprint.id !== row.blueprint_routine_id ||
      record.blueprint.versionId !== row.blueprint_version_id ||
      record.anchorKey !== row.anchor_key ||
      (record.scheduledAt === null
        ? row.scheduled_at !== null
        : row.scheduled_at === null ||
          Date.parse(record.scheduledAt) !== Date.parse(row.scheduled_at))
    )
      fail('INVALID_CONTEXT');
    return record;
  });
  const runs = (
    await rows(
      tx,
      `SELECT r.id,r.blueprint_routine_id,r.blueprint_version_id,r.occurrence_id,r.revision,r.state,r.record_json,h.record_json AS history FROM routine_run r LEFT JOIN routine_run_revision h ON h.athlete_id=r.athlete_id AND h.run_id=r.id AND h.revision=r.revision WHERE r.athlete_id=$1 ORDER BY r.id LIMIT 1001`,
      [tx.athleteId],
    )
  ).map((value) => {
    const row = parse(runRow, value),
      record = parse(routineRunSchema, row.record_json);
    if (row.history === null) fail('SOURCE_UNAVAILABLE');
    const history = parse(routineRunSchema, row.history);
    if (
      digest(history) !== digest(record) ||
      record.id !== row.id ||
      record.revision !== row.revision ||
      record.state !== row.state ||
      record.blueprint.id !== row.blueprint_routine_id ||
      record.blueprint.versionId !== row.blueprint_version_id ||
      (record.origin.kind === 'planned'
        ? record.origin.occurrenceId !== row.occurrence_id
        : row.occurrence_id !== null)
    )
      fail('INVALID_CONTEXT');
    return record;
  });
  const byOccurrence = new Map(occurrences.map((record) => [record.id, record]));
  const byStarted = new Map<string, RoutineRun>();
  for (const run of runs)
    if (run.origin.kind === 'planned') {
      const occurrence = byOccurrence.get(run.origin.occurrenceId);
      if (
        !occurrence ||
        occurrence.blueprint.id !== run.blueprint.id ||
        occurrence.blueprint.versionId !== run.blueprint.versionId ||
        byStarted.has(occurrence.id)
      )
        fail('SOURCE_UNAVAILABLE');
      byStarted.set(occurrence.id, run);
    }
  const scheduleIds = [...new Set(occurrences.map((record) => record.schedule.versionId))].sort();
  const scheduleRows = (
    await rows(
      tx,
      'SELECT v.schedule_id,v.version_id,v.source_plan_version_id,v.record_json,h.version_id AS head_version_id,h.notification_muted FROM routine_schedule_version v LEFT JOIN routine_schedule_head h ON h.athlete_id=v.athlete_id AND h.schedule_id=v.schedule_id WHERE v.athlete_id=$1 AND v.version_id=ANY($2::uuid[]) ORDER BY v.version_id LIMIT 5001',
      [tx.athleteId, scheduleIds],
      5000,
    )
  ).map((row) => parse(scheduleRow, row));
  const schedules = new Map(scheduleRows.map((row) => [row.version_id, row]));
  if (schedules.size !== scheduleIds.length) fail('SOURCE_UNAVAILABLE');
  for (const row of scheduleRows) {
    const record = parse(routineScheduleVersionSchema, row.record_json);
    if (record.id !== row.schedule_id || record.versionId !== row.version_id)
      fail('INVALID_CONTEXT');
    if (row.source_plan_version_id !== null) await sources.plan(row.source_plan_version_id);
    for (const occurrence of occurrences.filter(
      (item) => item.schedule.versionId === row.version_id,
    ))
      if (
        occurrence.schedule.id !== record.id ||
        occurrence.blueprint.id !== record.blueprint.id ||
        occurrence.blueprint.versionId !== record.blueprint.versionId
      )
        fail('INVALID_CONTEXT');
  }
  const currentBlueprintRefs = (
    await rows(
      tx,
      'SELECT v.blueprint_routine_id,v.blueprint_version_id FROM routine_schedule_head h LEFT JOIN routine_schedule_version v ON v.athlete_id=h.athlete_id AND v.schedule_id=h.schedule_id AND v.version_id=h.version_id WHERE h.athlete_id=$1 ORDER BY h.schedule_id LIMIT 1001',
      [tx.athleteId],
    )
  ).map((row) =>
    parse(z.strictObject({ blueprint_routine_id: uuid, blueprint_version_id: uuid }), row),
  );
  const blueprintIds = [
    ...new Set([
      ...occurrences.map((record) => record.blueprint.versionId),
      ...runs.map((record) => record.blueprint.versionId),
      ...currentBlueprintRefs.map((ref) => ref.blueprint_version_id),
    ]),
  ].sort();
  const blueprints = (
    await rows(
      tx,
      'SELECT v.routine_id,v.version_id,v.version,v.record_json,h.version_id AS head_version_id,h.version AS head_version,h.visibility,h.favorite FROM routine_blueprint_version v LEFT JOIN routine_blueprint_head h ON h.athlete_id=v.athlete_id AND h.routine_id=v.routine_id WHERE v.athlete_id=$1 AND v.version_id=ANY($2::uuid[]) ORDER BY v.version_id LIMIT 5001',
      [tx.athleteId, blueprintIds],
      5000,
    )
  ).map((value) => {
    const row = parse(blueprintRow, value),
      record = parse(routineBlueprintVersionSchema, row.record_json);
    if (record.routineId !== row.routine_id || record.versionId !== row.version_id)
      fail('INVALID_CONTEXT');
    if (
      row.head_version_id === null
        ? row.head_version !== null || row.visibility !== null || row.favorite !== null
        : row.head_version === null || row.visibility === null || row.favorite === null
    )
      fail('INVALID_CONTEXT');
    return {
      record,
      version: row.version,
      currentHead:
        row.head_version_id === null
          ? { state: 'absent' as const }
          : {
              state: 'present' as const,
              versionId: row.head_version_id,
              version: row.head_version,
              visibility: row.visibility,
              favorite: row.favorite,
            },
      unsupportedContent: record.steps
        .filter(
          (step) =>
            step.content.kind === 'recovery_method' || step.content.kind === 'checkin_template',
        )
        .map((step) => ({
          stepId: step.id,
          content: step.content,
          state: 'unavailable' as const,
          reason: 'producer_content_unsupported' as const,
        })),
    };
  });
  const byBlueprint = new Map(blueprints.map((row) => [row.record.versionId, row.record]));
  if (byBlueprint.size !== blueprintIds.length) fail('SOURCE_UNAVAILABLE');
  for (const ref of [
    ...occurrences.map((item) => item.blueprint),
    ...runs.map((item) => item.blueprint),
    ...currentBlueprintRefs.map((item) => ({
      id: item.blueprint_routine_id,
      versionId: item.blueprint_version_id,
    })),
  ])
    if (byBlueprint.get(ref.versionId)?.routineId !== ref.id) fail('INVALID_CONTEXT');
  for (const occurrence of occurrences) {
    const blueprint = byBlueprint.get(occurrence.blueprint.versionId) ?? fail('SOURCE_UNAVAILABLE');
    const steps = new Set(blueprint.steps.map((step) => step.id));
    if (occurrence.stepBindings.some((binding) => !steps.has(binding.stepId)))
      fail('INVALID_CONTEXT');
    for (const [groupId, stepId] of Object.entries(occurrence.selectedChoices))
      if (
        !blueprint.choiceGroups.some(
          (group) => group.id === groupId && group.stepIds.includes(stepId),
        )
      )
        fail('INVALID_CONTEXT');
  }
  const activities = (
    await rows(
      tx,
      'SELECT c.id,c.revision,c.deleted,c.original,o.values_json AS overlay,s.kind AS source_kind,s.source_id,s.source_revision,s.content_hash FROM activity_canonical c LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id LEFT JOIN activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id WHERE c.athlete_id=$1 ORDER BY c.id LIMIT 1001',
      [tx.athleteId],
    )
  ).map((row) => parse(activityRow, row));
  const intake = (
    await rows(
      tx,
      `SELECT e.id,e.current_revision AS revision,e.current_revision_id AS revision_id,e.status,CASE WHEN e.status='deleted' THEN jsonb_build_object('status','deleted','intakeId',e.id,'revisionId',r.revision_id,'revision',r.revision,'deletedAt',to_char(r.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reason',r.deletion_reason) ELSE r.record_json END AS record_json FROM intake_entry e LEFT JOIN intake_entry_revision r ON r.athlete_id=e.athlete_id AND r.intake_id=e.id AND r.revision=e.current_revision AND r.revision_id=e.current_revision_id WHERE e.athlete_id=$1 ORDER BY e.id LIMIT 1001`,
      [tx.athleteId],
    )
  ).map((row) => parse(ledgerRow, row));
  const recovery = (
    await rows(
      tx,
      'SELECT a.action_id::text AS id,a.revision,a.revision_id,a.status,r.record_json FROM recovery_action_log a LEFT JOIN recovery_action_revision r ON r.athlete_id=a.athlete_id AND r.action_id=a.action_id AND r.revision=a.revision AND r.revision_id=a.revision_id WHERE a.athlete_id=$1 ORDER BY a.action_id LIMIT 1001',
      [tx.athleteId],
    )
  ).map((row) => parse(ledgerRow, row));
  for (const row of intake) {
    if (row.record_json === null) fail('SOURCE_UNAVAILABLE');
    const record = parse(intakeEntryRecordSchema, row.record_json);
    if (
      record.intakeId !== row.id ||
      record.revisionId !== row.revision_id ||
      record.revision !== row.revision ||
      record.status !== row.status
    )
      fail('INVALID_CONTEXT');
  }
  for (const row of recovery) {
    if (row.record_json === null) fail('SOURCE_UNAVAILABLE');
    const record = parse(recoveryActionRecordSchema, row.record_json);
    if (
      record.actionId !== row.id ||
      record.revisionId !== row.revision_id ||
      record.revision !== row.revision ||
      record.status !== row.status
    )
      fail('INVALID_CONTEXT');
  }
  const byActivity = new Map(activities.map((row) => [row.id, row]));
  const byIntake = new Map(intake.map((row) => [row.id, row]));
  const byRecovery = new Map(recovery.map((row) => [row.id, row]));
  const cache = new Map<string, Promise<ActualFact>>();
  async function actual(ref: ActualRef, run: RoutineRun, stepId: string): Promise<ActualFact> {
    const key = digest({
      ref,
      ...(ref.kind === 'checklist_confirmation' ? { runId: run.id, stepId } : {}),
    });
    const cached = cache.get(key);
    if (cached) return cached;
    if (sources.sourceCount() + scheduleIds.length + blueprintIds.length + cache.size >= 5000)
      fail('CONTEXT_UNAVAILABLE');
    const pending = (async (): Promise<ActualFact> => {
      const unavailable = (reason: string, current: unknown = null): ActualFact => ({
        requested: ref,
        state: 'unavailable',
        reason,
        current,
        content: null,
      });
      if (ref.kind === 'recovery_log')
        return unavailable(
          'producer_actual_unsupported',
          byRecovery.get(parse(uuid, ref.id))
            ? {
                id: ref.id,
                revision: byRecovery.get(ref.id)?.revision,
                status: byRecovery.get(ref.id)?.status,
              }
            : null,
        );
      if (ref.kind === 'activity') {
        const requestedRevision = numericRevision(ref.revisionId),
          current = byActivity.get(parse(uuid, ref.id));
        if (ref.allocationId !== null)
          return unavailable(
            'producer_allocation_unsupported',
            current
              ? { id: current.id, revision: current.revision, deleted: current.deleted }
              : null,
          );
        if (!current) return unavailable('owned_reference_unavailable');
        const head = { id: current.id, revision: current.revision, deleted: current.deleted };
        if (current.deleted)
          return { requested: ref, state: 'deleted', reason: null, current: head, content: null };
        if (requestedRevision > current.revision) fail('INVALID_CONTEXT');
        if (requestedRevision < current.revision)
          return unavailable('requested_revision_unavailable', head);
        const original = parse(activityValuesSchema, current.original),
          overlay = current.overlay === null ? null : parse(activityOverlaySchema, current.overlay);
        let detail: unknown = null;
        if (ref.detailId !== null) {
          const fetched = (
            await tx.query(
              'SELECT id,activity_id,execution_id,current_revision,current_revision_id,status FROM supplementary_set_log WHERE athlete_id=$1 AND id=$2',
              [tx.athleteId, parse(uuid, ref.detailId)],
            )
          ).rows;
          if (fetched.length === 0) return unavailable('owned_detail_unavailable', head);
          const row = parse(
            z.strictObject({
              id: uuid,
              activity_id: uuid,
              execution_id: uuid,
              current_revision: revision.min(1),
              current_revision_id: uuid,
              status,
            }),
            fetched[0],
          );
          if (row.activity_id !== current.id) fail('INVALID_CONTEXT');
          if (row.status === 'deleted') return unavailable('detail_deleted', head);
          detail = row;
        }
        return {
          requested: ref,
          state: 'current',
          reason: null,
          current: head,
          content: { original, overlay, detail },
        };
      }
      if (ref.kind === 'intake') {
        parse(uuid, ref.revisionId);
        const current = byIntake.get(ref.id);
        if (!current) return unavailable('owned_reference_unavailable');
        const head = {
          id: current.id,
          revision: current.revision,
          revisionId: current.revision_id,
          status: current.status,
        };
        if (current.status === 'deleted')
          return { requested: ref, state: 'deleted', reason: null, current: head, content: null };
        const fetched = (
          await tx.query(
            'SELECT revision,record_json FROM intake_entry_revision WHERE athlete_id=$1 AND intake_id=$2 AND revision_id=$3',
            [tx.athleteId, ref.id, ref.revisionId],
          )
        ).rows;
        if (fetched.length === 0) return unavailable('requested_revision_unavailable', head);
        const row = parse(
            z.strictObject({ revision: revision.min(1), record_json: z.unknown() }),
            fetched[0],
          ),
          record = parse(intakeEntryRecordSchema, row.record_json);
        if (
          record.intakeId !== ref.id ||
          record.revisionId !== ref.revisionId ||
          record.revision !== row.revision ||
          record.status !== 'active' ||
          record.revision > current.revision
        )
          fail('INVALID_CONTEXT');
        return {
          requested: ref,
          state: ref.revisionId === current.revision_id ? 'current' : 'historical',
          reason: null,
          current: head,
          content: record,
        };
      }
      if (ref.kind === 'checkin') {
        const requestedRevision = numericRevision(ref.revisionId);
        const fetched = (
          await tx.query(
            'SELECT id,revision,deleted,values_json FROM check_in WHERE athlete_id=$1 AND id=$2',
            [tx.athleteId, parse(uuid, ref.id)],
          )
        ).rows;
        if (fetched.length === 0) return unavailable('owned_reference_unavailable');
        const row = parse(
          z.strictObject({
            id: uuid,
            revision: revision.min(1),
            deleted: z.boolean(),
            values_json: z.unknown(),
          }),
          fetched[0],
        );
        const head = { id: row.id, revision: row.revision, deleted: row.deleted };
        if (row.deleted)
          return { requested: ref, state: 'deleted', reason: null, current: head, content: null };
        if (requestedRevision > row.revision) fail('INVALID_CONTEXT');
        const history = (
          await tx.query(
            'SELECT values_json FROM check_in_revision WHERE athlete_id=$1 AND check_in_id=$2 AND revision=$3',
            [tx.athleteId, ref.id, requestedRevision],
          )
        ).rows[0];
        if (!history) return unavailable('requested_revision_unavailable', head);
        const values = parse(checkInValuesSchema, history['values_json']);
        if (
          requestedRevision === row.revision &&
          digest(values) !== digest(parse(checkInValuesSchema, row.values_json))
        )
          fail('INVALID_CONTEXT');
        return {
          requested: ref,
          state: requestedRevision === row.revision ? 'current' : 'historical',
          reason: null,
          current: head,
          content: values,
        };
      }
      const fetched = (
        await tx.query(
          `SELECT id,run_id,step_id,revision_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,state FROM routine_checklist_confirmation WHERE athlete_id=$1 AND id=$2`,
          [tx.athleteId, parse(uuid, ref.id)],
        )
      ).rows;
      parse(uuid, ref.revisionId);
      if (fetched.length === 0) return unavailable('owned_reference_unavailable');
      const record = parse(
        z.strictObject({
          id: uuid,
          run_id: uuid,
          step_id: id,
          revision_id: uuid,
          occurred_at: z.iso.datetime(),
          state: z.enum(['performed', 'partial']),
        }),
        fetched[0],
      );
      if (
        record.run_id !== run.id ||
        record.step_id !== stepId ||
        record.revision_id !== ref.revisionId
      )
        fail('INVALID_CONTEXT');
      const progress = run.progress.find((item) => item.stepId === stepId);
      if (
        !progress ||
        progress.state !== record.state ||
        progress.occurredAt === null ||
        Date.parse(progress.occurredAt) !== Date.parse(record.occurred_at)
      )
        fail('INVALID_CONTEXT');
      return {
        requested: ref,
        state: 'current',
        reason: null,
        current: { id: record.id, revisionId: record.revision_id },
        content: record,
      };
    })();
    cache.set(key, pending);
    return pending;
  }
  const runManifest = [];
  for (const run of runs) {
    const blueprint = byBlueprint.get(run.blueprint.versionId) ?? fail('SOURCE_UNAVAILABLE');
    const steps = new Map(blueprint.steps.map((step) => [step.id, step]));
    for (const [groupId, stepId] of Object.entries(run.selectedChoices))
      if (
        !blueprint.choiceGroups.some(
          (group) => group.id === groupId && group.stepIds.includes(stepId),
        )
      )
        fail('INVALID_CONTEXT');
    const actuals = [];
    for (const progress of run.progress) {
      const step = steps.get(progress.stepId);
      if (!step) fail('INVALID_CONTEXT');
      for (const ref of progress.actualRefs) {
        if (
          (ref.kind === 'activity' && step.content.kind !== 'workout_template') ||
          (ref.kind === 'intake' && step.content.kind !== 'nutrition_template') ||
          (ref.kind === 'checkin' && step.content.kind !== 'checkin_template') ||
          (ref.kind === 'checklist_confirmation' && step.content.kind !== 'checklist') ||
          (ref.kind === 'recovery_log' && step.content.kind !== 'recovery_method')
        )
          fail('INVALID_CONTEXT');
        actuals.push({ stepId: progress.stepId, fact: await actual(ref, run, progress.stepId) });
      }
    }
    runManifest.push({ record: run, historyDigest: digest(run), actuals });
  }
  return {
    uniqueSourceCount: scheduleIds.length + blueprintIds.length + cache.size,
    occurrences: occurrences.map((record) => ({
      record,
      currentSchedule:
        schedules.get(record.schedule.versionId)?.head_version_id === null
          ? { state: 'absent' as const }
          : {
              state: 'present' as const,
              versionId: schedules.get(record.schedule.versionId)?.head_version_id,
            },
      startedRun: byStarted.has(record.id)
        ? {
            state: 'present' as const,
            runId: byStarted.get(record.id)?.id,
            revision: byStarted.get(record.id)?.revision,
          }
        : { state: 'absent' as const },
    })),
    runs: runManifest,
    blueprints,
    schedules: scheduleRows.map((row) => ({
      scheduleId: row.schedule_id,
      versionId: row.version_id,
      sourcePlanVersionId: row.source_plan_version_id,
      record: parse(routineScheduleVersionSchema, row.record_json),
      currentHead:
        row.head_version_id === null
          ? { state: 'absent' as const }
          : {
              state: 'present' as const,
              versionId: row.head_version_id,
              notificationMuted: row.notification_muted,
            },
    })),
    actualRosters: {
      activities: activities.map((row) => ({
        id: row.id,
        revision: row.revision,
        deleted: row.deleted,
        originalDigest: digest(row.original),
        overlayDigest: digest(row.overlay),
        source:
          row.source_kind === null
            ? { state: 'absent' as const }
            : {
                state: 'present' as const,
                kind: row.source_kind,
                sourceId: row.source_id,
                sourceRevision: row.source_revision,
                contentHash: row.content_hash,
              },
      })),
      intake: intake.map((row) => ({
        id: row.id,
        revision: row.revision,
        revisionId: row.revision_id,
        status: row.status,
        contentDigest: digest(row.record_json),
      })),
      recovery: recovery.map((row) => ({
        id: row.id,
        revision: row.revision,
        revisionId: row.revision_id,
        status: row.status,
        contentDigest: digest(row.record_json),
      })),
    },
  };
}
