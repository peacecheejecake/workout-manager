import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import type { CoachingRunV1 } from '@workout/contracts/coaching-runs';
import { CoachingRunPanel } from '../src/run-panel';

afterEach(cleanup);
const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const evidenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const outputId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const run: CoachingRunV1 = {
  schemaVersion: 1,
  id: runId,
  threadId,
  evidenceSnapshotId: evidenceId,
  conversationRevision: 1,
  policy: { id: 'running-core-policy', version: '2026-09-18' },
  source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
  status: { kind: 'queued' },
};
function fixture(initial: CoachingRunV1 | null = null) {
  let current = initial;
  let createFailure: 'unknown' | null = null;
  let fixtureFailure = false;
  const requests: TransportRequest[] = [];
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    requests.push(input);
    if (input.method === 'POST' && input.path.endsWith('/runs')) {
      if (createFailure) {
        createFailure = null;
        throw new Error('secret transport detail');
      }
      current = run;
      return transportReplySchema.parse({ status: 200, traceId: null, body: run });
    }
    if (input.method === 'POST' && input.path.endsWith('/candidates')) {
      fixtureFailure = true;
      return transportReplySchema.parse({
        status: 409,
        traceId: null,
        body: { error: { code: 'STALE_BASIS', detail: 'secret backend detail' } },
      });
    }
    if (input.path.includes('/candidates'))
      return transportReplySchema.parse({ status: 200, traceId: null, body: [] });
    if (input.path.includes('/runs?'))
      return transportReplySchema.parse({
        status: 200,
        traceId: null,
        body: { items: current ? [current] : [], total: current ? 1 : 0 },
      });
    return transportReplySchema.parse({ status: 200, traceId: null, body: current ?? run });
  });
  return {
    transport: { request },
    requests,
    failCreate: () => {
      createFailure = 'unknown';
    },
    fixtureWasRequested: () => fixtureFailure,
  };
}
function Harness({
  transport,
  snapshotId = evidenceId,
  revision = 1,
}: {
  transport: AuthenticatedTransport;
  snapshotId?: string | null;
  revision?: number | null;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <CoachingRunPanel
        athleteId="athlete"
        sessionId="login-session"
        transport={transport}
        threadId={threadId}
        snapshotId={snapshotId}
        observedRevision={revision}
        createId={() => 'same-request-key'}
      />
    </QueryClientProvider>
  );
}

describe('coaching run panel', () => {
  it('requires selected evidence and a fully observed conversation; sends no plan write', async () => {
    const f = fixture();
    const rendered = render(<Harness transport={f.transport} snapshotId={null} />);
    expect(screen.getByRole('button', { name: '선택한 근거로 실행' })).toBeDisabled();
    expect(screen.getByText('실행하려면 저장된 근거를 먼저 선택하세요.')).toBeVisible();
    rendered.rerender(<Harness transport={f.transport} revision={null} />);
    expect(screen.getByRole('button', { name: '선택한 근거로 실행' })).toBeDisabled();
    rendered.rerender(<Harness transport={f.transport} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '선택한 근거로 실행' }));
    await screen.findByRole('region', { name: '선택한 실행' });
    const posts = f.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      path: `/bff/v1/coaching-threads/${threadId}/runs`,
      body: { schemaVersion: 1, evidenceSnapshotId: evidenceId, expectedConversationRevision: 1 },
      idempotencyKey: 'same-request-key',
    });
    expect(f.requests.every((request) => !request.path.includes('/plans/'))).toBe(true);
    expect(screen.queryByRole('link', { name: /후보 제안 검토/ })).not.toBeInTheDocument();
  });

  it('retries an uncertain create with the same body and key and never renders transport details', async () => {
    const f = fixture();
    f.failCreate();
    render(<Harness transport={f.transport} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '선택한 근거로 실행' }));
    await screen.findByRole('button', { name: '같은 요청 재확인' });
    expect(screen.queryByText('secret transport detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '선택한 근거로 실행' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '같은 요청 재확인' }));
    await screen.findByRole('region', { name: '선택한 실행' });
    const posts = f.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(posts[1]?.idempotencyKey).toBe(posts[0]?.idempotencyKey);
  });

  it('labels analysis as unvalidated and requires an explicit fixture validation request', async () => {
    const f = fixture({ ...run, status: { kind: 'analysis_ready', outputId } });
    render(<Harness transport={f.transport} />);
    const button = await screen.findByRole('button', { name: '테스트용 fixture 후보 검증' });
    expect(screen.getByText(/아직 검증된 후보나 계획 변경은 아닙니다/)).toBeVisible();
    expect(screen.queryByRole('link', { name: /후보 제안 검토/ })).not.toBeInTheDocument();
    expect(f.fixtureWasRequested()).toBe(false);
    await userEvent.setup().click(button);
    await waitFor(() => expect(f.fixtureWasRequested()).toBe(true));
    const validation = f.requests.find((request) => request.method === 'POST');
    expect(validation).toMatchObject({
      path: `/bff/v1/coaching-runs/${runId}/candidates`,
      body: null,
      idempotencyKey: 'same-request-key',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('변경되었습니다');
    expect(screen.queryByText('secret backend detail')).not.toBeInTheDocument();
  });

  it('aborts an in-flight command when the login lifetime unmounts', async () => {
    const f = fixture();
    let pendingSignal: AbortSignal | undefined;
    const transport: AuthenticatedTransport = {
      request: (input) => {
        if (input.method !== 'POST') return f.transport.request(input);
        pendingSignal = input.signal;
        return new Promise(() => undefined);
      },
    };
    const mounted = render(<Harness transport={transport} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '선택한 근거로 실행' }));
    await waitFor(() => expect(pendingSignal).toBeDefined());
    expect(pendingSignal?.aborted).toBe(false);
    mounted.unmount();
    expect(pendingSignal?.aborted).toBe(true);
  });

  it('hides a cached question during a delayed refetch and after repeated access failure', async () => {
    const sensitive = 'private follow-up question';
    const f = fixture({ ...run, status: { kind: 'needs_question', question: sensitive } });
    let detailReads = 0;
    let resolveDelayed!: (value: Awaited<ReturnType<AuthenticatedTransport['request']>>) => void;
    const delayed = new Promise<Awaited<ReturnType<AuthenticatedTransport['request']>>>(
      (resolve) => {
        resolveDelayed = resolve;
      },
    );
    const denied = transportReplySchema.parse({
      status: 404,
      traceId: null,
      body: { error: { code: 'RUN_NOT_FOUND' } },
    });
    const transport: AuthenticatedTransport = {
      request: (input) => {
        if (input.path === `/bff/v1/coaching-runs/${runId}`) {
          detailReads += 1;
          if (detailReads === 2) return delayed;
          if (detailReads > 2) return Promise.resolve(denied);
        }
        return f.transport.request(input);
      },
    };
    render(<Harness transport={transport} />);
    expect(await screen.findByText(new RegExp(sensitive))).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: '상태 새로고침' }));
    await screen.findByText('선택한 실행 조회 중');
    expect(screen.queryByText(new RegExp(sensitive))).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '선택한 실행' })).not.toBeInTheDocument();
    await act(async () => resolveDelayed(denied));
    expect(await screen.findByText(/선택한 실행을 확인할 수 없습니다/)).toBeVisible();
    expect(screen.queryByText(new RegExp(sensitive))).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '실행 다시 확인' }));
    await waitFor(() => expect(detailReads).toBe(3));
    expect(screen.queryByText(new RegExp(sensitive))).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '선택한 실행' })).not.toBeInTheDocument();
  });
});
