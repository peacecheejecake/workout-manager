import { CoachingPage } from './coaching-page';
export default function Page() {
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/account">계정</a> ·{' '}
        <a href="/planner">훈련 계획</a> · <a href="/activities">가져온 활동</a>
      </nav>
      <CoachingPage />
    </main>
  );
}
