import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createCapacitorBridgePort } from '@workout/platform/capacitor-bridge-port';
import { createNativeBridgeClient } from '@workout/platform/native-bridge-client';
import { createNativeAuthenticatedTransport } from '@workout/platform/native-authenticated-transport';
import {
  bindPrivateBrowserStorageAccount,
  clearPrivateBrowserStorage,
} from '@workout/platform/private-browser-storage';
import { nativeBridgeAiConsentSchema } from '@workout/contracts/native-bridge';
import type { NativeBridgeErrorCode, NativeBridgeSession } from '@workout/contracts/native-bridge';

const bridge = createNativeBridgeClient({
  port: createCapacitorBridgePort(),
  createId: () => crypto.randomUUID().replaceAll('-', ''),
});

type BridgeState =
  | { kind: 'connecting' }
  | { kind: 'ready'; settingsAvailable: boolean; authAvailable: boolean }
  | { kind: 'unavailable'; code: NativeBridgeErrorCode };

type AuthState =
  | { state: 'unavailable' | 'checking' }
  | { state: 'error'; code: NativeBridgeErrorCode }
  | NativeBridgeSession;

type ConsentState =
  | { state: 'unavailable' }
  | { state: 'loading'; athleteId: string }
  | { state: 'ready'; athleteId: string; granted: boolean; revision: number }
  | { state: 'error'; athleteId: string; code: 'UNAVAILABLE' | 'INVALID_REPLY' };

type NativeScreen = 'account' | 'note';
const nativeScreenHistoryKey = 'workoutNativeScreen';
const nativeScopeHistoryKey = 'workoutNativeScope';

export function NativeLanding({ client = bridge }: { client?: typeof bridge }) {
  const [bridgeState, setBridgeState] = useState<BridgeState>({ kind: 'connecting' });
  const [authState, setAuthState] = useState<AuthState>({ state: 'checking' });
  const [authPending, setAuthPending] = useState<'signIn' | 'signOut' | null>(null);
  const [authError, setAuthError] = useState<NativeBridgeErrorCode | null>(null);
  const [settingsResult, setSettingsResult] = useState<string | null>(null);
  const [consentState, setConsentState] = useState<ConsentState>({ state: 'unavailable' });
  const [consentRefresh, setConsentRefresh] = useState(0);
  const [screen, setScreen] = useState<NativeScreen>('account');
  const [note, setNote] = useState('');
  const [confirmBack, setConfirmBack] = useState(false);
  const [sessionCheck, setSessionCheck] = useState<'idle' | 'checking' | 'error'>('idle');
  const activeConsent = useRef<AbortController | null>(null);
  const activeSession = useRef<AbortController | null>(null);
  const sessionGeneration = useRef(0);
  const accountId = useRef<string | null>(null);
  const noteInput = useRef<HTMLTextAreaElement | null>(null);
  const continueButton = useRef<HTMLButtonElement | null>(null);
  const navigateButton = useRef<HTMLButtonElement | null>(null);
  const composing = useRef(false);
  const screenRef = useRef<NativeScreen>('account');
  const noteRef = useRef('');
  const confirmRef = useRef(false);
  const historyScope = useRef(crypto.randomUUID());

  function noteHistoryState() {
    return {
      [nativeScreenHistoryKey]: 'note',
      [nativeScopeHistoryKey]: historyScope.current,
    };
  }

  const updateScreen = useCallback((next: NativeScreen) => {
    screenRef.current = next;
    setScreen(next);
  }, []);

  const updateNote = useCallback((next: string) => {
    noteRef.current = next;
    setNote(next);
  }, []);

  const clearIdentity = useCallback(() => {
    activeConsent.current?.abort();
    clearPrivateBrowserStorage();
    accountId.current = null;
    historyScope.current = crypto.randomUUID();
    const previousState = history.state;
    history.replaceState(
      {
        ...(typeof previousState === 'object' && previousState !== null ? previousState : {}),
        [nativeScreenHistoryKey]: 'account',
        [nativeScopeHistoryKey]: historyScope.current,
      },
      '',
    );
    updateNote('');
    updateScreen('account');
    confirmRef.current = false;
    setConfirmBack(false);
    setConsentState({ state: 'unavailable' });
  }, [updateNote, updateScreen]);

  const acceptSession = useCallback(
    (session: NativeBridgeSession) => {
      if (session.state === 'signed_out') {
        clearIdentity();
      } else if (accountId.current !== null && accountId.current !== session.athleteId) {
        clearIdentity();
      }
      if (session.state === 'signed_in') {
        accountId.current = session.athleteId;
        bindPrivateBrowserStorageAccount(session.athleteId);
      }
      setSessionCheck('idle');
      setAuthState(session);
    },
    [clearIdentity],
  );

  function navigateBack() {
    confirmRef.current = false;
    setConfirmBack(false);
    updateNote('');
    updateScreen('account');
    if (
      history.state?.[nativeScreenHistoryKey] === 'note' &&
      history.state?.[nativeScopeHistoryKey] === historyScope.current
    )
      history.back();
  }

  function requestBack() {
    if (screenRef.current !== 'note' || confirmRef.current || composing.current) return;
    if (noteRef.current.length > 0) {
      noteInput.current?.blur();
      confirmRef.current = true;
      setConfirmBack(true);
      return;
    }
    navigateBack();
  }

  function onConfirmationKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      confirmRef.current = false;
      setConfirmBack(false);
      requestAnimationFrame(() => noteInput.current?.focus());
      return;
    }
    if (event.key !== 'Tab') return;
    if (event.shiftKey && event.currentTarget === continueButton.current) {
      event.preventDefault();
      navigateButton.current?.focus();
    } else if (!event.shiftKey && event.currentTarget === navigateButton.current) {
      event.preventDefault();
      continueButton.current?.focus();
    }
  }

  const refreshSession = useCallback(
    async ({ foreground = false }: { foreground?: boolean } = {}) => {
      if (activeSession.current) return;
      const controller = new AbortController();
      activeSession.current = controller;
      const generation = ++sessionGeneration.current;
      setSessionCheck('checking');
      if (!foreground && accountId.current === null) setAuthState({ state: 'checking' });
      try {
        const result = await client.session(controller.signal);
        if (controller.signal.aborted || generation !== sessionGeneration.current) return;
        if (result.ok) {
          acceptSession(result.value);
          setSessionCheck('idle');
        } else {
          // An uncertain network result does not revoke a known session or discard an unsaved draft.
          if (!foreground && accountId.current === null)
            setAuthState({ state: 'error', code: result.code });
          setSessionCheck('error');
        }
      } finally {
        if (activeSession.current === controller) activeSession.current = null;
      }
    },
    [acceptSession, client],
  );

  const cancelSessionCheck = useCallback(() => {
    sessionGeneration.current += 1;
    activeSession.current?.abort();
    activeSession.current = null;
    setSessionCheck('idle');
  }, []);

  const athleteId = authState.state === 'signed_in' ? authState.athleteId : null;
  const visibleConsentState =
    athleteId !== null && 'athleteId' in consentState && consentState.athleteId === athleteId
      ? consentState
      : ({ state: 'loading' } as const);

  useEffect(() => {
    if (athleteId === null) return;
    bindPrivateBrowserStorageAccount(athleteId);
    const controller = new AbortController();
    activeConsent.current = controller;
    const transport = createNativeAuthenticatedTransport(client, () => {
      if (controller.signal.aborted) return;
      cancelSessionCheck();
      clearIdentity();
      setAuthState({ state: 'signed_out' });
    });
    void transport
      .request({
        path: '/bff/v1/consents/ai',
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal: controller.signal,
      })
      .then((reply) => {
        if (controller.signal.aborted) return;
        if (reply.status === 401) return;
        const parsed = nativeBridgeAiConsentSchema.safeParse(reply.body);
        setConsentState(
          reply.status === 200 && parsed.success
            ? {
                state: 'ready',
                athleteId,
                granted: parsed.data.granted,
                revision: parsed.data.revision,
              }
            : { state: 'error', athleteId, code: 'INVALID_REPLY' },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setConsentState({ state: 'error', athleteId, code: 'UNAVAILABLE' });
      });
    return () => {
      controller.abort();
      if (activeConsent.current === controller) activeConsent.current = null;
    };
  }, [athleteId, consentRefresh, cancelSessionCheck, clearIdentity, client]);

  useEffect(() => {
    const controller = new AbortController();
    void client.connect(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setBridgeState(
        result.ok
          ? {
              kind: 'ready',
              settingsAvailable: result.value['app.openSettings'],
              authAvailable: result.value['auth.transport'],
            }
          : { kind: 'unavailable', code: result.code },
      );
      if (!result.ok || !result.value['auth.transport']) {
        clearIdentity();
        setAuthState({ state: 'unavailable' });
        return;
      }
      void refreshSession();
    });
    return () => {
      controller.abort();
      sessionGeneration.current += 1;
      activeSession.current?.abort();
      activeSession.current = null;
    };
  }, [clearIdentity, refreshSession, client]);

  useEffect(() => {
    const onNativeBack = () => requestBack();
    const onPopState = (event: PopStateEvent) => {
      const currentNoteEntry =
        event.state?.[nativeScreenHistoryKey] === 'note' &&
        event.state?.[nativeScopeHistoryKey] === historyScope.current;
      if (screenRef.current === 'note') {
        if (currentNoteEntry) return;
        if (noteRef.current.length > 0) {
          // Browser history has already moved. Restore this entry until the user chooses.
          history.pushState(noteHistoryState(), '');
          requestBack();
        } else {
          updateScreen('account');
        }
        return;
      }
      if (currentNoteEntry && accountId.current !== null) {
        updateScreen('note');
        requestAnimationFrame(() => noteInput.current?.focus());
      } else if (event.state?.[nativeScreenHistoryKey] === 'note') {
        // A prior account's forward entry must never reopen its draft screen.
        history.replaceState(
          {
            ...(typeof event.state === 'object' && event.state !== null ? event.state : {}),
            [nativeScreenHistoryKey]: 'account',
            [nativeScopeHistoryKey]: historyScope.current,
          },
          '',
        );
      }
    };
    const onForeground = () => {
      if (authPending !== null) return;
      if (client.getCapabilities()?.['auth.transport']) void refreshSession({ foreground: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onForeground();
    };
    window.addEventListener('workout:native-back', onNativeBack);
    window.addEventListener('workout:native-foreground', onForeground);
    window.addEventListener('popstate', onPopState);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('workout:native-back', onNativeBack);
      window.removeEventListener('workout:native-foreground', onForeground);
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  useEffect(() => {
    if (confirmBack) continueButton.current?.focus();
  }, [confirmBack]);

  async function openSettings() {
    setSettingsResult(null);
    const result = await client.openSettings();
    setSettingsResult(
      result.ok ? '기기 설정 열기를 요청했습니다.' : `기기 설정을 열 수 없습니다. (${result.code})`,
    );
  }

  async function checkSession() {
    setAuthError(null);
    await refreshSession({ foreground: accountId.current !== null });
  }

  async function signIn() {
    cancelSessionCheck();
    const generation = ++sessionGeneration.current;
    setAuthPending('signIn');
    setAuthError(null);
    try {
      const result = await client.signIn();
      if (generation !== sessionGeneration.current) return;
      if (result.ok) {
        acceptSession(result.value);
      } else setAuthError(result.code);
    } finally {
      setAuthPending(null);
    }
  }

  async function signOut() {
    cancelSessionCheck();
    const generation = ++sessionGeneration.current;
    activeConsent.current?.abort();
    setConsentState({ state: 'unavailable' });
    setAuthPending('signOut');
    setAuthError(null);
    try {
      const result = await client.signOut();
      if (generation !== sessionGeneration.current) return;
      if (result.ok) {
        acceptSession({ state: 'signed_out' });
      } else {
        setAuthError(result.code);
        setConsentRefresh((value) => value + 1);
      }
    } finally {
      setAuthPending(null);
    }
  }

  return (
    <main className="wm-page mobile-shell">
      <h1>Workout Manager</h1>
      <p>iPhone 앱 연결 기반</p>
      {screen === 'note' ? (
        <section className="native-note" aria-labelledby="native-note-heading">
          <div inert={confirmBack}>
            <button type="button" onClick={requestBack}>
              뒤로
            </button>
            <h2 id="native-note-heading">작업 메모 (임시)</h2>
            <p>이 메모는 이 화면에만 남으며 서버나 기기에 저장되지 않습니다.</p>
            <label htmlFor="native-note-input">작업 메모</label>
            <textarea
              id="native-note-input"
              ref={noteInput}
              value={note}
              rows={5}
              onChange={(event) => updateNote(event.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                updateNote(event.currentTarget.value);
              }}
            />
          </div>
          {confirmBack ? (
            <div
              className="native-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="native-confirm-heading"
              aria-describedby="native-confirm-description"
            >
              <h3 id="native-confirm-heading">저장되지 않은 변경사항</h3>
              <p id="native-confirm-description">화면을 떠나면 임시 메모가 사라집니다.</p>
              <button
                ref={continueButton}
                type="button"
                onKeyDown={onConfirmationKeyDown}
                onClick={() => {
                  confirmRef.current = false;
                  setConfirmBack(false);
                  requestAnimationFrame(() => noteInput.current?.focus());
                }}
              >
                계속 편집
              </button>
              <button
                ref={navigateButton}
                type="button"
                onKeyDown={onConfirmationKeyDown}
                onClick={navigateBack}
              >
                뒤로 이동
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      <section
        hidden={screen !== 'account'}
        aria-labelledby="native-auth-heading"
        aria-busy={authPending !== null}
      >
        <h2 id="native-auth-heading">계정</h2>
        {bridgeState.kind === 'ready' && bridgeState.authAvailable ? (
          <>
            {authState.state === 'checking' ? <p role="status">로그인 상태 확인 중</p> : null}
            {authState.state === 'error' ? (
              <>
                <p role="alert">로그인 상태를 확인할 수 없습니다. ({authState.code})</p>
                <button type="button" onClick={() => void checkSession()}>
                  다시 확인
                </button>
              </>
            ) : null}
            {authState.state === 'signed_out' ? (
              <>
                <p role="status">로그인하지 않았습니다.</p>
                <button type="button" disabled={authPending !== null} onClick={() => void signIn()}>
                  {authPending === 'signIn' ? '시스템 로그인 진행 중' : '시스템 로그인'}
                </button>
                <button
                  type="button"
                  disabled={authPending !== null}
                  onClick={() => void checkSession()}
                >
                  로그인 상태 다시 확인
                </button>
              </>
            ) : null}
            {authState.state === 'signed_in' ? (
              <>
                <p role="status">로그인했습니다.</p>
                <button
                  type="button"
                  onClick={() => {
                    history.pushState(noteHistoryState(), '');
                    updateScreen('note');
                    requestAnimationFrame(() => noteInput.current?.focus());
                  }}
                >
                  작업 메모 (임시) 열기
                </button>
                <section aria-labelledby="native-ai-consent-heading">
                  <h3 id="native-ai-consent-heading">AI 데이터 동의</h3>
                  {visibleConsentState.state === 'loading' ? (
                    <p role="status">동의 상태를 확인하고 있습니다.</p>
                  ) : null}
                  {visibleConsentState.state === 'ready' ? (
                    <p role="status">
                      {visibleConsentState.granted ? '동의함' : '동의하지 않음'} · 개정{' '}
                      {visibleConsentState.revision}
                    </p>
                  ) : null}
                  {visibleConsentState.state === 'error' ? (
                    <div role="alert">
                      동의 상태를 확인할 수 없습니다. ({visibleConsentState.code}){' '}
                      <button
                        type="button"
                        onClick={() => {
                          setConsentState({ state: 'loading', athleteId: authState.athleteId });
                          setConsentRefresh((value) => value + 1);
                        }}
                      >
                        다시 확인
                      </button>
                    </div>
                  ) : null}
                </section>
                <button
                  type="button"
                  disabled={authPending !== null}
                  onClick={() => void signOut()}
                >
                  {authPending === 'signOut' ? '로그아웃 진행 중' : '로그아웃'}
                </button>
              </>
            ) : null}
            {authError ? <p role="alert">계정 작업을 마치지 못했습니다. ({authError})</p> : null}
            <p>제품 화면의 인증된 기능과 건강 데이터 연결은 아직 사용할 수 없습니다.</p>
          </>
        ) : (
          <p role="status">앱 내 로그인과 건강 데이터 연결은 아직 사용할 수 없습니다.</p>
        )}
      </section>
      {sessionCheck === 'checking' && screen === 'note' ? (
        <p role="status">계정 상태를 다시 확인하고 있습니다.</p>
      ) : null}
      {sessionCheck === 'error' && authState.state === 'signed_in' ? (
        <p role="alert">계정 상태를 확인할 수 없습니다. 임시 메모는 유지됩니다.</p>
      ) : null}
      <section hidden={screen !== 'account'} aria-labelledby="native-settings-heading">
        <h2 id="native-settings-heading">기기 연결</h2>
        {bridgeState.kind === 'connecting' ? <p role="status">기기 연결 확인 중</p> : null}
        {bridgeState.kind === 'unavailable' ? (
          <p role="alert">기기 연결을 사용할 수 없습니다. ({bridgeState.code})</p>
        ) : null}
        {bridgeState.kind === 'ready' ? <p role="status">기기 연결이 준비되었습니다.</p> : null}
        <button
          type="button"
          disabled={bridgeState.kind !== 'ready' || !bridgeState.settingsAvailable}
          onClick={() => void openSettings()}
        >
          기기 설정 열기
        </button>
        {settingsResult ? <p role="status">{settingsResult}</p> : null}
      </section>
    </main>
  );
}

if (import.meta.env.MODE !== 'test') {
  const root = document.getElementById('root');
  if (!root) throw new Error('Root element required');
  createRoot(root).render(<NativeLanding />);
}
