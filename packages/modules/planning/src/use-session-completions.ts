import { useQuery } from '@tanstack/react-query';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { sessionCompletionListSchema } from '@workout/contracts/session-completion';

export function useSessionCompletions({
  athleteId,
  sessionId,
  transport,
  planVersionId,
}: {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  planVersionId: string | null;
}) {
  return useQuery({
    queryKey: ['planning-completions', athleteId, sessionId, planVersionId],
    enabled: planVersionId !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = transportReplySchema.parse(
        await transport.request({
          path: '/bff/v1/plans/current/session-completions',
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (response.status !== 200) throw new Error('SESSION_COMPLETIONS_READ_FAILED');
      return sessionCompletionListSchema.parse(response.body);
    },
  });
}
