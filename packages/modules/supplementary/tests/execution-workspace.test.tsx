import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import {
  supplementarySetLogRevisionSchema,
  type SupplementaryExecution,
} from '@workout/contracts/supplementary-core';
import { createSupplementaryApi } from '../src/supplementary-api';
import { ExecutionWorkspace } from '../src/execution-workspace';
import {
  definitionFromForm,
  emptyExerciseForm,
  setValuesFromInputs,
} from '../src/supplementary-model';

const executionId = '11111111-1111-4111-8111-111111111111';
const activityId = '22222222-2222-4222-8222-222222222222';
const exerciseId = '33333333-3333-4333-8333-333333333333';
const exerciseVersionId = '44444444-4444-4444-8444-444444444444';
const logId = '55555555-5555-4555-8555-555555555555';
const occurredAt = '2026-09-17T06:00:00.000Z';
const scope = ['users', 'athlete-1', 'sessions', 'session-1', 'supplementary'] as const;
const exercise = {
  version: 1,
  definition: definitionFromForm(
    { ...emptyExerciseForm, name: '점프', description: '사용자 설명' },
    null,
    { exerciseId, versionId: exerciseVersionId, definitionId: 'rep-total-v1' },
    '2026-09-17T00:00:00.000Z',
  ),
};
const execution = (revision: number): SupplementaryExecution => ({
  schemaVersion: 2,
  executionId,
  activityId,
  plannedSession: null,
  revision,
  status: 'active',
  startedAt: '2026-09-17T05:00:00.000Z',
  endedAt: null,
});
const set = (revision: number, count = '4') => ({
  status: 'active' as const,
  current: supplementarySetLogRevisionSchema.parse({
    ...setValuesFromInputs({
      exerciseVersionId,
      definition: exercise.definition.countDefinitions[0] ?? null,
      side: 'bilateral',
      state: 'performed',
      count,
      duration: '',
      resistance: '',
      resistanceKind: 'no_added_load',
      rpe: '',
      rir: '',
      reason: '',
      occurredAt,
      targetSetId: null,
      blockId: null,
    }),
    logId,
    revisionId:
      revision === 1
        ? '66666666-6666-4666-8666-666666666666'
        : '77777777-7777-4777-8777-777777777777',
    activityId,
    executionId,
    revision,
    source: 'user',
    recordedAt: '2026-09-17T07:00:00.000Z',
  }),
});

function baseReply(
  input: TransportRequest,
  revision = 1,
  setRevision: number | null = null,
  setCount = '4',
): Awaited<ReturnType<AuthenticatedTransport['request']>> {
  if (input.path === '/bff/v1/supplementary/executions')
    return { status: 200, body: { items: [execution(revision)], hasMore: false }, traceId: null };
  if (input.path === `/bff/v1/supplementary/executions/${executionId}`)
    return { status: 200, body: execution(revision), traceId: null };
  if (input.path === '/bff/v1/supplementary/exercises')
    return { status: 200, body: { items: [exercise], hasMore: false }, traceId: null };
  if (input.path === `/bff/v1/supplementary/executions/${executionId}/sets`)
    return {
      status: 200,
      body: { items: setRevision === null ? [] : [set(setRevision, setCount)], hasMore: false },
      traceId: null,
    };
  if (input.path === `/bff/v1/supplementary/executions/${executionId}/rest-timers`)
    return { status: 200, body: { items: [], hasMore: false }, traceId: null };
  throw new Error(`UNEXPECTED_PATH:${input.method}:${input.path}`);
}

function mount(transport: AuthenticatedTransport) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <ExecutionWorkspace
        api={createSupplementaryApi(transport)}
        scope={scope}
        executionId={executionId}
      />
    </QueryClientProvider>,
  );
  return { client, user };
}

describe('execution workspace delivery and freshness', () => {
  it('keeps the runner draft visible but blocks writes after a failed refetch, then uses the new revision', async () => {
    let reads = 0;
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.path === `/bff/v1/supplementary/executions/${executionId}`) {
          reads += 1;
          if (reads === 2) throw new Error('OFFLINE');
          return baseReply(input, reads === 3 ? 2 : 1);
        }
        return baseReply(input);
      },
    };
    const { client, user } = mount(transport);
    const exerciseSelect = await screen.findByRole('combobox', { name: '동작 버전' });
    await user.selectOptions(exerciseSelect, exerciseVersionId);
    await user.type(screen.getByRole('spinbutton', { name: /실제 횟수/ }), '7');
    await client.invalidateQueries({ queryKey: [...scope, 'execution', executionId] });
    expect(await screen.findByText(/최신 수행 상태를 불러오지 못했습니다/)).toBeTruthy();
    expect((screen.getByRole('spinbutton', { name: /실제 횟수/ }) as HTMLInputElement).value).toBe(
      '7',
    );
    expect(screen.getByRole('button', { name: '세트 초안 저장' }).hasAttribute('disabled')).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: '수행 다시 조회' }));
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '세트 초안 저장' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    expect((screen.getByRole('spinbutton', { name: /실제 횟수/ }) as HTMLInputElement).value).toBe(
      '7',
    );
    expect(screen.getByText(/수정 2/)).toBeTruthy();
  });

  it('keeps correction occurredAt but requires reselecting after a 409 before using the new revision', async () => {
    const patches: TransportRequest[] = [];
    let revision = 1;
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'PATCH') {
          patches.push(input);
          if (patches.length === 1) {
            revision = 2;
            return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
          }
          return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
        }
        return baseReply(input, revision, revision);
      },
    };
    const { user } = mount(transport);
    await screen.findByRole('button', { name: '정정' });
    await user.click(screen.getByRole('button', { name: '정정' }));
    const count = screen.getByRole('spinbutton', { name: /실제 횟수/ });
    await user.clear(count);
    await user.type(count, '5');
    await user.click(screen.getByRole('button', { name: '확인하고 실제 세트 저장' }));
    await screen.findByText(/세트 버전이 변경됐습니다/);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '확인하고 실제 세트 저장' }).hasAttribute('disabled'),
      ).toBe(true),
    );
    expect((screen.getByRole('spinbutton', { name: /실제 횟수/ }) as HTMLInputElement).value).toBe(
      '5',
    );
    await user.click(screen.getByRole('button', { name: '확인하고 실제 세트 저장' }));
    expect(patches).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '정정' }));
    const latestCount = screen.getByRole('spinbutton', { name: /실제 횟수/ });
    expect((latestCount as HTMLInputElement).value).toBe('4');
    await user.clear(latestCount);
    await user.type(latestCount, '5');
    await user.click(screen.getByRole('button', { name: '확인하고 실제 세트 저장' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    const command = z
      .object({ expectedRevision: z.number(), values: z.object({ occurredAt: z.string() }) })
      .parse(patches[1]?.body);
    expect(command.expectedRevision).toBe(2);
    expect(command.values.occurredAt).toBe(occurredAt);
    expect(patches[0]?.idempotencyKey).not.toBe(patches[1]?.idempotencyKey);
  });

  it('replays the frozen correction after a lost response and newer set refetch', async () => {
    const patches: TransportRequest[] = [];
    let revision = 1;
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'PATCH') {
          patches.push(input);
          if (patches.length === 1) {
            revision = 2;
            throw new Error('RESPONSE_LOST_AFTER_COMMIT');
          }
          return { status: 200, body: set(2, '5'), traceId: null };
        }
        return baseReply(input, revision, revision, revision === 2 ? '5' : '4');
      },
    };
    const { client, user } = mount(transport);
    await user.click(await screen.findByRole('button', { name: '정정' }));
    const count = screen.getByRole('spinbutton', { name: /실제 횟수/ });
    await user.clear(count);
    await user.type(count, '5');
    await user.click(screen.getByRole('button', { name: '확인하고 실제 세트 저장' }));
    expect(await screen.findByRole('button', { name: '같은 세트 명령 재시도' })).toBeTruthy();
    await client.invalidateQueries({ queryKey: [...scope, 'sets', executionId] });
    expect(await screen.findByText(/먼저 같은 명령을 재시도해 결과를 확인하세요/)).toBeTruthy();
    expect((count as HTMLInputElement).value).toBe('5');
    const retry = screen.getByRole('button', { name: '같은 세트 명령 재시도' });
    expect(retry.hasAttribute('disabled')).toBe(false);
    await user.click(retry);
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]?.idempotencyKey).toBe(patches[0]?.idempotencyKey);
    expect(patches[1]?.body).toEqual(patches[0]?.body);
    expect(await screen.findByText('세트 기록을 저장했습니다.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '세트 초안 저장' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    expect((screen.getByRole('spinbutton', { name: /실제 횟수/ }) as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('clears an uncertain correction after a replay conflict so the latest set can be reselected', async () => {
    const patches: TransportRequest[] = [];
    let revision = 1;
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'PATCH') {
          patches.push(input);
          if (patches.length === 1) {
            revision = 2;
            throw new Error('RESPONSE_LOST');
          }
          return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
        }
        return baseReply(input, revision, revision);
      },
    };
    const { client, user } = mount(transport);
    await user.click(await screen.findByRole('button', { name: '정정' }));
    const count = screen.getByRole('spinbutton', { name: /실제 횟수/ });
    await user.clear(count);
    await user.type(count, '5');
    await user.click(screen.getByRole('button', { name: '확인하고 실제 세트 저장' }));
    await screen.findByRole('button', { name: '같은 세트 명령 재시도' });
    await client.invalidateQueries({ queryKey: [...scope, 'sets', executionId] });
    await user.click(screen.getByRole('button', { name: '같은 세트 명령 재시도' }));
    await screen.findByText(/세트 버전이 변경됐습니다/);
    expect(patches).toHaveLength(2);
    expect(patches[1]?.idempotencyKey).toBe(patches[0]?.idempotencyKey);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '정정' }).hasAttribute('disabled')).toBe(false),
    );
    expect((count as HTMLInputElement).value).toBe('5');
    expect(
      screen.getByRole('button', { name: '확인하고 실제 세트 저장' }).hasAttribute('disabled'),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: '정정' }));
    expect((screen.getByRole('spinbutton', { name: /실제 횟수/ }) as HTMLInputElement).value).toBe(
      '4',
    );
    expect(
      screen.getByRole('button', { name: '확인하고 실제 세트 저장' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('blocks a correction when a concurrent set revision arrives before submit', async () => {
    let revision = 1;
    const patches: TransportRequest[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'PATCH') {
          patches.push(input);
          return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
        }
        return baseReply(input, revision, revision);
      },
    };
    const { client, user } = mount(transport);
    await user.click(await screen.findByRole('button', { name: '정정' }));
    const count = screen.getByRole('spinbutton', { name: /실제 횟수/ });
    await user.clear(count);
    await user.type(count, '5');
    revision = 2;
    await client.invalidateQueries({ queryKey: [...scope, 'sets', executionId] });
    expect(await screen.findByText(/정정 중인 세트의 기준이 바뀌었습니다/)).toBeTruthy();
    expect((screen.getByRole('spinbutton', { name: /실제 횟수/ }) as HTMLInputElement).value).toBe(
      '5',
    );
    expect(
      screen.getByRole('button', { name: '확인하고 실제 세트 저장' }).hasAttribute('disabled'),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: '확인하고 실제 세트 저장' }));
    expect(patches).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '정정' }));
    const freshCount = screen.getByRole('spinbutton', { name: /실제 횟수/ });
    await user.clear(freshCount);
    await user.type(freshCount, '5');
    await user.click(screen.getByRole('button', { name: '확인하고 실제 세트 저장' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(
      z.object({ expectedRevision: z.number() }).parse(patches[0]?.body).expectedRevision,
    ).toBe(2);
  });

  it('locks Activity matching during a delayed start and replays the same command after response loss', async () => {
    const writes: TransportRequest[] = [];
    const deferred: { reject?: (reason: Error) => void } = {};
    const first = new Promise<never>((_resolve, reject) => {
      deferred.reject = reject;
    });
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'POST' && input.path === '/bff/v1/supplementary/executions') {
          writes.push(input);
          if (writes.length === 1) return first;
          return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
        }
        return baseReply(input);
      },
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <ExecutionWorkspace
          api={createSupplementaryApi(transport)}
          scope={scope}
          executionId={null}
        />
      </QueryClientProvider>,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Activity 연결 방식' }), 'match');
    await user.type(screen.getByRole('textbox', { name: '기존 Activity ID' }), activityId);
    await user.click(screen.getByRole('button', { name: '확인하고 수행 시작' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(
      screen
        .getByRole('textbox', { name: '기존 Activity ID' })
        .closest('fieldset')
        ?.hasAttribute('disabled'),
    ).toBe(true);
    if (!deferred.reject) throw new Error('MISSING_FIRST_REQUEST');
    deferred.reject(new Error('RESPONSE_LOST'));
    await user.click(await screen.findByRole('button', { name: '같은 시작 명령 재시도' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
  });

  it('keeps a set create ID and idempotency key stable through a lost response', async () => {
    const writes: TransportRequest[] = [];
    const deferred: { reject?: (reason: Error) => void } = {};
    const first = new Promise<never>((_resolve, reject) => {
      deferred.reject = reject;
    });
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (
          input.method === 'POST' &&
          input.path === `/bff/v1/supplementary/executions/${executionId}/sets`
        ) {
          writes.push(input);
          if (writes.length === 1) return first;
          return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
        }
        return baseReply(input);
      },
    };
    const { user } = mount(transport);
    await screen.findByRole('option', { name: '점프 · 버전 1' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '세트 초안 저장' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: '동작 버전' }),
      exerciseVersionId,
    );
    expect((screen.getByRole('combobox', { name: '동작 버전' }) as HTMLSelectElement).value).toBe(
      exerciseVersionId,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: '상태' }), 'performed');
    await user.type(screen.getByRole('spinbutton', { name: /실제 횟수/ }), '4');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '확인하고 실제 세트 저장' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    const submit = screen.getByRole('button', { name: '확인하고 실제 세트 저장' });
    const form = submit.closest('form');
    if (!(form instanceof HTMLFormElement)) throw new Error('MISSING_SET_FORM');
    expect(form.checkValidity()).toBe(true);
    await user.click(submit);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(
      screen
        .getByRole('spinbutton', { name: /실제 횟수/ })
        .closest('fieldset')
        ?.hasAttribute('disabled'),
    ).toBe(true);
    if (!deferred.reject) throw new Error('MISSING_FIRST_REQUEST');
    deferred.reject(new Error('RESPONSE_LOST'));
    await user.click(await screen.findByRole('button', { name: '같은 세트 명령 재시도' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
  });

  it('retries an uncertain set deletion with the original command', async () => {
    const writes: TransportRequest[] = [];
    const deferred: { reject?: (reason: Error) => void } = {};
    const first = new Promise<never>((_resolve, reject) => {
      deferred.reject = reject;
    });
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'DELETE') {
          writes.push(input);
          if (writes.length === 1) return first;
          return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
        }
        return baseReply(input, 1, 1);
      },
    };
    const { user } = mount(transport);
    await user.click(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    if (!deferred.reject) throw new Error('MISSING_FIRST_REQUEST');
    deferred.reject(new Error('RESPONSE_LOST'));
    await user.click(await screen.findByRole('button', { name: '같은 삭제 명령 재시도' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
  });

  it('clears timer and completion keys on 409 and reissues commands against fetched revisions', async () => {
    let executionRevision = 1;
    let timerRevision = 1;
    let timerRecord: {
      timerId: string;
      executionId: string;
      revision: number;
      durationSeconds: number;
      startedAt: string;
      deadlineAt: string;
      pausedAt: null;
      remainingWhenPausedSeconds: null;
      status: 'running';
    } | null = null;
    const timerCommands: TransportRequest[] = [];
    const completions: TransportRequest[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.path === '/bff/v1/supplementary/rest-timers' && input.method === 'POST') {
          const body = z
            .object({
              action: z.string(),
              timerId: z.string(),
              executionId: z.string(),
              durationSeconds: z.number().optional(),
              at: z.string(),
              expectedRevision: z.number().optional(),
            })
            .parse(input.body);
          if (body.action === 'start') {
            timerRecord = {
              timerId: body.timerId,
              executionId,
              revision: 1,
              durationSeconds: body.durationSeconds ?? 60,
              startedAt: body.at,
              deadlineAt: new Date(Date.parse(body.at) + 60_000).toISOString(),
              pausedAt: null,
              remainingWhenPausedSeconds: null,
              status: 'running',
            };
            return { status: 200, body: timerRecord, traceId: null };
          }
          timerCommands.push(input);
          if (timerCommands.length === 1) {
            timerRevision = 2;
            return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
          }
          return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
        }
        if (
          input.path.startsWith('/bff/v1/supplementary/rest-timers/') &&
          input.method === 'GET' &&
          timerRecord
        )
          return { status: 200, body: { ...timerRecord, revision: timerRevision }, traceId: null };
        if (
          input.path === `/bff/v1/supplementary/executions/${executionId}/completion` &&
          input.method === 'POST'
        ) {
          completions.push(input);
          if (completions.length === 1) {
            executionRevision = 2;
            return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
          }
          return { status: 409, body: { error: { code: 'REVISION_CONFLICT' } }, traceId: null };
        }
        return baseReply(input, executionRevision);
      },
    };
    const { user } = mount(transport);
    await screen.findByRole('button', { name: '휴식 시작' });
    await user.click(screen.getByRole('button', { name: '휴식 시작' }));
    await screen.findByRole('button', { name: '일시정지' });
    await user.click(screen.getByRole('button', { name: '일시정지' }));
    await screen.findByText(/타이머 상태가 변경됐습니다/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '일시정지' }).hasAttribute('disabled')).toBe(false),
    );
    await user.click(screen.getByRole('button', { name: '일시정지' }));
    await waitFor(() => expect(timerCommands).toHaveLength(2));
    expect(
      z.object({ expectedRevision: z.number() }).parse(timerCommands[1]?.body).expectedRevision,
    ).toBe(2);
    expect(timerCommands[1]?.idempotencyKey).not.toBe(timerCommands[0]?.idempotencyKey);
    await user.click(screen.getByRole('button', { name: '수행 종료 확인' }));
    await screen.findByText(/수행 상태가 변경됐습니다/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '수행 종료 확인' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    await user.click(screen.getByRole('button', { name: '수행 종료 확인' }));
    await waitFor(() => expect(completions).toHaveLength(2));
    expect(
      z.object({ expectedRevision: z.number() }).parse(completions[1]?.body).expectedRevision,
    ).toBe(2);
    expect(completions[1]?.idempotencyKey).not.toBe(completions[0]?.idempotencyKey);
  });
});
