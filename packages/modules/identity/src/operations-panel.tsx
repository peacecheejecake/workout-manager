'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  accountExportSchema,
  operationsStatusSchema,
  eraseAccountResultSchema,
} from '@workout/contracts/operations';
import styles from './operations-panel.module.css';

export interface OperationsPanelProps {
  session: { athleteId: string; sessionId: string; csrfToken: string };
  onSignedOut(): void;
  onSessionChanged(): void;
}
const sessionChangedSchema = z.object({ error: z.object({ code: z.literal('SESSION_CHANGED') }) });
type RequestState = 'idle' | 'pending' | 'error';

/** Reset private controls and Blob ownership before a replacement account/session renders. */
export function OperationsPanel(props: OperationsPanelProps) {
  return (
    <OperationsLifetime
      key={JSON.stringify([props.session.athleteId, props.session.sessionId])}
      {...props}
    />
  );
}

function OperationsLifetime({ session, onSignedOut, onSessionChanged }: OperationsPanelProps) {
  const headingId = useId();
  const confirmationId = useId();
  const client = useQueryClient();
  const active = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const urls = useRef(new Set<string>());
  const [exportState, setExportState] = useState<RequestState>('idle');
  const [deleteState, setDeleteState] = useState<RequestState>('idle');
  const [download, setDownload] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const key = ['users', session.athleteId, 'sessions', session.sessionId, 'operations'];
  useEffect(() => {
    active.current = true;
    const pending = requests.current;
    const ownedUrls = urls.current;
    return () => {
      active.current = false;
      for (const request of pending) request.abort();
      pending.clear();
      for (const url of ownedUrls) URL.revokeObjectURL(url);
      ownedUrls.clear();
    };
  }, []);

  function releaseDownload() {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    setDownload(null);
  }
  function endSession(changed: boolean) {
    if (!active.current) return;
    active.current = false;
    for (const request of requests.current) request.abort();
    requests.current.clear();
    releaseDownload();
    setConfirmation('');
    setSessionUnavailable(true);
    client.clear();
    if (changed) onSessionChanged();
    else onSignedOut();
  }
  function requireActive(signal: AbortSignal) {
    if (!active.current || signal.aborted)
      throw new DOMException('Request no longer belongs to active session', 'AbortError');
  }
  async function requireSession(response: Response, signal: AbortSignal) {
    requireActive(signal);
    if (response.status === 401) {
      endSession(false);
      throw new DOMException('Session expired', 'AbortError');
    }
    if (response.status === 409) {
      const error: unknown = await response.clone().json();
      requireActive(signal);
      if (sessionChangedSchema.safeParse(error).success) {
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
      const response = await fetch('/bff/v1/operations/status', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-workout-session-id': session.sessionId },
        signal,
      });
      await requireSession(response, signal);
      if (!response.ok) throw new Error('OPERATIONS_STATUS_UNAVAILABLE');
      const data = operationsStatusSchema.parse(await response.json());
      requireActive(signal);
      return data;
    },
  });

  async function prepareExport() {
    if (
      !active.current ||
      requests.current.size > 0 ||
      exportState === 'pending' ||
      deleteState === 'pending'
    )
      return;
    const controller = new AbortController();
    requests.current.add(controller);
    releaseDownload();
    setExportState('pending');
    try {
      const response = await fetch('/bff/v1/operations/export', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-csrf-token': session.csrfToken, 'x-workout-session-id': session.sessionId },
        signal: controller.signal,
      });
      await requireSession(response, controller.signal);
      if (!response.ok) throw new Error('EXPORT_UNAVAILABLE');
      const data = accountExportSchema.parse(await response.json());
      requireActive(controller.signal);
      if (data.athleteId !== session.athleteId) throw new Error('EXPORT_SCOPE_MISMATCH');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      urls.current.add(url);
      setDownload(url);
      setExportState('idle');
      void client.invalidateQueries({ queryKey: key });
    } catch {
      if (active.current && !controller.signal.aborted) setExportState('error');
    } finally {
      requests.current.delete(controller);
    }
  }
  async function deleteAccount() {
    if (
      !active.current ||
      requests.current.size > 0 ||
      confirmation !== 'DELETE MY ACCOUNT' ||
      deleteState === 'pending' ||
      exportState === 'pending'
    )
      return;
    const controller = new AbortController();
    requests.current.add(controller);
    setDeleteState('pending');
    setConfirmation('');
    try {
      const response = await fetch('/bff/v1/operations/account', {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
          'x-workout-session-id': session.sessionId,
        },
        body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
        signal: controller.signal,
      });
      await requireSession(response, controller.signal);
      if (!response.ok) throw new Error('ERASURE_UNAVAILABLE');
      eraseAccountResultSchema.parse(await response.json());
      requireActive(controller.signal);
      endSession(false);
    } catch {
      if (active.current && !controller.signal.aborted) setDeleteState('error');
    } finally {
      requests.current.delete(controller);
    }
  }
  const busy = exportState === 'pending' || deleteState === 'pending' || sessionUnavailable;
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId}>운영 상태와 내 데이터</h2>
      {sessionUnavailable ? (
        <p role="status">로그인 상태가 변경되었습니다. 계정 정보를 다시 확인하고 있습니다.</p>
      ) : (
        <>
          <h3>연결과 처리 상태</h3>
          {status.isPending || status.isFetching ? (
            <p role="status">처리 상태를 확인하고 있습니다.</p>
          ) : null}
          {status.isError ? (
            <div role="alert">
              <p>처리 상태를 확인하지 못했습니다.</p>
              <button type="button" onClick={() => void status.refetch()}>
                처리 상태 다시 확인
              </button>
            </div>
          ) : null}
          {status.data && !status.isError && !status.isFetching ? (
            <div>
              <p>Garmin: 연결되지 않음 · HealthKit: 연결되지 않음</p>
              <p>
                앱 내부 처리: 대기 {status.data.outbox.pending}건 · 처리 중{' '}
                {status.data.outbox.leased}건 · 재시도 {status.data.outbox.retrying}건 · 완료{' '}
                {status.data.outbox.completed}건
              </p>
              <p>내부 작업 수는 건강 데이터 동기화 건수나 운동 수행 결과를 의미하지 않습니다.</p>
              <p>
                확인 시각: <time dateTime={status.data.checkedAt}>{status.data.checkedAt}</time>
              </p>
              <h4>최근 내 데이터 작업 (최대 10개)</h4>
              {status.data.audit.length === 0 ? (
                <p>작업 이력이 없습니다.</p>
              ) : (
                <ul>
                  {status.data.audit.map((item) => (
                    <li key={item.id}>
                      {item.action === 'export_requested' ? '내보내기 요청' : '계정 삭제'} ·{' '}
                      <time dateTime={item.createdAt}>{item.createdAt}</time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          <h3>내 데이터 내보내기</h3>
          <p>
            명시적으로 요청하면 현재 계정의 데이터를 JSON 파일로 준비합니다. 로그인 정보는 포함하지
            않습니다.
          </p>
          <button type="button" disabled={busy} onClick={() => void prepareExport()}>
            {exportState === 'error' ? '내 데이터 내보내기 다시 시도' : '내 데이터 내보내기 준비'}
          </button>
          {exportState === 'pending' ? (
            <p role="status">내보낼 데이터를 준비하고 있습니다.</p>
          ) : null}
          {exportState === 'error' ? (
            <p role="alert">내보내기를 준비하지 못했습니다. 다시 요청해 주세요.</p>
          ) : null}
          {download ? (
            <p>
              <a href={download} download="workout-manager-export.json">
                내 데이터 JSON 다운로드
              </a>
            </p>
          ) : null}
          <h3>앱 계정과 데이터 삭제</h3>
          <p>
            이 앱의 계획·활동·원본 데이터·수정 기록·동의·이력·로그인 세션을 삭제합니다. Garmin 등
            외부 제공자 계정은 삭제하지 않습니다.
          </p>
          <p>
            오래된 작업이 삭제한 계정을 되살리지 못하도록, 이전 계정을 구분하는 불투명한 식별자와
            삭제 시각만 별도로 남깁니다.
          </p>
          <p>
            백업 사본은 별도로 보관됩니다. 보관 기간이 만료되거나 삭제 정보를 반영한 안전한 복구
            절차가 적용될 때까지 남을 수 있습니다.
          </p>
          <label htmlFor={confirmationId}>삭제 확인 문구</label>
          <input
            id={confirmationId}
            value={confirmation}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setConfirmation(event.target.value)}
            aria-describedby={`${confirmationId}-help`}
          />
          <p id={`${confirmationId}-help`}>
            삭제하려면 DELETE MY ACCOUNT를 정확하게 입력한 뒤 아래 버튼을 누르세요.
          </p>
          <button
            type="button"
            className={styles.danger}
            disabled={busy || confirmation !== 'DELETE MY ACCOUNT'}
            onClick={() => void deleteAccount()}
          >
            확인하고 앱 계정 삭제
          </button>
          {deleteState === 'pending' ? <p role="status">앱 계정을 삭제하고 있습니다.</p> : null}
          {deleteState === 'error' ? (
            <p role="alert">
              삭제 결과를 확인하지 못했습니다. 다시 시도하려면 확인 문구를 새로 입력해 주세요.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
