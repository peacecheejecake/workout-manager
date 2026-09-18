import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import {
  routineBlueprintSaveCommandSchema,
  routineSchedulePreviewCommandSchema,
  type RoutineBlueprintRead,
  type RoutineRunRead,
  type RoutineScheduleRead,
} from '@workout/contracts/routine-commands';
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
