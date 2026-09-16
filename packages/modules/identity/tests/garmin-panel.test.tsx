import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GarminPanel,
  validateGarminAuthorizationUrl,
  type GarminPanelProps,
} from '../src/garmin-panel';

const session = { athleteId: 'athlete-one', sessionId: 'session-one', csrfToken: 'csrf-private' };
const disconnected = {
  configured: true,
  state: 'not_connected',
  permissions: [],
  connectedAt: null,
};
const connected = {
  configured: true,
  state: 'connected',
  permissions: ['ACTIVITY_EXPORT'],
  connectedAt: '2026-09-16T00:00:00Z',
};
const officialUrl =
  'https://connect.garmin.com/oauth2Confirm?state=fixture-state&client_id=public-client';
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(
  handler: (path: string, init?: RequestInit) => Promise<Response> = async () =>
    response(disconnected),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', fetcher);
  const props = {
    session,
    onSignedOut: vi.fn(),
    onSessionChanged: vi.fn(),
    navigateToAuthorization: vi.fn(),
  };
  const tree = (value: GarminPanelProps) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <GarminPanel {...value} />
      </QueryClientProvider>
    </StrictMode>
  );
  return { ...render(tree(props)), client, fetcher, props, tree };
}
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('separate Garmin connection settings', () => {
  it('shows a clear unavailable reason and does not start OAuth without configuration', async () => {
    const { fetcher } = setup(async () => response({ ...disconnected, configured: false }));
    expect(await screen.findByRole('button', { name: 'Garmin 공식 계정 연결' })).toBeDisabled();
    expect(screen.getByText(/Garmin 공식 연동 설정이 아직 준비되지 않았습니다/)).toBeVisible();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(screen.queryByLabelText(/비밀번호/)).not.toBeInTheDocument();
  });
  it('reads authoritative disconnected state even with a claimed successful callback query', async () => {
    window.history.replaceState(null, '', '/account?garmin=connected');
    setup();
    expect(await screen.findByText('Garmin 연결 상태: 연결되지 않음')).toBeVisible();
    expect(screen.queryByText('Garmin 연결 상태: 연결됨')).not.toBeInTheDocument();
  });
  it('starts OAuth only explicitly with scoped session and CSRF headers then navigates to the official URL', async () => {
    const user = userEvent.setup();
    const { props, fetcher } = setup(async (path) =>
      response(path.endsWith('/status') ? disconnected : { authorizationUrl: officialUrl }),
    );
    await user.click(await screen.findByRole('button', { name: 'Garmin 공식 계정 연결' }));
    await waitFor(() => expect(props.navigateToAuthorization).toHaveBeenCalledWith(officialUrl));
    const command = fetcher.mock.calls.find(([path]) => String(path).endsWith('/connect'))?.[1];
    expect(command).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-workout-session-id': 'session-one', 'x-csrf-token': 'csrf-private' },
    });
    expect(command).not.toHaveProperty('body');
  });
  it('rejects an arbitrary redirect and leaves an explicit retry path', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { props } = setup(async (path) => {
      if (path.endsWith('/status')) return response(disconnected);
      attempts++;
      return response({
        authorizationUrl: attempts === 1 ? 'https://evil.example/authorize' : officialUrl,
      });
    });
    await user.click(await screen.findByRole('button', { name: 'Garmin 공식 계정 연결' }));
    await screen.findByText(/Garmin 연결을 시작하지 못했습니다/);
    expect(props.navigateToAuthorization).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Garmin 상태 다시 확인' }));
    await user.click(await screen.findByRole('button', { name: 'Garmin 공식 계정 연결' }));
    await waitFor(() => expect(props.navigateToAuthorization).toHaveBeenCalledOnce());
  });
  it('does not navigate when an old connect response arrives after logout/unmount', async () => {
    const user = userEvent.setup();
    let finish: ((value: Response) => void) | undefined;
    const { unmount, props, fetcher } = setup(async (path) =>
      path.endsWith('/status')
        ? response(disconnected)
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    await user.click(await screen.findByRole('button', { name: 'Garmin 공식 계정 연결' }));
    const signal = fetcher.mock.calls.find(([path]) => String(path).endsWith('/connect'))?.[1]
      ?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish?.(response({ authorizationUrl: officialUrl }));
    });
    expect(props.navigateToAuthorization).not.toHaveBeenCalled();
  });
  it('rechecks current state after an explicit disconnect, without claiming data synchronization', async () => {
    const user = userEvent.setup();
    let erased = false;
    const { fetcher } = setup(async (path, init) => {
      if (init?.method === 'DELETE') {
        erased = true;
        return response(disconnected);
      }
      return response(erased ? disconnected : connected);
    });
    expect(await screen.findByText('Garmin 연결 상태: 연결됨')).toBeVisible();
    expect(screen.getByText('ACTIVITY_EXPORT')).toBeVisible();
    expect(screen.getByText(/동기화 완료를 의미하지 않습니다/)).toBeVisible();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Garmin 연결 해제' }));
    expect(await screen.findByText('Garmin 연결 상태: 연결되지 않음')).toBeVisible();
    expect(fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]).toBe(
      '/bff/v1/integrations/garmin/connection',
    );
  });
  it('requires disconnecting an expired connection before offering a new authorization', async () => {
    const user = userEvent.setup();
    let erased = false;
    const { fetcher } = setup(async (path, init) => {
      if (init?.method === 'DELETE') erased = true;
      return response(erased ? disconnected : { ...connected, state: 'reconnect_required' });
    });
    await screen.findByText('기존 연결을 해제한 뒤 다시 연결하세요.');
    expect(screen.queryByRole('button', { name: 'Garmin 연결 다시 시작' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Garmin 공식 계정 연결' })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Garmin 연결 해제' }));
    expect(await screen.findByRole('button', { name: 'Garmin 공식 계정 연결' })).toBeEnabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('refreshes the active operations summary after pending provider cleanup completes', async () => {
    const user = userEvent.setup();
    let finished = false;
    const { client } = setup(async () =>
      response(finished ? disconnected : { ...disconnected, state: 'disconnecting' }),
    );
    const observer = new QueryObserver(client, {
      queryKey: ['users', session.athleteId, 'sessions', session.sessionId, 'operations'],
      queryFn: async () => ({ garmin: finished ? 'not_connected' : 'disconnecting' }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await waitFor(() => expect(observer.getCurrentResult().data?.garmin).toBe('disconnecting'));
      await screen.findByText('Garmin 연결 상태: 연결 해제 중');
      expect(screen.getByText(/새 데이터를 가져오는 작업을 중단했습니다/)).toBeVisible();
      finished = true;
      await user.click(screen.getByRole('button', { name: 'Garmin 상태 다시 확인' }));
      await screen.findByText('Garmin 연결 상태: 연결되지 않음');
      await waitFor(() => expect(observer.getCurrentResult().data?.garmin).toBe('not_connected'));
    } finally {
      unsubscribe();
    }
  });
  it('hides uncertain prior connection state until the user refreshes after disconnect failure', async () => {
    const user = userEvent.setup();
    let attempted = false;
    setup(async (_path, init) => {
      if (init?.method === 'DELETE') {
        attempted = true;
        return response({ error: { code: 'UNAVAILABLE' } }, 503);
      }
      return response(attempted ? disconnected : connected);
    });
    await user.click(await screen.findByRole('button', { name: 'Garmin 연결 해제' }));
    await screen.findByText(/Garmin 연결 해제 결과를 확인하지 못했습니다/);
    expect(screen.queryByText('Garmin 연결 상태: 연결됨')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Garmin 연결 해제' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Garmin 상태 다시 확인' }));
    expect(await screen.findByText('Garmin 연결 상태: 연결되지 않음')).toBeVisible();
  });
  it.each([401, 409])(
    'clears private state on session response %s without navigating',
    async (code) => {
      const user = userEvent.setup();
      const { props, client } = setup(async (path) =>
        path.endsWith('/status')
          ? response(disconnected)
          : response({ error: { code: 'SESSION_CHANGED' } }, code),
      );
      await user.click(await screen.findByRole('button', { name: 'Garmin 공식 계정 연결' }));
      await waitFor(() =>
        expect(code === 401 ? props.onSignedOut : props.onSessionChanged).toHaveBeenCalledOnce(),
      );
      expect(props.navigateToAuthorization).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('button', { name: 'Garmin 공식 계정 연결' }),
      ).not.toBeInTheDocument();
      expect(
        client
          .getQueryCache()
          .getAll()
          .every((query) => query.state.data === undefined),
      ).toBe(true);
    },
  );
});

describe('authorization navigation boundary', () => {
  it('permits the exact local fixture only from the configured local shell', () => {
    expect(
      validateGarminAuthorizationUrl(
        'http://127.0.0.1:4500/authorize?state=fixture',
        'http://127.0.0.1:3100',
      ),
    ).toContain(':4500/authorize');
    expect(() =>
      validateGarminAuthorizationUrl('http://127.0.0.1:4500/authorize', 'https://workout.example'),
    ).toThrow();
  });
  it.each([
    'https://connect.garmin.com.evil.example/oauth2Confirm',
    'https://connect.garmin.com/other',
    'https://user:password@connect.garmin.com/oauth2Confirm',
    'https://connect.garmin.com/oauth2Confirm#fragment',
    'javascript:alert(1)',
    'http://connect.garmin.com/oauth2Confirm',
  ])('rejects unsafe destination %s', (url) => {
    expect(() => validateGarminAuthorizationUrl(url, 'http://127.0.0.1:3100')).toThrow();
  });
});
