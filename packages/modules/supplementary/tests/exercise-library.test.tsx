import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { supplementaryExerciseVersionSchema } from '@workout/contracts/supplementary-core';
import { createSupplementaryApi } from '../src/supplementary-api';
import { ExerciseLibrary } from '../src/exercise-library';

describe('exercise library', () => {
  it('keeps movement family separate from equipment and saves user content as unreviewed', async () => {
    const writes: TransportRequest[] = [];
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'GET')
          return { status: 200, body: { items: [], hasMore: false }, traceId: null };
        writes.push(input);
        const body = z.object({ definition: supplementaryExerciseVersionSchema }).parse(input.body);
        return { status: 200, body: { definition: body.definition, version: 1 }, traceId: null };
      },
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <ExerciseLibrary
          api={createSupplementaryApi(transport)}
          scope={['users', 'athlete-1', 'sessions', 'session-1', 'supplementary']}
          exerciseId={null}
        />
      </QueryClientProvider>,
    );
    await screen.findByText('등록된 동작이 없습니다.');
    await user.click(screen.getByRole('button', { name: '동작 추가' }));
    await user.type(screen.getByRole('textbox', { name: '이름' }), '맨몸 점프');
    await user.selectOptions(screen.getByRole('combobox', { name: '동작 계열' }), 'plyometric');
    await user.type(screen.getByRole('textbox', { name: '수행 설명' }), '사용자가 확인한 설명');
    await user.click(screen.getByRole('button', { name: '확인하고 버전 저장' }));
    expect(await screen.findByText(/동작 버전 1을 저장했습니다/)).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(writes[0]?.body).toMatchObject({
      confirmed: true,
      expectedVersionId: null,
      definition: { family: 'plyometric', equipment: ['bodyweight'], reviewState: 'unreviewed' },
    });
  });
});

describe('exercise save delivery', () => {
  it('locks the draft during a delayed request and replays the same command after a lost response', async () => {
    const writes: TransportRequest[] = [];
    const deferred: { reject?: (reason: Error) => void } = {};
    const firstResponse = new Promise<never>((_resolve, reject) => {
      deferred.reject = reject;
    });
    const transport: AuthenticatedTransport = {
      async request(input) {
        if (input.method === 'GET')
          return { status: 200, body: { items: [], hasMore: false }, traceId: null };
        writes.push(input);
        if (writes.length === 1) return firstResponse;
        const body = z.object({ definition: supplementaryExerciseVersionSchema }).parse(input.body);
        return { status: 200, body: { definition: body.definition, version: 1 }, traceId: null };
      },
    };
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ExerciseLibrary
          api={createSupplementaryApi(transport)}
          scope={['users', 'athlete-1', 'sessions', 'session-1', 'supplementary']}
          exerciseId={null}
        />
      </QueryClientProvider>,
    );
    await screen.findByText('등록된 동작이 없습니다.');
    await user.click(screen.getByRole('button', { name: '동작 추가' }));
    await user.type(screen.getByRole('textbox', { name: '이름' }), '점프');
    await user.type(screen.getByRole('textbox', { name: '수행 설명' }), '동작 설명');
    await user.click(screen.getByRole('button', { name: '확인하고 버전 저장' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(
      screen.getByRole('textbox', { name: '이름' }).closest('fieldset')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: '동작 추가' }).hasAttribute('disabled')).toBe(true);
    if (!deferred.reject) throw new Error('MISSING_FIRST_REQUEST');
    deferred.reject(new Error('RESPONSE_LOST'));
    expect(await screen.findByRole('button', { name: '같은 저장 명령 재시도' })).toBeTruthy();
    expect(
      screen.getByRole('textbox', { name: '이름' }).closest('fieldset')?.hasAttribute('disabled'),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: '같은 저장 명령 재시도' }));
    expect(await screen.findByText(/동작 버전 1을 저장했습니다/)).toBeTruthy();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
  });
});
