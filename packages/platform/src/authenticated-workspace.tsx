'use client';

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import {
  apiPathSchema,
  transportReplySchema,
  type AuthenticatedTransport,
} from '@workout/contracts/core';

const sessionSchema = z.strictObject({
  athleteId: z.string().min(1),
  sessionId: z.string().min(1),
  csrfToken: z.string().min(32),
  expiresAt: z.iso.datetime({ offset: true }),
});
type Session = z.infer<typeof sessionSchema>;
interface WorkspaceSession {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
}
const SessionContext = createContext<WorkspaceSession | null>(null);

/** The browser Host is bound to the session that created it, including across tabs. */
export function createSessionTransport(
  session: Session,
  expired: () => void,
  available: () => boolean = () => true,
  active: () => boolean = () => true,
): AuthenticatedTransport {
  return {
    async request(input) {
      if (!available()) throw new Error('SESSION_UNAVAILABLE');
      if (Date.parse(session.expiresAt) <= Date.now()) {
        expired();
        throw new Error('SESSION_EXPIRED');
      }
      const path = apiPathSchema.parse(input.path);
      if (!/^\/bff\/v1\/(?:plans|activities|activity-imports|check-ins)(?:\/|\?|$)/.test(path))
        throw new Error('ROUTE_NOT_ALLOWED');
      const headers: Record<string, string> = { 'x-workout-session-id': session.sessionId };
      if (!['GET', 'HEAD'].includes(input.method)) headers['x-csrf-token'] = session.csrfToken;
      if (input.idempotencyKey !== null) headers['idempotency-key'] = input.idempotencyKey;
      if (input.body !== null) headers['content-type'] = 'application/json';
      const response = await fetch(path, {
        method: input.method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        ...(input.body === null ? {} : { body: JSON.stringify(input.body) }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!active()) throw new Error('SESSION_UNAVAILABLE');
      if (response.status === 401) {
        expired();
        throw new Error('SESSION_EXPIRED');
      }
      const body: unknown = response.status === 204 ? null : await response.json();
      if (!active()) throw new Error('SESSION_UNAVAILABLE');
      if (
        response.status === 409 &&
        z.object({ error: z.object({ code: z.literal('SESSION_CHANGED') }) }).safeParse(body)
          .success
      ) {
        expired();
        throw new Error('SESSION_EXPIRED');
      }
      return transportReplySchema.parse({ status: response.status, body, traceId: null });
    },
  };
}

export function useAuthenticatedSession(): WorkspaceSession {
  const value = use(SessionContext);
  if (!value) throw new Error('AuthenticatedWorkspace required');
  return value;
}

function createTransportLifetime() {
  let active = true;
  let available = true;
  return {
    activate(next: boolean) {
      active = true;
      available = next;
    },
    deactivate() {
      active = false;
    },
    isAvailable() {
      return active && available;
    },
    isActive() {
      return active;
    },
  };
}

function SessionLifetime({
  session,
  expired,
  available,
  children,
}: {
  session: Session;
  expired: () => void;
  available: boolean;
  children: ReactNode;
}) {
  const [lifetime] = useState(createTransportLifetime);
  useLayoutEffect(() => {
    lifetime.activate(available);
    return () => lifetime.deactivate();
  }, [lifetime, available]);
  const value = useMemo(
    () => ({
      athleteId: session.athleteId,
      sessionId: session.sessionId,
      transport: createSessionTransport(
        session,
        () => {
          if (lifetime.isActive()) expired();
        },
        lifetime.isAvailable,
        lifetime.isActive,
      ),
    }),
    [session, expired, lifetime],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function AuthenticatedWorkspace({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [generation, setGeneration] = useState(0);
  const expired = useCallback(() => {
    setSession(null);
    setState('loading');
    setGeneration((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch('/bff/v1/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          setSession(null);
          setState('ready');
          return;
        }
        if (!response.ok) throw new Error('SESSION_UNAVAILABLE');
        const next = sessionSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setSession(Date.parse(next.expiresAt) > Date.now() ? next : null);
        setState('ready');
      } catch {
        if (!controller.signal.aborted) {
          setState('offline');
        }
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('visibilitychange', onVisible);
    };
  }, [generation]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(expired, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [session, expired]);
  if (state === 'loading') return <p role="status">로그인 상태를 확인하고 있습니다.</p>;
  if (state === 'offline' && !session)
    return (
      <div role="alert">
        로그인 확인 실패 <button onClick={expired}>다시 확인</button>
      </div>
    );
  if (!session)
    return (
      <p>
        이 작업은 로그인이 필요합니다. <a href="/account">계정에서 로그인</a>
      </p>
    );
  return (
    <>
      {state === 'offline' ? (
        <div role="alert">
          연결을 확인할 수 없어 저장을 잠시 중지했습니다. 작성 중인 내용은 유지됩니다.{' '}
          <button onClick={() => setGeneration((value) => value + 1)}>다시 확인</button>
        </div>
      ) : null}
      <SessionLifetime
        key={`${session.athleteId}:${session.sessionId}`}
        session={session}
        expired={expired}
        available={state === 'ready'}
      >
        {children}
      </SessionLifetime>
    </>
  );
}
