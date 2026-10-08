// Export34 factual routine/recovery records. This artifact grants no processing authority.
import { z } from 'zod';
import {
  type RaceManualPersonalExportData,
  validateRaceManualPersonalExportTuples,
} from './race-manual-personal-export.js';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  planDomainSchema,
} from './routines.js';
import {
  recoveryMethodVersionSchema,
  recoveryStrategyVersionSchema,
  recoveryActionRecordSchema,
} from './recovery-core.js';
import { integratedApprovalResultV4Schema } from './integrated-coaching.js';

const exportUuid34 = z.uuid();
const exportInstant34 = z.iso.datetime({ offset: true });
const exportRevision34 = z.number().int().min(1).max(2147483646);
const exportRunRevision34 = z.number().int().min(0).max(2147483646);
const exportStepId34 = z.string().min(1).max(200);
const exportRunState34 = z.enum(['in_progress', 'paused', 'ended', 'stopped']);
// Canonical decimal STRING, with PostgreSQL signed-bigint upper bound. No Number conversion.
const exportPauseMs34 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807');
function exportBody34<T>(schema: z.ZodType<T>, bytes: number) {
  return z
    .unknown()
    .superRefine((value, context) => {
      const json = z.json().safeParse(value);
      if (!json.success) {
        context.addIssue({ code: 'custom', message: 'Export body must be JSON' });
        return;
      }
      if (new TextEncoder().encode(JSON.stringify(json.data)).byteLength > bytes)
        context.addIssue({ code: 'custom', message: 'Export body byte bound exceeded' });
    })
    .pipe(schema);
}
function exportIssue34(context: z.RefinementCtx, message: string) {
  context.addIssue({ code: 'custom', message });
}
const blueprintRow34 = z
  .strictObject({
    routine_id: exportUuid34,
    version_id: exportUuid34,
    version: exportRevision34,
    previous_version_id: exportUuid34.nullable(),
    record_json: exportBody34(routineBlueprintVersionSchema, 1048576),
    created_at: exportInstant34,
  })
  .superRefine((row, context) => {
    if (
      row.record_json.routineId !== row.routine_id ||
      row.record_json.versionId !== row.version_id
    )
      exportIssue34(context, 'Blueprint identity tuple mismatch');
    if ((row.version === 1) !== (row.previous_version_id === null))
      exportIssue34(context, 'Blueprint predecessor mismatch');
  });
const blueprintHeadRow34 = z.strictObject({
  routine_id: exportUuid34,
  version_id: exportUuid34,
  version: exportRevision34,
  favorite: z.boolean(),
  visibility: z.enum(['active', 'archived', 'deleted']),
});
const scheduleRow34 = z
  .strictObject({
    schedule_id: exportUuid34,
    version_id: exportUuid34,
    prior_version_id: exportUuid34.nullable(),
    blueprint_routine_id: exportUuid34,
    blueprint_version_id: exportUuid34,
    source_plan_version_id: exportUuid34.nullable(),
    record_json: exportBody34(routineScheduleVersionSchema, 65536),
    created_at: exportInstant34,
  })
  .superRefine((row, context) => {
    const body = row.record_json;
    if (
      body.id !== row.schedule_id ||
      body.versionId !== row.version_id ||
      body.blueprint.id !== row.blueprint_routine_id ||
      body.blueprint.versionId !== row.blueprint_version_id
    )
      exportIssue34(context, 'Schedule identity tuple mismatch');
  });
const scheduleHeadRow34 = z.strictObject({
  schedule_id: exportUuid34,
  version_id: exportUuid34,
  notification_muted: z.boolean(),
});
const occurrenceRow34 = z
  .strictObject({
    id: exportUuid34,
    schedule_id: exportUuid34,
    schedule_version_id: exportUuid34,
    blueprint_routine_id: exportUuid34,
    blueprint_version_id: exportUuid34,
    anchor_key: z.string().min(1).max(200),
    scheduled_at: exportInstant34.nullable(),
    record_json: exportBody34(routineOccurrenceSchema, 65536),
  })
  .superRefine((row, context) => {
    const body = row.record_json;
    if (
      body.id !== row.id ||
      body.schedule.id !== row.schedule_id ||
      body.schedule.versionId !== row.schedule_version_id ||
      body.blueprint.id !== row.blueprint_routine_id ||
      body.blueprint.versionId !== row.blueprint_version_id ||
      body.anchorKey !== row.anchor_key ||
      (body.scheduledAt === null) !== (row.scheduled_at === null)
    )
      exportIssue34(context, 'Occurrence identity/anchor tuple mismatch');
    // Non-null timestamps are compared precisely by the v34 data tuple validator below.
  });
const runRow34 = z
  .strictObject({
    id: exportUuid34,
    blueprint_routine_id: exportUuid34,
    blueprint_version_id: exportUuid34,
    occurrence_id: exportUuid34.nullable(),
    revision: exportRunRevision34,
    state: exportRunState34,
    record_json: exportBody34(routineRunSchema, 1048576),
  })
  .superRefine((row, context) => {
    const body = row.record_json;
    if (
      body.id !== row.id ||
      body.revision !== row.revision ||
      body.state !== row.state ||
      body.blueprint.id !== row.blueprint_routine_id ||
      body.blueprint.versionId !== row.blueprint_version_id ||
      (body.origin.kind === 'planned' ? body.origin.occurrenceId : null) !== row.occurrence_id
    )
      exportIssue34(context, 'Run identity/origin tuple mismatch');
  });
const runRevisionRow34 = z
  .strictObject({
    run_id: exportUuid34,
    revision: exportRunRevision34,
    record_json: exportBody34(routineRunSchema, 1048576),
    recorded_at: exportInstant34,
  })
  .superRefine((row, context) => {
    if (row.record_json.id !== row.run_id || row.record_json.revision !== row.revision)
      exportIssue34(context, 'Run revision tuple mismatch');
  });
const checklistRow34 = z.strictObject({
  id: exportUuid34,
  run_id: exportUuid34,
  step_id: exportStepId34,
  revision_id: exportUuid34,
  occurred_at: exportInstant34,
  state: z.enum(['performed', 'partial']),
});
const timerRow34 = z
  .strictObject({
    run_id: exportUuid34,
    step_id: exportStepId34,
    revision: exportRevision34,
    state: z.enum(['running', 'paused', 'cleared']),
    duration_seconds: z.number().int().min(1).max(86400),
    started_at: exportInstant34,
    paused_at: exportInstant34.nullable(),
    paused_milliseconds: exportPauseMs34,
  })
  .refine(
    (row) => (row.state === 'paused') === (row.paused_at !== null),
    'Timer pause state mismatch',
  );
const methodRow34 = z
  .strictObject({
    method_id: exportUuid34,
    version_id: exportUuid34,
    version: exportRevision34,
    record_json: exportBody34(recoveryMethodVersionSchema, 65536),
  })
  .superRefine((row, context) => {
    if (
      row.record_json.methodId !== row.method_id ||
      row.record_json.versionId !== row.version_id ||
      row.record_json.version !== row.version
    )
      exportIssue34(context, 'Method identity tuple mismatch');
  });
const methodHeadRow34 = z.strictObject({
  method_id: exportUuid34,
  version: exportRevision34,
  version_id: exportUuid34,
});
const strategyRow34 = z
  .strictObject({
    strategy_id: exportUuid34,
    version_id: exportUuid34,
    version: exportRevision34,
    previous_version_id: exportUuid34.nullable(),
    previous_version: exportRevision34.nullable(),
    record_json: exportBody34(recoveryStrategyVersionSchema, 262144),
  })
  .superRefine((row, context) => {
    const body = row.record_json;
    if (
      body.strategyId !== row.strategy_id ||
      body.versionId !== row.version_id ||
      body.version !== row.version ||
      body.previousVersionId !== row.previous_version_id
    )
      exportIssue34(context, 'Strategy identity tuple mismatch');
    if (
      row.version === 1
        ? row.previous_version !== null || row.previous_version_id !== null
        : row.previous_version !== row.version - 1 || row.previous_version_id === null
    )
      exportIssue34(context, 'Strategy predecessor tuple mismatch');
  });
const strategyHeadRow34 = z.strictObject({
  strategy_id: exportUuid34,
  version: exportRevision34,
  version_id: exportUuid34,
});
const actionRow34 = z.strictObject({
  action_id: exportUuid34,
  revision: exportRevision34,
  revision_id: exportUuid34,
  status: z.enum(['active', 'deleted']),
});
const actionRevisionRow34 = z
  .strictObject({
    action_id: exportUuid34,
    revision: exportRevision34,
    revision_id: exportUuid34,
    status: z.enum(['active', 'deleted']),
    record_json: exportBody34(recoveryActionRecordSchema, 65536),
  })
  .superRefine((row, context) => {
    const body = row.record_json;
    if (
      body.actionId !== row.action_id ||
      body.revision !== row.revision ||
      body.revisionId !== row.revision_id ||
      body.status !== row.status
    )
      exportIssue34(context, 'Action revision tuple mismatch');
  });
const historyRow34 = z.strictObject({
  version_id: exportUuid34,
  approval_id: exportUuid34,
  action: z.literal('candidate_approved'),
});
const referencedApprovalRow34 = z
  .strictObject({
    approval_id: exportUuid34,
    candidate_id: exportUuid34,
    proposal_id: exportUuid34,
    proposal_digest: z.string().regex(/^[a-f0-9]{64}$/),
    write_domains: z
      .array(planDomainSchema)
      .min(1)
      .max(4)
      .refine((xs) => new Set(xs).size === xs.length),
    result_json: integratedApprovalResultV4Schema,
    approved_at: exportInstant34,
  })
  .superRefine((row, context) => {
    const result = row.result_json;
    if (
      result.approvalId !== row.approval_id ||
      result.candidateId !== row.candidate_id ||
      new Set(result.versions.map((item) => item.domain)).size !== row.write_domains.length ||
      result.versions.some((item) => !row.write_domains.includes(item.domain))
    )
      exportIssue34(context, 'Approval result identity/domain tuple mismatch');
  });
export const genericRecoveryExportFields34 = {
  genericRoutineBlueprintVersions: z.array(blueprintRow34).max(1000),
  genericRoutineBlueprintHeads: z.array(blueprintHeadRow34).max(1000),
  genericRoutineScheduleVersions: z.array(scheduleRow34).max(1000),
  genericRoutineScheduleHeads: z.array(scheduleHeadRow34).max(1000),
  genericRoutineOccurrences: z.array(occurrenceRow34).max(1000),
  genericRoutineRuns: z.array(runRow34).max(1000),
  genericRoutineRunRevisions: z.array(runRevisionRow34).max(1000),
  genericRoutineChecklistConfirmations: z.array(checklistRow34).max(1000),
  genericRoutineStepTimers: z.array(timerRow34).max(1000),
  recoveryMethodVersions: z.array(methodRow34).max(1000),
  recoveryMethodHeads: z.array(methodHeadRow34).max(1000),
  recoveryStrategyVersions: z.array(strategyRow34).max(1000),
  recoveryStrategyHeads: z.array(strategyHeadRow34).max(1000),
  recoveryActions: z.array(actionRow34).max(1000),
  recoveryActionRevisions: z.array(actionRevisionRow34).max(1000),
  recoveryStrategyHistory: z.array(historyRow34).max(1000),
  genericRoutineScheduleHistory: z.array(historyRow34).max(1000),
  referencedIntegratedApprovalFacts: z.array(referencedApprovalRow34).max(1000),
};
// Precise instant comparison: parse the timezone/whole seconds separately;
// preserve arbitrary fractional precision as canonical decimal text.
function preciseInstant34(value: string): string | null {
  const match = /^(.*:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match?.[1] || !match[3]) return null;
  const milliseconds = Date.parse(match[1] + match[3]);
  if (!Number.isSafeInteger(milliseconds)) return null;
  return `${milliseconds}:${(match[2] ?? '').replace(/0+$/, '')}`;
}
function sameInstant34(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const normalized = preciseInstant34(left);
  return normalized !== null && normalized === preciseInstant34(right);
}
const genericRecoveryExportRows34 = z.strictObject(genericRecoveryExportFields34);
type GenericRecoveryExportData34 = z.infer<typeof genericRecoveryExportRows34>;
export const genericRecoveryExportData34 = genericRecoveryExportRows34.superRefine(
  validateGenericRecoveryExportTuples34,
);
export function validateGenericRecoveryExportTuples34(
  data: GenericRecoveryExportData34,
  context: z.RefinementCtx,
) {
  validateGenericRecoveryExportTuples(data, context);
}
/** V36 accepts separately typed genuine manual results, never a fabricated
 * integrated approval fact. Historical V34/V35 calls keep the empty default. */
export function validateGenericRecoveryExportTuples36(
  data: GenericRecoveryExportData34 & RaceManualPersonalExportData,
  context: z.RefinementCtx,
) {
  validateRaceManualPersonalExportTuples(data, context);
  validateGenericRecoveryExportTuples(
    data,
    context,
    data.manualRaceCommandResults,
    'versioned_anchor',
  );
}
function validateGenericRecoveryExportTuples(
  data: GenericRecoveryExportData34,
  context: z.RefinementCtx,
  manualCommands: RaceManualPersonalExportData['manualRaceCommandResults'] = [],
  occurrenceIdentity: 'aggregate_anchor' | 'versioned_anchor' = 'aggregate_anchor',
) {
  const requireFact = (found: boolean, message: string) => {
    if (!found) exportIssue34(context, message);
  };
  const unique = (keys: readonly string[]) =>
    requireFact(new Set(keys).size === keys.length, 'Duplicate export factual identity');
  unique(data.genericRoutineBlueprintVersions.map((r) => r.version_id));
  unique(
    data.genericRoutineBlueprintVersions.map((r) => JSON.stringify([r.routine_id, r.version])),
  );
  unique(data.genericRoutineBlueprintHeads.map((r) => r.routine_id));
  unique(data.genericRoutineScheduleVersions.map((r) => r.version_id));
  unique(data.genericRoutineScheduleHeads.map((r) => r.schedule_id));
  unique(data.genericRoutineOccurrences.map((r) => r.id));
  unique(
    data.genericRoutineOccurrences.map((r) =>
      JSON.stringify(
        occurrenceIdentity === 'versioned_anchor'
          ? [r.schedule_id, r.schedule_version_id, r.anchor_key]
          : [r.schedule_id, r.anchor_key],
      ),
    ),
  );
  unique(data.genericRoutineRuns.map((r) => r.id));
  unique(data.genericRoutineRunRevisions.map((r) => JSON.stringify([r.run_id, r.revision])));
  unique(data.genericRoutineChecklistConfirmations.map((r) => r.id));
  unique(data.genericRoutineStepTimers.map((r) => JSON.stringify([r.run_id, r.step_id])));
  unique(data.recoveryMethodVersions.map((r) => r.version_id));
  unique(data.recoveryMethodVersions.map((r) => JSON.stringify([r.method_id, r.version])));
  unique(data.recoveryMethodHeads.map((r) => r.method_id));
  unique(data.recoveryStrategyVersions.map((r) => r.version_id));
  unique(data.recoveryStrategyVersions.map((r) => JSON.stringify([r.strategy_id, r.version])));
  unique(data.recoveryStrategyHeads.map((r) => r.strategy_id));
  unique(data.recoveryActions.map((r) => r.action_id));
  unique(data.recoveryActionRevisions.map((r) => JSON.stringify([r.action_id, r.revision])));
  unique(data.recoveryActionRevisions.map((r) => r.revision_id));
  unique(data.recoveryStrategyHistory.map((r) => r.version_id));
  unique(data.genericRoutineScheduleHistory.map((r) => r.version_id));
  unique(data.referencedIntegratedApprovalFacts.map((r) => r.approval_id));
  const blueprints = new Map(
    data.genericRoutineBlueprintVersions.map((row) => [row.version_id, row]),
  );
  const schedules = new Map(
    data.genericRoutineScheduleVersions.map((row) => [row.version_id, row]),
  );
  const occurrences = new Map(data.genericRoutineOccurrences.map((row) => [row.id, row]));
  const runs = new Map(data.genericRoutineRuns.map((row) => [row.id, row]));
  const methods = new Map(data.recoveryMethodVersions.map((row) => [row.version_id, row]));
  const strategies = new Map(data.recoveryStrategyVersions.map((row) => [row.version_id, row]));
  const approvals = new Map(
    data.referencedIntegratedApprovalFacts.map((row) => [row.approval_id, row]),
  );
  const manualApprovals = new Map<
    string,
    Extract<
      Extract<
        RaceManualPersonalExportData['manualRaceCommandResults'][number],
        { operation: 'approve' }
      >['result'],
      { status: 'committed' }
    >
  >();
  for (const command of manualCommands) {
    if (command.operation !== 'approve' || command.result.status !== 'committed') continue;
    requireFact(
      !approvals.has(command.result.approvalId) && !manualApprovals.has(command.result.approvalId),
      'Approval identity cannot alias different producer families',
    );
    manualApprovals.set(command.result.approvalId, command.result);
  }
  for (const row of data.genericRoutineBlueprintVersions) {
    requireFact(
      sameInstant34(row.record_json.createdAt, row.created_at),
      'Blueprint timestamp differs',
    );
    if (row.previous_version_id !== null) {
      const prior = blueprints.get(row.previous_version_id);
      requireFact(
        prior !== undefined &&
          prior.routine_id === row.routine_id &&
          prior.version === row.version - 1,
        'Blueprint predecessor tuple absent',
      );
    }
  }
  for (const head of data.genericRoutineBlueprintHeads) {
    const row = blueprints.get(head.version_id);
    requireFact(
      row !== undefined && row.routine_id === head.routine_id && row.version === head.version,
      'Blueprint head tuple absent',
    );
  }
  for (const row of data.genericRoutineScheduleVersions) {
    requireFact(
      blueprints.get(row.blueprint_version_id)?.routine_id === row.blueprint_routine_id,
      'Schedule blueprint tuple absent',
    );
    if (row.prior_version_id !== null)
      requireFact(
        schedules.get(row.prior_version_id)?.schedule_id === row.schedule_id,
        'Schedule predecessor tuple absent',
      );
  }
  for (const head of data.genericRoutineScheduleHeads)
    requireFact(
      schedules.get(head.version_id)?.schedule_id === head.schedule_id,
      'Schedule head tuple absent',
    );
  for (const row of data.genericRoutineOccurrences) {
    const schedule = schedules.get(row.schedule_version_id);
    requireFact(
      schedule !== undefined &&
        schedule.schedule_id === row.schedule_id &&
        schedule.blueprint_routine_id === row.blueprint_routine_id &&
        schedule.blueprint_version_id === row.blueprint_version_id,
      'Occurrence schedule/blueprint tuple absent',
    );
    requireFact(
      sameInstant34(row.record_json.scheduledAt, row.scheduled_at),
      'Occurrence timestamp differs',
    );
  }
  for (const run of data.genericRoutineRuns) {
    requireFact(
      blueprints.get(run.blueprint_version_id)?.routine_id === run.blueprint_routine_id,
      'Run blueprint tuple absent',
    );
    if (run.occurrence_id !== null) {
      const occurrence = occurrences.get(run.occurrence_id);
      requireFact(
        occurrence !== undefined &&
          occurrence.blueprint_routine_id === run.blueprint_routine_id &&
          occurrence.blueprint_version_id === run.blueprint_version_id,
        'Run occurrence tuple absent',
      );
    }
    const revision = data.genericRoutineRunRevisions.find(
      (row) => row.run_id === run.id && row.revision === run.revision,
    );
    requireFact(
      revision !== undefined &&
        JSON.stringify(revision.record_json) === JSON.stringify(run.record_json),
      'Run current revision differs',
    );
  }
  for (const row of data.genericRoutineRunRevisions) {
    const run = runs.get(row.run_id);
    requireFact(
      run !== undefined &&
        row.revision <= run.revision &&
        row.record_json.blueprint.id === run.blueprint_routine_id &&
        row.record_json.blueprint.versionId === run.blueprint_version_id &&
        (row.record_json.origin.kind === 'planned' ? row.record_json.origin.occurrenceId : null) ===
          run.occurrence_id,
      'Historical run frozen tuple differs',
    );
  }
  for (const row of [
    ...data.genericRoutineChecklistConfirmations,
    ...data.genericRoutineStepTimers,
  ]) {
    const run = runs.get(row.run_id);
    const blueprint = run ? blueprints.get(run.blueprint_version_id) : undefined;
    requireFact(
      blueprint?.record_json.steps.some((step) => step.id === row.step_id) === true,
      'Run step reference absent',
    );
  }
  for (const head of data.recoveryMethodHeads) {
    const row = methods.get(head.version_id);
    requireFact(
      row !== undefined && row.method_id === head.method_id && row.version === head.version,
      'Method head tuple absent',
    );
  }
  for (const row of data.recoveryStrategyVersions) {
    if (row.previous_version_id !== null) {
      const prior = strategies.get(row.previous_version_id);
      requireFact(
        prior !== undefined &&
          prior.strategy_id === row.strategy_id &&
          prior.version === row.previous_version,
        'Strategy predecessor tuple absent',
      );
    }
    for (const option of row.record_json.draft.options)
      if (option.methodVersionId !== null)
        requireFact(methods.has(option.methodVersionId), 'Strategy method version absent');
  }
  for (const head of data.recoveryStrategyHeads) {
    const row = strategies.get(head.version_id);
    requireFact(
      row !== undefined && row.strategy_id === head.strategy_id && row.version === head.version,
      'Strategy head tuple absent',
    );
  }
  for (const action of data.recoveryActions)
    requireFact(
      data.recoveryActionRevisions.some(
        (row) =>
          row.action_id === action.action_id &&
          row.revision === action.revision &&
          row.revision_id === action.revision_id &&
          row.status === action.status,
      ),
      'Current action exact tuple absent',
    );
  for (const row of data.recoveryActionRevisions) {
    const head = data.recoveryActions.find((action) => action.action_id === row.action_id);
    requireFact(
      head !== undefined && row.revision <= head.revision,
      'Action revision current identity absent',
    );
    if (row.record_json.status === 'active') {
      requireFact(methods.has(row.record_json.methodVersionId), 'Action method version absent');
      if (row.record_json.strategyVersionId !== null)
        requireFact(
          strategies.has(row.record_json.strategyVersionId),
          'Action strategy version absent',
        );
    }
  }
  const referenced = new Set<string>();
  for (const [rows, domain] of [
    [data.recoveryStrategyHistory, 'recovery'],
    [data.genericRoutineScheduleHistory, 'routine_schedule'],
  ] as const) {
    for (const history of rows) {
      referenced.add(history.approval_id);
      const approval = approvals.get(history.approval_id);
      const manual = manualApprovals.get(history.approval_id);
      const version =
        domain === 'recovery'
          ? strategies.get(history.version_id)
          : schedules.get(history.version_id);
      const aggregateId =
        version && ('strategy_id' in version ? version.strategy_id : version.schedule_id);
      requireFact(
        version !== undefined &&
          (approval?.result_json ?? manual)?.versions.some(
            (item) =>
              item.domain === domain &&
              item.versionId === history.version_id &&
              item.aggregateId === aggregateId,
          ) === true,
        'Approval history committed version tuple absent',
      );
    }
  }
  for (const approval of data.referencedIntegratedApprovalFacts) {
    requireFact(referenced.has(approval.approval_id), 'Unreferenced approval fact');
    requireFact(
      sameInstant34(approval.result_json.approvedAt, approval.approved_at),
      'Approval timestamp differs',
    );
  }
}
