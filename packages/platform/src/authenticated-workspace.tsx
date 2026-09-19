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
import {
  bindPrivateBrowserStorageAccount,
  clearPrivateBrowserStorage,
} from './private-browser-storage';

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
  fileTransfer: SessionFileTransfer;
}
const SessionContext = createContext<WorkspaceSession | null>(null);

interface SessionFileTransfer {
  upload(input: {
    uploadId: string;
    file: File;
    mediaType: 'application/pdf' | 'text/markdown';
    signal: AbortSignal;
    onProgress: (uploadedBytes: number, totalBytes: number) => void;
  }): Promise<void>;
  open(input: {
    resourceId: string;
    versionId: string;
    fileName: string;
    signal: AbortSignal;
  }): Promise<void>;
}

function assertLiveSession(session: Session, expired: () => void, available: () => boolean): void {
  if (!available()) throw new Error('SESSION_UNAVAILABLE');
  if (Date.parse(session.expiresAt) <= Date.now()) {
    expired();
    throw new Error('SESSION_EXPIRED');
  }
}

async function assertTransferResponse(
  response: Response,
  expired: () => void,
  active: () => boolean,
): Promise<void> {
  if (!active()) throw new Error('SESSION_UNAVAILABLE');
  if (response.status === 401) {
    expired();
    throw new Error('SESSION_EXPIRED');
  }
  if (response.status === 409) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (
      z.object({ error: z.object({ code: z.literal('SESSION_CHANGED') }) }).safeParse(body).success
    ) {
      expired();
      throw new Error('SESSION_EXPIRED');
    }
  }
  if (!response.ok) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error.code : 'RESOURCE_FILE_TRANSFER_FAILED');
  }
}

export function createSessionFileTransfer(
  session: Session,
  expired: () => void,
  available: () => boolean = () => true,
  active: () => boolean = () => true,
): SessionFileTransfer {
  const resourceIdSchema = z.uuid().transform((value) => value.toLowerCase());
  return {
    async upload(input) {
      assertLiveSession(session, expired, available);
      const uploadId = resourceIdSchema.parse(input.uploadId);
      input.onProgress(0, input.file.size);
      const response = await fetch(
        `/bff/v1/resources/uploads/${encodeURIComponent(uploadId)}/content`,
        {
          method: 'PUT',
          headers: {
            'content-type': input.mediaType,
            'x-resource-file-name': encodeURIComponent(input.file.name),
            'x-workout-session-id': session.sessionId,
            'x-csrf-token': session.csrfToken,
          },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          body: input.file,
          signal: input.signal,
        },
      );
      await assertTransferResponse(response, expired, active);
      input.onProgress(input.file.size, input.file.size);
    },
    async open(input) {
      assertLiveSession(session, expired, available);
      const resourceId = resourceIdSchema.parse(input.resourceId);
      const versionId = resourceIdSchema.parse(input.versionId);
      const search = new URLSearchParams({ versionId });
      const response = await fetch(
        `/bff/v1/resources/${encodeURIComponent(resourceId)}/content?${search.toString()}`,
        {
          method: 'GET',
          headers: { 'x-workout-session-id': session.sessionId },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: input.signal,
        },
      );
      await assertTransferResponse(response, expired, active);
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = input.fileName;
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    },
  };
}

/** The browser Host is bound to the session that created it, including across tabs. */
export function createSessionTransport(
  session: Session,
  expired: () => void,
  available: () => boolean = () => true,
  active: () => boolean = () => true,
): AuthenticatedTransport {
  return {
    async request(input) {
      assertLiveSession(session, expired, available);
      const path = apiPathSchema.parse(input.path);
      if (
        !/^\/bff\/v1\/(?:plans|plan-scenarios|planner|nutrition|supplementary|stretching|recovery|resources|routines|routine-versions|routine-schedule-previews|routine-schedules|routine-runs|coaching-threads|coaching-runs|coaching-candidates|joint-decisions|joint-candidates|integrated-candidates|coaching-constraints|evidence-snapshots|activities|activity-imports|check-ins|dashboard)(?:\/|\?|$)/.test(
          path,
        )
      )
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
      fileTransfer: createSessionFileTransfer(
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
    clearPrivateBrowserStorage();
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
          clearPrivateBrowserStorage();
          setSession(null);
          setState('ready');
          return;
        }
        if (!response.ok) throw new Error('SESSION_UNAVAILABLE');
        const next = sessionSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        if (Date.parse(next.expiresAt) > Date.now()) {
          bindPrivateBrowserStorageAccount(next.athleteId);
          setSession(next);
        } else {
          clearPrivateBrowserStorage();
          setSession(null);
        }
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
