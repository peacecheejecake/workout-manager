import { IdentityWorkspace } from '@workout/modules-identity/identity-workspace';
export default function AccountPage() {
  return (
    <main className="wm-page">
      <h1>계정과 개인정보</h1>
      <IdentityWorkspace />
      <nav aria-label="훈련 작업">
        <a href="/dashboard">대시보드</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/activities">가져온 활동</a> · <a href="/wellbeing">체크인</a>
      </nav>
    </main>
  );
}
