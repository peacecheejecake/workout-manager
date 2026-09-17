import { useQuery } from '@tanstack/react-query';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { sessionDistanceBounds, type PlanSnapshot } from '@workout/contracts/planning';
import { sessionActualsSchema } from '@workout/contracts/session-actuals';

export function useSessionActuals({
  athleteId,
  sessionId,
  transport,
  head,
}: {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  head: PlanSnapshot | null | undefined;
}) {
  return useQuery({
    queryKey: ['planning-session-actuals', athleteId, sessionId, head?.id ?? null],
    enabled: head != null,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!head) throw new Error('UNAVAILABLE');
      const response = transportReplySchema.parse(
        await transport.request({
          path: `/bff/v1/plans/versions/${encodeURIComponent(head.id)}/session-actuals`,
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (response.status !== 200) throw new Error('READ_FAILED');
      const result = sessionActualsSchema.parse(response.body);
      const expected = new Map(
        head.draft.sessions.map((session) => [session.id, sessionDistanceBounds(session)]),
      );
      if (
        result.planVersion.id.toLowerCase() !== head.id.toLowerCase() ||
        result.planVersion.version !== head.version ||
        result.sessions.length !== expected.size ||
        result.sessions.some((session) => {
          if (!expected.has(session.sessionId)) return true;
          const target = expected.get(session.sessionId);
          return target == null
            ? session.distanceTarget !== null
            : session.distanceTarget?.minMeters !== target.min ||
                session.distanceTarget.maxMeters !== target.max;
        })
      )
        throw new Error('MISMATCH');
      return result;
    },
  });
}
