import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import { raceEventSchema, raceResultSchema, trainingBestSchema } from '@workout/contracts/races';
import { fixtureServer } from '@workout/tooling/test-setup';
import { CompetitionWorkspace } from '../src/competition-workspace';
import { createRaceApi, RaceRequestError } from '../src/race-api';
import {
  eventDraft,
  parseEvent,
  resultDraft,
  parseResult,
  bestDraft,
  parseBest,
} from '../src/race-forms';

const id = '10000000-0000-4000-8000-000000000001';
const event = raceEventSchema.parse({
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
  course: null,
  targetSeconds: 0,
  planVersionId: 'plan-version-1',
});
const result = raceResultSchema.parse({
  kind: 'race-result',
  id,
  revision: 1,
  raceEventId: id,
  localDate: '2026-10-10',
  timezone: 'Asia/Seoul',
  source: {
    kind: 'official',
    authority: '공식 주최자',
    resultUrl: 'https://example.test/results',
    verifiedAt: null,
  },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: 10000,
  deviceDistanceMeters: null,
  linkedActivityId: id,
  weatherNote: null,
});
const best = trainingBestSchema.parse({
  kind: 'training-best',
  id,
  revision: 1,
  observedAt: '2026-10-10T03:00:00.000Z',
  source: { kind: 'activity', activityId: id },
  basis: 'device-estimated-split',
  distanceMeters: 10000,
  elapsedSeconds: 0,
});
function page(kind: string, items: unknown[] = [], nextCursor: unknown = null) {
  return {
    schemaVersion: 1,
    kind,
    sort: 'id-asc',
    collection: items.length ? { revision: 1, privacyGeneration: '0' } : null,
    items,
    nextCursor,
  };
}
function transport(
  handler: (
    request: TransportRequest,
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): AuthenticatedTransport {
  return {
    request: async (request) =>
      transportReplySchema.parse({ ...(await handler(request)), traceId: null }),
  };
}
function lists(request: TransportRequest) {
  const family = request.path.includes('/race-results')
    ? 'race-result'
    : request.path.includes('/training-bests')
      ? 'training-best'
      : 'race-event';
  return {
    status: 200,
    body: page(
      family,
      family === 'race-event' ? [event] : family === 'race-result' ? [result] : [best],
    ),
  };
}
function view(
  api: AuthenticatedTransport,
  athleteId: string | null = 'athlete',
  sessionId = 'session',
) {
  return (
    <CompetitionWorkspace
      athleteId={athleteId}
      sessionId={sessionId}
      transport={api}
      newCommandKey={() => 'fixed_command_key'}
    />
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('keeps every canonical field, null/zero, immutable course ref and server verification separate', () => {
  const course = { courseId: id, courseRevision: 4, revisionId: id };
  expect(
    parseEvent(
      eventDraft({
        ...event,
        course,
        distance: { kind: 'custom', label: '언덕', nominalMeters: null },
        localStartTime: '07:30:00',
        priority: 'A',
        officialUrl: 'https://example.test',
        locationName: '출발점',
      }),
    ),
  ).toEqual(
    expect.objectContaining({
      course,
      targetSeconds: 0,
      planVersionId: 'plan-version-1',
      distance: { kind: 'custom', label: '언덕', nominalMeters: null },
    }),
  );
  expect(parseResult(resultDraft(result))).toEqual({
    ...result,
    id: undefined,
    revision: undefined,
    source: {
      kind: 'official',
      authority: '공식 주최자',
      resultUrl: 'https://example.test/results',
    },
  });
  expect(parseBest(bestDraft(best))).toEqual(
    expect.objectContaining({
      elapsedSeconds: 0,
      basis: 'device-estimated-split',
      source: { kind: 'activity', activityId: id },
    }),
  );
});

it('MSW transport sends actual routes, strict commands, CAS and idempotency headers for all 3 families', async () => {
  const calls: { method: string; path: string; body: unknown; key: string | null }[] = [];
  fixtureServer.use(
    http.all('http://localhost/bff/v1/:family', async ({ request }) => {
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.method === 'GET' ? null : await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      const family = new URL(request.url).pathname.split('/').at(-1);
      return HttpResponse.json(
        request.method === 'GET'
          ? page(
              family === 'races'
                ? 'race-event'
                : family === 'race-results'
                  ? 'race-result'
                  : 'training-best',
            )
          : { id, revision: 1 },
      );
    }),
    http.all('http://localhost/bff/v1/:family/:id', async ({ request }) => {
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.method === 'GET' ? null : await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      const family = new URL(request.url).pathname.split('/').at(-2);
      return HttpResponse.json(
        request.method === 'GET'
          ? family === 'races'
            ? event
            : family === 'race-results'
              ? result
              : best
          : { id, revision: 2 },
      );
    }),
  );
  const network: AuthenticatedTransport = {
    request: async (input) => {
      const response = await fetch(`http://localhost${input.path}`, {
        method: input.method,
        headers: {
          'content-type': 'application/json',
          ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
        },
        ...(input.body === null ? {} : { body: JSON.stringify(input.body) }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return transportReplySchema.parse({
        status: response.status,
        body: await response.json(),
        traceId: null,
      });
    },
  };
  const api = createRaceApi(network);
  async function exercise<V>(
    family: {
      list: () => Promise<unknown>;
      read: (id: string) => Promise<unknown>;
      create: (input: { values: V; idempotencyKey: string }) => Promise<unknown>;
      update: (
        id: string,
        input: { values: V; expectedRevision: number; idempotencyKey: string },
      ) => Promise<unknown>;
      delete: (
        id: string,
        input: { expectedRevision: number; idempotencyKey: string },
      ) => Promise<unknown>;
    },
    values: V,
  ) {
    await family.list();
    await family.read(id);
    await family.create({ values, idempotencyKey: 'create_key' });
    await family.update(id, { values, expectedRevision: 1, idempotencyKey: 'update_key' });
    await family.delete(id, { expectedRevision: 2, idempotencyKey: 'delete_key' });
  }
  await exercise(api.events, parseEvent(eventDraft(event)));
  await exercise(api.results, parseResult(resultDraft(result)));
  await exercise(api.trainingBests, parseBest(bestDraft(best)));
  expect(calls).toHaveLength(15);
  expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(3);
  for (const call of calls.filter((call) => call.method === 'PATCH')) {
    expect(call.body).toEqual(expect.objectContaining({ expectedRevision: 1 }));
    expect(call.key).toBe('update_key');
    expect(call.body).not.toHaveProperty('idempotencyKey');
    expect(call.body).not.toHaveProperty('athleteId');
  }
});

it('rejects malformed replies, invalid cursor/input and browser supplied verifiedAt before request', async () => {
  const request = vi.fn(lists);
  const api = createRaceApi(transport(request));
  expect(() => api.events.list({ limit: 101 })).toThrow();
  const untrustedValues = {
    ...parseResult(resultDraft(result)),
    source: {
      kind: 'official' as const,
      authority: 'org',
      resultUrl: 'https://example.test',
      verifiedAt: '2026-10-10T00:00:00Z',
    },
  };
  expect(() =>
    api.results.create({ values: untrustedValues, idempotencyKey: 'invalid_key' }),
  ).toThrow();
  expect(request).not.toHaveBeenCalled();
  await expect(
    createRaceApi(transport(() => ({ status: 200, body: { id, revision: 0 } }))).events.create({
      values: parseEvent(eventDraft(event)),
      idempotencyKey: 'command_key',
    }),
  ).rejects.toThrow();
  await expect(
    createRaceApi(
      transport(() => ({ status: 409, body: { error: { code: 'RACE_CURSOR_STALE' } } })),
    ).events.list(),
  ).rejects.toEqual(new RaceRequestError(409, 'RACE_CURSOR_STALE'));
});

it('shows source/verification, zero, missing values and pending PB policy without claiming ranking', async () => {
  render(view(transport(lists)));
  expect(screen.getByText('목표 대회 불러오는 중입니다.')).toBeInTheDocument();
  expect(await screen.findByText('가을 대회')).toBeInTheDocument();
  expect(screen.getByText(/서버 미인증/)).toBeInTheDocument();
  expect(screen.getByText('Chip 0 초 · Gun 미상 초')).toBeInTheDocument();
  expect(screen.getByText(/device-estimated-split/)).toBeInTheDocument();
  expect(screen.getByText('PB 포함 기준 · 정책 미정')).toBeInTheDocument();
});

it('preserves edits and same payload key after network failure and shows success only after commit', async () => {
  const user = userEvent.setup();
  const writes: TransportRequest[] = [];
  let resolve: (value: { status: number; body: unknown }) => void = () => {};
  const api = transport((request) => {
    if (request.method === 'GET') return lists(request);
    writes.push(request);
    if (writes.length === 1) throw new Error('offline');
    return new Promise((done) => {
      resolve = done;
    });
  });
  render(view(api));
  await screen.findByText('가을 대회');
  const section = screen.getByRole('region', { name: '목표 대회' });
  await user.click(within(section).getByRole('button', { name: '편집' }));
  const input = screen.getByLabelText('대회 이름');
  expect(input).toHaveFocus();
  await user.clear(input);
  await user.type(input, '수정 대회');
  await user.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('초안은 유지됩니다');
  expect(input).toHaveValue('수정 대회');
  await user.click(screen.getByRole('button', { name: '저장' }));
  expect(screen.queryByText(/저장이 서버에 반영/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '서버 저장 중…' })).toBeDisabled();
  expect(writes[0]?.idempotencyKey).toBe(writes[1]?.idempotencyKey);
  await act(async () => resolve({ status: 200, body: { id, revision: 2 } }));
  expect(await screen.findByText('저장이 서버에 반영되었습니다 (revision 2).')).toBeInTheDocument();
  expect(writes[1]?.body).toEqual(
    expect.objectContaining({
      expectedRevision: 1,
      values: expect.objectContaining({
        title: '수정 대회',
        targetSeconds: 0,
        planVersionId: 'plan-version-1',
      }),
    }),
  );
});

it.each([
  'RACE_PLAN_IMPACT_REQUIRED',
  'REVISION_CONFLICT',
  'APP_CONSENT_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
])('surfaces %s without dropping the form or applying Plan', async (code) => {
  const user = userEvent.setup();
  const writes: TransportRequest[] = [];
  render(
    view(
      transport((request) => {
        if (request.method === 'GET') return lists(request);
        writes.push(request);
        return { status: 409, body: { error: { code } } };
      }),
    ),
  );
  await screen.findByText('가을 대회');
  await user.click(
    within(screen.getByRole('region', { name: '목표 대회' })).getByRole('button', {
      name: '편집',
    }),
  );
  await user.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByLabelText('대회 이름')).toHaveValue('가을 대회');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe(`/bff/v1/races/${id}`);
});

it('handles cursor stale as partial then explicitly refreshes from the first page', async () => {
  const user = userEvent.setup();
  const cursor = {
    kind: 'race-event',
    collection: { revision: 1, privacyGeneration: '0' },
    afterId: id,
  };
  const requests: TransportRequest[] = [];
  render(
    view(
      transport((request) => {
        requests.push(request);
        if (request.path.includes('cursor='))
          return { status: 409, body: { error: { code: 'RACE_CURSOR_STALE' } } };
        const reply = lists(request);
        return request.path.startsWith('/bff/v1/races?')
          ? { status: 200, body: page('race-event', [event], cursor) }
          : reply;
      }),
    ),
  );
  await screen.findByText('가을 대회');
  await user.click(screen.getByRole('button', { name: '다음 목표 대회 보기' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('일부 목록만');
  expect(screen.getByText('가을 대회')).toBeInTheDocument();
  await user.click(
    within(screen.getByRole('region', { name: '목표 대회' })).getByRole('button', {
      name: '목록 새로고침',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(
    requests.filter((request) => request.path.startsWith('/bff/v1/races?')).at(-1)?.path,
  ).not.toContain('cursor=');
});

it('requires explicit delete confirmation and uses existing revision', async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  render(
    view(
      transport((request) => {
        if (request.method === 'GET') return lists(request);
        remove(request);
        return { status: 200, body: { id, revision: 2 } };
      }),
    ),
  );
  await screen.findByText('가을 대회');
  await user.click(
    within(screen.getByRole('region', { name: '목표 대회' })).getByRole('button', {
      name: '삭제',
    }),
  );
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '삭제 확인' }));
  expect(await screen.findByText('삭제가 서버에 반영되었습니다.')).toBeInTheDocument();
  expect(remove).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'DELETE', body: { expectedRevision: 1 } }),
  );
});

it('drops cache/drafts on account/session change and ignores late successful mutations', async () => {
  const user = userEvent.setup();
  const clear = vi.spyOn(QueryClient.prototype, 'clear');
  let resolve: (value: { status: number; body: unknown }) => void = () => {};
  let pendingSignal: AbortSignal | undefined;
  const old = transport((request) => {
    if (request.method === 'GET') return lists(request);
    pendingSignal = request.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const empty = transport((request) => ({
    status: 200,
    body: page(
      request.path.includes('race-results')
        ? 'race-result'
        : request.path.includes('training-bests')
          ? 'training-best'
          : 'race-event',
    ),
  }));
  const mounted = render(view(old));
  await screen.findByText('가을 대회');
  await user.click(
    within(screen.getByRole('region', { name: '목표 대회' })).getByRole('button', {
      name: '편집',
    }),
  );
  fireEvent.change(screen.getByLabelText('대회 이름'), { target: { value: '비공개 초안' } });
  await user.click(screen.getByRole('button', { name: '저장' }));
  mounted.rerender(view(empty, 'other', 'new-session'));
  expect(await screen.findByText('저장한 목표 대회이 없습니다.')).toBeInTheDocument();
  expect(pendingSignal?.aborted).toBe(true);
  expect(clear).toHaveBeenCalled();
  await act(async () => resolve({ status: 200, body: { id, revision: 2 } }));
  expect(screen.queryByText(/저장이 서버에 반영/)).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue('비공개 초안')).not.toBeInTheDocument();
  mounted.rerender(view(empty, null));
  expect(screen.getByRole('status')).toHaveTextContent('로그인 후');
});

it('shows empty and unavailable states with retry action instead of inventing data', async () => {
  render(
    view(
      transport((request) =>
        request.path.includes('/races?')
          ? { status: 503, body: { error: { code: 'UNAVAILABLE' } } }
          : {
              status: 200,
              body: page(request.path.includes('race-results') ? 'race-result' : 'training-best'),
            },
      ),
    ),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('UNAVAILABLE');
  expect(screen.getByText('저장한 실제 대회 결과이 없습니다.')).toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: '목표 대회' })).getByRole('button', {
      name: '목록 새로고침',
    }),
  ).toBeEnabled();
});

it.each([
  { title: '목표 대회', path: '/bff/v1/races', dateLabel: '현지 날짜', date: '2026-10-10' },
  {
    title: '실제 대회 결과',
    path: '/bff/v1/race-results',
    dateLabel: '현지 날짜',
    date: '2026-10-10',
  },
  {
    title: '훈련 기록',
    path: '/bff/v1/training-bests',
    dateLabel: '관측 시각 (ISO 8601, offset 포함)',
    date: '2026-10-10T03:00:00.000Z',
  },
])(
  'creates $title only through its explicit actual API',
  async ({ title, path, dateLabel, date }) => {
    const user = userEvent.setup();
    const writes: TransportRequest[] = [];
    render(
      view(
        transport((request) => {
          if (request.method === 'GET') return lists(request);
          writes.push(request);
          return { status: 201, body: { id, revision: 1 } };
        }),
      ),
    );
    await screen.findByText('가을 대회');
    await user.click(screen.getByRole('button', { name: `새 ${title} 등록` }));
    if (title === '목표 대회') {
      const input = screen.getByLabelText('대회 이름');
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: '한글 대회' } });
      fireEvent.compositionEnd(input);
      expect(input).toHaveValue('한글 대회');
    }
    fireEvent.change(screen.getByLabelText(dateLabel), { target: { value: date } });
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(
      await screen.findByText('저장이 서버에 반영되었습니다 (revision 1).'),
    ).toBeInTheDocument();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.objectContaining({ path, method: 'POST', idempotencyKey: 'fixed_command_key' }),
    );
  },
);

it('rejects valid DTOs naming a different resource and sanitizes arbitrary error text', async () => {
  const other = '20000000-0000-4000-8000-000000000002';
  await expect(
    createRaceApi(transport(() => ({ status: 200, body: { ...event, id: other } }))).events.read(
      id,
    ),
  ).rejects.toThrow();
  await expect(
    createRaceApi(
      transport(() => ({ status: 200, body: { id: other, revision: 2 } })),
    ).events.update(id, {
      values: parseEvent(eventDraft(event)),
      expectedRevision: 1,
      idempotencyKey: 'update_key',
    }),
  ).rejects.toThrow();
  await expect(
    createRaceApi(
      transport(() => ({ status: 500, body: { error: { code: 'private raw health text' } } })),
    ).events.list(),
  ).rejects.toEqual(new RaceRequestError(500, 'REQUEST_FAILED'));
});

it('requires explicit latest revision adoption while preserving edited values', async () => {
  const user = userEvent.setup();
  const writes: TransportRequest[] = [];
  const api = transport((request) => {
    if (request.method === 'GET' && !request.path.includes('?'))
      return { status: 200, body: { ...event, revision: 2, title: '서버의 변경' } };
    if (request.method === 'GET') return lists(request);
    writes.push(request);
    return writes.length === 1
      ? { status: 409, body: { error: { code: 'REVISION_CONFLICT' } } }
      : { status: 200, body: { id, revision: 3 } };
  });
  render(view(api));
  await screen.findByText('가을 대회');
  await user.click(
    within(screen.getByRole('region', { name: '목표 대회' })).getByRole('button', {
      name: '편집',
    }),
  );
  fireEvent.change(screen.getByLabelText('대회 이름'), { target: { value: '유지할 초안' } });
  await user.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button', { name: '최신 기록 확인' }));
  await screen.findByText('서버의 변경');
  expect(screen.getByLabelText('대회 이름')).toHaveValue('유지할 초안');
  expect(writes).toHaveLength(1);
  await user.click(
    screen.getByRole('button', { name: '비교 완료 · 초안 유지하며 최신 revision 채택' }),
  );
  await user.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByText('저장이 서버에 반영되었습니다 (revision 3).')).toBeInTheDocument();
  expect(writes[1]?.body).toEqual(
    expect.objectContaining({
      expectedRevision: 2,
      values: expect.objectContaining({ title: '유지할 초안' }),
    }),
  );
});

it('keeps section state in the host and preserves mounted drafts across section changes', async () => {
  const user = userEvent.setup();
  const onSectionChange = vi.fn();
  const api = transport(lists);
  const props = { athleteId: 'athlete', sessionId: 'session', transport: api, onSectionChange };
  const mounted = render(<CompetitionWorkspace {...props} section="events" />);
  await screen.findByText('가을 대회');
  expect(screen.queryByRole('region', { name: '훈련 기록' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByLabelText('대회 이름'), { target: { value: '탭 전환 초안' } });
  await user.click(screen.getByRole('button', { name: '실제 대회 결과' }));
  expect(onSectionChange).toHaveBeenCalledWith('results');
  mounted.rerender(<CompetitionWorkspace {...props} section="results" />);
  expect(screen.getByRole('region', { name: '실제 대회 결과' })).toBeInTheDocument();
  mounted.rerender(<CompetitionWorkspace {...props} section="events" />);
  expect(screen.getByLabelText('대회 이름')).toHaveValue('탭 전환 초안');
});

it('selects named relations and sends the exact frozen course version without exposing raw IDs', async () => {
  const user = userEvent.setup();
  const writes: TransportRequest[] = [];
  const ref = {
    courseId: id,
    courseRevision: 7,
    revisionId: '30000000-0000-4000-8000-000000000003',
  };
  const api = transport((request) => {
    if (request.method === 'GET') return lists(request);
    writes.push(request);
    return { status: 200, body: { id, revision: 2 } };
  });
  render(
    <CompetitionWorkspace
      athleteId="athlete"
      sessionId="session"
      transport={api}
      relations={{
        plans: [{ id: 'plan-version-1', label: '가을 훈련 계획 · 승인 버전' }],
        courses: [{ ref, label: '강변 코스 · 10월 고정 버전' }],
        activities: [{ id, label: '10월 10일 아침 달리기' }],
      }}
    />,
  );
  await screen.findByText('가을 대회');
  expect(document.body.textContent).not.toContain(id);
  expect(document.body.textContent).not.toContain('plan-version-1');
  await user.click(
    within(screen.getByRole('region', { name: '목표 대회' })).getByRole('button', { name: '편집' }),
  );
  expect(screen.queryByLabelText('코스 ID')).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('고정 버전 코스'), ref.revisionId);
  expect(screen.getByLabelText('연결 계획')).toHaveDisplayValue('가을 훈련 계획 · 승인 버전');
  await user.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('저장이 서버에 반영되었습니다 (revision 2).');
  expect(writes[0]?.body).toEqual(
    expect.objectContaining({
      values: expect.objectContaining({ course: ref, planVersionId: 'plan-version-1' }),
    }),
  );
  await user.click(
    within(screen.getByRole('region', { name: '실제 대회 결과' })).getByRole('button', {
      name: '편집',
    }),
  );
  expect(screen.getByLabelText('연결 대회')).toHaveDisplayValue('가을 대회 · 2026-10-10');
  expect(screen.getByLabelText('연결 실제 활동')).toHaveDisplayValue('10월 10일 아침 달리기');
});

it('preserves stored relationships when optional catalogs are unavailable', async () => {
  const user = userEvent.setup();
  const ref = { courseId: id, courseRevision: 2, revisionId: id };
  const writes: TransportRequest[] = [];
  render(
    view(
      transport((request) => {
        if (request.method === 'GET' && request.path.startsWith('/bff/v1/races?'))
          return { status: 200, body: page('race-event', [{ ...event, course: ref }]) };
        if (request.method === 'GET') return lists(request);
        writes.push(request);
        return { status: 200, body: { id, revision: 2 } };
      }),
    ),
  );
  await screen.findByText('가을 대회');
  await user.click(
    within(screen.getByRole('region', { name: '목표 대회' })).getByRole('button', { name: '편집' }),
  );
  expect(screen.getByLabelText('연결 계획')).toBeDisabled();
  expect(screen.getByLabelText('고정 버전 코스')).toBeDisabled();
  expect(
    screen.getAllByText('연결 목록이 제공되지 않았습니다. 기존 연결은 그대로 유지됩니다.'),
  ).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('저장이 서버에 반영되었습니다 (revision 2).');
  expect(writes[0]?.body).toEqual(
    expect.objectContaining({
      values: expect.objectContaining({ course: ref, planVersionId: 'plan-version-1' }),
    }),
  );
});

it('loads additional named event choices in the records section without dropping the draft', async () => {
  const user = userEvent.setup();
  const nextId = '40000000-0000-4000-8000-000000000004';
  const cursor = {
    kind: 'race-event',
    collection: { revision: 1, privacyGeneration: '0' },
    afterId: id,
  };
  const api = transport((request) =>
    request.path.includes('cursor=')
      ? { status: 200, body: page('race-event', [{ ...event, id: nextId, title: '다음 대회' }]) }
      : request.path.startsWith('/bff/v1/races?')
        ? { status: 200, body: page('race-event', [event], cursor) }
        : lists(request),
  );
  render(
    <CompetitionWorkspace
      athleteId="athlete"
      sessionId="session"
      transport={api}
      section="results"
    />,
  );
  await screen.findByText('2026-10-10 대회 결과');
  await user.click(
    within(screen.getByRole('region', { name: '실제 대회 결과' })).getByRole('button', {
      name: '편집',
    }),
  );
  fireEvent.change(screen.getByLabelText('날씨 메모'), { target: { value: '유지할 메모' } });
  await user.click(screen.getByRole('button', { name: '연결 대회 더 불러오기' }));
  await waitFor(() =>
    expect(screen.getByRole('option', { name: '다음 대회 · 2026-10-10' })).toBeInTheDocument(),
  );
  await user.selectOptions(screen.getByLabelText('연결 대회'), nextId);
  expect(screen.getByLabelText('날씨 메모')).toHaveValue('유지할 메모');
});
