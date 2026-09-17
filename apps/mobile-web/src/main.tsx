import { lazy, Suspense, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DemoWorkspace } from '@workout/modules-activities/demo-workspace';
import './styles.css';

const SpikeWorkspace = lazy(() =>
  import('@workout/ui-spike/workspace').then((module) => ({ default: module.SpikeWorkspace })),
);
const CoachingPage = lazy(() =>
  import('./coaching-page').then((module) => ({ default: module.CoachingPage })),
);
const AccountPage = lazy(() =>
  import('./account-page').then((module) => ({ default: module.AccountPage })),
);
const root = document.getElementById('root');
if (!root) throw new Error('Root element required');
createRoot(root).render(
  <StrictMode>
    <main className="wm-page mobile-shell">
      {location.pathname === '/coach' ? (
        <Suspense fallback={<p role="status">상담 기록 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/account">계정</a>
          </nav>
          <CoachingPage />
        </Suspense>
      ) : location.pathname === '/account' ? (
        <Suspense fallback={<p role="status">계정 화면 준비 중</p>}>
          <AccountPage />
        </Suspense>
      ) : location.pathname === '/ui-spike' ? (
        <Suspense fallback={<p>검증 화면 준비 중</p>}>
          <SpikeWorkspace workerUrl="/dist/maplibre/maplibre-gl-worker.mjs" />
        </Suspense>
      ) : (
        <>
          <h1>Workout Manager · Mobile Web</h1>
          <p>개발 기반 확인 화면 · 서버 저장 및 실제 로그인이 연결되지 않았습니다.</p>
          <DemoWorkspace />
        </>
      )}
    </main>
  </StrictMode>,
);
