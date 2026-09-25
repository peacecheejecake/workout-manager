'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  garminUnofficialLoginResultSchema,
  garminUnofficialRunRequestResultSchema,
  garminUnofficialStatusSchema,
  type GarminUnofficialRun,
  type GarminUnofficialStatus,
} from '@workout/contracts/garmin-unofficial';
import styles from './garmin-unofficial-panel.module.css';

/**
 * The TEMPORARY, UNOFFICIAL Garmin connection (M1-06b-tmp). A separate section from the
 * official `GarminPanel`: its own heading, state words and sync status, so nothing here can
 * read as the official integration. Only the deployment's owner account sees it; every other
 * account (403) and a deployment with the adapter off (404) render nothing at all.
 */
export interface GarminUnofficialPanelProps {
  session: { athleteId: string; sessionId: string; csrfToken: string };
  onSignedOut(): void;
  onSessionChanged(): void;
}

const base = '/bff/v1/integrations/garmin-unofficial';
const sessionChangedSchema = z.object({ error: z.object({ code: z.literal('SESSION_CHANGED') }) });
const errorCodeSchema = z.object({ error: z.object({ code: z.string() }) });

export const garminUnofficialStateLabels: Record<GarminUnofficialStatus['state'], string> = {
  not_connected: '연결되지 않음',
  mfa_required: '인증 코드 입력 대기',
  connected: '연결됨',
  reconnect_required: '다시 연결 필요',
};
const runStateLabels: Record<GarminUnofficialRun['state'], string> = {
  running: '가져오는 중',
  succeeded: '완료',
  partial: '일부 완료',
  rate_limited: 'Garmin 요청 제한으로 중단',
  reconnect_required: '다시 연결 필요로 중단',
  failed_transient: '일시 오류로 중단',
  failed_permanent: '오류로 중단',
  cancelled: '연결 해제로 취소',
};
const triggerLabels: Record<GarminUnofficialRun['trigger'], string> = {
  manual: '직접',
  scheduled: '예약',
};

type Action = 'login' | 'mfa' | 'cancel' | 'disconnect' | 'schedule' | 'run';
/** Fixed text per server error code; server-provided text is never rendered. */
const errorMessages: Record<string, string> = {
  GARMIN_UNOFFICIAL_LOGIN_LOCKED:
    '로그인 시도가 잠시 제한되었습니다. 표시된 시각 이후에 다시 시도하세요.',
  GARMIN_UNOFFICIAL_PROVIDER_RATE_LIMITED:
    'Garmin이 로그인 요청을 제한했습니다. 잠시 후 다시 시도하세요.',
  GARMIN_UNOFFICIAL_LOGIN_REJECTED: 'Garmin 이메일 또는 비밀번호가 맞지 않습니다.',
  GARMIN_UNOFFICIAL_PROFILE_MISMATCH:
    '처음 연결한 Garmin 계정과 다른 계정이라 연결하지 않았습니다. 처음 연결한 Garmin 계정으로 로그인하세요.',
  GARMIN_UNOFFICIAL_ALREADY_CONNECTED: '이미 연결되어 있습니다. 현재 상태를 다시 확인하세요.',
  GARMIN_UNOFFICIAL_LOGIN_BUSY: '다른 로그인 요청을 처리하고 있습니다. 잠시 후 다시 시도하세요.',
  GARMIN_UNOFFICIAL_UNAVAILABLE:
    '비공식 Garmin 연결을 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
  INVALID_REQUEST: '입력한 값의 형식이 올바르지 않습니다. 비밀번호는 8자 이상이어야 합니다.',
  GARMIN_UNOFFICIAL_MFA_REJECTED: '인증 코드가 맞지 않습니다. 다시 입력하세요.',
  GARMIN_UNOFFICIAL_MFA_EXPIRED: '인증 코드 입력 시간이 지났습니다. 처음부터 다시 로그인하세요.',
  GARMIN_UNOFFICIAL_NOT_CONNECTED: '비공식 연결이 없습니다. 먼저 로그인하세요.',
  GARMIN_UNOFFICIAL_RUN_BLOCKED:
    '아직 가져오기를 시작할 수 없습니다. 다음 가져오기 가능 시각 이후에 다시 시도하세요.',
  GARMIN_UNOFFICIAL_RUN_BUSY: '이미 가져오기를 진행하고 있습니다.',
};
const fallbackMessages: Record<Action, string> = {
  login: '비공식 연결 로그인 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.',
  mfa: '인증 코드 확인 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.',
  cancel: '로그인 취소 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.',
  disconnect: '비공식 연결 해제 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.',
  schedule: '예약 가져오기 설정을 바꾸지 못했습니다. 상태를 다시 확인하세요.',
  run: '가져오기를 요청하지 못했습니다. 상태를 다시 확인하세요.',
};
const pendingMessages: Record<Action, string> = {
  login: 'Garmin에 로그인하고 있습니다.',
  mfa: '인증 코드를 확인하고 있습니다.',
  cancel: '로그인을 취소하고 있습니다.',
  disconnect: '비공식 연결을 해제하고 있습니다.',
  schedule: '예약 가져오기 설정을 바꾸고 있습니다.',
  run: '가져오기를 요청하고 있습니다.',
};

type StatusRead =
  { visible: false } | { visible: true; status: GarminUnofficialStatus; receivedAt: number };

function unofficialKey(session: GarminUnofficialPanelProps['session']) {
  return [
    'users',
    session.athleteId,
    'sessions',
    session.sessionId,
    'integrations',
    'garmin-unofficial',
  ];
}
const inFuture = (instant: string | null, now: number) =>
  instant !== null && Date.parse(instant) > now;
const polling = (read: StatusRead | undefined) =>
  read?.visible === true && (read.status.runRequested || read.status.lastRun?.state === 'running');

export function GarminUnofficialPanel(props: GarminUnofficialPanelProps) {
  return (
    <UnofficialLifetime
      key={JSON.stringify([props.session.athleteId, props.session.sessionId])}
      {...props}
    />
  );
}

function UnofficialLifetime({
  session,
  onSignedOut,
  onSessionChanged,
}: GarminUnofficialPanelProps) {
  const headingId = useId();
  const emailId = useId();
  const passwordId = useId();
  const codeId = useId();
  const client = useQueryClient();
  const [key] = useState(() => unofficialKey(session));
  const active = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<{ action: Action; code: string | null } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
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
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      requireActive(signal);
      if (sessionChangedSchema.safeParse(body).success) {
        endSession(true);
        throw new DOMException('Session changed', 'AbortError');
      }
    }
  }
  const status = useQuery<StatusRead>({
    queryKey: key,
    enabled: !sessionUnavailable,
    retry: false,
    refetchInterval: (query) => (polling(query.state.data) ? 2000 : false),
    queryFn: async ({ signal }): Promise<StatusRead> => {
      const response = await fetch(`${base}/status`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-workout-session-id': session.sessionId },
        signal,
      });
      await requireSession(response, signal);
      // Adapter off (404) or not the owner (403): the feature does not exist for this account.
      if (response.status === 404 || response.status === 403) return { visible: false };
      if (!response.ok) throw new Error('GARMIN_UNOFFICIAL_STATUS_UNAVAILABLE');
      const result = garminUnofficialStatusSchema.parse(await response.json());
      requireActive(signal);
      return { visible: true, status: result, receivedAt: Date.now() };
    },
  });

  async function command(
    action: Action,
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: unknown,
    accept: (response: Response) => Promise<void>,
  ): Promise<boolean> {
    if (!active.current || requests.current.size) return false;
    const controller = new AbortController();
    requests.current.add(controller);
    setPending(action);
    setActionError(null);
    let succeeded = false;
    try {
      const headers: Record<string, string> = {
        'x-csrf-token': session.csrfToken,
        'x-workout-session-id': session.sessionId,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${base}${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      await requireSession(response, controller.signal);
      if (!response.ok) {
        const parsed = errorCodeSchema.safeParse(await response.json().catch(() => null));
        requireActive(controller.signal);
        const code =
          parsed.success && parsed.data.error.code in errorMessages ? parsed.data.error.code : null;
        setActionError({ action, code });
      } else {
        await accept(response);
        requireActive(controller.signal);
        succeeded = true;
      }
    } catch {
      if (active.current && !controller.signal.aborted) setActionError({ action, code: null });
    } finally {
      requests.current.delete(controller);
    }
    if (!active.current || controller.signal.aborted) return succeeded;
    // The command reply is not display state: read the authoritative status either way.
    await client.cancelQueries({ queryKey: key, exact: true });
    await client.refetchQueries({ queryKey: key, exact: true });
    if (active.current) setPending(null);
    return succeeded;
  }
  const noContent = async () => undefined;

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = form.get('email');
    const password = form.get('password');
    if (typeof email !== 'string' || typeof password !== 'string') return;
    try {
      await command('login', '/login', 'POST', { email, password }, async (response) => {
        garminUnofficialLoginResultSchema.parse(await response.json());
      });
    } finally {
      // The password lives only in the DOM input and this call; drop it either way.
      if (passwordInput.current) passwordInput.current.value = '';
    }
  }
  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code');
    if (typeof code !== 'string') return;
    try {
      await command('mfa', '/login/mfa', 'POST', { code: code.trim() }, async (response) => {
        garminUnofficialLoginResultSchema.parse(await response.json());
      });
    } finally {
      if (codeInput.current) codeInput.current.value = '';
    }
  }
  async function refresh() {
    setActionError(null);
    setRefreshing(true);
    await status.refetch();
    if (active.current) setRefreshing(false);
  }

  const read = status.data;
  if (!read?.visible) return null;
  const current = read.status;
  const busy = pending !== null || sessionUnavailable;
  const running = current.runRequested || current.lastRun?.state === 'running';
  const blocked = inFuture(current.blockedUntil, read.receivedAt);
  const loginLocked = inFuture(current.loginLockedUntil, read.receivedAt);
  const linked = current.state === 'connected' || current.state === 'reconnect_required';
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId}>비공식 임시 Garmin 연결</h2>
      <div role="note" className={styles.warning}>
        <p>
          <strong>공식 Garmin 연동이 아닌 비공식 임시 연결입니다.</strong> Garmin 공식 연동이
          준비되기 전까지만 쓰는 임시 경로이며, 공식 연동이 준비되면 없어집니다.
        </p>
        <ul>
          <li>Garmin 이용약관에 어긋날 수 있습니다.</li>
          <li>Garmin이 요청을 제한하거나 계정에 조치를 취할 수 있습니다.</li>
          <li>Garmin이 내부 endpoint를 바꾸면 예고 없이 동작하지 않을 수 있습니다.</li>
          <li>
            로그인할 때 Garmin 비밀번호가 앱 서버를 한 번 거쳐 Garmin으로 전달되며, 앱은 비밀번호를
            저장하지 않습니다.
          </li>
          <li>앱에 저장되는 Garmin 세션은 Garmin 계정 전체 권한을 가집니다.</li>
          <li>
            이 배포의 소유자 계정만 사용할 수 있고, 처음 연결한 Garmin 계정 하나에만 묶입니다.
          </li>
        </ul>
      </div>
      {sessionUnavailable ? (
        <p role="status">로그인 상태가 변경되어 연결 정보를 다시 확인합니다.</p>
      ) : (
        <>
          {refreshing ? <p role="status">비공식 연결 상태를 확인하고 있습니다.</p> : null}
          {pending ? <p role="status">{pendingMessages[pending]}</p> : null}
          {status.isError ? (
            <p role="alert">
              비공식 연결 상태를 확인하지 못했습니다. 아래 정보는 이전 확인 결과입니다.
            </p>
          ) : null}
          {actionError ? (
            <p role="alert">
              {actionError.code
                ? errorMessages[actionError.code]
                : fallbackMessages[actionError.action]}
            </p>
          ) : null}
          <button type="button" disabled={busy || status.isFetching} onClick={() => void refresh()}>
            비공식 연결 상태 다시 확인
          </button>
          <p className={styles.state}>
            비공식 연결 상태: {garminUnofficialStateLabels[current.state]}
          </p>
          {current.state === 'not_connected' || current.state === 'reconnect_required' ? (
            <form className={styles.form} onSubmit={(event) => void login(event)}>
              {current.state === 'reconnect_required' ? (
                <p>저장된 Garmin 세션을 더 쓸 수 없습니다. 다시 로그인하세요.</p>
              ) : null}
              {current.profilePinned ? (
                <p>처음 연결한 Garmin 계정으로만 다시 연결할 수 있습니다.</p>
              ) : null}
              {loginLocked && current.loginLockedUntil ? (
                <p>
                  로그인 시도가 잠시 제한되었습니다:{' '}
                  <time dateTime={current.loginLockedUntil}>{current.loginLockedUntil}</time>
                </p>
              ) : null}
              <label htmlFor={emailId}>Garmin 이메일</label>
              <input
                id={emailId}
                name="email"
                type="email"
                autoComplete="username"
                required
                disabled={busy}
                spellCheck={false}
              />
              <label htmlFor={passwordId}>Garmin 비밀번호</label>
              <input
                id={passwordId}
                ref={passwordInput}
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                disabled={busy}
              />
              <button type="submit" disabled={busy || loginLocked}>
                비공식 연결 로그인
              </button>
            </form>
          ) : null}
          {current.state === 'mfa_required' ? (
            <form className={styles.form} onSubmit={(event) => void confirmCode(event)}>
              <p>
                Garmin이 보낸 인증 코드를 입력하세요. 입력 가능 시각:{' '}
                {current.mfaExpiresAt ? (
                  <time dateTime={current.mfaExpiresAt}>{current.mfaExpiresAt}</time>
                ) : (
                  '미확인'
                )}
                까지
              </p>
              <label htmlFor={codeId}>Garmin 인증 코드</label>
              <input
                id={codeId}
                ref={codeInput}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{4,10}"
                required
                disabled={busy}
              />
              <div className={styles.actions}>
                <button type="submit" disabled={busy}>
                  인증 코드 확인
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void command('cancel', '/login', 'DELETE', undefined, noContent)}
                >
                  로그인 취소
                </button>
              </div>
            </form>
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
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={busy || running || blocked}
                  onClick={() =>
                    void command('run', '/runs', 'POST', undefined, async (response) => {
                      garminUnofficialRunRequestResultSchema.parse(await response.json());
                    })
                  }
                >
                  지금 가져오기
                </button>
              </div>
              {blocked && current.blockedUntil ? (
                <p>
                  다음 가져오기 가능 시각:{' '}
                  <time dateTime={current.blockedUntil}>{current.blockedUntil}</time>
                </p>
              ) : null}
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={current.schedule.enabled}
                  disabled={busy}
                  onChange={(event) =>
                    void command(
                      'schedule',
                      '/schedule',
                      'PUT',
                      { enabled: event.currentTarget.checked },
                      noContent,
                    )
                  }
                />
                <span>예약 가져오기 ({current.schedule.intervalHours}시간마다)</span>
              </label>
              {current.schedule.paused ? (
                <p>
                  Garmin 요청 제한 또는 오류로 예약 가져오기가 일시 중지되었습니다. 다시 켜면
                  재개됩니다.
                </p>
              ) : null}
              {current.schedule.enabled &&
              !current.schedule.paused &&
              current.schedule.nextRunAt ? (
                <p>
                  다음 예약 가져오기:{' '}
                  <time dateTime={current.schedule.nextRunAt}>{current.schedule.nextRunAt}</time>
                </p>
              ) : null}
            </>
          ) : null}
          {linked ? (
            <div className={styles.disconnect}>
              <p>
                연결 해제는 앱에 저장된 Garmin 세션만 삭제합니다. 비공식 경로에는 Garmin 쪽 세션을
                끊는 방법이 없어 Garmin 세션이 계속 유효할 수 있습니다. Garmin 쪽 세션을 끝내려면
                Garmin 계정 비밀번호를 변경하고 Garmin 계정 설정에서 로그인된 세션·기기를
                로그아웃하세요.
              </p>
              <p>이미 가져온 활동은 삭제되지 않고 비공식 수집 표시와 함께 앱에 남습니다.</p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void command('disconnect', '/connection', 'DELETE', undefined, noContent)
                }
              >
                비공식 연결 해제
              </button>
            </div>
          ) : null}
          <UnofficialRunStatus status={current} />
        </>
      )}
    </section>
  );
}

function UnofficialRunStatus({ status }: { status: GarminUnofficialStatus }) {
  const run = status.lastRun;
  return (
    <>
      <h3>비공식 가져오기 상태</h3>
      <p>비공식 경로의 가져오기 상태이며 Garmin 공식 동기화 상태가 아닙니다.</p>
      {status.runRequested && run?.state !== 'running' ? (
        <p>가져오기 요청을 받았습니다. 곧 시작합니다.</p>
      ) : null}
      {run ? (
        <dl className={styles.run}>
          <dt>상태</dt>
          <dd>
            {runStateLabels[run.state]} · {triggerLabels[run.trigger]}
          </dd>
          <dt>시작</dt>
          <dd>
            <time dateTime={run.startedAt}>{run.startedAt}</time>
          </dd>
          <dt>종료</dt>
          <dd>
            {run.finishedAt ? <time dateTime={run.finishedAt}>{run.finishedAt}</time> : '진행 중'}
          </dd>
          <dt>건수</dt>
          <dd>
            목록 {run.listed} · 새로 가져옴 {run.imported} · 변경 없음 {run.unchanged} · 삭제 억제{' '}
            {run.suppressed} · 이미 처리됨 {run.skipped} · 실패 {run.failed}
          </dd>
          {run.complete === false ? (
            <>
              <dt>범위</dt>
              <dd>이번 실행은 가져올 기간의 목록을 끝까지 확인하지 못했습니다.</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p>아직 가져온 적이 없습니다.</p>
      )}
    </>
  );
}

/**
 * The account-erasure warning for the unofficial connection (gate condition 2(f)). Shown only
 * when the status endpoint answers 200 for this account; non-owners and deployments with the
 * adapter off see nothing.
 */
export function GarminUnofficialEraseNotice({
  session,
}: {
  session: GarminUnofficialPanelProps['session'];
}) {
  const notice = useQuery({
    queryKey: [...unofficialKey(session), 'erase-notice'],
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`${base}/status`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-workout-session-id': session.sessionId },
        signal,
      });
      if (response.status !== 200) return false;
      return garminUnofficialStatusSchema.safeParse(await response.json()).success;
    },
  });
  if (notice.data !== true) return null;
  return (
    <p role="note" className={styles.warning}>
      비공식 임시 Garmin 연결: 계정을 삭제하면 앱에 저장된 Garmin 세션도 삭제되지만 Garmin 쪽 세션은
      끊기지 않습니다. Garmin 계정 비밀번호를 변경하고 Garmin 계정 설정에서 로그인 세션을
      로그아웃하세요.
    </p>
  );
}
