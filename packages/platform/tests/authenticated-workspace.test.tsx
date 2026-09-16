import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticatedWorkspace,
  createSessionTransport,
  useAuthenticatedSession,
} from '../src/authenticated-workspace.js';
const session = {
  athleteId: 'athlete-a',
  sessionId: 'session-a',
  csrfToken: 'c'.repeat(43),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<typeof fetch>();
function pendingResponse() {
  let resolve: (value: Response) => void = () => {
    throw new Error('Deferred not initialized');
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function PrivateWorkspace() {
  const value = useAuthenticatedSession();
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState('');
  return (
    <>
      <p>{value.athleteId}</p>
      <button
        onClick={() => {
          void value.transport
            .request({
              path: '/bff/v1/plans/current',
              method: 'PUT',
              body: {},
              idempotencyKey: 'save-fixture-0001',
            })
            .then(
              () => setResult('saved'),
              (error: unknown) => setResult(error instanceof Error ? error.message : 'error'),
            );
        }}
      >
        Save private draft
      </button>
      <output>{result}</output>
      <label>
        Private draft
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('session-bound authenticated transport', () => {
  it('passes current session/CSRF/idempotency while preserving cancellation and null semantics', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const expired = vi.fn();
    const transport = createSessionTransport(session, expired);
    const controller = new AbortController();
    expect(
      await transport.request({
        path: '/bff/v1/plans/current',
        method: 'PUT',
        body: { draft: null },
        idempotencyKey: 'save-0001',
        signal: controller.signal,
      }),
    ).toEqual({ status: 204, body: null, traceId: null });
    expect(fetchMock).toHaveBeenCalledWith(
      '/bff/v1/plans/current',
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'x-workout-session-id': session.sessionId,
          'x-csrf-token': session.csrfToken,
          'idempotency-key': 'save-0001',
          'content-type': 'application/json',
        },
        body: '{"draft":null}',
      }),
    );
    expect(expired).not.toHaveBeenCalled();
  });
  it.each([
    '/bff/v1/consents/ai',
    'https://evil.example/bff/v1/activities',
    '/bff/v1/activities/../consents/ai',
  ])('refuses routes outside the product transport boundary: %s', async (path) => {
    await expect(
      createSessionTransport(session, vi.fn()).request({
        path,
        method: 'GET',
        body: null,
        idempotencyKey: null,
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    json({ error: { code: 'UNAUTHENTICATED' } }, 401),
    json({ error: { code: 'SESSION_CHANGED' } }, 409),
  ])(
    'invalidates an expired/switched session instead of returning cached data',
    async (response) => {
      fetchMock.mockResolvedValue(response);
      const expired = vi.fn();
      await expect(
        createSessionTransport(session, expired).request({
          path: '/bff/v1/activities',
          method: 'GET',
          body: null,
          idempotencyKey: null,
        }),
      ).rejects.toThrow('SESSION_EXPIRED');
      expect(expired).toHaveBeenCalledOnce();
    },
  );
  it('still clears an active session when an in-flight request returns 401 after going offline', async () => {
    const response = pendingResponse();
    let available = true;
    fetchMock.mockReturnValueOnce(response.promise);
    const expired = vi.fn();
    const request = createSessionTransport(session, expired, () => available).request({
      path: '/bff/v1/activities',
      method: 'GET',
      body: null,
      idempotencyKey: null,
    });
    available = false;
    response.resolve(new Response('Unauthorized', { status: 401 }));
    await expect(request).rejects.toThrow('SESSION_EXPIRED');
    expect(expired).toHaveBeenCalledOnce();
  });
  it('keeps ordinary stale-plan conflict available to the editor', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'REVISION_CONFLICT' } }, 409));
    const expired = vi.fn();
    const response = await createSessionTransport(session, expired).request({
      path: '/bff/v1/plans/current',
      method: 'GET',
      body: null,
      idempotencyKey: null,
    });
    expect(response.status).toBe(409);
    expect(expired).not.toHaveBeenCalled();
  });
  it('expires the private workspace even when a 401 response body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const expired = vi.fn();
    await expect(
      createSessionTransport(session, expired).request({
        path: '/bff/v1/activities',
        method: 'GET',
        body: null,
        idempotencyKey: null,
      }),
    ).rejects.toThrow('SESSION_EXPIRED');
    expect(expired).toHaveBeenCalledOnce();
  });
});
describe('AuthenticatedWorkspace private state lifetime', () => {
  it('does not mount private children without a validated unexpired session', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'UNAUTHENTICATED' } }, 401));
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    expect(await screen.findByRole('link', { name: '계정에서 로그인' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument();
  });
  it('resets private child state when a same-user session changes on foreground', async () => {
    fetchMock.mockResolvedValueOnce(json(session));
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    fireEvent.change(await screen.findByLabelText('Private draft'), {
      target: { value: 'old-session draft' },
    });
    fetchMock.mockResolvedValueOnce(json({ ...session, sessionId: 'session-b' }));
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(screen.getByLabelText('Private draft')).toHaveValue(''));
  });
  it('preserves unexpired private drafts when foreground revalidation is temporarily offline', async () => {
    fetchMock.mockResolvedValueOnce(json(session));
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    fireEvent.change(await screen.findByLabelText('Private draft'), {
      target: { value: 'unsaved workout' },
    });
    fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'));
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByLabelText('Private draft')).toHaveValue('unsaved workout');
  });
  it('blocks writes during 503 revalidation and resumes the same draft after recovery', async () => {
    fetchMock.mockResolvedValueOnce(json(session));
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    fireEvent.change(await screen.findByLabelText('Private draft'), {
      target: { value: 'keep through outage' },
    });
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'UNAVAILABLE' } }, 503));
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('저장을 잠시 중지');
    fireEvent.click(screen.getByRole('button', { name: 'Save private draft' }));
    await waitFor(() => expect(screen.getByText('SESSION_UNAVAILABLE')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(json(session));
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Private draft')).toHaveValue('keep through outage');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save private draft' }));
    expect(await screen.findByText('saved')).toBeInTheDocument();
  });
  it('does not let a late old-session 401 clear the replacement session draft', async () => {
    const oldRequest = pendingResponse();
    fetchMock.mockResolvedValueOnce(json(session)).mockReturnValueOnce(oldRequest.promise);
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    await screen.findByLabelText('Private draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save private draft' }));
    fetchMock.mockResolvedValueOnce(
      json({ ...session, athleteId: 'athlete-b', sessionId: 'session-b' }),
    );
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByText('athlete-b')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Private draft'), {
      target: { value: 'new account draft' },
    });
    await act(async () => {
      oldRequest.resolve(json({}, 401));
      await oldRequest.promise;
    });
    expect(screen.getByLabelText('Private draft')).toHaveValue('new account draft');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('aborts old session lookup on unmount and ignores its late response after another workspace mounts', async () => {
    const old = pendingResponse();
    fetchMock
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json({ ...session, athleteId: 'athlete-b', sessionId: 'session-b' }));
    const first = render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    first.unmount();
    expect(signal?.aborted).toBe(true);
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    expect(await screen.findByText('athlete-b')).toBeInTheDocument();
    await act(async () => {
      old.resolve(json(session));
      await old.promise;
    });
    expect(screen.queryByText('athlete-a')).not.toBeInTheDocument();
    expect(screen.getByText('athlete-b')).toBeInTheDocument();
  });
  it('hides private children at session expiry while revalidation is pending', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const next = pendingResponse();
    fetchMock
      .mockResolvedValueOnce(json({ ...session, expiresAt }))
      .mockReturnValueOnce(next.promise);
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    await act(async () => {});
    expect(screen.getByLabelText('Private draft')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1001);
    });
    expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('로그인 상태');
  });
});
