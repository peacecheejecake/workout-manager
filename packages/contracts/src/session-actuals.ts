import { z } from 'zod';
import { idSchema, instantSchema } from './primitives.js';
import { distanceRangeSchema } from './planning.js';
import { dashboardActualSchema } from './dashboard.js';

export const sessionActualsDefinition = {
  version: 'session-actuals-v1',
  actual:
    '조회한 저장 버전과 세션에 명시적으로 연결된 현재 활동을 한 번씩 합산합니다. 날짜로 연결하지 않습니다.',
  comparison:
    '알려진 연결 거리 전체와 저장된 목표를 비교합니다. 일부 거리 미보고 시 확정 차이를 계산하지 않습니다.',
  duration:
    '시간은 정의별로 구분합니다. 계획 시간의 측정 정의가 없어 시간 차이를 계산하지 않습니다.',
  coverage: '연결된 자료의 수집 완전성은 미확인입니다. 연결 없음은 미수행·휴식·0이 아닙니다.',
} as const;
export const sessionActualsQuerySchema = z.strictObject({
  planVersionId: z.uuid().transform((value) => value.toLowerCase()),
});
export const sessionActualSchema = z.strictObject({
  sessionId: idSchema.max(200),
  distanceTarget: distanceRangeSchema.nullable(),
  actual: dashboardActualSchema,
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const sessionActualsSchema = z
  .strictObject({
    definitionVersion: z.literal('session-actuals-v1'),
    observedAt: instantSchema,
    planVersion: z.strictObject({
      id: z.uuid(),
      version: z.number().int().positive(),
      title: z.string().min(1).max(200),
    }),
    currentPlanVersionId: z.uuid().nullable(),
    sessions: z.array(sessionActualSchema).max(1000),
    activityDataRevision: z.strictObject({
      count,
      revisionSum: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    }),
    coverage: z.literal('unknown'),
  })
  .superRefine((value, context) => {
    if (new Set(value.sessions.map((session) => session.sessionId)).size !== value.sessions.length)
      context.addIssue({
        code: 'custom',
        message: 'Duplicate session actuals',
        path: ['sessions'],
      });
    if (
      value.sessions.reduce((sum, session) => sum + session.actual.count, 0) >
      value.activityDataRevision.count
    )
      context.addIssue({
        code: 'custom',
        message: 'Linked activities exceed canonical rows',
        path: ['activityDataRevision'],
      });
  });
export type SessionActualsQuery = z.infer<typeof sessionActualsQuerySchema>;
export type SessionActual = z.infer<typeof sessionActualSchema>;
export type SessionActuals = z.infer<typeof sessionActualsSchema>;

export type SessionDistanceComparison =
  | { status: 'no_linked_activities' | 'missing_actual' | 'partial_actual' | 'missing_target' }
  | { status: 'exact'; deltaMeters: number }
  | { status: 'range'; position: 'below' | 'within' | 'above'; distanceToRangeMeters: number };
export function compareSessionDistance(session: SessionActual): SessionDistanceComparison {
  const { actual, distanceTarget } = session;
  if (actual.count === 0) return { status: 'no_linked_activities' };
  if (actual.distanceMeters.value === null) return { status: 'missing_actual' };
  if (actual.distanceMeters.missingCount > 0) return { status: 'partial_actual' };
  if (distanceTarget === null) return { status: 'missing_target' };
  const value = actual.distanceMeters.value;
  if (distanceTarget.minMeters === distanceTarget.maxMeters)
    return { status: 'exact', deltaMeters: value - distanceTarget.minMeters };
  return value < distanceTarget.minMeters
    ? {
        status: 'range',
        position: 'below',
        distanceToRangeMeters: value - distanceTarget.minMeters,
      }
    : value > distanceTarget.maxMeters
      ? {
          status: 'range',
          position: 'above',
          distanceToRangeMeters: value - distanceTarget.maxMeters,
        }
      : { status: 'range', position: 'within', distanceToRangeMeters: 0 };
}
