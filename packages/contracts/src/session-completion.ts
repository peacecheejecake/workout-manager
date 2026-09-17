import { z } from 'zod';
import {
  idSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  timeZoneSchema,
} from './primitives.js';
import type { PlanDraft } from './planning.js';

const sessionId = idSchema.max(200);
const versionId = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2147483646);
const collectionRevision = z.number().int().min(0).max(2147483646);
const reason = z.string().trim().min(1).max(500);
export const sessionCompletionDefinition = {
  version: 'session-completion-v1',
  source: 'user',
  method: 'self_report',
  meaning:
    '사용자가 저장된 계획 세션의 완료를 확인한 기록입니다. 기기 측정이나 계획 이행률이 아닙니다.',
  missing: '완료 확인 기록 없음',
  timing: '확인 시각은 기록을 남긴 시각이며 실제 운동 종료 시각이 아닙니다.',
} as const;
export const sessionCompletionPathSchema = z.strictObject({ sessionId });
export const sessionCompletionScheduleSchema = z.strictObject({
  blockId: sessionId,
  date: localDateSchema,
  localStartTime: localTimeSchema.nullable(),
  timezone: timeZoneSchema,
});
export const sessionCompletionSchema = z
  .strictObject({
    sessionId,
    revision,
    planVersionId: versionId,
    schedule: sessionCompletionScheduleSchema,
    status: z.enum(['completed', 'retracted']),
    reportedAt: instantSchema,
    reason: reason.nullable(),
    source: z.literal('user'),
    method: z.literal('self_report'),
    definitionVersion: z.literal('session-completion-v1'),
  })
  .superRefine((value, context) => {
    if ((value.status === 'retracted' || value.revision > 1) && value.reason === null)
      context.addIssue({
        code: 'custom',
        message: 'A correction reason is required',
        path: ['reason'],
      });
    if (value.revision === 1 && value.status !== 'completed')
      context.addIssue({
        code: 'custom',
        message: 'The first report must confirm completion',
        path: ['status'],
      });
  });
export const sessionCompletionBodySchema = z
  .strictObject({
    action: z.enum(['complete', 'retract']),
    confirmed: z.literal(true),
    expectedPlanVersionId: versionId,
    expectedRevision: revision.nullable(),
    reason: reason.nullable(),
  })
  .superRefine((value, context) => {
    if (value.action === 'retract' && value.expectedRevision === null)
      context.addIssue({
        code: 'custom',
        message: 'Retraction requires an existing report',
        path: ['expectedRevision'],
      });
    if (value.expectedRevision !== null && value.reason === null)
      context.addIssue({
        code: 'custom',
        message: 'A correction reason is required',
        path: ['reason'],
      });
  });
export const sessionCompletionCommandSchema = sessionCompletionBodySchema.safeExtend({
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
});
export const sessionCompletionResultSchema = z
  .strictObject({
    report: sessionCompletionSchema,
    collectionRevision: revision,
  })
  .refine(
    (value) => value.collectionRevision >= value.report.revision,
    'Collection revision cannot precede the report',
  );
export const sessionCompletionListSchema = z
  .strictObject({
    currentPlanVersionId: versionId.nullable(),
    collectionRevision,
    // Only reports for sessions in the current saved head, including retractions.
    items: z.array(sessionCompletionSchema).max(1000),
  })
  .refine(
    (value) => new Set(value.items.map((item) => item.sessionId)).size === value.items.length,
    'Duplicate session completion reports',
  )
  .refine(
    (value) => value.currentPlanVersionId !== null || value.items.length === 0,
    'An absent saved head has no current session reports',
  )
  .refine(
    (value) => value.items.every((item) => item.revision <= value.collectionRevision),
    'Collection revision cannot precede reports',
  );
export const sessionCompletionReadSchema = z
  .strictObject({
    sessionId,
    currentPlanVersionId: versionId.nullable(),
    report: sessionCompletionSchema.nullable(),
    history: z.array(sessionCompletionSchema).max(100),
    totalHistory: z.number().int().nonnegative().max(2147483646),
  })
  .superRefine((value, context) => {
    if (value.report?.sessionId !== undefined && value.report.sessionId !== value.sessionId)
      context.addIssue({ code: 'custom', message: 'Mismatched report session', path: ['report'] });
    if (value.history.some((item) => item.sessionId !== value.sessionId))
      context.addIssue({
        code: 'custom',
        message: 'Mismatched history session',
        path: ['history'],
      });
    if (
      value.totalHistory !== (value.report?.revision ?? 0) ||
      value.history.length !== Math.min(value.totalHistory, 100) ||
      value.history.some((item, index) => item.revision !== value.totalHistory - index) ||
      (value.report !== null && JSON.stringify(value.history[0]) !== JSON.stringify(value.report))
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid report history count',
        path: ['totalHistory'],
      });
  });
export type SessionCompletion = z.infer<typeof sessionCompletionSchema>;
export type SessionCompletionCommand = z.infer<typeof sessionCompletionCommandSchema>;
export type SessionCompletionResult = z.infer<typeof sessionCompletionResultSchema>;
export type SessionCompletionList = z.infer<typeof sessionCompletionListSchema>;
export type SessionCompletionRead = z.infer<typeof sessionCompletionReadSchema>;

/** Active user confirmations fix scheduling identity; they never create an actual activity. */
export function preservesSessionCompletions(
  plan: PlanDraft,
  reports: SessionCompletion[],
): boolean {
  const sessions = new Map(plan.sessions.map((session) => [session.id, session]));
  return reports.every((report) => {
    if (report.status === 'retracted') return true;
    const session = sessions.get(report.sessionId);
    return (
      session !== undefined &&
      session.blockId === report.schedule.blockId &&
      session.date === report.schedule.date &&
      session.localStartTime === report.schedule.localStartTime &&
      plan.timezone === report.schedule.timezone
    );
  });
}
