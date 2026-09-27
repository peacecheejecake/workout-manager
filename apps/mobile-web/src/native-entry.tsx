import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createCapacitorBridgePort } from '@workout/platform/capacitor-bridge-port';
import { createNativeBridgeClient } from '@workout/platform/native-bridge-client';
import type { NativeBridgeErrorCode } from '@workout/contracts/native-bridge';

const bridge = createNativeBridgeClient({
  port: createCapacitorBridgePort(),
  createId: () => crypto.randomUUID().replaceAll('-', ''),
});

type BridgeState =
  | { kind: 'connecting' }
  | { kind: 'ready'; settingsAvailable: boolean }
  | { kind: 'unavailable'; code: NativeBridgeErrorCode };

function NativeLanding() {
  const [bridgeState, setBridgeState] = useState<BridgeState>({ kind: 'connecting' });
  const [settingsResult, setSettingsResult] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void bridge.connect(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setBridgeState(
        result.ok
          ? { kind: 'ready', settingsAvailable: result.value['app.openSettings'] }
          : { kind: 'unavailable', code: result.code },
      );
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

  return (
    <main className="wm-page mobile-shell">
      <h1>Workout Manager</h1>
      <p>iPhone 앱 연결 기반</p>
      <section aria-labelledby="native-auth-heading">
        <h2 id="native-auth-heading">계정</h2>
        <p role="status">앱 내 로그인과 건강 데이터 연결은 아직 사용할 수 없습니다.</p>
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
