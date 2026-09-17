import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema } from '@workout/contracts/core';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { useSessionActuals } from '../src/use-session-actuals';

const head = planSnapshotSchema.parse({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  version: 1,
  createdAt: '2026-09-17T00:00:00Z',
  draft: {
    title: 'Saved',
    timezone: 'UTC',
    periods: [
      {
        id: 'season',
        parentId: null,
        level: 'season',
        title: 'Season',
        startDate: '2026-09-01',
        endDateExclusive: '2026-10-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      },
    ],
    sessions: [],
  },
});
const body = {
  definitionVersion: 'session-actuals-v1',
  observedAt: head.createdAt,
  planVersion: { id: head.id, version: 1, title: head.draft.title },
  currentPlanVersionId: head.id,
  sessions: [],
  activityDataRevision: { count: 0, revisionSum: '0' },
  coverage: 'unknown',
};
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
describe('saved session actuals query', () => {
  it.each(['missing', 'unknown', 'target'] as const)(
    'rejects a schema-valid %s session projection',
    async (kind) => {
      const levels = ['season', 'wave', 'phase', 'block'] as const;
      const saved = planSnapshotSchema.parse({
        ...head,
        draft: {
          ...head.draft,
          periods: levels.map((level, index) => ({
            ...head.draft.periods[0],
            id: level,
            level,
            parentId: index === 0 ? null : levels[index - 1],
          })),
          sessions: [
            {
              id: 'run',
              blockId: 'block',
              date: '2026-09-17',
              localStartTime: null,
              title: 'Run',
              sport: 'running',
              durationSeconds: null,
              distanceMeters: 1000,
              purpose: '',
              notes: '',
              priority: 'normal',
              targetRpe: null,
              locks: { date: false, time: false, intensity: false },
              steps: [],
            },
          ],
        },
      });
      const empty = { value: null, knownCount: 0, missingCount: 0 };
      const payload = {
        ...body,
        sessions:
          kind === 'missing'
            ? []
            : [
                {
                  sessionId: kind === 'unknown' ? 'other' : 'run',
                  distanceTarget: { minMeters: kind === 'target' ? 500 : 1000, maxMeters: 1000 },
                  actual: {
                    count: 0,
                    distanceMeters: empty,
                    durationSeconds: {
                      timer: empty,
                      elapsed: empty,
                      moving: empty,
                      unknown: empty,
                    },
                    sources: { fit: 0, fixture: 0, manual: 0 },
                    overlayCount: 0,
                  },
                },
              ],
      };
      const request = vi.fn(async () =>
        transportReplySchema.parse({ status: 200, body: payload, traceId: null }),
      );
      const { result } = renderHook(
        () =>
          useSessionActuals({
            athleteId: 'a',
            sessionId: 'auth',
            transport: { request },
            head: saved,
          }),
        { wrapper: wrapper() },
      );
      await waitFor(() => expect(result.current.error?.message).toBe('MISMATCH'));
      expect(result.current.data).toBeUndefined();
    },
  );
  it.each([
    { ...body, planVersion: { ...body.planVersion, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
    { ...body, planVersion: { ...body.planVersion, version: 2 } },
    { ...body, sessions: [{ sessionId: 'unknown' }] },
  ])('rejects a response for a different saved plan or session projection', async (payload) => {
    const request = vi.fn(async () =>
      transportReplySchema.parse({ status: 200, body: payload, traceId: null }),
    );
    const { result } = renderHook(
      () => useSessionActuals({ athleteId: 'a', sessionId: 'auth', transport: { request }, head }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
  it('scopes results by authenticated user and cancels the previous read on switch', async () => {
    const signals: AbortSignal[] = [];
    const request = vi.fn<Parameters<typeof useSessionActuals>[0]['transport']['request']>(
      async (input) => {
        if (input.signal) signals.push(input.signal);
        return new Promise(() => {});
      },
    );
    const { result, rerender, unmount } = renderHook(
      ({ athleteId }) =>
        useSessionActuals({ athleteId, sessionId: 'auth', transport: { request }, head }),
      { initialProps: { athleteId: 'a' }, wrapper: wrapper() },
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    rerender({ athleteId: 'b' });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.data).toBeUndefined();
    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });
  it('does not request a saved comparison before a plan exists', () => {
    const request = vi.fn();
    renderHook(
      () =>
        useSessionActuals({
          athleteId: 'a',
          sessionId: 'auth',
          transport: { request },
          head: null,
        }),
      { wrapper: wrapper() },
    );
    expect(request).not.toHaveBeenCalled();
  });
});
