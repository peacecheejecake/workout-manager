import { useEffect, useRef, useState } from 'react';
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

function NativeLanding() {
  const [bridgeState, setBridgeState] = useState<BridgeState>({ kind: 'connecting' });
  const [authState, setAuthState] = useState<AuthState>({ state: 'checking' });
  const [authPending, setAuthPending] = useState<'signIn' | 'signOut' | null>(null);
  const [authError, setAuthError] = useState<NativeBridgeErrorCode | null>(null);
  const [settingsResult, setSettingsResult] = useState<string | null>(null);
  const [consentState, setConsentState] = useState<ConsentState>({ state: 'unavailable' });
  const [consentRefresh, setConsentRefresh] = useState(0);
  const activeConsent = useRef<AbortController | null>(null);

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
    const transport = createNativeAuthenticatedTransport(bridge, () => {
      if (controller.signal.aborted) return;
      clearPrivateBrowserStorage();
      setConsentState({ state: 'unavailable' });
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
  }, [athleteId, consentRefresh]);

  useEffect(() => {
    const controller = new AbortController();
    void bridge.connect(controller.signal).then((result) => {
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
        clearPrivateBrowserStorage();
        setAuthState({ state: 'unavailable' });
        return;
      }
      void bridge.session(controller.signal).then((sessionResult) => {
        if (controller.signal.aborted) return;
        if (sessionResult.ok && sessionResult.value.state === 'signed_out') {
          clearPrivateBrowserStorage();
          setConsentState({ state: 'unavailable' });
        }
        setAuthState(
          sessionResult.ok ? sessionResult.value : { state: 'error', code: sessionResult.code },
        );
      });
    });
    return () => controller.abort();
  }, []);

  async function openSettings() {
    setSettingsResult(null);
    const result = await bridge.openSettings();
    setSettingsResult(
      result.ok ? '기기 설정 열기를 요청했습니다.' : `기기 설정을 열 수 없습니다. (${result.code})`,
    );
  }

  async function checkSession() {
    setAuthError(null);
    setAuthState({ state: 'checking' });
    const result = await bridge.session();
    if (result.ok && result.value.state === 'signed_out') {
      clearPrivateBrowserStorage();
      setConsentState({ state: 'unavailable' });
    }
    setAuthState(result.ok ? result.value : { state: 'error', code: result.code });
  }

  async function signIn() {
    setAuthPending('signIn');
    setAuthError(null);
    try {
      const result = await bridge.signIn();
      if (result.ok) {
        if (result.value.state === 'signed_out') {
          clearPrivateBrowserStorage();
          setConsentState({ state: 'unavailable' });
        }
        setAuthState(result.value);
      } else setAuthError(result.code);
    } finally {
      setAuthPending(null);
    }
  }

  async function signOut() {
    activeConsent.current?.abort();
    setConsentState({ state: 'unavailable' });
    setAuthPending('signOut');
    setAuthError(null);
    try {
      const result = await bridge.signOut();
      if (result.ok) {
        clearPrivateBrowserStorage();
        setAuthState({ state: 'signed_out' });
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
      <section aria-labelledby="native-auth-heading" aria-busy={authPending !== null}>
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
      <section aria-labelledby="native-settings-heading">
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

const root = document.getElementById('root');
if (!root) throw new Error('Root element required');
createRoot(root).render(<NativeLanding />);
