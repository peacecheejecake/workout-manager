import { z } from 'zod';
import { activitySchema, activityValuesSchema } from './activity.js';
import { dashboardActualSchema } from './dashboard.js';
import {
  distanceRangeSchema,
  durationRangeSchema,
  periodDraftSchema,
  plannedSessionSchema,
} from './planning.js';
import { instantSchema, localDateSchema } from './primitives.js';

const metric = z.number().finite().nonnegative().nullable();
export const activityDistanceComparisonSchema = z
  .strictObject({
    actual: metric,
    planned: metric,
    plannedRange: distanceRangeSchema.nullable().optional(),
    rangePosition: z.enum(['below', 'within', 'above', 'unknown']).optional(),
    delta: z.number().finite().nullable(),
    status: z.enum([
      'available',
      'missing_actual',
      'missing_plan',
      'missing_both',
      'range_available',
      'range_missing_actual',
    ]),
  })
  .refine((value) => {
    if (value.plannedRange) {
      const position =
        value.actual === null
          ? 'unknown'
          : value.actual < value.plannedRange.minMeters
            ? 'below'
            : value.actual > value.plannedRange.maxMeters
              ? 'above'
              : 'within';
      return (
        value.planned === null &&
        value.delta === null &&
        value.rangePosition === position &&
        value.status === (value.actual === null ? 'range_missing_actual' : 'range_available')
      );
    }
    if (value.rangePosition !== undefined) return false;
    const status =
      value.actual === null
        ? value.planned === null
          ? 'missing_both'
          : 'missing_actual'
        : value.planned === null
          ? 'missing_plan'
          : 'available';
    return (
      value.status === status &&
      value.delta ===
        (value.actual !== null && value.planned !== null ? value.actual - value.planned : null)
    );
  }, 'Distance difference requires both observations');

export const activityContextSchema = z
  .strictObject({
    definitionVersion: z.literal('activity-context-v1'),
    observedAt: instantSchema,
    activity: activitySchema,
    activityDataRevision: z.strictObject({
      count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      revisionSum: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    }),
    planContext: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('unlinked') }),
      z.strictObject({
        status: z.literal('unavailable'),
        reason: z.enum(['linked_plan_unavailable', 'unsupported_calendar']),
      }),
      z.strictObject({
        status: z.literal('linked'),
        planVersion: z.strictObject({
          id: z.uuid(),
          version: z.number().int().positive(),
          title: z.string().min(1).max(200),
        }),
        currentPlanVersionId: z.uuid().nullable(),
        session: plannedSessionSchema,
        block: periodDraftSchema.refine((value) => value.level === 'block'),
        actualLocalDate: localDateSchema.nullable(),
        blockMembership: z.enum(['included', 'outside', 'unknown_time']),
        blockActual: dashboardActualSchema,
        distanceComparison: activityDistanceComparisonSchema,
        durationComparison: z
          .strictObject({
            actual: metric,
            actualKind: activityValuesSchema.shape.durationKind,
            planned: metric,
            plannedRange: durationRangeSchema.nullable().optional(),
            delta: z.null(),
            status: z.literal('not_comparable'),
            reason: z.literal('planned_duration_definition_missing'),
          })
          .refine(
            (comparison) => !comparison.plannedRange || comparison.planned === null,
            'Duration range cannot also be an exact target',
          ),
        coverage: z.literal('unknown'),
      }),
    ]),
  })
  .superRefine((value, context) => {
    const plan = value.planContext;
    const link = value.activity.userReport?.planLink;
    if (plan.status === 'unlinked' && link)
      context.addIssue({ code: 'custom', message: 'Stored plan link cannot be omitted' });
    if (plan.status !== 'unlinked' && !link)
      context.addIssue({ code: 'custom', message: 'Plan context requires an explicit link' });
    if (plan.status !== 'linked') return;
    const membership =
      plan.actualLocalDate === null
        ? 'unknown_time'
        : plan.actualLocalDate >= plan.block.startDate &&
            plan.actualLocalDate < plan.block.endDateExclusive
          ? 'included'
          : 'outside';
    if (
      link?.planVersionId.toLowerCase() !== plan.planVersion.id.toLowerCase() ||
      link?.sessionId !== plan.session.id ||
      plan.session.blockId !== plan.block.id ||
      plan.blockMembership !== membership ||
      plan.distanceComparison.actual !== value.activity.effective.distanceMeters ||
      plan.distanceComparison.planned !== plan.session.distanceMeters ||
      plan.durationComparison.actual !== value.activity.effective.durationSeconds ||
      plan.durationComparison.actualKind !== value.activity.effective.durationKind ||
      plan.durationComparison.planned !== plan.session.durationSeconds
    )
      context.addIssue({
        code: 'custom',
        message: 'Plan context must match the same activity and linked snapshot',
      });
    const distanceRange = plan.session.distanceRange;
    const durationRange = plan.session.durationRange;
    const distanceComparisonRange = plan.distanceComparison.plannedRange;
    const durationComparisonRange = plan.durationComparison.plannedRange;
    if (
      (distanceRange
        ? distanceRange.minMeters !== distanceComparisonRange?.minMeters ||
          distanceRange.maxMeters !== distanceComparisonRange?.maxMeters
        : Boolean(distanceComparisonRange)) ||
      (durationRange
        ? durationRange.minSeconds !== durationComparisonRange?.minSeconds ||
          durationRange.maxSeconds !== durationComparisonRange?.maxSeconds
        : Boolean(durationComparisonRange))
    )
      context.addIssue({
        code: 'custom',
        message: 'Comparison bounds must match the linked snapshot',
      });
  });
export type ActivityContext = z.infer<typeof activityContextSchema>;
