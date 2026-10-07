import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticatedWorkspace,
  createSessionFileTransfer,
  createSessionTransport,
  useAuthenticatedSession,
} from '../src/authenticated-workspace.js';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY } from '../src/private-browser-storage.js';
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
  it.each(
    ['races', 'race-results', 'training-bests'].flatMap((family) => [
      { method: 'GET' as const, path: `/bff/v1/${family}?limit=50` },
      { method: 'GET' as const, path: `/bff/v1/${family}/00000000-0000-4000-8000-000000000001` },
      { method: 'POST' as const, path: `/bff/v1/${family}` },
      { method: 'PATCH' as const, path: `/bff/v1/${family}/00000000-0000-4000-8000-000000000001` },
      { method: 'DELETE' as const, path: `/bff/v1/${family}/00000000-0000-4000-8000-000000000001` },
    ]),
  )(
    'carries bounded race $method $path without logging private values',
    async ({ method, path }) => {
      const logs = [
        vi.spyOn(console, 'log'),
        vi.spyOn(console, 'info'),
        vi.spyOn(console, 'debug'),
      ];
      try {
        fetchMock.mockResolvedValue(json({ accepted: true }));
        const signal = new AbortController().signal;
        const write = method !== 'GET';
        const body = write ? { values: { chipSeconds: 0, gunSeconds: null } } : null;
        await expect(
          createSessionTransport(session, vi.fn()).request({
            path,
            method,
            body,
            idempotencyKey: write ? 'synthetic-race-command' : null,
            signal,
          }),
        ).resolves.toEqual({ status: 200, body: { accepted: true }, traceId: null });
        expect(fetchMock).toHaveBeenCalledWith(path, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal,
          headers: {
            'x-workout-session-id': session.sessionId,
            ...(write
              ? {
                  'x-csrf-token': session.csrfToken,
                  'idempotency-key': 'synthetic-race-command',
                  'content-type': 'application/json',
                }
              : {}),
          },
          ...(write ? { body: JSON.stringify(body) } : {}),
        });
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      } finally {
        for (const log of logs) log.mockRestore();
      }
    },
  );
  it.each([
    '/bff/v1/races-admin',
    '/bff/v1/races/admin',
    '/bff/v1/race-results-admin',
    '/bff/v1/race-results/admin',
    '/bff/v1/training-bests-admin',
    '/bff/v1/training-bests/admin',
    '/bff/v1/admin/races',
    '/bff/v1/races/00000000-0000-4000-8000-000000000001/admin',
  ])('refuses unsafe competition namespace %s before fetch', async (path) => {
    await expect(
      createSessionTransport(session, vi.fn()).request({
        path,
        method: 'GET',
        body: null,
        idempotencyKey: null,
      }),
    ).rejects.toThrow('ROUTE_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/bff/v1/race-results/v2?schemaVersion=2&limit=50'],
    ['GET', '/bff/v1/race-results/v2/00000000-0000-4000-8000-000000000001?schemaVersion=2'],
    ['POST', '/bff/v1/race-results/v2'],
    ['PATCH', '/bff/v1/race-results/v2/00000000-0000-4000-8000-000000000001'],
  ] as const)(
    'carries explicit V2 result %s %s through the session boundary',
    async (method, path) => {
      fetchMock.mockResolvedValue(json({ accepted: true }));
      const write = method !== 'GET';
      const body = write ? { schemaVersion: 2, values: { proofs: [] } } : null;
      const signal = new AbortController().signal;
      await createSessionTransport(session, vi.fn()).request({
        path,
        method,
        body,
        idempotencyKey: write ? 'synthetic-v2-command' : null,
        signal,
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
        headers: {
          'x-workout-session-id': session.sessionId,
          ...(write
            ? {
                'x-csrf-token': session.csrfToken,
                'idempotency-key': 'synthetic-v2-command',
                'content-type': 'application/json',
              }
            : {}),
        },
        ...(write ? { body: JSON.stringify(body) } : {}),
      });
    },
  );
  it.each([
    ['DELETE', '/bff/v1/race-results/v2/00000000-0000-4000-8000-000000000001'],
    ['PUT', '/bff/v1/race-results/v2'],
    ['POST', '/bff/v1/race-results/v2?schemaVersion=2'],
    ['PATCH', '/bff/v1/race-results/v2/00000000-0000-4000-8000-000000000001?schemaVersion=2'],
    ['GET', '/bff/v1/races/v2'],
    ['GET', '/bff/v1/training-bests/v2'],
    ['GET', '/bff/v1/race-results/v2/admin'],
    ['GET', '/bff/v1/race-results/v2/00000000-0000-4000-8000-000000000001/admin'],
    ['GET', '/bff/v1/race-results/v2-other'],
    ['GET', '/bff/v1/race-results/v2/'],
  ] as const)('refuses unsupported V2 result %s %s before fetch', async (method, path) => {
    await expect(
      createSessionTransport(session, vi.fn()).request({
        path,
        method,
        body: null,
        idempotencyKey: null,
      }),
    ).rejects.toThrow('ROUTE_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/bff/v1/ai-settings'],
    ['GET', '/bff/v1/ai-settings/catalog'],
    ['PUT', '/bff/v1/ai-settings'],
  ] as const)(
    'carries scoped AI settings %s %s without logging private values',
    async (method, path) => {
      const logs = [
        vi.spyOn(console, 'log'),
        vi.spyOn(console, 'info'),
        vi.spyOn(console, 'debug'),
      ];
      try {
        fetchMock.mockResolvedValue(json({ accepted: true }));
        const signal = new AbortController().signal;
        const write = method === 'PUT';
        const body = write ? { expectedRevision: 0, comparisonEnabled: false } : null;
        await expect(
          createSessionTransport(session, vi.fn()).request({
            path,
            method,
            body,
            idempotencyKey: write ? 'synthetic-settings-command' : null,
            signal,
          }),
        ).resolves.toEqual({ status: 200, body: { accepted: true }, traceId: null });
        expect(fetchMock).toHaveBeenCalledWith(path, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal,
          headers: {
            'x-workout-session-id': session.sessionId,
            ...(write
              ? {
                  'x-csrf-token': session.csrfToken,
                  'idempotency-key': 'synthetic-settings-command',
                  'content-type': 'application/json',
                }
              : {}),
          },
          ...(write ? { body: JSON.stringify(body) } : {}),
        });
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      } finally {
        for (const log of logs) log.mockRestore();
      }
    },
  );
  it.each([
    ['GET', '/bff/v1/ai-settings-admin'],
    ['GET', '/bff/v1/ai-settings/admin'],
    ['GET', '/bff/v1/ai-settings/catalog-admin'],
    ['GET', '/bff/v1/admin/ai-settings'],
    ['PUT', '/bff/v1/ai-settings/catalog'],
    ['POST', '/bff/v1/ai-settings'],
  ] as const)('refuses unsafe AI settings %s %s before fetch', async (method, path) => {
    await expect(
      createSessionTransport(session, vi.fn()).request({
        path,
        method,
        body: null,
        idempotencyKey: null,
      }),
    ).rejects.toThrow('ROUTE_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
  it('allows the restore generation read for the current session without write credentials', async () => {
    fetchMock.mockResolvedValue(json({ generationId: 'ad01a6b2-e6c6-4384-a818-729e15aa5eb5' }));
    await createSessionTransport(session, vi.fn()).request({
      path: '/bff/v1/restore-generation',
      method: 'GET',
      body: null,
      idempotencyKey: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/bff/v1/restore-generation',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-workout-session-id': session.sessionId },
      }),
    );
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
  it('rejects a real response that reaches the transport after its workspace is inactive', async () => {
    const delayed = pendingResponse();
    const response = json({ owner: 'Alice private result' });
    const parse = vi.spyOn(response, 'json');
    let active = true;
    fetchMock.mockReturnValueOnce(delayed.promise);
    const request = createSessionTransport(
      session,
      vi.fn(),
      () => true,
      () => active,
    ).request({
      path: '/bff/v1/courses',
      method: 'GET',
      body: null,
      idempotencyKey: null,
    });
    active = false;
    delayed.resolve(response);
    await expect(request).rejects.toThrow('SESSION_UNAVAILABLE');
    expect(parse).not.toHaveBeenCalled();
  });
  it('rejects an old response whose body finishes parsing after workspace invalidation', async () => {
    const response = json({ owner: 'Alice private result' });
    let finishBody: (value: { owner: string }) => void = () => undefined;
    let markParsing: () => void = () => undefined;
    const parsing = new Promise<void>((resolve) => {
      markParsing = resolve;
    });
    const body = new Promise<{ owner: string }>((resolve) => {
      finishBody = resolve;
    });
    vi.spyOn(response, 'json').mockImplementation(() => {
      markParsing();
      return body;
    });
    let active = true;
    fetchMock.mockResolvedValueOnce(response);
    const request = createSessionTransport(
      session,
      vi.fn(),
      () => true,
      () => active,
    ).request({
      path: '/bff/v1/courses',
      method: 'GET',
      body: null,
      idempotencyKey: null,
    });
    await parsing;
    active = false;
    finishBody({ owner: 'Alice private result' });
    await expect(request).rejects.toThrow('SESSION_UNAVAILABLE');
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
  it('unmounts a populated private child when another tab removes the account scope on logout', async () => {
    const revalidation = pendingResponse();
    fetchMock.mockResolvedValueOnce(json(session)).mockReturnValueOnce(revalidation.promise);
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    fireEvent.change(await screen.findByLabelText('Private draft'), {
      target: { value: 'Alice private draft' },
    });
    expect(localStorage.getItem(PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY)).toBe(session.athleteId);
    localStorage.removeItem(PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY,
          oldValue: session.athleteId,
          newValue: null,
        }),
      );
    });
    expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('로그인 상태');
    await act(async () => {
      revalidation.resolve(json({ error: { code: 'UNAUTHENTICATED' } }, 401));
      await revalidation.promise;
    });
    expect(await screen.findByRole('link', { name: '계정에서 로그인' })).toBeInTheDocument();
  });
  it('revalidates a focused cross-origin tab and removes private children after logout 401', async () => {
    const revalidation = pendingResponse();
    fetchMock.mockResolvedValueOnce(json(session)).mockReturnValueOnce(revalidation.promise);
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    fireEvent.change(await screen.findByLabelText('Private draft'), {
      target: { value: 'Alice private draft' },
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      revalidation.resolve(json({ error: { code: 'UNAUTHENTICATED' } }, 401));
      await revalidation.promise;
    });
    expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '계정에서 로그인' })).toBeInTheDocument();
  });
  it('supersedes a pending Alice check on focus after a cross-origin Bob login', async () => {
    const oldRevalidation = pendingResponse();
    const bob = { ...session, athleteId: 'athlete-b', sessionId: 'session-b' };
    fetchMock
      .mockResolvedValueOnce(json(session))
      .mockReturnValueOnce(oldRevalidation.promise)
      .mockResolvedValueOnce(json(bob));
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    fireEvent.change(await screen.findByLabelText('Private draft'), {
      target: { value: 'Alice private draft' },
    });
    act(() => window.dispatchEvent(new Event('focus')));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const oldSignal = fetchMock.mock.calls[1]?.[1]?.signal;
    expect(oldSignal?.aborted).toBe(false);

    // Another origin cannot deliver this tab's account-scope storage event.
    act(() => window.dispatchEvent(new Event('focus')));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(oldSignal?.aborted).toBe(true);
    expect(await screen.findByText(bob.athleteId)).toBeInTheDocument();
    expect(screen.getByLabelText('Private draft')).toHaveValue('');
    await act(async () => {
      oldRevalidation.resolve(json(session));
      await oldRevalidation.promise;
    });
    expect(screen.getByText(bob.athleteId)).toBeInTheDocument();
    expect(screen.getByLabelText('Private draft')).toHaveValue('');
    expect(localStorage.getItem(PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY)).toBe(bob.athleteId);
  });
  it('keeps replacement account storage when another tab changes account scope', async () => {
    const bob = { ...session, athleteId: 'athlete-b', sessionId: 'session-b' };
    fetchMock.mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(bob));
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    fireEvent.change(await screen.findByLabelText('Private draft'), {
      target: { value: 'Alice private draft' },
    });
    localStorage.setItem(PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY, bob.athleteId);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY,
          oldValue: session.athleteId,
          newValue: bob.athleteId,
        }),
      );
    });
    expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument();
    expect(await screen.findByText(bob.athleteId)).toBeInTheDocument();
    expect(screen.getByLabelText('Private draft')).toHaveValue('');
    expect(localStorage.getItem(PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY)).toBe(bob.athleteId);
  });
  it('ignores an old session response arriving after another tab logs out', async () => {
    const oldRevalidation = pendingResponse();
    fetchMock
      .mockResolvedValueOnce(json(session))
      .mockReturnValueOnce(oldRevalidation.promise)
      .mockResolvedValueOnce(json({ error: { code: 'UNAUTHENTICATED' } }, 401));
    render(
      <AuthenticatedWorkspace>
        <PrivateWorkspace />
      </AuthenticatedWorkspace>,
    );
    fireEvent.change(await screen.findByLabelText('Private draft'), {
      target: { value: 'Alice private draft' },
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    localStorage.removeItem(PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY,
          oldValue: session.athleteId,
          newValue: null,
        }),
      );
    });
    expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '계정에서 로그인' })).toBeInTheDocument();
    await act(async () => {
      oldRevalidation.resolve(json(session));
      await oldRevalidation.promise;
    });
    expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '계정에서 로그인' })).toBeInTheDocument();
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
  ['GET', '/bff/v1/healthkit/workout-review?limit=50'],
  ['POST', '/bff/v1/healthkit/workout-activities'],
  ['POST', '/bff/v1/healthkit/workout-bindings'],
] as const)('binds HealthKit review %s %s to the active session', async (method, path) => {
  fetchMock.mockResolvedValue(json({ accepted: true }));
  await createSessionTransport(session, vi.fn()).request({
    method,
    path,
    body: method === 'GET' ? null : { confirmed: true },
    idempotencyKey: method === 'GET' ? null : 'healthkit-key',
  });
  expect(fetchMock).toHaveBeenCalledWith(
    path,
    expect.objectContaining({
      credentials: 'same-origin',
      headers: expect.objectContaining({
        'x-workout-session-id': session.sessionId,
        ...(method === 'GET'
          ? {}
          : { 'x-csrf-token': session.csrfToken, 'idempotency-key': 'healthkit-key' }),
      }),
    }),
  );
});

it('rejects adjacent HealthKit namespaces', async () => {
  await expect(
    createSessionTransport(session, vi.fn()).request({
      method: 'POST',
      path: '/bff/v1/healthkit/workout-activities-admin',
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
  ['POST', '/bff/v1/retrieval/queries'],
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
  '/bff/v1/retrieval/queries-admin',
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

it.each([
  ['POST', '/bff/v1/retrieval/queries/admin'],
  ['POST', '/bff/v1/retrieval/queries/'],
  ['POST', '/bff/v1/retrieval/queries?admin=true'],
  ['GET', '/bff/v1/retrieval/queries'],
  ['PUT', '/bff/v1/retrieval/queries'],
] as const)('rejects non-POST or non-exact retrieval query route %s %s', async (method, path) => {
  await expect(
    createSessionTransport(session, vi.fn()).request({
      method,
      path,
      body: null,
      idempotencyKey: null,
    }),
  ).rejects.toThrow('ROUTE_NOT_ALLOWED');
  expect(fetchMock).not.toHaveBeenCalled();
});

describe('race capabilities exact transport route', () => {
  it('carries only the exact GET through the existing session', async () => {
    fetchMock.mockResolvedValue(
      json({ schemaVersion: 1, legacyResults: true, proofResultsV2: false }),
    );
    await createSessionTransport(session, vi.fn()).request({
      method: 'GET',
      path: '/bff/v1/race-results/capabilities',
      body: null,
      idempotencyKey: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['DELETE', '/bff/v1/race-results/capabilities'],
    ['PUT', '/bff/v1/race-results/capabilities'],
    ['POST', '/bff/v1/race-results/capabilities'],
    ['PATCH', '/bff/v1/race-results/capabilities'],
    ['GET', '/bff/v1/race-results/capabilities?schemaVersion=1'],
    ['GET', '/bff/v1/race-results/capabilities?'],
    ['GET', '/bff/v1/race-results/capabilities/'],
    ['GET', '/bff/v1/race-results/capabilities-other'],
  ] as const)('rejects %s %s before fetch', async (method, path) => {
    await expect(
      createSessionTransport(session, vi.fn()).request({
        method,
        path,
        body: null,
        idempotencyKey: null,
      }),
    ).rejects.toThrow('ROUTE_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const ownedRouteId = '00000000-0000-4000-8000-000000000001';
const templateRoute = '/bff/v1/check-in-templates';
const reviewRoute = `/bff/v1/race-date-change-reviews/${ownedRouteId}`;
describe('exact template and manual race review transport routes', () => {
  it.each([
    ['GET', templateRoute],
    ['GET', `${templateRoute}?limit=100&offset=10000`],
    ['GET', `${templateRoute}?offset=0&limit=1`],
    ['GET', `${templateRoute}?limit=20`],
    ['GET', `${templateRoute}?offset=0`],
    ['GET', `${templateRoute}/${ownedRouteId}`],
    ['GET', `${templateRoute}/${ownedRouteId}/versions/${ownedRouteId}`],
    ['POST', templateRoute],
    ['GET', '/bff/v1/race-date-change-reviews/capabilities'],
    ['POST', `/bff/v1/races/${ownedRouteId}/date-change-reviews`],
    ['GET', reviewRoute],
    ['POST', `${reviewRoute}/approve`],
  ] as const)(
    'permits only supported %s %s with session/write credentials',
    async (method, path) => {
      fetchMock.mockResolvedValue(json({ accepted: true }));
      const write = method === 'POST';
      const signal = new AbortController().signal;
      await createSessionTransport(session, vi.fn()).request({
        method,
        path,
        body: write ? { confirmed: true } : null,
        idempotencyKey: write ? 'explicit-command-key' : null,
        signal,
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
        headers: {
          'x-workout-session-id': session.sessionId,
          ...(write
            ? {
                'x-csrf-token': session.csrfToken,
                'idempotency-key': 'explicit-command-key',
                'content-type': 'application/json',
              }
            : {}),
        },
        ...(write ? { body: '{"confirmed":true}' } : {}),
      });
    },
  );

  it.each([
    ['DELETE', templateRoute],
    ['PUT', templateRoute],
    ['PATCH', `${templateRoute}/${ownedRouteId}`],
    ['POST', `${templateRoute}/${ownedRouteId}`],
    ['POST', `${templateRoute}?limit=1`],
    ['GET', `${templateRoute}?`],
    ['GET', `${templateRoute}?limit=0`],
    ['GET', `${templateRoute}?limit=101`],
    ['GET', `${templateRoute}?offset=10001`],
    ['GET', `${templateRoute}?offset=-1`],
    ['GET', `${templateRoute}?limit=01`],
    ['GET', `${templateRoute}?limit=%32`],
    ['GET', `${templateRoute}?limit=2&limit=3`],
    ['GET', `${templateRoute}?offset=0&offset=1`],
    ['GET', `${templateRoute}?limit=1&admin=true`],
    ['GET', `${templateRoute}?offset=0&`],
    ['GET', `${templateRoute}/admin`],
    ['GET', `${templateRoute}/${ownedRouteId}/`],
    ['GET', `${templateRoute}/${ownedRouteId}/versions/${ownedRouteId}?offset=0`],
    ['GET', `${templateRoute}/${ownedRouteId}/versions/${ownedRouteId}/admin`],
    ['GET', `${templateRoute}/%30${ownedRouteId.slice(1)}`],
    ['GET', `${templateRoute}-admin`],
    ['POST', '/bff/v1/race-date-change-reviews/capabilities'],
    ['GET', '/bff/v1/race-date-change-reviews/capabilities?'],
    ['GET', '/bff/v1/race-date-change-reviews/capabilities?admin=true'],
    ['GET', `/bff/v1/races/${ownedRouteId}/date-change-reviews`],
    ['POST', `/bff/v1/races/${ownedRouteId}/date-change-reviews?admin=true`],
    ['POST', `/bff/v1/races/${ownedRouteId}/date-change-reviews/admin`],
    ['DELETE', reviewRoute],
    ['POST', reviewRoute],
    ['GET', `${reviewRoute}?maxSchemaVersion=1`],
    ['GET', `${reviewRoute}/approve`],
    ['POST', `${reviewRoute}/approve?confirmed=true`],
    ['POST', `${reviewRoute}/approve/admin`],
    ['GET', '/bff/v1/race-date-change-reviews/admin'],
  ] as const)('rejects unsupported %s %s before HTTP', async (method, path) => {
    await expect(
      createSessionTransport(session, vi.fn()).request({
        method,
        path,
        body: null,
        idempotencyKey: null,
      }),
    ).rejects.toThrow('ROUTE_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    `${templateRoute}/%2e%2e/admin`,
    `${reviewRoute}/%2fapprove`,
    `${templateRoute}/${ownedRouteId}#admin`,
  ])('preserves primary API syntax rejection for %s before HTTP', async (path) => {
    await expect(
      createSessionTransport(session, vi.fn()).request({
        method: 'GET',
        path,
        body: null,
        idempotencyKey: null,
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Mirrors the actual Host's explicit transport-identity reset boundary. */
function TransportReferenceWorkspace({
  observed,
}: {
  observed: (transport: AuthenticatedTransport) => void;
}) {
  const { transport } = useAuthenticatedSession();
  const [identity, setIdentity] = useState(() => ({ transport, revision: 0 }));
  useEffect(() => observed(transport), [transport, observed]);
  if (identity.transport !== transport) {
    setIdentity({ transport, revision: identity.revision + 1 });
    return null;
  }
  return <PrivateWorkspace key={identity.revision} />;
}

describe('revalidation preserves exact session transport identity', () => {
  it('retains the actual reset-on-reference consumer draft through focus, visibility and 60-second lookup', async () => {
    vi.useFakeTimers();
    const observed = vi.fn();
    fetchMock.mockImplementation(async () => json({ ...session }));
    render(
      <AuthenticatedWorkspace>
        <TransportReferenceWorkspace observed={observed} />
      </AuthenticatedWorkspace>,
    );
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Private draft'), { target: { value: '초안 유지' } });
    const original = observed.mock.calls[0]?.[0];
    for (const eventName of ['focus', 'visibilitychange']) {
      await act(async () => window.dispatchEvent(new Event(eventName)));
      expect(screen.getByLabelText('Private draft')).toHaveValue('초안 유지');
      expect(observed).toHaveBeenCalledExactlyOnceWith(original);
    }
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText('Private draft')).toHaveValue('초안 유지');
    expect(observed).toHaveBeenCalledExactlyOnceWith(original);
  });
  it.each([
    { field: 'athleteId', next: { ...session, athleteId: 'athlete-b' } },
    { field: 'sessionId', next: { ...session, sessionId: 'session-b' } },
    { field: 'csrfToken', next: { ...session, csrfToken: 'r'.repeat(43) } },
    {
      field: 'expiresAt',
      next: {
        ...session,
        expiresAt: new Date(Date.parse(session.expiresAt) + 60_000).toISOString(),
      },
    },
  ])('resets on $field rotation and makes the old transport unavailable', async ({ next }) => {
    const observed = vi.fn<(transport: AuthenticatedTransport) => void>();
    fetchMock.mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(next));
    render(
      <AuthenticatedWorkspace>
        <TransportReferenceWorkspace observed={observed} />
      </AuthenticatedWorkspace>,
    );
    await screen.findByLabelText('Private draft');
    fireEvent.change(screen.getByLabelText('Private draft'), {
      target: { value: 'old private draft' },
    });
    const original = observed.mock.calls[0]?.[0];
    if (!original) throw Error('Missing original transport');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(screen.getByLabelText('Private draft')).toHaveValue('');
    expect(observed).toHaveBeenCalledTimes(2);
    const current = observed.mock.calls[1]?.[0];
    expect(current).not.toBe(original);
    await expect(
      original.request({
        path: '/bff/v1/plans/current',
        method: 'PUT',
        body: {},
        idempotencyKey: 'old-command',
      }),
    ).rejects.toThrow('SESSION_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (!current) throw Error('Missing replacement transport');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await current.request({
      path: '/bff/v1/plans/current',
      method: 'PUT',
      body: {},
      idempotencyKey: 'new-command',
    });
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual(
      expect.objectContaining({
        'x-workout-session-id': next.sessionId,
        'x-csrf-token': next.csrfToken,
      }),
    );
  });
  it('honors a changed shorter expiry instead of preserving the prior timer', async () => {
    vi.useFakeTimers();
    const observed = vi.fn();
    const next = { ...session, expiresAt: new Date(Date.now() + 1000).toISOString() };
    fetchMock
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(next))
      .mockReturnValue(new Promise(() => {}));
    render(
      <AuthenticatedWorkspace>
        <TransportReferenceWorkspace observed={observed} />
      </AuthenticatedWorkspace>,
    );
    await act(async () => {});
    await act(async () => window.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByLabelText('Private draft')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(1001));
    expect(screen.queryByLabelText('Private draft')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('로그인 상태');
  });
});

it('keeps transport-reset consumer drafts across offline blocking and identical-session recovery', async () => {
  const observed = vi.fn<(transport: AuthenticatedTransport) => void>();
  fetchMock.mockResolvedValueOnce(json(session));
  render(
    <AuthenticatedWorkspace>
      <TransportReferenceWorkspace observed={observed} />
    </AuthenticatedWorkspace>,
  );
  await screen.findByLabelText('Private draft');
  fireEvent.change(screen.getByLabelText('Private draft'), { target: { value: 'offline draft' } });
  fetchMock.mockResolvedValueOnce(json({ error: { code: 'UNAVAILABLE' } }, 503));
  await act(async () => window.dispatchEvent(new Event('focus')));
  fireEvent.click(screen.getByRole('button', { name: 'Save private draft' }));
  expect(await screen.findByText('SESSION_UNAVAILABLE')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Private draft')).toHaveValue('offline draft');
  fetchMock.mockResolvedValueOnce(json({ ...session }));
  fireEvent.click(screen.getByRole('button', { name: '다시 확인' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(observed).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Private draft')).toHaveValue('offline draft');
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  fireEvent.click(screen.getByRole('button', { name: 'Save private draft' }));
  expect(await screen.findByText('saved')).toBeInTheDocument();
});
