import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { IdentityWorkspace } from '../src/identity-workspace';

const session = {
  athleteId: 'athlete-a',
  sessionId: 'session-a',
  csrfToken: 'c'.repeat(43),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function operationsResponse() {
  return response({
    checkedAt: '2026-09-16T00:00:00Z',
    outbox: { pending: 0, leased: 0, retrying: 0, completed: 0 },
    providers: { garmin: 'not_connected', healthkit: 'not_connected' },
    audit: [],
  });
}
afterEach(() => vi.unstubAllGlobals());

it('shows provider login on401 without exposing private controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(null, 401)),
  );
  render(<IdentityWorkspace />);
  expect(await screen.findByRole('link', { name: 'OIDC로 로그인' })).toHaveAttribute(
    'href',
    '/bff/v1/auth/login',
  );
  expect(screen.queryByRole('button', { name: 'AI 전달에 동의' })).not.toBeInTheDocument();
});
it('clears private consent and account UI only after logout confirmation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path === '/bff/v1/operations/status'
        ? operationsResponse()
        : path === '/bff/v1/session'
          ? response(session)
          : path.endsWith('/logout')
            ? new Response(null, { status: 204 })
            : response({ kind: 'ai', granted: true, revision: 2 }),
    ),
  );
  render(<IdentityWorkspace />);
  await screen.findByRole('button', { name: 'AI 동의 철회' });
  await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
  await screen.findByRole('link', { name: 'OIDC로 로그인' });
  expect(screen.queryByText(/athlete-a/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'AI 동의 철회' })).not.toBeInTheDocument();
});
it('does not claim consent success when its revision conflicts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) =>
      path === '/bff/v1/operations/status'
        ? operationsResponse()
        : path === '/bff/v1/session'
          ? response(session)
          : init?.method === 'PUT'
            ? response({ error: { code: 'CONSENT_CONFLICT' } }, 409)
            : response({ kind: 'ai', granted: false, revision: 1 }),
    ),
  );
  render(<IdentityWorkspace />);
  await userEvent.click(await screen.findByRole('button', { name: 'AI 전달에 동의' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('현재 동의: 허용하지 않음')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '같은 변경 재시도' })).not.toBeInTheDocument();
});
it('retries uncertain mutations with the original idempotency key and server revision', async () => {
  const commands: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/bff/v1/operations/status') return operationsResponse();
      if (path === '/bff/v1/session') return response(session);
      if (init?.method === 'PUT') {
        commands.push(init);
        return commands.length === 1
          ? response(null, 503)
          : response({ kind: 'ai', granted: true, revision: 2 });
      }
      return response({
        kind: 'ai',
        granted: commands.length > 1,
        revision: commands.length > 1 ? 2 : 1,
      });
    }),
  );
  render(<IdentityWorkspace />);
  await userEvent.click(await screen.findByRole('button', { name: 'AI 전달에 동의' }));
  await userEvent.click(await screen.findByRole('button', { name: '같은 변경 재시도' }));
  await screen.findByRole('button', { name: 'AI 동의 철회' });
  expect(commands).toHaveLength(2);
  expect(commands[0]?.body).toBe(commands[1]?.body);
  expect(commands[0]?.headers).toEqual(commands[1]?.headers);
});
it('rejects malformed session data without showing an account', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ ...session, csrfToken: 'short' })),
  );
  render(<IdentityWorkspace />);
  expect(await screen.findByRole('alert')).toHaveTextContent('로그인 상태를 확인하지 못했습니다.');
  expect(screen.queryByText(/athlete-a/)).not.toBeInTheDocument();
});

it('never relabels a historical successful receipt as the current consent after a newer withdrawal', async () => {
  let commands = 0;
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/bff/v1/operations/status') return operationsResponse();
      if (path === '/bff/v1/session') return response(session);
      if (init?.method === 'PUT') {
        commands += 1;
        return commands === 1
          ? response(null, 503)
          : response({ kind: 'ai', granted: true, revision: 2 });
      }
      reads += 1;
      return response({ kind: 'ai', granted: false, revision: reads === 1 ? 1 : 3 });
    }),
  );
  render(<IdentityWorkspace />);
  await userEvent.click(await screen.findByRole('button', { name: 'AI 전달에 동의' }));
  await userEvent.click(await screen.findByRole('button', { name: '같은 변경 재시도' }));
  expect(await screen.findByText('현재 동의: 허용하지 않음')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'AI 동의 철회' })).not.toBeInTheDocument();
  expect(reads).toBe(2);
});
it('hides previous consent when the authoritative read fails after a successful receipt', async () => {
  let wrote = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/bff/v1/operations/status') return operationsResponse();
      if (path === '/bff/v1/session') return response(session);
      if (init?.method === 'PUT') {
        wrote = true;
        return response({ kind: 'ai', granted: true, revision: 2 });
      }
      return wrote ? response(null, 503) : response({ kind: 'ai', granted: false, revision: 1 });
    }),
  );
  render(<IdentityWorkspace />);
  await userEvent.click(await screen.findByRole('button', { name: 'AI 전달에 동의' }));
  await screen.findByText('동의를 불러오지 못했습니다.');
  expect(screen.queryByText(/현재 동의:/)).not.toBeInTheDocument();
});
it('clears account A before refetching B when a shared cookie changes ahead of session refresh', async () => {
  const next = { ...session, athleteId: 'athlete-b', sessionId: 'session-b' };
  let switched = false;
  let releaseSession: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const headers: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/bff/v1/operations/status') return operationsResponse();
      if (path === '/bff/v1/session') {
        if (switched) {
          await delayed;
          return response(next);
        }
        return response(session);
      }
      const expected = new Headers(init?.headers).get('x-workout-session-id') ?? '';
      headers.push(expected);
      if (switched && expected !== next.sessionId)
        return response({ error: { code: 'SESSION_CHANGED' } }, 409);
      return response({ kind: 'ai', granted: switched, revision: 1 });
    }),
  );
  render(<IdentityWorkspace />);
  await screen.findByRole('button', { name: 'AI 전달에 동의' });
  switched = true;
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(screen.queryByText(/athlete-a/)).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'AI 동의 철회' })).not.toBeInTheDocument();
  await act(async () => {
    releaseSession?.();
    await delayed;
  });
  await screen.findByText(/athlete-b/);
  await screen.findByRole('button', { name: 'AI 동의 철회' });
  expect(headers).toContain('session-a');
  expect(headers).toContain('session-b');
  focusManager.setFocused(undefined);
});
it('clears an expired server session and its private consent controls', async () => {
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/bff/v1/operations/status') return operationsResponse();
      if (path === '/bff/v1/session') return response(session);
      reads += 1;
      return reads === 1
        ? response({ kind: 'ai', granted: true, revision: 1 })
        : response(null, 401);
    }),
  );
  render(<IdentityWorkspace />);
  await screen.findByRole('button', { name: 'AI 동의 철회' });
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await screen.findByRole('link', { name: 'OIDC로 로그인' });
  expect(screen.queryByText(/athlete-a/)).not.toBeInTheDocument();
  expect(screen.queryByText(/현재 동의:/)).not.toBeInTheDocument();
  focusManager.setFocused(undefined);
});
