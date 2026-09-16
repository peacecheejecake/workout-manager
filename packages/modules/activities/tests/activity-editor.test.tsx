import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { Activity } from '@workout/contracts/activity';
import { ActivityEditor, type ActivityEditorProps } from '../src/activity-editor';
const values = {
  title: '실제 달리기',
  kind: 'running' as const,
  startedAt: '2026-09-15T00:00:00Z',
  timezone: 'Asia/Seoul',
  distanceMeters: 0,
  durationSeconds: null,
  durationKind: 'unknown' as const,
};
const record: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 1,
  source: { kind: 'fit', sourceId: 'import-one', revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
  userReport: {
    sessionRpe: null,
    note: '기존 메모',
    planLink: { planVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sessionId: 'old-session' },
    definitionVersion: 'activity-report-v1',
    source: 'user',
    method: 'self_report',
    rpeReportedAt: null,
  },
};
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
function setup(handler?: (request: TransportRequest) => Promise<Reply>, editing = false) {
  const request = vi.fn(
    handler ??
      (async (input) =>
        input.path.endsWith('/plans/current') ? reply({ head: null, history: [] }) : reply(record)),
  );
  const props: ActivityEditorProps = {
    athleteId: 'alice',
    sessionId: 'session-a',
    transport: { request },
    target: editing ? { mode: 'edit', activityId: record.id } : { mode: 'create' },
    initialStartedAt: values.startedAt,
    initialTimezone: values.timezone,
    activityHref: (id) => `/activities?selected=${id}`,
    listHref: '/activities',
    createId: vi.fn(() => crypto.randomUUID()),
  };
  return { ...render(<ActivityEditor {...props} />), props, request };
}
async function prepare(editing = false) {
  const user = userEvent.setup();
  if (editing) {
    await screen.findByRole('region', { name: '정정 기준 원본' });
    await user.type(screen.getByLabelText('활동 정정 사유'), '관측 정정');
  } else await user.type(screen.getByLabelText('활동 제목'), '직접 보고');
  await user.click(screen.getByRole('button', { name: '활동 저장 미리보기' }));
  return user;
}
it('requires preview and explicit confirmation, preserving zero and absent report separately', async () => {
  const { request } = setup(async (input) =>
    input.path.endsWith('/plans/current')
      ? reply({ head: null, history: [] })
      : input.method === 'POST'
        ? reply({ activityId: record.id, revision: 1 })
        : reply(record),
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('활동 제목'), '직접 보고');
  await user.type(screen.getByLabelText('활동 거리 (m)'), '0');
  await user.type(screen.getByLabelText('세션 체감 강도 (RPE 0~10)'), '0');
  await user.click(screen.getByRole('button', { name: '활동 저장 미리보기' }));
  expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
  await screen.findByText('활동 저장이 확인되었습니다.');
  expect(request.mock.calls.find(([input]) => input.method === 'POST')?.[0].body).toMatchObject({
    confirmed: true,
    activity: { distanceMeters: 0, durationSeconds: null },
    report: { sessionRpe: 0, note: null, planLink: null },
  });
});
it('keeps uncertain commands frozen against edits, discard, target changes, and retries exact payload', async () => {
  let writes = 0;
  const { request, rerender, props } = setup(async (input) => {
    if (input.path.endsWith('/plans/current')) return reply({ head: null, history: [] });
    if (input.method === 'POST') {
      if (++writes === 1) throw new Error('lost response');
      return reply({ activityId: record.id, revision: 1 });
    }
    return reply(record);
  });
  const user = await prepare();
  await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
  await screen.findByRole('button', { name: '같은 활동 요청 다시 시도' });
  expect(screen.getByLabelText('활동 제목')).toBeDisabled();
  expect(screen.getByRole('button', { name: '활동 초안 버리기' })).toBeDisabled();
  rerender(<ActivityEditor {...props} target={{ mode: 'edit', activityId: record.id }} />);
  expect(screen.getByRole('button', { name: '작성 내용 버리고 대상 전환' })).toBeDisabled();
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  screen.getByRole('link', { name: '활동 목록으로' }).dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await user.click(screen.getByRole('button', { name: '같은 활동 요청 다시 시도' }));
  await screen.findByText('활동 저장이 확인되었습니다.');
  const commands = request.mock.calls
    .filter(([input]) => input.method === 'POST')
    .map(([input]) => input);
  expect(commands[0]?.body).toEqual(commands[1]?.body);
  expect(commands[0]?.idempotencyKey).toBe(commands[1]?.idempotencyKey);
});
for (const editing of [false, true])
  it(`preserves fields and allows correction after a definite 400 rejection (${editing})`, async () => {
    const { request } = setup(
      async (input) =>
        input.path.endsWith('/plans/current')
          ? reply({ head: null, history: [] })
          : input.method === 'GET'
            ? reply(record)
            : reply({ error: { code: 'STARTED_AT_IN_FUTURE' } }, 400),
      editing,
    );
    const user = await prepare(editing);
    await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
    await screen.findByText(/입력이 거절되었습니다/);
    expect(screen.getByLabelText('활동 제목')).toBeEnabled();
    expect(screen.getByLabelText('활동 제목')).toHaveValue(editing ? values.title : '직접 보고');
    await user.type(screen.getByLabelText('활동 메모'), ' 수정');
    await user.click(screen.getByRole('button', { name: '활동 저장 미리보기' }));
    await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
    await screen.findByText(/입력이 거절되었습니다/);
    const writes = request.mock.calls.filter(([input]) => input.method !== 'GET');
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0].idempotencyKey).not.toBe(writes[1]?.[0].idempotencyKey);
  });
it('retains old plan link during plan fetch failure and requires explicit comparison for stale correction', async () => {
  let conflict = false;
  const updated = { ...record, revision: 2, effective: { ...values, title: '다른 창 제목' } };
  const { request } = setup(async (input) => {
    if (input.path.endsWith('/plans/current')) return reply(null, 503);
    if (input.method === 'PATCH') {
      conflict = true;
      return reply({ error: { code: 'REVISION_CONFLICT' } }, 409);
    }
    return reply(conflict ? updated : record);
  }, true);
  const user = await prepare(true);
  expect(
    within(screen.getByRole('region', { name: '활동 저장 미리보기' })).getByText(/old-session/),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
  await user.click(await screen.findByRole('button', { name: '최신 활동 비교' }));
  await screen.findByRole('region', { name: '최신 활동 원본' });
  expect(screen.getByLabelText('활동 제목')).toHaveValue(values.title);
  await user.click(screen.getByRole('button', { name: '작성 내용 유지하고 다시 정정 준비' }));
  await user.click(screen.getByRole('button', { name: '활동 저장 미리보기' }));
  await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
  const last = request.mock.calls.filter(([input]) => input.method === 'PATCH').at(-1)?.[0];
  expect(last?.body).toMatchObject({
    expectedRevision: 2,
    report: { planLink: record.userReport?.planLink },
  });
});
for (const status of [404, 503])
  it(`distinguishes successful save from subsequent current-read failure ${status}`, async () => {
    let committed = false;
    setup(async (input) => {
      if (input.path.endsWith('/plans/current')) return reply({ head: null, history: [] });
      if (input.method === 'PATCH') {
        committed = true;
        return reply({ ...record, revision: 2 });
      }
      return committed ? reply(null, status) : reply(record);
    }, true);
    const user = await prepare(true);
    await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
    await screen.findByText(/저장은 확인되었지만/);
    expect(screen.queryByRole('region', { name: '저장 후 현재 기록' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '같은 활동 요청 다시 시도' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '활동 초안 버리기' }));
    await user.click(screen.getByRole('button', { name: '활동 초안 폐기 확인' }));
    expect(screen.getByLabelText('활동 제목')).toBeDisabled();
  });
it('uses the authoritative current revision when reopening editing after save', async () => {
  let saved = false;
  setup(async (input) => {
    if (input.path.endsWith('/plans/current')) return reply({ head: null, history: [] });
    if (input.method === 'PATCH') {
      saved = true;
      return reply({ ...record, revision: 2 });
    }
    return reply(
      saved
        ? { ...record, revision: 3, effective: { ...values, title: '최신 현재 제목' } }
        : record,
    );
  }, true);
  const user = await prepare(true);
  await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
  await screen.findByRole('region', { name: '저장 후 현재 기록' });
  await user.click(screen.getByRole('button', { name: '활동 초안 버리기' }));
  await user.click(screen.getByRole('button', { name: '활동 초안 폐기 확인' }));
  expect(await screen.findByText('정정 기준 원본 · 수정 3')).toBeVisible();
  expect(screen.getByLabelText('활동 제목')).toHaveValue('최신 현재 제목');
});
it('does not preview or save on IME Enter and ignores a late response after account change', async () => {
  let finish: ((value: Reply) => void) | undefined;
  const { request, props, rerender } = setup(async (input) =>
    input.method === 'POST'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : reply({ head: null, history: [] }),
  );
  const title = screen.getByLabelText('활동 제목');
  fireEvent.compositionStart(title);
  fireEvent.change(title, { target: { value: '달리기' } });
  fireEvent.keyDown(title, { key: 'Enter', isComposing: true });
  const form = title.closest('form');
  if (form) fireEvent.submit(form);
  expect(screen.queryByRole('button', { name: '실제 활동 확인하고 저장' })).not.toBeInTheDocument();
  fireEvent.compositionEnd(title);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '활동 저장 미리보기' }));
  await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
  rerender(<ActivityEditor {...props} athleteId="bob" sessionId="session-b" />);
  await act(async () => {
    finish?.(reply({ activityId: record.id, revision: 1 }));
  });
  expect(screen.getByLabelText('활동 제목')).toHaveValue('');
  expect(screen.queryByText('활동 저장이 확인되었습니다.')).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(1);
});

it('selects a session from a validated plan snapshot and submits its exact version link', async () => {
  const version = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const plan = {
    head: {
      id: version,
      version: 1,
      createdAt: values.startedAt,
      draft: {
        title: '계획',
        timezone: 'Asia/Seoul',
        periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
          id: level,
          parentId: index === 0 ? null : levels[index - 1],
          level,
          title: level,
          startDate: '2026-09-01',
          endDateExclusive: '2026-10-01',
          timezone: 'Asia/Seoul',
          intent: '',
          isPartial: false,
        })),
        sessions: [
          {
            id: 'plan-session',
            blockId: 'block',
            date: '2026-09-15',
            localStartTime: null,
            title: '계획 달리기',
            sport: 'running',
            durationSeconds: null,
            distanceMeters: null,
            targetRpe: null,
            purpose: '',
            notes: '',
            priority: 'normal',
            locks: { date: false, time: false, intensity: false },
            steps: [],
          },
        ],
      },
    },
    history: [],
  };
  const { request } = setup(async (input) =>
    input.path.endsWith('/plans/current')
      ? reply(plan)
      : input.method === 'POST'
        ? reply({ activityId: record.id, revision: 1 })
        : reply(record),
  );
  const user = userEvent.setup();
  await screen.findByRole('option', { name: '2026-09-15 · 계획 달리기' });
  await user.type(screen.getByLabelText('활동 제목'), '계획과 연결한 실제');
  await user.selectOptions(
    screen.getByLabelText('연결할 계획 세션'),
    JSON.stringify({ planVersionId: version, sessionId: 'plan-session' }),
  );
  await user.click(screen.getByRole('button', { name: '활동 저장 미리보기' }));
  expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  await user.click(screen.getByRole('button', { name: '실제 활동 확인하고 저장' }));
  await screen.findByText('활동 저장이 확인되었습니다.');
  expect(request.mock.calls.find(([input]) => input.method === 'POST')?.[0].body).toMatchObject({
    report: { planLink: { planVersionId: version, sessionId: 'plan-session' } },
  });
  expect(
    request.mock.calls.every(
      ([input]) => input.method === 'GET' || input.path === '/bff/v1/activities',
    ),
  ).toBe(true);
});
