import { ActivitiesPage } from './activities-page';
export default function Page() {
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/account">계정</a> ·{' '}
        <a href="/planner">훈련 계획</a> · <a href="/wellbeing">체크인</a> ·{' '}
        <a href="/activities/track-preview">기록 파일 미리보기</a>
      </nav>
      <h1>활동 목록</h1>
      <ActivitiesPage />
    </main>
  );
}
