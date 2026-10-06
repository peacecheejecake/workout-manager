import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HealthKitPanel } from '@workout/modules-identity/healthkit-panel';
import { createNativeBridgeClient } from '@workout/platform/native-bridge-client';
import './style.css';

const scenarios = [
  'choosing',
  'confirming',
  'registering',
  'registered',
  'refresh_pending',
  'offline',
  'conflict',
  'consent_required',
  'unauthorized',
  'unavailable',
];
let scenario = 'choosing';
let granted = true;
let openedHandle = null;
let outcome = 'idle';
let oldHost = false;
let managementScenario = 'pending_cleanup';
let managementHandle = null;
let managementOutcome = 'idle';

function createFixtureBridge() {
  let sequence = 0;
  return createNativeBridgeClient({
    createId: () => `fixture_${++sequence}`,
    port: {
      async exchange(request) {
        if (request.kind === 'hello')
          return {
            kind: 'hello.result',
            version: 3,
            id: request.id,
            capabilities: {
              'app.openSettings': false,
              'healthkit.read': false,
              'healthkit.workouts': true,
              'auth.transport': true,
              ...(oldHost
                ? {}
                : { 'healthkit.workouts.selection': true, 'healthkit.workouts.management': true }),
            },
          };
        const reply = {
          kind: 'command.result',
          version: 3,
          id: request.id,
          method: request.method,
        };
        if (request.method === 'healthkit.workouts.status')
          return {
            ...reply,
            status: { requestState: 'requested', pendingCount: 0, pauseReason: null },
          };
        if (request.method === 'healthkit.workouts.select') {
          openedHandle = crypto.randomUUID();
          outcome = scenario;
          return { ...reply, status: 'opened', selectionId: openedHandle };
        }
        if (request.method === 'healthkit.workouts.cancelSelection') {
          if (request.payload.selectionId === openedHandle) outcome = 'cancelled';
          return { ...reply, status: 'cancelled' };
        }
        if (request.method === 'healthkit.workouts.selectionStatus')
          return {
            ...reply,
            status: {
              state: request.payload.selectionId === openedHandle ? outcome : 'unavailable',
              registeredCount: outcome === 'registered' ? 1 : null,
              selectedCount: outcome === 'idle' || outcome === 'cancelled' ? 0 : 1,
              resultCount: outcome === 'registered' ? 1 : null,
            },
          };
        if (request.method === 'healthkit.workouts.manage') {
          managementHandle = crypto.randomUUID();
          managementOutcome = managementScenario;
          return { ...reply, status: 'opened', managementId: managementHandle };
        }
        if (request.method === 'healthkit.workouts.cancelManagement') {
          if (
            request.payload.managementId === managementHandle &&
            !['pending_cleanup', 'released', 'deregistering'].includes(managementOutcome)
          )
            managementOutcome = 'cancelled';
          return { ...reply, status: 'cancelled' };
        }
        if (request.method === 'healthkit.workouts.managementStatus')
          return {
            ...reply,
            status: {
              state:
                request.payload.managementId === managementHandle
                  ? managementOutcome
                  : 'unavailable',
              registeredCount: managementOutcome === 'released' ? 0 : null,
              selectedCount: 0,
              resultCount: managementOutcome === 'released' ? 1 : null,
            },
          };
        if (request.method === 'api.healthkitConsent.write') {
          granted = request.payload.granted;
          return { ...reply, status: 200, body: { kind: 'healthkit', granted, revision: 1 } };
        }
        if (request.method === 'healthkit.workouts.requestAccess')
          return { ...reply, status: 'requested' };
        return { kind: 'error', version: 3, id: request.id, code: 'UNSUPPORTED_METHOD' };
      },
    },
  });
}

function Fixture() {
  const [accountNumber, setAccountNumber] = useState(1);
  const [readyBridge, setReadyBridge] = useState(null);
  const [selectedScenario, setSelectedScenario] = useState('choosing');
  const [narrow, setNarrow] = useState(false);
  const [selectedManagementScenario, setSelectedManagementScenario] = useState('pending_cleanup');
  const transport = useMemo(
    () => ({
      async request() {
        return { status: 200, body: { kind: 'healthkit', granted, revision: 1 }, traceId: null };
      },
    }),
    [],
  );
  async function connect() {
    const next = createFixtureBridge();
    await next.connect();
    setReadyBridge(next);
    setAccountNumber((number) => number + 1);
  }
  return (
    <main className={narrow ? 'narrow' : ''}>
      <h1>HealthKit 선택 UI</h1>
      <p>
        합성 상태만 사용하는 검증 fixture입니다. iPhone·HealthKit·제품 서버에 접근하지 않습니다.
      </p>
      <label htmlFor="registration-scenario">등록 결과 시나리오</label>
      <select
        id="registration-scenario"
        value={selectedScenario}
        onChange={(event) => {
          setSelectedScenario(event.target.value);
          scenario = event.target.value;
          if (openedHandle) outcome = scenario;
        }}
      >
        {scenarios.map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <label htmlFor="management-scenario">해제 결과 시나리오</label>
      <select
        id="management-scenario"
        value={selectedManagementScenario}
        onChange={(event) => {
          setSelectedManagementScenario(event.target.value);
          managementScenario = event.target.value;
          if (managementHandle) managementOutcome = managementScenario;
        }}
      >
        {[
          'choosing',
          'confirming',
          'deregistering',
          'pending_cleanup',
          'released',
          'offline',
          'conflict',
          'legacy_blocked',
        ].map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <label>
        <input
          type="checkbox"
          checked={narrow}
          onChange={(event) => setNarrow(event.target.checked)}
        />
        좁은 컨테이너 280px
      </label>
      <label>
        <input
          type="checkbox"
          onChange={(event) => {
            oldHost = event.target.checked;
          }}
        />
        구형 host (다음 연결 적용)
      </label>
      <button type="button" onClick={() => void connect()}>
        합성 앱 연결·계정 전환
      </button>
      {readyBridge ? (
        <HealthKitPanel
          account={{
            athleteId: `synthetic-account-${accountNumber}`,
            scopeId: `fixture-${accountNumber}`,
          }}
          bridge={readyBridge}
          transport={transport}
        />
      ) : null}
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
