import { lazy, Suspense, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { trainingCandidateStatusV1Schema } from '@workout/contracts/coaching-candidates';
import { jointCandidateV3Schema } from '@workout/contracts/joint-coaching';
import { integratedCandidateV4Schema } from '@workout/contracts/integrated-coaching';
import { DemoWorkspace } from '@workout/modules-activities/demo-workspace';
import './styles.css';

const SpikeWorkspace = lazy(() =>
  import('@workout/ui-spike/workspace').then((module) => ({ default: module.SpikeWorkspace })),
);
const CoachingPage = lazy(() =>
  import('./coaching-page').then((module) => ({ default: module.CoachingPage })),
);
const ProposalPage = lazy(() =>
  import('./proposal-page').then((module) => ({ default: module.ProposalPage })),
);
const JointProposalPage = lazy(() =>
  import('./joint-proposal-page').then((module) => ({ default: module.JointProposalPage })),
);
const IntegratedProposalPage = lazy(() =>
  import('./integrated-proposal-page').then((module) => ({
    default: module.IntegratedProposalPage,
  })),
);
const PlannerPage = lazy(() =>
  import('./planner-page').then((module) => ({ default: module.PlannerPage })),
);
const AccountPage = lazy(() =>
  import('./account-page').then((module) => ({ default: module.AccountPage })),
);
const NutritionPage = lazy(() =>
  import('./nutrition-page').then((module) => ({ default: module.NutritionPage })),
);
const SupplementaryPage = lazy(() =>
  import('./supplementary-page').then((module) => ({ default: module.SupplementaryPage })),
);
const StretchingPage = lazy(() =>
  import('./stretching-page').then((module) => ({ default: module.StretchingPage })),
);
const RoutinePage = lazy(() =>
  import('./routine-page').then((module) => ({ default: module.RoutinePage })),
);
const RecoveryPage = lazy(() =>
  import('./recovery-page').then((module) => ({ default: module.RecoveryPage })),
);
const ResourcePage = lazy(() =>
  import('./resource-page').then((module) => ({ default: module.ResourcePage })),
);
const GalleryPage = lazy(() =>
  import('./gallery-page').then((module) => ({ default: module.GalleryPage })),
);
const proposalPath = location.pathname.match(/^\/proposals\/([^/]+)\/?$/)?.[1];
const proposalCandidateId = proposalPath
  ? trainingCandidateStatusV1Schema.shape.candidateId.safeParse(proposalPath)
  : null;
const jointProposalPath = location.pathname.match(/^\/joint-proposals\/([^/]+)\/?$/)?.[1];
const jointProposalCandidateId = jointProposalPath
  ? jointCandidateV3Schema.shape.id.safeParse(jointProposalPath)
  : null;
const integratedProposalPath = location.pathname.match(/^\/integrated-proposals\/([^/]+)\/?$/)?.[1];
const integratedProposalCandidateId = integratedProposalPath
  ? integratedCandidateV4Schema.shape.id.safeParse(integratedProposalPath)
  : null;
const root = document.getElementById('root');
if (!root) throw new Error('Root element required');
createRoot(root).render(
  <StrictMode>
    <main className="wm-page mobile-shell">
      {integratedProposalCandidateId?.success ? (
        <Suspense fallback={<p role="status">통합 후보 검토 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/coach">코치</a> · <a href="/planner">통합 계획</a> ·{' '}
            <a href="/recovery">회복</a>
          </nav>
          <IntegratedProposalPage candidateId={integratedProposalCandidateId.data.toLowerCase()} />
        </Suspense>
      ) : integratedProposalPath ? (
        <p role="alert">통합 후보 주소가 올바르지 않습니다.</p>
      ) : jointProposalCandidateId?.success ? (
        <Suspense fallback={<p role="status">공동 후보 검토 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/coach">코치</a> · <a href="/planner">훈련 계획</a> ·{' '}
            <a href="/account">계정</a>
          </nav>
          <JointProposalPage candidateId={jointProposalCandidateId.data.toLowerCase()} />
        </Suspense>
      ) : jointProposalPath ? (
        <p role="alert">공동 후보 주소가 올바르지 않습니다.</p>
      ) : proposalCandidateId?.success ? (
        <Suspense fallback={<p role="status">후보 검토 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/coach">코치</a> · <a href="/account">계정</a>
          </nav>
          <ProposalPage candidateId={proposalCandidateId.data.toLowerCase()} />
        </Suspense>
      ) : proposalPath ? (
        <p role="alert">후보 주소가 올바르지 않습니다.</p>
      ) : location.pathname === '/gallery' || location.pathname.startsWith('/gallery/') ? (
        <Suspense fallback={<p role="status">갤러리 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/resources">자료실</a> · <a href="/account">계정</a>
          </nav>
          <GalleryPage path={location.pathname} query={location.search} />
        </Suspense>
      ) : location.pathname === '/resources' || location.pathname.startsWith('/resources/') ? (
        <Suspense fallback={<p role="status">자료실 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/coach">코치</a> · <a href="/account">계정</a>
          </nav>
          <ResourcePage path={location.pathname} query={location.search} />
        </Suspense>
      ) : location.pathname === '/recovery' || location.pathname.startsWith('/recovery/') ? (
        <Suspense fallback={<p role="status">회복 전략 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/wellbeing">체크인</a> · <a href="/nutrition">영양</a> ·{' '}
            <a href="/account">계정</a>
          </nav>
          <RecoveryPage path={location.pathname} />
        </Suspense>
      ) : location.pathname === '/stretching' || location.pathname.startsWith('/stretching/') ? (
        <Suspense fallback={<p role="status">스트레칭 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/planner">훈련 계획</a> · <a href="/activities">활동</a> ·{' '}
            <a href="/supplementary">보강 운동</a> · <a href="/account">계정</a>
          </nav>
          <StretchingPage path={location.pathname} query={location.search} />
        </Suspense>
      ) : location.pathname === '/routines' ||
        location.pathname.startsWith('/routines/') ||
        location.pathname.startsWith('/routine-runs/') ? (
        <Suspense fallback={<p role="status">루틴 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/planner">훈련 계획</a> · <a href="/supplementary">보강 운동</a> ·{' '}
            <a href="/recovery">회복 전략</a> · <a href="/resources">자료실</a> ·{' '}
            <a href="/account">계정</a>
          </nav>
          <RoutinePage path={location.pathname} />
        </Suspense>
      ) : location.pathname === '/supplementary' ||
        location.pathname.startsWith('/supplementary/') ? (
        <Suspense fallback={<p role="status">보강 운동 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/planner">훈련 계획</a> · <a href="/activities">활동</a> ·{' '}
            <a href="/account">계정</a>
          </nav>
          <SupplementaryPage path={location.pathname} />
        </Suspense>
      ) : location.pathname === '/nutrition' || location.pathname.startsWith('/nutrition/') ? (
        <Suspense fallback={<p role="status">영양 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/planner">훈련 계획</a> · <a href="/account">계정</a>
          </nav>
          <NutritionPage path={location.pathname} />
        </Suspense>
      ) : location.pathname === '/planner' ? (
        <Suspense fallback={<p role="status">훈련 계획 화면 준비 중</p>}>
          <nav aria-label="주요 화면">
            <a href="/coach">코치</a> · <a href="/account">계정</a>
          </nav>
          <PlannerPage />
        </Suspense>
      ) : location.pathname === '/coach' ? (
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
          <nav aria-label="더보기">
            <a href="/nutrition">영양 계획·섭취 기록</a> · <a href="/supplementary">보강 운동</a> ·{' '}
            <a href="/routines">루틴</a> · <a href="/stretching">스트레칭</a> ·{' '}
            <a href="/recovery">회복 전략</a> · <a href="/account">계정</a>
          </nav>
          <DemoWorkspace />
        </>
      )}
    </main>
  </StrictMode>,
);
