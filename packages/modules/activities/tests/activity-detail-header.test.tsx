import '@testing-library/jest-dom/vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { ActivityBrowser } from '../src/activity-browser';

/**
 * S09 header (01_product_screen_spec §7.2): "S09 상단은 출처·관측 시각·정정 여부와 …
 * 요약이다". Each of the three is asserted against what the server answered, so a header
 * that dropped one, took a client clock, or always said "no correction" fails here.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
const values = {
  title: '상단 요약 활동',
  kind: 'running' as const,
  startedAt: '2026-09-15T23:30:00+09:00',
  timezone: 'Asia/Seoul',
  durationSeconds: 600,
  durationKind: 'elapsed' as const,
  distanceMeters: 2000,
};
const base: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 1,
  source: { kind: 'fit', sourceId: 'source-header', revision: 3, contentHash: 'e'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
};
const corrected: Activity = {
  ...base,
  revision: 2,
  effective: { ...values, distanceMeters: 2100 },
  overlay: { distanceMeters: 2100 },
};
const read = (activity: Activity): ActivityDetailsRead => ({
  activityId: activity.id,
  activityRevision: activity.revision,
  source: activity.source,
  details: null,
});

function setup(answers: { activity: Activity; observedAt: string }[]) {
  let current = 0;
  const request = vi.fn((input: TransportRequest) => {
    const answer = answers[Math.min(current, answers.length - 1)];
    if (!answer) throw new Error('no answer');
    if (input.path === '/bff/v1/plans/current')
      return Promise.resolve(reply({ head: null, history: [] }));
    if (input.path.includes('?')) return Promise.resolve(reply({ items: [], total: 0 }));
    if (input.path.endsWith('/context'))
      return Promise.resolve(
        reply({
          definitionVersion: 'activity-context-v1',
          observedAt: answer.observedAt,
          activity: answer.activity,
          activityDataRevision: { count: 1, revisionSum: String(answer.activity.revision) },
          planContext: { status: 'unlinked' },
        }),
      );
    if (input.path.endsWith('/details')) return Promise.resolve(reply(read(answer.activity)));
    return Promise.resolve(reply({ error: { code: 'NOT_FOUND' } }, 404));
  });
  render(
    <ActivityBrowser
      athleteId="alice"
      sessionId="session-a"
      transport={{ request }}
      search={`selected=${base.id}`}
      onSearchChange={vi.fn()}
      initialTimezone="Asia/Seoul"
      importHref="/activities/import"
    />,
  );
  return {
    request,
    next() {
      current += 1;
    },
  };
}

const header = () => screen.getByRole('region', { name: '활동 요약 출처' });

describe('S09 detail header', () => {
  it('names the source, the server observation time and that nothing was corrected', async () => {
    const observedAt = '2026-09-16T00:00:07.123Z';
    const { request } = setup([{ activity: base, observedAt }]);
    const region = await screen.findByRole('region', { name: '활동 요약 출처' });
    expect(region).toHaveTextContent('출처 FIT · 원본 수정 3 · 기록 수정 1 · 사용자 정정 없음');
    expect(region).toHaveTextContent('출처 식별자: source-header');
    const time = within(region).getByText(observedAt);
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', observedAt);
    // The observation time is the server's stamp, not the activity's own start.
    expect(region).not.toHaveTextContent(values.startedAt);
    // Reading the header writes nothing.
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('says a correction exists once the server reports an overlay and follows the new observation', async () => {
    const user = userEvent.setup();
    const { next } = setup([
      { activity: base, observedAt: '2026-09-16T00:00:00Z' },
      { activity: corrected, observedAt: '2026-09-16T00:05:00Z' },
    ]);
    expect(await screen.findByRole('region', { name: '활동 요약 출처' })).toHaveTextContent(
      '사용자 정정 없음',
    );
    next();
    await act(async () => {
      await user.click(screen.getByRole('button', { name: '활동 상세 다시 확인' }));
    });
    expect(await screen.findByText('2026-09-16T00:05:00Z')).toHaveAttribute(
      'datetime',
      '2026-09-16T00:05:00Z',
    );
    expect(header()).toHaveTextContent('출처 FIT · 원본 수정 3 · 기록 수정 2 · 사용자 정정 있음');
    expect(header()).not.toHaveTextContent('2026-09-16T00:00:00Z');
  });

  it.each([
    ['fixture', '테스트 자료'],
    ['manual', '수동 기록'],
  ] as const)('labels a %s source by name', async (kind, label) => {
    setup([
      {
        activity: { ...base, source: { ...base.source, kind } },
        observedAt: '2026-09-16T00:00:00Z',
      },
    ]);
    expect(await screen.findByRole('region', { name: '활동 요약 출처' })).toHaveTextContent(
      `출처 ${label} · 원본 수정 3`,
    );
  });
});
