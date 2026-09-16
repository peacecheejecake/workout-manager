'use client';

import { useEffect, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { OperationsPanel } from './operations-panel';
import { GarminPanel } from './garmin-panel';

const sessionSchema = z.strictObject({
  athleteId: z.string().min(1),
  sessionId: z.string().min(1),
  csrfToken: z.string().min(32),
  expiresAt: z.iso.datetime({ offset: true }),
});
const consentSchema = z.strictObject({
  kind: z.literal('ai'),
  granted: z.boolean(),
  revision: z.number().int().nonnegative(),
});
type Session = z.infer<typeof sessionSchema>;

async function loadSession(signal: AbortSignal) {
  const response = await fetch('/bff/v1/session', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('SESSION_UNAVAILABLE');
  const data = sessionSchema.parse(await response.json());
  return Date.parse(data.expiresAt) <= Date.now() ? null : data;
}

export function IdentityWorkspace() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <SessionBoundary />
    </QueryClientProvider>
  );
}

function SessionBoundary() {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ['identity', 'current-session'],
    queryFn: ({ signal }) => loadSession(signal),
    refetchInterval: 60_000,
  });
  useEffect(() => {
    if (!session.data) return;
    const timer = setTimeout(
      () => client.setQueryData(['identity', 'current-session'], null),
      Math.max(0, Date.parse(session.data.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [client, session.data]);
  if (session.isPending) return <p role="status">로그인 상태를 확인하고 있습니다.</p>;
  if (session.isError)
    return (
      <div role="alert">
        <p>로그인 상태를 확인하지 못했습니다.</p>
        <button type="button" onClick={() => void session.refetch()}>
          다시 확인
        </button>
      </div>
    );
  if (!session.data)
    return (
      <section>
        <h2>로그인</h2>
        <p>인증 제공자에서 로그인·가입·계정 복구를 진행합니다.</p>
        <a href="/bff/v1/auth/login">OIDC로 로그인</a>
      </section>
    );
  return (
    <AccountLifetime
      key={session.data.sessionId}
      session={session.data}
      onSessionChanged={() => {
        void client.cancelQueries({ queryKey: ['identity', 'current-session'] }).then(() => {
          client.setQueryData(['identity', 'current-session'], null);
          void client.invalidateQueries({ queryKey: ['identity', 'current-session'] });
        });
      }}
      onSignedOut={() => {
        void client.cancelQueries({ queryKey: ['identity', 'current-session'] });
        client.setQueryData(['identity', 'current-session'], null);
      }}
    />
  );
}

interface AccountProps {
  session: Session;
  onSignedOut: () => void;
  onSessionChanged: () => void;
}
function AccountLifetime({ session, onSignedOut, onSessionChanged }: AccountProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Account session={session} onSignedOut={onSignedOut} onSessionChanged={onSessionChanged} />
    </QueryClientProvider>
  );
}

function Account({ session, onSignedOut, onSessionChanged }: AccountProps) {
  async function requireSameSession(response: Response) {
    if (response.status === 401) {
      onSignedOut();
      throw new Error('SESSION_EXPIRED');
    }
    if (response.status === 409) {
      const error: unknown = await response.clone().json();
      if (
        z.object({ error: z.object({ code: z.literal('SESSION_CHANGED') }) }).safeParse(error)
          .success
      ) {
        onSessionChanged();
        throw new Error('SESSION_CHANGED');
      }
    }
  }
  const client = useQueryClient();
  const key = ['users', session.athleteId, 'sessions', session.sessionId, 'consent', 'ai'];
  const consent = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const response = await fetch('/bff/v1/consents/ai', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-workout-session-id': session.sessionId },
        signal,
      });
      await requireSameSession(response);
      if (!response.ok) throw new Error('CONSENT_UNAVAILABLE');
      return consentSchema.parse(await response.json());
    },
  });
  const update = useMutation({
    mutationFn: async (input: {
      granted: boolean;
      expectedRevision: number;
      idempotencyKey: string;
    }) => {
      const response = await fetch('/bff/v1/consents/ai', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
          'x-workout-session-id': session.sessionId,
          'idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify({ granted: input.granted, expectedRevision: input.expectedRevision }),
      });
      await requireSameSession(response);
      if (response.status === 409) throw new Error('CONSENT_CONFLICT');
      if (!response.ok) throw new Error('CONSENT_UNAVAILABLE');
      return consentSchema.parse(await response.json());
    },
    onMutate: () => client.cancelQueries({ queryKey: key }),
    onSuccess: async () => {
      // An idempotent response is a historical command receipt, never the current consent head.
      await client.cancelQueries({ queryKey: key });
      await client.invalidateQueries({ queryKey: key }, { throwOnError: true });
    },
  });
  const logout = useMutation({
    mutationFn: async () => {
      const response = await fetch('/bff/v1/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': session.csrfToken, 'x-workout-session-id': session.sessionId },
      });
      if (response.status !== 401) await requireSameSession(response);
      if (!response.ok && response.status !== 401) throw new Error('LOGOUT_FAILED');
    },
    onSuccess: () => {
      client.clear();
      onSignedOut();
    },
  });
  return (
    <section aria-labelledby="account-heading">
      <h2 id="account-heading">계정과 AI 동의</h2>
      <p>로그인된 계정: {session.athleteId}</p>
      <button type="button" disabled={logout.isPending} onClick={() => logout.mutate()}>
        로그아웃
      </button>
      {logout.isError ? <p role="alert">로그아웃을 확인하지 못했습니다. 다시 시도하세요.</p> : null}
      <h3>AI 코치에 정보 전달</h3>
      <p>
        훈련 계획·수행 요약·체크인 정보를 AI 코칭 목적으로 전달하는 동의입니다. 사진·자료 원문·정밀
        위치는 포함하지 않습니다. 현재 외부 AI 전송 기능은 연결되지 않았습니다.
      </p>
      {consent.isPending || consent.isFetching || update.isPending ? (
        <p role="status">동의를 확인하고 있습니다.</p>
      ) : null}
      {consent.isError ? (
        <div role="alert">
          동의를 불러오지 못했습니다.
          <button type="button" onClick={() => void consent.refetch()}>
            동의 다시 확인
          </button>
        </div>
      ) : null}
      {consent.data &&
      !consent.isError &&
      !consent.isFetching &&
      !update.isPending &&
      !update.isError ? (
        <>
          <p>현재 동의: {consent.data.granted ? '허용' : '허용하지 않음'}</p>
          <button
            type="button"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                granted: !consent.data.granted,
                expectedRevision: consent.data.revision,
                idempotencyKey: crypto.randomUUID(),
              })
            }
          >
            {consent.data.granted ? 'AI 동의 철회' : 'AI 전달에 동의'}
          </button>
        </>
      ) : null}
      {update.isError ? (
        <div role="alert">
          <p>
            동의 변경을 확인하지 못했습니다. 다른 변경과 충돌했다면 현재 상태를 다시 확인하세요.
          </p>
          <button
            type="button"
            onClick={() => {
              update.reset();
              void consent.refetch();
            }}
          >
            현재 동의 다시 확인
          </button>
          {update.variables && update.error.message !== 'CONSENT_CONFLICT' ? (
            <button
              type="button"
              onClick={() => {
                if (update.variables) update.mutate(update.variables);
              }}
            >
              같은 변경 재시도
            </button>
          ) : null}
        </div>
      ) : null}
      <GarminPanel
        session={session}
        onSignedOut={onSignedOut}
        onSessionChanged={onSessionChanged}
      />
      <OperationsPanel
        session={session}
        onSignedOut={onSignedOut}
        onSessionChanged={onSessionChanged}
      />
    </section>
  );
}
