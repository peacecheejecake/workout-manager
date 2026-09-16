import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationsPanel, type OperationsPanelProps } from '../src/operations-panel';

const session = { athleteId: 'athlete-one', sessionId: 'session-one', csrfToken: 'csrf-secret' };
const status = {
  checkedAt: '2026-09-16T00:00:00Z',
  outbox: { pending: 2, leased: 1, retrying: 0, completed: 3 },
  providers: { garmin: 'not_connected', healthkit: 'not_connected' },
  audit: [],
};
const exported = {
  schemaVersion: 1,
  athleteId: session.athleteId,
  exportedAt: '2026-09-16T00:00:00Z',
  data: {
    consents: [],
    planSnapshots: [],
    planHead: [],
    planHistory: [],
    activities: [],
    activitySources: [],
    sourceRevisions: [],
    overlays: [],
    overlayRevisions: [],
    suppressions: [],
  },
};
const createObjectURL = vi.fn(() => 'blob:private-export');
const revokeObjectURL = vi.fn();
const NativeURL = URL;
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function setup(
  fetchMutation: (path: string, init?: RequestInit) => Promise<Response> = async (path) =>
    response(path.endsWith('export') ? exported : { erased: true }),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    return path.endsWith('/status') ? response(status) : fetchMutation(path, init);
  });
  vi.stubGlobal('fetch', fetcher);
  const onSignedOut = vi.fn();
  const onSessionChanged = vi.fn();
  const props = { session, onSignedOut, onSessionChanged };
  const tree = (value: OperationsPanelProps) => (
    <QueryClientProvider client={client}>
      <OperationsPanel {...value} />
    </QueryClientProvider>
  );
  const result = render(tree(props));
  return { ...result, client, fetcher, onSignedOut, onSessionChanged, props, tree };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'URL',
    class extends NativeURL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('account operations controls', () => {
  it('shows the actual Garmin connection state from the operations response', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({ ...status, providers: { garmin: 'connected', healthkit: 'not_connected' } }),
      ),
    );
    render(
      <QueryClientProvider client={client}>
        <OperationsPanel session={session} onSignedOut={() => {}} onSessionChanged={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Garmin: 연결됨 · HealthKit: 연결되지 않음')).toBeVisible();
    expect(
      screen.queryByText('Garmin: 연결되지 않음 · HealthKit: 연결되지 않음'),
    ).not.toBeInTheDocument();
  });
  it('does not export or delete on render and requires exact deletion confirmation', async () => {
    const user = userEvent.setup();
    const { fetcher, onSignedOut, client } = setup();
    await screen.findByText(/Garmin: 연결되지 않음/);
    expect(fetcher.mock.calls.map(([path]) => String(path))).toEqual(['/bff/v1/operations/status']);
    const button = screen.getByRole('button', { name: '확인하고 앱 계정 삭제' });
    expect(button).toBeDisabled();
    const input = screen.getByRole('textbox', { name: '삭제 확인 문구' });
    await user.type(input, 'delete my account');
    expect(button).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'DELETE MY ACCOUNT');
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce());
    expect(
      fetcher.mock.calls.find(([path]) => String(path).endsWith('/account'))?.[1],
    ).toMatchObject({
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
      headers: { 'x-csrf-token': 'csrf-secret', 'x-workout-session-id': 'session-one' },
    });
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });
  it('exports only explicitly and revokes download URLs on replacement and unmount without caching export data', async () => {
    const user = userEvent.setup();
    const { fetcher, client, unmount } = setup();
    await screen.findByText(/Garmin: 연결되지 않음/);
    await user.click(screen.getByRole('button', { name: '내 데이터 내보내기 준비' }));
    const link = await screen.findByRole('link', { name: '내 데이터 JSON 다운로드' });
    expect(link).toHaveAttribute('href', 'blob:private-export');
    const request = fetcher.mock.calls.find(([path]) => String(path).endsWith('/export'))?.[1];
    expect(request).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-csrf-token': 'csrf-secret', 'x-workout-session-id': 'session-one' },
    });
    expect(request).not.toHaveProperty('body');
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([['users', 'athlete-one', 'sessions', 'session-one', 'operations']]);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain('planSnapshots');
    await user.click(screen.getByRole('button', { name: '내 데이터 내보내기 준비' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('rejects an export from another athlete and supports explicit retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    setup(async () => {
      attempts++;
      return response(attempts === 1 ? { ...exported, athleteId: 'other-athlete' } : exported);
    });
    await user.click(screen.getByRole('button', { name: '내 데이터 내보내기 준비' }));
    await screen.findByRole('alert');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: '내 데이터 JSON 다운로드' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '내 데이터 내보내기 다시 시도' }));
    await screen.findByRole('link', { name: '내 데이터 JSON 다운로드' });
  });
  it('requires a fresh confirmation after deletion failure instead of automatically retrying', async () => {
    const user = userEvent.setup();
    const { fetcher, onSignedOut } = setup(async () => response({ error: 'unavailable' }, 503));
    const input = screen.getByRole('textbox', { name: '삭제 확인 문구' });
    await user.type(input, 'DELETE MY ACCOUNT');
    await user.click(screen.getByRole('button', { name: '확인하고 앱 계정 삭제' }));
    await screen.findByText(/삭제 결과를 확인하지 못했습니다/);
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: '확인하고 앱 계정 삭제' })).toBeDisabled();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/account'))).toHaveLength(
      1,
    );
  });
  it.each([401, 409])('clears private cache and download after session status %s', async (code) => {
    const user = userEvent.setup();
    let attempts = 0;
    const { onSignedOut, onSessionChanged, client } = setup(async () => {
      attempts++;
      return attempts === 1
        ? response(exported)
        : response({ error: { code: 'SESSION_CHANGED' } }, code);
    });
    await user.click(screen.getByRole('button', { name: '내 데이터 내보내기 준비' }));
    await screen.findByRole('link', { name: '내 데이터 JSON 다운로드' });
    await user.click(screen.getByRole('button', { name: '내 데이터 내보내기 준비' }));
    await waitFor(() =>
      expect(code === 401 ? onSignedOut : onSessionChanged).toHaveBeenCalledOnce(),
    );
    expect(screen.queryByRole('link', { name: '내 데이터 JSON 다운로드' })).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });
  it('ignores an old in-flight export after session replacement and aborts its request', async () => {
    const user = userEvent.setup();
    let finish: ((value: Response) => void) | undefined;
    const { rerender, tree, props, fetcher } = setup(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await user.click(screen.getByRole('button', { name: '내 데이터 내보내기 준비' }));
    const signal = fetcher.mock.calls.find(([path]) => String(path).endsWith('/export'))?.[1]
      ?.signal;
    rerender(
      tree({
        ...props,
        session: { ...session, athleteId: 'athlete-two', sessionId: 'session-two' },
      }),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish?.(response(exported));
    });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: '내 데이터 JSON 다운로드' })).not.toBeInTheDocument();
  });
});
