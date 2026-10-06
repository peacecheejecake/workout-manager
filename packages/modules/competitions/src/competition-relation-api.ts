import type { z } from 'zod';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { planReadSchema } from '@workout/contracts/planning';
import { courseListSchema } from '@workout/contracts/courses';
import { activityListQuerySchema, activityListSchema } from '@workout/contracts/activity';
import type { CompetitionRelations } from './competition-workspace';

export class CompetitionRelationError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'INVALID_RESPONSE') {
    super(code);
    this.name = 'CompetitionRelationError';
  }
}
export interface RelationCatalog<T> {
  choices: readonly T[];
  /** The bounded response's count, never proof of all historical choices. */
  total: number;
}
type Choice<K extends keyof CompetitionRelations> = NonNullable<CompetitionRelations[K]>[number];
const safeLabel = (value: string, fallback: string): string =>
  value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 400) || fallback;
function unique(ids: readonly string[]) {
  if (new Set(ids).size !== ids.length) throw new CompetitionRelationError('INVALID_RESPONSE');
}
const kindLabels = {
  running: '달리기',
  cycling: '자전거',
  walking: '걷기',
  strength: '근력 운동',
  other: '기타 실제 활동',
  unknown: '실제 활동',
} as const;
const activityQuery = activityListQuerySchema.parse({
  limit: 100,
  offset: 0,
  sort: 'started_desc',
});
const activityPath = `/bff/v1/activities?${new URLSearchParams(
  Object.entries(activityQuery).map(([key, value]) => [key, String(value)]),
)}`;

export function createCompetitionRelationApi(transport: AuthenticatedTransport) {
  async function read<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const raw = await transport.request({
      path,
      method: 'GET',
      body: null,
      idempotencyKey: null,
      signal,
    });
    signal.throwIfAborted();
    const reply = transportReplySchema.safeParse(raw);
    if (!reply.success) throw new CompetitionRelationError('INVALID_RESPONSE');
    if (reply.data.status !== 200) throw new CompetitionRelationError('UNAVAILABLE');
    const body = schema.safeParse(reply.data.body);
    if (!body.success) throw new CompetitionRelationError('INVALID_RESPONSE');
    return body.data;
  }
  return {
    async plans(signal: AbortSignal): Promise<RelationCatalog<Choice<'plans'>>> {
      const data = await read('/bff/v1/plans/current', planReadSchema, signal);
      unique(data.history.map((item) => item.id));
      const choices = data.history.map((item) => ({
        id: item.id,
        label: `${safeLabel(item.title, '저장된 계획')} · 계획 v${item.version}`,
      }));
      if (data.head && !choices.some((item) => item.id === data.head?.id))
        choices.unshift({
          id: data.head.id,
          label: `${safeLabel(data.head.draft.title, '현재 계획')} · 계획 v${data.head.version}`,
        });
      return { choices: choices.slice(0, 100), total: Math.min(choices.length, 100) };
    },
    async courses(signal: AbortSignal): Promise<RelationCatalog<Choice<'courses'>>> {
      const data = await read('/bff/v1/courses', courseListSchema, signal);
      unique(data.courses.map((item) => item.courseId));
      if (data.total !== data.courses.length)
        throw new CompetitionRelationError('INVALID_RESPONSE');
      return {
        total: data.total,
        choices: data.courses.flatMap((item) =>
          item.status === 'available'
            ? [
                {
                  ref: {
                    courseId: item.courseId,
                    courseRevision: item.headRevision,
                    revisionId: item.revisionId,
                  },
                  label: `${safeLabel(item.name, '저장된 코스')} · 버전 ${item.headRevision}`,
                },
              ]
            : [],
        ),
      };
    },
    async activities(signal: AbortSignal): Promise<RelationCatalog<Choice<'activities'>>> {
      const data = await read(activityPath, activityListSchema, signal);
      unique(data.items.map((item) => item.id));
      if (data.items.length !== Math.min(activityQuery.limit, data.total))
        throw new CompetitionRelationError('INVALID_RESPONSE');
      return {
        total: data.total,
        choices: data.items.map((item) => {
          const values = item.effective;
          const date =
            values.startedAt !== null && values.timezone !== null
              ? new Intl.DateTimeFormat('ko-KR', {
                  timeZone: values.timezone,
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                }).format(new Date(values.startedAt))
              : '날짜 미상';
          return {
            id: item.id,
            label: `${safeLabel(values.title ?? '', kindLabels[values.kind])} · ${date}`,
          };
        }),
      };
    },
  };
}
