import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticatedWorkspace,
  createSessionFileTransfer,
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
  it.each([
    ['GET', '/bff/v1/plan-scenarios?limit=3'],
    ['GET', '/bff/v1/plan-scenarios/scenario/revisions/1'],
    ['POST', '/bff/v1/plan-scenarios'],
    ['PUT', '/bff/v1/plan-scenarios/scenario'],
    ['POST', '/bff/v1/plan-scenarios/scenario/apply'],
  ] as const)('carries session-bound scenario %s %s through the host', async (method, path) => {
    fetchMock.mockResolvedValue(json({ accepted: true }));
    const write = method !== 'GET';
    await createSessionTransport(session, vi.fn()).request({
      path,
      method,
      body: write ? { confirmed: true } : null,
      idempotencyKey: write ? 'scenario-key' : null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'error',
        headers: expect.objectContaining({
          'x-workout-session-id': session.sessionId,
          ...(write
            ? { 'x-csrf-token': session.csrfToken, 'idempotency-key': 'scenario-key' }
            : {}),
        }),
      }),
    );
  });
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
  it('sends check-in writes through the session-bound transport', async () => {
    fetchMock.mockResolvedValue(json({ id: 'receipt' }));
    const transport = createSessionTransport(session, vi.fn());
    await transport.request({
      path: '/bff/v1/check-ins',
      method: 'POST',
      body: { values: { fatigue: 0, discomfort: null } },
      idempotencyKey: 'checkin-0001',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/bff/v1/check-ins',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-csrf-token': session.csrfToken,
          'x-workout-session-id': session.sessionId,
          'idempotency-key': 'checkin-0001',
        }),
        body: '{"values":{"fatigue":0,"discomfort":null}}',
      }),
    );
  });
  it('sends supplementary set writes with session, CSRF and idempotency credentials', async () => {
    fetchMock.mockResolvedValue(json({ id: 'set-a' }));
    await createSessionTransport(session, vi.fn()).request({
      path: '/bff/v1/supplementary/executions/one/sets',
      method: 'POST',
      body: { state: 'performed' },
      idempotencyKey: 'supplementary-set-0001',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/bff/v1/supplementary/executions/one/sets',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-csrf-token': session.csrfToken,
          'x-workout-session-id': session.sessionId,
          'idempotency-key': 'supplementary-set-0001',
        }),
      }),
    );
  });
  it('allows stretching actual writes through the current session only', async () => {
    fetchMock.mockResolvedValue(json({ status: 'active' }));
    await createSessionTransport(session, vi.fn()).request({
      path: '/bff/v1/stretching/logs',
      method: 'POST',
      body: { confirmation: 'user_confirmed' },
      idempotencyKey: 'stretch-log-0001',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/bff/v1/stretching/logs',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-workout-session-id': session.sessionId,
          'x-csrf-token': session.csrfToken,
          'idempotency-key': 'stretch-log-0001',
        }),
      }),
    );
  });
  it('binds recovery strategy and action writes to the session and CSRF token', async () => {
    fetchMock.mockImplementation(async () => json({ accepted: true }));
    const transport = createSessionTransport(session, vi.fn());
    for (const path of [
      '/bff/v1/recovery/strategy-drafts',
      '/bff/v1/recovery/strategies/10000000-0000-4000-8000-000000000001/confirm',
      '/bff/v1/recovery/action-logs',
    ]) {
      await transport.request({
        path,
        method: 'POST',
        body: { confirmed: true },
        idempotencyKey: 'recovery-command-1',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        path,
        expect.objectContaining({
          credentials: 'same-origin',
          headers: expect.objectContaining({
            'x-csrf-token': session.csrfToken,
            'x-workout-session-id': session.sessionId,
            'idempotency-key': 'recovery-command-1',
          }),
        }),
      );
    }
  });
  it('keeps dashboard reads bound to the current session without write credentials', async () => {
    fetchMock.mockResolvedValue(json({ definitionVersion: 'dashboard-v1' }));
    const transport = createSessionTransport(session, vi.fn());
    await transport.request({
      path: '/bff/v1/dashboard?anchor=2026-09-16&timezone=UTC',
      method: 'GET',
      body: null,
      idempotencyKey: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/bff/v1/dashboard?anchor=2026-09-16&timezone=UTC',
      expect.objectContaining({
        headers: { 'x-workout-session-id': session.sessionId },
        credentials: 'same-origin',
        cache: 'no-store',
      }),
    );
  });
  it.each([
    '/bff/v1/consents/ai',
    '/bff/v1/plan-scenarios-admin',
    '/bff/v1/plan-scenarios/../consents/ai',
    '/bff/v1/check-ins-admin',
    '/bff/v1/dashboard-admin',
    '/bff/v1/dashboard/../consents/ai',
    '/bff/v1/supplementary-admin',
    '/bff/v1/supplementary/../consents/ai',
    '/bff/v1/stretching-admin',
    '/bff/v1/stretching/../consents/ai',
    '/bff/v1/recovery-admin',
    '/bff/v1/recovery/../consents/ai',
    '/bff/v1/check-ins/../consents/ai',
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

describe('session-bound resource file transfer', () => {
  const resourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const uploadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('uploads exact bytes with session, CSRF, encoded filename and bounded progress', async () => {
    fetchMock.mockResolvedValue(json({ state: 'staged' }));
    const progress = vi.fn();
    const file = new File(['# 달리기'], '달리기 메모.md', { type: 'text/markdown' });
    const signal = new AbortController().signal;
    await createSessionFileTransfer(session, vi.fn()).upload({
      uploadId,
      file,
      mediaType: 'text/markdown',
      signal,
      onProgress: progress,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/bff/v1/resources/uploads/${uploadId}/content`,
      expect.objectContaining({
        method: 'PUT',
        body: file,
        signal,
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'content-type': 'text/markdown',
          'x-resource-file-name': encodeURIComponent(file.name),
          'x-workout-session-id': session.sessionId,
          'x-csrf-token': session.csrfToken,
        }),
      }),
    );
    expect(progress.mock.calls).toEqual([
      [0, file.size],
      [file.size, file.size],
    ]);
  });

  it('preserves the server retry contract for a failed raw upload', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'UPLOAD_RETRY_REQUIRED' } }, 503));
    await expect(
      createSessionFileTransfer(session, vi.fn()).upload({
        uploadId,
        file: new File(['# retry'], 'retry.md', { type: 'text/markdown' }),
        mediaType: 'text/markdown',
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow('UPLOAD_RETRY_REQUIRED');
  });

  it('downloads the exact version through a short-lived blob URL', async () => {
    fetchMock.mockResolvedValue(new Response('synthetic', { status: 200 }));
    const createObjectURL = vi.fn(() => 'blob:resource');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await createSessionFileTransfer(session, vi.fn()).open({
      resourceId,
      versionId,
      fileName: 'guide.pdf',
      signal: new AbortController().signal,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/bff/v1/resources/${resourceId}/content?versionId=${versionId}`,
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:resource');
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

it.each([
  ['GET', '/bff/v1/nutrition/plans?from=2026-09-18&toInclusive=2026-09-20'],
  ['POST', '/bff/v1/nutrition/plans'],
  ['GET', '/bff/v1/nutrition/foods/food-1'],
  ['POST', '/bff/v1/nutrition/intakes'],
  ['PATCH', '/bff/v1/nutrition/intakes/intake-1'],
  ['DELETE', '/bff/v1/nutrition/intakes/intake-1'],
] as const)('binds nutrition %s %s to the active session and CSRF token', async (method, path) => {
  fetchMock.mockResolvedValue(json({ accepted: true }));
  await createSessionTransport(session, vi.fn()).request({
    method,
    path,
    body: method === 'GET' ? null : { confirmed: true },
    idempotencyKey: method === 'GET' ? null : 'nutrition-key',
  });
  expect(fetchMock).toHaveBeenCalledWith(
    path,
    expect.objectContaining({
      credentials: 'same-origin',
      headers: expect.objectContaining({
        'x-workout-session-id': session.sessionId,
        ...(method === 'GET'
          ? {}
          : { 'x-csrf-token': session.csrfToken, 'idempotency-key': 'nutrition-key' }),
      }),
    }),
  );
});
it('rejects adjacent nutrition namespaces', async () => {
  await expect(
    createSessionTransport(session, vi.fn()).request({
      method: 'POST',
      path: '/bff/v1/nutrition-admin/intakes',
      body: {},
      idempotencyKey: 'private',
    }),
  ).rejects.toThrow('ROUTE_NOT_ALLOWED');
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  ['GET', '/bff/v1/routines'],
  ['POST', '/bff/v1/routines'],
  ['GET', '/bff/v1/routine-versions/version'],
  ['POST', '/bff/v1/routine-schedule-previews'],
  ['POST', '/bff/v1/routine-schedules'],
  ['POST', '/bff/v1/routine-runs/run/steps'],
] as const)('binds routine %s %s to the active session and CSRF token', async (method, path) => {
  fetchMock.mockResolvedValue(json({ accepted: true }));
  await createSessionTransport(session, vi.fn()).request({
    method,
    path,
    body: method === 'GET' ? null : { confirmed: true },
    idempotencyKey: method === 'GET' ? null : 'routine-key',
  });
  expect(fetchMock).toHaveBeenCalledWith(
    path,
    expect.objectContaining({
      credentials: 'same-origin',
      headers: expect.objectContaining({
        'x-workout-session-id': session.sessionId,
        ...(method === 'GET'
          ? {}
          : { 'x-csrf-token': session.csrfToken, 'idempotency-key': 'routine-key' }),
      }),
    }),
  );
});
it('rejects adjacent routine namespaces', async () => {
  await expect(
    createSessionTransport(session, vi.fn()).request({
      method: 'POST',
      path: '/bff/v1/routines-admin',
      body: {},
      idempotencyKey: 'private',
    }),
  ).rejects.toThrow('ROUTE_NOT_ALLOWED');
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  ['GET', '/bff/v1/coaching-constraints'],
  ['POST', '/bff/v1/coaching-constraints'],
  ['PUT', '/bff/v1/coaching-constraints/constraint'],
  ['DELETE', '/bff/v1/coaching-constraints/constraint'],
  ['GET', '/bff/v1/coaching-threads?limit=20'],
  ['GET', '/bff/v1/evidence-snapshots/snapshot'],
  ['GET', '/bff/v1/coaching-threads/thread/evidence-snapshots?limit=20'],
  ['POST', '/bff/v1/coaching-threads/thread/evidence-snapshots'],
  ['GET', '/bff/v1/coaching-threads/thread/messages?afterRevision=1'],
  ['POST', '/bff/v1/coaching-threads'],
  ['POST', '/bff/v1/coaching-threads/thread/messages'],
  ['GET', '/bff/v1/coaching-threads/thread/runs?limit=20&offset=0'],
  ['POST', '/bff/v1/coaching-threads/thread/runs'],
  ['GET', '/bff/v1/coaching-runs/run'],
  ['POST', '/bff/v1/coaching-runs/run/candidates'],
  ['GET', '/bff/v1/coaching-candidates/candidate/status'],
  ['POST', '/bff/v1/coaching-candidates/candidate/partials'],
  ['POST', '/bff/v1/coaching-candidates/candidate/approve'],
  ['GET', '/bff/v1/planner/integrated?from=2026-09-18&toExclusive=2026-09-19&timezone=UTC'],
  ['GET', '/bff/v1/joint-decisions/decision/candidates'],
  ['GET', '/bff/v1/joint-candidates/candidate'],
  ['POST', '/bff/v1/joint-candidates/candidate/partials'],
  ['POST', '/bff/v1/joint-candidates/candidate/approve'],
  ['GET', '/bff/v1/integrated-candidates/candidate?maxSchemaVersion=4'],
  ['POST', '/bff/v1/integrated-candidates/candidate/approve'],
] as const)('uses the session-bound coaching namespace for %s %s', async (method, path) => {
  fetchMock.mockResolvedValue(json({ accepted: true }));
  const controller = new AbortController();
  await createSessionTransport(session, vi.fn()).request({
    method,
    path,
    body: method !== 'GET' ? { message: 'Synthetic user text' } : null,
    idempotencyKey: method !== 'GET' ? 'coaching-key' : null,
    signal: controller.signal,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    path,
    expect.objectContaining({
      signal: controller.signal,
      credentials: 'same-origin',
      headers: expect.objectContaining({
        'x-workout-session-id': session.sessionId,
        ...(method !== 'GET'
          ? { 'x-csrf-token': session.csrfToken, 'idempotency-key': 'coaching-key' }
          : {}),
      }),
    }),
  );
});
it.each([
  '/bff/v1/coaching-constraints-admin',
  '/bff/v1/coaching-threads-admin',
  '/bff/v1/coaching-runs-admin',
  '/bff/v1/coaching-candidates-admin',
  '/bff/v1/planner-admin',
  '/bff/v1/joint-candidates-admin',
  '/bff/v1/integrated-candidates-admin',
  '/bff/v1/evidence-snapshots-admin',
])(
  'keeps similarly named non-coaching route %s outside the authenticated allowlist',
  async (path) => {
    await expect(
      createSessionTransport(session, vi.fn()).request({
        method: 'POST',
        path,
        body: {},
        idempotencyKey: 'private',
      }),
    ).rejects.toThrow('ROUTE_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
