import { z } from 'zod';
import { idSchema, instantSchema } from './primitives.js';
import { validateNutritionPlanItem } from './nutrition-core.js';
import { raceManualProjectionIntentSchema } from './race-manual-public.js';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
} from './routines.js';
import {
  raceManualPublicTrainingMemberSchema,
  raceManualPublicNutritionPlanSchema,
  raceManualPublicNutritionItemSchema,
  raceManualPublicTrainingLinkSchema,
  raceManualPublicRecoveryMemberSchema,
  raceManualPublicRoutineExpansionSchema,
  raceManualPublicStartedRunSchema,
  raceManualPublicRaceChangeSchema,
  raceManualPublicOperationalTimingSchema,
} from './race-manual-public-preview.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const version = z.number().int().min(1).max(2147483647);
const domain = z.enum(['training', 'nutrition', 'recovery', 'routine_schedule']);
const target = z.strictObject({ domain, aggregateId: uuid });
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v: unknown, i) => same(v, b[i]))
    );
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = Object.entries(a),
    right = new Map(Object.entries(b));
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && same(value, right.get(key)))
  );
}
function unique(values: readonly string[], c: z.RefinementCtx) {
  if (new Set(values).size !== values.length)
    c.addIssue({ code: 'custom', message: 'Duplicate exact tuple' });
}
function section<T extends z.ZodType>(schema: T) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({ state: z.literal('present'), members: z.array(schema).min(1).max(1000) }),
  ]);
}
// Diagnostic goals retain numerical definitions and reported basis, without
// copying private evidence identifiers or pretending empty provenance.
const sourceTargets = raceManualPublicNutritionItemSchema.shape.targets.element.options;
function goalAmount<T extends z.ZodType>(unit: T) {
  const { min, max, basis } = sourceTargets[0].shape.amount.shape;
  return z.strictObject({ min, max, unit, basis }).refine((value) => value.min <= value.max, {
    message: 'Target min must not exceed max',
    path: ['max'],
  });
}
const diagnosticTarget = z.discriminatedUnion('metric', [
  z.strictObject({
    metric: z.literal('energy'),
    amount: goalAmount(sourceTargets[0].shape.amount.shape.unit),
  }),
  z.strictObject({
    metric: z.literal('carbohydrate'),
    amount: goalAmount(sourceTargets[1].shape.amount.shape.unit),
  }),
  z.strictObject({
    metric: z.literal('protein'),
    amount: goalAmount(sourceTargets[2].shape.amount.shape.unit),
  }),
  z.strictObject({
    metric: z.literal('fat'),
    amount: goalAmount(sourceTargets[3].shape.amount.shape.unit),
  }),
  z.strictObject({
    metric: z.literal('fluid'),
    amount: goalAmount(sourceTargets[4].shape.amount.shape.unit),
  }),
  z.strictObject({
    metric: z.literal('sodium'),
    amount: goalAmount(sourceTargets[5].shape.amount.shape.unit),
  }),
]);
export const raceManualPublicImpactNutritionItemSchema = z
  .strictObject({
    ...raceManualPublicNutritionItemSchema.shape,
    targets: z.array(diagnosticTarget).max(6),
  })
  .superRefine(validateNutritionPlanItem);
const nutritionPlan = z
  .strictObject({
    ...raceManualPublicNutritionPlanSchema.shape,
    items: z.array(raceManualPublicImpactNutritionItemSchema).max(5000),
  })
  .superRefine((p, c) =>
    unique(
      p.items.map((i) => i.id),
      c,
    ),
  );
const ref = z.strictObject({ versionId: uuid, version });
const timing = z.strictObject({
  itemId: raceManualPublicNutritionItemSchema.shape.id,
  state: z.enum(['affected', 'unchanged']),
  before: raceManualPublicOperationalTimingSchema,
  after: raceManualPublicOperationalTimingSchema,
  resolution: z.enum(['absent', 'explicit_replacement']),
  requirement: z.enum(['none', 'resolve_before_review']),
});
const nutrition = z
  .strictObject({
    aggregateId: uuid,
    before: z.strictObject({
      ref,
      plan: nutritionPlan,
      linkedTraining: raceManualPublicTrainingLinkSchema,
    }),
    after: z.strictObject({
      plan: nutritionPlan,
      linkedTraining: raceManualPublicTrainingLinkSchema,
    }),
    timings: z.array(timing).max(5000),
  })
  .superRefine((m, c) => {
    const old = new Map(m.before.plan.items.map((i) => [i.id, i])),
      next = new Map(m.after.plan.items.map((i) => [i.id, i]));
    unique(
      m.timings.map((i) => i.itemId),
      c,
    );
    if (old.size !== next.size || old.size !== m.timings.length)
      c.addIssue({ code: 'custom', message: 'Exact item roster required' });
    if (m.before.linkedTraining.kind === 'follows_training_approval')
      c.addIssue({ code: 'custom', message: 'Before requires frozen link' });
    for (const t of m.timings) {
      const a = old.get(t.itemId),
        b = next.get(t.itemId);
      if (!a || !b) {
        c.addIssue({ code: 'custom', message: 'Missing exact item' });
        continue;
      }
      const { anchor: aa, ...ap } = a,
        { anchor: ba, ...bp } = b;
      if (!same(ap, bp))
        c.addIssue({ code: 'custom', message: 'Food, quantity and goals must remain unchanged' });
      if (
        t.state === 'unchanged' &&
        (!same(a, b) || !same(t.before, t.after) || t.resolution !== 'absent')
      )
        c.addIssue({ code: 'custom', message: 'Unchanged item must be preserved' });
      if (
        aa.kind === 'disconnected' &&
        (ba.kind !== 'disconnected' ||
          t.state !== 'unchanged' ||
          t.before.state !== 'suspended' ||
          t.after.state !== 'suspended')
      )
        c.addIssue({ code: 'custom', message: 'No implicit reconnect' });
      if (
        (aa.kind !== 'disconnected' && t.before.state === 'suspended') ||
        (ba.kind !== 'disconnected' && t.after.state === 'suspended')
      )
        c.addIssue({ code: 'custom', message: 'Suspension requires disconnected anchor' });
      const required =
        t.state === 'affected' &&
        (t.after.state !== 'resolved' ||
          (t.before.state === 'unresolved' && t.resolution === 'absent'));
      if ((t.requirement === 'resolve_before_review') !== required)
        c.addIssue({ code: 'custom', message: 'Exact timing requirement required' });
    }
  });
const storedOccurrence = z
  .strictObject({
    occurrenceId: idSchema,
    schedule: routineOccurrenceSchema.shape.schedule,
    blueprint: routineOccurrenceSchema.shape.blueprint,
    sourcePlanVersionId: uuid.nullable(),
    anchorKey: routineOccurrenceSchema.shape.anchorKey,
    scheduledAt: instantSchema.nullable(),
    timingStatus: z.enum(['resolved', 'unresolved']),
    // The physical occurrence does not store a reason; expansion reasons must
    // not be invented as if they were frozen source facts.
    unresolvedReason: z.null(),
  })
  .superRefine((o, c) => {
    if ((o.timingStatus === 'resolved') !== (o.scheduledAt !== null))
      c.addIssue({ code: 'custom', message: 'Exact stored planned timing required' });
  });
const routine = z
  .strictObject({
    aggregateId: uuid,
    state: z.enum(['affected', 'unchanged', 'retained_ended']),
    blueprint: routineBlueprintVersionSchema,
    before: z.strictObject({
      schedule: routineScheduleVersionSchema,
      sourcePlanVersionId: uuid.nullable(),
      expansion: raceManualPublicRoutineExpansionSchema,
    }),
    after: z.strictObject({
      schedule: routineScheduleVersionSchema,
      sourcePlanVersionId: uuid.nullable(),
      expansion: raceManualPublicRoutineExpansionSchema,
    }),
    retainedStarted: z.array(raceManualPublicStartedRunSchema).max(1000),
    storedOccurrences: z.array(storedOccurrence).max(1000),
    resolution: z.enum(['absent', 'explicit_replacement']),
    requirement: z.enum(['none', 'resolve_before_review', 'retained_ended_unresolved']),
  })
  .superRefine((m, c) => {
    for (const side of [m.before, m.after]) {
      if (
        side.schedule.id !== m.aggregateId ||
        side.schedule.blueprint.id !== m.blueprint.routineId ||
        side.schedule.blueprint.versionId !== m.blueprint.versionId
      )
        c.addIssue({ code: 'custom', message: 'Exact routine/blueprint tuple required' });
      if (side.expansion.state === 'expanded') {
        unique(
          side.expansion.occurrences.map((o) => o.id),
          c,
        );
        unique(
          side.expansion.occurrences.map((o) => o.anchorKey),
          c,
        );
        for (const o of side.expansion.occurrences)
          if (
            o.schedule.id !== m.aggregateId ||
            o.schedule.versionId !== side.schedule.versionId ||
            o.blueprint.id !== m.blueprint.routineId ||
            o.blueprint.versionId !== m.blueprint.versionId
          )
            c.addIssue({ code: 'custom', message: 'Exact occurrence tuple required' });
      }
    }
    const unresolved = (side: typeof m.before) =>
      side.expansion.state === 'unresolved' ||
      side.expansion.occurrences.some((o) => o.timingStatus === 'unresolved');
    if (m.state !== 'affected' && (!same(m.before, m.after) || m.resolution !== 'absent'))
      c.addIssue({ code: 'custom', message: 'Frozen routine must remain unchanged' });
    if ((m.state === 'retained_ended') !== (m.before.schedule.state === 'ended'))
      c.addIssue({ code: 'custom', message: 'Ended classification required' });
    const required =
      m.state === 'affected' &&
      (unresolved(m.after) ||
        m.storedOccurrences.some(
          (o) =>
            o.timingStatus === 'unresolved' &&
            m.retainedStarted.some((r) => r.occurrenceId === o.occurrenceId),
        ) ||
        (m.resolution === 'absent' &&
          m.storedOccurrences.some(
            (o) =>
              o.schedule.versionId === m.before.schedule.versionId &&
              o.timingStatus === 'unresolved',
          )));
    const expected =
      m.state === 'retained_ended' &&
      m.storedOccurrences.some(
        (o) =>
          o.schedule.versionId === m.before.schedule.versionId && o.timingStatus === 'unresolved',
      )
        ? 'retained_ended_unresolved'
        : required
          ? 'resolve_before_review'
          : 'none';
    if (m.requirement !== expected)
      c.addIssue({ code: 'custom', message: 'Exact routine requirement required' });
    unique(
      m.storedOccurrences.map((o) => o.occurrenceId),
      c,
    );
    for (const o of m.storedOccurrences) {
      if (o.schedule.id !== m.aggregateId)
        c.addIssue({ code: 'custom', message: 'Stored occurrence aggregate mismatch' });
      const retained = m.retainedStarted.find((r) => r.occurrenceId === o.occurrenceId);
      if (o.schedule.versionId !== m.before.schedule.versionId && !retained)
        c.addIssue({
          code: 'custom',
          message: 'Historical occurrence requires exact retained run',
        });
      if (
        o.schedule.versionId === m.before.schedule.versionId &&
        (o.blueprint.id !== m.blueprint.routineId ||
          o.blueprint.versionId !== m.blueprint.versionId ||
          o.sourcePlanVersionId !== m.before.sourcePlanVersionId)
      )
        c.addIssue({ code: 'custom', message: 'Exact current frozen source required' });
      if (
        retained &&
        (retained.scheduleVersionId !== o.schedule.versionId ||
          retained.blueprintVersionId !== o.blueprint.versionId ||
          retained.anchorKey !== o.anchorKey)
      )
        c.addIssue({ code: 'custom', message: 'Exact retained occurrence tuple required' });
    }
    for (const r of m.retainedStarted)
      if (!m.storedOccurrences.some((o) => o.occurrenceId === r.occurrenceId))
        c.addIssue({ code: 'custom', message: 'Retained occurrence source required' });
    unique(
      m.retainedStarted.map((r) => r.runId),
      c,
    );
    unique(
      m.retainedStarted.map((r) => r.anchorKey),
      c,
    );
    if (
      m.state === 'affected' &&
      m.after.expansion.state === 'expanded' &&
      m.after.expansion.occurrences.some((o) =>
        m.retainedStarted.some((r) => r.anchorKey === o.anchorKey),
      )
    )
      c.addIssue({ code: 'custom', message: 'Started anchors cannot be replanned' });
  });
const recovery = z
  .strictObject({
    aggregateId: uuid,
    state: z.enum(['affected', 'unchanged']),
    before: raceManualPublicRecoveryMemberSchema.shape.before,
    after: raceManualPublicRecoveryMemberSchema.shape.after.omit({ kind: true }),
    requirement: z.enum(['none', 'resolve_before_review']),
  })
  .superRefine((m, c) => {
    for (const side of [m.before, m.after]) {
      if (
        (side.status === 'user_confirmed' && side.selectedOptionId === null) ||
        (side.selectedOptionId !== null &&
          !side.plan.options.some((o) => o.id === side.selectedOptionId))
      )
        c.addIssue({ code: 'custom', message: 'Actual recovery selection required' });
      unique(
        side.planLinks.map((r) => JSON.stringify([r.domain, r.aggregateId])),
        c,
      );
    }
    if (m.before.planLinks.some((r) => r.version.kind !== 'retained'))
      c.addIssue({ code: 'custom', message: 'Frozen recovery version required' });
    if (
      !same(m.before.plan, m.after.plan) ||
      m.before.status !== m.after.status ||
      m.before.selectedOptionId !== m.after.selectedOptionId
    )
      c.addIssue({
        code: 'custom',
        message: 'Recovery planned content and reported selection must be preserved',
      });
    if (m.state === 'unchanged' && !same(m.before.planLinks, m.after.planLinks))
      c.addIssue({ code: 'custom', message: 'Unchanged recovery links required' });
    const required =
      m.state === 'affected' &&
      (m.before.status !== 'user_confirmed' || m.before.selectedOptionId === null);
    if ((m.requirement === 'resolve_before_review') !== required)
      c.addIssue({ code: 'custom', message: 'Exact recovery confirmation requirement required' });
  });
const requirement = z.discriminatedUnion('domain', [
  z.strictObject({
    domain: z.literal('nutrition'),
    aggregateId: uuid,
    planVersionId: uuid,
    itemId: raceManualPublicNutritionItemSchema.shape.id,
    reason: z.literal('affected_timing_unresolved'),
    editor: z.literal('replace_anchor'),
  }),
  z.strictObject({
    domain: z.literal('recovery'),
    aggregateId: uuid,
    strategyVersionId: uuid,
    reason: z.literal('recovery_confirmation_required'),
    editor: z.literal('confirm_recovery_and_review'),
  }),
  z.strictObject({
    domain: z.literal('routine_schedule'),
    aggregateId: uuid,
    scheduleVersionId: idSchema,
    reason: z.enum(['affected_timing_unresolved', 'retained_ended_unresolved']),
    editor: z.enum(['replace_rule', 'unavailable_frozen_ended']),
  }),
]);
const notice = z.strictObject({
  domain,
  aggregateId: uuid,
  itemId: raceManualPublicNutritionItemSchema.shape.id.nullable(),
  code: z.enum([
    'UNCHANGED_UNRESOLVED',
    'DISCONNECTED_RETAINED',
    'STARTED_RUN_PRESERVED',
    'ENDED_SCHEDULE_RETAINED',
  ]),
});
const fixed = {
  schemaVersion: z.literal(1),
  approvalAllowed: z.literal(false),
  persistence: z.literal('not_stored'),
  freshness: z.literal('not_checked'),
};
const projected = z
  .strictObject({
    ...fixed,
    status: z.literal('projected'),
    expectedEvent: z.strictObject({ id: uuid, revision: version }),
    intent: raceManualProjectionIntentSchema,
    beforeBasis: z.literal('captured_snapshot'),
    afterBasis: z.literal('hypothetical'),
    race: raceManualPublicRaceChangeSchema,
    training: section(raceManualPublicTrainingMemberSchema),
    nutrition: section(nutrition),
    recovery: section(recovery),
    routines: section(routine),
    retainedUnplanned: z
      .array(
        z.strictObject({
          runId: idSchema,
          blueprintVersionId: idSchema,
          preservation: z.literal('unplanned_run_unchanged'),
        }),
      )
      .max(1000),
    affected: z.array(target).max(1000),
    resolutionRequirements: z.array(requirement).max(1000),
    notices: z.array(notice).max(5000),
  })
  .superRefine((p, c) => {
    if (
      p.expectedEvent.id !== p.intent.expectedEvent.id.toLowerCase() ||
      p.expectedEvent.revision !== p.intent.expectedEvent.revision ||
      p.race.eventId !== p.expectedEvent.id ||
      p.race.expectedRevision !== p.expectedEvent.revision ||
      p.race.after.localDate !== p.intent.newLocalDate
    )
      c.addIssue({ code: 'custom', message: 'Exact event and original intent required' });
    const expectedAffected: z.infer<typeof target>[] = [],
      expectedRequirements: z.infer<typeof requirement>[] = [],
      expectedNotices: z.infer<typeof notice>[] = [];
    const rosters = {
      training: p.training,
      nutrition: p.nutrition,
      recovery: p.recovery,
      routine_schedule: p.routines,
    };
    let count = 0;
    for (const d of ['training', 'nutrition', 'recovery', 'routine_schedule'] as const) {
      const roster = rosters[d];
      if (roster.state === 'absent') continue;
      count += roster.members.length;
      unique(
        roster.members.map((m) => m.aggregateId),
        c,
      );
    }
    if (count > 1000) c.addIssue({ code: 'custom', message: 'Whole aggregate limit' });
    for (const m of p.training.state === 'present' ? p.training.members : [])
      if (m.after.kind === 'new_version_on_approval')
        expectedAffected.push({ domain: 'training', aggregateId: m.aggregateId });
    for (const m of p.recovery.state === 'present' ? p.recovery.members : [])
      if (m.state === 'affected') {
        expectedAffected.push({ domain: 'recovery', aggregateId: m.aggregateId });
        if (m.requirement === 'resolve_before_review')
          expectedRequirements.push({
            domain: 'recovery',
            aggregateId: m.aggregateId,
            strategyVersionId: m.before.ref.versionId,
            reason: 'recovery_confirmation_required',
            editor: 'confirm_recovery_and_review',
          });
      }
    for (const m of p.nutrition.state === 'present' ? p.nutrition.members : []) {
      if (m.timings.some((t) => t.state === 'affected'))
        expectedAffected.push({ domain: 'nutrition', aggregateId: m.aggregateId });
      for (const t of m.timings) {
        if (t.requirement === 'resolve_before_review')
          expectedRequirements.push({
            domain: 'nutrition',
            aggregateId: m.aggregateId,
            planVersionId: m.before.ref.versionId,
            itemId: t.itemId,
            reason: 'affected_timing_unresolved',
            editor: 'replace_anchor',
          });
        if (
          t.state === 'unchanged' &&
          (t.before.state === 'unresolved' || t.before.state === 'suspended')
        )
          expectedNotices.push({
            domain: 'nutrition',
            aggregateId: m.aggregateId,
            itemId: t.itemId,
            code: t.before.state === 'suspended' ? 'DISCONNECTED_RETAINED' : 'UNCHANGED_UNRESOLVED',
          });
        const r = p.intent.resolutions.nutrition.find(
          (r) => r.planVersionId.toLowerCase() === m.before.ref.versionId && r.itemId === t.itemId,
        );
        if (
          (t.resolution === 'explicit_replacement') !== Boolean(r) ||
          (r && !same(r.anchor, m.after.plan.items.find((i) => i.id === t.itemId)?.anchor))
        )
          c.addIssue({
            code: 'custom',
            message: 'Exact nutrition resolution correspondence required',
          });
      }
    }
    for (const m of p.routines.state === 'present' ? p.routines.members : []) {
      if (m.state === 'affected')
        expectedAffected.push({ domain: 'routine_schedule', aggregateId: m.aggregateId });
      if (m.requirement !== 'none')
        expectedRequirements.push({
          domain: 'routine_schedule',
          aggregateId: m.aggregateId,
          scheduleVersionId: m.before.schedule.versionId,
          reason:
            m.requirement === 'retained_ended_unresolved'
              ? 'retained_ended_unresolved'
              : 'affected_timing_unresolved',
          editor:
            m.requirement === 'retained_ended_unresolved'
              ? 'unavailable_frozen_ended'
              : 'replace_rule',
        });
      if (
        m.state === 'unchanged' &&
        m.storedOccurrences.some(
          (o) =>
            o.schedule.versionId === m.before.schedule.versionId && o.timingStatus === 'unresolved',
        )
      )
        expectedNotices.push({
          domain: 'routine_schedule',
          aggregateId: m.aggregateId,
          itemId: null,
          code: 'UNCHANGED_UNRESOLVED',
        });
      if (m.state === 'retained_ended')
        expectedNotices.push({
          domain: 'routine_schedule',
          aggregateId: m.aggregateId,
          itemId: null,
          code: 'ENDED_SCHEDULE_RETAINED',
        });
      if (m.retainedStarted.length)
        expectedNotices.push({
          domain: 'routine_schedule',
          aggregateId: m.aggregateId,
          itemId: null,
          code: 'STARTED_RUN_PRESERVED',
        });
      const r = p.intent.resolutions.routines.find(
        (r) => r.scheduleVersionId === m.before.schedule.versionId,
      );
      if (
        (m.resolution === 'explicit_replacement') !== Boolean(r) ||
        (r &&
          (!same(r.rule, m.after.schedule.rule) ||
            !same(r.window, m.after.schedule.window) ||
            r.sourcePlanVersionId !== m.after.sourcePlanVersionId))
      )
        c.addIssue({ code: 'custom', message: 'Exact routine resolution correspondence required' });
    }
    for (const r of p.intent.resolutions.nutrition)
      if (!(
        p.nutrition.state === 'present' &&
        p.nutrition.members.some(
          (m) =>
            m.before.ref.versionId === r.planVersionId.toLowerCase() &&
            m.timings.some((t) => t.itemId === r.itemId && t.state === 'affected'),
        )
      ))
        c.addIssue({ code: 'custom', message: 'Resolution requires affected owned tuple' });
    for (const r of p.intent.resolutions.routines)
      if (!(
        p.routines.state === 'present' &&
        p.routines.members.some(
          (m) => m.before.schedule.versionId === r.scheduleVersionId && m.state === 'affected',
        )
      ))
        c.addIssue({ code: 'custom', message: 'Resolution requires affected owned tuple' });
    function exact(a: readonly unknown[], b: readonly unknown[]) {
      unique(
        a.map((v) => JSON.stringify(v)),
        c,
      );
      if (a.length !== b.length || a.some((v) => !b.some((w) => same(v, w))))
        c.addIssue({ code: 'custom', message: 'Exact derived roster required' });
    }
    const changedTraining = new Set(
      expectedAffected.filter((t) => t.domain === 'training').map((t) => t.aggregateId),
    );
    for (const m of p.nutrition.state === 'present' ? p.nutrition.members : [])
      if (
        m.after.linkedTraining.kind === 'follows_training_approval' &&
        !changedTraining.has(m.after.linkedTraining.aggregateId)
      )
        c.addIssue({
          code: 'custom',
          message: 'Hypothetical nutrition link needs affected training',
        });
    for (const m of p.recovery.state === 'present' ? p.recovery.members : [])
      for (const link of m.after.planLinks)
        if (
          link.version.kind === 'follows_approval' &&
          !expectedAffected.some(
            (t) => t.domain === link.domain && t.aggregateId === link.aggregateId,
          )
        )
          c.addIssue({
            code: 'custom',
            message: 'Hypothetical recovery link needs affected target',
          });
    if (p.intent.selection.kind === 'keep_plan' && changedTraining.size)
      c.addIssue({ code: 'custom', message: 'Keep plan cannot change training' });
    if (p.intent.selection.kind === 'move_period') {
      const selection = p.intent.selection;
      if (!(
        p.training.state === 'present' &&
        p.training.members.length === 1 &&
        p.training.members.some(
          (m) =>
            m.before.ref.versionId.toLowerCase() ===
              selection.expectedCurrentPlanVersionId.toLowerCase() &&
            m.before.plan.periods.some((period) => period.id === selection.periodId),
        )
      ))
        c.addIssue({ code: 'custom', message: 'Move requires exact current training period' });
    }
    exact(p.affected, expectedAffected);
    exact(p.resolutionRequirements, expectedRequirements);
    exact(p.notices, expectedNotices);
    unique(
      [
        ...p.retainedUnplanned.map((r) => r.runId),
        ...(p.routines.state === 'present'
          ? p.routines.members.flatMap((m) => m.retainedStarted.map((r) => r.runId))
          : []),
      ],
      c,
    );
  });
const blocked = z
  .strictObject({
    ...fixed,
    status: z.literal('blocked'),
    reason: z.enum([
      'source_unavailable',
      'source_permission_unavailable',
      'stale_basis',
      'incomplete_affected_scope',
      'unsupported_source',
      'processing_port_unavailable',
      'limit_exceeded',
    ]),
    domains: z.array(domain).max(4),
  })
  .superRefine((p, c) => unique(p.domains, c));
/** Strict transient presentation only: no stored candidate, reference, source
 * authentication or current approval permission is represented. */
const plain = z.unknown().superRefine((raw, c) => {
  let visits = 0;
  let bytes = 0;
  function charge(text: string) {
    if (text.length > 4194304 - bytes) throw Error('bytes');
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > 4194304) throw Error('bytes');
  }
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (++visits > 5000 || depth > 64) throw Error('limit');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      charge(v);
      return;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || ancestors.has(v)) throw Error('plain');
    const array = Array.isArray(v);
    if (
      array
        ? Object.getPrototypeOf(v) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    )
      throw Error('plain');
    const keys = Reflect.ownKeys(v);
    if (keys.length > 5001) throw Error('limit');
    ancestors.add(v);
    let count = 0;
    for (const key of keys) {
      if (typeof key !== 'string') throw Error('plain');
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !('value' in d)) throw Error('plain');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length))
        throw Error('dense');
      charge(key);
      count++;
      visit(d.value, depth + 1);
    }
    if (array && count !== v.length) throw Error('dense');
    ancestors.delete(v);
  }
  try {
    visit(raw, 0);
    if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 4194304) throw Error('bytes');
  } catch {
    c.addIssue({ code: 'custom', message: 'Bounded plain impact required' });
  }
});
export const raceManualPublicImpactSchema = plain.pipe(
  z.discriminatedUnion('status', [projected, blocked]),
);
export type RaceManualPublicImpact = z.infer<typeof raceManualPublicImpactSchema>;
