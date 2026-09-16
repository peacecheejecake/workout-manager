import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  idSchema,
  instantSchema,
  nonEmptyStringSchema,
  nonNegativeNumberSchema,
} from '@workout/contracts/primitives';

/** M0 shell fixture DTO, not a provider/canonical activity ingestion contract. */
export const activityListSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: idSchema,
        title: nonEmptyStringSchema,
        startedAt: instantSchema,
        durationSeconds: nonNegativeNumberSchema.nullable(),
        source: z.literal('fixture'),
      }),
    )
    .max(100)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      'Duplicate activity IDs',
    ),
});
export type ActivityListReply = z.infer<typeof activityListSchema>;
export interface ActivityQueryScope {
  userId: string;
  workspaceId: string;
  sessionId: string;
}
export function activityListQueryOptions(
  scope: ActivityQueryScope,
  transport: AuthenticatedTransport,
) {
  return queryOptions({
    queryKey: [
      'users',
      scope.userId,
      'workspaces',
      scope.workspaceId,
      'sessions',
      scope.sessionId,
      'activities',
    ],
    queryFn: async ({ signal }): Promise<ActivityListReply> => {
      const result: unknown = await transport.request({
        path: '/bff/v1/activities',
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      const reply = transportReplySchema.safeParse(result);
      if (!reply.success || reply.data.status !== 200) throw new Error('ACTIVITIES_UNAVAILABLE');
      const body = activityListSchema.safeParse(reply.data.body);
      if (!body.success) throw new Error('ACTIVITIES_INVALID_RESPONSE');
      return body.data;
    },
  });
}
