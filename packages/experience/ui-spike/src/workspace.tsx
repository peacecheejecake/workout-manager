'use client';

import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import styles from './workspace.module.css';

const MapPanel = lazy(() => import('./map-panel').then((module) => ({ default: module.MapPanel })));
const DataPanels = lazy(() =>
  import('./data-panels').then((module) => ({ default: module.DataPanels })),
);
const InteractionPanel = lazy(() =>
  import('./interaction-panel').then((module) => ({ default: module.InteractionPanel })),
);
const RoutingRecoveryPanel = lazy(() =>
  import('./routing-recovery-panel').then((module) => ({ default: module.RoutingRecoveryPanel })),
);

const OverlayPanel = lazy(() =>
  import('./overlay-panel').then((module) => ({ default: module.OverlayPanel })),
);

const TableVirtualizationPanel = lazy(() =>
  import('./table-virtualization-panel').then((module) => ({
    default: module.TableVirtualizationPanel,
  })),
);

const StreamPanel = lazy(() =>
  import('./stream-panel').then((module) => ({ default: module.StreamPanel })),
);

class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p role="alert">검증 도구를 불러오지 못했습니다. 페이지를 새로고침해 다시 시도하세요.</p>
    ) : (
      this.props.children
    );
  }
}

export function SpikeWorkspace({ workerUrl }: { workerUrl: string }) {
  const [started, setStarted] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showTableVirtualization, setShowTableVirtualization] = useState(false);
  const [showStream, setShowStream] = useState(false);
  const [showRoutingRecovery, setShowRoutingRecovery] = useState(false);
  return (
    <div className={styles.workspace}>
      <h1>UI 호환성 검증</h1>
      <p>
        개발용 가상 데이터입니다. 계정·건강 기록·외부 공급자와 연결되지 않습니다. 입력은 이 페이지
        메모리에만 남습니다.
      </p>
      <p>
        <a href="/dist/notices/THIRD_PARTY_NOTICES.txt">오픈소스 라이선스 고지</a>
      </p>
      <button type="button" onClick={() => setShowRoutingRecovery((value) => !value)}>
        {showRoutingRecovery ? '라우팅 오류 검증 닫기' : '라우팅 오류 검증 열기'}
      </button>
      <button type="button" onClick={() => setShowOverlay((value) => !value)}>
        {showOverlay ? 'Overlay 조합 검증 닫기' : 'Overlay 조합 검증 열기'}
      </button>
      <button type="button" onClick={() => setShowTableVirtualization((value) => !value)}>
        {showTableVirtualization ? '표 가상화 검증 닫기' : '표 가상화 검증 열기'}
      </button>
      <button type="button" onClick={() => setShowStream((value) => !value)}>
        {showStream ? 'Streaming 합성 검증 닫기' : 'Streaming 합성 검증 열기'}
      </button>
      {showStream ? (
        <PanelBoundary>
          <Suspense fallback={<p role="status">Streaming 합성 검증 준비 중</p>}>
            <StreamPanel />
          </Suspense>
        </PanelBoundary>
      ) : null}
      {showTableVirtualization ? (
        <PanelBoundary>
          <Suspense fallback={<p role="status">표 가상화 검증 준비 중</p>}>
            <TableVirtualizationPanel />
          </Suspense>
        </PanelBoundary>
      ) : null}
      {showOverlay ? (
        <PanelBoundary>
          <Suspense fallback={<p role="status">Overlay 조합 검증 준비 중</p>}>
            <OverlayPanel />
          </Suspense>
        </PanelBoundary>
      ) : null}
      {showRoutingRecovery ? (
        <PanelBoundary>
          <Suspense fallback={<p role="status">라우팅 오류 검증 준비 중</p>}>
            <RoutingRecoveryPanel />
          </Suspense>
        </PanelBoundary>
      ) : null}
      {started ? (
        <div className={styles.panels}>
          <PanelBoundary>
            <Suspense fallback={<p role="status">차트·표·편집기 준비 중</p>}>
              <DataPanels />
            </Suspense>
          </PanelBoundary>
          <PanelBoundary>
            <Suspense fallback={<p role="status">드래그·분할 패널 준비 중</p>}>
              <InteractionPanel />
            </Suspense>
          </PanelBoundary>
          <section>
            <button type="button" onClick={() => setShowMap((value) => !value)}>
              {showMap ? '지도 해제' : '지도 다시 열기'}
            </button>
            {showMap ? (
              <PanelBoundary>
                <Suspense fallback={<p role="status">지도 도구 준비 중</p>}>
                  <MapPanel workerUrl={workerUrl} />
                </Suspense>
              </PanelBoundary>
            ) : (
              <p>지도 리소스 해제됨</p>
            )}
          </section>
        </div>
      ) : (
        <button type="button" onClick={() => setStarted(true)}>
          검증 도구 열기
        </button>
      )}
    </div>
  );
}
