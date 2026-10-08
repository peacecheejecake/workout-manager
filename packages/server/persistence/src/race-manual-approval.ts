import {
  assertRaceManualSameTxApprovalContinuation,
  type RaceManualSameTxApprovalContinuation,
} from './race-manual-same-tx-approval-continuation.js';
import { prepareRaceManualSameTxReviewApplicationIn } from './race-manual-same-tx-review-continuation.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  raceManualApprovalCandidateSchema,
  raceManualApprovalCommandSchema,
  raceManualApprovalExpectedHeadsSchema,
  raceManualApprovalNutritionKey,
  raceManualApprovalResultSchema,
  type RaceManualApprovalWrite,
} from '@workout/contracts/race-manual-approval';
import { saveNutritionPlanV4IntentSchema } from '@workout/contracts/nutrition-race-plan-v4';
import {
  routineScheduleVersionSchema,
  routineRunSchema,
  routineOccurrenceSchema,
} from '@workout/contracts/routines';
import type { Database, Transaction } from './database.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import {
  prepareRaceManualSemanticBasisV2In,
  raceManualSemanticBasisV2Schema,
} from './race-manual-review-semantic-basis-v2.js';
import { raceProjectionIntentSchema } from './race-plan-impact-projection-input.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';
import { readRaceManualReviewCompatibleChainIn } from './race-manual-review-chain-v2.js';
import { captureRaceManualReviewCompatibleLifecycleInventoryIn } from './race-manual-review-lifecycle-inventory-v2.js';
import { expandRoutineSchedule } from './routine-expansion.js';
import { persistPlanVersion } from './planning.js';
import {
  persistRecoveryStrategyVersionIn,
  persistRoutineScheduleVersionIn,
} from './race-manual-approval-domain-writes.js';
import { saveNutritionPlanV4ForRaceApprovalIn } from './nutrition-race-plan-v4-writer.js';
import { enqueue } from './outbox.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const same = (a: unknown, b: unknown) => impactDependencyDigest(a) === impactDependencyDigest(b);
const plain = z.unknown().superRefine((v, c) => {
  try {
    assertRaceManualPlainV2(v);
  } catch {
    c.addIssue({ code: 'custom', message: 'Invalid bounded plain approval input' });
  }
});
/** Internal preparation input. An optimistic basis and parent IDs are not
 * credentials. Public transport will accept only a stored server basis reference. */
export const raceManualApprovalPrepareSchema = plain.pipe(
  z.strictObject({
    schemaVersion: z.literal(1),
    chain: raceManualApprovalCommandSchema.out.shape.chain,
    intent: raceProjectionIntentSchema,
    expectedBasis: raceManualSemanticBasisV2Schema,
  }),
);
export class RaceManualApprovalError extends Error {
  constructor(
    readonly code:
      | 'PARENT_UNAVAILABLE'
      | 'STALE_BASIS'
      | 'INVALID_CONTEXT'
      | 'APPLICATION_UNAVAILABLE'
      | 'UNRESOLVED_AFFECTED',
  ) {
    super(code);
  }
}
type Current = Extract<
  Awaited<ReturnType<typeof prepareRaceManualSemanticBasisV2In>>,
  { status: 'current_dependencies_captured' }
>;
async function call(tx: Transaction, expression: string, args: unknown[], budget: SourceBudget) {
  const remaining = 4194304n - budget.bytes;
  const row = z
    .strictObject({ bytes: z.string().regex(/^\d+$/), value: z.unknown() })
    .parse(
      (
        await tx.query(
          `WITH v AS MATERIALIZED (SELECT ${expression} AS value), n AS MATERIALIZED (SELECT value,octet_length(coalesce(value::text,'null'))::bigint AS bytes FROM v) SELECT bytes::text,CASE WHEN bytes <= $${args.length + 1}::bigint THEN value ELSE NULL END AS value FROM n`,
          [...args, remaining.toString()],
        )
      ).rows[0],
    );
  if (BigInt(row.bytes) > remaining) throw new RaceManualApprovalError('INVALID_CONTEXT');
  reserveSourceBudget(budget, BigInt(row.bytes), 0);
  assertRaceManualPlainV2(row.value);
  return row.value;
}
function contextOf(current: Current) {
  const retained = current.prepared.retained;
  if (
    retained.state !== 'present' ||
    retained.payload.preparation.candidate.status !== 'assembled_readonly'
  )
    throw new RaceManualApprovalError('INVALID_CONTEXT');
  return {
    retained,
    c: retained.payload.preparation.context,
    projection: retained.payload.preparation.candidate.body.projection,
  };
}
function parentRoots(
  current: Current,
  parent: NonNullable<Awaited<ReturnType<typeof readRaceManualReviewCompatibleChainIn>>>,
) {
  if (parent.payload?.state !== 'present') throw new RaceManualApprovalError('PARENT_UNAVAILABLE');
  const { c } = contextOf(current),
    before = parent.payload.payload.preparation.context;
  // Whole selection heads and exact mutable observations prevent historical
  // parent intent from silently binding to new current plans/actuals. This does
  // not reconstruct a semantic basis that SQL116 never stored.
  for (const key of [
    'event',
    'manualBasis',
    'restoreGeneration',
    'currentTraining',
    'rosters',
    'collectorSelection',
    'calendarIntent',
  ] as const)
    if (!same(c[key] ?? null, before[key] ?? null))
      throw new RaceManualApprovalError('STALE_BASIS');
  if (
    !same(
      current.basis.activities,
      before.sourcePermissionManifest.activityMediaPermissions.activities,
    )
  )
    throw new RaceManualApprovalError('STALE_BASIS');
  const old = parent.payload.payload.inventory.refs.map((r) => ({
    identity: r.identity,
    dtoDigest: r.dtoDigest,
  }));
  if (!same(current.basis.copiedSources, old)) throw new RaceManualApprovalError('STALE_BASIS');
}
function retainedSource(current: Current) {
  return contextOf(current).retained.payload.preparation.sourceInput.projectionInput;
}
function heads(current: Current) {
  const { c } = contextOf(current);
  const roster = <T extends { aggregateId: string }>(members: T[]) =>
    members.length
      ? {
          state: 'present' as const,
          members: [...members].sort((a, b) =>
            a.aggregateId < b.aggregateId ? -1 : a.aggregateId > b.aggregateId ? 1 : 0,
          ),
        }
      : { state: 'absent' as const };
  return raceManualApprovalExpectedHeadsSchema.parse({
    training: roster(
      c.currentTraining
        ? [
            {
              aggregateId: c.currentTraining.aggregateId,
              head: {
                kind: 'exists',
                versionId: c.currentTraining.snapshot.id,
                version: c.currentTraining.snapshot.version,
              },
            },
          ]
        : [],
    ),
    nutrition: roster(
      c.nutrition.map((r) => ({
        aggregateId: r.aggregateId,
        head: { kind: 'exists', versionId: r.record.versionId, version: r.record.version },
      })),
    ),
    recovery: roster(
      c.recovery.map((r) => ({
        aggregateId: r.aggregateId,
        head: { kind: 'exists', versionId: r.record.versionId, version: r.record.version },
      })),
    ),
    routine_schedule: roster(
      c.routines.map((r) => ({
        aggregateId: r.aggregateId,
        head: { kind: 'exists', versionId: r.record.versionId },
      })),
    ),
  });
}
function recipes(
  current: Current,
  candidateId: string,
  createId: () => string,
): RaceManualApprovalWrite[] {
  const { c, projection } = contextOf(current),
    writes: RaceManualApprovalWrite[] = [];
  if (projection.requiresResolution) throw new RaceManualApprovalError('UNRESOLVED_AFFECTED');
  const training = projection.calendar.plan;
  const trainingChanged =
    training !== null &&
    c.currentTraining !== null &&
    !same(training, c.currentTraining.snapshot.draft);
  if (trainingChanged && training && c.currentTraining)
    writes.push({
      domain: 'training',
      aggregateId: c.currentTraining.aggregateId,
      expectedHead: {
        kind: 'exists',
        versionId: c.currentTraining.snapshot.id,
        version: c.currentTraining.snapshot.version,
      },
      proposed: training,
    });
  const changedNutrition = new Set<string>();
  for (const n of projection.nutrition) {
    const affected = n.items.some((i) => i.state === 'affected');
    const linkedChanged =
      trainingChanged && n.record.linkedTrainingPlanVersionId === c.currentTraining?.snapshot.id;
    if (!affected && !linkedChanged) continue;
    if (
      n.items.some(
        (i) => i.state === 'affected' && (i.after.state === 'unresolved' || i.notice !== null),
      )
    )
      throw new RaceManualApprovalError('UNRESOLVED_AFFECTED');
    const currentRow = c.nutrition.find((r) => r.versionId === n.planVersionId);
    if (!currentRow) throw new RaceManualApprovalError('INVALID_CONTEXT');
    const raceIds = [
      ...new Set(
        n.items.flatMap((i) =>
          i.item.anchor.kind === 'relative' && i.item.anchor.entity === 'race'
            ? [i.item.anchor.entityId]
            : [],
        ),
      ),
    ].sort();
    const expectedRaceHeads = raceIds.map((eventId) => {
      if (eventId === c.event.id)
        return { namespace: 'race-event' as const, eventId, revision: c.event.revision };
      const nested = c.consumedSources.races.find((r) => r.id === eventId);
      if (!nested) throw new RaceManualApprovalError('INVALID_CONTEXT');
      return { namespace: 'race-event' as const, eventId, revision: nested.revision };
    });
    const intent = saveNutritionPlanV4IntentSchema.parse({
      schemaVersion: 4,
      intent: {
        schemaVersion: 3,
        command: {
          kind: 'update',
          planId: n.record.planId,
          expectedHeadVersionId: n.record.versionId,
          idempotencyKey: raceManualApprovalNutritionKey(candidateId, n.record.planId),
          confirmed: true,
          draft: {
            period: n.record.period,
            timezone: n.record.timezone,
            purpose: n.record.purpose,
            linkedTrainingPlanVersionId: n.record.linkedTrainingPlanVersionId,
            items: n.items.map(({ item }) => {
              const { planVersionId: _version, ...draft } = item;
              return draft;
            }),
          },
        },
        expectedRaceHeads,
        reconnectItemIds: [],
      },
    });
    writes.push({
      domain: 'nutrition',
      aggregateId: n.record.planId,
      expectedHead: { kind: 'exists', versionId: n.record.versionId, version: n.record.version },
      intent,
    });
    changedNutrition.add(n.record.planId);
  }
  for (const r of c.recovery) {
    const changed = r.record.draft.planRefs.some((ref) =>
      ref.kind === 'training'
        ? trainingChanged && ref.headVersionId === c.currentTraining?.snapshot.id
        : changedNutrition.has(ref.aggregateId),
    );
    if (!changed) continue;
    if (r.record.status !== 'user_confirmed' || r.record.selectedOptionId === null)
      throw new RaceManualApprovalError('UNRESOLVED_AFFECTED');
    writes.push({
      domain: 'recovery',
      aggregateId: r.aggregateId,
      expectedHead: { kind: 'exists', versionId: r.record.versionId, version: r.record.version },
      proposed: r.record.draft,
      selectedOptionId: r.record.selectedOptionId,
    });
  }
  for (const r of projection.routines) {
    if (r.state !== 'affected') continue;
    if (r.notice !== null || r.projection.expansion.state !== 'expanded')
      throw new RaceManualApprovalError('UNRESOLVED_AFFECTED');
    const source = c.routineActualManifest.schedules.find(
      (s) => s.versionId === r.scheduleVersionId,
    );
    if (!source || !c.routines.some((s) => s.versionId === r.scheduleVersionId))
      throw new RaceManualApprovalError('INVALID_CONTEXT');
    const proposed = routineScheduleVersionSchema.parse({
      ...r.projection.proposed,
      versionId: uuid.parse(createId()),
    });
    const resolution = retainedSource(current).resolutions.routines.find(
      (row) => row.scheduleVersionId === r.scheduleVersionId,
    );
    const sourceId = resolution ? resolution.sourcePlanVersionId : source.sourcePlanVersionId;
    const sourceDraft =
      sourceId === c.currentTraining?.snapshot.id
        ? training
        : (c.consumedSources.plans.find((plan) => plan.id === sourceId)?.draft ?? null);
    const expanded = expandRoutineSchedule(proposed, sourceDraft);
    // Started anchors belong to the schedule aggregate across immutable versions.
    // The complete manifest retains historical occurrences and their actual runs.
    const started = new Set(
      c.routineActualManifest.runs.flatMap((row) => {
        const run = routineRunSchema.parse(row.record);
        return run.origin.kind === 'planned' ? [run.origin.occurrenceId] : [];
      }),
    );
    const startedKeys = new Set(
      c.routineActualManifest.occurrences.flatMap((row) => {
        const occurrence = routineOccurrenceSchema.parse(row.record);
        return occurrence.schedule.id === r.record.id && started.has(occurrence.id)
          ? [occurrence.anchorKey]
          : [];
      }),
    );
    const occurrences = expanded.filter((o) => !startedKeys.has(o.anchorKey));
    if (occurrences.some((o) => o.timingStatus !== 'resolved'))
      throw new RaceManualApprovalError('UNRESOLVED_AFFECTED');
    writes.push({
      domain: 'routine_schedule',
      aggregateId: r.record.id,
      expectedHead: { kind: 'exists', versionId: r.record.versionId },
      proposed,
      sourcePlanVersionId: sourceId,
      occurrences,
    });
  }
  return writes.sort((a, b) =>
    a.domain < b.domain
      ? -1
      : a.domain > b.domain
        ? 1
        : a.aggregateId < b.aggregateId
          ? -1
          : a.aggregateId > b.aggregateId
            ? 1
            : 0,
  );
}
/** Real persisted parent + fresh same-transaction full-owned/purpose capture.
 * The readonly parent's missing5/applyfalse remain untouched. The new SQL118
 * boundary binds actual sources and a new basis, never a caller Boolean seal. */
export async function prepareRaceManualApprovalIn(
  tx: Transaction,
  unknownInput: unknown,
  budget: SourceBudget = { bytes: 0n, sources: 0 },
  options: { now?: () => Date; createId?: () => string } = {},
) {
  const input = raceManualApprovalPrepareSchema.parse(unknownInput);
  const parent = await readRaceManualReviewCompatibleChainIn(tx, input.chain.evidenceId, budget);
  if (
    !parent ||
    parent.payload === null ||
    parent.result.decisionId !== input.chain.decisionId ||
    parent.result.proposalId !== input.chain.proposalId ||
    parent.result.candidateDigest !== input.chain.readonlyCandidateDigest
  )
    throw new RaceManualApprovalError('PARENT_UNAVAILABLE');
  const current = await prepareRaceManualSemanticBasisV2In(
    tx,
    input.intent,
    input.expectedBasis,
    budget,
  );
  if (current.status !== 'current_dependencies_captured')
    return { status: 'blocked' as const, reason: 'current_basis_unavailable' as const };
  parentRoots(current, parent);
  const { retained } = contextOf(current);
  if (current.prepared.consumedScope?.status !== 'validated_read_scope')
    return { status: 'blocked' as const, reason: 'incomplete_affected_scope' as const };
  const lifecycle = await captureRaceManualReviewCompatibleLifecycleInventoryIn(
    tx,
    retained,
    budget,
  );
  if (lifecycle.status !== 'dependency_correspondence')
    return { status: 'blocked' as const, reason: 'source_lifecycle_unavailable' as const };
  return prepareApplicationFromCurrent(tx, input, current, lifecycle, budget, options);
}
type ApplicationCurrent = Extract<
  Awaited<ReturnType<typeof prepareRaceManualSemanticBasisV2In>>,
  { status: 'current_dependencies_captured' }
>;
type ApplicationLifecycle = Awaited<
  ReturnType<typeof captureRaceManualReviewCompatibleLifecycleInventoryIn>
>;
async function prepareApplicationFromCurrent(
  tx: Transaction,
  input: z.infer<typeof raceManualApprovalPrepareSchema>,
  current: ApplicationCurrent,
  lifecycle: ApplicationLifecycle,
  budget: SourceBudget,
  options: { now?: () => Date; createId?: () => string },
) {
  const { c, retained, projection } = contextOf(current);
  if (current.prepared.consumedScope?.status !== 'validated_read_scope')
    return { status: 'blocked' as const, reason: 'incomplete_affected_scope' as const };
  const candidateId = uuid.parse((options.createId ?? randomUUID)());
  let writes: RaceManualApprovalWrite[];
  try {
    writes = recipes(current, candidateId, options.createId ?? randomUUID);
  } catch (error) {
    if (error instanceof RaceManualApprovalError && error.code === 'UNRESOLVED_AFFECTED')
      return { status: 'blocked' as const, reason: 'affected_timing_unresolved' as const };
    throw error;
  }
  const notices = projection.nutrition.flatMap((n) =>
    n.items.flatMap((i) =>
      i.state === 'unchanged' && i.before.state === 'unresolved'
        ? [
            {
              domain: 'nutrition' as const,
              aggregateId: n.record.planId,
              itemId: i.itemId,
              code:
                i.item.anchor.kind === 'disconnected'
                  ? ('DISCONNECTED_RETAINED' as const)
                  : ('UNCHANGED_UNRESOLVED' as const),
            },
          ]
        : [],
    ),
  );
  const unsigned = {
    schemaVersion: 1 as const,
    candidateId,
    chain: input.chain,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    raceChange: {
      eventId: c.event.id,
      expectedRevision: c.event.revision,
      newLocalDate: input.intent.newLocalDate,
    },
    expectation: {
      restoreGeneration: c.restoreGeneration,
      appRevision:
        current.basis.manualBasis.app.state === 'present'
          ? current.basis.manualBasis.app.revision
          : 0,
      manualPolicy: c.manualBasis.policy,
      semanticDigest: current.semanticDigest,
      heads: heads(current),
    },
    authority: 'server_revalidation_required' as const,
    applicationState: 'ready_for_explicit_approval' as const,
    scope: 'whole_affected' as const,
    affected: writes.map((w) => ({ domain: w.domain, aggregateId: w.aggregateId })),
    writes,
    notices,
  };
  const candidate = raceManualApprovalCandidateSchema.parse({
    ...unsigned,
    applicationDigest: impactDependencyDigest(unsigned),
  });
  const stored = raceManualApprovalCandidateSchema.parse(
    await call(
      tx,
      'public.prepare_race_manual_application_v1($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb)',
      [
        JSON.stringify(candidate),
        JSON.stringify(current.basis),
        JSON.stringify(retained),
        JSON.stringify(lifecycle),
      ],
      budget,
    ),
  );
  if (!same(stored, candidate)) throw new RaceManualApprovalError('INVALID_CONTEXT');
  return { status: 'prepared' as const, candidate: stored };
}

/** Same-tx stored-parent ACK is required before using the first actual capture.
 * SQL118 still revalidates persisted parents, actual sources, purpose and recipes. */
export async function prepareRaceManualSameTxApprovalIn(
  tx: Transaction,
  unknownInput: unknown,
  handle: unknown,
  budget: SourceBudget,
  options: { now?: () => Date; createId?: () => string } = {},
) {
  const input = raceManualApprovalPrepareSchema.parse(unknownInput);
  return prepareRaceManualSameTxReviewApplicationIn(
    tx,
    handle,
    input.intent,
    input.expectedBasis,
    input.chain,
    budget,
    (current, lifecycle) =>
      prepareApplicationFromCurrent(tx, input, current, lifecycle, budget, options),
  );
}
/** Outer successful receipt precedes all new processing checks. The persisted
 * candidate is locked/applied once by SQL118, even under a different outer key. */
export async function approveRaceManualApplicationIn(
  tx: Transaction,
  unknownCommand: unknown,
  budget: SourceBudget = { bytes: 0n, sources: 0 },
  options: { now?: () => Date; createId?: () => string } = {},
) {
  const command = raceManualApprovalCommandSchema.parse(unknownCommand);
  const replay = await call(
    tx,
    'public.read_race_manual_application_receipt_v1($1::text,$2::jsonb)',
    [command.idempotencyKey, JSON.stringify(command)],
    budget,
  );
  if (replay !== null) return raceManualApprovalResultSchema.parse(replay);
  const stored = z
    .strictObject({
      candidate: raceManualApprovalCandidateSchema,
      basis: raceManualSemanticBasisV2Schema,
    })
    .parse(
      await call(
        tx,
        'public.read_race_manual_application_v1($1::uuid)',
        [command.candidateId],
        budget,
      ),
    );
  return applyStoredRaceManualApplicationIn(tx, command, stored, budget, options);
}
/** Internal entry consumes only the actual protected-reader factory handle.
 * The original receipt is checked before consuming fresh approval state. */
export async function approveRaceManualApplicationFromStoredCaptureIn(
  tx: Transaction,
  unknownCommand: unknown,
  continuation: RaceManualSameTxApprovalContinuation,
  handle: unknown,
  budget: SourceBudget,
  options: { now?: () => Date; createId?: () => string } = {},
) {
  assertRaceManualSameTxApprovalContinuation(continuation);
  try {
    const command = raceManualApprovalCommandSchema.parse(unknownCommand);
    const replay = await call(
      tx,
      'public.read_race_manual_application_receipt_v1($1::text,$2::jsonb)',
      [command.idempotencyKey, JSON.stringify(command)],
      budget,
    );
    if (replay !== null) return raceManualApprovalResultSchema.parse(replay);
    return await continuation.consume(tx, handle, command, budget, (stored) =>
      applyStoredRaceManualApplicationIn(tx, command, stored, budget, options),
    );
  } finally {
    continuation.invalidate(handle);
  }
}
async function applyStoredRaceManualApplicationIn(
  tx: Transaction,
  command: z.infer<typeof raceManualApprovalCommandSchema>,
  stored: {
    candidate: z.infer<typeof raceManualApprovalCandidateSchema>;
    basis: z.infer<typeof raceManualSemanticBasisV2Schema>;
  },
  budget: SourceBudget,
  options: { now?: () => Date; createId?: () => string },
) {
  const candidate = stored.candidate;
  if (
    candidate.applicationState !== 'ready_for_explicit_approval' ||
    candidate.applicationDigest !== command.applicationDigest ||
    !same(candidate.chain, command.chain) ||
    !same(candidate.raceChange, command.raceChange) ||
    !same(candidate.expectation, command.expectation)
  )
    throw new RaceManualApprovalError('APPLICATION_UNAVAILABLE');
  const parent = await readRaceManualReviewCompatibleChainIn(
    tx,
    candidate.chain.evidenceId,
    budget,
  );
  if (!parent || parent.payload === null) throw new RaceManualApprovalError('PARENT_UNAVAILABLE');
  const current = await prepareRaceManualSemanticBasisV2In(
    tx,
    stored.basis.intent,
    stored.basis,
    budget,
  );
  if (current.status !== 'current_dependencies_captured')
    throw new RaceManualApprovalError('STALE_BASIS');
  parentRoots(current, parent);
  const { retained, c } = contextOf(current);
  const ids = candidate.writes.flatMap((w) =>
    w.domain === 'routine_schedule' ? [w.proposed.versionId] : [],
  );
  let cursor = 0;
  const freshWrites = recipes(current, candidate.candidateId, () => {
    const id = ids[cursor++];
    if (id === undefined) throw new RaceManualApprovalError('INVALID_CONTEXT');
    return id;
  });
  if (
    !same(freshWrites, candidate.writes) ||
    !same(heads(current), candidate.expectation.heads) ||
    current.semanticDigest !== candidate.expectation.semanticDigest ||
    current.prepared.consumedScope?.status !== 'validated_read_scope'
  )
    throw new RaceManualApprovalError('STALE_BASIS');
  const lifecycle = await captureRaceManualReviewCompatibleLifecycleInventoryIn(
    tx,
    retained,
    budget,
  );
  if (lifecycle.status !== 'dependency_correspondence')
    throw new RaceManualApprovalError('INVALID_CONTEXT');
  const contextId = uuid.parse(
    await call(
      tx,
      'public.begin_race_manual_application_v1($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb)',
      [
        JSON.stringify(command),
        JSON.stringify(current.basis),
        JSON.stringify(retained),
        JSON.stringify(lifecycle),
      ],
      budget,
    ),
  );
  const approvedAt = (options.now ?? (() => new Date()))().toISOString();
  const approvalId = uuid.parse((options.createId ?? randomUUID)());
  const applied: Extract<
    z.infer<typeof raceManualApprovalResultSchema>,
    { status: 'committed' }
  >['versions'] = [];
  const replacements = new Map<string, string>();

  for (const write of candidate.writes) {
    if (write.domain !== 'training') continue;
    const changedSessions = new Set(
      contextOf(current)
        .projection.calendar.sessionDiffs.filter((s) => s.beforeDate !== s.afterDate)
        .map((s) => s.id),
    );
    const reviewed = c.nutrition
      .filter((n) =>
        n.record.items.some(
          (item) =>
            item.anchor.kind === 'relative' &&
            item.anchor.entity === 'session' &&
            changedSessions.has(item.anchor.entityId),
        ),
      )
      .map((n) => n.aggregateId);
    const saved = await persistPlanVersion(tx, {
      aggregateId: write.aggregateId,
      expectedVersionId: write.expectedHead.kind === 'exists' ? write.expectedHead.versionId : null,
      draft: write.proposed,
      reviewedRelativeNutritionPlanIds: reviewed,
    });
    if (write.expectedHead.kind === 'exists')
      replacements.set(write.expectedHead.versionId, saved.id);
    replacements.set(write.aggregateId, saved.id);
    applied.push({
      domain: 'training',
      aggregateId: write.aggregateId,
      versionId: saved.id,
      version: saved.version,
    });
    await tx.query(
      "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'candidate_approved')",
      [tx.athleteId, saved.id],
    );
  }
  const race = z
    .strictObject({ eventId: uuid, revision: z.number().int().positive() })
    .parse(await call(tx, 'public.apply_race_manual_event_v1($1::uuid)', [contextId], budget));
  for (const write of candidate.writes) {
    if (write.domain !== 'nutrition') continue;
    const original = write.intent.intent;
    const linked = original.command.draft.linkedTrainingPlanVersionId;
    const intent = saveNutritionPlanV4IntentSchema.parse({
      schemaVersion: 4,
      intent: {
        ...original,
        command: {
          ...original.command,
          draft: {
            ...original.command.draft,
            linkedTrainingPlanVersionId:
              linked === null ? null : (replacements.get(linked) ?? linked),
          },
        },
        expectedRaceHeads: original.expectedRaceHeads.map((head) =>
          head.eventId === race.eventId ? { ...head, revision: race.revision } : head,
        ),
      },
    });
    const saved = await saveNutritionPlanV4ForRaceApprovalIn(tx, intent, contextId, {
      now: () => new Date(approvedAt),
      ...(options.createId ? { id: options.createId } : {}),
    });
    replacements.set(write.expectedHead.versionId, saved.plan.versionId);
    replacements.set(write.aggregateId, saved.plan.versionId);
    applied.push({
      domain: 'nutrition',
      aggregateId: write.aggregateId,
      versionId: saved.plan.versionId,
      version: saved.plan.version,
    });
  }
  const occurrenceIds: string[] = [];
  for (const write of candidate.writes) {
    if (write.domain === 'recovery') {
      const draft = {
        ...write.proposed,
        planRefs: write.proposed.planRefs.map((ref) => ({
          ...ref,
          headVersionId: replacements.get(ref.headVersionId) ?? ref.headVersionId,
        })),
      };
      const saved = await persistRecoveryStrategyVersionIn(tx, {
        aggregateId: write.aggregateId,
        expectedVersionId:
          write.expectedHead.kind === 'exists' ? write.expectedHead.versionId : null,
        draft,
        selectedOptionId: write.selectedOptionId,
        approvedAt,
        ...(options.createId ? { createId: options.createId } : {}),
      });
      applied.push({
        domain: 'recovery',
        aggregateId: write.aggregateId,
        versionId: saved.versionId,
        version: saved.version,
      });
    }
    if (write.domain === 'routine_schedule') {
      const source = write.sourcePlanVersionId;
      const saved = await persistRoutineScheduleVersionIn(tx, {
        aggregateId: write.aggregateId,
        expectedVersionId:
          write.expectedHead.kind === 'exists' ? write.expectedHead.versionId : null,
        schedule: write.proposed,
        sourcePlanVersionId: source === null ? null : (replacements.get(source) ?? source),
        occurrences: write.occurrences,
        approvedAt,
      });
      occurrenceIds.push(...saved.occurrenceIds);
      applied.push({
        domain: 'routine_schedule',
        aggregateId: write.aggregateId,
        versionId: saved.versionId,
      });
    }
  }
  const result = raceManualApprovalResultSchema.parse({
    schemaVersion: 1,
    status: 'committed',
    candidateId: candidate.candidateId,
    approvalId,
    proposalId: candidate.chain.proposalId,
    approvedAt,
    race,
    versions: applied,
    occurrenceIds,
    notices: candidate.notices,
  });
  await enqueue(tx, {
    id: (options.createId ?? randomUUID)(),
    idempotencyKey: `race-manual-approval:${candidate.candidateId}`,
    topic: 'race.manual_plan_approved',
    payload: result,
  });
  const committed = raceManualApprovalResultSchema.parse(
    await call(
      tx,
      'public.commit_race_manual_application_v1($1::uuid,$2::jsonb)',
      [contextId, JSON.stringify(result)],
      budget,
    ),
  );
  if (!same(committed, result)) throw new RaceManualApprovalError('INVALID_CONTEXT');
  return committed;
}
export function createRaceManualApprovalRepository(
  database: Database,
  options: { now?: () => Date; createId?: () => string } = {},
) {
  const snapshot = () => {
    if (!database.snapshotTenant) throw new RaceManualApprovalError('INVALID_CONTEXT');
    return database.snapshotTenant.bind(database);
  };
  return {
    prepare(athleteId: string, input: unknown) {
      const parsed = raceManualApprovalPrepareSchema.parse(input);
      return snapshot()(athleteId, (tx) =>
        prepareRaceManualApprovalIn(tx, parsed, { bytes: 0n, sources: 0 }, options),
      );
    },
    approve(athleteId: string, input: unknown) {
      const parsed = raceManualApprovalCommandSchema.parse(input);
      return snapshot()(athleteId, (tx) =>
        approveRaceManualApplicationIn(tx, parsed, { bytes: 0n, sources: 0 }, options),
      );
    },
  };
}
