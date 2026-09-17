import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  planDraftSchema,
  type PlanSnapshot,
  type PlannedSession,
} from '@workout/contracts/planning';
import { PlanHistoryPanel } from '../src/plan-history-panel';
import { comparePlanHistory } from '../src/plan-history-comparison';

const beforeId = '11111111-1111-4111-8111-111111111111';
const afterId = '22222222-2222-4222-8222-222222222222';
function snapshot(
  patch: Pick<PlannedSession, 'paceTarget' | 'heartRateTarget'> = {},
): PlanSnapshot {
  return {
    id: beforeId,
    version: 1,
    createdAt: '2026-09-01T00:00:00Z',
    draft: planDraftSchema.parse({
      title: 'Synthetic target history',
      timezone: 'UTC',
      periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
        id: level,
        parentId: index === 0 ? null : levels[index - 1],
        level,
        title: level,
        startDate: '2026-09-01',
        endDateExclusive: '2026-10-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'run',
          blockId: 'block',
          date: '2026-09-17',
          localStartTime: null,
          title: '합성 비교 세션',
          sport: 'running',
          durationSeconds: null,
          distanceMeters: 0,
          targetRpe: 0,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
          ...patch,
        },
      ],
    }),
  };
}
describe('session pace and HR immutable history display', () => {
  it.each([
    {
      patch: {
        paceTarget: { minSecondsPerKm: 300.125, maxSecondsPerKm: 360.25 },
        heartRateTarget: { minBpm: 120, maxBpm: 150 },
      },
      pace: '300.125–360.25 초/km',
      heartRate: '120–150 bpm',
    },
    {
      patch: { paceTarget: null, heartRateTarget: null },
      pace: '미지정 (명시적으로 비움)',
      heartRate: '미지정 (명시적으로 비움)',
    },
    {
      patch: {
        paceTarget: { minSecondsPerKm: 300, maxSecondsPerKm: 300 },
        heartRateTarget: { minBpm: 150, maxBpm: 150 },
      },
      pace: '300 초/km',
      heartRate: '150 bpm',
    },
  ])(
    'compares legacy absence against explicit $pace / $heartRate without changing the source snapshots',
    async ({ patch, pace, heartRate }) => {
      const before = snapshot();
      const after = { ...snapshot(patch), id: afterId, version: 2 };
      const originalBefore = structuredClone(before);
      const originalAfter = structuredClone(after);
      const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) =>
        transportReplySchema.parse({
          status: 200,
          body: input.path.endsWith(beforeId) ? before : after,
          traceId: 'synthetic',
        }),
      );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      render(
        <QueryClientProvider client={client}>
          <PlanHistoryPanel
            athleteId="alice"
            sessionId="auth-session"
            transport={{ request }}
            search={`compareFrom=${beforeId}&compareTo=${afterId}`}
            onSearchChange={() => {}}
            current={{ head: after, history: [] }}
          />
        </QueryClientProvider>,
      );
      const row = await screen.findByText(/^세션 합성 비교 세션 ·/);
      await userEvent.click(row);
      const oldValues = screen.getByRole('region', { name: '이전 세션' });
      const newValues = screen.getByRole('region', { name: '이후 세션' });
      expect(
        within(oldValues).getByText('목표 페이스: 미지정 (이전 형식에 값 없음)'),
      ).toBeVisible();
      expect(within(oldValues).getByText('목표 심박: 미지정 (이전 형식에 값 없음)')).toBeVisible();
      expect(within(newValues).getByText(`목표 페이스: ${pace}`)).toBeVisible();
      expect(within(newValues).getByText(`목표 심박: ${heartRate}`)).toBeVisible();
      expect(newValues).toHaveTextContent('목표 RPE 0');
      const comparison = comparePlanHistory(before, after, null);
      expect(comparison.sessions.find((session) => session.id === 'run')?.status).toBe('changed');
      expect(before).toEqual(originalBefore);
      expect(after).toEqual(originalAfter);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    },
  );
});
