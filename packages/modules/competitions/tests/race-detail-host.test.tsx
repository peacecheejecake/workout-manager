import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { RaceEventDetailHost } from '../src/race-detail-host';

afterEach(cleanup);
const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const at = '2026-10-01T00:00:00Z';
const event = {
  id,
  revision: 1,
  title: '가을 대회',
  localDate: '2026-10-10',
  localStartTime: null,
  timezone: 'Asia/Seoul',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: { courseId: other, courseRevision: 2, revisionId: id },
  targetSeconds: null,
  planVersionId: other,
};
const course = {
  status: 'available',
  courseId: other,
  name: '강변 코스',
  visibility: 'private',
  headRevision: 2,
  revisionId: id,
  createdAt: at,
  updatedAt: at,
};
function reply(body: unknown, status = 200) {
  return transportReplySchema.parse({ body, status, traceId: null });
}
function body(path: string) {
  if (path === '/bff/v1/race-date-change-reviews/capabilities?maxSchemaVersion=2')
    return { schemaVersion: 1, dateChangeReviews: false };
  return path.includes('/plans')
    ? { head: null, history: [{ id: other, version: 3, createdAt: at, title: '가을 계획' }] }
    : path.includes('/courses')
      ? { courses: [course], total: 1 }
      : event;
}
function view(
  transport: AuthenticatedTransport,
  sessionId = 'a',
  athleteId: string | null = 'alice',
  raceId = id,
) {
  return (
    <RaceEventDetailHost
      athleteId={athleteId}
      sessionId={sessionId}
      transport={transport}
      raceId={raceId}
    />
  );
}
it('starts detail and both actual catalogs in parallel and displays exact named frozen references', async () => {
  const pending: (() => void)[] = [];
  const request = vi.fn<AuthenticatedTransport['request']>(
    (input) => new Promise((resolve) => pending.push(() => resolve(reply(body(input.path))))),
  );
  render(view({ request }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  expect(request.mock.calls.map(([input]) => input.path).sort()).toEqual(
    [
      '/bff/v1/courses',
      '/bff/v1/plans/current',
      `/bff/v1/races/${id}`,
      '/bff/v1/race-date-change-reviews/capabilities?maxSchemaVersion=2',
    ].sort(),
  );
  await act(async () => {
    pending.forEach((resolve) => resolve());
  });
  expect(await screen.findByText(/가을 계획 · 계획 v3/)).toBeVisible();
  expect(screen.getByText(/강변 코스 · 버전 2/)).toBeVisible();
  expect(document.body.textContent).not.toContain(id);
  expect(document.body.textContent).not.toContain(other);
  expect(request.mock.calls.some(([input]) => input.path.includes('activities'))).toBe(false);
});
it('localizes malformed catalogs, preserves missing old references and retries only the failed catalog', async () => {
  let failed = true;
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    input.path.includes('/courses')
      ? reply(
          failed
            ? { courses: [{ ...course, headRevision: 'invalid' }], total: 1 }
            : { courses: [{ ...course, headRevision: 3, revisionId: other }], total: 1 },
        )
      : reply(body(input.path)),
  );
  render(view({ request }));
  expect(
    await screen.findByText('코스 목록을 불러오지 못했습니다. 기존 연결은 유지됩니다.'),
  ).toBeVisible();
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  expect(screen.getByLabelText('고정 버전 코스')).toBeDisabled();
  failed = false;
  await userEvent.click(screen.getByRole('button', { name: '코스 목록 다시 시도' }));
  await waitFor(() => expect(screen.getByLabelText('고정 버전 코스')).not.toBeDisabled());
  expect(screen.getByLabelText('고정 버전 코스')).toHaveValue(id);
  expect(screen.getByRole('option', { name: /기존 고정 버전 코스/ })).toBeInTheDocument();
  expect(request.mock.calls.filter(([input]) => input.path.includes('/plans'))).toHaveLength(1);
  expect(request.mock.calls.filter(([input]) => input.path.includes('/races/'))).toHaveLength(1);
});
it('selects a current catalog tuple explicitly and sends strict PATCH without a plan write', async () => {
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    input.method === 'PATCH'
      ? reply({ id, revision: 2 })
      : reply(
          input.path.includes('/courses')
            ? { courses: [{ ...course, headRevision: 3, revisionId: other }], total: 1 }
            : body(input.path),
        ),
  );
  render(view({ request }));
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  const next = { courseId: other, courseRevision: 3, revisionId: other };
  await userEvent.selectOptions(screen.getByLabelText('고정 버전 코스'), other);
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('저장이 서버에 반영되었습니다 (revision 2).');
  const writes = request.mock.calls.filter(([input]) => input.method !== 'GET');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.[0].body).toMatchObject({
    expectedRevision: 1,
    values: { course: next, planVersionId: other },
  });
});
it.each(['account', 'session'] as const)(
  'aborts both catalogs and ignores late responses on %s change',
  async (kind) => {
    const pending: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    const old = vi.fn<AuthenticatedTransport['request']>(
      (input) =>
        new Promise((resolve) => {
          if (!input.signal) throw Error('NO_SIGNAL');
          signals.push(input.signal);
          pending.push(() => resolve(reply(body(input.path))));
        }),
    );
    const fresh = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      reply(
        input.path.includes('/plans')
          ? { head: null, history: [] }
          : input.path.includes('/courses')
            ? { courses: [], total: 0 }
            : { ...event, title: '새 세션 대회', course: null, planVersionId: null },
      ),
    );
    const rendered = render(view({ request: old }));
    await waitFor(() => expect(old).toHaveBeenCalledTimes(4));
    rendered.rerender(
      view(
        { request: fresh },
        kind === 'session' ? 'b' : 'a',
        kind === 'account' ? 'bob' : 'alice',
      ),
    );
    expect(await screen.findByText('새 세션 대회')).toBeVisible();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      pending.forEach((resolve) => resolve());
    });
    expect(screen.queryByText(/가을 계획/)).not.toBeInTheDocument();
    expect(screen.queryByText(/강변 코스/)).not.toBeInTheDocument();
    expect(screen.queryByText('가을 대회')).not.toBeInTheDocument();
  },
);
it('does not fetch catalogs or details outside an authenticated valid selection', () => {
  const request = vi.fn<AuthenticatedTransport['request']>();
  const rendered = render(view({ request }, 'a', null));
  expect(screen.getByText(/로그인 후/)).toBeVisible();
  rendered.rerender(view({ request }, 'a', 'alice', 'invalid'));
  expect(screen.getByRole('alert')).toHaveTextContent('대회 주소가 올바르지 않습니다.');
  expect(request).not.toHaveBeenCalled();
});

it('detects an unsaved immutable course tuple selection before back and preserves it on continue', async () => {
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    reply(
      input.path.includes('/courses')
        ? { courses: [{ ...course, headRevision: 3, revisionId: other }], total: 1 }
        : body(input.path),
    ),
  );
  const onBack = vi.fn();
  render(
    <RaceEventDetailHost
      athleteId="alice"
      sessionId="a"
      raceId={id}
      transport={{ request }}
      onBack={onBack}
    />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.selectOptions(screen.getByLabelText('고정 버전 코스'), other);
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(onBack).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '계속 편집' }));
  expect(screen.getByLabelText('고정 버전 코스')).toHaveValue(other);
  expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
});

it('loads actual capabilities and strict current PlanRead only when date review is opened', async () => {
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    reply(
      input.path.includes('/capabilities')
        ? { schemaVersion: 1, dateChangeReviews: true }
        : input.path.includes('/plans')
          ? { head: null, history: [] }
          : input.path.includes('/courses')
            ? { courses: [], total: 0 }
            : { ...event, planVersionId: null },
    ),
  );
  render(view({ request }));
  await userEvent.click(await screen.findByRole('button', { name: '대회 날짜 변경 검토' }));
  expect(
    await screen.findByText('현재 훈련 계획 없음. 계획 유지 방식만 선택할 수 있습니다.'),
  ).toBeVisible();
  expect(request.mock.calls.filter(([r]) => r.path === '/bff/v1/plans/current')).toHaveLength(2);
  expect(screen.getByRole('button', { name: '대회 편집' })).toBeDisabled();
  expect(request.mock.calls.every(([r]) => r.method === 'GET')).toBe(true);
});
it('keeps unknown/malformed capabilities closed without constructing date writes', async () => {
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    reply(
      input.path.includes('/capabilities')
        ? { schemaVersion: 1, dateChangeReviews: true, authority: true }
        : body(input.path),
    ),
  );
  render(view({ request }));
  await userEvent.click(await screen.findByRole('button', { name: '대회 날짜 변경 검토' }));
  expect(await screen.findByText('대회 날짜 변경 검토 지원을 확인할 수 없습니다.')).toBeVisible();
  expect(screen.queryByLabelText('새 대회 날짜')).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([r]) => r.path.includes('/plans'))).toHaveLength(1);
});
it('rejects catalog-shaped current plans in the review loader instead of fabricating a PlanRead', async () => {
  let reads = 0;
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    reply(
      input.path.includes('/capabilities')
        ? { schemaVersion: 1, dateChangeReviews: true }
        : input.path.includes('/plans')
          ? ++reads === 1
            ? { head: null, history: [] }
            : { choices: [], total: 0 }
          : input.path.includes('/courses')
            ? { courses: [], total: 0 }
            : event,
    ),
  );
  render(view({ request }));
  await userEvent.click(await screen.findByRole('button', { name: '대회 날짜 변경 검토' }));
  expect(
    await screen.findByText('현재 계획을 확인할 수 없어 검토를 시작하지 않습니다.'),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: '전체 영향 검토' })).toBeDisabled();
  expect(request.mock.calls.every(([r]) => r.method === 'GET')).toBe(true);
});

it('refreshes actual detail and relation plans only after explicit server commit', async () => {
  const candidateId = '10000000-0000-4000-8000-000000000009';
  const reference = {
    schemaVersion: 1,
    candidateId,
    applicationDigest: 'a'.repeat(64),
    chain: {
      evidenceId: '10000000-0000-4000-8000-000000000003',
      decisionId: '10000000-0000-4000-8000-000000000004',
      proposalId: '10000000-0000-4000-8000-000000000005',
      readonlyCandidateDigest: 'b'.repeat(64),
    },
    createdAt: at,
  };
  const before = {
    title: event.title,
    localDate: event.localDate,
    localStartTime: null,
    timezone: event.timezone,
    distance: event.distance,
    priority: null,
    participation: event.participation,
    targetSeconds: null,
  };
  let approved = false;
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (input.path.includes('/capabilities'))
      return reply({ schemaVersion: 1, dateChangeReviews: true });
    if (input.path.endsWith('/approve')) {
      approved = true;
      return reply({
        schemaVersion: 1,
        status: 'committed',
        candidateId,
        approvalId: '10000000-0000-4000-8000-000000000006',
        proposalId: reference.chain.proposalId,
        approvedAt: at,
        race: { eventId: id, revision: 2 },
        versions: [],
        occurrenceIds: [],
        notices: [],
      });
    }
    if (input.method === 'POST')
      return reply({ status: 'reviewed', reference, bodyState: 'present' }, 201);
    if (input.path === `/bff/v1/race-date-change-reviews/${candidateId}`)
      return reply({
        schemaVersion: 1,
        status: 'present',
        reference,
        storedCandidateState: 'ready_for_explicit_approval',
        beforeBasis: 'frozen_review',
        afterBasis: 'hypothetical_on_approval',
        freshness: 'not_checked_on_read',
        scope: 'whole_affected',
        race: {
          eventId: id,
          expectedRevision: 1,
          before,
          after: { ...before, localDate: '2026-10-11' },
        },
        training: { state: 'absent' },
        nutrition: { state: 'absent' },
        recovery: { state: 'absent' },
        routines: { state: 'absent' },
        retainedUnplanned: [],
        affected: [],
        notices: [],
      });
    if (input.path.includes('/plans')) return reply({ head: null, history: [] });
    if (input.path.includes('/courses')) return reply({ courses: [], total: 0 });
    return reply({
      ...event,
      planVersionId: null,
      revision: approved ? 2 : 1,
      localDate: approved ? '2026-10-11' : event.localDate,
    });
  });
  render(view({ request }));
  await userEvent.click(await screen.findByRole('button', { name: '대회 날짜 변경 검토' }));
  await screen.findByText('현재 훈련 계획 없음. 계획 유지 방식만 선택할 수 있습니다.');
  await userEvent.type(screen.getByLabelText('새 대회 날짜'), '2026-10-11');
  await userEvent.selectOptions(screen.getByLabelText('계획 비교 방식'), 'keep_plan');
  await userEvent.click(screen.getByRole('button', { name: '전체 영향 검토' }));
  const confirm = await screen.findByRole('checkbox');
  expect(request.mock.calls.filter(([r]) => r.path === `/bff/v1/races/${id}`)).toHaveLength(1);
  expect(approved).toBe(false);
  await userEvent.click(confirm);
  await userEvent.click(screen.getByRole('button', { name: '계획 변경 승인' }));
  await waitFor(() =>
    expect(request.mock.calls.filter(([r]) => r.path === `/bff/v1/races/${id}`)).toHaveLength(2),
  );
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([r]) => r.path === '/bff/v1/plans/current').length,
    ).toBeGreaterThanOrEqual(3),
  );
  expect(screen.getByText(/^2026-10-11 · 출발 시간 미상/)).toBeVisible();
  expect(request.mock.calls.some(([r]) => r.method === 'PATCH')).toBe(false);
});
