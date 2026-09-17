import '@testing-library/jest-dom/vitest';
import { z } from 'zod';
import { transportReplySchema } from '@workout/contracts/core';
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  coachingThreadSchema,
  coachingMessageAppendSchema,
  coachingThreadCreateSchema,
} from '@workout/contracts/coaching-threads';
import { CoachingWorkspace } from '../src/coaching-workspace';
afterEach(cleanup);
const planId = '11111111-1111-4111-8111-111111111111',
  threadId = '22222222-2222-4222-8222-222222222222',
  otherId = '33333333-3333-4333-8333-333333333333',
  messageId = '44444444-4444-4444-8444-444444444444';
const instant = '2026-01-01T00:00:00.000Z';
const plan = planSnapshotSchema.parse({
  id: planId,
  version: 1,
  createdAt: instant,
  draft: {
    title: 'Stored plan',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index ? levels[index - 1] : null,
      level,
      title: level,
      startDate: '2026-01-01',
      endDateExclusive: '2026-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
      ...(index === 0
        ? {
            constraints: {
              unavailableDates: ['2026-01-02'],
              dailyTimeLimits: [{ date: '2026-01-03', availableSeconds: 0 }],
            },
          }
        : {}),
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-01-04',
        localStartTime: null,
        title: 'Synthetic session',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: true, time: false, intensity: true },
        steps: [],
      },
    ],
  },
});
function makeThread(id = threadId) {
  return coachingThreadSchema.parse({
    id,
    planVersionId: planId,
    title: id === threadId ? 'First conversation' : 'Second conversation',
    scope: { kind: 'session', targetId: 'session' },
    revision: 1,
    createdAt: instant,
    updatedAt: instant,
  });
}
function fixture(initialRevision = 1) {
  let thread = { ...makeThread(), revision: initialRevision };
  const posts: TransportRequest[] = [];
  let nextFailure: 'conflict' | 'unknown' | 'server' | 'malformed' | null = null;
  let delayList: Promise<void> | null = null;
  const respond = async (input: TransportRequest) => {
    const path = input.path;
    if (input.method === 'POST') {
      const { signal: _signal, ...sent } = input;
      posts.push(structuredClone(sent));
      if (nextFailure === 'conflict') {
        nextFailure = null;
        thread = { ...thread, revision: thread.revision + 1 };
        return { status: 409, body: { error: { code: 'CONVERSATION_REVISION_CONFLICT' } } };
      }
      if (nextFailure === 'server') {
        nextFailure = null;
        return { status: 503, body: { error: { code: 'UNAVAILABLE' } } };
      }
      if (nextFailure === 'malformed') {
        nextFailure = null;
        return { status: 200, body: { unexpected: 'private detail never render' } };
      }
      if (nextFailure === 'unknown') {
        nextFailure = null;
        throw new Error('private detail never render');
      }
      const body = path.endsWith('/messages')
        ? coachingMessageAppendSchema.parse({
            ...z.record(z.string(), z.unknown()).parse(input.body),
            idempotencyKey: input.idempotencyKey,
          })
        : coachingThreadCreateSchema.parse({
            ...z.record(z.string(), z.unknown()).parse(input.body),
            idempotencyKey: input.idempotencyKey,
          });
      const revision = 'expectedRevision' in body ? body.expectedRevision + 1 : 1;
      thread = {
        ...thread,
        revision,
        ...('title' in body ? { title: body.title, scope: body.scope } : {}),
      };
      return {
        status: 200,
        body: {
          thread,
          message: {
            id: messageId,
            threadId,
            revision,
            role: 'user',
            content: body.message,
            createdAt: instant,
          },
        },
      };
    }
    if (path === '/bff/v1/plans/current')
      return {
        status: 200,
        body: {
          head: plan,
          history: [{ id: planId, version: 1, title: plan.draft.title, createdAt: instant }],
        },
      };
    if (path.startsWith('/bff/v1/plans/versions/')) return { status: 200, body: plan };
    if (path.includes('/messages?')) {
      const id = path.includes(otherId) ? otherId : threadId;
      const current = id === threadId ? thread : makeThread(otherId);
      return {
        status: 200,
        body: {
          thread: current,
          messages: Array.from({ length: current.revision }, (_, index) => ({
            id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
            threadId: id,
            revision: index + 1,
            role: 'user',
            content: `Stored message ${index + 1}`,
            createdAt: instant,
          }))
            .filter(
              (message) =>
                message.revision >
                Number(new URL(path, 'https://example.test').searchParams.get('afterRevision')),
            )
            .slice(0, 50),
          hasMore:
            current.revision >
            Number(new URL(path, 'https://example.test').searchParams.get('afterRevision')) + 50,
        },
      };
    }
    if (path.startsWith('/bff/v1/coaching-threads?')) {
      if (delayList) await delayList;
      return { status: 200, body: { items: [thread, makeThread(otherId)], total: 2 } };
    }
    return { status: 200, body: path.endsWith(otherId) ? makeThread(otherId) : thread };
  };
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
    transportReplySchema.parse({ ...(await respond(input)), traceId: null }),
  );
  return {
    transport: { request },
    posts,
    fail: (value: typeof nextFailure) => {
      nextFailure = value;
    },
    delay: (promise: Promise<void>) => {
      delayList = promise;
    },
  };
}
function Harness({
  transport,
  initial = `thread=${threadId}`,
  sessionId = 'session-a',
}: {
  transport: AuthenticatedTransport;
  initial?: string;
  sessionId?: string;
}) {
  const [search, setSearch] = useState(initial);
  return (
    <>
      <output aria-label="Address">{search}</output>
      <CoachingWorkspace
        athleteId="athlete"
        sessionId={sessionId}
        transport={transport}
        search={search}
        onSearchChange={setSearch}
        createId={() => `key-${crypto.randomUUID()}`}
      />
    </>
  );
}
async function ready() {
  await screen.findByRole('region', { name: '저장된 상담 맥락' });
  return screen.getByRole('textbox', { name: '사용자 메시지' });
}
describe('coaching workspace user records', () => {
  it('shows immutable scope, ancestor constraints, null/zero and locks without assistant output; retains per-thread drafts', async () => {
    const f = fixture(),
      user = userEvent.setup();
    render(<Harness transport={f.transport} />);
    const box = await ready();
    const context = screen.getByRole('region', { name: '저장된 상담 맥락' });
    expect(context).toHaveTextContent('2026-01-02');
    expect(context).toHaveTextContent('2026-01-03: 0초');
    expect(context).toHaveTextContent('기간 제약: 미기록');
    expect(context).toHaveTextContent('계획 거리: 0m · 계획 시간: 미정');
    expect(context).toHaveTextContent('날짜 켜짐');
    await user.type(box, 'First draft');
    await user.click(screen.getByRole('button', { name: 'Second conversation' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: '선택한 상담 기록' })).toHaveTextContent(
        'Second conversation',
      ),
    );
    await user.type(screen.getByRole('textbox', { name: '사용자 메시지' }), 'Second draft');
    await user.click(screen.getByRole('button', { name: 'First conversation' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '사용자 메시지' })).toHaveValue('First draft'),
    );
    expect(f.posts).toHaveLength(0);
  });
  it('preserves conflict draft and requires explicit latest review before a new revision can be sent', async () => {
    const f = fixture(),
      user = userEvent.setup();
    render(<Harness transport={f.transport} />);
    await user.type(await ready(), 'My retained draft');
    f.fail('conflict');
    await user.click(screen.getByRole('button', { name: '사용자 메시지 저장' }));
    await screen.findByRole('button', { name: '최신 기록 확인 후 다시 검토' });
    expect(screen.getByRole('textbox', { name: '사용자 메시지' })).toHaveValue('My retained draft');
    expect(screen.getByRole('button', { name: '사용자 메시지 저장' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '최신 기록 확인 후 다시 검토' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '사용자 메시지 저장' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: '사용자 메시지 저장' }));
    await waitFor(() => expect(f.posts).toHaveLength(2));
    expect(f.posts[0]?.body).toMatchObject({ expectedRevision: 1 });
    expect(f.posts[1]?.body).toMatchObject({ expectedRevision: 2, message: 'My retained draft' });
    expect(f.posts[0]?.idempotencyKey).not.toBe(f.posts[1]?.idempotencyKey);
  });
  it.each(['unknown', 'server', 'malformed'] as const)(
    'keeps %s outcomes immutable, locks navigation, and reconfirms identical key and body',
    async (failure) => {
      const f = fixture(),
        user = userEvent.setup();
      render(<Harness transport={f.transport} />);
      await user.type(await ready(), 'Uncertain draft');
      f.fail(failure);
      await user.click(screen.getByRole('button', { name: '사용자 메시지 저장' }));
      await screen.findByRole('button', { name: '같은 요청 재확인' });
      expect(screen.getByRole('textbox', { name: '사용자 메시지' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Second conversation' })).toBeDisabled();
      expect(screen.queryByText('private detail never render')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '같은 요청 재확인' }));
      await waitFor(() => expect(f.posts).toHaveLength(2));
      expect(f.posts[1]?.body).toEqual(f.posts[0]?.body);
      expect(f.posts[1]?.idempotencyKey).toBe(f.posts[0]?.idempotencyKey);
      await waitFor(() =>
        expect(screen.getByRole('textbox', { name: '사용자 메시지' })).toHaveValue(''),
      );
    },
  );
  it('creates explicitly and does not let delayed refresh navigate away from a newer selection', async () => {
    const f = fixture(),
      user = userEvent.setup();
    render(<Harness transport={f.transport} initial="" />);
    await screen.findByRole('option', { name: 'Synthetic session' });
    await user.selectOptions(screen.getByLabelText('상담 대상'), 'session');
    await user.type(screen.getByLabelText('상담 제목'), 'New conversation');
    await user.type(screen.getByLabelText('첫 사용자 메시지'), 'First new message');
    let release!: () => void;
    f.delay(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await user.click(screen.getByRole('button', { name: '상담 기록 만들기' }));
    await screen.findByRole('region', { name: '선택한 상담 기록' });
    await user.click(screen.getByRole('button', { name: 'Second conversation' }));
    await waitFor(() => expect(screen.getByLabelText('Address')).toHaveTextContent(otherId));
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByRole('region', { name: '선택한 상담 기록' })).toHaveTextContent(
        'Second conversation',
      ),
    );
    expect(screen.getByLabelText('Address')).toHaveTextContent(otherId);
    expect(f.posts).toHaveLength(1);
  });
  it('rejects invalid URL and does not implicitly submit IME Enter', async () => {
    const f = fixture();
    const rendered = render(<Harness transport={f.transport} initial="thread=bad" />);
    expect(screen.getByRole('alert')).toHaveTextContent('상담 조회 주소');
    expect(f.transport.request).not.toHaveBeenCalled();
    rendered.unmount();
    render(<Harness transport={f.transport} />);
    const box = await ready();
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: '한글' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(box);
    expect(f.posts).toHaveLength(0);
  });
  it('drops private drafts on session change and ignores late command completion after unmount under StrictMode', async () => {
    const f = fixture();
    let resolve!: (value: Awaited<ReturnType<AuthenticatedTransport['request']>>) => void;
    const original = f.transport.request;
    const transport: AuthenticatedTransport = {
      request: (input) =>
        input.method === 'POST'
          ? new Promise((done) => {
              resolve = done;
            })
          : original(input),
    };
    const user = userEvent.setup(),
      mounted = render(
        <StrictMode>
          <Harness transport={transport} />
        </StrictMode>,
      );
    await user.type(await ready(), 'Private draft');
    mounted.rerender(
      <StrictMode>
        <Harness transport={transport} sessionId="session-b" />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '사용자 메시지' })).toHaveValue(''),
    );
    await user.type(screen.getByRole('textbox', { name: '사용자 메시지' }), 'Pending private');
    await user.click(screen.getByRole('button', { name: '사용자 메시지 저장' }));
    mounted.unmount();
    await act(async () =>
      resolve({
        status: 200,
        traceId: null,
        body: {
          thread: { ...makeThread(), revision: 2 },
          message: {
            id: messageId,
            threadId,
            revision: 2,
            role: 'user',
            content: 'Pending private',
            createdAt: instant,
          },
        },
      }),
    );
    expect(screen.queryByRole('region', { name: '상담 기록' })).not.toBeInTheDocument();
  });
});

it('keeps a pagination-boundary conflict locked until message 51 is loaded and explicitly reviewed', async () => {
  const f = fixture(50),
    user = userEvent.setup();
  render(<Harness transport={f.transport} />);
  await user.type(await ready(), 'Retained boundary draft');
  expect(screen.queryByText('Stored message 51')).not.toBeInTheDocument();
  f.fail('conflict');
  await user.click(screen.getByRole('button', { name: '사용자 메시지 저장' }));
  await user.click(await screen.findByRole('button', { name: '최신 기록 확인 후 다시 검토' }));
  await screen.findByText(/최신 메시지가 아직 표시되지 않았습니다/);
  expect(screen.getByRole('button', { name: '사용자 메시지 저장' })).toBeDisabled();
  expect(f.posts).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '메시지 더 보기' }));
  await screen.findByText('Stored message 51');
  expect(screen.getByRole('button', { name: '사용자 메시지 저장' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '최신 기록 확인 후 다시 검토' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '사용자 메시지 저장' })).toBeEnabled(),
  );
  expect(screen.getByRole('textbox', { name: '사용자 메시지' })).toHaveValue(
    'Retained boundary draft',
  );
  await user.click(screen.getByRole('button', { name: '사용자 메시지 저장' }));
  await waitFor(() => expect(f.posts).toHaveLength(2));
  expect(f.posts[1]?.body).toMatchObject({
    expectedRevision: 51,
    message: 'Retained boundary draft',
  });
});

it('cannot dismiss an original thread conflict by reviewing a different selected thread', async () => {
  const f = fixture(),
    user = userEvent.setup();
  render(<Harness transport={f.transport} />);
  await user.type(await ready(), 'Original conflict draft');
  f.fail('conflict');
  await user.click(screen.getByRole('button', { name: '사용자 메시지 저장' }));
  await screen.findByRole('button', { name: '최신 기록 확인 후 다시 검토' });
  await user.click(screen.getByRole('button', { name: 'Second conversation' }));
  await user.click(screen.getByRole('button', { name: '최신 기록 확인 후 다시 검토' }));
  await user.click(screen.getByRole('button', { name: 'First conversation' }));
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: '사용자 메시지' })).toHaveValue(
      'Original conflict draft',
    ),
  );
  expect(screen.getByRole('button', { name: '사용자 메시지 저장' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '최신 기록 확인 후 다시 검토' })).toBeVisible();
});

it('ignores an in-flight review completion after the selected thread changes', async () => {
  const f = fixture(),
    user = userEvent.setup();
  let delay = false,
    waiting = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      const response = await f.transport.request(input);
      if (delay && input.path.includes(`${threadId}/messages?`)) {
        waiting = true;
        await gate;
      }
      return response;
    },
  };
  render(<Harness transport={transport} />);
  await user.type(await ready(), 'Keep original conflict');
  f.fail('conflict');
  await user.click(screen.getByRole('button', { name: '사용자 메시지 저장' }));
  delay = true;
  await user.click(await screen.findByRole('button', { name: '최신 기록 확인 후 다시 검토' }));
  await waitFor(() => expect(waiting).toBe(true));
  await user.click(screen.getByRole('button', { name: 'Second conversation' }));
  await waitFor(() => expect(screen.getByLabelText('Address')).toHaveTextContent(otherId));
  await act(async () => {
    release();
  });
  await user.click(screen.getByRole('button', { name: 'First conversation' }));
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: '사용자 메시지' })).toHaveValue(
      'Keep original conflict',
    ),
  );
  expect(screen.getByRole('button', { name: '사용자 메시지 저장' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '최신 기록 확인 후 다시 검토' })).toBeVisible();
});
