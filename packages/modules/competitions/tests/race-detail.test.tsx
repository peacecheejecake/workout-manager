import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import { raceEventSchema } from '@workout/contracts/races';
import { RaceEventDetailWorkspace } from '../src/race-detail';

afterEach(cleanup);
const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
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
  officialUrl: 'https://example.test/race',
  course: { courseId: other, courseRevision: 2, revisionId: id },
  targetSeconds: 0,
  planVersionId: other,
});
function transport(
  handler: (
    request: TransportRequest,
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): AuthenticatedTransport {
  return {
    request: vi.fn(async (input) =>
      transportReplySchema.parse({ ...(await handler(input)), traceId: null }),
    ),
  };
}
const good = () => ({ status: 200, body: event });
function view(
  api: AuthenticatedTransport,
  athleteId: string | null = 'alice',
  sessionId = 'a',
  raceId = id,
) {
  return (
    <RaceEventDetailWorkspace
      athleteId={athleteId}
      sessionId={sessionId}
      raceId={raceId}
      transport={api}
    />
  );
}
it('reads only the exact private detail and displays null, zero, timezone and named frozen relations', async () => {
  const api = transport(good);
  const onBack = vi.fn();
  render(
    <RaceEventDetailWorkspace
      athleteId="alice"
      sessionId="a"
      raceId={id}
      transport={api}
      onBack={onBack}
      relations={{
        plans: [{ id: other, label: '가을 승인 계획' }],
        courses: [
          {
            ref: { courseId: other, courseRevision: 2, revisionId: id },
            label: '강변 코스 · 고정 버전 2',
          },
        ],
      }}
    />,
  );
  expect(await screen.findByRole('heading', { name: '가을 대회' })).toBeVisible();
  expect(screen.getByText(/출발 시간 미상.*Asia\/Seoul.*장소 미상/)).toBeVisible();
  expect(screen.getByText(/목표 0 초.*가을 승인 계획/)).toBeVisible();
  expect(screen.getByText(/강변 코스 · 고정 버전 2/)).toBeVisible();
  expect(screen.getByRole('link', { name: '공식 대회 안내' })).toHaveAttribute(
    'href',
    event.officialUrl,
  );
  expect(document.body.textContent).not.toContain(id);
  expect(document.body.textContent).not.toContain(other);
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.request).mock.calls[0]?.[0].path).toBe(`/bff/v1/races/${id}`);
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(onBack).toHaveBeenCalledOnce();
});
it.each([null, ''] as const)(
  'requires a signed-in account before any GET (%s)',
  async (athlete) => {
    const api = transport(good);
    render(view(api, athlete));
    expect(screen.getByRole('status')).toHaveTextContent('로그인 후');
    expect(api.request).not.toHaveBeenCalled();
  },
);
it('rejects an invalid race ID before fetching without exposing it', () => {
  const api = transport(good);
  render(view(api, 'alice', 'a', 'private-invalid-id'));
  expect(screen.getByRole('alert')).toHaveTextContent('주소가 올바르지');
  expect(api.request).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('private-invalid-id');
});
it('renders foreign/missing detail unavailable with retry and no fabricated record/editor', async () => {
  let denied = true;
  const api = transport(() =>
    denied ? { status: 404, body: { error: { code: 'RACE_NOT_FOUND' } } } : good(),
  );
  render(view(api));
  expect(await screen.findByRole('alert')).toHaveTextContent('찾을 수 없거나 읽을 수 없습니다');
  expect(screen.queryByRole('button', { name: '대회 편집' })).not.toBeInTheDocument();
  denied = false;
  await userEvent.click(screen.getByRole('button', { name: '대회 다시 불러오기' }));
  expect(await screen.findByRole('heading', { name: '가을 대회' })).toBeVisible();
});
it('rejects a malformed or wrongly bound response without showing private payload', async () => {
  const api = transport(() => ({
    status: 200,
    body: { ...event, id: other, secret: 'private payload' },
  }));
  render(view(api));
  expect(await screen.findByRole('alert')).toHaveTextContent('불러오지 못했습니다');
  expect(document.body.textContent).not.toContain('private payload');
  expect(screen.queryByRole('heading', { name: '가을 대회' })).not.toBeInTheDocument();
});
it('preserves the draft on CAS failure, compares current GET, and explicitly adopts revision without replacing input', async () => {
  const commands: TransportRequest[] = [];
  let conflict = true;
  const api = transport((input) => {
    if (input.method === 'PATCH') {
      commands.push(input);
      if (conflict) {
        conflict = false;
        return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } } };
      }
      return { status: 200, body: { id, revision: 3 } };
    }
    return {
      status: 200,
      body: conflict ? event : { ...event, revision: 2, title: '서버의 새 이름' },
    };
  });
  render(view(api));
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.clear(screen.getByLabelText('대회 이름'));
  await userEvent.type(screen.getByLabelText('대회 이름'), '내 수정 초안');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('다른 변경과 충돌');
  expect(screen.getByLabelText('대회 이름')).toHaveValue('내 수정 초안');
  expect(screen.queryByRole('button', { name: /비교 완료/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '최신 대회 확인' }));
  expect(await screen.findByRole('heading', { name: '서버의 새 이름' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /비교 완료/ }));
  expect(screen.getByLabelText('대회 이름')).toHaveValue('내 수정 초안');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByText('저장이 서버에 반영되었습니다 (revision 3).')).toBeVisible();
  expect(commands[0]?.body).toMatchObject({
    expectedRevision: 1,
    values: { title: '내 수정 초안', course: event.course, planVersionId: other },
  });
  expect(commands[1]?.body).toMatchObject({
    expectedRevision: 2,
    values: { title: '내 수정 초안' },
  });
  expect(commands[1]?.idempotencyKey).not.toBe(commands[0]?.idempotencyKey);
  await waitFor(() =>
    expect(vi.mocked(api.request).mock.calls.filter(([r]) => r.method === 'GET')).toHaveLength(3),
  );
});
it('keeps PlanImpactRequired date drafts and saved relations without writing Plans', async () => {
  const api = transport((input) =>
    input.method === 'PATCH'
      ? { status: 409, body: { error: { code: 'RACE_PLAN_IMPACT_REQUIRED' } } }
      : good(),
  );
  render(view(api));
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.clear(screen.getByLabelText('현지 날짜'));
  await userEvent.type(screen.getByLabelText('현지 날짜'), '2026-10-11');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('별도 승인');
  expect(screen.getByLabelText('현지 날짜')).toHaveValue('2026-10-11');
  expect(screen.getByLabelText('연결 계획')).toBeDisabled();
  expect(
    vi.mocked(api.request).mock.calls.every(([r]) => r.path.startsWith('/bff/v1/races/')),
  ).toBe(true);
});
it('keeps editing draft after latest review fails', async () => {
  let reads = 0;
  const api = transport(() =>
    ++reads === 1 ? good() : { status: 404, body: { error: { code: 'RACE_NOT_FOUND' } } },
  );
  render(view(api));
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.clear(screen.getByLabelText('대회 이름'));
  await userEvent.type(screen.getByLabelText('대회 이름'), '보존할 초안');
  await userEvent.click(screen.getByRole('button', { name: '최신 대회 확인' }));
  expect(await screen.findByText(/찾을 수 없거나 읽을 수 없습니다/)).toBeVisible();
  expect(screen.getByLabelText('대회 이름')).toHaveValue('보존할 초안');
});
it('requires delete confirmation, cancels safely and repeats failed deletion with its original receipt key', async () => {
  const deletes: TransportRequest[] = [];
  let failure = true;
  const api = transport((input) => {
    if (input.method !== 'DELETE') return good();
    deletes.push(input);
    if (failure) {
      failure = false;
      throw new Error('private transport secret');
    }
    return { status: 200, body: { id, revision: 2 } };
  });
  render(view(api));
  await userEvent.click(await screen.findByRole('button', { name: '대회 삭제' }));
  expect(deletes).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '삭제 취소' }));
  expect(deletes).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '대회 삭제' }));
  await userEvent.click(screen.getByRole('button', { name: '대회 삭제 확인' }));
  expect(await screen.findByText(/연결을 확인하고 다시 시도/)).toBeVisible();
  expect(document.body.textContent).not.toContain('private transport secret');
  await userEvent.click(screen.getByRole('button', { name: '대회 삭제 확인' }));
  expect(await screen.findByText('대회 삭제가 서버에 반영되었습니다.')).toBeVisible();
  expect(deletes).toHaveLength(2);
  expect(deletes[0]?.idempotencyKey).toBe(deletes[1]?.idempotencyKey);
  expect(deletes[1]?.body).toEqual({ expectedRevision: 1 });
  expect(screen.queryByRole('heading', { name: '가을 대회' })).not.toBeInTheDocument();
  expect(vi.mocked(api.request).mock.calls.filter(([r]) => r.method === 'GET')).toHaveLength(1);
});
it.each(['account', 'session', 'race'] as const)(
  'cancels old detail and ignores late responses on %s change',
  async (mode) => {
    let resolve: ((value: { status: number; body: unknown }) => void) | undefined;
    let signal: AbortSignal | undefined;
    const api = transport((input) => {
      signal = input.signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const mounted = render(view(api));
    await waitFor(() => expect(resolve).toBeDefined());
    const next = transport(() => ({
      status: 200,
      body: { ...event, id: mode === 'race' ? other : id, title: '새 범위 대회' },
    }));
    mounted.rerender(
      view(
        next,
        mode === 'account' ? 'bob' : 'alice',
        mode === 'session' ? 'b' : 'a',
        mode === 'race' ? other : id,
      ),
    );
    expect(await screen.findByRole('heading', { name: '새 범위 대회' })).toBeVisible();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve?.(good());
    });
    expect(screen.queryByRole('heading', { name: '가을 대회' })).not.toBeInTheDocument();
  },
);
it('aborts pending PATCH on logout and cannot deliver late save status into another account', async () => {
  let resolve: ((value: { status: number; body: unknown }) => void) | undefined;
  let signal: AbortSignal | undefined;
  const api = transport((input) =>
    input.method === 'GET'
      ? good()
      : new Promise((done) => {
          resolve = done;
          signal = input.signal;
        }),
  );
  const mounted = render(view(api));
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(resolve).toBeDefined());
  mounted.rerender(view(api, null));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    resolve?.({ status: 200, body: { id, revision: 2 } });
  });
  expect(screen.getByRole('status')).toHaveTextContent('로그인 후');
  expect(screen.queryByText(/저장이 서버에/)).not.toBeInTheDocument();
});
it('refreshes cached detail without silently adopting a new revision into an editing draft', async () => {
  let latest = false;
  const api = transport(() => ({
    status: 200,
    body: latest ? { ...event, revision: 2, title: '새 서버 제목' } : event,
  }));
  render(view(api));
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.clear(screen.getByLabelText('대회 이름'));
  await userEvent.type(screen.getByLabelText('대회 이름'), '로컬 초안');
  latest = true;
  await userEvent.click(screen.getByRole('button', { name: '대회 새로고침' }));
  expect(await screen.findByRole('heading', { name: '새 서버 제목' })).toBeVisible();
  expect(screen.getByLabelText('대회 이름')).toHaveValue('로컬 초안');
  expect(screen.getByText(/편집 기준 revision 1/)).toBeVisible();
});
it('keeps terminal revision readable and allows exact terminal deletion without attempting PATCH', async () => {
  const api = transport((input) =>
    input.method === 'DELETE'
      ? { status: 200, body: { id, revision: 2147483647 } }
      : { status: 200, body: { ...event, revision: 2147483647 } },
  );
  render(view(api));
  expect(await screen.findByText('최종 버전 대회는 읽기와 삭제만 가능합니다.')).toBeVisible();
  expect(screen.getByRole('button', { name: '대회 편집' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '대회 삭제' }));
  await userEvent.click(screen.getByRole('button', { name: '대회 삭제 확인' }));
  expect(await screen.findByText('대회 삭제가 서버에 반영되었습니다.')).toBeVisible();
  expect(vi.mocked(api.request).mock.calls.find(([r]) => r.method === 'DELETE')?.[0].body).toEqual({
    expectedRevision: 2147483647,
  });
  expect(vi.mocked(api.request).mock.calls.some(([r]) => r.method === 'PATCH')).toBe(false);
});

it('confirms dirty back navigation, focuses continue, and retains the draft until explicit discard', async () => {
  const onBack = vi.fn();
  render(
    <RaceEventDetailWorkspace
      athleteId="alice"
      sessionId="a"
      raceId={id}
      transport={transport(good)}
      onBack={onBack}
    />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.clear(screen.getByLabelText('대회 이름'));
  await userEvent.type(screen.getByLabelText('대회 이름'), '보존할 변경');
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(onBack).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '계속 편집' })).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: '계속 편집' }));
  expect(screen.getByLabelText('대회 이름')).toHaveValue('보존할 변경');
  expect(screen.getByRole('button', { name: '대회 목록으로' })).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  await userEvent.click(screen.getByRole('button', { name: '변경을 버리고 이동' }));
  expect(onBack).toHaveBeenCalledTimes(1);
});
it('does not confirm unchanged or reverted valid edits', async () => {
  const onBack = vi.fn();
  render(
    <RaceEventDetailWorkspace
      athleteId="alice"
      sessionId="a"
      raceId={id}
      transport={transport(good)}
      onBack={onBack}
    />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(onBack).toHaveBeenCalledTimes(1);
  await userEvent.clear(screen.getByLabelText('대회 이름'));
  await userEvent.type(screen.getByLabelText('대회 이름'), '변경');
  await userEvent.clear(screen.getByLabelText('대회 이름'));
  await userEvent.type(screen.getByLabelText('대회 이름'), event.title);
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(onBack).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: '계속 편집' })).not.toBeInTheDocument();
});
it('keeps invalid and failed-save drafts dirty and clears them on session switch', async () => {
  const onBack = vi.fn();
  const api = transport((input) =>
    input.method === 'PATCH'
      ? { status: 409, body: { error: { code: 'REVISION_CONFLICT' } } }
      : good(),
  );
  const content = (sessionId: string) => (
    <RaceEventDetailWorkspace
      athleteId="alice"
      sessionId={sessionId}
      raceId={id}
      transport={api}
      onBack={onBack}
    />
  );
  const rendered = render(content('a'));
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.clear(screen.getByLabelText('대회 이름'));
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(screen.getByRole('button', { name: '계속 편집' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '계속 편집' }));
  await userEvent.type(screen.getByLabelText('대회 이름'), '실패한 초안');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText(/다른 변경과 충돌/);
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(onBack).not.toHaveBeenCalled();
  expect(screen.getByLabelText('대회 이름')).toHaveValue('실패한 초안');
  rendered.rerender(content('b'));
  expect(screen.queryByLabelText('대회 이름')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '계속 편집' })).not.toBeInTheDocument();
  await screen.findByRole('button', { name: '대회 편집' });
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(onBack).toHaveBeenCalledTimes(1);
});
it('blocks back during a pending save and permits it after the exact successful receipt', async () => {
  let complete: ((value: { status: number; body: unknown }) => void) | undefined;
  const api = transport((input) =>
    input.method === 'PATCH'
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : good(),
  );
  const onBack = vi.fn();
  render(
    <RaceEventDetailWorkspace
      athleteId="alice"
      sessionId="a"
      raceId={id}
      transport={api}
      onBack={onBack}
    />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.type(screen.getByLabelText('대회 이름'), ' 수정');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(screen.getByRole('button', { name: '대회 목록으로' })).toBeDisabled();
  await act(async () => {
    complete?.({ status: 200, body: { id, revision: 2 } });
  });
  await screen.findByText('저장이 서버에 반영되었습니다 (revision 2).');
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '계속 편집' })).not.toBeInTheDocument();
});

it('keeps exact detail fields and unsaved draft when app consent blocks PATCH without CAS or automatic grant', async () => {
  let permitted = false;
  const commands: TransportRequest[] = [];
  const onBack = vi.fn();
  const api = transport((request) => {
    commands.push(request);
    if (request.method === 'GET') return good();
    return permitted
      ? { status: 200, body: { id, revision: 2 } }
      : {
          status: 409,
          body: { error: { code: 'APP_CONSENT_REQUIRED', message: 'private permission' } },
        };
  });
  render(
    <RaceEventDetailWorkspace
      athleteId="alice"
      sessionId="a"
      raceId={id}
      transport={api}
      onBack={onBack}
    />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '대회 편집' }));
  await userEvent.clear(screen.getByLabelText('대회 이름'));
  await userEvent.type(screen.getByLabelText('대회 이름'), '동의 대기 상세 초안');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '앱 저장·처리 동의가 필요합니다. 계정에서 동의 상태를 확인하세요. 초안은 유지됩니다.',
  );
  expect(screen.getByLabelText('대회 이름')).toHaveValue('동의 대기 상세 초안');
  expect(screen.getByLabelText('현지 날짜')).toHaveValue(event.localDate);
  expect(
    screen.queryByText(/다른 변경과 충돌|저장이 서버에 반영|private permission/),
  ).not.toBeInTheDocument();
  expect(commands.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  expect(commands.every((request) => request.path === `/bff/v1/races/${id}`)).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: '대회 목록으로' }));
  expect(screen.getByRole('region', { name: '미저장 변경 이동 확인' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '계속 편집' }));
  expect(onBack).not.toHaveBeenCalled();
  expect(screen.getByLabelText('대회 이름')).toHaveValue('동의 대기 상세 초안');
  permitted = true;
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('저장이 서버에 반영되었습니다 (revision 2).');
  const writes = commands.filter((request) => request.method === 'PATCH');
  expect(writes).toHaveLength(2);
  expect(writes[1]?.body).toEqual(writes[0]?.body);
  expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
  expect(writes[1]?.body).toMatchObject({
    expectedRevision: 1,
    values: {
      title: '동의 대기 상세 초안',
      course: event.course,
      planVersionId: event.planVersionId,
    },
  });
});
