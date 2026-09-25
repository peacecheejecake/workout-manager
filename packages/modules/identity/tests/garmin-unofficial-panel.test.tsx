import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GarminUnofficialEraseNotice, GarminUnofficialPanel } from '../src/garmin-unofficial-panel';

const session = { athleteId: 'owner-one', sessionId: 'session-one', csrfToken: 'csrf-private' };
const secret = 'correct horse battery';
const base = '/bff/v1/integrations/garmin-unofficial';
type Status = Record<string, unknown>;
const notConnected: Status = {
  provider: 'garmin-connect-unofficial',
  official: false,
  state: 'not_connected',
  connectedAt: null,
  profilePinned: false,
  mfaExpiresAt: null,
  schedule: { enabled: false, paused: false, intervalHours: 6, nextRunAt: null },
  blockedUntil: null,
  loginLockedUntil: null,
  runRequested: false,
  lastRun: null,
};
const connected: Status = {
  ...notConnected,
  state: 'connected',
  connectedAt: '2026-09-20T00:00:00Z',
  profilePinned: true,
};
const mfa: Status = {
  ...notConnected,
  state: 'mfa_required',
  mfaExpiresAt: '2026-09-25T00:05:00Z',
};
const run = (state: string) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  trigger: 'manual',
  state,
  startedAt: '2026-09-25T00:00:00Z',
  finishedAt: state === 'running' ? null : '2026-09-25T00:01:00Z',
  listed: 5,
  imported: 3,
  unchanged: 1,
  suppressed: 1,
  skipped: 0,
  failed: 0,
  complete: state === 'running' ? null : true,
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (code: string, status: number) => response({ error: { code } }, status);

function setup(handler: (path: string, init?: RequestInit) => Promise<Response>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', fetcher);
  const props = { session, onSignedOut: vi.fn(), onSessionChanged: vi.fn() };
  const result = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <div data-testid="host">
          <GarminUnofficialPanel {...props} />
        </div>
      </QueryClientProvider>
    </StrictMode>,
  );
  return { ...result, client, fetcher, props };
}
const calls = (fetcher: ReturnType<typeof setup>['fetcher'], method: string) =>
  fetcher.mock.calls.filter(([, init]) => init?.method === method);
async function settled(client: QueryClient) {
  await waitFor(() =>
    expect(
      client.getQueryState([
        'users',
        'owner-one',
        'sessions',
        'session-one',
        'integrations',
        'garmin-unofficial',
      ])?.status,
    ).toBe('success'),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('unofficial temporary Garmin connection', () => {
  it.each([
    ['adapter off', () => new Response(null, { status: 404 })],
    ['not the owner', () => failure('GARMIN_UNOFFICIAL_OWNER_ONLY', 403)],
  ])('renders nothing at all when the %s', async (_, answer) => {
    const { client, getByTestId } = setup(async () => answer());
    await settled(client);
    expect(getByTestId('host')).toBeEmptyDOMElement();
    expect(screen.queryByText(/비공식/)).not.toBeInTheDocument();
  });

  it('warns that it is not the official integration and keeps its own state words', async () => {
    setup(async () => response(notConnected));
    expect(
      await screen.findByRole('heading', { level: 2, name: '비공식 임시 Garmin 연결' }),
    ).toBeVisible();
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('공식 Garmin 연동이 아닌 비공식 임시 연결입니다');
    expect(note).toHaveTextContent(/이용약관/);
    expect(note).toHaveTextContent(/요청을 제한하거나 계정에 조치/);
    expect(note).toHaveTextContent(/예고 없이/);
    expect(note).toHaveTextContent(/비밀번호가 앱 서버를 한 번 거쳐.*저장하지 않습니다/);
    expect(note).toHaveTextContent(/Garmin 계정 전체 권한/);
    expect(note).toHaveTextContent(/소유자 계정만.*처음 연결한 Garmin 계정 하나/);
    expect(screen.getByText('비공식 연결 상태: 연결되지 않음')).toBeVisible();
    expect(screen.queryByText(/^Garmin 연결 상태/)).not.toBeInTheDocument();
    expect(screen.getByText('아직 가져온 적이 없습니다.')).toBeVisible();
    expect(
      screen.getByText('비공식 경로의 가져오기 상태이며 Garmin 공식 동기화 상태가 아닙니다.'),
    ).toBeVisible();
  });

  it('logs in once with scoped headers, then clears the password and reads the connected state', async () => {
    const user = userEvent.setup();
    let state = notConnected;
    const { fetcher } = setup(async (path, init) => {
      if (path === `${base}/login` && init?.method === 'POST') {
        state = connected;
        return response({ state: 'connected' });
      }
      return response(state);
    });
    await user.type(await screen.findByLabelText('Garmin 이메일'), 'owner@example.com');
    const password = screen.getByLabelText('Garmin 비밀번호');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    await user.type(password, secret);
    await user.click(screen.getByRole('button', { name: '비공식 연결 로그인' }));
    expect(await screen.findByText('비공식 연결 상태: 연결됨')).toBeVisible();
    const [login] = calls(fetcher, 'POST');
    expect(login?.[0]).toBe(`${base}/login`);
    expect(login?.[1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': 'csrf-private',
        'x-workout-session-id': 'session-one',
      },
    });
    expect(JSON.parse(String(login?.[1]?.body))).toEqual({
      email: 'owner@example.com',
      password: secret,
    });
    expect(fetcher.mock.calls.every(([path]) => !String(path).includes('horse'))).toBe(true);
    expect(screen.getByText('2026-09-20T00:00:00Z')).toBeVisible();
    expect(screen.queryByLabelText('Garmin 비밀번호')).not.toBeInTheDocument();
  });

  it('clears the password after a rejected login and shows fixed text, not server text', async () => {
    const user = userEvent.setup();
    const { fetcher } = setup(async (path, init) =>
      init?.method === 'POST'
        ? response(
            { error: { code: 'GARMIN_UNOFFICIAL_LOGIN_REJECTED', message: 'server leak' } },
            422,
          )
        : response(notConnected),
    );
    await user.type(await screen.findByLabelText('Garmin 이메일'), 'owner@example.com');
    await user.type(screen.getByLabelText('Garmin 비밀번호'), secret);
    await user.click(screen.getByRole('button', { name: '비공식 연결 로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Garmin 이메일 또는 비밀번호가 맞지 않습니다.',
    );
    expect(screen.queryByText(/server leak/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Garmin 비밀번호')).toHaveValue('');
    expect(screen.getByLabelText('Garmin 이메일')).toHaveValue('owner@example.com');
    expect(fetcher.mock.calls.every(([path]) => !String(path).includes('horse'))).toBe(true);
  });

  it('refuses a different Garmin account with a fixed alert and the pinned-account hint', async () => {
    const user = userEvent.setup();
    setup(async (_, init) =>
      init?.method === 'POST'
        ? failure('GARMIN_UNOFFICIAL_PROFILE_MISMATCH', 409)
        : response({ ...notConnected, profilePinned: true }),
    );
    expect(
      await screen.findByText('처음 연결한 Garmin 계정으로만 다시 연결할 수 있습니다.'),
    ).toBeVisible();
    await user.type(screen.getByLabelText('Garmin 이메일'), 'other@example.com');
    await user.type(screen.getByLabelText('Garmin 비밀번호'), secret);
    await user.click(screen.getByRole('button', { name: '비공식 연결 로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /처음 연결한 Garmin 계정과 다른 계정이라 연결하지 않았습니다/,
    );
  });

  it('shows the login lockout and disables the submit button', async () => {
    setup(async () => response({ ...notConnected, loginLockedUntil: '2099-01-01T00:00:00Z' }));
    expect(await screen.findByText(/로그인 시도가 잠시 제한되었습니다:/)).toBeVisible();
    expect(screen.getByText('2099-01-01T00:00:00Z')).toHaveAttribute(
      'datetime',
      '2099-01-01T00:00:00Z',
    );
    expect(screen.getByRole('button', { name: '비공식 연결 로그인' })).toBeDisabled();
  });

  it('continues an MFA login with a one-time code, and can cancel a pending step', async () => {
    const user = userEvent.setup();
    let state = notConnected;
    const { fetcher } = setup(async (path, init) => {
      if (path === `${base}/login` && init?.method === 'POST') {
        state = mfa;
        return response({ state: 'mfa_required' });
      }
      if (path === `${base}/login/mfa`) {
        state = connected;
        return response({ state: 'connected' });
      }
      return response(state);
    });
    await user.type(await screen.findByLabelText('Garmin 이메일'), 'owner@example.com');
    await user.type(screen.getByLabelText('Garmin 비밀번호'), secret);
    await user.click(screen.getByRole('button', { name: '비공식 연결 로그인' }));
    const code = await screen.findByLabelText('Garmin 인증 코드');
    expect(screen.getByText('비공식 연결 상태: 인증 코드 입력 대기')).toBeVisible();
    expect(screen.getByText('2026-09-25T00:05:00Z')).toBeVisible();
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByRole('button', { name: '로그인 취소' })).toBeEnabled();
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: '인증 코드 확인' }));
    expect(await screen.findByText('비공식 연결 상태: 연결됨')).toBeVisible();
    const mfaCall = calls(fetcher, 'POST').find(([path]) => path === `${base}/login/mfa`);
    expect(JSON.parse(String(mfaCall?.[1]?.body))).toEqual({ code: '123456' });
  });

  it('cancels a pending MFA step', async () => {
    const user = userEvent.setup();
    let state = mfa;
    const { fetcher } = setup(async (path, init) => {
      if (init?.method === 'DELETE') {
        state = notConnected;
        return new Response(null, { status: 204 });
      }
      return response(state);
    });
    await user.click(await screen.findByRole('button', { name: '로그인 취소' }));
    expect(await screen.findByText('비공식 연결 상태: 연결되지 않음')).toBeVisible();
    expect(calls(fetcher, 'DELETE')[0]?.[0]).toBe(`${base}/login`);
  });

  it('shows an expired MFA step as a restart, not a retry', async () => {
    const user = userEvent.setup();
    setup(async (_, init) =>
      init?.method === 'POST' ? failure('GARMIN_UNOFFICIAL_MFA_EXPIRED', 409) : response(mfa),
    );
    await user.type(await screen.findByLabelText('Garmin 인증 코드'), '1234');
    await user.click(screen.getByRole('button', { name: '인증 코드 확인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/처음부터 다시 로그인하세요/);
    expect(screen.getByLabelText('Garmin 인증 코드')).toHaveValue('');
  });

  it('requests a run and polls status until the background run finishes', async () => {
    const user = userEvent.setup();
    const statuses = [connected];
    let reads = 0;
    const { fetcher } = setup(async (path, init) => {
      if (path === `${base}/runs`) {
        statuses.push(
          { ...connected, runRequested: true },
          { ...connected, lastRun: run('running') },
          { ...connected, lastRun: run('succeeded') },
        );
        return response({ requested: true }, 202);
      }
      if (init?.method) throw new Error('unexpected');
      const next = statuses[Math.min(reads, statuses.length - 1)];
      if (reads < statuses.length - 1) reads++;
      return response(next);
    });
    const button = await screen.findByRole('button', { name: '지금 가져오기' });
    await waitFor(() => expect(button).toBeEnabled());
    reads = 1;
    await user.click(button);
    expect(await screen.findByText(/가져오기 요청을 받았습니다/)).toBeVisible();
    expect(screen.getByRole('button', { name: '지금 가져오기' })).toBeDisabled();
    expect(await screen.findByText(/가져오는 중 · 직접/, {}, { timeout: 5000 })).toBeVisible();
    expect(await screen.findByText(/완료 · 직접/, {}, { timeout: 5000 })).toBeVisible();
    expect(
      screen.getByText(
        '목록 5 · 새로 가져옴 3 · 변경 없음 1 · 삭제 억제 1 · 이미 처리됨 0 · 실패 0',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '지금 가져오기' })).toBeEnabled();
    expect(calls(fetcher, 'POST')[0]?.[1]?.headers).toMatchObject({
      'x-csrf-token': 'csrf-private',
    });
  }, 15_000);

  it('disables a run until the provider block passes and shows when', async () => {
    setup(async () => response({ ...connected, blockedUntil: '2099-01-01T00:00:00Z' }));
    expect(await screen.findByText(/다음 가져오기 가능 시각:/)).toBeVisible();
    expect(screen.getByRole('button', { name: '지금 가져오기' })).toBeDisabled();
  });

  it('toggles the schedule through the server and shows a paused schedule', async () => {
    const user = userEvent.setup();
    let state: Status = {
      ...connected,
      schedule: { enabled: false, paused: true, intervalHours: 6, nextRunAt: null },
    };
    const { fetcher } = setup(async (_, init) => {
      if (init?.method === 'PUT') {
        state = {
          ...connected,
          schedule: {
            enabled: true,
            paused: false,
            intervalHours: 6,
            nextRunAt: '2026-09-25T06:00:00Z',
          },
        };
        return new Response(null, { status: 204 });
      }
      return response(state);
    });
    const toggle = await screen.findByRole('checkbox', { name: '예약 가져오기 (6시간마다)' });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText(/예약 가져오기가 일시 중지되었습니다. 다시 켜면 재개됩니다/),
    ).toBeVisible();
    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: '예약 가져오기 (6시간마다)' })).toBeChecked(),
    );
    expect(screen.queryByText(/일시 중지되었습니다/)).not.toBeInTheDocument();
    const put = calls(fetcher, 'PUT')[0];
    expect(put?.[0]).toBe(`${base}/schedule`);
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ enabled: true });
  });

  it('explains that disconnecting cannot end the Garmin-side session', async () => {
    const user = userEvent.setup();
    let state = connected;
    const { fetcher } = setup(async (_, init) => {
      if (init?.method === 'DELETE') {
        state = { ...notConnected, profilePinned: true };
        return new Response(null, { status: 204 });
      }
      return response(state);
    });
    expect(
      await screen.findByText(
        '연결 해제는 앱에 저장된 Garmin 세션만 삭제합니다. 비공식 경로에는 Garmin 쪽 세션을 끊는 방법이 없어 Garmin 세션이 계속 유효할 수 있습니다. Garmin 쪽 세션을 끝내려면 Garmin 계정 비밀번호를 변경하고 Garmin 계정 설정에서 로그인된 세션·기기를 로그아웃하세요.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/이미 가져온 활동은 삭제되지 않고 비공식 수집 표시와 함께/),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: '비공식 연결 해제' }));
    expect(await screen.findByText('비공식 연결 상태: 연결되지 않음')).toBeVisible();
    expect(calls(fetcher, 'DELETE')[0]?.[0]).toBe(`${base}/connection`);
    expect(screen.queryByRole('button', { name: '비공식 연결 해제' })).not.toBeInTheDocument();
  });

  it('ends the session on 401 instead of showing the panel', async () => {
    const { props } = setup(async () => new Response(null, { status: 401 }));
    await waitFor(() => expect(props.onSignedOut).toHaveBeenCalledOnce());
    expect(screen.queryByText(/비공식/)).not.toBeInTheDocument();
  });

  it('aborts an in-flight command on unmount', async () => {
    const user = userEvent.setup();
    const { fetcher, unmount } = setup(async (path, init) =>
      init?.method === 'POST' ? new Promise<Response>(() => undefined) : response(connected),
    );
    await user.click(await screen.findByRole('button', { name: '지금 가져오기' }));
    const signal = calls(fetcher, 'POST')[0]?.[1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('unofficial Garmin erase notice', () => {
  function renderNotice(answer: () => Response) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetcher = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetcher);
    render(
      <QueryClientProvider client={client}>
        <div data-testid="host">
          <GarminUnofficialEraseNotice session={session} />
        </div>
      </QueryClientProvider>,
    );
    return fetcher;
  }
  it.each([
    ['404', () => new Response(null, { status: 404 })],
    ['403', () => failure('GARMIN_UNOFFICIAL_OWNER_ONLY', 403)],
  ])('stays hidden on %s', async (_, answer) => {
    const fetcher = renderNotice(answer);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('host')).toBeEmptyDOMElement();
  });
  it('warns the owner that erasing cannot end the Garmin-side session', async () => {
    renderNotice(() => response(connected));
    expect(
      await screen.findByText(
        '비공식 임시 Garmin 연결: 계정을 삭제하면 앱에 저장된 Garmin 세션도 삭제되지만 Garmin 쪽 세션은 끊기지 않습니다. Garmin 계정 비밀번호를 변경하고 Garmin 계정 설정에서 로그인 세션을 로그아웃하세요.',
      ),
    ).toBeVisible();
  });
});
