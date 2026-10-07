import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import {
  routineBlueprintSaveCommandSchema,
  routineSchedulePreviewCommandSchema,
  type RoutineBlueprintRead,
  type RoutineRunRead,
  type RoutineScheduleRead,
} from '@workout/contracts/routine-commands';
import type { CheckInTemplateVersion } from '@workout/contracts/check-in-templates';
import { RoutineWorkspace } from '../src/routine-workspace';
import { parseRoutineRoute } from '../src/routine-route';

const routineId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const stepId = '44444444-4444-4444-8444-444444444444';
const blueprint: RoutineBlueprintRead = {
  blueprint: {
    schemaVersion: 4,
    routineId,
    versionId,
    title: '저녁 점검',
    intent: '',
    status: 'published',
    tags: [],
    steps: [
      {
        id: stepId,
        title: '물 마시기 확인',
        content: { kind: 'checklist', prompt: '확인' },
        timing: { kind: 'ordered', afterStepId: null },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-09-18T00:00:00.000Z',
  },
  version: 1,
  favorite: false,
  visibility: 'active',
};
const runRead: RoutineRunRead = {
  run: {
    id: runId,
    revision: 0,
    blueprint: { id: routineId, versionId },
    origin: { kind: 'unplanned' },
    state: 'in_progress',
    progress: [],
    selectedChoices: {},
    startedAt: '2026-09-18T00:00:00.000Z',
    endedAt: null,
  },
  timers: [],
};
const scheduleRead: RoutineScheduleRead = {
  schedule: {
    schemaVersion: 4,
    id: '55555555-5555-4555-8555-555555555555',
    versionId: '77777777-7777-4777-8777-777777777777',
    blueprint: { id: routineId, versionId },
    window: {
      startDate: '2026-11-02',
      endDateExclusive: '2026-11-03',
      timezone: 'UTC',
      maxOccurrences: 1,
    },
    rule: { kind: 'dates', dates: ['2026-11-02'], localTime: null },
    state: 'active',
  },
  sourcePlanVersionId: null,
  occurrences: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      schedule: {
        id: '55555555-5555-4555-8555-555555555555',
        versionId: '77777777-7777-4777-8777-777777777777',
      },
      blueprint: { id: routineId, versionId },
      anchorKey: 'date:2026-11-02',
      scheduledAt: null,
      timingStatus: 'unresolved',
      stepBindings: [],
      selectedChoices: {},
    },
  ],
  notificationMuted: false,
  impactDigest: 'b'.repeat(64),
};

function renderWorkspace(
  transport: AuthenticatedTransport,
  route: Parameters<typeof RoutineWorkspace>[0]['route'],
) {
  render(
    <RoutineWorkspace
      athleteId="athlete-1"
      sessionId="session-1"
      transport={transport}
      route={route}
    />,
  );
}

describe('generic routine shell', () => {
  it('discards a populated Alice library and unsaved blueprint when the session changes', async () => {
    let releaseAlice:
      | ((value: {
          status: number;
          body: { items: RoutineBlueprintRead[]; hasMore: boolean };
          traceId: null;
        }) => void)
      | undefined;
    const aliceSearch = new Promise<{
      status: number;
      body: { items: RoutineBlueprintRead[]; hasMore: boolean };
      traceId: null;
    }>((resolve) => {
      releaseAlice = resolve;
    });
    const aliceRequest = vi.fn(async (input: TransportRequest) => {
      if (input.path.startsWith('/bff/v1/routines?')) return aliceSearch;
      if (input.path === '/bff/v1/routines')
        return { status: 200, body: { items: [blueprint], hasMore: false }, traceId: null };
      throw new Error(input.path);
    });
    const bobRequest = vi.fn(async (input: TransportRequest) => {
      if (input.path === '/bff/v1/routines')
        return { status: 200, body: { items: [], hasMore: false }, traceId: null };
      throw new Error(input.path);
    });
    const user = userEvent.setup();
    const view = render(
      <RoutineWorkspace
        athleteId="alice"
        sessionId="alice-session"
        transport={{ request: aliceRequest }}
        route={{ kind: 'library' }}
      />,
    );
    expect(await screen.findByRole('link', { name: '저녁 점검' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '새 루틴' }));
    await user.type(screen.getByRole('textbox', { name: '제목' }), 'Alice private blueprint');
    await user.type(screen.getByRole('searchbox', { name: '제목 검색' }), 'late');
    await waitFor(() =>
      expect(aliceRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/bff/v1/routines?search=late' }),
      ),
    );

    view.rerender(
      <RoutineWorkspace
        athleteId="bob"
        sessionId="bob-session"
        transport={{ request: bobRequest }}
        route={{ kind: 'library' }}
      />,
    );
    releaseAlice?.({ status: 200, body: { items: [blueprint], hasMore: false }, traceId: null });
    expect(await screen.findByText('저장된 루틴이 없습니다.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '저녁 점검' })).toBeNull();
    expect(screen.queryByDisplayValue('Alice private blueprint')).toBeNull();
    expect((screen.getByRole('searchbox', { name: '제목 검색' }) as HTMLInputElement).value).toBe(
      '',
    );
    expect(bobRequest).toHaveBeenCalledWith(expect.objectContaining({ path: '/bff/v1/routines' }));
  });

  it('clears a populated run step draft on logout before another session opens the same run', async () => {
    const request = vi.fn(async (input: TransportRequest) => {
      if (input.path === `/bff/v1/routine-runs/${runId}`)
        return { status: 200, body: runRead, traceId: null };
      if (input.path === `/bff/v1/routine-versions/${versionId}`)
        return { status: 200, body: blueprint.blueprint, traceId: null };
      throw new Error(input.path);
    });
    const user = userEvent.setup();
    const view = render(
      <RoutineWorkspace
        athleteId="alice"
        sessionId="alice-session"
        transport={{ request }}
        route={{ kind: 'run', runId }}
      />,
    );
    const reason = await screen.findByRole('textbox', { name: '부분·중단 이유 (선택)' });
    await user.type(reason, 'Alice private runner note');
    expect((reason as HTMLInputElement).value).toBe('Alice private runner note');
    view.rerender(
      <RoutineWorkspace
        athleteId="bob"
        sessionId="bob-session"
        transport={{ request }}
        route={{ kind: 'run', runId }}
      />,
    );
    expect(
      ((await screen.findByRole('textbox', { name: '부분·중단 이유 (선택)' })) as HTMLInputElement)
        .value,
    ).toBe('');
    expect(screen.queryByDisplayValue('Alice private runner note')).toBeNull();
    expect(
      request.mock.calls.filter(([input]) => input.path === `/bff/v1/routine-runs/${runId}`),
    ).toHaveLength(2);
  });
  it('parses library, detail, edit, schedule and run routes without confusing supplementary templates', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(parseRoutineRoute('/routines')).toEqual({ kind: 'library' });
    expect(parseRoutineRoute(`/routines/${id}`)).toEqual({ kind: 'detail', routineId: id });
    expect(parseRoutineRoute(`/routines/${id}/edit`)).toEqual({
      kind: 'detail',
      routineId: id,
      edit: true,
    });
    expect(parseRoutineRoute(`/routines/${id}/schedule`)).toEqual({
      kind: 'schedule',
      routineId: id,
    });
    expect(parseRoutineRoute(`/routine-runs/${id}`)).toEqual({ kind: 'run', runId: id });
    expect(parseRoutineRoute('/routines/r1')).toBeNull();
    expect(parseRoutineRoute('/supplementary/routines')).toBeNull();
  });

  it('saves a reusable checklist blueprint without scheduling or creating an actual', async () => {
    const writes: TransportRequest[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'GET')
          return { status: 200, body: { items: [], hasMore: false }, traceId: null };
        writes.push(input);
        const body = routineBlueprintSaveCommandSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(input.body),
          idempotencyKey: input.idempotencyKey,
        });
        return {
          status: 200,
          body: { blueprint: body.blueprint, version: 1, favorite: false, visibility: 'active' },
          traceId: null,
        };
      },
    };
    const user = userEvent.setup();
    render(
      <RoutineWorkspace
        athleteId="athlete-1"
        sessionId="session-1"
        transport={transport}
        route={{ kind: 'library' }}
      />,
    );
    await screen.findByText('저장된 루틴이 없습니다.');
    await user.click(screen.getByRole('button', { name: '새 루틴' }));
    await user.type(screen.getByRole('textbox', { name: '제목' }), '저녁 점검');
    await user.click(screen.getByRole('button', { name: '단계 추가' }));
    await user.type(screen.getByRole('textbox', { name: '단계 제목' }), '쉬었는지 확인');
    await user.click(screen.getByRole('button', { name: '루틴 버전 저장' }));
    expect(await screen.findByText(/루틴 버전 1을 저장했습니다/)).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/bff/v1/routines');
    expect(writes[0]?.body).toMatchObject({
      confirmed: true,
      expectedVersionId: null,
      blueprint: { schemaVersion: 4, title: '저녁 점검' },
    });
    expect(writes[0]?.body).not.toHaveProperty('idempotencyKey');
  });

  it('replays the exact run start command when its response is lost', async () => {
    const writes: TransportRequest[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'GET' && input.path === '/bff/v1/routines')
          return { status: 200, body: { items: [blueprint], hasMore: false }, traceId: null };
        if (input.method === 'GET' && input.path === `/bff/v1/routines/${routineId}`)
          return { status: 200, body: blueprint, traceId: null };
        writes.push(input);
        throw new Error('RESPONSE_LOST');
      },
    };
    const user = userEvent.setup();
    renderWorkspace(transport, { kind: 'detail', routineId });
    await screen.findByRole('button', { name: '계획 없이 실행' });
    await user.click(screen.getByRole('button', { name: '계획 없이 실행' }));
    await user.click(await screen.findByRole('button', { name: '같은 실행 시작 재시도' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]?.idempotencyKey).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toMatchObject({ blueprintVersionId: versionId, occurrenceId: null });
  });

  it('replays the exact schedule approval after an uncertain response', async () => {
    const writes: TransportRequest[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'GET' && input.path === `/bff/v1/routines/${routineId}`)
          return { status: 200, body: blueprint, traceId: null };
        if (input.method === 'GET' && input.path === '/bff/v1/routine-schedules')
          return { status: 200, body: { items: [], hasMore: false }, traceId: null };
        if (input.path === '/bff/v1/routine-schedule-previews') {
          const command = routineSchedulePreviewCommandSchema.parse(input.body);
          return {
            status: 200,
            body: {
              ...command,
              occurrences: [],
              conflicts: [],
              previewDigest: 'a'.repeat(64),
            },
            traceId: null,
          };
        }
        writes.push(input);
        throw new Error('RESPONSE_LOST');
      },
    };
    const user = userEvent.setup();
    renderWorkspace(transport, { kind: 'schedule', routineId });
    await screen.findByText(/저녁 점검 · 고정 버전/);
    fireEvent.change(screen.getByLabelText('현지 날짜'), { target: { value: '2026-11-02' } });
    await user.click(screen.getByRole('button', { name: '영향 미리보기' }));
    await user.click(await screen.findByRole('button', { name: '표시된 루틴 발생분 승인' }));
    await user.click(await screen.findByRole('button', { name: '같은 일정 승인 재시도' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]?.idempotencyKey).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toMatchObject({ previewDigest: 'a'.repeat(64) });
  });

  it('replays the exact scheduled run start after an uncertain response', async () => {
    const writes: TransportRequest[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'GET' && input.path === `/bff/v1/routines/${routineId}`)
          return { status: 200, body: blueprint, traceId: null };
        if (input.method === 'GET' && input.path === '/bff/v1/routine-schedules')
          return {
            status: 200,
            body: { items: [scheduleRead], hasMore: false },
            traceId: null,
          };
        writes.push(input);
        throw new Error('RESPONSE_LOST');
      },
    };
    const user = userEvent.setup();
    renderWorkspace(transport, { kind: 'schedule', routineId });
    await user.click(await screen.findByRole('button', { name: '이 발생분 실행' }));
    await user.click(await screen.findByRole('button', { name: '같은 발생분 실행 시작 재시도' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]?.idempotencyKey).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toMatchObject({ occurrenceId: scheduleRead.occurrences[0]?.id });
  });

  it('replays the exact step record after an uncertain response', async () => {
    const writes: TransportRequest[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'GET' && input.path === `/bff/v1/routine-runs/${runId}`)
          return { status: 200, body: runRead, traceId: null };
        if (input.method === 'GET' && input.path === `/bff/v1/routine-versions/${versionId}`)
          return { status: 200, body: blueprint.blueprint, traceId: null };
        writes.push(input);
        throw new Error('RESPONSE_LOST');
      },
    };
    const user = userEvent.setup();
    renderWorkspace(transport, { kind: 'run', runId });
    await screen.findByRole('button', { name: '수행 확인' });
    await user.click(screen.getByRole('button', { name: '수행 확인' }));
    await screen.findByRole('button', { name: '같은 단계 기록 재시도' });
    expect(
      screen.getByRole('textbox', { name: '부분·중단 이유 (선택)' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: '수행 확인' }).hasAttribute('disabled')).toBe(true);
    await user.click(await screen.findByRole('button', { name: '같은 단계 기록 재시도' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]?.idempotencyKey).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toMatchObject({ stepId, state: 'performed', expectedRevision: 0 });
  });

  it('allows starting a cleared timer again', async () => {
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.path === `/bff/v1/routine-runs/${runId}`)
          return {
            status: 200,
            body: {
              ...runRead,
              timers: [
                {
                  runId,
                  stepId,
                  revision: 2,
                  state: 'cleared',
                  durationSeconds: 60,
                  startedAt: '2026-09-18T00:00:00.000Z',
                  pausedAt: null,
                  pausedMilliseconds: 0,
                },
              ],
            },
            traceId: null,
          };
        return { status: 200, body: blueprint.blueprint, traceId: null };
      },
    };
    renderWorkspace(transport, { kind: 'run', runId });
    expect(await screen.findByRole('button', { name: '시작' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('spinbutton', { name: '보조 타이머 (초)' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});

it.each([
  ['APP_CONSENT_REQUIRED', '앱 데이터 처리 동의가 필요합니다.'],
  ['STALE_APP_ADMISSION', '앱 데이터 처리 동의가 변경되어'],
  ['APP_BINDING_UNAVAILABLE', '앱 데이터 처리 동의 기준을 확인할 수 없어'],
] as const)('keeps the blueprint draft on %s without saved success', async (code, message) => {
  let writes = 0;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.method === 'GET')
        return { status: 200, body: { items: [], hasMore: false }, traceId: null };
      writes += 1;
      return { status: 409, body: { error: { code } }, traceId: null };
    },
  };
  const user = userEvent.setup();
  render(
    <RoutineWorkspace
      athleteId="a"
      sessionId="s"
      transport={transport}
      route={{ kind: 'library' }}
    />,
  );
  await user.click(await screen.findByRole('button', { name: '새 루틴' }));
  const title = screen.getByRole('textbox', { name: '제목' });
  await user.type(title, '유지할 루틴');
  await user.click(screen.getByRole('button', { name: '단계 추가' }));
  await user.type(screen.getByRole('textbox', { name: '단계 제목' }), '유지할 단계');
  await user.click(screen.getByRole('button', { name: '루틴 버전 저장' }));
  expect(await screen.findByText(new RegExp(message))).toBeTruthy();
  expect((title as HTMLInputElement).value).toBe('유지할 루틴');
  expect(writes).toBe(1);
  expect(screen.queryByText(/루틴 버전 1을 저장했습니다/)).toBeNull();
  expect(screen.queryByText(/다른 기기에서 변경됐습니다/)).toBeNull();
});

const checkTemplate = {
  templateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  version: 1,
  previousVersionId: null,
  previousVersion: null,
  createdAt: '2026-10-08T00:00:00Z',
  content: {
    definitionVersion: 'checkin-v1' as const,
    source: 'user' as const,
    method: 'self_report' as const,
    title: '직접 보고 질문',
    instructions: null,
    fields: ['fatigue', 'discomfort'] as ('fatigue' | 'discomfort')[],
  },
};
const actualCheckIn = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  revision: 1,
  values: {
    observedAt: '2026-10-06T00:00:00Z',
    timezone: 'UTC',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: null,
  },
  localDate: '2026-10-06',
  recordedAt: '2026-10-06T00:00:01Z',
  updatedAt: '2026-10-06T00:00:01Z',
  source: 'user',
  method: 'self_report',
  definitionVersion: 'checkin-v1',
};
const checkBlueprint: RoutineBlueprintRead = {
  ...blueprint,
  blueprint: {
    ...blueprint.blueprint,
    steps: blueprint.blueprint.steps.map((step) => ({
      ...step,
      title: '피로 직접 보고',
      content: {
        kind: 'checkin_template',
        ref: { id: checkTemplate.templateId, versionId: checkTemplate.versionId },
      },
    })),
  },
};
it('explicitly selects an owned exact template version before saving a blueprint', async () => {
  let saved: RoutineBlueprintSaveCommandSchemaOutput | undefined;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.path.startsWith('/bff/v1/check-in-templates?'))
        return { status: 200, body: { items: [checkTemplate] }, traceId: null };
      if (input.path.includes('/versions/'))
        return { status: 200, body: checkTemplate, traceId: null };
      if (input.method === 'POST') {
        saved = routineBlueprintSaveCommandSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(input.body),
          idempotencyKey: input.idempotencyKey,
        });
        return { status: 200, body: { ...blueprint, blueprint: saved.blueprint }, traceId: null };
      }
      return { status: 200, body: { items: [], hasMore: false }, traceId: null };
    },
  };
  const user = userEvent.setup();
  renderWorkspace(transport, { kind: 'library' });
  await user.click(await screen.findByRole('button', { name: '새 루틴' }));
  await user.type(screen.getByRole('textbox', { name: '제목' }), '체크인 루틴');
  await user.click(screen.getByRole('button', { name: '단계 추가' }));
  await user.type(screen.getByRole('textbox', { name: '단계 제목' }), '보고');
  await user.selectOptions(screen.getByRole('combobox', { name: '종류' }), 'checkin_template');
  await user.selectOptions(
    await screen.findByRole('combobox', { name: '내 체크인 템플릿' }),
    checkTemplate.versionId,
  );
  expect(await screen.findByText(/사용자 직접 보고 \(self_report\)/)).toBeTruthy();
  expect(saved).toBeUndefined();
  await user.click(screen.getByRole('button', { name: '이 고정 버전 선택' }));
  await user.click(screen.getByRole('button', { name: '루틴 버전 저장' }));
  await waitFor(() =>
    expect(saved?.blueprint.steps[0]?.content).toEqual({
      kind: 'checkin_template',
      ref: { id: checkTemplate.templateId, versionId: checkTemplate.versionId },
    }),
  );
});
type RoutineBlueprintSaveCommandSchemaOutput = z.infer<typeof routineBlueprintSaveCommandSchema>;
it('keeps historical template pinned while the list offers a newer head', async () => {
  const newer = {
    ...checkTemplate,
    versionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    version: 2,
    previousVersionId: checkTemplate.versionId,
    previousVersion: 1,
  };
  let saved: RoutineBlueprintSaveCommandSchemaOutput | undefined;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.path.startsWith('/bff/v1/check-in-templates?'))
        return { status: 200, body: { items: [newer] }, traceId: null };
      if (input.path.includes('/versions/'))
        return { status: 200, body: checkTemplate, traceId: null };
      if (input.method === 'POST') {
        saved = routineBlueprintSaveCommandSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(input.body),
          idempotencyKey: input.idempotencyKey,
        });
        return {
          status: 200,
          body: { ...checkBlueprint, blueprint: saved.blueprint },
          traceId: null,
        };
      }
      if (input.path === `/bff/v1/routines/${routineId}`)
        return { status: 200, body: checkBlueprint, traceId: null };
      return { status: 200, body: { items: [checkBlueprint], hasMore: false }, traceId: null };
    },
  };
  const user = userEvent.setup();
  renderWorkspace(transport, { kind: 'detail', routineId, edit: true });
  expect(await screen.findByText(/고정 버전 1 · 사용자/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '루틴 버전 저장' }));
  await waitFor(() =>
    expect(saved?.blueprint.steps[0]?.content).toEqual(checkBlueprint.blueprint.steps[0]?.content),
  );
});
it('keeps a failed template save frozen and retries the identical key/body', async () => {
  const writes: TransportRequest[] = [];
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.path.startsWith('/bff/v1/check-in-templates?'))
        return { status: 200, body: { items: [] }, traceId: null };
      if (input.path.includes('/versions/'))
        return { status: 200, body: checkTemplate, traceId: null };
      if (input.path === '/bff/v1/check-in-templates' && input.method === 'POST') {
        writes.push(input);
        return { status: 500, body: { error: { code: 'INTERNAL_ERROR' } }, traceId: null };
      }
      return { status: 200, body: { items: [], hasMore: false }, traceId: null };
    },
  };
  const user = userEvent.setup();
  renderWorkspace(transport, { kind: 'library' });
  await user.click(await screen.findByRole('button', { name: '새 루틴' }));
  await user.click(screen.getByRole('button', { name: '단계 추가' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '종류' }), 'checkin_template');
  await user.type(
    await screen.findByRole('textbox', { name: '체크인 템플릿 제목' }),
    '보존할 질문',
  );
  await user.click(screen.getByRole('button', { name: '체크인 입력 항목 저장' }));
  expect(await screen.findByText(/저장 결과가 불확실합니다. 같은 입력과 요청/)).toBeTruthy();
  expect(
    screen.getByRole('textbox', { name: '체크인 템플릿 제목' }).closest('fieldset'),
  ).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: '같은 템플릿 저장 재시도' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]?.body).toEqual(writes[0]?.body);
  expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
  expect(screen.queryByText(/입력 항목을 저장했습니다/)).toBeNull();
});
it('validates the actual CheckIn before linking numeric revision, with zero distinct from unknown', async () => {
  let body: unknown;
  let current = runRead;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.path === `/bff/v1/check-ins/${actualCheckIn.id}`)
        return { status: 200, body: actualCheckIn, traceId: null };
      if (input.path === `/bff/v1/routine-runs/${runId}/steps`) {
        body = input.body;
        current = { ...runRead, run: { ...runRead.run, revision: 1 } };
        return { status: 200, body: current, traceId: null };
      }
      if (input.path === `/bff/v1/routine-runs/${runId}`)
        return { status: 200, body: current, traceId: null };
      return { status: 200, body: checkBlueprint.blueprint, traceId: null };
    },
  };
  const user = userEvent.setup();
  renderWorkspace(transport, { kind: 'run', runId });
  const id = await screen.findByRole('textbox', { name: '실제 체크인 ID (UUID)' });
  expect(screen.getByRole('button', { name: '수행 확인' })).toHaveProperty('disabled', true);
  await user.type(id, actualCheckIn.id);
  await user.click(screen.getByRole('button', { name: '실제 체크인 확인' }));
  expect(await screen.findByText('피로: 0 / 불편감: 미상')).toBeTruthy();
  expect(screen.getByRole('button', { name: '수행 확인' })).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: '이 실제 체크인 연결' }));
  await user.click(screen.getByRole('button', { name: '수행 확인' }));
  await waitFor(() =>
    expect(body).toMatchObject({
      actualRefs: [{ kind: 'checkin', id: actualCheckIn.id, revisionId: '1' }],
      occurredAt: null,
      confirmed: true,
    }),
  );
});
it('rejects foreign/mismatched actual response before a run write', async () => {
  let writes = 0;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.method === 'POST') writes += 1;
      if (input.path.startsWith('/bff/v1/check-ins/'))
        return {
          status: 200,
          body: { ...actualCheckIn, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
          traceId: null,
        };
      if (input.path === `/bff/v1/routine-runs/${runId}`)
        return { status: 200, body: runRead, traceId: null };
      return { status: 200, body: checkBlueprint.blueprint, traceId: null };
    },
  };
  const user = userEvent.setup();
  renderWorkspace(transport, { kind: 'run', runId });
  await user.type(
    await screen.findByRole('textbox', { name: '실제 체크인 ID (UUID)' }),
    actualCheckIn.id,
  );
  await user.click(screen.getByRole('button', { name: '실제 체크인 확인' }));
  expect(await screen.findByText(/실제 체크인을 확인하지 못했습니다/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '수행 확인' })).toHaveProperty('disabled', true);
  expect(writes).toBe(0);
});
it('does not fall back from unavailable recovery to an intake actual', async () => {
  const recoveryBlueprint = {
    ...blueprint.blueprint,
    steps: blueprint.blueprint.steps.map((step) => ({
      ...step,
      content: {
        kind: 'recovery_method' as const,
        ref: { id: checkTemplate.templateId, versionId: checkTemplate.versionId },
      },
    })),
  };
  const request: AuthenticatedTransport['request'] = async (input) => ({
    status: 200,
    body: input.path === `/bff/v1/routine-runs/${runId}` ? runRead : recoveryBlueprint,
    traceId: null,
  });
  renderWorkspace({ request }, { kind: 'run', runId });
  expect(
    await screen.findByText(/회복 단계의 실제 기록 연결은 아직 지원하지 않습니다/),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: '수행 확인' })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('textbox', { name: '기존 실제 기록 ID' })).toBeNull();
});
it('shows template save success only after a committed response and still requires explicit selection', async () => {
  let release:
    ((value: Awaited<ReturnType<AuthenticatedTransport['request']>>) => void) | undefined;
  const pending = new Promise<Awaited<ReturnType<AuthenticatedTransport['request']>>>((resolve) => {
    release = resolve;
  });
  let created: CheckInTemplateVersion = checkTemplate;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.path.startsWith('/bff/v1/check-in-templates?'))
        return { status: 200, body: { items: [] }, traceId: null };
      if (input.path.includes('/versions/')) return { status: 200, body: created, traceId: null };
      if (input.path === '/bff/v1/check-in-templates' && input.method === 'POST') {
        const body = z
          .strictObject({
            templateId: z.uuid(),
            expectedVersion: z.literal(0),
            content: z.strictObject({
              definitionVersion: z.literal('checkin-v1'),
              source: z.literal('user'),
              method: z.literal('self_report'),
              title: z.string(),
              instructions: z.string().nullable(),
              fields: z.array(z.enum(['fatigue', 'discomfort'])),
            }),
          })
          .parse(input.body);
        created = { ...checkTemplate, templateId: body.templateId, content: body.content };
        return pending;
      }
      return { status: 200, body: { items: [], hasMore: false }, traceId: null };
    },
  };
  const user = userEvent.setup();
  renderWorkspace(transport, { kind: 'library' });
  await user.click(await screen.findByRole('button', { name: '새 루틴' }));
  await user.click(screen.getByRole('button', { name: '단계 추가' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '종류' }), 'checkin_template');
  await user.type(
    await screen.findByRole('textbox', { name: '체크인 템플릿 제목' }),
    '새 직접 보고',
  );
  await user.click(screen.getByRole('button', { name: '체크인 입력 항목 저장' }));
  expect(screen.queryByText(/입력 항목을 저장했습니다/)).toBeNull();
  expect(
    screen.getByRole('textbox', { name: '체크인 템플릿 제목' }).closest('fieldset'),
  ).toHaveProperty('disabled', true);
  release?.({ status: 200, body: created, traceId: null });
  expect(await screen.findByText(/입력 항목을 저장했습니다/)).toBeTruthy();
  expect(await screen.findByRole('button', { name: '이 고정 버전 선택' })).toHaveProperty(
    'disabled',
    false,
  );
});
it('keeps template input on app withdrawal without showing saved success', async () => {
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.path.startsWith('/bff/v1/check-in-templates?'))
        return { status: 200, body: { items: [] }, traceId: null };
      if (input.method === 'POST')
        return { status: 409, body: { error: { code: 'APP_CONSENT_REQUIRED' } }, traceId: null };
      return { status: 200, body: { items: [], hasMore: false }, traceId: null };
    },
  };
  const user = userEvent.setup();
  renderWorkspace(transport, { kind: 'library' });
  await user.click(await screen.findByRole('button', { name: '새 루틴' }));
  await user.click(screen.getByRole('button', { name: '단계 추가' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '종류' }), 'checkin_template');
  const input = await screen.findByRole('textbox', { name: '체크인 템플릿 제목' });
  await user.type(input, '유지할 질문');
  await user.click(screen.getByRole('button', { name: '체크인 입력 항목 저장' }));
  expect(
    await screen.findByText(/앱 데이터 처리 동의가 필요합니다. 입력은 유지됩니다/),
  ).toBeTruthy();
  expect(input).toHaveProperty('value', '유지할 질문');
  expect(input.closest('fieldset')).toHaveProperty('disabled', false);
  expect(screen.queryByText(/입력 항목을 저장했습니다/)).toBeNull();
});
it('aborts private actual read and discards its selector on account/session change', async () => {
  let signal: AbortSignal | undefined;
  const request: AuthenticatedTransport['request'] = async (input) => {
    if (input.path.startsWith('/bff/v1/check-ins/')) {
      signal = input.signal;
      return new Promise(() => undefined);
    }
    return {
      status: 200,
      body: input.path === `/bff/v1/routine-runs/${runId}` ? runRead : checkBlueprint.blueprint,
      traceId: null,
    };
  };
  const user = userEvent.setup();
  const view = render(
    <RoutineWorkspace
      athleteId="alice"
      sessionId="a"
      transport={{ request }}
      route={{ kind: 'run', runId }}
    />,
  );
  await user.type(
    await screen.findByRole('textbox', { name: '실제 체크인 ID (UUID)' }),
    actualCheckIn.id,
  );
  await user.click(screen.getByRole('button', { name: '실제 체크인 확인' }));
  await waitFor(() => expect(signal).toBeDefined());
  view.rerender(
    <RoutineWorkspace
      athleteId="bob"
      sessionId="b"
      transport={{
        request: async () => ({ status: 200, body: { items: [], hasMore: false }, traceId: null }),
      }}
      route={{ kind: 'library' }}
    />,
  );
  await waitFor(() => expect(signal?.aborted).toBe(true));
  expect(screen.queryByRole('textbox', { name: '실제 체크인 ID (UUID)' })).toBeNull();
  expect(screen.queryByText(/피로: 0/)).toBeNull();
});
