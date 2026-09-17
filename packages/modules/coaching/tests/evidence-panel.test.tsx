import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { EvidencePanel } from '../src/evidence-panel';
import { createEvidenceDraftStore } from '../src/evidence-store';
import { available, id, purged } from './evidence-panel-fixture';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
});
function reply(body: unknown, status = 200) {
  return transportReplySchema.parse({ body, status, traceId: null });
}
function setup(options: Partial<ComponentProps<typeof EvidencePanel>> = {}) {
  const request = vi
    .fn<AuthenticatedTransport['request']>()
    .mockImplementation(async (input) =>
      input.path.startsWith('/bff/v1/evidence-snapshots/')
        ? reply(available())
        : input.method === 'POST'
          ? reply(purged)
          : reply({ items: [], total: 0 }),
    );
  const store = createEvidenceDraftStore();
  store.getState().actions.edit(id, 'from', '2026-09-17');
  store.getState().actions.edit(id, 'toExclusive', '2026-09-19');
  store.getState().actions.edit(id, 'timezone', 'UTC');
  const props: ComponentProps<typeof EvidencePanel> = {
    athleteId: 'owner',
    sessionId: 'session',
    transport: { request },
    threadId: id,
    observedRevision: 1,
    snapshotId: null,
    offset: 0,
    search: `thread=${id}&offset=40`,
    onSearchChange: vi.fn(),
    onReviewConversation: vi.fn().mockResolvedValue(true),
    createId: () => 'stable',
    store,
    externalPending: false,
    ...options,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const element = () => (
    <QueryClientProvider client={client}>
      <EvidencePanel {...props} />
    </QueryClientProvider>
  );
  const view = render(element());
  return {
    request,
    store,
    props,
    client,
    ...view,
    update: (patch: Partial<typeof props>) => {
      Object.assign(props, patch);
      view.rerender(element());
    },
  };
}
describe('stored evidence panel recovery', () => {
  it('retains identical command after lost response and locks draft dates', async () => {
    const f = setup();
    let posts = 0;
    f.request.mockImplementation(async (input) =>
      input.method === 'POST'
        ? ++posts === 1
          ? Promise.reject(new Error('lost'))
          : reply(purged)
        : reply({ items: [], total: 0 }),
    );
    await userEvent.click(screen.getByRole('button', { name: '근거 저장' }));
    await screen.findByRole('button', { name: '근거 같은 요청 재확인' });
    expect(screen.getByLabelText('근거 시작일')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '근거 같은 요청 재확인' }));
    await waitFor(() => expect(f.props.onSearchChange).toHaveBeenCalled());
    const sent = f.request.mock.calls.map((c) => c[0]).filter((c) => c.method === 'POST');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(f.store.getState().drafts[id]?.from).toBe('2026-09-17');
  });
  it('keeps409 blocked until explicit complete conversation review', async () => {
    const review = vi.fn().mockResolvedValue(false),
      f = setup({ onReviewConversation: review });
    f.request.mockImplementation(async (input) =>
      input.method === 'POST'
        ? reply({ error: { code: 'CONVERSATION_REVISION_CONFLICT' } }, 409)
        : reply({ items: [], total: 0 }),
    );
    await userEvent.click(screen.getByRole('button', { name: '근거 저장' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '근거 저장' })).toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: '상담 기록 새로 확인' }));
    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '근거 저장' })).toBeDisabled();
    review.mockResolvedValue(true);
    await userEvent.click(screen.getByRole('button', { name: '상담 기록 새로 확인' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '근거 저장' })).toBeEnabled());
  });
  it('shows413 bounds failure while retaining editable inputs', async () => {
    const f = setup();
    f.request.mockImplementation(async (input) =>
      input.method === 'POST'
        ? reply({ error: { code: 'EVIDENCE_TOO_LARGE' } }, 413)
        : reply({ items: [], total: 0 }),
    );
    await userEvent.click(screen.getByRole('button', { name: '근거 저장' }));
    await screen.findByText(/근거 저장 한도를 초과/);
    expect(screen.getByLabelText('근거 시작일')).toHaveValue('2026-09-17');
    expect(screen.getByLabelText('근거 시작일')).toBeEnabled();
  });
  it('does not navigate a new thread on late capture success', async () => {
    let resolve: (value: ReturnType<typeof reply>) => void = () => {
      throw new Error('not pending');
    };
    const pending = new Promise<ReturnType<typeof reply>>((r) => {
      resolve = r;
    });
    const f = setup();
    f.request.mockImplementation(async (input) =>
      input.method === 'POST' ? pending : reply({ items: [], total: 0 }),
    );
    await userEvent.click(screen.getByRole('button', { name: '근거 저장' }));
    f.update({ threadId: other });
    await act(async () => resolve(reply(purged)));
    await waitFor(() => expect(f.store.getState().phase).toBe('idle'));
    expect(f.props.onSearchChange).not.toHaveBeenCalled();
  });
  it('aborts pending capture on unmount without navigating', async () => {
    const f = setup();
    let signal: AbortSignal | undefined;
    f.request.mockImplementation(async (input) => {
      if (input.method === 'POST') {
        signal = input.signal;
        return new Promise(() => {});
      }
      return reply({ items: [], total: 0 });
    });
    await userEvent.click(screen.getByRole('button', { name: '근거 저장' }));
    f.unmount();
    expect(signal?.aborted).toBe(true);
    expect(f.props.onSearchChange).not.toHaveBeenCalled();
  });
  it('hides cached body while refreshing and after failed validation, then shows purged on focus', async () => {
    const f = setup({ snapshotId: id });
    await screen.findByText('question');
    f.request.mockImplementation(async (input) =>
      input.path.startsWith('/bff/v1/evidence-snapshots/')
        ? reply({ error: { code: 'INTERNAL' } }, 500)
        : reply({ items: [], total: 0 }),
    );
    await userEvent.click(screen.getByRole('button', { name: '선택한 근거 새로 확인' }));
    await screen.findByText(/이전 본문은 표시하지 않습니다/);
    expect(screen.queryByText('question')).not.toBeInTheDocument();
    f.request.mockImplementation(async (input) =>
      input.path.startsWith('/bff/v1/evidence-snapshots/')
        ? reply(purged)
        : reply({ items: [], total: 0 }),
    );
    fireEvent.focus(window);
    await waitFor(() =>
      expect(screen.queryByText(/이전 본문은 표시하지 않습니다/)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('question')).not.toBeInTheDocument();
  });
  it('purged metadata suppresses available detail and foreign-thread detail is rejected', async () => {
    const f = setup({ snapshotId: id });
    await screen.findByText('question');
    f.request.mockImplementation(async (input) =>
      input.path.startsWith('/bff/v1/evidence-snapshots/')
        ? reply(available())
        : reply({ items: [purged], total: 1 }),
    );
    await userEvent.click(screen.getByRole('button', { name: '근거 목록 새로 확인' }));
    await screen.findByText('본문 회수됨', { exact: false });
    expect(screen.queryByText('question')).not.toBeInTheDocument();
    expect(
      f.client.getQueryData([
        'users',
        'owner',
        'sessions',
        'session',
        'evidence',
        'snapshot',
        id,
        id,
      ]),
    ).toEqual(purged);
    f.unmount();
    const g = setup({ snapshotId: id });
    await screen.findByText('question');
    g.request.mockImplementation(async (input) =>
      input.path.startsWith('/bff/v1/evidence-snapshots/')
        ? reply({ ...purged, threadId: other })
        : reply({ items: [], total: 0 }),
    );
    await userEvent.click(screen.getByRole('button', { name: '선택한 근거 새로 확인' }));
    await screen.findByText(/이전 본문은 표시하지 않습니다/);
    expect(screen.queryByText('question')).not.toBeInTheDocument();
  });
  it('changes snapshot pagination without overwriting thread-list offset or drafts', async () => {
    const f = setup();
    f.request.mockResolvedValue(reply({ items: [], total: 45 }));
    await userEvent.click(await screen.findByRole('button', { name: '근거 목록 새로 확인' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '다음 근거 페이지' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: '다음 근거 페이지' }));
    expect(f.props.onSearchChange).toHaveBeenCalledWith(`thread=${id}&offset=40&snapshotOffset=20`);
    expect(f.store.getState().drafts[id]?.timezone).toBe('UTC');
  });
});
