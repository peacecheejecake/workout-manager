import { z } from 'zod';
import { idSchema, instantSchema } from './primitives.js';
import { periodDraftSchema, plannedSessionSchema } from './planning.js';
import { dashboardActualSchema, dashboardPlannedSchema } from './dashboard.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const periodSummaryQuerySchema = z.strictObject({
  planVersionId: z.uuid().transform((value) => value.toLowerCase()),
  periodId: idSchema.max(200),
});
export const periodSummaryDefinition = {
  version: 'period-summary-v1',
  planned: '선택한 저장 버전의 기간과 하위 Block에 속한 계획 세션을 한 번씩 합산합니다.',
  actual: '해당 기간의 현지 날짜 범위에 시작한 현재 실제 활동입니다. 계획 연결 여부와 무관합니다.',
  duration:
    '실제 시간은 timer/elapsed/moving/unknown 정의별로 구분하며 계획 시간과 합치지 않습니다.',
  keySessions: '사용자가 중요도를 높음으로 지정한 계획 세션입니다. 중요도를 추정하지 않습니다.',
  coverage:
    '수집 완전성은 미확인입니다. 빈 기록은 휴식·미수행이 아니며 이행률을 계산하지 않습니다.',
} as const;
export const periodSummarySchema = z
  .strictObject({
    definitionVersion: z.literal('period-summary-v1'),
    observedAt: instantSchema,
    planVersion: z.strictObject({
      id: z.uuid(),
      version: z.number().int().positive(),
      title: z.string().min(1).max(200),
    }),
    currentPlanVersionId: z.uuid().nullable(),
    period: periodDraftSchema,
    planned: dashboardPlannedSchema,
    keySessions: z.array(plannedSessionSchema).max(1000),
    actual: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('available'), totals: dashboardActualSchema }),
      z.strictObject({
        status: z.literal('unavailable'),
        reason: z.literal('unsupported_calendar'),
      }),
    ]),
    dataRevision: z.strictObject({
      activities: z.strictObject({ count, revisionSum: z.string().regex(/^(?:0|[1-9][0-9]*)$/) }),
    }),
    // Account-wide count: an unknown start cannot be assigned to this period.
    unplacedActivityCount: count,
    coverage: z.literal('unknown'),
  })
  .superRefine((value, context) => {
    const unsupportedCalendar = value.period.startDate < '0001-01-01';
    if (unsupportedCalendar !== (value.actual.status === 'unavailable'))
      context.addIssue({
        code: 'custom',
        message: 'Calendar availability must match the period',
        path: ['actual'],
      });
    if (value.planned.count > 1000)
      context.addIssue({
        code: 'custom',
        message: 'Planned count exceeds snapshot bound',
        path: ['planned'],
      });
    const actualCount = value.actual.status === 'available' ? value.actual.totals.count : 0;
    if (actualCount + value.unplacedActivityCount > value.dataRevision.activities.count)
      context.addIssue({
        code: 'custom',
        message: 'Activity counts exceed observed canonical rows',
        path: ['dataRevision'],
      });
    if (value.period.startDate >= value.period.endDateExclusive)
      context.addIssue({ code: 'custom', message: 'Expected non-empty period', path: ['period'] });
    if (
      new Set(value.keySessions.map((session) => session.id)).size !== value.keySessions.length ||
      value.keySessions.length > value.planned.count
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid key session count',
        path: ['keySessions'],
      });
    for (const [index, session] of value.keySessions.entries()) {
      if (
        session.priority !== 'high' ||
        session.date < value.period.startDate ||
        session.date >= value.period.endDateExclusive ||
        (value.period.level === 'block' && session.blockId !== value.period.id)
      )
        context.addIssue({
          code: 'custom',
          message: 'Key session must belong to the period and have high priority',
          path: ['keySessions', index],
        });
    }
  });
export type PeriodSummaryQuery = z.infer<typeof periodSummaryQuerySchema>;
export type PeriodSummary = z.infer<typeof periodSummarySchema>;
