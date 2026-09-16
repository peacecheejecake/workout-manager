'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  garminConnectResultSchema,
  garminStatusSchema,
  type GarminStatus,
} from '@workout/contracts/garmin';
import styles from './garmin-panel.module.css';

export interface GarminPanelProps {
  session: { athleteId: string; sessionId: string; csrfToken: string };
  onSignedOut(): void;
  onSessionChanged(): void;
  navigateToAuthorization?(url: string): void;
}
const sessionChangedSchema = z.object({ error: z.object({ code: z.literal('SESSION_CHANGED') }) });
export const garminStateLabels: Record<GarminStatus['state'], string> = {
  not_connected: '연결되지 않음',
  connecting: '승인 진행 중',
  connected: '연결됨',
  reconnect_required: '다시 연결 필요',
  disconnecting: '연결 해제 중',
};

/** Allow only the official authorization page, with a narrowly scoped local E2E provider. */
export function validateGarminAuthorizationUrl(value: string, currentOrigin: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('INVALID_GARMIN_AUTHORIZATION_URL');
  const official = url.origin === 'https://connect.garmin.com' && url.pathname === '/oauth2Confirm';
  const fixture =
    currentOrigin === 'http://127.0.0.1:3100' &&
    url.origin === 'http://127.0.0.1:4500' &&
    url.pathname === '/authorize';
  if (!official && !fixture) throw new Error('INVALID_GARMIN_AUTHORIZATION_URL');
  return url.href;
}
const navigate = (url: string) => window.location.assign(url);

export function GarminPanel(props: GarminPanelProps) {
  return (
    <GarminLifetime
      key={JSON.stringify([props.session.athleteId, props.session.sessionId])}
      {...props}
    />
  );
}
function GarminLifetime({
  session,
  onSignedOut,
  onSessionChanged,
  navigateToAuthorization = navigate,
}: GarminPanelProps) {
  const headingId = useId();
  const client = useQueryClient();
  const [key] = useState(() => [
    'users',
    session.athleteId,
    'sessions',
    session.sessionId,
    'integrations',
    'garmin',
  ]);
  const active = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const [pending, setPending] = useState<'connect' | 'disconnect' | null>(null);
  const [actionError, setActionError] = useState<'connect' | 'disconnect' | null>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  useEffect(() => {
    active.current = true;
    const ownedRequests = requests.current;
    return () => {
      active.current = false;
      for (const request of ownedRequests) request.abort();
      ownedRequests.clear();
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
  }, [client, key]);
  function requireActive(signal: AbortSignal) {
    if (!active.current || signal.aborted)
      throw new DOMException('Inactive Garmin request', 'AbortError');
  }
  function endSession(changed: boolean) {
    if (!active.current) return;
    active.current = false;
    for (const controller of requests.current) controller.abort();
    requests.current.clear();
    setSessionUnavailable(true);
    client.clear();
    if (changed) onSessionChanged();
    else onSignedOut();
  }
  async function requireSession(response: Response, signal: AbortSignal) {
    requireActive(signal);
    if (response.status === 401) {
      endSession(false);
      throw new DOMException('Session expired', 'AbortError');
    }
    if (response.status === 409) {
      const body: unknown = await response.clone().json();
      requireActive(signal);
      if (sessionChangedSchema.safeParse(body).success) {
        endSession(true);
        throw new DOMException('Session changed', 'AbortError');
      }
    }
  }
  const status = useQuery({
    queryKey: key,
    enabled: !sessionUnavailable,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch('/bff/v1/integrations/garmin/status', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-workout-session-id': session.sessionId },
        signal,
      });
      await requireSession(response, signal);
      if (!response.ok) throw new Error('GARMIN_STATUS_UNAVAILABLE');
      const result = garminStatusSchema.parse(await response.json());
      requireActive(signal);
      return result;
    },
  });
  const current =
    status.isSuccess && !status.isFetching && !pending && !actionError ? status.data : undefined;
  async function refreshStatus() {
    setActionError(null);
    const result = await status.refetch();
    if (result.isSuccess && active.current) {
      await client.invalidateQueries({
        queryKey: ['users', session.athleteId, 'sessions', session.sessionId, 'operations'],
      });
    }
  }
  async function connect() {
    if (
      !active.current ||
      requests.current.size ||
      !current?.configured ||
      current.state === 'connected' ||
      current.state === 'reconnect_required' ||
      current.state === 'disconnecting'
    )
      return;
    const controller = new AbortController();
    requests.current.add(controller);
    setPending('connect');
    setActionError(null);
    try {
      const response = await fetch('/bff/v1/integrations/garmin/connect', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-csrf-token': session.csrfToken, 'x-workout-session-id': session.sessionId },
        signal: controller.signal,
      });
      await requireSession(response, controller.signal);
      if (!response.ok) throw new Error('GARMIN_CONNECT_UNAVAILABLE');
      const result = garminConnectResultSchema.parse(await response.json());
      requireActive(controller.signal);
      const authorizationUrl = validateGarminAuthorizationUrl(
        result.authorizationUrl,
        window.location.origin,
      );
      requireActive(controller.signal);
      navigateToAuthorization(authorizationUrl);
    } catch {
      if (active.current && !controller.signal.aborted) {
        setActionError('connect');
        setPending(null);
      }
    } finally {
      requests.current.delete(controller);
    }
  }
  async function disconnect() {
    if (
      !active.current ||
      requests.current.size ||
      !current ||
      current.state === 'not_connected' ||
      current.state === 'disconnecting'
    )
      return;
    const controller = new AbortController();
    requests.current.add(controller);
    setPending('disconnect');
    setActionError(null);
    try {
      const response = await fetch('/bff/v1/integrations/garmin/connection', {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-csrf-token': session.csrfToken, 'x-workout-session-id': session.sessionId },
        signal: controller.signal,
      });
      await requireSession(response, controller.signal);
      if (!response.ok) throw new Error('GARMIN_DISCONNECT_UNAVAILABLE');
      garminStatusSchema.parse(await response.json());
      requireActive(controller.signal);
      await client.cancelQueries({ queryKey: key, exact: true });
      // Read the actual connection head; the command response is not authoritative display state.
      await client.resetQueries({ queryKey: key, exact: true }, { throwOnError: true });
      requireActive(controller.signal);
      void client.invalidateQueries({
        queryKey: ['users', session.athleteId, 'sessions', session.sessionId, 'operations'],
      });
      setPending(null);
    } catch {
      if (active.current && !controller.signal.aborted) {
        setActionError('disconnect');
        setPending(null);
      }
    } finally {
      requests.current.delete(controller);
    }
  }
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId}>Garmin 연결 설정</h2>
      <p>
        앱 로그인과 별도로 Garmin 공식 승인 화면에서 데이터 연결을 허용합니다. 앱에 Garmin
        비밀번호를 입력하지 않습니다.
      </p>
      <p>
        연결 승인은 활동 가져오기나 동기화 완료를 의미하지 않습니다. 현재 화면은 연결 상태와 승인
        범위만 표시합니다.
      </p>
      {sessionUnavailable ? (
        <p role="status">로그인 상태가 변경되어 연결 정보를 다시 확인합니다.</p>
      ) : (
        <>
          {status.isPending || status.isFetching ? (
            <p role="status">Garmin 연결 상태를 확인하고 있습니다.</p>
          ) : null}
          {pending ? (
            <p role="status">
              {pending === 'connect'
                ? 'Garmin 공식 승인 화면으로 이동하고 있습니다.'
                : 'Garmin 연결 해제를 확인하고 있습니다.'}
            </p>
          ) : null}
          {status.isError ? <p role="alert">Garmin 연결 상태를 확인하지 못했습니다.</p> : null}
          {actionError ? (
            <p role="alert">
              {actionError === 'connect'
                ? 'Garmin 연결을 시작하지 못했습니다. 상태를 확인하고 다시 시도하세요.'
                : 'Garmin 연결 해제 결과를 확인하지 못했습니다. 현재 상태를 다시 확인하세요.'}
            </p>
          ) : null}
          <button
            type="button"
            disabled={pending !== null || status.isFetching}
            onClick={() => void refreshStatus()}
          >
            Garmin 상태 다시 확인
          </button>
          {current ? (
            <>
              <p>Garmin 연결 상태: {garminStateLabels[current.state]}</p>
              {current.state === 'disconnecting' ? (
                <p>
                  앱은 Garmin에서 새 데이터를 가져오는 작업을 중단했습니다. Garmin 쪽 연결 해제는
                  처리 대기 중이며, Garmin 응답이 지연되거나 실패하면 완료까지 시간이 걸릴 수
                  있습니다. 상태를 다시 확인해 주세요.
                </p>
              ) : null}
              {!current.configured ? (
                <p>
                  Garmin 공식 연동 설정이 아직 준비되지 않았습니다. 운영자 설정이 완료된 뒤 연결할
                  수 있습니다.
                </p>
              ) : null}
              {current.state === 'connected' ? (
                <>
                  <p>
                    연결 시각:{' '}
                    {current.connectedAt ? (
                      <time dateTime={current.connectedAt}>{current.connectedAt}</time>
                    ) : (
                      '미확인'
                    )}
                  </p>
                  <h3>승인된 범위</h3>
                  {current.permissions.length ? (
                    <ul>
                      {current.permissions.map((permission) => (
                        <li key={permission}>{permission}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>승인 범위가 확인되지 않았습니다.</p>
                  )}
                </>
              ) : null}
              {current.state === 'reconnect_required' ? (
                <p>기존 연결을 해제한 뒤 다시 연결하세요.</p>
              ) : null}
              {current.state !== 'connected' && current.state !== 'reconnect_required' ? (
                <button
                  type="button"
                  disabled={!current.configured || current.state === 'disconnecting'}
                  onClick={() => void connect()}
                >
                  {current.state === 'not_connected'
                    ? 'Garmin 공식 계정 연결'
                    : 'Garmin 연결 다시 시작'}
                </button>
              ) : null}
              {current.state !== 'not_connected' ? (
                <>
                  <p>
                    연결 해제는 앱과 Garmin의 연결만 해제합니다. Garmin 계정과 앱에 이미 저장된
                    활동은 삭제하지 않습니다.
                  </p>
                  <button
                    type="button"
                    disabled={current.state === 'disconnecting'}
                    onClick={() => void disconnect()}
                  >
                    Garmin 연결 해제
                  </button>
                </>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
