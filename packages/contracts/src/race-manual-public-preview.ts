import { z } from 'zod';
import { createBoundedPlainJsonSchema } from './bounded-plain-json.js';
import {
  idSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  timeZoneSchema,
} from './primitives.js';
import { planDraftSchema, planSnapshotSchema } from './planning.js';
import { nutritionPlanDraftSchema, validateNutritionPlanItem } from './nutrition-core.js';
import { nutritionPlanVersionV3Schema } from './nutrition-race-plan-v3.js';
import { recoveryStrategyDraftSchema } from './recovery-core.js';
import {
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
} from './routines.js';
import { raceEventSchema } from './races.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(2147483647);
const domain = z.enum(['training', 'nutrition', 'recovery', 'routine_schedule']);
const target = z.strictObject({ domain, aggregateId: uuid });
/** Existing durable identity only. A digest/reference is not permission or a seal. */
export const raceManualPublicPreviewReferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateId: uuid,
  applicationDigest: digest,
  chain: z.strictObject({
    evidenceId: uuid,
    decisionId: uuid,
    proposalId: uuid,
    readonlyCandidateDigest: digest,
  }),
  createdAt: instantSchema,
});

/** Exact4MiB encoded transport budget, independent of semantic source visits.
 * Strict planned member/array limits below remain unchanged. */
const plain = createBoundedPlainJsonSchema(4194304, 'Bounded plain preview required');
// Object key spelling/order is not a semantic change; ordered arrays remain
// ordered. Both values reach this helper only after the bounded strict decode.
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry: unknown, index: number) => same(entry, right[index]))
    );
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  const a = new Map<string, unknown>(Object.entries(left));
  const b = new Map<string, unknown>(Object.entries(right));
  return a.size === b.size && [...a].every(([key, value]) => b.has(key) && same(value, b.get(key)));
}
function unique(values: readonly string[], context: z.RefinementCtx, message: string) {
  if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message });
}
function section<T extends z.ZodType>(member: T) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({ state: z.literal('present'), members: z.array(member).min(1).max(1000) }),
  ]);
}
const numberedRef = z.strictObject({ versionId: uuid, version });
const trainingRef = z.strictObject({ versionId: planSnapshotSchema.shape.id, version });
const trainingMember = z
  .strictObject({
    aggregateId: uuid,
    before: z.strictObject({ ref: trainingRef, plan: planDraftSchema }),
    after: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('retained'), plan: planDraftSchema }),
      z.strictObject({ kind: z.literal('new_version_on_approval'), plan: planDraftSchema }),
    ]),
  })
  .superRefine((member, context) => {
    if (member.after.kind === 'retained' && !same(member.before.plan, member.after.plan))
      context.addIssue({ code: 'custom', message: 'Retained training must remain unchanged' });
  });

export const raceManualPublicOperationalTimingSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('resolved'),
    date: localDateSchema,
    localTime: localTimeSchema.nullable(),
    timezone: timeZoneSchema,
  }),
  z.strictObject({
    state: z.literal('unresolved'),
    reason: z.enum([
      'missing_anchor',
      'missing_session_time',
      'missing_session_duration',
      'ambiguous_local_time',
      'timezone_mismatch',
      'offset_out_of_range',
      'missing_race_time',
      'missing_race_end',
      'unsupported_anchor_mapping',
    ]),
  }),
  z.strictObject({
    state: z.literal('suspended'),
    reason: z.literal('race_disconnected'),
    resume: z.literal('explicit_reconnect_and_reapproval_required'),
  }),
]);
const {
  planVersionId: _storedVersion,
  evidenceIds: _evidence,
  source: _source,
  ...plannedItemFields
} = nutritionPlanVersionV3Schema.shape.items.element.shape;
void _storedVersion;
void _evidence;
void _source;
/** Planned food/quantity/targets/instructions are retained. Stored pins, source
 * evidence and approval metadata are not a public preview body. */
const nutritionItem = z.strictObject(plannedItemFields).superRefine(validateNutritionPlanItem);
const nutritionPlan = z
  .strictObject({
    period: nutritionPlanDraftSchema.shape.period,
    purpose: nutritionPlanDraftSchema.shape.purpose,
    timezone: nutritionPlanDraftSchema.shape.timezone,
    items: z.array(nutritionItem).max(5000),
  })
  .superRefine((plan, context) =>
    unique(
      plan.items.map((item) => item.id),
      context,
      'Duplicate nutrition item',
    ),
  );
const link = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent') }),
  z.strictObject({ kind: z.literal('retained'), versionId: planSnapshotSchema.shape.id }),
  z.strictObject({ kind: z.literal('follows_training_approval'), aggregateId: uuid }),
]);
const nutritionMember = z
  .strictObject({
    aggregateId: uuid,
    before: z.strictObject({ ref: numberedRef, plan: nutritionPlan, linkedTraining: link }),
    after: z.strictObject({
      kind: z.enum(['retained', 'new_version_on_approval']),
      plan: nutritionPlan,
      linkedTraining: link,
    }),
    timings: z
      .array(
        z.strictObject({
          itemId: nutritionItem.shape.id,
          state: z.enum(['unchanged', 'affected']),
          before: raceManualPublicOperationalTimingSchema,
          after: raceManualPublicOperationalTimingSchema,
        }),
      )
      .max(5000),
  })
  .superRefine((member, context) => {
    const before = new Map(member.before.plan.items.map((item) => [item.id, item]));
    const after = new Map(member.after.plan.items.map((item) => [item.id, item]));
    unique(
      member.timings.map((row) => row.itemId),
      context,
      'Duplicate nutrition timing',
    );
    if (before.size !== after.size || before.size !== member.timings.length)
      context.addIssue({ code: 'custom', message: 'Exact nutrition item roster required' });
    for (const row of member.timings) {
      const old = before.get(row.itemId),
        next = after.get(row.itemId);
      if (!old || !next) {
        context.addIssue({ code: 'custom', message: 'Unknown timing item' });
        continue;
      }
      if (row.state === 'unchanged' && (!same(old, next) || !same(row.before, row.after)))
        context.addIssue({
          code: 'custom',
          message: 'Unchanged nutrition must preserve item and timing',
        });
      if (
        old.anchor.kind === 'disconnected' &&
        (next.anchor.kind !== 'disconnected' ||
          row.state !== 'unchanged' ||
          row.before.state !== 'suspended' ||
          row.after.state !== 'suspended')
      )
        context.addIssue({
          code: 'custom',
          message: 'Disconnected timing requires separate reconnect and reapproval',
        });
      if (
        (old.anchor.kind !== 'disconnected' && row.before.state === 'suspended') ||
        (next.anchor.kind !== 'disconnected' && row.after.state === 'suspended')
      )
        context.addIssue({ code: 'custom', message: 'Suspension requires disconnected anchor' });
      const { anchor: oldAnchor, ...oldPlanned } = old;
      const { anchor: nextAnchor, ...nextPlanned } = next;
      void oldAnchor;
      void nextAnchor;
      if (!same(oldPlanned, nextPlanned))
        context.addIssue({
          code: 'custom',
          message: 'Date review must preserve planned food, quantity and goals',
        });
      if (row.state === 'affected' && row.after.state !== 'resolved')
        context.addIssue({
          code: 'custom',
          message: 'Affected timing must be resolved before ready review',
        });
    }
    if (member.before.linkedTraining.kind === 'follows_training_approval')
      context.addIssue({
        code: 'custom',
        message: 'Frozen before cannot follow hypothetical approval',
      });
    if (
      member.after.kind === 'retained' &&
      (!same(member.before.plan, member.after.plan) ||
        !same(member.before.linkedTraining, member.after.linkedTraining))
    )
      context.addIssue({ code: 'custom', message: 'Retained nutrition must remain unchanged' });
  });

const recoveryPlan = z
  .strictObject({
    title: recoveryStrategyDraftSchema.shape.title,
    goal: recoveryStrategyDraftSchema.shape.goal,
    startDate: recoveryStrategyDraftSchema.shape.startDate,
    endDateExclusive: recoveryStrategyDraftSchema.shape.endDateExclusive,
    timezone: recoveryStrategyDraftSchema.shape.timezone,
    priority: recoveryStrategyDraftSchema.shape.priority,
    options: recoveryStrategyDraftSchema.shape.options,
    reassessment: recoveryStrategyDraftSchema.shape.reassessment,
  })
  .superRefine((plan, context) => {
    if (plan.startDate >= plan.endDateExclusive)
      context.addIssue({ code: 'custom', message: 'Recovery period must be ordered' });
    unique(
      plan.options.map((option) => option.id),
      context,
      'Duplicate recovery option',
    );
    unique(
      plan.reassessment.map((entry) => entry.id),
      context,
      'Duplicate reassessment',
    );
  });
const recoveryLink = z.strictObject({
  domain: z.enum(['training', 'nutrition']),
  aggregateId: uuid,
  version: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('retained'), versionId: uuid }),
    z.strictObject({ kind: z.literal('follows_approval') }),
  ]),
});
const recoverySide = z.strictObject({
  plan: recoveryPlan,
  status: z.enum(['draft', 'user_confirmed']),
  selectedOptionId: uuid.nullable(),
  planLinks: z.array(recoveryLink).max(20),
});
const recoveryMember = z
  .strictObject({
    aggregateId: uuid,
    before: recoverySide.extend({ ref: numberedRef }),
    after: recoverySide.extend({ kind: z.enum(['retained', 'new_version_on_approval']) }),
  })
  .superRefine((member, context) => {
    for (const side of [member.before, member.after]) {
      if (
        (side.status === 'user_confirmed' && side.selectedOptionId === null) ||
        (side.selectedOptionId !== null &&
          !side.plan.options.some((option) => option.id === side.selectedOptionId))
      )
        context.addIssue({ code: 'custom', message: 'Invalid selected recovery option' });
      unique(
        side.planLinks.map((ref) => JSON.stringify([ref.domain, ref.aggregateId])),
        context,
        'Duplicate recovery plan link',
      );
    }
    if (member.before.planLinks.some((ref) => ref.version.kind !== 'retained'))
      context.addIssue({ code: 'custom', message: 'Frozen recovery links require exact version' });
    if (
      member.after.kind === 'new_version_on_approval' &&
      (member.after.status !== 'user_confirmed' || member.after.selectedOptionId === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Affected recovery must retain explicit selected option',
      });
    if (
      member.after.kind === 'retained' &&
      !same(
        {
          plan: member.before.plan,
          status: member.before.status,
          selectedOptionId: member.before.selectedOptionId,
          planLinks: member.before.planLinks,
        },
        {
          plan: member.after.plan,
          status: member.after.status,
          selectedOptionId: member.after.selectedOptionId,
          planLinks: member.after.planLinks,
        },
      )
    )
      context.addIssue({ code: 'custom', message: 'Retained recovery must remain unchanged' });
  });

const expansion = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('expanded'),
    occurrences: z.array(routineOccurrenceSchema).max(1000),
  }),
  z.strictObject({
    state: z.literal('unresolved'),
    reason: z.enum([
      'SOURCE_PLAN_REQUIRED',
      'SOURCE_PLAN_TIMEZONE_MISMATCH',
      'PERIOD_NOT_FOUND',
      'SESSION_NOT_FOUND',
      'ANCHOR_OUTSIDE_WINDOW',
      'ANCHOR_OUTSIDE_PERIOD',
      'EXPANSION_LIMIT_EXCEEDED',
      'DUPLICATE_ANCHOR',
      'UNSUPPORTED_MAPPING',
    ]),
  }),
]);
const started = z.strictObject({
  runId: idSchema,
  occurrenceId: idSchema,
  scheduleVersionId: idSchema,
  blueprintVersionId: idSchema,
  anchorKey: routineOccurrenceSchema.shape.anchorKey,
  preservation: z.literal('started_run_frozen'),
});
const routineMember = z
  .strictObject({
    aggregateId: uuid,
    blueprint: routineBlueprintVersionSchema,
    before: z.strictObject({ schedule: routineScheduleVersionSchema, expansion }),
    after: z.strictObject({
      kind: z.enum(['retained', 'new_version_on_approval']),
      schedule: routineScheduleVersionSchema,
      expansion,
    }),
    retainedStarted: z.array(started).max(1000),
  })
  .superRefine((member, context) => {
    for (const side of [member.before, member.after]) {
      if (
        side.schedule.id !== member.aggregateId ||
        side.schedule.blueprint.id !== member.blueprint.routineId ||
        side.schedule.blueprint.versionId !== member.blueprint.versionId
      )
        context.addIssue({ code: 'custom', message: 'Routine/blueprint tuple mismatch' });
      if (side.expansion.state === 'expanded') {
        unique(
          side.expansion.occurrences.map((entry) => entry.id),
          context,
          'Duplicate occurrence',
        );
        unique(
          side.expansion.occurrences.map((entry) => entry.anchorKey),
          context,
          'Duplicate occurrence anchor',
        );
        if (
          side.expansion.occurrences.some(
            (entry) =>
              entry.schedule.id !== member.aggregateId ||
              entry.schedule.versionId !== side.schedule.versionId ||
              entry.blueprint.id !== member.blueprint.routineId ||
              entry.blueprint.versionId !== member.blueprint.versionId,
          )
        )
          context.addIssue({ code: 'custom', message: 'Occurrence tuple mismatch' });
      }
    }
    unique(
      member.retainedStarted.map((entry) => entry.runId),
      context,
      'Duplicate retained run',
    );
    unique(
      member.retainedStarted.map((entry) => entry.anchorKey),
      context,
      'Duplicate started anchor',
    );
    if (
      member.after.kind === 'new_version_on_approval' &&
      (member.after.expansion.state !== 'expanded' ||
        member.after.expansion.occurrences.some((entry) => entry.timingStatus !== 'resolved') ||
        member.before.schedule.state === 'ended' ||
        member.after.schedule.versionId === member.before.schedule.versionId)
    )
      context.addIssue({
        code: 'custom',
        message: 'Affected routine must have a new resolved schedule',
      });
    if (
      member.after.kind === 'new_version_on_approval' &&
      member.after.expansion.state === 'expanded' &&
      member.after.expansion.occurrences.some((entry) =>
        member.retainedStarted.some((run) => run.anchorKey === entry.anchorKey),
      )
    )
      context.addIssue({ code: 'custom', message: 'Started anchors cannot be replanned' });
    if (
      member.after.kind === 'retained' &&
      (!same(member.before.schedule, member.after.schedule) ||
        !same(member.before.expansion, member.after.expansion))
    )
      context.addIssue({ code: 'custom', message: 'Retained routine must remain unchanged' });
  });
const raceSide = raceEventSchema.pick({
  title: true,
  localDate: true,
  localStartTime: true,
  timezone: true,
  distance: true,
  priority: true,
  participation: true,
  targetSeconds: true,
});
const race = z
  .strictObject({ eventId: uuid, expectedRevision: version, before: raceSide, after: raceSide })
  .superRefine((event, context) => {
    if (!same({ ...event.before, localDate: event.after.localDate }, event.after))
      context.addIssue({ code: 'custom', message: 'Only race date may change' });
  });
const notice = z.strictObject({
  domain,
  aggregateId: uuid,
  itemId: nutritionItem.shape.id.nullable(),
  code: z.enum([
    'UNCHANGED_UNRESOLVED',
    'DISCONNECTED_RETAINED',
    'STARTED_RUN_PRESERVED',
    'ENDED_SCHEDULE_RETAINED',
  ]),
});
const present = z
  .strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('present'),
    reference: raceManualPublicPreviewReferenceSchema,
    storedCandidateState: z.literal('ready_for_explicit_approval'),
    beforeBasis: z.literal('frozen_review'),
    afterBasis: z.literal('hypothetical_on_approval'),
    freshness: z.literal('not_checked_on_read'),
    scope: z.literal('whole_affected'),
    race,
    training: section(trainingMember),
    nutrition: section(nutritionMember),
    recovery: section(recoveryMember),
    routines: section(routineMember),
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
    notices: z.array(notice).max(5000),
  })
  .superRefine((preview, context) => {
    const rosters = {
      training: preview.training,
      nutrition: preview.nutrition,
      recovery: preview.recovery,
      routine_schedule: preview.routines,
    };
    const changed = new Set<string>();
    let count = 0;
    for (const d of ['training', 'nutrition', 'recovery', 'routine_schedule'] as const) {
      const roster = rosters[d];
      if (roster.state === 'absent') continue;
      unique(
        roster.members.map((member) => member.aggregateId),
        context,
        'Duplicate domain aggregate',
      );
      count += roster.members.length;
      for (const member of roster.members)
        if (member.after.kind === 'new_version_on_approval')
          changed.add(JSON.stringify([d, member.aggregateId]));
    }
    if (count > 1000)
      context.addIssue({ code: 'custom', message: 'Whole domain roster exceeds 1000' });
    for (const member of preview.nutrition.state === 'present' ? preview.nutrition.members : [])
      if (
        member.after.linkedTraining.kind === 'follows_training_approval' &&
        !changed.has(JSON.stringify(['training', member.after.linkedTraining.aggregateId]))
      )
        context.addIssue({ code: 'custom', message: 'Nutrition link requires affected training' });
    for (const member of preview.recovery.state === 'present' ? preview.recovery.members : [])
      for (const ref of member.after.planLinks)
        if (
          ref.version.kind === 'follows_approval' &&
          !changed.has(JSON.stringify([ref.domain, ref.aggregateId]))
        )
          context.addIssue({ code: 'custom', message: 'Recovery link requires affected target' });
    unique(
      preview.affected.map((entry) => JSON.stringify([entry.domain, entry.aggregateId])),
      context,
      'Duplicate affected target',
    );
    if (
      preview.affected.length !== changed.size ||
      preview.affected.some(
        (entry) => !changed.has(JSON.stringify([entry.domain, entry.aggregateId])),
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Affected roster must exactly match hypothetical writes',
      });
    unique(
      [
        ...preview.retainedUnplanned.map((run) => run.runId),
        ...(preview.routines.state === 'present'
          ? preview.routines.members.flatMap((member) =>
              member.retainedStarted.map((run) => run.runId),
            )
          : []),
      ],
      context,
      'Duplicate preserved run across scheduled and unplanned rosters',
    );
    const expectedNotices: z.infer<typeof notice>[] = [];
    for (const member of preview.nutrition.state === 'present' ? preview.nutrition.members : [])
      for (const row of member.timings) {
        if (
          row.state === 'unchanged' &&
          (row.before.state === 'unresolved' || row.before.state === 'suspended')
        )
          expectedNotices.push({
            domain: 'nutrition',
            aggregateId: member.aggregateId,
            itemId: row.itemId,
            code:
              row.before.state === 'suspended' ? 'DISCONNECTED_RETAINED' : 'UNCHANGED_UNRESOLVED',
          });
      }
    for (const member of preview.routines.state === 'present' ? preview.routines.members : []) {
      if (member.before.schedule.state === 'ended')
        expectedNotices.push({
          domain: 'routine_schedule',
          aggregateId: member.aggregateId,
          itemId: null,
          code: 'ENDED_SCHEDULE_RETAINED',
        });
      if (member.retainedStarted.length)
        expectedNotices.push({
          domain: 'routine_schedule',
          aggregateId: member.aggregateId,
          itemId: null,
          code: 'STARTED_RUN_PRESERVED',
        });
    }
    const expected = new Set(expectedNotices.map((entry) => JSON.stringify(entry)));
    unique(
      preview.notices.map((entry) => JSON.stringify(entry)),
      context,
      'Duplicate notice',
    );
    if (
      preview.notices.length !== expected.size ||
      preview.notices.some((entry) => !expected.has(JSON.stringify(entry)))
    )
      context.addIssue({ code: 'custom', message: 'Exact preservation notices required' });
  });
const unavailable = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal('unavailable'),
  reference: raceManualPublicPreviewReferenceSchema,
  reason: z.literal('review_body_purged'),
  preview: z.null(),
});
/** Presentation of stored review facts only. This schema cannot authenticate the
 * frozen source, grant permission, apply a proposal or prove current freshness. */
export const raceManualPublicPreviewSchema = plain.pipe(
  z.discriminatedUnion('status', [present, unavailable]),
);
export type RaceManualPublicPreview = z.infer<typeof raceManualPublicPreviewSchema>;
export type RaceManualPublicPreviewReference = z.infer<
  typeof raceManualPublicPreviewReferenceSchema
>;

/** Fresh processing failure is separate from a durable ready review; no copied
 * source/body is returned and no review reference is invented after rollback. */
export const raceManualPublicPreviewBlockedSchema = plain.pipe(
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('blocked'),
    stage: z.enum(['semantic', 'chain', 'application']),
    blockers: z
      .array(
        z.strictObject({
          reason: z.enum([
            'source_unavailable',
            'source_permission_unavailable',
            'stale_basis',
            'incomplete_affected_scope',
            'affected_timing_unresolved',
            'disconnection_origin_unavailable',
            'reconnect_target_unavailable',
            'unsupported_source',
            'application_port_unavailable',
          ]),
          target: target.nullable(),
        }),
      )
      .min(1)
      .max(1000),
    resolutionRequirements: z
      .array(
        z.discriminatedUnion('domain', [
          z.strictObject({
            domain: z.literal('nutrition'),
            aggregateId: uuid,
            planVersionId: uuid,
            itemId: nutritionItem.shape.id,
            action: z.literal('replace_anchor_and_review'),
          }),
          z.strictObject({
            domain: z.literal('routine_schedule'),
            aggregateId: uuid,
            scheduleVersionId: idSchema,
            action: z.literal('replace_rule_and_review'),
          }),
        ]),
      )
      .max(1000),
  }),
);
export type RaceManualPublicPreviewBlocked = z.infer<typeof raceManualPublicPreviewBlockedSchema>;

/** Safe planned presentation codecs shared by transient diagnostics. These are
 * structural codecs, not stored-source or approval authority. */
export {
  trainingMember as raceManualPublicTrainingMemberSchema,
  nutritionItem as raceManualPublicNutritionItemSchema,
  nutritionPlan as raceManualPublicNutritionPlanSchema,
  link as raceManualPublicTrainingLinkSchema,
  recoveryMember as raceManualPublicRecoveryMemberSchema,
  expansion as raceManualPublicRoutineExpansionSchema,
  started as raceManualPublicStartedRunSchema,
  race as raceManualPublicRaceChangeSchema,
};
