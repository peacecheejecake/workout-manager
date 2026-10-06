import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AppConsentPanel, type AppConsentPanelProps } from '../src/app-consent-panel';

const session = { athleteId: 'synthetic-a', sessionId: 'session-a', csrfToken: 'c'.repeat(43) };
const endpoint = '/bff/v1/consents/app';
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const head = (granted = false, revision = 1) => ({ kind: 'app', granted, revision });
const clients: QueryClient[] = [];
function mount(overrides: Partial<AppConsentPanelProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const props = { session, onSignedOut: vi.fn(), onSessionChanged: vi.fn(), ...overrides };
  const view = render(
    <QueryClientProvider client={client}>
      <AppConsentPanel {...props} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    props,
    switchSession(next: AppConsentPanelProps['session']) {
      view.rerender(
        <QueryClientProvider client={client}>
          <AppConsentPanel {...props} session={next} />
        </QueryClientProvider>,
      );
    },
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('loads app-only scoped head and explains purpose before an explicit grant without auto-writing', async () => {
  const fetcher = vi.fn(async () => response(head(false, 0)));
  vi.stubGlobal('fetch', fetcher);
  const { client } = mount();
  const grant = await screen.findByRole('button', { name: '앱 저장·처리에 동의' });
  const notice = screen.getByText(/계획·실제 기록·대화를 새로 저장하거나 처리하기 위한/);
  expect(notice).toHaveTextContent('AI에 정보를 전달하는 동의 및 HealthKit 접근 허용과는 별개');
  expect(screen.getByText(/허용을 철회하면/)).toHaveTextContent('조회·내보내기·삭제는 계속');
  expect(notice.compareDocumentPosition(grant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith(
    endpoint,
    expect.objectContaining({
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'x-workout-session-id': session.sessionId },
    }),
  );
  expect(client.getQueryCache().getAll()[0]?.queryKey).toEqual([
    'users',
    session.athleteId,
    'sessions',
    session.sessionId,
    'consent',
    'app',
  ]);
  expect(screen.queryByText(session.athleteId)).not.toBeInTheDocument();
});

it.each([false, true])(
  'changes granted=%s with current CAS/session/CSRF then reads current head',
  async (granted) => {
    let current = head(granted, 4);
    const writes: RequestInit[] = [];
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        writes.push(init);
        current = head(!granted, 5);
      }
      return response(current);
    });
    vi.stubGlobal('fetch', fetcher);
    mount();
    await userEvent.click(
      await screen.findByRole('button', {
        name: granted ? '앱 처리 동의 철회' : '앱 저장·처리에 동의',
      }),
    );
    await screen.findByText(`현재 앱 저장·처리: ${granted ? '허용하지 않음' : '허용'}`);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toBe(JSON.stringify({ granted: !granted, expectedRevision: 4 }));
    const headers = new Headers(writes[0]?.headers);
    expect(headers.get('x-csrf-token')).toBe(session.csrfToken);
    expect(headers.get('x-workout-session-id')).toBe(session.sessionId);
    expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(writes[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'PUT')).toHaveLength(2);
  },
);

it('does not relabel a historical receipt as a current grant after a newer withdrawal', async () => {
  let writes = 0;
  let reads = 0;
  const commands: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        commands.push(init);
        writes += 1;
        return writes === 1 ? response(null, 503) : response(head(true, 2));
      }
      reads += 1;
      return response(head(false, reads === 1 ? 1 : 3));
    }),
  );
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '앱 저장·처리에 동의' }));
  await userEvent.click(await screen.findByRole('button', { name: '같은 앱 이용 변경 재시도' }));
  await screen.findByText('현재 앱 저장·처리: 허용하지 않음');
  expect(screen.queryByRole('button', { name: '앱 처리 동의 철회' })).not.toBeInTheDocument();
  expect(commands).toHaveLength(2);
  expect(commands[0]?.body).toBe(commands[1]?.body);
  expect(commands[0]?.headers).toEqual(commands[1]?.headers);
  expect(reads).toBe(2);
});

it('CAS conflict hides stale controls and permits only current-head refresh before a fresh decision', async () => {
  let conflicted = false;
  const writes: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        writes.push(init);
        if (!conflicted) {
          conflicted = true;
          return response({ error: { code: 'CONSENT_CONFLICT', message: 'private' } }, 409);
        }
        return response(head(true, 9));
      }
      return response(head(false, conflicted ? 8 : 1));
    }),
  );
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '앱 저장·처리에 동의' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('다른 변경과 충돌');
  expect(
    screen.queryByRole('button', { name: '같은 앱 이용 변경 재시도' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/현재 앱 저장·처리:/)).not.toBeInTheDocument();
  expect(screen.queryByText('private')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '현재 앱 이용 허용 다시 확인' }));
  await userEvent.click(await screen.findByRole('button', { name: '앱 저장·처리에 동의' }));
  expect(writes[1]?.body).toBe(JSON.stringify({ granted: true, expectedRevision: 8 }));
  expect(new Headers(writes[0]?.headers).get('idempotency-key')).not.toBe(
    new Headers(writes[1]?.headers).get('idempotency-key'),
  );
});

it('successful receipt followed by failed authoritative GET never displays stale grant or retries that write', async () => {
  let wrote = false;
  let recovered = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        wrote = true;
        return response(head(true, 2));
      }
      return wrote && !recovered
        ? response(null, 503)
        : response(head(recovered, recovered ? 2 : 1));
    }),
  );
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '앱 저장·처리에 동의' }));
  await screen.findByText('현재 앱 이용 허용 상태를 확인하지 못했습니다.');
  expect(screen.queryByText(/현재 앱 저장·처리:/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '같은 앱 이용 변경 재시도' }),
  ).not.toBeInTheDocument();
  recovered = true;
  await userEvent.click(screen.getByRole('button', { name: '앱 이용 허용 다시 확인' }));
  await screen.findByText('현재 앱 저장·처리: 허용');
});

it.each([
  { kind: 'ai', granted: true, revision: 1 },
  { ...head(), extra: 'private' },
  { ...head(), revision: '1' },
  { ...head(), revision: -1 },
  { ...head(), revision: 1.5 },
  { ...head(), revision: 2147483648 },
  { ...head(), granted: 'true' },
  head(true, 0),
])('rejects unknown or malformed app head %# without granting automatically', async (body) => {
  const fetcher = vi.fn(async () => response(body));
  vi.stubGlobal('fetch', fetcher);
  mount();
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: '앱 저장·처리에 동의' })).not.toBeInTheDocument();
  expect(screen.queryByText(/현재 앱 저장·처리:/)).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('accepts terminal head read without offering an impossible revision increment', async () => {
  const fetcher = vi.fn(async () => response(head(true, 2147483647)));
  vi.stubGlobal('fetch', fetcher);
  mount();
  await screen.findByText('현재 앱 저장·처리: 허용');
  expect(screen.getByText('현재 허용 상태를 변경할 수 없습니다.')).toBeVisible();
  expect(screen.queryByRole('button', { name: '앱 처리 동의 철회' })).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('retry GET recovers from initial unavailable state without a PUT', async () => {
  let reads = 0;
  const fetcher = vi.fn(async () =>
    response(++reads === 1 ? null : head(), reads === 1 ? 503 : 200),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '앱 이용 허용 다시 확인' }));
  await screen.findByRole('button', { name: '앱 저장·처리에 동의' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([401, 409])(
  'ends current account on authorization response %s and clears private cache',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: { code: 'SESSION_CHANGED' } }, status)),
    );
    const { props, client } = mount();
    await waitFor(() =>
      expect(status === 401 ? props.onSignedOut : props.onSessionChanged).toHaveBeenCalledOnce(),
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: '앱 저장·처리에 동의' })).not.toBeInTheDocument();
  },
);

it('same-athlete new session aborts late head and removes old session cache', async () => {
  const old = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get('x-workout-session-id') === session.sessionId) {
        signal = init?.signal;
        return old.promise;
      }
      return response(head(false, 7));
    }),
  );
  const view = mount();
  await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
  view.switchSession({ ...session, sessionId: 'session-b' });
  await screen.findByText('현재 앱 저장·처리: 허용하지 않음');
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    old.resolve(response(head(true, 8)));
    await old.promise;
  });
  expect(screen.queryByRole('button', { name: '앱 처리 동의 철회' })).not.toBeInTheDocument();
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey),
  ).toEqual([['users', session.athleteId, 'sessions', 'session-b', 'consent', 'app']]);
});

it('account switch aborts pending PUT and ignores its late auth failure without clearing the new account', async () => {
  const old = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        signal = init.signal;
        return old.promise;
      }
      return response(head(false, 1));
    }),
  );
  const view = mount();
  await userEvent.click(await screen.findByRole('button', { name: '앱 저장·처리에 동의' }));
  view.switchSession({ ...session, athleteId: 'synthetic-b', sessionId: 'session-b' });
  expect(signal?.aborted).toBe(true);
  await screen.findByText('현재 앱 저장·처리: 허용하지 않음');
  await act(async () => {
    old.resolve(response(null, 401));
    await old.promise;
  });
  expect(view.props.onSignedOut).not.toHaveBeenCalled();
  expect(view.props.onSessionChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '앱 저장·처리에 동의' })).toBeVisible();
});

it('unmount aborts PUT and clears head even when transport ignores cancellation', async () => {
  const old = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        signal = init.signal;
        return old.promise;
      }
      return response(head());
    }),
  );
  const view = mount();
  await userEvent.click(await screen.findByRole('button', { name: '앱 저장·처리에 동의' }));
  expect(screen.queryByRole('button', { name: '앱 저장·처리에 동의' })).not.toBeInTheDocument();
  view.unmount();
  expect(signal?.aborted).toBe(true);
  expect(view.client.getQueryCache().getAll()).toHaveLength(0);
  await act(async () => {
    old.resolve(response(head(true, 2)));
    await old.promise;
  });
  expect(view.client.getQueryCache().getAll()).toHaveLength(0);
});

it.each([
  head(true, 1),
  { kind: 'ai', granted: true, revision: 2 },
  { ...head(true, 2), forged: true },
])('malformed or mismatched successful receipt %# does not show a grant', async (receipt) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) =>
      response(init?.method === 'PUT' ? receipt : head()),
    ),
  );
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '앱 저장·처리에 동의' }));
  await screen.findByRole('button', { name: '같은 앱 이용 변경 재시도' });
  expect(screen.queryByText(/현재 앱 저장·처리:/)).not.toBeInTheDocument();
});

it.each([401, 409])(
  'clears a previously loaded private head when PUT loses session with %s',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init?: RequestInit) =>
        init?.method === 'PUT'
          ? response({ error: { code: 'SESSION_CHANGED' } }, status)
          : response(head(true, 4)),
      ),
    );
    const { props, client } = mount();
    await userEvent.click(await screen.findByRole('button', { name: '앱 처리 동의 철회' }));
    await waitFor(() =>
      expect(status === 401 ? props.onSignedOut : props.onSessionChanged).toHaveBeenCalledOnce(),
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
    expect(screen.queryByText(/현재 앱 저장·처리:/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '같은 앱 이용 변경 재시도' }),
    ).not.toBeInTheDocument();
  },
);
